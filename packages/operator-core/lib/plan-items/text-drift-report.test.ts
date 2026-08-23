/**
 * text-drift-report.test.ts — the IMPURE halves of plan-item text drift
 * (WI-40825 / EI-21218726167520963). The pure comparison core is covered by
 * ./text-drift.test.ts; this file covers the two halves that talk to the world:
 * the post-write PUSH (`reportPlanItemTextDrift`) and the read-side PULL
 * (`planItemTextDriftForWorkItem`).
 *
 * WHAT THESE TESTS ARE REALLY DEFENDING. Three of the properties below are the
 * ones whose failure modes are SILENT — they produce a plausible-looking result
 * rather than an error, which is exactly the class this whole feature exists to
 * close:
 *
 *   1. DUAL LINKAGE (EI-13738). A work-item reaches its plan item through EITHER
 *      `payload.plan_item` (plan_items:convert) OR the `source_plan_slug` /
 *      `source_plan_item_ids` columns (plans:start -> promote.ts, the path that
 *      actually runs in production). Resolving only one mechanism yields an empty
 *      report — indistinguishable from "nobody is working on this item" at
 *      precisely the moment a whole fleet is. So there is a test per mechanism
 *      AND a test that a row matching BOTH is reported once, not twice.
 *   2. `unknown` IS NOT `match`. A pre-stamp record must resolve to `unknown`,
 *      never to a clean bill of health.
 *   3. CALIBRATION. Several tests assert that untouched items produce NOTHING,
 *      so a detector that simply returned everything it found could not pass.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const sqlMock = vi.fn();
const notifyAgentsMock = vi.fn();
const resolvePlanItemStampMock = vi.fn();
const getPlanRowMock = vi.fn();
const planItemsForRowMock = vi.fn();

// Every mock below is PARTIAL. These modules sit in a large shared graph and
// other modules in it import exports this file never touches; replacing a module
// wholesale breaks collection with a "no export is defined on the mock" error
// that has nothing to do with the code under test.
vi.mock('@papercusp/db-org', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getOrgPg: () => ({ sql: sqlMock }),
}));

vi.mock('../agent-tools/coordination/notify-agents', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  notifyAgents: (...args: unknown[]) => notifyAgentsMock(...args),
}));

vi.mock('../agent-tools/coordination/identity', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resolveAgentIdentity: () => IDENTITY,
}));

vi.mock('../scheduler/plan-item-lane-guard', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resolvePlanItemStamp: (...args: unknown[]) => resolvePlanItemStampMock(...args),
}));

vi.mock('../agent-tools/plans/source', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getPlanRow: (...args: unknown[]) => getPlanRowMock(...args),
  planItemsForRow: (...args: unknown[]) => planItemsForRowMock(...args),
}));

import { planItemTextHash, type PlanItemTextChange } from './text-drift';
import {
  MAX_DRIFT_NOTIFICATIONS,
  planItemTextDriftForWorkItem,
  planItemTextDriftForWrite,
  reportPlanItemTextDrift,
} from './text-drift-report';

const IDENTITY = {
  ownerId: 'su-editor',
  workspaceId: 'ws-test',
} as unknown as Parameters<typeof reportPlanItemTextDrift>[0]['identity'];

interface StampRowFixture {
  feature_id: string;
  harness_slug: string | null;
  title: string | null;
  status: string | null;
  taken_by: string | null;
  item_id: string | null;
}
interface ColumnRowFixture {
  feature_id: string;
  harness_slug: string | null;
  title: string | null;
  status: string | null;
  taken_by: string | null;
  source_plan_item_ids: string[] | null;
}

/**
 * Route the two lookups by their SQL text. The production code fires both in one
 * `Promise.all`, so the mock has to tell them apart the same way a reader does —
 * by which linkage column each names.
 */
function primeQueries(opts: { stamp?: StampRowFixture[]; column?: ColumnRowFixture[] }): void {
  sqlMock.mockImplementation((strings: TemplateStringsArray) => {
    const text = strings.join(' ');
    if (text.includes("payload->'plan_item'")) return Promise.resolve(opts.stamp ?? []);
    if (text.includes('source_plan_slug')) return Promise.resolve(opts.column ?? []);
    throw new Error(`unexpected query: ${text.slice(0, 80)}`);
  });
}

function stampRow(over: Partial<StampRowFixture> = {}): StampRowFixture {
  return {
    feature_id: 'WI-1',
    harness_slug: 'papercusp',
    title: 'old wording',
    status: 'wip',
    taken_by: 'su-holder',
    item_id: 'P-001',
    ...over,
  };
}
function columnRow(over: Partial<ColumnRowFixture> = {}): ColumnRowFixture {
  return {
    feature_id: 'WI-2',
    harness_slug: 'papercusp',
    title: 'old wording',
    status: 'wip',
    taken_by: 'su-holder-2',
    source_plan_item_ids: ['P-001'],
    ...over,
  };
}

