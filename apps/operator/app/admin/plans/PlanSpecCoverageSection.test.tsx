// @vitest-environment jsdom
/**
 * PlanSpecCoverageSection — the plan-surface view of P-008's spec-coverage census (P-011).
 *
 * P-008 wired `evaluatePlanSpecCoverageGate` into the plan acceptance gate, but its
 * verdict was reachable only by ATTEMPTING A SHIP: a human saw THAT `plans:set-status`
 * refused, never WHICH clauses are uncovered or at WHICH revision — and nothing at all
 * while the plan was still green. This section renders the same verdict continuously.
 *
 * THREE CLASSES ARE PINNED HERE, and the second is the one D-018 was written for:
 *
 *  1. The SUBSCRIPTION contract: the census reads clauses, then evidence, then
 *     scorecards, so it must compute NOTHING until a human opens the section. A
 *     regression that drops the `enabled` gate changes no rendered output and shows up
 *     only as every plan view paying for a census it never displays.
 *
 *  2. The ADVISORY contract (D-018). The gate REPORTS far more than it REFUSES, and
 *     exactly one code — `spec_proof_stale` — is a failure. `reports` (unproven clauses,
 *     ungraded adequacy, undeclared falsifiers) must render as NOTICES: D-013/D-017 give
 *     the uncovered-clause refusal to P-013, so rendering one as a blocking error shows a
 *     human a failure no gate blocks on AND visually pre-empts a decision P-013 owns.
 *     These tests are named for the ruling so that widening it has to be deliberate.
 *
 *  3. BOUNDEDNESS (D-018). A truncated census makes every count a FLOOR. The truncation
 *     must render beside the counts, and must NOT be escalated into a refusal — refusing
 *     on a floor manufactures a stale verdict from a row that fell off the end of a read.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { NuqsTestingAdapter } from 'nuqs/adapters/testing';

type SyncCall = { queryName: string; enabled?: boolean; args?: Record<string, unknown> };
const { syncCalls, coverageRow } = vi.hoisted(() => ({
  syncCalls: [] as SyncCall[],
  coverageRow: { current: null as unknown },
}));

vi.mock('@papercusp/sync', () => ({
  onSyncBusEvent: () => () => {},
  useSyncQuery: (opts: { queryName: string; enabled?: boolean; args?: Record<string, unknown> }) => {
    syncCalls.push({ queryName: opts.queryName, enabled: opts.enabled, args: opts.args });
    const enabled = opts.enabled !== false;
    let data: unknown[] = [];
    if (enabled && opts.queryName === 'plans.specCoverage' && coverageRow.current) {
      data = [coverageRow.current];
    }
    return {
      data,
      loading: false,
      fetching: false,
      transport: 'sse' as const,
      invalidate: () => {},
      error: null,
    };
  },
}));

import { PlanSpecCoverageSection } from './PlanSpecCoverageSection';

const SLUG = 'plan-a';
/** The nuqs key the section opens on — `speccov=<slug>`. */
const OPEN = `?speccov=${SLUG}`;

function renderSection(searchParams: string) {
  return render(
    <NuqsTestingAdapter searchParams={searchParams}>
      <PlanSpecCoverageSection slug={SLUG} harnessSlug="papercusp" />
    </NuqsTestingAdapter>,
  );
}

const coverageCalls = () => syncCalls.filter((c) => c.queryName === 'plans.specCoverage');

function row(over: Record<string, unknown> = {}) {
  return {
    planSlug: SLUG,
    applicable: true,
    mode: 'enforced',
    satisfied: true,
    code: null,
    message: null,
    wouldBlock: [],
    reports: [],
    clauses: {
      total: 4,
      enforceable: 3,
      exempt: 1,
      draft: 0,
      inactive: 0,
      falsifierDeclared: 2,
    },
    coverage: {
      proven: 3,
      staleProof: 0,
      unproven: 0,
      staleProofClauses: [],
      unprovenSpecIds: [],
    },
    adequacy: { graded: 3, ungraded: 0, ungradedSpecIds: [] },
    bounded: {
      evidenceCensusLimit: 2000,
      evidenceRowsRead: 12,
      truncatedByLimit: false,
      adequacyClauseLimit: 200,
      adequacyTruncatedByLimit: false,
    },
    unavailableReason: null,
    ...over,
  };
}

afterEach(() => {
  cleanup();
  syncCalls.length = 0;
  coverageRow.current = null;
});

