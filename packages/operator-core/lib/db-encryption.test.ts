/**
 * Coverage for db-encryption: the ENCRYPTED_TABLES allowlist, getDbEncryptionKey's
 * env path + in-process caching, and — the part this file previously left bare —
 * the KEY FILE custody path: atomic creation, permission repair, and refusal to
 * encrypt under a truncated key.
 *
 * WI-2144851 / plan security-boundary-remediation-and-usability-2026-09-04 P-007.
 * The source audit (docs/audits/security-usability-2026-09-04.md, the credential
 * hardening paragraph after F12) asks for "safe atomic key creation, and tested key
 * recovery/rotation" on THIS store, citing db-encryption.ts by name. Until this
 * describe block existed the header of this file read "the env var is always set
 * here so the file-read / key-bootstrap ... is never triggered" — i.e. the whole
 * custody surface the audit named had zero coverage.
 *
 * Every case below points the module at a throwaway directory via
 * PAPERCUSP_DB_ENCRYPTION_KEY_FILE. Nothing here reads or writes the real
 * ~/.papercusp/db-encryption-key.
 */
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ENCRYPTED_TABLES,
  getDbEncryptionKey,
  ensureDbEncryptionKeyFile,
  __resetDbEncryptionKeyForTests,
} from './db-encryption';

const ENV = 'PAPERCUSP_DB_ENCRYPTION_KEY';
const FILE_ENV = 'PAPERCUSP_DB_ENCRYPTION_KEY_FILE';

/** A well-formed key of the shape this module generates: 32 random bytes, base64. */
const VALID_KEY = Buffer.alloc(32, 7).toString('base64');

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

describe('getDbEncryptionKey — key file custody (P-007 Workstream B)', () => {
  let dir: string;
  let keyPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'db-enc-key-'));
    keyPath = join(dir, 'nested', 'db-encryption-key');
    vi.stubEnv(ENV, ''); // empty => fall through to the FILE path, which is the subject here
    vi.stubEnv(FILE_ENV, keyPath);
    __resetDbEncryptionKeyForTests();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('bootstraps a 32-byte base64 key at mode 0600', () => {
    const key = getDbEncryptionKey();

    expect(Buffer.from(key, 'base64')).toHaveLength(32);
    expect(readFileSync(keyPath, 'utf8').trim()).toBe(key);
    // The old writer created the file at the umask default and only chmod'd it
    // afterwards, so the key was world-readable for a window — and stayed 0644
    // forever if the process died between the two calls.
    expect(statSync(keyPath).mode & 0o777).toBe(0o600);
  });

  it('REFUSES a truncated key file instead of encrypting new rows under it', () => {
    // A short read / partial write, not a passphrase: this module only ever
    // writes generated 44-char keys to this path.
    ensureDbEncryptionKeyFile(keyPath); // create the dir + a real key first
    writeFileSync(keyPath, 'deadbeef\n', { mode: 0o600 }); // then corrupt it
    __resetDbEncryptionKeyForTests();

    expect(() => getDbEncryptionKey()).toThrow(/truncated or corrupt/i);
    // Critically: the damaged file is LEFT IN PLACE. Overwriting it would destroy
    // the last chance to recover whatever the real key was.
    expect(readFileSync(keyPath, 'utf8')).toBe('deadbeef\n');
  });

  it('names the recovery routes in the refusal', () => {
    ensureDbEncryptionKeyFile(keyPath);
    writeFileSync(keyPath, 'short\n', { mode: 0o600 });
    __resetDbEncryptionKeyForTests();

    expect(() => getDbEncryptionKey()).toThrow(new RegExp(ENV));
    expect(() => getDbEncryptionKey()).toThrow(/re-enter/i);
  });

  it('tightens an over-permissive existing key file on load', () => {
    ensureDbEncryptionKeyFile(keyPath);
    writeFileSync(keyPath, `${VALID_KEY}\n`);
    chmodSync(keyPath, 0o644); // as left by the pre-fix writer, or a careless restore
    __resetDbEncryptionKeyForTests();

    expect(getDbEncryptionKey()).toBe(VALID_KEY);
    expect(statSync(keyPath).mode & 0o777).toBe(0o600);
  });

  it('replaces an empty key file rather than refusing (nothing there to recover)', () => {
    ensureDbEncryptionKeyFile(keyPath);
    writeFileSync(keyPath, '   \n', { mode: 0o600 });
    __resetDbEncryptionKeyForTests();

    const key = getDbEncryptionKey();
    expect(Buffer.from(key, 'base64')).toHaveLength(32);
    expect(readFileSync(keyPath, 'utf8').trim()).toBe(key);
  });

  it('CONTROL: a short env override is still honoured verbatim', () => {
    // The length floor is scoped to the file this module writes, never to the
    // operator-supplied env passphrase. Without this control, a floor applied to
    // both paths would look identical to a correct one.
    vi.stubEnv(ENV, 'short');
    __resetDbEncryptionKeyForTests();
    expect(getDbEncryptionKey()).toBe('short');
  });
});

describe('ensureDbEncryptionKeyFile — atomic provisioning', () => {
  let dir: string;
  let keyPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'db-enc-ensure-'));
    keyPath = join(dir, 'nested', 'db-encryption-key');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('creates the key and its parent directory at restrictive modes', () => {
    const key = ensureDbEncryptionKeyFile(keyPath);

    expect(Buffer.from(key, 'base64')).toHaveLength(32);
    expect(statSync(keyPath).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, 'nested')).mode & 0o077).toBe(0); // no group/other access
  });

  it('ADOPTS a key that appeared concurrently instead of clobbering it', () => {
    // The lost-bootstrap-race branch. Two operators (:3070 and :3170) can both
    // observe "no key file" and both generate one; whichever wrote last used to
    // win, silently orphaning every row the loser had already encrypted.
    const first = ensureDbEncryptionKeyFile(keyPath);
    const second = ensureDbEncryptionKeyFile(keyPath);

    expect(second).toBe(first);
    expect(readFileSync(keyPath, 'utf8').trim()).toBe(first);
  });
});
