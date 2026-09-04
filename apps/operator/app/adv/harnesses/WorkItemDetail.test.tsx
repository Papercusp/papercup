/**
 * @vitest-environment jsdom
 *
 * WorkItemDetail Chat action (EI-290) — the unified WI-* detail pane must
 * carry a user-reachable steer/chat affordance, wired through the same
 * `openFeatureChat` path the legacy F-* detail uses (chat row created for
 * THIS work item, discuss mode, worker role).
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NuqsTestingAdapter } from 'nuqs/adapters/testing';

const openFeatureChat = vi.fn();
vi.mock('@papercusp/papercusp-shared', () => ({
  openFeatureChat: (...args: unknown[]) => openFeatureChat(...args),
}));

const discussionProps = vi.fn();
vi.mock('../../_components/work-items/WorkItemDiscussion', () => ({
  WORK_ITEM_DISCUSSION_PARAM: 'opcid',
  default: (props: {
    harnessSlug: string;
    workItemId: string;
    title?: string | null;
    onClose?: () => void;
  }) => {
    discussionProps(props);
    return (
      <div data-testid="work-item-discussion-stub">
        <button type="button" data-testid="work-item-discussion-close" onClick={props.onClose} />
      </div>
    );
  },
}));

import { WorkItemDetail } from './DetailPanel';
import type { WorkItemRow } from './WorkItemsPanel';

afterEach(() => {
  cleanup();
  openFeatureChat.mockReset();
  discussionProps.mockReset();
});

const workItem: WorkItemRow = {
  id: 'WI-42',
  kind: 'feature',
  family: 'feature',
  title: 'Steerable item',
  state: 'in_progress',
  severity: null,
  assignee: null,
  assignedBy: null,
  priority: null,
  rank: null,
  spineRole: null,
  spineStatus: null,
  updatedAt: null,
  summary: null,
  planSlug: null,
} as unknown as WorkItemRow;

function renderDetail(searchParams = '') {
  const onUrlUpdate = vi.fn();
  render(<WorkItemDetail slug="papercup" workItem={workItem} onSelect={() => {}} />, {
    wrapper: ({ children }) => (
      <NuqsTestingAdapter searchParams={searchParams} onUrlUpdate={onUrlUpdate}>
        {children}
      </NuqsTestingAdapter>
    ),
  });
  const lastQuery = () =>
    onUrlUpdate.mock.calls.length
      ? onUrlUpdate.mock.calls[onUrlUpdate.mock.calls.length - 1][0].queryString
      : '';
  return { lastQuery };
}

describe('WorkItemDetail chat affordance', () => {
  it('renders the canonical icon-bearing kind pill in the detail metadata', () => {
    renderDetail();

    const label = screen.getByText('Feature');
    expect(label.parentElement?.querySelector('svg')).not.toBeNull();
    expect(screen.queryByText(/^feature$/)).toBeNull();
  });

  it('renders a Chat action that opens a discuss-mode worker chat for the item', async () => {
    openFeatureChat.mockResolvedValue({ chatId: 'chat-1' });
    renderDetail();

    const btn = screen.getByTestId('wi-detail-chat');
    fireEvent.click(btn);

    await waitFor(() => expect(openFeatureChat).toHaveBeenCalledTimes(1));
    expect(openFeatureChat).toHaveBeenCalledWith({
      slug: 'papercup',
      role: 'worker',
      featureId: 'WI-42',
      title: 'Steerable item',
      mode: 'discuss',
    });
  });

  it('surfaces an open-chat failure as a toast instead of throwing', async () => {
    openFeatureChat.mockResolvedValue({ error: 'chat backend down' });
    renderDetail();

    fireEvent.click(screen.getByTestId('wi-detail-chat'));
    // The button recovers (not stuck disabled) and no exception escapes.
    await waitFor(() =>
      expect((screen.getByTestId('wi-detail-chat') as HTMLButtonElement).disabled).toBe(false),
    );
  });

  it('keeps worker Chat and adds a nuqs-backed inline Papercup discussion', async () => {
    const { lastQuery } = renderDetail();
    expect(screen.getByTestId('wi-detail-chat')).toBeTruthy();
    expect(screen.getByTestId('wi-detail-discuss').getAttribute('aria-expanded')).toBe('false');

    fireEvent.click(screen.getByTestId('wi-detail-discuss'));
    await waitFor(() => expect(lastQuery()).toContain('opcid=papercup::WI-42'));

    cleanup();
    const reopened = renderDetail('?opcid=papercup%3A%3AWI-42');
    expect(screen.getByTestId('wi-detail-discuss').getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByTestId('work-item-discussion-stub')).toBeTruthy();
    expect(discussionProps).toHaveBeenLastCalledWith(
      expect.objectContaining({
        harnessSlug: 'papercup',
        workItemId: 'WI-42',
        title: 'Steerable item',
      }),
    );

    const close = screen.getByTestId('work-item-discussion-close');
    close.focus();
    fireEvent.click(close);
    await waitFor(() => expect(reopened.lastQuery()).not.toContain('opcid='));
    expect(document.activeElement).toBe(screen.getByTestId('wi-detail-discuss'));
  });
});
