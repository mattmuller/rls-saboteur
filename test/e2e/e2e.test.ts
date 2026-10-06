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
  await admin.end();
});

describe('rls-saboteur against a real database', () => {
  it('catches what the tests assert and misses what they do not', () => {
    if (!reachable) return; // no Postgres: nothing to prove here
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
    expect(left.stdout.trim()).toBe('3');
    expect(readFileSync(join(root, 'e2e-report.md'), 'utf8')).toContain('Missed breaks');
  });
});
