/**
 * swarm-join-retry.test.ts — WI-752 / FED-2: a substrate whose boot-time swarm
 * join FAILS (transient identity / DHT / keychain blip) must RETRY the join and
 * federate WITHOUT an operator restart.
 *
 * Pre-WI-752 the join was one-shot: any failure in
 * `resolveLocalAnnounceIdentity` (gh user / keychain) made boot's catch keep the
 * harness LOCAL-ONLY forever (`handle.swarm === null`) — the exact "BOTH VMs
 * gh-unauthed → never announce → dead link" shape, recoverable only by a
 * restart. Now boot retries the join on a bounded backoff, so the instant the
 * cause clears (a token returns, the keychain unlocks) the harness joins itself.
 *
 * This is a fast `*.test.ts` (no Docker / PG / real network): a FAKE swarm (no
 * wire) + an identity resolver that THROWS on the first call then succeeds, so
 * the first join fails and the retry's join succeeds. A real on-disk corestore
 * is used (boot opens one) and torn down in afterEach.
 */
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { generateKeyPairSync, sign as nodeSign } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bootHarnessSubstrate, type BootedHarnessHandle } from '../boot';
import { type HyperswarmLike } from '../swarm';
import { _setSwarmGuardForTests, type SwarmGuard } from '../swarm-guard';
import type { OpEnvelope } from '../op-envelope-types';
import { _resetBootHistoryForTests } from '../boot-history';
import { _resetCacheForTests, closeHarnessStore } from '../corestore';

const ALLOW_GUARD: SwarmGuard = {
  firewall: () => false,
  isBannedKey: () => false,
  isBannedIp: () => false,
  banKey: () => {},
  banIp: () => {},
  recordConnection: async () => ({ allow: true }),
};

const cleanups: Array<() => void | Promise<void>> = [];

// The boot-time join-failure path warns on purpose ('[swarm] join FAILED …');
// the repo's fail-on-console would redden the test, so silence console.warn.
beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(async () => {
  while (cleanups.length) {
    try {
      await cleanups.pop()!();
    } catch {
      /* best-effort */
    }
  }
  _setSwarmGuardForTests(null);
  _resetCacheForTests();
  _resetBootHistoryForTests();
  vi.restoreAllMocks();
});

function makeWorkspaceRoot(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });
  return dir;
}

function rawPubkeyBase64(publicKey: ReturnType<typeof generateKeyPairSync>['publicKey']): string {
  const spkiDer = publicKey.export({ type: 'spki', format: 'der' }) as Buffer;
  return spkiDer.subarray(-32).toString('base64');
}

/** A no-wire fake swarm — `join` succeeds, no peers ever connect. */
function makeFakeSwarm(): HyperswarmLike {
  return {
    join: () => ({ flushed: async () => {}, refresh: () => {} }),
    leave: () => {},
    on: () => {},
    off: () => {},
    connections: [],
  };
}

/**
 * An identity override whose `resolveGithubUser` THROWS the first `failTimes`
 * calls (simulating a transient gh-auth / identity blip), then succeeds. The
 * caller reads `calls()` to assert the retry actually re-attempted.
 */
function makeFlakyIdentity(login: string, userId: number, keychainId: string, failTimes: number) {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const devicePubkey = rawPubkeyBase64(publicKey);
  let calls = 0;
  return {
    devicePubkey,
    calls: () => calls,
    override: {
      resolveOpts: {
        keychainId,
        resolveGithubUser: async () => {
          calls++;
          if (calls <= failTimes) throw new Error(`transient identity blip #${calls}`);
          return { id: userId, login };
        },
        loadKeypair: async (id: string) => ({ keychainId: id, pubkeyBase64: devicePubkey }),
        resolveAttestationGistId: async () => `gist-${login}`,
      },
      sign: async (_keychainId: string, bytes: Buffer) => nodeSign(null, bytes, privateKey),
    },
  };
}

