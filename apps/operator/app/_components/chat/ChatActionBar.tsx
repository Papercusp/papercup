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
import { useMemo, useState, type CSSProperties, type ReactNode } from 'react';
import { z } from 'zod';
import { askUserLocal } from '@/lib/chat-cards/ask-user-local';
// Import the BARREL, not `chat-actions/registry` directly: the barrel's
// side-effect imports (`import './SessionActions'` etc.) are what REGISTER the
// concrete actions. Importing the registry module alone gets you a working
// `listChatActions` over an EMPTY registry — so the bar rendered `null` and the
// whole action bar was invisible in the app, while unit tests stayed green
// because they import the action modules directly. Keep this pointed at the
// barrel; the shorter-looking `/registry` path is the bug.
import { listChatActions } from '@/lib/chat-actions';
import type { ChatAction, ChatActionContext } from '@/lib/chat-actions/types';

/** WI-6552: ceiling on a `params()` option-load before the bar gives up. */
const PARAMS_TIMEOUT_MS = 12_000;

/**
 * Reject with `message` if `p` has not settled within `ms`. The pending
 * promise is abandoned, not cancelled — there is nothing to cancel through
 * the ChatAction contract — but the BAR recovers, which is the point: a
 * never-settling `params()` otherwise pins the button aria-busy forever.
 */
async function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

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

/**
 * Inline styles, deliberately — `.chat-action-bar` / `.chat-action-bar-button`
 * were emitted by this component but defined in NO stylesheet in the repo, so
 * the bar rendered as bare UA buttons with the icon jammed against the label
 * ("↻Resume in new terminal"). The chat surface and AgentInspectorModal both
 * style inline rather than via a sheet, so this matches the surrounding
 * convention instead of introducing a stylesheet only this component loads.
 *
 * The button values are copied from AgentInspectorModal's resume/fork/focus
 * buttons so the two surfaces render as visibly the same control — which is
 * the actual ask behind P-015 ("the same ones that show up in the turn
 * history"). The classNames are kept for tests and for any future sheet.
 */
const BAR_STYLE: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  alignItems: 'center',
  gap: 6,
  padding: '6px 8px',
};

const BUTTON_STYLE: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 4,
  font: 'inherit',
  fontSize: 11,
  lineHeight: 1.4,
  padding: '2px 8px',
  borderRadius: 5,
  border: '1px solid var(--border)',
  background: 'var(--bg-1)',
  color: 'var(--fg)',
};

const GROUP_STYLE: CSSProperties = { display: 'inline-flex', alignItems: 'center', gap: 6 };

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
  /** WI-6552: last action that completed successfully — the success half of
   *  the feedback pair below. Cleared whenever another action starts. */
  const [done, setDone] = useState<string | null>(null);

  if (actions.length === 0) return null;

  const invoke = async (action: ChatAction): Promise<void> => {
    setError(null);
    setDone(null);
    setRunningId(action.id);
    try {
      if (!(await confirmed(action, ctx))) return;
      let value: unknown;
      if (action.params) {
        // WI-6552: `params()` may hang rather than settle — Grade's fetches
        // `rubrics.list` through the sync layer's in-flight gate, which can
        // queue behind a page's other queries and never resolve OR reject.
        // Awaiting it unbounded leaves this button aria-busy + disabled with
        // NO card and NO error: a permanently dead action bar, which is the
        // same "nothing happened" the owner reported, in its worst form.
        // Bound it so the failure is at least legible and the bar recovers.
        const spec = await withTimeout(
          action.params(ctx),
          PARAMS_TIMEOUT_MS,
          `${action.label} could not load its options in time — try again.`,
        );
        const r = await askUserLocal(spec);
        if (r.action !== 'submit') return;
        value = r.payload;
      }
      await action.run(ctx, value);
      // WI-6552 [owner:Avi 2026-07-27, verbatim] "I also selected one of the
      // rubrics and nothing happaned." It very likely DID happen: single-select
      // cards commit on click and `run` posts the directive, but this bar only
      // ever rendered feedback in the CATCH below — a fully successful action
      // returned in complete silence, which is indistinguishable from a dead
      // click. Acknowledge success too, so the two outcomes never look alike.
      setDone(action.label);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      // eslint-disable-next-line no-console
      console.warn(`[chat-action-bar] ${action.id} failed`, e);
    } finally {
      setRunningId(null);
    }
  };

  return (
    <div className="chat-action-bar" role="toolbar" aria-label="Chat actions" data-testid="chat-action-bar" style={BAR_STYLE}>
      {groupActions(actions).map(({ group, actions: groupItems }) => (
        <div className="chat-action-bar-group" key={group || '_'} data-group={group || undefined} style={GROUP_STYLE}>
          {groupItems.map((action) => (
            <button
              key={action.id}
              type="button"
              className="chat-action-bar-button"
              data-testid={`chat-action-${action.id}`}
              onClick={() => void invoke(action)}
              disabled={runningId !== null}
              aria-busy={runningId === action.id}
              style={{ ...BUTTON_STYLE, cursor: runningId !== null ? 'default' : 'pointer' }}
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
      {!error && done && (
        <div className="chat-action-bar-done" role="status" data-testid="chat-action-bar-done">
          ✓ {done} applied
        </div>
      )}
    </div>
  );
}
