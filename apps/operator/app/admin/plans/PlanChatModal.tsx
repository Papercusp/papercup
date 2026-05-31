'use client';

/**
 * PlanChatModal — an in-app agent chat hosted in a modal, for the Planning
 * tab (planning-attention-importance-2026-05-31, P-017).
 *
 * The Plans tab is not inside the /adv HarnessesDock, so it can't open a
 * chat via the dock's OPEN_CHAT_EVENT (see the attention-importance-system
 * insight). Instead this creates a harness-scoped chat directly
 * (POST /api/harness/:slug/agent-chats) and renders the standalone
 * <ChatPanel> — the same component the dock mounts — inside a Modal.
 *
 * agent_chats are per-harness, so a chat needs a harnessSlug; a pure SU
 * plan with no harness shows a clear "no harness" message instead.
 */

import { useEffect, useState } from 'react';
import { Modal } from '@/app/harness/Modal';
import ChatPanel from '@/app/harness/ChatPanel';

interface Props {
  open: boolean;
  onClose: () => void;
  /** Harness the chat is scoped to (agent_chats are per-harness schema). */
  harnessSlug: string | null | undefined;
  /** Plan-context title for the chat (e.g. "<plan> · P-007"). */
  label: string;
}

export default function PlanChatModal({ open, onClose, harnessSlug, label }: Props) {
  const [chatId, setChatId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Create the chat once when the modal opens (and a harness is known).
  useEffect(() => {
    if (!open || chatId || creating || !harnessSlug) return;
    let cancelled = false;
    setCreating(true);
    setError(null);
    fetch(`/api/harness/${encodeURIComponent(harnessSlug)}/agent-chats`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ role: 'worker', title: label }),
    })
      .then(async (r) => {
        if (!r.ok) {
          const b = (await r.json().catch(() => ({}))) as { error?: string };
          throw new Error(b.error ?? `HTTP ${r.status}`);
        }
        return r.json() as Promise<{ id: string }>;
      })
      .then((chat) => {
        if (!cancelled) setChatId(chat.id);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!cancelled) setCreating(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, chatId, creating, harnessSlug, label]);

  // Reset when closed so reopening starts a fresh chat.
  useEffect(() => {
    if (!open) {
      setChatId(null);
      setError(null);
    }
  }, [open]);

  return (
    <Modal
      open={open}
      onOpenChange={(o) => !o && onClose()}
      title={`Chat — ${label}`}
      contentClassName="pc-plan-chat-modal"
    >
      {!harnessSlug ? (
        <div className="pc-plans__placeholder">
          This plan isn’t attached to a harness, so an agent chat can’t be opened here.
        </div>
      ) : error ? (
        <div className="pc-plans__placeholder pc-plans__placeholder--error">
          <p>Couldn’t start the chat:</p>
          <code>{error}</code>
        </div>
      ) : !chatId ? (
        <div className="pc-plans__placeholder">Starting chat…</div>
      ) : (
        <div className="pc-plan-chat-modal__panel">
          <ChatPanel slug={harnessSlug} chatId={chatId} mode="discuss" onArchive={onClose} />
        </div>
      )}
    </Modal>
  );
}