describe('PlanSpecCoverageSection subscription (P-011)', () => {
  it('subscribes but stays DISABLED while the section is closed', () => {
    coverageRow.current = row();
    renderSection('?');

    const calls = coverageCalls();
    // The subscription must EXIST, or the next assertion is vacuous.
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((c) => c.enabled === false)).toBe(true);
  });

  it('ENABLES the census once a human opens the section', () => {
    coverageRow.current = row();
    renderSection(OPEN);

    expect(coverageCalls().some((c) => c.enabled === true)).toBe(true);
  });

  it('scopes the census to this plan, so an open panel cannot render another plan’s verdict', () => {
    coverageRow.current = row();
    renderSection(OPEN);

    const call = coverageCalls().find((c) => c.enabled === true);
    expect(call?.args).toMatchObject({ planSlug: SLUG, harnessSlug: 'papercusp' });
  });
});

describe('PlanSpecCoverageSection advisory contract (D-018)', () => {
  it('REPORTS unproven clauses on a NOT-YET-ELIGIBLE plan without rendering a ship blocker', () => {
    // ⚠ RE-FRAMED by P-013, not weakened. This case used to be "unproven clauses are
    // permanently advisory, because P-013 owns the refusal". P-013 made that refusal, so
    // on an ELIGIBLE plan these now DO block (asserted in the next test).
    //
    // What survives is the migration lane, which is the half that still must not block: a
    // plan that has shipped, or has not been reconciled, reports `mode: 'report-only'` and
    // names its findings in `wouldBlock` WITHOUT refusing. Rendering those as a blocker
    // would refuse every unreconciled plan at once — the fleet-wide refusal the per-plan
    // migration exists to avoid.
    coverageRow.current = row({
      mode: 'report-only',
      satisfied: true,
      wouldBlock: ['2-enforceable-clause(s)-with-no-evidence'],
      reports: [
        'not-enforcing:not-yet-reconciled',
        '2-enforceable-clause(s)-with-no-evidence',
        '1-enforceable-clause(s)-without-a-current-adequacy-scorecard',
      ],
      coverage: {
        proven: 1,
        staleProof: 0,
        unproven: 2,
        staleProofClauses: [],
        unprovenSpecIds: ['SPEC-7', 'SPEC-9'],
      },
      adequacy: { graded: 2, ungraded: 1, ungradedSpecIds: ['SPEC-7'] },
    });
    renderSection(OPEN);

    // The reports render...
    expect(screen.getByTestId('plan-spec-coverage-reports')).toBeTruthy();
    expect(screen.getByText(/Advisory — reported, not enforced/)).toBeTruthy();
    expect(screen.getByText(/SPEC-7, SPEC-9/)).toBeTruthy();
    // ...and NOTHING renders as a refusal. This is the assertion that must fail if
    // anyone promotes an advisory report into a blocker at this surface.
    expect(screen.queryByTestId('plan-spec-coverage-blocking')).toBeNull();
    expect(screen.queryByText(/Ship BLOCKED/)).toBeNull();
  });

  it('renders an ENFORCED unproven-clause refusal as a REAL blocker (P-013)', () => {
    // The falsifier for the re-framing above. Without this case, the panel could render
    // EVERY unproven finding as advisory — including one the ship path will actually
    // refuse — and the test above would still pass. That failure mode is the worse
    // direction: a human reads "advisory", ships, and the gate refuses anyway.
    coverageRow.current = row({
      mode: 'enforced',
      satisfied: false,
      code: 'spec_clause_unproven',
      message: "plan 'p' cannot be marked shipped: 2 enforceable spec clause(s) have NO evidence bound",
      wouldBlock: ['2-enforceable-clause(s)-with-no-evidence'],
      coverage: {
        proven: 1,
        staleProof: 0,
        unproven: 2,
        staleProofClauses: [],
        unprovenSpecIds: ['SPEC-7', 'SPEC-9'],
      },
    });
    renderSection(OPEN);

    expect(screen.getByTestId('plan-spec-coverage-blocking')).toBeTruthy();
  });

  it('renders a blocker from the VERDICT, not from a known-code list', () => {
    // The regression guard for how `blocking` is computed. The panel read
    // `code === 'spec_proof_stale'`, so any refusal carrying a different code rendered as
    // advisory. Pinning an UNKNOWN code here fails if anyone re-introduces a hand-kept
    // list, and passes as long as the gate's own satisfied/mode verdict is what is read.
    coverageRow.current = row({
      mode: 'enforced',
      satisfied: false,
      code: 'some_future_refusal_code',
      message: 'refused for a reason this panel has never heard of',
    });
    renderSection(OPEN);

    expect(screen.getByTestId('plan-spec-coverage-blocking')).toBeTruthy();
  });

  it('renders spec_proof_stale as a REAL blocker — the one condition entitled to be one', () => {
    coverageRow.current = row({
      satisfied: false,
      code: 'spec_proof_stale',
      wouldBlock: ['1-clause(s)-proven-only-at-a-superseded-revision'],
      coverage: {
        proven: 2,
        staleProof: 1,
        unproven: 0,
        staleProofClauses: [
          { specId: 'SPEC-1', planItemId: 'P-001', currentRevision: 3, provenRevisions: [1] },
        ],
        unprovenSpecIds: [],
      },
    });
    renderSection(OPEN);

    expect(screen.getByTestId('plan-spec-coverage-blocking')).toBeTruthy();
    expect(screen.getByText(/Ship BLOCKED/)).toBeTruthy();
  });

  it('never renders a stale-proof clause without BOTH revisions', () => {
    // A coverage claim detached from the revision it was earned against is the defect
    // this whole plan exists to end — so the superseded AND current revisions must both
    // be on screen, not just the clause id.
    coverageRow.current = row({
      satisfied: false,
      code: 'spec_proof_stale',
      coverage: {
        proven: 0,
        staleProof: 1,
        unproven: 0,
        staleProofClauses: [
          { specId: 'SPEC-1', planItemId: 'P-001', currentRevision: 5, provenRevisions: [2] },
        ],
        unprovenSpecIds: [],
      },
    });
    renderSection(OPEN);

    const blocking = screen.getByTestId('plan-spec-coverage-blocking');
    expect(blocking.textContent).toContain('SPEC-1');
    expect(blocking.textContent).toContain('r2');
    expect(blocking.textContent).toContain('r5');
  });

  it('renders the gate’s OWN mode rather than re-deriving it', () => {
    coverageRow.current = row({ mode: 'report-only' });
    renderSection(OPEN);

    expect(screen.getByTestId('plan-spec-coverage-mode').textContent).toContain('report-only');
    expect(screen.getByText(/cannot refuse in its current state/)).toBeTruthy();
  });

  it('shows an undeclared-falsifier count rather than omitting it (D-016)', () => {
    // Omission reads as "all declared", which is the opposite of the truth.
    coverageRow.current = row({ clauses: { ...row().clauses, falsifierDeclared: 1 } });
    renderSection(OPEN);

    expect(screen.getByText(/Falsifiers declared: 1 of 3 enforceable/)).toBeTruthy();
  });
});

