import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Guard, GuardError, hostId, newToken } from '../src/guard.js';
import {
  DockerGuardError,
  checkDockerArgs,
  containerNameFor,
  removableContainer,
  LABEL_HOST,
  LABEL_KEY,
  LABEL_PID,
  LABEL_TOKEN
} from '../src/docker.js';
import { applyMasks, maskText, parseMask, scrambleExpr, validateMasks } from '../src/mask.js';
import { discoverBuildFiles, pgCronHint } from '../src/files.js';
import { modeLines, policyDifferences, sandboxImageFor } from '../src/run.js';
import { containerHostFor, rolesScript } from '../src/sandbox.js';
import type { Db } from '../src/guard.js';
import type { Policy } from '../src/types.js';

// ---------------------------------------------------------------- guard: the empty master

describe('guard: build mode', () => {
  const url = 'postgres://u:p@127.0.0.1:5432/appdb';
  it('empty-master: the guard refuses a master made from template0 unless build mode is on', () => {
    const off = new Guard({ sourceUrl: url, allowTerminate: false });
    const on = new Guard({ sourceUrl: url, allowTerminate: false, emptyMaster: true });
    const sql = (g: Guard): string => `create database "${g.masterName()}" template "template0"`;
    expect(() => off.check('admin', sql(off))).toThrow(GuardError);
    expect(() => on.check('admin', sql(on))).not.toThrow();
  });
  it('empty-master: build mode allows template0 for the master only, and no other template', () => {
    const g = new Guard({ sourceUrl: url, allowTerminate: false, emptyMaster: true });
    expect(() => g.check('admin', `create database "${g.masterName()}" template "template1"`)).toThrow(GuardError);
    expect(() => g.check('admin', `create database "${g.masterName()}" template "other"`)).toThrow(GuardError);
    // A per-break copy may not come from template0, even in build mode.
    expect(() => g.check('admin', `create database "${g.copyName(1)}" template "template0"`)).toThrow(GuardError);
    // The master is still allowed from the source in default mode.
    const d = new Guard({ sourceUrl: url, allowTerminate: false });
    expect(() => d.check('admin', `create database "${d.masterName()}" template "appdb"`)).not.toThrow();
  });
});

// ---------------------------------------------------------------- docker guard

describe('docker guard', () => {
  const token = newToken();
  const name = containerNameFor(hostId(), process.pid, token);
  const labels = ['--label', `${LABEL_KEY}=1`, '--label', `${LABEL_HOST}=${hostId()}`, '--label', `${LABEL_PID}=${process.pid}`, '--label', `${LABEL_TOKEN}=${token}`];
  const runArgs = (extra: string[] = [], image = 'postgres:17'): string[] => [
    'run', '-d', '--rm', '--name', name, ...labels, '-e', 'POSTGRES_PASSWORD', '-p', '127.0.0.1::5432', '--add-host', 'host.docker.internal:host-gateway', image, ...extra
  ];
  it('docker guard: allows the one container shape the tool starts', () => {
    expect(() => checkDockerArgs(runArgs(), name)).not.toThrow();
    expect(() => checkDockerArgs(['port', name, '5432/tcp'], name)).not.toThrow();
    expect(() => checkDockerArgs(['rm', '-f', '-v', name], name)).not.toThrow();
  });
  it('docker guard: refuses privileges, mounts, host network and a published port beyond loopback', () => {
    for (const bad of [
      ['--privileged'], ['-v', '/:/host'], ['--network', 'host'], ['--pid', 'host'], ['--cap-add', 'ALL'], ['-p', '0.0.0.0:5432:5432'], ['--user', 'root']
    ]) {
      const a = runArgs();
      a.splice(1, 0, ...bad);
      expect(() => checkDockerArgs(a, name), bad.join(' ')).toThrow(DockerGuardError);
    }
    expect(() => checkDockerArgs(runArgs(['--privileged']), name)).toThrow(DockerGuardError);
    expect(() => checkDockerArgs(runArgs([], '--privileged'), name)).toThrow(DockerGuardError);
    const other = containerNameFor(hostId(), process.pid + 1, token);
    expect(() => checkDockerArgs(runArgs().map((x) => (x === name ? other : x)), name)).toThrow(DockerGuardError);
  });
  it('docker guard: exec runs only pg_dump, psql and pg_isready in its own container', () => {
    expect(() => checkDockerArgs(['exec', '-i', '-e', 'PGPASSWORD', name, 'psql', '-c', 'select 1'], name)).not.toThrow();
    expect(() => checkDockerArgs(['exec', name, 'sh', '-c', 'id'], name)).toThrow(DockerGuardError);
    expect(() => checkDockerArgs(['exec', name, 'bash'], name)).toThrow(DockerGuardError);
    expect(() => checkDockerArgs(['exec', '-e', 'LD_PRELOAD', name, 'psql'], name)).toThrow(DockerGuardError);
    expect(() => checkDockerArgs(['exec', 'some-other-container', 'psql'], name)).toThrow(DockerGuardError);
  });
  it('docker guard: refuses every other verb, and a removal of a name that is not the tool\'s', () => {
    for (const v of [['kill', name], ['stop', name], ['cp', name, '/tmp'], ['network', 'rm', 'bridge'], ['volume', 'rm', 'x'], ['system', 'prune', '-f'], ['image', 'rm', 'postgres']]) {
      expect(() => checkDockerArgs(v, name), v.join(' ')).toThrow(DockerGuardError);
    }
    expect(() => checkDockerArgs(['rm', '-f', '-v', 'supabase_db_x'], name)).toThrow(DockerGuardError);
    expect(() => checkDockerArgs(['rm', '-f', 'supabase_db_x'], name)).toThrow(DockerGuardError);
  });
});

