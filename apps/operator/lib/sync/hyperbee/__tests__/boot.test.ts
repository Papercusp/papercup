/**
 * bootHarnessSubstrate — composer tests (Model B, Stage 4a).
 *
 * Covers:
 *   - Argument validation (workspaceRoot / workspaceId / harnessSlug).
 *   - Schema-version alert event subscription / unsubscription.
 *   - The Model B handle shape: `ownLog.keyHex` + `mergeNow` + `admitted`
 *     (NOT the retired Autobase `base`).
 *   - The single-peer path: own writes → mergeNow → PG projection.
 *
 * The single-peer test uses a real Corestore over a tmp dir (mirrors
 * peer-log.test.ts) + a capturing projection sink (no real PG), with the
 * merge poll-timer disabled so the test drives `mergeNow()` by hand.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import Corestore from 'corestore';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPairSync, sign as nodeSign } from 'node:crypto';
import { bootHarnessSubstrate, onSchemaVersionAlert } from '../boot';
import { schemaVersionEvents, type SchemaVersionAlert, CURRENT_SCHEMA_VERSION } from '../schema-version';
import { _resetCacheForTests } from '../corestore';
import { openOwnLog } from '../peer-log';
import { buildAnnounce, type SignedAnnounce } from '../announce';
import { _clearRegistryForTests } from '../projection';

/** Build a VALID signed announce with a freshly-generated Ed25519 keypair —
 *  `verifyAnnounce(frame)` (real crypto, runs inside boot's onAnnounce) returns
 *  true for this frame. log_core_key is a real 64-hex key boot can openRemoteLog. */
async function validAnnounce(over: Partial<SignedAnnounce> = {}): Promise<SignedAnnounce> {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const rawPub = (publicKey.export({ type: 'spki', format: 'der' }) as Buffer)
    .subarray(-32)
    .toString('base64');
  const body = {
    device_pubkey: rawPub,
    github_user_id: 4242,
    github_login: 'alice',
    log_core_key: 'cc'.repeat(32),
    ...over,
  };
  return buildAnnounce(body, async (bytes) => nodeSign(null, bytes, privateKey));
}

const cleanups: Array<() => void | Promise<void>> = [];

afterEach(async () => {
  schemaVersionEvents.removeAllListeners();
  _clearRegistryForTests();
  while (cleanups.length) {
    try { await cleanups.pop()!(); } catch {}
  }
  _resetCacheForTests();
});

describe('bootHarnessSubstrate — validation', () => {
  it('rejects missing workspaceRoot', async () => {
    await expect(
      bootHarnessSubstrate({ workspaceRoot: '', workspaceId: 'w', harnessSlug: 's' }),
    ).rejects.toThrow(/workspaceRoot/);
  });

  it('rejects missing workspaceId', async () => {
    await expect(
      bootHarnessSubstrate({ workspaceRoot: '/tmp', workspaceId: '', harnessSlug: 's' }),
    ).rejects.toThrow(/workspaceId/);
  });

  it('rejects missing harnessSlug', async () => {
    await expect(
      bootHarnessSubstrate({ workspaceRoot: '/tmp', workspaceId: 'w', harnessSlug: '' }),
    ).rejects.toThrow(/harnessSlug/);
  });
});

describe('bootHarnessSubstrate — Model B handle shape + single-peer merge', () => {
  function tmpWorkspaceRoot(): string {
    const dir = mkdtempSync(join(tmpdir(), 'mb-boot-'));
    cleanups.push(() => { try { rmSync(dir, { recursive: true, force: true }); } catch {} });
    return dir;
  }

  it('exposes ownLog.keyHex + mergeNow + admitted, NOT base', async () => {
    const handle = await bootHarnessSubstrate({
      workspaceRoot: tmpWorkspaceRoot(),
      workspaceId: 'ws-1',
      harnessSlug: 's1',
      mergePollMs: 0, // disable the poll timer; drive mergeNow by hand
    });
    cleanups.push(() => handle.close());

    expect(handle.ownLog.keyHex).toMatch(/^[0-9a-f]{64}$/);
    expect(typeof handle.mergeNow).toBe('function');
    expect(handle.admitted.get(handle.ownLog.keyHex)).toBe(handle.ownLog);
    // The retired Autobase `base` is gone.
    expect((handle as unknown as { base?: unknown }).base).toBeUndefined();
    expect(handle.swarm).toBeNull();
  });

  it('single-peer: own writes flow through mergeNow into the projection sink', async () => {
    // Capture applied ops via the applyOverride seam. The scoped per-harness
    // apply (buildHarnessProjectionApply) deliberately does NOT consult the
    // global registry (D-021 collision fix), so tests inject their own sink.
    const writes: unknown[] = [];
    const handle = await bootHarnessSubstrate({
      workspaceRoot: tmpWorkspaceRoot(),
      workspaceId: 'ws-1',
      harnessSlug: 's2',
      mergePollMs: 0,
      applyOverride: async (op) => {
        if (op.table === 'mb_test_table') writes.push(op.value);
        return true;
      },
    });
    cleanups.push(() => handle.close());

    await handle.append({
      type: 'put',
      table: 'mb_test_table',
      hbKey: 'F-1',
      value: { id: 'F-1' },
      ts: 1000,
      schema_version: CURRENT_SCHEMA_VERSION,
    });
    expect(handle.ownLog.length).toBe(1);

    const applied = await handle.mergeNow();
    expect(applied).toBe(1);
    expect(writes).toEqual([{ id: 'F-1' }]);
  });
});

