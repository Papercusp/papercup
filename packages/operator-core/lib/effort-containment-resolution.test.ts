/**
 * effort-scoped-continuity-2026-09-02 — P-009, the SEAM half.
 *
 * `effort-scoped-continuity.test.ts` holds the pure falsifiers (identity, rungs,
 * ladder, ceiling). This file holds the ones that only exist once a seam is actually
 * driven: fan-out capping and its DISCLOSURE (P-019), direction defaults (D-007's
 * member-vs-leader split), depth accounting (D-008 spends budget against it),
 * P-017's write-level fallback, and P-003's journal flag at the write itself.
 *
 * The store is mocked at `boundedPgReadTxn`, deliberately: every claim tested here
 * is JS-side arithmetic over rows — the cap, the ordering, the disclosure, the depth
 * — and mocking the row source is what makes a 200-descendant tree cheap to assert.
 * The SQL itself is covered by the integration lane.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const rowsets = vi.hoisted(() => ({
  queue: [] as unknown[][],
  calls: 0,
  queries: [] as Array<{ sql: string; params: unknown[] }>,
}));
const sql = vi.hoisted(() => vi.fn());
const commentWorkItem = vi.hoisted(() => vi.fn());
const setCarryNoteWithPrior = vi.hoisted(() => vi.fn());
const addPost = vi.hoisted(() => vi.fn());
const getOrCreateThread = vi.hoisted(() => vi.fn());

vi.mock('@papercusp/db-org', async (orig) => ({
  ...(await orig<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({ sql }),
}));

vi.mock('./pg-read-query', async (orig) => ({
  ...(await orig<typeof import('./pg-read-query')>()),
  boundedPgReadTxn: async (read: (tx: unknown) => Promise<unknown>) => {
    rowsets.calls += 1;
    const next = rowsets.queue.shift();
    if (next === undefined) throw new Error('rowset queue exhausted');
    const tx = (strings: TemplateStringsArray, ...params: unknown[]) => {
      rowsets.queries.push({ sql: strings.join('?'), params });
      return Promise.resolve(next);
    };
    return read(tx);
  },
}));

vi.mock('./carry-note', async (orig) => ({
  ...(await orig<typeof import('./carry-note')>()),
  setCarryNoteWithPrior,
}));

vi.mock('./work-items', async (orig) => ({
  ...(await orig<typeof import('./work-items')>()),
  commentWorkItem,
}));

vi.mock('@papercusp/coordination/capabilities', async (orig) => ({
  ...(await orig<typeof import('@papercusp/coordination/capabilities')>()),
  PgThreadStore: class {
    getOrCreateThread = getOrCreateThread;
    addPost = addPost;
  },
}));

import {
  DESCENDANT_FANOUT_CAP,
  OMITTED_DESCENDANT_REF_CAP,
  resolveContainmentTree,
} from './containment-tree';
import { effortObjectRef, postLearnedAtLevel } from './effort-thread';
import { setWorkItemCheckpointWithPrior } from './work-item-checkpoint';

const WS = 'ws-effort-test';

/** Queue the rowsets `resolveContainmentTree` will read, in call order. */
function queue(...sets: unknown[][]): void {
  rowsets.queue = sets;
  rowsets.calls = 0;
  rowsets.queries = [];
}

function itemRows(n: number, planSlug: string, opts: { withCheckpoint?: number } = {}) {
  return Array.from({ length: n }, (_, i) => ({
    feature_id: `WI-${1000 + i}`,
    harness_slug: 'papercusp',
    source_plan_slug: planSlug,
    goal_id: null,
    title: `item ${i}`,
    has_checkpoint: i < (opts.withCheckpoint ?? 0),
  }));
}

beforeEach(() => {
  rowsets.queue = [];
  rowsets.calls = 0;
  sql.mockReset();
  commentWorkItem.mockReset();
  addPost.mockReset();
  getOrCreateThread.mockReset();
  setCarryNoteWithPrior.mockReset();
});

