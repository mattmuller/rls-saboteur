import pg from 'pg';
import { withDatabase } from './config.js';
import { qi } from './sql.js';
import type { Break } from './types.js';

/**
 * Isolation.
 *
 * Template mode: every break runs on its own copy of the database, made with
 * CREATE DATABASE ... TEMPLATE. Postgres only allows that when nobody else is
 * connected to the source, and a running local Supabase stack always has
 * services connected (auth, REST, realtime). So the source is copied ONCE into
 * a master template, and each break copies the master. Taking that first copy
 * may need those connections closed for a moment. They reconnect by themselves.
 *
 * In-place mode: when no copy can be made, the break is applied to the real
 * local database and put back afterwards, one at a time.
 */

const PREFIX = 'saboteur_';

export type IsolationMode = 'auto' | 'template' | 'in-place';

export interface Isolation {
  mode: 'template' | 'in-place';
  /** Notes to show the user (what was disconnected, why in-place). */
  notes: string[];
  withBreak<T>(brk: Break, fn: (dbUrl: string) => Promise<T>): Promise<T>;
  /** A database with no break applied, for the baseline check on the copy. */
  withPristine<T>(fn: (dbUrl: string) => Promise<T>): Promise<T>;
  dispose(): Promise<void>;
}

async function connect(url: string): Promise<pg.Client> {
  const c = new pg.Client({ connectionString: url });
  c.on('error', () => {});
  await c.connect();
  return c;
}

