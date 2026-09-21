/**
 * P-020 of design-to-code-coverage-seam-2026-09-02 — the acceptance-drain sweep's
 * pure decision surface, tested without a database (the split spec-triad-sweep
 * uses for the same reason).
 *
 * What is actually at stake in each case is named in the test title: these are
 * the exclusions whose absence would either file work nobody can complete, or
 * re-file work that is already open.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const M = vi.hoisted(() => ({
  getFlag: vi.fn(),
  sql: vi.fn(),
  list: vi.fn(),
  evaluate: vi.fn(),
  ensure: vi.fn(),
  setState: vi.fn(),
}));

vi.mock('@papercusp/flags/server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@papercusp/flags/server')>();
  return { ...actual, getFlag: M.getFlag };
});
vi.mock('@papercusp/db-org', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@papercusp/db-org')>();
  return { ...actual, getOrgPg: () => ({ sql: M.sql }) };
});
vi.mock('../../workspace-registry', () => ({ activeWorkspaceId: () => 'papercusp-workspace' }));
vi.mock('../../work-scope-policy', () => ({ isHarnessInScope: () => true }));
vi.mock('./source', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./source')>();
  return { ...actual, listPlanIndexRowsForWorkspace: M.list };
});
vi.mock('../../plan-acceptance-gate', () => ({
  evaluatePlanAcceptanceGate: M.evaluate,
}));
vi.mock('./acceptance-drain-filing', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./acceptance-drain-filing')>();
  return { ...actual, ensureAcceptanceDrainFiling: M.ensure };
});
vi.mock('../../work-items', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../work-items')>();
  return { ...actual, setWorkItemState: M.setState };
});

import {
  ACCEPTANCE_DRAIN_MAX_FILINGS_PER_RUN,
  runAcceptanceDrainSweepOnce,
  selectAcceptanceDrainCandidates,
} from './acceptance-drain-sweep';
import {
  acceptanceDrainFilingBody,
  acceptanceDrainPlanRef,
} from './acceptance-drain-filing';

type Row = Parameters<typeof selectAcceptanceDrainCandidates>[0][number];

/**
 * A minimal PlanIndexRow-shaped fixture; only the fields the filter reads.
 *
 * ⚠ These keys are CAMELCASE on purpose. `PlanIndexRow` is `Omit<PlanRow,
 * 'content'>`, whose fields are `planSlug`/`harnessSlug` — NOT the snake_case
 * `plan_slug`/`harness_slug` of the underlying `harness_plans` columns. An
 * earlier version of this fixture used the column names, which matched an
 * earlier version of the filter, so both were wrong together and these tests
 * passed while the sweep dropped all 202 live rows and reported a clean no-op
 * tick. A fixture that encodes the same assumption as the code under test cannot
 * falsify it; keep this shape pinned to the real type.
 */
function row(over: Partial<Row>): Row {
  return {
    planSlug: 'a-plan',
    harnessSlug: 'papercusp',
    template: null,
    ...over,
  } as Row;
}

const WS = 'papercusp-workspace';

beforeEach(() => {
  vi.clearAllMocks();
  M.getFlag.mockResolvedValue(true);
  M.sql.mockResolvedValue([]);
  M.list.mockResolvedValue([]);
  M.evaluate.mockResolvedValue({
    satisfied: false,
    code: 'acceptance_unaudited',
    message: 'run plans:audit',
  });
  M.ensure.mockResolvedValue({
    outcome: 'created',
    id: 'WI-ACCEPTANCE',
    ref: `${WS}/papercusp/ordinary`,
  });
  M.setState.mockResolvedValue({ ok: true });
});

describe('selectAcceptanceDrainCandidates', () => {
  it('admits an ordinary held plan — the calibration case, so the exclusions below are not vacuous', () => {
    const rows = [row({ planSlug: 'ordinary' })];
    expect(selectAcceptanceDrainCandidates(rows, new Set(), WS).map((r) => r.planSlug)).toEqual([
      'ordinary',
    ]);
  });

  it('excludes rubric-template plans: they are exempt from carrying a rubric, so the item could never be completed', () => {
    const rows = [row({ planSlug: 'acceptance-something', template: 'rubric' })];
    expect(selectAcceptanceDrainCandidates(rows, new Set(), WS)).toEqual([]);
  });

  it('excludes a plan that already has an open filing, BEFORE the expensive gate would run', () => {
    const rows = [row({ planSlug: 'already-filed' })];
    const filed = new Set([`${WS}/papercusp/already-filed`]);
    expect(selectAcceptanceDrainCandidates(rows, filed, WS)).toEqual([]);
  });

  it('dedupes on the FULLY-QUALIFIED ref, so one tenant does not suppress another tenant s same-named plan', () => {
    const rows = [row({ planSlug: 'shared-name', harnessSlug: 'papercusp' })];
    // An open filing for the same slug under a DIFFERENT harness must not match.
    const filed = new Set([`${WS}/other-harness/shared-name`]);
    expect(selectAcceptanceDrainCandidates(rows, filed, WS).map((r) => r.planSlug)).toEqual([
      'shared-name',
    ]);
  });

  it('drops rows with no slug or no harness rather than filing an unaddressable item', () => {
    const rows = [
      row({ planSlug: null as unknown as string }),
      row({ harnessSlug: null as unknown as string }),
    ];
    expect(selectAcceptanceDrainCandidates(rows, new Set(), WS)).toEqual([]);
  });

  it('caps filings per run, so the first tick cannot file the whole measured backlog at once', () => {
    expect(ACCEPTANCE_DRAIN_MAX_FILINGS_PER_RUN).toBeGreaterThan(0);
    expect(ACCEPTANCE_DRAIN_MAX_FILINGS_PER_RUN).toBeLessThan(187);
  });
});