// ── P-003: the ring was never missing — it was switched off at this one call ────

describe('work-item checkpoint journal ring (P-003)', () => {
  it('writes work-item checkpoints WITH the journal ring on', async () => {
    // Measured 2026-09-02: 10,326 `workitem`-scoped carry_notes rows, ZERO carrying a
    // journal entry, while the `loop` scope on the SAME substrate had 29,377. One
    // literal `journal: false` here was the entire cause — week 3's agent silently
    // destroying week 1's reasoning on every replace-on-write. This asserts the flag
    // at the call, because that is the single character a future edit could revert
    // with nothing else in the tree noticing.
    setCarryNoteWithPrior.mockResolvedValue({ stored: null, priorLength: 0 });
    await setWorkItemCheckpointWithPrior(
      { workItemId: 'WI-1', harness: 'papercusp' },
      'did: turned the ring on',
    );
    expect(setCarryNoteWithPrior).toHaveBeenCalledTimes(1);
    const opts = setCarryNoteWithPrior.mock.calls[0][2];
    expect(opts).toMatchObject({ journal: true });
  });

  it('keeps the bounded fail-fast contract the ring rides along with', async () => {
    // The ring adds no query and no lock — it rides the row this transaction already
    // SELECTed FOR UPDATE. `bounded: true` is what keeps a contended write returning
    // a typed, retryable error instead of an ambiguous "commit status unknown"
    // transport timeout (EI-21864672058763701), so it must not be lost alongside it.
    setCarryNoteWithPrior.mockResolvedValue({ stored: null, priorLength: 0 });
    await setWorkItemCheckpointWithPrior({ workItemId: 'WI-1', harness: null }, 'anything');
    expect(setCarryNoteWithPrior.mock.calls[0][2]).toMatchObject({ journal: true, bounded: true });
  });

  it('CONTROL: the journal assertion is falsifiable — a `journal: false` seam fails it', () => {
    // A guard that has never failed is a guard nobody has tested. The subject here is
    // a module this file IMPORTS, so the repo's falsifiability ladder prescribes a
    // permanent in-file control rather than mutating the shared tree (git-sync sweeps
    // it, and a sweep landing mid-probe commits the mutant). The two halves together
    // are what falsify a regression: `toHaveBeenCalledTimes(1)` above proves the real
    // production seam was driven, and this proves the predicate discriminates rather
    // than passing on anything it is handed.
    expect(() =>
      expect({ journal: false, bounded: true }).toMatchObject({ journal: true }),
    ).toThrow();
    expect(() => expect({ bounded: true }).toMatchObject({ journal: true })).toThrow();
  });

  it('keys a harness-null item under the canonical sentinel, not an empty segment', async () => {
    // EI-8805: one namespace on every write/read seam, or the ring a reader looks for
    // is not the ring the writer filled.
    setCarryNoteWithPrior.mockResolvedValue({ stored: null, priorLength: 0 });
    await setWorkItemCheckpointWithPrior({ workItemId: 'EI-7', harness: null }, 'note');
    expect(setCarryNoteWithPrior.mock.calls[0][0].scope).toBe('workitem:*:EI-7');
  });
});

// ── direction: the member/leader split is a DEFAULT, not a convention (D-007) ────

