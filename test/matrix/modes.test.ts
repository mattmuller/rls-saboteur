import { spawn, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyMasks, parseMask } from '../../src/mask.js';
import { hostId, newToken } from '../../src/guard.js';
import { startSandbox } from '../../src/sandbox.js';

/**
 * The 0.3.0 modes against real PostgreSQL: --from-files (schema and seed only), --mask, --sandbox, and pg_cron.
 * Needs SABOTEUR_MATRIX_URL and, for the sandbox tests, Docker and SABOTEUR_MATRIX_IMAGE (npm run test:matrix sets both).
 * The pg_cron test needs SABOTEUR_MATRIX_URL_CRON, a server with pg_cron preloaded.
 *
 * A test command (test/modes/project/observe.sh) records what each copy holds. That is the database's own answer, so a
 * test of masking asks the database and never trusts a success message.
 */
const superUrl = process.env.SABOTEUR_MATRIX_URL;
const cronUrl = process.env.SABOTEUR_MATRIX_URL_CRON;
const image = process.env.SABOTEUR_MATRIX_IMAGE;
const root = join(import.meta.dirname, '..', '..');
const cli = join(root, 'dist', 'cli.js');
const project = join(root, 'test', 'modes', 'project');
const DB = 'rls_fx_modes';

const urlFor = (db: string, base = superUrl!): string => {
  const u = new URL(base);
  u.pathname = '/' + db;
  return u.toString();
};

async function open(url: string): Promise<pg.Client> {
  const c = new pg.Client({ connectionString: url });
  c.on('error', () => {});
  await c.connect();
  return c;
}

async function wipe(base = superUrl!): Promise<void> {
  const c = await open(urlFor('postgres', base));
  try {
    const dbs = await c.query(`select datname from pg_database where datname like 'rls\\_fx\\_%' or datname like 'saboteur\\_%'`);
    for (const { datname } of dbs.rows) await c.query(`drop database "${datname}" with (force)`);
    const roles = await c.query(`select rolname from pg_roles where rolname !~ '^pg_' and rolname <> current_user and not rolsuper`);
    for (const { rolname } of roles.rows) await c.query(`drop role "${rolname}"`);
  } finally {
    await c.end();
  }
}

/** A source database holding the schema and three CANARY rows that must never reach a copy unmasked. */
async function makeSource(): Promise<void> {
  await wipe();
  const c = await open(urlFor('postgres'));
  await c.query(`create database ${DB}`);
  await c.end();
  const s = await open(urlFor(DB));
  try {
    await s.query(readFileSync(join(project, 'supabase', 'migrations', '20260101000000_schema.sql'), 'utf8'));
    await s.query(`
      insert into people (email, full_name, tenant_id, passport_no, token, note) values
       ('real-alice@corp.example','CANARY Alice Real','t1',900001,'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','CANARY private note'),
       ('real-bob@corp.example','CANARY Bob Real','t1',900002,'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',null),
       ('real-carol@corp.example','CANARY Carol Real','t2',900003,null,'CANARY carol note');
      insert into orders (tenant_id, buyer_email, total) values ('t1','real-alice@corp.example',99),('t2','real-carol@corp.example',77);`);
  } finally {
    await s.end();
  }
}

async function leftovers(): Promise<string[]> {
  const c = await open(urlFor('postgres'));
  const r = await c.query(`select datname from pg_database where datname like 'saboteur\\_%'`);
  await c.end();
  return r.rows.map((x) => x.datname);
}

async function sourceFingerprint(): Promise<string> {
  const s = await open(urlFor(DB));
  try {
    const r = await s.query(
      `select (select md5(string_agg(p::text, '|' order by id)) from people p) as people,
              (select md5(string_agg(o::text, '|' order by id)) from orders o) as orders,
              (select md5(string_agg(polname || xmin::text, '|' order by polname)) from pg_policy) as policies`
    );
    return JSON.stringify(r.rows[0]);
  } finally {
    await s.end();
  }
}

let scratch = '';
let n = 0;

interface Run {
  status: number | null;
  out: string;
  observed: string;
  json: { breaks: { outcome: string }[]; masked: { column: string; rows: number }[]; couldNotCheck: string | null; isolation: string } | null;
}

function cliArgs(extra: string[], observe: string, dir: string): string[] {
  const id = ++n;
  return [
    cli, '--db-url', urlFor(DB), '--runner', 'psql', '--test', join(dir, 'observe.sh'), '--yes',
    '--report', join(scratch, `r${id}.md`), '--json-file', join(scratch, `r${id}.json`), ...extra
  ];
}

function runCli(extra: string[], opts: { dir?: string; admin?: boolean } = {}): Run {
  const dir = opts.dir ?? project;
  const observe = join(scratch, `obs${++n}.txt`);
  const args = cliArgs([...(opts.admin === false ? [] : ['--admin-url', urlFor('postgres')]), ...extra], observe, dir);
  const r = spawnSync('node', args, { cwd: dir, encoding: 'utf8', env: { ...process.env, OBSERVE_FILE: observe }, timeout: 600_000 });
  const jsonFile = args[args.indexOf('--json-file') + 1];
  return {
    status: r.status,
    out: `${r.stdout}\n${r.stderr}`,
    observed: existsSync(observe) ? readFileSync(observe, 'utf8') : '',
    json: existsSync(jsonFile) ? JSON.parse(readFileSync(jsonFile, 'utf8')) : null
  };
}

