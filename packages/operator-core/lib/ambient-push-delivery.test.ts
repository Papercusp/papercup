/**
 * ambient-push-delivery.test.ts — the P-003 delivery-rail composition
 * (ambient-semantic-push-2026-07-14): renderPushBlock purity, the injection-door
 * cap, and prepareAmbientPushBlock's select→tally→render pipeline against a MOCKED
 * store (no PG — the end-to-end-vs-real-PG proof is the integration test).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  renderPushBlock,
  applyPushInjectionDoor,
  rowToPushObject,
  pushInjectionDoorTokens,
  reportVolumeViolations,
} from './ambient-push-delivery';
import { makePush, type DropReason } from './ambient-push';
import type { PushDeliveryRow } from './push-delivery-store';
import type { VolumeReport } from './push-volume-guard';

const row = (over: Partial<PushDeliveryRow> = {}): PushDeliveryRow => ({
  id: 1,
  target_owner_id: 'su-recv',
  target_session_id: null,
  workspace_id: 'default',
  matcher_kind: 'collision',
  severity: 'critical',
  handle_kind: 'session',
  handle_ref: 'su-peer',
  handle_query: ['foo', 'bar'],
  teaser: 'peer su-peer converging — shared: foo, bar',
  score: 0.8,
  source_session_id: 'su-peer',
  status: 'queued',
  drop_reason: null,
  enqueued_at: '2026-07-14T10:00:00Z',
  delivered_at: null,
  pulled_at: null,
  acted_at: null,
  ...over,
});

describe('renderPushBlock (pure)', () => {
  it('renders a data-not-directive header + one legible line per push, with the pull handle', () => {
    const block = renderPushBlock([
      makePush({ matcherKind: 'collision', handle: { kind: 'session', ref: 'su-x', query: ['auth', 'jwt'] }, teaser: 'peer converging', score: 0.9 }),
      makePush({ matcherKind: 'dead-end', handle: { kind: 'fact', ref: 'D-015', query: ['retry'] }, teaser: 'documented dead-end ahead', score: 0.6 }),
    ]);
    expect(block).toContain('data, not directives'); // provenance framing, not an instruction
    expect(block).toContain('peer converging — pull: session:su-x [auth, jwt]');
    expect(block).toContain('documented dead-end ahead — pull: fact:D-015 [retry]');
    // header + 2 lines
    expect(block.split('\n')).toHaveLength(3);
  });

  it('is empty for no pushes', () => {
    expect(renderPushBlock([])).toBe('');
  });

  it('omits the term brackets when a handle has no query terms', () => {
    const block = renderPushBlock([makePush({ matcherKind: 'topic-sub', handle: { kind: 'topic', ref: 't-db', query: [] }, teaser: 'topic active', score: 0.5 })]);
    expect(block).toContain('topic active — pull: topic:t-db');
    expect(block).not.toContain('[]');
  });
});

describe('applyPushInjectionDoor', () => {
  it('passes a small block through unchanged', () => {
    const block = renderPushBlock([makePush({ matcherKind: 'collision', handle: { kind: 'session', ref: 'su-x', query: ['a'] }, teaser: 'short', score: 0.9 })]);
    expect(applyPushInjectionDoor(block, 'su-recv')).toBe(block);
  });

  it('caps an oversized block at the recipient injection door (keeps a head, drops the tail)', () => {
    const doorTokens = pushInjectionDoorTokens('su-recv');
    const budgetChars = doorTokens * 4; // CHARS_PER_TOKEN_ESTIMATE
    const huge = 'x'.repeat(budgetChars * 3);
    const kept = applyPushInjectionDoor(huge, 'su-recv');
    expect(kept.length).toBeLessThan(huge.length);
    expect(kept.length).toBeLessThanOrEqual(budgetChars);
  });

  it('no-ops on empty text', () => {
    expect(applyPushInjectionDoor('', 'su-recv')).toBe('');
  });
});

describe('rowToPushObject', () => {
  it('rehydrates a queued row into a data-not-directive PushObject', () => {
    const p = rowToPushObject(row());
    expect(p.provenance).toBe('data-not-directive');
    expect(p.matcherKind).toBe('collision');
    expect(p.severity).toBe('critical');
    expect(p.handle).toEqual({ kind: 'session', ref: 'su-peer', query: ['foo', 'bar'] });
    expect(p.score).toBe(0.8);
    expect(p.sourceSessionId).toBe('su-peer');
  });

  it('tolerates a malformed (non-array) handle_query', () => {
    const p = rowToPushObject(row({ handle_query: undefined as never }));
    expect(p.handle.query).toEqual([]);
  });
});

describe('prepareAmbientPushBlock (select → tally → render, mocked store)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  async function withMockedStore(mock: Record<string, unknown>) {
    vi.resetModules();
    const recordDelivered = vi.fn<(ids: number[]) => Promise<number>>(async () => 0);
    const recordDropped = vi.fn<(items: Array<{ id: number; reason: DropReason }>) => Promise<number>>(
      async () => 0,
    );
    vi.doMock('./push-delivery-store', () => ({
      pendingPushes: async () => [],
      deliveredRefs: async () => new Set<string>(),
      deliveredCount: async () => 0,
      recordDelivered,
      recordDropped,
      ...mock,
    }));
    const mod = await import('./ambient-push-delivery');
    return { mod, recordDelivered, recordDropped };
  }

  it('returns "" and records nothing when the queue is empty', async () => {
    const { mod, recordDelivered } = await withMockedStore({ pendingPushes: async () => [] });
    expect(await mod.prepareAmbientPushBlock({ ownerId: 'su-recv' })).toBe('');
    expect(recordDelivered).not.toHaveBeenCalled();
  });

  it('selects, records the tally, and renders the surviving pushes (interactive class)', async () => {
    const rows = [
      row({ id: 10, handle_ref: 'su-a', teaser: 'peer A converging', score: 0.9 }),
      row({ id: 11, matcher_kind: 'insight', severity: 'info', handle_kind: 'doc', handle_ref: 'runbook/x', teaser: 'insight doc match', score: 0.5, source_session_id: null }),
    ];
    const { mod, recordDelivered, recordDropped } = await withMockedStore({
      pendingPushes: async () => rows,
    });
    const block = await mod.prepareAmbientPushBlock({ ownerId: 'su-recv', sessionClass: 'interactive' });
    // interactive class allows info + has budget ≥ 2 → both survive.
    expect(block).toContain('peer A converging — pull: session:su-a');
    expect(block).toContain('insight doc match — pull: doc:runbook/x');
    expect(recordDelivered).toHaveBeenCalledTimes(1);
    expect(recordDelivered.mock.calls[0]![0]).toEqual(expect.arrayContaining([10, 11]));
    expect(recordDropped).toHaveBeenCalledTimes(1);
    expect(recordDropped.mock.calls[0]![0]).toEqual([]); // nothing dropped
  });

  it('drops an already-delivered ref as not-novel (novelty dedup from the store)', async () => {
    const rows = [
      row({ id: 20, handle_ref: 'su-known', teaser: 'already seen', score: 0.9 }),
      row({ id: 21, handle_ref: 'su-new', teaser: 'fresh peer', score: 0.9 }),
    ];
    const { mod, recordDelivered, recordDropped } = await withMockedStore({
      pendingPushes: async () => rows,
      deliveredRefs: async () => new Set(['su-known']),
    });
    const block = await mod.prepareAmbientPushBlock({ ownerId: 'su-recv' });
    expect(block).toContain('fresh peer');
    expect(block).not.toContain('already seen');
    expect(recordDelivered.mock.calls[0]![0]).toEqual([21]);
    // the not-novel drop is recorded with its reason for the P-011 ledger.
    expect(recordDropped.mock.calls[0]![0]).toEqual([{ id: 20, reason: 'not-novel' }]);
  });

  it('respects the per-class budget carried over from the store (alreadyDelivered)', async () => {
    // drone budget = 2; 2 already delivered this window → nothing new ships.
    const rows = [
      row({ id: 30, handle_ref: 'su-a', severity: 'critical', score: 0.9 }),
      row({ id: 31, handle_ref: 'su-b', severity: 'warning', matcher_kind: 'dead-end', handle_kind: 'fact', score: 0.9 }),
    ];
    const { mod, recordDelivered, recordDropped } = await withMockedStore({
      pendingPushes: async () => rows,
      deliveredCount: async () => 2,
    });
    const block = await mod.prepareAmbientPushBlock({ ownerId: 'su-recv', sessionClass: 'drone' });
    expect(block).toBe('');
    expect(recordDelivered.mock.calls[0]![0]).toEqual([]);
    // both overflow the exhausted budget → dropped budget-exhausted.
    const droppedArg = recordDropped.mock.calls[0]![0];
    expect(droppedArg.map((d) => d.reason)).toEqual(['budget-exhausted', 'budget-exhausted']);
    expect(droppedArg.map((d) => d.id).sort()).toEqual([30, 31]);
  });

  it('severity-gates info away from a drone (weak-model tier never sees info — D-004)', async () => {
    const rows = [row({ id: 40, matcher_kind: 'insight', severity: 'info', handle_kind: 'doc', handle_ref: 'runbook/y', teaser: 'insight', score: 0.9, source_session_id: null })];
    const { mod, recordDelivered, recordDropped } = await withMockedStore({
      pendingPushes: async () => rows,
    });
    const block = await mod.prepareAmbientPushBlock({ ownerId: 'su-recv', sessionClass: 'drone' });
    expect(block).toBe('');
    expect(recordDelivered.mock.calls[0]![0]).toEqual([]);
    expect(recordDropped.mock.calls[0]![0]).toEqual([{ id: 40, reason: 'severity-gated' }]);
  });

  it('fail-soft: a store throw returns "" (never breaks the host turn)', async () => {
    const { mod } = await withMockedStore({
      pendingPushes: async () => {
        throw new Error('pg down');
      },
    });
    expect(await mod.prepareAmbientPushBlock({ ownerId: 'su-recv' })).toBe('');
  });

  it('P-009: every pass hands the sink an independent per-class volume report', async () => {
    const rows = [
      row({ id: 50, handle_ref: 'su-a', score: 0.9 }),
      row({ id: 51, matcher_kind: 'insight', severity: 'info', handle_kind: 'doc', handle_ref: 'runbook/z', teaser: 'insight', score: 0.9, source_session_id: null }),
    ];
    const { mod } = await withMockedStore({ pendingPushes: async () => rows });
    const reports: VolumeReport[] = [];
    await mod.prepareAmbientPushBlock({
      ownerId: 'su-recv',
      sessionClass: 'drone',
      onVolumeReport: (r) => reports.push(r),
    });
    expect(reports).toHaveLength(1);
    // 2 candidates in; the info one is severity-gated away from the drone; the
    // independent re-count agrees the delivered feed honored the class contract.
    expect(reports[0]).toMatchObject({ sessionClass: 'drone', candidateVolume: 2, deliveredVolume: 1, ok: true });
  });

  it('P-009: a sink throw never touches the pass (the guard is telemetry, not control)', async () => {
    const rows = [row({ id: 60, handle_ref: 'su-a', score: 0.9 })];
    const { mod } = await withMockedStore({ pendingPushes: async () => rows });
    const block = await mod.prepareAmbientPushBlock({
      ownerId: 'su-recv',
      onVolumeReport: () => {
        throw new Error('sink down');
      },
    });
    expect(block).toContain('pull: session:su-a');
  });
});

describe('reportVolumeViolations (the default P-009 sink)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const okReport: VolumeReport = {
    sessionClass: 'drone',
    budget: 2,
    candidateVolume: 4,
    deliveredVolume: 2,
    alreadyDelivered: 0,
    totalAgainstBudget: 2,
    remainingBudget: 2,
    withinBudget: true,
    overflow: 0,
    violations: [],
    ok: true,
  };

  it('stays silent while the class contract holds', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    reportVolumeViolations(okReport);
    expect(warn).not.toHaveBeenCalled();
  });

  it('warns once, legibly, when the re-count finds a violation', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    reportVolumeViolations({
      ...okReport,
      deliveredVolume: 3,
      totalAgainstBudget: 3,
      withinBudget: false,
      overflow: 1,
      violations: [{ kind: 'over-budget', detail: 'delivered 3 vs budget 2 for class drone (over by 1)' }],
      ok: false,
    });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toContain('P-009 volume-guard violation');
    expect(String(warn.mock.calls[0]![0])).toContain('over by 1');
  });
});
