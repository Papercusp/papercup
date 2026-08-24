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
 * the burden moves onto the PASSES: three states are satisfied-but-not-clean, and
 * flattening any into a green claims a verification that never happened.
 *
 *   · `skipped`           — the gate did not APPLY; nothing was checked.
 *   · `forcedPast`        — a recorded human waiver of the code-truth family.
 *   · `vettedUnderWaiver` — a rubric vetted over a consult nobody critiqued.
 *
 * Each has a test named for the rule, so collapsing one into "passed" has to be deliberate.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
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

function row(over: Record<string, unknown> = {}) {
  return {
    planSlug: SLUG,
    satisfied: true,
    skipped: null,
    code: null,
    message: null,
    rubricId: 'RUB-1',
    gradedBy: 'su-someone-else',
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
