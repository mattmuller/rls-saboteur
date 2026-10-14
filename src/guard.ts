import { randomUUID } from 'node:crypto';
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

/** Pure rule: may this name be dropped, given its comment? Used by every drop. */
export function droppable(
  name: string,
  label: string | null,
  sourceDb: string,
  token: string,
  isAlive: (pid: number) => boolean = pidAlive
): { ok: true } | { ok: false; why: string } {
  if (name === sourceDb) return { ok: false, why: `"${name}" is the source database` };
  if (!name.startsWith(PREFIX)) return { ok: false, why: `"${name}" does not start with ${PREFIX}` };
  if (label === null) return { ok: false, why: `"${name}" has no rls-saboteur label` };
  if (label === LABEL_PREFIX + token) return { ok: true };
  const pid = copyOwnerPid(name);
  if (label.startsWith(LABEL_PREFIX) && pid !== null && !isAlive(pid)) return { ok: true };
  return { ok: false, why: `"${name}" is not labelled as a copy made by this run, or by a run that has died` };
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

export class Guard {
  readonly sourceDb: string;
  readonly allowTerminate: boolean;
  readonly token = randomUUID();
  private readonly labelled = new Set<string>();
  private readonly justCreated = new Set<string>();

  constructor(o: GuardOptions) {
    this.sourceDb = databaseOf(o.sourceUrl);
    this.allowTerminate = o.allowTerminate;
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
    if (/pg_terminate_backend|pg_cancel_backend/i.test(s)) {
      if (!this.allowTerminate) throw new GuardError('closing other sessions is not allowed here (remote host, --allow-remote..., or --no-terminate)');
      if (normalise(TERMINATE_SQL) !== s) throw new GuardError(`unexpected session-closing statement: ${snippet(sql)}`);
      return;
    }
    let m = /^create database ("(?:[^"]|"")+") template ("(?:[^"]|"")+")(?: owner ("(?:[^"]|"")+"))?$/i.exec(s);
    if (m) {
      const name = parseIdent(m[1]);
      const tpl = parseIdent(m[2]);
      if (!name || !tpl) throw new GuardError('bad create database');
      if (name === this.sourceDb || !name.startsWith(PREFIX)) throw new GuardError(`will not create "${name}"`);
      const isMaster = /^saboteur_\d+_tpl$/.test(name);
      if (isMaster ? tpl !== this.sourceDb : !this.labelled.has(tpl)) throw new GuardError(`"${name}" may not be copied from "${tpl}"`);
      return;
    }
    m = /^comment on database ("(?:[^"]|"")+") is '([^']*)'$/i.exec(s);
    if (m) {
      const name = parseIdent(m[1]);
      if (!name || name === this.sourceDb || !name.startsWith(PREFIX)) throw new GuardError('will not label that database');
      if (m[2] !== LABEL_PREFIX + this.token) throw new GuardError('wrong label');
      return;
    }
    m = /^drop database if exists ("(?:[^"]|"")+") with \(force\)$/i.exec(s);
    if (m) {
      const name = parseIdent(m[1]);
      if (!name || name === this.sourceDb || !name.startsWith(PREFIX)) throw new GuardError(`will not drop "${name}"`);
      return; // the label is checked in query(), which has the connection
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
    if (role === 'source') {
      const r = await client.query('show default_transaction_read_only');
      if (r.rows[0]?.default_transaction_read_only !== 'on') {
        await client.end().catch(() => {});
        throw new GuardError('could not make the connection to the source read-only');
      }
    }
    return {
      end: () => client.end(),
      query: async (text: string, values?: unknown[]) => {
        this.check(role, text);
        const s = normalise(text);
        const drop = /^drop database if exists ("(?:[^"]|"")+") with \(force\)$/i.exec(s);
        if (role === 'admin' && drop) {
          const name = parseIdent(drop[1])!;
          const r = await client.query(`select shobj_description(oid, 'pg_database') as c from pg_database where datname = $1`, [name]);
          if (r.rowCount === 0) return r; // nothing to drop
          const label = (r.rows[0].c as string | null) ?? null;
          const pending = this.justCreated.has(name);
          const d = droppable(name, label, this.sourceDb, this.token);
          if (!d.ok && !(pending && label === null)) throw new GuardError(d.why);
        }
        const res = await client.query(text, values as unknown[]);
        if (role === 'admin') {
          const c = /^create database ("(?:[^"]|"")+")/i.exec(s);
          if (c) this.justCreated.add(parseIdent(c[1])!);
          const l = /^comment on database ("(?:[^"]|"")+")/i.exec(s);
          if (l) {
            const n = parseIdent(l[1])!;
            this.labelled.add(n);
            this.justCreated.delete(n);
          }
        }
        return res;
      }
    };
  }

  /** Create a copy and label it straight away. The copy is only usable once it is labelled. */
  async createCopy(admin: Db, name: string, template: string, owner: string): Promise<void> {
    await admin.query(`create database ${qi(name)} template ${qi(template)}${owner ? ` owner ${qi(owner)}` : ''}`);
    await admin.query(`comment on database ${qi(name)} is '${LABEL_PREFIX}${this.token}'`);
  }

  urlFor(baseUrl: string, name: string): string {
    return withDatabase(baseUrl, name);
  }

  /** Drop a copy of this run. The guard checks the label. */
  async dropCopy(admin: Db, name: string): Promise<void> {
    await admin.query(`drop database if exists ${qi(name)} with (force)`);
  }
}

function snippet(sql: string): string {
  const s = normalise(sql);
  return s.length > 80 ? s.slice(0, 77) + '...' : s;
}
