import { beforeEach, describe, expect, it, vi } from 'vitest';

// A fake pg.Client. It records every statement that is really sent, and answers a few catalogue lookups.
const sent: string[] = [];
const mockWhere: { value: string | null } = { value: null };
const config: { label: string | null | 'absent'; labels: { datname: string; label: string | null }[] } = { label: null, labels: [] };
vi.mock('pg', () => {
  class Client {
    constructor(public cfg: unknown) {}
    on() {}
    async connect() {}
    async end() {}
    async query(sql: string) {
      if (/^select current_database\(\) as d$/.test(sql)) {
        return { rows: [{ d: mockWhere.value ?? decodeURIComponent(new URL((this.cfg as { connectionString: string }).connectionString).pathname.slice(1)) }], rowCount: 1 };
      }
      sent.push(sql);
      if (/^show default_transaction_read_only/.test(sql)) return { rows: [{ default_transaction_read_only: 'on' }], rowCount: 1 };
      if (/shobj_description\(oid, 'pg_database'\) as c from/.test(sql)) {
        return config.label === 'absent' ? { rows: [], rowCount: 0 } : { rows: [{ c: config.label }], rowCount: 1 };
      }
      if (/shobj_description\(oid, 'pg_database'\) as label/.test(sql)) return { rows: config.labels, rowCount: config.labels.length };
      return { rows: [], rowCount: 0 };
    }
  }
  return { default: { Client } };
});

import { CANCEL_SQL, Guard, GuardError, LABEL_PREFIX, TERMINATE_SQL, copyNameFor, droppable, hostId, hostIdFrom, isReadOnlySql, labelFor, parseCopyName, sourceNameProblem } from '../src/guard.js';
import { sweepStale } from '../src/isolation.js';

const src = 'postgres://postgres:postgres@127.0.0.1:55322/appdb';
const adminUrl = 'postgres://postgres:postgres@127.0.0.1:55322/template1';
const real = () => sent.filter((s) => !/^show default_transaction_read_only/.test(s));

beforeEach(() => {
  sent.length = 0;
  config.label = null;
  config.labels = [];
});

describe('guard: the source database is read-only', () => {
  it.each([
    'drop policy "p" on "public"."t"',
    'alter database appdb with allow_connections false',
    'alter table t disable row level security',
    'insert into t values (1)',
    'update t set a = 1',
    'create extension pgtap',
    'select 1; drop table t',
    'with x as (delete from t returning *) select * from x',
    'select * into newt from t',
    'select pg_terminate_backend(pid) from pg_stat_activity',
    "select set_config('x','y',false)",
    'set default_transaction_read_only = off',
    'select $f$ x $f$'
  ])('a write on a source connection throws before it is sent: %s', async (sql) => {
    const g = new Guard({ sourceUrl: src, allowTerminate: true });
    const c = await g.connect(src);
    await expect(c.query(sql)).rejects.toThrow(GuardError);
    expect(real()).toHaveLength(0);
  });

  it('plain reads pass', async () => {
    const g = new Guard({ sourceUrl: src, allowTerminate: false });
    const c = await g.connect(src);
    await c.query('select 1');
    await c.query('-- note\nwith a as (select 1) select * from a;');
    expect(real()).toHaveLength(2);
    expect(isReadOnlySql("select 'delete from t'")).toBe(true);
  });

  it('a database that is not a labelled copy is treated as the source, whatever its name', async () => {
    const g = new Guard({ sourceUrl: src, allowTerminate: false });
    const other = await g.connect('postgres://postgres:postgres@127.0.0.1:55322/some_other_db');
    await expect(other.query('create table t (a int)')).rejects.toThrow(GuardError);
    const lookalike = await g.connect('postgres://postgres:postgres@127.0.0.1:55322/saboteur_1_1');
    await expect(lookalike.query('create table t (a int)')).rejects.toThrow(GuardError);
  });
});

