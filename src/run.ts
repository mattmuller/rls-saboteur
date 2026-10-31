import { generateBreaks } from './breaks.js';
import { readCatalogue } from './catalogue.js';
import { runChecks } from './checks.js';
import { CONFIG_FILE, type SkipRule, redact, scrubSecrets } from './config.js';
import { createIsolation, type Isolation } from './isolation.js';
import { createSandboxIsolation } from './sandbox.js';
import type { BuildFiles } from './files.js';
import { type MaskSpec, maskText, validateMasks } from './mask.js';
import { Guard } from './guard.js';
import { type Prompter, visible } from './confirm.js';
import { hostOf, urlIsLocal } from './safety.js';
import { describeFacts, readFacts, type ServerFacts } from './facts.js';
import { DEFAULT_MAX_SIZE, formatSize } from './options.js';
import { describeCatalogue, type RunModel } from './report.js';
import { filesMentioning, type TestRun, type TestSuite } from './tests.js';
import type { Break, BreakResult, Finding, Policy } from './types.js';

export interface RunOptions {
  dbUrl: string;
  databaseSource: string;
  schemas: string[];
  suite: TestSuite | null;
  jobs: number;
  threshold: number;
  timeoutMs: number;
  terminate: boolean;
  allowRemote?: boolean;
  /** Refuse a source larger than this many bytes (default 2 GB). */
  maxSizeBytes?: number;
  /** --close-sessions: the owner has approved closing other sessions on the source. --yes does not do this. */
  closeSessions?: boolean;
  /** Switch off outbound HTTP inside the copies (default true). */
  isolateNetwork?: boolean;
  /** Asks the owner. Every question defaults to No. */
  confirm: Prompter;
  /** The test command when it came from .rls-saboteur.json rather than --test. */
  testFromConfig?: string;
  adminUrl?: string;
  adminNote?: string;
  /** Names (never values) of environment variables that are removed from the test environment. */
  removedEnv?: string[];
  /** Names of .env files in the project that mention a database. The test framework may read them itself. */
  envFiles?: string[];
  onlyRelated: boolean;
  checksOnly: boolean;
  dryRun: boolean;
  filter?: string;
  skip: SkipRule[];
  progress: (line: string) => void;
  /** Working directory, where the migration and seed files are read from. */
  cwd?: string;
  /** --from-files: build the copies from these files; no row of the database is copied. */
  buildFiles?: BuildFiles | null;
  /** --sandbox: the copies live in a Docker container. */
  sandbox?: boolean;
  /** --sandbox-image. Default: postgres:<major version of the source>. */
  sandboxImage?: string;
  /** --sandbox-host-network: allow pg_dump on the host network for a --sandbox-image you chose. */
  sandboxHostNetwork?: boolean;
  /** --mask: columns scrambled in the first copy before any break runs. */
  masks?: MaskSpec[];
}

/** Policies that differ between two catalogues, by schema.table/name. Used to prove files rebuild the database's policies. */
export function policyDifferences(fromDatabase: Policy[], fromCopy: Policy[]): string[] {
  const key = (p: Policy): string => `${p.schema}.${p.table}/${p.name}`;
  const body = (p: Policy): string => JSON.stringify([p.cmd, p.permissive, [...p.roles].sort(), p.qual, p.withCheck]);
  const a = new Map(fromDatabase.map((p) => [key(p), body(p)]));
  const b = new Map(fromCopy.map((p) => [key(p), body(p)]));
  const out: string[] = [];
  for (const [k, v] of a) {
    if (!b.has(k)) out.push(`${k} is in the database but not in the copy`);
    else if (b.get(k) !== v) out.push(`${k} differs between the database and the copy`);
  }
  for (const k of b.keys()) if (!a.has(k)) out.push(`${k} is in the copy but not in the database`);
  return out;
}

export interface RunOutput {
  model: RunModel;
  breaks: Break[];
}

/** Why --from-files needs --sandbox. The migration and seed files are your code and can do anything their role can. */
export const FILES_NEED_SANDBOX =
  '--from-files needs --sandbox. Migration and seed files are your code: on your own server they would run with the rights of your database user ' +
  'and could change roles or other databases there. In a sandbox container that has no network at all they can only reach the container.';

