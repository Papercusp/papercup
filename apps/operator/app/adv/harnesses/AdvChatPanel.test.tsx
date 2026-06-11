/**
 * @vitest-environment jsdom
 *
 * AdvChatPanel free-slot picker (WI-125) — a chat panel opened from the
 * Add-panel catalog must let the user START a chat (pick a work item →
 * openFeatureChat, same worker/discuss defaults as the Detail-pane Chat
 * button) instead of dead-ending on a placeholder.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const openFeatureChat = vi.fn();
vi.mock('@papercusp/papercup-shared', () => ({
  openFeatureChat: (...args: unknown[]) => openFeatureChat(...args),
}));

let syncRows: Array<{ id: string; title: string; state: string }> = [];
vi.mock('@papercusp/sync', () => ({
  useSyncQuery: () => ({ data: syncRows, loading: false, fetching: false, error: null, invalidate: vi.fn() }),
}));

// The bound-slot path renders the real ChatPanel — stub it; this suite tests
// the slot logic, not the chat UI.
vi.mock('../../harness/ChatPanel', () => ({
  default: ({ slug, chatId }: { slug: string; chatId: string }) => (
    <div data-testid="chat-panel-stub">{`chat:${slug}:${chatId}`}</div>
  ),
}));

import AdvChatPanel from './AdvChatPanel';
import type { PanelComponentProps } from '../../harness/dock/panel-registry';

afterEach(() => {
  cleanup();
  openFeatureChat.mockReset();
  syncRows = [];
});

function makeProps(params: Record<string, unknown>): PanelComponentProps {
  return {
    params,
    api: { setParams: vi.fn(), setTitle: vi.fn() },
  } as unknown as PanelComponentProps;
}

describe('AdvChatPanel free slot (WI-125)', () => {
  it('lists open work items in the picker and filters terminal states', () => {
    syncRows = [
      { id: 'WI-1', title: 'Open item', state: 'in_progress' },
      { id: 'WI-2', title: 'Done item', state: 'done' },
      { id: 'WI-3', title: 'Fresh item', state: 'open' },
    ];
    render(<AdvChatPanel {...makeProps({ harnessSlug: 'papercup' })} />);
    const select = screen.getByTestId('adv-chat-pick') as HTMLSelectElement;
    const labels = [...select.options].map((o) => o.text);
    expect(labels).toContain('WI-1 · Open item');
    expect(labels).toContain('WI-3 · Fresh item');
    expect(labels.find((l) => l.includes('WI-2'))).toBeUndefined();
  });

  it('starts a worker/discuss chat for the picked work item', async () => {
    openFeatureChat.mockResolvedValue({ chatId: 'c-1' });
    syncRows = [{ id: 'WI-7', title: 'Steer me', state: 'open' }];
    render(<AdvChatPanel {...makeProps({ harnessSlug: 'papercup' })} />);

    const startBtn = screen.getByTestId('adv-chat-start') as HTMLButtonElement;
    expect(startBtn.disabled).toBe(true); // nothing picked yet

    fireEvent.change(screen.getByTestId('adv-chat-pick'), { target: { value: 'WI-7' } });
    fireEvent.click(screen.getByTestId('adv-chat-start'));

    await waitFor(() => expect(openFeatureChat).toHaveBeenCalledTimes(1));
    expect(openFeatureChat).toHaveBeenCalledWith({
      slug: 'papercup',
      role: 'worker',
      featureId: 'WI-7',
      title: 'Steer me',
      mode: 'discuss',
    });
  });

  it('renders the bound chat when params carry a chatId', () => {
    render(<AdvChatPanel {...makeProps({ harnessSlug: 'papercup', chatId: 'c-9' })} />);
    expect(screen.getByText('chat:papercup:c-9')).toBeTruthy();
    expect(screen.queryByTestId('adv-chat-pick')).toBeNull();
  });
});
