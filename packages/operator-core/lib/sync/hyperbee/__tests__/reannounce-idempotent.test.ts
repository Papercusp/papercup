/**
 * P-504 / WI-2141185 — idempotent re-admission.
 *
 * A peer re-sends its signed announce on every writer-progress tick and on
 * every re-pair, and the shared swarm socket fans each frame out to every
 * local harness on the topic. Before this guard, EVERY such frame re-ran the
 * full admission path (binding verification / hive-members read, a
 * boot-history record + PG insert, a merge poke) — measured on the tower as
 * 35k `announce_admitted` lines/min, PG pool starvation and V8 OOM aborts.
 *
 * Contract under test:
 *   - a same-identity re-announce from an already-admitted peer is answered
 *     `admit` WITHOUT re-running admission or re-recording the boot event;
 *   - the suppression is observable but bounded (one log line, not one per frame);
 *   - an identity change, a tampered signature, and a revoked device are NOT
 *     short-circuited — they still take the full path and get its verdict.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { generateKeyPairSync, sign as nodeSign, type KeyObject } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  bootHarnessSubstrate as bootHarnessSubstrateImpl,
  type BootHarnessOpts,
} from '../boot';
import { buildAnnounce, type SignedAnnounce } from '../announce';
import { _resetCacheForTests } from '../corestore';
import { _clearRegistryForTests } from '../projection';
import { _resetBootHistoryForTests, listBootHistory } from '../boot-history';

function bootHarnessSubstrate(opts: BootHarnessOpts) {
  return bootHarnessSubstrateImpl({ rekeyDepsOverride: null, ...opts });
}

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) {
    try {
      await cleanups.pop()!();
    } catch {}
  }
  _resetCacheForTests();
  _clearRegistryForTests();
  _resetBootHistoryForTests();
  vi.restoreAllMocks();
});

function tmpDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {}
  });
  return dir;
}

interface Identity {
  privateKey: KeyObject;
  devicePubkey: string;
}

function makeIdentity(): Identity {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const devicePubkey = (publicKey.export({ type: 'spki', format: 'der' }) as Buffer)
    .subarray(-32)
    .toString('base64');
  return { privateKey, devicePubkey };
}

/** A freshly signed announce (new ts) for the SAME device identity + log key. */
async function announceFor(id: Identity, logCoreKey: string): Promise<SignedAnnounce> {
  const body = {
    device_pubkey: id.devicePubkey,
    github_user_id: 4242,
    github_login: 'alice',
    attestation_gist_id: 'gist-test',
    log_core_key: logCoreKey,
  };
  return buildAnnounce(body, async (bytes) => nodeSign(null, bytes, id.privateKey));
}

function admittedEventsFor(harnessSlug: string): number {
  return listBootHistory({ harnessSlug, kinds: ['announce_admitted'] }).length;
}

describe('P-504 idempotent re-admission (re-announce from an already-admitted peer)', () => {
  it('answers admit without re-running admission, re-recording the boot event, or logging per frame', async () => {
    let verifyCalls = 0;
    const harnessSlug = 'reann-1';
    const handle = await bootHarnessSubstrate({
      workspaceRoot: tmpDir('reann-'),
      workspaceId: 'ws-reann-1',
      harnessSlug,
      mergePollMs: 0,
      pendingRetryMs: 0,
      loadRevokedOverride: async () => new Set(),
      verifyBindingOverride: async () => {
        verifyCalls++;
        return 'verified';
      },
      applyOverride: async () => true,
    });
    cleanups.push(() => handle.close());
    const admittedEvents: unknown[] = [];
    cleanups.push(handle.onAdmitted((info) => admittedEvents.push(info)));
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const id = makeIdentity();
    const logCoreKey = 'ab'.repeat(32);

    // First announce: the real admission.
    await expect(handle.onAnnounce(await announceFor(id, logCoreKey))).resolves.toEqual({
      admit: true,
    });
    expect(verifyCalls).toBe(1);
    expect(handle.admitted.has(logCoreKey)).toBe(true);
    expect(admittedEvents).toHaveLength(1);
    expect(admittedEventsFor(harnessSlug)).toBe(1);

    // Re-announces (fresh ts, same identity): admit, but NOTHING re-runs.
    for (let i = 0; i < 25; i++) {
      await expect(handle.onAnnounce(await announceFor(id, logCoreKey))).resolves.toEqual({
        admit: true,
      });
    }
    expect(verifyCalls).toBe(1);
    expect(admittedEvents).toHaveLength(1);
    expect(admittedEventsFor(harnessSlug)).toBe(1);

    // Bounded observability: exactly ONE suppression line for 25 suppressed frames.
    const suppressionLines = logSpy.mock.calls.filter(
      (args) => typeof args[0] === 'string' && args[0].includes('re-announce suppressed'),
    );
    expect(suppressionLines).toHaveLength(1);
    expect(suppressionLines[0][0]).toContain(`harness=${harnessSlug}`);
  });

  it('is NOT short-circuited by an identity change, a tampered signature, or a revoked device', async () => {
    let verifyCalls = 0;
    const harnessSlug = 'reann-2';
    const handle = await bootHarnessSubstrate({
      workspaceRoot: tmpDir('reann-neg-'),
      workspaceId: 'ws-reann-2',
      harnessSlug,
      mergePollMs: 0,
      pendingRetryMs: 0,
      loadRevokedOverride: async () => new Set(),
      verifyBindingOverride: async () => {
        verifyCalls++;
        return 'verified';
      },
      applyOverride: async () => true,
    });
    cleanups.push(() => handle.close());
    vi.spyOn(console, 'log').mockImplementation(() => {});

    const id = makeIdentity();
    const logCoreKey = 'cd'.repeat(32);
    await expect(handle.onAnnounce(await announceFor(id, logCoreKey))).resolves.toEqual({
      admit: true,
    });
    expect(verifyCalls).toBe(1);

    // Positive control for the assertions below: a same-identity re-announce
    // IS short-circuited (verifyCalls must not move).
    await handle.onAnnounce(await announceFor(id, logCoreKey));
    expect(verifyCalls).toBe(1);

    // (1) Tampered signature → sigValid=false → full path → rejected, never admit.
    const forged: SignedAnnounce = {
      ...(await announceFor(id, logCoreKey)),
      sig: Buffer.alloc(64, 7).toString('base64'),
    };
    const forgedDecision = await handle.onAnnounce(forged);
    expect(forgedDecision.admit).toBe(false);

    // (2) Identity change on the same log key (a different device signs it) →
    //     full admission runs again (verifyBinding is consulted).
    const otherDevice = makeIdentity();
    await expect(handle.onAnnounce(await announceFor(otherDevice, logCoreKey))).resolves.toEqual({
      admit: true,
    });
    expect(verifyCalls).toBe(2);

    // (3) Revoked device → not short-circuited; the full path refuses it.
    await handle.revoke(otherDevice.devicePubkey);
    const revokedDecision = await handle.onAnnounce(await announceFor(otherDevice, logCoreKey));
    expect(revokedDecision.admit).toBe(false);
  });
});
