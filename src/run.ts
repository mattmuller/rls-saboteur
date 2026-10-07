import pg from 'pg';
import { generateBreaks } from './breaks.js';
import { readCatalogue } from './catalogue.js';
import { runChecks } from './checks.js';
import { type SkipRule, redact, scrubSecrets } from './config.js';
import { createIsolation, type IsolationMode } from './isolation.js';
import { describeCatalogue, type RunModel } from './report.js';
import { filesMentioning, type TestRun, type TestSuite } from './tests.js';
import type { Break, BreakResult, Finding } from './types.js';

export interface RunOptions {
  dbUrl: string;
  databaseSource: string;
  schemas: string[];
  suite: TestSuite | null;
  jobs: number;
  threshold: number;
  timeoutMs: number;
  isolation: IsolationMode;
  terminate: boolean;
  adminUrl?: string;
  adminNote?: string;
  onlyRelated: boolean;
  checksOnly: boolean;
  dryRun: boolean;
  filter?: string;
  skip: SkipRule[];
  progress: (line: string) => void;
}

export interface RunOutput {
  model: RunModel;
  breaks: Break[];
}

export async function run(o: RunOptions): Promise<RunOutput> {
  const started = Date.now();
  const model: RunModel = {
    database: redact(o.dbUrl),
    databaseSource: o.databaseSource,
    testsDescription: o.suite ? o.suite.description : 'none found',
    schemas: o.schemas,
    policyCount: 0,
    tableCount: 0,
    isolation: 'template',
    notes: [],
    results: [],
    findings: [],
    unparsed: [],
    policies: [],
    threshold: o.threshold,
    jobs: o.jobs,
    durationMs: 0,
    checksOnly: o.checksOnly
  };

  // Catalogue only. No user table is read.
  const client = new pg.Client({ connectionString: o.dbUrl });
  client.on('error', () => {});
  await client.connect();
  let findings: Finding[];
  let breaks: Break[];
  try {
    const cat = await readCatalogue(client, o.schemas);
    Object.assign(model, describeCatalogue(cat));
    model.policies = cat.policies;
    findings = await runChecks(client, o.schemas);
    const gen = generateBreaks(cat);
    breaks = gen.breaks;
    model.unparsed = gen.unparsed;
  } finally {
    await client.end().catch(() => {});
  }
  model.findings = findings;

  if (o.filter) breaks = breaks.filter((b) => b.id.includes(o.filter!));

  // Config-level skips are listed, never silent.
  const results: BreakResult[] = [];
  const todo: Break[] = [];
  for (const b of breaks) {
    const rule = o.skip.find((s) => s.policy === b.policy && (!s.table || s.table === b.table));
    if (rule) results.push({ brk: b, outcome: 'skipped', note: `skipped by config: ${rule.reason}`, ms: 0 });
    else todo.push(b);
  }

  if (o.dryRun || o.checksOnly) {
    model.results = o.dryRun ? [...results, ...todo.map((brk): BreakResult => ({ brk, outcome: 'skipped', note: 'dry run', ms: 0 }))] : [];
    model.durationMs = Date.now() - started;
    return { model, breaks };
  }

  const suite = o.suite;
  if (!suite) {
    model.couldNotCheck =
      'no tests found. Add pgTAP files in supabase/tests, or pass --test "<command>". ' +
      'To get a starter suite, try rlsautotest or SupaShield, then run this again.';
    model.durationMs = Date.now() - started;
    return { model, breaks };
  }

  // Baseline on the real database. The psql runner needs pgTAP, which the real database may not
  // have, so it takes its baseline on a prepared copy below instead.
  if (suite.mode !== 'psql') {
    o.progress('Running the tests once, unchanged...');
    const base = await suite.run(o.dbUrl, { timeoutMs: o.timeoutMs });
    if (base.status !== 'passed') {
      model.couldNotCheck = `${baselineMessage(base, [o.dbUrl])}\n${tail(base.output, [o.dbUrl])}`;
      model.durationMs = Date.now() - started;
      return { model, breaks };
    }
    model.baselineAssertions = base.assertions;
  }

  const iso = await createIsolation({
    sourceUrl: o.dbUrl,
    mode: o.isolation,
    terminate: o.terminate,
    adminUrl: o.adminUrl,
    prepareMaster: suite.prepare ? (url) => suite.prepare!(url) : undefined
  });
  try {
    model.isolation = iso.mode;
    model.notes = [...(o.adminNote ? [o.adminNote] : []), ...iso.notes].map((n) => scrubSecrets(n, [o.dbUrl]));
    if (iso.mode === 'in-place' && suite.prepare) {
      await suite.prepare(o.dbUrl);
      model.notes.push('Installed the pgTAP extension in your local database, because the psql runner needs it.');
    }
    if (iso.mode === 'template' || suite.mode === 'psql') {
      const copyBase = await iso.withPristine((url) => suite.run(url, { timeoutMs: o.timeoutMs }));
      model.baselineAssertions ??= copyBase.assertions;
      if (copyBase.status !== 'passed' && suite.mode === 'psql') {
        model.couldNotCheck = `${baselineMessage(copyBase, [o.dbUrl])}\n${tail(copyBase.output, [o.dbUrl])}`;
        model.durationMs = Date.now() - started;
        return { model, breaks };
      }
      if (copyBase.status !== 'passed') {
        model.couldNotCheck =
          'the tests pass on your database but fail on an unchanged copy of it. ' +
          'They probably depend on something a copy does not carry (a connection setting or an outside service). ' +
          'Try --isolation in-place.\n' +
          tail(copyBase.output, [o.dbUrl]);
        model.durationMs = Date.now() - started;
        return { model, breaks };
      }
    }

    const jobs = iso.mode === 'in-place' ? 1 : Math.max(1, o.jobs);
    model.jobs = jobs;
    const testFilesByTable: Record<string, number> = {};
    if (suite.files.length) {
      for (const b of todo) {
        const key = `${b.schema}.${b.table}`;
        testFilesByTable[key] ??= filesMentioning(suite, b.table).length;
      }
      model.testFilesByTable = testFilesByTable;
    }

    let done = 0;
    const queue = [...todo];
    const worker = async (): Promise<void> => {
      for (let b = queue.shift(); b; b = queue.shift()) {
        const t0 = Date.now();
        let r: BreakResult;
        try {
          let files: string[] | undefined;
          if (o.onlyRelated && suite.files.length) {
            files = filesMentioning(suite, b.table);
          }
          if (files && files.length === 0) {
            r = { brk: b, outcome: 'missed', note: 'no test file mentions this table', ms: Date.now() - t0 };
          } else {
            const t = await iso.withBreak(b, (url) => suite.run(url, { files, timeoutMs: o.timeoutMs }));
            r = { brk: b, ...outcomeOf(t, [o.dbUrl]), ms: Date.now() - t0 };
          }
        } catch (e) {
          r = { brk: b, outcome: 'skipped', note: scrubSecrets(`the break could not be applied: ${(e as Error).message}`, [o.dbUrl]), ms: Date.now() - t0 };
        }
        results.push(r);
        done++;
        o.progress(`  ${done}/${todo.length} breaks tried`);
      }
    };
    await Promise.all(Array.from({ length: jobs }, worker));
  } finally {
    await iso.dispose();
  }

  const order = new Map(breaks.map((b, i) => [b.id, i]));
  results.sort((a, b) => (order.get(a.brk.id) ?? 0) - (order.get(b.brk.id) ?? 0));
  model.results = results;
  model.durationMs = Date.now() - started;
  return { model, breaks };
}

/** Maps a test run on a broken database to a result. Only a real test failure counts as caught. */
export function outcomeOf(t: TestRun, urls: string[]): Pick<BreakResult, 'outcome' | 'note'> {
  if (t.status === 'passed') return { outcome: 'missed' };
  if (t.status === 'failed') return t.reason ? { outcome: 'caught', note: scrubSecrets(t.reason, urls) } : { outcome: 'caught' };
  return { outcome: 'error', note: scrubSecrets(t.reason ?? 'the tests could not run', urls) };
}

/** Message for a baseline (unbroken) run that did not pass. The run then stops with exit 2. */
export function baselineMessage(base: TestRun, urls: string[]): string {
  if (base.status === 'error') {
    return `the tests could not run before any policy is broken (${scrubSecrets(base.reason ?? 'unknown error', urls)}). Fix that first.`;
  }
  return 'the tests fail before any policy is broken. Fix them first.';
}

function tail(s: string, urls: string[]): string {
  const lines = s.trim().split(/\r?\n/);
  return scrubSecrets(lines.slice(-15).join('\n'), urls);
}
