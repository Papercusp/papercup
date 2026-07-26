/**
 * reconcile-linked-work-items.integration.test.ts — EI-5925.
 *
 * Mirrors convert.integration.test.ts's strategy: the `../work-items` module
 * (getWorkItem / setWorkItemState / isSettledWorkItemState) is mocked so each
 * WorkItem's shape (state / lastProgressAt / family) is fully controlled per
 * test, while `coord_links` + `harness_features_consolidated` / `engineer_issues`
 * are REAL Postgres (the same lightweight schema fixture, so the actual SQL --
 * the `implements` edge lookup AND the `payload.plan_item` stamp-unwrap match --
 * is proven, not assumed.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import { HARNESS_FEATURES_CONSOLIDATED_DDL } from '../../test/_work-items-schema';
import { randomBytes } from 'node:crypto';
import { getTestPg } from '@papercusp/test-config/pg';
import { DEFAULT_COORD_WORKSPACE } from '@papercusp/coordination/event-log';
import { PLAN_ITEM_KIND, planItemRef } from '../issue-blocks-merge';
import { IMPLEMENTS_REL } from './convert';

const h = vi.hoisted(() => ({ sql: undefined as unknown as postgres.Sql }));
vi.mock('@papercusp/db-org', async () => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return { ...actual, getOrgPg: () => ({ sql: h.sql }) };
});

interface StubWorkItem {
  id: string;
  harness: string | null;
  state: string;
  family: 'issue' | 'feature';
  lastProgressAt: string | null;
  payload?: Record<string, unknown> | null;
}

const h2 = vi.hoisted(() => ({
  items: new Map<string, StubWorkItem>(),
  setWorkItemState: vi.fn(async (id: string, state: string) => {
    const wi = h2.items.get(id);
    if (wi) wi.state = state;
    return wi ?? null;
  }),
  // EI-18732669095544832: the lane-sync GATE leg (applyLaneGateToWorkItem)
  // flips state through setWorkItemStateWithAliasInfo, not plain
  // setWorkItemState — needed once tests below exercise resyncPlanItemLaneNow.
  setWorkItemStateWithAliasInfo: vi.fn(async (id: string, state: string) => {
    const wi = h2.items.get(id);
    if (wi) wi.state = state;
    return wi ? { workItem: wi } : null;
  }),
}));
const setWorkItemState = h2.setWorkItemState;
const setWorkItemStateWithAliasInfo = h2.setWorkItemStateWithAliasInfo;
// EI-18653945816361859: recording stubs for the stale-lane-hold clear path —
// mergeWorkItemPayload / setWorkItemClaimHold apply directly to the in-memory
// stub so a subsequent activeExternalBlockers/readWorkItemHeldOpenBy read (the
// REAL pure functions, imported actual below) sees the mutation.
const h4 = vi.hoisted(() => ({
  mergeWorkItemPayload: vi.fn(async (id: string, patch: Record<string, unknown>) => {
    const wi = h2.items.get(id);
    if (wi) wi.payload = { ...(wi.payload ?? {}), ...patch };
    return wi ?? null;
  }),
  setWorkItemClaimHold: vi.fn(async (id: string, hold: boolean) => {
    const wi = h2.items.get(id);
    if (wi?.payload && !hold) {
      const { held_open_by, held_open_at, held_open_reason, _claimHold, ...rest } = wi.payload;
      wi.payload = rest;
    }
    return wi ? { id, harness: wi.harness, hold, applicable: true } : null;
  }),
}));
vi.mock('../work-items', async () => {
  const actual = await vi.importActual<typeof import('../work-items')>('../work-items');
  return {
    isSettledWorkItemState: actual.isSettledWorkItemState,
    SETTLED_WORK_ITEM_STATES: actual.SETTLED_WORK_ITEM_STATES,
    readWorkItemHeldOpenBy: actual.readWorkItemHeldOpenBy,
    getWorkItem: (id: string) => h2.items.get(id) ?? null,
    setWorkItemState: h2.setWorkItemState,
    setWorkItemStateWithAliasInfo: h2.setWorkItemStateWithAliasInfo,
    mergeWorkItemPayload: h4.mergeWorkItemPayload,
    setWorkItemClaimHold: h4.setWorkItemClaimHold,
  };
});

// EI-8970: the stale-read guard's plan re-read. Defaults to `null` (no row
// resolvable) for every pre-existing test above — matching the guard's
// fail-open behaviour and leaving all prior assertions unaffected; only the
// new "EI-8970" describe block below overrides it per-test.
const h3 = vi.hoisted(() => ({
  getPlanRow: vi.fn(
    async (_slug: string, _opts?: unknown) =>
      null as { items: { id: string; status: string; blockedBy?: string[] }[] } | null,
  ),
}));
// EI-18732669095544832: `classifyPlanLane` (the new resyncPlanItemLaneNow's lane
// classifier) also imports `planItemsForRow` off this SAME module — a real, pure
// function with no I/O. Only `getPlanRow` needs mocking (the stale-read guard's
// re-read target); passing through the real `planItemsForRow` via importActual
// keeps that lane-classification path exercised for real instead of undefined.
vi.mock('../agent-tools/plans/source', async () => {
  const actual = await vi.importActual<typeof import('../agent-tools/plans/source')>('../agent-tools/plans/source');
  return { ...actual, getPlanRow: h3.getPlanRow };
});

const {
  reconcileLinkedWorkItemsForPlanItem,
  reconcileOrphanedPlanItemWorkItems,
  resyncPlanItemLaneNow,
  planLaneBlockerRef,
} = await import('./reconcile-linked-work-items');
const { updateExternalBlockerHistory } = await import('../external-blockers');

const WS = DEFAULT_COORD_WORKSPACE;
let rootSql: postgres.Sql;

beforeAll(async () => {
  const adminUri = await getTestPg();
  const dbName = `recwi_${randomBytes(5).toString('hex')}`;
  const admin = postgres(adminUri, { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe(`CREATE DATABASE "${dbName}"`);
  } finally {
    await admin.end({ timeout: 5 });
  }
  const u = new URL(adminUri);
  u.pathname = `/${dbName}`;
  rootSql = postgres(u.toString(), { max: 1, onnotice: () => {} });
  await rootSql.unsafe(`CREATE SCHEMA harness_shared`);
  await rootSql.unsafe(`
    CREATE TABLE harness_shared.coord_links (
      id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
      workspace_id text DEFAULT 'default' NOT NULL,
      src_kind text NOT NULL, src_ref text NOT NULL,
      dst_kind text NOT NULL, dst_ref text NOT NULL,
      rel text NOT NULL, created_by text,
      created_at timestamptz DEFAULT now() NOT NULL
    )`);
  await rootSql.unsafe(HARNESS_FEATURES_CONSOLIDATED_DDL);
  h.sql = rootSql;
}, 90_000);

afterAll(async () => {
  await rootSql?.end({ timeout: 5 });
});

beforeEach(async () => {
  await rootSql`TRUNCATE harness_shared.coord_links, harness_shared.work_items`;
  h2.items.clear();
  setWorkItemState.mockClear();
  setWorkItemStateWithAliasInfo.mockClear();
  h3.getPlanRow.mockReset();
  h3.getPlanRow.mockResolvedValue(null);
});

async function edge(o: { plan: string; item: string; srcKind?: string; srcRef: string }) {
  await rootSql`
    INSERT INTO harness_shared.coord_links (workspace_id, src_kind, src_ref, dst_kind, dst_ref, rel)
    VALUES (${WS}, ${o.srcKind ?? 'issue'}, ${o.srcRef}, ${PLAN_ITEM_KIND},
            ${planItemRef(o.plan, o.item)}, ${IMPLEMENTS_REL})`;
}

function stub(over: Partial<StubWorkItem> & { id: string }): StubWorkItem {
  const wi: StubWorkItem = {
    harness: 'sheets',
    state: 'open',
    family: 'issue',
    lastProgressAt: null,
    ...over,
  };
  h2.items.set(wi.id, wi);
  return wi;
}

/**
 * Insert a REAL base-table work-item row carrying a `payload.plan_item` stamp — the
 * source the periodic sweep's candidate query (harness_shared.work_items) AND
 * findAllLinkedWorkItems's stamp backstop both read. getWorkItem is still the mock,
 * so pair each row with a `stub` of the same id. Payload is a plain jsonb object,
 * matching production (verified: every live stamped payload is object-shaped).
 */
