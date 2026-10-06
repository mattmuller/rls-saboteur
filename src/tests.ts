import { spawn, spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';

export interface TestRun {
  ok: boolean;
  output: string;
  /** Number of TAP assertions seen, when the runner can tell. */
  assertions?: number;
  timedOut?: boolean;
}

export interface RunOptions {
  files?: string[];
  timeoutMs: number;
}

export interface TestSuite {
  /** One line for the console, e.g. `supabase/tests/*.sql  (pgTAP, run with supabase test db)`. */
  description: string;
  mode: 'supabase' | 'psql' | 'custom';
  /** Test files. Empty for a custom command. */
  files: string[];
  /** File contents, lower-cased, keyed by path. Used to map files to tables. */
  contents: Map<string, string>;
  run(dbUrl: string, opts: RunOptions): Promise<TestRun>;
  /** One-off setup on a throwaway database, e.g. installing pgTAP for the psql runner. */
  prepare?(dbUrl: string): Promise<void>;
}

const TESTS_DIR = join('supabase', 'tests');

export function findTestFiles(cwd: string, dir = TESTS_DIR): string[] {
  const root = join(cwd, dir);
  if (!existsSync(root)) return [];
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (name.endsWith('.sql')) out.push(relative(cwd, p));
    }
  };
  walk(root);
  return out;
}

/** True when `word` appears in `text` as a whole identifier. Plain text search, no SQL is interpreted. */
export function containsWord(text: string, word: string): boolean {
  const w = word.toLowerCase();
  const isIdent = (c: string | undefined): boolean => c !== undefined && /[a-z0-9_]/.test(c);
  let from = 0;
  for (;;) {
    const at = text.indexOf(w, from);
    if (at === -1) return false;
    if (!isIdent(text[at - 1]) && !isIdent(text[at + w.length])) return true;
    from = at + 1;
  }
}

export function filesMentioning(suite: TestSuite, table: string): string[] {
  return suite.files.filter((f) => containsWord(suite.contents.get(f) ?? '', table));
}

export function which(cmd: string): boolean {
  const r = spawnSync(process.platform === 'win32' ? 'where' : 'which', [cmd], { stdio: 'ignore' });
  return r.status === 0;
}

function execute(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  cwd: string,
  timeoutMs: number,
  shell: boolean
): Promise<{ code: number | null; output: string; timedOut: boolean }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd, env, shell, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    const keep = (b: Buffer): void => {
      output += b.toString();
      if (output.length > 400_000) output = output.slice(-200_000);
    };
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ code: 127, output: output + String(e), timedOut });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, output, timedOut });
    });
  });
}

/** Environment handed to every test command so it can reach the right database. */
export function dbEnv(dbUrl: string): NodeJS.ProcessEnv {
  const u = new URL(dbUrl);
  return {
    ...process.env,
    DATABASE_URL: dbUrl,
    SABOTEUR_DB_URL: dbUrl,
    PGHOST: u.hostname.replace(/^\[|\]$/g, ''),
    PGPORT: u.port || '5432',
    PGDATABASE: decodeURIComponent(u.pathname.slice(1)),
    PGUSER: decodeURIComponent(u.username),
    PGPASSWORD: decodeURIComponent(u.password)
  };
}

/** Count TAP result lines. Plain line-start checks on test output. */
export function countAssertions(output: string): number {
  let n = 0;
  for (const line of output.split(/\r?\n/)) {
    if (line.startsWith('ok ') || line.startsWith('not ok ')) n++;
  }
  return n;
}

function tapFailed(output: string): boolean {
  return output
    .split(/\r?\n/)
    .some((l) => l.startsWith('not ok') || l.startsWith('# Looks like you') || l.includes('Bad plan'));
}

export interface SuiteOptions {
  cwd: string;
  /** `--test` command. Takes precedence over discovery. */
  command?: string;
  runner?: 'auto' | 'supabase' | 'psql';
}

export function discoverSuite(o: SuiteOptions): TestSuite | null {
  if (o.command) {
    const cmd = o.command;
    return {
      description: `${cmd}  (your command; must exit non-zero on failure)`,
      mode: 'custom',
      files: [],
      contents: new Map(),
      async run(dbUrl, opts) {
        const withUrl = cmd.split('{{db_url}}').join(JSON.stringify(dbUrl));
        const r = await execute(withUrl, [], dbEnv(dbUrl), o.cwd, opts.timeoutMs, true);
        return { ok: r.code === 0 && !r.timedOut, output: r.output, timedOut: r.timedOut };
      }
    };
  }

  const files = findTestFiles(o.cwd);
  if (files.length === 0) return null;
  const contents = new Map(files.map((f) => [f, readFileSync(join(o.cwd, f), 'utf8').toLowerCase()]));
  const useSupabase = o.runner === 'supabase' || (o.runner !== 'psql' && which('supabase'));

  if (useSupabase) {
    return {
      description: `${TESTS_DIR}/*.sql  (pgTAP, run with supabase test db)`,
      mode: 'supabase',
      files,
      contents,
      async run(dbUrl, opts) {
        const args = ['test', 'db', '--db-url', dbUrl, ...(opts.files ?? [])];
        const r = await execute('supabase', args, process.env, o.cwd, opts.timeoutMs, false);
        const m = /Tests=(\d+)/.exec(r.output);
        return {
          ok: r.code === 0 && !r.timedOut,
          output: r.output,
          assertions: m ? Number(m[1]) : undefined,
          timedOut: r.timedOut
        };
      }
    };
  }

  return {
    description: `${TESTS_DIR}/*.sql  (pgTAP, run file by file with psql)`,
    mode: 'psql',
    files,
    contents,
    async prepare(dbUrl) {
      const sql =
        "do $$ begin if exists (select 1 from pg_namespace where nspname = 'extensions') " +
        "then create extension if not exists pgtap with schema extensions; " +
        "else create extension if not exists pgtap; end if; end $$;";
      const r = await execute('psql', ['-X', '-q', '-v', 'ON_ERROR_STOP=1', '-c', sql, dbUrl], process.env, o.cwd, 60_000, false);
      if (r.code !== 0) throw new Error(`Could not install pgTAP for the psql runner:\n${r.output.trim()}`);
    },
    async run(dbUrl, opts) {
      const list = opts.files ?? files;
      let all = '';
      for (const f of list) {
        const r = await execute(
          'psql',
          ['-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-f', f, dbUrl],
          process.env,
          o.cwd,
          opts.timeoutMs,
          false
        );
        all += r.output;
        if (r.code !== 0 || r.timedOut || tapFailed(r.output)) {
          return { ok: false, output: all, assertions: countAssertions(all), timedOut: r.timedOut };
        }
      }
      return { ok: true, output: all, assertions: countAssertions(all) };
    }
  };
}
