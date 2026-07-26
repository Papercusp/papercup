/**
 * ChatAction registry — Map-based lookup, same pattern as
 * lib/chat-cards/registry.ts (tool-name → card renderer).
 *
 * A concrete action module calls `registerChatAction` at import time;
 * lib/chat-actions/index.ts side-effect-imports every known action module
 * so consumers (ChatActionBar) see them all by importing once.
 */
import type { ChatAction, ChatActionContext } from './types';

const REGISTRY = new Map<string, ChatAction>();

/**
 * Register an action. Re-registering the same id replaces the prior
 * descriptor (lets HMR work in dev, same as registerCard).
 */
export function registerChatAction(action: ChatAction): void {
  REGISTRY.set(action.id, action);
}

export function getChatAction(id: string): ChatAction | undefined {
  return REGISTRY.get(id);
}

/**
 * Actions available right now for `ctx`, in registration order. A throwing
 * `available()` is treated as "not available" (logged, not fatal) — one
 * broken action must not blank the whole bar.
 */
export function listChatActions(ctx: ChatActionContext): ChatAction[] {
  const out: ChatAction[] = [];
  for (const action of REGISTRY.values()) {
    let ok: boolean;
    try {
      ok = action.available(ctx);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn(`[chat-actions] ${action.id}.available threw`, e);
      continue;
    }
    if (ok) out.push(action);
  }
  return out;
}

/** All registered ids, regardless of availability. Test/debug use. */
export function listAllChatActionIds(): string[] {
  return [...REGISTRY.keys()];
}

/** Test-only — flush the registry between specs. */
export function _resetChatActionsForTests(): void {
  REGISTRY.clear();
}