describe('guard: the admin connection', () => {
  const admin = async (g: Guard) => g.connect(adminUrl);

  it('refuses to drop a name that is not prefixed, or is the source', async () => {
    const g = new Guard({ sourceUrl: src, allowTerminate: false });
    const a = await admin(g);
    config.label = labelFor(g.token);
    await expect(a.query('drop database if exists "production" with (force)')).rejects.toThrow(GuardError);
    await expect(a.query('drop database if exists "appdb" with (force)')).rejects.toThrow(GuardError);
    const s2 = new Guard({ sourceUrl: 'postgres://u:p@127.0.0.1:1/saboteur_5_1', allowTerminate: false });
    const a2 = await s2.connect(adminUrl);
    await expect(a2.query('drop database if exists "saboteur_5_1" with (force)')).rejects.toThrow(GuardError);
    expect(real().filter((s) => /^drop/i.test(s))).toHaveLength(0);
  });

  it('refuses to drop a prefixed database that has no label', async () => {
    const g = new Guard({ sourceUrl: src, allowTerminate: false });
    const a = await admin(g);
    config.label = null;
    await expect(a.query('drop database if exists "saboteur_1_9" with (force)')).rejects.toThrow(/no rls-saboteur label/);
    expect(real().filter((s) => /^drop/i.test(s))).toHaveLength(0);
  });

  it('refuses a label from another run whose process is alive', async () => {
    const g = new Guard({ sourceUrl: src, allowTerminate: false });
    const a = await admin(g);
    config.label = labelFor('some-other-token');
    await expect(a.query(`drop database if exists "saboteur_${process.pid}_3" with (force)`)).rejects.toThrow(GuardError);
  });

  it('drops a copy labelled by this run', async () => {
    const g = new Guard({ sourceUrl: src, allowTerminate: false });
    const a = await admin(g);
    config.label = labelFor(g.token);
    await a.query(`drop database if exists "saboteur_${process.pid}_3" with (force)`);
    expect(real().filter((s) => /^drop/i.test(s))).toHaveLength(1);
  });

  it('refuses anything else, including changing the source database', async () => {
    const g = new Guard({ sourceUrl: src, allowTerminate: true });
    const a = await admin(g);
    for (const sql of [
      'alter database "appdb" with allow_connections false',
      'drop database "appdb"',
      'create database "saboteur_1_tpl" template "other"',
      'create database "production" template "appdb"',
      `comment on database "appdb" is '${labelFor(g.token)}'`,
      `comment on database "saboteur_1_tpl" is 'something else'`,
      'create role evil superuser'
    ]) {
      await expect(a.query(sql)).rejects.toThrow(GuardError);
    }
    expect(real()).toHaveLength(0);
  });

  it('refuses to close sessions when terminating is not allowed (the remote flag)', async () => {
    const g = new Guard({ sourceUrl: src, allowTerminate: false });
    const a = await admin(g);
    await expect(a.query(TERMINATE_SQL, ['appdb'])).rejects.toThrow(/not allowed/);
    expect(real()).toHaveLength(0);
    const ok = new Guard({ sourceUrl: src, allowTerminate: true });
    await (await ok.connect(adminUrl)).query(TERMINATE_SQL, ['appdb']);
    expect(real()).toHaveLength(1);
  });

  it('sweep drops only labelled copies whose process is dead', async () => {
    const g = new Guard({ sourceUrl: src, allowTerminate: false });
    const a = await admin(g);
    config.labels = [
      { datname: 'saboteur_999999_1', label: labelFor('old') }, // dead pid, labelled: dropped
      { datname: 'saboteur_999998_1', label: null }, // dead pid, unlabelled: kept
      { datname: 'saboteur_999997_1', label: 'someone elses comment' }, // wrong label: kept
      { datname: `saboteur_${process.pid}_1`, label: labelFor('old') }, // live pid: kept
      { datname: 'saboteur_notes', label: labelFor('old') } // not our name pattern: kept
    ];
    config.label = labelFor('old');
    expect(await sweepStale(a)).toBe(1);
    const drops = real().filter((s) => /^drop/i.test(s));
    expect(drops).toEqual(['drop database if exists "saboteur_999999_1" with (force)']);
  });
});

describe('droppable (the one rule behind every drop)', () => {
  it('rejects the source, unprefixed names and missing labels', () => {
    expect(droppable('appdb', labelFor('t'), 'appdb', 't').ok).toBe(false);
    expect(droppable('saboteur_1_1', labelFor('t'), 'saboteur_1_1', 't').ok).toBe(false);
    expect(droppable('prod', labelFor('t'), 'appdb', 't').ok).toBe(false);
    expect(droppable('saboteur_1_1', null, 'appdb', 't').ok).toBe(false);
    expect(droppable('saboteur_1_1', labelFor('t'), 'appdb', 't').ok).toBe(true);
    expect(droppable('saboteur_1_1', labelFor('x'), 'appdb', 't', () => false).ok).toBe(true);
    expect(droppable('saboteur_1_1', labelFor('x'), 'appdb', 't', () => true).ok).toBe(false);
  });
});

