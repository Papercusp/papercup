/**
 * two-peer.test.ts — Model B substrate, Stage 7: a two-peer-on-one-box
 * integration test that PROVES the substrate replicates + the read-admission
 * security gate works, end-to-end, over the REAL modules (no Docker, no PG).
 *
 * ## Why this is a normal `*.test.ts` (not `*.integration.test.ts`)
 *
 * Despite being an "integration" exercise in spirit, it requires NO Postgres
 * and NO Docker: the read-merge's apply sink is INJECTED as a `vi.fn()` spy
 * (`mergeAdmittedLogs(..., { applyImpl })`), so we assert at the
 * read-merge → apply boundary and never touch the projection→PG final hop
 * (that hop is already unit-tested per-table). The repo's unit layer
 * (`@papercusp/test-config` `defineVitestConfig({ layer: 'unit' })`)
 * EXCLUDES the integration-test glob (vitest-config.ts line 42-43), and the
 * integration layer only RUNS files matching the dot-integration glob
 * (and its globalSetup wants Docker). Naming this `two-peer.test.ts` is what
 * makes it RUN in the normal suite (`npx vitest run lib/sync/hyperbee/`) with
 * no Docker — which is exactly what we want for a deterministic, spy-asserted
 * substrate proof.
 *
 * ## What it composes (all real, all shipped in Stages 1-6)
 *  - peer-log.ts          — `openOwnLog(store)` / `openRemoteLog(store, keyHex)`
 *  - read-merge.ts        — `mergeAdmittedLogs(logs, { applyImpl })`
 *  - announce.ts          — `buildAnnounce` / `verifyAnnounce` over a REAL
 *                           Ed25519 keypair (Node `crypto.generateKeyPairSync`)
 *  - read-admission.ts    — `makeAdmissionDecider({ verifyBinding, revoked })`
 *  - feature-claim.ts     — `claimFeature(ownLog, { harness_slug, feature_id, ... })`
 *  - Corestore replication — `s1.replicate(true)` / `s2.replicate(false)` piped
 *                            both ways (mirrors peer-log.test.ts's remote test);
 *                            a remote core needs `await remote.update()` before
 *                            `length` reflects the writer's appends.
 *
 * ## The 4 cases (the substrate's load-bearing claims)
 *  1. Replication — peer A's write crosses the wire to peer B's merge → apply.
 *  2. Admission refusal — a forged binding / tampered announce is denied; the
 *     refused peer's ops never enter the merged set.
 *  3. Revocation — a revoked peer is denied; a merge over only-admitted logs
 *     applies none of its ops.
 *  4. Claims are APPEND-ONLY audit history (the corrected Stage-5 semantics) —
 *     two peers' claims for the same feature land as SEPARATE rows (distinct
 *     `<feature_id>/<seq>` keys); they do NOT LWW-clobber. "Who holds F now" is
 *     a separate latest-`claimed_at` read, not a winner-takes-the-key.
 *
 * Resource hygiene: every temp dir + store is tracked in `cleanups` at creation
 * and torn down in `afterEach` (mirrors peer-log.test.ts / convergence.test.ts),
 * so a thrown assertion can't leak a dir or a still-open store.
 */

import { afterEach, describe, it, expect, vi } from 'vitest';
import Corestore from 'corestore';
import { generateKeyPairSync, sign as nodeSign } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openOwnLog, openRemoteLog, type PeerLogOp } from '../peer-log';
import { mergeAdmittedLogs, type AdmittedLog } from '../read-merge';
import type { OpEnvelope } from '../op-envelope-types';
import {
  buildAnnounce,
  verifyAnnounce,
  type AnnounceBody,
  type SignedAnnounce,
} from '../announce';
import { makeAdmissionDecider } from '../read-admission';
import { claimFeature } from '../../../orchestrator/feature-claim';
import { CLAIMS_TABLE_TAG, type FeatureClaimRow } from '../projections/feature-claims';

const cleanups: Array<() => void> = [];

afterEach(() => {
  while (cleanups.length) {
    try { cleanups.pop()!(); } catch {}
  }
});

/** A Corestore over a fresh tmp dir; both are registered for afterEach teardown. */
function makeStore(prefix: string): Corestore {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => { try { rmSync(dir, { recursive: true, force: true }); } catch {} });
  const store = new Corestore(dir);
  cleanups.push(() => { void store.close(); });
  return store;
}

