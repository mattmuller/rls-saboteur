import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const action = readFileSync(join(import.meta.dirname, '..', 'action.yml'), 'utf8');

/** The `run: |` script of the step with this name, taken from action.yml as written. */
function stepScript(name: string): string {
  const lines = action.split('\n');
  const at = lines.findIndex((l) => l.trim() === `- name: ${name}`);
  expect(at, `step "${name}" not found`).toBeGreaterThan(-1);
  const run = lines.findIndex((l, i) => i > at && l.trim() === 'run: |');
  const out: string[] = [];
  for (let i = run + 1; i < lines.length && (lines[i] === '' || lines[i].startsWith('        ')); i++) out.push(lines[i].slice(8));
  return out.join('\n');
}

function checkInputs(env: Record<string, string>): { status: number | null; close: string | undefined; stdout: string } {
  const dir = mkdtempSync(join(tmpdir(), 'rls-saboteur-action-'));
  try {
    const out = join(dir, 'out');
    const r = spawnSync('bash', ['-c', stepScript('Check inputs')], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH ?? '', GITHUB_OUTPUT: out, SABOTEUR_VERSION: '0.2.0', SABOTEUR_THRESHOLD: '100', SABOTEUR_JOBS: '2', ...env }
    });
    let text = '';
    try {
      text = readFileSync(out, 'utf8');
    } catch {
      /* no output written */
    }
    return { status: r.status, close: /^close=(.*)$/m.exec(text)?.[1], stdout: r.stdout };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('7: the Action closes sessions by default only on the stack it starts itself', () => {
  it('close-sessions unset and start-supabase true: close', () => {
    expect(checkInputs({ SABOTEUR_START: 'true', SABOTEUR_CLOSE: '' })).toMatchObject({ status: 0, close: 'true' });
  });
  it('close-sessions unset and start-supabase false: do not close', () => {
    expect(checkInputs({ SABOTEUR_START: 'false', SABOTEUR_CLOSE: '' })).toMatchObject({ status: 0, close: 'false' });
  });
  it('an explicit value always wins', () => {
    expect(checkInputs({ SABOTEUR_START: 'false', SABOTEUR_CLOSE: 'true' }).close).toBe('true');
    expect(checkInputs({ SABOTEUR_START: 'true', SABOTEUR_CLOSE: 'false' }).close).toBe('false');
  });
  it('input validation still works: a bad close-sessions, version, threshold or jobs exits 2', () => {
    expect(checkInputs({ SABOTEUR_START: 'true', SABOTEUR_CLOSE: 'yes' })).toMatchObject({ status: 2, close: undefined });
    expect(checkInputs({ SABOTEUR_START: 'true', SABOTEUR_CLOSE: '', SABOTEUR_VERSION: 'latest' }).status).toBe(2);
    expect(checkInputs({ SABOTEUR_START: 'true', SABOTEUR_CLOSE: '', SABOTEUR_THRESHOLD: '101' }).status).toBe(2);
    expect(checkInputs({ SABOTEUR_START: 'true', SABOTEUR_CLOSE: '', SABOTEUR_JOBS: '0' }).status).toBe(2);
  });
  it('the run step passes --close-sessions only when the check step said close=true', () => {
    expect(stepScript('Run RLS Saboteur')).toContain('if [ "$SABOTEUR_CLOSE" = "true" ]; then args+=(--close-sessions); fi');
    expect(action).toContain('SABOTEUR_CLOSE: ${{ steps.check.outputs.close }}');
  });
});