describe('containment direction (D-007)', () => {
  it('defaults to ancestors ONLY — a member claim path must not pay for a closure', async () => {
    // D-007: "the rollup read is a LEADER read, not a member read". If descent were
    // the default, every claim on a 126-item plan would silently become a transitive
    // closure. The falsifier is the QUERY COUNT: one read, not two.
    queue([{ plan_slug: 'p1', harness_slug: 'papercusp', goal_id: 'goal-9', title: 'P1' }]);
    const tree = await resolveContainmentTree(
      { kind: 'plan', ref: 'p1', harness: 'papercusp' },
      { workspaceId: WS },
    );
    expect(rowsets.calls).toBe(1);
    expect(tree.descended).toBe(false);
    expect(tree.ancestors).toEqual([{ kind: 'goal', ref: 'goal-9', harness: null, depth: 1 }]);
  });

  it('distinguishes "not asked for" from "none exist" — the guess a caller must not make', async () => {
    // `descendants: []` is ambiguous on its own, so `descended` carries the answer.
    // Without it a member's ancestors-only read is indistinguishable from a leader's
    // read of a childless plan, and a rollup that found nothing looks like one that
    // never ran.
    queue([]); // ancestors: plan has no goal
    const notAsked = await resolveContainmentTree(
      { kind: 'plan', ref: 'p1', harness: 'papercusp' },
      { workspaceId: WS },
    );
    expect(notAsked.descendants).toEqual([]);
    expect(notAsked.descended).toBe(false);

    queue([]); // descendants: plan genuinely has no items
    const askedAndEmpty = await resolveContainmentTree(
      { kind: 'plan', ref: 'p1', harness: 'papercusp' },
      { workspaceId: WS, direction: 'down' },
    );
    expect(askedAndEmpty.descendants).toEqual([]);
    expect(askedAndEmpty.descended).toBe(true);
    expect(askedAndEmpty.fanOut.truncated).toBe(false);
  });

  it('never descends from a work-item — the leaf level has no closure to pay for', async () => {
    queue([]); // ancestors only; a descendant query would exhaust the queue and throw
    const tree = await resolveContainmentTree(
      { kind: 'work_item', ref: 'WI-1', harness: 'papercusp' },
      { workspaceId: WS, direction: 'both' },
    );
    expect(rowsets.calls).toBe(1);
    expect(tree.descendants).toEqual([]);
    expect(tree.fanOut.total).toBe(0);
  });
});

// ── P-019: the cap is only half of it — the REMAINDER has to be nameable ────────