export async function run(o: RunOptions): Promise<RunOutput> {
  if (o.buildFiles && !o.sandbox) throw new Error(FILES_NEED_SANDBOX);
  const started = Date.now();
  const model: RunModel = {
    database: redact(o.dbUrl),
    databaseSource: o.databaseSource,
    testsDescription: o.suite ? o.suite.description : 'none found',
    schemas: o.schemas,
    policyCount: 0,
    tableCount: 0,
    isolation: 'template',
    masked: [],
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
  const sourceGuard = new Guard({ sourceUrl: o.dbUrl, allowTerminate: false });
  const client = await sourceGuard.connect(o.dbUrl);
  let findings: Finding[];
  let breaks: Break[];
  let facts: ServerFacts | undefined;
  let factsError: string | undefined;
  let maskProblems: string[] = [];
  try {
    const cat = await readCatalogue(client, o.schemas);
    Object.assign(model, describeCatalogue(cat));
    model.policies = cat.policies;
    if (o.masks?.length && !o.checksOnly) {
      maskProblems = await validateMasks(client, o.masks);
    }
    findings = await runChecks(client, o.schemas);
    const gen = generateBreaks(cat);
    breaks = gen.breaks;
    model.unparsed = gen.unparsed;
    try {
      facts = await readFacts(client);
      model.serverFacts = describeFacts(facts, decodeURIComponent(new URL(o.dbUrl).pathname.slice(1)));
    } catch (e) {
      factsError = (e as Error).message;
    }
  } finally {
    await client.end().catch(() => {});
  }
  model.findings = findings;

  if (maskProblems.length) {
    model.couldNotCheck =
      `--mask cannot be applied, so nothing was copied: ${maskProblems.join('; ')}. ` +
      `A run never goes on with rows it was told to scramble.`;
    model.durationMs = Date.now() - started;
    return { model, breaks };
  }

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

  if (todo.length === 0 && model.policyCount > 0) {
    model.couldNotCheck =
      `no break was run, although the database has ${model.policyCount} polic${model.policyCount === 1 ? 'y' : 'ies'}. ` +
      (o.filter ? `--filter "${visible(o.filter)}" matched no break, or every match was skipped by ${CONFIG_FILE}. ` : breaks.length === 0 ? 'No break could be generated for them. ' : `Every break was skipped by ${CONFIG_FILE}. `) +
      `A run that checked nothing is not a pass.`;
    model.durationMs = Date.now() - started;
    return { model, breaks };
  }

  // Size and server facts come from the server itself, before anything is copied.
  const limit = o.maxSizeBytes ?? DEFAULT_MAX_SIZE;
  if (!facts) {
    model.couldNotCheck = `could not read the size of the database from the server (${scrubSecrets(factsError ?? 'no answer', [o.dbUrl])}), so it will not be copied.`;
    model.durationMs = Date.now() - started;
    return { model, breaks };
  }
  if (facts.sizeBytes > limit && !o.buildFiles) {
    const jobsN = Math.max(1, o.jobs);
    model.couldNotCheck =
      `the database is ${facts.sizePretty}, larger than the limit of ${formatSize(limit)}. ` +
      `Copying it locks it for the length of the copy and needs about ${formatSize(facts.sizeBytes * (jobsN + 1))} of free disk ((jobs + 1) x its size, here ${jobsN + 1} x). ` +
      `Pass --max-size <size> (for example --max-size ${formatSize(facts.sizeBytes * 2).replace(' ', '')}) to allow it. Nothing was copied.`;
    model.durationMs = Date.now() - started;
    return { model, breaks };
  }

  // Nothing below this line touches the database except through copies. Ask first.
  const dbName = decodeURIComponent(new URL(o.dbUrl).pathname.slice(1));
  const local = urlIsLocal(o.dbUrl);
  if (o.testFromConfig) {
    const ok = await o.confirm.ask(
      `The test command comes from ${CONFIG_FILE} in this project:\n  ${visible(o.testFromConfig)}\nRun it? (y/N)`,
      `running the test command from ${CONFIG_FILE}: ${visible(o.testFromConfig)}`
    );
    if (!ok) return stopped(model, started, `you did not approve the test command from ${CONFIG_FILE}`, breaks);
  }
  const planText =
    `Plan\n` +
    `  Database: ${visible(dbName)} on ${visible(scrubSecrets(hostOf(o.dbUrl), [o.dbUrl]))} (${local ? 'local' : 'NOT local'}; that is the host name only, the lines below come from the server)\n` +
    describeFacts(facts, dbName).map((l) => `  ${l}\n`).join('') +
    modeLines(o).map((l) => `  ${l}\n`).join('') +
    `  Note: outbound HTTP from the copy ${o.isolateNetwork === false ? 'is NOT switched off (--no-isolate-network was given)' : 'is switched off'}.\n` +
    `  Test environment: ${
      o.removedEnv?.length
        ? `${o.removedEnv.length} variable(s) that name a database or Supabase project are removed (${o.removedEnv.map(visible).join(', ')}); DATABASE_URL, SABOTEUR_DB_URL and PG* point at the copy.`
        : 'no variable that names a database or Supabase project was set; DATABASE_URL, SABOTEUR_DB_URL and PG* point at the copy.'
    }\n` +
    (o.envFiles?.length
      ? `  Warning: ${o.envFiles.map(visible).join(', ')} in this directory mention a database. Your test framework may read ${o.envFiles.length === 1 ? 'it' : 'them'} itself and reach a database other than the copy; this tool does not control that.\n`
      : '') +
    (suite.mode === 'custom'
      ? ''
      : `  Note: the test files are your code. They run with the rights of your database user on this server, so a \\c or dblink inside one can reach other databases there.\n`) +
    `  It will: ${o.buildFiles ? 'build temporary copies from files' : 'make temporary copies of it'}, break ${todo.length} policies in the copies, run: ${visible(suite.description)}\n` +
    `  It will not change this database.\n` +
    `Continue? (y/N)`;
  if (!(await o.confirm.ask(planText, `the plan: temporary copies of "${visible(dbName)}", ${todo.length} breaks in the copies, tests run: ${visible(suite.description)}`))) {
    return stopped(model, started, 'you answered No to the plan. Nothing was copied', breaks);
  }

  const prepareMaster = suite.prepare ? (url: string) => suite.prepare!(url) : undefined;
  const verifyMaster = async (masterUrl: string): Promise<void> => {
    const g = new Guard({ sourceUrl: masterUrl, allowTerminate: false });
    const c = await g.connect(masterUrl);
    try {
      const diff = policyDifferences(model.policies, (await readCatalogue(c, o.schemas)).policies);
      if (diff.length) {
        throw new Error(
          `the copy built from files does not have the policies of the database, so the breaks would not fit it: ${diff.slice(0, 5).join('; ')}${diff.length > 5 ? `; and ${diff.length - 5} more` : ''}. ` +
            `Update the migrations, or run without --from-files.`
        );
      }
    } finally {
      await c.end().catch(() => {});
    }
  };
  let iso: Isolation;
  if (o.sandbox) {
    iso = await createSandboxIsolation({
      dbUrl: o.dbUrl,
      image: sandboxImageFor(o, facts),
      hostNetworkDump: hostNetworkAllowed(o),
      files: o.buildFiles ?? null,
      schemas: o.schemas,
      cwd: o.cwd ?? process.cwd(),
      isolateNetwork: o.isolateNetwork,
      masks: o.masks,
      prepareMaster,
      verifyMaster
    });
  } else {
    iso = await createIsolation({
      sourceUrl: o.dbUrl,
      terminate: o.terminate,
      allowRemote: o.allowRemote,
      isolateNetwork: o.isolateNetwork,
      confirmTerminate: (n, apps, db) =>
        o.confirm.askSeparate(
          `${n} other connection(s) are open to ${visible(db)} (${apps.length ? apps.map(visible).join(', ') : 'no application name'}). Close them for a moment? They reconnect by themselves. (y/N)`,
          `closing ${n} other connection(s) to "${visible(db)}" for a moment (local database only)`,
          Boolean(o.closeSessions),
          '--close-sessions'
        ),
      adminUrl: o.adminUrl,
      masks: o.masks,
      prepareMaster
    });
  }
  try {
    model.isolation = iso.mode;
    model.masked = iso.masked;
    model.notes = [...(o.adminNote ? [o.adminNote] : []), ...iso.notes].map((n) => scrubSecrets(n, [o.dbUrl]));
    {
      const copyBase = await iso.withPristine((url) => suite.run(url, { timeoutMs: o.timeoutMs }));
      model.baselineAssertions ??= copyBase.assertions;
      if (copyBase.status !== 'passed') {
        model.couldNotCheck =
          `${baselineMessage(copyBase, [o.dbUrl])}\n` +
          `The baseline runs on an unchanged copy of your database, never on the database itself. ` +
          `Tests that depend on a connection setting or an outside service may not work on a copy.\n` +
          tail(copyBase.output, [o.dbUrl]);
        model.durationMs = Date.now() - started;
        return { model, breaks };
      }
    }

    const jobs = Math.max(1, o.jobs);
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

function stopped(model: RunModel, started: number, why: string, breaks: Break[]): RunOutput {
  model.couldNotCheck = `stopped before anything was copied: ${why}.`;
  model.durationMs = Date.now() - started;
  return { model, breaks };
}

/** pg_dump may use the host network on its own only for the default image. A chosen image needs --sandbox-host-network. */
export function hostNetworkAllowed(o: Pick<RunOptions, 'sandboxImage' | 'sandboxHostNetwork'>): boolean {
  return o.sandboxHostNetwork === true || !o.sandboxImage;
}

/** The image for the sandbox: --sandbox-image, or the official postgres image of the source's major version. */
export function sandboxImageFor(o: Pick<RunOptions, 'sandboxImage'>, facts: ServerFacts): string {
  if (o.sandboxImage) return o.sandboxImage;
  const major = /^(\d+)/.exec(facts.version)?.[1];
  if (!major) throw new Error(`could not read the major version from "${facts.version}"; pass --sandbox-image`);
  return `postgres:${major}`;
}

/** Plan lines for the new modes. Empty for a default run, so a default plan is unchanged. */
export function modeLines(o: Pick<RunOptions, 'buildFiles' | 'sandbox' | 'sandboxImage' | 'sandboxHostNetwork' | 'masks'>): string[] {
  const out: string[] = [];
  if (o.buildFiles) {
    out.push(
      `Copies: built from ${visible(o.buildFiles.description)}. No row of this database is copied. ` +
        `Those files are your code: they run as the superuser of the container, not on your server. ` +
        `Outbound HTTP functions are also switched off after each file, as a second layer.`
    );
  }
  if (o.sandbox) {
    out.push(
      `Sandbox: the copies live in a Docker container (image ${visible(o.sandboxImage ?? 'postgres:<version of the source>')}, pulled if it is not here). The container is removed when the run ends.` +
        (o.buildFiles
          ? ' It has no network at all (docker --network none) and no published port. This tool reaches it through docker exec. Your files run inside it as the container superuser, so they can only reach the container.'
          : ' It sits on the default Docker network and is reachable on 127.0.0.1 only. pg_dump runs in it and reads your database in a read-only session, so the container can reach your machine and the internet. Nothing of yours runs there except the SQL restored from your own database, with the triggers created after the data, so none fires.' +
            (o.sandboxImage && !o.sandboxHostNetwork
              ? ' If this container cannot reach your database on 127.0.0.1 (Docker Engine for Linux), the run stops: pg_dump on the host network is allowed for the default image only, or with --sandbox-host-network.'
              : ' If this container cannot reach your database on 127.0.0.1 (Docker Engine for Linux), pg_dump runs in a SECOND container on the HOST network (docker --network host --entrypoint pg_dump, same image, removed with the sandbox). That container can reach everything on your machine\'s loopback. The container that holds the copies never gets the host network.'))
    );
  }
  if (o.masks?.length) {
    out.push(`Masking: ${o.masks.map((m) => visible(maskText(m))).join(', ')} are rewritten in the first copy before any break runs. If one cannot be, the run stops.`);
  }
  return out;
}
