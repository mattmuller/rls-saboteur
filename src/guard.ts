import { createHash, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { hostname } from 'node:os';
import { readFileSync, readlinkSync } from 'node:fs';
import pg from 'pg';
import { withDatabase } from './config.js';
import { qi } from './sql.js';

/**
 * The structural guard. Every pg connection in this tool is opened by Guard.connect, and every
 * statement goes through the allowlist below BEFORE it is sent. There are three kinds of connection:
 *
 *  - copy:   a database this run created and labelled. Anything goes. It is thrown away.
 *  - admin:  template1 or postgres (never the source). May only create, label and drop labelled
 *            copies, run read-only selects, and (when allowed) close sessions on the source.
 *  - source: every other database, above all the one the user pointed us at. Read-only selects
 *            only, and the session itself is read-only (default_transaction_read_only=on).
 *
 * The owner's rule: the tool must never jeopardise any database other than its own copies.
 */

export const PREFIX = 'saboteur_';
export const LABEL_PREFIX = 'rls-saboteur copy ';

function bootId(): string {
  try {
    if (process.platform === 'linux') return readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
    if (process.platform === 'darwin') return execFileSync('sysctl', ['-n', 'kern.bootsessionuuid'], { encoding: 'utf8', timeout: 2000 }).trim();
  } catch {
    /* fall through */
  }
  return '';
}

/** Linux only: the pid namespace this process lives in. Two containers can share a kernel and a hostname but never this. */
function pidNamespace(): string {
  try {
    if (process.platform === 'linux') return readlinkSync('/proc/self/ns/pid');
  } catch {
    /* fall through */
  }
  return '';
}

/** The host id for given inputs. Pure, so a test can show that each of the three changes the result. */
export function hostIdFrom(host: string, boot: string, pidNs: string): string {
  return createHash('sha256').update(`${host}\0${boot}\0${pidNs}`).digest('hex').slice(0, 12);
}

let cachedHostId: string | undefined;
/**
 * Names the machine, boot and pid namespace this process runs on. A pid is only meaningful where it was issued, so a
 * copy made by another host (a second CI runner, another container, another pid namespace) must never be
 * judged "dead" by looking at our own process table.
 */
export function hostId(): string {
  cachedHostId ??= hostIdFrom(hostname(), bootId(), pidNamespace());
  return cachedHostId;
}

/** A new random token for one run: 16 hex characters, used in the database names and in the label. */
export function newToken(): string {
  return randomBytes(8).toString('hex');
}

/**
 * The name of a database this tool creates. It carries the identity of its maker (host, pid, run token), so that a copy
 * is recognisable even when the COMMENT that labels it was never written (an interrupt or a kill between CREATE and COMMENT).
 * suffix is "tpl" for the master template, or the number of the per-break copy. At most 9 + 12 + 1 + 10 + 1 + 16 + 4 = 53 bytes.
 */
export function copyNameFor(host: string, pid: number, token: string, suffix: string | number): string {
  return `${PREFIX}${host}_${pid}_${token}_${suffix}`;
}

export interface CopyName {
  host: string;
  pid: number;
  token: string;
  suffix: string;
}

/** Reads the identity out of a database name made by copyNameFor, or null for any other name. */
export function parseCopyName(name: string): CopyName | null {
  const m = /^saboteur_([0-9a-f]{12})_(\d{1,10})_([0-9a-f]{16})_(tpl|\d{1,9})$/.exec(name);
  return m ? { host: m[1], pid: Number(m[2]), token: m[3], suffix: m[4] } : null;
}

/** Returns a message when the source database itself has the name of a saboteur copy. Such a source is never accepted. */
export function sourceNameProblem(db: string): string | null {
  if (parseCopyName(db) !== null || copyOwnerPid(db) !== null) {
    return `The database "${db}" has the name of a copy made by rls-saboteur. Point --db-url at your own database, not at a copy.`;
  }
  return null;
}

/** The comment written on a copy: who made it (token) and where (host). */
export function labelFor(token: string): string {
  return `${LABEL_PREFIX}${token} host=${hostId()}`;
}

/** Splits a copy's comment. host is undefined for a label without a host id (older versions). */
export function parseLabel(label: string): { token: string; host?: string } | null {
  if (!label.startsWith(LABEL_PREFIX)) return null;
  const m = /^(\S+)(?: host=(\S+))?$/.exec(label.slice(LABEL_PREFIX.length));
  return m ? { token: m[1], host: m[2] } : null;
}

/** Cancels our own in-flight CREATE DATABASE. query() allows it only for a backend pid it saw running one. */
export const CANCEL_SQL = 'select pg_cancel_backend($1)';

export const TERMINATE_SQL = `select pg_terminate_backend(pid) from pg_stat_activity
          where datname = $1 and pid <> pg_backend_pid()
            and (usesysid = (select oid from pg_roles where rolname = current_user)
                 or (select rolsuper from pg_roles where rolname = current_user))`;

export type Role = 'copy' | 'admin' | 'source';

export class GuardError extends Error {
  constructor(message: string) {
    super(`Refused by the safety guard: ${message}`);
    this.name = 'GuardError';
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** The pid in a database name this tool created, or null for any other name. */
export function copyOwnerPid(datname: string): number | null {
  const m = /^saboteur_(\d+)_(?:tpl|\d+)$/.exec(datname);
  return m ? Number(m[1]) : null;
}

export function databaseOf(url: string): string {
  return decodeURIComponent(new URL(url).pathname.slice(1));
}

/** Comments and the contents of string literals removed, whitespace collapsed, one trailing ; dropped. */
export function normalise(sql: string): string {
  let s = sql.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ');
  s = s.replace(/\s+/g, ' ').trim();
  return s.replace(/;\s*$/, '').trim();
}

function blankLiterals(s: string): string {
  return s.replace(/'(?:[^']|'')*'/g, "''");
}

const WRITE_WORDS =
  /\b(insert|update|delete|merge|into|alter|drop|create|truncate|grant|revoke|copy|call|do|vacuum|reindex|cluster|comment|lock|listen|notify|set|reset|refresh|prepare|execute|declare|begin|commit|rollback|savepoint|discard|load|import|security)\b/i;
const WRITE_FUNCTIONS =
  /\b(pg_terminate_backend|pg_cancel_backend|set_config|nextval|setval|lo_import|lo_export|lo_create|lo_unlink|dblink\w*|pg_advisory\w*|pg_reload_conf|pg_switch_wal|pg_create_\w+|pg_drop_\w+|pg_rotate_logfile|pg_promote|pg_read_file|pg_ls_dir|query_to_xml\w*)\b/i;

/** True only for one plain read: a SELECT or WITH ... SELECT with nothing in it that writes. */
export function isReadOnlySql(sql: string): boolean {
  const s = normalise(sql);
  if (!/^(select|with)\b/i.test(s)) return false;
  if (s.includes(';')) return false;
  if (/\$[A-Za-z_]*\$/.test(s)) return false;
  const code = blankLiterals(s);
  if (code.includes(';')) return false;
  if (WRITE_WORDS.test(code) || WRITE_FUNCTIONS.test(code)) return false;
  return true;
}

function parseIdent(s: string): string | null {
  const m = /^"((?:[^"]|"")+)"$/.exec(s);
  return m ? m[1].replace(/""/g, '"') : null;
}

