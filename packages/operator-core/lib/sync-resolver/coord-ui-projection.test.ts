/**
 * coord.* UI display-projection unit pins
 * (whole-app-sync-payload-audit-2026-07-19 P-006).
 */
import { describe, expect, it } from 'vitest';
import {
  projectCoordInboxForUi,
  projectCoordPlansForUi,
  COORD_TEXT_PREVIEW_MAX,
  COORD_PLANS_UI_WINDOW,
} from './coord-ui-projection';

describe('projectCoordInboxForUi', () => {
  it('drops the heavy `payload`, keeping every rendered scalar (incl. the key fields)', () => {
    const rows = [
      {
        ts: '2026-07-19T00:00:00Z',
        msg_id: 'm1',
        source: 'message',
        kind: 'escalation',
        from: 'su-abc',
        to: ['human'],
        plan_slug: 'p',
        harness_slug: 'h',
        summary: 'needs a human',
        payload: { ts: '…', msg_id: 'm1', kind: 'escalation', huge: 'x'.repeat(5000) },
      },
    ];
    const out = projectCoordInboxForUi(rows) as Array<Record<string, unknown>>;
    expect(out[0]).not.toHaveProperty('payload');
    // client keys on `${source}:${msg_id}` — both must survive
    expect(out[0].source).toBe('message');
    expect(out[0].msg_id).toBe('m1');
    expect(out[0].summary).toBe('needs a human');
    expect(out[0].kind).toBe('escalation');
    expect(out[0].from).toBe('su-abc');
    expect(out[0].plan_slug).toBe('p');
  });

  it('is defensive against non-array / non-object rows', () => {
    expect(projectCoordInboxForUi(null)).toBeNull();
    expect(projectCoordInboxForUi([null, 'x'])).toEqual([null, 'x']);
  });
});

