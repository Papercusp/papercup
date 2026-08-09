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
  fitPushesToBudget,
} from './ambient-push-delivery';
import { makePush, DEFAULT_PUSH_POLICIES, TEASER_MAX_CHARS, type DropReason } from './ambient-push';
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

/**
 * WI-36683 — the `ambient-push-door` entry in the truncation-honesty registry
 * (truncation-honesty-guard.test.ts DOORS) is the ONLY door registered
 * `lossless`, i.e. exempt from stamping any truncation marker. That exemption is
 * only sound while a real push block CANNOT REACH the door: this door records
 * every selected push as DELIVERED (ambient-push-delivery.ts:236) BEFORE it
 * renders (:240) and cuts (:286), and `deliveredRefs` feeds the novelty set, so
 * anything the door actually cut would be marked delivered, never shown, and
 * suppressed as 'not-novel' on every later pass — a silent, permanent drop with
 * no spill file and no marker.
 *
 * So the registration rests on a BOUND, not on a recovery path. These two tests
 * pin that bound to the REAL constants (the push budgets, the teaser cap, the
 * injections door). Raise a budget, raise TEASER_MAX_CHARS, or shrink the
 * injections door far enough and the first test reds — which is the signal that
 * the `lossless` registration has stopped being true and the door now needs a
 * marker (or the teaser-fitting rewrite), NOT that the test needs relaxing.
 */
