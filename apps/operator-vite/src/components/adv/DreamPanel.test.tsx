// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import frozen from './dream-view.fixture.json';
import type { DreamMetrics } from '@papercusp/operator-core/lib/dream/dream-metrics';
import type { DreamDetail, DreamHistory } from '@papercusp/operator-core/lib/dream/dream-read';

const h = vi.hoisted(() => ({
  initial: {} as Record<string, string>, queries: vi.fn(), invalidate: vi.fn(), flag: true,
  data: {} as Record<string, unknown[]>, errors: {} as Record<string, Error>, loading: false,
}));
vi.mock('@papercusp/flags/client', () => ({ useFlag: () => h.flag }));
vi.mock('nuqs', async () => {
  const { useState } = await import('react');
  const { nuqsParsers } = await import('@papercusp/test-config/nuqs-mock');
  return { ...nuqsParsers, useQueryState: (key: string) => useState(h.initial[key] ?? '') };
});
vi.mock('@papercusp/sync', () => ({ useSyncQuery: (opts: { queryName: string; args?: { view?: string } }) => {
  h.queries(opts);
  const key = opts.queryName === 'learning.dream' ? opts.args?.view ?? 'controls' : opts.queryName;
  return { data: h.data[key], error: h.errors[key], loading: h.loading, fetching: false, invalidate: h.invalidate };
} }));
import { DreamDetailLoader, DreamFunnel, DreamPanel, DreamRunDetail } from './DreamPanel';

// Captured from the real ledger fixture + read projection. Backend behavior is
// exercised separately in dream-read.integration.test.ts; this suite consumes its wire data.
const captured = frozen.detail as unknown as DreamDetail;
const fixture = { run: captured.run, candidate: captured.proposal!,
  packets: captured.provenance!.sampling!.status === 'selected' ? [captured.provenance!.sampling!.selection.a.packet] : [] };
const scope = { workspaceId: 'dream-ui', potSlug: 'pot-a', since: '2026-09-07T00:00:00Z', until: '2026-09-08T00:00:00Z' };
afterEach(cleanup);
beforeEach(() => {
  vi.clearAllMocks(); h.initial = {}; h.errors = {}; h.flag = true; h.loading = false;
  const run = { ...fixture.run, status: 'accepted' as const, routedRef: 'engineer-issue:EI-123' };
  const history: DreamHistory = { scope, runs: [{ runId: run.runId, cycleId: run.cycleId, potSlug: run.potSlug,
    status: run.status, review: { verdict: 'accept', reason: 'supported-delta' }, mode: run.mode, startedAt: run.startedAt, costUsd: run.costUsd,
    title: fixture.candidate.behavior, routedRef: run.routedRef, version: 'dream-capability-run-v1' }],
    nextCursor: JSON.stringify([run.startedAt, run.runId]) };
  h.data = { 'harnessProjects.lite': [{ slug: 'pot-a', harness_kind: 'hive' }, { slug: 'repo-only', harness_kind: 'project' }],
    metrics: [structuredClone(frozen.metrics)], history: [history],
    run: [structuredClone(captured)] };
});

