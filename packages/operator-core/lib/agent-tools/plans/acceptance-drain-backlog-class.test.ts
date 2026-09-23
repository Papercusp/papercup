/**
 * P-016 of review-system-rework-reduction-2026-09-23 — the awaiting-acceptance
 * backlog classification.
 *
 * RSR-P-016-A: after the backlog pass, every awaiting-acceptance plan carries a
 * recorded classification of what blocks it.
 * RSR-P-016-B: each classified plan names the next repair action for its class.
 *
 * The pure classifier is tested directly; the writer is tested for recording the
 * class on the filing, and for picking the same canonical row the carry writer
 * and the sweep's duplicate retirement pick.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_STALLED_AFTER_DAYS } from '@papercusp/plan-parser';

const M = vi.hoisted(() => ({
  sql: vi.fn(),
  upsert: vi.fn(),
}));

vi.mock('@papercusp/db-org', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@papercusp/db-org')>();
  return { ...actual, getOrgPg: () => ({ sql: M.sql }) };
});
vi.mock('../../coord/condition-upsert', () => ({
  upsertConditionWorkItem: M.upsert,
}));

import { GATE_CODE_OWNERSHIP } from '../../agent-obligation-providers';
import {
  acceptanceDrainBacklogClass,
  ensureAcceptanceDrainFiling,
  planIdleDays,
  type AcceptanceDrainGateObservation,
} from './acceptance-drain-filing';

const NOW = new Date('2026-09-23T12:00:00.000Z');
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString().slice(0, 10);
const AUDIT_REPAIR = {
  kind: 'evidence-repair',
  repairVerb: 'plans:audit',
  nextVerb: { name: 'plans:get', args: { slug: 'p', harness: 'papercusp', shipReadiness: true } },
  instruction: "plan 'p' cannot be marked shipped: run plans:audit",
};

function classify(observation: AcceptanceDrainGateObservation | undefined, planUpdated: string | null) {
  return acceptanceDrainBacklogClass({
    planSlug: 'p',
    harnessSlug: 'papercusp',
    observation,
    planUpdated,
    now: NOW,
  });
}

describe('acceptanceDrainBacklogClass — the class and its next repair action', () => {
  it('reuses the plan lifecycle stall threshold rather than a second hand-picked number', () => {
    expect(classify({ satisfied: false, code: 'acceptance_unaudited' }, daysAgo(1)).stalledAfterDays).toBe(
      DEFAULT_STALLED_AFTER_DAYS,
    );
  });

  it('classifies a passing gate as ready, with the ship call as its action', () => {
    const c = classify({ satisfied: true }, daysAgo(90));
    expect(c.backlogClass).toBe('ready');
    expect(c.nextRepairAction.kind).toBe('ship');
    expect(c.nextRepairAction.verbs[0]).toEqual({
      name: 'plans:set-plan-status',
      args: { slug: 'p', harness: 'papercusp', status: 'shipped', expectedCurrent: 'awaiting-acceptance' },
    });
  });

  it('classifies a recently written plan owing author work as author-repair, quoting the gate repair', () => {
    const c = classify({ satisfied: false, code: 'acceptance_unaudited', repairAction: AUDIT_REPAIR }, daysAgo(5));
    expect(c.backlogClass).toBe('author-repair');
    expect(c.nextRepairAction.kind).toBe('gate-repair');
    expect(c.nextRepairAction.instruction).toBe(AUDIT_REPAIR.instruction);
    expect(c.nextRepairAction.verbs.map((v) => v.name)).toEqual(['plans:audit', 'plans:get']);
  });

  it('classifies an idle plan owing author work as an abandonment candidate whose FIRST action is the supersede decision', () => {
    const c = classify({ satisfied: false, code: 'acceptance_unaudited', repairAction: AUDIT_REPAIR }, daysAgo(45));
    expect(c.backlogClass).toBe('abandonment-candidate');
    expect(c.planIdleDays).toBe(45);
    expect(c.nextRepairAction.kind).toBe('abandonment-triage');
    expect(c.nextRepairAction.verbs[0]).toEqual({
      name: 'plans:set-plan-status',
      args: { slug: 'p', harness: 'papercusp', status: 'superseded', expectedCurrent: 'awaiting-acceptance' },
    });
    // The gate repair is still offered, second — a candidate is not a verdict.
    expect(c.nextRepairAction.verbs.slice(1).map((v) => v.name)).toEqual(['plans:audit', 'plans:get']);
    expect(c.nextRepairAction.instruction).toContain(AUDIT_REPAIR.instruction);
  });

  it('draws the abandonment line exactly at the threshold', () => {
    const at = classify({ satisfied: false, code: 'acceptance_unaudited' }, daysAgo(DEFAULT_STALLED_AFTER_DAYS));
    const below = classify({ satisfied: false, code: 'acceptance_unaudited' }, daysAgo(DEFAULT_STALLED_AFTER_DAYS - 1));
    expect(at.backlogClass).toBe('abandonment-candidate');
    expect(below.backlogClass).toBe('author-repair');
  });

  it('never calls a plan abandoned when its idle age is unreadable', () => {
    expect(classify({ satisfied: false, code: 'acceptance_unaudited' }, null).backlogClass).toBe('author-repair');
    expect(classify({ satisfied: false, code: 'acceptance_unaudited' }, 'not-a-date').backlogClass).toBe('author-repair');
  });

  it('keeps a plan waiting only on a grader in recruitment however old it is — the author owes nothing', () => {
    for (const code of ['acceptance_ungraded', 'self_graded_only']) {
      const c = classify({ satisfied: false, code }, daysAgo(200));
      expect(c.backlogClass).toBe('recruitment');
      expect(c.nextRepairAction.kind).toBe('recruit-grader');
      expect(c.nextRepairAction.verbs.length).toBeGreaterThan(0);
    }
  });

  it('classifies an unmeasured gate as unmeasured, never as author work to fix', () => {
    expect(classify({ satisfied: false }, daysAgo(90)).backlogClass).toBe('unmeasured');
    expect(classify({ satisfied: false, code: 'spec_coverage_unavailable' }, daysAgo(90)).backlogClass).toBe('unmeasured');
    expect(classify(undefined, daysAgo(90)).nextRepairAction.verbs[0]?.name).toBe('plans:get');
  });

  it('RSR-P-016-B population: every gate code the ownership map knows, at every age, yields a class with a callable next action', () => {
    const codes = Object.keys(GATE_CODE_OWNERSHIP);
    // Positive control: the population is the real map, not an empty list.
    expect(codes.length).toBeGreaterThan(10);
    const seen = new Set<string>();
    for (const code of codes) {
      for (const age of [0, DEFAULT_STALLED_AFTER_DAYS + 10]) {
        const c = classify({ satisfied: false, code }, daysAgo(age));
        seen.add(c.backlogClass);
        expect(c.nextRepairAction.instruction.length, `${code}@${age}d`).toBeGreaterThan(0);
        expect(c.nextRepairAction.verbs.length, `${code}@${age}d`).toBeGreaterThan(0);
        for (const v of c.nextRepairAction.verbs) expect(v.name, `${code}@${age}d`).toMatch(/^[a-z_]+:[a-z_-]+$/);
      }
    }
    expect([...seen].sort()).toEqual(['abandonment-candidate', 'author-repair', 'recruitment', 'unmeasured']);
  });
});

describe('planIdleDays', () => {
  it('counts whole days from a frontmatter date or datetime', () => {
    expect(planIdleDays('2026-09-20', NOW)).toBe(3);
    expect(planIdleDays('2026-09-23T11:00:00Z', NOW)).toBe(0);
    expect(planIdleDays(undefined, NOW)).toBeNull();
    expect(planIdleDays('', NOW)).toBeNull();
  });
});

describe('ensureAcceptanceDrainFiling — P-016 recording', () => {
  const input = {
    workspaceId: 'papercusp-workspace',
    harnessSlug: 'papercusp',
    planSlug: 'held-plan',
    code: 'acceptance_unaudited',
    message: 'run plans:audit',
    observedAt: NOW,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    M.sql.mockResolvedValue([{ feature_id: 'WI-CANON', harness_slug: 'papercusp' }]);
  });

  it('records the class and its next repair action on the filing when the plan write date is supplied', async () => {
    const result = await ensureAcceptanceDrainFiling({ ...input, planUpdated: daysAgo(60) });
    expect(result).toMatchObject({ outcome: 'already-open', id: 'WI-CANON', backlogClass: 'abandonment-candidate' });
    const update = M.sql.mock.calls[1]!;
    const patch = JSON.parse(update.find((v: unknown) => typeof v === 'string' && v.includes('backlogClass')) as string);
    expect(patch).toMatchObject({
      backlogClass: 'abandonment-candidate',
      planIdleDays: 60,
      backlogClassifiedAt: NOW.toISOString(),
      nextRepairAction: { kind: 'abandonment-triage' },
    });
  });

  it('leaves a recorded class untouched when the caller cannot supply the write date', async () => {
    const result = await ensureAcceptanceDrainFiling(input);
    expect(result).toEqual({ outcome: 'already-open', id: 'WI-CANON', ref: 'papercusp-workspace/papercusp/held-plan' });
    const update = M.sql.mock.calls[1]!;
    const patch = update.find((v: unknown) => typeof v === 'string' && v.includes('acceptanceDrainPlan')) as string;
    expect(patch).not.toContain('backlogClass');
  });

  it('adopts the canonical (oldest) open filing, the same row the carry writer and the sweep keep', async () => {
    await ensureAcceptanceDrainFiling(input);
    const select = (M.sql.mock.calls[0]![0] as string[]).join('?');
    expect(select).toMatch(/ORDER BY created_ts, feature_id\s+LIMIT 1/);
  });
});
