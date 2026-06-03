// @vitest-environment jsdom
/**
 * Render + wiring test for the Harness Gym dashboard (P-024 / gym-ui-handoff surfaces).
 *
 * Mocks /api/gym/* and asserts each surface renders from its endpoint and that the
 * headline accept→promote action POSTs correctly. jsdom can't do real layout/Monaco, so
 * this guards the data-binding + the nuqs-driven tab/selection state + the accept flow.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { cleanup, render, waitFor, fireEvent } from '@testing-library/react';
import { withNuqsTestingAdapter } from 'nuqs/adapters/testing';
import GymDashboard from '../GymDashboard';

const PROPOSAL = {
  id: 'p1', cycle: 2, variantId: 'cand-c2', role: 'worker',
  originalMd: 'old worker prompt', proposedMd: 'old worker prompt\nRe-read acceptance',
  rationale: 'targets the spec-gap', devAnchorDelta: 0.12, costDelta: 0.01, probeStatus: 'pass', status: 'pending',
};

let posted: Array<{ url: string; body: unknown }> = [];

function mockFetch() {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    if (method === 'POST') posted.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null });

    if (url.endsWith('/api/gym/harnesses')) return json([{ harnessSlug: 'gymtest', pendingCount: 1, lastCycle: 2, autoloop: null }]);
    if (url.includes('/api/gym/gymtest/proposals')) return json({ proposals: [PROPOSAL] });
    if (url.endsWith('/api/gym/gymtest/accept')) return json({ ok: true, promoted: true });
    if (url.endsWith('/api/gym/gymtest/reject')) return json({ ok: true, promoted: false });
    if (url.endsWith('/api/gym/gymtest/prompts') && method === 'GET') return json({ judgeRubric: 'the rubric', roles: { worker: 'wprompt' }, editableKeys: ['judge', 'worker'] });
    if (url.endsWith('/api/gym/gymtest/prompts') && method === 'POST') return json({ ok: true, judgeRubric: 'the rubric', roles: { worker: 'wprompt' } });
    if (url.endsWith('/api/gym/gymtest/autoloop') && method === 'GET') return json({ autoloop: { enabled: false, status: 'idle', budgetUsd: 50, spentUsd: 0, lastCycle: null }, configured: true });
    if (url.endsWith('/api/gym/gymtest/autoloop') && method === 'POST') return json({ ok: true });
    if (url.includes('/api/gym/gymtest/cycles')) return json({ cycles: [], available: false });
    return json({}, 404);
  });
}

beforeEach(() => { posted = []; vi.stubGlobal('fetch', mockFetch()); });
afterEach(() => { vi.unstubAllGlobals(); cleanup(); });

const renderAt = (search: string) =>
  render(<GymDashboard />, { wrapper: withNuqsTestingAdapter({ searchParams: search }) });

describe('GymDashboard', () => {
  it('proposals: renders the diff + numbers and accept→promote POSTs the proposal id', async () => {
    const { findByTestId, getByTestId } = renderAt('?gymSlug=gymtest&gymTab=proposals');
    await findByTestId('gym-proposal-row');
    const diff = await findByTestId('gym-diff');
    expect(diff.textContent).toContain('Re-read acceptance');
    fireEvent.click(getByTestId('gym-accept'));
    await waitFor(() => expect(posted.some((p) => p.url.endsWith('/accept') && (p.body as { id: string }).id === 'p1')).toBe(true));
  });

  it('prompts: lists editable keys and saving POSTs { role, md }', async () => {
    const { findByTestId, getByTestId } = renderAt('?gymSlug=gymtest&gymTab=prompts&role=worker');
    await findByTestId('gym-role-worker');
    const editor = (await findByTestId('gym-prompt-editor')) as HTMLTextAreaElement;
    await waitFor(() => expect(editor.value).toBe('wprompt'));
    fireEvent.change(editor, { target: { value: 'wprompt v2' } });
    fireEvent.click(getByTestId('gym-prompt-save'));
    await waitFor(() => expect(posted.some((p) => p.url.endsWith('/prompts') && (p.body as { role: string }).role === 'worker' && (p.body as { md: string }).md === 'wprompt v2')).toBe(true));
  });

  it('autoloop: shows status and toggling POSTs enabled', async () => {
    const { findByTestId, getByTestId } = renderAt('?gymSlug=gymtest&gymTab=autoloop');
    const status = await findByTestId('gym-autoloop-status');
    expect(status.textContent).toContain('idle');
    fireEvent.click(getByTestId('gym-autoloop-toggle'));
    await waitFor(() => expect(posted.some((p) => p.url.endsWith('/autoloop') && (p.body as { enabled: boolean }).enabled === true)).toBe(true));
  });

  it('run-analytics: shows the Unavailable notice when no gym run DB is configured', async () => {
    const { findByTestId } = renderAt('?gymSlug=gymtest&gymTab=cycles');
    await findByTestId('gym-unavailable');
  });
});
