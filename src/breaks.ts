import { parse } from 'pgsql-ast-parser';
import { qi, qt } from './sql.js';
import type { Break, Catalogue, Policy } from './types.js';

/**
 * Break generator.
 *
 * Expressions come from pg_get_expr, so they are Postgres's own rendering of the
 * policy. They are parsed with pgsql-ast-parser (a real SQL parser, no regexes).
 * Changes are made by slicing the ORIGINAL text at the parser's source locations,
 * never by printing the AST back. Printing can reformat or drop constructs.
 * The parser's end offsets can sit before closing parentheses, so a slice is
 * widened until its parentheses balance. The result is parsed again as a check.
 */

type Node = Record<string, any>;

export interface GenerateResult {
  breaks: Break[];
  /** Policies whose expression the parser could not read. Their expression-level breaks are skipped. */
  unparsed: { policy: string; table: string; reason: string }[];
}

const CMD_VERB: Record<string, string> = {
  SELECT: 'reads',
  INSERT: 'inserts',
  UPDATE: 'updates',
  DELETE: 'deletes',
  ALL: 'reads and writes'
};

function who(p: Policy): string {
  return p.roles.length ? p.roles.join(', ') : 'any role';
}

function parseExpr(text: string): Node | null {
  try {
    const r = parse(text, { entry: 'expr', locationTracking: true } as any) as unknown as Node[];
    return r.length === 1 ? r[0] : null;
  } catch {
    return null;
  }
}

/** Balance of ( and ) in a string, ignoring quoted text. Returns open minus close. */
export function parenBalance(s: string): number {
  let bal = 0;
  let quote: string | null = null;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quote) {
      if (ch === quote) {
        if (s[i + 1] === quote) i++;
        else quote = null;
      }
      continue;
    }
    if (ch === "'" || ch === '"') quote = ch;
    else if (ch === '(') bal++;
    else if (ch === ')') bal--;
  }
  return bal;
}

/** Locate a node: its own location, or the span of everything beneath it. */
function span(node: Node): { start: number; end: number } | null {
  let start = Infinity;
  let end = -Infinity;
  const visit = (n: unknown): void => {
    if (!n || typeof n !== 'object') return;
    if (Array.isArray(n)) return n.forEach(visit);
    const loc = (n as Node)._location;
    if (loc) {
      start = Math.min(start, loc.start);
      end = Math.max(end, loc.end);
    }
    for (const [k, v] of Object.entries(n)) if (k !== '_location') visit(v);
  };
  visit(node);
  return start === Infinity ? null : { start, end };
}

/** Widen a slice outwards until its parentheses balance. Null when it cannot. */
function balancedSlice(src: string, start: number, end: number): string | null {
  let s = start;
  let e = end;
  for (let guard = 0; guard < 64; guard++) {
    const bal = parenBalance(src.slice(s, e));
    if (bal === 0) return src.slice(s, e).trim();
    if (bal > 0) {
      // more "(" than ")": the end stopped short of closing parens
      while (e < src.length && /\s/.test(src[e])) e++;
      if (src[e] !== ')') return null;
      e++;
    } else {
      while (s > 0 && /\s/.test(src[s - 1])) s--;
      if (src[s - 1] !== '(') return null;
      s--;
    }
  }
  return null;
}

/** Flatten a top-level chain of AND into its conjuncts. */
function conjunctsOf(node: Node): Node[] {
  if (node.type === 'binary' && node.op === 'AND') return [...conjunctsOf(node.left), ...conjunctsOf(node.right)];
  return [node];
}

export function conjunctTexts(expr: string): string[] | null {
  const ast = parseExpr(expr);
  if (!ast) return null;
  const out: string[] = [];
  for (const c of conjunctsOf(ast)) {
    const sp = span(c);
    if (!sp) return null;
    const text = balancedSlice(expr, sp.start, sp.end);
    if (!text) return null;
    out.push(text);
  }
  return out;
}

function isAuthUid(n: Node | undefined): boolean {
  if (!n) return false;
  if (n.type === 'call') return n.function?.name === 'uid' && n.function?.schema === 'auth';
  if (n.type === 'cast') return isAuthUid(n.operand);
  // pg_get_expr renders the cached form as ( SELECT auth.uid() AS uid)
  if (n.type === 'select' && !n.from && n.columns?.length === 1) return isAuthUid(n.columns[0].expr);
  return false;
}

function columnRef(n: Node | undefined): Node | null {
  if (!n) return null;
  if (n.type === 'ref' && n.name !== '*') return n;
  if (n.type === 'cast') return columnRef(n.operand);
  return null;
}

interface Scope {
  schema: string;
  table: string;
  alias?: string;
}

