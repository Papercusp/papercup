/**
 * keychain — the encrypted-file fallback tier (AES-256-GCM).
 *
 * The OS keychain tiers (secret-tool / security CLI) are exercised on the
 * real machine and can't be asserted hermetically, so we force the file
 * fallback by stubbing `node:child_process` execFile to ENOENT (CLIs "not
 * installed") and pointing $HOME at a fresh temp dir. That covers the tier
 * that ships everywhere: round-trip, not_found, auth-tag tamper, delete,
 * and id isolation.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let TMP_HOME: string;
let origHome: string | undefined;
let origIdentityDir: string | undefined;

beforeEach(() => {
  vi.resetModules();
  TMP_HOME = mkdtempSync(join(tmpdir(), 'pc-keychain-'));
  origHome = process.env.HOME;
  origIdentityDir = process.env.PAPERCUSP_IDENTITY_DIR;
  process.env.HOME = TMP_HOME; // os.homedir() honors $HOME on POSIX -> default identity dir = $HOME/.papercusp/identity
  delete process.env.PAPERCUSP_IDENTITY_DIR;
  // Make the OS keychain CLIs look uninstalled so both tiers fall through to the file backend.
  vi.doMock('node:child_process', () => ({
    execFile: (_cmd: string, _args: string[], _opts: unknown, cb: (e: Error) => void) =>
      cb(Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' })),
  }));
});

afterEach(() => {
  if (origHome === undefined) delete process.env.HOME;
  else process.env.HOME = origHome;
  if (origIdentityDir === undefined) delete process.env.PAPERCUSP_IDENTITY_DIR;
  else process.env.PAPERCUSP_IDENTITY_DIR = origIdentityDir;
  vi.doUnmock('node:child_process');
  try {
    rmSync(TMP_HOME, { recursive: true, force: true });
  } catch {
    /* best-effort cleanup */
  }
});

async function loadKeychain() {
  return import('./keychain');
}

const encPath = (id: string) =>
  join(TMP_HOME, '.papercusp', 'identity', 'keypair-' + id.replace(/[^a-zA-Z0-9_-]/g, '_') + '.enc');

describe('keychain (encrypted-file fallback)', () => {
  it('store -> load round-trips the private-key DER', async () => {
    const { keychainStore, keychainLoad } = await loadKeychain();
    const der = Buffer.from('fake-pkcs8-der-bytes-0123456789ab');
    await keychainStore('gh123:fp', der);
    const res = await keychainLoad('gh123:fp');
    expect(res.kind).toBe('ok');
    if (res.kind === 'ok') expect(res.value.equals(der)).toBe(true);
  });

  it('load returns not_found when nothing was stored', async () => {
    const { keychainLoad } = await loadKeychain();
    const res = await keychainLoad('absent:id');
    expect(res.kind).toBe('error');
    if (res.kind === 'error') expect(res.error.kind).toBe('not_found');
  });

  it('a tampered ciphertext fails with decryption_failed (GCM auth-tag mismatch)', async () => {
    const { keychainStore, keychainLoad } = await loadKeychain();
    await keychainStore('tamper:id', Buffer.from('secret-key-material-aaaaaaaaaaaa'));
    const path = encPath('tamper:id');
    const buf = await readFile(path);
    buf[buf.length - 1] ^= 0xff; // flip a ciphertext byte
    writeFileSync(path, buf);
    const res = await keychainLoad('tamper:id');
    expect(res.kind).toBe('error');
    if (res.kind === 'error') expect(res.error.kind).toBe('decryption_failed');
  });

  it('delete removes the entry (subsequent load is not_found)', async () => {
    const { keychainStore, keychainLoad, keychainDelete } = await loadKeychain();
    await keychainStore('del:id', Buffer.from('zzzzzzzzzzzzzzzz'));
    await keychainDelete('del:id');
    const res = await keychainLoad('del:id');
    expect(res.kind).toBe('error');
    if (res.kind === 'error') expect(res.error.kind).toBe('not_found');
  });

  it('different ids do not collide', async () => {
    const { keychainStore, keychainLoad } = await loadKeychain();
    await keychainStore('id-a', Buffer.from('aaaaaaaaaaaaaaaa'));
    await keychainStore('id-b', Buffer.from('bbbbbbbbbbbbbbbb'));
    const a = await keychainLoad('id-a');
    const b = await keychainLoad('id-b');
    expect(a.kind === 'ok' && a.value.toString()).toBe('aaaaaaaaaaaaaaaa');
    expect(b.kind === 'ok' && b.value.toString()).toBe('bbbbbbbbbbbbbbbb');
  });

  it('honors PAPERCUSP_IDENTITY_DIR over HOME for fallback storage', async () => {
    const customIdentityDir = mkdtempSync(join(tmpdir(), 'pc-keychain-identity-'));
    process.env.PAPERCUSP_IDENTITY_DIR = customIdentityDir;
    try {
      const { keychainStore, keychainLoad } = await loadKeychain();
      const id = '279242982:papercusp-testvm-tester';
      const der = Buffer.from('shared-hive-device-key-material');
      const safe = id.replace(/[^a-zA-Z0-9_-]/g, '_');

      await keychainStore(id, der);

      expect(existsSync(join(customIdentityDir, 'keypair-' + safe + '.enc'))).toBe(true);
      expect(existsSync(encPath(id))).toBe(false);

      const loaded = await keychainLoad(id);
      expect(loaded.kind).toBe('ok');
      if (loaded.kind === 'ok') expect(loaded.value.equals(der)).toBe(true);
    } finally {
      rmSync(customIdentityDir, { recursive: true, force: true });
    }
  });
});
