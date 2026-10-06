import { describe, expect, it } from 'vitest';
import { conjunctTexts, findUidComparisons, generateBreaks, parenBalance } from '../src/breaks.js';
import type { Catalogue, Policy } from '../src/types.js';

const policy = (over: Partial<Policy>): Policy => ({
  schema: 'public',
  table: 'documents',
  name: 'p',
  cmd: 'SELECT',
  permissive: true,
  roles: ['authenticated'],
  qual: null,
  withCheck: null,
  ...over
});

const cols = (table: string, names: [string, string][]) =>
  names.map(([column, type]) => ({ schema: 'public', table, column, type }));

const cat = (policies: Policy[], extra: Partial<Catalogue> = {}): Catalogue => ({
  policies,
  tables: [{ schema: 'public', table: 'documents', rlsEnabled: true, rlsForced: false }],
  columns: [
    ...cols('documents', [
      ['id', 'uuid'],
      ['org_id', 'uuid'],
      ['author_id', 'uuid'],
      ['title', 'text']
    ]),
    ...cols('members', [
      ['org_id', 'uuid'],
      ['user_id', 'uuid']
    ])
  ],
  ...extra
});

const kinds = (c: Catalogue) => generateBreaks(c).breaks.map((b) => b.kind);

describe('parenBalance', () => {
  it('ignores parentheses in quoted text', () => {
    expect(parenBalance("(a = ')')")).toBe(0);
    expect(parenBalance('(a')).toBe(1);
  });
});

describe('conjunctTexts', () => {
  it('splits a top-level AND chain and keeps subqueries whole', () => {
    const expr =
      "((org_id IN ( SELECT members.org_id FROM members WHERE (members.user_id = ( SELECT auth.uid() AS uid)))) AND (author_id = auth.uid()) AND ((title = 'a'::text) OR (title = 'b'::text)))";
    const parts = conjunctTexts(expr)!;
    expect(parts).toHaveLength(3);
    expect(parts[0]).toContain('SELECT auth.uid() AS uid)))');
    expect(parts[1]).toBe('author_id = auth.uid()');
    expect(parts[2]).toContain('OR');
  });
  it('returns one part for an expression without AND', () => {
    expect(conjunctTexts('(author_id = auth.uid())')).toHaveLength(1);
  });
  it('returns null for text the parser cannot read', () => {
    expect(conjunctTexts('this is ((( not sql')).toBeNull();
  });
});

describe('generateBreaks', () => {
  it('makes drop and USING true for a plain SELECT policy', () => {
    expect(kinds(cat([policy({ qual: '(author_id = auth.uid())' })]))).toEqual([
      'drop-policy',
      'using-true',
      'column-swapped',
      'rls-disabled'
    ]);
  });

  it('makes no USING break for an INSERT policy, and a WITH CHECK break instead', () => {
    const b = generateBreaks(cat([policy({ cmd: 'INSERT', withCheck: '(author_id = auth.uid())' })])).breaks;
    expect(b.map((x) => x.kind)).toContain('check-removed');
    expect(b.map((x) => x.kind)).not.toContain('using-true');
  });

  it('makes one conjunct break per condition', () => {
    const b = generateBreaks(cat([policy({ cmd: 'UPDATE', qual: '((title = \'a\'::text) AND (archived_at IS NULL))' })])).breaks;
    const conj = b.filter((x) => x.kind === 'conjunct-removed');
    expect(conj).toHaveLength(2);
    expect(conj[0].apply[0]).toContain("using ((archived_at IS NULL))");
    expect(conj[1].apply[0]).toContain("using ((title = 'a'::text))");
  });

  it('does not split on OR', () => {
    const b = generateBreaks(cat([policy({ qual: "((title = 'a'::text) OR (title = 'b'::text))" })])).breaks;
    expect(b.filter((x) => x.kind === 'conjunct-removed')).toHaveLength(0);
  });

  it('swaps the column compared with auth.uid() for another column of the same type', () => {
    const b = generateBreaks(cat([policy({ qual: '(author_id = auth.uid())' })])).breaks.filter((x) => x.kind === 'column-swapped');
    expect(b).toHaveLength(1);
    expect(b[0].apply[0]).toContain('using (("org_id" = auth.uid()))');
  });

  it('handles the cached ( SELECT auth.uid() AS uid) form', () => {
    const found = findUidComparisons('(author_id = ( SELECT auth.uid() AS uid))', 'public', 'documents');
    expect(found.map((f) => f.column)).toEqual(['author_id']);
  });

  it('looks up columns of the subquery table, not the policy table', () => {
    const b = generateBreaks(
      cat([policy({ qual: '(org_id IN ( SELECT members.org_id FROM members WHERE (members.user_id = auth.uid())))' })])
    ).breaks.filter((x) => x.kind === 'column-swapped');
    expect(b).toHaveLength(1);
    expect(b[0].apply[0]).toContain('members."org_id" = auth.uid()');
  });

  it('skips the swap when no other column has the same type', () => {
    const c = cat([policy({ qual: '(title = auth.uid())' })]);
    expect(kinds(c)).not.toContain('column-swapped');
  });

  it('turns restrictive into permissive by recreating the policy', () => {
    const b = generateBreaks(cat([policy({ permissive: false, qual: '(archived = false)' })])).breaks.find(
      (x) => x.kind === 'restrictive-to-permissive'
    )!;
    expect(b.apply[0]).toMatch(/^drop policy/);
    expect(b.apply[1]).toContain('as permissive for select to "authenticated" using ((archived = false))');
    expect(b.restore[1]).toContain('as restrictive');
  });

  it('adds one RLS-disabled break per table that has policies', () => {
    const c = cat([policy({ qual: '(true)' }), policy({ name: 'q', qual: '(author_id = auth.uid())' })]);
    expect(kinds(c).filter((k) => k === 'rls-disabled')).toHaveLength(1);
  });

  it('records unparsed expressions instead of crashing', () => {
    const r = generateBreaks(cat([policy({ qual: 'this is ((( not sql' })]));
    expect(r.unparsed).toHaveLength(1);
    expect(r.breaks.map((b) => b.kind)).toContain('drop-policy');
  });

  it('every break carries a restore', () => {
    const c = cat([
      policy({ qual: '(author_id = auth.uid())' }),
      policy({ name: 'r', cmd: 'UPDATE', qual: '(a = 1) AND (b = 2)', withCheck: '(a = 1) AND (b = 2)' })
    ]);
    for (const b of generateBreaks(c).breaks) expect(b.restore.length).toBeGreaterThan(0);
  });
});
