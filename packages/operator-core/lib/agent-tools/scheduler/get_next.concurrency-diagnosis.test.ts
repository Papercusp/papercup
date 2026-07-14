/**
 * EI-12095: scheduler:get_next's miss diagnosis must recognize "you already hold your max
 * concurrent claims" as a DISTINCT cause from pool/floor admissibility.
 *
 * `getNextForBee` (claim-spec-store.ts) short-circuits BEFORE the claim query whenever the
 * caller already holds >= its spec's maxConcurrentClaims (default 1) — a parked/held item
 * still counts (it retains `taken_by`). Before this fix, the miss-diagnosis path
 * (`buildMissDiagnosis` → `diagnoseClaimNextMiss` / `explainIssueClaimFloors`) had no idea
 * this had happened and reported ordinary pool/floor admissibility stats (e.g. "26 admissible,
 * 0 floored") — a real, expensive false signal: a live fleet leader burned hours bisecting the
 * claim query/tier-3 flag/workspace scope for a member that was simply holding its one slot.
 *
 * These tests pin: a concurrency-blocked miss is reported plainly, with the held ids, and
 * WITHOUT ever invoking the pool/floor diagnosis machinery.
 */
import { beforeEach, describe, it, expect, vi } from 'vitest';

const diagnoseM = vi.hoisted(() => vi.fn());
const explainFloorsM = vi.hoisted(() => vi.fn());
const getClaimSpecRecordM = vi.hoisted(() => vi.fn());
const getActiveClaimsM = vi.hoisted(() => vi.fn());
const getNextForBeeM = vi.hoisted(() => vi.fn());

vi.mock('../coordination/identity', () => ({
  resolveAgentIdentity: () => ({ ownerId: 'su-member', workspaceId: 'ws-1' }),
}));
vi.mock('@papercusp/flags/server', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getFlag: vi.fn(async () => true),
}));
vi.mock('../../scheduler/fleet-scope-admission', () => ({
  // No fleet scope in play — the miss must fall through to buildMissDiagnosis.
  reconcileFleetScopeClaims: vi.fn(async () => ({ scope: null, quarantinedIds: [] })),
  fleetScopedMiss: vi.fn(),
}));
vi.mock('../../scheduler/claim-spec-store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../scheduler/claim-spec-store')>();
  return {
    ...actual,
    getNextForBee: getNextForBeeM,
    getClaimSpecRecord: getClaimSpecRecordM,
    getActiveClaimsForBee: getActiveClaimsM,
  };
});
vi.mock('../../work-items', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  diagnoseClaimNextMiss: diagnoseM,
  explainIssueClaimFloors: explainFloorsM,
}));

import getNextTool from './get_next';

async function callMiss() {
  const out = (await getNextTool.handler({ harness: 'papercusp' } as never, {} as never)) as {
    content: Array<{ text: string }>;
  };
  return JSON.parse(out.content[0]!.text);
}

describe('scheduler:get_next miss diagnosis is concurrency-aware (EI-12095)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getNextForBeeM.mockResolvedValue(null); // every test here is a miss
    diagnoseM.mockResolvedValue({ drained: false, pendingUnclaimed: 26, readyUnclaimed: 26 });
    explainFloorsM.mockResolvedValue([]);
  });

  it('reports the concurrency block plainly, with held ids, WITHOUT running the pool/floor diagnosis', async () => {
    getClaimSpecRecordM.mockResolvedValue({
      source: 'cup',
      spec: { specId: 'x', revision: 1, limits: { maxConcurrentClaims: 1 } },
      revision: 1,
      updatedBy: null,
      updatedAt: null,
    });
    getActiveClaimsM.mockResolvedValue([{ id: 'EI-10058', kind: 'bug' }]);

    const b = await callMiss();

    expect(b.ok).toBe(false);
    expect(b.error).toMatch(/you already hold 1\/1 concurrent claim\(s\)/);
    expect(b.error).toMatch(/held: EI-10058/);
    expect(b.diagnosis).toMatchObject({
      concurrencyBlocked: true,
      activeClaims: 1,
      maxConcurrentClaims: 1,
      heldIds: ['EI-10058'],
    });
    // The whole point: a concurrency-blocked miss must never reach — let alone report — the
    // pool/floor admissibility stats that misled the live incident this closes.
    expect(diagnoseM).not.toHaveBeenCalled();
    expect(explainFloorsM).not.toHaveBeenCalled();
  });

  it('names EVERY held id when a spec authorizes more than one concurrent claim', async () => {
    getClaimSpecRecordM.mockResolvedValue({
      source: 'cup',
      spec: { specId: 'x', revision: 1, limits: { maxConcurrentClaims: 2 } },
      revision: 1,
      updatedBy: null,
      updatedAt: null,
    });
    getActiveClaimsM.mockResolvedValue([
      { id: 'EI-1', kind: 'bug' },
      { id: 'EI-2', kind: 'change' },
    ]);

    const b = await callMiss();

    expect(b.error).toMatch(/you already hold 2\/2 concurrent claim\(s\)/);
    expect(b.error).toMatch(/held: EI-1, EI-2/);
    expect(diagnoseM).not.toHaveBeenCalled();
  });

  it('falls through to the pool/floor diagnosis when the caller is UNDER its concurrency limit', async () => {
    getClaimSpecRecordM.mockResolvedValue({
      source: 'cup',
      spec: { specId: 'x', revision: 1, limits: { maxConcurrentClaims: 1 } },
      revision: 1,
      updatedBy: null,
      updatedAt: null,
    });
    getActiveClaimsM.mockResolvedValue([]); // holds nothing — a genuine pool/floor miss

    const b = await callMiss();

    expect(b.error).toMatch(/the backlog is NOT drained: 26 unclaimed/);
    expect(b.diagnosis).toMatchObject({ drained: false, pendingUnclaimed: 26, readyUnclaimed: 26 });
    expect(diagnoseM).toHaveBeenCalledOnce();
  });

  it('defaults maxConcurrentClaims to 1 when the spec omits `limits` (matches getNextForBee)', async () => {
    getClaimSpecRecordM.mockResolvedValue({
      source: 'default',
      spec: { specId: 'default', revision: 0 }, // no `limits` at all
      revision: null,
      updatedBy: null,
      updatedAt: null,
    });
    getActiveClaimsM.mockResolvedValue([{ id: 'WI-42', kind: 'change' }]);

    const b = await callMiss();

    expect(b.error).toMatch(/you already hold 1\/1 concurrent claim\(s\)/);
    expect(diagnoseM).not.toHaveBeenCalled();
  });

  it('fails soft to the ordinary pool/floor diagnosis if getActiveClaimsForBee errors', async () => {
    getClaimSpecRecordM.mockResolvedValue({
      source: 'cup',
      spec: { specId: 'x', revision: 1, limits: { maxConcurrentClaims: 1 } },
      revision: 1,
      updatedBy: null,
      updatedAt: null,
    });
    getActiveClaimsM.mockRejectedValue(new Error('pg boom'));

    const b = await callMiss();

    expect(b.error).toMatch(/the backlog is NOT drained/);
    expect(diagnoseM).toHaveBeenCalledOnce();
  });
});
