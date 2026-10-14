/** Command-line values, checked. A bad value stops the run with exit 2; it is never turned into a default. */

export function parsePercent(raw: string, name: string): number {
  const n = Number(raw);
  if (raw.trim() === '' || !Number.isFinite(n) || n < 0 || n > 100) {
    throw new Error(`${name} must be a number from 0 to 100, got "${raw}".`);
  }
  return n;
}

export function parseJobs(raw: string): number {
  const n = Number(raw);
  if (raw.trim() === '' || !Number.isInteger(n) || n < 1) throw new Error(`--jobs must be a whole number of 1 or more, got "${raw}".`);
  return n;
}

export function parseSeconds(raw: string): number {
  const n = Number(raw);
  if (raw.trim() === '' || !Number.isFinite(n) || n <= 0) throw new Error(`--timeout must be a number of seconds above 0, got "${raw}".`);
  return n;
}

const UNITS: Record<string, number> = { b: 1, kb: 1024, mb: 1024 ** 2, gb: 1024 ** 3, tb: 1024 ** 4 };

/** "500MB", "2 GB", "1048576" (bytes). Binary units, like pg_size_pretty. */
export function parseSize(raw: string, name = '--max-size'): number {
  const m = /^\s*(\d+(?:\.\d+)?)\s*([a-z]*)\s*$/i.exec(raw);
  const unit = m ? (m[2] === '' ? 1 : UNITS[m[2].toLowerCase()]) : undefined;
  if (!m || unit === undefined) throw new Error(`${name} must be a size such as 500MB or 2GB, got "${raw}".`);
  const n = Number(m[1]) * unit;
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${name} must be above 0, got "${raw}".`);
  return Math.floor(n);
}

export const DEFAULT_MAX_SIZE = 2 * 1024 ** 3;

export function formatSize(bytes: number): string {
  const units = ['bytes', 'kB', 'MB', 'GB', 'TB'];
  let n = bytes;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${i === 0 ? n : n.toFixed(1)} ${units[i]}`;
}

export const RUNNERS = ['auto', 'supabase', 'psql'] as const;
export type Runner = (typeof RUNNERS)[number];

/** --runner: one of auto, supabase, psql. Anything else is exit 2; it is never treated as auto. */
export function parseRunner(raw: string | undefined): Runner {
  if (raw === undefined) return 'auto';
  if ((RUNNERS as readonly string[]).includes(raw)) return raw as Runner;
  throw new Error(`--runner must be one of ${RUNNERS.join(', ')}, got "${raw}".`);
}
