/**
 * P-008 picker model rules (learning-pot-scope-gate-2026-08-30).
 *
 * Fixtures here are built LOCALLY and deliberately not shared with
 * learning-pot-rail.test.ts. D-006's second half is exactly that: never let one
 * fixture builder define the shape, because a builder that always emits a
 * well-formed catalog is incapable of reproducing the cache-boundary payload
 * that crashed the Learning tab (WI-1397883). Several cases below construct
 * payloads the TYPE says are impossible for that reason.
 */
import { describe, expect, it } from 'vitest';
import type {
  AutomationArming,
  AutomationGymArm,
  AutomationLaneArm,
} from '@papercusp/operator-core/lib/automation/catalog';

import {
  FIRST_LANE_FOR_NEW_POT,
  buildPotPickerRows,
  filterPotPickerRows,
  potScopeWrite,
  type PotPickerRow,
} from './learning-pot-picker';

const gym = (harnessSlug: string, enabled = false): AutomationGymArm => ({
  harnessSlug,
  enabled,
  budgetUsd: null,
  spentUsd: 0,
  status: 'idle',
});

const lane = (
  potSlug: string,
  loopId: string,
  enabled = false,
  displayName = loopId,
): AutomationLaneArm =>
  ({ loopId, displayName, potSlug, enabled, budgetUsd: null }) as AutomationLaneArm;

/** `disabledPots` listed ⇒ those pots read 'off'; everything else reads 'on'. */
const scope = (disabledPots: string[]) =>
  ({ disabledPots, rows: [] }) as unknown as AutomationArming['potScope'];

const arming = (partial: Partial<AutomationArming>): AutomationArming =>
  ({
    gymPots: [],
    lanes: [],
    potScope: scope([]),
    ...partial,
  }) as AutomationArming;

/**
 * A POT in the workspace listing. `harnessProjects.lite` returns every project,
 * so `harness_kind` is what marks the ones that can actually learn — a bare
 * `{ slug }` is a repo, and the picker must not offer it.
 */
const pot = (slug: string) => ({ slug, harness_kind: 'hive' });

const bySlug = (rows: PotPickerRow[], slug: string) => {
  const row = rows.find((r) => r.potSlug === slug);
  if (!row) throw new Error(`no row for ${slug}`);
  return row;
};

describe('the picker population', () => {
  it('lists every pot in the workspace, not only the ones that learn', () => {
    const rows = buildPotPickerRows(
      [pot('alpha'), pot('beta'), pot('gamma')],
      arming({ gymPots: [gym('alpha', true)] }),
    );
    expect(rows.map((r) => r.potSlug).sort()).toEqual(['alpha', 'beta', 'gamma']);
  });

  it('INCLUDES a pot that carries arming but is missing from the project listing', () => {
    // The failure this prevents: such a pot would be invisible on the only
    // surface that can switch it off, so it would keep spending with no route
    // to stop it.
    const rows = buildPotPickerRows(
      [pot('alpha')],
      arming({ gymPots: [gym('ghost', true)] }),
    );
    expect(rows.map((r) => r.potSlug)).toContain('ghost');
  });

  it('does not duplicate a pot present in BOTH the listing and the arming block', () => {
    const rows = buildPotPickerRows(
      [pot('alpha')],
      arming({ gymPots: [gym('alpha', true)], lanes: [lane('alpha', 'l1', true)] }),
    );
    expect(rows.filter((r) => r.potSlug === 'alpha')).toHaveLength(1);
  });

  it('orders armed pots first, then by slug', () => {
    const rows = buildPotPickerRows(
      [pot('zeta'), pot('alpha'), pot('beta')],
      arming({ gymPots: [gym('zeta', true), gym('alpha')] }),
    );
    // zeta is armed so it leads despite sorting last alphabetically.
    expect(rows.map((r) => r.potSlug)).toEqual(['zeta', 'alpha', 'beta']);
  });
});

