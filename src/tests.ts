import { spawn, spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';

/** passed: every test passed. failed: the tests ran and at least one assertion failed. error: the tests could not run. */
export type TestStatus = 'passed' | 'failed' | 'error';

export interface TestRun {
  status: TestStatus;
  /** Short reason, set when status is error. Not yet scrubbed. */
  reason?: string;
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

interface ExecResult {
  code: number | null;
  signal?: NodeJS.Signals | null;
  output: string;
  timedOut: boolean;
}

function execute(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  cwd: string,
  timeoutMs: number,
  shell: boolean
): Promise<ExecResult> {
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
      resolve({ code: 127, signal: null, output: output + String(e), timedOut });
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, output, timedOut });
    });
  });
}

/**
 * Quote a value so the shell that `spawn(..., {shell: true})` uses passes it on byte for byte.
 * POSIX sh: single quotes, with each ' written as '\''. Windows cmd.exe: double quotes, and a value
 * holding " % or ! is refused, because cmd.exe expands or breaks on those even inside quotes.
 * Returns null when the value cannot be quoted safely.
 */
export function shellQuote(value: string, platform: NodeJS.Platform = process.platform): string | null {
  if (platform === 'win32') {
    if (/["%!]/.test(value)) return null;
    return `"${value}"`;
  }
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Keep the password out of argv, where `ps` shows it to every user on the machine. The URL goes on the
 * command line without it, and the password travels in PGPASSWORD, which libpq (psql) and the Supabase CLI
 * (pgx) both read. A URL with no password is returned unchanged.
 */
export function passwordless(dbUrl: string): { url: string; env: NodeJS.ProcessEnv } {
  try {
    const u = new URL(dbUrl);
    if (!u.password) return { url: dbUrl, env: process.env };
    const password = decodeURIComponent(u.password);
    u.password = '';
    return { url: u.toString(), env: { ...process.env, PGPASSWORD: password } };
  } catch {
    return { url: dbUrl, env: process.env };
  }
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

export function tapFailed(output: string): boolean {
  return output
    .split(/\r?\n/)
    .some(
      (l) =>
        l.startsWith('not ok') ||
        l.startsWith('# Looks like you') ||
        l.includes('Bad plan') ||
        l.includes('Failed test') ||
        /^Result: FAIL\b/.test(l.trim())
    );
}

/**
 * Custom `--test` command contract: exit 0 passed, exit 1 failed, any other exit code or a signal is an
 * error (the command could not run). A timeout is an error.
 */
export function classifyCustom(r: Pick<ExecResult, 'code' | 'signal' | 'timedOut'>): { status: TestStatus; reason?: string } {
  if (r.timedOut) return { status: 'error', reason: 'the command timed out' };
  if (r.signal) return { status: 'error', reason: `the command was killed by ${r.signal}` };
  if (r.code === 0) return { status: 'passed' };
  if (r.code === 1) return { status: 'failed' };
  return { status: 'error', reason: `the command exited with code ${r.code}, which is not 0 or 1` };
}

/** pgTAP runners: a failure needs TAP evidence. A non-zero exit without it means the tests did not run properly. */
export function classifyTap(
  r: Pick<ExecResult, 'code' | 'signal' | 'timedOut' | 'output'>,
  opts: { psql?: boolean } = {}
): { status: TestStatus; reason?: string } {
  if (r.timedOut) return { status: 'error', reason: 'the tests timed out' };
  if (tapFailed(r.output)) return { status: 'failed' };
  if (r.signal) return { status: 'error', reason: `the test process was killed by ${r.signal}` };
  if (r.code === 0) return { status: 'passed' };
  // psql exit 3: a statement failed under ON_ERROR_STOP. The unbroken baseline ran the same files and
  // passed, so the break changed what the SQL does. Exit 1 (fatal) and 2 (connection) stay errors.
  if (opts.psql && r.code === 3) return { status: 'failed', reason: 'a SQL error stopped the tests' };
  return { status: 'error', reason: `exit code ${r.code} with no failed test in the output` };
}

export interface SuiteOptions {
  cwd: string;
  /** `--test` command. Takes precedence over discovery. */
  command?: string;
  runner?: 'auto' | 'supabase' | 'psql';
  /** Directory of pgTAP files. Default supabase/tests. */
  testsDir?: string;
}

export function discoverSuite(o: SuiteOptions): TestSuite | null {
  if (o.command) {
    const cmd = o.command;
    return {
      description: `${cmd}  (your command; exit 0 passed, 1 test failed, other: could not run)`,
      mode: 'custom',
      files: [],
      contents: new Map(),
      async run(dbUrl, opts) {
        let withUrl = cmd;
        if (cmd.includes('{{db_url}}')) {
          const quoted = shellQuote(dbUrl);
          if (quoted === null) {
            return {
              status: 'error',
              reason:
                'the database URL holds a character (" % or !) that cmd.exe cannot pass safely through {{db_url}}. ' +
                'Use $DATABASE_URL (%DATABASE_URL% in cmd.exe) in your command instead.',
              output: '',
              timedOut: false
            };
          }
          withUrl = cmd.split('{{db_url}}').join(quoted);
        }
        const r = await execute(withUrl, [], dbEnv(dbUrl), o.cwd, opts.timeoutMs, true);
        return { ...classifyCustom(r), output: r.output, timedOut: r.timedOut };
      }
    };
  }

  const testsDir = o.testsDir ?? TESTS_DIR;
  const files = findTestFiles(o.cwd, testsDir);
  if (files.length === 0) return null;
  const contents = new Map(files.map((f) => [f, readFileSync(join(o.cwd, f), 'utf8').toLowerCase()]));
  const useSupabase = o.runner === 'supabase' || (o.runner !== 'psql' && which('supabase'));

  if (useSupabase) {
    return {
      description: `${testsDir}/*.sql  (pgTAP, run with supabase test db)`,
      mode: 'supabase',
      files,
      contents,
      async run(dbUrl, opts) {
        // A custom directory is passed explicitly; the CLI only looks in supabase/tests by itself.
        const safe = passwordless(dbUrl);
        const args = ['test', 'db', '--db-url', safe.url, ...(opts.files ?? (testsDir === TESTS_DIR ? [] : [testsDir]))];
        const r = await execute('supabase', args, safe.env, o.cwd, opts.timeoutMs, false);
        const m = /Tests=(\d+)/.exec(r.output);
        return {
          ...classifyTap(r),
          output: r.output,
          assertions: m ? Number(m[1]) : undefined,
          timedOut: r.timedOut
        };
      }
    };
  }

  return {
    description: `${testsDir}/*.sql  (pgTAP, run file by file with psql)`,
    mode: 'psql',
    files,
    contents,
    async prepare(dbUrl) {
      const sql =
        "do $$ begin if exists (select 1 from pg_namespace where nspname = 'extensions') " +
        "then create extension if not exists pgtap with schema extensions; " +
        "else create extension if not exists pgtap; end if; end $$;";
      const safe = passwordless(dbUrl);
      const r = await execute('psql', ['-X', '-q', '-v', 'ON_ERROR_STOP=1', '-c', sql, safe.url], safe.env, o.cwd, 60_000, false);
      if (r.code !== 0) throw new Error(`Could not install pgTAP for the psql runner:\n${r.output.trim()}`);
    },
    async run(dbUrl, opts) {
      const list = opts.files ?? files;
      const safe = passwordless(dbUrl);
      let all = '';
      for (const f of list) {
        const r = await execute(
          'psql',
          ['-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-f', f, safe.url],
          safe.env,
          o.cwd,
          opts.timeoutMs,
          false
        );
        all += r.output;
        const c = classifyTap(r, { psql: true });
        if (c.status !== 'passed') {
          return { ...c, output: all, assertions: countAssertions(all), timedOut: r.timedOut };
        }
      }
      return { status: 'passed', output: all, assertions: countAssertions(all) };
    }
  };
}
