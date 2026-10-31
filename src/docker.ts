import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { hostId } from './guard.js';

/**
 * The Docker guard. Sandbox mode starts a throwaway PostgreSQL container, and this file is the only place that runs
 * `docker`. Like the database guard, it is an allowlist of the commands the tool itself sends: every call goes through
 * checkDockerArgs BEFORE it runs, with no shell. A command that is not in the list is refused.
 *
 * The rules: the tool starts one container shape (loopback port, no mounts, no extra privileges, no host network),
 * runs only pg_dump, psql and pg_isready inside it, and removes only containers that carry its name and labels and that
 * belong to this run, or to a dead process of this host.
 */

export const CONTAINER_PREFIX = 'rls-saboteur-sandbox-';
export const LABEL_KEY = 'rls-saboteur.sandbox';
export const LABEL_HOST = 'rls-saboteur.host';
export const LABEL_PID = 'rls-saboteur.pid';
export const LABEL_TOKEN = 'rls-saboteur.token';

export const NET_PREFIX = 'rls-saboteur-sandbox-net-';

/** The internal network that goes with a container (--from-files mode). Same id, so one name implies the other. */
export function netNameFor(containerName: string): string {
  const id = parseContainerName(containerName);
  if (!id) throw new DockerGuardError('bad container name');
  return `${NET_PREFIX}${id.host}-${id.pid}-${id.token}`;
}

/** The shell script `docker exec` runs in the container to carry one TCP connection to the server inside it. */
export const RELAY_SCRIPT = 'exec 3<>/dev/tcp/127.0.0.1/5432 || exit 1; cat <&3 & cat >&3; exit 0';

export function containerNameFor(host: string, pid: number, token: string): string {
  return `${CONTAINER_PREFIX}${host}-${pid}-${token}`;
}

export interface ContainerName {
  host: string;
  pid: number;
  token: string;
}

