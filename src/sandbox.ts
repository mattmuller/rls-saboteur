import { randomBytes } from 'node:crypto';
import net from 'node:net';
import { withDatabase } from './config.js';
import {
  CONTAINER_PREFIX,
  LABEL_HOST,
  LABEL_KEY,
  LABEL_PID,
  LABEL_TOKEN,
  RELAY_SCRIPT,
  containerNameFor,
  docker,
  dockerSpawn,
  removableContainer,
  startWatchdog
} from './docker.js';
import { Guard, databaseOf, hostId, newToken, type Db } from './guard.js';
import { createIsolation, type Isolation, type IsolationOptions } from './isolation.js';
import type { BuildFiles } from './files.js';
import { loadFiles, pgCronHint } from './files.js';
import { isLocalHost } from './safety.js';
import { qi } from './sql.js';
import { scrubSecrets } from './config.js';

/**
 * Sandbox mode. The copies live in a throwaway PostgreSQL container, not on the server that holds your database.
 *
 * The container is the whole "server" for the run. Everything after the first copy is the same code as the default mode,
 * pointed at the container: the master template, a copy per break, the guard, the sweep. Nothing needs the source's
 * sessions closed, because the source is only read (pg_dump) or not read at all (--from-files).
 *
 * Cleanup has three layers: the normal path and the signal handler remove the container; a detached watchdog removes it
 * if this process dies by kill -9; and the next run removes any container of this host whose process is dead.
 */

export interface Sandbox {
  name: string;
  /** True when the container has no network at all (--network none). This tool reaches it through docker exec. */
  isolated: boolean;
  port: number;
  user: string;
  password: string;
  /** URL of a database in the container. Loopback only. */
  url(db: string): string;
  /** Proves again that the server asks for a password. Run after anything of yours has run in the container. */
  checkAuth(): Promise<void>;
  /** Removes the container. Returns true when it is gone. */
  remove(): Promise<boolean>;
}

const READY_TIMEOUT_MS = 120_000;

function lines(s: string): string[] {
  return s.split(/\r?\n/).filter(Boolean);
}

/** Removes containers of this tool, made by dead processes of this host. Returns the names removed. */
export function sweepContainers(token: string, own: string): string[] {
  const out = docker(
    ['ps', '-a', '--filter', `label=${LABEL_KEY}=1`, '--format', `{{.Names}}\t{{.Label "${LABEL_HOST}"}}\t{{.Label "${LABEL_PID}"}}\t{{.Label "${LABEL_TOKEN}"}}\t{{.Label "${LABEL_KEY}"}}`],
    own
  );
  const removed: string[] = [];
  if (out.code !== 0) return removed;
  for (const l of lines(out.stdout)) {
    const [name, host, pid, tok, key] = l.split('\t');
    const ok = removableContainer(name, { [LABEL_KEY]: key, [LABEL_HOST]: host, [LABEL_PID]: pid, [LABEL_TOKEN]: tok }, token);
    if (!ok.ok) continue;
    if (docker(['rm', '-f', '-v', name], own).code === 0) removed.push(name);
  }
  return removed;
}

const MAX_RELAYED = 64;

/** Carries TCP connections from this machine to the server inside an isolated container, one `docker exec` each. */
function startRelay(name: string): Promise<{ port: number; close(): void }> {
  const children = new Set<ReturnType<typeof dockerSpawn>>();
  const server = net.createServer((sock) => {
    // Another process on this machine can connect to this port. A password stops it, and this cap stops it from filling
    // the process table with `docker exec` children.
    if (children.size >= MAX_RELAYED) {
      sock.destroy();
      return;
    }
    const ch = dockerSpawn(['exec', '-i', name, 'bash', '-c', RELAY_SCRIPT], name);
    children.add(ch);
    const end = (): void => {
      sock.destroy();
      ch.kill();
      children.delete(ch);
    };
    ch.stdin?.on('error', () => {});
    ch.stdout?.on('error', () => {});
    sock.on('error', end);
    sock.on('close', end);
    ch.on('error', end);
    ch.on('close', end);
    sock.pipe(ch.stdin!);
    ch.stdout!.pipe(sock);
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      resolve({
        port: (server.address() as net.AddressInfo).port,
        close: () => {
          server.close();
          for (const c of children) c.kill();
        }
      });
    });
  });
}