async function pollUntil<T>(
  fn: () => T | Promise<T>,
  { timeoutMs, intervalMs }: { timeoutMs: number; intervalMs: number },
): Promise<T | undefined> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() >= deadline) return undefined;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

describe('FED-2 join-retry — a failed boot-time swarm join self-heals without a restart', () => {
  it('retries the join after a transient identity failure and federates (no restart)', async () => {
    _setSwarmGuardForTests(ALLOW_GUARD);
    const workspaceId = 'ws-join-retry';
    const harnessSlug = 'sheets';
    const binding = { kind: 'local' as const, workspace_id: workspaceId, harness_slug: harnessSlug };
    const id = makeFlakyIdentity('alice', 4242, 'kc-alice', 1); // fail once, then succeed
    const root = makeWorkspaceRoot('sjr-');

    const handle: BootedHarnessHandle = await bootHarnessSubstrate({
      workspaceRoot: root,
      workspaceId,
      harnessSlug,
      swarmBinding: binding,
      swarmOverride: makeFakeSwarm(),
      verifyBindingOverride: async () => 'verified',
      applyOverride: vi.fn<(op: OpEnvelope) => Promise<boolean>>(async () => true),
      mergePollMs: 0,
      pendingRetryMs: 0,
      loadRevokedOverride: async () => new Set(),
      announceIdentityOverride: id.override,
      swarmJoinRetryMs: 40, // fast retry for the test
    });
    cleanups.push(async () => {
      await handle.close();
      await closeHarnessStore({ workspaceRoot: root, harnessSlug });
    });

    // The FIRST join failed → boot returns local-only.
    expect(handle.swarm, 'first join should have failed → local-only at boot').toBeNull();

    // The retry loop re-attempts and, now that the identity resolves, JOINS —
    // with no restart and nothing external poking it.
    const joined = await pollUntil(() => handle.swarm, { timeoutMs: 4000, intervalMs: 25 });
    expect(joined, 'join never recovered via the retry loop').toBeTruthy();
    expect(handle.swarm!.topicHex).toMatch(/^[0-9a-f]{64}$/);
    expect(id.calls()).toBeGreaterThanOrEqual(2); // initial + at least one retry
  }, 20_000);

  it('swarmJoinRetryMs: 0 disables the retry (stays local-only)', async () => {
    _setSwarmGuardForTests(ALLOW_GUARD);
    const workspaceId = 'ws-join-retry-off';
    const harnessSlug = 'sheets';
    const binding = { kind: 'local' as const, workspace_id: workspaceId, harness_slug: harnessSlug };
    const id = makeFlakyIdentity('bob', 7, 'kc-bob', 1); // would succeed on retry #2 — but retry is OFF
    const root = makeWorkspaceRoot('sjr-off-');

    const handle: BootedHarnessHandle = await bootHarnessSubstrate({
      workspaceRoot: root,
      workspaceId,
      harnessSlug,
      swarmBinding: binding,
      swarmOverride: makeFakeSwarm(),
      verifyBindingOverride: async () => 'verified',
      applyOverride: vi.fn<(op: OpEnvelope) => Promise<boolean>>(async () => true),
      mergePollMs: 0,
      pendingRetryMs: 0,
      loadRevokedOverride: async () => new Set(),
      announceIdentityOverride: id.override,
      swarmJoinRetryMs: 0, // DISABLED
    });
    cleanups.push(async () => {
      await handle.close();
      await closeHarnessStore({ workspaceRoot: root, harnessSlug });
    });

    expect(handle.swarm).toBeNull();
    // Give a retry loop (if it wrongly existed) time to fire — it must NOT.
    await new Promise((r) => setTimeout(r, 300));
    expect(handle.swarm, 'retry was disabled but the harness joined anyway').toBeNull();
    expect(id.calls()).toBe(1); // only the one boot-time attempt, no retries
  }, 20_000);
});
