'use client';

/**
 * AdvChatPanel — a dockview panel slot that hosts an in-app agent chat.
 *
 * Reuses the standalone <ChatPanel> (the same one the retired /pi dock
 * mounted). A panel is a reusable "slot": when its params carry a
 * `chatId` it renders that chat; when empty it shows a work-item picker
 * (WI-125: openable from the Add-panel catalog, so a chat can start
 * without going through Detail) and is a "free slot" the open-chat
 * drain (HarnessesDock) fills first. Archiving a chat clears the slot
 * back to free rather than closing the panel, so it can host the next
 * chat.
 */

import { useCallback, useMemo, useState } from 'react';
import { MessageCircle } from 'lucide-react';
import { openFeatureChat } from '@papercusp/papercup-shared';
import { useSyncQuery } from '@papercusp/sync';
import { toast } from 'sonner';
import ChatPanel from '../../harness/ChatPanel';
import { Select } from '../../harness/Select';
import type { PanelComponentProps } from '../../harness/dock/panel-registry';

// Terminal states excluded from the picker — steering targets in-flight work.
const TERMINAL_STATES = new Set(['done', 'closed', 'resolved', 'archived', 'deprecated']);

/** The free-slot empty state: pick a work item, start a worker chat on it.
 *  Same `openFeatureChat` defaults as the Detail-pane Chat button (EI-290):
 *  role worker, mode discuss. The drain then fills this (first free) slot. */
function StartChatPicker({ slug }: { slug: string }) {
  const [featureId, setFeatureId] = useState('');
  const [starting, setStarting] = useState(false);
  const query = useSyncQuery<{ id: string; title: string; state: string }>({
    queryName: 'workItems.byHarness',
    args: { harnessSlug: slug, limit: 300 },
    enabled: Boolean(slug),
  });
  const items = useMemo(
    () => (query.data ?? []).filter((i) => !TERMINAL_STATES.has(i.state)),
    [query.data],
  );
  const start = useCallback(async () => {
    const item = items.find((i) => i.id === featureId);
    if (!item) return;
    setStarting(true);
    try {
      const res = await openFeatureChat({
        slug,
        role: 'worker',
        featureId: item.id,
        title: item.title,
        mode: 'discuss',
      });
      if (res && typeof res === 'object' && 'error' in res) {
        throw new Error(String((res as { error: unknown }).error));
      }
    } catch (e) {
      toast.error('Open chat failed', { description: String(e) });
    } finally {
      setStarting(false);
    }
  }, [featureId, items, slug]);

  return (
    <div
      className="pc-adv-chat-empty"
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 10,
        height: '100%',
        padding: '16px',
        textAlign: 'center',
        color: 'var(--fg-dim)',
        fontSize: '13px',
        lineHeight: 1.5,
      }}
    >
      <MessageCircle size={18} aria-hidden />
      <span>
        Start a chat with the worker about a work item — or use the Chat button on a
        work item&apos;s Detail pane.
      </span>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', maxWidth: '100%' }}>
        <Select
          aria-label="Work item to chat about"
          testId="adv-chat-pick"
          value={featureId}
          onChange={setFeatureId}
          disabled={query.loading || items.length === 0}
          placeholder={query.loading ? 'Loading work items…' : items.length === 0 ? 'No open work items' : 'Choose a work item…'}
          triggerStyle={{ maxWidth: 260, fontSize: 12, padding: '4px 6px' }}
          options={items.map((i) => ({ value: i.id, label: `${i.id} · ${i.title}` }))}
        />
        <button
          type="button"
          data-testid="adv-chat-start"
          disabled={!featureId || starting}
          onClick={() => void start()}
          style={{ fontSize: 12, padding: '4px 10px' }}
        >
          {starting ? 'Starting…' : 'Start chat'}
        </button>
      </div>
    </div>
  );
}

export default function AdvChatPanel({ params, api }: PanelComponentProps) {
  const slug = (params.harnessSlug as string) || '';
  const chatId = (params.chatId as string) || '';
  const mode = params.mode === 'discuss' ? 'discuss' : undefined;

  const onArchive = useCallback(() => {
    // Free the slot (keep the panel) so the next opened chat reuses it.
    api.setParams({ ...params, chatId: null });
    api.setTitle('Chat');
  }, [api, params]);

  if (!chatId) {
    return <StartChatPicker slug={slug} />;
  }

  return (
    <div style={{ width: '100%', height: '100%', minHeight: 0, display: 'flex' }}>
      <ChatPanel slug={slug} chatId={chatId} mode={mode} onArchive={onArchive} />
    </div>
  );
}