export async function startSandbox(image: string, token: string, isolated = false): Promise<Sandbox> {
  const name = containerNameFor(hostId(), process.pid, token);
  const v = docker(['ps', '-a', '--filter', `label=${LABEL_KEY}=1`, '--format', `{{.Names}}\t{{.Label "${LABEL_HOST}"}}\t{{.Label "${LABEL_PID}"}}\t{{.Label "${LABEL_TOKEN}"}}\t{{.Label "${LABEL_KEY}"}}`], name);
  if (v.code !== 0) throw new Error(`Docker is not available (${scrubSecrets(v.stderr.trim() || 'no answer from the docker command', [])}). Sandbox mode needs a running Docker.`);
  sweepContainers(token, name);

  const labels = ['--label', `${LABEL_KEY}=1`, '--label', `${LABEL_HOST}=${hostId()}`, '--label', `${LABEL_PID}=${process.pid}`, '--label', `${LABEL_TOKEN}=${token}`];
  const password = randomBytes(18).toString('hex');
  let relay: { port: number; close(): void } | undefined;
  const remove = async (): Promise<boolean> => {
    relay?.close();
    docker(['rm', '-f', '-v', name], name);
    const gone = docker(['inspect', '--format', '{{.State.Running}}', name], name).code !== 0; // inspect fails once the container is gone
    return gone;
  };
  const run = docker(
    [
      'run', '-d', '--rm', '--name', name, ...labels, '-e', 'POSTGRES_PASSWORD', '-e', 'POSTGRES_INITDB_ARGS',
      ...(isolated ? ['--network', 'none'] : ['-p', '127.0.0.1::5432', '--add-host', 'host.docker.internal:host-gateway']),
      image
    ],
    name,
    // scram-sha-256 on host (TCP) connections too, so a client that reaches the relay needs the password.
    { POSTGRES_PASSWORD: password, POSTGRES_INITDB_ARGS: '--auth-host=scram-sha-256' },
    600_000
  );
  if (run.code !== 0) {
    await remove();
    throw new Error(`Could not start the sandbox container from image "${image}": ${run.stderr.trim().split('\n').slice(-3).join(' ')}`);
  }
  startWatchdog(name, process.pid);
  try {
    relay = isolated ? await startRelay(name) : undefined;
    const port = relay ? relay.port : readPort(name);
    const user = await waitReady(port, password, name);
    // Every client of the relay (and of the published port) must need the password. Prove it with a wrong one.
    const checkAuth = async (): Promise<void> => {
      await assertAuthEnforced(
        (u, pw, db) => `postgres://${encodeURIComponent(u)}:${pw}@127.0.0.1:${port}/${db}`,
        user,
        async (url) => new Guard({ sourceUrl: url, allowTerminate: false }).connect(url)
      );
      const okUrl = `postgres://${user}:${password}@127.0.0.1:${port}/postgres`;
      const c = await new Guard({ sourceUrl: okUrl, allowTerminate: false }).connect(okUrl);
      try {
        await assertNoPasswordlessHostRules((sql) => c.query(sql));
      } finally {
        await c.end().catch(() => {});
      }
    };
    await checkAuth();
    return {
      checkAuth,
      name,
      isolated,
      port,
      user,
      password,
      url: (db) => withDatabase(`postgres://${user}:${password}@127.0.0.1:${port}/postgres`, db),
      remove
    };
  } catch (e) {
    await remove();
    throw e;
  }
}

function readPort(name: string): number {
  const r = docker(['port', name, '5432/tcp'], name);
  const m = /127\.0\.0\.1:(\d+)/.exec(r.stdout);
  if (r.code !== 0 || !m) throw new Error(`Could not read the port of the sandbox container (${r.stderr.trim()})`);
  return Number(m[1]);
}

