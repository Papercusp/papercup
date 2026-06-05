/**
 * adv-overview-logic.test.ts — Brief 23 (overview-dashboard-2026-06-05).
 *
 * Unit-tests the PURE tile-derivation layer of AdvOverviewTab + the
 * click-through target map. Mirrors the package convention (adv-shell-logic,
 * adv-now-running-logic): test the logic, not a full mount (which needs real
 * ZQL sync + IPC + nuqs adapter).
 */

import { describe, expect, it } from 'vitest';
import type {
  PlanListRow,
  AttentionItem,
  AttentionKind,
  AttentionTier,
  Importance,
} from '@/app/admin/plans/plans-api';
import {
  planProgress,
  selectActivePlans,
  selectDecisions,
  countAlerts,
  selectLiveAgents,
  OVERVIEW_TILE_TARGETS,
  type OverviewRosterEntry,
} from '../adv/AdvOverviewTab';
import { ADV_TABS } from '../adv/AdvShell';

// ─── factories ───────────────────────────────────────────────────────────
function plan(over: Partial<PlanListRow> = {}): PlanListRow {
  return {
    slug: 'p',
    title: 'P',
    status: 'active',
    updated: '2026-06-05',
    owner: null,
    archived: false,
    isLegacy: false,
    itemCounts: null,
    nextAction: null,
    harness: 'all',
    startStatus: null,
    priority: null,
    ...over,
  };
}

function attn(over: Partial<AttentionItem> = {}): AttentionItem {
  return {
    id: Math.random().toString(36).slice(2),
    kind: 'coord-message' as AttentionKind,
    source: 'test',
    harnessSlug: null,
    planSlug: null,
    itemRef: null,
    title: 'item',
    body: '',
    status: 'open',
    importance: 'normal' as Importance,
    tier: 'activity' as AttentionTier,
    needsHuman: false,
    actions: [],
    ref: { kind: 'coord-message' } as AttentionItem['ref'],
    ...over,
  };
}

/** An attention item as the PRE-tier green :3070 host serves it (no `tier`
 *  on the wire) — exercises the wire-lag fallback path. */
function attnNoTier(over: Partial<AttentionItem> = {}): AttentionItem {
  const { tier: _tier, ...rest } = attn(over);
  return rest as AttentionItem;
}

function agent(over: Partial<OverviewRosterEntry> = {}): OverviewRosterEntry {
  return {
    ownerId: Math.random().toString(36).slice(2),
    label: 'su-x',
    intent: 'working',
    currentFiles: [],
    liveness: 'live',
    currentPlanSlug: null,
    role: null,
    agent: null,
    ...over,
  };
}

// ─── planProgress ──────────────────────────────────────────────────────────
describe('planProgress', () => {
  it('null counts → all zero', () => {
    expect(planProgress(null)).toEqual({ done: 0, total: 0, pct: 0 });
  });
  it('computes done/total/pct over active+done, excluding dropped/unknown', () => {
    const r = planProgress({ todo: 2, wip: 1, done: 3, dropped: 5, unknown: 9 });
    expect(r.done).toBe(3);
    expect(r.total).toBe(6); // 2 + 1 + 3
    expect(r.pct).toBe(50);
  });
  it('counts needs-human + blocked in the denominator', () => {
    const r = planProgress({ blocked: 1, 'needs-human': 1, done: 2 });
    expect(r.total).toBe(4);
    expect(r.pct).toBe(50);
  });
  it('zero total → 0% (no divide-by-zero)', () => {
    expect(planProgress({ dropped: 3 }).pct).toBe(0);
  });
});

