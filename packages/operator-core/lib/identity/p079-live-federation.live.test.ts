/**
 * p079-live-federation.live.test.ts — the REAL P-079 bidirectional-federation
 * acceptance test, run in-process with TWO genuinely distinct GitHub identities.
 *
 * This is the live counterpart to `two-peer-swarm-bidi.test.ts` (which stands in
 * for the binding gate with `verifyBindingOverride`). Here NOTHING about the
 * GitHub identity path is stubbed: real OAuth tokens for two real accounts, real
 * attestation gists owned by each account, the REAL `verifyChannel1` (OAuth) +
 * the REAL `verifyAttestation` (gist ownership) admitting each peer — finally
 * over the REAL Hyperswarm transport with the real write-free admission adapter
 * (`buildVerifyBindingAdapter`) as the gate.
 *
 * ## Write-free join (non-collaborator-join-fork-pr-2026-06-02)
 * Admission proves the `device_pubkey ↔ github_user_id` binding from the
 * device-signed announce (which carries the attestation gist id) +
 * `verifyAttestation` on that gist — with NO shared-repo contributor file and
 * NO upstream write at join. So this test deliberately provisions ONLY the
 * per-account attestation gists + signed announces and creates NO shared repo,
 * NO `user/<id>` contributor-file branches, and needs NO collaborator grant —
 * which is exactly what proves join is genuinely write-free.
 *
 * It closes the one thing the offline `two-peer-swarm-bidi` test cannot assert:
 * the real two-identity gist publish→verify loop (runbook
 * `/internal/docs/testing/p079-bidirectional-federation`, "Mode A").
 *
 * ## Gated — does NOT run in CI / `test:affected`
 * Requires two live `gh`-authenticated GitHub accounts + network, so it is
 * skipped unless `P079_LIVE=1`. The two identities default to `papercupai`
 * (active) + `aviynw` (keyring) and are overridable via `P079_LOGIN_A` /
 * `P079_LOGIN_B`.
 *
 *   P079_LIVE=1 npx vitest run p079-live-federation.live --config vitest.config.ts
 *
 * What it creates on GitHub (all auto-cleaned in afterAll): two public
 * attestation gists. Swarm runs on a LOCAL testnet DHT (offline), not the
 * public DHT.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  generateKeyPairSync,
  sign as nodeSign,
  type KeyObject,
} from 'node:crypto';
import { execFile as _execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import createTestnet from 'hyperdht/testnet.js';
import Hyperswarm from 'hyperswarm';

import {
  createAttestationGist,
  verifyAttestation,
  clearAttestationCache,
} from './attest';
import { keychainStore, keychainDelete } from './keychain';
import { verifyChannel1 } from './two-channel-verifier';
import { buildVerifyBindingAdapter } from '../sync/hyperbee/verify-binding-adapter';
import { bootHarnessSubstrate } from '../sync/hyperbee/boot';
import { type HyperswarmLike } from '../sync/hyperbee/swarm';
import type { OpEnvelope } from '../sync/hyperbee/op-envelope-types';
import { listBootHistory, _resetBootHistoryForTests } from '../sync/hyperbee/boot-history';
import { _resetCacheForTests, closeHarnessStore } from '../sync/hyperbee/corestore';

const execFile = promisify(_execFile);

const LIVE = process.env.P079_LIVE === '1';
const LOGIN_A = process.env.P079_LOGIN_A ?? 'papercupai';
const LOGIN_B = process.env.P079_LOGIN_B ?? 'aviynw';

// ─── live identity state, populated in beforeAll ────────────────────────────────

interface LivePeer {
  /** Configured gh account login (used to fetch the token). */
  ghAccount: string;
  /** Resolved numeric GitHub user id (from GET /user). */
  userId: number;
  /** Resolved GitHub login (from GET /user — authoritative). */
  login: string;
  /** OAuth token for this account. */
  token: string;
  /** Throwaway keychain id — deleted in afterAll. */
  keychainId: string;
  /** In-memory device private key (also stored in keychain for createAttestationGist). */
  privateKey: KeyObject;
  /** Raw 32-byte Ed25519 device pubkey, base64. */
  pubkeyBase64: string;
  /** Real attestation gist id, created under this account. */
  gistId: string;
}