/**
 * SQLSTATE 28P01 is "password authentication failed". 28000 ("invalid authorization specification") is NOT accepted: on a
 * rule that trusts everyone, a user that does not exist also gets 28000 ("role does not exist"), so it proves nothing.
 */
const AUTH_REFUSED = new Set(['28P01']);

/**
 * Proves the server asks for a password. It tries two logins that must be refused AS AN AUTHENTICATION FAILURE:
 * the right user with a wrong password, and a random user that does not exist on a database other than "postgres"
 * (a rule that trusts one user or one database would let the second in). Any other error (a refused connection, a server
 * that is still starting, a missing database) is not a refusal, and stops the run: a check that cannot run proves nothing.
 */
export async function assertAuthEnforced(
  urlFor: (user: string, password: string, db: string) => string,
  user: string,
  connect: (url: string) => Promise<{ end(): Promise<void> }>
): Promise<void> {
  const probes = [
    { user, db: 'postgres', what: 'the right user with a wrong password' },
    { user: `nobody_${randomBytes(6).toString('hex')}`, db: 'template1', what: 'a user that does not exist, on another database' }
  ];
  for (const p of probes) {
    const wrong = `wrong-${randomBytes(8).toString('hex')}`;
    let db: { end(): Promise<void> } | undefined;
    try {
      db = await connect(urlFor(p.user, wrong, p.db));
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (code && AUTH_REFUSED.has(code)) continue; // refused by authentication: the good case
      throw new Error(`could not check that the sandbox asks for a password (${p.what}): ${(e as Error).message}`);
    }
    await db.end().catch(() => {});
    throw new Error(
      `the sandbox lets a client in without the right password (${p.what}). Its pg_hba.conf trusts that connection. ` +
        'Any process on this machine that reaches the sandbox port could then use the database. Use an image that asks for the password, such as the official postgres image.'
    );
  }
}

/** Host rules whose method needs no password. "reject" is fine. Local (socket) rules are not listed: only the container can use them. */
export const PASSWORDLESS_RULES_SQL = `select line_number, type, database::text as database, user_name::text as user_name, address, auth_method
  from pg_hba_file_rules where type like 'host%' and auth_method not in ('scram-sha-256', 'md5', 'password', 'reject') order by line_number`;

export async function assertNoPasswordlessHostRules(query: (sql: string) => Promise<{ rows: Record<string, unknown>[] }>): Promise<void> {
  const r = await query(PASSWORDLESS_RULES_SQL);
  if (r.rows.length) {
    const first = r.rows[0];
    throw new Error(
      `the sandbox's pg_hba.conf has ${r.rows.length} host rule(s) that need no password (line ${String(first.line_number)}: ${String(first.type)} ${String(first.database)} ${String(first.user_name)} ${String(first.address ?? '')} ${String(first.auth_method)}). ` +
        'A process on this machine that reaches the sandbox port could use the database. Use an image that asks for the password, such as the official postgres image.'
    );
  }
}

/** Waits until a TCP login works, then picks the first superuser: postgres, or supabase_admin on a Supabase image. */
async function waitReady(port: number, password: string, name: string): Promise<string> {
  const end = Date.now() + READY_TIMEOUT_MS;
  let last = '';
  while (Date.now() < end) {
    if (docker(['inspect', '--format', '{{.State.Running}}', name], name).stdout.trim() === 'false') break;
    for (const user of ['postgres', 'supabase_admin']) {
      const url = `postgres://${user}:${password}@127.0.0.1:${port}/postgres`;
      const g = new Guard({ sourceUrl: url, allowTerminate: false });
      let db: Db | undefined;
      try {
        db = await g.connect(url);
        const r = await db.query('select rolsuper from pg_roles where rolname = current_user');
        if (r.rows[0]?.rolsuper === true) {
          await new Promise((res) => setTimeout(res, 500)); // a second login proves the final server is up
          return user;
        }
        last = `${user} is not a superuser`;
      } catch (e) {
        last = (e as Error).message;
      } finally {
        await db?.end().catch(() => {});
      }
    }
    await new Promise((res) => setTimeout(res, 1000));
  }
  throw new Error(`The sandbox container did not become ready (${last}). Check that the image is a PostgreSQL image.`);
}