const CHANGED: PlanItemTextChange = {
  id: 'P-001',
  kind: 'changed',
  before: 'build the thing',
  after: 'build a completely different thing',
};

beforeEach(() => {
  vi.clearAllMocks();
  notifyAgentsMock.mockResolvedValue({ notified: ['su-holder'], subscribed: [], woke: 0 });
});

describe('reportPlanItemTextDrift — the post-write push', () => {
  it('stays silent, and touches no database, when the write changed no item text', async () => {
    primeQueries({});
    const res = await reportPlanItemTextDrift({
      planSlug: 'my-plan',
      changes: [],
      identity: IDENTITY,
    });
    expect(res).toBeNull();
    expect(sqlMock).not.toHaveBeenCalled();
  });

  it('stays silent when nothing open was minted from the changed items', async () => {
    primeQueries({ stamp: [], column: [] });
    const res = await reportPlanItemTextDrift({
      planSlug: 'my-plan',
      changes: [CHANGED],
      identity: IDENTITY,
    });
    expect(res).toBeNull();
    expect(notifyAgentsMock).not.toHaveBeenCalled();
  });

  it('reports a payload-stamp-linked work-item and pings its holder', async () => {
    primeQueries({ stamp: [stampRow()], column: [] });
    const res = await reportPlanItemTextDrift({
      planSlug: 'my-plan',
      changes: [CHANGED],
      identity: IDENTITY,
    });
    expect(res?.affected).toEqual([
      {
        workItemId: 'WI-1',
        itemId: 'P-001',
        kind: 'changed',
        title: 'old wording',
        state: 'wip',
        holder: 'su-holder',
      },
    ]);
    expect(res?.notified).toBe(1);
    expect(notifyAgentsMock).toHaveBeenCalledTimes(1);
    const opts = notifyAgentsMock.mock.calls[0]![1] as { addressees: string[]; body: string; wake: boolean };
    expect(opts.addressees).toEqual(['su-holder']);
    // The ping must carry the NEW text — a warning that does not say what changed
    // just sends the holder back to guess.
    expect(opts.body).toContain('build a completely different thing');
    // An inbox inject, never a turn-stealing wake.
    expect(opts.wake).toBe(false);
  });

  it('reports a COLUMN-linked work-item too — the plans:start path carries no payload stamp (EI-13738)', async () => {
    primeQueries({ stamp: [], column: [columnRow()] });
    const res = await reportPlanItemTextDrift({
      planSlug: 'my-plan',
      changes: [CHANGED],
      identity: IDENTITY,
    });
    expect(res?.affected.map((a) => a.workItemId)).toEqual(['WI-2']);
    expect(notifyAgentsMock).toHaveBeenCalledTimes(1);
  });

  it('reports a row matching BOTH linkage mechanisms exactly once, and pings its holder once', async () => {
    // The same work-item, reachable both ways — the dedupe this asserts is what
    // keeps a holder from being pinged twice for one edit.
    primeQueries({
      stamp: [stampRow({ feature_id: 'WI-DUAL' })],
      column: [columnRow({ feature_id: 'WI-DUAL' })],
    });
    const res = await reportPlanItemTextDrift({
      planSlug: 'my-plan',
      changes: [CHANGED],
      identity: IDENTITY,
    });
    expect(res?.affected).toHaveLength(1);
    expect(res?.affected[0]!.workItemId).toBe('WI-DUAL');
    expect(notifyAgentsMock).toHaveBeenCalledTimes(1);
  });

  it('reports only the items THIS write touched when a work-item implements several', async () => {
    // CALIBRATION: P-002 and P-003 are linked to the same work-item but were not
    // changed, so a detector that reported everything it found would fail here.
    primeQueries({
      stamp: [],
      column: [columnRow({ source_plan_item_ids: ['P-001', 'P-002', 'P-003'] })],
    });
    const res = await reportPlanItemTextDrift({
      planSlug: 'my-plan',
      changes: [CHANGED],
      identity: IDENTITY,
    });
    expect(res?.affected.map((a) => a.itemId)).toEqual(['P-001']);
  });

  it('reports an unclaimed work-item to the editor but notifies nobody, and says so', async () => {
    primeQueries({ stamp: [stampRow({ taken_by: null })], column: [] });
    const res = await reportPlanItemTextDrift({
      planSlug: 'my-plan',
      changes: [CHANGED],
      identity: IDENTITY,
    });
    expect(res?.affected).toHaveLength(1);
    expect(res?.notified).toBe(0);
    expect(notifyAgentsMock).not.toHaveBeenCalled();
    expect(res?.warning).toContain('No holder was notified');
  });

  it('distinguishes a REMOVED item from a rewritten one, in both the ping and the warning', async () => {
    primeQueries({ stamp: [stampRow()], column: [] });
    const res = await reportPlanItemTextDrift({
      planSlug: 'my-plan',
      changes: [{ id: 'P-001', kind: 'removed', before: 'build the thing' }],
      identity: IDENTITY,
    });
    expect(res?.affected[0]!.kind).toBe('removed');
    expect(res?.warning).toContain('REMOVED');
    const opts = notifyAgentsMock.mock.calls[0]![1] as { body: string; summary: string };
    expect(opts.body).toContain('REMOVED from the plan');
    expect(opts.summary).toContain('was removed from the plan');
  });

  it('caps the fan-out at MAX_DRIFT_NOTIFICATIONS but still reports every affected item', async () => {
    const many = Array.from({ length: MAX_DRIFT_NOTIFICATIONS + 4 }, (_, i) =>
      stampRow({ feature_id: `WI-${i}`, item_id: `P-${i}`, taken_by: `su-holder-${i}` }),
    );
    const changes: PlanItemTextChange[] = many.map((r) => ({
      id: r.item_id!,
      kind: 'changed',
      before: 'old',
      after: 'new',
    }));
    primeQueries({ stamp: many, column: [] });
    const res = await reportPlanItemTextDrift({
      planSlug: 'my-plan',
      changes,
      identity: IDENTITY,
    });
    expect(res?.affected).toHaveLength(MAX_DRIFT_NOTIFICATIONS + 4);
    expect(notifyAgentsMock).toHaveBeenCalledTimes(MAX_DRIFT_NOTIFICATIONS);
  });

  it('computes the report without sending anything when notify is false', async () => {
    primeQueries({ stamp: [stampRow()], column: [] });
    const res = await reportPlanItemTextDrift({
      planSlug: 'my-plan',
      changes: [CHANGED],
      identity: IDENTITY,
      notify: false,
    });
    expect(res?.affected).toHaveLength(1);
    expect(res?.notified).toBe(0);
    expect(notifyAgentsMock).not.toHaveBeenCalled();
  });

  it('fails soft when the lookup throws — the plan write already committed', async () => {
    sqlMock.mockImplementation(() => {
      throw new Error('pg is down');
    });
    await expect(
      reportPlanItemTextDrift({ planSlug: 'my-plan', changes: [CHANGED], identity: IDENTITY }),
    ).resolves.toBeNull();
  });

  it('fails soft when a holder notification throws, still returning the report', async () => {
    primeQueries({ stamp: [stampRow()], column: [] });
    notifyAgentsMock.mockRejectedValue(new Error('coord is down'));
    const res = await reportPlanItemTextDrift({
      planSlug: 'my-plan',
      changes: [CHANGED],
      identity: IDENTITY,
    });
    expect(res?.affected).toHaveLength(1);
    expect(res?.notified).toBe(0);
  });
});

