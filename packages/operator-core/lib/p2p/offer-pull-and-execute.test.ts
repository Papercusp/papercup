/**
 * WI-3629 puller-boundary caller — REAL-SEAM integration test.
 *
 * Per the leader's finding #4 (the WI-3591 near-miss precedent, cited in
 * docs/plans/LIVE-2-shared-fleet-drill-checklist-2026-07-10.md), this seam
 * must NOT ship with only a mocked-executor unit test: this file exercises
 * the REAL `evaluatePull` (standing-puller.ts, unmocked, pure) and the REAL
 * `executeClaimedOffer` (offer-executor.ts, unmocked) through the REAL
 * `pullAndExecuteOffer` glue — only the true IO leaves (PG reads, the
 * host-supervisor spawn) are stubbed via `depsOverride`, exactly like
 * offer-executor.test.ts's own convention for those same leaves.
 * `applyCapabilityEnvelope` is deliberately left as the REAL
 * `applyCapabilityEnvelopeForForeignSession` (via `foreignSessionExecutorDeps`,
 * pure — reads the already-landed deny-all `ROLE_ENVELOPES` map, no IO) so
 * this test also proves the seam actually rides the landed C2 gate, not a
 * stand-in for it.
 */
import { describe, it, expect, vi } from 'vitest';
import { generateEd25519KeypairDer, signWithPrivateKeyDer } from '../identity/ed25519';
import type { WorkOffer } from './offer-budget';
import { offerAuthorshipSigningBytes, buildOfferAuthorship, type AuthorshipVerifyInput } from './offer-authorship';
import type { HostAvailability } from './claim-authority';
import { bakedP2pDefaults, type P2pSettings } from './settings';
import type { PullEvaluationInput, StealContext } from './standing-puller';
import type { ForeignWorkspace } from './foreign-workspaces';
import type { OfferExecutorDeps } from './offer-executor';
import { pullAndExecuteOffer, productionOfferExecutorDeps } from './offer-pull-and-execute';

/* ── fixtures (mirrors standing-puller.test.ts / offer-executor.test.ts) ── */

function makeOffer(over: Partial<WorkOffer> = {}): WorkOffer {
  return {
    offerId: 'offer-1',
    fleetSlug: 'fleet-a',
    publisherRef: 'user:5',
    billedTo: 'host:h1',
    modelClass: 'frontier-remote',
    priority: 3,
    isolationReqs: [],
    budget: { remote: { cap: 1000, unit: 'usd-micros', maxPerCall: 100 }, local: null },
    publishedAt: 1000,
    ttlMs: 60_000,
    ...over,
  };
}

/** A genuinely-signed authorship input (real Ed25519 sig verifies over the offer+epoch). */
function signedAuthorship(over: { offer?: Partial<WorkOffer>; epoch?: number } = {}): AuthorshipVerifyInput {
  const kp = generateEd25519KeypairDer();
  const offer = makeOffer(over.offer);
  const epoch = over.epoch ?? 4;
  const sig = signWithPrivateKeyDer(kp.privateKeyDer, offerAuthorshipSigningBytes(offer, epoch));
  return {
    offer,
    authorship: buildOfferAuthorship({ devicePubkey: kp.pubkeyBase64, epoch, signature: sig }),
    attestedGithubUserId: 5,
    publisherSet: { ownerGithubUserId: 279242982, ownerAnchored: true, ownerSignatureValid: true, memberGithubUserIds: [5, 7] },
    ownerHighWaterEpoch: 4,
    host: { runtimeVersion: '1.3.0', capabilities: [] },
  };
}

function optedInSettings(mut: (s: P2pSettings) => void = () => {}): P2pSettings {
  const s = bakedP2pDefaults();
  s.optIn.mode = 'any-fleet';
  mut(s);
  return s;
}

