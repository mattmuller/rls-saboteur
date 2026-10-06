import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

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

/** Show a URL without its password. */
export function redact(dbUrl: string): string {
  try {
    const u = new URL(dbUrl);
    u.password = '';
    u.username = '';
    return u.toString().replace('://', '://');
  } catch {
    return '(database)';
  }
}

/** Swap the database name in a connection URL. */
export function withDatabase(dbUrl: string, database: string): string {
  const u = new URL(dbUrl);
  u.pathname = '/' + encodeURIComponent(database);
  return u.toString();
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
    let decoded = url;
    try {
      decoded = decodeURIComponent(url);
    } catch {
      /* keep raw */
    }
    for (const form of new Set([url, decoded])) out = out.split(form).join(safe);
    try {
      const pw = new URL(url).password;
      if (pw) {
        for (const form of new Set([pw, decodeURIComponent(pw)])) {
          if (form.length >= 3) out = out.split(form).join('***');
        }
      }
    } catch {
      /* not a URL */
    }
  }
  out = out.replace(/(postgres(?:ql)?:\/\/)([^\s:@/]*):([^\s@/]*)@/gi, '$1$2:***@');
  out = out.replace(/\b(PGPASSWORD|password)\s*=\s*('[^']*'|"[^"]*"|[^\s'"]+)/gi, '$1=***');
  return out;
}
