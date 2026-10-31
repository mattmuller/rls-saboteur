#!/usr/bin/env node
// npm run test:matrix: build the CLI, start rls-saboteur-ci-16 and -17 (official postgres images plus
// pgTAP, see test/docker/Dockerfile), run the fixture matrix against each, and stop them again.
// Each version also gets a SECOND throwaway server (rls-saboteur-ci-b-<v>, port 55500+v) so that the different-server
// test (SABOTEUR_MATRIX_URL_B) really runs. Only containers named rls-saboteur-ci-* are ever created or removed.
// Volumes are never touched.
import { spawnSync } from 'node:child_process';
import { cpus, loadavg } from 'node:os';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..', '..');
const versions = (process.env.MATRIX_VERSIONS ?? '16,17').split(',').map((v) => v.trim()).filter(Boolean);
const port = (v) => 55400 + Number(v);
const portB = (v) => 55500 + Number(v);
const name = (v) => `rls-saboteur-ci-${v}`;
const nameB = (v) => `rls-saboteur-ci-b-${v}`;
// A third server with pg_cron preloaded, for the pg_cron test only.
const portC = (v) => 55600 + Number(v);
const nameC = (v) => `rls-saboteur-ci-cron-${v}`;
const image = (v) => `rls-saboteur-ci-pg:${v}`;

const SUPABASE_CI_IMAGE = 'public.ecr.aws/supabase/postgres:17.6.1.011';
function supabaseImageFor(v) {
  if (process.env.SABOTEUR_MATRIX_SUPABASE_IMAGE) return process.env.SABOTEUR_MATRIX_SUPABASE_IMAGE;
  return process.env.CI && v === '17' ? SUPABASE_CI_IMAGE : '';
}

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
  for (const n of [name(v), nameB(v), nameC(v)]) {
    if (!n.startsWith('rls-saboteur-ci-')) continue;
    quiet('docker', ['rm', '-f', n]);
  }
}

function startServer(v, n, p, extra = []) {
  const r = sh('docker', [
    'run', '-d', '--name', n, '-e', 'POSTGRES_PASSWORD=postgres', '-p', `127.0.0.1:${p}:5432`,
    image(v), '-c', 'cluster_name=rls-saboteur-ci', '-c', 'fsync=off', '-c', 'max_connections=200', ...extra
  ], { stdio: ['ignore', 'ignore', 'inherit'] });
  if (r.status !== 0) throw new Error(`could not start ${n} (is port ${p} free?)`);
}

function isReady(n) {
  // Ready means a TCP login from the host works, not only that the entrypoint's temporary server is up.
  return quiet('docker', ['exec', n, 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres']).status === 0 &&
    quiet('docker', ['exec', n, 'psql', '-h', '127.0.0.1', '-U', 'postgres', '-Atc', "select current_setting('cluster_name')"]).stdout?.trim() === 'rls-saboteur-ci';
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
    started.push(v);
    startServer(v, name(v), port(v));
    startServer(v, nameB(v), portB(v));
    startServer(v, nameC(v), portC(v), ['-c', 'shared_preload_libraries=pg_cron', '-c', 'cron.database_name=postgres']);
  }
  for (const v of started) {
    for (const n of [name(v), nameB(v), nameC(v)]) {
      let ready = false;
      for (let i = 0; i < 90 && !ready; i++) {
        ready = isReady(n);
        if (!ready) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);
      }
      if (!ready) throw new Error(`${n} did not become ready`);
    }
  }
  for (const v of started) {
    console.log(`\n=== PostgreSQL ${v} (port ${port(v)}) ===`);
    const [vc, va] = niced('npx', ['vitest', 'run', '--config', 'vitest.matrix.config.ts', ...process.argv.slice(2)]);
    const r = sh(vc, va, { env: {
      ...process.env,
      SABOTEUR_MATRIX_URL: `postgres://postgres:postgres@127.0.0.1:${port(v)}/postgres`,
      SABOTEUR_MATRIX_URL_B: `postgres://postgres:postgres@127.0.0.1:${portB(v)}/postgres`,
      SABOTEUR_MATRIX_URL_CRON: `postgres://postgres:postgres@127.0.0.1:${portC(v)}/postgres`,
      SABOTEUR_MATRIX_IMAGE: image(v),
      // The Supabase tests need the image. Set SABOTEUR_MATRIX_SUPABASE_IMAGE for a local copy. In CI (CI is set) the public
      // image is pulled for the PostgreSQL 17 run, so those tests are not skipped there. The image is PostgreSQL 17, so the
      // 16 run does not use it.
      ...(supabaseImageFor(v) ? { SABOTEUR_MATRIX_SUPABASE_IMAGE: supabaseImageFor(v) } : {})
    } });
    if (r.status !== 0) failed = true;
  }
} catch (e) {
  console.error(String(e instanceof Error ? e.message : e));
  failed = true;
} finally {
  for (const v of versions) removeContainer(v);
}
process.exit(failed ? 1 : 0);
