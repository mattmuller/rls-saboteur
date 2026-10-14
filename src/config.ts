import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { urlIsLocal } from './safety.js';
import { safeParams } from './urls.js';

const LOCAL_DEFAULT_PASSWORDS = new Set(['postgres', 'password', 'supabase']);

/** Read `[db] port` from a Supabase config.toml. Only that one key; this is not a TOML parser. */
export function readDbPort(toml: string): number | null {
  let section = '';
  for (const raw of toml.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) continue;
    const sec = /^\[([^\]]+)\]$/.exec(line);
    if (sec) {
      section = sec[1].trim();
      continue;
    }
    if (section === 'db') {
      const m = /^port\s*=\s*(\d+)$/.exec(line);
      if (m) return Number(m[1]);
    }
  }
  return null;
}

export interface Discovered {
  dbUrl: string;
  source: string;
}

export const DEFAULT_LOCAL_PORT = 54322;

export function discoverDbUrl(cwd: string, override?: string): Discovered {
  if (override) return { dbUrl: override, source: '--db-url' };
  const file = join(cwd, 'supabase', 'config.toml');
  let port = DEFAULT_LOCAL_PORT;
  let source = 'local Supabase default port';
  if (existsSync(file)) {
    const found = readDbPort(readFileSync(file, 'utf8'));
    if (found) {
      port = found;
      source = 'local Supabase, found from supabase/config.toml';
    }
  }
  return { dbUrl: `postgres://postgres:postgres@127.0.0.1:${port}/postgres`, source };
}

export interface SkipRule {
  policy: string;
  table?: string;
  reason: string;
}

export interface FileConfig {
  schemas?: string[];
  test?: string;
  threshold?: number;
  skip?: SkipRule[];
}

export const CONFIG_FILE = '.rls-saboteur.json';

export function readFileConfig(cwd: string): FileConfig {
  const file = join(cwd, CONFIG_FILE);
  if (!existsSync(file)) return {};
  let cfg: FileConfig;
  try {
    cfg = JSON.parse(readFileSync(file, 'utf8')) as FileConfig;
  } catch (e) {
    throw new Error(`${CONFIG_FILE} is not valid JSON: ${(e as Error).message}`);
  }
  for (const s of cfg.skip ?? []) {
    if (!s.policy || !s.reason?.trim()) {
      throw new Error(`${CONFIG_FILE}: every skip needs a "policy" and a written "reason".`);
    }
  }
  return cfg;
}

/**
 * Show a URL without credentials. User, password and the whole query string are
 * dropped, because a query string can carry password=, sslpassword=, sslkey= and similar.
 */
export function redact(dbUrl: string): string {
  try {
    const u = new URL(dbUrl);
    const hadQuery = u.search !== '';
    u.password = '';
    u.username = '';
    u.search = '';
    u.hash = '';
    return u.toString() + (hadQuery ? '?\u2026' : '');
  } catch {
    return '(database)';
  }
}

/**
 * Build the URL of another database on the same server. The URL is made from parsed parts: user,
 * password, host, port and the new database name. Only parameters that change how we talk (sslmode and
 * the like) are carried over. A query parameter such as dbname, host or options is dropped, because a
 * libpq runner would let it override the database written in the path.
 */
export function withDatabase(dbUrl: string, database: string): string {
  const src = new URL(dbUrl);
  const u = new URL(`${src.protocol}//placeholder`);
  u.username = src.username;
  u.password = src.password;
  u.hostname = src.hostname;
  u.port = src.port;
  u.pathname = '/' + encodeURIComponent(database);
  for (const [k, v] of safeParams(src)) u.searchParams.append(k, v);
  return u.toString();
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/**
 * Remove credentials from text that came from outside: test output, child
 * process errors, driver messages. psql, pg_prove and the Supabase CLI can echo
 * a connection string, and a copy's URL carries the same password.
 *
 * Known URLs are replaced by their redacted form, raw and percent-decoded. Then
 * any user:password@ in a URL, and any password=... / PGPASSWORD=... token, is masked.
 */
export function scrubSecrets(text: string, knownUrls: string[] = []): string {
  let out = text;
  for (const url of knownUrls) {
    if (!url) continue;
    const safe = redact(url);
    const decoded = safeDecode(url);
    for (const form of new Set([url, decoded])) out = out.split(form).join(safe);
    try {
      const u = new URL(url);
      const pw = u.password;
      if (pw) {
        // A well-known local default (postgres:postgres on localhost) is not a secret, and
        // replacing the bare word would erase "postgres" from ordinary text. Every other
        // password is replaced bare, whatever it equals and however short it is. The
        // full-URL replacement above has already run regardless.
        const localDefault = LOCAL_DEFAULT_PASSWORDS.has(safeDecode(pw)) && urlIsLocal(url);
        if (!localDefault) {
          for (const form of new Set([pw, safeDecode(pw)])) {
            if (form.length >= 3) out = out.split(form).join('***');
          }
        }
      }
    } catch {
      /* not a URL */
    }
  }
  // Userinfo runs to the LAST @ before the host, so a password holding / or @ is covered.
  out = out.replace(/(postgres(?:ql)?:\/\/)[^\s]*@(?=[^\s@]+(?:[/?\s]|$))/gi, '$1***@');
  // Query-string and libpq keyword forms.
  out = out.replace(/\b(PGPASSWORD|(?:ssl)?password|sslkey|sslcert)\s*=\s*('[^']*'|\\?"[^"]*?\\?"|[^\s'"&]+)/gi, '$1=***');
  return out;
}