function sqlstate(e: unknown): string | undefined {
  return (e as { code?: string }).code;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Drop copies left behind by earlier runs that died. Only copies whose owning process is gone. */
export async function sweepStale(admin: pg.Client): Promise<number> {
  const res = await admin.query(`select datname from pg_database where datname like 'saboteur\\_%'`);
  let dropped = 0;
  for (const { datname } of res.rows as { datname: string }[]) {
    // Only databases this tool named: saboteur_<pid>_tpl or saboteur_<pid>_<n>.
    const m = /^saboteur_(\d+)_(?:tpl|\d+)$/.exec(datname);
    if (!m || pidAlive(Number(m[1]))) continue;
    try {
      await admin.query(`drop database if exists ${qi(datname)} with (force)`);
      dropped++;
    } catch {
      /* leave it; not ours to fight over */
    }
  }
  return dropped;
}

export interface IsolationOptions {
  sourceUrl: string;
  mode: IsolationMode;
  /** Allow closing other connections to the source for the first copy. */
  terminate: boolean;
  /**
   * A superuser URL, used only to copy and drop databases. A local Supabase stack keeps
   * connections open as a superuser (the cron scheduler), which the normal role cannot close.
   */
  adminUrl?: string;
  /** Runs once on the master template, e.g. installing pgTAP. */
  prepareMaster?: (masterUrl: string) => Promise<void>;
}

export async function createIsolation(o: IsolationOptions): Promise<Isolation> {
  const sourceDb = decodeURIComponent(new URL(o.sourceUrl).pathname.slice(1));
  const adminDb = sourceDb === 'template1' ? 'postgres' : 'template1';
  const adminUrl = withDatabase(o.adminUrl ?? o.sourceUrl, adminDb);
  const owner = decodeURIComponent(new URL(o.sourceUrl).username);
  const notes: string[] = [];

  if (o.mode === 'in-place') return inPlace(o.sourceUrl, notes, 'in-place mode was requested');

  const admin = await connect(adminUrl);
  let master = '';
  let result: Isolation | null = null;
  try {
    await sweepStale(admin);
    master = `${PREFIX}${process.pid}_tpl`;
    const created = await makeMaster(admin, sourceDb, master, owner, o.terminate, notes, Boolean(o.adminUrl));
    if (!created.ok) {
      if (o.mode === 'template') {
        throw new Error(
          `Could not copy the database: ${created.reason}\n` +
            `Drop --isolation template to fall back to in-place mode.`
        );
      }
      return await inPlace(o.sourceUrl, notes, created.reason);
    }
    const masterUrl = withDatabase(o.sourceUrl, master);
    try {
      if (o.prepareMaster) await o.prepareMaster(masterUrl);
    } catch (e) {
      await admin.query(`drop database if exists ${qi(master)} with (force)`).catch(() => {});
      throw e;
    }

    let counter = 0;
    const live = new Set<string>();
    const withCopy = async <T>(brk: Break | null, fn: (dbUrl: string) => Promise<T>): Promise<T> => {
      const name = `${PREFIX}${process.pid}_${++counter}`;
      const a = await connect(adminUrl);
      live.add(name);
      try {
        await a.query(`create database ${qi(name)} template ${qi(master)}${owner ? ` owner ${qi(owner)}` : ''}`);
        const url = withDatabase(o.sourceUrl, name);
        if (brk) {
          const c = await connect(url);
          try {
            for (const stmt of brk.apply) await c.query(stmt);
          } finally {
            await c.end().catch(() => {});
          }
        }
        return await fn(url);
      } finally {
        await a.query(`drop database if exists ${qi(name)} with (force)`).catch(() => {});
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
        const a = await connect(adminUrl);
        try {
          for (const n of live) await a.query(`drop database if exists ${qi(n)} with (force)`).catch(() => {});
          await a.query(`drop database if exists ${qi(master)} with (force)`).catch(() => {});
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
  admin: pg.Client,
  sourceDb: string,
  master: string,
  owner: string,
  terminate: boolean,
  notes: string[],
  haveAdminUrl: boolean
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const create = () =>
    admin.query(`create database ${qi(master)} template ${qi(sourceDb)}${owner ? ` owner ${qi(owner)}` : ''}`);
  try {
    await create();
    return { ok: true };
  } catch (e) {
    if (sqlstate(e) !== '55006') return { ok: false, reason: (e as Error).message };
  }
  // 55006: the source is in use.
  const others = await admin.query(
    `select count(*)::int as n from pg_stat_activity where datname = $1 and pid <> pg_backend_pid()`,
    [sourceDb]
  );
  const n = others.rows[0].n as number;
  if (!terminate) {
    return { ok: false, reason: `${n} other connection(s) to "${sourceDb}" and --no-terminate was given` };
  }
  // Close the other connections just long enough to copy. Try to stop new ones first.
  let blocked = false;
  try {
    await admin.query(`alter database ${qi(sourceDb)} with allow_connections false`);
    blocked = true;
  } catch {
    /* not the owner: fall back to terminate-and-retry */
  }
  try {
    for (let attempt = 0; attempt < 8; attempt++) {
      // Only sessions this role may signal: its own, or any when it is a superuser.
      await admin.query(
        `select pg_terminate_backend(pid) from pg_stat_activity
          where datname = $1 and pid <> pg_backend_pid()
            and (usesysid = (select oid from pg_roles where rolname = current_user)
                 or (select rolsuper from pg_roles where rolname = current_user))`,
        [sourceDb]
      );
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
        (haveAdminUrl ? '' : ' (a local Supabase keeps a superuser cron connection open; --admin-url lets it be closed)')
    };
  } finally {
    if (blocked) await admin.query(`alter database ${qi(sourceDb)} with allow_connections true`).catch(() => {});
  }
}

/**
 * In-place fallback. Applies one break to the real database, runs the callback,
 * then restores. Serial by construction. Restores on SIGINT and SIGTERM too.
 */
async function inPlace(sourceUrl: string, notes: string[], why: string): Promise<Isolation> {
  notes.push(
    `No database copy was made (${why}). Each break is applied to your local database and put back afterwards, one at a time.`
  );
  let current: Break | null = null;
  let chain: Promise<unknown> = Promise.resolve();

  const restoreCurrent = async (): Promise<void> => {
    if (!current) return;
    const c = await connect(sourceUrl);
    try {
      for (const stmt of current.restore) await c.query(stmt);
      current = null;
    } finally {
      await c.end().catch(() => {});
    }
  };
  const onSignal = (sig: NodeJS.Signals): void => {
    restoreCurrent().finally(() => process.exit(sig === 'SIGINT' ? 130 : 143));
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  return {
    mode: 'in-place',
    notes,
    withPristine: (fn) => fn(sourceUrl),
    withBreak(brk, fn) {
      const run = async () => {
        const c = await connect(sourceUrl);
        current = brk;
        try {
          for (const stmt of brk.apply) await c.query(stmt);
          await c.end();
          return await fn(sourceUrl);
        } finally {
          await c.end().catch(() => {});
          await restoreCurrent();
        }
      };
      const next = chain.then(run, run);
      chain = next.catch(() => {});
      return next as Promise<never>;
    },
    async dispose() {
      process.off('SIGINT', onSignal);
      process.off('SIGTERM', onSignal);
      await restoreCurrent();
    }
  };
}
