'use client';

/**
 * AdvChatPanel — a dockview panel slot that hosts an in-app agent chat.
 *
 * Reuses the standalone <ChatPanel> (the same one the retired /pi dock
 * mounted). A panel is a reusable "slot": when its params carry a
 * `chatId` it renders that chat; when empty it shows a placeholder and
 * is a "free slot" the open-chat drain (HarnessesDock) fills first.
 * Archiving a chat clears the slot back to free rather than closing the
 * panel, so it can host the next chat.
 */

import { useCallback } from 'react';
import ChatPanel from '../../harness/ChatPanel';
import type { PanelComponentProps } from '../../harness/dock/panel-registry';

export default function AdvChatPanel({ params, api }: PanelComponentProps) {
  const slug = (params.harnessSlug as string) || '';
  const chatId = (params.chatId as string) || '';

  const onArchive = useCallback(() => {
    // Free the slot (keep the panel) so the next opened chat reuses it.
    api.setParams({ ...params, chatId: null });
    api.setTitle('Chat');
  }, [api, params]);

  if (!chatId) {
    return (
      <div
        className="pc-adv-chat-empty"
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          height: '100%',
          padding: '16px',
          textAlign: 'center',
          color: 'var(--fg-dim)',
          fontSize: '13px',
          lineHeight: 1.5,
        }}
      >
        No chat open. Use the <span aria-hidden>&nbsp;💬&nbsp;</span> button on a feature
        (row or detail) to start a worker chat here.
      </div>
    );
  }

  return (
    <div style={{ width: '100%', height: '100%', minHeight: 0, display: 'flex' }}>
      <ChatPanel slug={slug} chatId={chatId} onArchive={onArchive} />
    </div>
  );
}
