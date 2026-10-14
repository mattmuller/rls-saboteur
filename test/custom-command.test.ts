import { describe, expect, it } from 'vitest';
import { discoverSuite, shellQuote } from '../src/tests.js';

const posix = process.platform !== 'win32';

// The URL must reach the user's command byte for byte, whatever the password holds.
const passwords = ['pa$HOME', 'p$(echo x)q', "it's", 'back`echo x`tick', 'a b;c|d&e'];

describe.runIf(posix)('{{db_url}} is quoted for the shell', () => {
  for (const pw of passwords) {
    it(`passes a password of ${JSON.stringify(pw)} unchanged`, async () => {
      const url = `postgres://user:${pw}@127.0.0.1:5432/db`;
      const suite = discoverSuite({ cwd: process.cwd(), command: 'node -e "console.log(process.argv[1])" {{db_url}}' });
      const r = await suite!.run(url, { timeoutMs: 20_000 });
      expect(r.output.trim()).toBe(url);
    });
  }
});

describe('shellQuote', () => {
  it('writes a single quote as the four characters \'\\\'\'', () => {
    expect(shellQuote("a'b", 'linux')).toBe(`'a'\\''b'`);
  });
  it('double-quotes for cmd.exe and refuses ", % and !', () => {
    expect(shellQuote('postgres://u:p@h/db', 'win32')).toBe('"postgres://u:p@h/db"');
    for (const bad of ['a"b', 'a%PATH%b', 'a!b']) expect(shellQuote(bad, 'win32')).toBeNull();
  });
});
