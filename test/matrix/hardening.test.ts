import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { discoverSuite } from '../../src/tests.js';
import { copyNameFor, hostId } from '../../src/guard.js';

/**
 * Hardening leads A-G, against a real Postgres. Needs SABOTEUR_MATRIX_URL (a superuser URL).
 * SABOTEUR_MATRIX_URL_B is a second, separate server and is only needed for lead C.
 * Every test here proves the tool does not reach anything but its own copy.
 */
const superUrl = process.env.SABOTEUR_MATRIX_URL;
const otherUrl = process.env.SABOTEUR_MATRIX_URL_B;
const root = join(import.meta.dirname, '..', '..');
const cli = join(root, 'dist', 'cli.js');
const SRC = 'hard_src';
let scratch = '';

const urlFor = (base: string, db: string): string => {
  const u = new URL(base);
  u.pathname = '/' + db;
  return u.toString();
};
async function open(url: string, app?: string): Promise<pg.Client> {
  const c = new pg.Client({ connectionString: url, application_name: app });
  c.on('error', () => {});
  await c.connect();
  return c;
}
async function sql(base: string, db: string, text: string): Promise<pg.QueryResult> {
  const c = await open(urlFor(base, db));
  try {
    return await c.query(text);
  } finally {
    await c.end();
  }
}
async function resetServer(base: string): Promise<void> {
  const c = await open(urlFor(base, 'postgres'));
  try {
    const dbs = await c.query(`select datname from pg_database where datname like 'hard\\_%' or datname like 'saboteur\\_%'`);
    for (const { datname } of dbs.rows) await c.query(`drop database "${datname}" with (force)`);
    await c.query('drop role if exists hard_owner');
  } finally {
    await c.end();
  }
}
const SETUP = `
  create table docs (id serial primary key, tenant_id text not null);
  alter table docs enable row level security;
  create policy "own docs" on docs for select using (tenant_id = current_setting('app.tenant', true));
  create schema net;
  create table net_calls (url text);
  create function net.http_post(url text, body jsonb default '{}') returns bigint language plpgsql as
    $$ begin insert into public.net_calls values (url); return 1; end $$;
  create table evt (id serial primary key);
  create function evt_hook() returns trigger language plpgsql as
    $$ begin perform net.http_post('https://example.invalid/hook'); return new; end $$;
  create trigger evt_after after insert on evt for each row execute function evt_hook();
`;
async function makeSource(): Promise<void> {
  await resetServer(superUrl!);
  await sql(superUrl!, 'postgres', `create database ${SRC}`);
  await sql(superUrl!, SRC, SETUP);
}
async function copies(base: string): Promise<string[]> {
  const r = await sql(base, 'postgres', `select datname from pg_database where datname like 'saboteur\\_%' order by 1`);
  return r.rows.map((x) => x.datname as string);
}
function cliRun(args: string[], env: Record<string, string> = {}, input?: string) {
  return spawnSync('node', [cli, ...args], {
    cwd: scratch,
    encoding: 'utf8',
    input,
    env: { ...process.env, ...env, CI: 'true' }
  });
}
const base = (extra: string[] = []) => [
  '--db-url', urlFor(superUrl!, SRC), '--report', join(scratch, 'r.md'), '--json-file', join(scratch, 'r.json'), ...extra
];

