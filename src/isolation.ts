import { urlIsLocal } from './safety.js';
import { withDatabase } from './config.js';
import { Guard, PREFIX, LABEL_PREFIX, TERMINATE_SQL, copyOwnerPid, databaseOf, type Db } from './guard.js';
import { qi } from './sql.js';
import type { Break } from './types.js';

export { copyOwnerPid };

/**
 * Isolation.
 *
 * Every break runs on its own copy of the database, made with CREATE DATABASE ... TEMPLATE.
 * Postgres only allows that when nobody else is connected to the source, and a running local
 * Supabase stack always has services connected (auth, REST, realtime). So the source is copied
 * ONCE into a master template, and each break copies the master. Taking that first copy may need
 * those connections closed for a moment (local only, never with the remote flag). They reconnect.
 *
 * The source database is never altered: no setting is changed, no statement but a read is sent to
 * it. Every copy carries a label, and only labelled copies are ever dropped. See guard.ts.
 */

export interface Isolation {
  mode: 'template';
  /** Notes to show the user (what was disconnected). */
  notes: string[];
  withBreak<T>(brk: Break, fn: (dbUrl: string) => Promise<T>): Promise<T>;
  /** A database with no break applied, for the baseline check on the copy. */
  withPristine<T>(fn: (dbUrl: string) => Promise<T>): Promise<T>;
  dispose(): Promise<void>;
}

function sqlstate(e: unknown): string | undefined {
  return (e as { code?: string }).code;
}

/**
 * Drop copies left behind by earlier runs that died. A database is dropped only when its name matches
 * saboteur_<pid>_..., its comment starts with "rls-saboteur copy " and its pid is dead.
 */
export async function sweepStale(admin: Db): Promise<number> {
  const res = await admin.query(
    `select datname, shobj_description(oid, 'pg_database') as label from pg_database where datname like 'saboteur\\_%'`
  );
  let dropped = 0;
  for (const { datname, label } of res.rows as { datname: string; label: string | null }[]) {
    if (copyOwnerPid(datname) === null) continue;
    if (!label || !label.startsWith(LABEL_PREFIX)) continue;
    try {
      // The guard repeats the label and pid checks inside the connection before it sends the drop.
      await admin.query(`drop database if exists ${qi(datname)} with (force)`);
      dropped++;
    } catch {
      /* alive, or not ours to fight over */
    }
  }
  return dropped;
}

export interface IsolationOptions {
  sourceUrl: string;
  /** Allow closing other connections to the source for the first copy (still needs a local host). */
  terminate: boolean;
  /** The remote flag is in effect: closing sessions is then never allowed. */
  allowRemote?: boolean;
  /**
   * A superuser URL, used only to copy and drop databases. A local Supabase stack keeps
   * connections open as a superuser (the cron scheduler), which the normal role cannot close.
   */
  adminUrl?: string;
  /** Asked before any session on the source is closed. Return false to stop. */
  confirmTerminate?: (n: number, applications: string[], db: string) => Promise<boolean>;
  /** Runs once on the master template, e.g. installing pgTAP. */
  prepareMaster?: (masterUrl: string) => Promise<void>;
}

