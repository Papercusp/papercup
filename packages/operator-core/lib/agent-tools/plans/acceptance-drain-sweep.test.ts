/**
 * P-020 of design-to-code-coverage-seam-2026-09-02 — the acceptance-drain sweep's
 * pure decision surface, tested without a database (the split spec-triad-sweep
 * uses for the same reason).
 *
 * What is actually at stake in each case is named in the test title: these are
 * the exclusions whose absence would either file work nobody can complete, or
 * re-file work that is already open.
 */
import { describe, expect, it } from 'vitest';
import {
  ACCEPTANCE_DRAIN_MAX_FILINGS_PER_RUN,
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
