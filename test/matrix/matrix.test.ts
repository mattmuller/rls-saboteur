import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Fixture matrix. Each directory under test/fixtures is a small synthetic database with its own tests
 * and an expected.json naming the breaks that must be caught and the ones that must be missed.
 * Each fixture gets a fresh database; the CLI is run end to end and its JSON report must match exactly.
 *
 * Needs a superuser URL for a throwaway cluster in SABOTEUR_MATRIX_URL (npm run test:matrix starts one).
 * The cluster is wiped between fixtures (every database named rls_fx_*, every non-system role), so the
 * harness refuses a server whose cluster_name is not "rls-saboteur-ci".
 */
const superUrl = process.env.SABOTEUR_MATRIX_URL;
const root = join(import.meta.dirname, '..', '..');
const fixturesDir = join(root, 'test', 'fixtures');
const cli = join(root, 'dist', 'cli.js');

interface Expected {
  /** Extra CLI arguments. */
  args?: string[];
  /** Login role for --db-url, with its password. Default: the superuser. */
  dbRole?: { name: string; password: string };
  /** Omit --admin-url (the db-url role must then be able to copy by itself). */
  noAdminUrl?: boolean;
  exit: number;
  caught: string[];
  missed: string[];
  skipped?: string[];
  errored?: string[];
  /** check:severity pairs, e.g. "function-execute:FAIL". */
  findings?: string[];
  /** Why the fixture exists and what each deliberate miss stands for. */
  notes?: string;
}

const withDb = (url: string, db: string, user?: { name: string; password: string }): string => {
  const u = new URL(url);
  u.pathname = '/' + db;
  if (user) {
    u.username = user.name;
    u.password = user.password;
  }
  return u.toString();
};

async function withAdmin<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: superUrl });
  c.on('error', () => {});
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end().catch(() => {});
  }
}

/** Remove everything a previous fixture left: its databases first, then its roles. */
async function wipe(): Promise<void> {
  await withAdmin(async (c) => {
    const dbs = await c.query(`select datname from pg_database where datname like 'rls\\_fx\\_%' or datname like 'saboteur\\_%'`);
    for (const { datname } of dbs.rows) await c.query(`drop database "${datname}" with (force)`);
    const roles = await c.query(
      `select rolname from pg_roles where rolname !~ '^pg_' and rolname <> current_user and not rolsuper`
    );
    for (const { rolname } of roles.rows) await c.query(`drop role "${rolname}"`);
  });
}

function psql(url: string, args: string[]): { status: number | null; out: string } {
  const r = spawnSync('psql', ['-X', '-q', '-v', 'ON_ERROR_STOP=1', ...args, url], { encoding: 'utf8' });
  return { status: r.status, out: (r.stdout ?? '') + (r.stderr ?? '') };
}

const names = existsSync(fixturesDir) ? readdirSync(fixturesDir).sort() : [];
let scratch = '';
let version = '';

describe.skipIf(!superUrl)('fixture matrix', () => {
  beforeAll(async () => {
    expect(existsSync(cli), 'run npm run build first').toBe(true);
    await withAdmin(async (c) => {
      const r = await c.query(`select current_setting('cluster_name') as name, current_setting('server_version') as v`);
      if (r.rows[0].name !== 'rls-saboteur-ci') {
        throw new Error(`Refusing to wipe a cluster named "${r.rows[0].name}". Only rls-saboteur-ci clusters are wiped.`);
      }
      version = r.rows[0].v;
    });
    scratch = mkdtempSync(join(tmpdir(), 'rls-saboteur-matrix-'));
  });
  afterAll(async () => {
    if (superUrl) await wipe().catch(() => {});
    if (scratch) rmSync(scratch, { recursive: true, force: true });
  });

  for (const name of names) {
    it(`${name}`, async () => {
      const dir = join(fixturesDir, name);
      const expected: Expected = JSON.parse(readFileSync(join(dir, 'expected.json'), 'utf8'));
      const db = `rls_fx_${name.replace(/[^a-z0-9]/g, '_')}`;

      await wipe();
      await withAdmin((c) => c.query(`create database "${db}"`));
      const load = psql(withDb(superUrl!, db), ['-f', join(dir, 'schema.sql')]);
      expect(load.status, `schema.sql failed on ${version}:\n${load.out}`).toBe(0);

      const dbUrl = withDb(superUrl!, db, expected.dbRole);
      const jsonFile = join(scratch, `${name}.json`);
      const args = [
        cli,
        '--db-url', dbUrl,
        ...(expected.noAdminUrl ? [] : ['--admin-url', withDb(superUrl!, 'postgres')]),
        '--runner', 'psql',
        '--report', join(scratch, `${name}.md`),
        '--json-file', jsonFile,
        ...(expected.args ?? [])
      ];
      // The CLI reads supabase/config.toml from its cwd; the fixture directory has none.
      const r = spawnSync('node', args, { cwd: dir, encoding: 'utf8' });
      const log = `${r.stdout}\n${r.stderr}`;
      expect(existsSync(jsonFile), `no JSON report on ${version}:\n${log}`).toBe(true);
      const report = JSON.parse(readFileSync(jsonFile, 'utf8'));
      const ids = (outcome: string): string[] =>
        report.breaks.filter((b: { outcome: string }) => b.outcome === outcome).map((b: { id: string }) => b.id).sort();
      const findings = (report.findings as { check: string; severity: string }[]).map((f) => `${f.check}:${f.severity}`).sort();

      const got = {
        exit: r.status,
        couldNotCheck: report.couldNotCheck,
        caught: ids('caught'),
        missed: ids('missed'),
        skipped: ids('skipped'),
        errored: ids('error'),
        findings,
        unparsed: report.unparsed.length
      };
      const want = {
        exit: expected.exit,
        couldNotCheck: null,
        caught: [...expected.caught].sort(),
        missed: [...expected.missed].sort(),
        skipped: [...(expected.skipped ?? [])].sort(),
        errored: [...(expected.errored ?? [])].sort(),
        findings: [...(expected.findings ?? [])].sort(),
        unparsed: 0
      };
      expect(got, `PostgreSQL ${version}\n${log}`).toEqual(want);
    });
  }
});