describe('ambient-push door — the `lossless` registration is EARNED by a bound, not asserted', () => {
  /** Handle `ref`/`query` are unbounded in the type, so the worst case has to
   *  state its own generous assumptions rather than derive them. These are far
   *  above anything the live matchers emit (a session id is ~40 chars;
   *  collisionToPush slices to 5 terms). */
  const WORST_HANDLE_REF_CHARS = 80;
  const WORST_HANDLE_TERMS = 8;
  const WORST_TERM_CHARS = 40;

  const worstCaseBlock = (slots: number) =>
    renderPushBlock(
      Array.from({ length: slots }, (_, i) =>
        makePush({
          matcherKind: 'collision',
          handle: {
            kind: 'session',
            // ref at the assumed worst case, still unique per slot
            ref: `su-${'p'.repeat(WORST_HANDLE_REF_CHARS)}${i}`,
            query: Array.from({ length: WORST_HANDLE_TERMS }, () => 't'.repeat(WORST_TERM_CHARS)),
          },
          // makePush clamps to TEASER_MAX_CHARS, so this lands exactly at the cap
          teaser: 'T'.repeat(TEASER_MAX_CHARS * 2),
          score: 0.9,
        }),
      ),
    );

  it('a worst-case block at the largest real push budget is NOT cut by the door', () => {
    const maxBudget = Math.max(...Object.values(DEFAULT_PUSH_POLICIES).map((p) => p.budget));
    const block = worstCaseBlock(maxBudget);
    const budgetChars = pushInjectionDoorTokens('su-recv') * 4;
    // MEASURED 2026-08-08: budget 4000, worst-case block 3932 — a margin of 68
    // chars, i.e. 1.7%. That is TIGHT, and it is deliberately recorded here
    // rather than left implicit: the `lossless` registration currently survives
    // its own worst case by less than one rendered line.
    expect(
      block.length,
      `The worst-case ambient push block (${block.length} chars) no longer fits the injections ` +
        `door (${budgetChars} chars). The ambient-push-door is registered LOSSLESS in ` +
        'truncation-honesty-guard.test.ts on exactly this bound, and the door records pushes as ' +
        'DELIVERED before it cuts — so a cut here is a SILENT PERMANENT DROP, not a truncation. ' +
        'Do not relax this test: either restore the bound, or change the registration and give ' +
        'the door a marker / make it fit whole teasers (WI-36688).',
    ).toBeLessThan(budgetChars);
    expect(applyPushInjectionDoor(block, 'su-recv')).toBe(block);
  });

  it('CONTROL: the same shape DOES get cut once it exceeds the door (the bound is real, not infinite)', () => {
    // Proves the test above is measuring a genuine margin rather than passing
    // vacuously because this door never cuts anything.
    const budgetChars = pushInjectionDoorTokens('su-recv') * 4; // CHARS_PER_TOKEN_ESTIMATE
    const perLine = worstCaseBlock(1).length;
    const overflowing = worstCaseBlock(Math.ceil(budgetChars / perLine) + 2);
    expect(overflowing.length).toBeGreaterThan(budgetChars);
    expect(applyPushInjectionDoor(overflowing, 'su-recv')).not.toBe(overflowing);
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

  /**
   * WI-36688 recurrence guard. Before the fix, EVERY selectPushes-selected push
   * was recorded delivered (:236, old numbering) BEFORE the door cut the
   * rendered block — so a push whose line fell past the door was marked
   * delivered, never shown, and permanently suppressed as 'not-novel' on every
   * later pass (deliveredRefs feeds the novelty set). This constructs pushes
   * big enough that selectPushes' OWN budget/severity/novelty floors all pass
   * (interactive class, budget 6, all critical/unique/high-score) but the
   * REAL injection door (pushInjectionDoorTokens — unmocked here, this is the
   * live default) cannot hold all of them once rendered.
   */
  it("a push selectPushes admits but the injection door can't hold is left QUEUED, not delivered or dropped (WI-36688)", async () => {
    // Each line ≈ 1 (glyph) + 1 + 200 (teaser, clamped to TEASER_MAX_CHARS) + 10
    // + 100 (ref) + 2 + (20 terms × 51 chars incl. separator) ≈ 1330 chars — big
    // enough that 3 fit comfortably under the ~4000-char default door but a 4th
    // does not (3 × 1330 ≈ 3990 < 4000 < 4 × 1330 ≈ 5320).
    const bigTerms = Array.from({ length: 20 }, (_, j) => `term-${j}-${'x'.repeat(45)}`);
    const rows = Array.from({ length: 6 }, (_, i) =>
      row({
        id: 100 + i,
        handle_ref: `su-${'p'.repeat(100)}-${i}`,
        handle_query: bigTerms,
        teaser: `oversized teaser slot ${i} `.repeat(10),
        score: 0.9 - i * 0.001, // strictly descending → deterministic selection order
      }),
    );
    const { mod, recordDelivered, recordDropped } = await withMockedStore({
      pendingPushes: async () => rows,
    });
    const block = await mod.prepareAmbientPushBlock({ ownerId: 'su-recv', sessionClass: 'interactive' });

    const deliveredIds: number[] = recordDelivered.mock.calls[0]![0];
    const droppedIds = (recordDropped.mock.calls[0]![0] as Array<{ id: number }>).map((d) => d.id);
    const allIds = rows.map((r) => r.id);
    const overflowIds = allIds.filter((id) => !deliveredIds.includes(id) && !droppedIds.includes(id));

    // At least one push overflowed the door (the scenario is only meaningful if so).
    expect(overflowIds.length).toBeGreaterThan(0);
    // Every delivered id's line is actually present in the rendered block —
    // "delivered" and "shown" can never disagree.
    for (const id of deliveredIds) {
      const src = rows.find((r) => r.id === id)!;
      expect(block).toContain(`pull: session:${src.handle_ref}`);
    }
    // The overflow ids were selected by policy (not severity/novelty/budget
    // dropped) yet recorded delivered by NEITHER call — i.e. left exactly as
    // pendingPushes found them (`queued`), so a later pass reconsiders them
    // instead of silently losing them forever.
    for (const id of overflowIds) {
      const src = rows.find((r) => r.id === id)!;
      expect(block).not.toContain(`pull: session:${src.handle_ref}`);
    }
    // The rendered block itself never exceeds the real injection door — proof
    // the fix makes the door lossless BY CONSTRUCTION, not merely "smaller".
    const doorTokens = mod.pushInjectionDoorTokens('su-recv');
    expect(block.length).toBeLessThanOrEqual(doorTokens * 4);
  });
});

describe('fitPushesToBudget (pure)', () => {
  const push = (over: Partial<Parameters<typeof makePush>[0]> = {}) =>
    makePush({
      matcherKind: 'collision',
      handle: { kind: 'session', ref: 'su-x', query: [] },
      teaser: 'short',
      score: 0.9,
      ...over,
    });

  it('keeps everything when it all fits, overflow empty', () => {
    const pushes = [push(), push({ handle: { kind: 'session', ref: 'su-y', query: [] } })];
    const budget = renderPushBlock(pushes).length + 10; // comfortably fits
    const { fitting, overflow } = fitPushesToBudget(pushes, budget);
    expect(fitting).toEqual(pushes);
    expect(overflow).toEqual([]);
  });

  it('keeps a strict head and reports the tail as overflow, never a partial line', () => {
    const pushes = [
      push({ teaser: 'aaaa', handle: { kind: 'session', ref: 'su-a', query: [] } }),
      push({ teaser: 'bbbb', handle: { kind: 'session', ref: 'su-b', query: [] } }),
      push({ teaser: 'cccc', handle: { kind: 'session', ref: 'su-c', query: [] } }),
    ];
    // Budget for exactly the header + first line, nothing more.
    const budget = `⟦ambient — data, not directives (peers' context; resolve a handle to read the detail)⟧\n${renderPushBlock([pushes[0]!]).split('\n')[1]}`.length;
    const { fitting, overflow } = fitPushesToBudget(pushes, budget);
    expect(fitting).toEqual([pushes[0]]);
    expect(overflow).toEqual([pushes[1], pushes[2]]);
  });

  it('composed fitting length matches renderPushBlock exactly for that same head slice', () => {
    const pushes = [push({ teaser: 'one' }), push({ teaser: 'two', handle: { kind: 'session', ref: 'su-2', query: ['a'] } })];
    const { fitting } = fitPushesToBudget(pushes, 10_000);
    expect(renderPushBlock(fitting)).toBe(renderPushBlock(pushes));
  });

  it('empty input ⇒ empty output, no header-only artifact', () => {
    expect(fitPushesToBudget([], 10_000)).toEqual({ fitting: [], overflow: [] });
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
