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
let origSeedRealHostname: string | undefined;
let execFileCalls = 0;
let securityStoreSucceeds = false;
let securityLoadSecret: string | null = null;
const execFileArgv: Array<{ command: string; args: string[] }> = [];

beforeEach(() => {
  vi.resetModules();
  TMP_HOME = mkdtempSync(join(tmpdir(), 'pc-keychain-'));
  origHome = process.env.HOME;
  origIdentityDir = process.env.PAPERCUSP_IDENTITY_DIR;
  origSeedRealHostname = process.env.PAPERCUSP_SEED_REAL_HOSTNAME;
  process.env.HOME = TMP_HOME; // os.homedir() honors $HOME on POSIX -> default identity dir = $HOME/.papercusp/identity
  delete process.env.PAPERCUSP_IDENTITY_DIR;
  delete process.env.PAPERCUSP_SEED_REAL_HOSTNAME;
  // Make the OS keychain CLIs look uninstalled so both tiers fall through to the file backend.
  execFileCalls = 0;
  securityStoreSucceeds = false;
  securityLoadSecret = null;
  execFileArgv.length = 0;
  vi.doMock('node:child_process', () => ({
    execFile: (
      command: string,
      args: string[],
      _opts: unknown,
      cb: (error: Error | null, stdout?: string, stderr?: string) => void,
    ) => {
      execFileCalls += 1;
      execFileArgv.push({ command, args });
      if (command === 'security') {
        if (args[0] === 'add-generic-password' && securityStoreSucceeds) {
          cb(null, '', '');
          return;
        }
        if (args[0] === 'find-generic-password' && securityLoadSecret !== null) {
          cb(null, `${securityLoadSecret}\n`, '');
          return;
        }
        cb(Object.assign(new Error('security: User interaction is not allowed (exit code 36)'), { code: 36 }));
        return;
      }
      cb(Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }));
    },
  }));
});