/** Text of a role script: create the roles the source has and the container lacks, without passwords or superuser. */
/**
 * A role name goes into SQL that psql reads, so a name that could end a quoted string, start a psql meta-command or hide
 * a line is refused, never quoted around. Postgres allows such names; the tool does not copy them.
 */
export function unsafeRoleName(name: string): boolean {
  return /[$\\\u0000\r\n\u2028\u2029]/.test(name);
}

export function rolesScript(rows: { rolname: string; rolinherit: boolean; rolcreaterole: boolean; rolcreatedb: boolean; rolcanlogin: boolean; rolreplication: boolean; rolbypassrls: boolean }[], members: { role: string; member: string }[], skip: string): string {
  const lit = (s: string): string => `'${s.replace(/'/g, "''")}'`;
  // A fresh tag for every script: a role name cannot be written to match it, and names holding $ are refused anyway.
  const tag = `sab${randomBytes(8).toString('hex')}`;
  const out: string[] = [];
  for (const name of [...rows.map((r) => r.rolname), ...members.flatMap((m) => [m.role, m.member])]) {
    if (name === skip || name.startsWith('pg_')) continue;
    if (unsafeRoleName(name)) {
      throw new Error(
        `sandbox: the role "${name.replace(/[^\x20-\x7e]/g, '?')}" has a name with a $, a backslash or a line break in it. ` +
          `The sandbox does not copy such names, because they could change the script that creates roles. Rename the role, or use --from-files.`
      );
    }
  }
  for (const r of rows) {
    if (r.rolname === skip || r.rolname.startsWith('pg_')) continue;
    const flags = [
      'NOSUPERUSER',
      r.rolinherit ? 'INHERIT' : 'NOINHERIT',
      r.rolcreaterole ? 'CREATEROLE' : 'NOCREATEROLE',
      r.rolcreatedb ? 'CREATEDB' : 'NOCREATEDB',
      r.rolcanlogin ? 'LOGIN' : 'NOLOGIN',
      r.rolreplication ? 'REPLICATION' : 'NOREPLICATION',
      r.rolbypassrls ? 'BYPASSRLS' : 'NOBYPASSRLS'
    ].join(' ');
    out.push(`do $${tag}$ begin if not exists (select 1 from pg_roles where rolname = ${lit(r.rolname)}) then create role ${qi(r.rolname)} ${flags}; end if; end $${tag}$;`);
  }
  for (const m of members) {
    if (m.role.startsWith('pg_') || m.member.startsWith('pg_') || m.role === skip || m.member === skip) continue;
    out.push(`do $${tag}$ begin grant ${qi(m.role)} to ${qi(m.member)}; exception when others then null; end $${tag}$;`);
  }
  return out.join('\n') + '\n';
}

/**
 * The environment of the pg_dump process. PGOPTIONS makes the server itself refuse a write on the dump session,
 * as the guard does for the source session.
 */
export function dumpEnvFor(dbUrl: string): Record<string, string> {
  const u = new URL(dbUrl);
  return {
    PGPASSWORD: decodeURIComponent(u.password),
    PGOPTIONS: '-c default_transaction_read_only=on',
    PGHOST: containerHostFor(decodeURIComponent(u.hostname)),
    PGPORT: u.port || '5432',
    PGUSER: decodeURIComponent(u.username),
    PGDATABASE: databaseOf(dbUrl)
  };
}

/** The host name a container uses to reach the source on the host machine. */
export function containerHostFor(host: string): string {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase();
  return h === 'localhost' || h === '127.0.0.1' || h === '::1' ? 'host.docker.internal' : host;
}

