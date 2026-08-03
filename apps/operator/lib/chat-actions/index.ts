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
  registerChatModeAction,
  getChatModeAction,
  listChatModeActions,
  listAllChatModeActionIds,
  _resetChatActionsForTests,
} from './registry';
export type {
  ChatAction,
  ChatActionContext,
  ChatActionConfirm,
  ChatModeAction,
  ChatModeOption,
  ChatModeState,
} from './types';

// Side-effect: registers concrete actions.
//
// There is deliberately no `GradeAction` here. It was a 'Grade session…' button
// that opened a rubric picker and then set grade mode ON — i.e. the same
// mode:set the GRADE pill (PostureActions' overlay pills) already performs, so
// the two read as one duplicated control. Removed [owner 2026-08-03]:
// "remove the grade session button next to focus window, we dont need it if we
// have the grade on off toggle right above it".
//
// What went with it: the rubric CHOICE. The pill turns grade mode on without
// naming a rubric, and the rubric only ever rode in mode:set's free-text
// `reason`, never as structured state. To give the choice back, the right shape
// is the GRADE pill itself offering one option per active rubric (Off + each
// rubric) rather than a second button — blocked today only because
// ChatModeAction.options() is synchronous while `rubrics.list` is fetched.
import './PostureActions';
import './SessionActions';