describe('Dreams in Analyze', () => {
  it('DREAM-REDISCOVERY: shows useful existing work without novelty or duplicate-work credit', () => {
    const detail = structuredClone(captured);
    detail.reuse = { kind: 'refinement', priorRefs: ['plan:existing-restoration'], familyIds: ['restoration'], usefulness: 'supported', noveltyCredit: 'none' };
    render(<DreamRunDetail detail={detail} />);
    const reuse = screen.getByRole('region', { name: 'Existing work and reuse' });
    expect(within(reuse).getByText(/assessed usefulness: supported/)).toBeTruthy();
    expect(within(reuse).getByText(/plan:existing-restoration/)).toBeTruthy();
    expect(within(reuse).getByText(/No new-discovery credit/)).toBeTruthy();
  });
  it('DREAM-CATALOGUE-LIMITS: identifies unmapped behavior as unknown', () => {
    render(<DreamRunDetail detail={structuredClone(captured)} />);
    expect(screen.getByText(/Catalogue coverage: partial/).textContent).toContain('Unmapped repository behaviors remain unknown');
  });
  it('shows attributable problem context and labels its benefit as proposed', () => {
    const d = structuredClone(captured);
    d.problemContext = { mode: 'observed-problems', note: 'A report is not verified benefit.', evidence: [{ ref: 'observation:EI-1', kind: 'observation', workspaceId: d.run.workspaceId, potSlug: d.run.potSlug, attributedTo: 'engineer-1', capturedAt: '2026-09-27T00:00:00Z', text: 'Replay lost state.', contentHash: 'a'.repeat(64) }] };
    d.proposal!.problemFit = { refs: ['observation:EI-1'], beneficiary: 'Debugging engineers', proposedImprovement: 'Restore the reported state for replay.' };
    render(<DreamRunDetail detail={d} />);
    expect(screen.getByRole('region', { name: 'Problem context' }).textContent).toContain('reported by engineer-1');
    expect(screen.getByText(/Addresses observation:EI-1/).textContent).toContain('(proposed benefit)');
    expect(h.queries).not.toHaveBeenCalled();
  });
  it.each(['dependency', 'source', 'counterfactual'] as const)('DREAM-REVIEW-NEXT-CHECK: shows the bounded %s check without dispatching work', (kind) => {
    const d = structuredClone(captured);
    d.run.status = 'rejected'; d.run.review = { verdict: 'unverified', reason: 'review-unavailable' };
    d.nextCheck = { kind, instruction: 'Read the scoped source and its executable test before reassessment.', evidenceNeeded: ['Snapshot removal effect remains unknown.'], maxSourceQueries: 2 };
    render(<DreamRunDetail detail={d} />);
    const next = screen.getByRole('region', { name: 'Next evidence check' });
    expect(within(next).getByText(d.nextCheck.instruction)).toBeTruthy();
    expect(within(next).getByText('Snapshot removal effect remains unknown.')).toBeTruthy();
    expect(within(next).getByText(/At most 2 source searches/)).toBeTruthy();
    expect(h.queries).not.toHaveBeenCalled();
  });
  it.each([
    ['counterfactual-unknown', 'insufficient evidence'],
    ['rerank-unavailable', 'review unavailable'],
  ])('labels historical %s outcomes honestly in history and detail', (reason, label) => {
    h.initial.dreamPot = 'pot-a';
    const review = { verdict: 'unverified', reason };
    const history = h.data.history![0] as DreamHistory;
    history.runs[0]!.status = 'rejected'; history.runs[0]!.review = review;
    (h.data.run![0] as DreamDetail).run.status = 'rejected';
    (h.data.run![0] as DreamDetail).run.review = review;
    render(<DreamPanel />);
    fireEvent.click(screen.getByRole('button', { name: new RegExp(label + '.*Combine the A output') }));
    expect(screen.getByText(label)).toBeTruthy();
    expect(screen.queryByText('rejected')).toBeNull();
  });
  it('asks for a pot and does not read attempts until one is selected', () => {
    render(<DreamPanel />);
    expect(screen.getByRole('combobox', { name: 'Dream pot' })).toBeTruthy();
    expect(screen.getByText(/Choose a pot to see its last seven days/)).toBeTruthy();
    expect(h.queries.mock.calls.some(([q]) => q.queryName === 'learning.dream')).toBe(false);
  });
  it('uses the complete metric window and mounts a scoped detail read only on expansion', () => {
    h.initial.dreamPot = 'pot-a';
    render(<DreamPanel />);
    expect(h.queries).toHaveBeenCalledWith(expect.objectContaining({ queryName: 'learning.dream', args: { potSlug: 'pot-a', view: 'history', since: scope.since, until: scope.until } }));
    expect(h.queries.mock.calls.some(([q]) => q.args?.view === 'run')).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: /accepted.*Combine the A output/ }));
    expect(h.queries).toHaveBeenCalledWith(expect.objectContaining({ queryName: 'learning.dream', args: { potSlug: 'pot-a', view: 'run', runId: fixture.run.runId } }));
    expect(screen.getByText('Falsifier: The seeded mismatch is missed.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /accepted.*Combine the A output/ }));
    expect(screen.queryByRole('article')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Older attempts' }));
    expect(h.queries).toHaveBeenCalledWith(expect.objectContaining({ args: expect.objectContaining({ cursor: (h.data.history![0] as DreamHistory).nextCursor }) }));
    expect(screen.getByRole('button', { name: 'Newest attempts' })).toBeTruthy();
  });
  it('keeps the selected attempt addressable outside the current list page', () => {
    h.initial = { dreamPot: 'pot-a', dreamRun: 'historical-run' };
    render(<DreamPanel />);
    expect(h.queries).toHaveBeenCalledWith(expect.objectContaining({ args: { potSlug: 'pot-a', view: 'run', runId: 'historical-run' } }));
  });
  it('names the historical pot even when it no longer appears in the live catalog', () => {
    h.initial.dreamPot = 'pot-a'; h.data['harnessProjects.lite'] = [];
    render(<DreamPanel />);
    expect(screen.getByRole('combobox', { name: 'Dream pot' }).textContent).toBe('pot-a');
  });
  it('does not report zero percent when no attempts were reviewed', () => {
    render(<DreamFunnel metrics={frozen.emptyMetrics as DreamMetrics} />);
    expect(screen.getByText('Review pass rate (decisive reviews): 0 / 0 · not available.')).toBeTruthy();
    expect(screen.getByText('Dedupe / sink survival (review-passed attempts): 0 / 0 · not available.')).toBeTruthy();
  });
  it('shows missing, loading, transport and degraded detail states separately', () => {
    h.data.run = [];
    const view = render(<DreamDetailLoader potSlug="pot-a" runId="missing" />);
    expect(screen.getByText('This attempt was not found in this pot.')).toBeTruthy();
    h.loading = true; view.rerender(<DreamDetailLoader potSlug="pot-a" runId="missing" />);
    expect(screen.getByText('Loading Dream detail…')).toBeTruthy();
    h.loading = false; h.errors.run = new Error('socket secret');
    view.rerender(<DreamDetailLoader potSlug="pot-a" runId="missing" />);
    expect(screen.getByText('Dream detail unavailable')).toBeTruthy();
    expect(screen.queryByText(/socket secret/)).toBeNull();
    h.errors = {}; h.data.run = [{ unavailable: true, unavailableKind: 'read-failed', unavailableReason: 'Ledger unavailable' }];
    view.rerender(<DreamDetailLoader potSlug="pot-a" runId="missing" />);
    expect(screen.getByText(/Dream detail unavailable.*Ledger unavailable/)).toBeTruthy();
  });
  it('shows rejected evidence, source hashes, actual unknown costs and the canonical proposal link', () => {
    const d = structuredClone(h.data.run![0] as DreamDetail);
    d.run.status = 'rejected'; d.run.error = 'Review was inconclusive';
    d.provenance!.calls[0] = { ...d.provenance!.calls[0]!, status: 'unknown', usage: null };
    render(<DreamRunDetail detail={d} />);
    expect(screen.getByText('Review was inconclusive')).toBeTruthy();
    expect(screen.getByText(/Source freshness now: not rechecked/)).toBeTruthy();
    expect(screen.getByText('A:').parentElement?.textContent).toContain('Produces the input.');
    const link = screen.getByRole('link', { name: /implementation: evidence\/A.ts/ });
    const anchor = document.getElementById(link.getAttribute('href')!.slice(1));
    expect(anchor?.textContent).toContain('export function A()');
    expect(anchor?.textContent).toContain(fixture.packets[0]!.sources[0]!.sourceHash);
    const row = screen.getByText('generation / dreamer').closest('tr')!;
    expect(within(row).getAllByText('unknown')).toHaveLength(2);
    expect(screen.getByRole('link', { name: /Open accepted proposal/ }).getAttribute('href')).toContain('lview=improvements&impq=EI-123');
  });
  it('shows an optional third role and its removal effect', () => {
    const d = structuredClone(h.data.run![0] as DreamDetail);
    const sampling = d.provenance!.sampling!;
    if (sampling.status !== 'selected') throw new Error('Expected fixture selection');
    sampling.selection.c = { entry: structuredClone(sampling.selection.b), declaration: {
      aId: 'A', bId: 'B', cId: 'C', aVersion: 'a'.repeat(64), bVersion: 'b'.repeat(64), cVersion: 'c'.repeat(64),
      role: 'constraint', contribution: 'Restricts output.', removalEffect: 'Constraint disappears.', evidenceIds: ['code'],
    } } as NonNullable<typeof sampling.selection.c>;
    sampling.selection.c.entry.packet.unit.id = 'capability:C';
    d.proposal!.thirdContribution = { role: 'constraint', uniqueContribution: 'Restricts output.', removalEffect: 'Constraint disappears.', sources: [{ unit: 'C', evidenceId: 'code' }] };
    render(<DreamRunDetail detail={d} />);
    expect(screen.getByRole('region', { name: 'Source C' })).toBeTruthy();
    expect(screen.getByText('C (constraint):').parentElement?.textContent).toContain('Constraint disappears.');
  });
  it('keeps legacy attempts visible with unknown provenance', () => {
    const d: DreamDetail = { ...captured, run: { ...fixture.run, outcome: { verdict: 'none' }, review: null, status: 'abstained' },
      provenance: null, proposal: null, capabilityReview: null, assessments: [] };
    render(<DreamRunDetail detail={d} />);
    expect(screen.getByText(/Legacy attempt: capability packets/)).toBeTruthy();
    expect(screen.getByText(/Legacy summary: generation unknown.*review unknown/)).toBeTruthy();
    expect(screen.getByText('No review recorded.')).toBeTruthy();
  });
  it('renders read failures as unavailable and refreshes through sync', () => {
    h.initial.dreamPot = 'pot-a'; h.errors.metrics = new Error('offline');
    render(<DreamPanel />);
    expect(screen.getByText('Dream metrics unavailable')).toBeTruthy();
    expect(screen.queryByRole('definition')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Refresh Dream history' }));
    expect(h.invalidate).toHaveBeenCalledTimes(2);
  });
  it('keeps the feature flag independent of manual or automatic arming', () => {
    h.flag = false; render(<DreamPanel />);
    expect(h.queries).not.toHaveBeenCalled();
  });
});