/**
 * Pure rule: may this name be dropped? Used by every drop.
 * The identity comes from the NAME when it has the current format (host, pid, run token), and from the label otherwise
 * (names of 0.1.x and 0.2.0-dev: saboteur_<pid>_...). A database is droppable only when it is not the source, and it was
 * made by this run, or by a process of this host that is dead. If the name and the label both speak, they must agree.
 */
export function droppable(
  name: string,
  label: string | null,
  sourceDb: string,
  token: string,
  isAlive: (pid: number) => boolean = pidAlive,
  host: string = hostId()
): { ok: true } | { ok: false; why: string } {
  if (name === sourceDb) return { ok: false, why: `"${name}" is the source database` };
  if (!name.startsWith(PREFIX)) return { ok: false, why: `"${name}" does not start with ${PREFIX}` };
  const parsed = label === null ? null : parseLabel(label);
  const id = parseCopyName(name);
  if (id) {
    if (parsed && (parsed.token !== id.token || (parsed.host !== undefined && parsed.host !== id.host))) {
      return { ok: false, why: `"${name}" has a label that does not match its name` };
    }
    if (id.token === token && id.host === host) return { ok: true };
    if (id.host === host && !isAlive(id.pid)) return { ok: true };
    return { ok: false, why: `"${name}" was not made by this run, and is not a copy of a dead process of this host` };
  }
  if (label === null) return { ok: false, why: `"${name}" has no rls-saboteur label` };
  if (parsed && parsed.token === token) return { ok: true };
  const pid = copyOwnerPid(name);
  if (parsed && parsed.host === host && pid !== null && !isAlive(pid)) return { ok: true };
  return { ok: false, why: `"${name}" is not labelled as a copy made by this run, or by a run of this host that has died` };
}