export function parseContainerName(name: string): ContainerName | null {
  const m = /^rls-saboteur-sandbox-([0-9a-f]{12})-(\d{1,10})-([0-9a-f]{16})$/.exec(name);
  return m ? { host: m[1], pid: Number(m[2]), token: m[3] } : null;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Pure rule: may this container be removed? Used by every removal.
 * It must carry the tool's name AND labels, the labels must agree with the name, and it must be a container of this run,
 * or one made by a dead process of this host. A container of another host, or of a live process, is never removed.
 */
export function removableContainer(
  name: string,
  labels: Record<string, string>,
  token: string,
  isAlive: (pid: number) => boolean = pidAlive,
  host: string = hostId()
): { ok: true } | { ok: false; why: string } {
  const id = parseContainerName(name);
  if (!id) return { ok: false, why: `"${name}" does not have the name of a sandbox container` };
  if (labels[LABEL_KEY] !== '1') return { ok: false, why: `"${name}" has no ${LABEL_KEY} label` };
  if (labels[LABEL_HOST] !== id.host || labels[LABEL_PID] !== String(id.pid) || labels[LABEL_TOKEN] !== id.token) {
    return { ok: false, why: `"${name}" has labels that do not match its name` };
  }
  if (id.token === token && id.host === host) return { ok: true };
  if (id.host === host && !isAlive(id.pid)) return { ok: true };
  return { ok: false, why: `"${name}" was not made by this run, and is not a container of a dead process of this host` };
}

/** The same rule as removableContainer, for the network of a container. */
export function removableNetwork(
  name: string,
  labels: Record<string, string>,
  token: string,
  isAlive: (pid: number) => boolean = pidAlive,
  host: string = hostId()
): { ok: true } | { ok: false; why: string } {
  const m = /^rls-saboteur-sandbox-net-([0-9a-f]{12})-(\d{1,10})-([0-9a-f]{16})$/.exec(name);
  if (!m) return { ok: false, why: `"${name}" does not have the name of a sandbox network` };
  const owner = containerNameFor(m[1], Number(m[2]), m[3]);
  return removableContainer(owner, labels, token, isAlive, host);
}

export class DockerGuardError extends Error {
  constructor(message: string) {
    super(`Refused by the Docker guard: ${message}`);
    this.name = 'DockerGuardError';
  }
}

/** Environment variable names the tool passes to `docker exec -e` (names only: the values never touch the command line). */
const EXEC_ENV = new Set(['PGPASSWORD', 'PGOPTIONS', 'PGHOST', 'PGPORT', 'PGUSER', 'PGDATABASE']);
const EXEC_PROGRAMS = new Set(['pg_dump', 'psql', 'pg_isready']);
export const IMAGE_PATTERN = /^[a-z0-9][a-zA-Z0-9._\/:@-]{0,200}$/;

/**
 * Throws unless these docker arguments have one of the shapes the tool sends. `ownName` is the container of this run.
 * Listing (`ps`) and `port`/`inspect` are reads. `rm` is checked again by removableContainer in the caller.
 */
export function checkDockerArgs(args: string[], ownName: string): void {
  const [verb, ...rest] = args;
  const same = (a: string[], b: string[]): boolean => a.length === b.length && a.every((x, i) => x === b[i]);
  switch (verb) {
    case 'run': {
      // docker run -d --rm --name N --label k=v x4 -e POSTGRES_PASSWORD
      //   then either  -p 127.0.0.1::5432 --add-host host.docker.internal:host-gateway IMAGE       (rows come from a dump)
      //   or           --network NET IMAGE   (NET is internal: no route to the host or the internet; files mode)
      const fixedHead = ['-d', '--rm', '--name'];
      if (!same(rest.slice(0, 3), fixedHead)) break;
      const name = rest[3];
      if (name !== ownName || !parseContainerName(name)) break;
      const id = parseContainerName(name)!;
      const labels = rest.slice(4, 12);
      const wantLabels = [
        '--label', `${LABEL_KEY}=1`,
        '--label', `${LABEL_HOST}=${id.host}`,
        '--label', `${LABEL_PID}=${id.pid}`,
        '--label', `${LABEL_TOKEN}=${id.token}`
      ];
      if (!same(labels, wantLabels)) break;
      const tail = rest.slice(12);
      const bridge = ['-e', 'POSTGRES_PASSWORD', '-p', '127.0.0.1::5432', '--add-host', 'host.docker.internal:host-gateway'];
      const isolated = ['-e', 'POSTGRES_PASSWORD', '--network', netNameFor(name)];
      const want = tail[2] === '--network' ? isolated : bridge;
      if (!same(tail.slice(0, want.length), want)) break;
      const image = tail[want.length];
      if (tail.length !== want.length + 1 || !image || image.startsWith('-') || !IMAGE_PATTERN.test(image)) break;
      return;
    }
    case 'network': {
      const [sub, ...r] = rest;
      const id = parseContainerName(ownName);
      if (!id) break;
      const labelArgs = ['--label', `${LABEL_KEY}=1`, '--label', `${LABEL_HOST}=${id.host}`, '--label', `${LABEL_PID}=${id.pid}`, '--label', `${LABEL_TOKEN}=${id.token}`];
      const own = netNameFor(ownName);
      if (sub === 'create' && same(r, ['--internal', ...labelArgs, own])) return;
      if (sub === 'rm' && r.length === 1 && /^rls-saboteur-sandbox-net-[0-9a-f]{12}-\d{1,10}-[0-9a-f]{16}$/.test(r[0])) return;
      if (sub === 'ls' && same(r, ['--filter', `label=${LABEL_KEY}=1`, '--format', `{{.Name}}\t{{.Label "${LABEL_HOST}"}}\t{{.Label "${LABEL_PID}"}}\t{{.Label "${LABEL_TOKEN}"}}\t{{.Label "${LABEL_KEY}"}}`])) return;
      break;
    }
    case 'port':
      if (same(rest, [ownName, '5432/tcp'])) return;
      break;
    case 'inspect':
      if (rest.length === 3 && rest[0] === '--format' && rest[1] === '{{.State.Running}}' && parseContainerName(rest[2])) return;
      break;
    case 'ps':
      if (same(rest, ['-a', '--filter', `label=${LABEL_KEY}=1`, '--format', `{{.Names}}\t{{.Label "${LABEL_HOST}"}}\t{{.Label "${LABEL_PID}"}}\t{{.Label "${LABEL_TOKEN}"}}\t{{.Label "${LABEL_KEY}"}}`])) return;
      break;
    case 'rm':
      // -v removes the anonymous volume of the image. Only a name of the tool's shape.
      if (rest.length === 3 && rest[0] === '-f' && rest[1] === '-v' && parseContainerName(rest[2])) return;
      break;
    case 'exec': {
      // docker exec [-i] [-e VAR]... NAME program args...
      let i = 0;
      if (rest[i] === '-i') i++;
      while (rest[i] === '-e') {
        if (!EXEC_ENV.has(rest[i + 1] ?? '')) throw new DockerGuardError(`exec may not pass the variable "${rest[i + 1]}"`);
        i += 2;
      }
      if (rest[i] !== ownName) break;
      const program = rest[i + 1];
      if (program === 'bash') {
        // The one shell command the tool sends: the relay that carries a TCP connection to the server in the container.
        if (same(rest.slice(i + 1), ['bash', '-c', RELAY_SCRIPT]) && i === 1) return; // exactly: exec -i NAME bash -c SCRIPT
        throw new DockerGuardError('exec may run bash only with the relay script');
      }
      if (!program || !EXEC_PROGRAMS.has(program)) throw new DockerGuardError(`exec may run only ${[...EXEC_PROGRAMS].join(', ')}, not "${program}"`);
      return;
    }
  }
  throw new DockerGuardError(`this docker command is not one the tool sends: docker ${args.slice(0, 3).join(' ')}${args.length > 3 ? ' ...' : ''}`);
}

export interface DockerResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Runs `docker` with a checked argument list and no shell. `env` is merged over the process environment. */
export function docker(args: string[], ownName: string, env: Record<string, string> = {}, timeoutMs = 120_000): DockerResult {
  checkDockerArgs(args, ownName);
  const r = spawnSync('docker', args, { encoding: 'utf8', env: { ...process.env, ...env }, timeout: timeoutMs, stdio: ['ignore', 'pipe', 'pipe'] });
  return { code: r.status, stdout: r.stdout ?? '', stderr: (r.stderr ?? '') + (r.error ? String(r.error.message) : '') };
}

/** A streaming docker exec, for the dump pipe. The same check applies. */
export function dockerSpawn(args: string[], ownName: string, env: Record<string, string> = {}): ChildProcess {
  checkDockerArgs(args, ownName);
  return spawn('docker', args, { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
}

/**
 * Starts a detached watchdog that removes the container when this process is gone (including kill -9) or when the
 * container is gone already. The script is fixed text; the name must have the tool's shape.
 */
export function startWatchdog(name: string, pid: number, net?: string): void {
  if (!parseContainerName(name)) throw new DockerGuardError('watchdog: bad container name');
  if (net !== undefined && net !== netNameFor(name)) throw new DockerGuardError('watchdog: bad network name');
  const script =
    'while kill -0 "$1" 2>/dev/null && docker inspect --format "{{.State.Running}}" "$2" >/dev/null 2>&1; do sleep 2; done; ' +
    'docker rm -f -v "$2" >/dev/null 2>&1; if [ -n "$3" ]; then docker network rm "$3" >/dev/null 2>&1; fi';
  const child = spawn('sh', ['-c', script, 'sh', String(pid), name, net ?? ''], { detached: true, stdio: 'ignore' });
  child.unref();
}