describe('descendant fan-out cap and disclosure (P-019 / D-008)', () => {
  it('caps the admitted set and DISCLOSES every omitted child by ref', async () => {
    // The measured worst plan in this workspace carries 126 items. Capping alone
    // would make a rollup of it silently partial — indistinguishable from a plan
    // with 24 items. P-019 exists so the omission is auditable, not inferred.
    const total = DESCENDANT_FANOUT_CAP + 6;
    queue(itemRows(total, 'p1'));
    const tree = await resolveContainmentTree(
      { kind: 'plan', ref: 'p1', harness: 'papercusp' },
      { workspaceId: WS, direction: 'down' },
    );
    expect(tree.descendants).toHaveLength(DESCENDANT_FANOUT_CAP);
    expect(tree.fanOut).toMatchObject({
      admitted: DESCENDANT_FANOUT_CAP,
      total,
      cap: DESCENDANT_FANOUT_CAP,
      truncated: true,
    });
    expect(tree.omittedDescendants).toHaveLength(6);
    expect(tree.omittedDescendantsTruncated).toBe(false);
    // The disclosed refs are exactly the tail the cap cut — not a sample of it.
    expect(tree.omittedDescendants.map((d) => d.ref)).toEqual(
      itemRows(total, 'p1')
        .slice(DESCENDANT_FANOUT_CAP)
        .map((r) => r.feature_id),
    );
  });

  it('reports EXHAUSTION of the omitted list rather than passing a cut list off as whole', async () => {
    // The same failure one level up: a truncated disclosure that does not say it is
    // truncated is a complete-looking answer. `omittedDescendantsTruncated` is what
    // stops the audit trail from lying about its own completeness.
    const total = DESCENDANT_FANOUT_CAP + OMITTED_DESCENDANT_REF_CAP + 5;
    queue(itemRows(total, 'p1'));
    const tree = await resolveContainmentTree(
      { kind: 'plan', ref: 'p1', harness: 'papercusp' },
      { workspaceId: WS, direction: 'down' },
    );
    expect(tree.omittedDescendants).toHaveLength(OMITTED_DESCENDANT_REF_CAP);
    expect(tree.omittedDescendantsTruncated).toBe(true);
    expect(tree.fanOut.truncated).toBe(true);
  });

  it('admits a goal\'s own PLANS before its grandchild items', async () => {
    // D-007: a plan's thread is where a leader's cross-item rulings live. Ordering
    // items first would let item chatter evict exactly the rulings a rollup exists
    // to surface — the inversion this ordering prevents.
    const plans = Array.from({ length: 3 }, (_, i) => ({
      plan_slug: `p${i}`,
      harness_slug: 'papercusp',
      goal_id: 'goal-9',
      title: `plan ${i}`,
    }));
    queue(plans, itemRows(DESCENDANT_FANOUT_CAP + 10, 'p0'));
    const tree = await resolveContainmentTree(
      { kind: 'goal', ref: 'goal-9' },
      { workspaceId: WS, direction: 'down' },
    );
    expect(tree.descendants.slice(0, 3).map((d) => d.kind)).toEqual(['plan', 'plan', 'plan']);
    expect(tree.descendants.slice(3).every((d) => d.kind === 'work_item')).toBe(true);
    // A goal's plans sit one hop away; its items two.
    expect(tree.descendants[0].depth).toBe(1);
    expect(tree.descendants[3].depth).toBe(2);
  });

  it('reads beyond the plan cap before declaring a goal fan-out complete', async () => {
    const plans = Array.from({ length: DESCENDANT_FANOUT_CAP + 1 }, (_, i) => ({
      plan_slug: `p${i}`,
      harness_slug: 'papercusp',
      goal_id: 'goal-9',
      title: `plan ${i}`,
    }));
    queue(plans, []);
    const tree = await resolveContainmentTree(
      { kind: 'goal', ref: 'goal-9' },
      { workspaceId: WS, direction: 'down' },
    );
    expect(tree.descendants).toHaveLength(DESCENDANT_FANOUT_CAP);
    expect(tree.fanOut).toMatchObject({ total: DESCENDANT_FANOUT_CAP + 1, truncated: true });
    expect(tree.omittedDescendants).toEqual([
      { kind: 'plan', ref: `p${DESCENDANT_FANOUT_CAP}`, harness: 'papercusp' },
    ]);
    expect(rowsets.queries[0]!.params).toContain(
      DESCENDANT_FANOUT_CAP + OMITTED_DESCENDANT_REF_CAP + 1,
    );
  });

  it('honours a caller-supplied cap but never lets it reach zero', async () => {
    queue(itemRows(10, 'p1'));
    const tree = await resolveContainmentTree(
      { kind: 'plan', ref: 'p1', harness: 'papercusp' },
      { workspaceId: WS, direction: 'down', maxDescendants: 0 },
    );
    // A zero cap would make every rollup silently empty while reporting success.
    expect(tree.descendants).toHaveLength(1);
    expect(tree.fanOut.cap).toBe(1);
    expect(tree.fanOut.truncated).toBe(true);
  });
});

// ── depth is the budget's only cost-bearing field, so it must be charged right ──