describe('projectCoordPlansForUi', () => {
  it('drops now_state and clips now_next, keeping the rendered fields', () => {
    const rows = [
      {
        slug: 'my-plan',
        title: 'T',
        status: 'active',
        updated: '2026-07-19',
        item_count: 3,
        decision_count: 1,
        now_state: 'x'.repeat(4000),
        now_next: 'y'.repeat(900),
      },
    ];
    const out = projectCoordPlansForUi(rows) as Array<Record<string, unknown>>;
    expect(out[0]).not.toHaveProperty('now_state');
    expect((out[0].now_next as string).length).toBe(COORD_TEXT_PREVIEW_MAX);
    expect(out[0].now_next as string).toMatch(/…$/);
    expect(out[0].slug).toBe('my-plan');
    expect(out[0].title).toBe('T');
    expect(out[0].status).toBe('active');
    expect(out[0].item_count).toBe(3);
    expect(out[0].decision_count).toBe(1);
  });

  it('leaves a short/null now_next untouched', () => {
    const out = projectCoordPlansForUi([
      { slug: 'a', now_next: 'short', now_state: 's' },
      { slug: 'b', now_next: null, now_state: null },
    ]) as Array<Record<string, unknown>>;
    expect(out[0].now_next).toBe('short');
    expect(out[0]).not.toHaveProperty('now_state');
    expect(out[1].now_next).toBeNull();
  });

  it('is defensive against a non-array payload', () => {
    expect(projectCoordPlansForUi({ error: 'x' })).toEqual({ error: 'x' });
  });

  // WI-7256 — the unbounded-growth term: a scheduled plan mints one
  // `<template>@run-<token>` row per fire, permanently.
  describe('finished plan-run snapshots (WI-7256)', () => {
    it('drops a TERMINAL run instance but keeps its parent template', () => {
      const out = projectCoordPlansForUi([
        { slug: 'nightly-alert-2026-07-06', status: 'active' },
        { slug: 'nightly-alert-2026-07-06@run-1784241963690', status: 'superseded' },
        { slug: 'nightly-alert-2026-07-06@run-1784244243583', status: 'shipped' },
      ]) as Array<Record<string, unknown>>;
      expect(out.map((r) => r.slug)).toEqual(['nightly-alert-2026-07-06']);
    });

    it('KEEPS an in-flight run instance — it is minted `active`, not superseded', () => {
      // The whole reason the predicate tests status and not just the slug
      // shape: dropping every instance would hide a running scheduled plan.
      const out = projectCoordPlansForUi([
        { slug: 'nightly-alert@run-1784241963690', status: 'active' },
        { slug: 'nightly-alert@run-1784241963691', status: 'draft' },
        { slug: 'nightly-alert@run-1784241963692', status: 'ready' },
        { slug: 'nightly-alert@run-1784241963693', status: 'superseded' },
      ]) as Array<Record<string, unknown>>;
      expect(out.map((r) => r.status)).toEqual(['active', 'draft', 'ready']);
    });

    it('does not sweep up a human-authored slug that merely contains @run-', () => {
      const out = projectCoordPlansForUi([
        // no digit token
        { slug: 'plan-about-@run-semantics', status: 'superseded' },
        // token not at the end
        { slug: 'foo@run-123-notes', status: 'superseded' },
        // no template part before the separator
        { slug: '@run-123', status: 'superseded' },
      ]) as Array<Record<string, unknown>>;
      expect(out).toHaveLength(3);
    });

    it('still projects the surviving rows (now_state dropped, now_next clipped)', () => {
      const out = projectCoordPlansForUi([
        { slug: 'p@run-1', status: 'superseded', now_state: 'gone' },
        { slug: 'p', status: 'active', now_state: 'x'.repeat(9), now_next: 'y'.repeat(900) },
      ]) as Array<Record<string, unknown>>;
      expect(out).toHaveLength(1);
      expect(out[0]).not.toHaveProperty('now_state');
      expect((out[0].now_next as string).length).toBe(COORD_TEXT_PREVIEW_MAX);
    });
  });

  // WI-7256 second half — the LARGER growth term. Dropping terminal run
  // snapshots (above) bounded one population; ordinary authored plans accrue at
  // ~45-50/week and were never bounded at all. Measured 2026-08-31: 1,486 rows
  // / 634,634 B, past even the raised 390,000 ceiling.
  describe('recency window (WI-7256)', () => {
    const rows = (n: number, updated?: (i: number) => string | null) =>
      Array.from({ length: n }, (_, i) => ({
        slug: `plan-${String(i).padStart(5, '0')}`,
        status: 'active',
        updated: updated ? updated(i) : `2026-01-01`,
      }));

    it('does not window a corpus at or under the limit, and preserves its order', () => {
      const input = rows(COORD_PLANS_UI_WINDOW, (i) => `2026-01-${String((i % 28) + 1).padStart(2, '0')}`);
      const out = projectCoordPlansForUi(input) as Array<Record<string, unknown>>;
      expect(out).toHaveLength(COORD_PLANS_UI_WINDOW);
      expect(out.map((r) => r.slug)).toEqual(input.map((r) => r.slug));
    });

    it('caps an over-limit corpus at the window', () => {
      const out = projectCoordPlansForUi(rows(COORD_PLANS_UI_WINDOW + 500)) as unknown[];
      expect(out).toHaveLength(COORD_PLANS_UI_WINDOW);
    });

    it('keeps the most-recently-updated rows and drops the oldest', () => {
      // Oldest first on input, so an unwindowed/unsorted implementation would
      // keep exactly the wrong end — this is the assertion that fails if the
      // window is removed or the sort direction is flipped.
      const input = rows(COORD_PLANS_UI_WINDOW + 3, (i) => `2026-01-01`).map((r, i) => ({
        ...r,
        updated: `2026-${String(Math.floor(i / 400) + 1).padStart(2, '0')}-${String((i % 28) + 1).padStart(2, '0')}`,
      }));
      const newest = [...input].sort((a, b) => b.updated.localeCompare(a.updated))[0];
      const out = projectCoordPlansForUi(input) as Array<Record<string, unknown>>;
      expect(out[0].slug).toBe(newest.slug);
      expect(out.map((r) => r.updated).every((u) => u === out[0].updated || u! <= out[0].updated!)).toBe(true);
    });

    it('sorts rows with no `updated` last, so they are dropped first', () => {
      const dated = rows(COORD_PLANS_UI_WINDOW, () => '2026-06-01');
      const undated = rows(5, () => null).map((r) => ({ ...r, slug: `undated-${r.slug}` }));
      const out = projectCoordPlansForUi([...undated, ...dated]) as Array<Record<string, unknown>>;
      expect(out).toHaveLength(COORD_PLANS_UI_WINDOW);
      expect(out.some((r) => String(r.slug).startsWith('undated-'))).toBe(false);
    });

    it('is DETERMINISTIC when `updated` ties — input order cannot change the window', () => {
      // Load-bearing, not cosmetic: `updated` is DATE-granularity, so the
      // cutoff sits inside a tie, and coord.plans is delta-encoded. A window
      // whose membership depended on input order would emit spurious
      // add/remove deltas between two polls of unchanged data.
      const input = rows(COORD_PLANS_UI_WINDOW + 50, () => '2026-06-01');
      const shuffled = [...input].reverse();
      const a = projectCoordPlansForUi(input) as Array<Record<string, unknown>>;
      const b = projectCoordPlansForUi(shuffled) as Array<Record<string, unknown>>;
      expect(b.map((r) => r.slug)).toEqual(a.map((r) => r.slug));
    });

    it('CONTROL: these assertions FAIL against the pre-WI-7256 unwindowed projection', () => {
      // Falsifiability control (CLAUDE.md § "Proving a guard is falsifiable",
      // MODULE tier: a deliberately-wrong implementation kept permanently in
      // the test file, rather than mutating the shared tree). Without this,
      // "the window test passes" says nothing about whether it CAN fail.
      //
      // This is the exact pre-fix body: project each row, never window.
      const unwindowed = (input: Array<Record<string, unknown>>) =>
        input.map(({ now_state: _drop, ...rest }) => rest);

      // Index 0 is the OLDEST month, so an unwindowed/unsorted projection
      // surfaces the oldest row first and ordering is discriminated too.
      const input = rows(
        COORD_PLANS_UI_WINDOW + 500,
        (i) => `2026-${String((i % 12) + 1).padStart(2, '0')}-01`,
      );

      // The control violates BOTH properties the window guarantees...
      expect(unwindowed(input).length).toBeGreaterThan(COORD_PLANS_UI_WINDOW);
      const controlNewest = unwindowed(input)[0].updated;
      const trueNewest = [...input].sort((a, b) => String(b.updated).localeCompare(String(a.updated)))[0].updated;

      // ...and the REAL subject satisfies them (the calibration half — without
      // it, a broken subject would let the control pass vacuously too).
      const real = projectCoordPlansForUi(input) as Array<Record<string, unknown>>;
      expect(real).toHaveLength(COORD_PLANS_UI_WINDOW);
      expect(real[0].updated).toBe(trueNewest);
      expect(real[0].updated).not.toBe(controlNewest);
    });

    it('windows AFTER dropping terminal snapshots, so they cost no window slot', () => {
      const snapshots = Array.from({ length: 50 }, (_, i) => ({
        slug: `nightly@run-17842419636${String(i).padStart(2, '0')}`,
        status: 'superseded',
        updated: '2026-12-31', // newest, so an ordering bug would rank them first
      }));
      const real = rows(COORD_PLANS_UI_WINDOW, () => '2026-06-01');
      const out = projectCoordPlansForUi([...snapshots, ...real]) as Array<Record<string, unknown>>;
      expect(out).toHaveLength(COORD_PLANS_UI_WINDOW);
      expect(out.some((r) => String(r.slug).includes('@run-'))).toBe(false);
    });
  });
});
