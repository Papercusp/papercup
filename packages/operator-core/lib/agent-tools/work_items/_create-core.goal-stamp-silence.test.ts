/**
 * EI-20075667133396690 — a FAILED goal-provenance stamp must be distinguishable
 * from one that correctly DECLINED.
 *
 * `createOneWorkItem` stamps `work_items.goal_id` as a best-effort decoration and
 * swallows any failure, which is the right call: the item exists, and failing a
 * creation because provenance could not be recorded is worse than losing the
 * attribution. The defect was that the catch was EMPTY — no log, no field, no
 * signal of any kind.
 *
 * That silence matters because of the base rate. Declining to stamp is the
 * overwhelming majority outcome (most agents are not running under a goal), and a
 * decline and a throw produced byte-identical results: `goalId` absent. So a stamp
 * that was broken for every single call would look exactly like a fleet that simply
 * has no goals — which is precisely the ambiguity that made `goal_id` NULL on all
 * 37,579 work-items unreadable without booting real Postgres to settle it.
 *
 * The three cases below are one discrimination test, and the two controls are the
 * point: asserting only that a throw reports an error would pass against an
 * implementation that reports an error unconditionally, which would be a worse bug
 * than the one being fixed (it would cry wolf on the majority path).
 *
 * Companion: goal-provenance-stamp.integration.test.ts proves the stamp's SQL is
 * correct against real Postgres. This file is about what happens when it is not.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@papercusp/flags/server', () => ({ getFlag: vi.fn(async () => false) }));
vi.mock('../../work-items', () => ({
  createWorkItem: vi.fn(async (input: { kind: string; title: string; harness?: string }) => ({
    id: 'WI-NEW',
    kind: input.kind,
    title: input.title,
    harness: input.harness ?? 'papercusp',
  })),
  getWorkItem: vi.fn(async () => null),
  linkWorkItem: vi.fn(async () => {}),
  isWorkItemKind: (k: string) => ['feature', 'chunk', 'bug', 'change', 'task'].includes(k),
  isDeprecatedWorkItemKind: (k: string) => k === 'chunk',
  familyOf: (k: string) => (['bug', 'change', 'task'].includes(k) ? 'issue' : 'feature'),
  ensureClaimHoldAttribution: (payload: unknown) => payload,
  resolveWorkItemRef: vi.fn(async () => null),
  setWorkItemState: vi.fn(async () => {}),
}));
vi.mock('./mirror-guard', () => ({ findMirroredOpenItem: vi.fn(async () => null) }));
vi.mock('../_pot-scope', () => ({
  resolvePotScope: vi.fn(async () => ({ kind: 'pot', slug: 'papercusp' })),
  POT_REQUIRED_DETAIL: 'hive required',
}));
vi.mock('../../datatype-registry-store', () => ({ getGenericKindDatatype: vi.fn(async () => null) }));
vi.mock('../../datatype-payload-validation', () => ({
  validateDatatypePayload: () => ({ ok: true as const }),
}));
vi.mock('../../routing-gate-hints', () => ({ matchRoutingGateHint: () => null }));
vi.mock('../../issue-blocks-merge', () => ({
  planItemRef: (s: string, i: string) => `${s}#${i}`,
  PLAN_ITEM_KIND: 'plan_item',
}));
vi.mock('./semantic-dupe-guard', () => ({ findSemanticDupes: vi.fn(async () => null) }));
vi.mock('./recent-lexical-dupe-guard', () => ({ findRecentLexicalDupes: vi.fn(async () => null) }));
vi.mock('./fulltext-lexical-dupe-guard', () => ({ findFulltextLexicalDupes: vi.fn(async () => null) }));

/** The ambient goal the creating agent is (or is not) running under. */
const resolveGoalContextMock = vi.fn<() => Promise<string | null>>(async () => null);
vi.mock('../../modes/goal-context', () => ({
  resolveGoalContext: () => resolveGoalContextMock(),
}));

/** The stamp's UPDATE. Throws when `sqlThrows` is set — the failure mode under test. */
let sqlThrows: Error | null = null;
const sqlMock = vi.fn(async () => {
  if (sqlThrows) throw sqlThrows;
  return [];
});
vi.mock('@papercusp/db-org', async (orig) => ({ ...(await orig<typeof import('@papercusp/db-org')>()), getOrgPg: () => ({ sql: sqlMock }) }));

import { createOneWorkItem } from './_create-core';

const ctx = { ownerId: 'agent-1', workspaceId: 'default', harnessSlug: 'papercusp' };
const spec = { kind: 'bug' as const, title: 'a thing is broken' };

/** Narrow to the ok:true arm and expose the two goal fields under test. */
function okResult(r: Awaited<ReturnType<typeof createOneWorkItem>>) {
  if (!r.ok) throw new Error(`expected ok:true, got error: ${r.error}`);
  return r;
}

describe('createOneWorkItem × goal-provenance stamp failures (EI-20075667133396690)', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    sqlThrows = null;
    resolveGoalContextMock.mockClear();
    resolveGoalContextMock.mockResolvedValue(null);
    sqlMock.mockClear();
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => warnSpy.mockRestore());

  it('reports goalStampError — and still creates the item — when the stamp THROWS', async () => {
    resolveGoalContextMock.mockResolvedValue('goal-abc');
    sqlThrows = new Error('column "goal_id" does not exist');

    const r = okResult(await createOneWorkItem(spec, ctx));

    // Fail-open is the contract: the item MUST still exist.
    expect(r.workItem.id).toBe('WI-NEW');
    // ...but the failure is no longer invisible.
    expect(r.goalStampError).toMatch(/goal_id.*does not exist/);
    expect(r.goalId).toBeUndefined();
    // ...and it is on the record for anyone reading logs rather than the result.
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('goal provenance stamp failed for WI-NEW'),
      expect.stringContaining('does not exist'),
    );
  });

  it('CONTROL: a DECLINED stamp (agent has no goal) is not reported as an error', async () => {
    // The majority path. If this ever reports goalStampError, the signal is worthless:
    // every creation on the box would carry a spurious failure.
    resolveGoalContextMock.mockResolvedValue(null);

    const r = okResult(await createOneWorkItem(spec, ctx));

    expect(r.goalStampError).toBeUndefined();
    expect(r.goalId).toBeUndefined();
    expect(sqlMock).not.toHaveBeenCalled(); // declined before touching the DB
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('CONTROL: a SUCCEEDED stamp returns goalId and no error', async () => {
    // Guards the other direction — that the error field is not simply always set,
    // and that goalId is really reachable on the typed result (it was returned at
    // runtime but undeclared, so callers had to cast to see it).
    resolveGoalContextMock.mockResolvedValue('goal-abc');

    const r = okResult(await createOneWorkItem(spec, ctx));

    expect(r.goalId).toBe('goal-abc');
    expect(r.goalStampError).toBeUndefined();
    expect(sqlMock).toHaveBeenCalledTimes(1);
    expect(warnSpy).not.toHaveBeenCalled();
  });
});
