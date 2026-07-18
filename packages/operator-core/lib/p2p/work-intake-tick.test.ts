/**
 * work-intake-tick.test.ts — P-406 (D-004) minimal intake loop, unit-level.
 *
 * Every real IO edge (listWorkOffers, resolvePublisherSet,
 * resolveAttestedGithubUserId, currentGrantorEpoch, hostAvailability,
 * pullAndExecute, emitReceipt) is injected — this proves the TICK'S OWN
 * orchestration (offer→input assembly, the v1 designation:null boundary,
 * unresolvable-record handling, receipt-on-skip, no-receipt-on-execute)
 * without needing a live PG. The underlying `evaluatePull`/
 * `executeClaimedOffer` chain already has its own real-seam coverage in
 * offer-pull-and-execute.test.ts / standing-puller.test.ts / offer-executor.test.ts.
 */
import { describe, it, expect, vi } from 'vitest';
import { runWorkIntakeTick, type WorkIntakeHostIdentity } from './work-intake-tick';
import type { StoredWorkOffer } from './offer-store';
import type { WorkOffer } from './offer-budget';
import type { OfferAuthorship } from './offer-authorship';
import type { PublisherSet } from './offer-authorship';
import type { PullAndExecuteResult } from './offer-pull-and-execute';

const HOST: WorkIntakeHostIdentity = {
  hostRef: 'host:self',
  responderGithubUserId: 5,
  executorDevice: 'dev-host',
  sourceRepoPath: '/src/repo',
  rootPath: '/root',
};

const OFFER: WorkOffer = {
  offerId: 'offer-1',
  fleetSlug: 'fleet-a',
  publisherRef: 'user:279242982',
  billedTo: 'host:h1',
  modelClass: 'frontier-remote',
  priority: 3,
  isolationReqs: [],
  budget: { remote: { cap: 1000, unit: 'usd-micros', maxPerCall: 100 }, local: null },
  publishedAt: 1000,
  ttlMs: 60_000,
};

const AUTHORSHIP: OfferAuthorship = {
  devicePubkey: 'pubkey-1',
  signatureByDevice: 'sig-1',
  epoch: 4,
};

const OK_PUBLISHER_SET: PublisherSet = {
  ownerGithubUserId: 279242982,
  ownerAnchored: true,
  ownerSignatureValid: true,
  memberGithubUserIds: [279242982, 5],
};

function storedOffer(over: Partial<StoredWorkOffer> = {}): StoredWorkOffer {
  return {
    workspaceId: 'ws-1',
    potHomeSlug: 'papercusp',
    publisherGithubUserId: 279242982,
    offerId: 'offer-1',
    record: {
      offerId: 'offer-1',
      publisherGithubUserId: 279242982,
      fleetSlug: 'fleet-a',
      kind: 'work',
      status: 'open',
      cancelReason: null,
      workOffer: OFFER,
      authorship: AUTHORSHIP,
      seat: null,
      spawnRequest: null,
      recordVersion: 1,
    },
    recordJson: '{}',
    signerDevicePubkey: 'pubkey-1',
    signature: 'sig-outer',
    recordVersion: 1,
    fleetSlug: 'fleet-a',
    offerKind: 'work',
    status: 'open',
    localDisposition: null,
    fedHlc: null,
    updatedAt: 1000,
    ...over,
  };
}

function baseDeps(overOffers: StoredWorkOffer[] = [storedOffer()]) {
  const receipts: unknown[] = [];
  return {
    host: HOST,
    listWorkOffers: vi.fn(async () => overOffers),
    resolvePublisherSet: vi.fn(async () => OK_PUBLISHER_SET),
    resolveAttestedGithubUserId: vi.fn(async () => 5),
    currentGrantorEpoch: vi.fn(async () => 4),
    hostAvailability: vi.fn(async () => ({ remote: null, local: null })),
    emitReceipt: vi.fn(async (args: unknown) => {
      receipts.push(args);
      return { ok: true, receipt: {} } as never;
    }),
    _receipts: receipts,
  };
}