describe('bootHarnessSubstrate — onAnnounce admit/reject (Stage 4b/4c, Fix 6)', () => {
  function tmpWorkspaceRoot(): string {
    const dir = mkdtempSync(join(tmpdir(), 'mb-boot-ann-'));
    cleanups.push(() => { try { rmSync(dir, { recursive: true, force: true }); } catch {} });
    return dir;
  }

  it('a VALID + admitted announce → remote log lands in admitted + mergeNow runs', async () => {
    const handle = await bootHarnessSubstrate({
      workspaceRoot: tmpWorkspaceRoot(),
      workspaceId: 'ws-1',
      harnessSlug: 'ann-1',
      mergePollMs: 0, // disable the poll so the only merge is onAnnounce's
      pendingRetryMs: 0, // disable the retry timer too
      // binding check returns 'verified' → a valid-sig announce is admitted.
      verifyBindingOverride: async () => 'verified',
    });
    cleanups.push(() => handle.close());

    const beforeKeys = [...handle.admitted.keys()];
    expect(beforeKeys).toEqual([handle.ownLog.keyHex]); // only the own log

    const frame = await validAnnounce({ log_core_key: 'cc'.repeat(32) });
    const decision = await handle.onAnnounce(frame);

    expect(decision.admit).toBe(true);
    // The peer's remote log is now in the admitted set, keyed by its log_core_key.
    expect(handle.admitted.has('cc'.repeat(32))).toBe(true);
    const remote = handle.admitted.get('cc'.repeat(32))!;
    expect(remote.keyHex).toBe('cc'.repeat(32));
    expect(remote).not.toBe(handle.ownLog);
  });

  it('a REJECTED announce (binding fails) → not added, admit:false', async () => {
    const handle = await bootHarnessSubstrate({
      workspaceRoot: tmpWorkspaceRoot(),
      workspaceId: 'ws-1',
      harnessSlug: 'ann-2',
      mergePollMs: 0,
      pendingRetryMs: 0, // disable the retry timer
      // binding check returns 'fail' → not admitted (reason binding_invalid).
      verifyBindingOverride: async () => 'fail',
    });
    cleanups.push(() => handle.close());

    const frame = await validAnnounce({ log_core_key: 'dd'.repeat(32) });
    const decision = await handle.onAnnounce(frame);

    expect(decision.admit).toBe(false);
    expect(handle.admitted.has('dd'.repeat(32))).toBe(false);
    // Only the own log remains admitted.
    expect([...handle.admitted.keys()]).toEqual([handle.ownLog.keyHex]);
  });

  it('a FORGED announce (bad sig) → reason bad_sig, binding never consulted', async () => {
    const verifyBinding = vi.fn(async () => 'verified' as const);
    const handle = await bootHarnessSubstrate({
      workspaceRoot: tmpWorkspaceRoot(),
      workspaceId: 'ws-1',
      harnessSlug: 'ann-3',
      mergePollMs: 0,
      pendingRetryMs: 0, // disable the retry timer
      verifyBindingOverride: verifyBinding,
    });
    cleanups.push(() => handle.close());

    // Tamper the sig so verifyAnnounce (real crypto) fails.
    const frame = await validAnnounce({ log_core_key: 'ee'.repeat(32) });
    const forged: SignedAnnounce = { ...frame, sig: Buffer.from('tampered').toString('base64') };
    const decision = await handle.onAnnounce(forged);

    expect(decision).toMatchObject({ admit: false, reason: 'bad_sig' });
    // The sig check short-circuits before the binding check.
    expect(verifyBinding).not.toHaveBeenCalled();
    expect(handle.admitted.has('ee'.repeat(32))).toBe(false);
  });

  it('admitting the same announce twice is idempotent (one remote log)', async () => {
    const handle = await bootHarnessSubstrate({
      workspaceRoot: tmpWorkspaceRoot(),
      workspaceId: 'ws-1',
      harnessSlug: 'ann-4',
      mergePollMs: 0,
      pendingRetryMs: 0, // disable the retry timer
      verifyBindingOverride: async () => 'verified',
    });
    cleanups.push(() => handle.close());

    const frame = await validAnnounce({ log_core_key: 'ab'.repeat(32) });
    await handle.onAnnounce(frame);
    const first = handle.admitted.get('ab'.repeat(32));
    await handle.onAnnounce(frame);
    const second = handle.admitted.get('ab'.repeat(32));
    expect(second).toBe(first); // same handle, not re-opened
    expect(handle.admitted.size).toBe(2); // own + the one peer
  });
});