const docker = (args: string[]): string => spawnSync('docker', args, { encoding: 'utf8' }).stdout.trim();
const sandboxContainers = (): string[] => docker(['ps', '-a', '--format', '{{.Names}}', '--filter', 'name=rls-saboteur-sandbox-']).split('\n').filter(Boolean);
const volumes = (): string => docker(['volume', 'ls', '-q']).split('\n').sort().join('\n');

/** How many data files of the connected database contain this text. Needs the cluster to be the matrix container. */
async function filesHolding(c: pg.Client, needle: string): Promise<number | null> {
  await c.query('checkpoint');
  const oid = (await c.query(`select oid::text as o from pg_database where datname = current_database()`)).rows[0].o;
  const container = process.env.SABOTEUR_MATRIX_CONTAINER ?? `rls-saboteur-ci-${Number(new URL(superUrl!).port) - 55400}`;
  const r = spawnSync('docker', ['exec', container, 'sh', '-c', `grep -rlF '${needle}' /var/lib/postgresql/data/base/${oid} | wc -l`], { encoding: 'utf8' });
  return r.status === 0 ? Number(r.stdout.trim()) : null;
}
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function until(fn: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return true;
    await sleep(500);
  }
  return fn();
}

afterAll(() => {
  if (scratch) rmSync(scratch, { recursive: true, force: true });
});

