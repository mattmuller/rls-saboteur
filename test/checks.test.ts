import { describe, expect, it } from 'vitest';
import { codeWords, usesCurrentUser } from '../src/checks.js';
import { hostOf, isLocalHost, remoteRefusal } from '../src/safety.js';
import { readDbPort } from '../src/config.js';
import { containsWord } from '../src/tests.js';
import { exitCode, score, type RunModel } from '../src/report.js';

describe('current_user detection', () => {
  it('finds current_user used as code', () => {
    expect(usesCurrentUser('begin return current_user = \'admin\'; end')).toBe(true);
    expect(usesCurrentUser('select current_role')).toBe(true);
  });
  it('ignores comments, strings and dollar quotes', () => {
    expect(usesCurrentUser('-- current_user is the owner\nselect 1')).toBe(false);
    expect(usesCurrentUser("select 'current_user'")).toBe(false);
    expect(usesCurrentUser('select $q$ current_user $q$')).toBe(false);
    expect(usesCurrentUser('/* current_user */ select 1')).toBe(false);
  });
  it('does not match longer identifiers', () => {
    expect(codeWords('select my_current_user_id')).toEqual(['select', 'my_current_user_id']);
  });
  it('does not treat session_user as a finding', () => {
    expect(usesCurrentUser('select session_user')).toBe(false);
  });
});

describe('local-only guard', () => {
  it.each(['localhost', '127.0.0.1', '::1', 'host.docker.internal', '/var/run/postgresql'])('allows %s', (h) => {
    expect(isLocalHost(h)).toBe(true);
  });
  it.each(['db.example.com', '10.0.0.5', 'aws-0-eu.pooler.supabase.com'])('refuses %s', (h) => {
    expect(isLocalHost(h)).toBe(false);
  });
  it('reads IPv6 hosts from a URL', () => {
    expect(hostOf('postgres://u:p@[::1]:5432/db')).toBe('::1');
  });
  it('refuses a remote URL unless the flag is given', () => {
    expect(remoteRefusal('postgres://u:p@db.example.com:5432/postgres', false)).toContain('Refusing');
    expect(remoteRefusal('postgres://u:p@db.example.com:5432/postgres', true)).toBeNull();
    expect(remoteRefusal('postgres://u:p@127.0.0.1:54322/postgres', false)).toBeNull();
  });
});

describe('config.toml', () => {
  it('reads the db port and ignores other sections', () => {
    const toml = '[api]\nport = 1111\n[db]\n# comment\nport = 55322 # inline\nshadow_port = 55320\n';
    expect(readDbPort(toml)).toBe(55322);
  });
  it('returns null without a db port', () => {
    expect(readDbPort('[api]\nport = 1\n')).toBeNull();
  });
});

describe('containsWord', () => {
  it('matches whole identifiers only', () => {
    expect(containsWord('select * from public.documents;', 'documents')).toBe(true);
    expect(containsWord('select * from documents_archive;', 'documents')).toBe(false);
    expect(containsWord('mydocuments', 'documents')).toBe(false);
  });
});

describe('score and exit code', () => {
  const brk = (id: string) => ({ id, kind: 'drop-policy' as const, schema: 'public', table: 't', policy: 'p', label: '', effect: '', apply: [], restore: [] });
  const model = (outcomes: ('caught' | 'missed' | 'skipped')[], extra: Partial<RunModel> = {}): RunModel => ({
    database: '', databaseSource: '', testsDescription: '', schemas: ['public'], policyCount: 0, tableCount: 0,
    isolation: 'template', notes: [], findings: [], unparsed: [], policies: [], threshold: 100, jobs: 1, durationMs: 0,
    results: outcomes.map((o, i) => ({ brk: brk(String(i)), outcome: o, ms: 0 })),
    ...extra
  });
  it('scores caught over caught plus missed and ignores skipped', () => {
    expect(score(model(['caught', 'caught', 'caught', 'missed', 'skipped']).results).percent).toBe(75);
  });
  it('exits 0 at the threshold, 1 below it, 2 when it could not check', () => {
    expect(exitCode(model(['caught', 'caught']))).toBe(0);
    expect(exitCode(model(['caught', 'missed']))).toBe(1);
    expect(exitCode(model(['caught', 'missed'], { threshold: 50 }))).toBe(0);
    expect(exitCode(model([], { couldNotCheck: 'x' }))).toBe(2);
  });
  it('exits 1 on a catalogue FAIL even at 100%', () => {
    const f = { check: 'role-membership' as const, severity: 'FAIL' as const, title: '', detail: '' };
    expect(exitCode(model(['caught'], { findings: [f] }))).toBe(1);
    expect(exitCode(model(['caught'], { findings: [{ ...f, severity: 'WARN' }] }))).toBe(0);
  });
});

import { copyOwnerPid } from '../src/isolation.js';
describe('stale copy sweep only touches names this tool made', () => {
  it('recognises its own names', () => {
    expect(copyOwnerPid('saboteur_123_tpl')).toBe(123);
    expect(copyOwnerPid('saboteur_123_7')).toBe(123);
  });
  it('leaves everything else alone', () => {
    expect(copyOwnerPid('saboteur_e2e_src_1')).toBeNull();
    expect(copyOwnerPid('saboteur_backup')).toBeNull();
    expect(copyOwnerPid('postgres')).toBeNull();
  });
});
