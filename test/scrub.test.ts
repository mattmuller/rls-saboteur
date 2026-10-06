import { describe, expect, it } from 'vitest';
import { scrubSecrets } from '../src/config.js';
import { consoleReport, jsonReport, markdownReport, type RunModel } from '../src/report.js';

const URL_WITH_PW = 'postgres://postgres:s3cr3t-pw@127.0.0.1:54322/saboteur_1_2';

describe('scrubSecrets', () => {
  it('masks known URLs, URL passwords and libpq password tokens', () => {
    const text = `psql: could not connect ${URL_WITH_PW}\nconninfo host=x password=hunter22 dbname=y\nPGPASSWORD=abc123 psql\n`;
    const out = scrubSecrets(text, [URL_WITH_PW]);
    expect(out).not.toContain('s3cr3t-pw');
    expect(out).not.toContain('hunter22');
    expect(out).not.toContain('abc123');
  });
  it('masks a percent-encoded password in a copy URL it was not told about', () => {
    const out = scrubSecrets('failed: postgres://u:p%40ss%2Fword@h:1/db', []);
    expect(out).not.toContain('p%40ss');
  });
  it('masks quoted libpq passwords', () => {
    expect(scrubSecrets("password='two words'", [])).not.toContain('two words');
  });
});

describe('reports never carry a secret', () => {
  const model: RunModel = {
    database: 'postgres://127.0.0.1:54322/postgres', databaseSource: 'x', testsDescription: 't', schemas: ['public'],
    policyCount: 1, tableCount: 1, isolation: 'template', notes: [], findings: [], unparsed: [], policies: [],
    threshold: 100, jobs: 1, durationMs: 1, results: [],
    couldNotCheck: `tests fail\nconnect ${URL_WITH_PW} password=secret`
  };
  it('console, markdown and JSON', () => {
    for (const raw of [consoleReport(model, false), markdownReport(model), jsonReport(model)]) {
      const out = scrubSecrets(raw, [URL_WITH_PW]); // the same call cli.ts makes before output
      expect(out).not.toContain('s3cr3t-pw');
      expect(out).not.toContain('password=secret');
    }
  });
});

describe('redact and scrubSecrets edge cases', () => {
  it('redact drops a query-string password and user info', async () => {
    const { redact } = await import('../src/config.js');
    const r = redact('postgres://u:pw@127.0.0.1:5432/db?password=hunter9&sslmode=disable');
    expect(r).not.toContain('hunter9');
    expect(r).not.toContain('pw@');
    expect(r).toContain('127.0.0.1:5432/db');
  });
  it('masks a query-string password in free text', () => {
    expect(scrubSecrets('see postgres://h/db?password=hunter9&x=1', [])).not.toContain('hunter9');
  });
  it('masks a password containing / and @', () => {
    const out = scrubSecrets('error for postgres://u:p@ss/w@dbhost:5432/db failed', []);
    expect(out).not.toContain('p@ss');
    expect(out).not.toContain('ss/w');
    expect(out).toContain('dbhost:5432/db');
  });
  it('masks sslpassword', () => {
    const out = scrubSecrets('host=x sslpassword=topsecret1 sslkey=/k.pem', []);
    expect(out).not.toContain('topsecret1');
  });
  it('removes a very short known password through the full-URL replacement', () => {
    const url = 'postgres://u:ab@127.0.0.1:5432/db';
    expect(scrubSecrets(`conn ${url} lost`, [url])).not.toContain(':ab@');
  });
});

describe('malformed escapes and nasty inputs', () => {
  it('still removes a password holding a bare % escape', () => {
    const url = 'postgres://u:pa%zzword9@127.0.0.1:5432/db';
    const out = scrubSecrets(`could not connect: pa%zzword9 / ${url}`, [url]);
    expect(out).not.toContain('pa%zzword9');
  });

  const nasty: { text: string; secret: string; known?: string }[] = [
    { text: 'postgres://u:s3cret!@h:5432/db', secret: 's3cret!' },
    { text: 'postgresql://u:p@ss/w@h/db', secret: 'p@ss' },
    { text: 'postgres://u:p%40ss%2Fw@h/db', secret: 'p%40ss' },
    { text: 'postgres://u:pa%zzword9@h/db', secret: 'pa%zzword9', known: 'postgres://u:pa%zzword9@h/db' },
    { text: 'host=h dbname=d password=hunter22 user=u', secret: 'hunter22' },
    { text: "host=h password='two words here'", secret: 'two words here' },
    { text: 'host=h password="dq secret1"', secret: 'dq secret1' },
    { text: 'host=h sslpassword=keypass99 sslmode=require', secret: 'keypass99' },
    { text: 'PGPASSWORD=envpass77 psql -h x', secret: 'envpass77' },
    { text: 'postgres://h/db?sslmode=require&password=qspass55', secret: 'qspass55' },
    { text: 'POSTGRES://U:UpperPw1@H/db', secret: 'UpperPw1' },
    { text: 'url=postgres://u:in-a-sentence-pw@h:1/db, retrying', secret: 'in-a-sentence-pw' }
  ];

  it.each(nasty)('no secret survives in console, markdown or JSON: $text', ({ text, secret, known }) => {
    const model: RunModel = {
      database: 'postgres://127.0.0.1:54322/postgres', databaseSource: 'x', testsDescription: 't', schemas: ['public'],
      policyCount: 1, tableCount: 1, isolation: 'template', notes: [text], findings: [], unparsed: [], policies: [],
      threshold: 100, jobs: 1, durationMs: 1, results: [], couldNotCheck: text
    };
    for (const raw of [consoleReport(model, false), markdownReport(model), jsonReport(model)]) {
      expect(scrubSecrets(raw, known ? [known] : [])).not.toContain(secret);
    }
  });
});