export interface UidComparison {
  /** Column name as written. */
  column: string;
  /** Source offsets of the whole reference (qualifier included). */
  start: number;
  end: number;
  qualifier: string | null;
  scope: Scope;
}

/** Find `<column> = auth.uid()` comparisons, tracking which table each column belongs to. */
export function findUidComparisons(expr: string, policySchema: string, policyTable: string): UidComparison[] {
  const ast = parseExpr(expr);
  if (!ast) return [];
  const found: UidComparison[] = [];
  const walk = (n: unknown, scope: Scope | null): void => {
    if (!n || typeof n !== 'object') return;
    if (Array.isArray(n)) return n.forEach((x) => walk(x, scope));
    const node = n as Node;
    let here = scope;
    if (node.type === 'select' && Array.isArray(node.from)) {
      if (node.from.length === 1 && node.from[0].type === 'table') {
        const t = node.from[0].name;
        here = { schema: t.schema ?? policySchema, table: t.name, alias: t.alias };
      } else here = null;
    }
    if (node.type === 'binary' && (node.op === '=' || node.op === '<>' || node.op === '!=')) {
      const pairs: [Node, Node][] = [
        [node.left, node.right],
        [node.right, node.left]
      ];
      for (const [colSide, uidSide] of pairs) {
        const ref = columnRef(colSide);
        if (ref && isAuthUid(uidSide) && here && ref._location) {
          const q: string | null = ref.table?.name ?? null;
          if (q === null || q === here.alias || q === here.table) {
            found.push({
              column: ref.name,
              start: ref._location.start,
              end: ref._location.end,
              qualifier: q,
              scope: here
            });
          }
        }
      }
    }
    for (const [k, v] of Object.entries(node)) if (k !== '_location') walk(v, here);
  };
  walk(ast, { schema: policySchema, table: policyTable });
  return found;
}

function createPolicySql(p: Policy, overrides: Partial<Pick<Policy, 'permissive' | 'qual' | 'withCheck'>> = {}): string {
  const permissive = overrides.permissive ?? p.permissive;
  const qual = 'qual' in overrides ? overrides.qual : p.qual;
  const check = 'withCheck' in overrides ? overrides.withCheck : p.withCheck;
  const roles = p.roles.length ? p.roles.map(qi).join(', ') : 'public';
  return (
    `create policy ${qi(p.name)} on ${qt(p.schema, p.table)} as ${permissive ? 'permissive' : 'restrictive'} ` +
    `for ${p.cmd.toLowerCase()} to ${roles}` +
    (qual ? ` using (${qual})` : '') +
    (check ? ` with check (${check})` : '')
  );
}

function alterSql(p: Policy, clause: 'using' | 'with check', expr: string): string {
  return `alter policy ${qi(p.name)} on ${qt(p.schema, p.table)} ${clause} (${expr})`;
}

function isTrue(expr: string | null): boolean {
  return expr !== null && expr.trim().toLowerCase() === 'true';
}