export interface GuardOptions {
  sourceUrl: string;
  /** Closing other sessions on the source. Only ever true for a local source without the remote flag. */
  allowTerminate: boolean;
}

export interface Db {
  query(text: string, values?: unknown[]): Promise<pg.QueryResult>;
  end(): Promise<void>;
}

/** What a cleanup has to know about CREATE DATABASE statements this run has started and not yet seen finish. */
export interface InflightCreate {
  /** The server process running it (the admin connection's backend pid). */
  pid: number;
  name: string;
}

export class Guard {
  readonly sourceDb: string;
  /** Closing other sessions on the source. Starts as given and can only be switched off (denyTerminate). */
  allowTerminate: boolean;
  /** Why closing sessions was switched off after construction, for the message to the user. */
  terminateDeniedReason?: string;
  readonly token = newToken();
  private readonly labelled = new Set<string>();
  /** CREATE DATABASE statements sent and not yet finished, by backend pid. */
  private readonly inflight = new Map<number, string>();
  /** Every copy name this run has started to create and not yet dropped. Cleanup drops these. */
  readonly attempted = new Set<string>();
  private closing = false;

  constructor(o: GuardOptions) {
    this.sourceDb = databaseOf(o.sourceUrl);
    this.allowTerminate = o.allowTerminate;
  }

  /** Switch off closing sessions for the rest of the run. There is no way back on. */
  denyTerminate(reason: string): void {
    this.allowTerminate = false;
    this.terminateDeniedReason = reason;
  }

  /** After this, no new CREATE DATABASE is sent. Cleanup calls it first so that a worker cannot start another copy. */
  stopCreating(): void {
    this.closing = true;
  }

  /** The CREATE DATABASE statements in flight right now. */
  inflightCreates(): InflightCreate[] {
    return [...this.inflight].map(([pid, name]) => ({ pid, name }));
  }

  /** Resolves true when no CREATE DATABASE of this run is in flight, or false after timeoutMs. */
  async waitCreatesEnded(timeoutMs: number): Promise<boolean> {
    const end = Date.now() + timeoutMs;
    while (this.inflight.size > 0) {
      if (Date.now() >= end) return false;
      await new Promise((r) => setTimeout(r, 50));
    }
    return true;
  }

  /** True for a name this run (this host, this pid, this token) is allowed to create. */
  private isOwnName(name: string): CopyName | null {
    const id = parseCopyName(name);
    return id && id.host === hostId() && id.pid === process.pid && id.token === this.token ? id : null;
  }

  /** The master template name of this run. */
  masterName(): string {
    return copyNameFor(hostId(), process.pid, this.token, 'tpl');
  }