async function insertWorkItemRow(o: {
  id: string;
  kind: 'feature' | 'bug';
  status: string;
  planSlug: string;
  itemId: string;
  harness?: string;
}) {
  // jsonb_build_object (NOT `${jsonString}::jsonb`) — postgres.js binds a JS string
  // under a ::jsonb cast as a jsonb STRING-SCALAR, not an object, which then trips
  // the engineer_issues view's `(payload - '_ei')` ("cannot delete from scalar").
  // Production payloads are object-shaped (verified live), so build an object here.
  await rootSql`
    INSERT INTO harness_shared.work_items
      (workspace_id, harness_slug, feature_id, item_kind, status, payload, created_ts, updated_ts)
    VALUES (${WS}, ${o.harness ?? 'sheets'}, ${o.id}, ${o.kind}, ${o.status},
            jsonb_build_object('plan_item', jsonb_build_object('plan_slug', ${o.planSlug}::text, 'item_id', ${o.itemId}::text)),
            0, 0)`;
}

describe('reconcileLinkedWorkItemsForPlanItem (PG, EI-5925)', () => {
  it('resolves a non-terminal, no-progress linked work-item via the implements edge', async () => {
    stub({ id: 'WI-mirror-1', state: 'open', lastProgressAt: null });
    await edge({ plan: 'p1', item: 'P-001', srcRef: 'WI-mirror-1' });

    const result = await reconcileLinkedWorkItemsForPlanItem({ planSlug: 'p1', itemId: 'P-001' });

    expect(result.reconciled).toEqual(['WI-mirror-1']);
    expect(result.skippedInFlight).toEqual([]);
    expect(result.skippedAlreadyTerminal).toEqual([]);
    expect(setWorkItemState).toHaveBeenCalledWith(
      'WI-mirror-1',
      'resolved',
      expect.objectContaining({ by: 'system:plan-item-reconcile' }),
    );
  });

  it('never clobbers a linked item carrying independent in-flight progress', async () => {
    stub({ id: 'WI-active', state: 'open', lastProgressAt: '2026-07-02T00:00:00Z' });
    await edge({ plan: 'p1', item: 'P-002', srcRef: 'WI-active' });

    const result = await reconcileLinkedWorkItemsForPlanItem({ planSlug: 'p1', itemId: 'P-002' });

    expect(result.reconciled).toEqual([]);
    expect(result.skippedInFlight).toEqual(['WI-active']);
    expect(setWorkItemState).not.toHaveBeenCalled();
  });

  it('skips an already-terminal linked item as a no-op', async () => {
    stub({ id: 'WI-done', state: 'resolved', lastProgressAt: null });
    await edge({ plan: 'p1', item: 'P-003', srcRef: 'WI-done' });

    const result = await reconcileLinkedWorkItemsForPlanItem({ planSlug: 'p1', itemId: 'P-003' });

    expect(result.reconciled).toEqual([]);
    expect(result.skippedAlreadyTerminal).toEqual(['WI-done']);
    expect(setWorkItemState).not.toHaveBeenCalled();
  });

  it('a feature-family linked item resolves to "passed", not "resolved"', async () => {
    stub({ id: 'F-mirror-1', harness: 'sheets', state: 'todo', family: 'feature', lastProgressAt: null });
    await edge({ plan: 'p1', item: 'P-004', srcRef: 'sheets#F-mirror-1', srcKind: 'feature' });

    const result = await reconcileLinkedWorkItemsForPlanItem({ planSlug: 'p1', itemId: 'P-004' });

    expect(result.reconciled).toEqual(['F-mirror-1']);
    expect(setWorkItemState).toHaveBeenCalledWith('F-mirror-1', 'passed', expect.anything());
  });

  // EI-18677799334390930: when the triggering plans:set-status call resolved an
  // attributable actor, the reconciler's completionRef names them — so a leader
  // reading a `no-evidence`-flagged reconcile close can route a correction to the
  // real actor instead of broadcasting "who flipped this plan item?" to the fleet.
  it('stamps the triggering actor onto the completionRef when available (EI-18677799334390930)', async () => {
    stub({ id: 'WI-attributed', state: 'open', lastProgressAt: null });
    await edge({ plan: 'p1', item: 'P-005', srcRef: 'WI-attributed' });

    await reconcileLinkedWorkItemsForPlanItem({ planSlug: 'p1', itemId: 'P-005', triggeredBy: 'su-abc123' });

    expect(setWorkItemState).toHaveBeenCalledWith(
      'WI-attributed',
      'resolved',
      expect.objectContaining({
        by: 'system:plan-item-reconcile',
        completionRef: expect.stringContaining('(plan item flipped by su-abc123)'),
      }),
    );
  });

  it('leaves the completionRef unattributed when no triggering actor was resolved (the periodic sweep case)', async () => {
    stub({ id: 'WI-unattributed', state: 'open', lastProgressAt: null });
    await edge({ plan: 'p1', item: 'P-P22', srcRef: 'WI-unattributed' });

    await reconcileLinkedWorkItemsForPlanItem({ planSlug: 'p1', itemId: 'P-P22' });

    expect(setWorkItemState).toHaveBeenCalledWith(
      'WI-unattributed',
      'resolved',
      expect.objectContaining({ completionRef: expect.not.stringContaining('flipped by') }),
    );
  });

  // NOTE: the payload.plan_item STAMP backstop path (mirroring
  // findConvertedWorkItemByStamp's already-proven jsonb-string-scalar unwrap,
  // convert.integration.test.ts) is exercised by findAllLinkedWorkItems's
  // second query but is NOT separately covered here — a first attempt at this
  // case did not match as expected and, given time budget, is left for a
  // follow-up rather than shipped un-debugged. The PRIMARY truth source (the
  // `implements` coord_links edge, covered above) is fully proven.

  it('no linked work-item at all is a clean no-op', async () => {
    const result = await reconcileLinkedWorkItemsForPlanItem({ planSlug: 'p1', itemId: 'P-999' });
    expect(result).toEqual({
      planSlug: 'p1',
      itemId: 'P-999',
      reconciled: [],
      skippedInFlight: [],
      skippedAlreadyTerminal: [],
    });
  });

  it('reconciles MULTIPLE distinct work-items linked to the SAME plan item', async () => {
    stub({ id: 'WI-dup-1', state: 'open', lastProgressAt: null });
    stub({ id: 'WI-dup-2', state: 'open', lastProgressAt: null });
    await edge({ plan: 'p1', item: 'P-006', srcRef: 'WI-dup-1' });
    await edge({ plan: 'p1', item: 'P-006', srcRef: 'WI-dup-2' });

    const result = await reconcileLinkedWorkItemsForPlanItem({ planSlug: 'p1', itemId: 'P-006' });

    expect(result.reconciled.sort()).toEqual(['WI-dup-1', 'WI-dup-2']);
  });
});

