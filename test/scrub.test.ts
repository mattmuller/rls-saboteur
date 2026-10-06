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