describe.skipIf(!superUrl)('build modes', () => {
  beforeAll(async () => {
    const c = await open(urlFor('postgres'));
    const r = await c.query(`select current_setting('cluster_name') as name`);
    await c.end();
    if (r.rows[0].name !== 'rls-saboteur-ci') throw new Error(`Refusing to wipe a cluster named "${r.rows[0].name}".`);
    scratch ||= mkdtempSync(join(tmpdir(), 'rls-saboteur-modes-'));
  });
  afterAll(async () => {
    if (superUrl) await wipe().catch(() => {});
  });

  // ---------------------------------------------------------------- schema and seed only

  it('files-need-sandbox: --from-files without --sandbox exits 2 and creates nothing', async () => {
    await makeSource();
    const r = runCli(['--from-files']);
    expect(r.status, r.out).toBe(2);
    expect(r.out).toMatch(/--from-files needs --sandbox/);
    expect(r.observed).toBe('');
    expect(await leftovers()).toEqual([]);
  });

  // ---------------------------------------------------------------- masking

  it('mask-db: every masked value is different in the database afterwards, and the shape survives', async () => {
    await makeSource();
    const c = await open(urlFor(DB));
    try {
      // The masks run on a plain connection, as the master template's connection would: a superuser.
      const db = { query: (t: string, v?: unknown[]) => c.query(t, v), end: async () => {} };
      const before = (await c.query(`select id, email, full_name, passport_no, token, note from people order by id`)).rows;
      // Statistics and data files hold the old values until they are rebuilt. Prove the test can see them first.
      await c.query('create statistics sab_ext (mcv) on tenant_id, email from people');
      await c.query('analyze people');
      expect(Number((await c.query(`select count(*) as n from pg_stats_ext where tablename = 'people' and most_common_vals::text ~ 'real-'`)).rows[0].n), 'extended statistics hold real values before masking').toBeGreaterThan(0);
      const oid = (await c.query(`select oid::text as o from pg_database where datname = current_database()`)).rows[0].o;
      const container = process.env.SABOTEUR_MATRIX_CONTAINER ?? `rls-saboteur-ci-${Number(new URL(superUrl!).port) - 55400}`;
      const filesHolding = async (needle: string): Promise<number | null> => {
        await c.query('checkpoint');
        const r = spawnSync('docker', ['exec', container, 'sh', '-c', `grep -rlF '${needle}' /var/lib/postgresql/data/base/${oid} | wc -l`], { encoding: 'utf8' });
        return r.status === 0 ? Number(r.stdout.trim()) : null;
      };
      const statsHolding = async (): Promise<number> =>
        Number((await c.query(`select count(*) as n from pg_stats where tablename = 'people' and attname in ('email', 'full_name') and (histogram_bounds::text ~ 'real-|CANARY' or most_common_vals::text ~ 'real-|CANARY')`)).rows[0].n);
      expect(await statsHolding(), 'the statistics hold the real values before masking').toBeGreaterThan(0);
      const filesBefore = await filesHolding('CANARY Alice');
      if (filesBefore !== null) expect(filesBefore, 'the data files hold the real values before masking').toBeGreaterThan(0);
      const out = await applyMasks(
        db,
        ['public.people.email', 'public.people.full_name', 'public.people.passport_no', 'public.people.token', 'public.people.note=null'].map(parseMask),
        'test-salt'
      );
      expect(out.map((x) => x.rows)).toEqual([3, 3, 3, 2, 2]);
      const after = (await c.query(`select id, email, full_name, passport_no, token, note from people order by id`)).rows;
      for (let i = 0; i < before.length; i++) {
        expect(after[i].email).not.toBe(before[i].email);
        expect(after[i].email).toMatch(/^[0-9a-f]{32}$/);
        expect(after[i].full_name).not.toBe(before[i].full_name);
        expect(after[i].full_name.length).toBeLessThanOrEqual(60); // varchar(60) still holds
        expect(after[i].passport_no).not.toBe(before[i].passport_no);
        expect(after[i].note).toBeNull();
      }
      expect(after[2].token).toBeNull(); // NULL stays NULL
      expect(after[0].token).not.toBe(before[0].token);
      expect(after[0].token).toMatch(/^[0-9a-f-]{36}$/);
      expect(new Set(after.map((x) => x.email)).size).toBe(3); // the unique constraint still holds
      // Ask the database: no original value is left in its statistics, nor in the files the next copy will be made from.
      expect(await statsHolding(), 'the statistics still hold a real value').toBe(0);
      const ext = await c.query(`select count(*) as n from pg_stats_ext where tablename = 'people' and most_common_vals::text ~ 'real-'`);
      expect(Number(ext.rows[0].n), 'the extended statistics still hold a real value').toBe(0);
      if (filesBefore !== null) {
        expect(await filesHolding('CANARY Alice'), 'a data file still holds a real value').toBe(0);
        expect(await filesHolding('private note'), 'a data file still holds a real note').toBe(0);
      }
    } finally {
      await c.end();
    }
  });

  it('mask-inherit: rows, statistics and files of inheritance children and partitions are cleaned too', async () => {
    await makeSource();
    const c = await open(urlFor(DB));
    try {
      await c.query(`create table parent_t (id serial primary key, email text not null);
        create table child_t (extra text) inherits (parent_t);
        create table pt (id int, email text) partition by range (id);
        create table pt1 partition of pt for values from (0) to (100);
        insert into parent_t(email) values ('p-real@corp.example');
        insert into child_t(email, extra) values ('c-real-1@corp.example','x'),('c-real-2@corp.example','y');
        insert into pt values (1,'part-real-1@corp.example'),(2,'part-real-2@corp.example');
        analyze parent_t; analyze child_t; analyze pt; analyze pt1;`);
      const statsHolding = async (): Promise<number> =>
        Number((await c.query(`select count(*) as n from pg_stats where tablename in ('parent_t','child_t','pt','pt1') and attname = 'email' and histogram_bounds::text ~ 'real'`)).rows[0].n);
      expect(await statsHolding(), 'child statistics hold real values before masking').toBeGreaterThan(0);
      const before = await filesHolding(c, 'c-real-1@corp');
      const db = { query: (t: string, v?: unknown[]) => c.query(t, v), end: async () => {} };
      const out = await applyMasks(db, ['public.parent_t.email', 'public.pt.email'].map(parseMask), 'test-salt');
      expect(out.map((x) => x.rows)).toEqual([3, 2]); // the child's rows were reached by the UPDATE
      const live = await c.query(`select email from parent_t union all select email from pt`);
      expect(live.rows.every((r) => /^[0-9a-f]{32}$/.test(r.email))).toBe(true);
      expect(await statsHolding(), 'a child or partition still has real values in its statistics').toBe(0);
      if (before !== null) {
        expect(before, 'the data files hold the real values before masking').toBeGreaterThan(0);
        expect(await filesHolding(c, 'c-real-1@corp'), 'a child data file still holds a real value').toBe(0);
        expect(await filesHolding(c, 'part-real-1@corp'), 'a partition data file still holds a real value').toBe(0);
      }
    } finally {
      await c.end();
    }
  });

  it('mask-child-refused: masking a child table on its own exits 2 before anything is copied', async () => {
    await makeSource();
    const c = await open(urlFor(DB));
    await c.query(`create table parent_t (id serial primary key, email text not null); create table child_t (extra text) inherits (parent_t);`);
    await c.end();
    const r = runCli(['--mask', 'public.child_t.email']);
    expect(r.status, r.out).toBe(2);
    expect(r.out).toMatch(/public\.child_t inherits from public\.parent_t/);
    expect(r.out).toMatch(/nothing was copied/);
    expect(r.observed).toBe('');
    expect(await leftovers()).toEqual([]);
  });

  it('mask-multi-parent: a table with a parent outside the masked tree stops the run before any copy', async () => {
    await makeSource();
    const c = await open(urlFor(DB));
    await c.query(`create table pa (email text); create table pb (email text); create table ch () inherits (pa, pb);`);
    await c.end();
    const r = runCli(['--mask', 'public.pa.email']);
    expect(r.status, r.out).toBe(2);
    expect(r.out).toMatch(/public\.ch also inherits from public\.pb, which is outside the tree of public\.pa/);
    expect(r.observed).toBe('');
    expect(await leftovers()).toEqual([]);
  });

  it('mask-copiers: a materialized view or an update rule over the masked table stops the run before any copy', async () => {
    await makeSource();
    const c = await open(urlFor(DB));
    await c.query(`create materialized view people_mv as select email from people;`);
    await c.end();
    const r = runCli(['--mask', 'public.people.email']);
    expect(r.status, r.out).toBe(2);
    expect(r.out).toMatch(/materialized view (public\.)?people_mv would keep a copy/);
    expect(r.observed).toBe('');
    const c2 = await open(urlFor(DB));
    await c2.query(`drop materialized view people_mv; create table people_log (old_email text); create rule log_update as on update to people do also insert into people_log values (old.email);`);
    await c2.end();
    const r2 = runCli(['--mask', 'public.people.email']);
    expect(r2.status, r2.out).toBe(2);
    expect(r2.out).toMatch(/rule log_update on (public\.)?people would keep a copy/);
    expect(await leftovers()).toEqual([]);
  });

  it('mask-fk: a column tied to a masked column by a foreign key must be masked in the same run', async () => {
    await makeSource();
    const c = await open(urlFor(DB));
    await c.query(`create table contacts (id serial primary key, person_email text references people(email)); insert into contacts(person_email) values ('real-alice@corp.example');`);
    await c.end();
    const alone = runCli(['--mask', 'public.people.email']);
    expect(alone.status, alone.out).toBe(2);
    expect(alone.out).toMatch(/public\.contacts\.person_email is tied to public\.people\.email by a foreign key/);
    expect(alone.observed).toBe('');
    const both = runCli(['--mask', 'public.people.email', '--mask', 'public.contacts.person_email', '--jobs', '1']);
    expect(both.status, both.out).toBe(1);
    const peopleLines = both.observed.split('\n').filter((l) => l.startsWith('people|'));
    expect(peopleLines.length).toBeGreaterThan(0);
    for (const l of peopleLines) expect(l.split('|')[2]).toMatch(/^[0-9a-f]{32}$/);
    expect(await leftovers()).toEqual([]);
  });

  it('mask-run: the first copy is masked before the baseline, and the same value masks the same way in two tables', async () => {
    await makeSource();
    const before = await sourceFingerprint();
    const r = runCli(['--mask', 'public.people.email', '--mask', 'public.people.full_name', '--mask', 'public.people.passport_no', '--mask', 'public.people.token', '--mask', 'public.people.note=null', '--mask', 'public.orders.buyer_email', '--jobs', '1']);
    expect(r.status, r.out).toBe(1);
    expect(r.observed).not.toMatch(/CANARY|corp\.example|90000\d|aaaaaaaa|bbbbbbbb/);
    const lines = r.observed.split('\n');
    expect(lines.filter((l) => l.startsWith('people|')).length).toBeGreaterThanOrEqual(3);
    // Every copy that holds rows, the unbroken baseline included, shows masked values.
    for (const l of lines.filter((x) => x.startsWith('people|'))) expect(l.split('|')[2]).toMatch(/^[0-9a-f]{32}$/);
    // The masked buyer e-mail on an order equals the masked e-mail of the same person.
    const email1 = lines.find((l) => l.startsWith('people|1|'))!.split('|')[2];
    const order1 = lines.find((l) => l.startsWith('orders|1|'))!.split('|')[2];
    expect(order1).toBe(email1);
    expect(r.json?.masked.map((m) => m.column)).toContain('public.people.email');
    expect(await sourceFingerprint()).toBe(before); // the source keeps its real rows
    expect(await leftovers()).toEqual([]);
  });

  it('mask-missing-column: a named column that does not exist exits 2 before anything is copied or run', async () => {
    await makeSource();
    const r = runCli(['--mask', 'public.people.nosuch']);
    expect(r.status, r.out).toBe(2);
    expect(r.out).toMatch(/public\.people\.nosuch does not exist/);
    expect(r.out).toMatch(/nothing was copied/);
    expect(r.observed).toBe('');
    expect(await leftovers()).toEqual([]);
  });

  it('mask-failure: a rewrite that fails after the copy exists stops the run before any test and removes the copy', async () => {
    await makeSource();
    // id exists and is a table column, so validation passes. NOT NULL makes the rewrite itself fail.
    const r = runCli(['--mask', 'public.people.id=null']);
    expect(r.status, r.out).toBe(2);
    expect(r.out).toMatch(/masking public\.people\.id=null failed, so the run stops before any test/);
    expect(r.observed).toBe('');
    expect(await leftovers()).toEqual([]);
  });

  it('mask-needs-superuser: a role that cannot switch triggers off cannot mask, and the run stops', async () => {
    await makeSource();
    const c = await open(urlFor('postgres'));
    await c.query(`create role mask_owner login password 'm' createdb`);
    await c.query(`alter database ${DB} owner to mask_owner`);
    await c.end();
    const s = await open(urlFor(DB));
    await s.query(`alter table people owner to mask_owner; alter table orders owner to mask_owner`);
    await s.end();
    const u = new URL(urlFor(DB));
    u.username = 'mask_owner';
    u.password = 'm';
    const r = runCli(['--db-url', u.toString(), '--mask', 'public.people.email'], { admin: false });
    // --db-url given twice: the later one wins in parseArgs, which is the non-superuser.
    expect(r.status, r.out).toBe(2);
    expect(r.observed).toBe('');
    expect(await leftovers()).toEqual([]);
  });
});

