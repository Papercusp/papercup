/**
 * chat-seed — hand a drafted message to the Papercup chat composer
 * (owner ask 2026-07-16: the Inbox "Discuss" action opens a chat with
 * Papercup about the item, instead of a thread with the — usually dead or
 * system — originating agent).
 *
 * Two delivery paths, consume-once either way:
 *  - the pending store: OperatorChat is usually NOT mounted when Discuss is
 *    clicked (the inbox view replaces the chat body), so it consumes the seed
 *    in its input-state initializer on mount;
 *  - the window event: covers a mounted composer (defensive — no current
 *    caller seeds while the chat is visible).
 */
let pending: string | null = null;

export const CHAT_SEED_EVENT = 'papercusp:seedOperatorChatDraft';

/** Stage `text` as the Papercup composer draft and notify a mounted chat. */
export function seedOperatorChatDraft(text: string): void {
  pending = text;
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(CHAT_SEED_EVENT, { detail: { text } }));
  }
}

/** One-shot read: returns the staged draft and clears it. */
export function consumePendingChatSeed(): string | null {
  const p = pending;
  pending = null;
  return p;
}