describe('F: a pid is only judged on the host that owns it', () => {
  it('a copy labelled by another host is never swept, even with a dead pid', async () => {
    const a = await new Guard({ sourceUrl: src, allowTerminate: false }).connect(adminUrl);
    config.labels = [
      { datname: 'saboteur_999999_1', label: `${LABEL_PREFIX}old host=someoneelse00` }, // other host: kept
      { datname: 'saboteur_999998_1', label: `${LABEL_PREFIX}old` }, // no host id (older version): kept
      { datname: 'saboteur_999997_1', label: labelFor('old') } // this host, dead pid: dropped
    ];
    config.label = labelFor('old');
    expect(await sweepStale(a)).toBe(1);
    expect(real().filter((q) => q.startsWith('drop database'))).toEqual(['drop database if exists "saboteur_999997_1" with (force)']);
  });
  it('droppable refuses a dead pid from another host, and accepts the same host', () => {
    expect(droppable('saboteur_1_1', `${LABEL_PREFIX}x host=other0000000`, 'appdb', 't', () => false).ok).toBe(false);
    expect(droppable('saboteur_1_1', `${LABEL_PREFIX}x host=${hostId()}`, 'appdb', 't', () => false).ok).toBe(true);
  });
});

describe('A: every connection must land on the database it names', () => {
  it('throws when the server says the session is on another database', async () => {
    const g = new Guard({ sourceUrl: src, allowTerminate: false });
    mockWhere.value = 'some_other_database';
    try {
      await expect(g.connect(src)).rejects.toThrow(/landed on "some_other_database"/);
    } finally {
      mockWhere.value = null;
    }
  });
});

describe('1a: the identity of a copy is in its NAME, so a missing label does not hide it', () => {
  const me = hostId();
  const other = 'ffffffffffff';
  const tok = 'a'.repeat(16);
  it('names stay within the 63 byte limit for a 10 digit pid and a large copy counter', () => {
    expect(copyNameFor(me, 4294967295, tok, 'tpl').length).toBeLessThanOrEqual(63);
    expect(copyNameFor(me, 4294967295, tok, 999999).length).toBeLessThanOrEqual(63);
    expect(hostId()).toMatch(/^[0-9a-f]{12}$/);
  });
  it('the host id changes with the pid namespace, so two containers with one kernel and one hostname differ', () => {
    expect(hostIdFrom('h', 'boot', 'pid:[4026531836]')).not.toBe(hostIdFrom('h', 'boot', 'pid:[4026532999]'));
    expect(hostIdFrom('h', 'boot', 'pid:[1]')).toBe(hostIdFrom('h', 'boot', 'pid:[1]'));
    expect(hostIdFrom('h', 'boot', '')).not.toBe(hostIdFrom('h2', 'boot', ''));
  });
  it('parses its own names and nothing else', () => {
    expect(parseCopyName(copyNameFor(me, 77, tok, 3))).toEqual({ host: me, pid: 77, token: tok, suffix: '3' });
    for (const n of ['saboteur_123_tpl', 'saboteur_notes', 'postgres', `saboteur_${me}_77_${tok}_x`, `saboteur_${me}_77_${tok}`]) expect(parseCopyName(n)).toBeNull();
  });
  it('an UNLABELLED copy of this run is droppable; of a dead process of this host is droppable', () => {
    const mine = copyNameFor(me, process.pid, tok, 'tpl');
    expect(droppable(mine, null, 'appdb', tok).ok).toBe(true);
    const dead = copyNameFor(me, 2147480000, 'b'.repeat(16), 1);
    expect(droppable(dead, null, 'appdb', tok, () => false).ok).toBe(true);
  });
  it('is refused when the pid is alive, the host differs, it is the source, or label and name disagree', () => {
    const live = copyNameFor(me, 2147480000, 'b'.repeat(16), 1);
    expect(droppable(live, null, 'appdb', tok, () => true).ok).toBe(false);
    const foreign = copyNameFor(other, 2147480000, 'b'.repeat(16), 1);
    expect(droppable(foreign, null, 'appdb', tok, () => false).ok).toBe(false);
    expect(droppable(foreign, labelFor('b'.repeat(16)), 'appdb', tok, () => false).ok).toBe(false);
    expect(droppable(live, null, live, tok, () => false).ok).toBe(false);
    expect(droppable(live, labelFor('c'.repeat(16)), 'appdb', tok, () => false).ok).toBe(false);
    expect(droppable(live, `${LABEL_PREFIX}${'b'.repeat(16)} host=${other}`, 'appdb', tok, () => false).ok).toBe(false);
  });
  it('the sweep drops an unlabelled dead copy of this host and leaves a live or foreign one', async () => {
    const a = await new Guard({ sourceUrl: src, allowTerminate: false }).connect(adminUrl);
    const dead = copyNameFor(me, 2147480000, 'b'.repeat(16), 1);
    config.labels = [
      { datname: dead, label: null }, // this host, dead pid, no label: dropped
      { datname: copyNameFor(other, 2147480001, 'b'.repeat(16), 1), label: null }, // other host: kept
      { datname: copyNameFor(me, process.pid, 'b'.repeat(16), 1), label: null } // live pid: kept
    ];
    config.label = null;
    expect(await sweepStale(a, 'appdb', 'x'.repeat(16))).toBe(1);
    expect(real().filter((q) => q.startsWith('drop database'))).toEqual([`drop database if exists "${dead}" with (force)`]);
  });
  it('a database that is not the source but wears a saboteur name is refused as a source', () => {
    expect(sourceNameProblem(copyNameFor(me, 1, tok, 'tpl'))).toMatch(/name of a copy/);
    expect(sourceNameProblem('saboteur_123_tpl')).toMatch(/name of a copy/);
    expect(sourceNameProblem('appdb')).toBeNull();
    expect(sourceNameProblem('saboteur_notes')).toBeNull();
  });
  it('the guard only creates and labels names that belong to this run', async () => {
    const g = new Guard({ sourceUrl: src, allowTerminate: false });
    const a = await g.connect(adminUrl);
    await expect(a.query(`create database "saboteur_1_tpl" template "appdb"`)).rejects.toThrow(/not a name of this run/);
    await expect(a.query(`create database "${copyNameFor(me, process.pid, 'b'.repeat(16), 'tpl')}" template "appdb"`)).rejects.toThrow(/not a name of this run/);
    await expect(a.query(`create database "${g.masterName()}" template "other"`)).rejects.toThrow(/may not be copied/);
    await a.query(`create database "${g.masterName()}" template "appdb"`);
    await expect(a.query(`comment on database "saboteur_1_tpl" is '${labelFor(g.token)}'`)).rejects.toThrow(GuardError);
  });
});

