/**
 * Pane-coverage invariant — the mechanical enforcement of the owner mandate.
 *
 * OWNER MANDATE (Avi, 2026-07-25, verbatim): "WE NEED ALL ROUTINES SURFACED TO
 * THE USER IN ONE OF THE PANES IN THE LEFT HAND SIDEBAR THERE CAN BE NO
 * ROUTINES THAT DONT GET SURFACED THERE."
 *
 * WHY THIS FILE EXISTS: the invariant was previously carried by a COMMENT on a
 * hand-written array in AgentsTab.tsx — "so no routine can exist without
 * appearing in exactly one of the three panes" — and the comment was wrong.
 * `infra` appeared in no pane's category list, so 40 routines (39 of them
 * ACTIVE: git-sync, green-checkpoint, hive-git-gc, release/deploy sweeps) were
 * invisible in the rail. Nothing failed, because nothing was checking.
 *
 * These tests are the check. If someone adds an AutomationCategory and forgets
 * to surface it, or narrows a pane's list, this file goes red.
 */
import { describe, it, expect } from 'vitest';
import {
  AUTOMATION_CATEGORIES,
  BLENDER_PANE_CATEGORIES,
  DOCS_PANE_CATEGORIES,
  CATCH_ALL_PANE_CATEGORIES,
  classifyRoutine,
  type AutomationCategory,
} from './catalog';

/** Every pane in the left rail that renders scheduled work, by its category claim. */
const PANES: Record<string, readonly AutomationCategory[]> = {
  Blender: BLENDER_PANE_CATEGORIES,
  Docs: DOCS_PANE_CATEGORIES,
  Agents: CATCH_ALL_PANE_CATEGORIES,
};

describe('left-rail pane coverage', () => {
  it('surfaces EVERY automation category in some pane — the owner mandate', () => {
    const surfaced = new Set(Object.values(PANES).flat());
    const orphaned = AUTOMATION_CATEGORIES.filter((c) => !surfaced.has(c));
    expect(
      orphaned,
      `These categories are rendered by NO left-sidebar pane, so their routines are ` +
        `invisible to the owner: ${orphaned.join(', ')}. Every category must be claimed ` +
        `by a named pane or fall through to CATCH_ALL_PANE_CATEGORIES.`,
    ).toEqual([]);
  });

  it('surfaces each category in exactly ONE pane — no routine listed twice', () => {
    const seen = new Map<AutomationCategory, string>();
    const dupes: string[] = [];
    for (const [pane, cats] of Object.entries(PANES)) {
      for (const c of cats) {
        const prior = seen.get(c);
        if (prior) dupes.push(`${c} claimed by both ${prior} and ${pane}`);
        else seen.set(c, pane);
      }
    }
    expect(dupes).toEqual([]);
  });

  it('claims no category that does not exist', () => {
    const known = new Set<string>(AUTOMATION_CATEGORIES);
    for (const [pane, cats] of Object.entries(PANES)) {
      for (const c of cats) {
        expect(known.has(c), `${pane} claims unknown category "${c}"`).toBe(true);
      }
    }
  });

  it('derives the catch-all rather than hand-listing it', () => {
    // The specific failure this guards: a new category added to
    // AUTOMATION_CATEGORIES must land in the catch-all automatically, with no
    // one remembering to edit a pane. Simulating that is what makes this a
    // regression test and not a restatement of the implementation.
    const named = new Set([...BLENDER_PANE_CATEGORIES, ...DOCS_PANE_CATEGORIES]);
    const expected = AUTOMATION_CATEGORIES.filter((c) => !named.has(c));
    expect([...CATCH_ALL_PANE_CATEGORIES]).toEqual([...expected]);
    // …and it must be non-empty, or the catch-all pane renders nothing at all.
    expect(CATCH_ALL_PANE_CATEGORIES.length).toBeGreaterThan(0);
  });
});

describe('classifyRoutine is total', () => {
  /**
   * Real routine names sampled from the live table (2026-07-25), spanning every
   * category — including the `infra` names that were invisible. A classification
   * outside AUTOMATION_CATEGORIES would mean a routine that no pane can render.
   */
  const LIVE_SAMPLE: Array<[name: string, group: string | null]> = [
    ['git-sync', 'git-sync'],
    ['green-checkpoint', 'release'],
    ['hive-git-gc', null],
    ['release-trigger', 'release'],
    ['knowledge-pack-delivery', null],
    ['knowledge-pack-hygiene', null],
    ['improvement-watchdog', 'health'],
    ['improvement-implement', 'self-improvement'],
    ['bp-singleton-memory-precision-0', null],
    ['template-gym', null],
    ['pot-eval-battery', null],
    ['pot-wake', 'supervision'],
    ['wake-brain', null],
    ['hive-canary-sla', null],
    ['cross-hive-outbox-drain', 'health'],
    ['p2p-work-intake', 'health'],
    ['plan-item-orphan-reconcile', 'health'],
    ['loop-su-92bacd98-b714-4f44-a4fc-08e73ea7ca39', 'agent-loops'],
    ['prospector-cadence', null],
    ['some-brand-new-routine-nobody-anticipated', null],
  ];

  const surfaced = new Set(Object.values(PANES).flat());

  it.each(LIVE_SAMPLE)('classifies %s into a surfaced category', (name, group) => {
    const category = classifyRoutine(name, group);
    expect(AUTOMATION_CATEGORIES).toContain(category);
    expect(
      surfaced.has(category),
      `"${name}" classifies as "${category}", which no pane renders — it would be invisible.`,
    ).toBe(true);
  });
});
