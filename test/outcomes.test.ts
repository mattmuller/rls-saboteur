import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { baselineMessage, outcomeOf } from '../src/run.js';
import { consoleReport, exitCode, type RunModel } from '../src/report.js';
import { discoverSuite } from '../src/tests.js';

const URL = 'postgres://u:pw@127.0.0.1:5432/db';

async function custom(command: string) {
  const suite = discoverSuite({ cwd: process.cwd(), command })!;
  return suite.run(URL, { timeoutMs: 20_000 });
}

describe('custom --test command', () => {
  it('exit 0 is passed, so the break is missed', async () => {
    const r = await custom('exit 0');
    expect(r.status).toBe('passed');
    expect(outcomeOf(r, [URL]).outcome).toBe('missed');
  });
  it('exit 1 is failed, so the break is caught', async () => {
    const r = await custom('exit 1');
    expect(r.status).toBe('failed');
    expect(outcomeOf(r, [URL]).outcome).toBe('caught');
  });
  it('exit 2 is an error, not a catch', async () => {
    const r = await custom('exit 2');
    expect(r.status).toBe('error');
    const o = outcomeOf(r, [URL]);
    expect(o.outcome).toBe('error');
    expect(o.note).toContain('2');
  });
  it('a signal is an error', async () => {
    const r = await custom('kill -9 $$');
    expect(r.status).toBe('error');
    expect(outcomeOf(r, [URL]).outcome).toBe('error');
  });
  it('a missing command (exit 127) is an error', async () => {
    expect((await custom('definitely-not-a-command-xyz')).status).toBe('error');
  });
});

describe('psql runner', () => {
  let dir: string;
  const oldPath = process.env.PATH;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'saboteur-psql-'));
    mkdirSync(join(dir, 'supabase', 'tests'), { recursive: true });
    writeFileSync(join(dir, 'supabase', 'tests', 'a.sql'), 'select 1;');
    mkdirSync(join(dir, 'bin'));
    process.env.PATH = `${join(dir, 'bin')}:${oldPath}`;
  });
  afterEach(() => {
    process.env.PATH = oldPath;
  });
  function fakePsql(body: string): void {
    const p = join(dir, 'bin', 'psql');
    writeFileSync(p, `#!/bin/sh\n${body}\n`);
    chmodSync(p, 0o755);
  }
  const run = () => discoverSuite({ cwd: dir, runner: 'psql' })!.run(URL, { timeoutMs: 20_000 });

  it('not ok in the output with exit 3 is caught', async () => {
    fakePsql('echo "ok 1 - a"; echo "not ok 2 - b"; exit 3');
    const r = await run();
    expect(r.status).toBe('failed');
    expect(outcomeOf(r, [URL]).outcome).toBe('caught');
  });
  it('exit 0 with not ok is caught', async () => {
    fakePsql('echo "not ok 1 - b"');
    expect((await run()).status).toBe('failed');
  });
  it('exit 2 with no TAP failure is an error', async () => {
    fakePsql('echo "psql: error: connection refused" >&2; exit 2');
    const r = await run();
    expect(r.status).toBe('error');
    expect(outcomeOf(r, [URL]).outcome).toBe('error');
  });
  it('clean TAP and exit 0 is passed', async () => {
    fakePsql('echo "ok 1 - a"');
    expect((await run()).status).toBe('passed');
  });
});

describe('baseline error', () => {
  const model: RunModel = {
    database: 'x', databaseSource: 'x', testsDescription: 't', schemas: ['public'], policyCount: 1, tableCount: 1,
    isolation: 'template', notes: [], findings: [], unparsed: [], policies: [], threshold: 100, jobs: 1, durationMs: 1, results: []
  };
  it('names the error and leads to exit 2', () => {
    const msg = baselineMessage({ status: 'error', reason: `could not connect ${URL}`, output: '' }, [URL]);
    expect(msg).toContain('could not run');
    expect(msg).not.toContain('pw');
    expect(exitCode({ ...model, couldNotCheck: msg })).toBe(2);
  });
  it('a failing baseline says the tests fail', () => {
    expect(baselineMessage({ status: 'failed', output: '' }, [])).toContain('fail');
  });
});

describe('score with errors', () => {
  it('leaves errors out of the score and warns', () => {
    const brk = { id: 'a', kind: 'drop-policy', schema: 's', table: 't', policy: 'p', label: 'l', effect: 'e', apply: [], restore: [] } as const;
    const m: RunModel = {
      database: 'x', databaseSource: 'x', testsDescription: 't', schemas: ['public'], policyCount: 1, tableCount: 1,
      isolation: 'template', notes: [], findings: [], unparsed: [], policies: [], threshold: 100, jobs: 1, durationMs: 1,
      results: [
        { brk, outcome: 'caught', ms: 1 },
        { brk, outcome: 'error', note: 'x', ms: 1 }
      ]
    };
    const out = consoleReport(m, false);
    expect(out).toContain('Score  100%');
    expect(out).toContain('WARNING: 1 break(s) errored');
  });
});