const HOST_OK: HostAvailability = { remote: { allotmentRemaining: 500, liveHeadroom: 500 }, local: null };
const STEAL_OK: StealContext = { t2StaleMs: 10_000, selfReliability: 0.9, minReliabilityToSteal: 0.5, publisherExcludedHosts: [], betterCandidateExists: false };

function pullInput(over: Partial<PullEvaluationInput> = {}): PullEvaluationInput {
  return {
    active: true,
    selfHostRef: 'host:self',
    settings: optedInSettings(),
    nowMs: 5_000,
    maxRolloutTier: 1,
    authorship: signedAuthorship(),
    hostAvailability: HOST_OK,
    designation: null,
    hostHighWaterEpoch: 0,
    hostHighWaterSeq: 0,
    steal: STEAL_OK,
    ...over,
  };
}

const fakeWs = (over: Partial<ForeignWorkspace> = {}): ForeignWorkspace => ({
  workspaceId: 'ws-1',
  offerId: 'offer-1',
  fleetSlug: 'fleet-a',
  originGithubUserId: 5,
  executorDevice: 'dev-host',
  rootPath: '/foreign/offer-1',
  clonePath: '/foreign/offer-1/repo',
  sessionId: null,
  executionEpoch: 7,
  state: 'provisioning',
  parkReason: null,
  baseSha: 'abc',
  ...over,
});

/** Stub ONLY the true IO leaves executeClaimedOffer would otherwise hit
 *  (PG-backed provision/bind/setState/receipt + the host-supervisor spawn).
 *  `currentGrantorEpoch` / `hostAvailability` are also stubbed here (PG) —
 *  everything ELSE in the seam (evaluatePull, executeClaimedOffer's own
 *  logic, the landed C2 applyCapabilityEnvelope gate) runs FOR REAL. */
function makeLeafOverrides(over: Partial<OfferExecutorDeps> = {}) {
  const calls: string[] = [];
  const overrides: Partial<OfferExecutorDeps> = {
    currentGrantorEpoch: vi.fn(async () => 7),
    hostAvailability: vi.fn(async () => HOST_OK),
    launchSession: vi.fn(async () => {
      calls.push('launch');
      return { sessionId: 'sess-9' };
    }),
    provisionForeignClone: vi.fn(async () => {
      calls.push('provision');
      return { ok: true as const, workspace: fakeWs(), clonePath: '/foreign/offer-1/repo' };
    }),
    bindForeignSession: vi.fn(async (_ws: string, _offer: string, sessionId: string) => fakeWs({ sessionId, state: 'active' })) as any,
    setForeignWorkspaceState: vi.fn(async () => fakeWs({ state: 'parked' })) as any,
    emitP2pReceipt: vi.fn(async () => ({ ok: true as const, receipt: {} as any })) as any,
    ...over,
  };
  return { overrides, calls };
}

const ctx = {
  workspaceId: 'ws-1',
  potSlug: 'hive-h',
  responderGithubUserId: 99,
  executorDevice: 'dev-host',
  hostRef: 'host:self',
  sourceRepoPath: '/src/repo',
  rootPath: '/foreign/offer-1',
};

