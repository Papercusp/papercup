/**
 * @vitest-environment jsdom
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import { PinnedIssuePanel } from './PinnedIssuePanel';

function mockApi() {
  return { setParams: vi.fn(), setTitle: vi.fn(), close: vi.fn() };
}

const FIXTURE = {
  issues: [
    {
      id: 'I-0001',
      title: 'A real issue with body',
      severity: 'major',
      status: 'open',
      source: 'validator',
      foundAt: '2026-05-10T12:00:00Z',
      attempts: 1,
      linkedFeatureId: 'F-FIX-005',
      codePointer: 'apps/web/src/Foo.ts:42',
      repro: 'click foo, observe bar',
      evidence: 'stack trace…',
      suggestedFix: 'wrap in try/catch',
      notes: [{ at: 'now', body: 'hmm' }],
    },
    { id: 'I-0002', title: 'Other issue', severity: 'minor', status: 'fixed' },
  ],
};

const originalFetch = globalThis.fetch;

beforeEach(() => {
  globalThis.fetch = vi.fn(async () =>
    new Response(JSON.stringify(FIXTURE), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  ) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  cleanup();
});

describe('PinnedIssuePanel', () => {
  it('shows missing-params placeholder when slug/issueId absent', () => {
    const api = mockApi();
    render(
      <PinnedIssuePanel
        panelId="p1"
        panelType="pin:issue"
        params={{}}
        api={api}
      />,
    );
    expect(screen.getByText(/Missing required params/i)).toBeTruthy();
  });

  it('renders the chosen issue with severity / status / source', async () => {
    const api = mockApi();
    render(
      <PinnedIssuePanel
        panelId="p1"
        panelType="pin:issue"
        params={{ harnessSlug: 'sheets', issueId: 'I-0001' }}
        api={api}
      />,
    );
    await waitFor(() => screen.getByText('A real issue with body'));
    expect(screen.getByText('I-0001')).toBeTruthy();
    expect(screen.getByText('open')).toBeTruthy();
    expect(screen.getByText('validator')).toBeTruthy();
  });

  it('shows reproduction / evidence / suggested-fix sections', async () => {
    const api = mockApi();
    render(
      <PinnedIssuePanel
        panelId="p1"
        panelType="pin:issue"
        params={{ harnessSlug: 'sheets', issueId: 'I-0001' }}
        api={api}
      />,
    );
    await waitFor(() => screen.getByText('A real issue with body'));
    expect(screen.getByText('Reproduction')).toBeTruthy();
    expect(screen.getByText('click foo, observe bar')).toBeTruthy();
    expect(screen.getByText('Evidence')).toBeTruthy();
    expect(screen.getByText('stack trace…')).toBeTruthy();
    expect(screen.getByText('Suggested fix')).toBeTruthy();
    expect(screen.getByText('wrap in try/catch')).toBeTruthy();
  });

  it('shows linked feature row when present', async () => {
    const api = mockApi();
    render(
      <PinnedIssuePanel
        panelId="p1"
        panelType="pin:issue"
        params={{ harnessSlug: 'sheets', issueId: 'I-0001' }}
        api={api}
      />,
    );
    await waitFor(() => screen.getByText('A real issue with body'));
    expect(screen.getByText('F-FIX-005')).toBeTruthy();
  });

  it('shows error UI when issue id not found', async () => {
    const api = mockApi();
    render(
      <PinnedIssuePanel
        panelId="p1"
        panelType="pin:issue"
        params={{ harnessSlug: 'sheets', issueId: 'I-9999' }}
        api={api}
      />,
    );
    await waitFor(() =>
      expect(screen.getByText(/Issue I-9999 not found in sheets/i)).toBeTruthy(),
    );
  });

  it('updates panel title with 📌 prefix', async () => {
    const api = mockApi();
    render(
      <PinnedIssuePanel
        panelId="p1"
        panelType="pin:issue"
        params={{ harnessSlug: 'sheets', issueId: 'I-0001' }}
        api={api}
      />,
    );
    await waitFor(() => expect(api.setTitle).toHaveBeenCalled());
    const titleArg = api.setTitle.mock.calls[0][0] as string;
    expect(titleArg.startsWith('📌 I-0001:')).toBe(true);
  });
});
