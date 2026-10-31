#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CONFIG_FILE, discoverDbUrl, readFileConfig, scrubSecrets } from './config.js';
import { REMOTE_FLAG, remoteRefusal, resolveConnection, stripRedirectEnv, urlIsLocal } from './safety.js';
import { consoleReport, exitCode, jsonReport, markdownReport } from './report.js';
import { run } from './run.js';
import { dbEnvRemovals, discoverSuite, envFileWarnings } from './tests.js';
import { Guard, databaseOf, sourceNameProblem, verifyDatabase } from './guard.js';
import { connectionParamProblem } from './urls.js';
import { DEFAULT_MAX_SIZE, parseJobs, parsePercent, parseRunner, parseSeconds, parseSize } from './options.js';
import { visible } from './confirm.js';
import { ApprovalRequired, makePrompter } from './confirm.js';
import { parseMask } from './mask.js';
import { discoverBuildFiles } from './files.js';
import { IMAGE_PATTERN } from './docker.js';

let knownUrl: string[] = [];
const HELP = `rls-saboteur: mutation testing for Postgres and Supabase RLS

Breaks each row level security policy on purpose, one at a time, runs your tests,
and lists every break the tests did not catch.

Usage
  npx rls-saboteur [options]

Options
  --db-url <url>        Database to read. Default: local Supabase, port from supabase/config.toml
  --schemas <a,b>       Schemas to cover. Default: public
  --test "<command>"    Run this command instead of "supabase test db". Exit 0 means passed, exit 1 means a
                        test failed, any other exit code or a signal means the tests could not run (an error,
                        not a catch).
                        The database is passed as $DATABASE_URL, $SABOTEUR_DB_URL, the PG* variables,
                        and as {{db_url}} inside the command.
  --tests-dir <dir>     Directory of pgTAP files. Default: supabase/tests
  --runner <name>       auto (default), supabase, or psql. For the default pgTAP discovery.
  --jobs <n>            Breaks to run in parallel on database copies. Default: 2
  --threshold <pct>     Fail below this score. Default: 100
  --only-related        Per break, run only the test files that mention the table
  --isolation template  Kept for old scripts. Every run uses database copies. "in-place" was removed in 0.2.0.
  --admin-url <url>     Superuser URL used only to copy and drop databases. A local Supabase keeps a
                        superuser cron connection open; with this, copies (and --jobs) work.
  --close-sessions      Approve closing other sessions on the database for a moment, to take the first copy.
                        --yes does NOT approve this. Local database only; never with the remote flag.
  --max-size <size>     Copy a source larger than 2GB. Default limit: 2GB. Copying locks the source for the
                        copy's duration and needs about (jobs + 1) x its size in free disk.
  --no-isolate-network  Leave outbound HTTP on inside the copies. Default: it is switched off (pg_net and http
                        functions do nothing in a copy; the source is never touched).
  --no-terminate        Never close other connections to take the first copy. A busy database is then an error.
                        (Closing them is only ever done on a local host, after you say yes.)
  --yes                 Approve the plan and a test command from ${CONFIG_FILE} without asking.
                        Required when there is no terminal (CI). Only pass it for a run you have read the
                        plan of. It does not approve closing sessions (see --close-sessions).
  --from-files          Build the copies from supabase/migrations/*.sql and supabase/seed.sql instead of cloning the
                        database. No row of your database is copied. The policies in the files must match it.
  --migrations-dir <d>  With --from-files: the migrations directory. Default: supabase/migrations
  --seed-file <path>    With --from-files: the seed file. Default: supabase/seed.sql (optional)
  --mask <col>          Scramble schema.table.column in the first copy, before any break runs. Repeat for more.
                        schema.table.column=null sets it to NULL instead. If a column cannot be masked, the run stops.
  --sandbox             Run the copies in a throwaway Docker container (127.0.0.1 only) instead of on the server
                        that holds your database. The rows are streamed in with pg_dump unless --from-files is given.
  --sandbox-image <i>   Image for --sandbox. Default: postgres:<major version of your database>
  --timeout <seconds>   Per test run. Default: 600
  --filter <text>       Only breaks whose id contains this text
  --checks-only         Run only the checks that need no tests
  --dry-run             List the breaks and stop. Runs no tests.
  --json                Print the report as JSON on stdout (the console report goes to stderr)
  --json-file <path>    Also write the JSON report to a file
  --report <path>       Markdown report. Default: saboteur-report.md
  ${REMOTE_FLAG}
                        Allow a database that is not local. Breaking a policy takes a lock.
  -h, --help, -v, --version

Exit codes: 0 passed, 1 below threshold or a check failed, 2 could not check.
Optional ${CONFIG_FILE}: { "schemas": [], "test": "", "threshold": 95, "skip": [{ "policy": "", "reason": "" }] }
`;