describe('PlanSpecCoverageSection boundedness (D-018)', () => {
  it('marks a truncated census as a FLOOR and does NOT escalate it to a refusal', () => {
    coverageRow.current = row({
      mode: 'report-only',
      reports: ['evidence-census-truncated'],
      bounded: {
        evidenceCensusLimit: 2000,
        evidenceRowsRead: 2000,
        truncatedByLimit: true,
        adequacyClauseLimit: 200,
        adequacyTruncatedByLimit: false,
      },
    });
    renderSection(OPEN);

    const notice = screen.getByTestId('plan-spec-coverage-truncated');
    expect(notice.textContent).toContain('FLOOR');
    expect(notice.textContent).toContain('2000');
    // A floor must never be rendered as a verdict.
    expect(screen.queryByTestId('plan-spec-coverage-blocking')).toBeNull();
  });

  it('renders the truncation BESIDE the counts, not instead of them', () => {
    coverageRow.current = row({
      mode: 'report-only',
      bounded: { ...row().bounded, truncatedByLimit: true, evidenceRowsRead: 2000 },
    });
    renderSection(OPEN);

    expect(screen.getByTestId('plan-spec-coverage-truncated')).toBeTruthy();
    expect(screen.getByTestId('plan-spec-coverage-counts')).toBeTruthy();
  });
});

describe('PlanSpecCoverageSection degraded reads (D-018 fail-open)', () => {
  it('never renders a FAILED census as a clean one', () => {
    coverageRow.current = row({
      applicable: false,
      code: 'spec_coverage_unavailable',
      unavailableReason: 'resolver-unavailable',
      clauses: null,
      coverage: null,
      adequacy: null,
      bounded: null,
    });
    renderSection(OPEN);

    const el = screen.getByTestId('plan-spec-coverage-unavailable');
    expect(el.textContent).toContain('NOT evidence');
    expect(screen.queryByTestId('plan-spec-coverage-counts')).toBeNull();
  });

  it('distinguishes "no clauses adopted" from "census failed"', () => {
    // Both are empty states; only one means the plan is clean.
    coverageRow.current = row({
      applicable: false,
      reports: ['no-first-class-spec-clauses'],
      clauses: { total: 0, enforceable: 0, exempt: 0, draft: 0, inactive: 0, falsifierDeclared: 0 },
      coverage: { proven: 0, staleProof: 0, unproven: 0, staleProofClauses: [], unprovenSpecIds: [] },
      adequacy: { graded: 0, ungraded: 0, ungradedSpecIds: [] },
    });
    renderSection(OPEN);

    expect(screen.getByTestId('plan-spec-coverage-none')).toBeTruthy();
    expect(screen.queryByTestId('plan-spec-coverage-unavailable')).toBeNull();
  });
});