describe('ancestor depth accounting (D-008)', () => {
  it('charges a goal reached THROUGH a plan two hops, and a directly-held goal one', async () => {
    // D-008 spends the read budget against depth. Collapsing the two would buy an
    // orphan's goal the same resolution as its own plan — the mis-pricing that makes
    // a bounded brief spend its budget in the wrong place.
    queue([
      {
        feature_id: 'WI-1',
        harness_slug: 'papercusp',
        source_plan_slug: 'p1',
        goal_id: 'goal-direct',
        title: 'has both',
      },
    ]);
    const viaPlan = await resolveContainmentTree({ kind: 'work_item', ref: 'WI-1' }, { workspaceId: WS });
    expect(viaPlan.ancestors).toEqual([
      { kind: 'plan', ref: 'p1', harness: 'papercusp', depth: 1 },
      { kind: 'goal', ref: 'goal-direct', harness: null, depth: 2 },
    ]);

    queue([
      {
        feature_id: 'WI-2',
        harness_slug: 'papercusp',
        source_plan_slug: null,
        goal_id: 'goal-direct',
        title: 'goal only',
      },
    ]);
    const direct = await resolveContainmentTree({ kind: 'work_item', ref: 'WI-2' }, { workspaceId: WS });
    expect(direct.ancestors).toEqual([{ kind: 'goal', ref: 'goal-direct', harness: null, depth: 1 }]);
  });

  it('inherits the PLAN\'s goal when the item carries none — the only route most work has', async () => {
    // Measured 2026-09-02: only 30 open items carry a goal_id directly. Without
    // inheritance the goal rung would be unreachable for essentially all plan-backed
    // work, and P-020's ontology would admit a level nothing could ever resolve to.
    queue(
      [
        {
          feature_id: 'WI-3',
          harness_slug: 'papercusp',
          source_plan_slug: 'p1',
          goal_id: null,
          title: 'no goal of its own',
        },
      ],
      [{ plan_slug: 'p1', harness_slug: 'papercusp', goal_id: 'goal-inherited', title: 'P1' }],
    );
    const tree = await resolveContainmentTree({ kind: 'work_item', ref: 'WI-3' }, { workspaceId: WS });
    expect(tree.ancestors.map((a) => a.ref)).toEqual(['p1', 'goal-inherited']);
  });

  it('resolves NOTHING above a goal — it is the top of the containment tree', async () => {
    const tree = await resolveContainmentTree({ kind: 'goal', ref: 'goal-9' }, { workspaceId: WS });
    expect(rowsets.calls).toBe(0);
    expect(tree.ancestors).toEqual([]);
  });
});

// ── fail-soft, because every caller is on a claim path ─────────────────────────

describe('resolution failure is never a failed claim', () => {
  it('degrades to the root alone when the store throws', async () => {
    // Continuity ENRICHMENT must degrade to "no ancestor", never to a failed claim:
    // a briefing that can fail a claim is worse than no briefing.
    queue(); // any read exhausts the queue and throws
    const tree = await resolveContainmentTree(
      { kind: 'work_item', ref: 'WI-1', harness: 'papercusp' },
      { workspaceId: WS, direction: 'both' },
    );
    expect(tree.root.ref).toBe('WI-1');
    expect(tree.ancestors).toEqual([]);
    expect(tree.descendants).toEqual([]);
  });

  it('answers without touching the store when there is no ref to resolve', async () => {
    const tree = await resolveContainmentTree({ kind: 'plan', ref: '' }, { workspaceId: WS });
    expect(rowsets.calls).toBe(0);
    expect(tree.ancestors).toEqual([]);
  });
});

// ── P-017: the write attaches at the level asked for, or the nearest it HAS ─────