export function generateBreaks(cat: Catalogue): GenerateResult {
  const breaks: Break[] = [];
  const unparsed: GenerateResult['unparsed'] = [];

  for (const p of cat.policies) {
    const base = { schema: p.schema, table: p.table, policy: p.name };
    const idOf = (kind: string, extra = '') => `${p.schema}.${p.table}/${p.name}/${kind}${extra}`;
    const dropSql = `drop policy ${qi(p.name)} on ${qt(p.schema, p.table)}`;
    const recreate = createPolicySql(p);
    const verb = CMD_VERB[p.cmd];

    // 1. Drop the policy.
    breaks.push({
      ...base,
      id: idOf('drop-policy'),
      kind: 'drop-policy',
      label: 'policy dropped',
      effect: p.permissive
        ? `${who(p)} loses the access this policy granted`
        : `the restriction is gone, so ${who(p)} gets whatever the other policies allow`,
      apply: [dropSql],
      restore: [recreate]
    });

    // 2. USING becomes true.
    if (p.qual && p.cmd !== 'INSERT' && !isTrue(p.qual)) {
      breaks.push({
        ...base,
        id: idOf('using-true'),
        kind: 'using-true',
        label: 'USING replaced with true',
        effect: p.permissive
          ? `any ${who(p)} ${verb} every row in the table, whatever tenant it belongs to`
          : `the restriction no longer filters any row`,
        apply: [alterSql(p, 'using', 'true')],
        restore: [alterSql(p, 'using', p.qual)]
      });
    }

    // 3. WITH CHECK removed.
    if (p.withCheck && p.cmd !== 'SELECT' && p.cmd !== 'DELETE' && !isTrue(p.withCheck)) {
      breaks.push({
        ...base,
        id: idOf('check-removed'),
        kind: 'check-removed',
        label: 'WITH CHECK removed',
        effect: 'rows can be written that the policy would have rejected, for example into another tenant',
        apply: [alterSql(p, 'with check', 'true')],
        restore: [alterSql(p, 'with check', p.withCheck)]
      });
    }

    // 4 and 5 need the parser.
    for (const clause of ['using', 'with check'] as const) {
      const expr = clause === 'using' ? p.qual : p.withCheck;
      if (!expr || isTrue(expr)) continue;
      const clauseName = clause === 'using' ? 'USING' : 'WITH CHECK';
      const original = clause === 'using' ? p.qual! : p.withCheck!;

      const parts = conjunctTexts(expr);
      if (parts === null) {
        unparsed.push({ policy: p.name, table: `${p.schema}.${p.table}`, reason: `could not parse the ${clauseName} expression` });
      } else if (parts.length > 1) {
        parts.forEach((removed, i) => {
          const rest = parts.filter((_, j) => j !== i).map((c) => `(${c})`).join(' AND ');
          if (!parseExpr(rest)) return;
          breaks.push({
            ...base,
            id: idOf('conjunct-removed', `#${clause === 'using' ? 'u' : 'c'}${i + 1}`),
            kind: 'conjunct-removed',
            label: `${clauseName} condition removed: ${oneLine(removed)}`,
            effect: `rows that fail this condition now pass the policy`,
            apply: [alterSql(p, clause, rest)],
            restore: [alterSql(p, clause, original)]
          });
        });
      }

      if (parts !== null) {
        const colInfo = (schema: string, table: string) => cat.columns.filter((c) => c.schema === schema && c.table === table);
        for (const cmp of findUidComparisons(expr, p.schema, p.table)) {
          if (expr.slice(cmp.end - cmp.column.length, cmp.end) !== cmp.column) continue;
          const cols = colInfo(cmp.scope.schema, cmp.scope.table);
          const current = cols.find((c) => c.column === cmp.column);
          if (!current) continue;
          const sameType = cols.filter((c) => c.column !== cmp.column && c.type === current.type);
          // A foreign-key style column is the likelier real mistake than the primary key.
          const alt = sameType.find((c) => c.column !== 'id') ?? sameType[0];
          if (!alt) continue;
          const prefix = expr.slice(cmp.start, cmp.end - cmp.column.length);
          const swapped = expr.slice(0, cmp.start) + prefix + qi(alt.column) + expr.slice(cmp.end);
          if (!parseExpr(swapped)) continue;
          breaks.push({
            ...base,
            id: idOf('column-swapped', `#${clause === 'using' ? 'u' : 'c'}@${cmp.start}`),
            kind: 'column-swapped',
            label: `${clauseName}: auth.uid() compared with ${alt.column} instead of ${cmp.column}`,
            effect: `the ownership check looks at ${cmp.scope.table}.${alt.column}, the wrong field`,
            apply: [alterSql(p, clause, swapped)],
            restore: [alterSql(p, clause, original)]
          });
        }
      }
    }

    // 6. Restrictive becomes permissive.
    if (!p.permissive) {
      breaks.push({
        ...base,
        id: idOf('restrictive-to-permissive'),
        kind: 'restrictive-to-permissive',
        label: 'restrictive policy made permissive',
        effect: 'the policy now grants access instead of limiting it, because Postgres ORs permissive policies together',
        apply: [dropSql, createPolicySql(p, { permissive: true })],
        restore: [dropSql, recreate]
      });
    }
  }

  // 7. RLS switched off, once per table that has policies.
  const withPolicies = new Set(cat.policies.map((p) => `${p.schema}.${p.table}`));
  for (const t of cat.tables) {
    if (!t.rlsEnabled || !withPolicies.has(`${t.schema}.${t.table}`)) continue;
    breaks.push({
      id: `${t.schema}.${t.table}/-/rls-disabled`,
      kind: 'rls-disabled',
      schema: t.schema,
      table: t.table,
      policy: null,
      label: 'row level security disabled on the table',
      effect: 'every policy on the table is ignored and any role with a grant sees every row',
      apply: [`alter table ${qt(t.schema, t.table)} disable row level security`],
      restore: [
        `alter table ${qt(t.schema, t.table)} enable row level security`,
        ...(t.rlsForced ? [`alter table ${qt(t.schema, t.table)} force row level security`] : [])
      ]
    });
  }

  return { breaks, unparsed };
}

function oneLine(s: string): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > 110 ? t.slice(0, 107) + '...' : t;
}