function pipeInto(
  sb: Sandbox,
  producer: { args: string[]; env: Record<string, string> } | null,
  consumer: { args: string[]; input?: string },
  urls: string[]
): Promise<void> {
  return new Promise((resolve, reject) => {
    const load = dockerSpawn(consumer.args, sb.name, { PGPASSWORD: sb.password });
    const dump = producer ? dockerSpawn(producer.args, sb.name, producer.env) : null;
    let errLoad = '';
    let errDump = '';
    load.stderr?.on('data', (d: Buffer) => (errLoad = (errLoad + d.toString()).slice(-8000)));
    dump?.stderr?.on('data', (d: Buffer) => (errDump = (errDump + d.toString()).slice(-8000)));
    load.stdin?.on('error', () => {});
    if (dump) dump.stdout?.pipe(load.stdin!);
    else {
      load.stdin?.end(consumer.input ?? '');
    }
    let codes: Record<string, number | null> = {};
    const finish = (): void => {
      if (!('load' in codes) || (dump && !('dump' in codes))) return;
      if (codes.load === 0 && (!dump || codes.dump === 0)) return resolve();
      const text = scrubSecrets(`${errDump}\n${errLoad}`.trim().split('\n').slice(-12).join('\n'), urls);
      reject(new Error(text || 'the sandbox load failed with no message'));
    };
    load.on('error', (e) => reject(e));
    dump?.on('error', (e) => reject(e));
    load.on('close', (c) => {
      codes = { ...codes, load: c };
      finish();
    });
    dump?.on('close', (c) => {
      codes = { ...codes, dump: c };
      finish();
    });
  });
}

export interface SandboxIsolationOptions {
  /** The real database. Read for the catalogue and, without files, dumped (read only) into the container. */
  dbUrl: string;
  image: string;
  /** Build from files instead of dumping the database. */
  files: BuildFiles | null;
  cwd: string;
  isolateNetwork?: boolean;
  masks?: IsolationOptions['masks'];
  prepareMaster?: IsolationOptions['prepareMaster'];
  verifyMaster?: IsolationOptions['verifyMaster'];
  cleanupWaitMs?: number;
}

