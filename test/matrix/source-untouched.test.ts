import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * The owner's requirement: the tool must never jeopardise any database other than its own copy.
 * Real Postgres. Needs SABOTEUR_MATRIX_URL (npm run test:matrix starts the cluster).
 * Each test takes a catalogue snapshot of the source, runs the CLI, and compares.
 */
const superUrl = process.env.SABOTEUR_MATRIX_URL;
const root = join(import.meta.dirname, '..', '..');
const cli = join(root, 'dist', 'cli.js');
const fixture = join(root, 'test', 'fixtures', 'plain-postgres');
const DB = 'rls_fx_guard_src';

const urlFor = (db: string, user?: { name: string; password: string }): string => {
  const u = new URL(superUrl!);
  u.pathname = '/' + db;
  if (user) {
    u.username = user.name;
    u.password = user.password;
  }
  return u.toString();
};
const owner = { name: 'app_owner', password: 'owner' };

async function open(url: string, app?: string): Promise<pg.Client> {
  const c = new pg.Client({ connectionString: url, application_name: app });
  c.on('error', () => {});
  await c.connect();
  return c;
}

async function reset(): Promise<void> {
  const c = await open(urlFor('postgres'));
  try {
    const dbs = await c.query(`select datname from pg_database where datname like 'rls\\_fx\\_%' or datname like 'saboteur\\_%'`);
    for (const { datname } of dbs.rows) await c.query(`drop database "${datname}" with (force)`);
    const roles = await c.query(`select rolname from pg_roles where rolname !~ '^pg_' and rolname <> current_user and not rolsuper`);
    for (const { rolname } of roles.rows) await c.query(`drop role "${rolname}"`);
    await c.query(`create database ${DB}`);
  } finally {
    await c.end();
  }
  const load = spawnSync('psql', ['-X', '-q', '-v', 'ON_ERROR_STOP=1', '-f', join(fixture, 'schema.sql'), urlFor(DB)], { encoding: 'utf8' });
  expect(load.status, load.stderr).toBe(0);
  // Bulk data in a table without policies, so that copying the database takes a measurable moment.
  const c2 = await open(urlFor(DB));
  await c2.query(`create table bulk as select g as id, repeat('x', 400) as pad from generate_series(1, 600000) g`);
  await c2.end();
}

/** Everything about the source that a write, a setting change or DDL would alter. xmin changes with any DDL. */
async function snapshot(): Promise<unknown> {
  const s = await open(urlFor(DB));
  const a = await open(urlFor('postgres'));
  try {
    const q = async (c: pg.Client, sql: string) => (await c.query(sql)).rows;
    return {
      policies: await q(s, `select schemaname, tablename, policyname, permissive, roles, cmd, qual, with_check from pg_policies order by 1,2,3`),
      policyXmin: await q(s, `select polname, xmin::text from pg_policy order by 1`),
      classes: await q(s, `select oid::text, relname, relrowsecurity, relforcerowsecurity, xmin::text from pg_class where relnamespace = 'public'::regnamespace order by 1`),
      attributes: await q(s, `select count(*)::int as n, max(xmin::text::bigint)::text as newest from pg_attribute where attrelid in (select oid from pg_class where relnamespace = 'public'::regnamespace)`),
      database: await q(a, `select d.*, d.xmin::text as xmin, shobj_description(d.oid, 'pg_database') as comment from pg_database d where datname = '${DB}'`),
      settings: await q(a, `select * from pg_db_role_setting where setdatabase = (select oid from pg_database where datname = '${DB}')`),
      roles: await q(a, `select a.*, a.xmin::text as xmin from pg_authid a order by rolname`),
      memberships: await q(a, `select roleid::text, member::text, grantor::text from pg_auth_members order by 1,2,3`)
    };
  } finally {
    await s.end();
    await a.end();
  }
}

const args = (extra: string[] = []) => [
  cli, '--db-url', urlFor(DB, owner), '--admin-url', urlFor('postgres'), '--runner', 'psql', '--tests-dir', 'tests',
  '--report', join(scratch, 'r.md'), '--json-file', join(scratch, 'r.json'), ...extra
];
let scratch = '';

