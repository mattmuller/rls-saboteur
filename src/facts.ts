import type { Db } from './guard.js';
import { visible } from './confirm.js';

/** What the server itself says about the database we are about to copy. Read-only selects. */
export interface ServerFacts {
  version: string;
  addr: string | null;
  port: number | null;
  sizeBytes: number;
  sizePretty: string;
  sessions: { app: string; addr: string | null }[];
}

export async function readFacts(c: Db): Promise<ServerFacts> {
  const v = await c.query(
    `select current_setting('server_version') as version, inet_server_addr()::text as addr, inet_server_port() as port,
            pg_database_size(current_database())::text as bytes, pg_size_pretty(pg_database_size(current_database())) as pretty`
  );
  const row = v.rows[0];
  if (!row || row.bytes === undefined) throw new Error('the server did not report the size of the database');
  const s = await c.query(
    `select coalesce(application_name, '') as app, client_addr::text as addr
       from pg_stat_activity where datname = current_database() and pid <> pg_backend_pid() order by 1, 2`
  );
  return {
    version: String(row.version),
    addr: row.addr ?? null,
    port: row.port === null || row.port === undefined ? null : Number(row.port),
    sizeBytes: Number(row.bytes),
    sizePretty: String(row.pretty),
    sessions: s.rows.map((r) => ({ app: String(r.app ?? ''), addr: r.addr ?? null }))
  };
}

/** What identifies a server process. Each part is undefined when this role may not read it. */
export interface Identity {
  sysid?: string;
  addr?: string | null;
  port?: number | null;
  dataDir?: string;
}

export async function readIdentity(c: Db): Promise<Identity> {
  const id: Identity = {};
  try {
    id.sysid = String((await c.query('select system_identifier::text as s from pg_control_system()')).rows[0]?.s ?? '') || undefined;
  } catch {
    /* needs superuser */
  }
  try {
    const r = await c.query(`select inet_server_addr()::text as addr, inet_server_port() as port, current_setting('data_directory') as dir`);
    id.addr = r.rows[0]?.addr ?? null;
    id.port = r.rows[0]?.port === null || r.rows[0]?.port === undefined ? null : Number(r.rows[0].port);
    id.dataDir = r.rows[0]?.dir || undefined;
  } catch {
    try {
      const r = await c.query(`select inet_server_addr()::text as addr, inet_server_port() as port`);
      id.addr = r.rows[0]?.addr ?? null;
      id.port = r.rows[0]?.port === null || r.rows[0]?.port === undefined ? null : Number(r.rows[0].port);
    } catch {
      /* leave unknown */
    }
  }
  return id;
}

/**
 * Do two connections reach the same Postgres server? Best proof first: the cluster's system identifier (superuser).
 * Then the address, port and data directory together. If neither is readable, only an identical host and port
 * will do, and that is NOT proof ("localhost" and "127.0.0.1" are not treated as equal): `proven` is false, so the
 * caller may copy but must not close sessions.
 */
export function sameServer(
  a: Identity,
  b: Identity,
  hostPortA: string,
  hostPortB: string
): { same: boolean; proven: boolean; how: string } {
  if (a.sysid && b.sysid) return { same: a.sysid === b.sysid, proven: true, how: 'cluster system identifier' };
  if (a.dataDir && b.dataDir && a.port != null && b.port != null) {
    return { same: a.addr === b.addr && a.port === b.port && a.dataDir === b.dataDir, proven: true, how: 'server address, port and data directory' };
  }
  return { same: hostPortA === hostPortB, proven: false, how: 'host and port (the server could not be asked)' };
}

/** The lines shown in the plan and in --dry-run. All text from the server is written out visibly. */
export function describeFacts(f: ServerFacts, dbName: string): string[] {
  const sessions = f.sessions
    .slice(0, 5)
    .map((x) => `${visible(x.app || 'no application name')} from ${visible(x.addr ?? 'socket')}`)
    .join(', ');
  return [
    `Server: PostgreSQL ${visible(f.version)}. Server reports address ${visible(f.addr ?? '(unix socket)')} port ${f.port ?? '(unknown)'}.`,
    `Size of "${visible(dbName)}": ${visible(f.sizePretty)}`,
    `Other sessions: ${f.sessions.length}${f.sessions.length ? ` (${sessions}${f.sessions.length > 5 ? ', ...' : ''})` : ''}`
  ];
}
