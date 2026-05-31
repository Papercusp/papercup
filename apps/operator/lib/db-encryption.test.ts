/**
 * Coverage for db-encryption: the ENCRYPTED_TABLES allowlist and
 * getDbEncryptionKey's env path + in-process caching. The env var is always set
 * here so the file-read / key-bootstrap (which would write ~/.papercusp) is
 * never triggered.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ENCRYPTED_TABLES, getDbEncryptionKey, __resetDbEncryptionKeyForTests } from './db-encryption';

const ENV = 'PAPERCUSP_DB_ENCRYPTION_KEY';

beforeEach(() => {
  __resetDbEncryptionKeyForTests();
  vi.stubEnv(ENV, 'default-test-key'); // never fall through to the file/bootstrap path
});
afterEach(() => {
  vi.unstubAllEnvs();
  __resetDbEncryptionKeyForTests();
});

describe('ENCRYPTED_TABLES', () => {
  it('contains the credential tables and not arbitrary ones', () => {
    expect(ENCRYPTED_TABLES.has('operator_credentials')).toBe(true);
    expect(ENCRYPTED_TABLES.has('operator_search_provider_credentials')).toBe(true);
    expect(ENCRYPTED_TABLES.has('harness_features')).toBe(false);
  });
});

describe('getDbEncryptionKey', () => {
  it('returns the trimmed env key', () => {
    vi.stubEnv(ENV, '  secret-key  ');
    expect(getDbEncryptionKey()).toBe('secret-key');
  });

  it('caches the resolution until reset', () => {
    vi.stubEnv(ENV, 'k1');
    expect(getDbEncryptionKey()).toBe('k1');
    vi.stubEnv(ENV, 'k2'); // changed underneath
    expect(getDbEncryptionKey()).toBe('k1'); // still cached
    __resetDbEncryptionKeyForTests();
    expect(getDbEncryptionKey()).toBe('k2'); // re-resolved
  });
});