let peerA: LivePeer; // publisher (Alice)
let peerB: LivePeer; // joiner (Bob)

// Resources to tear down (newest-first), used by the swarm stage.
const swarmCleanups: Array<() => void | Promise<void>> = [];

// ─── helpers ────────────────────────────────────────────────────────────────────

/** Raw 32-byte Ed25519 pubkey, base64 — the binding's `device_pubkey` convention. */
function rawPubkeyBase64(publicKey: KeyObject): string {
  const spkiDer = publicKey.export({ type: 'spki', format: 'der' }) as Buffer;
  return spkiDer.subarray(-32).toString('base64');
}

/** Resolve a specific account's OAuth token non-interactively via gh. */
async function ghTokenFor(account: string): Promise<string> {
  const { stdout } = await execFile('gh', ['auth', 'token', '--user', account]);
  const token = stdout.trim();
  if (!token) throw new Error(`no gh token for account '${account}'`);
  return token;
}

/** GET /user with a token → { id, login }. This is the live Channel-1 surface. */
async function ghUser(token: string): Promise<{ id: number; login: string }> {
  const resp = await fetch('https://api.github.com/user', {
    headers: {
      Authorization: 'token ' + token,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
  if (!resp.ok) throw new Error('GET /user failed: ' + resp.status);
  const data = (await resp.json()) as { id: number; login: string };
  return { id: data.id, login: data.login };
}

/** Provision one peer: keypair → keychain → real attestation gist. */
async function provisionPeer(ghAccount: string): Promise<LivePeer> {
  const token = await ghTokenFor(ghAccount);
  const { id, login } = await ghUser(token);
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const pubkeyBase64 = rawPubkeyBase64(publicKey);
  const keychainId = `p079-live-test:${login}:${id}`;
  const privDer = privateKey.export({ type: 'pkcs8', format: 'der' }) as Buffer;
  await keychainStore(keychainId, privDer);
  const gist = await createAttestationGist({
    keychainId,
    pubkeyBase64,
    deviceLabel: `p079-live-${login}`,
    githubUserId: id,
    githubLogin: login,
    token,
  });
  return { ghAccount, userId: id, login, token, keychainId, privateKey, pubkeyBase64, gistId: gist.gistId };
}

/** Poll `fn()` until truthy or timeout. */
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

/** A real `hyperswarm` bootstrapped to a local testnet DHT (offline). */
function makeSwarm(bootstrap: unknown): HyperswarmLike {
  const swarm = new Hyperswarm({ bootstrap }) as unknown as HyperswarmLike & { destroy(): Promise<void> };
  swarmCleanups.push(async () => {
    try {
      await swarm.destroy();
    } catch {
      /* ignore */
    }
  });
  return swarm;
}

/** Build the announceIdentityOverride for a peer from its real identity + device key. */
function announceOverrideFor(peer: LivePeer) {
  return {
    resolveOpts: {
      keychainId: peer.keychainId,
      resolveGithubUser: async () => ({ id: peer.userId, login: peer.login }),
      loadKeypair: async (id: string) => ({ keychainId: id, pubkeyBase64: peer.pubkeyBase64 }),
      // Carry this peer's REAL attestation gist id on the announce.
      resolveAttestationGistId: async () => peer.gistId,
    },
    sign: async (_id: string, bytes: Buffer) => nodeSign(null, bytes, peer.privateKey),
  };
}

// ─── the gated live suite ───────────────────────────────────────────────────────

describe.skipIf(!LIVE)('P-079 LIVE bidirectional federation (two real GitHub identities)', () => {
  beforeAll(async () => {
    // Provision both peers (tokens, ids, keypairs, real attestation gists). NO
    // shared repo + NO contributor-file branches are created: write-free join
    // (non-collaborator-join-fork-pr-2026-06-02) admits purely on the announced
    // gist id + verifyAttestation, so the gists + announces are all we provision.
    peerA = await provisionPeer(LOGIN_A);
    peerB = await provisionPeer(LOGIN_B);
    expect(peerA.userId).not.toBe(peerB.userId); // genuinely distinct identities

    clearAttestationCache();
    // eslint-disable-next-line no-console
    console.info(
      `[P-079 live] A=${peerA.login}#${peerA.userId} B=${peerB.login}#${peerB.userId} (write-free: gists + announces only, no shared repo)`,
    );
  }, 240_000);

  afterAll(async () => {
    // Swarm resources first (newest-first).
    while (swarmCleanups.length) {
      try {
        await swarmCleanups.pop()!();
      } catch {
        /* ignore */
      }
    }
    _resetCacheForTests();
    _resetBootHistoryForTests();

    // Delete the two attestation gists.
    for (const peer of [peerA, peerB]) {
      if (!peer?.gistId) continue;
      try {
        await fetch('https://api.github.com/gists/' + peer.gistId, {
          method: 'DELETE',
          headers: { Authorization: 'token ' + peer.token, Accept: 'application/vnd.github+json' },
        });
      } catch {
        /* best-effort */
      }
    }
    // Delete throwaway keychain entries.
    for (const peer of [peerA, peerB]) {
      if (!peer?.keychainId) continue;
      try {
        await keychainDelete(peer.keychainId);
      } catch {
        /* best-effort */
      }
    }
  }, 120_000);

  it('Channel 1 (OAuth GET /user): each token identifies its claimed user; cross-claim is rejected', async () => {
    expect(await verifyChannel1({ token: peerA.token, claimedGithubUserId: peerA.userId })).toEqual({ kind: 'ok' });
    expect(await verifyChannel1({ token: peerB.token, claimedGithubUserId: peerB.userId })).toEqual({ kind: 'ok' });
    // Forgery: A's token claiming B's id → mismatch.
    expect(await verifyChannel1({ token: peerA.token, claimedGithubUserId: peerB.userId })).toEqual({
      kind: 'fail',
      reason: 'oauth_user_id_mismatch',
    });
  }, 60_000);

  it('Write-free binding crux (gist ownership): each attestation gist is owned by the claimed id, both ways; cross-claimed gist is rejected', async () => {
    const a = await verifyAttestation(peerA.gistId, peerA.pubkeyBase64, peerA.userId, { skipCache: true });
    const b = await verifyAttestation(peerB.gistId, peerB.pubkeyBase64, peerB.userId, { skipCache: true });
    expect(a.valid).toBe(true);
    expect(a.resolvedGithubUserId).toBe(peerA.userId);
    expect(b.valid).toBe(true);
    expect(b.resolvedGithubUserId).toBe(peerB.userId);
    // Forgery (D-006): A's real gist claimed under B's id → github_user_id_mismatch.
    const forged = await verifyAttestation(peerA.gistId, peerA.pubkeyBase64, peerB.userId, { skipCache: true });
    expect(forged.valid).toBe(false);
    expect(forged.reason).toBe('github_user_id_mismatch');
  }, 60_000);

  it('Swarm: the two real identities federate a feature BOTH ways over real Hyperswarm, gated by the REAL write-free verifyAttestation adapter (no override)', async () => {
    clearAttestationCache();
    const testnet = await createTestnet(3);
    swarmCleanups.push(async () => {
      try {
        await testnet.destroy();
      } catch {
        /* ignore */
      }
    });

    const workspaceId = 'ws-p079-live';
    const harnessSlug = 'p079live';
    const binding = { kind: 'local' as const, workspace_id: workspaceId, harness_slug: harnessSlug };

    const rootA = mkdtempSync(join(tmpdir(), 'p079-live-A-'));
    const rootB = mkdtempSync(join(tmpdir(), 'p079-live-B-'));
    swarmCleanups.push(() => rmSync(rootA, { recursive: true, force: true }));
    swarmCleanups.push(() => rmSync(rootB, { recursive: true, force: true }));

    const applyA = vi.fn<(op: OpEnvelope) => Promise<boolean>>(async () => true);
    const applyB = vi.fn<(op: OpEnvelope) => Promise<boolean>>(async () => true);

    // The REAL admission gate (write-free join): the stateless adapter runs the
    // real verifyAttestation against each peer's REAL attestation gist (carried
    // on the announce via announceOverrideFor → resolveAttestationGistId). No
    // shared-repo read, no override — gists are public so no token/context needed.
    const gateA = buildVerifyBindingAdapter();
    const gateB = buildVerifyBindingAdapter();

    const handleA = await bootHarnessSubstrate({
      workspaceRoot: rootA,
      workspaceId,
      harnessSlug,
      swarmBinding: binding,
      swarmOverride: makeSwarm(testnet.bootstrap),
      verifyBindingOverride: gateA, // REAL write-free verifyAttestation adapter
      applyOverride: applyA,
      mergePollMs: 0,
      pendingRetryMs: 0,
      loadRevokedOverride: async () => new Set(),
      announceIdentityOverride: announceOverrideFor(peerA),
    });
    swarmCleanups.push(async () => {
      await handleA.close();
      await closeHarnessStore({ workspaceRoot: rootA, harnessSlug });
    });

    const handleB = await bootHarnessSubstrate({
      workspaceRoot: rootB,
      workspaceId,
      harnessSlug,
      swarmBinding: binding,
      swarmOverride: makeSwarm(testnet.bootstrap),
      verifyBindingOverride: gateB, // REAL write-free verifyAttestation adapter
      applyOverride: applyB,
      mergePollMs: 0,
      pendingRetryMs: 0,
      loadRevokedOverride: async () => new Set(),
      announceIdentityOverride: announceOverrideFor(peerB),
    });
    swarmCleanups.push(async () => {
      await handleB.close();
      await closeHarnessStore({ workspaceRoot: rootB, harnessSlug });
    });

    expect(handleA.swarm).not.toBeNull();
    expect(handleB.swarm).not.toBeNull();
    expect(handleA.swarm!.topicHex).toBe(handleB.swarm!.topicHex);

    await handleA.append({
      type: 'put',
      table: 'features_consolidated',
      hbKey: 'F-A-1',
      value: { status: 'in-progress', author: peerA.login },
      ts: 2001,
      schema_version: 1,
      writerPubkey: peerA.pubkeyBase64,
    });
    await handleB.append({
      type: 'put',
      table: 'features_consolidated',
      hbKey: 'F-B-1',
      value: { status: 'done', author: peerB.login },
      ts: 2002,
      schema_version: 1,
      writerPubkey: peerB.pubkeyBase64,
    });

    let capturedByB: OpEnvelope | undefined;
    let capturedByA: OpEnvelope | undefined;
    const bidi = await pollUntil(
      async () => {
        await Promise.all([handleA.mergeNow(), handleB.mergeNow()]);
        capturedByB ??= applyB.mock.calls.find((c) => c[0].hbKey === 'F-A-1')?.[0];
        capturedByA ??= applyA.mock.calls.find((c) => c[0].hbKey === 'F-B-1')?.[0];
        return capturedByB && capturedByA ? { capturedByB, capturedByA } : undefined;
      },
      { timeoutMs: 45_000, intervalMs: 500 },
    );

    expect(bidi?.capturedByB, "B never received A's op (A→B failed) — real write-free gate may have rejected").toBeTruthy();
    expect(bidi?.capturedByA, "A never received B's op (B→A failed) — real write-free gate may have rejected").toBeTruthy();
    expect(bidi!.capturedByB).toMatchObject({ hbKey: 'F-A-1', writerPubkey: peerA.pubkeyBase64 });
    expect(bidi!.capturedByA).toMatchObject({ hbKey: 'F-B-1', writerPubkey: peerB.pubkeyBase64 });

    expect(handleA.admitted.size, "A's admitted set ≥ own + B").toBeGreaterThanOrEqual(2);
    expect(handleB.admitted.size, "B's admitted set ≥ own + A").toBeGreaterThanOrEqual(2);

    const connected = listBootHistory({ workspaceId, harnessSlug, kinds: ['peer_connected'], limit: 10 });
    expect(connected.length, 'expected ≥1 peer_connected').toBeGreaterThan(0);
  }, 120_000);
});