describe('capture level resolution (P-017 / D-009)', () => {
  it('writes at the item by default — the level 94% of work actually has', async () => {
    commentWorkItem.mockResolvedValue({ post_id: 'post-1' });
    const res = await postLearnedAtLevel({
      workItemId: 'WI-1',
      harness: 'papercusp',
      text: 'root cause: the gate judged a candidate without the fix.',
      workspaceId: WS,
    });
    expect(rowsets.calls).toBe(0); // no ancestor walk for the default level
    expect(res).toMatchObject({ posted: true, level: 'work_item', requestedLevel: 'work_item', fellBack: false });
    expect(commentWorkItem).toHaveBeenCalledWith(
      'WI-1',
      expect.stringContaining('root cause'),
      undefined,
      expect.objectContaining({ harness: 'papercusp' }),
    );
  });

  it('attaches a PLAN-level lesson to the plan\'s own thread, not the item that noticed it', async () => {
    // D-007: the level of the note matches the level of the insight. A cross-item
    // ruling filed on the one item that happened to surface it is invisible to every
    // sibling lane — the exact loss this plan exists to stop.
    queue(
      [
        {
          feature_id: 'WI-1',
          harness_slug: 'papercusp',
          source_plan_slug: 'my-plan',
          goal_id: null,
          title: 't',
        },
      ],
      [{ plan_slug: 'my-plan', harness_slug: 'papercusp', goal_id: null, title: 'My plan' }],
    );
    getOrCreateThread.mockResolvedValue({ thread_id: 'plan:papercusp:my-plan' });
    addPost.mockResolvedValue({ post_id: 'post-2' });
    const res = await postLearnedAtLevel({
      workItemId: 'WI-1',
      level: 'plan',
      harness: 'papercusp',
      text: 'root cause: every lane read the stale column.',
      workspaceId: WS,
    });
    expect(res).toMatchObject({ posted: true, level: 'plan', ref: 'my-plan', fellBack: false });
    expect(commentWorkItem).not.toHaveBeenCalled();
    expect(addPost).toHaveBeenCalledWith(expect.objectContaining({ thread_id: 'plan:papercusp:my-plan' }));
  });

  it('FALLS BACK to the item when the asked-for level does not exist, rather than dropping the note', async () => {
    // The silent-drop failure: an orphan item asked to file at the plan level has no
    // plan. Dropping would destroy the lesson at exactly the moment it was written;
    // falling back keeps it and REPORTS the demotion so the writer is not misled.
    queue([
      {
        feature_id: 'WI-9',
        harness_slug: 'papercusp',
        source_plan_slug: null,
        goal_id: null,
        title: 'orphan',
      },
    ]);
    commentWorkItem.mockResolvedValue({ post_id: 'post-3' });
    const res = await postLearnedAtLevel({
      workItemId: 'WI-9',
      level: 'goal',
      harness: 'papercusp',
      text: 'still open: the orphan lane has no goal.',
      workspaceId: WS,
    });
    expect(res).toMatchObject({ posted: true, level: 'work_item', requestedLevel: 'goal', fellBack: true });
    expect(commentWorkItem).toHaveBeenCalledTimes(1);
  });

  it('fails SOFT — a capture that cannot be written must never fail the checkpoint it rode along', async () => {
    commentWorkItem.mockRejectedValue(new Error('store down'));
    const res = await postLearnedAtLevel({
      workItemId: 'WI-1',
      harness: 'papercusp',
      text: 'anything',
      workspaceId: WS,
    });
    expect(res).toMatchObject({ posted: false, skipped: 'write-failed' });
    // The advisory still comes back: the writer learns what the note lacked even
    // when the write itself lost.
    expect(res.advisory?.missing.map((m) => m.rung)).toContain('rootCauses');
  });

  it('carries the write-time advisory on the SUCCESS path too, which is where it can change a note', async () => {
    commentWorkItem.mockResolvedValue({ post_id: 'post-4' });
    const bare = await postLearnedAtLevel({
      workItemId: 'WI-1',
      text: 'retried it; still red.',
      workspaceId: WS,
    });
    expect(bare.advisory?.note).toMatch(/root cause/);
    const rich = await postLearnedAtLevel({
      workItemId: 'WI-1',
      text: 'root cause: stale pin. false premise: I thought the gate refetched. still open: the retry path.',
      workspaceId: WS,
    });
    expect(rich.advisory?.note).toBeNull();
  });

  it('refuses to mint a work-item thread ref, because its parent kind is family-dependent', () => {
    expect(() => effortObjectRef({ kind: 'work_item', ref: 'WI-1', harness: 'papercusp' })).toThrow(
      /workItemObjectRef/,
    );
    expect(effortObjectRef({ kind: 'plan', ref: 'p1', harness: 'papercusp' })).toEqual({
      kind: 'plan',
      ref: 'papercusp:p1',
    });
    expect(effortObjectRef({ kind: 'goal', ref: 'goal-9' })).toEqual({ kind: 'goal', ref: 'goal-9' });
  });
});