describe.skipIf(!superUrl)('hardening against a real Postgres', () => {
  beforeAll(() => {
    scratch = mkdtempSync(join(tmpdir(), 'rls-saboteur-hard-'));
  });
  afterAll(async () => {
    if (scratch) rmSync(scratch, { recursive: true, force: true });
    await resetServer(superUrl!).catch(() => {});
    if (otherUrl) await resetServer(otherUrl).catch(() => {});
  });

  describe('A: a URL query string cannot send a runner to another database', () => {
    it('the psql runner installs pgTAP only in the database named by the path, never in ?dbname=', async () => {
      await resetServer(superUrl!);
      await sql(superUrl!, 'postgres', 'create database hard_src');
      await sql(superUrl!, 'postgres', 'create database hard_copy');
      mkdirSync(join(scratch, 'supabase', 'tests'), { recursive: true });
      writeFileSync(join(scratch, 'supabase', 'tests', 'a.sql'), 'select 1;');
      const suite = discoverSuite({ cwd: scratch, runner: 'psql' })!;
      const sneaky = urlFor(superUrl!, 'hard_copy') + '?dbname=hard_src';
      await suite.prepare!(sneaky);
      const inSrc = await sql(superUrl!, 'hard_src', `select count(*)::int as n from pg_extension where extname = 'pgtap'`);
      const inCopy = await sql(superUrl!, 'hard_copy', `select count(*)::int as n from pg_extension where extname = 'pgtap'`);
      expect(inSrc.rows[0].n, 'pgTAP was installed in the source').toBe(0);
      expect(inCopy.rows[0].n).toBe(1);
    });

    it.each([['dbname'], ['database'], ['options'], ['user'], ['port'], ['host'], ['service']])(
      'the CLI refuses ?%s= on --db-url with exit 2 and creates nothing',
      async (param) => {
        await makeSource();
        const v = param === 'options' ? '-c%20search_path%3Dx' : param === 'port' ? '5432' : param === 'host' ? '127.0.0.1' : 'hard_src';
        const r = cliRun(['--db-url', urlFor(superUrl!, SRC) + `?${param}=${v}`, '--test', 'exit 0', '--yes']);
        expect(r.status, r.stdout + r.stderr).toBe(2);
        expect(r.stderr).toContain(param);
        expect(await copies(superUrl!)).toEqual([]);
      }
    );

    it('the CLI refuses ?dbname= on --admin-url too', async () => {
      await makeSource();
      const r = cliRun([...base(['--test', 'exit 0', '--yes']), '--admin-url', urlFor(superUrl!, 'postgres') + '?dbname=hard_src']);
      expect(r.status, r.stdout + r.stderr).toBe(2);
      expect(r.stderr).toContain('--admin-url');
      expect(await copies(superUrl!)).toEqual([]);
    });
  });

  describe('B: the plan shows what the server says, and large or busy sources need their own approval', () => {
    it('the plan lists server version, source size, other sessions and the server address', async () => {
      await makeSource();
      const held = await open(urlFor(superUrl!, SRC), 'my-app');
      const r = cliRun(base(['--test', 'exit 0', '--yes']));
      await held.end();
      expect(r.stderr).toMatch(/PostgreSQL 1[0-9]/);
      expect(r.stderr).toMatch(/Size of "hard_src": [0-9.]+ (kB|MB|bytes)/);
      expect(r.stderr).toMatch(/Other sessions: 1/);
      expect(r.stderr).toContain('my-app');
      expect(r.stderr).toMatch(/Server reports address \S+ port \d+/);
    });

    it('a source above --max-size is refused, with exit 2, before any copy', async () => {
      await makeSource();
      await sql(superUrl!, SRC, `create table big as select g, repeat('x', 200) p from generate_series(1, 20000) g`);
      const r = cliRun(base(['--test', 'exit 0', '--yes', '--max-size', '1MB']));
      expect(r.status, r.stdout + r.stderr).toBe(2);
      expect(r.stdout + r.stderr).toMatch(/larger than the limit of 1\.0 MB/);
      expect(r.stdout + r.stderr).toContain('--max-size');
      expect(await copies(superUrl!)).toEqual([]);
      // and the same source is accepted once the limit allows it
      const ok = cliRun(base(['--test', 'exit 0', '--yes', '--max-size', '1GB']));
      expect([0, 1]).toContain(ok.status);
    });

    it('--yes alone does not close other sessions; --close-sessions does', async () => {
      await makeSource();
      const held = await open(urlFor(superUrl!, SRC), 'my-app');
      const r = cliRun(base(['--test', 'exit 0', '--yes']));
      expect(r.status, r.stdout + r.stderr).toBe(2);
      expect(r.stderr).toContain('--close-sessions');
      expect((await held.query('select 1 as one')).rows[0].one, 'the held session must still be alive').toBe(1);
      expect(await copies(superUrl!)).toEqual([]);
      const r2 = cliRun(base(['--test', 'exit 0', '--yes', '--close-sessions']));
      expect([0, 1], r2.stdout + r2.stderr).toContain(r2.status);
      expect(r2.stdout + r2.stderr).toMatch(/Closed \d+ other connection/);
      await held.end().catch(() => {});
    });
  });

  describe.skipIf(!otherUrl)('C: --admin-url must be the same server as --db-url', () => {
    it('an admin URL on another server exits 2 and creates nothing on either server', async () => {
      await makeSource();
      await resetServer(otherUrl!);
      await sql(otherUrl!, 'postgres', `create database ${SRC}`);
      await sql(otherUrl!, SRC, SETUP);
      const r = cliRun(base(['--test', 'exit 0', '--yes', '--admin-url', urlFor(otherUrl!, 'postgres')]));
      expect(r.status, r.stdout + r.stderr).toBe(2);
      expect(r.stderr).toMatch(/not the same server/);
      expect(await copies(superUrl!)).toEqual([]);
      expect(await copies(otherUrl!)).toEqual([]);
    });
  });

  describe('D: the test command sees only the copy', () => {
    it('removes other database variables and points DATABASE_URL and PG* at the copy', async () => {
      await makeSource();
      const out = join(scratch, 'env.txt');
      const leak = 'postgres://prod:secret@prod.invalid:5432/prod';
      const env: Record<string, string> = {};
      for (const k of ['DIRECT_URL', 'SUPABASE_DB_URL', 'POSTGRES_URL', 'POSTGRES_PRISMA_URL', 'POSTGRES_URL_NON_POOLING', 'DB_URL']) env[k] = leak;
      env.PGOPTIONS = '-c search_path=prod';
      const r = cliRun(base(['--test', `env > '${out}'`, '--yes']), env);
      expect(r.status, r.stdout + r.stderr).toBe(1);
      const seen = readFileSync(out, 'utf8');
      expect(seen).not.toContain('prod.invalid');
      for (const k of Object.keys(env)) expect(seen, k).not.toMatch(new RegExp(`^${k}=`, 'm'));
      expect(seen).toMatch(/^DATABASE_URL=.*saboteur_/m);
      expect(seen).toMatch(/^PGDATABASE=saboteur_/m);
    });
  });

  describe('2: the plan names what was removed from the test environment, and the .env files it cannot control', () => {
    it('lists variable NAMES (never values) and warns about a .env file that mentions a database', async () => {
      await makeSource();
      writeFileSync(join(scratch, '.env.local'), 'SUPABASE_URL=https://prodref.supabase.co\n');
      mkdirSync(join(scratch, 'supabase', 'tests'), { recursive: true });
      writeFileSync(join(scratch, 'supabase', 'tests', 'a.sql'), 'select 1;');
      const r = cliRun(base(['--runner', 'psql', '--yes']), { TEST_DATABASE_URL: 'postgres://prod:topsecret@prod.invalid/prod', SUPABASE_SERVICE_ROLE_KEY: 'eyJservice' });
      rmSync(join(scratch, '.env.local'), { force: true });
      rmSync(join(scratch, 'supabase'), { recursive: true, force: true });
      expect(r.stderr).toMatch(/Test environment: \d+ variable\(s\) .* removed \(.*SUPABASE_SERVICE_ROLE_KEY.*TEST_DATABASE_URL/);
      expect(r.stderr).not.toMatch(/topsecret|eyJservice|prod\.invalid/);
      expect(r.stderr).toMatch(/Warning: \.env\.local in this directory mention a database/);
      expect(r.stderr).not.toContain('prodref');
      expect(r.stderr).toMatch(/Note: the test files are your code/);
    });
  });

  describe('E: outbound HTTP from the copy is switched off', () => {
    const cmd = `psql "$DATABASE_URL" -X -qAt -c "insert into evt default values" -c "select count(*) from net_calls" | grep -qx 0`;
    it('a trigger that calls net.http_post records nothing in the copy', async () => {
      await makeSource();
      const r = cliRun(base(['--test', cmd, '--yes']));
      expect(JSON.parse(readFileSync(join(scratch, 'r.json'), 'utf8')).couldNotCheck, r.stdout + r.stderr).toBeNull();
      expect(r.stderr).toContain('outbound HTTP from the copy is switched off');
    });
    it('--no-isolate-network leaves it on, says so, and the stub records the call', async () => {
      await makeSource();
      const r = cliRun(base(['--test', cmd, '--yes', '--no-isolate-network']));
      expect(r.status, r.stdout + r.stderr).toBe(2);
      expect(r.stderr).toContain('outbound HTTP from the copy is NOT switched off');
    });
    it('a role that cannot replace the functions gets exit 2, never a copy with HTTP on', async () => {
      await makeSource();
      await sql(superUrl!, 'postgres', `create role hard_owner login createdb password 'o'`);
      await sql(superUrl!, 'postgres', 'alter database ' + SRC + ' owner to hard_owner');
      await sql(superUrl!, SRC, `grant all on schema public to hard_owner; grant all on all tables in schema public to hard_owner; grant usage on schema net to hard_owner; grant execute on all functions in schema net to hard_owner`);
      const u = new URL(urlFor(superUrl!, SRC));
      u.username = 'hard_owner';
      u.password = 'o';
      const r = cliRun(['--db-url', u.toString(), '--report', join(scratch, 'r.md'), '--json-file', join(scratch, 'r.json'), '--test', 'exit 0', '--yes']);
      expect(r.status, r.stdout + r.stderr).toBe(2);
      expect(r.stderr).toContain('Could not switch off outbound HTTP');
      expect(await copies(superUrl!)).toEqual([]);
    });
    it('names the extensions it cannot switch off', async () => {
      await makeSource();
      await sql(superUrl!, SRC, 'create extension dblink');
      const r = cliRun(base(['--test', 'exit 0', '--yes']));
      expect(r.stdout + r.stderr).toMatch(/Not switched off: dblink/);
    });
    it('the source still has the original function afterwards', async () => {
      const r = await sql(superUrl!, SRC, `select prosrc from pg_proc where proname = 'http_post' and pronamespace = 'net'::regnamespace`);
      expect(r.rows[0].prosrc).toContain('insert into public.net_calls');
    });
  });

  describe('F: only dead copies of this host are swept', () => {
    it('leaves a copy labelled by another host alone, and sweeps one of this host with a dead pid', async () => {
      await makeSource();
      const { hostId } = await import('../../src/guard.js');
      await sql(superUrl!, 'postgres', 'create database saboteur_2147480000_1');
      await sql(superUrl!, 'postgres', `comment on database saboteur_2147480000_1 is 'rls-saboteur copy tok host=otherhost0000'`);
      await sql(superUrl!, 'postgres', 'create database saboteur_2147480001_1');
      await sql(superUrl!, 'postgres', `comment on database saboteur_2147480001_1 is 'rls-saboteur copy tok host=${hostId()}'`);
      const r = cliRun(base(['--test', 'exit 0', '--yes']));
      expect([0, 1], r.stdout + r.stderr).toContain(r.status);
      const left = await copies(superUrl!);
      expect(left).toContain('saboteur_2147480000_1');
      expect(left).not.toContain('saboteur_2147480001_1');
    });
  });

  describe('1: an interrupted copy never leaves a database behind', () => {
    const NAMES = `select datname, shobj_description(oid, 'pg_database') as label from pg_database where datname like 'saboteur\\_%' order by 1`;
    async function makeBigSource(): Promise<void> {
      await makeSource();
      await sql(superUrl!, SRC, `create table bulk as select g as id, repeat('x', 400) as pad from generate_series(1, 600000) g`);
    }
    /** Start the CLI; resolves with the child and a promise of its exit code. */
    function startCli(args: string[]) {
      const child = spawn('node', [cli, ...args], { cwd: scratch, env: { ...process.env, CI: 'true' }, stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      child.stdout.on('data', (b) => (out += b));
      child.stderr.on('data', (b) => (out += b));
      const exited = new Promise<number | null>((r) => child.on('close', (code) => r(code)));
      return { child, exited, output: () => out };
    }
    /** Waits until the server is running a CREATE DATABASE for a saboteur database matching `pattern`. */
    async function waitForCreate(pattern: string): Promise<void> {
      const c = await open(urlFor(superUrl!, 'postgres'));
      try {
        for (let i = 0; i < 4000; i++) {
          const r = await c.query(
            `select count(*)::int as n from pg_stat_activity where state = 'active' and query ~* $1 and pid <> pg_backend_pid()`,
            [pattern]
          );
          if (r.rows[0].n > 0) return;
          await new Promise((res) => setTimeout(res, 10));
        }
        throw new Error('the CREATE DATABASE never showed up in pg_stat_activity');
      } finally {
        await c.end();
      }
    }
    /** After the CLI has exited: wait for any CREATE DATABASE still running on the server, then list the saboteur databases. */
    async function leftAfterExit(): Promise<unknown[]> {
      const c = await open(urlFor(superUrl!, 'postgres'));
      try {
        for (let i = 0; i < 1200; i++) {
          const r = await c.query(`select count(*)::int as n from pg_stat_activity where state = 'active' and query ~* '^create database' and pid <> pg_backend_pid()`);
          if (r.rows[0].n === 0) break;
          await new Promise((res) => setTimeout(res, 50));
        }
      } finally {
        await c.end();
      }
      return (await sql(superUrl!, 'postgres', NAMES)).rows;
    }
    const MASTER_CREATE = '^create database "saboteur_[0-9a-f]{12}_[0-9]+_[0-9a-f]{16}_tpl"';
    const BREAK_CREATE = '^create database "saboteur_[0-9a-f]{12}_[0-9]+_[0-9a-f]{16}_[0-9]+"';

    it.each([['SIGINT', 130], ['SIGTERM', 143]] as const)('%s during the first copy: the CLI exits only after the server stopped creating, and NO saboteur database remains (no reset)', async (sig, code) => {
      await makeBigSource();
      const run = startCli(base(['--test', 'exit 0', '--yes']));
      await waitForCreate(MASTER_CREATE);
      run.child.kill(sig);
      expect(await run.exited, run.output()).toBe(code);
      // The CLI must not have left before the CREATE ended and was dropped. If the server were still copying,
      // the copy would appear once it finished, so wait for any running CREATE first: nothing may remain.
      expect(await leftAfterExit(), run.output()).toEqual([]);
    }, 120_000);

    it('SIGINT during a per-break copy: no saboteur database remains', async () => {
      await makeBigSource();
      const run = startCli(base(['--test', 'exit 0', '--yes']));
      await waitForCreate(BREAK_CREATE);
      run.child.kill('SIGINT');
      expect(await run.exited, run.output()).toBe(130);
      expect(await leftAfterExit(), run.output()).toEqual([]);
    }, 120_000);

    it('kill -9 between CREATE and COMMENT leaves an unlabelled copy; the next run sweeps it by its name', async () => {
      await makeBigSource();
      const run = startCli(base(['--test', 'exit 0', '--yes']));
      await waitForCreate(MASTER_CREATE);
      run.child.kill('SIGKILL');
      await run.exited;
      // The server finishes the CREATE by itself. Wait for the orphan to appear.
      let rows: { datname: string; label: string | null }[] = [];
      for (let i = 0; i < 600 && rows.length === 0; i++) {
        rows = (await sql(superUrl!, 'postgres', NAMES)).rows;
        if (rows.length === 0) await new Promise((r) => setTimeout(r, 100));
      }
      expect(rows.length, 'the orphan never appeared').toBe(1);
      expect(rows[0].label, 'the orphan has no label: only its name identifies it').toBeNull();
      const again = cliRun(base(['--test', 'exit 0', '--yes']));
      expect([0, 1], again.stdout + again.stderr).toContain(again.status);
      expect((await sql(superUrl!, 'postgres', NAMES)).rows).toEqual([]);
    }, 180_000);

    it('an unlabelled copy of a dead pid on this host is swept; one of another host, or of a live pid, is not', async () => {
      await makeSource();
      const tok = 'b'.repeat(16);
      const dead = copyNameFor(hostId(), 2147480000, tok, 1);
      const foreign = copyNameFor('ffffffffffff', 2147480001, tok, 1);
      const live = copyNameFor(hostId(), process.pid, tok, 2);
      for (const n of [dead, foreign, live]) await sql(superUrl!, 'postgres', `create database "${n}"`);
      const r = cliRun(base(['--test', 'exit 0', '--yes']));
      expect([0, 1], r.stdout + r.stderr).toContain(r.status);
      const left = await copies(superUrl!);
      expect(left).not.toContain(dead);
      expect(left).toContain(foreign);
      expect(left).toContain(live);
    });

    it('a --db-url that names a saboteur copy is refused with exit 2', async () => {
      await makeSource();
      const name = copyNameFor(hostId(), 2147480000, 'b'.repeat(16), 'tpl');
      await sql(superUrl!, 'postgres', `create database "${name}"`);
      const r = cliRun(['--db-url', urlFor(superUrl!, name), '--test', 'exit 0', '--yes', '--dry-run']);
      expect(r.status, r.stdout + r.stderr).toBe(2);
      expect(r.stderr).toMatch(/name of a copy/);
      expect(await copies(superUrl!)).toEqual([name]);
    });
  });

  describe('H1: values are checked, and a run that checked nothing is not a pass', () => {
    it.each([['--threshold', 'abc'], ['--threshold', '150'], ['--jobs', '0'], ['--jobs', '1.5'], ['--timeout', '-1'], ['--max-size', 'huge'], ['--runner', 'bogus']])(
      '%s %s exits 2 before any connection',
      async (flag, value) => {
        await makeSource();
        const r = cliRun(base(['--test', 'exit 0', '--yes', flag, value]));
        expect(r.status, r.stdout + r.stderr).toBe(2);
        expect(r.stderr).toContain(flag);
        expect(await copies(superUrl!)).toEqual([]);
      }
    );
    it('a --filter that matches no break while policies exist is exit 2, not 0', async () => {
      await makeSource();
      const r = cliRun(base(['--test', 'exit 0', '--yes', '--filter', 'no-such-break']));
      expect(r.status, r.stdout + r.stderr).toBe(2);
      expect(r.stdout + r.stderr).toMatch(/no break was run/);
    });
  });

  describe('G: names from the database are shown visibly', () => {
    it('an escape sequence in a policy name never reaches the console or the report as a control character', async () => {
      await makeSource();
      await sql(superUrl!, SRC, `create policy "evil\u001b[31mRED\u2028and\u200bmore" on docs for select using (true)`);
      const r = cliRun(base(['--test', 'exit 0', '--yes', '--dry-run']));
      const r2 = cliRun(base(['--test', 'exit 0', '--yes']));
      const all = r.stdout + r.stderr + r2.stdout + r2.stderr + readFileSync(join(scratch, 'r.md'), 'utf8');
      expect(all).not.toMatch(new RegExp('[\\u0000-\\u0008\\u000b-\\u001f\\u007f\\u2028\\u2029\\u200b-\\u200d\\ufeff]'));
      expect(all).toContain('\\x1b[31mRED');
    });
  });
});
void existsSync;
