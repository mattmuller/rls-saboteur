import { beforeEach, describe, expect, it, vi } from 'vitest';

// A fake pg.Client that behaves like a busy database: copying the source fails with 55006,
// the role cannot terminate other sessions, and every statement is recorded.
const queries: string[] = [];
vi.mock('pg', () => {
  class Client {
    on() {}
    async connect() {}
    async end() {}
    async query(sql: string) {
      queries.push(sql);
      if (/^create database/i.test(sql)) throw Object.assign(new Error('source database is being accessed by other users'), { code: '55006' });
      if (/count\(\*\)::int as n/.test(sql)) return { rows: [{ n: 2 }] };
      // pg_terminate_backend is filtered to sessions this role may signal: it closes none of them.
      return { rows: [] };
    }
  }
  return { default: { Client } };
});

import { createIsolation } from '../src/isolation.js';
import type { Break } from '../src/types.js';

const brk: Break = {
  id: 'public.t/p/drop-policy', kind: 'drop-policy', schema: 'public', table: 't', policy: 'p',
  label: 'policy dropped', effect: '', apply: ['drop policy "p" on "public"."t"'], restore: ['create policy "p" on "public"."t"']
};
const url = 'postgres://postgres:postgres@127.0.0.1:55322/postgres';
const applied = () => queries.filter((q) => q.startsWith('drop policy'));

beforeEach(() => {
  queries.length = 0;
});

describe('in-place mode is never a silent fallback', () => {
  it.each(['auto', 'template'] as const)('mode %s on a busy database stops and names both fixes', async (mode) => {
    await expect(createIsolation({ sourceUrl: url, mode, terminate: true })).rejects.toThrow(/--admin-url[\s\S]*--isolation in-place/);
    expect(applied()).toHaveLength(0);
  });

  it('stops with --no-terminate too, and applies nothing', async () => {
    await expect(createIsolation({ sourceUrl: url, mode: 'auto', terminate: false })).rejects.toThrow(/--isolation in-place/);
    expect(applied()).toHaveLength(0);
  });

  it('runs in place only when asked, applies the break, then restores it', async () => {
    const iso = await createIsolation({ sourceUrl: url, mode: 'in-place', terminate: true });
    expect(iso.mode).toBe('in-place');
    await iso.withBreak(brk, async () => {
      expect(applied()).toHaveLength(1);
    });
    expect(queries).toContain(brk.restore[0]);
    await iso.dispose();
  });
});