  /** The name of the n-th per-break copy of this run. */
  copyName(n: number): string {
    return copyNameFor(hostId(), process.pid, this.token, n);
  }

  roleOf(db: string): Role {
    if (this.labelled.has(db)) return 'copy';
    if (db !== this.sourceDb && (db === 'template1' || db === 'postgres')) return 'admin';
    return 'source';
  }

  /** Throws unless this statement is allowed on a connection of this role. */
  check(role: Role, sql: string): void {
    if (role === 'copy') return;
    if (isReadOnlySql(sql)) return;
    if (role === 'source') throw new GuardError(`the source database is read-only. Blocked: ${snippet(sql)}`);
    const s = normalise(sql);
    if (/pg_cancel_backend/i.test(s)) {
      // Only ever our own in-flight CREATE; query() checks the pid.
      if (normalise(CANCEL_SQL) !== s) throw new GuardError(`unexpected statement: ${snippet(sql)}`);
      return;
    }
    if (/pg_terminate_backend/i.test(s)) {
      if (!this.allowTerminate) {
        throw new GuardError(this.terminateDeniedReason ?? 'closing other sessions is not allowed here (remote host, --allow-remote..., or --no-terminate)');
      }
      if (normalise(TERMINATE_SQL) !== s) throw new GuardError(`unexpected session-closing statement: ${snippet(sql)}`);
      return;
    }
    let m = /^create database ("(?:[^"]|"")+") template ("(?:[^"]|"")+")(?: owner ("(?:[^"]|"")+"))?$/i.exec(s);
    if (m) {
      const name = parseIdent(m[1]);
      const tpl = parseIdent(m[2]);
      if (!name || !tpl) throw new GuardError('bad create database');
      if (name === this.sourceDb || !name.startsWith(PREFIX)) throw new GuardError(`will not create "${name}"`);
      const id = this.isOwnName(name);
      if (!id) throw new GuardError(`will not create "${name}": it is not a name of this run`);
      if (this.closing) throw new GuardError('the run is shutting down, so no new copy is started');
      if (id.suffix === 'tpl' ? tpl !== this.sourceDb : !this.labelled.has(tpl)) throw new GuardError(`"${name}" may not be copied from "${tpl}"`);
      return;
    }
    m = /^comment on database ("(?:[^"]|"")+") is '([^']*)'$/i.exec(s);
    if (m) {
      const name = parseIdent(m[1]);
      if (!name || name === this.sourceDb || !this.isOwnName(name)) throw new GuardError('will not label that database');
      if (m[2] !== labelFor(this.token)) throw new GuardError('wrong label');
      return;
    }
    m = /^drop database if exists ("(?:[^"]|"")+") with \(force\)$/i.exec(s);
    if (m) {
      const name = parseIdent(m[1]);
      if (!name || name === this.sourceDb || !name.startsWith(PREFIX)) throw new GuardError(`will not drop "${name}"`);
      return; // the label and the name are checked in query(), which has the connection
    }
    throw new GuardError(`the admin connection may not run: ${snippet(sql)}`);
  }

  async connect(url: string): Promise<Db> {
    const db = databaseOf(url);
    const role = this.roleOf(db);
    const u = new URL(url);
    let cfg: pg.ClientConfig;
    if (role === 'source') {
      // Our own startup option must win: a ?options= in the URL would override it.
      u.searchParams.delete('options');
      cfg = { connectionString: u.toString(), options: '-c default_transaction_read_only=on' };
    } else {
      cfg = { connectionString: url };
    }
    const client = new pg.Client(cfg);
    client.on('error', () => {});
    await client.connect();
    // Whatever the URL said, the session must be on the database we meant. Checked on every connection.
    const where = await client.query('select current_database() as d');
    if (where.rows[0]?.d !== db) {
      await client.end().catch(() => {});
      throw new GuardError(`the connection for "${db}" landed on "${String(where.rows[0]?.d)}"`);
    }
    if (role === 'source') {
      const r = await client.query('show default_transaction_read_only');
      if (r.rows[0]?.default_transaction_read_only !== 'on') {
        await client.end().catch(() => {});
        throw new GuardError('could not make the connection to the source read-only');
      }
    }
    // The server process behind this connection, known from the connect handshake (no statement is sent).
    const backendPid = (client as unknown as { processID?: number }).processID;
    return {
      end: () => client.end(),
      query: async (text: string, values?: unknown[]) => {
        this.check(role, text);
        const s = normalise(text);
        if (role === 'admin' && normalise(CANCEL_SQL) === s) {
          const target = values?.length === 1 ? values[0] : undefined;
          if (typeof target !== 'number' || ![...this.inflight.keys()].includes(target)) {
            throw new GuardError('pg_cancel_backend is only allowed for the backend that runs this run\'s own CREATE DATABASE');
          }
        }
        if (role === 'admin' && normalise(TERMINATE_SQL) === s && !(values?.length === 1 && values[0] === this.sourceDb)) {
          throw new GuardError('sessions may only be closed on the source database');
        }
        const drop = /^drop database if exists ("(?:[^"]|"")+") with \(force\)$/i.exec(s);
        if (role === 'admin' && drop) {
          const name = parseIdent(drop[1])!;
          const r = await client.query(`select shobj_description(oid, 'pg_database') as c from pg_database where datname = $1`, [name]);
          if (r.rowCount === 0) {
            this.attempted.delete(name);
            return r; // nothing to drop
          }
          const label = (r.rows[0].c as string | null) ?? null;
          const d = droppable(name, label, this.sourceDb, this.token);
          if (!d.ok) throw new GuardError(d.why);
        }
        const create = role === 'admin' ? /^create database ("(?:[^"]|"")+")/i.exec(s) : null;
        if (create) {
          const n = parseIdent(create[1])!;
          this.attempted.add(n);
          if (backendPid !== undefined) this.inflight.set(backendPid, n);
        }
        let res: pg.QueryResult;
        try {
          res = await client.query(text, values as unknown[]);
        } finally {
          if (create && backendPid !== undefined) this.inflight.delete(backendPid);
        }
        if (role === 'admin') {
          const l = /^comment on database ("(?:[^"]|"")+")/i.exec(s);
          if (l) this.labelled.add(parseIdent(l[1])!);
          if (drop) this.attempted.delete(parseIdent(drop[1])!);
        }
        return res;
      }
    };
  }

  /** Create a copy and label it straight away. The copy is only usable once it is labelled. */
  async createCopy(admin: Db, name: string, template: string, owner: string): Promise<void> {
    await admin.query(`create database ${qi(name)} template ${qi(template)}${owner ? ` owner ${qi(owner)}` : ''}`);
    await admin.query(`comment on database ${qi(name)} is '${labelFor(this.token)}'`);
  }

  urlFor(baseUrl: string, name: string): string {
    return withDatabase(baseUrl, name);
  }

  /** Drop a copy of this run. The guard checks the label and the name. */
  async dropCopy(admin: Db, name: string): Promise<void> {
    await admin.query(`drop database if exists ${qi(name)} with (force)`);
  }
}

function snippet(sql: string): string {
  const s = normalise(sql);
  return s.length > 80 ? s.slice(0, 77) + '...' : s;
}

/** Connect to `url` and confirm the session is on the database the URL names. Used before a test runner starts. */
export async function verifyDatabase(url: string): Promise<void> {
  const want = databaseOf(url);
  const client = new pg.Client({ connectionString: url });
  client.on('error', () => {});
  await client.connect();
  try {
    const r = await client.query('select current_database() as d');
    if (r.rows[0]?.d !== want) throw new GuardError(`the test database "${want}" resolved to "${String(r.rows[0]?.d)}"`);
  } finally {
    await client.end().catch(() => {});
  }
}
