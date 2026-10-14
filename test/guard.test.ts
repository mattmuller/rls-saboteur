import { beforeEach, describe, expect, it, vi } from 'vitest';

// A fake pg.Client. It records every statement that is really sent, and answers a few catalogue lookups.
const sent: string[] = [];
const config: { label: string | null | 'absent'; labels: { datname: string; label: string | null }[] } = { label: null, labels: [] };
vi.mock('pg', () => {
  class Client {
    constructor(public cfg: unknown) {}
    on() {}
    async connect() {}
    async end() {}
    async query(sql: string) {
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

import { Guard, GuardError, LABEL_PREFIX, TERMINATE_SQL, droppable, isReadOnlySql } from '../src/guard.js';
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
    config.label = LABEL_PREFIX + g.token;
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
    config.label = LABEL_PREFIX + 'some-other-token';
    await expect(a.query(`drop database if exists "saboteur_${process.pid}_3" with (force)`)).rejects.toThrow(GuardError);
  });

  it('drops a copy labelled by this run', async () => {
    const g = new Guard({ sourceUrl: src, allowTerminate: false });
    const a = await admin(g);
    config.label = LABEL_PREFIX + g.token;
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
      `comment on database "appdb" is '${LABEL_PREFIX}${g.token}'`,
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
      { datname: 'saboteur_999999_1', label: LABEL_PREFIX + 'old' }, // dead pid, labelled: dropped
      { datname: 'saboteur_999998_1', label: null }, // dead pid, unlabelled: kept
      { datname: 'saboteur_999997_1', label: 'someone elses comment' }, // wrong label: kept
      { datname: `saboteur_${process.pid}_1`, label: LABEL_PREFIX + 'old' }, // live pid: kept
      { datname: 'saboteur_notes', label: LABEL_PREFIX + 'old' } // not our name pattern: kept
    ];
    config.label = LABEL_PREFIX + 'old';
    expect(await sweepStale(a)).toBe(1);
    const drops = real().filter((s) => /^drop/i.test(s));
    expect(drops).toEqual(['drop database if exists "saboteur_999999_1" with (force)']);
  });
});

describe('droppable (the one rule behind every drop)', () => {
  it('rejects the source, unprefixed names and missing labels', () => {
    expect(droppable('appdb', LABEL_PREFIX + 't', 'appdb', 't').ok).toBe(false);
    expect(droppable('saboteur_1_1', LABEL_PREFIX + 't', 'saboteur_1_1', 't').ok).toBe(false);
    expect(droppable('prod', LABEL_PREFIX + 't', 'appdb', 't').ok).toBe(false);
    expect(droppable('saboteur_1_1', null, 'appdb', 't').ok).toBe(false);
    expect(droppable('saboteur_1_1', LABEL_PREFIX + 't', 'appdb', 't').ok).toBe(true);
    expect(droppable('saboteur_1_1', LABEL_PREFIX + 'x', 'appdb', 't', () => false).ok).toBe(true);
    expect(droppable('saboteur_1_1', LABEL_PREFIX + 'x', 'appdb', 't', () => true).ok).toBe(false);
  });
});
