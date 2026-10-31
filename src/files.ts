import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { Db } from './guard.js';

/**
 * Schema and seed only. A copy is built from the project's own files instead of cloning the database, so no row of the
 * real database is ever read. The files are the Supabase layout: supabase/migrations/*.sql in name order, then seed.sql.
 */

export interface BuildFiles {
  /** Migration files, in the order they run. */
  migrations: string[];
  /** The seed file, or null when there is none. */
  seed: string | null;
  /** What the plan says. */
  description: string;
}

export const DEFAULT_MIGRATIONS_DIR = join('supabase', 'migrations');
export const DEFAULT_SEED_FILE = join('supabase', 'seed.sql');

export function discoverBuildFiles(cwd: string, migrationsDir?: string, seedFile?: string): BuildFiles {
  const dir = migrationsDir ?? DEFAULT_MIGRATIONS_DIR;
  const root = join(cwd, dir);
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    throw new Error(`--from-files: the migrations directory "${dir}" does not exist. Pass --migrations-dir <dir>.`);
  }
  const migrations = readdirSync(root)
    .filter((n) => n.endsWith('.sql'))
    .sort()
    .map((n) => relative(cwd, join(root, n)));
  if (migrations.length === 0) throw new Error(`--from-files: "${dir}" holds no .sql file.`);
  const seedPath = seedFile ?? DEFAULT_SEED_FILE;
  let seed: string | null = null;
  if (existsSync(join(cwd, seedPath))) seed = seedPath;
  else if (seedFile !== undefined) throw new Error(`--from-files: the seed file "${seedFile}" does not exist.`);
  return {
    migrations,
    seed,
    description: `${migrations.length} migration file(s) from ${dir}${seed ? ` and ${seed}` : ' (no seed file, so tables are empty)'}`
  };
}

/**
 * Runs the files, in order, on a database that is a labelled copy. Each file is one simple-protocol query, so it may hold
 * many statements. A failure names the file and stops the run.
 */
export async function loadFiles(db: Db, cwd: string, files: BuildFiles): Promise<void> {
  for (const f of [...files.migrations, ...(files.seed ? [files.seed] : [])]) {
    const sql = readFileSync(join(cwd, f), 'utf8');
    try {
      await db.query(sql);
    } catch (e) {
      throw new Error(`building the copy from ${f} failed: ${(e as Error).message}${pgCronHint((e as Error).message)}`);
    }
  }
}

/** pg_cron installs only in the database named by cron.database_name, never in the fresh database a copy is built in. */
export function pgCronHint(message: string): string {
  return /can only create extension in database/i.test(message)
    ? '\nThis is pg_cron. It installs only in the database named by cron.database_name, so it cannot be created in a copy built from files. ' +
      'Run without --from-files (a clone keeps the extension, and its jobs stay inert), or keep the pg_cron statements out of the migrations.'
    : '';
}