describe('bootHarnessSubstrate — revocation drops the admitted log end-to-end (D-004, Fix 1)', () => {
  function tmpDir(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    cleanups.push(() => { try { rmSync(dir, { recursive: true, force: true }); } catch {} });
    return dir;
  }

  /** A real device identity + an injectable Ed25519 signer (stable across calls,
   *  so a re-announce uses the SAME device_pubkey that was revoked). */
  function makeDevice(githubLogin: string, githubUserId: number) {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const devicePubkey = (publicKey.export({ type: 'spki', format: 'der' }) as Buffer)
      .subarray(-32)
      .toString('base64');
    return {
      devicePubkey,
      githubUserId,
      githubLogin,
      sign: async (bytes: Buffer) => nodeSign(null, bytes, privateKey),
    };
  }

  /** Pipe two Corestores' replication streams both ways (Stage-0 verified). */
  function replicate(s1: Corestore, s2: Corestore): void {
    type Pipeable = { pipe<T extends Pipeable>(dest: T): T };
    const a = s1.replicate(true) as unknown as Pipeable;
    const b = s2.replicate(false) as unknown as Pipeable;
    a.pipe(b).pipe(a);
  }

  it('admit a remote peer (its op merges) → revoke → its NEW ops stop merging + a re-announce is refused', async () => {
    // Capture applied ops via the applyOverride seam (the scoped per-harness
    // apply doesn't consult the global registry — D-021), so we see exactly
    // which of the peer's ops merge before vs. after revocation.
    const writes: Array<{ id: string }> = [];
    const handle = await bootHarnessSubstrate({
      workspaceRoot: tmpDir('mb-revoke-host-'),
      workspaceId: 'ws-1',
      harnessSlug: 'revoke-1',
      mergePollMs: 0,                       // drive mergeNow by hand
      pendingRetryMs: 0,                    // disable the retry timer
      verifyBindingOverride: async () => 'verified',
      applyOverride: async (op) => {
        if (op.table === 'mb_revoke_table') writes.push(op.value as { id: string });
        return true;
      },
    });
    cleanups.push(() => handle.close());

    // ── A real remote peer P: its own store + writable log, replicated into the
    // host's store so P's ops actually cross to the host and merge. ──
    const peerDir = tmpDir('mb-revoke-peer-');
    const peerStore = new Corestore(peerDir);
    cleanups.push(() => { void peerStore.close(); });
    await peerStore.ready();
    const peerOwn = await openOwnLog(peerStore);
    const P = makeDevice('peer-alice', 4242);

    // P writes its FIRST op, then we replicate P's store into the host's store.
    await peerOwn.append({
      type: 'put', table: 'mb_revoke_table', hbKey: 'P-1',
      value: { id: 'P-1' }, ts: 100, schema_version: CURRENT_SCHEMA_VERSION,
      author_pubkey: P.devicePubkey,
    });
    replicate(peerStore, handle.store);

    // P announces (valid sig + binding-true) → admitted; merge applies P's op #0.
    const announce = await buildAnnounce(
      {
        device_pubkey: P.devicePubkey,
        github_user_id: P.githubUserId,
        github_login: P.githubLogin,
        log_core_key: peerOwn.keyHex,
      },
      P.sign,
    );
    const admitDecision = await handle.onAnnounce(announce);
    expect(admitDecision.admit).toBe(true);
    expect(handle.admitted.has(peerOwn.keyHex)).toBe(true);

    // onAnnounce already merged; P's first op is in PG.
    expect(writes).toEqual([{ id: 'P-1' }]);

    // ── REVOKE P. ── Drops its log from the admitted set + re-merges.
    await handle.revoke(P.devicePubkey);
    // The peer's log is no longer in the admitted set.
    expect(handle.admitted.has(peerOwn.keyHex)).toBe(false);
    // Only the host's own log remains admitted.
    expect([...handle.admitted.keys()]).toEqual([handle.ownLog.keyHex]);

    // ── P writes a NEW op after revocation. ── It must NOT merge: the log is
    // out of the admitted set, so mergeNow never reads it.
    await peerOwn.append({
      type: 'put', table: 'mb_revoke_table', hbKey: 'P-2',
      value: { id: 'P-2' }, ts: 200, schema_version: CURRENT_SCHEMA_VERSION,
      author_pubkey: P.devicePubkey,
    });
    const appliedAfter = await handle.mergeNow();
    expect(appliedAfter).toBe(0);                       // nothing in the admitted set newly applied
    expect(writes).toEqual([{ id: 'P-1' }]);            // P-2 never reached PG

    // ── A re-announce from the revoked pubkey is refused with reason 'revoked'. ──
    const reAnnounce = await buildAnnounce(
      {
        device_pubkey: P.devicePubkey,
        github_user_id: P.githubUserId,
        github_login: P.githubLogin,
        log_core_key: peerOwn.keyHex,
      },
      P.sign,
    );
    const reDecision = await handle.onAnnounce(reAnnounce);
    expect(reDecision).toMatchObject({ admit: false, reason: 'revoked' });
    // Still not re-admitted.
    expect(handle.admitted.has(peerOwn.keyHex)).toBe(false);
  });

  it('revoking an unknown pubkey is a no-op (idempotent) but still blocks a future announce', async () => {
    const handle = await bootHarnessSubstrate({
      workspaceRoot: tmpDir('mb-revoke-unknown-'),
      workspaceId: 'ws-1',
      harnessSlug: 'revoke-2',
      mergePollMs: 0,
      pendingRetryMs: 0, // disable the retry timer
      verifyBindingOverride: async () => 'verified',
    });
    cleanups.push(() => handle.close());

    const P = makeDevice('never-admitted', 7);
    // Revoke a pubkey we never admitted → no throw, admitted set unchanged.
    await expect(handle.revoke(P.devicePubkey)).resolves.toBeUndefined();
    expect([...handle.admitted.keys()]).toEqual([handle.ownLog.keyHex]);
    // Revoking again is still a no-op (idempotent).
    await expect(handle.revoke(P.devicePubkey)).resolves.toBeUndefined();

    // A subsequent (valid-sig) announce from that revoked pubkey is refused.
    const announce = await buildAnnounce(
      {
        device_pubkey: P.devicePubkey,
        github_user_id: P.githubUserId,
        github_login: P.githubLogin,
        log_core_key: 'fe'.repeat(32),
      },
      P.sign,
    );
    const decision = await handle.onAnnounce(announce);
    expect(decision).toMatchObject({ admit: false, reason: 'revoked' });
    expect(handle.admitted.has('fe'.repeat(32))).toBe(false);
  });
});