async function main(): Promise<number> {
  const { values: v } = parseArgs({
    options: {
      'db-url': { type: 'string' },
      schemas: { type: 'string' },
      test: { type: 'string' },
      runner: { type: 'string' },
      'tests-dir': { type: 'string' },
      jobs: { type: 'string' },
      threshold: { type: 'string' },
      'only-related': { type: 'boolean' },
      isolation: { type: 'string' },
      'no-terminate': { type: 'boolean' },
      'close-sessions': { type: 'boolean' },
      'max-size': { type: 'string' },
      'isolate-network': { type: 'boolean' },
      'no-isolate-network': { type: 'boolean' },
      yes: { type: 'boolean' },
      'admin-url': { type: 'string' },
      'from-files': { type: 'boolean' },
      'migrations-dir': { type: 'string' },
      'seed-file': { type: 'string' },
      mask: { type: 'string', multiple: true },
      sandbox: { type: 'boolean' },
      'sandbox-image': { type: 'string' },
      timeout: { type: 'string' },
      filter: { type: 'string' },
      'checks-only': { type: 'boolean' },
      'dry-run': { type: 'boolean' },
      json: { type: 'boolean' },
      'json-file': { type: 'string' },
      report: { type: 'string' },
      [REMOTE_FLAG.slice(2)]: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean', short: 'v' }
    }
  });
  if (v.help) {
    process.stdout.write(HELP);
    return 0;
  }
  if (v.version) {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    process.stdout.write(pkg.version + '\n');
    return 0;
  }

  const cwd = process.cwd();
  const file = readFileConfig(cwd);
  const found = discoverDbUrl(cwd, v['db-url']);
  knownUrl = [found.dbUrl, ...(v['admin-url'] ? [v['admin-url']] : [])];
  // Values are checked before anything connects. A bad value is exit 2, never a silent default.
  const threshold = v.threshold !== undefined ? parsePercent(v.threshold, '--threshold') : file.threshold !== undefined ? parsePercent(String(file.threshold), `"threshold" in ${CONFIG_FILE}`) : 100;
  const jobs = v.jobs !== undefined ? parseJobs(v.jobs) : 2;
  const timeoutSeconds = v.timeout !== undefined ? parseSeconds(v.timeout) : 600;
  let runner = parseRunner(v.runner);
  if (v.sandbox) {
    // The Supabase CLI runs pg_prove in its own container, which on Docker Desktop for Mac could not reach the sandbox
    // (connection refused, in both modes). psql and --test run on this machine and do.
    if (runner === 'supabase') throw new Error('--runner supabase does not work with --sandbox: the Supabase CLI runs pg_prove in a container that cannot reach the sandbox. Use --runner psql (the default with --sandbox) or --test.');
    if (runner === 'auto') runner = 'psql';
  }
  const maxSizeBytes = v['max-size'] !== undefined ? parseSize(v['max-size']) : DEFAULT_MAX_SIZE;
  if (v['isolate-network'] && v['no-isolate-network']) throw new Error('--isolate-network and --no-isolate-network contradict each other.');
  const urlProblem =
    connectionParamProblem(found.dbUrl, v['db-url'] ? '--db-url' : 'the database URL') ??
    (v['admin-url'] ? connectionParamProblem(v['admin-url'], '--admin-url') : null);
  if (urlProblem) {
    process.stderr.write(scrubSecrets(urlProblem, knownUrl) + '\n');
    return 2;
  }
  const sourceName = sourceNameProblem(databaseOf(found.dbUrl));
  if (sourceName) {
    process.stderr.write(sourceName + '\n');
    return 2;
  }
  const fromFiles = Boolean(v['from-files']);
  const sandbox = Boolean(v.sandbox);
  if (!fromFiles && (v['migrations-dir'] !== undefined || v['seed-file'] !== undefined)) throw new Error('--migrations-dir and --seed-file need --from-files.');
  if (!sandbox && v['sandbox-image'] !== undefined) throw new Error('--sandbox-image needs --sandbox.');
  if (sandbox && v['admin-url']) throw new Error('--admin-url is not used with --sandbox: the container is the server that makes the copies.');
  if (v['sandbox-image'] !== undefined && (!IMAGE_PATTERN.test(v['sandbox-image']) || v['sandbox-image'].startsWith('-'))) {
    throw new Error(`--sandbox-image "${v['sandbox-image']}" is not an image name.`);
  }
  const masks = [...(file.mask ?? []), ...(v.mask ?? [])].map(parseMask);
  const buildFiles = fromFiles ? discoverBuildFiles(cwd, v['migrations-dir'], v['seed-file']) : null;
  const allowRemote = Boolean(v[REMOTE_FLAG.slice(2)]);
  const refusal =
    remoteRefusal(found.dbUrl, allowRemote) ?? (v['admin-url'] ? remoteRefusal(v['admin-url'], allowRemote) : null);
  if (refusal) {
    process.stderr.write(scrubSecrets(refusal, knownUrl) + '\n');
    return 2;
  }
  // From here on the guard and the connection use the same values: the host is written into the
  // URL, and nothing in the environment can redirect it (psql and the Supabase CLI read it too).
  found.dbUrl = resolveConnection(found.dbUrl).url;
  const adminUrl = v['admin-url'] ? resolveConnection(v['admin-url']).url : undefined;
  knownUrl.push(found.dbUrl, ...(adminUrl ? [adminUrl] : []));
  const removedEnv = dbEnvRemovals(process.env);
  stripRedirectEnv();

  // Zero-config: a local Supabase has a documented superuser (supabase_admin, local default
  // password). It is not a secret. It is used only to copy and drop databases.
  let adminNote: string | undefined;
  let adminUrlFinal = adminUrl;
  if (!sandbox && !adminUrlFinal && !v['no-terminate'] && existsSync(join(cwd, 'supabase', 'config.toml')) && urlIsLocal(found.dbUrl)) {
    const u = new URL(found.dbUrl);
    u.username = 'supabase_admin';
    u.password = 'postgres';
    const probeGuard = new Guard({ sourceUrl: found.dbUrl, allowTerminate: false });
    let probe: Awaited<ReturnType<Guard['connect']>> | undefined;
    try {
      probe = await probeGuard.connect(u.toString());
      adminUrlFinal = u.toString();
      adminNote = 'Using the local Supabase superuser (supabase_admin, the CLI default) only to copy and drop databases.';
    } catch {
      /* not a local Supabase, or a changed password: carry on without */
    } finally {
      await probe?.end().catch(() => {});
    }
  }

  if (v.isolation !== undefined && v.isolation !== 'template' && v.isolation !== 'auto') {
    process.stderr.write(
      v.isolation === 'in-place'
        ? '--isolation in-place was removed in 0.2.0, because it changed the real database. ' +
            'Every run now uses temporary copies and never changes your database. ' +
            'If the copy fails (a local Supabase keeps a superuser connection open), pass --admin-url with a superuser URL.\n'
        : '--isolation only accepts template. Every run uses database copies.\n'
    );
    return 2;
  }
    const schemas = v.schemas ? v.schemas.split(',').map((s) => s.trim()).filter(Boolean) : (file.schemas?.length ? file.schemas : ['public']);
  const suite = discoverSuite({ cwd, command: v.test ?? file.test, runner, testsDir: v['tests-dir'], verify: verifyDatabase });
  const tty = Boolean(process.stderr.isTTY);

  const out = v.json ? process.stderr : process.stdout;
  const result = await run({
    dbUrl: found.dbUrl,
    databaseSource: found.source,
    schemas,
    suite,
    jobs,
    threshold,
    timeoutMs: timeoutSeconds * 1000,
    terminate: !v['no-terminate'],
    closeSessions: Boolean(v['close-sessions']),
    maxSizeBytes,
    isolateNetwork: !v['no-isolate-network'],
    allowRemote,
    confirm: makePrompter({ yes: Boolean(v.yes) }),
    testFromConfig: !v.test && file.test ? file.test : undefined,
    adminUrl: adminUrlFinal,
    adminNote,
    removedEnv,
    envFiles: envFileWarnings(cwd),
    onlyRelated: Boolean(v['only-related']),
    checksOnly: Boolean(v['checks-only']),
    dryRun: Boolean(v['dry-run']),
    filter: v.filter,
    skip: file.skip ?? [],
    cwd,
    buildFiles,
    sandbox,
    sandboxImage: v['sandbox-image'],
    masks,
    progress: (line) => {
      if (tty) process.stderr.write(`\r\x1b[K${line}`);
    }
  });
  if (tty) process.stderr.write('\r\x1b[K');

  const { model } = result;
  if (v['dry-run']) {
    out.write(`${result.breaks.length} breaks on ${model.policyCount} policies:\n`);
    for (const l of model.serverFacts ?? []) out.write(`  ${l}\n`);
    for (const b of result.breaks) out.write(`  ${visible(b.id)}\n      ${visible(b.label)}\n`);
    return 0;
  }
  const urls = knownUrl;
  out.write(scrubSecrets(consoleReport(model, Boolean(process.stdout.isTTY) && !v.json), urls) + '\n');
  writeFileSync(v.report ?? 'saboteur-report.md', scrubSecrets(markdownReport(model), urls));
  if (v.json) process.stdout.write(scrubSecrets(jsonReport(model), urls) + '\n');
  if (v['json-file']) writeFileSync(v['json-file'], scrubSecrets(jsonReport(model), urls));
  return exitCode(model);
}

main().then(
  (code) => process.exit(code),
  (e: Error) => {
    const text = e instanceof ApprovalRequired ? e.message : `rls-saboteur could not check: ${e.message}`;
    process.stderr.write(scrubSecrets(text, knownUrl).split('\n').map(visible).join('\n') + '\n');
    process.exit(2);
  }
);
