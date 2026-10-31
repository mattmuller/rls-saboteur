import { urlIsLocal } from './safety.js';
import { withDatabase } from './config.js';
import { CANCEL_SQL, Guard, TERMINATE_SQL, copyOwnerPid, databaseOf, droppable, sourceNameProblem, type Db } from './guard.js';
import { readIdentity, sameServer } from './facts.js';
import { isolateNetwork } from './network.js';
import { hostOf } from './safety.js';
import { qi } from './sql.js';
import { applyMasks, type MaskSpec, type MaskedColumn } from './mask.js';
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
  mode: 'template' | 'files' | 'sandbox';
  /** Notes to show the user (what was disconnected). */
  notes: string[];
  /** The columns masked in the first copy, with the rows rewritten. Empty when --mask was not given. */
  masked: MaskedColumn[];
  withBreak<T>(brk: Break, fn: (dbUrl: string) => Promise<T>): Promise<T>;
  /** A database with no break applied, for the baseline check on the copy. */
  withPristine<T>(fn: (dbUrl: string) => Promise<T>): Promise<T>;
  dispose(): Promise<void>;
}

function sqlstate(e: unknown): string | undefined {
  return (e as { code?: string }).code;
}

/**
 * Drop copies left behind by earlier runs that died. A database is dropped only when droppable() says so: its NAME
 * (saboteur_<host>_<pid>_<token>_...) or its label names this host, its pid is dead here, and it is not the source.
 * The admin connection's guard repeats that rule inside the connection before it sends the drop.
 */