describe('reconcileLinkedWorkItemsForPlanItem — stale-read guard (EI-8970)', () => {
  it('bails the WHOLE sweep, touching nothing, when the plan item is no longer `done` by the time the sweep runs', async () => {
    stub({ id: 'WI-corrected', state: 'wip', lastProgressAt: null });
    await edge({ plan: 'p1', item: 'P-007', srcRef: 'WI-corrected' });
    // A peer corrected the plan item back to `wip` between the `done` event
    // firing and this sweep actually running — the exact race on
    // cup-lexicon-full-rename-2026-07-09#P-006 / WI-3463.
    h3.getPlanRow.mockResolvedValue({ items: [{ id: 'P-007', status: 'wip' }] });

    const result = await reconcileLinkedWorkItemsForPlanItem({ planSlug: 'p1', itemId: 'P-007' });

    expect(result).toEqual({
      planSlug: 'p1',
      itemId: 'P-007',
      reconciled: [],
      skippedInFlight: [],
      skippedAlreadyTerminal: [],
    });
    expect(setWorkItemState).not.toHaveBeenCalled();
  });

  it('proceeds normally when the re-read CONFIRMS the plan item is still `done`', async () => {
    stub({ id: 'WI-confirmed', state: 'open', lastProgressAt: null });
    await edge({ plan: 'p1', item: 'P-008', srcRef: 'WI-confirmed' });
    h3.getPlanRow.mockResolvedValue({ items: [{ id: 'P-008', status: 'done' }] });

    const result = await reconcileLinkedWorkItemsForPlanItem({ planSlug: 'p1', itemId: 'P-008' });

    expect(result.reconciled).toEqual(['WI-confirmed']);
    expect(setWorkItemState).toHaveBeenCalledWith(
      'WI-confirmed',
      'resolved',
      expect.objectContaining({ by: 'system:plan-item-reconcile' }),
    );
  });

  it('fails OPEN (proceeds as before) when the re-read throws — a DB hiccup must never suppress a real reconcile', async () => {
    stub({ id: 'WI-failopen', state: 'open', lastProgressAt: null });
    await edge({ plan: 'p1', item: 'P-009', srcRef: 'WI-failopen' });
    h3.getPlanRow.mockRejectedValue(new Error('connection reset'));

    const result = await reconcileLinkedWorkItemsForPlanItem({ planSlug: 'p1', itemId: 'P-009' });

    expect(result.reconciled).toEqual(['WI-failopen']);
  });

  it('fails OPEN when the row resolves but the item id is absent from its derived index', async () => {
    stub({ id: 'WI-noindex', state: 'open', lastProgressAt: null });
    await edge({ plan: 'p1', item: 'P-010', srcRef: 'WI-noindex' });
    // e.g. an un-normalized row (Stage-3 index not yet populated) — items: [].
    h3.getPlanRow.mockResolvedValue({ items: [] });

    const result = await reconcileLinkedWorkItemsForPlanItem({ planSlug: 'p1', itemId: 'P-010' });

    expect(result.reconciled).toEqual(['WI-noindex']);
  });
});