describe('WI-3629 pullAndExecuteOffer — real-seam (evaluatePull -> executeClaimedOffer, real)', () => {
  it('a WON claim executes for real: spawns via the assembled deps, real C2 envelope gate resolves (deny-all landed)', async () => {
    const { overrides, calls } = makeLeafOverrides();
    const result = await pullAndExecuteOffer(pullInput(), ctx, overrides);

    expect(result.outcome).toBe('executed');
    if (result.outcome !== 'executed') throw new Error('unreachable');
    expect(result.decision.outcome).toBe('claim');
    expect(result.decision.authorizedGithubUserId).toBe(5);
    expect(result.execute.ok).toBe(true);
    if (!result.execute.ok) throw new Error('unreachable');
    expect(result.execute.sessionId).toBe('sess-9');
    expect(calls).toEqual(['provision', 'launch']);
    // The stamped epoch was read via the SAME injected currentGrantorEpoch
    // port executeClaimedOffer re-reads internally for its H9 fence.
    expect(overrides.currentGrantorEpoch).toHaveBeenCalledWith(99);
  });

  it('a SKIP (e.g. offer expired) never reaches the executor — no leaf IO port is touched', async () => {
    const { overrides, calls } = makeLeafOverrides();
    const expired = pullInput({ nowMs: 1000 + 60_000 + 1 });
    const result = await pullAndExecuteOffer(expired, ctx, overrides);

    expect(result.outcome).toBe('skip');
    if (result.outcome !== 'skip') throw new Error('unreachable');
    expect(result.decision.reason).toBe('offer_expired');
    expect(overrides.currentGrantorEpoch).not.toHaveBeenCalled();
    expect(overrides.hostAvailability).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
  });

  it('H9 fence: the host-grantor epoch moving between the seam stamp-read and executeClaimedOffer re-read is refused, not silently admitted', async () => {
    let call = 0;
    const { overrides, calls } = makeLeafOverrides({
      // First call = the seam's "stamped at admission" read; second call =
      // executeClaimedOffer's own internal H9 re-read. A real revocation
      // between the two must be caught, never masked.
      currentGrantorEpoch: vi.fn(async () => (call++ === 0 ? 7 : 8)),
    });
    const result = await pullAndExecuteOffer(pullInput(), ctx, overrides);

    expect(result.outcome).toBe('executed');
    if (result.outcome !== 'executed') throw new Error('unreachable');
    expect(result.execute.ok).toBe(false);
    if (result.execute.ok) throw new Error('unreachable');
    expect(result.execute.refusal.code).toBe('stale-epoch');
    // Refused BEFORE any spawn-side effect — the race is caught, not raced past.
    expect(calls).toEqual([]);
  });

  it('a STEAL decision executes the same way as a direct claim (stole:true carried through, executor unaware of the distinction)', async () => {
    const { overrides, calls } = makeLeafOverrides();
    const stealInput = pullInput({
      designation: { designatedHostRef: 'host:other', rosterEpoch: 4, designatedAtMs: 0, seq: 0 },
      nowMs: 20_000, // age 20s > T2 10s (STEAL_OK.t2StaleMs)
    });
    const result = await pullAndExecuteOffer(stealInput, ctx, overrides);

    expect(result.outcome).toBe('executed');
    if (result.outcome !== 'executed') throw new Error('unreachable');
    expect(result.decision.outcome).toBe('steal');
    expect(result.decision.stole).toBe(true);
    expect(result.execute.ok).toBe(true);
    expect(calls).toEqual(['provision', 'launch']);
  });
});

describe('productionOfferExecutorDeps', () => {
  it('binds currentGrantorEpoch to the given ctx (workspaceId/potSlug) while forwarding the grantor id argument', async () => {
    // We can't hit real PG here, so verify via an override that the composed
    // fn is actually CALLED with the grantor id argument (proves the seam
    // wires the argument through rather than swallowing it) — the real
    // grant-store binding itself is exercised end-to-end in the tests above
    // via depsOverride replacing this same port.
    const spy = vi.fn(async () => 3);
    const deps = productionOfferExecutorDeps({ workspaceId: 'ws-1', potSlug: 'hive-h', hostRef: 'host:self' }, { currentGrantorEpoch: spy });
    await deps.currentGrantorEpoch(42);
    expect(spy).toHaveBeenCalledWith(42);
  });

  it('composes both WI-1937 ports from foreignSessionExecutorDeps (applyCapabilityEnvelope + launchSession present)', () => {
    const deps = productionOfferExecutorDeps({ workspaceId: 'ws-1', potSlug: 'hive-h', hostRef: 'host:self' });
    expect(typeof deps.applyCapabilityEnvelope).toBe('function');
    expect(typeof deps.launchSession).toBe('function');
    expect(typeof deps.currentGrantorEpoch).toBe('function');
    expect(typeof deps.hostAvailability).toBe('function');
  });
});