describe('1b: pg_cancel_backend is allowed only for the backend running our own CREATE', () => {
  it('refuses any other pid, and any other cancel statement', async () => {
    const g = new Guard({ sourceUrl: src, allowTerminate: false });
    const a = await g.connect(adminUrl);
    await expect(a.query(CANCEL_SQL, [4242])).rejects.toThrow(/own CREATE DATABASE/);
    await expect(a.query('select pg_cancel_backend(pid) from pg_stat_activity')).rejects.toThrow(GuardError);
    await expect(a.query(CANCEL_SQL, [])).rejects.toThrow(GuardError);
    expect(real().filter((q) => /pg_cancel_backend/.test(q))).toHaveLength(0);
  });
});

describe('4: closing sessions only on the source database, and never once denied', () => {
  it('the session-closing statement is refused for any database but the source', async () => {
    const g = new Guard({ sourceUrl: src, allowTerminate: true });
    const a = await g.connect(adminUrl);
    await expect(a.query(TERMINATE_SQL, ['production'])).rejects.toThrow(/only be closed on the source/);
    await expect(a.query(TERMINATE_SQL, [])).rejects.toThrow(GuardError);
    await expect(a.query(TERMINATE_SQL, ['appdb', 'x'])).rejects.toThrow(GuardError);
    expect(real().filter((q) => /pg_terminate_backend/.test(q))).toHaveLength(0);
    await a.query(TERMINATE_SQL, ['appdb']);
    expect(real().filter((q) => /pg_terminate_backend/.test(q))).toHaveLength(1);
  });
  it('denyTerminate switches closing off with the given reason, and it stays off', async () => {
    const g = new Guard({ sourceUrl: src, allowTerminate: true });
    g.denyTerminate('the admin URL is not proven to be the same server');
    const a = await g.connect(adminUrl);
    await expect(a.query(TERMINATE_SQL, ['appdb'])).rejects.toThrow(/not proven to be the same server/);
    expect(real()).toHaveLength(0);
  });
});
