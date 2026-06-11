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

const openFeatureChat = vi.fn();
vi.mock('@papercusp/papercup-shared', () => ({
  openFeatureChat: (...args: unknown[]) => openFeatureChat(...args),
}));

import { WorkItemDetail } from './DetailPanel';
import type { WorkItemRow } from './WorkItemsPanel';

afterEach(() => {
  cleanup();
  openFeatureChat.mockReset();
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

describe('WorkItemDetail chat affordance', () => {
  it('renders a Chat action that opens a discuss-mode worker chat for the item', async () => {
    openFeatureChat.mockResolvedValue({ chatId: 'chat-1' });
    render(<WorkItemDetail slug="papercup" workItem={workItem} onSelect={() => {}} />);

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
    render(<WorkItemDetail slug="papercup" workItem={workItem} onSelect={() => {}} />);

    fireEvent.click(screen.getByTestId('wi-detail-chat'));
    // The button recovers (not stuck disabled) and no exception escapes.
    await waitFor(() =>
      expect((screen.getByTestId('wi-detail-chat') as HTMLButtonElement).disabled).toBe(false),
    );
  });
});