// ─── selectActivePlans ─────────────────────────────────────────────────────
describe('selectActivePlans', () => {
  it('drops shipped / superseded / archived', () => {
    const rows = [
      plan({ slug: 'a', status: 'active' }),
      plan({ slug: 'b', status: 'shipped' }),
      plan({ slug: 'c', status: 'superseded' }),
      plan({ slug: 'd', status: 'active', archived: true }),
    ];
    expect(selectActivePlans(rows).map((p) => p.slug)).toEqual(['a']);
  });
  it('ranks started first, then active, then ready, then others', () => {
    const rows = [
      plan({ slug: 'ready', status: 'ready' }),
      plan({ slug: 'started', status: 'active', startStatus: 'started' }),
      plan({ slug: 'draft', status: 'draft' }),
      plan({ slug: 'active', status: 'active' }),
    ];
    expect(selectActivePlans(rows).map((p) => p.slug)).toEqual(['started', 'active', 'ready', 'draft']);
  });
  it('respects the limit', () => {
    const rows = Array.from({ length: 10 }, (_, i) => plan({ slug: `p${i}` }));
    expect(selectActivePlans(rows, 3)).toHaveLength(3);
  });
});

// ─── selectDecisions ───────────────────────────────────────────────────────
describe('selectDecisions', () => {
  it('keeps only tier=decision items (canonical Brief 21 path)', () => {
    const items = [
      attn({ id: '1', tier: 'decision' }),
      attn({ id: '2', tier: 'alert' }),
      attn({ id: '3', tier: 'activity', needsHuman: true }), // tier wins over needsHuman
    ];
    expect(selectDecisions(items).map((i) => i.id)).toEqual(['1']);
  });
  it('falls back to needsHuman when the wire has no tier (pre-deploy :3070)', () => {
    const items = [attnNoTier({ id: '1', needsHuman: true }), attnNoTier({ id: '2', needsHuman: false })];
    expect(selectDecisions(items).map((i) => i.id)).toEqual(['1']);
  });
  it('respects the limit', () => {
    const items = Array.from({ length: 8 }, () => attn({ tier: 'decision' }));
    expect(selectDecisions(items, 2)).toHaveLength(2);
  });
});

// ─── countAlerts ───────────────────────────────────────────────────────────
describe('countAlerts', () => {
  it('counts tier=alert items (canonical Brief 21 path)', () => {
    const items = [
      attn({ tier: 'alert' }),
      attn({ tier: 'alert' }),
      attn({ tier: 'decision' }),
      attn({ tier: 'activity' }),
    ];
    expect(countAlerts(items)).toBe(2);
  });
  it('falls back to non-decision smoke-fail + coord-escalation without tier', () => {
    const items = [
      attnNoTier({ kind: 'smoke-fail' }),
      attnNoTier({ kind: 'coord-escalation' }),
      attnNoTier({ kind: 'coord-message' }), // ignored
      attnNoTier({ kind: 'smoke-fail', needsHuman: true }), // a decision, not an alert
    ];
    expect(countAlerts(items)).toBe(2);
  });
});

// ─── selectLiveAgents ──────────────────────────────────────────────────────
describe('selectLiveAgents', () => {
  it('excludes stale agents', () => {
    const roster = [agent({ liveness: 'live' }), agent({ liveness: 'idle' }), agent({ liveness: 'stale' })];
    expect(selectLiveAgents(roster)).toHaveLength(2);
  });
  it('respects the limit', () => {
    const roster = Array.from({ length: 9 }, () => agent({ liveness: 'live' }));
    expect(selectLiveAgents(roster, 4)).toHaveLength(4);
  });
});

// ─── click-through targets ─────────────────────────────────────────────────
describe('OVERVIEW_TILE_TARGETS', () => {
  it('every tile targets a real AdvShell tab', () => {
    const ids = new Set(ADV_TABS.map((t) => t.id));
    for (const target of Object.values(OVERVIEW_TILE_TARGETS)) {
      expect(ids.has(target as (typeof ADV_TABS)[number]['id'])).toBe(true);
    }
  });
  it('covers all four tiles', () => {
    expect(Object.keys(OVERVIEW_TILE_TARGETS).sort()).toEqual(['activity', 'agents', 'needsYou', 'plans']);
  });
});
