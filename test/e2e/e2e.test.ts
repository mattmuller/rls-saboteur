import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * End-to-end test against a real Postgres. Needs a superuser URL in
 * SABOTEUR_E2E_URL (any local Postgres, for example the demo stack on 55322).
 * It creates its own database, and the tests inside it are plain SQL run by psql,
 * so neither pgTAP nor Docker is needed.
 */
const base = process.env.SABOTEUR_E2E_URL ?? 'postgres://postgres:postgres@127.0.0.1:55322/postgres';
const dbName = `saboteur_e2e_src_${process.pid}`;
const url = (db: string) => {
  const u = new URL(base);
  u.pathname = '/' + db;
  return u.toString();
};
const root = join(import.meta.dirname, '..', '..');

let reachable = false;
let createdAnon = false;

beforeAll(async () => {
  const admin = new pg.Client({ connectionString: base });
  admin.on('error', () => {});
  try {
    await admin.connect();
    reachable = true;
  } catch {
    return;
  }
  await admin.query(`drop database if exists ${dbName} with (force)`);
  await admin.query(`create database ${dbName}`);
  createdAnon = (await admin.query("select 1 from pg_roles where rolname = 'anon'")).rowCount === 0;
  await admin.query(`do $$ begin if not exists (select 1 from pg_roles where rolname = 'app_user') then create role app_user; end if; end $$`);
  await admin.end();
  const c = new pg.Client({ connectionString: url(dbName) });
  c.on('error', () => {});
  await c.connect();
  await c.query(`
    create table docs (id int primary key, org text not null, owner uuid not null);
    grant select, insert, update, delete on docs to app_user;
    alter table docs enable row level security;
    create function whoami() returns uuid language sql stable as
      $$ select (nullif(current_setting('request.jwt.claims', true), '')::json ->> 'sub')::uuid $$;
  `);
  // Four defects the catalogue checks must find: a policy caller without EXECUTE, a custom role that
  // inherits anon, a column grant under a table grant, and current_user in a SECURITY DEFINER function.
  await c.query(`
    do $$ begin
      if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
    end $$;
    grant anon to app_user;
    do $$ begin
      if not exists (select 1 from pg_roles where rolname = 'app_other') then create role app_other nologin; end if;
    end $$;
    grant select on docs to app_other;
    create function owner_is_app() returns boolean language plpgsql security definer as
      $$ begin return current_user = 'app'; end $$;
    revoke execute on function owner_is_app() from public;
    grant execute on function owner_is_app() to app_other;
    grant select (id) on docs to app_other;
    create function no_exec() returns boolean language sql stable as $$ select true $$;
    revoke execute on function no_exec() from public, app_other;
    create policy "needs exec" on docs for select to app_other using (no_exec());
    create policy "uses definer" on docs for select to app_other using (owner_is_app());
  `);
  await c.query(`
    create policy "read own" on docs for select to app_user using (owner = whoami());
    create policy "insert own" on docs for insert to app_user with check (owner = whoami());
    create policy "update own" on docs for update to app_user using (owner = whoami()) with check (owner = whoami());
  `);
  await c.end();
});

afterAll(async () => {
  if (!reachable) return;
  const admin = new pg.Client({ connectionString: base });
  await admin.connect();
  await admin.query(`drop database if exists ${dbName} with (force)`);
  await admin.query('drop role if exists app_user').catch(() => {});
  await admin.query('drop role if exists app_other').catch(() => {});
  // Only drop anon if this test created it; a Supabase database has its own.
  if (createdAnon) await admin.query('drop role if exists anon').catch(() => {});
  await admin.end();
});

describe('rls-saboteur against a real database', () => {
  it('catches what the tests assert and misses what they do not', (ctx) => {
    if (!reachable) ctx.skip();
    const cli = join(root, 'dist', 'cli.js');
    const r = spawnSync(
      'node',
      [cli, '--db-url', url(dbName), '--schemas', 'public', '--jobs', '2', '--json', '--report', join(root, 'e2e-report.md'),
       '--test', `psql "{{db_url}}" -X -q -v ON_ERROR_STOP=1 -f ${join(root, 'test/e2e/check.sql')}`],
      { encoding: 'utf8', cwd: root }
    );
    const report = JSON.parse(r.stdout);
    const outcome = (id: string) => report.breaks.find((b: { id: string }) => b.id.includes(id))?.outcome;

    expect(r.status).toBe(1); // some breaks are missed on purpose
    expect(outcome('read own/drop-policy')).toBe('caught');
    expect(outcome('read own/using-true')).toBe('caught');
    expect(outcome('insert own/check-removed')).toBe('caught');
    // The tests never update a row, so every break on the update policy is missed.
    expect(outcome('update own/drop-policy')).toBe('missed');
    expect(outcome('update own/using-true')).toBe('missed');
    expect(outcome('update own/check-removed')).toBe('missed');
    expect(outcome('docs/-/rls-disabled')).toBe('caught');

    // The source database is left exactly as it was.
    const left = spawnSync('psql', [url(dbName), '-X', '-A', '-t', '-c', "select count(*) from pg_policies where tablename = 'docs'"], { encoding: 'utf8' });
    expect(left.stdout.trim()).toBe('5'); // all policies still there
    expect(readFileSync(join(root, 'e2e-report.md'), 'utf8')).toContain('Missed breaks');
  });
});

describe('catalogue checks against a real database', () => {
  it('finds each of the four defects exactly once', (ctx) => {
    if (!reachable) ctx.skip();
    const r = spawnSync('node', [join(root, 'dist', 'cli.js'), '--db-url', url(dbName), '--checks-only', '--json', '--report', join(root, 'e2e-report.md')], {
      encoding: 'utf8',
      cwd: root
    });
    const report = JSON.parse(r.stdout);
    const count = (check: string) => report.findings.filter((f: { check: string }) => f.check === check).length;
    expect(count('function-execute')).toBe(1);
    expect(count('role-membership')).toBe(1);
    expect(count('inert-column-grant')).toBe(1);
    expect(count('definer-current-user')).toBe(1);
    expect(r.status).toBe(1);
  });
});