describe('removableContainer (the one rule behind every container removal)', () => {
  const host = 'aaaaaaaaaaaa';
  const token = 'b'.repeat(16);
  const mk = (h: string, pid: number, t: string) => {
    const n = containerNameFor(h, pid, t);
    return { n, l: { [LABEL_KEY]: '1', [LABEL_HOST]: h, [LABEL_PID]: String(pid), [LABEL_TOKEN]: t } };
  };
  it('removes a container of this run', () => {
    const c = mk(host, 10, token);
    expect(removableContainer(c.n, c.l, token, () => true, host).ok).toBe(true);
  });
  it('removes a container of a dead process of this host', () => {
    const c = mk(host, 10, 'c'.repeat(16));
    expect(removableContainer(c.n, c.l, token, () => false, host).ok).toBe(true);
  });
  it('never removes a container of a live process, of another host, or without the tool\'s labels', () => {
    const live = mk(host, 10, 'c'.repeat(16));
    expect(removableContainer(live.n, live.l, token, () => true, host).ok).toBe(false);
    const foreign = mk('dddddddddddd', 10, 'c'.repeat(16));
    expect(removableContainer(foreign.n, foreign.l, token, () => false, host).ok).toBe(false);
    const c = mk(host, 10, 'c'.repeat(16));
    expect(removableContainer(c.n, {}, token, () => false, host).ok).toBe(false);
    expect(removableContainer(c.n, { ...c.l, [LABEL_PID]: '11' }, token, () => false, host).ok).toBe(false);
    expect(removableContainer('supabase_db_x', c.l, token, () => false, host).ok).toBe(false);
  });
});

// ---------------------------------------------------------------- masks

describe('mask: parsing', () => {
  it('reads schema.table.column with the default and the null strategy', () => {
    expect(parseMask('public.users.email')).toEqual({ schema: 'public', table: 'users', column: 'email', strategy: 'scramble' });
    expect(parseMask('public.users.note=null').strategy).toBe('null');
    expect(parseMask('"my schema"."T.1".c').table).toBe('T.1');
    expect(maskText(parseMask('a.b.c=null'))).toBe('a.b.c=null');
  });
  it('rejects anything else', () => {
    for (const bad of ['', 'users.email', 'a.b', 'a.b.c.d', 'a.b.c=hash', 'a.b.c=', 'a.b.c extra']) {
      expect(() => parseMask(bad), bad).toThrow(/--mask/);
    }
  });
  it('scramble expressions match the column type, and an unknown type has none', () => {
    expect(scrambleExpr('"c"', { base: 'varchar', type: 'character varying(8)', maxLen: 8 }, 'ab')).toContain('left(md5');
    expect(scrambleExpr('"c"', { base: 'varchar', type: 'character varying(8)', maxLen: 8 }, 'ab')).toContain(', 8)');
    expect(scrambleExpr('"c"', { base: 'uuid', type: 'uuid', maxLen: null }, 'ab')).toContain('::uuid');
    expect(scrambleExpr('"c"', { base: 'int4', type: 'integer', maxLen: null }, 'ab')).toContain('% 2147483647');
    expect(() => scrambleExpr('"c"', { base: 'jsonb', type: 'jsonb', maxLen: null }, 'ab')).toThrow();
  });
});