describe('runAcceptanceDrainSweepOnce — P-023 lifecycle characterization', () => {
  it('evaluates a newborn pending carry instead of deduping away its first gate read', async () => {
    M.list.mockResolvedValue([row({ planSlug: 'newborn' })]);
    M.sql.mockResolvedValue([{ ref: `${WS}/papercusp/newborn`, gate_observation: 'pending' }]);
    M.ensure.mockResolvedValue({
      outcome: 'already-open', id: 'WI-CARRY', ref: `${WS}/papercusp/newborn`,
    });

    const result = await runAcceptanceDrainSweepOnce({ workspaceId: WS });
    expect(M.evaluate).toHaveBeenCalledExactlyOnceWith('newborn');
    expect(M.ensure).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      planSlug: 'newborn', code: 'acceptance_unaudited',
    }));
    expect(result).toMatchObject({ alreadyFiled: 1, refreshed: 1, filed: [], errors: [] });
  });

  it('re-evaluates an open filing and keeps the same keyed row instead of minting a sibling', async () => {
    M.list.mockResolvedValue([row({ planSlug: 'already-filed' })]);
    M.sql.mockResolvedValue([{ ref: `${WS}/papercusp/already-filed` }]);

    const result = await runAcceptanceDrainSweepOnce({ workspaceId: WS });

    expect(result).toMatchObject({
      scanned: 1,
      alreadyFiled: 1,
      filed: [],
      refreshed: 1,
      shippableNow: 0,
    });
    expect(M.evaluate).toHaveBeenCalledExactlyOnceWith('already-filed');
    expect(M.ensure).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ planSlug: 'already-filed' }));
  });

  it('provides the control: a held plan without a filing reaches the live gate and filer', async () => {
    M.list.mockResolvedValue([row({ planSlug: 'ordinary' })]);

    const result = await runAcceptanceDrainSweepOnce({ workspaceId: WS });

    expect(M.evaluate).toHaveBeenCalledWith('ordinary');
    expect(M.ensure).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: WS,
        harnessSlug: 'papercusp',
        planSlug: 'ordinary',
        code: 'acceptance_unaudited',
      }),
    );
    expect(result.filed).toEqual([
      { planSlug: 'ordinary', harnessSlug: 'papercusp', code: 'acceptance_unaudited', workItemId: 'WI-ACCEPTANCE' },
    ]);
  });

  it('closes the keyed filing only after the plan leaves awaiting-acceptance terminally', async () => {
    M.list.mockResolvedValue([]);
    M.sql.mockResolvedValue([{
      feature_id: 'WI-SHIPPED',
      harness_slug: 'papercusp',
      ref: `${WS}/papercusp/shipped-plan`,
      gate_observation: 'ready',
      payload: { acceptanceDrainPlan: `${WS}/papercusp/shipped-plan`, gateObservation: 'ready' },
      plan_status: 'shipped',
      archived: false,
    }]);
    const result = await runAcceptanceDrainSweepOnce({ workspaceId: WS });
    expect(result).toMatchObject({ reconciled: 1 });
    expect(M.setState).toHaveBeenCalledWith('WI-SHIPPED', 'resolved', expect.objectContaining({
      by: 'system:acceptance-drain',
      completionRef: expect.stringContaining('shipped'),
    }));
  });
});

describe('acceptanceDrainPlanRef', () => {
  it('qualifies the ref with workspace and harness', () => {
    expect(
      acceptanceDrainPlanRef({ workspaceId: WS, harnessSlug: 'papercusp', planSlug: 'p' }),
    ).toBe(`${WS}/papercusp/p`);
  });
});

describe('acceptanceDrainFilingBody', () => {
  const GATE_MESSAGE =
    "plan 'x' cannot be marked shipped: it has no code-truth audit. " +
    "plans:audit { slug:'x', items:[{ itemId, verdict, citations }] }.";

  it('quotes the gate s own repair text verbatim rather than paraphrasing it', () => {
    // The whole point of the filing: the gate already writes a precise repair and
    // it was simply never delivered. A paraphrase here would be a second copy of
    // the instruction, free to drift from the gate that enforces it.
    const body = acceptanceDrainFilingBody('x', 'acceptance_unaudited', GATE_MESSAGE);
    expect(body).toContain(GATE_MESSAGE);
  });

  it('names the blocker code, so the item is actionable without re-running the gate', () => {
    const body = acceptanceDrainFilingBody('x', 'acceptance_unaudited', GATE_MESSAGE);
    expect(body).toContain('acceptance_unaudited');
  });

  it('warns that the gate short-circuits, so clearing one code is not read as finishing', () => {
    const body = acceptanceDrainFilingBody('x', 'acceptance_unaudited', GATE_MESSAGE);
    expect(body).toMatch(/SHORT-CIRCUIT/i);
  });

  it('steers off the rubric-first mistake D-032 measured — the reason this sweep exists at all', () => {
    const body = acceptanceDrainFilingBody('x', 'acceptance_unaudited', GATE_MESSAGE);
    expect(body).toMatch(/do not author a rubric first/i);
  });

  it('states that not shipping is a legitimate resolution, so the item is not a wall either', () => {
    const body = acceptanceDrainFilingBody('x', 'acceptance_unaudited', GATE_MESSAGE);
    expect(body).toMatch(/should not ship at all/i);
  });
});
