import { describe, expect, it, vi } from 'vitest';

// A fake pg that records every statement. 'create database' on the master fails with "source in use" (55006),
// like a busy source, and the listener count is sampled at that moment.
// With sim.hang set, CREATE DATABASE stays in flight (like a 600 MB copy) until pg_cancel_backend names its backend pid.
const sent: string[] = [];
const sampled: { sigint: number } = { sigint: -1 };
const sim: {
  hang: boolean;
  cancelWorks: boolean;
  exists: Set<string>;
  inflightPid: number | null;
  reject: ((e: Error) => void) | null;
  started: (() => void) | null;
  leftover: string[] | null;
} = { hang: false, cancelWorks: true, exists: new Set(), inflightPid: null, reject: null, started: null, leftover: null };
let nextPid = 7000;
vi.mock('pg', () => {
  class Client {
    processID = ++nextPid;
    constructor(public cfg: { connectionString: string }) {}
    on() {}
    async connect() {}
    async end() {}
    async query(sql: string, values?: unknown[]) {
      if (/^select current_database\(\) as d$/.test(sql)) {
        return { rows: [{ d: decodeURIComponent(new URL(this.cfg.connectionString).pathname.slice(1)) }], rowCount: 1 };
      }
      sent.push(sql);
      if (/^show default_transaction_read_only/.test(sql)) return { rows: [{ default_transaction_read_only: 'on' }], rowCount: 1 };
      if (/^create database/i.test(sql)) {
        sampled.sigint = process.listenerCount('SIGINT');
        if (sim.hang) {
          sim.inflightPid = this.processID;
          return new Promise((_, reject) => {
            sim.reject = reject;
            sim.started?.();
          });
        }
        throw Object.assign(new Error('source database is being accessed by other users'), { code: '55006' });
      }
      if (/^select pg_cancel_backend/.test(sql)) {
        if (sim.cancelWorks && values?.[0] === sim.inflightPid) {
          sim.reject?.(Object.assign(new Error('canceling statement due to user request'), { code: '57014' }));
          sim.inflightPid = null;
        }
        return { rows: [{ pg_cancel_backend: true }], rowCount: 1 };
      }
      if (/shobj_description\(oid, 'pg_database'\) as c from/.test(sql)) {
        // An unlabelled database: the interrupted CREATE finished, the COMMENT never came.
        const name = String(values?.[0]);
        return sim.exists.has(name) ? { rows: [{ c: null }], rowCount: 1 } : { rows: [], rowCount: 0 };
      }
      if (/^select datname from pg_database where datname = any/.test(sql)) {
        const names = (sim.leftover ?? []).filter((n) => n);
        return { rows: names.map((datname) => ({ datname })), rowCount: names.length };
      }
      if (/^drop database/i.test(sql)) return { rows: [], rowCount: 0 };
      if (/from pg_stat_activity where datname = \$1/.test(sql)) return { rows: [{ n: 3, apps: ['my-app'] }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    }
  }
  return { default: { Client } };
});

import { createIsolation } from '../src/isolation.js';
import { ApprovalRequired, makePrompter, visible } from '../src/confirm.js';
import { connectionParamProblem } from '../src/urls.js';
import { withDatabase } from '../src/config.js';
import { copyConnection, dbEnv, dbEnvRemovals, envFileWarnings } from '../src/tests.js';
import { parseJobs, parsePercent, parseRunner, parseSeconds, parseSize } from '../src/options.js';
import { sameServer } from '../src/facts.js';
import { exitCode, sanitizeModel, type RunModel } from '../src/report.js';

const src = 'postgres://app:pw@127.0.0.1:55322/appdb';

describe('H3: a busy source that may not be closed is rejected without any DDL', () => {
  const ddl = () => sent.filter((q) => /^(drop|alter|create|comment|select pg_terminate)/i.test(q) && !/^create database "saboteur_[0-9a-f]{12}_\d+_[0-9a-f]{16}_tpl"/i.test(q));
  it('--no-terminate: names --admin-url, closes nothing, changes nothing', async () => {
    sent.length = 0;
    await expect(createIsolation({ sourceUrl: src, terminate: false })).rejects.toThrow(/--admin-url/);
    expect(sent.some((q) => /pg_terminate_backend/.test(q))).toBe(false);
    expect(ddl().filter((q) => !/^drop database if exists/i.test(q))).toEqual([]);
  });
  it('answering No: names --admin-url, closes nothing', async () => {
    sent.length = 0;
    await expect(createIsolation({ sourceUrl: src, terminate: true, confirmTerminate: async () => false })).rejects.toThrow(/--admin-url/);
    expect(sent.some((q) => /pg_terminate_backend/.test(q))).toBe(false);
  });
  it('an --admin-url that is the same server only by host and port is not proven, so sessions are not closed', async () => {
    sent.length = 0;
    // The mock server cannot answer the identity questions, so only the host and port fallback is left.
    await expect(
      createIsolation({ sourceUrl: src, terminate: true, adminUrl: 'postgres://postgres:pw@127.0.0.1:55322/postgres', confirmTerminate: async () => true })
    ).rejects.toThrow(/closing other sessions is refused: .*does not prove it/);
    expect(sent.some((q) => /pg_terminate_backend/.test(q))).toBe(false);
  });
  it('the remote flag: never closes', async () => {
    sent.length = 0;
    await expect(createIsolation({ sourceUrl: src, terminate: true, allowRemote: true, confirmTerminate: async () => true })).rejects.toThrow(/remote flag/);
    expect(sent.some((q) => /pg_terminate_backend/.test(q))).toBe(false);
  });
});

describe('H4: the signal handlers exist before the first copy starts', () => {
  it('SIGINT has a listener while CREATE DATABASE for the master is in flight, and none after the failure', async () => {
    const before = process.listenerCount('SIGINT');
    sampled.sigint = -1;
    await createIsolation({ sourceUrl: src, terminate: false }).catch(() => {});
    expect(sampled.sigint).toBe(before + 1);
    expect(process.listenerCount('SIGINT')).toBe(before);
  });
});

describe('H4: an interrupt during CREATE DATABASE cancels it, waits for it, then drops by name', () => {
  const adminDb = (q: string) => /^(?:create database|drop database if exists) "([^"]+)"/i.exec(q)?.[1];
  async function interrupt(opts: { cancelWorks: boolean; signal?: NodeJS.Signals }) {
    sent.length = 0;
    Object.assign(sim, { hang: true, cancelWorks: opts.cancelWorks, inflightPid: null, reject: null, leftover: null });
    sim.exists.clear();
    const exits: number[] = [];
    const stderr: string[] = [];
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((c?: number) => {
      exits.push(c ?? 0);
      return undefined as never;
    }) as never);
    const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation(((t: string) => {
      stderr.push(String(t));
      return true;
    }) as never);
    const before = { int: process.listeners('SIGINT'), term: process.listeners('SIGTERM') };
    const started = new Promise<void>((r) => (sim.started = r));
    const p = createIsolation({ sourceUrl: src, terminate: false, cleanupWaitMs: 150 }).catch(() => {});
    await started;
    const create = sent.find((q) => /^create database/i.test(q))!;
    const name = adminDb(create)!;
    // The CREATE has finished on the server, but its COMMENT never came: the database exists with no label.
    if (opts.cancelWorks) sim.exists.add(name);
    const sig = opts.signal ?? 'SIGINT';
    (process.emit as (e: string, a: string) => boolean)(sig, sig);
    for (let i = 0; i < 100 && exits.length === 0; i++) await new Promise((r) => setTimeout(r, 50));
    exitSpy.mockRestore();
    errSpy.mockRestore();
    // process.exit was stubbed, so this run's handlers were never removed by the exit. Remove them here.
    for (const l of process.listeners('SIGINT')) if (!before.int.includes(l)) process.off('SIGINT', l);
    for (const l of process.listeners('SIGTERM')) if (!before.term.includes(l)) process.off('SIGTERM', l);
    sim.hang = false;
    return { name, exits, stderr: stderr.join(''), p };
  }

  it('cancels its own CREATE, then drops the unlabelled copy by its NAME, and exits 130', async () => {
    const r = await interrupt({ cancelWorks: true });
    expect(r.exits).toEqual([130]);
    const iCancel = sent.findIndex((q) => /^select pg_cancel_backend/.test(q));
    const iDrop = sent.findIndex((q) => adminDb(q) === r.name && /^drop/i.test(q));
    expect(iCancel, 'no cancel was sent').toBeGreaterThan(-1);
    expect(iDrop, 'the unlabelled copy was not dropped').toBeGreaterThan(iCancel);
    expect(r.name).toMatch(/^saboteur_[0-9a-f]{12}_\d+_[0-9a-f]{16}_tpl$/);
  });
  it('SIGTERM does the same and exits 143', async () => {
    const r = await interrupt({ cancelWorks: true, signal: 'SIGTERM' });
    expect(r.exits).toEqual([143]);
    expect(sent.some((q) => adminDb(q) === r.name && /^drop/i.test(q))).toBe(true);
  });
  it('when the CREATE cannot be cancelled and a copy remains, it names the database and the drop command, and exits 1', async () => {
    Object.assign(sim, { leftover: null });
    sent.length = 0;
    // The drop cannot remove it: the server still lists it after the drop.
    const origLeft = sim.leftover;
    const pending = interrupt({ cancelWorks: false });
    // report the master name as still present once the cancel attempt is made
    const timer = setInterval(() => {
      const c = sent.find((q) => /^create database/i.test(q));
      if (c) sim.leftover = [adminDb(c)!];
    }, 5);
    const r = await pending;
    clearInterval(timer);
    sim.leftover = origLeft;
    expect(r.exits).toEqual([1]);
    expect(r.stderr).toContain(r.name);
    expect(r.stderr).toMatch(/drop database "saboteur_[0-9a-f]{12}_\d+_[0-9a-f]{16}_tpl" with \(force\);/);
  });
});