export async function createIsolation(o: IsolationOptions): Promise<Isolation> {
  const sourceDb = databaseOf(o.sourceUrl);
  const adminDb = sourceDb === 'template1' ? 'postgres' : 'template1';
  const adminUrl = withDatabase(o.adminUrl ?? o.sourceUrl, adminDb);
  const owner = decodeURIComponent(new URL(o.sourceUrl).username);
  const notes: string[] = [];
  const local = urlIsLocal(o.sourceUrl) && (!o.adminUrl || urlIsLocal(o.adminUrl));
  const guard = new Guard({ sourceUrl: o.sourceUrl, allowTerminate: o.terminate && !o.allowRemote && local });

  const admin = await guard.connect(adminUrl);
  const master = `${PREFIX}${process.pid}_tpl`;
  let result: Isolation | null = null;
  try {
    await sweepStale(admin);
    const created = await makeMaster(guard, admin, master, owner, o, notes);
    if (!created.ok) {
      throw new Error(
        `Could not copy the database: ${created.reason}\n` +
          `Your database was not changed. If it is a local Supabase stack, pass --admin-url with a superuser URL, ` +
          `used only to copy and drop databases. Otherwise free the database of other connections and run again.`
      );
    }
    const masterUrl = withDatabase(o.sourceUrl, master);
    try {
      if (o.prepareMaster) await o.prepareMaster(masterUrl);
    } catch (e) {
      await guard.dropCopy(admin, master).catch(() => {});
      throw e;
    }

    let counter = 0;
    const live = new Set<string>();
    const withCopy = async <T>(brk: Break | null, fn: (dbUrl: string) => Promise<T>): Promise<T> => {
      const name = `${PREFIX}${process.pid}_${++counter}`;
      const a = await guard.connect(adminUrl);
      live.add(name);
      try {
        await guard.createCopy(a, name, master, owner);
        const url = withDatabase(o.sourceUrl, name);
        if (brk) {
          const c = await guard.connect(url);
          try {
            for (const stmt of brk.apply) await c.query(stmt);
          } finally {
            await c.end().catch(() => {});
          }
        }
        return await fn(url);
      } finally {
        await guard.dropCopy(a, name).catch(() => {});
        live.delete(name);
        await a.end().catch(() => {});
      }
    };

    const onSignal = (sig: NodeJS.Signals): void => {
      result?.dispose().finally(() => process.exit(sig === 'SIGINT' ? 130 : 143));
    };
    process.on('SIGINT', onSignal);
    process.on('SIGTERM', onSignal);

    result = {
      mode: 'template',
      notes,
      withBreak: (brk, fn) => withCopy(brk, fn),
      withPristine: (fn) => withCopy(null, fn),
      async dispose() {
        process.off('SIGINT', onSignal);
        process.off('SIGTERM', onSignal);
        const a = await guard.connect(adminUrl);
        try {
          for (const n of live) await guard.dropCopy(a, n).catch(() => {});
          await guard.dropCopy(a, master).catch(() => {});
        } finally {
          await a.end().catch(() => {});
        }
      }
    };
    return result;
  } finally {
    await admin.end().catch(() => {});
  }
}

async function makeMaster(
  guard: Guard,
  admin: Db,
  master: string,
  owner: string,
  o: IsolationOptions,
  notes: string[]
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const sourceDb = guard.sourceDb;
  const create = () => guard.createCopy(admin, master, sourceDb, owner);
  try {
    await create();
    return { ok: true };
  } catch (e) {
    if (sqlstate(e) !== '55006') return { ok: false, reason: (e as Error).message };
  }
  // 55006: the source is in use.
  const others = await admin.query(
    `select count(*)::int as n, coalesce(array_agg(distinct nullif(application_name, '')), '{}') as apps
       from pg_stat_activity where datname = $1 and pid <> pg_backend_pid()`,
    [sourceDb]
  );
  const n = others.rows[0].n as number;
  const apps = ((others.rows[0].apps as (string | null)[]) ?? []).filter((a): a is string => Boolean(a)).sort();
  if (!guard.allowTerminate) {
    const why = o.allowRemote
      ? 'closing other connections is never done together with the remote flag'
      : !o.terminate
        ? '--no-terminate was given'
        : 'the host is not local';
    return {
      ok: false,
      reason:
        `${n} other connection(s) to "${sourceDb}" are open and ${why}. ` +
        `Stop the services that use the database (or point --db-url at a local scratch copy of it) and run again`
    };
  }
  if (o.confirmTerminate && !(await o.confirmTerminate(n, apps, sourceDb))) {
    return {
      ok: false,
      reason: `${n} other connection(s) to "${sourceDb}" are open, and you chose not to close them. Stop the services that use it and run again, or answer yes to close them for a moment`
    };
  }
  // Close the other connections just long enough to copy. Nothing about the source is changed.
  for (let attempt = 0; attempt < 8; attempt++) {
    await admin.query(TERMINATE_SQL, [sourceDb]);
    try {
      await create();
      notes.push(
        `Closed ${n} other connection(s) to "${sourceDb}" for a moment to copy it. Local services reconnect by themselves.`
      );
      return { ok: true };
    } catch (e) {
      if (sqlstate(e) !== '55006') return { ok: false, reason: (e as Error).message };
      await new Promise((r) => setTimeout(r, 150));
    }
  }
  return {
    ok: false,
    reason:
      `"${sourceDb}" still has connections that this role cannot close` +
      (o.adminUrl ? '' : ' (a local Supabase keeps a superuser cron connection open)')
  };
}
