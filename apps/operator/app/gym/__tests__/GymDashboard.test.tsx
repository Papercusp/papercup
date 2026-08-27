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

// Monaco can't render in jsdom (and won't load offline in the WebKitGTK Tauri webview either);
// force the DiffEditor to throw so the LoadBoundary falls back to the robust jsdiff line-diff —
// which is exactly the path that renders in those environments, and the one we assert on.
vi.mock('@monaco-editor/react', () => ({
  DiffEditor: () => { throw new Error('monaco unavailable (jsdom)'); },
}));

import GymDashboard from '../GymDashboard';

const PROPOSAL = {
  id: 'p1', cycle: 2, variantId: 'cand-c2', role: 'worker',
  originalMd: 'old worker prompt', proposedMd: 'old worker prompt\nRe-read acceptance',
  rationale: 'targets the spec-gap', devAnchorDelta: 0.12, costDelta: 0.01, probeStatus: 'pass', status: 'pending',
};

let posted: Array<{ url: string; body: unknown }> = [];
let getUrls: string[] = [];
// P-020: the proposals mock is a mutable fixture so a test can supply decided (auto-accepted)
// proposals and assert they render — the whole point of defaulting the tab to status=all.
let proposalsFixture: Array<Record<string, unknown>> = [PROPOSAL];

function mockFetch() {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    if (method === 'POST') posted.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null });
    else getUrls.push(url);

    // Real backend shape (control.ts `GET /gym/harnesses`): { harnesses: [...] }, not a bare
    // array — a mock that returned the bare array here (matching the frontend's former bug,
    // not the real endpoint) let GymDashboard.tsx's `harnesses.map` crash ship past this suite;
    // caught live by the P-004 Tauri surface verification instead (gui-e2e-tauri-surface-2026-08-27).
    if (url.endsWith('/api/gym/harnesses')) return json({ harnesses: [{ harnessSlug: 'gymtest', pendingCount: 1, lastCycle: 2, autoloop: null }] });
    if (url.includes('/api/gym/gymtest/proposals')) return json({ proposals: proposalsFixture });
    if (url.endsWith('/api/gym/gymtest/accept')) return json({ ok: true, promoted: true });
    if (url.endsWith('/api/gym/gymtest/reject')) return json({ ok: true, promoted: false });
    if (url.endsWith('/api/gym/gymtest/prompts') && method === 'GET') return json({ judgeRubric: 'the rubric', roles: { worker: 'wprompt' }, editableKeys: ['judge', 'worker'] });
    if (url.endsWith('/api/gym/gymtest/prompts') && method === 'POST') return json({ ok: true, judgeRubric: 'the rubric', roles: { worker: 'wprompt' } });
    if (url.endsWith('/api/gym/gymtest/autoloop') && method === 'GET') return json({ autoloop: { enabled: false, status: 'idle', budgetUsd: 50, spentUsd: 0, lastCycle: null }, configured: true });
    if (url.endsWith('/api/gym/gymtest/autoloop') && method === 'POST') return json({ ok: true });
    // The durable live-DB read now always answers (migration 650); no more available:false.
    if (url.includes('/api/gym/gymtest/cycles')) return json({ cycles: [{ cycle: 0, parentId: null, candidateId: 'cand-c0', decision: 'accept' }] });
    return json({}, 404);
  });
}

beforeEach(() => {
  posted = [];
  getUrls = [];
  proposalsFixture = [PROPOSAL];
  vi.stubGlobal('fetch', mockFetch());
  // The Monaco mock throws → the LoadBoundary catches it (the EXPECTED fallback path); React DEV
  // logs the caught error + a component-stack notice to console.error. Swallow ONLY those; any
  // other console.error still fails the test (matches the PlanRail.test.tsx pattern).
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    const msg = args.map((a) => String((a as Error)?.message ?? a)).join(' ');
    if (/monaco unavailable|error occurred|component stack|recreate this component|MonacoDiffEditor|LoadBoundary/i.test(msg)) return;
    throw new Error(`Unexpected console.error: ${msg}`);
  });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); cleanup(); });

const renderAt = (search: string) =>
  render(<GymDashboard />, { wrapper: withNuqsTestingAdapter({ searchParams: search }) });

describe('GymDashboard', () => {
  it('proposals: defaults to status=all, renders the diff + numbers and accept→promote POSTs the proposal id', async () => {
    const { findByTestId, getByTestId } = renderAt('?gymSlug=gymtest&gymTab=proposals');
    await findByTestId('gym-proposal-row');
    // P-020: the tab must request ALL statuses (not the pending-only default that hid every
    // auto-decided challenger).
    expect(getUrls.some((u) => u.includes('/proposals?status=all'))).toBe(true);
    const diff = await findByTestId('gym-diff');
    expect(diff.textContent).toContain('Re-read acceptance');
    fireEvent.click(getByTestId('gym-accept'));
    await waitFor(() => expect(posted.some((p) => p.url.endsWith('/accept') && (p.body as { id: string }).id === 'p1')).toBe(true));
  });

  it('proposals: a decided (auto-accepted) challenger is visible and has no accept button (P-020)', async () => {
    proposalsFixture = [
      { ...PROPOSAL, id: 'p2', status: 'accepted' },
    ];
    const { findByTestId, queryByTestId } = renderAt('?gymSlug=gymtest&gymTab=proposals');
    await findByTestId('gym-proposal-row');
    // The decided proposal shows its status + the "auto-accepted" note, and offers no accept/reject.
    await findByTestId('gym-proposal-decided');
    expect((await findByTestId('gym-proposal-status')).textContent).toContain('accepted');
    expect(queryByTestId('gym-accept')).toBeNull();
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

  it('run-analytics: the Cycles tab renders rows from the durable live-DB read (P-013)', async () => {
    const { findByTestId } = renderAt('?gymSlug=gymtest&gymTab=cycles');
    const grid = await findByTestId('gym-cycles');
    expect(grid.textContent).toContain('cand-c0');
    expect(grid.textContent).toContain('accept');
  });
});
