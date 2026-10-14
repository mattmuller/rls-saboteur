/**
 * Connection URLs. A libpq-based runner (psql, the Supabase CLI) reads these query parameters and lets
 * them override the database, host or user written in the URL. A URL such as
 * postgres://u:p@127.0.0.1:5432/src?dbname=src sends such a runner to "src" even when we built
 * the URL to name a copy. So a URL we are given may not carry any of them, and every URL we build
 * is made from parsed parts, never from the text we were given.
 */
export const CONNECTION_PARAMS = [
  'dbname',
  'database',
  'host',
  'hostaddr',
  'port',
  'service',
  'servicefile',
  'options',
  'user',
  'target_session_attrs',
  'replication',
  'load_balance_hosts'
];

/** Parameters that are safe to carry onto a copy's URL: they change how we talk, never where. */
const KEEP_PARAMS = new Set([
  'sslmode',
  'sslrootcert',
  'sslcert',
  'sslkey',
  'sslpassword',
  'ssl',
  'channel_binding',
  'gssencmode',
  'sslnegotiation',
  'connect_timeout',
  'application_name'
]);

/** Query parameters of `url` that are safe to keep, lower-cased names. */
export function safeParams(url: URL): [string, string][] {
  const out: [string, string][] = [];
  for (const [k, v] of url.searchParams) if (KEEP_PARAMS.has(k.toLowerCase())) out.push([k, v]);
  return out;
}

/**
 * Returns a message when a URL given with `flag` must be refused, or null. Never echoes the password.
 */
export function connectionParamProblem(rawUrl: string, flag: string): string | null {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    return `${flag} is not a valid database URL.`;
  }
  if (u.protocol !== 'postgres:' && u.protocol !== 'postgresql:') {
    return `${flag} must start with postgres:// or postgresql://.`;
  }
  const hit = [...new Set([...u.searchParams.keys()].map((k) => k.toLowerCase()))].filter((k) => CONNECTION_PARAMS.includes(k));
  if (hit.length) {
    return (
      `${flag} carries the connection parameter(s) ${hit.map((k) => `"${k}"`).join(', ')} in its query string. ` +
      `psql and the Supabase CLI let such a parameter override the database, host or user in the URL, ` +
      `so a run could end up on a different database than the copy. ` +
      `Write the database, host, port and user in the URL itself, and remove the query parameters.`
    );
  }
  if (u.hostname.includes(',')) return `${flag} names more than one host. Give one host.`;
  return null;
}
