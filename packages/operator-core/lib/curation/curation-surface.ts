/**
 * Curated-message surface — the OUTPUT half of the curator-operator
 * (plan `curator-operator-2026-06-04`, P0 / D-001).
 *
 * The operator is the fleet's single user-facing voice. When the curation loop
 * decides to surface something, it writes ONE curated message into the
 * workspace's operator conversation as a system-generated assistant turn, then
 * fires the sync-invalidate so it live-tails into the desktop chat AND any pui
 * operator pane subscribed to `operatorTurns.byConversation` (the
 * `tui-operator-surface` plan). No new transport — it rides the existing chat
 * channel, so curated status appears exactly where the user already talks to
 * the operator.
 *
 * `role: 'assistant'`, `source: 'system'` — a system-generated (not user-typed)
 * operator utterance; renders in the chat live-tail with no enum changes.
 */
import { getOrCreateActiveConversation, appendTurn } from '../operator-conversations';
import { notifySyncInvalidate } from '../sync-sse';

/**
 * Surface one curated message into the operator conversation. Returns the
 * conversation + turn ids (useful for tests / audit). Workspace-scoped via the
 * ambient `activeWorkspaceId()` (the loop runs each workspace in its own scope).
 */
export async function surfaceCuratedMessage(text: string): Promise<{ conversationId: string; turnId: string }> {
  const convo = await getOrCreateActiveConversation();
  const turn = await appendTurn({
    conversationId: convo.id,
    role: 'assistant',
    text,
    source: 'system',
  });
  void notifySyncInvalidate('operatorTurns.byConversation', { conversationId: convo.id }).catch(() => {});
  return { conversationId: convo.id, turnId: turn.id };
}