describe('what arming a row would ACTUALLY do (D-007)', () => {
  it('names the lanes that would RESUME when something is armed', () => {
    const rows = buildPotPickerRows(
      [pot('alpha')],
      arming({
        gymPots: [gym('alpha', true)],
        lanes: [lane('alpha', 'l1', true, 'Fleet EKG'), lane('alpha', 'l2', false, 'Dream')],
      }),
    );
    expect(bySlug(rows, 'alpha').consequence).toEqual({
      kind: 'resumes',
      lanes: ['Gym', 'Fleet EKG'],
    });
  });

  it('says the gate alone starts NOTHING when every lane is disarmed — the majority case', () => {
    // D-005 measured 47 of 54 pots in exactly this state. A picker that reports
    // these as now-learning after a gate flip is lying about spend.
    const rows = buildPotPickerRows(
      [pot('alpha')],
      arming({ gymPots: [gym('alpha', false)], lanes: [lane('alpha', 'l1', false)] }),
    );
    expect(bySlug(rows, 'alpha').consequence).toEqual({
      kind: 'starts-nothing',
      needsLane: 'Gym',
    });
    expect(bySlug(rows, 'alpha').neverLearned).toBe(false);
  });

  it('names the lane a NEVER-learned pot will start', () => {
    const rows = buildPotPickerRows([{ slug: 'fresh' }], arming({}));
    const row = bySlug(rows, 'fresh');
    expect(row.neverLearned).toBe(true);
    expect(row.laneCount).toBe(0);
    expect(row.consequence).toEqual({ kind: 'starts', lane: FIRST_LANE_FOR_NEW_POT });
  });

  it('falls back to a governor lane name when a disarmed pot has no gym row', () => {
    const rows = buildPotPickerRows(
      [pot('alpha')],
      arming({ lanes: [lane('alpha', 'l1', false, 'Regret mining')] }),
    );
    expect(bySlug(rows, 'alpha').consequence).toEqual({
      kind: 'starts-nothing',
      needsLane: 'Regret mining',
    });
  });
});

describe('the master gate is read, never guessed', () => {
  it('reports a switched-off pot as off', () => {
    const rows = buildPotPickerRows(
      [pot('alpha')],
      arming({ gymPots: [gym('alpha', true)], potScope: scope(['alpha']) }),
    );
    expect(bySlug(rows, 'alpha').learning).toBe('off');
  });

  it('reports UNKNOWN — never on — when the scope did not survive the cache boundary', () => {
    // The exact WI-1397883 payload: `potScope` absent from a catalog cached
    // before P-005 added it.
    const stale = { gymPots: [gym('alpha', true)], lanes: [] } as unknown as AutomationArming;
    expect(bySlug(buildPotPickerRows([pot('alpha')], stale), 'alpha').learning).toBe('unknown');
  });

  it('reports UNKNOWN when there is no arming payload at all', () => {
    expect(bySlug(buildPotPickerRows([pot('alpha')], null), 'alpha').learning).toBe('unknown');
  });

  it('survives a payload whose declared arrays are absent', () => {
    const partial = { potScope: scope([]) } as unknown as AutomationArming;
    expect(() => buildPotPickerRows([pot('alpha')], partial)).not.toThrow();
  });

  it('survives a null project listing', () => {
    expect(() => buildPotPickerRows(null, arming({ gymPots: [gym('alpha')] }))).not.toThrow();
  });
});

describe('search', () => {
  const rows = buildPotPickerRows(
    [{ slug: 'papercusp' }, { slug: 'calendar' }, { slug: 'cupboard' }],
    arming({}),
  );

  it('matches case-insensitively on a fragment', () => {
    expect(filterPotPickerRows(rows, 'CUP').map((r) => r.potSlug)).toEqual(['cupboard']);
  });

  it('matches a fragment anywhere in the slug, not just its start', () => {
    // 'cu' sits mid-slug in papercusp ("cusp") and at the head of cupboard.
    expect(filterPotPickerRows(rows, 'cu').map((r) => r.potSlug).sort()).toEqual([
      'cupboard',
      'papercusp',
    ]);
  });

  it('returns EVERY row for a blank or whitespace query, never none', () => {
    expect(filterPotPickerRows(rows, '')).toHaveLength(3);
    expect(filterPotPickerRows(rows, '   ')).toHaveLength(3);
    expect(filterPotPickerRows(rows, null)).toHaveLength(3);
  });

  it('returns nothing for a genuine non-match', () => {
    expect(filterPotPickerRows(rows, 'zzz')).toHaveLength(0);
  });
});

describe('the footer’s one write', () => {
  const rows = buildPotPickerRows([pot('alpha'), pot('beta')], arming({}));

  it('sends the whole selection in ONE call', () => {
    expect(potScopeWrite(rows, new Set(['alpha', 'beta']), false)).toEqual({
      pots: ['alpha', 'beta'],
      enabled: false,
    });
  });

  it('returns null for an empty selection instead of writing an empty audit event', () => {
    expect(potScopeWrite(rows, new Set(), true)).toBeNull();
  });

  it('never flips a pot the user cannot currently see', () => {
    // Selection left over from a previous search must not act on filtered-out
    // rows — the write is scoped to the VISIBLE list.
    const visible = filterPotPickerRows(rows, 'alpha');
    expect(potScopeWrite(visible, new Set(['alpha', 'beta']), false)).toEqual({
      pots: ['alpha'],
      enabled: false,
    });
  });
});