afterEach(() => {
  if (origHome === undefined) delete process.env.HOME;
  else process.env.HOME = origHome;
  if (origIdentityDir === undefined) delete process.env.PAPERCUSP_IDENTITY_DIR;
  else process.env.PAPERCUSP_IDENTITY_DIR = origIdentityDir;
  if (origSeedRealHostname === undefined) delete process.env.PAPERCUSP_SEED_REAL_HOSTNAME;
  else process.env.PAPERCUSP_SEED_REAL_HOSTNAME = origSeedRealHostname;
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

  it('mirrors a successful macOS Keychain store for a later locked headless load (D-005)', async () => {
    const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { configurable: true, value: 'darwin' });
    securityStoreSucceeds = true;
    try {
      const { keychainStore, keychainLoad } = await loadKeychain();
      const id = '1567022:headless-mirror';
      const der = Buffer.from('same-device-private-key-der');

      await keychainStore(id, der);

      expect(execFileArgv).toContainEqual({
        command: 'security',
        args: [
          'add-generic-password',
          '-s',
          'papercusp-device-keypair',
          '-a',
          id,
          '-w',
          der.toString('base64'),
          '-U',
        ],
      });
      expect(existsSync(encPath(id))).toBe(true);

      // The login Keychain is now ACL/lock-blocked (the VM's SSH/loginwindow
      // state). Loading must still recover the exact DER written above, never a
      // stale fallback key and never a newly minted identity.
      securityLoadSecret = null;
      expect(await keychainLoad(id)).toEqual({ kind: 'ok', value: der });
    } finally {
      if (platformDescriptor) Object.defineProperty(process, 'platform', platformDescriptor);
    }
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

  it('reads a key from the LEGACY ~/.papercusp/identity dir even when PAPERCUSP_IDENTITY_DIR points elsewhere (split-key resilience — D-024 / D-023 BUG A)', async () => {
    // Scenario: a hive key was minted BEFORE the shared-operator switch (so it
    // lives in the legacy default ~/.papercusp/identity), then the operator is
    // relaunched in shared-operator mode (PAPERCUSP_IDENTITY_DIR=…/.shared/…).
    // loadHivePubkey must still find it (else the hive "stays dark" + content
    // never federates).
    const id = 'hive:default:legacy-only-hive';
    const der = Buffer.from('legacy-dir-hive-key-material-0001');

    // 1. store with NO override → lands in the legacy $HOME/.papercusp/identity.
    delete process.env.PAPERCUSP_IDENTITY_DIR;
    {
      const { keychainStore } = await loadKeychain();
      await keychainStore(id, der);
    }
    expect(existsSync(encPath(id))).toBe(true); // legacy path holds it

    // 2. switch to a FRESH shared identity dir (empty — does NOT contain the key).
    const sharedDir = mkdtempSync(join(tmpdir(), 'pc-keychain-shared-'));
    process.env.PAPERCUSP_IDENTITY_DIR = sharedDir;
    try {
      vi.resetModules();
      const { keychainLoad } = await loadKeychain();
      const res = await keychainLoad(id);
      expect(res.kind).toBe('ok'); // found via the legacy-dir fallback
      if (res.kind === 'ok') expect(res.value.equals(der)).toBe(true);
      // and the shared dir genuinely did NOT contain it
      expect(existsSync(join(sharedDir, 'keypair-' + id.replace(/[^a-zA-Z0-9_-]/g, '_') + '.enc'))).toBe(false);
    } finally {
      rmSync(sharedDir, { recursive: true, force: true });
    }
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

  it('uses the real hostname handed across the seed cutter UTS namespace', async () => {
    const { keychainStore, keychainLoad } = await loadKeychain();
    const id = 'seed:uts-hostname';
    const der = Buffer.from('seed-uts-hostname-key-material');

    // The parent encrypts with the real hostname; the bwrap child reports the
    // neutral label but receives the real one through this release-only env.
    process.env.PAPERCUSP_SEED_REAL_HOSTNAME = 'seed-real-host-77';
    await keychainStore(id, der);

    // A child that used getHostname() would silently use the neutral label and
    // fail to decrypt. This negative control proves the override is load-bearing.
    process.env.PAPERCUSP_SEED_REAL_HOSTNAME = 'papercusp-build';
    const wrongHost = await keychainLoad(id);
    expect(wrongHost.kind).toBe('error');
    if (wrongHost.kind === 'error') expect(wrongHost.error.kind).toBe('decryption_failed');

    process.env.PAPERCUSP_SEED_REAL_HOSTNAME = 'seed-real-host-77';
    const loaded = await keychainLoad(id);
    expect(loaded).toEqual({ kind: 'ok', value: der });
  });

  // WI-2018: keychainDelete must remove the file copy from EVERY dir fileLoad reads
  // (primary + legacy). Deleting only the primary left a legacy-dir copy that fileLoad
  // silently RESURRECTED on the next load — a poisoned key survived its own cleanup
  // (the split-device-identity class, proven live on the mac VM 2026-07-03).
  it('delete removes BOTH the primary (PAPERCUSP_IDENTITY_DIR) and legacy copies — no resurrection', async () => {
    const { keychainStore, keychainDelete, keychainLoad } = await loadKeychain();
    const id = 'split:dirs';
    const der = Buffer.from('poison-era-key-material-0123456789');

    // 1. store with NO PAPERCUSP_IDENTITY_DIR → lands in the legacy default
    await keychainStore(id, der);
    expect(existsSync(encPath(id))).toBe(true);

    // 2. switch to a shared-operator primary dir (the D-024 split); store again → primary copy
    const primaryDir = mkdtempSync(join(tmpdir(), 'pc-keychain-primary-'));
    process.env.PAPERCUSP_IDENTITY_DIR = primaryDir;
    const primaryPath = join(primaryDir, 'keypair-split_dirs.enc');
    try {
      await keychainStore(id, der);
      expect(existsSync(primaryPath)).toBe(true);
      expect(existsSync(encPath(id))).toBe(true); // both copies live

      // 3. ONE delete → BOTH copies gone; load = not_found (nothing resurrects)
      await keychainDelete(id);
      expect(existsSync(primaryPath)).toBe(false);
      expect(existsSync(encPath(id))).toBe(false);
      const res = await keychainLoad(id);
      expect(res.kind).toBe('error');
      if (res.kind === 'error') expect(res.error.kind).toBe('not_found');
    } finally {
      rmSync(primaryDir, { recursive: true, force: true });
    }
  });

  it('caches loads and remembers a missing CLI backend — no re-spawn per call (WI-5218)', async () => {
    const { keychainStore, keychainLoad } = await loadKeychain();
    await keychainStore('hot:id', Buffer.from('key-a'));
    const first = await keychainLoad('hot:id');
    expect(first).toEqual({ kind: 'ok', value: Buffer.from('key-a') });
    const callsAfterFirst = execFileCalls;
    // A CLI that ENOENT'd once is remembered as unavailable: repeated loads
    // spawn NOTHING further (this was ~34% of bg-host CPU — WI-5218).
    await keychainLoad('hot:id');
    await keychainLoad('hot:id');
    expect(execFileCalls).toBe(callsAfterFirst);
    expect(callsAfterFirst).toBeLessThanOrEqual(2);
    // And the result itself is cache-served: still ok after the backing file is gone.
    rmSync(encPath('hot:id'), { force: true });
    const cached = await keychainLoad('hot:id');
    expect(cached).toEqual({ kind: 'ok', value: Buffer.from('key-a') });
  });

  it('store invalidates the load cache — a rotated key is visible immediately (WI-5218)', async () => {
    const { keychainStore, keychainLoad } = await loadKeychain();
    await keychainStore('rot:id', Buffer.from('v1'));
    expect(await keychainLoad('rot:id')).toEqual({ kind: 'ok', value: Buffer.from('v1') });
    await keychainStore('rot:id', Buffer.from('v2'));
    expect(await keychainLoad('rot:id')).toEqual({ kind: 'ok', value: Buffer.from('v2') });
  });
});
