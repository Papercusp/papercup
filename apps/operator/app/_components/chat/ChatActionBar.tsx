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
// Import the BARREL, not `chat-actions/registry` directly: the barrel's
// side-effect imports (`import './SessionActions'` etc.) are what REGISTER the
// concrete actions. Importing the registry module alone gets you a working
// `listChatActions` over an EMPTY registry — so the bar rendered `null` and the
// whole action bar was invisible in the app, while unit tests stayed green
// because they import the action modules directly. Keep this pointed at the
// barrel; the shorter-looking `/registry` path is the bug.
import { listChatActions, listChatModeActions } from '@/lib/chat-actions';
import type { ChatAction, ChatActionContext, ChatModeAction } from '@/lib/chat-actions/types';

/**
 * WI-6552: ceiling on a `params()` option-load before the bar gives up.
 *
 * This exists to guarantee the bar RECOVERS from a load that never settles —
 * not to enforce snappiness. Erroring out a load that would have succeeded is
 * a worse failure than making the user wait, because it turns a working
 * feature into a broken one.
 *
 * P-009 / D-003: DERIVED, not picked. The previous value was a bare 30_000
 * justified by "a cold `rubrics.list` can take far longer than a snappy budget
 * would allow" — but that observation was measuring WI-6559, where the sync
 * gate's deadline did not cover the queue wait, so a cold `rubrics.list` never
 * settled at all. That bug is fixed; the justification died with it. The real
 * post-fix numbers are nowhere near 30s: warm resolve 250ms, server 8.8ms, and
 * a 106-query desktop startup wave completes in ~2.9s at p50 395ms.
 *
 * What actually sets the floor is an ORDERING INVARIANT, not a latency budget.
 * The sync layer rejects a request that cannot get a gate slot at its
 * DEFAULT_REQUEST_TIMEOUT_MS (20s) with a real, specific message. This ceiling
 * must sit ABOVE that, or it fires first and replaces that message with an
 * opaque "timed out" — re-creating the very opacity WI-6559 was filed for.
 * 25s = the layer's 20s + 5s of headroom for the rejection to propagate and
 * render.
 *
 * Deliberately a LITERAL rather than `DEFAULT_REQUEST_TIMEOUT_MS + 5_000`:
 * importing that constant pulls the `@papercusp/sync` barrel into this module's
 * graph, and ~90 test files across the tree `vi.mock('@papercusp/sync')` with
 * hand-written factories. Any of them that transitively reaches this component
 * would fail with "No DEFAULT_REQUEST_TIMEOUT_MS export is defined on the mock"
 * — a tree-wide fixture break, in files this change never touched, to derive
 * one number. The ordering is instead enforced by the guard test in
 * ChatActionBar.test.tsx, which imports the real constant (it mocks no barrel),
 * so the invariant is still checked without the coupling.
 */
export const PARAMS_TIMEOUT_MS = 25_000;

/**
 * Reject with `message` if `p` has not settled within `ms`. The pending
 * promise is abandoned, not cancelled — there is nothing to cancel through
 * the ChatAction contract — but the BAR recovers, which is the point: a
 * never-settling `params()` otherwise pins the button aria-busy forever.
 */