describe('runWorkIntakeTick (P-406/D-004 minimal intake loop)', () => {
  it('no-ops when there are no open offers (never calls the pull/execute seam)', async () => {
    const deps = baseDeps([]);
    const pullAndExecute = vi.fn();
    const result = await runWorkIntakeTick('ws-1', 'papercusp', { ...deps, pullAndExecute });
    expect(result.offers).toEqual([]);
    expect(pullAndExecute).not.toHaveBeenCalled();
  });

  it('marks a pre-schema/junk or non-work record UNRESOLVABLE without touching the pull seam', async () => {
    const deps = baseDeps([storedOffer({ record: null })]);
    const pullAndExecute = vi.fn();
    const result = await runWorkIntakeTick('ws-1', 'papercusp', { ...deps, pullAndExecute });
    expect(result.offers).toEqual([{ offerId: 'offer-1', outcome: 'unresolvable', reason: 'malformed_or_non_work_record' }]);
    expect(pullAndExecute).not.toHaveBeenCalled();
  });

  it('skips with a loud receipt when the publisher set fails to resolve (fail-closed, never guesses)', async () => {
    const deps = baseDeps();
    deps.resolvePublisherSet = vi.fn(async () => ({ ...OK_PUBLISHER_SET, ownerSignatureValid: false }));
    const pullAndExecute = vi.fn();
    const result = await runWorkIntakeTick('ws-1', 'papercusp', { ...deps, pullAndExecute });
    expect(result.offers).toEqual([{ offerId: 'offer-1', outcome: 'skip', reason: 'publisher_set_unresolvable' }]);
    expect(pullAndExecute).not.toHaveBeenCalled();
    expect(deps._receipts).toHaveLength(1);
    expect((deps._receipts[0] as { refusal: { code: string } }).refusal.code).toBe('publisher_set_unresolvable');
  });

  it('always calls evaluatePull with designation: null (the v1 no-steal boundary) and forwards the resolved inputs', async () => {
    const deps = baseDeps();
    const pullAndExecute = vi.fn(async () => ({ outcome: 'skip', decision: { outcome: 'skip', reason: 'no_claim_authority', detail: 'no headroom' } }) satisfies PullAndExecuteResult);
    await runWorkIntakeTick('ws-1', 'papercusp', { ...deps, pullAndExecute });
    expect(pullAndExecute).toHaveBeenCalledTimes(1);
    const [input, execCtx] = pullAndExecute.mock.calls[0]!;
    expect(input.designation).toBeNull();
    expect(input.selfHostRef).toBe('host:self');
    expect(input.authorship.attestedGithubUserId).toBe(5);
    expect(input.authorship.publisherSet).toEqual(OK_PUBLISHER_SET);
    expect(input.authorship.ownerHighWaterEpoch).toBe(4);
    expect(execCtx.hostRef).toBe('host:self');
    expect(execCtx.responderGithubUserId).toBe(5);
  });

  it('relays a puller SKIP as a receipted skip, never as an error', async () => {
    const deps = baseDeps();
    const pullAndExecute = vi.fn(
      async () =>
        ({
          outcome: 'skip',
          decision: { outcome: 'skip', reason: 'opt-in-off', detail: 'admission refused: opt-in-off' },
        }) satisfies PullAndExecuteResult,
    );
    const result = await runWorkIntakeTick('ws-1', 'papercusp', { ...deps, pullAndExecute });
    expect(result.offers).toEqual([{ offerId: 'offer-1', outcome: 'skip', reason: 'puller:opt-in-off' }]);
    expect(deps._receipts).toHaveLength(1);
  });

  it('reports a WON claim as executed and emits NO extra receipt (the executor already receipts its own pipeline)', async () => {
    const deps = baseDeps();
    const pullAndExecute = vi.fn(
      async () =>
        ({
          outcome: 'executed',
          decision: { outcome: 'claim', stole: false, authorizedGithubUserId: 5, ownerGithubUserId: 279242982, epoch: 4, grants: [] },
          execute: { ok: true, workspace: {} as never, sessionId: 'sess-1', clonePath: '/root/repo', presenceLabel: 'foreign', ledgers: {}, receiptsEmitted: 0, receiptFailures: 0 } as never,
        }) satisfies PullAndExecuteResult,
    );
    const result = await runWorkIntakeTick('ws-1', 'papercusp', { ...deps, pullAndExecute });
    expect(result.offers).toEqual([{ offerId: 'offer-1', outcome: 'executed' }]);
    expect(deps._receipts).toHaveLength(0);
  });

  it('processes multiple offers independently — one refusal never stalls the others', async () => {
    const deps = baseDeps([storedOffer({ offerId: 'offer-1' }), storedOffer({ offerId: 'offer-2', record: null })]);
    const pullAndExecute = vi.fn(
      async () =>
        ({
          outcome: 'executed',
          decision: { outcome: 'claim', stole: false, authorizedGithubUserId: 5, ownerGithubUserId: 279242982, epoch: 4, grants: [] },
          execute: { ok: true, workspace: {} as never, sessionId: 'sess-1', clonePath: '/root/repo', presenceLabel: 'foreign', ledgers: {}, receiptsEmitted: 0, receiptFailures: 0 } as never,
        }) satisfies PullAndExecuteResult,
    );
    const result = await runWorkIntakeTick('ws-1', 'papercusp', { ...deps, pullAndExecute });
    expect(result.offers).toEqual([
      { offerId: 'offer-1', outcome: 'executed' },
      { offerId: 'offer-2', outcome: 'unresolvable', reason: 'malformed_or_non_work_record' },
    ]);
  });
});
