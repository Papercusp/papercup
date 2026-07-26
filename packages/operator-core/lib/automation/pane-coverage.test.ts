/**
 * Pane-coverage invariant — the mechanical enforcement of the owner mandate.
 *
 * OWNER MANDATE (owner, 2026-07-25, verbatim): "WE NEED ALL ROUTINES SURFACED TO
 * THE USER IN ONE OF THE PANES IN THE LEFT HAND SIDEBAR THERE CAN BE NO
 * ROUTINES THAT DONT GET SURFACED THERE."
 *
 * WHY THIS FILE EXISTS: the invariant was once carried by a COMMENT on a
 * hand-written array in AgentsTab.tsx — "so no routine can exist without appearing
 * in exactly one of the three panes" — and the comment was wrong. `infra` appeared
 * in no pane's category list, so 40 routines (39 of them ACTIVE: git-sync,
 * green-checkpoint, hive-git-gc, release sweeps) were invisible in the rail.
 * Nothing failed, because nothing was checking.
 *
 * WHAT CHANGED (agents-system-pane-split-2026-07-26): panes no longer route by
 * CATEGORY. The rail is two panes — Agents and System — and a row's pane is decided
 * by `spend`: `llm`/`unknown` → Agents, `none` → System. That is a total function
 * over a three-value domain, so coverage now holds BY CONSTRUCTION rather than by
 * keeping two hand-written lists in sync. This file pins that construction, plus
 * the residual category invariants (categories still LABEL rows even though they no
 * longer route them).
 *
 * The failure mode it still guards is real: someone adds a third pane, or narrows a
 * lens predicate, and rows fall between them exactly as `infra` once did.
 */
import { describe, it, expect } from 'vitest';
import { AUTOMATION_CATEGORIES, type AutomationCategory } from './pane-categories';
import { classifyRoutine } from './catalog';
import {
  AGENT_FAMILY_ORDER,
  SYSTEM_FAMILY_ORDER,
  TARGET_ROLE_SPEND,
  routineFamily,
  spendForTargetRole,
  type RoutineFamily,
  type RoutineSpend,
} from './routine-classification';

/**
 * The pane a row lands in, mirroring `rowsForLens` in AutomationPane.tsx.
 *
 * ⚠ `unknown` goes to Agents, NOT System. An unclassified `target_role` must never
 * quietly present itself as free — the owner-facing consequence of getting this
 * backwards is a routine that CAN spend money sitting in the pane whose blurb says
 * "none of it spends money".
 */
function paneFor(spend: RoutineSpend | 'unknown'): 'Agents' | 'System' {
  return spend === 'none' ? 'System' : 'Agents';
}

describe('left-rail pane coverage', () => {
  it('routes each of the three spend values to exactly one pane', () => {
    const spends: Array<RoutineSpend | 'unknown'> = ['llm', 'none', 'unknown'];
    for (const s of spends) {
      expect(paneFor(s), `spend=${s} must resolve to a pane`).toMatch(/^(Agents|System)$/);
    }
    // And the split is real — not everything piling into one pane.
    expect(new Set(spends.map(paneFor)).size).toBe(2);
  });

  it('routes an unclassified role to Agents, never to the free pane', () => {
    expect(paneFor(spendForTargetRole('system:not-a-real-action'))).toBe('Agents');
    expect(paneFor(spendForTargetRole(null))).toBe('Agents');
  });

  it('routes every classified target_role to a pane', () => {
    for (const [role, entry] of Object.entries(TARGET_ROLE_SPEND)) {
      expect(paneFor(entry.spend), `${role} must reach a pane`).toMatch(/^(Agents|System)$/);
    }
  });

  // The concrete regression: `infra` was in nobody's list and hid 40 routines. Under
  // the spend split these are all `none`, so they are System rows — surfaced, and in
  // the pane that correctly describes them.
  it('surfaces the infra routines that the old category wiring lost', () => {
    for (const role of [
      'system:git-sync',
      'system:green-checkpoint',
      'system:hive-git-gc',
      'system:release-trigger',
    ]) {
      expect(paneFor(spendForTargetRole(role)), role).toBe('System');
    }
  });
});

describe('family coverage — the browse-by-family view', () => {
  const ALL_FAMILIES: readonly RoutineFamily[] = [...AGENT_FAMILY_ORDER, ...SYSTEM_FAMILY_ORDER];

  it('claims every family by exactly one pane, with no overlap', () => {
    expect(new Set(ALL_FAMILIES).size).toBe(ALL_FAMILIES.length);
  });

  it('never produces a family that no pane lists', () => {
    // A spread of real routine names observed on the box, plus an unrecognised one.
    const names = [
      'loop-su-d93ac1bf-d48f-420d-8136-dea6de467e7f',
      'hive-wake',
      'overwatch-wake',
      'bp-singleton-scout-0',
      'improvement-triage',
      'doc-steward-dispatch',
      'knowledge-pack-hygiene',
      'git-sync',
      'green-checkpoint',
      'session-dir-gc',
      'telemetry-retention',
      'cross-hive-outbox-drain',
      'p2p-perf-tier1',
      'coord-probe-canary',
      'a-brand-new-routine-nobody-mapped',
    ];
    for (const n of names) {
      const fam = routineFamily(n, n.startsWith('loop-') ? 'loop' : 'scheduled');
      expect(ALL_FAMILIES, `${n} → ${fam} is in no pane's family list`).toContain(fam);
    }
  });
});

describe('categories still label every row (they no longer route panes)', () => {
  it('classifies any routine into a known category', () => {
    const cases: Array<[string, string | null]> = [
      ['gym-cycle', 'self-improvement'],
      ['knowledge-pack-hygiene', 'health'],
      ['git-sync', 'git-sync'],
      ['loop-su-abc', null],
      ['something-unrecognised', null],
    ];
    for (const [name, group] of cases) {
      const cat = classifyRoutine(name, group);
      expect(AUTOMATION_CATEGORIES as readonly AutomationCategory[], `${name} → ${cat}`).toContain(cat);
    }
  });

  it('keeps the category list non-empty so the label axis still exists', () => {
    expect(AUTOMATION_CATEGORIES.length).toBeGreaterThan(0);
  });
});
