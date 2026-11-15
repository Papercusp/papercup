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
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let TMP_HOME: string;
let origHome: string | undefined;
let origPapercuspHome: string | undefined;
let origIdentityDir: string | undefined;
let origSeedRealHostname: string | undefined;
let origIdentityMode: string | undefined;
let origEnvOperatorId: string | undefined;
let origRequestOnly: string | undefined;
let execFileCalls = 0;
let securityStoreSucceeds = false;
let securityLoadSecret: string | null = null;
let securityLoadNotFound = false;
const execFileArgv: Array<{ command: string; args: string[] }> = [];

beforeEach(() => {
  vi.resetModules();
  TMP_HOME = mkdtempSync(join(tmpdir(), 'pc-keychain-'));
  origHome = process.env.HOME;
  origPapercuspHome = process.env.PAPERCUSP_HOME;
  origIdentityDir = process.env.PAPERCUSP_IDENTITY_DIR;
  origSeedRealHostname = process.env.PAPERCUSP_SEED_REAL_HOSTNAME;
  origIdentityMode = process.env.PAPERCUSP_IDENTITY_MODE;
  origEnvOperatorId = process.env.PAPERCUSP_ENV_OPERATOR_ID;
  origRequestOnly = process.env.PAPERCUSP_REQUEST_ONLY;
  process.env.HOME = TMP_HOME; // os.homedir() honors $HOME on POSIX -> default identity dir = $HOME/.papercusp/identity
  // papercuspPath honors this pin before HOME, including inherited workspace roots.
  process.env.PAPERCUSP_HOME = join(TMP_HOME, '.papercusp');
  delete process.env.PAPERCUSP_IDENTITY_DIR;
  delete process.env.PAPERCUSP_SEED_REAL_HOSTNAME;
  delete process.env.PAPERCUSP_IDENTITY_MODE;
  delete process.env.PAPERCUSP_ENV_OPERATOR_ID;
  delete process.env.PAPERCUSP_REQUEST_ONLY;
  // Make the OS keychain CLIs look uninstalled so both tiers fall through to the file backend.
  execFileCalls = 0;
  securityStoreSucceeds = false;
  securityLoadSecret = null;
  securityLoadNotFound = false;
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
        if (args[0] === 'find-generic-password' && securityLoadNotFound) {
          cb(Object.assign(new Error('security: The specified item could not be found in the keychain. (exit code 44)'), { code: 44 }));
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
  if (origPapercuspHome === undefined) delete process.env.PAPERCUSP_HOME;
  else process.env.PAPERCUSP_HOME = origPapercuspHome;
  if (origIdentityDir === undefined) delete process.env.PAPERCUSP_IDENTITY_DIR;
  else process.env.PAPERCUSP_IDENTITY_DIR = origIdentityDir;
  if (origSeedRealHostname === undefined) delete process.env.PAPERCUSP_SEED_REAL_HOSTNAME;
  else process.env.PAPERCUSP_SEED_REAL_HOSTNAME = origSeedRealHostname;
  if (origIdentityMode === undefined) delete process.env.PAPERCUSP_IDENTITY_MODE;
  else process.env.PAPERCUSP_IDENTITY_MODE = origIdentityMode;
  if (origEnvOperatorId === undefined) delete process.env.PAPERCUSP_ENV_OPERATOR_ID;
  else process.env.PAPERCUSP_ENV_OPERATOR_ID = origEnvOperatorId;
  if (origRequestOnly === undefined) delete process.env.PAPERCUSP_REQUEST_ONLY;
  else process.env.PAPERCUSP_REQUEST_ONLY = origRequestOnly;
  vi.doUnmock('node:child_process');
  vi.doUnmock('node:fs/promises');
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
  it('keeps the fixture home pin and encrypted identity files inside its synthetic HOME', async () => {
    expect(process.env.PAPERCUSP_HOME).toBe(join(TMP_HOME, '.papercusp'));
    const { identityDir, keychainStore, keychainLoad } = await loadKeychain();
    expect(identityDir()).toBe(join(TMP_HOME, '.papercusp', 'identity'));

    const id = 'fixture:home-isolation';
    const der = Buffer.from('synthetic-fixture-key-material');
    await keychainStore(id, der);
    expect(existsSync(encPath(id))).toBe(true);
    expect(await keychainLoad(id)).toEqual({ kind: 'ok', value: der });
  });

  it('recognizes every request-only marker and keeps ordinary primary writes enabled', async () => {
    const { identityWritesAllowed, isRequestOnlyIdentityProcess } = await loadKeychain();
    expect(identityWritesAllowed({})).toBe(true);
    expect(isRequestOnlyIdentityProcess({})).toBe(false);
    for (const env of [
      { PAPERCUSP_IDENTITY_MODE: 'load-only' },
      { PAPERCUSP_ENV_OPERATOR_ID: 'staging' },
      { PAPERCUSP_REQUEST_ONLY: '1' },
    ]) {
      expect(isRequestOnlyIdentityProcess(env)).toBe(true);
      expect(identityWritesAllowed(env)).toBe(false);
    }
  });

  it('fails closed before store/delete can touch any backend or encrypted mirror', async () => {
    process.env.PAPERCUSP_REQUEST_ONLY = '1';
    const { keychainStore, keychainDelete } = await loadKeychain();
    const id = 'request-only:must-not-write';
    const callsBefore = execFileCalls;

    await expect(keychainStore(id, Buffer.from('forbidden-key'))).rejects.toThrow(
      /request-only sidecar identity guard/,
    );
    await expect(keychainDelete(id)).rejects.toThrow(/request-only sidecar identity guard/);
    expect(execFileCalls).toBe(callsBefore);
    expect(existsSync(encPath(id))).toBe(false);
  });

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

  it('falls through an available macOS Keychain miss to the encrypted LaunchDaemon mirror', async () => {
    const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { configurable: true, value: 'darwin' });
    securityStoreSucceeds = true;
    try {
      const id = '1567022:launchdaemon-mirror';
      const der = Buffer.from('launchdaemon-device-private-key-der');
      await (await loadKeychain()).keychainStore(id, der);
      expect(existsSync(encPath(id))).toBe(true);

      // A LaunchDaemon can see the `security` CLI yet receive exit 44 for an
      // item visible to the login session. Re-import to model a fresh process:
      // the OS-tier miss must continue to the converged encrypted mirror.
      securityLoadNotFound = true;
      vi.resetModules();
      expect(await (await loadKeychain()).keychainLoad(id)).toEqual({ kind: 'ok', value: der });
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
    if (res.kind === 'error') {
      expect(res.error.kind).toBe('decryption_failed');
      if (res.error.kind === 'decryption_failed') {
        expect(res.error.reason).toContain('context={');
        expect(res.error.reason).toContain('"identityDirs"');
        expect(res.error.reason).toContain('"home"');
        expect(res.error.reason).toContain('"hostname"');
        expect(res.error.reason).toContain('"username"');
      }
    }
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

  it('fails closed without rewriting either valid but divergent fallback mirror', async () => {
    const id = 'hive:default:divergent-fallbacks';
    const canonicalDer = Buffer.from('canonical-legacy-hive-key-material');
    const divergentDer = Buffer.from('divergent-primary-hive-key-material');

    // The original identity predates PAPERCUSP_IDENTITY_DIR and therefore has
    // the only provenance that crosses the directory migration.
    const { keychainStore } = await loadKeychain();
    await keychainStore(id, canonicalDer);
    expect(existsSync(encPath(id))).toBe(true);
    const canonicalLegacyBlob = await readFile(encPath(id));

    const primaryDir = mkdtempSync(join(tmpdir(), 'pc-keychain-divergent-primary-'));
    process.env.PAPERCUSP_IDENTITY_DIR = primaryDir;
    const primaryPath = join(primaryDir, 'keypair-hive_default_divergent-fallbacks.enc');
    try {
      // A normal configured store now mirrors both roots. Restore the prior
      // legacy ciphertext afterward to reproduce the live split without adding
      // a test-only encryption seam to the production module.
      vi.resetModules();
      await keychainStore(id, divergentDer);
      expect(existsSync(primaryPath)).toBe(true);
      writeFileSync(encPath(id), canonicalLegacyBlob);
      const primaryBefore = await readFile(primaryPath);
      const legacyBefore = await readFile(encPath(id));

      vi.resetModules();
      const loaded = await (await loadKeychain()).keychainLoad(id);
      expect(loaded.kind).toBe('error');
      if (loaded.kind === 'error') {
        expect(loaded.error.kind).toBe('io_error');
        if (loaded.error.kind === 'io_error') {
          expect(loaded.error.reason).toContain('identity mirrors disagree');
        }
      }
      expect(await readFile(primaryPath)).toEqual(primaryBefore);
      expect(await readFile(encPath(id))).toEqual(legacyBefore);
    } finally {
      rmSync(primaryDir, { recursive: true, force: true });
    }
  });

  it('a store that cannot converge both mirrors publishes NEITHER — no divergent primary (EI-21987155936742109)', async () => {
    // Live recurrence on Avis-iMac.local 2026-08-31: the configured shared mirror
    // held a fresh device key while the legacy HOME mirror still held the ATTESTED
    // one, so `fileLoad` fail-closed forever and all three P2P substrates stayed
    // unbooted. No rogue writer is needed to mint that split — `fileStore` is the
    // only writer, and it converged the mirrors in a bare sequential loop, primary
    // FIRST. Any interruption after the first write and before the second (crash,
    // kill, ENOSPC, an unmounted share, EACCES) leaves exactly the observed state.
    // Each individual file write was already atomic; the PAIR was not.
    if (process.getuid?.() === 0) return; // root ignores the mode bits this test turns on

    const primaryDir = mkdtempSync(join(tmpdir(), 'pc-keychain-partial-store-'));
    const legacyDir = join(TMP_HOME, '.papercusp', 'identity');
    process.env.PAPERCUSP_IDENTITY_DIR = primaryDir;
    const id = '1567022:Avis-iMac_local-aviweiss';
    const primaryPath = join(primaryDir, 'keypair-' + id.replace(/[^a-zA-Z0-9_-]/g, '_') + '.enc');
    const attestedDer = Buffer.from('attested-device-key-the-gist-binds');
    const freshDer = Buffer.from('fresh-device-key-nothing-attests--');

    try {
      // A healthy rig: the attested identity is converged across both mirrors.
      const { keychainStore } = await loadKeychain();
      await keychainStore(id, attestedDer);
      expect(existsSync(primaryPath)).toBe(true);
      expect(existsSync(encPath(id))).toBe(true);

      // The legacy root stops accepting writes (share drops / perms change).
      chmodSync(legacyDir, 0o500);
      await expect(keychainStore(id, freshDer)).rejects.toThrow();
      chmodSync(legacyDir, 0o700);

      // The rig must still boot. A store that could not reach every mirror must
      // not have published a primary the attestation cannot vouch for — that is
      // what bricks the device, because `fileLoad` then refuses both copies.
      vi.resetModules();
      const loaded = await (await loadKeychain()).keychainLoad(id);
      expect(loaded.kind).toBe('ok');
      if (loaded.kind === 'ok') expect(loaded.value.equals(attestedDer)).toBe(true);
    } finally {
      try {
        chmodSync(legacyDir, 0o700);
      } catch {
        /* best-effort: the test may have failed before the mode was restored */
      }
      rmSync(primaryDir, { recursive: true, force: true });
    }
  });

  it('probeTiers reports DIVERGED mirrors rather than a healthy-looking first match (EI-21987155936742109)', async () => {
    // The WI-2018 probe stopped at the first mirror that read, so the split it
    // was added to diagnose rendered as a perfectly healthy `file:'primary'`.
    const id = 'hive:default:probe-divergence';
    const attestedDer = Buffer.from('attested-key-for-probe-divergence-');
    const divergentDer = Buffer.from('divergent-key-for-probe-divergenc');

    const primaryDir = mkdtempSync(join(tmpdir(), 'pc-keychain-probe-divergent-'));
    process.env.PAPERCUSP_IDENTITY_DIR = primaryDir;
    try {
      const { keychainStore, keychainProbeTiers } = await loadKeychain();
      await keychainStore(id, attestedDer);
      const attestedLegacyBlob = await readFile(encPath(id));

      // CONTROL: two mirrors present and converged must NOT report divergence,
      // or the flag below would be indistinguishable from always-true.
      //
      // This is also the guard's sharpest edge. Each mirror is encrypted under
      // its OWN random salt+IV, so two mirrors holding the SAME key still have
      // completely different ciphertext — verified on the live rig 2026-08-31,
      // where the healthy swarm key's two mirrors differed in every byte. A
      // divergence check written as a byte compare therefore reports every
      // healthy box as split; only a decrypted-plaintext compare is correct.
      const convergedPrimaryBlob = await readFile(join(primaryDir, 'keypair-hive_default_probe-divergence.enc'));
      expect(convergedPrimaryBlob.equals(attestedLegacyBlob)).toBe(false);

      const converged = await keychainProbeTiers(id);
      expect(converged.file).toBe('primary');
      expect(converged.mirrorsDiverged).toBe(false);

      // Restore the earlier legacy ciphertext to reproduce the live split
      // without adding a test-only encryption seam to the production module.
      vi.resetModules();
      await (await loadKeychain()).keychainStore(id, divergentDer);
      writeFileSync(encPath(id), attestedLegacyBlob);

      vi.resetModules();
      const split = await (await loadKeychain()).keychainProbeTiers(id);
      expect(split.mirrorsDiverged).toBe(true);
      expect(split.file).toBe('primary'); // the pre-existing field keeps its meaning
    } finally {
      rmSync(primaryDir, { recursive: true, force: true });
    }
  });

  it('mirrors a configured fallback into HOME so an unconfigured launcher reuses the same identity', async () => {
    const customIdentityDir = mkdtempSync(join(tmpdir(), 'pc-keychain-identity-'));
    process.env.PAPERCUSP_IDENTITY_DIR = customIdentityDir;
    try {
      const { keychainStore } = await loadKeychain();
      const id = '279242982:papercusp-testvm-tester';
      const der = Buffer.from('shared-hive-device-key-material');
      const safe = id.replace(/[^a-zA-Z0-9_-]/g, '_');

      await keychainStore(id, der);

      expect(existsSync(join(customIdentityDir, 'keypair-' + safe + '.enc'))).toBe(true);
      expect(existsSync(encPath(id))).toBe(true);

      // Reproduce the stale installed launcher that omitted the configured
      // root. It must see the mirrored canonical DER, not a not_found that
      // authorizes loadOrGenerateDeviceKeypair to mint a split identity.
      delete process.env.PAPERCUSP_IDENTITY_DIR;
      vi.resetModules();
      const { keychainLoad } = await loadKeychain();
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

  it('atomically replaces the fallback and invalidates a load that races the write', async () => {
    const id = 'atomic:replacement';
    const oldDer = Buffer.from('old-private-key-material');
    const newDer = Buffer.from('new-private-key-material');
    const original = await loadKeychain();
    await original.keychainStore(id, oldDer);

    vi.resetModules();
    let tempWritten!: () => void;
    let releaseRename!: () => void;
    const sawTemp = new Promise<void>((resolve) => { tempWritten = resolve; });
    const renameGate = new Promise<void>((resolve) => { releaseRename = resolve; });
    vi.doMock('node:fs/promises', async (importOriginal) => {
      const actual = await importOriginal<typeof import('node:fs/promises')>();
      return {
        ...actual,
        writeFile: async (...args: Parameters<typeof actual.writeFile>) => {
          const result = await actual.writeFile(...args);
          if (String(args[0]).includes('.tmp-')) {
            tempWritten();
            await renameGate;
          }
          return result;
        },
      };
    });
    const keychain = await loadKeychain();
    const replacing = keychain.keychainStore(id, newDer);
    await sawTemp;

    // The complete old ciphertext remains at the final path until rename. A
    // direct O_TRUNC write made this concurrent load decryption_failed and
    // authorized the destructive regeneration fixed by WI-989591.
    const during = await keychain.keychainLoad(id);
    expect(during).toEqual({ kind: 'ok', value: oldDer });

    releaseRename();
    await replacing;
    expect(await keychain.keychainLoad(id)).toEqual({ kind: 'ok', value: newDer });
  });
});