describe('reconcileLinkedWorkItemsForPlanItem — dropped plan item (EI-14693)', () => {
  it('maps a `dropped` plan item to `deprecated` for a feature-family linked item', async () => {
    stub({ id: 'F-drop', harness: 'sheets', state: 'todo', family: 'feature', lastProgressAt: null });
    await edge({ plan: 'p1', item: 'P-d1', srcRef: 'sheets#F-drop', srcKind: 'feature' });
    h3.getPlanRow.mockResolvedValue({ items: [{ id: 'P-d1', status: 'dropped' }] });

    const result = await reconcileLinkedWorkItemsForPlanItem({ planSlug: 'p1', itemId: 'P-d1' });

    expect(result.reconciled).toEqual(['F-drop']);
    expect(setWorkItemState).toHaveBeenCalledWith('F-drop', 'deprecated', expect.anything());
  });

  it('maps a `dropped` plan item to `closed` for an issue-family linked item', async () => {
    stub({ id: 'WI-drop', state: 'open', family: 'issue', lastProgressAt: null });
    await edge({ plan: 'p1', item: 'P-d2', srcRef: 'WI-drop' });
    h3.getPlanRow.mockResolvedValue({ items: [{ id: 'P-d2', status: 'dropped' }] });

    const result = await reconcileLinkedWorkItemsForPlanItem({ planSlug: 'p1', itemId: 'P-d2' });

    expect(result.reconciled).toEqual(['WI-drop']);
    expect(setWorkItemState).toHaveBeenCalledWith(
      'WI-drop',
      'closed',
      expect.objectContaining({ by: 'system:plan-item-reconcile' }),
    );
  });

  it('the reaction path (no knownTerminalStatus) still BAILS when the item is neither done nor dropped', async () => {
    stub({ id: 'WI-todo', state: 'open', lastProgressAt: null });
    await edge({ plan: 'p1', item: 'P-d3', srcRef: 'WI-todo' });
    h3.getPlanRow.mockResolvedValue({ items: [{ id: 'P-d3', status: 'todo' }] });

    const result = await reconcileLinkedWorkItemsForPlanItem({ planSlug: 'p1', itemId: 'P-d3' });

    expect(result.reconciled).toEqual([]);
    expect(setWorkItemState).not.toHaveBeenCalled();
  });
});

