import type { BreakResult, Catalogue, Finding, Policy } from './types.js';

export interface RunModel {
  database: string;
  databaseSource: string;
  testsDescription: string;
  schemas: string[];
  policyCount: number;
  tableCount: number;
  baselineAssertions?: number;
  isolation: 'template' | 'in-place';
  notes: string[];
  results: BreakResult[];
  findings: Finding[];
  unparsed: { policy: string; table: string; reason: string }[];
  policies: Policy[];
  /** Per table: how many test files mention it. Absent when the runner cannot tell. */
  testFilesByTable?: Record<string, number>;
  threshold: number;
  jobs: number;
  durationMs: number;
  /** Set when the run could not check (exit 2). */
  couldNotCheck?: string;
  /** Only the checks that need no tests were run. */
  checksOnly?: boolean;
}

export interface Score {
  caught: number;
  missed: number;
  skipped: number;
  errored: number;
  total: number;
  /** Percent, 0-100, or null when nothing was checked. */
  percent: number | null;
}

export function score(results: BreakResult[]): Score {
  const count = (o: string) => results.filter((r) => r.outcome === o).length;
  const caught = count('caught');
  const missed = count('missed');
  const decided = caught + missed;
  return {
    caught,
    missed,
    skipped: count('skipped'),
    errored: count('error'),
    total: results.length,
    percent: decided === 0 ? null : Math.round((caught / decided) * 100)
  };
}

export function exitCode(m: RunModel): 0 | 1 | 2 {
  if (m.couldNotCheck) return 2;
  const s = score(m.results);
  if (m.findings.some((f) => f.severity === 'FAIL')) return 1;
  if (s.percent !== null && s.percent < m.threshold) return 1;
  return 0;
}

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + ' '.repeat(n - s.length);
}

function oneLine(s: string, max = 100): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max - 3) + '...' : t;
}

function policyOf(m: RunModel, r: BreakResult): Policy | undefined {
  return m.policies.find((p) => p.schema === r.brk.schema && p.table === r.brk.table && p.name === r.brk.policy);
}

function expressionLine(p: Policy | undefined): string | null {
  if (!p) return null;
  const parts: string[] = [];
  if (p.qual) parts.push(`USING ${oneLine(p.qual)}`);
  if (p.withCheck) parts.push(`WITH CHECK ${oneLine(p.withCheck)}`);
  return parts.length ? parts.join(' ') : null;
}

function hint(m: RunModel, r: BreakResult): string {
  const key = `${r.brk.schema}.${r.brk.table}`;
  const n = m.testFilesByTable?.[key];
  if (n === 0) return `No test file mentions ${r.brk.table}.`;
  if (n !== undefined) return `${n} test file(s) mention ${r.brk.table}, and none fails with this break.`;
  return `Your tests still pass with this break in place.`;
}

export const INLINE_MISSED = 3;

export function consoleReport(m: RunModel, color: boolean): string {
  const c = (code: string, s: string) => (color ? `\x1b[${code}m${s}\x1b[0m` : s);
  const red = (s: string) => c('31;1', s);
  const green = (s: string) => c('32', s);
  const dim = (s: string) => c('2', s);
  const s = score(m.results);
  const out: string[] = [];
  const row = (k: string, v: string) => out.push(`${pad(k, 11)}${v}`);

  row('Database', `${m.database}  (${m.databaseSource})`);
  row('Tests', m.testsDescription);
  row('Policies', `${m.policyCount} on ${m.tableCount} tables in ${m.schemas.join(', ')}`);
  if (m.checksOnly) {
    // no tests were run
  } else if (m.couldNotCheck) {
    out.push('');
    out.push(red(`Could not check: ${m.couldNotCheck}`));
  } else {
    row('Baseline', m.baselineAssertions ? `all ${m.baselineAssertions} tests pass` : 'tests pass');
    const decided = m.results.length;
    row(
      'Sabotage',
      `breaking each policy in turn and re-running the tests  (${decided} breaks, ${m.isolation === 'template' ? `${m.jobs} at a time, on database copies` : 'in place, one at a time'})`
    );
    for (const n of m.notes) out.push(dim(`  note: ${n}`));
    const w = String(s.caught + s.missed).length;
    out.push(`  ${green('caught')}  ${String(s.caught).padStart(w)} / ${s.caught + s.missed}`);
    out.push(
      `  ${red('MISSED')}  ${String(s.missed).padStart(w)} / ${s.caught + s.missed}  your tests still pass with these policies broken`
    );
    const missed = m.results.filter((r) => r.outcome === 'missed');
    for (const r of missed.slice(0, INLINE_MISSED)) {
      const p = policyOf(m, r);
      out.push(`  ${red('MISSED')}  ${r.brk.table}  ${r.brk.policy ? `"${r.brk.policy}"` : '(table)'}`);
      const expr = expressionLine(p);
      if (expr) out.push(`          ${expr}`);
      out.push(`          break: ${r.brk.label}  → ${r.brk.effect}`);
      out.push(`          ${hint(m, r)}`);
    }
    if (missed.length > INLINE_MISSED) {
      out.push(`  ... ${missed.length - INLINE_MISSED} more in saboteur-report.md`);
    }
    if (s.skipped || s.errored) {
      out.push(dim(`  not counted: ${s.skipped} skipped, ${s.errored} errored (see saboteur-report.md)`));
    }
    if (m.unparsed.length) {
      out.push(dim(`  ${m.unparsed.length} policy expression(s) could not be parsed; their condition-level breaks were not tried.`));
    }
  }

  out.push('Checks without tests');
  if (m.findings.length === 0) out.push(`  ${green('ok')}    no problems found in grants, roles or functions`);
  for (const f of m.findings) {
    out.push(`  ${f.severity === 'FAIL' ? red('FAIL') : 'WARN'}  ${f.title}`);
    out.push(`        ${f.detail}`);
  }

  const code = exitCode(m);
  const pct = s.percent === null ? 'n/a' : `${s.percent}%`;
  out.push(m.checksOnly ? `Checks only   exit ${code}` : `Score  ${pct}   exit ${code} (threshold ${m.threshold}%)`);
  return out.join('\n');
}