export async function createSandboxIsolation(o: SandboxIsolationOptions): Promise<Isolation> {
  const token = newToken();
  const name = containerNameFor(hostId(), process.pid, token);
  let sb: Sandbox | undefined;
  let signalled = false;
  // Installed BEFORE the container starts, so a Ctrl-C during the image pull or the start-up still removes it.
  const removeNow = async (): Promise<boolean> => {
    if (sb) return sb.remove();
    docker(['rm', '-f', '-v', name], name);
    return docker(['inspect', '--format', '{{.State.Running}}', name], name).code !== 0;
  };
  const onSignal = (sig: NodeJS.Signals): void => {
    if (signalled) return;
    signalled = true;
    const code = sig === 'SIGINT' ? 130 : 143;
    removeNow()
      .then((gone) => {
        if (!gone) {
          process.stderr.write(`rls-saboteur could not remove its sandbox container. Remove it yourself: docker rm -f -v ${name}\n`);
          process.exit(1);
        }
        process.exit(code);
      })
      .catch(() => process.exit(1));
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  const uninstall = (): void => {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
  };
  try {
    sb = await startSandbox(o.image, token, o.files !== null);
  } catch (e) {
    if (signalled) await new Promise<never>(() => {});
    uninstall();
    throw e;
  }
  const box = sb;
  const afterCleanup = async (): Promise<void> => {
    const gone = await box.remove();
    uninstall();
    if (!gone) throw new Error(`rls-saboteur could not remove its sandbox container. Remove it yourself: docker rm -f -v ${box.name}`);
  };
  try {
    const sourceUrl = box.url('postgres');
    const sourceGuardUrls = [o.dbUrl, sourceUrl];
    const iso = await createIsolation({
      sourceUrl,
      terminate: false,
      isolateNetwork: o.isolateNetwork,
      masks: o.masks,
      prepareMaster: o.prepareMaster,
      verifyMaster: o.verifyMaster,
      cleanupWaitMs: o.cleanupWaitMs,
      manageSignals: false,
      emptyMaster: true,
      build: async (masterUrl, guard, between) => {
        if (o.files) {
          const m = await guard.connect(masterUrl);
          try {
            await loadFiles(m, o.cwd, o.files, between);
          } finally {
            await m.end().catch(() => {});
          }
        } else {
          await dumpInto(sb, o.dbUrl, databaseOf(masterUrl), sourceGuardUrls);
        }
        // Your files (or the restored dump) have run as superuser. They could have loosened pg_hba.conf and reloaded it.
        await box.checkAuth();
      }
    });
    const notes = [
      `Sandbox: the copies live in the container ${box.name} (image ${o.image}), reached on 127.0.0.1:${box.port}. ` +
        (box.isolated ? 'The container has no network at all (docker --network none). ' : 'The container is on the default Docker network, so it can reach this machine and the internet. ') +
        'The container is removed when the run ends.',
      ...iso.notes
    ];
    let disposed = false;
    return {
      mode: 'sandbox',
      notes,
      withBreak: (b, fn) => iso.withBreak(b, fn),
      withPristine: (fn) => iso.withPristine(fn),
      masked: iso.masked,
      async dispose() {
        if (signalled) await new Promise<never>(() => {});
        if (disposed) return;
        disposed = true;
        try {
          await iso.dispose();
        } finally {
          await afterCleanup();
        }
      }
    };
  } catch (e) {
    if (signalled) await new Promise<never>(() => {});
    await afterCleanup().catch((x) => {
      (e as Error).message += `\n${(x as Error).message}`;
    });
    throw e;
  }
}

/** Copies the source into the master database inside the container: roles first, then pg_dump piped into psql. */
async function dumpInto(sb: Sandbox, dbUrl: string, masterDb: string, urls: string[]): Promise<void> {
  const u = new URL(dbUrl);
  const host = decodeURIComponent(u.hostname);
  if (!isLocalHost(host)) throw new Error('sandbox: the source host is not local');
  // Roles and memberships, read from the source with plain selects.
  const guard = new Guard({ sourceUrl: dbUrl, allowTerminate: false });
  const src = await guard.connect(dbUrl);
  let script: string;
  try {
    const roles = await src.query(
      `select rolname::text, rolinherit, rolcreaterole, rolcreatedb, rolcanlogin, rolreplication, rolbypassrls from pg_roles order by 1`
    );
    const mem = await src.query(
      `select r.rolname::text as role, m.rolname::text as member from pg_auth_members a
         join pg_roles r on r.oid = a.roleid join pg_roles m on m.oid = a.member order by 1, 2`
    );
    script = rolesScript(roles.rows, mem.rows, sb.user);
  } finally {
    await src.end().catch(() => {});
  }
  const psqlArgs = (db: string, single: boolean): string[] => [
    'exec', '-i', '-e', 'PGPASSWORD', sb.name, 'psql', '-X', '-q', '-v', 'ON_ERROR_STOP=1', ...(single ? ['--single-transaction'] : []),
    '-h', '127.0.0.1', '-U', sb.user, '-d', db
  ];
  await pipeInto(sb, null, { args: psqlArgs('postgres', false), input: script }, urls);
  const dumpEnv = dumpEnvFor(dbUrl);
  await pipeInto(
    sb,
    {
      args: ['exec', '-e', 'PGPASSWORD', '-e', 'PGOPTIONS', '-e', 'PGHOST', '-e', 'PGPORT', '-e', 'PGUSER', '-e', 'PGDATABASE', sb.name, 'pg_dump', '--no-publications', '--no-subscriptions', '--no-tablespaces'],
      env: dumpEnv
    },
    { args: psqlArgs(masterDb, true) },
    urls
  ).catch((e: Error) => {
    throw new Error(
      `sandbox: loading the dump into the container failed:\n${e.message}${pgCronHint(e.message)}\n` +
        `A source that uses extensions or schemas the image lacks needs a different --sandbox-image, ` +
        `and a Supabase source needs --from-files (the Supabase image already holds the managed schemas).`
    );
  });
}

export { CONTAINER_PREFIX };