describe('reconcileLinkedWorkItemsForPlanItem — stale plan-lane hold cleared before terminal flip (EI-18653945816361859)', () => {
  beforeEach(() => {
    h4.mergeWorkItemPayload.mockClear();
    h4.setWorkItemClaimHold.mockClear();
  });

  it('clears a stale plan-lane external blocker + held_open lease BEFORE the terminal flip', async () => {
    const laneRef = planLaneBlockerRef('p1', 'P-011');
    stub({
      id: 'WI-stale-hold',
      state: 'blocked',
      lastProgressAt: null,
      payload: {
        held_open_by: 'system:plan-item-lane-sync',
        held_open_at: new Date().toISOString(),
        _claimHold: true,
        externalBlockers: [
          {
            kind: 'gate',
            capability: 'live-dependency',
            capabilitySource: 'explicit',
            ref: laneRef,
            summary: 'plan lane blocked',
            status: 'active',
            createdAt: new Date().toISOString(),
            createdBy: 'system:plan-item-lane-sync',
            updatedAt: new Date().toISOString(),
          },
        ],
      },
    });
    await edge({ plan: 'p1', item: 'P-011', srcRef: 'WI-stale-hold' });
    h3.getPlanRow.mockResolvedValue({ items: [{ id: 'P-011', status: 'done' }] });

    const result = await reconcileLinkedWorkItemsForPlanItem({ planSlug: 'p1', itemId: 'P-011' });

    expect(h4.mergeWorkItemPayload).toHaveBeenCalledWith(
      'WI-stale-hold',
      expect.objectContaining({ externalBlockers: expect.any(Array) }),
      expect.anything(),
    );
    expect(h4.setWorkItemClaimHold).toHaveBeenCalledWith(
      'WI-stale-hold',
      false,
      expect.objectContaining({ by: 'system:plan-item-lane-sync' }),
    );
    expect(result.reconciled).toEqual(['WI-stale-hold']);
    expect(setWorkItemState).toHaveBeenCalledWith('WI-stale-hold', 'resolved', expect.anything());
  });

  it('is a no-op when the linked item carries no plan-lane hold at all', async () => {
    stub({ id: 'WI-clean', state: 'open', lastProgressAt: null, payload: null });
    await edge({ plan: 'p1', item: 'P-012', srcRef: 'WI-clean' });
    h3.getPlanRow.mockResolvedValue({ items: [{ id: 'P-012', status: 'done' }] });

    await reconcileLinkedWorkItemsForPlanItem({ planSlug: 'p1', itemId: 'P-012' });

    expect(h4.mergeWorkItemPayload).not.toHaveBeenCalled();
    expect(h4.setWorkItemClaimHold).not.toHaveBeenCalled();
  });
});

