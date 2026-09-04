// @vitest-environment jsdom
/**
 * DetailPanel — close-gate (spec-test-adequacy) panel, P-011's rubric/testing surface.
 *
 * `specTestAdequacyCompletionGate` is a HARD gate on work_items:complete, and before this
 * section its verdict was reachable only by ATTEMPTING the close — a write with side
 * effects whose refusal names a rubric there was no read for.
 *
 * THREE CLASSES ARE PINNED HERE, and the third is the one this section lives or dies by:
 *
 *  1. The SUBSCRIPTION contract, mirroring the behavior-contract and prior-attempts
 *     suites: the gate is multi-table, so the section must compute NOTHING until a human
 *     opens it. A regression dropping the `enabled` gate changes no rendered output and
 *     shows up only as every work-item selection paying for a read it never displays.
 *
 *  2. The DISTINGUISHABILITY contract: "the gate does not judge this item" and "the gate
 *     could not be run" both render as no blockers. On a HARD gate the second must never
 *     read as a clean bill of health.
 *
 *  3. The LOWER-BOUND contract (D-020). The gate grades freshness against fingerprints the
 *     CALLER attests at close time about its own working tree; a read cannot have them, so
 *     currentness returns `unknown` — deliberately NOT `stale`. An `unknown` here means "a
 *     read cannot establish this", never "this clause fails". So the blocker must render
 *     as a NOTICE with the caveat STATED IN THE COPY, never as an error. Rendering it as a
 *     failure would tell a human a close is blocked on evidence that may be perfectly
 *     current — D-017's rule one level deeper.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { NuqsTestingAdapter } from 'nuqs/adapters/testing';

type SyncCall = { queryName: string; enabled?: boolean; args?: Record<string, unknown> };
const { syncCalls, adequacyRow } = vi.hoisted(() => ({
  syncCalls: [] as SyncCall[],
  adequacyRow: { current: null as unknown },
}));

const WORK_ITEM = {
  id: 'WI-1',
  harness: 'h1',
  family: 'issue',
  kind: 'bug',
  title: 'a selected work item',
  state: 'open',
};

vi.mock('@papercusp/sync', () => ({
  onSyncBusEvent: () => () => {},
  useSyncQuery: (opts: { queryName: string; enabled?: boolean; args?: Record<string, unknown> }) => {
    syncCalls.push({ queryName: opts.queryName, enabled: opts.enabled, args: opts.args });
    const enabled = opts.enabled !== false;
    let data: unknown[] = [];
    if (enabled && opts.queryName === 'workItems.detail') data = [WORK_ITEM];
    if (enabled && opts.queryName === 'workItems.specAdequacy' && adequacyRow.current) {
      data = [adequacyRow.current];
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
vi.mock('./useHarnessData', () => ({
  useHarnessFeature: () => ({ feature: null, loading: false, error: null, patchFeature: vi.fn() }),
  useHarnessIssues: () => ({ issues: [], patchIssue: vi.fn() }),
}));
vi.mock('@/lib/useLexicon', () => ({ useLexicon: () => (k: string) => k }));
vi.mock('@papercusp/papercusp-shared', () => ({ openFeatureChat: vi.fn() }));
vi.mock('../../harness/FeatureEditor', () => ({ default: () => null }));

import DetailPanel from './DetailPanel';

function renderDetail(searchParams: string) {
  return render(
    <NuqsTestingAdapter searchParams={searchParams}>
      <DetailPanel
        panelId={'p1' as never}
        panelType={'detail' as never}
        params={{ harnessSlug: 'h1' } as never}
        api={{ setTitle: vi.fn() } as never}
      />
    </NuqsTestingAdapter>,
  );
}

const adequacyCalls = () => syncCalls.filter((c) => c.queryName === 'workItems.specAdequacy');

/** 'h1::WI-1' is encodeScopedRef(slug, id) — the section follows the SELECTED item. */
const OPEN = '?sel=WI-1&wisa=h1%3A%3AWI-1';
const CLOSED = '?sel=WI-1';

const row = (over: Record<string, unknown> = {}) => ({
  workItemId: 'WI-1',
  rubricRef: 'spec-test-adequacy',
  classRef: null,
  attestationSupplied: false,
  verdict: { ok: true, applicable: true, checked: [], blockerReason: null, impactReport: null },
  verdictIsLowerBound: true,
  clauses: [],
  unavailableReason: null,
  ...over,
});

afterEach(() => {
  cleanup();
  syncCalls.length = 0;
  adequacyRow.current = null;
});