/** Pipe two Corestores' replication streams both ways (Stage-0 verified pattern). */
function replicate(s1: Corestore, s2: Corestore): void {
  type Pipeable = { pipe<T extends Pipeable>(dest: T): T };
  const a = s1.replicate(true) as unknown as Pipeable;
  const b = s2.replicate(false) as unknown as Pipeable;
  a.pipe(b).pipe(a);
}

/** Raw 32-byte Ed25519 pubkey, base64 — the binding's device_pubkey convention. */
function rawPubkeyBase64(publicKey: ReturnType<typeof generateKeyPairSync>['publicKey']): string {
  const spkiDer = publicKey.export({ type: 'spki', format: 'der' }) as Buffer;
  return spkiDer.subarray(-32).toString('base64');
}

/** A real device identity: an Ed25519 keypair + its raw-32-byte-base64 pubkey + an injectable signer. */
interface Device {
  devicePubkey: string;
  githubUserId: number;
  githubLogin: string;
  sign: (bytes: Buffer) => Promise<Buffer>;
}

function makeDevice(githubLogin: string, githubUserId: number): Device {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    devicePubkey: rawPubkeyBase64(publicKey),
    githubUserId,
    githubLogin,
    sign: async (bytes) => nodeSign(null, bytes, privateKey),
  };
}

/** Typed apply spy (a bare `vi.fn(async () => true)` infers a zero-arg tuple). */
const applySpy = () => vi.fn<(op: OpEnvelope) => Promise<boolean>>(async () => true);