export async function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
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
 * P-003 replaced this component's inline styles with the shared control
 * VOCABULARY (`pc-ctl-*`, chat-controls.css, loaded by SessionChatModal).
 *
 * The inline styles existed because `.chat-action-bar-button` was emitted here
 * but defined in NO stylesheet in the repo, so the bar rendered as bare UA
 * buttons with the icon jammed against the label ("↻Resume in new terminal").
 * A real sheet now exists and every chat surface loads it, so the classes are
 * load-bearing rather than decorative — and being classes is the point: the
 * five shapes have to be declared in ONE place for "rounded means the system
 * is telling you something" to hold anywhere.
 *
 * The old classNames (`chat-action-bar`, `chat-action-bar-button`) are kept
 * alongside the new ones so existing tests and any external selector keep
 * working.
 */
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
  /** P-005: the mode axes, rendered as pills ahead of the verbs. */
  const modes = useMemo(() => listChatModeActions(ctx), [ctx]);
  const [runningId, setRunningId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** WI-6552: last action that completed successfully — the success half of
   *  the feedback pair below. Cleared whenever another action starts. */
  const [done, setDone] = useState<string | null>(null);

  if (actions.length === 0 && modes.length === 0) return null;

  /**
   * A mode pill's click opens its chooser, then writes the pick. Deliberately
   * the SAME askUserLocal/LocalCardHost plumbing an action's `params()` uses —
   * there is no second card vocabulary (plan D-001), so a mode chooser looks
   * and behaves exactly like every other chooser on the surface.
   */
  const invokeMode = async (mode: ChatModeAction): Promise<void> => {
    setError(null);
    setDone(null);
    setRunningId(mode.id);
    try {
      const options = mode.options(ctx);
      const r = await askUserLocal({
        prompt: `Set ${mode.cap}`,
        // z.string() rather than z.enum: the option set is supplied by the
        // descriptor at click time, so it is not a compile-time constant.
        dataSchema: z.object({ picks: z.tuple([z.string()]) }),
        presentation: {
          kind: 'radio',
          options: options.map((o) => ({ id: o.id, label: o.label, hint: o.hint })),
        },
        allowDecline: true,
      });
      if (r.action !== 'submit') return;
      const [choice] = (r.payload as { picks: [string] }).picks;
      await mode.set(ctx, choice);
      setDone(`${mode.cap} → ${options.find((o) => o.id === choice)?.label ?? choice}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      // eslint-disable-next-line no-console
      console.warn(`[chat-action-bar] mode ${mode.id} failed`, e);
    } finally {
      setRunningId(null);
    }
  };

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
      // WI-6552 [owner 2026-07-27, verbatim] "I also selected one of the
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
    <div
      className="chat-action-bar pc-ctl-band pc-ctl-band--do"
      role="toolbar"
      aria-label="Chat actions"
      data-testid="chat-action-bar"
    >
      {/* Modes first: they say what the agent IS, and the verbs below act on
          it. Reading order follows that dependency. */}
      {modes.map((mode) => {
        const state = mode.current(ctx);
        return (
          <button
            key={mode.id}
            type="button"
            className={`pc-ctl-mode${state.on ? '' : ' pc-ctl-mode--off'}`}
            data-testid={`chat-mode-${mode.id}`}
            data-on={state.on ? 'true' : 'false'}
            onClick={() => void invokeMode(mode)}
            disabled={runningId !== null}
            aria-busy={runningId === mode.id}
            /* aria-label, not `title`: design-primitives forbids a title-only
               tooltip on a button, and this is the text a screen reader needs
               anyway — the visible pill is deliberately only two short words. */
            aria-label={`${mode.cap} is ${state.value}${state.title ? ` — ${state.title}` : ''}. Change it.`}
          >
            <span className="pc-ctl-mode__inner">
              <span className="pc-ctl-mode__cap">{mode.cap}</span>
              <span className="pc-ctl-mode__value">
                {state.value}
                <span aria-hidden="true">▾</span>
              </span>
            </span>
          </button>
        );
      })}
      {modes.length > 0 && actions.length > 0 ? (
        <span className="pc-ctl-band__sep" aria-hidden="true" />
      ) : null}
      {groupActions(actions).map(({ group, actions: groupItems }) => (
        <div className="chat-action-bar-group" key={group || '_'} data-group={group || undefined}>
          {groupItems.map((action) => (
            <button
              key={action.id}
              type="button"
              className="chat-action-bar-button pc-ctl-act"
              data-testid={`chat-action-${action.id}`}
              onClick={() => void invoke(action)}
              disabled={runningId !== null}
              aria-busy={runningId === action.id}
            >
              <span className="pc-ctl-act__inner">
                {action.icon ? <span className="pc-ctl-act__icon">{action.icon}</span> : null}
                <span>{action.label}</span>
              </span>
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