describe('planItemTextDriftForWrite — the handler one-liner', () => {
  it('is a no-op for an undefined or empty change list', async () => {
    await expect(planItemTextDriftForWrite({} as never, 'my-plan', undefined)).resolves.toBeNull();
    await expect(planItemTextDriftForWrite({} as never, 'my-plan', [])).resolves.toBeNull();
    expect(sqlMock).not.toHaveBeenCalled();
  });

  it('swallows every failure, because it runs after the write has committed', async () => {
    sqlMock.mockImplementation(() => {
      throw new Error('pg is down');
    });
    await expect(
      planItemTextDriftForWrite({} as never, 'my-plan', [CHANGED], 'papercusp'),
    ).resolves.toBeNull();
  });
});

describe('planItemTextDriftForWorkItem — the read-side pull', () => {
  const CURRENT = 'build a completely different thing';

  function primePlan(items: Array<{ id: string; text: string }>): void {
    getPlanRowMock.mockResolvedValue({ slug: 'my-plan' });
    planItemsForRowMock.mockReturnValue(items);
  }

  it('is silent for an ordinary unplanned work-item with no linkage', async () => {
    resolvePlanItemStampMock.mockResolvedValue(null);
    const res = await planItemTextDriftForWorkItem({ payload: null, harness: 'papercusp' });
    expect(res).toBeNull();
  });

  it('is silent for a finished work-item — drift on a closed record is history', async () => {
    const res = await planItemTextDriftForWorkItem({
      payload: null,
      harness: 'papercusp',
      state: 'done',
    });
    expect(res).toBeNull();
    // The terminal check must short-circuit BEFORE any lookup.
    expect(resolvePlanItemStampMock).not.toHaveBeenCalled();
  });

  it('reports drifted when the live text no longer matches the mint-time hash', async () => {
    resolvePlanItemStampMock.mockResolvedValue({ plan_slug: 'my-plan', item_ids: ['P-001'] });
    primePlan([{ id: 'P-001', text: CURRENT }]);
    const res = await planItemTextDriftForWorkItem({
      payload: { plan_item: { item_text_hash: planItemTextHash('build the thing') } },
      harness: 'papercusp',
      state: 'wip',
    });
    expect(res?.status).toBe('drifted');
    expect(res?.planSlug).toBe('my-plan');
    expect(res?.itemId).toBe('P-001');
    expect(res?.currentText).toBe(CURRENT);
  });

  it('stays silent when the item still reads exactly as it did at mint', async () => {
    // CALIBRATION for the test above: same machinery, matching hash, no report.
    resolvePlanItemStampMock.mockResolvedValue({ plan_slug: 'my-plan', item_ids: ['P-001'] });
    primePlan([{ id: 'P-001', text: CURRENT }]);
    const res = await planItemTextDriftForWorkItem({
      payload: { plan_item: { item_text_hash: planItemTextHash(CURRENT) } },
      harness: 'papercusp',
      state: 'wip',
    });
    expect(res).toBeNull();
  });

  it('ignores a pure whitespace reflow — rewrapping a plan body is not a re-specification', async () => {
    resolvePlanItemStampMock.mockResolvedValue({ plan_slug: 'my-plan', item_ids: ['P-001'] });
    primePlan([{ id: 'P-001', text: 'build   the\n  thing' }]);
    const res = await planItemTextDriftForWorkItem({
      payload: { plan_item: { item_text_hash: planItemTextHash('build the thing') } },
      harness: 'papercusp',
      state: 'wip',
    });
    expect(res).toBeNull();
  });

  it('reports UNKNOWN — never a clean match — for a record minted before the stamp existed', async () => {
    // This is the false-absence guard. A column-linked (plans:start) work-item
    // carries no payload hash at all, and reporting that as "no drift" would be
    // the exact silent-wrong-answer this feature exists to prevent.
    resolvePlanItemStampMock.mockResolvedValue({ plan_slug: 'my-plan', item_ids: ['P-001'] });
    primePlan([{ id: 'P-001', text: CURRENT }]);
    const res = await planItemTextDriftForWorkItem({
      payload: { plan_item: { plan_slug: 'my-plan', item_id: 'P-001' } },
      harness: 'papercusp',
      state: 'wip',
    });
    expect(res?.status).toBe('unknown');
    expect(res?.status).not.toBe('match');
  });

  it('reports drifted with itemMissing when the plan no longer carries the item', async () => {
    resolvePlanItemStampMock.mockResolvedValue({ plan_slug: 'my-plan', item_ids: ['P-009'] });
    primePlan([{ id: 'P-001', text: CURRENT }]);
    const res = await planItemTextDriftForWorkItem({
      payload: { plan_item: { item_text_hash: planItemTextHash('build the thing') } },
      harness: 'papercusp',
      state: 'wip',
    });
    expect(res?.status).toBe('drifted');
    expect(res?.itemMissing).toBe(true);
  });

  it('surfaces the drifted item, not the clean one, when a work-item implements several', async () => {
    // The stamped hash matches P-001 exactly, so P-001 resolves `match` and only
    // P-002 has actually moved. A single actionable verdict beats a list, so the
    // resolver must skip past the clean item rather than stopping at the first.
    resolvePlanItemStampMock.mockResolvedValue({ plan_slug: 'my-plan', item_ids: ['P-001', 'P-002'] });
    primePlan([
      { id: 'P-001', text: CURRENT },
      { id: 'P-002', text: 'something else entirely' },
    ]);
    const res = await planItemTextDriftForWorkItem({
      payload: { plan_item: { item_text_hash: planItemTextHash(CURRENT) } },
      harness: 'papercusp',
      state: 'wip',
    });
    expect(res?.status).toBe('drifted');
    expect(res?.itemId).toBe('P-002');
  });

  it('fails soft when the plan lookup throws — a plans hiccup must not break a work-item read', async () => {
    resolvePlanItemStampMock.mockResolvedValue({ plan_slug: 'my-plan', item_ids: ['P-001'] });
    getPlanRowMock.mockRejectedValue(new Error('plans is down'));
    const res = await planItemTextDriftForWorkItem({
      payload: { plan_item: { item_text_hash: 'abc' } },
      harness: 'papercusp',
      state: 'wip',
    });
    expect(res).toBeNull();
  });

  it('is silent when the plan itself has vanished', async () => {
    resolvePlanItemStampMock.mockResolvedValue({ plan_slug: 'my-plan', item_ids: ['P-001'] });
    getPlanRowMock.mockResolvedValue(null);
    const res = await planItemTextDriftForWorkItem({
      payload: { plan_item: { item_text_hash: 'abc' } },
      harness: 'papercusp',
      state: 'wip',
    });
    expect(res).toBeNull();
  });
});
