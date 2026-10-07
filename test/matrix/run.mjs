#!/usr/bin/env node
// npm run test:matrix: build the CLI, start rls-saboteur-ci-16 and -17 (official postgres images plus
// pgTAP, see test/docker/Dockerfile), run the fixture matrix against each, and stop them again.
// Only containers named rls-saboteur-ci-* are ever created or removed. Volumes are never touched.
import { spawnSync } from 'node:child_process';
import { cpus, loadavg } from 'node:os';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..', '..');
const versions = (process.env.MATRIX_VERSIONS ?? '16,17').split(',').map((v) => v.trim()).filter(Boolean);
const port = (v) => 55400 + Number(v);
const name = (v) => `rls-saboteur-ci-${v}`;
const image = (v) => `rls-saboteur-ci-pg:${v}`;

function sh(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { stdio: 'inherit', cwd: root, ...opts });
}
function quiet(cmd, args) {
  return spawnSync(cmd, args, { encoding: 'utf8', cwd: root });
}
// Heavy steps go through nice when the machine is already busy.
const busy = loadavg()[0] > 8;
const niced = (cmd, args) => (busy && process.platform !== 'win32' ? ['nice', ['-n', '19', cmd, ...args]] : [cmd, args]);
if (busy) console.log(`load ${loadavg()[0].toFixed(1)} on ${cpus().length} cores: heavy steps run with nice -n 19`);

function removeContainer(v) {
  // The name check is the safety: only our own containers are ever removed.
  if (!name(v).startsWith('rls-saboteur-ci-')) return;
  quiet('docker', ['rm', '-f', name(v)]);
}

const started = [];
let failed = false;
try {
  let [c, a] = niced('npm', ['run', 'build']);
  if (sh(c, a).status !== 0) throw new Error('build failed');

  for (const v of versions) {
    [c, a] = niced('docker', ['build', '--build-arg', `PG_MAJOR=${v}`, '-t', image(v), 'test/docker']);
    if (sh(c, a, { stdio: ['ignore', 'ignore', 'inherit'] }).status !== 0) throw new Error(`docker build failed for ${v}`);
    removeContainer(v);
    const r = sh('docker', [
      'run', '-d', '--name', name(v), '-e', 'POSTGRES_PASSWORD=postgres', '-p', `127.0.0.1:${port(v)}:5432`,
      image(v), '-c', 'cluster_name=rls-saboteur-ci', '-c', 'fsync=off', '-c', 'max_connections=200'
    ], { stdio: ['ignore', 'ignore', 'inherit'] });
    if (r.status !== 0) throw new Error(`could not start ${name(v)} (is port ${port(v)} free?)`);
    started.push(v);
  }
  for (const v of started) {
    let ready = false;
    for (let i = 0; i < 90 && !ready; i++) {
      // Ready means a TCP login from the host works, not only that the entrypoint's temporary server is up.
      ready = quiet('docker', ['exec', name(v), 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres']).status === 0 &&
        quiet('docker', ['exec', name(v), 'psql', '-h', '127.0.0.1', '-U', 'postgres', '-Atc', "select current_setting('cluster_name')"]).stdout?.trim() === 'rls-saboteur-ci';
      if (!ready) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);
    }
    if (!ready) throw new Error(`${name(v)} did not become ready`);
  }
  for (const v of started) {
    console.log(`\n=== PostgreSQL ${v} (port ${port(v)}) ===`);
    const [vc, va] = niced('npx', ['vitest', 'run', '--config', 'vitest.matrix.config.ts']);
    const r = sh(vc, va, { env: { ...process.env, SABOTEUR_MATRIX_URL: `postgres://postgres:postgres@127.0.0.1:${port(v)}/postgres` } });
    if (r.status !== 0) failed = true;
  }
} catch (e) {
  console.error(String(e instanceof Error ? e.message : e));
  failed = true;
} finally {
  for (const v of versions) removeContainer(v);
}
process.exit(failed ? 1 : 0);
