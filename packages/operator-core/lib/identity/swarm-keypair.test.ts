/**
 * swarm-keypair — EI-18683526122026208. Hermetic like hive-keypair.test.ts:
 * stub `node:child_process` execFile so the OS keychain CLIs look uninstalled
 * (forcing the encrypted-file fallback) and point $HOME at a fresh temp dir.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let TMP_HOME: string;
let origHome: string | undefined;
let origOverrideId: string | undefined;

function mockChildProcess() {
  vi.doMock('node:child_process', () => ({
    execFile: (_cmd: string, _args: string[], _opts: unknown, cb: (e: Error) => void) => {
      cb(Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }));
    },
  }));
}

beforeEach(() => {
  vi.resetModules();
  TMP_HOME = mkdtempSync(join(tmpdir(), 'pc-swarm-kp-'));
  origHome = process.env.HOME;
  origOverrideId = process.env.PAPERCUSP_SWARM_IDENTITY_ID;
  delete process.env.PAPERCUSP_SWARM_IDENTITY_ID;
  process.env.HOME = TMP_HOME;
  mockChildProcess();
});

afterEach(() => {
  if (origHome === undefined) delete process.env.HOME;
  else process.env.HOME = origHome;
  if (origOverrideId === undefined) delete process.env.PAPERCUSP_SWARM_IDENTITY_ID;
  else process.env.PAPERCUSP_SWARM_IDENTITY_ID = origOverrideId;
  vi.doUnmock('node:child_process');
  try {
    rmSync(TMP_HOME, { recursive: true, force: true });
  } catch {
    /* best-effort cleanup */
  }
});

async function load() {
  return import('./swarm-keypair');
}

describe('swarmIdentityKeychainId', () => {
  it('defaults to a machine-fingerprint-scoped id', async () => {
    const { swarmIdentityKeychainId } = await load();
    const id = swarmIdentityKeychainId({ hostname: 'box1', username: 'alice' });
    expect(id).toBe('swarm:box1-alice');
  });

  it('PAPERCUSP_SWARM_IDENTITY_ID overrides the default', async () => {
    process.env.PAPERCUSP_SWARM_IDENTITY_ID = 'custom-instance';
    const { swarmIdentityKeychainId } = await load();
    expect(swarmIdentityKeychainId({ hostname: 'box1', username: 'alice' })).toBe('swarm:custom-instance');
  });
});

describe('loadOrGenerateSwarmSeed', () => {
  it('mints a 32-byte seed on first call', async () => {
    const { loadOrGenerateSwarmSeed } = await load();
    const seed = await loadOrGenerateSwarmSeed();
    expect(seed).toBeInstanceOf(Buffer);
    expect(seed.length).toBe(32);
  });

  it('is idempotent: repeated calls in the SAME process return the identical seed', async () => {
    const { loadOrGenerateSwarmSeed } = await load();
    const a = await loadOrGenerateSwarmSeed();
    const b = await loadOrGenerateSwarmSeed();
    expect(b.equals(a)).toBe(true);
  });

  it('SURVIVES a fresh module load (simulates a process restart)', async () => {
    const first = await load();
    const seed1 = await first.loadOrGenerateSwarmSeed();

    // Force a fresh module graph — the in-memory keychain load-cache from the
    // first import must not be what makes this pass; only the on-disk
    // encrypted-file fallback (same $HOME) should.
    vi.resetModules();
    mockChildProcess();
    const second = await load();
    const seed2 = await second.loadOrGenerateSwarmSeed();

    expect(seed2.equals(seed1)).toBe(true);
  });

  it('two DIFFERENT PAPERCUSP_SWARM_IDENTITY_ID overrides get DIFFERENT seeds', async () => {
    process.env.PAPERCUSP_SWARM_IDENTITY_ID = 'instance-a';
    const a = await load();
    const seedA = await a.loadOrGenerateSwarmSeed();

    vi.resetModules();
    mockChildProcess();
    process.env.PAPERCUSP_SWARM_IDENTITY_ID = 'instance-b';
    const b = await load();
    const seedB = await b.loadOrGenerateSwarmSeed();

    expect(seedB.equals(seedA)).toBe(false);
  });
});