describe.skipIf(!superUrl || !image)('sandbox', () => {
  const sbArgs = (extra: string[]): string[] => ['--sandbox', '--sandbox-image', image!, '--jobs', '1', ...extra];
  beforeAll(async () => {
    const c = await open(urlFor('postgres'));
    const r = await c.query(`select current_setting('cluster_name') as name`);
    await c.end();
    if (r.rows[0].name !== 'rls-saboteur-ci') throw new Error(`Refusing to wipe a cluster named "${r.rows[0].name}".`);
    scratch ||= mkdtempSync(join(tmpdir(), 'rls-saboteur-modes-'));
  });
  afterAll(async () => {
    for (const name of sandboxContainers()) if (name.startsWith('rls-saboteur-sandbox-')) docker(['rm', '-f', '-v', name]);
    if (superUrl) await wipe().catch(() => {});
  });

  it('sandbox-files: the copies are built in a container from the files, and the container and its volume are gone afterwards', async () => {
    await makeSource();
    const before = await sourceFingerprint();
    const vols = volumes();
    expect(sandboxContainers()).toEqual([]);
    const hold = await open(urlFor(DB)); // a busy source: a sandbox never needs its sessions closed
    let r: Run;
    try {
      r = runCli(sbArgs(['--from-files']), { admin: false });
    } finally {
      await hold.end();
    }
    expect(r.status, r.out).toBe(1);
    expect(r.out).toMatch(/Sandbox: the copies live in the container rls-saboteur-sandbox-/);
    expect(r.out).not.toMatch(/Closed \d+ other connection/);
    expect(r.observed).toContain('seed-one@example.test');
    expect(r.observed).not.toMatch(/CANARY|corp\.example/);
    expect(r.json?.isolation).toBe('sandbox');
    expect(sandboxContainers()).toEqual([]);
    expect(volumes()).toBe(vols);
    expect(await sourceFingerprint()).toBe(before);
    expect(await leftovers()).toEqual([]); // nothing was created on the source's server either
  });

  it('files-mode-mismatch: files that do not rebuild the policies of the database stop the run with exit 2', async () => {
    await makeSource();
    const dir = join(scratch, 'mismatch');
    cpSync(project, dir, { recursive: true });
    const mig = join(dir, 'supabase', 'migrations', '20260101000000_schema.sql');
    writeFileSync(mig, readFileSync(mig, 'utf8').replace(/create policy "tenant reads orders"[^;]*;/, ''));
    const r = runCli(sbArgs(['--from-files']), { dir, admin: false });
    expect(r.status, r.out).toBe(2);
    expect(r.out).toMatch(/does not have the policies of the database/);
    expect(r.out).toContain('public.orders/tenant reads orders is in the database but not in the copy');
    expect(r.observed).toBe(''); // no test ran
    expect(await leftovers()).toEqual([]);
  });

  it('files-mode-failure: a migration that fails stops the run, names the file, and leaves no copy', async () => {
    await makeSource();
    const dir = join(scratch, 'broken');
    cpSync(project, dir, { recursive: true });
    writeFileSync(join(dir, 'supabase', 'migrations', '20260101000001_broken.sql'), 'create table nope (;');
    const r = runCli(sbArgs(['--from-files']), { dir, admin: false });
    expect(r.status, r.out).toBe(2);
    expect(r.out).toContain('20260101000001_broken.sql');
    expect(r.observed).toBe('');
    expect(await leftovers()).toEqual([]);
  });

  it('sandbox-net: a migration that creates net.http_post is neutralised, and the seed cannot call it', async () => {
    await makeSource();
    const dir = join(scratch, 'netproj');
    cpSync(project, dir, { recursive: true });
    writeFileSync(
      join(dir, 'supabase', 'migrations', '20260101000001_net.sql'),
      `create schema net;
create table public.net_marker (url text, at timestamptz default now());
create function net.http_post(url text) returns integer language plpgsql as $$ begin insert into public.net_marker(url) values (url); return 1; end $$;\n`
    );
    writeFileSync(join(dir, 'supabase', 'seed.sql'), readFileSync(join(project, 'supabase', 'seed.sql'), 'utf8') + "select net.http_post('from-seed');\n");
    // The source needs the same objects, so the policies match.
    const s = await open(urlFor(DB));
    await s.query(readFileSync(join(dir, 'supabase', 'migrations', '20260101000001_net.sql'), 'utf8'));
    await s.end();
    writeFileSync(
      join(dir, 'observe.sh'),
      `#!/bin/sh
set -e
{
  echo "after-load $(psql -X -At "$DATABASE_URL" -c 'select count(*) from public.net_marker')"
  psql -X -At "$DATABASE_URL" -c "select net.http_post('from-test')" >/dev/null
  echo "after-test-call $(psql -X -At "$DATABASE_URL" -c 'select count(*) from public.net_marker')"
} >> "$OBSERVE_FILE"
exit 0
`,
      { mode: 0o755 }
    );
    const r = runCli(sbArgs(['--from-files']), { dir, admin: false });
    expect(r.status, r.out).toBe(1);
    expect(r.out).toContain('1 function(s) (net.http_post) do nothing there');
    const lines = r.observed.split('\n').filter(Boolean);
    expect(lines.length).toBeGreaterThanOrEqual(2);
    for (const l of lines) expect(l.endsWith(' 0'), l).toBe(true); // the seed's call and the test's call both did nothing
  });

  it('sandbox-isolated: in --from-files mode a migration cannot reach the host or the internet, and no port is published', async () => {
    await makeSource();
    const port = new URL(superUrl!).port;
    const dir = join(scratch, 'isoproj');
    cpSync(project, dir, { recursive: true });
    const probe = (target: string): string => `copy reach_tmp from program 'timeout 4 bash -c "exec 3<>/dev/tcp/${target} && echo CONNECTED" 2>/dev/null || echo BLOCKED';`;
    writeFileSync(
      join(dir, 'supabase', 'migrations', '20260101000001_reach.sql'),
      `create table public.reach (what text, result text);
create temp table reach_tmp (r text);
${probe(`host.docker.internal/${port}`)}
insert into public.reach select 'host.docker.internal', r from reach_tmp; truncate reach_tmp;
${probe(`172.17.0.1/${port}`)}
insert into public.reach select 'docker-bridge-gateway', r from reach_tmp; truncate reach_tmp;
${probe(`127.0.0.1/${port}`)}
insert into public.reach select 'own-loopback-on-the-host-port', r from reach_tmp; truncate reach_tmp;
${probe('1.1.1.1/443')}
insert into public.reach select 'internet', r from reach_tmp; truncate reach_tmp;
copy reach_tmp from program 'tail -n +2 /proc/net/route | wc -l | tr -d " "';
insert into public.reach select 'routes', r from reach_tmp; truncate reach_tmp;
copy reach_tmp from program 'grep -B1 "host LOCAL" /proc/net/fib_trie | grep -oE "[0-9]+[.][0-9]+[.][0-9]+[.][0-9]+" | sort -u';
insert into public.reach select 'ipv4-address', r from reach_tmp;\n`
    );
    writeFileSync(
      join(dir, 'observe.sh'),
      `#!/bin/sh
set -e
c=$(docker ps --format '{{.Names}}' --filter name=rls-saboteur-sandbox- | head -1)
{
  psql -X -At "$DATABASE_URL" -c "select 'reach ' || what || ' ' || result from reach order by 1"
  echo "inspect $(docker inspect --format '{{.HostConfig.NetworkMode}} ports={{json .HostConfig.PortBindings}} hosts={{json .HostConfig.ExtraHosts}}' "$c")"
} >> "$OBSERVE_FILE"
exit 0
`,
      { mode: 0o755 }
    );
    const r = runCli(sbArgs(['--from-files']), { dir, admin: false });
    expect(r.status, r.out).toBe(1);
    expect(r.out).toContain('no network at all');
    const lines = r.observed.split('\n').filter(Boolean);
    for (const what of ['host.docker.internal', 'docker-bridge-gateway', 'own-loopback-on-the-host-port', 'internet']) expect(lines).toContain(`reach ${what} BLOCKED`);
    expect(lines.some((l) => /^reach .* CONNECTED/.test(l))).toBe(false);
    // No route at all, and no IPv4 address except loopback. (Linux still lists a few fallback tunnel devices in a new network
    // namespace, all down and without an address, so the interface list itself proves nothing.)
    expect(lines).toContain('reach routes 0');
    const addrs = lines.filter((l) => l.startsWith('reach ipv4-address ')).map((l) => l.split(' ')[2]);
    expect(addrs.length).toBeGreaterThan(0);
    expect(addrs.every((a) => a.startsWith('127.'))).toBe(true);
    expect(lines.find((l) => l.startsWith('inspect '))).toMatch(/^inspect none ports=\{\} hosts=null/);
    // Control: the same probe on the default network DOES connect to the host, so the test above can fail.
    const control = spawnSync('docker', ['run', '--rm', '--add-host', 'host.docker.internal:host-gateway', image!, 'bash', '-c', `timeout 4 bash -c "exec 3<>/dev/tcp/host.docker.internal/${port} && echo CONNECTED" 2>/dev/null || echo BLOCKED`], { encoding: 'utf8' });
    expect(control.stdout.trim()).toBe('CONNECTED');
  });

  it('sandbox-auth-relay: a wrong password through the relay is refused, and the right one is accepted', async () => {
    const sb = await startSandbox(image!, newToken(), true);
    try {
      const wrong = new pg.Client({ connectionString: sb.url('postgres').replace(sb.password, 'not-the-password') });
      wrong.on('error', () => {});
      await expect(wrong.connect()).rejects.toThrow(/password authentication failed/);
      const none = new pg.Client({ host: '127.0.0.1', port: sb.port, user: sb.user, database: 'postgres' });
      none.on('error', () => {});
      await expect(none.connect()).rejects.toThrow();
      await sb.checkAuth(); // the same checks the run makes: two refused logins and no passwordless host rule
      const ok = new pg.Client({ connectionString: sb.url('postgres') });
      ok.on('error', () => {});
      await ok.connect();
      expect((await ok.query('select 1 as n')).rows[0].n).toBe(1);
      await ok.end();
    } finally {
      await sb.remove();
    }
    expect(sandboxContainers()).toEqual([]);
  });

  for (const [label, rule, expected] of [
    ['loopback', 'host all all 127.0.0.1/32 trust', /lets a client in|need no password/],
    ['one database', 'host template1 all all trust', /could not check that the sandbox asks for a password|need no password|lets a client in/]
  ] as const) {
    it(`sandbox-auth-trust: an image with a passwordless host rule (${label}) stops the run with exit 2 and leaves no container`, async () => {
      await makeSource();
      const tag = `rls-saboteur-ci-pg-trust:${label.replace(' ', '-')}`;
      const build = spawnSync('docker', ['build', '-q', '-t', tag, '-'], {
        input: `FROM ${image}\nRUN printf '#!/bin/sh\\nsed -i "1i ${rule}" "$PGDATA/pg_hba.conf"\\n' > /docker-entrypoint-initdb.d/zz-trust.sh && chmod +x /docker-entrypoint-initdb.d/zz-trust.sh\n`,
        encoding: 'utf8'
      });
      expect(build.status, build.stderr).toBe(0);
      try {
        const r = runCli(['--sandbox', '--sandbox-image', tag, '--jobs', '1', '--from-files'], { admin: false });
        expect(r.status, r.out).toBe(2);
        expect(r.out).toMatch(expected);
        expect(r.observed).toBe('');
        expect(sandboxContainers()).toEqual([]);
      } finally {
        docker(['image', 'rm', tag]);
      }
    });
  }

  it('sandbox-auth-after-build: a migration that loosens pg_hba.conf stops the run before any copy', async () => {
    await makeSource();
    const dir = join(scratch, 'hbaproj');
    cpSync(project, dir, { recursive: true });
    writeFileSync(
      join(dir, 'supabase', 'migrations', '20260101000001_hba.sql'),
      `copy (select 'host all all all trust') to program 'cat >> "$PGDATA/pg_hba.conf"';\nselect pg_reload_conf();\n`
    );
    const r = runCli(sbArgs(['--from-files']), { dir, admin: false });
    expect(r.status, r.out).toBe(2);
    expect(r.out).toMatch(/pg_hba\.conf has 1 host rule\(s\) that need no password/);
    expect(r.observed).toBe(''); // no test ran, so no copy was made
    expect(sandboxContainers()).toEqual([]);
  });

  it('sandbox-dump: the rows are streamed into the container, masked there, and the source is unchanged', async () => {
    await makeSource();
    const before = await sourceFingerprint();
    const r = runCli(sbArgs(['--mask', 'public.people.email', '--mask', 'public.people.full_name', '--mask', 'public.people.note=null', '--mask', 'public.orders.buyer_email']), { admin: false });
    expect(r.status, r.out).toBe(1);
    expect(r.out).toContain('pg_dump runs in it');
    expect(r.observed).toMatch(/people\|1\|[0-9a-f]{32}\|/);
    expect(r.observed).not.toMatch(/CANARY|real-alice/);
    expect(r.observed).toContain('90000'); // passport numbers were not masked, so the dump did bring the rows
    expect(sandboxContainers()).toEqual([]);
    expect(await sourceFingerprint()).toBe(before);
  });

  it('sandbox-dump-triggers: no trigger fires while the dump is loaded', async () => {
    await makeSource();
    const dir = join(scratch, 'triggerproj');
    cpSync(project, dir, { recursive: true });
    const s = await open(urlFor(DB));
    await s.query(`create table public.audit (n serial primary key, who text);
      create function public.audit_fn() returns trigger language plpgsql as $$ begin insert into public.audit(who) values (new.email); return new; end $$;
      create trigger people_audit after insert on public.people for each row execute function public.audit_fn();
      insert into public.people (email, full_name, tenant_id) values ('trigger-row@corp.example', 'T', 't1');`);
    const sourceRows = Number((await s.query('select count(*) as n from public.audit')).rows[0].n);
    await s.end();
    expect(sourceRows).toBe(1);
    writeFileSync(join(dir, 'observe.sh'), `#!/bin/sh\nset -e\necho "audit $(psql -X -At "$DATABASE_URL" -c 'select count(*) from public.audit')" >> "$OBSERVE_FILE"\nexit 0\n`, { mode: 0o755 });
    const r = runCli(sbArgs([]), { dir, admin: false });
    expect(r.status, r.out).toBe(1);
    // The audit row is data and is dumped once. A trigger firing on the load would make it two.
    for (const l of r.observed.split('\n').filter(Boolean)) expect(l).toBe('audit 1');
  });

  it('sandbox-unmasked-dump: without --mask a dump copy holds the rows, which is what the plan says', async () => {
    await makeSource();
    const r = runCli(sbArgs([]), { admin: false });
    expect(r.status, r.out).toBe(1);
    expect(r.observed).toContain('real-alice@corp.example');
    expect(sandboxContainers()).toEqual([]);
  });

  it('sandbox-kill9: a run killed with SIGKILL leaves no container behind', async () => {
    await makeSource();
    const observe = join(scratch, 'k9.txt');
    const args = cliArgs([...sbArgs(['--from-files'])], observe, project);
    args[args.indexOf('--test') + 1] = 'sleep 300';
    const child = spawn('node', args, { cwd: project, stdio: 'ignore' });
    expect(await until(() => sandboxContainers().length === 1, 120_000)).toBe(true);
    await sleep(3000); // let it get past the build
    child.kill('SIGKILL');
    // No handler can run after SIGKILL. The detached watchdog removes the container.
    expect(await until(() => sandboxContainers().length === 0, 30_000)).toBe(true);
  });

  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    it(`sandbox-${sig.toLowerCase()}: ${sig} removes the container and exits ${sig === 'SIGINT' ? 130 : 143}`, async () => {
      await makeSource();
      const args = cliArgs([...sbArgs(['--from-files'])], join(scratch, 'sig.txt'), project);
      args[args.indexOf('--test') + 1] = 'sleep 300';
      const child = spawn('node', args, { cwd: project, stdio: 'ignore' });
      const exited = new Promise<number | null>((res) => child.on('exit', (c) => res(c)));
      expect(await until(() => sandboxContainers().length === 1, 120_000)).toBe(true);
      await sleep(3000);
      child.kill(sig);
      expect(await exited).toBe(sig === 'SIGINT' ? 130 : 143);
      expect(sandboxContainers()).toEqual([]);
    });
  }

  it('sandbox-sigint-startup: SIGINT while the container is still starting removes it and exits 130', async () => {
    await makeSource();
    const args = cliArgs([...sbArgs(['--from-files'])], join(scratch, 'sigstart.txt'), project);
    args[args.indexOf('--test') + 1] = 'sleep 300';
    const child = spawn('node', args, { cwd: project, stdio: 'ignore' });
    const exited = new Promise<number | null>((res) => child.on('exit', (c) => res(c)));
    // The moment the container exists, before the database in it is ready.
    expect(await until(() => sandboxContainers().length === 1, 120_000)).toBe(true);
    child.kill('SIGINT');
    expect(await exited).toBe(130);
    expect(sandboxContainers()).toEqual([]);
  });

  it('sandbox-sweep: the next run removes the container of a dead process, and no other', async () => {
    await makeSource();
    const dead = spawnSync('node', ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' }).stdout.trim();
    const mk = (host: string, pid: string, token: string): string => {
      const name = `rls-saboteur-sandbox-${host}-${pid}-${token}`;
      const r = spawnSync('docker', ['run', '-d', '--rm', '--name', name, '--label', 'rls-saboteur.sandbox=1', '--label', `rls-saboteur.host=${host}`, '--label', `rls-saboteur.pid=${pid}`, '--label', `rls-saboteur.token=${token}`, image!, 'sleep', '600'], { encoding: 'utf8' });
      expect(r.status, r.stderr).toBe(0);
      return name;
    };
    const ofDead = mk(hostId(), dead, 'a'.repeat(16));
    const ofLive = mk(hostId(), String(process.pid), 'b'.repeat(16));
    const ofOther = mk('c'.repeat(12), dead, 'd'.repeat(16));
    try {
      const r = runCli(sbArgs(['--from-files']), { admin: false });
      expect(r.status, r.out).toBe(1);
      const left = sandboxContainers();
      expect(left).not.toContain(ofDead);
      expect(left).toContain(ofLive);
      expect(left).toContain(ofOther);
    } finally {
      for (const c of [ofDead, ofLive, ofOther]) docker(['rm', '-f', '-v', c]);
    }
  });
});