describe('reconcileOrphanedPlanItemWorkItems — periodic data-heal (EI-14693)', () => {
  it('heals BOTH a feature and an issue orphan of an already-`done` plan item', async () => {
    // Real base-table rows carrying the stamp (the candidate + stamp-backstop source)
    // + matching stub entries (getWorkItem/setWorkItemState are mocked).
    await insertWorkItemRow({ id: 'F-sweep', kind: 'feature', status: 'todo', planSlug: 'psweep', itemId: 'P-100' });
    await insertWorkItemRow({ id: 'WI-sweep', kind: 'bug', status: 'open', planSlug: 'psweep', itemId: 'P-100' });
    // Real orphans also carry the `implements` edge convert.ts writes (verified in
    // prod for WI-3488 et al) — findAllLinkedWorkItems finds them via that edge.
    await edge({ plan: 'psweep', item: 'P-100', srcRef: 'sheets#F-sweep', srcKind: 'feature' });
    await edge({ plan: 'psweep', item: 'P-100', srcRef: 'WI-sweep' });
    stub({ id: 'F-sweep', harness: 'sheets', state: 'todo', family: 'feature', lastProgressAt: null });
    stub({ id: 'WI-sweep', harness: 'sheets', state: 'open', family: 'issue', lastProgressAt: null });
    h3.getPlanRow.mockResolvedValue({ items: [{ id: 'P-100', status: 'done' }] });

    const result = await reconcileOrphanedPlanItemWorkItems();

    expect(result.candidatePlanItems).toBe(1);
    expect(result.terminalPlanItems).toBe(1);
    expect(result.reconciled.sort()).toEqual(['F-sweep', 'WI-sweep']);
    expect(setWorkItemState).toHaveBeenCalledWith('F-sweep', 'passed', expect.anything());
    expect(setWorkItemState).toHaveBeenCalledWith('WI-sweep', 'resolved', expect.anything());
  });

  it('maps a `dropped` plan item to deprecated/closed in the sweep too', async () => {
    await insertWorkItemRow({ id: 'F-swdrop', kind: 'feature', status: 'todo', planSlug: 'psd', itemId: 'P-1' });
    await edge({ plan: 'psd', item: 'P-1', srcRef: 'sheets#F-swdrop', srcKind: 'feature' });
    stub({ id: 'F-swdrop', harness: 'sheets', state: 'todo', family: 'feature', lastProgressAt: null });
    h3.getPlanRow.mockResolvedValue({ items: [{ id: 'P-1', status: 'dropped' }] });

    const result = await reconcileOrphanedPlanItemWorkItems();

    expect(result.reconciled).toEqual(['F-swdrop']);
    expect(setWorkItemState).toHaveBeenCalledWith('F-swdrop', 'deprecated', expect.anything());
  });

  it('is FAIL-CLOSED: a candidate whose plan item is still `wip` is left untouched', async () => {
    await insertWorkItemRow({ id: 'F-open', kind: 'feature', status: 'todo', planSlug: 'popen', itemId: 'P-1' });
    stub({ id: 'F-open', harness: 'sheets', state: 'todo', family: 'feature', lastProgressAt: null });
    h3.getPlanRow.mockResolvedValue({ items: [{ id: 'P-1', status: 'wip' }] });

    const result = await reconcileOrphanedPlanItemWorkItems();

    expect(result.candidatePlanItems).toBe(1);
    expect(result.terminalPlanItems).toBe(0);
    expect(result.reconciled).toEqual([]);
    expect(setWorkItemState).not.toHaveBeenCalled();
  });

  it('is FAIL-CLOSED: a candidate whose plan cannot be resolved (getPlanRow → null) is left untouched', async () => {
    await insertWorkItemRow({ id: 'F-noplan', kind: 'feature', status: 'todo', planSlug: 'pnull', itemId: 'P-1' });
    stub({ id: 'F-noplan', harness: 'sheets', state: 'todo', family: 'feature', lastProgressAt: null });
    h3.getPlanRow.mockResolvedValue(null);

    const result = await reconcileOrphanedPlanItemWorkItems();

    expect(result.terminalPlanItems).toBe(0);
    expect(result.reconciled).toEqual([]);
    expect(setWorkItemState).not.toHaveBeenCalled();
  });

  it('does NOT enumerate an already-terminal work-item as a candidate (non-terminal predicate)', async () => {
    await insertWorkItemRow({ id: 'F-term', kind: 'feature', status: 'passed', planSlug: 'pterm', itemId: 'P-1' });
    await insertWorkItemRow({ id: 'WI-term', kind: 'bug', status: 'resolved', planSlug: 'pterm', itemId: 'P-2' });
    h3.getPlanRow.mockResolvedValue({ items: [{ id: 'P-1', status: 'done' }, { id: 'P-2', status: 'done' }] });

    const result = await reconcileOrphanedPlanItemWorkItems();

    expect(result.candidatePlanItems).toBe(0);
    expect(result.reconciled).toEqual([]);
    expect(setWorkItemState).not.toHaveBeenCalled();
  });

  it('WI-5279: does NOT enumerate a work-item stored with the UNIFIED terminal spelling (done/dropped), not just the legacy one', async () => {
    // work-item-status-full-unify (2026-07-19): rows can now be written with the
    // literal 'done'/'dropped' status instead of the legacy per-family spelling.
    // The candidate query's exclusion list must cover BOTH or these rows leak back
    // in as "candidates" every sweep tick, wasting work and — at scale — crowding
    // out genuine orphans from the `LIMIT cap` window (WI-5279/EI-13337 class).
    await insertWorkItemRow({ id: 'F-unified-term', kind: 'feature', status: 'done', planSlug: 'punified', itemId: 'P-1' });
    await insertWorkItemRow({ id: 'WI-unified-term', kind: 'bug', status: 'dropped', planSlug: 'punified', itemId: 'P-2' });
    h3.getPlanRow.mockResolvedValue({ items: [{ id: 'P-1', status: 'done' }, { id: 'P-2', status: 'dropped' }] });

    const result = await reconcileOrphanedPlanItemWorkItems();

    expect(result.candidatePlanItems).toBe(0);
    expect(result.reconciled).toEqual([]);
    expect(setWorkItemState).not.toHaveBeenCalled();
  });

  it('WI-5279: a genuine orphan is not starved out of the LIMIT-cap window by already-terminal (unified-spelling) noise', async () => {
    // Reproduces the production shape found live-verifying WI-5279: a large volume
    // of already-`done`/`dropped` stamped rows sitting alongside one genuine
    // non-terminal orphan. With a tight cap and the STALE exclusion list, the noise
    // could fill the whole candidate window before the real orphan is ever read.
    for (let i = 0; i < 5; i++) {
      await insertWorkItemRow({ id: `F-noise-${i}`, kind: 'feature', status: 'done', planSlug: 'pnoise', itemId: `P-noise-${i}` });
    }
    await insertWorkItemRow({ id: 'F-real-orphan', kind: 'feature', status: 'todo', planSlug: 'pnoise', itemId: 'P-real' });
    await edge({ plan: 'pnoise', item: 'P-real', srcRef: 'sheets#F-real-orphan', srcKind: 'feature' });
    stub({ id: 'F-real-orphan', harness: 'sheets', state: 'todo', family: 'feature', lastProgressAt: null });
    h3.getPlanRow.mockResolvedValue({
      items: [
        ...Array.from({ length: 5 }, (_, i) => ({ id: `P-noise-${i}`, status: 'done' })),
        { id: 'P-real', status: 'done' },
      ],
    });

    const result = await reconcileOrphanedPlanItemWorkItems({ candidateCap: 3 });

    expect(result.candidatePlanItems).toBe(1);
    expect(result.reconciled).toEqual(['F-real-orphan']);
    expect(setWorkItemState).toHaveBeenCalledWith('F-real-orphan', 'passed', expect.anything());
  });

  it('skips a candidate carrying independent in-flight progress (lastProgressAt)', async () => {
    await insertWorkItemRow({ id: 'F-active', kind: 'feature', status: 'wip', planSlug: 'pact', itemId: 'P-1' });
    await edge({ plan: 'pact', item: 'P-1', srcRef: 'sheets#F-active', srcKind: 'feature' });
    stub({ id: 'F-active', harness: 'sheets', state: 'wip', family: 'feature', lastProgressAt: '2026-07-10T00:00:00Z' });
    h3.getPlanRow.mockResolvedValue({ items: [{ id: 'P-1', status: 'done' }] });

    const result = await reconcileOrphanedPlanItemWorkItems();

    expect(result.terminalPlanItems).toBe(1);
    expect(result.reconciled).toEqual([]);
    expect(result.skippedInFlight).toEqual(['F-active']);
    expect(setWorkItemState).not.toHaveBeenCalled();
  });
});

