// @vitest-environment jsdom
/**
 * /admin/admission "Slack bug reports" (slack-messages-to-bug-reports P-008, D-011): one row per
 * Slack channel with its filed / merged / suggested / refused counts, the newest refusal reason and
 * the newest error, read from the admission.chatBugs sync query.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';

const H = vi.hoisted(() => ({
  query: { data: undefined as unknown, loading: false, error: null as unknown },
  calls: [] as Array<{ queryName: string; args: unknown }>,
}));

vi.mock('@papercusp/sync', () => ({
  useSyncQuery: (opts: { queryName: string; args: unknown }) => {
    H.calls.push(opts);
    return H.query;
  },
}));

import ChatBugsHealth from './ChatBugsHealth';

function channel(overrides: Record<string, unknown>) {
  return {
    channelId: 'C1',
    configured: true,
    filed: 0,
    merged: 0,
    suggested: 0,
    refused: 0,
    lastRefusal: null,
    lastError: null,
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
  H.query = { data: undefined, loading: false, error: null };
  H.calls = [];
});

describe('ChatBugsHealth', () => {
  it('shows each channel’s counts, its newest refusal reason and its newest error', () => {
    H.query = {
      loading: false,
      error: null,
      data: [
        {
          deliveriesTruncated: false,
          sources: [
            {
              dataSourceId: 'ds-1',
              kind: 'slack',
              status: 'connected',
              providerAccountId: 'T-ACME',
              channels: [
                channel({ channelId: 'CBUGS', filed: 3, merged: 2, suggested: 1, refused: 1, lastRefusal: { reason: 'rule-1=admission_source_not_visible', at: '2026-10-06T10:00:00.000Z' } }),
                channel({ channelId: 'CQUIET' }),
                channel({ channelId: 'COLD', configured: false, filed: 1, lastError: { message: 'chat_admission_fetch_failed:COLD:1700.1:timeout', at: '2026-10-06T11:00:00.000Z' } }),
              ],
            },
          ],
        },
      ],
    };
    render(<ChatBugsHealth />);

    expect(H.calls[0]).toEqual({ queryName: 'admission.chatBugs', args: {} });
    const section = within(screen.getByRole('region', { name: 'Slack bug reports' }));
    expect(section.getByText('3 Slack channels')).toBeTruthy();

    // By the channel cell's data attribute: an error message can name the channel too.
    const cells = (id: string) =>
      within(document.querySelector(`[data-channel="${id}"]`)!.closest('tr') as HTMLElement)
        .getAllByRole('cell')
        .map((c) => c.textContent);
    expect(cells('CBUGS')).toEqual(['T-ACME', 'CBUGS', '3', '2', '1', '1', 'rule-1=admission_source_not_visible', '—']);
    expect(cells('CQUIET')).toEqual(['T-ACME', 'CQUIET', '0', '0', '0', '0', '—', '—']);
    expect(cells('COLD')).toEqual(['T-ACME', 'COLD (no rule)', '1', '0', '0', '0', '—', 'chat_admission_fetch_failed:COLD:1700.1:timeout']);
  });

  it('says so when no channel has a rule or a report yet', () => {
    H.query = { loading: false, error: null, data: [{ deliveriesTruncated: false, sources: [] }] };
    render(<ChatBugsHealth />);
    expect(screen.getByText('No Slack channel has a bug rule or a report yet.')).toBeTruthy();
  });

  it('says refusals are a minimum when the delivery window was cut', () => {
    H.query = {
      loading: false,
      error: null,
      data: [{ deliveriesTruncated: true, sources: [{ dataSourceId: 'ds-1', kind: 'slack', status: null, providerAccountId: null, channels: [channel({ refused: 2000 })] }] }],
    };
    render(<ChatBugsHealth />);
    expect(screen.getByText('Only the newest failed deliveries are counted, so refusals are a minimum.')).toBeTruthy();
    // With no provider account the data source id names the workspace.
    expect(within(document.querySelector('[data-channel="C1"]')!.closest('tr') as HTMLElement).getAllByRole('cell')[0]!.textContent).toBe('ds-1');
  });

  it('reports a load failure instead of an empty table', () => {
    H.query = { loading: false, error: new Error('sync unavailable'), data: undefined };
    render(<ChatBugsHealth />);
    expect(screen.getByRole('alert').textContent).toBe('Couldn’t load Slack bug reports: sync unavailable');
  });
});