/** A fake database that answers the mask queries. `s` controls what it says. */
function fakeDb(s: { exists?: boolean; type?: string; before?: number; updated?: number; left?: number; noSuper?: boolean; relkind?: string; generated?: string }): { db: Db; log: string[] } {
  const log: string[] = [];
  const db: Db = {
    async end() {},
    async query(text: string) {
      log.push(text.replace(/\s+/g, ' ').trim());
      if (/from pg_attribute a/.test(text)) {
        if (s.exists === false) return { rows: [], rowCount: 0 } as never;
        return { rows: [{ relkind: s.relkind ?? 'r', type: s.type ?? 'text', base: s.type ?? 'text', generated: s.generated ?? '', identity: '', maxlen: null }], rowCount: 1 } as never;
      }
      if (/session_replication_role/.test(text) && s.noSuper) throw new Error('permission denied to set parameter');
      if (/select count\(\*\) as n from _sab_mask/.test(text)) return { rows: [{ n: s.before ?? 3 }], rowCount: 1 } as never;
      if (/^update /.test(text.trim())) return { rows: [], rowCount: s.updated ?? s.before ?? 3 } as never;
      if (/select count\(\*\) as n from/.test(text)) return { rows: [{ n: s.left ?? 0 }], rowCount: 1 } as never;
      return { rows: [], rowCount: 0 } as never;
    }
  };
  return { db, log };
}

describe('mask: it fails closed', () => {
  const spec = [parseMask('public.users.email')];
  it('mask-ok: a clean rewrite is committed and counted', async () => {
    const { db, log } = fakeDb({});
    const out = await applyMasks(db, spec, 'salt');
    expect(out).toEqual([{ column: 'public.users.email', strategy: 'scramble', rows: 3 }]);
    expect(log).toContain('commit');
    expect(log.findIndex((l) => /^update/.test(l))).toBeGreaterThan(log.indexOf('begin'));
    expect(log.some((l) => /row_security = off/.test(l))).toBe(true);
  });
  it('mask-closed: a column that does not exist stops the run', async () => {
    await expect(applyMasks(fakeDb({ exists: false }).db, spec, 's')).rejects.toThrow(/does not exist/);
    expect(await validateMasks(fakeDb({ exists: false }).db, spec)).toEqual(['public.users.email does not exist']);
  });
  it('mask-closed: a row that was not rewritten stops the run and rolls back', async () => {
    const { db, log } = fakeDb({ before: 3, updated: 2 });
    await expect(applyMasks(db, spec, 's')).rejects.toThrow(/rewrote 2 row\(s\).*expected 3/);
    expect(log).toContain('rollback');
    expect(log).not.toContain('commit');
  });
  it('mask-closed: an original value that survives stops the run and rolls back', async () => {
    const { db, log } = fakeDb({ left: 1 });
    await expect(applyMasks(db, spec, 's')).rejects.toThrow(/still hold an original value/);
    expect(log).toContain('rollback');
    expect(log).not.toContain('commit');
  });
  it('mask-closed: a role that cannot switch triggers off stops the run', async () => {
    await expect(applyMasks(fakeDb({ noSuper: true }).db, spec, 's')).rejects.toThrow(/needs a superuser/);
  });
  it('mask-closed: a type scramble cannot handle, a view and a generated column stop the run', async () => {
    await expect(applyMasks(fakeDb({ type: 'jsonb' }).db, spec, 's')).rejects.toThrow(/does not handle/);
    await expect(applyMasks(fakeDb({ relkind: 'v' }).db, spec, 's')).rejects.toThrow(/not a table/);
    await expect(applyMasks(fakeDb({ generated: 's' }).db, spec, 's')).rejects.toThrow(/generated column/);
  });
  it('mask-null: the null strategy checks that no value is left', async () => {
    const { db } = fakeDb({ left: 2 });
    await expect(applyMasks(db, [parseMask('public.users.note=null')], 's')).rejects.toThrow(/still hold an original value/);
  });
});

// ---------------------------------------------------------------- files, plan lines, helpers