describe('B: closing sessions needs its own approval', () => {
  const quiet = { write: () => true };
  const noTty = { isTTY: false } as NodeJS.ReadableStream & { isTTY?: boolean };
  it('--yes answers ask() but not askSeparate(): with no terminal it throws and names --close-sessions', async () => {
    const p = makePrompter({ yes: true, stdin: noTty, stdout: { isTTY: false }, out: quiet, env: {} });
    expect(await p.ask('plan? (y/N)', 'the plan')).toBe(true);
    await expect(p.askSeparate('close? (y/N)', 'closing sessions', false, '--close-sessions')).rejects.toThrow(/--close-sessions/);
    await expect(p.askSeparate('close? (y/N)', 'closing sessions', false, '--close-sessions')).rejects.toBeInstanceOf(ApprovalRequired);
  });
  it('--close-sessions approves it without a terminal', async () => {
    const p = makePrompter({ yes: false, stdin: noTty, stdout: { isTTY: false }, out: quiet, env: {} });
    expect(await p.askSeparate('close? (y/N)', 'x', true, '--close-sessions')).toBe(true);
  });
});

describe('A: connection URLs', () => {
  it.each(['dbname', 'DBNAME', 'database', 'host', 'hostaddr', 'port', 'service', 'servicefile', 'options', 'user', 'target_session_attrs', 'replication'])(
    'rejects ?%s=',
    (k) => {
      expect(connectionParamProblem(`postgres://u:p@127.0.0.1:5432/db?${k}=x`, '--db-url')).toContain('--db-url');
    }
  );
  it('accepts sslmode, a plain URL, and does not echo the password', () => {
    expect(connectionParamProblem('postgres://u:p@127.0.0.1:5432/db?sslmode=disable', '--db-url')).toBeNull();
    expect(connectionParamProblem('postgres://u:secret@127.0.0.1:5432/db?dbname=x', '--db-url')).not.toContain('secret');
    expect(connectionParamProblem('not a url', '--db-url')).toMatch(/not a valid/);
    expect(connectionParamProblem('postgres://a,b/db', '--db-url')).toMatch(/more than one host/);
  });
  it('withDatabase builds from parts: dbname, host, options and user in the query never survive', () => {
    const u = withDatabase('postgres://u:p%40@127.0.0.1:5432/src?dbname=src&host=prod&options=-c%20x&user=root&sslmode=require', 'copy');
    expect(u).toBe('postgres://u:p%40@127.0.0.1:5432/copy?sslmode=require');
  });
  it('the subprocess URL has no query and the PG* variables name the copy', () => {
    const r = copyConnection('postgres://u:p@127.0.0.1:5432/copy?dbname=src&host=prod', {});
    expect(r.url).toBe('postgres://u@127.0.0.1:5432/copy');
    expect(r.env).toMatchObject({ PGHOST: '127.0.0.1', PGPORT: '5432', PGDATABASE: 'copy', PGUSER: 'u', PGPASSWORD: 'p' });
  });
});

