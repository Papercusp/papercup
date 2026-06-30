/**
 * Delta eval/replay harness — unit tier (agent-tool-delta-protocol-2026-06-22,
 * Lane A / P-003).
 *
 * Two things this proves, both load-bearing for the owner BUILD decision (D-007/
 * D-008):
 *   1. MERGE CORRECTNESS — `applyListDelta(base, computeListDelta(base, next))`
 *      deep-equals `next` across every transition kind (add / update / remove /
 *      reorder / identical / churn), AND the unsafe paths degrade to `full`
 *      instead of emitting a wrong delta. This is the "silently wrong merge"
 *      hazard converted into a deterministic assert.
 *   2. THE WIN IS REAL — on `plans:list`/`plans:attention`-shaped payloads (the
 *      two views that are ~98% of all tool-output bytes per the Lane-A P-001
 *      measurement), `not_modified` and single-row deltas cost a tiny fraction
 *      of the full body. Asserted as a regression guard so a future encoder/
 *      shape change that erases the saving fails loudly.
 */

import { describe, it, expect } from 'vitest';
import {
  computeListDelta,
  applyListDelta,
  evalSnapshotTransition,
  checksumRows,
  type Row,
} from './delta-eval-harness';

/* ─── Fixtures shaped like the REAL dominant views ───────────────────────────
 * plans:list row: { slug, title, status, updated, created, owner, template,
 *   harness, isLegacy, itemCounts, nextAction, maxImportance } (list.ts ListRow).
 * `slug` is the stable identity key. Sizes track the real ~432KB/250-plan view. */

const ITEM_STATES = ['todo', 'wip', 'blocked', 'needs-human', 'done', 'dropped'] as const;

function planRow(i: number, over: Partial<Row> = {}): Row {
  return {
    slug: `plan-topic-number-${i}-2026-06-${String((i % 28) + 1).padStart(2, '0')}`,
    title: `Plan ${i} — a representative multi-clause title describing the effort and its scope`,
    status: i % 5 === 0 ? 'active' : 'draft',
    updated: `2026-06-${String((i % 28) + 1).padStart(2, '0')}`,
    created: `2026-06-${String((i % 20) + 1).padStart(2, '0')}`,
    owner: 'aviynw6@gmail.com',
    template: null,
    harness: 'papercusp',
    isLegacy: false,
    itemCounts: { todo: i % 7, wip: i % 3, done: i % 11, blocked: i % 4 },
    nextAction:
      `Phase ${i % 4} — the single next concrete action is to wire up component ${i} and verify it against the suite, then hand off to the reviewer for sign-off.`,
    maxImportance: ITEM_STATES[i % ITEM_STATES.length] === 'todo' ? 'high' : 'normal',
    ...over,
  };
}

function workspaceView(n: number): Row[] {
  return Array.from({ length: n }, (_, i) => planRow(i));
}

const KEY = { itemKey: 'slug' };

/* ─── Merge correctness: the de-risk oracle ──────────────────────────────── */

describe('computeListDelta / applyListDelta — merge correctness round-trip', () => {
  const base = workspaceView(40);

  function assertRoundTrips(b: Row[] | null, next: Row[]) {
    const delta = computeListDelta(b, next, KEY);
    if (delta.mode === 'full') throw new Error(`expected a mergeable delta, got full:${delta.reason}`);
    if (delta.mode === 'not_modified') {
      expect(b).not.toBeNull();
      expect(applyListDelta(b as Row[], delta, KEY)).toEqual(next);
      return delta;
    }
    const merged = applyListDelta(b as Row[], delta, KEY);
    expect(merged).toEqual(next); // EXACT reconstruction — order + bodies
    return delta;
  }

  it('identical snapshot → not_modified, and the merge is base itself', () => {
    const d = assertRoundTrips(base, workspaceView(40));
    expect(d.mode).toBe('not_modified');
  });

  it('one row UPDATED → delta with put.length 1, exact merge', () => {
    const next = workspaceView(40);
    next[17] = planRow(17, { status: 'shipped', nextAction: 'CHANGED next action text' });
    const d = assertRoundTrips(base, next);
    expect(d.mode).toBe('delta');
    if (d.mode === 'delta') {
      expect(d.counts).toMatchObject({ added: 0, updated: 1, removed: 0, total: 40 });
      expect(d.put.map((p) => p.id)).toEqual([next[17].slug]);
    }
  });

  it('rows ADDED (appended + inserted) → delta, exact merge incl. order', () => {
    const next = [...workspaceView(40)];
    next.push(planRow(40), planRow(41));
    next.splice(5, 0, planRow(99)); // inserted mid-list — order must reconstruct
    const d = assertRoundTrips(base, next);
    expect(d.mode).toBe('delta');
    if (d.mode === 'delta') expect(d.counts.added).toBe(3);
  });

  it('rows REMOVED → delta carries remove ids, exact merge', () => {
    const next = workspaceView(40).filter((_, i) => i !== 3 && i !== 30);
    const d = assertRoundTrips(base, next);
    expect(d.mode).toBe('delta');
    if (d.mode === 'delta') {
      expect(d.counts.removed).toBe(2);
      expect(d.remove.sort()).toEqual([planRow(3).slug, planRow(30).slug].sort());
    }
  });

  it('REORDERED only (same set + bodies, new order) → delta reconstructs order exactly', () => {
    const next = [...workspaceView(40)].reverse();
    const d = assertRoundTrips(base, next);
    expect(d.mode).toBe('delta');
    if (d.mode === 'delta') {
      // no bodies changed — only the order line ships
      expect(d.put).toHaveLength(0);
      expect(d.remove).toHaveLength(0);
    }
  });

  it('CHURN (add + update + remove + reorder at once) → exact merge', () => {
    let next = workspaceView(40);
    next[2] = planRow(2, { status: 'shipped' }); // update
    next[8] = planRow(8, { nextAction: 'different' }); // update
    next = next.filter((_, i) => i !== 12 && i !== 25); // remove
    next.unshift(planRow(50)); // add at head
    next.push(planRow(51)); // add at tail
    next = [next[0], ...next.slice(1).reverse()]; // reorder the tail
    assertRoundTrips(base, next);
  });

  it('base→empty and empty→base both reconstruct exactly', () => {
    assertRoundTrips(base, []); // everything removed
    assertRoundTrips([], base); // everything added
  });
});