describe('onSchemaVersionAlert', () => {
  it('subscribes to alerts emitted by the substrate', () => {
    const received: SchemaVersionAlert[] = [];
    const unsub = onSchemaVersionAlert((a) => received.push(a));
    schemaVersionEvents.emit('alert', {
      harnessSlug: 's',
      observed_version: 99,
      known_version: 1,
    });
    expect(received).toHaveLength(1);
    expect(received[0].observed_version).toBe(99);
    unsub();
  });

  it('unsub stops further deliveries', () => {
    const received: SchemaVersionAlert[] = [];
    const unsub = onSchemaVersionAlert((a) => received.push(a));
    unsub();
    schemaVersionEvents.emit('alert', {
      harnessSlug: 's',
      observed_version: 99,
      known_version: 1,
    });
    expect(received).toHaveLength(0);
  });

  it('multiple subscribers receive the alert independently', () => {
    const a: SchemaVersionAlert[] = [];
    const b: SchemaVersionAlert[] = [];
    const unsub1 = onSchemaVersionAlert((x) => a.push(x));
    const unsub2 = onSchemaVersionAlert((x) => b.push(x));
    schemaVersionEvents.emit('alert', { harnessSlug: 's', observed_version: 5, known_version: 1 });
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
    unsub1();
    schemaVersionEvents.emit('alert', { harnessSlug: 's', observed_version: 6, known_version: 1 });
    expect(a).toHaveLength(1);    // unsubbed
    expect(b).toHaveLength(2);    // still active
    unsub2();
  });
});
