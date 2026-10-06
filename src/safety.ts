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
  if (!host) return true; // libpq default: unix socket
  const h = host.toLowerCase();
  if (h.startsWith('/')) return true;
  if (LOCAL_HOSTS.has(h)) return true;
  if (h.endsWith('.localhost')) return true;
  if (h.startsWith('supabase_db_')) return true;
  return false;
}

export const REMOTE_FLAG = '--allow-remote-i-understand-this-locks-tables';

export function hostOf(dbUrl: string): string {
  try {
    const u = new URL(dbUrl);
    // URL keeps brackets on IPv6 hosts.
    return u.hostname.replace(/^\[|\]$/g, '');
  } catch {
    throw new Error(`Cannot read a host from the database URL.`);
  }
}

/** Returns an error message when the run must be refused, or null when it may go ahead. */
export function remoteRefusal(dbUrl: string, allowRemote: boolean): string | null {
  const host = hostOf(dbUrl);
  if (isLocalHost(host) || allowRemote) return null;
  return (
    `Refusing to run against "${host}". It is not a local database.\n` +
    `Breaking a policy on a live database takes a lock and can stall it.\n` +
    `Point --db-url at a local database. Or pass ${REMOTE_FLAG} if you accept the risk.`
  );
}
