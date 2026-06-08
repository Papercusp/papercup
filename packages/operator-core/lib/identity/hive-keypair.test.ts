/**
 * hive-keypair — the per-HIVE Ed25519 identity keypair
 * (shared-hive-federation-2026-06-08 P-002).
 *
 * Hermetic like keychain.test.ts: stub `node:child_process` execFile so the OS
 * keychain CLIs look uninstalled (force the encrypted-file fallback) and point
 * $HOME at a fresh temp dir. We additionally RECORD the execFile calls so we
 * can assert the hive service namespace is threaded through to the backend.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let TMP_HOME: string;
let origHome: string | undefined;
const execCalls: Array<{ cmd: string; args: string[] }> = [];

function mockChildProcess() {
  vi.doMock('node:child_process', () => ({
    execFile: (cmd: string, args: string[], _opts: unknown, cb: (e: Error) => void) => {
      execCalls.push({ cmd, args });
      cb(Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }));
    },
  }));
}

beforeEach(() => {
  vi.resetModules();
  execCalls.length = 0;
  TMP_HOME = mkdtempSync(join(tmpdir(), 'pc-hive-kp-'));
  origHome = process.env.HOME;
  process.env.HOME = TMP_HOME; // os.homedir() honors $HOME on POSIX → keychain file under $HOME/.papercusp/identity
  mockChildProcess();
});

afterEach(() => {
  if (origHome === undefined) delete process.env.HOME;
  else process.env.HOME = origHome;
  vi.doUnmock('node:child_process');
  try {
    rmSync(TMP_HOME, { recursive: true, force: true });
  } catch {
    /* best-effort cleanup */
  }
});

/** Load hive-keypair + ed25519 from the freshly-mocked module graph. */
async function load() {
  const hk = await import('./hive-keypair');
  const ed = await import('./ed25519');
  return { ...hk, verifyEd25519: ed.verifyEd25519 };
}

describe('hiveKeychainId', () => {
  it('is `hive:<ws>:<slug>` and validates its inputs', async () => {
    const { hiveKeychainId } = await load();
    expect(hiveKeychainId('ws1', 'my-hive')).toBe('hive:ws1:my-hive');
    expect(() => hiveKeychainId('', 's')).toThrow(/workspaceId/);
    expect(() => hiveKeychainId('w', '')).toThrow(/slug/);
  });
});

describe('loadOrGenerateHiveKeypair', () => {
  it('generates on first call — returns the keychainId + a 32-byte b64 pubkey', async () => {
    const { loadOrGenerateHiveKeypair } = await load();
    const kp = await loadOrGenerateHiveKeypair('ws1', 'alpha');
    expect(kp.keychainId).toBe('hive:ws1:alpha');
    expect(Buffer.from(kp.pubkeyBase64, 'base64')).toHaveLength(32);
  });

  it('is idempotent — a second call returns the SAME pubkey (persisted, not regenerated)', async () => {
    const { loadOrGenerateHiveKeypair } = await load();
    const a = await loadOrGenerateHiveKeypair('ws1', 'alpha');
    const b = await loadOrGenerateHiveKeypair('ws1', 'alpha');
    expect(b.pubkeyBase64).toBe(a.pubkeyBase64);
  });

  it('is STABLE across a module reload (simulated operator restart)', async () => {
    const a = await (await load()).loadOrGenerateHiveKeypair('ws1', 'alpha');
    // Simulate a restart: reset the module graph + re-mock, but keep $HOME (so the
    // keychain file survives) — the keypair must be the same one, not a new mint.
    vi.resetModules();
    mockChildProcess();
    const b = await (await import('./hive-keypair')).loadOrGenerateHiveKeypair('ws1', 'alpha');
    expect(b.pubkeyBase64).toBe(a.pubkeyBase64);
  });

  it('distinct hives (different slug OR workspace) get distinct keypairs', async () => {
    const { loadOrGenerateHiveKeypair } = await load();
    const a = await loadOrGenerateHiveKeypair('ws1', 'alpha');
    const b = await loadOrGenerateHiveKeypair('ws1', 'beta');
    const c = await loadOrGenerateHiveKeypair('ws2', 'alpha');
    expect(new Set([a.pubkeyBase64, b.pubkeyBase64, c.pubkeyBase64]).size).toBe(3);
  });

  it('threads the hive keychain SERVICE namespace to the OS backend (not the device service)', async () => {
    const { loadOrGenerateHiveKeypair, HIVE_KEYPAIR_SERVICE } = await load();
    await loadOrGenerateHiveKeypair('ws1', 'alpha');
    expect(HIVE_KEYPAIR_SERVICE).toBe('papercusp-hive-keypair');
    expect(execCalls.some((c) => c.cmd === 'secret-tool' && c.args.includes(HIVE_KEYPAIR_SERVICE))).toBe(true);
    expect(execCalls.some((c) => c.args.includes('papercusp-device-keypair'))).toBe(false);
  });
});

describe('signWithHiveKey + loadHivePubkey', () => {
  it('signs with the hive key; the signature verifies against the hive pubkey only', async () => {
    const { loadOrGenerateHiveKeypair, signWithHiveKey, verifyEd25519 } = await load();
    const kp = await loadOrGenerateHiveKeypair('ws1', 'alpha');
    const msg = Buffer.from('hive federation envelope');
    const sig = await signWithHiveKey('ws1', 'alpha', msg);
    expect(sig).toHaveLength(64);
    expect(verifyEd25519(msg, kp.pubkeyBase64, sig)).toBe(true);
    // a different hive's pubkey must NOT verify it
    const other = await loadOrGenerateHiveKeypair('ws1', 'beta');
    expect(verifyEd25519(msg, other.pubkeyBase64, sig)).toBe(false);
  });

  it('signWithHiveKey throws when this Swarm holds no key for the hive', async () => {
    const { signWithHiveKey } = await load();
    await expect(signWithHiveKey('ws1', 'absent', Buffer.from('x'))).rejects.toThrow(/not held/);
  });

  it('loadHivePubkey returns null when absent, then the pubkey once minted', async () => {
    const { loadOrGenerateHiveKeypair, loadHivePubkey } = await load();
    expect(await loadHivePubkey('ws1', 'ghost')).toBeNull();
    const kp = await loadOrGenerateHiveKeypair('ws1', 'ghost');
    expect(await loadHivePubkey('ws1', 'ghost')).toBe(kp.pubkeyBase64);
  });
});