describe('D: the test command environment', () => {
  it('drops database variables of every common name and repoints DATABASE_URL and SABOTEUR_DB_URL', () => {
    const saved = { ...process.env };
    try {
      for (const k of ['DIRECT_URL', 'SUPABASE_DB_URL', 'POSTGRES_URL', 'POSTGRES_PRISMA_URL', 'POSTGRES_URL_NON_POOLING', 'DB_URL', 'PGSERVICE', 'PGOPTIONS']) process.env[k] = 'prod';
      process.env.DATABASE_URL = 'prod';
      const env = dbEnv('postgres://u:p@127.0.0.1:5432/copy');
      for (const k of ['DIRECT_URL', 'SUPABASE_DB_URL', 'POSTGRES_URL', 'POSTGRES_PRISMA_URL', 'POSTGRES_URL_NON_POOLING', 'DB_URL', 'PGSERVICE', 'PGOPTIONS']) expect(env[k], k).toBeUndefined();
      expect(env.DATABASE_URL).toBe('postgres://u:p@127.0.0.1:5432/copy');
      expect(env.SABOTEUR_DB_URL).toBe('postgres://u:p@127.0.0.1:5432/copy');
      expect(env.PGDATABASE).toBe('copy');
    } finally {
      for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
      Object.assign(process.env, saved);
    }
  });
});