describe('Model B substrate — two peers on one box', () => {
  // ── Case 1 — REPLICATION: peer A's write reaches peer B's merge → apply. ──
  it('replicates: peer A appends → peer B merges A\'s remote log → apply spy sees the op', async () => {
    const sA = makeStore('mb2-A-'); await sA.ready();
    const sB = makeStore('mb2-B-'); await sB.ready();

    const A = makeDevice('alice', 4242);

    // Peer A appends one op to its OWN log.
    const ownA = await openOwnLog(sA);
    const op: PeerLogOp = {
      type: 'put',
      table: 'features_consolidated',
      hbKey: 'F-1',
      value: { status: 'todo' },
      ts: 1000,
      schema_version: 1,
      author_pubkey: A.devicePubkey,
    };
    await ownA.append(op);

    // Replicate the two stores both ways, then peer B opens A's log read-only.
    replicate(sA, sB);
    const remoteAonB = await openRemoteLog(sB, ownA.keyHex);
    await remoteAonB.update(); // a remote needs update() before length reflects appends
    expect(remoteAonB.length).toBe(1);

    // Peer B's merge over [its own (empty) log, A's remote log].
    const ownB = await openOwnLog(sB);
    const apply = applySpy();
    const applied = await mergeAdmittedLogs([ownB, remoteAonB], {
      applyImpl: apply,
      getTimeoutMs: 0, // instant fakes/locals — no timeout needed
    });

    // THE PROOF: A's write crossed to B and flowed through B's merge to apply.
    expect(applied).toBe(1);
    expect(apply).toHaveBeenCalledTimes(1);
    expect(apply.mock.calls[0][0]).toMatchObject({
      table: 'features_consolidated',
      hbKey: 'F-1',
      value: { status: 'todo' },
      ts: 1000,
      writerPubkey: A.devicePubkey,
    });
  });

  // ── Case 2 — ADMISSION REFUSAL: a forged binding / tampered announce is denied. ──
  it('refuses a forged binding and a tampered announce; the refused peer is never merged', async () => {
    const A = makeDevice('alice', 4242);
    const C = makeDevice('carol', 9001);

    // A's log core key (just a shape-valid 64-hex string for the announce body).
    const sA = makeStore('mb2-rA-'); await sA.ready();
    const ownA = await openOwnLog(sA);

    const testNowMs = Date.now();

    // C builds a GENUINELY-signed announce (real keypair → verifyAnnounce true).
    const cBody: AnnounceBody = {
      device_pubkey: C.devicePubkey,
      github_user_id: C.githubUserId,
      github_login: C.githubLogin,
      attestation_gist_id: 'gist-test',
      log_core_key: ownA.keyHex, // any 64-hex; the announce sig is what's tested
      ts: testNowMs,
    };
    const cAnnounce = await buildAnnounce(cBody, C.sign, { nowMs: testNowMs });
    expect(verifyAnnounce(cAnnounce, { nowMs: testNowMs })).toBe(true); // C's sig is real

    // Only A's binding is valid; C's binding is forged/unknown.
    const admit = makeAdmissionDecider({
      verifyBinding: async (pk) => pk === A.devicePubkey ? 'verified' : 'fail',
    });

    // C has a valid sig but an INVALID binding → binding_invalid.
    const cDecision = await admit({
      device_pubkey: C.devicePubkey,
      github_login: C.githubLogin,
      github_user_id: C.githubUserId,
      attestation_gist_id: 'gist-test',
      sigValid: verifyAnnounce(cAnnounce, { nowMs: testNowMs }),
    });
    expect(cDecision).toEqual({ admit: false, reason: 'binding_invalid' });

    // A TAMPERED announce → verifyAnnounce false → bad_sig (sig short-circuits
    // before the binding check, so even A's valid binding can't rescue it).
    const tampered: SignedAnnounce = { ...cAnnounce, github_login: 'mallory' };
    expect(verifyAnnounce(tampered, { nowMs: testNowMs })).toBe(false);
    const tamperedDecision = await admit({
      device_pubkey: A.devicePubkey, // even claim A's (valid-binding) identity…
      github_login: A.githubLogin,
      github_user_id: A.githubUserId,
      attestation_gist_id: 'gist-test',
      sigValid: verifyAnnounce(tampered, { nowMs: testNowMs }), // …the bad sig still denies it
    });
    expect(tamperedDecision).toEqual({ admit: false, reason: 'bad_sig' });

    // Sanity: A (real sig + valid binding) WOULD be admitted.
    const aAnnounce = await buildAnnounce(
      { device_pubkey: A.devicePubkey, github_user_id: A.githubUserId, github_login: A.githubLogin, attestation_gist_id: 'gist-test', log_core_key: ownA.keyHex },
      A.sign,
      { nowMs: testNowMs },
    );
    expect(
      await admit({
        device_pubkey: A.devicePubkey,
        github_login: A.githubLogin,
        github_user_id: A.githubUserId,
        attestation_gist_id: 'gist-test',
        sigValid: verifyAnnounce(aAnnounce, { nowMs: testNowMs }),
      }),
    ).toEqual({ admit: true });

    // CONSEQUENCE: a merge over ONLY the admitted logs (A's, not C's) sees no
    // C op. C wrote a "forged" op to its own log, but because admission refused
    // C, that log is never opened/merged — so C's op never reaches apply.
    const sC = makeStore('mb2-rC-'); await sC.ready();
    const ownC = await openOwnLog(sC);
    await ownC.append({
      type: 'put', table: 'features_consolidated', hbKey: 'F-evil',
      value: { status: 'pwned' }, ts: 5, schema_version: 1, author_pubkey: C.devicePubkey,
    });
    await ownA.append({
      type: 'put', table: 'features_consolidated', hbKey: 'F-ok',
      value: { status: 'todo' }, ts: 5, schema_version: 1, author_pubkey: A.devicePubkey,
    });
    const apply = applySpy();
    // Only A's log is admitted → only A's op is merged; C's log is excluded.
    await mergeAdmittedLogs([ownA], { applyImpl: apply, getTimeoutMs: 0 });
    const mergedKeys = apply.mock.calls.map((c) => c[0].hbKey);
    expect(mergedKeys).toContain('F-ok');
    expect(mergedKeys).not.toContain('F-evil');
  });

  // ── Case 3 — REVOCATION: a revoked peer is denied; its ops never apply. ──
  it('revocation: a revoked peer is denied and its log\'s ops are not applied', async () => {
    const B = makeDevice('bob', 7);

    // B's binding would otherwise be valid (verifyBinding → 'verified'), but B is revoked.
    const admit = makeAdmissionDecider({
      verifyBinding: async () => 'verified',
      revoked: new Set([B.devicePubkey]),
    });

    const decision = await admit({
      device_pubkey: B.devicePubkey,
      github_login: B.githubLogin,
      github_user_id: B.githubUserId,
      sigValid: true, // revocation is checked FIRST, before sig + binding
    });
    expect(decision).toEqual({ admit: false, reason: 'revoked' });

    // CONSEQUENCE: B is excluded from the admitted set, so a merge that does
    // NOT include B's log applies none of B's ops.
    const sB = makeStore('mb2-revB-'); await sB.ready();
    const ownB = await openOwnLog(sB);
    await ownB.append({
      type: 'put', table: 'features_consolidated', hbKey: 'F-revoked',
      value: { status: 'todo' }, ts: 9, schema_version: 1, author_pubkey: B.devicePubkey,
    });
    const apply = applySpy();
    const applied = await mergeAdmittedLogs([], { applyImpl: apply, getTimeoutMs: 0 });
    expect(applied).toBe(0);
    expect(apply).not.toHaveBeenCalled();
  });

  // ── Case 4 — CLAIMS ARE APPEND-ONLY (corrected Stage-5 semantics): two peers'
  // claims for the SAME feature land as SEPARATE rows; they do NOT clobber. ──
  it('claims are append-only audit history: both peers\' claims for one feature survive as distinct rows', async () => {
    const sA = makeStore('mb2-cA-'); await sA.ready();
    const sB = makeStore('mb2-cB-'); await sB.ready();

    const A = makeDevice('alice', 4242);
    const B = makeDevice('bob', 7);
    const FEATURE = 'F-42';
    const HARNESS = 'sheets';

    const ownA = await openOwnLog(sA);
    const ownB = await openOwnLog(sB);

    // Append-only seq = ownLog.length, so to give the two peers DISTINCT seqs
    // (and thus distinct `<feature_id>/<seq>` keys, no PG-PK collision) peer A's
    // log carries one prior op before it claims → A claims at seq 1, B at seq 0.
    // This is the realistic case (a peer's log accumulates ops over time) and is
    // exactly what makes two cross-peer claims for one feature NON-colliding.
    await ownA.append({
      type: 'put', table: 'features_consolidated', hbKey: 'F-other',
      value: { status: 'todo' }, ts: 1, schema_version: 1, author_pubkey: A.devicePubkey,
    });

    // Both peers claim the SAME feature via the REAL claimFeature primitive.
    await claimFeature(ownA, { harness_slug: HARNESS, feature_id: FEATURE, claimer_github_user_id: A.githubUserId, now_ms: 100 });
    await claimFeature(ownB, { harness_slug: HARNESS, feature_id: FEATURE, claimer_github_user_id: B.githubUserId, now_ms: 200 });

    // Replicate both logs to a third store and read them as remotes (proves the
    // claims cross the wire, not just an in-process read).
    const sMerge = makeStore('mb2-cM-'); await sMerge.ready();
    replicate(sA, sMerge);
    replicate(sB, sMerge);
    const remoteA = await openRemoteLog(sMerge, ownA.keyHex);
    const remoteB = await openRemoteLog(sMerge, ownB.keyHex);
    await remoteA.update();
    await remoteB.update();
    expect(remoteA.length).toBe(2); // F-other + the claim
    expect(remoteB.length).toBe(1); // the claim

    // Merge both peers' logs with a spy apply sink.
    const apply = applySpy();
    await mergeAdmittedLogs([remoteA, remoteB], { applyImpl: apply, getTimeoutMs: 0 });

    // Pull out the two claim ops (the `claims` table); ignore the F-other op.
    const claimOps = apply.mock.calls
      .map((c) => c[0])
      .filter((env) => env.table === CLAIMS_TABLE_TAG);

    // BOTH claims applied as SEPARATE rows — append-only, NOT LWW-clobbered.
    expect(claimOps).toHaveLength(2);

    // Distinct `<feature_id>/<seq>` keys: A claimed at seq 1, B at seq 0.
    const claimKeys = claimOps.map((env) => env.hbKey).sort();
    expect(claimKeys).toEqual([`${FEATURE}/0`, `${FEATURE}/1`]);

    // Each row carries its own claimer (distinct pubkeys), same feature — the
    // append-only audit history; "current holder" is a separate read, not a key winner.
    const rowsBySeq = new Map<number, FeatureClaimRow>();
    for (const env of claimOps) {
      const row = env.value as FeatureClaimRow;
      rowsBySeq.set(row.seq, row);
    }
    expect(rowsBySeq.get(0)?.claimer_pubkey).toBe(ownB.keyHex);
    expect(rowsBySeq.get(0)?.claimer_github_user_id).toBe(B.githubUserId);
    expect(rowsBySeq.get(1)?.claimer_pubkey).toBe(ownA.keyHex);
    expect(rowsBySeq.get(1)?.claimer_github_user_id).toBe(A.githubUserId);
    // Same feature, distinct claimers → distinct keys → no clobber.
    expect(rowsBySeq.get(0)?.feature_id).toBe(FEATURE);
    expect(rowsBySeq.get(1)?.feature_id).toBe(FEATURE);
    expect(rowsBySeq.get(0)?.claimer_pubkey).not.toBe(rowsBySeq.get(1)?.claimer_pubkey);
  });
});
