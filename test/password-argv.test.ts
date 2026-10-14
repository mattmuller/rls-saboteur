import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { discoverSuite, passwordless } from '../src/tests.js';

describe('passwordless', () => {
  it('moves the password out of the URL and into PGPASSWORD, decoded', () => {
    const r = passwordless('postgres://u:p%40ss%24w@127.0.0.1:5432/db?sslmode=disable');
    expect(r.url).toBe('postgres://u@127.0.0.1:5432/db?sslmode=disable');
    expect(r.env.PGPASSWORD).toBe('p@ss$w');
  });
  it('leaves a URL without a password alone', () => {
    expect(passwordless('postgres://u@127.0.0.1/db').url).toBe('postgres://u@127.0.0.1/db');
  });
});

// A fake psql records what it was given. The password must be in PGPASSWORD and absent from argv.
describe.runIf(process.platform !== 'win32')('the psql runner keeps the password out of argv', () => {
  it('passes it by environment', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'saboteur-argv-'));
    const bin = join(dir, 'bin');
    mkdirSync(bin);
    mkdirSync(join(dir, 'supabase', 'tests'), { recursive: true });
    writeFileSync(join(dir, 'supabase', 'tests', 'a.sql'), 'select 1;');
    const log = join(dir, 'log.txt');
    writeFileSync(join(bin, 'psql'), `#!/bin/sh\nprintf '%s\\n' "$@" >> "${log}"\nprintf 'PGPASSWORD=%s\\n' "$PGPASSWORD" >> "${log}"\n`);
    chmodSync(join(bin, 'psql'), 0o755);
    const oldPath = process.env.PATH;
    process.env.PATH = `${bin}:${oldPath}`;
    try {
      const suite = discoverSuite({ cwd: dir, runner: 'psql' })!;
      const url = 'postgres://u:s3cretPW@127.0.0.1:5432/db';
      await suite.prepare!(url);
      await suite.run(url, { timeoutMs: 20_000 });
    } finally {
      process.env.PATH = oldPath;
    }
    const seen = readFileSync(log, 'utf8');
    const argvLines = seen.split('\n').filter((l) => !l.startsWith('PGPASSWORD='));
    expect(argvLines.join('\n')).not.toContain('s3cretPW');
    expect(argvLines).toContain('postgres://u@127.0.0.1:5432/db');
    expect(seen).toContain('PGPASSWORD=s3cretPW');
  });
});