export function markdownReport(m: RunModel): string {
  const s = score(m.results);
  const lines: string[] = [];
  lines.push('# RLS Saboteur report', '');
  lines.push(`- Database: \`${m.database}\` (${m.databaseSource})`);
  lines.push(`- Tests: ${m.testsDescription}`);
  lines.push(`- Policies: ${m.policyCount} on ${m.tableCount} tables in ${m.schemas.join(', ')}`);
  lines.push(`- Isolation: ${m.isolation === 'template' ? 'database copies (CREATE DATABASE ... TEMPLATE)' : 'in place'}`);
  lines.push(`- Score: **${s.percent === null ? 'n/a' : s.percent + '%'}** (${s.caught} caught, ${s.missed} missed, ${s.skipped} skipped, ${s.errored} errored). Threshold ${m.threshold}%.`);
  lines.push(`- Run time: ${(m.durationMs / 1000).toFixed(1)} s`, '');
  if (m.couldNotCheck) lines.push(`**Could not check:** ${m.couldNotCheck}`, '');

  const missed = m.results.filter((r) => r.outcome === 'missed');
  lines.push(`## Missed breaks (${missed.length})`, '');
  if (missed.length === 0) lines.push('None. Every break made at least one test fail.', '');
  for (const r of missed) {
    const p = policyOf(m, r);
    lines.push(`### \`${r.brk.schema}.${r.brk.table}\` ${r.brk.policy ? `"${r.brk.policy}"` : '(table)'}`, '');
    const expr = expressionLine(p);
    if (expr) lines.push('```sql', expr, '```', '');
    lines.push(`- Break: ${r.brk.label}`);
    lines.push(`- Effect: ${r.brk.effect}`);
    lines.push(`- ${hint(m, r)}`);
    lines.push('- SQL applied:', '', '```sql', ...r.brk.apply.map((x) => x + ';'), '```', '');
  }

  lines.push('## Checks without tests', '');
  if (m.findings.length === 0) lines.push('No problems found.', '');
  for (const f of m.findings) lines.push(`- **${f.severity}** ${f.title}. ${f.detail}`);
  if (m.findings.length) lines.push('');

  const other = m.results.filter((r) => r.outcome === 'skipped' || r.outcome === 'error');
  if (other.length) {
    lines.push('## Not counted', '');
    for (const r of other) lines.push(`- ${r.outcome}: ${r.brk.id}${r.note ? ` (${oneLine(r.note, 160)})` : ''}`);
    lines.push('');
  }
  if (m.unparsed.length) {
    lines.push('## Expressions the parser could not read', '');
    for (const u of m.unparsed) lines.push(`- ${u.table} "${u.policy}": ${u.reason}`);
    lines.push('');
  }
  const caught = m.results.filter((r) => r.outcome === 'caught');
  lines.push(`## Caught breaks (${caught.length})`, '');
  for (const r of caught) lines.push(`- ${r.brk.id}: ${r.brk.label}`);
  lines.push('');
  return lines.join('\n');
}

export function jsonReport(m: RunModel): string {
  const s = score(m.results);
  return JSON.stringify(
    {
      version: 1,
      database: m.database,
      schemas: m.schemas,
      policies: m.policyCount,
      tables: m.tableCount,
      isolation: m.isolation,
      threshold: m.threshold,
      score: s,
      exit: exitCode(m),
      couldNotCheck: m.couldNotCheck ?? null,
      breaks: m.results.map((r) => ({
        id: r.brk.id,
        kind: r.brk.kind,
        schema: r.brk.schema,
        table: r.brk.table,
        policy: r.brk.policy,
        label: r.brk.label,
        effect: r.brk.effect,
        sql: r.brk.apply,
        outcome: r.outcome,
        note: r.note ?? null
      })),
      findings: m.findings,
      unparsed: m.unparsed
    },
    null,
    2
  );
}

export function describeCatalogue(cat: Catalogue): { policyCount: number; tableCount: number } {
  const tables = new Set(cat.policies.map((p) => `${p.schema}.${p.table}`));
  return { policyCount: cat.policies.length, tableCount: tables.size };
}
