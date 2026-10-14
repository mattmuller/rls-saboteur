const LOCAL_HOSTS = new Set([
  'localhost',
  '127.0.0.1',
  '::1',
  '[::1]',
  'host.docker.internal',
  'gateway.docker.internal',
  'kubernetes.docker.internal',
  'host.containers.internal'
]);

/**
 * True when the host is this machine or the Docker host.
 * Unix sockets (a path) count as local. So does a Supabase local container name.
 */
export function isLocalHost(host: string | undefined | null): boolean {
  if (!host) return false; // an unresolved host is never assumed local
  const h = host.toLowerCase();
  if (h.startsWith('/')) return true;
  if (LOCAL_HOSTS.has(h)) return true;
  if (h.endsWith('.localhost')) return true;
  // A Supabase container name is one DNS label. A dotted name such as supabase_db_x.evil.com is a real host.
  if (/^supabase_db_[a-z0-9_-]+$/.test(h)) return true;
  return false;
}

export const REMOTE_FLAG = '--allow-remote-i-understand-this-locks-tables';

/** Environment variables that can redirect a connection that does not name its own host. */
const REDIRECT_ENV = ['PGHOST', 'PGHOSTADDR', 'PGSERVICE', 'PGSERVICEFILE'];

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

function splitHosts(raw: string): string[] {
  return raw
    .split(',')
    .map((h) => safeDecode(h.trim()).replace(/^\[|\]$/g, ''))
    .filter((h) => h !== '');
}

export interface Resolved {
  /** The URL with its host written out and the redirecting query parameters removed. */
  url: string;
  /** Every host the connection could reach, from the URL, its query and the environment. */
  hosts: string[];
  /** True when a pg_service.conf entry is selected, which can set any host. */
  usesService: boolean;
}

/**
 * Work out where a connection will really go. This mirrors node-postgres
 * (pg-connection-string 2.x): a `host` query parameter wins over the URL host,
 * and an empty host falls back to PGHOST, then to localhost. libpq, which psql and
 * the Supabase CLI use, also honours `hostaddr`, PGHOSTADDR and a service entry,
 * so those are counted too. Every candidate must be local for the guard to pass.
 */
export function resolveConnection(dbUrl: string, env: NodeJS.ProcessEnv = process.env): Resolved {
  // Same two-step parse as pg-connection-string: an empty host (user@/db) needs a stand-in.
  let u: URL;
  let dummy = false;
  try {
    u = new URL(dbUrl);
  } catch {
    try {
      u = new URL(dbUrl.replace('@/', '@___DUMMY___/'));
      dummy = true;
    } catch {
      throw new Error('Cannot read a host from the database URL.');
    }
  }
  const urlHostname = dummy ? '' : u.hostname;
  const q = u.searchParams;
  const queryHost = splitHosts(q.get('host') ?? '');
  const urlHost = splitHosts(urlHostname);
  const pgHost = queryHost.length ? queryHost : urlHost.length ? urlHost : splitHosts(env.PGHOST ?? '');
  const hosts = [...pgHost, ...splitHosts(q.get('hostaddr') ?? ''), ...splitHosts(env.PGHOSTADDR ?? '')];
  const effective = pgHost.length ? pgHost : ['localhost'];
  const usesService = Boolean(q.get('service')) || Boolean(env.PGSERVICE);

  const out = u;
  out.searchParams.delete('host');
  out.searchParams.delete('hostaddr');
  out.searchParams.delete('service');
    if (dummy) out.hostname = '';
  if (effective.length === 1 && !effective[0].startsWith('/')) {
    out.hostname = effective[0].includes(':') ? `[${effective[0]}]` : effective[0];
  } else if (pgHost.length) {
    // A socket path or a list stays in the query, where both pg and libpq read it.
    out.searchParams.set('host', effective.join(','));
  }
  return { url: out.toString(), hosts: hosts.length ? hosts : effective, usesService };
}

/** Remove the variables that could redirect a connection, once the URL has been resolved. */
export function stripRedirectEnv(env: NodeJS.ProcessEnv = process.env): void {
  for (const k of REDIRECT_ENV) delete env[k];
}

/** True when every host this URL could reach is local. */
export function urlIsLocal(dbUrl: string, env: NodeJS.ProcessEnv = process.env): boolean {
  try {
    return resolveConnection(dbUrl, env).hosts.every((h) => isLocalHost(h));
  } catch {
    return false;
  }
}

export function hostOf(dbUrl: string): string {
  return resolveConnection(dbUrl).hosts.join(', ');
}

/** Returns an error message when the run must be refused, or null when it may go ahead. */
export function remoteRefusal(dbUrl: string, allowRemote: boolean, env: NodeJS.ProcessEnv = process.env): string | null {
  if (allowRemote) return null;
  const r = resolveConnection(dbUrl, env);
  if (r.usesService) {
    return (
      `Refusing to run: the connection names a service (PGSERVICE or ?service=). ` +
      `A pg_service.conf entry can point anywhere, so it cannot be checked.\n` +
      `Use a plain --db-url, or pass ${REMOTE_FLAG} if you accept the risk.`
    );
  }
  const remote = r.hosts.filter((h) => !isLocalHost(h));
  if (remote.length === 0) return null;
  return (
    `Refusing to run against "${remote.join(', ')}". It is not a local database.\n` +
    `Breaking a policy on a live database takes a lock and can stall it.\n` +
    `Point --db-url at a local database. Or pass ${REMOTE_FLAG} if you accept the risk.`
  );
}
