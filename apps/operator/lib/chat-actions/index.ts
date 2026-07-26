/**
 * ChatAction registry — public surface.
 *
 * Import once from this module; the side-effect imports below register
 * every known action. Future action authors add a line here (and ship an
 * Entry module beside this one) — see lib/chat-cards/index.ts for the exact
 * same pattern one level over.
 *
 *   import { listChatActions } from '@/lib/chat-actions';
 *   const actions = listChatActions(ctx);
 *
 * No concrete actions are registered yet — this is the substrate
 * (gui-chat-session-controls-2026-07-25 P-002). Posture (P-004), grade
 * (P-005), and session actions (P-006) each add an Entry module + a line
 * below without touching the bar or the registry.
 */

export {
  registerChatAction,
  getChatAction,
  listChatActions,
  listAllChatActionIds,
  _resetChatActionsForTests,
} from './registry';
export type { ChatAction, ChatActionContext, ChatActionConfirm } from './types';

// Side-effect: registers concrete actions. P-005/P-006 each add
// `import './FooAction';` here.
import './PostureActions';
