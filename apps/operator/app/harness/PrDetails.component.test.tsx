// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import type { PrViewerDetails } from '@papercusp/operator-core/lib/pr-host/pr-viewer';
import { prToRow } from '@papercusp/operator-core/lib/pr-host/pr-viewer';
import { toast } from 'sonner';

const sync = vi.hoisted(() => ({ data: [] as unknown[], loading: false, error: null as Error | null,
  invalidate: vi.fn(), query: vi.fn() }));
vi.mock('@papercusp/sync', () => ({ useSyncQuery: (opts: unknown) => { sync.query(opts); return sync; } }));
vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }) }));
vi.mock('nuqs', async () => {
  const React = await import('react');
  return { parseAsString: {}, useQueryState: () => React.useState<string | null>(null) };
});
import { PrDetails } from './PrDetails';

function fixture(): PrViewerDetails {
  const pr: PrViewerDetails['pr'] = { ref: { remote: 'github.com/acme/repo', number: 7 },
    title: 'Combined pot work', body: '', state: 'open', head_ref: 'papercusp/standing', base_ref: 'main',
    head_sha: 'a'.repeat(40), merge_commit_sha: null, author: { github_user_id: 1, github_login: 'avi' },
    reviewers_requested: [], review_decision: 'approved', checks_state: 'success', mergeable_state: 'mergeable',
    is_draft: false, url: 'https://github.com/acme/repo/pull/7', updated_at: 1 };
  return { pr, row: prToRow(pr), targetSha: 'b'.repeat(40), standing: true,
    permissions: { review: true, close: true, sendGreen: true }, mergeTestStatus: 'pass', mergeBlocker: null,
    mergeTest: { result: 'pass', mergeSha: 'c'.repeat(40), prHeadSha: pr.head_sha, targetTipSha: 'b'.repeat(40) },
    commits: [{ sha: pr.head_sha, message: 'Combined work', author: 'avi', url: 'https://github.com/acme/repo/commit/a' }],
    files: [{ filename: 'src/main.ts', status: 'modified', additions: 1, deletions: 1, patch: '-old\n+new' },
      { filename: 'logo.png', status: 'modified', additions: 0, deletions: 0 }],
    diff: 'diff --git a/src/main.ts b/src/main.ts\n-old\n+new', diffTruncated: false,
    checks: [{ name: 'Full suite', conclusion: 'success', status: 'completed', url: null }] };
}
describe('PR details', () => {
  beforeEach(() => { sync.data = [fixture()]; sync.loading = false; sync.error = null; });
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.clearAllMocks(); });
  const mount = () => render(<PrDetails harnessSlug="acme" number={7} onChanged={vi.fn()} />);
  it('loads the named sync query and shows commits, checks, actual state and exact tested SHA separately from the head', () => {
    const view = mount();
    expect(sync.query).toHaveBeenCalledWith({ queryName: 'harnessPrs.detail', args: { harnessSlug: 'acme', number: 7 } });
    expect(view.getByLabelText('Exact merge test').textContent).toContain('c'.repeat(40));
    expect(view.getByLabelText('PR checks').textContent).toContain('Full suite — success');
    expect(view.getByLabelText('PR commits').textContent).toContain('Combined work');
    expect(view.getByText('open · mergeable')).toBeTruthy();
    expect(view.getByRole('link', { name: 'Open on GitHub' }).getAttribute('href')).toContain('/pull/7');
    fireEvent.change(view.getByLabelText('File diff'), { target: { value: 'src/main.ts' } });
    expect(view.getByLabelText('PR diff').textContent).toBe('-old\n+new');
    fireEvent.change(view.getByLabelText('File diff'), { target: { value: 'logo.png' } });
    expect(view.getByLabelText('PR diff').textContent).toContain('did not provide a patch');
  });
  it('shows stale tests, report absence and truncated-diff disclosure', () => {
    const d = fixture(); d.mergeTestStatus = 'stale'; d.diffTruncated = true; sync.data = [d];
    const view = mount();
    expect(view.getByText('Retest and merge')).toBeTruthy();
    expect(view.getByText(/head or target changed/)).toBeTruthy();
    expect(view.getByText('No reviewer report yet.')).toBeTruthy();
    expect(view.getByText(/combined diff is truncated/)).toBeTruthy();
  });
  it.each(['running', 'fail', 'unavailable'] as const)('prevents merging on %s evidence', status => {
    const d = fixture(); d.mergeTestStatus = status; sync.data = [d];
    const view = mount();
    expect((view.getByRole('button', { name: 'Test and merge' }) as HTMLButtonElement).disabled).toBe(true);
  });
  it('shows conflicts and disables merge; historical closed PRs remain readable', () => {
    const d = fixture(); d.pr.mergeable_state = 'not_mergeable'; d.mergeBlocker = 'Merge conflicts block this PR.'; sync.data = [d];
    const view = mount();
    expect(view.getByText('Merge conflicts block this PR.')).toBeTruthy();
    expect((view.getByText('Merge tested commit') as HTMLButtonElement).disabled).toBe(true);
    d.pr.state = 'closed'; view.rerender(<PrDetails harnessSlug="acme" number={7} onChanged={vi.fn()} />);
    expect(view.getByText('closed · not_mergeable')).toBeTruthy();
    expect((view.getByText('Close PR') as HTMLButtonElement).disabled).toBe(true);
  });
  it('hides writes when the authoritative detail response grants no permission', () => {
    const d = fixture(); d.permissions = { review: false, close: false, sendGreen: false }; sync.data = [d];
    const view = mount();
    expect(view.queryByText('Merge tested commit')).toBeNull();
    expect(view.queryByText('Close PR')).toBeNull();
    expect(view.queryByText('Send what’s green now')).toBeNull();
  });
  it.each(['testing', 'waiting', 'refused', 'merged'])("reports the actual '%s' outcome without inventing a merge", async action => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ action, detail: `Outcome: ${action}` }) })));
    const changed = vi.fn();
    const view = render(<PrDetails harnessSlug="acme" number={7} onChanged={changed} />);
    fireEvent.click(view.getByText('Merge tested commit'));
    await waitFor(() => expect(view.getByText(`Outcome: ${action}`)).toBeTruthy());
    expect(fetch).toHaveBeenCalledWith('/api/harness/acme/prs/7/action', expect.objectContaining({ body: '{"action":"merge"}' }));
    expect(toast.success).toHaveBeenCalledTimes(action === 'merged' ? 1 : 0);
    expect(sync.invalidate).toHaveBeenCalledTimes(1); expect(changed).toHaveBeenCalledTimes(1);
  });
  it.each([['Close PR', 'close', 'closed'], ['Send what’s green now', 'send-green', 'sent']])('routes %s through the existing action endpoint', async (label, action, outcome) => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ action: outcome }) })));
    const view = mount(); fireEvent.click(view.getByText(label));
    await waitFor(() => expect(toast.success).toHaveBeenCalledTimes(1));
    expect(fetch).toHaveBeenCalledWith('/api/harness/acme/prs/7/action', expect.objectContaining({ body: JSON.stringify({ action }) }));
  });
  it('surfaces permission failures and invalidates stale detail permissions', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 403, json: async () => ({ error: 'Permission changed' }) })));
    const view = mount(); fireEvent.click(view.getByText('Close PR'));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Error: Permission changed'));
    expect(toast.success).not.toHaveBeenCalled(); expect(sync.invalidate).toHaveBeenCalled();
  });
  it('renders query failure before a loading placeholder and lets the viewer retry', () => {
    sync.error = new Error('Provider unreachable'); sync.loading = true;
    const view = mount(); expect(view.getByRole('alert').textContent).toContain('Provider unreachable');
    fireEvent.click(view.getByText('Retry details')); expect(sync.invalidate).toHaveBeenCalled();
  });
});
