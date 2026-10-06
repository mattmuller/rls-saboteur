import { describe, expect, it } from 'vitest';
import { remoteRefusal, resolveConnection, urlIsLocal } from '../src/safety.js';
import { scrubSecrets } from '../src/config.js';

const none: NodeJS.ProcessEnv = {};

describe('the local-only guard resolves where a connection really goes', () => {
  it('refuses a ?host= parameter that points away from a localhost URL', () => {
    expect(remoteRefusal('postgres://u:p@localhost/db?host=prod.example.com', false, none)).toContain('prod.example.com');
  });
  it('refuses an empty host when PGHOST is remote', () => {
    expect(remoteRefusal('postgres://u:p@/db', false, { PGHOST: 'prod.example.com' })).toContain('prod.example.com');
  });
  it('refuses a multi-host list with one remote entry', () => {
    expect(remoteRefusal('postgres://u:p@localhost,prod.example.com/db', false, none)).toContain('prod.example.com');
    expect(remoteRefusal('postgres://u:p@localhost/db?host=127.0.0.1,prod.example.com', false, none)).toContain('prod.example.com');
  });
  it('refuses a remote hostaddr in the URL or the environment, even with a local host', () => {
    expect(remoteRefusal('postgres://u:p@localhost/db?hostaddr=10.1.2.3', false, none)).toContain('10.1.2.3');
    expect(remoteRefusal('postgres://u:p@127.0.0.1/db', false, { PGHOSTADDR: '10.1.2.3' })).toContain('10.1.2.3');
  });
  it('refuses a service entry, since it can point anywhere', () => {
    expect(remoteRefusal('postgres://u:p@localhost/db?service=prod', false, none)).toContain('service');
    expect(remoteRefusal('postgres://u:p@localhost/db', false, { PGSERVICE: 'prod' })).toContain('service');
  });
  it('allows a socket path, an empty host with no environment, and plain localhost', () => {
    expect(remoteRefusal('postgres://u:p@/db?host=/var/run/postgresql', false, none)).toBeNull();
    expect(remoteRefusal('postgres://u:p@/db', false, none)).toBeNull();
    expect(remoteRefusal('postgres://u:p@localhost,127.0.0.1/db', false, none)).toBeNull();
  });
  it('lets the flag override every refusal', () => {
    expect(remoteRefusal('postgres://u:p@localhost/db?host=prod.example.com', true, none)).toBeNull();
  });
  it('writes the effective host into the resolved URL and drops the redirecting parameters', () => {
    const r = resolveConnection('postgres://u:p@/db?host=127.0.0.1&sslmode=disable', none);
    expect(r.url).toContain('@127.0.0.1');
    expect(r.url).not.toContain('host=');
    expect(r.url).toContain('sslmode=disable');
    expect(resolveConnection('postgres://u:p@/db', { PGHOST: 'localhost' }).url).toContain('@localhost');
    expect(resolveConnection('postgres://u:p@/db?host=/var/run/postgresql', none).url).toContain('host=%2Fvar%2Frun%2Fpostgresql');
  });
});

describe('the scrubber uses the same resolver', () => {
  it('does not treat the local default as local when ?host= points away', () => {
    const url = 'postgres://postgres:postgres@localhost/db?host=prod.example.com';
    expect(urlIsLocal(url, none)).toBe(false);
    expect(scrubSecrets('rejected: postgres', [url])).not.toContain('postgres');
  });
});