/* ─── Unsafe transitions degrade to full (never a wrong delta) ───────────── */

describe('computeListDelta — full fallback on unmergeable transitions', () => {
  it('base absent (post-compaction) → full / base_absent', () => {
    const d = computeListDelta(null, workspaceView(10), KEY);
    expect(d).toEqual({ mode: 'full', reason: 'base_absent' });
  });

  it('a row missing the identity key → full / no_item_key (no false removed claims)', () => {
    const next = workspaceView(5);
    delete (next[2] as Row).slug;
    expect(computeListDelta(workspaceView(5), next, KEY).mode).toBe('full');
    expect(computeListDelta(workspaceView(5), next, KEY)).toMatchObject({ reason: 'no_item_key' });
  });

  it('duplicate identity key → full / duplicate_key (ambiguous identity)', () => {
    const next = workspaceView(5);
    (next[3] as Row).slug = (next[0] as Row).slug;
    expect(computeListDelta(workspaceView(5), next, KEY)).toMatchObject({
      mode: 'full',
      reason: 'duplicate_key',
    });
  });

  it('applyListDelta throws on a full delta (no body to merge)', () => {
    expect(() => applyListDelta([], { mode: 'full', reason: 'base_absent' }, KEY)).toThrow(/full/);
  });
});

/* ─── checksum identity stability ────────────────────────────────────────── */

describe('checksumRows', () => {
  it('is stable across input order and equal for equal sets', () => {
    const a = workspaceView(12);
    const b = [...a].reverse();
    expect(checksumRows(a, 'slug')).toBe(checksumRows(b, 'slug'));
  });
  it('changes when any body changes', () => {
    const a = workspaceView(12);
    const b = workspaceView(12);
    b[4] = planRow(4, { status: 'shipped' });
    expect(checksumRows(a, 'slug')).not.toBe(checksumRows(b, 'slug'));
  });
});

/* ─── The win is real: token measurement on the dominant views ───────────── */

describe('evalSnapshotTransition — token ROI on plans:list-shaped payloads', () => {
  it('UNCHANGED 60-plan view → not_modified, >99% saving vs full-TOON, merge correct', async () => {
    const base = workspaceView(60);
    const e = await evalSnapshotTransition(base, workspaceView(60), KEY);
    expect(e.mode).toBe('not_modified');
    expect(e.correct).toBe(true);
    expect(e.winner).toBe('not_modified');
    const fullBaseline = Math.min(e.tokens.fullJson, e.tokens.fullToon);
    expect(e.tokens.notModified).toBeLessThan(fullBaseline / 50); // ≥98% smaller
    expect(e.savedVsFullPct).toBeGreaterThan(99);
    // sanity: the full body is genuinely large (the ~432KB-class view)
    expect(e.tokens.fullToon).toBeGreaterThan(3000);
  });

  it('ONE row changed in a 60-plan view → delta « full, big saving, merge correct', async () => {
    const base = workspaceView(60);
    const next = workspaceView(60);
    next[42] = planRow(42, { status: 'shipped', nextAction: 'a newly edited next-action line' });
    const e = await evalSnapshotTransition(base, next, KEY);
    expect(e.mode).toBe('delta');
    expect(e.correct).toBe(true);
    expect(e.winner).toBe('delta');
    // one changed body + 60 ids of order << 60 full bodies
    const fullBaseline = Math.min(e.tokens.fullJson, e.tokens.fullToon);
    expect(e.tokens.delta!).toBeLessThan(fullBaseline / 5);
    expect(e.savedVsFullPct).toBeGreaterThan(75);
  });

  it('FINDING: TOON-compact does NOT universally beat JSON — on the nested plans:list row shape it is WORSE, so the delta path is the only real win', async () => {
    // plans:list rows carry a nested `itemCounts` object + long `nextAction`
    // strings → TOON cannot tabularize them and its nested form exceeds compact
    // JSON. The harness reports both so the negotiator picks min(json,toon); the
    // delta/not_modified saving is shape-INDEPENDENT and dominates either way.
    const e = await evalSnapshotTransition(workspaceView(60), workspaceView(60), KEY);
    expect(e.tokens.fullToon).toBeGreaterThan(e.tokens.fullJson); // TOON loses here
    expect(e.winner).toBe('not_modified'); // ...but the delta path still wins big
    expect(e.savedVsFullPct).toBeGreaterThan(99);
  });

  it('base absent → full re-send, no merge claimed', async () => {
    const e = await evalSnapshotTransition(null, workspaceView(20), KEY);
    expect(e.mode).toBe('full');
    expect(e.reason).toBe('base_absent');
    expect(e.correct).toBeNull();
    expect(e.tokens.notModified).toBeNull();
    expect(e.tokens.delta).toBeNull();
  });

  it('tiny body (small-response bypass) → winner is full, never a delta round-trip', async () => {
    const base: Row[] = [{ slug: 'a', n: 1 }];
    const next: Row[] = [{ slug: 'a', n: 2 }];
    const e = await evalSnapshotTransition(base, next, KEY);
    expect(e.winner === 'full_toon' || e.winner === 'full_json').toBe(true);
  });
});
