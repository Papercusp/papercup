/**
 * WI-6007 — wiring the (fully-built, zero-writer) `harness_shared.claim_audit`
 * detector into getNextForBee, the ONE place that knows the RESOLVED claim-spec
 * provenance (source/specId/revision/fleetSlug).
 *
 * Motivating incident (WI-5995): a p2p-titled bug was served to two fleet members
 * whose claim spec rev 8 explicitly excludes `*p2p*`; proving which spec/revision
 * actually admitted it took a full SQL + JS-evaluator investigation and could still
 * only be INFERRED. These tests prove: (a) a successful claim writes a row carrying
 * the resolved specId/revision/source, (b) a THROWN insert never fails the claim
 * (pure best-effort observability), and (c) the fail-closed scope-refusal path is
 * recorded too (point 4 of the ticket), without ever handing out a real item.
 *
 * getNextWorkItem / planItemLaneBlockReason / releaseWorkItem / matchesWorkItemClaimSpec
 * are mocked at the module boundary (same pattern as
 * get-next-for-bee-plan-lane-guard.test.ts); `recordClaimAttempt` (claim-audit.ts) is
 * mocked so these stay unit-speed with no PG — the writer itself is already covered
 * by claim-audit.integration.test.ts against a real Postgres.
 *
 * Run: cd packages/operator-core && npx vitest run lib/scheduler/claim-audit-provenance.test.ts
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { createBranchedSqlMock } from '../testing/sql-mock';

const { sqlMock } = vi.hoisted(() => ({
  sqlMock: vi.fn(async (..._args: unknown[]) => [] as unknown[]),
}));
vi.mock('@papercusp/db-org', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({ sql: sqlMock }),
}));

const getNextWorkItemMock = vi.fn();
vi.mock('./get-next', () => ({
  getNextWorkItem: (...args: unknown[]) => getNextWorkItemMock(...args),
}));

const planItemLaneBlockReasonMock = vi.fn();
vi.mock('./plan-item-lane-guard', () => ({
  planItemLaneBlockReason: (...args: unknown[]) => planItemLaneBlockReasonMock(...args),
}));

const releaseWorkItemMock = vi.fn(async (..._args: unknown[]) => null);
vi.mock('../work-items', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../work-items')>()),
  releaseWorkItem: (...args: unknown[]) => releaseWorkItemMock(...args),
}));

const matchesWorkItemClaimSpecMock = vi.fn((..._args: unknown[]) => true);
vi.mock('./claim-spec-match', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./claim-spec-match')>()),
  matchesWorkItemClaimSpec: (...args: unknown[]) => matchesWorkItemClaimSpecMock(...args),
}));

const recordClaimAttemptMock = vi.fn(async (..._args: unknown[]) => undefined);
vi.mock('../orchestrator/claim-audit', () => ({
  recordClaimAttempt: (...args: unknown[]) => recordClaimAttemptMock(...args),
}));

import { getNextForBee } from './claim-spec-store';

function claimResult(id: string, family: 'feature' | 'issue' = 'feature') {
  return {
    workItem: { id, family, payload: {}, harness: 'papercusp' },
    claimedUnder: { specId: 'gui-chat-controls-plan', revision: 7 },
  };
}

describe('getNextForBee — claim_audit provenance wiring (WI-6007)', () => {
  beforeEach(() => {
    sqlMock.mockReset().mockResolvedValue([]);
    getNextWorkItemMock.mockReset();
    planItemLaneBlockReasonMock.mockReset();
    releaseWorkItemMock.mockReset().mockResolvedValue(null);
    matchesWorkItemClaimSpecMock.mockReset().mockReturnValue(true);
    recordClaimAttemptMock.mockReset().mockResolvedValue(undefined);
  });

  it('records a WON row carrying the resolved specId+revision+source on a successful claim', async () => {
    getNextWorkItemMock.mockResolvedValueOnce(claimResult('WI-1', 'issue'));
    planItemLaneBlockReasonMock.mockResolvedValueOnce(null);

    const res = await getNextForBee({ cupId: 'su-me', harness: 'papercusp', ignoreStoredSpec: true });

    expect(res?.workItem.id).toBe('WI-1');
    expect(recordClaimAttemptMock).toHaveBeenCalledOnce();
    const call = recordClaimAttemptMock.mock.calls[0]![0] as {
      workspaceId: string;
      harnessSlug: string;
      feature_id: string;
      claimer_pubkey: string;
      outcome: string;
      detail: string;
    };
    expect(call.harnessSlug).toBe('papercusp');
    expect(call.feature_id).toBe('WI-1');
    expect(call.claimer_pubkey).toBe('su-me');
    expect(call.outcome).toBe('won');
    // ignoreStoredSpec:true resolves `record` to the literal DEFAULT-source object
    // (per getNextForBee's own contract — res.specSource asserts the same thing in
    // the sibling plan-lane-guard test suite), so the provenance recorded here is
    // 'default' — the important thing being it is the RESOLVED source, not omitted.
    const detail = JSON.parse(call.detail) as Record<string, unknown>;
    expect(detail).toMatchObject({
      source: 'default',
      specId: 'gui-chat-controls-plan',
      revision: 7,
      tier: 'issue-tier3',
    });
  });

  it('records tier as feature-tier1-2 for a feature-family claim', async () => {
    getNextWorkItemMock.mockResolvedValueOnce(claimResult('F-1', 'feature'));
    planItemLaneBlockReasonMock.mockResolvedValueOnce(null);

    await getNextForBee({ cupId: 'su-me', harness: 'papercusp', ignoreStoredSpec: true });

    const call = recordClaimAttemptMock.mock.calls[0]![0] as { detail: string };
    expect(JSON.parse(call.detail)).toMatchObject({ tier: 'feature-tier1-2' });
  });

  it('a THROWN insert never fails the claim (pure best-effort observability)', async () => {
    getNextWorkItemMock.mockResolvedValueOnce(claimResult('F-2'));
    planItemLaneBlockReasonMock.mockResolvedValueOnce(null);
    recordClaimAttemptMock.mockRejectedValueOnce(new Error('claim_audit insert boom'));

    const res = await getNextForBee({ cupId: 'su-me', harness: 'papercusp', ignoreStoredSpec: true });

    // The claim itself must still succeed despite the audit write throwing.
    expect(res?.workItem.id).toBe('F-2');
    expect(recordClaimAttemptMock).toHaveBeenCalledOnce();
  });

  it('records a LOST row for the fail-closed scope-refusal path (WI-4770 transition guard), never handing out an item', async () => {
    // getClaimSpecRecord resolution: no per-bee row, a fleet-membership fact naming
    // 'ghost-fleet', and no valid sentinel row for it — resolves to
    // { source: 'default', fleetSlug: 'ghost-fleet' }, which getNextForBee's own
    // fail-closed guard (WI-4770) must refuse rather than fall through to the
    // generic backlog. The per-bee and fleet-sentinel lookups share IDENTICAL query
    // text (same SELECT over cup_claim_specs, differing only in the interpolated
    // bee_id VALUE) — createBranchedSqlMock's `match` also receives the full call
    // args, so branch on the interpolated bee_id (args[2]) rather than text.
    const branches = createBranchedSqlMock([
      {
        label: 'per-bee claim-spec lookup (bee_id = cupId) — none stored',
        match: (q, args) => q.includes('FROM harness_shared.cup_claim_specs') && args[2] === 'su-me',
        respond: () => [],
      },
      {
        label: 'fleet-membership lookup — names ghost-fleet',
        match: (q) => q.includes('FROM harness_shared.fleet_membership_events'),
        respond: () => [{ fleet_slug: 'ghost-fleet', fleet_role: 'member' }],
      },
      {
        label: "fleet-sentinel claim-spec lookup (bee_id = 'fleet:ghost-fleet') — invalid/missing",
        match: (q, args) => q.includes('FROM harness_shared.cup_claim_specs') && args[2] === 'fleet:ghost-fleet',
        respond: () => [],
      },
    ]);
    sqlMock.mockImplementation(branches.handler);

    const res = await getNextForBee({ cupId: 'su-me', harness: 'papercusp' });

    expect(res).toBeNull();
    expect(getNextWorkItemMock).not.toHaveBeenCalled(); // never even reached item-selection
    expect(recordClaimAttemptMock).toHaveBeenCalledOnce();
    const call = recordClaimAttemptMock.mock.calls[0]![0] as {
      feature_id: string;
      claimer_pubkey: string;
      outcome: string;
      detail: string;
    };
    expect(call.feature_id).toBe('fleet-scope-refusal:ghost-fleet');
    expect(call.claimer_pubkey).toBe('su-me');
    expect(call.outcome).toBe('lost');
    expect(JSON.parse(call.detail)).toMatchObject({ source: 'default', fleetSlug: 'ghost-fleet' });
  });
});
