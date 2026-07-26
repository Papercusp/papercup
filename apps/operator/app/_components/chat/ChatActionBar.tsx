'use client';

/**
 * ChatActionBar — renders the ChatAction registry as a row of buttons
 * (gui-chat-session-controls-2026-07-25 P-002). Adding an action means
 * registering a descriptor (lib/chat-actions) — this component never grows
 * a per-action branch.
 *
 * Value collection: an action with `params` opens its CardSpec through
 * `askUserLocal` — rendered by whichever `<LocalCardHost/>` is mounted in
 * the same tree (SessionChatModal mounts one alongside this bar). A
 * `confirm` step (no payload) reuses the same plumbing via a synthetic
 * single-option card; declining (Skip) cancels the run.
 */
import { useMemo, useState, type ReactNode } from 'react';
import { z } from 'zod';
import { askUserLocal } from '@/lib/chat-cards/ask-user-local';
import { listChatActions } from '@/lib/chat-actions/registry';
import type { ChatAction, ChatActionContext } from '@/lib/chat-actions/types';

async function confirmed(action: ChatAction, ctx: ChatActionContext): Promise<boolean> {
  const spec = typeof action.confirm === 'function' ? action.confirm(ctx) : action.confirm;
  if (!spec) return true;
  const r = await askUserLocal({
    prompt: spec.message,
    dataSchema: z.object({ picks: z.tuple([z.literal('confirm')]) }),
    presentation: {
      kind: 'radio',
      options: [{ id: 'confirm', label: spec.confirmLabel ?? 'Confirm', style: 'primary' }],
    },
    allowDecline: true,
  });
  return r.action === 'submit';
}

interface GroupedActions {
  group: string;
  actions: ChatAction[];
}

function groupActions(actions: ChatAction[]): GroupedActions[] {
  const order: string[] = [];
  const byGroup = new Map<string, ChatAction[]>();
  for (const action of actions) {
    const g = action.group ?? '';
    if (!byGroup.has(g)) {
      byGroup.set(g, []);
      order.push(g);
    }
    byGroup.get(g)!.push(action);
  }
  return order.map((group) => ({ group, actions: byGroup.get(group)! }));
}

export function ChatActionBar({ ctx }: { ctx: ChatActionContext }): ReactNode {
  const actions = useMemo(() => listChatActions(ctx), [ctx]);
  const [runningId, setRunningId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (actions.length === 0) return null;

  const invoke = async (action: ChatAction): Promise<void> => {
    setError(null);
    setRunningId(action.id);
    try {
      if (!(await confirmed(action, ctx))) return;
      let value: unknown;
      if (action.params) {
        const spec = await action.params(ctx);
        const r = await askUserLocal(spec);
        if (r.action !== 'submit') return;
        value = r.payload;
      }
      await action.run(ctx, value);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      // eslint-disable-next-line no-console
      console.warn(`[chat-action-bar] ${action.id} failed`, e);
    } finally {
      setRunningId(null);
    }
  };

  return (
    <div className="chat-action-bar" role="toolbar" aria-label="Chat actions" data-testid="chat-action-bar">
      {groupActions(actions).map(({ group, actions: groupItems }) => (
        <div className="chat-action-bar-group" key={group || '_'} data-group={group || undefined}>
          {groupItems.map((action) => (
            <button
              key={action.id}
              type="button"
              className="chat-action-bar-button"
              onClick={() => void invoke(action)}
              disabled={runningId !== null}
              aria-busy={runningId === action.id}
            >
              {action.icon}
              <span>{action.label}</span>
            </button>
          ))}
        </div>
      ))}
      {error && (
        <div className="chat-action-bar-error" role="alert">
          {error}
        </div>
      )}
    </div>
  );
}