describe('close-gate panel — subscription contract', () => {
  it('computes NOTHING until a human opens the section', () => {
    adequacyRow.current = row();
    renderDetail(CLOSED);
    // The gate resolves a contract, then evidence, then scorecards. Paying for that on
    // every work-item selection is invisible in the output and expensive in aggregate.
    expect(adequacyCalls().every((c) => c.enabled === false)).toBe(true);
  });

  it('subscribes for the SELECTED item once opened', () => {
    adequacyRow.current = row();
    renderDetail(OPEN);
    const live = adequacyCalls().filter((c) => c.enabled);
    expect(live.length).toBeGreaterThan(0);
    expect(live[0].args).toMatchObject({ harnessSlug: 'h1', workItemId: 'WI-1' });
  });

  it('never sends a classRef, so the gate returns its real first refusal', () => {
    adequacyRow.current = row();
    renderDetail(OPEN);
    const live = adequacyCalls().filter((c) => c.enabled);
    // Sending a guessed class would silently grade the item under the wrong proof floor
    // — and hide the refusal that tells the reader which class to attest.
    expect(live[0].args).not.toHaveProperty('classRef');
  });
});

describe('close-gate panel — D-020 lower bound', () => {
  it('states the lower-bound caveat in the copy, not just in a field', () => {
    adequacyRow.current = row({
      verdict: {
        ok: false,
        applicable: true,
        checked: [],
        blockerReason: 'SPEC-1@3: unknown [freshness]',
        impactReport: null,
      },
    });
    renderDetail(OPEN);
    expect(screen.getByTestId('wi-spec-adequacy-lower-bound')).toBeTruthy();
    // A reader must be able to see WHY an unknown is not a failure without knowing D-020.
    expect(screen.getByTestId('wi-spec-adequacy-lower-bound').textContent).toMatch(
      /UNESTABLISHED rather than failed/i,
    );
  });

  it('renders the blocker VERBATIM as the gate emitted it', () => {
    const reason = 'SPEC-1@3: unknown [freshness]; SPEC-2@1: no current terminal complete scorecard';
    adequacyRow.current = row({
      verdict: { ok: false, applicable: true, checked: [], blockerReason: reason, impactReport: null },
    });
    renderDetail(OPEN);
    // Verbatim: the exact text work_items:complete would return, so a reader can act on it
    // without re-deriving what the gate meant.
    expect(screen.getByTestId('wi-spec-adequacy-blocker').textContent).toContain(reason);
  });

  it('shows an advisory impactReport as a NOTICE even on a PASSING verdict (D-017)', () => {
    adequacyRow.current = row({
      verdict: {
        ok: true,
        applicable: true,
        checked: ['SPEC-1@3'],
        blockerReason: null,
        impactReport: 'coverage edges pinned to superseded revisions: p/SPEC-9 edge@1 vs current@2.',
      },
    });
    renderDetail(OPEN);
    const impact = screen.getByTestId('wi-spec-adequacy-impact');
    expect(impact.textContent).toMatch(/reported, not enforced/i);
    // It is populated independently of `ok`; keying it off a refusal would hide exactly
    // the condition D-013 asked P-016 to report.
    expect(screen.getByTestId('wi-spec-adequacy-clear')).toBeTruthy();
  });
});

describe('close-gate panel — the empty cases stay distinguishable', () => {
  it('never lets a FAILED gate read as a clear close', () => {
    adequacyRow.current = row({ unavailableReason: 'resolver-unavailable' });
    renderDetail(OPEN);
    const el = screen.getByTestId('wi-spec-adequacy-unavailable');
    // The copy must actively deny the inference, because "no blocker shown" is precisely
    // what a reader would otherwise conclude on a hard gate.
    expect(el.textContent).toMatch(/NOT evidence that the close is clear/i);
  });

  it('separates "does not apply" from "could not be run"', () => {
    adequacyRow.current = row({
      verdict: { ok: true, applicable: false, checked: [], blockerReason: null, impactReport: null },
    });
    renderDetail(OPEN);
    expect(screen.getByTestId('wi-spec-adequacy-inapplicable')).toBeTruthy();
    expect(screen.queryByTestId('wi-spec-adequacy-unavailable')).toBeNull();
  });

  it('reports the rubric ROLE and the per-clause proof floor', () => {
    adequacyRow.current = row({
      classRef: 'plan-class-bugfix',
      attestationSupplied: true,
      clauses: [
        {
          specId: 'SPEC-1',
          revision: 3,
          behaviorClass: 'functional',
          mutationRequired: false,
          requiredTestLayers: ['l3'],
          requiredProofFloor: 'l4',
        },
      ],
    });
    renderDetail(OPEN);
    const text = screen.getByTestId('wi-detail-spec-adequacy').parentElement?.parentElement
      ?.parentElement?.textContent;
    expect(text).toContain('spec-test-adequacy');
    // The revision never leaves the specId's side — the defect this whole plan is about.
    expect(text).toContain('SPEC-1@r3');
    expect(text).toContain('floor L4');
  });
});
