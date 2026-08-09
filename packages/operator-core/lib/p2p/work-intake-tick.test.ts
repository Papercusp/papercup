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
import { resolve } from 'node:path';
import { runWorkIntakeTick, type WorkIntakeHostIdentity } from './work-intake-tick';
import type { StoredWorkOffer } from './offer-store';
import type { WorkOffer } from './offer-budget';
import type { OfferAuthorship } from './offer-authorship';
import type { PublisherSet } from './offer-authorship';
import type { PullAndExecuteContext, PullAndExecuteResult } from './offer-pull-and-execute';
import type { PullEvaluationInput } from './standing-puller';
import type { Sql } from 'postgres';
import { bakedP2pDefaults, mergeP2pLayers } from './settings';

const HOST: WorkIntakeHostIdentity = {
  hostRef: 'host:self',
  responderGithubUserId: 5,
  executorDevice: 'dev-host',
  sourceRepoPath: '/src/repo',
  foreignWorkRoot: '/foreign-work',
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
      potSlug: null,
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
    potSlug: null,
    offerKind: 'work',
    status: 'open',
    localDisposition: null,
    fedHlc: null,
    updatedAt: 1000,
    ...over,
  };
}

// Every seam below is injected, so this handle is never dereferenced — it only has
// to STOP `runWorkIntakeTick` from falling back to `getOrgPg().sql`, which opens a
// real pool against the developer's live DB (the no-real-PG rail,
// EI-19311807188719573, turned that silent live read into a loud failure).
const SQL_STUB = {} as unknown as Sql;

function baseDeps(overOffers: StoredWorkOffer[] = [storedOffer()]) {
  const receipts: unknown[] = [];
  return {
    host: HOST,
    sql: SQL_STUB,
    readP2pSettings: vi.fn(async () => ({
      workspaceId: 'ws-1',
      baked: bakedP2pDefaults(),
      defaultLayer: null,
      overrideLayer: null,
      effective: mergeP2pLayers(bakedP2pDefaults()),
    })),
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

  /**
   * WI-37205 recurrence guard. The defect was NOT that the idle path did the wrong
   * thing — it did exactly the right thing, silently. `{ offers: [] }` was returned
   * before any log and with no counter, so a COMPLETED idle scan and a body that
   * never ran produced byte-identical evidence, and `routines.last_fired_at` could
   * not separate them either (claim.ts stamps it at DISPATCH, before the body runs).
   *
   * The property under test is therefore *evidence-bearing-ness*, not behavior:
   * an idle tick must return proof that a scan HAPPENED. Asserting `offers` is empty
   * cannot express that — `scanned` is the field that can.
   */
  it('reports a COMPLETED idle scan distinguishably (scanned:0, not merely an empty offers[])', async () => {
    const deps = baseDeps([]);
    const result = await runWorkIntakeTick('ws-1', 'papercusp', { ...deps, pullAndExecute: vi.fn() });

    expect(result.scanned).toBe(0);
    // The whole point: `scanned` is PRESENT on the idle path. A body that never ran
    // could not have set it, so `undefined` here is the regression, not `0`.
    expect(result.scanned).not.toBeUndefined();
    expect(Object.hasOwn(result, 'scanned')).toBe(true);
  });

  it('reports how many offers a non-idle tick actually scanned', async () => {
    const deps = baseDeps([storedOffer({ record: null }), storedOffer({ record: null })]);
    const result = await runWorkIntakeTick('ws-1', 'papercusp', { ...deps, pullAndExecute: vi.fn() });

    expect(result.scanned).toBe(2);
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
    const pullAndExecute = vi.fn(async (_input: PullEvaluationInput, _ctx: PullAndExecuteContext) =>
      ({ outcome: 'skip', decision: { outcome: 'skip', reason: 'no_claim_authority', detail: 'no headroom' } }) satisfies PullAndExecuteResult,
    );
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

  // WI-6680 regression ×2. `p2p_foreign_workspaces` has a UNIQUE index on
  // root_path (mig 467), so the host config's foreign-work path must be a BASE
  // that each offer gets its own subtree under — passing one shared root
  // through registers offer #1 and refuses every later offer with `conflict`.
  it('derives a PER-OFFER foreign root under the host base (root_path is UNIQUE — one shared root breaks offer #2)', async () => {
    const deps = baseDeps([storedOffer({ offerId: 'offer-a' }), storedOffer({ offerId: 'offer-b' })]);
    const pullAndExecute = vi.fn(async (_input: PullEvaluationInput, _ctx: PullAndExecuteContext) =>
      ({ outcome: 'skip', decision: { outcome: 'skip', reason: 'no_claim_authority', detail: 'x' } }) satisfies PullAndExecuteResult,
    );
    await runWorkIntakeTick('ws-1', 'papercusp', { ...deps, pullAndExecute });

    const roots = pullAndExecute.mock.calls.map(([, ctx]) => ctx.rootPath);
    expect(roots).toEqual(['/foreign-work/offer-a', '/foreign-work/offer-b']);
    expect(new Set(roots).size).toBe(roots.length);
  });

  it('never lets a REMOTE-AUTHORED offerId escape the foreign-work base via path traversal', async () => {
    const deps = baseDeps([storedOffer({ offerId: '../../../etc/cron.d' })]);
    const pullAndExecute = vi.fn(async (_input: PullEvaluationInput, _ctx: PullAndExecuteContext) =>
      ({ outcome: 'skip', decision: { outcome: 'skip', reason: 'no_claim_authority', detail: 'x' } }) satisfies PullAndExecuteResult,
    );
    await runWorkIntakeTick('ws-1', 'papercusp', { ...deps, pullAndExecute });

    // The property that matters is CONTAINMENT after normalization, not the
    // absence of literal dots: '..' is inert once the separators are gone, so
    // resolve() is what actually proves the escape failed.
    const root = pullAndExecute.mock.calls[0]![1].rootPath;
    expect(resolve(root).startsWith(resolve('/foreign-work') + '/')).toBe(true);
    expect(resolve(root)).not.toBe(resolve('/etc/cron.d'));
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
