#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { CONFIG_FILE, discoverDbUrl, readFileConfig } from './config.js';
import { REMOTE_FLAG, remoteRefusal } from './safety.js';
import { consoleReport, exitCode, jsonReport, markdownReport } from './report.js';
import { run } from './run.js';
import { discoverSuite } from './tests.js';
import type { IsolationMode } from './isolation.js';

const HELP = `rls-saboteur: mutation testing for Postgres and Supabase RLS

Breaks each row level security policy on purpose, one at a time, runs your tests,
and lists every break the tests did not catch.

Usage
  npx rls-saboteur [options]

Options
  --db-url <url>        Database to read. Default: local Supabase, port from supabase/config.toml
  --schemas <a,b>       Schemas to cover. Default: public
  --test "<command>"    Run this command instead of "supabase test db". It must exit non-zero on failure.
                        The database is passed as $DATABASE_URL, $SABOTEUR_DB_URL, the PG* variables,
                        and as {{db_url}} inside the command.
  --runner <name>       auto (default), supabase, or psql. For the default pgTAP discovery.
  --jobs <n>            Breaks to run in parallel on database copies. Default: 2
  --threshold <pct>     Fail below this score. Default: 100
  --only-related        Per break, run only the test files that mention the table
  --isolation <mode>    auto (default), template, or in-place
  --no-terminate        Do not close other connections to take the first copy. Falls back to in-place.
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
      jobs: { type: 'string' },
      threshold: { type: 'string' },
      'only-related': { type: 'boolean' },
      isolation: { type: 'string' },
      'no-terminate': { type: 'boolean' },
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
  const refusal = remoteRefusal(found.dbUrl, Boolean(v[REMOTE_FLAG.slice(2)]));
  if (refusal) {
    process.stderr.write(refusal + '\n');
    return 2;
  }

  const isolation = (v.isolation ?? 'auto') as IsolationMode;
  if (!['auto', 'template', 'in-place'].includes(isolation)) {
    process.stderr.write('--isolation must be auto, template or in-place\n');
    return 2;
  }
  const runner = (v.runner ?? 'auto') as 'auto' | 'supabase' | 'psql';
  const schemas = v.schemas ? v.schemas.split(',').map((s) => s.trim()).filter(Boolean) : (file.schemas?.length ? file.schemas : ['public']);
  const suite = discoverSuite({ cwd, command: v.test ?? file.test, runner });
  const tty = Boolean(process.stderr.isTTY);

  const out = v.json ? process.stderr : process.stdout;
  const result = await run({
    dbUrl: found.dbUrl,
    databaseSource: found.source,
    schemas,
    suite,
    jobs: v.jobs ? Number(v.jobs) : 2,
    threshold: v.threshold ? Number(v.threshold) : (file.threshold ?? 100),
    timeoutMs: (v.timeout ? Number(v.timeout) : 600) * 1000,
    isolation,
    terminate: !v['no-terminate'],
    onlyRelated: Boolean(v['only-related']),
    checksOnly: Boolean(v['checks-only']),
    dryRun: Boolean(v['dry-run']),
    filter: v.filter,
    skip: file.skip ?? [],
    progress: (line) => {
      if (tty) process.stderr.write(`\r\x1b[K${line}`);
    }
  });
  if (tty) process.stderr.write('\r\x1b[K');

  const { model } = result;
  if (v['dry-run']) {
    out.write(`${result.breaks.length} breaks on ${model.policyCount} policies:\n`);
    for (const b of result.breaks) out.write(`  ${b.id}\n      ${b.label}\n`);
    return 0;
  }
  out.write(consoleReport(model, Boolean(process.stdout.isTTY) && !v.json) + '\n');
  writeFileSync(v.report ?? 'saboteur-report.md', markdownReport(model));
  if (v.json) process.stdout.write(jsonReport(model) + '\n');
  if (v['json-file']) writeFileSync(v['json-file'], jsonReport(model));
  return exitCode(model);
}

main().then(
  (code) => process.exit(code),
  (e: Error) => {
    process.stderr.write(`rls-saboteur could not check: ${e.message}\n`);
    process.exit(2);
  }
);