describe.skipIf(!superUrl)('the source database is never changed', () => {
  beforeAll(() => {
    scratch = mkdtempSync(join(tmpdir(), 'rls-saboteur-guard-'));
  });
  afterAll(async () => {
    if (superUrl) await reset().catch(() => {});
    if (scratch) rmSync(scratch, { recursive: true, force: true });
    if (superUrl) {
      const c = await open(urlFor('postgres'));
      await c.query(`drop database if exists ${DB} with (force)`).catch(() => {});
      await c.end();
    }
  });

  it('source-untouched: a full run leaves the source catalogue byte for byte the same', async () => {
    await reset();
    const before = await snapshot();
    const r = spawnSync('node', args(['--yes']), { cwd: fixture, encoding: 'utf8' });
    expect(r.status, r.stdout + r.stderr).toBe(1); // missed breaks, as in the fixture
    expect(r.stderr).toContain('It will not change this database.');
    expect(await snapshot()).toEqual(before);
    const a = await open(urlFor('postgres'));
    const left = await a.query(`select datname from pg_database where datname like 'saboteur\\_%'`);
    await a.end();
    expect(left.rows).toEqual([]);
  });

  it('source-untouched-busy: closing other sessions leaves the source settings alone, and says so', async () => {
    await reset();
    const before = await snapshot();
    const held = await open(urlFor(DB, owner), 'my-app');
    let closed = false;
    held.on('error', () => (closed = true));
    const r = spawnSync('node', args(['--yes']), { cwd: fixture, encoding: 'utf8' });
    expect(r.status, r.stdout + r.stderr).toBe(1);
    expect(r.stderr).toContain('my-app'); // the plan question lists the application names
    expect(r.stdout + r.stderr).toMatch(/Closed \d+ other connection/);
    expect(await snapshot()).toEqual(before);
    await held.end().catch(() => {});
    void closed;
  });

  it('no-terminate-with-remote-flag: the remote flag never closes a session', async () => {
    await reset();
    const before = await snapshot();
    const held = await open(urlFor(DB, owner), 'my-app');
    const r = spawnSync('node', args(['--yes', '--allow-remote-i-understand-this-locks-tables']), { cwd: fixture, encoding: 'utf8' });
    expect(r.status, r.stdout + r.stderr).toBe(2);
    expect(r.stdout + r.stderr).toMatch(/never done together with the remote flag/);
    // The held session is still alive.
    expect((await held.query('select 1 as one')).rows[0].one).toBe(1);
    await held.end();
    expect(await snapshot()).toEqual(before);
  });

  it('no-prompt-without-yes: a run with no terminal and no --yes exits 2 and makes no copy', async () => {
    await reset();
    const before = await snapshot();
    // Watch for any copy during the run.
    const watcher = await open(urlFor('postgres'));
    let sawCopy = false;
    const timer = setInterval(async () => {
      const r = await watcher.query(`select 1 from pg_database where datname like 'saboteur\\_%'`).catch(() => null);
      if (r && r.rowCount) sawCopy = true;
    }, 5);
    const r = spawnSync('node', args(), { cwd: fixture, encoding: 'utf8', input: '' });
    clearInterval(timer);
    await watcher.end();
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('--yes');
    expect(sawCopy).toBe(false);
    expect(await snapshot()).toEqual(before);
  });

  it('crash-during-first-copy: kill -9 mid-copy leaves the source open and unchanged', async () => {
    let observed = false;
    for (let attempt = 0; attempt < 5 && !observed; attempt++) {
      await reset();
      const before = await snapshot();
      const watcher = await open(urlFor('postgres'));
      const child = spawn('node', args(['--yes']), { cwd: fixture, stdio: 'ignore' });
      const exited = new Promise<void>((res) => child.on('exit', () => res()));
      const deadline = Date.now() + 60_000;
      while (Date.now() < deadline && !observed) {
        const r = await watcher.query(`select 1 from pg_stat_activity where query ilike 'create database "saboteur\\_%' and state = 'active'`);
        if (r.rowCount) {
          child.kill('SIGKILL');
          observed = true;
        } else await new Promise((res) => setTimeout(res, 3));
      }
      if (!observed) child.kill('SIGKILL');
      await exited;
      await watcher.end();
      // The source still accepts connections and nothing about it moved.
      const probe = await open(urlFor(DB, owner));
      expect((await probe.query('select 1 as one')).rows[0].one).toBe(1);
      await probe.end();
      expect(await snapshot()).toEqual(before);
    }
    expect(observed, 'never caught the first copy in flight; make the bulk table bigger').toBe(true);
  });
});
