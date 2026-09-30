// @vitest-environment jsdom
/**
 * PlanProvenance — plan-item-provenance-2026-09-29 P-005 / R-6.
 *
 * R-6's falsifier, pinned directly: "an item renders with no visible provenance label, or
 * a rejected request is listed after covered ones." Plus the two rulings the panel exists
 * to carry:
 *
 *  · D-006 — chips visible WITHOUT expanding anything; the subscription is NOT gated on a
 *    toggle (a gated query would render no chip until a click — the unread fold R-6 bans).
 *  · D-007 — "Your words" only for an affirmative owner verdict; `unknown` is "Origin
 *    unknown", never the owner and never the agent.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { NuqsTestingAdapter, type OnUrlUpdateFunction } from 'nuqs/adapters/testing';

import type { PlanProvenanceView } from '@papercusp/operator-core/lib/plan-provenance-read';

type SyncCall = { queryName: string; enabled?: boolean; args?: Record<string, unknown> };
const { syncCalls, viewRow, loading } = vi.hoisted(() => ({
  syncCalls: [] as SyncCall[],
  viewRow: { current: null as unknown },
  loading: { current: false },
}));

vi.mock('@papercusp/sync', () => ({
  onSyncBusEvent: () => () => {},
  useSyncQuery: (opts: { queryName: string; enabled?: boolean; args?: Record<string, unknown> }) => {
    syncCalls.push({ queryName: opts.queryName, enabled: opts.enabled, args: opts.args });
    const enabled = opts.enabled !== false;
    const data = enabled && opts.queryName === 'plans.provenance' && viewRow.current ? [viewRow.current] : [];
    return {
      data,
      loading: loading.current,
      fetching: false,
      transport: 'sse' as const,
      invalidate: () => {},
      error: null,
    };
  },
}));

import { itemChipText, PlanProvenance, speakerText } from './PlanProvenance';

const SLUG = 'plan-a';
const OWNER_REF = 'session_turn:claude:s1:0';
const AGENT_REF = 'session_turn:claude:s1:1';
const UNKNOWN_REF = 'session_turn:claude:s1:2';

function view(over: Partial<PlanProvenanceView> = {}): PlanProvenanceView {
  return {
    planSlug: SLUG,
    harnessSlug: 'papercusp',
    status: 'audited',
    audit: { auditSeq: 3, createdAt: '2026-09-29T00:00:00Z', createdBy: 'su-x', enforced: true },
    grandfathered: false,
    auditedRevision: { id: 10, seq: 4, contentHash: 'h4' },
    currentRevision: { seq: 4, contentHash: 'h4' },
    stale: false,
    unauditedItems: [],
    counts: { owner: 1, derived: 1, 'agent-added': 1, unresolved: 1, 'not-audited': 0 },
    items: [
      {
        itemId: 'P-001',
        text: 'Owner-asked thing',
        label: 'owner',
        mappingIds: ['M-1'],
        sources: [
          { ref: OWNER_REF, speaker: 'user', verdict: 'owner-typed', owner: true, excerpt: 'please build X' },
        ],
      },
      { itemId: 'P-002', text: 'Follows from P-001', label: 'derived', derivedFrom: ['P-001'], mappingIds: [], sources: [] },
      { itemId: 'P-003', text: 'Agent idea', label: 'agent-added', agentReason: 'needed for tests', mappingIds: [], sources: [] },
      {
        itemId: 'P-004',
        text: 'Self-cited',
        label: 'unresolved',
        reason: 'no_owner_ref',
        mappingIds: ['M-2'],
        sources: [
          { ref: AGENT_REF, speaker: 'assistant', verdict: 'not-user-turn', owner: false, excerpt: 'I will do Y' },
          { ref: UNKNOWN_REF, speaker: null, verdict: 'unknown', owner: false, excerpt: null },
        ],
      },
    ],
    // The read model's order: rejected, open, repaired, covered.
    requests: [
      { mappingId: 'M-3', requirement: 'Dropped request', disposition: 'rejected', planTargets: [], sources: [] },
      { mappingId: 'M-4', requirement: 'Open request', disposition: 'open', planTargets: [], sources: [] },
      {
        mappingId: 'M-1',
        requirement: 'Build X',
        disposition: 'covered',
        planTargets: ['P-001'],
        sources: [{ ref: OWNER_REF, speaker: 'user', verdict: 'owner-typed', owner: true, excerpt: 'please build X' }],
      },
    ],
    repairedOmissions: [],
    rejectedOrSuperseded: [],
    unresolvedBlockers: [],
    ...over,
  };
}

function renderPanel(searchParams = '', onUrlUpdate?: OnUrlUpdateFunction) {
  return render(
    <NuqsTestingAdapter searchParams={searchParams} onUrlUpdate={onUrlUpdate}>
      <PlanProvenance slug={SLUG} harnessSlug="papercusp" />
    </NuqsTestingAdapter>,
  );
}

afterEach(() => {
  cleanup();
  syncCalls.length = 0;
  viewRow.current = null;
  loading.current = false;
});

describe('PlanProvenance — R-6: every item carries a visible label', () => {
  it('subscribes to plans.provenance ungated (D-006: no chip may wait behind a click)', () => {
    viewRow.current = view();
    renderPanel();
    const calls = syncCalls.filter((c) => c.queryName === 'plans.provenance');
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((c) => c.enabled !== false)).toBe(true);
    expect(calls[0]?.args).toEqual({ planSlug: SLUG, harnessSlug: 'papercusp' });
  });

  it('renders a non-empty chip for every item with nothing expanded', () => {
    viewRow.current = view();
    renderPanel();
    const rows = screen.getAllByTestId('plan-provenance-item');
    expect(rows.map((r) => r.getAttribute('data-item-id'))).toEqual(['P-001', 'P-002', 'P-003', 'P-004']);
    for (const row of rows) {
      const chip = within(row).getByTestId('plan-provenance-chip');
      expect(chip.textContent?.trim()).not.toBe('');
      expect(chip.getAttribute('aria-expanded')).toBe('false');
    }
    expect(rows.map((r) => within(r).getByTestId('plan-provenance-chip').textContent)).toEqual([
      'Yours',
      'Derived from P-001',
      'Agent-added',
      'Unresolved: cites only non-owner turns',
    ]);
    // Nothing was expanded to get there.
    expect(screen.queryAllByTestId('plan-provenance-quote')).toHaveLength(0);
  });

  it('labels items a pre-audit plan cannot trace as Not audited, with the no-audit notice', () => {
    viewRow.current = view({
      status: 'no-audit',
      audit: null,
      auditedRevision: null,
      counts: { owner: 0, derived: 0, 'agent-added': 0, unresolved: 0, 'not-audited': 1 },
      items: [{ itemId: 'P-001', text: 'x', label: 'not-audited', mappingIds: [], sources: [] }],
      requests: [],
    });
    renderPanel();
    expect(screen.getByTestId('plan-provenance-chip').textContent).toBe('Not audited');
    expect(screen.getByTestId('plan-provenance-no-audit')).toBeTruthy();
    expect(screen.queryByTestId('plan-provenance-requests')).toBeNull();
  });
});

describe('PlanProvenance — R-6: "What you asked for" puts rejected and open first', () => {
  it('lists every request with rejected before open before covered', () => {
    viewRow.current = view();
    renderPanel();
    const dispositions = screen
      .getAllByTestId('plan-provenance-request')
      .map((r) => r.getAttribute('data-disposition'));
    expect(dispositions).toEqual(['rejected', 'open', 'covered']);
    expect(dispositions.indexOf('rejected')).toBeLessThan(dispositions.indexOf('covered'));
    expect(screen.getByText('Dropped request')).toBeTruthy();
  });
});

describe('PlanProvenance — R-6: the staleness line', () => {
  it('names the items added after the audit and both revisions', () => {
    viewRow.current = view({
      stale: true,
      currentRevision: { seq: 6, contentHash: 'h6' },
      unauditedItems: ['P-006', 'P-007'],
    });
    renderPanel();
    const line = screen.getByTestId('plan-provenance-stale').textContent ?? '';
    expect(line).toContain('audited r4, now r6');
    expect(line).toContain('2 item(s) added since: P-006, P-007');
  });

  it('shows no staleness line when the audit covers the current plan', () => {
    viewRow.current = view();
    renderPanel();
    expect(screen.queryByTestId('plan-provenance-stale')).toBeNull();
  });
});

describe('PlanProvenance — D-007: labels never overclaim owner speech', () => {
  it('opens an item quote via nuqs and labels owner, agent and unknown turns distinctly', () => {
    viewRow.current = view();
    renderPanel(`?prov=${SLUG}:item:P-004`);
    const quotes = screen.getAllByTestId('plan-provenance-quote');
    expect(quotes.map((q) => q.getAttribute('data-verdict'))).toEqual(['not-user-turn', 'unknown']);
    expect(quotes[0]?.textContent).toContain("The agent's words");
    expect(quotes[1]?.textContent).toContain('Origin unknown');
    expect(screen.queryByText('Your words')).toBeNull();
    expect(quotes[1]?.textContent).toContain('Turn text could not be read.');
  });

  it('says "Your words" only for an affirmative owner verdict', () => {
    expect(speakerText({ owner: true, verdict: 'owner-typed' })).toBe('Your words');
    expect(speakerText({ owner: false, verdict: 'unknown' })).toBe('Origin unknown');
    expect(speakerText({ owner: false, verdict: 'not-user-turn' })).toBe("The agent's words");
    expect(speakerText({ owner: false, verdict: 'agent-injected' })).toBe('Injected by the system');
    // `owner` is the read model's statement — an owner-shaped verdict without it is not the owner.
    expect(speakerText({ owner: false, verdict: 'owner-typed' })).not.toBe('Your words');
  });

  it('writes the expansion to the URL so ui:get_state can see it', async () => {
    viewRow.current = view();
    const onUrlUpdate = vi.fn<OnUrlUpdateFunction>();
    renderPanel('', onUrlUpdate);
    const firstChip = within(screen.getAllByTestId('plan-provenance-item')[0]!).getByTestId('plan-provenance-chip');
    fireEvent.click(firstChip);
    // nuqs flushes URL writes on a throttled tick, not synchronously.
    await waitFor(() => expect(onUrlUpdate).toHaveBeenCalled());
    const last = onUrlUpdate.mock.calls.at(-1)?.[0];
    expect(last?.searchParams.get('prov')).toBe(`${SLUG}:item:P-001`);
  });
});

describe('PlanProvenance — failure states', () => {
  it('a missing row renders as unavailable, never as a clean plan', () => {
    viewRow.current = null;
    renderPanel();
    expect(screen.getByTestId('plan-provenance-unavailable').textContent).toContain('NOT evidence');
    expect(screen.queryAllByTestId('plan-provenance-chip')).toHaveLength(0);
  });

  it('chip text covers every label', () => {
    expect(itemChipText({ label: 'unresolved', reason: 'no_mapping' })).toBe('Unresolved: no request maps to it');
    expect(itemChipText({ label: 'derived' })).toBe('Derived');
    expect(itemChipText({ label: 'not-audited' })).toBe('Not audited');
  });
});