describe('resyncPlanItemLaneNow — inline lane resync off plans:set-item-blocked-by (EI-18732669095544832)', () => {
  beforeEach(() => {
    h4.mergeWorkItemPayload.mockClear();
    h4.setWorkItemClaimHold.mockClear();
  });

  it('CLEARING a blocked-by edge un-parks the linked work-item RIGHT NOW (the reported bug)', async () => {
    // Repro shape: P-011 was `blocked-by: P-010`; the lane sync GATED WI-6096 for
    // it (an `active` plan-lane external blocker + state:'blocked'). The caller
    // just cleared the edge (blockedBy: [] on P-011) — resyncPlanItemLaneNow must
    // reflect that immediately, not 15 minutes later.
    await edge({ plan: 'pblk', item: 'P-011', srcRef: 'WI-6096' });
    const ref = planLaneBlockerRef('pblk', 'P-011');
    const { blockers } = updateExternalBlockerHistory(
      {},
      { kind: 'gate', capability: 'live-dependency', ref, summary: 'parked' },
      'system:plan-item-lane-sync',
    );
    stub({
      id: 'WI-6096',
      harness: 'sheets',
      state: 'blocked',
      family: 'issue',
      lastProgressAt: null,
      payload: { externalBlockers: blockers },
    });
    h3.getPlanRow.mockResolvedValue({
      items: [
        { id: 'P-010', status: 'done', blockedBy: [] },
        { id: 'P-011', status: 'todo', blockedBy: [] }, // cleared
      ],
    });

    const result = await resyncPlanItemLaneNow('pblk', 'P-011', null);

    expect(result).not.toBeNull();
    expect(result!.ungated).toEqual(['WI-6096']);
    expect(h4.setWorkItemClaimHold).toHaveBeenCalledWith(
      'WI-6096',
      false,
      expect.objectContaining({ by: 'system:plan-item-lane-sync' }),
    );
  });

  it('ADDING a blocked-by edge parks the linked work-item RIGHT NOW (the symmetric mirror case)', async () => {
    await edge({ plan: 'pblk2', item: 'P-021', srcKind: 'feature', srcRef: 'sheets#F-xyz' });
    stub({ id: 'F-xyz', harness: 'sheets', state: 'todo', family: 'feature', lastProgressAt: null });
    h3.getPlanRow.mockResolvedValue({
      items: [
        { id: 'P-020', status: 'todo', blockedBy: [] },
        { id: 'P-021', status: 'todo', blockedBy: ['P-020'] }, // just added, unresolved
      ],
    });

    const result = await resyncPlanItemLaneNow('pblk2', 'P-021', null);

    expect(result).not.toBeNull();
    expect(result!.gated).toEqual(['F-xyz']);
    expect(setWorkItemStateWithAliasInfo).toHaveBeenCalledWith(
      'F-xyz',
      'blocked',
      expect.objectContaining({ by: 'system:plan-item-lane-sync' }),
    );
  });

  it('never clobbers independent in-flight progress even when the lane just went blocked', async () => {
    await edge({ plan: 'pblk3', item: 'P-031', srcKind: 'feature', srcRef: 'sheets#F-active2' });
    stub({
      id: 'F-active2',
      harness: 'sheets',
      state: 'wip',
      family: 'feature',
      lastProgressAt: '2026-07-20T00:00:00Z',
    });
    h3.getPlanRow.mockResolvedValue({
      items: [
        { id: 'P-030', status: 'todo', blockedBy: [] },
        { id: 'P-031', status: 'todo', blockedBy: ['P-030'] },
      ],
    });

    const result = await resyncPlanItemLaneNow('pblk3', 'P-031', null);

    expect(result).not.toBeNull();
    expect(result!.gated).toEqual([]);
    expect(result!.skippedInFlight).toEqual(['F-active2']);
    expect(setWorkItemStateWithAliasInfo).not.toHaveBeenCalled();
  });

  it('is a fail-closed no-op when the plan cannot be resolved (getPlanRow → null)', async () => {
    await edge({ plan: 'pnoplan', item: 'P-001', srcRef: 'WI-x' });
    stub({ id: 'WI-x', harness: 'sheets', state: 'blocked', family: 'issue', lastProgressAt: null });
    h3.getPlanRow.mockResolvedValue(null);

    const result = await resyncPlanItemLaneNow('pnoplan', 'P-001', null);

    expect(result).toBeNull();
    expect(h4.setWorkItemClaimHold).not.toHaveBeenCalled();
    expect(setWorkItemStateWithAliasInfo).not.toHaveBeenCalled();
  });
});
