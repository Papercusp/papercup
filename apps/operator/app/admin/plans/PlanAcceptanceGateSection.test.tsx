// @vitest-environment jsdom
/**
 * PlanAcceptanceGateSection — the plan-surface view of the acceptance gate verdict (P-011).
 *
 * `evaluatePlanAcceptanceGate` is called by `plans:set-status` and the unshipped-plans
 * audit and NOWHERE else, so its verdict was reachable only by attempting a ship. This
 * section renders it continuously: which rubric judges the plan, who graded it, and the
 * exact blocker.
 *
 * THE CLASS PINNED HERE IS THE INVERSE OF THE SIBLING COVERAGE SUITE. There, findings are
 * advisory and must not look like failures (D-018). Here the codes ARE real refusals, so
 * the burden moves onto the PASSES: five states are satisfied-but-not-clean, and
 * flattening any into a green claims a verification that never happened.
 *
 *   · `skipped`           — the gate did not APPLY; nothing was checked.
 *   · `forcedPast`        — a recorded human waiver of the code-truth family.
 *   · `vettedUnderWaiver` — a rubric vetted over a consult nobody critiqued.
 *   · `gradedVia:'minimum'` — a grader taken from BELOW the relevance floor.
 *   · `unknownRatedCriteria` — explicitly not-assessable outcomes.
 *
 * Each has a test named for the rule, so collapsing one into "passed" has to be deliberate.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { NuqsTestingAdapter } from 'nuqs/adapters/testing';

type SyncCall = { queryName: string; enabled?: boolean; args?: Record<string, unknown> };
const { syncCalls, gateRow } = vi.hoisted(() => ({
  syncCalls: [] as SyncCall[],
  gateRow: { current: null as unknown },
}));

vi.mock('@papercusp/sync', () => ({
  onSyncBusEvent: () => () => {},
  useSyncQuery: (opts: { queryName: string; enabled?: boolean; args?: Record<string, unknown> }) => {
    syncCalls.push({ queryName: opts.queryName, enabled: opts.enabled, args: opts.args });
    const enabled = opts.enabled !== false;
    let data: unknown[] = [];
    if (enabled && opts.queryName === 'plans.acceptanceGate' && gateRow.current) {
      data = [gateRow.current];
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

import { PlanAcceptanceGateSection } from './PlanAcceptanceGateSection';

const SLUG = 'plan-a';
const OPEN = `?gate=${SLUG}`;

function renderSection(searchParams: string) {
  return render(
    <NuqsTestingAdapter searchParams={searchParams}>
      <PlanAcceptanceGateSection slug={SLUG} />
    </NuqsTestingAdapter>,
  );
}

const gateCalls = () => syncCalls.filter((c) => c.queryName === 'plans.acceptanceGate');

function requirementSnapshot() {
  return {
    planSlug: SLUG, applicable: true, plan: { harnessSlug: 'papercusp' },
    completeness: { complete: true, truncated: false, problems: [] },
    readiness: { state: 'ready', nextRepair: null },
    grading: { vetting: { state: 'current' }, authorVerdict: { state: 'accepted' } },
    bars: [{
      barKey: 'R-1', criterionKey: 'complete-export', title: 'Complete export',
      model: 'Every selected record and attachment is exported.', method: 'Run the export fixture.',
      falsifier: 'An attachment is absent.', check: { kind: 'tests', files: ['export.integration.test.ts'] },
      replication: null, role: 'outcome', mandatory: true, requiredScope: ['tree'], evidencePlane: 'tree',
      requiredTestLayers: ['integration'], passRatings: ['healthy'], coversBarKeys: [],
      requirement: {
        intent: { request: 'Export all my work.', rationale: 'Keep a complete backup.',
          constraints: ['Include attachments.'], sourceRefs: ['request:original-export'] },
        acceptance: { condition: 'Every selected record and attachment is exported.', falsifier: 'An attachment is absent.',
          requiredScope: ['tree'], evidencePlane: 'tree', requiredTestLayers: ['integration'], passRatings: ['healthy'] },
        verification: { method: 'Run the export fixture.', check: { kind: 'tests', files: ['export.integration.test.ts'] }, replication: null },
      },
      readiness: { state: 'ready' },
      mappings: [{ planItemId: 'P-001', planItemStatus: 'done', specId: 'SPEC-EXPORT', specRevision: 2, sourceValId: 'VAL-EXPORT' }],
      workContracts: [{ workItemId: 'WI-1', specId: 'SPEC-EXPORT', specRevision: 2, current: true }],
      proof: { state: 'current', adequacy: { state: 'pass' }, evidenceRefs: ['run:failed', 'run:passed'],
        history: [
          { id: 1, evidenceRef: 'run:failed', workItemId: 'WI-1', specId: 'SPEC-EXPORT', specRevision: 1,
            matchesCurrentSpec: false, observedAt: '2026-09-04', currentness: { comparisonSupplied: true, overall: 'stale' },
            details: { adequacy: { outcome: 'failed' } } },
          { id: 2, evidenceRef: 'run:passed', workItemId: 'WI-1', specId: 'SPEC-EXPORT', specRevision: 2,
            matchesCurrentSpec: true, observedAt: '2026-09-05', currentness: { comparisonSupplied: true, overall: 'current' },
            details: { adequacy: { outcome: 'passed' } } },
        ] },
      grading: { state: 'pass', rating: 'healthy', history: [
        { scorecardId: 'EI-10', role: 'independent', createdBy: 'peer-grader', rubricRevision: 3,
          currentRevision: true, complete: true, rating: 'healthy', evidence: 'All export records matched.', createdAt: '2026-09-05' },
        { scorecardId: 'EI-11', role: 'author', createdBy: 'requirement-author', rubricRevision: 3,
          currentRevision: true, complete: true, authorVerdict: 'accept', reasoning: 'The independent evidence meets the promise.',
          supersedes: 'EI-10', createdAt: '2026-09-05' },
      ] },
    }],
  };
}

function row(over: Record<string, unknown> = {}) {
  return {
    planSlug: SLUG,
    satisfied: true,
    skipped: null,
    code: null,
    message: null,
    rubricId: 'RUB-1',
    gradedBy: 'su-someone-else',
    unknownRatedCriteria: [],
    gradedVia: null,
    forcedPast: null,
    vettedUnderWaiver: null,
    unavailableReason: null,
    ...over,
  };
}

afterEach(() => {
  cleanup();
  syncCalls.length = 0;
  gateRow.current = null;
});

describe('unified requirement inspection', () => {
  it('opens one requirement with its sections, failed history, independent grade, author verdict and scoped work links', () => {
    gateRow.current = row({ acceptanceBarContractSnapshot: requirementSnapshot() });
    renderSection(OPEN);
    const detail = screen.getByTestId('requirement-R-1') as HTMLDetailsElement;
    fireEvent.click(detail.querySelector('summary')!);
    expect(detail.open).toBe(true);
    for (const name of ['Intent', 'Acceptance (BAR)', 'Verification', 'Linked work and validation', 'Evidence history', 'Review history']) {
      expect(within(detail).getByRole('heading', { name })).toBeTruthy();
    }
    expect(within(detail).getByText('request:original-export')).toBeTruthy();
    expect(within(detail).getByText('run:failed')).toBeTruthy();
    expect(within(detail).getByText('run:passed')).toBeTruthy();
    expect(within(detail).getByText('independent')).toBeTruthy();
    expect(within(detail).getByText('author')).toBeTruthy();
    const work = within(detail).getAllByRole('link', { name: 'WI-1' })[0]!;
    expect(work.getAttribute('href')).toContain('wpop=papercusp%3A%3AWI-1');
    // Keep the current plan/expanded requirement while nuqs opens the popup.
    // WorkRefPill forwards the event; its caller must cancel native navigation.
    expect(fireEvent.click(work)).toBe(false);
    expect(detail.open).toBe(true);
    expect(screen.getByText('All requirements accepted.')).toBeTruthy();
    expect(screen.getByText(/release checks and deployment follow acceptance/)).toBeTruthy();
  });

  it('does not turn passing proof and independent grading into author acceptance', () => {
    const snapshot = requirementSnapshot();
    snapshot.grading.authorVerdict.state = 'missing';
    gateRow.current = row({ acceptanceBarContractSnapshot: snapshot });
    renderSection(OPEN);
    expect(screen.getByText('Acceptance incomplete.')).toBeTruthy();
    expect(screen.getByText('Not accepted')).toBeTruthy();
    expect(screen.queryByText('All requirements accepted.')).toBeNull();
  });

  it('keeps stale, partial and legacy data visibly unaccepted even when the process gate passes', () => {
    const snapshot = requirementSnapshot();
    snapshot.completeness.truncated = true;
    snapshot.applicable = false;
    snapshot.bars[0]!.proof.state = 'stale';
    snapshot.bars[0]!.readiness.state = 'blocked';
    delete (snapshot.bars[0] as { requirement?: unknown }).requirement;
    gateRow.current = row({ acceptanceBarContractSnapshot: snapshot });
    renderSection(OPEN);
    fireEvent.click(screen.getByTestId('requirement-R-1').querySelector('summary')!);
    expect(screen.getByText('Original intent was not recorded.')).toBeTruthy();
    expect(screen.getByTestId('requirements-incomplete').textContent).toContain('partial history');
    expect(screen.getByText('Not accepted')).toBeTruthy();
    expect(screen.queryByText('All requirements accepted.')).toBeNull();
  });

  it('shows an unavailable snapshot without presenting requirement acceptance', () => {
    gateRow.current = row({ acceptanceBarContractSnapshot: null, acceptanceBarContractSnapshotUnavailableReason: 'read failed' });
    renderSection(OPEN);
    expect(screen.getByTestId('requirement-details-unavailable').textContent).toContain('unverified');
    expect(screen.queryByText('All requirements accepted.')).toBeNull();
  });
});

describe('PlanAcceptanceGateSection subscription (P-011)', () => {
  it('subscribes but stays DISABLED while the section is closed', () => {
    gateRow.current = row();
    renderSection('?');

    const calls = gateCalls();
    // The subscription must EXIST, or the next assertion is vacuous.
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((c) => c.enabled === false)).toBe(true);
  });

  it('ENABLES the gate evaluation once a human opens the section', () => {
    gateRow.current = row();
    renderSection(OPEN);

    expect(gateCalls().some((c) => c.enabled === true)).toBe(true);
  });
});

describe('PlanAcceptanceGateSection blockers (P-011)', () => {
  it('renders the EXACT code and the gate’s message VERBATIM', () => {
    // The message names the concrete next action; summarizing it throws that away.
    const message =
      'plan cannot be marked shipped: 2 plan item(s) are unfinished. Finish them or force with a reason.';
    gateRow.current = row({
      satisfied: false,
      code: 'plan_items_unfinished',
      message,
      gradedBy: null,
    });
    renderSection(OPEN);

    const blocking = screen.getByTestId('plan-acceptance-gate-blocking');
    expect(blocking.textContent).toContain('plan_items_unfinished');
    expect(screen.getByText(message)).toBeTruthy();
  });

  it('names the rubric ROLE and the independent grader (the rubric verdict)', () => {
    gateRow.current = row({ rubricId: 'RUB-42', gradedBy: 'su-grader' });
    renderSection(OPEN);

    expect(screen.getByTestId('plan-acceptance-gate-rubric').textContent).toContain('RUB-42');
    expect(screen.getByTestId('plan-acceptance-gate-grader').textContent).toContain('su-grader');
  });

  it('says a self-grading does not satisfy the gate rather than leaving the grader blank', () => {
    // Blank reads as "graded"; the absence is the point.
    gateRow.current = row({ gradedBy: null });
    renderSection(OPEN);

    expect(screen.getByTestId('plan-acceptance-gate-grader').textContent).toContain(
      'No independent grading recorded',
    );
  });
});

describe('PlanAcceptanceGateSection caveated passes — a pass is not automatically clean', () => {
  it('renders a SKIPPED gate as "not checked", never as a pass', () => {
    gateRow.current = row({ satisfied: true, skipped: 'flag-off' });
    renderSection(OPEN);

    const el = screen.getByTestId('plan-acceptance-gate-skipped');
    expect(el.textContent).toContain('did NOT APPLY');
    expect(el.textContent).toContain('not a pass');
    expect(screen.getByTestId('plan-acceptance-gate-toggle').textContent).toContain('not checked');
    expect(screen.getByTestId('plan-acceptance-gate-toggle').textContent).not.toContain(
      '— passed',
    );
  });

  it('SHOWS a forced waiver and its reason — a force that is easy to hide is worth little', () => {
    gateRow.current = row({
      satisfied: true,
      forcedPast: {
        reason: 'shipping ahead of the audit backfill, tracked in WI-999',
        checks: ['acceptance_unaudited', 'plan_items_unfinished'],
      },
    });
    renderSection(OPEN);

    const forced = screen.getByTestId('plan-acceptance-gate-forced');
    expect(forced.textContent).toContain('WAIVED');
    expect(forced.textContent).toContain('shipping ahead of the audit backfill');
    // The specific checks that were waived must be named, not just "some were waived".
    expect(forced.textContent).toContain('acceptance_unaudited');
    expect(forced.textContent).toContain('plan_items_unfinished');
    // And the badge must not read as an unqualified pass.
    expect(screen.getByTestId('plan-acceptance-gate-toggle').textContent).toContain('caveats');
  });

  it('DISCLOSES a rubric vetted over a consult nobody critiqued', () => {
    gateRow.current = row({
      satisfied: true,
      vettedUnderWaiver: { consultId: 'CON-7', reason: 'reviewer pool empty' },
    });
    renderSection(OPEN);

    const el = screen.getByTestId('plan-acceptance-gate-vetting-waiver');
    expect(el.textContent).toContain('CON-7');
    expect(el.textContent).toContain('NO external critique');
    expect(screen.getByTestId('plan-acceptance-gate-toggle').textContent).toContain('caveats');
  });

  it('DISCLOSES a below-floor minimum-fill grader — the grading is real, the expertise match is not', () => {
    // unified-responder-selection-critique-and-grading-2026-08-30 D-002 accepts this
    // knowingly where no above-floor grader exists, and asks that it not be
    // rediscovered as a surprise. Same rendering contract as the vetting waiver.
    gateRow.current = row({ satisfied: true, gradedBy: 'su-below-floor', gradedVia: 'minimum' });
    renderSection(OPEN);

    const el = screen.getByTestId('plan-acceptance-gate-grader-minimum');
    expect(el.textContent).toContain('BELOW the relevance floor');
    expect(screen.getByTestId('plan-acceptance-gate-grader').textContent).toContain('su-below-floor');
    expect(screen.getByTestId('plan-acceptance-gate-toggle').textContent).toContain('caveats');
  });

  it('DISCLOSES criteria explicitly rated UNKNOWN — a process pass is not outcome evidence', () => {
    gateRow.current = row({ satisfied: true, unknownRatedCriteria: ['central-outcome'] });
    renderSection(OPEN);

    const el = screen.getByTestId('plan-acceptance-gate-unknown');
    expect(el.textContent).toContain('central-outcome');
    expect(el.textContent).toContain('UNKNOWN');
    expect(el.textContent).toContain('not verified');
    expect(screen.getByTestId('plan-acceptance-gate-toggle').textContent).toContain('caveats');
  });

  it('a FLOOR-selected grader is not a caveat — only a known below-floor fill is', () => {
    // The control for the case above: `gradedVia` being present must not by itself
    // dim a pass, or the disclosure degrades into noise on every graded plan.
    gateRow.current = row({ satisfied: true, gradedVia: 'floor' });
    renderSection(OPEN);

    expect(screen.queryByTestId('plan-acceptance-gate-grader-minimum')).toBeNull();
    expect(screen.getByTestId('plan-acceptance-gate-toggle').textContent).toContain('— passed');
    expect(screen.getByTestId('plan-acceptance-gate-toggle').textContent).not.toContain('caveats');
  });

  it('renders a genuinely clean pass as a plain pass', () => {
    // The control: without this, the caveat assertions above could pass vacuously by
    // labelling EVERYTHING a caveat.
    gateRow.current = row();
    renderSection(OPEN);

    expect(screen.getByTestId('plan-acceptance-gate-toggle').textContent).toContain('— passed');
    expect(screen.getByTestId('plan-acceptance-gate-toggle').textContent).not.toContain('caveats');
    expect(screen.queryByTestId('plan-acceptance-gate-skipped')).toBeNull();
    expect(screen.queryByTestId('plan-acceptance-gate-forced')).toBeNull();
    expect(screen.queryByTestId('plan-acceptance-gate-vetting-waiver')).toBeNull();
  });
});

describe('PlanAcceptanceGateSection degraded reads', () => {
  it('never renders a FAILED evaluation as a pass', () => {
    gateRow.current = row({
      satisfied: false,
      unavailableReason: 'resolver-unavailable',
      rubricId: null,
      gradedBy: null,
    });
    renderSection(OPEN);

    const el = screen.getByTestId('plan-acceptance-gate-unavailable');
    expect(el.textContent).toContain('NOT evidence');
    expect(screen.queryByTestId('plan-acceptance-gate-rubric')).toBeNull();
  });
});