describe('build files', () => {
  it('from-files: reads migrations in name order, then the seed', () => {
    const d = mkdtempSync(join(tmpdir(), 'sab-files-'));
    try {
      mkdirSync(join(d, 'supabase', 'migrations'), { recursive: true });
      writeFileSync(join(d, 'supabase', 'migrations', '2_b.sql'), 'select 2');
      writeFileSync(join(d, 'supabase', 'migrations', '1_a.sql'), 'select 1');
      writeFileSync(join(d, 'supabase', 'migrations', 'notes.txt'), 'x');
      writeFileSync(join(d, 'supabase', 'seed.sql'), 'select 3');
      const f = discoverBuildFiles(d);
      expect(f.migrations.map((m) => m.split('/').pop())).toEqual(['1_a.sql', '2_b.sql']);
      expect(f.seed).toMatch(/seed\.sql$/);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });
  it('from-files: a missing directory, no migration, or a named seed that is missing is an error', () => {
    const d = mkdtempSync(join(tmpdir(), 'sab-files-'));
    try {
      expect(() => discoverBuildFiles(d)).toThrow(/does not exist/);
      mkdirSync(join(d, 'supabase', 'migrations'), { recursive: true });
      expect(() => discoverBuildFiles(d)).toThrow(/no .sql file/);
      writeFileSync(join(d, 'supabase', 'migrations', '1.sql'), 'select 1');
      expect(discoverBuildFiles(d).seed).toBeNull();
      expect(() => discoverBuildFiles(d, undefined, 'nope.sql')).toThrow(/seed file/);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });
  it('pg_cron: the hint appears only for the pg_cron error', () => {
    expect(pgCronHint('can only create extension in database postgres')).toMatch(/cron\.database_name/);
    expect(pgCronHint('syntax error')).toBe('');
  });
});

describe('plan lines and helpers', () => {
  const pol = (name: string, qual = 'true'): Policy => ({ schema: 'public', table: 't', name, cmd: 'SELECT', permissive: true, roles: [], qual, withCheck: null });
  it('default-plan: a default run adds no plan line', () => {
    expect(modeLines({ buildFiles: null, sandbox: false, masks: [] })).toEqual([]);
    expect(modeLines({ masks: undefined })).toEqual([]);
  });
  it('plan: the new modes say what they do', () => {
    const files = { migrations: ['a.sql'], seed: null, description: '1 migration file(s)' };
    expect(modeLines({ buildFiles: files }).join(' ')).toMatch(/No row of this database is copied/);
    expect(modeLines({ sandbox: true }).join(' ')).toMatch(/streamed into it with pg_dump/);
    expect(modeLines({ sandbox: true, buildFiles: files }).join(' ')).not.toMatch(/pg_dump/);
    expect(modeLines({ masks: [parseMask('a.b.c')] }).join(' ')).toMatch(/If one cannot be, the run stops/);
  });
  it('policyDifferences names a policy that is missing, extra or different', () => {
    expect(policyDifferences([pol('a')], [pol('a')])).toEqual([]);
    expect(policyDifferences([pol('a')], [])).toHaveLength(1);
    expect(policyDifferences([], [pol('a')])).toHaveLength(1);
    expect(policyDifferences([pol('a', 'true')], [pol('a', 'false')])).toHaveLength(1);
  });
  it('sandbox image defaults to the official image of the source major version', () => {
    const f = { version: '17.6', addr: null, port: null, sizeBytes: 0, sizePretty: '', sessions: [] };
    expect(sandboxImageFor({}, f)).toBe('postgres:17');
    expect(sandboxImageFor({ sandboxImage: 'x/y:1' }, f)).toBe('x/y:1');
  });
  it('sandbox: only loopback source hosts are rewritten to the Docker host name', () => {
    expect(containerHostFor('127.0.0.1')).toBe('host.docker.internal');
    expect(containerHostFor('localhost')).toBe('host.docker.internal');
    expect(containerHostFor('supabase_db_x')).toBe('supabase_db_x');
  });
  it('sandbox roles script: no superuser, no password, system roles skipped', () => {
    const base = { rolinherit: true, rolcreaterole: false, rolcreatedb: false, rolcanlogin: false, rolreplication: false, rolbypassrls: false };
    const sql = rolesScript([{ rolname: 'app_user', ...base }, { rolname: 'pg_monitor', ...base }, { rolname: 'postgres', ...base }, { rolname: "o'q", ...base, rolcanlogin: true }], [{ role: 'app_user', member: "o'q" }], 'postgres');
    expect(sql).toContain('create role "app_user" NOSUPERUSER');
    expect(sql).not.toMatch(/pg_monitor|"postgres"/);
    expect(sql).not.toMatch(/(?<!NO)SUPERUSER|password/i);
    expect(sql).toContain(`'o''q'`);
    expect(sql).toContain('grant "app_user" to "o\'q"');
  });
});