export async function sweepStale(admin: Db, sourceDb = '', token = ''): Promise<number> {
  const res = await admin.query(
    `select datname, shobj_description(oid, 'pg_database') as label from pg_database where datname like 'saboteur\\_%'`
  );
  let dropped = 0;
  for (const { datname, label } of res.rows as { datname: string; label: string | null }[]) {
    if (!droppable(datname, label, sourceDb, token).ok) continue;
    try {
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
  /** Switch off outbound HTTP inside the copies (default true). The source is never touched. */
  isolateNetwork?: boolean;
  /** How long cleanup waits for an interrupted CREATE DATABASE to end (default 30 s). */
  cleanupWaitMs?: number;
  /** Runs once on the master template, e.g. installing pgTAP. */
  prepareMaster?: (masterUrl: string) => Promise<void>;
  /** Columns to scramble in the master, after it is built and before anything else touches it. */
  masks?: MaskSpec[];
  /**
   * Build mode: runs on the new master and fills it, from files or a dump. With emptyMaster the master starts EMPTY (from
   * template0) and nothing is cloned. Without it, the master is a clone of the source database (the sandbox uses this for the
   * database an image ships with) and the build adds to it.
   */
  build?: (masterUrl: string, guard: Guard, between: () => Promise<void>) => Promise<void>;
  emptyMaster?: boolean;
  /** Runs on the built master. A throw stops the run (for example: the files do not rebuild the policies of the database). */
  verifyMaster?: (masterUrl: string) => Promise<void>;
  /** Sandbox mode owns the signal handler, because removing the container removes every copy in it. Default true. */
  manageSignals?: boolean;
}

export async function createIsolation(o: IsolationOptions): Promise<Isolation> {
  const sourceDb = databaseOf(o.sourceUrl);
  const adminDb = sourceDb === 'template1' ? 'postgres' : 'template1';
  const adminUrl = withDatabase(o.adminUrl ?? o.sourceUrl, adminDb);
  const owner = decodeURIComponent(new URL(o.sourceUrl).username);
  const notes: string[] = [];
  const local = urlIsLocal(o.sourceUrl) && (!o.adminUrl || urlIsLocal(o.adminUrl));
  const sourceProblem = sourceNameProblem(sourceDb);
  if (sourceProblem) throw new Error(sourceProblem);
  const guard = new Guard({ sourceUrl: o.sourceUrl, allowTerminate: o.terminate && !o.allowRemote && local && !o.emptyMaster, emptyMaster: o.emptyMaster });
  const master = guard.masterName();
  const WAIT_MS = o.cleanupWaitMs ?? 30_000;

  /**
   * Cleanup comes first: a Ctrl-C during the very first copy must still remove what exists so far.
   * A CREATE DATABASE that is still running on the server will finish by itself after the client is gone, and the copy
   * would be left behind. So: stop starting copies, cancel our own CREATEs, wait for them to end, then drop by name.
   * Returns the names that are still there.
   */
  const cleanup = async (): Promise<string[]> => {
    guard.stopCreating();
    let a: Db | undefined;
    try {
      a = await guard.connect(adminUrl);
      for (const c of guard.inflightCreates()) {
        // pg_cancel_backend on the backend running our own CREATE; the guard allows no other pid.
        await a.query(CANCEL_SQL, [c.pid]).catch(() => {});
      }
      await guard.waitCreatesEnded(WAIT_MS);
      for (const n of new Set([...guard.attempted, master])) await guard.dropCopy(a, n).catch(() => {});
      const left = await a.query(`select datname from pg_database where datname = any($1::text[])`, [[...guard.attempted, master]]);
      const names = (left.rows as { datname: string }[]).map((r) => r.datname);
      // A CREATE that did not end in time may still produce its database later: name it too.
      for (const c of guard.inflightCreates()) if (!names.includes(c.name)) names.push(c.name);
      return names;
    } catch {
      return [...new Set([...guard.attempted, master])];
    } finally {
      await a?.end().catch(() => {});
    }
  };
  const leftoverMessage = (names: string[]): string =>
    `rls-saboteur could not remove its temporary copies: ${names.join(', ')}. ` +
    `Drop them yourself: ${names.map((n) => `drop database ${qi(n)} with (force);`).join(' ')}`;
  let signalled = false;
  // When a signal is being handled, the signal handler owns the exit. The normal paths wait for it instead of racing it.
  const yieldToSignal = async (): Promise<void> => {
    if (signalled) await new Promise<never>(() => {});
  };
  const onSignal = (sig: NodeJS.Signals): void => {
    if (signalled) return;
    signalled = true;
    const code = sig === 'SIGINT' ? 130 : 143;
    // The whole cleanup is bounded, so a dead server cannot hold the exit forever.
    const limit = new Promise<string[] | 'timeout'>((r) => setTimeout(() => r('timeout'), WAIT_MS * 2 + 5000).unref());
    Promise.race([cleanup(), limit])
      .then((left) => {
        const names = left === 'timeout' ? [...new Set([...guard.attempted, master])] : left;
        if (names.length) {
          process.stderr.write(leftoverMessage(names) + '\n');
          process.exit(1);
          return;
        }
        process.exit(code);
      })
      .catch(() => process.exit(1));
  };
  const uninstall = (): void => {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
  };
  if (o.manageSignals !== false) {
    process.on('SIGINT', onSignal);
    process.on('SIGTERM', onSignal);
  }

  let admin: Db | undefined;
  let ready = false;
  try {
    admin = await guard.connect(adminUrl);
    if (o.adminUrl) {
      const r = await assertSameServer(guard, o.sourceUrl, o.adminUrl);
      // Closing sessions on the source is only allowed when it is PROVEN that the admin connection is on the same server.
      if (!r.proven) {
        guard.denyTerminate(
          `closing other sessions is refused: the admin URL could be shown to be on the same server only by host and port (${r.how}), which does not prove it. ` +
            `Use a superuser --admin-url, or stop the services that use the database yourself`
        );
      }
    }
    await sweepStale(admin, guard.sourceDb, guard.token);
    const created = o.emptyMaster ? await makeEmptyMaster(guard, admin, master, owner) : await makeMaster(guard, admin, master, owner, o, notes);
    if (!created.ok) {
      throw new Error(
        `Could not copy the database: ${created.reason}\n` +
          `Your database was not changed. If it is a local Supabase stack, pass --admin-url with a superuser URL, ` +
          `used only to copy and drop databases. Otherwise free the database of other connections and run again.`
      );
    }
    const masterUrl = withDatabase(o.sourceUrl, master);
    // Switch outbound HTTP off in the master. In build mode this runs AFTER the build, because the net and http
    // functions only exist once the files or the dump have installed them. It also runs between the files (see below).
    const isolate = async (): Promise<ReturnType<typeof isolateNetwork> | undefined> => {
      if (o.isolateNetwork === false) return undefined;
      const m = await guard.connect(withDatabase(o.adminUrl ?? o.sourceUrl, master));
      try {
        return await isolateNetwork(m);
      } finally {
        await m.end().catch(() => {});
      }
    };
    if (o.build) await o.build(masterUrl, guard, async () => void (await isolate()));
    const r = await isolate();
    if (r) {
      notes.push(
        r.replaced.length
          ? `Outbound HTTP is switched off in the copies: ${r.replaced.length} function(s) (${r.replaced.slice(0, 6).join(', ')}${r.replaced.length > 6 ? ', ...' : ''}) do nothing there.`
          : 'Outbound HTTP is switched off in the copies: no pg_net or http functions were found.'
      );
      if (r.remaining.length) notes.push(`Not switched off: ${r.remaining.join(', ')} can still open connections from a copy.`);
    }
    if (o.build && o.verifyMaster) await o.verifyMaster(masterUrl);
    // Masking comes before everything else that reads or copies the master: pgTAP, the baseline and every break copy.
    let masked: MaskedColumn[] = [];
    if (o.masks?.length) {
      const m = await guard.connect(withDatabase(o.adminUrl ?? o.sourceUrl, master));
      try {
        masked = await applyMasks(m, o.masks);
      } finally {
        await m.end().catch(() => {});
      }
      notes.push(`Masked ${masked.length} column(s) in the first copy before any break ran: ${masked.map((c) => `${c.column} (${c.rows} row(s))`).join(', ')}.`);
    }
    if (o.prepareMaster) await o.prepareMaster(masterUrl);

    let counter = 0;
    const withCopy = async <T>(brk: Break | null, fn: (dbUrl: string) => Promise<T>): Promise<T> => {
      const name = guard.copyName(++counter);
      const a = await guard.connect(adminUrl);
      try {
        await guard.createCopy(a, name, master, owner);
        const url = withDatabase(o.sourceUrl, name);
        // Connecting checks current_database() against the name. Done for the unbroken copy too.
        const c = await guard.connect(url);
        try {
          if (brk) for (const stmt of brk.apply) await c.query(stmt);
        } finally {
          await c.end().catch(() => {});
        }
        return await fn(url);
      } finally {
        await guard.dropCopy(a, name).catch(() => {});
        await a.end().catch(() => {});
      }
    };

    ready = true;
    return {
      mode: o.emptyMaster ? 'files' : 'template',
      notes,
      masked,
      withBreak: (brk, fn) => withCopy(brk, fn),
      withPristine: (fn) => withCopy(null, fn),
      async dispose() {
        await yieldToSignal();
        uninstall();
        const left = await cleanup();
        if (left.length) throw new Error(leftoverMessage(left));
      }
    };
  } catch (e) {
    await yieldToSignal();
    const left = await cleanup().catch(() => [] as string[]);
    if (left.length) (e as Error).message += `\n${leftoverMessage(left)}`;
    throw e;
  } finally {
    if (!ready) uninstall();
    await admin?.end().catch(() => {});
  }
}

/** --admin-url may only copy and drop on the server that holds the source. Anything else exits 2. */
async function assertSameServer(guard: Guard, sourceUrl: string, adminUrl: string): Promise<{ proven: boolean; how: string }> {
  const src = await guard.connect(sourceUrl);
  const adm = await guard.connect(adminUrl);
  try {
    const a = await readIdentity(src);
    const b = await readIdentity(adm);
    const r = sameServer(a, b, hostPort(sourceUrl), hostPort(adminUrl));
    if (!r.same) {
      throw new Error(
        `--admin-url is not the same server as --db-url (compared: ${r.how}). ` +
          `The admin connection copies and drops databases, so it must be the server that holds the source. Nothing was copied`
      );
    }
    return { proven: r.proven, how: r.how };
  } finally {
    await src.end().catch(() => {});
    await adm.end().catch(() => {});
  }
}

function hostPort(url: string): string {
  const u = new URL(url);
  return `${hostOf(url)}:${u.port || '5432'}`;
}

/** Build mode: an empty master from template0. Nothing is read from the source. */
async function makeEmptyMaster(guard: Guard, admin: Db, master: string, owner: string): Promise<{ ok: true } | { ok: false; reason: string }> {
  try {
    await guard.createCopy(admin, master, 'template0', owner);
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: (e as Error).message };
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
    const why = guard.terminateDeniedReason
      ? guard.terminateDeniedReason
      : o.allowRemote
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