describe.skipIf(!cronUrl)('pg_cron', () => {
  const CRON_DB = 'postgres';
  beforeAll(() => {
    scratch ||= mkdtempSync(join(tmpdir(), 'rls-saboteur-modes-'));
  });
  const count = async (db: string, where = 'true'): Promise<number> => {
    const c = await open(urlFor(db, cronUrl!));
    try {
      return Number((await c.query(`select count(*) as n from public.heartbeat where ${where}`)).rows[0].n);
    } finally {
      await c.end();
    }
  };
  afterAll(async () => {
    if (!cronUrl) return;
    const c = await open(urlFor('postgres', cronUrl));
    await c.query(`select cron.unschedule(jobid) from cron.job`).catch(() => {});
    await c.query(`drop table if exists public.heartbeat`).catch(() => {});
    await c.end();
    await wipe(cronUrl).catch(() => {});
  });

  it('pg-cron-copies: a job scheduled in the source keeps running there and never runs in a copy', async () => {
    const c = await open(urlFor(CRON_DB, cronUrl!));
    await c.query(`create extension if not exists pg_cron`);
    await c.query(`create table public.heartbeat(db text, at timestamptz default now())`);
    await c.query(`alter table public.heartbeat enable row level security`);
    await c.query(`create policy "hb read" on public.heartbeat for select using (true)`);
    await c.query(`select cron.schedule('beat', '1 seconds', $$insert into public.heartbeat(db) values (current_database())$$)`);
    await c.end();
    await sleep(3000); // let the job fire a few times in the source
    // The test command records the heartbeat count of its own copy, waits, and records it again.
    const script = join(scratch, 'watch.sh');
    const out = join(dirOf(script), 'cron-observed.txt');
    writeFileSync(
      script,
      `#!/bin/sh\nset -e\na=$(psql -X -At "$DATABASE_URL" -c "select count(*) from public.heartbeat")\nsleep 6\nb=$(psql -X -At "$DATABASE_URL" -c "select count(*) from public.heartbeat")\necho "$(psql -X -At "$DATABASE_URL" -c 'select current_database()') $a $b" >> "$OBSERVE_FILE"\nexit 0\n`,
      { mode: 0o755 }
    );
    const sourceBefore = await count(CRON_DB);
    const r = spawnSync(
      'node',
      [cli, '--db-url', urlFor(CRON_DB, cronUrl!), '--runner', 'psql', '--test', script, '--yes', '--close-sessions', '--jobs', '1', '--filter', 'drop-policy', '--report', join(dirOf(script), 'cron.md')],
      { encoding: 'utf8', env: { ...process.env, OBSERVE_FILE: out }, timeout: 600_000 }
    );
    expect(r.status, r.stdout + r.stderr).toBe(1);
    const rows = readFileSync(out, 'utf8').trim().split('\n').map((l) => l.split(' '));
    expect(rows.length).toBeGreaterThanOrEqual(2); // the baseline copy and the break copy
    for (const [db, a, b] of rows) {
      expect(db).toMatch(/^saboteur_/);
      expect(b, `copy ${db}: ${a} rows, then ${b} after 6 s`).toBe(a); // the copy's own job rows are inert
    }
    // Meanwhile the source's job kept firing, so the test could have seen a change if copies were live.
    expect(await count(CRON_DB)).toBeGreaterThan(sourceBefore);
    expect(await count(CRON_DB, `db <> 'postgres'`)).toBe(0); // no source job ran in a copy
  });
});

function dirOf(p: string): string {
  return p.slice(0, p.lastIndexOf('/'));
}