describe('2: the test command environment holds no variable that names another database or project', () => {
  const names = [
    'TEST_DATABASE_URL', 'SHADOW_DATABASE_URL', 'SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY',
    'DATABASE_URL_UNPOOLED', 'prisma_database_url', 'MY_POSTGRES_HOST', 'APP_DBURL', 'PGPASSWORD', 'PGSSLMODE', 'SERVICE_ROLE_JWT'
  ];
  it('removes every variable whose name contains DATABASE, DB_URL, DBURL, POSTGRES, SUPABASE or SERVICE_ROLE, and PG*', () => {
    const base = { PATH: '/bin', HOME: '/h', NODE_ENV: 'test', ...Object.fromEntries(names.map((n) => [n, 'secret-value'])) };
    const { env } = copyConnection('postgres://u:p@127.0.0.1:5432/copy', base);
    for (const n of names) expect(env[n], n).toBe(n.startsWith('PG') ? env[n] : undefined);
    expect(env.PGPASSWORD).toBe('p');
    expect(env.PGSSLMODE).toBeUndefined();
    expect(env.PATH).toBe('/bin');
    expect(env.NODE_ENV).toBe('test');
  });
  it('dbEnvRemovals lists names only, never values', () => {
    const list = dbEnvRemovals({ PATH: '/bin', SUPABASE_URL: 'https://prodref.supabase.co', TEST_DATABASE_URL: 'postgres://prod:secret@h/db' });
    expect(list).toEqual(['SUPABASE_URL', 'TEST_DATABASE_URL']);
    expect(JSON.stringify(list)).not.toMatch(/prodref|secret/);
  });
  it('envFileWarnings names the .env files that mention a database, and nothing else', async () => {
    const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = mkdtempSync(join(tmpdir(), 'rls-saboteur-env-'));
    try {
      writeFileSync(join(dir, '.env.local'), 'SUPABASE_URL=https://prodref.supabase.co\n');
      writeFileSync(join(dir, '.env'), 'FOO=bar\n');
      writeFileSync(join(dir, '.env.test'), 'database_url=postgres://x\n');
      expect(envFileWarnings(dir)).toEqual(['.env.local', '.env.test']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('C: same server', () => {
  const id = (o: object) => o as never;
  it('system identifier decides when both are readable', () => {
    expect(sameServer(id({ sysid: '1' }), id({ sysid: '1' }), 'a:1', 'b:2').same).toBe(true);
    expect(sameServer(id({ sysid: '1' }), id({ sysid: '2' }), 'a:1', 'a:1').same).toBe(false);
  });
  it('then address, port and data directory together', () => {
    const a = { addr: '172.17.0.2', port: 5432, dataDir: '/var/lib/postgresql/data' };
    expect(sameServer(a, { ...a }, 'x:1', 'y:2').same).toBe(true);
    expect(sameServer(a, { ...a, addr: '172.17.0.3' }, 'x:1', 'x:1').same).toBe(false);
  });
  it('else only an identical host and port will do', () => {
    expect(sameServer({}, {}, '127.0.0.1:5432', '127.0.0.1:5432').same).toBe(true);
    // localhost and 127.0.0.1 are not assumed to be the same machine
    expect(sameServer({}, {}, 'localhost:5432', '127.0.0.1:5432').same).toBe(false);
    expect(sameServer({}, {}, '127.0.0.1:5432', '127.0.0.1:5433').same).toBe(false);
    expect(sameServer({}, {}, 'db.example.com:5432', '127.0.0.1:5432').same).toBe(false);
  });
  it('only the system identifier or the data directory PROVE it; host and port do not', () => {
    expect(sameServer({ sysid: '1' }, { sysid: '1' }, 'a:1', 'b:2').proven).toBe(true);
    const a = { addr: '172.17.0.2', port: 5432, dataDir: '/var/lib/postgresql/data' };
    expect(sameServer(a, { ...a }, 'x:1', 'y:2').proven).toBe(true);
    const r = sameServer({}, {}, '127.0.0.1:5432', '127.0.0.1:5432');
    expect(r.same).toBe(true);
    expect(r.proven).toBe(false);
  });
});

describe('G: visible()', () => {
  it('writes out line separators and zero-width characters', () => {
    expect(visible('a b c​d‌e‍f﻿g')).toBe('a\\u2028b\\u2029c\\u200bd\\u200ce\\u200df\\ufeffg');
    expect(visible('\u001b[31mx')).toBe('\\x1b[31mx');
  });
  it('sanitizeModel writes out names but keeps the line breaks of multi-line fields', () => {
    const m = { database: 'a\u001bb', couldNotCheck: 'line1\nline2\u001b', policies: [{ name: 'p\nq' }], notes: ['n '] } as unknown as RunModel;
    const c = sanitizeModel(m) as unknown as { database: string; couldNotCheck: string; policies: { name: string }[]; notes: string[] };
    expect(c.database).toBe('a\\x1bb');
    expect(c.couldNotCheck).toBe('line1\nline2\\x1b');
    expect(c.policies[0].name).toBe('p\\nq');
    expect(c.notes[0]).toBe('n\\u2028');
  });
});

describe('H1: option values', () => {
  it.each(['abc', '', '-1', '101', 'NaN', 'Infinity'])('--threshold %j is refused', (v) => expect(() => parsePercent(v, '--threshold')).toThrow(/--threshold/));
  it('accepts 0, 95.5 and 100', () => {
    expect([parsePercent('0', 't'), parsePercent('95.5', 't'), parsePercent('100', 't')]).toEqual([0, 95.5, 100]);
  });
  it.each(['0', '-1', '1.5', 'abc', '', 'Infinity'])('--jobs %j is refused', (v) => expect(() => parseJobs(v)).toThrow(/--jobs/));
  it('accepts a whole number of 1 or more', () => expect(parseJobs('4')).toBe(4));
  it.each(['0', '-5', 'x', ''])('--timeout %j is refused', (v) => expect(() => parseSeconds(v)).toThrow(/--timeout/));
  it('parses sizes in binary units', () => {
    expect(parseSize('2GB')).toBe(2 * 1024 ** 3);
    expect(parseSize('500 MB')).toBe(500 * 1024 ** 2);
    expect(parseSize('1024')).toBe(1024);
    expect(() => parseSize('big')).toThrow(/--max-size/);
    expect(() => parseSize('5XB')).toThrow();
  });
});

describe('H1: a run that decided nothing is not a pass', () => {
  const model = (o: Partial<RunModel>): RunModel =>
    ({ database: 'd', databaseSource: 's', testsDescription: 't', schemas: ['public'], policyCount: 3, tableCount: 1, isolation: 'template', notes: [],
       results: [], findings: [], unparsed: [], policies: [], threshold: 100, jobs: 1, durationMs: 0, ...o }) as RunModel;
  const r = (outcome: string) => ({ brk: { id: 'x' } as never, outcome: outcome as never, ms: 0 });
  it('every break errored: exit 2, not 0', () => {
    expect(exitCode(model({ results: [r('error'), r('error')] }))).toBe(2);
  });
  it('every break skipped: exit 2', () => {
    expect(exitCode(model({ results: [r('skipped')] }))).toBe(2);
  });
  it('checks-only and a database with no policies are unaffected', () => {
    expect(exitCode(model({ checksOnly: true }))).toBe(0);
    expect(exitCode(model({ policyCount: 0 }))).toBe(0);
  });
});

describe('6: --runner is checked', () => {
  it('accepts auto, supabase, psql and no value', () => {
    expect([undefined, 'auto', 'supabase', 'psql'].map((r) => parseRunner(r))).toEqual(['auto', 'auto', 'supabase', 'psql']);
  });
  it('rejects anything else, naming the allowed values', () => {
    expect(() => parseRunner('bogus')).toThrow(/auto, supabase, psql/);
    expect(() => parseRunner('')).toThrow(/--runner/);
    expect(() => parseRunner('PSQL')).toThrow(/--runner/);
  });
});
