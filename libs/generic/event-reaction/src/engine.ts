/**
 * The reaction engine: turn matched actions into scheduled reactions.
 *
 * Flow (the host calls `runReactions` from its post-event hook):
 *   1. for each matched action: apply the per-rule success gate;
 *   2. apply the loop guard (depth cap + cycle detection);
 *   3. SCHEDULE the reaction OFF the hot path — fire-and-forget, never blocking
 *      or breaking the trigger.
 *
 * Scheduling routes a `durable`-mode rule to the injected durable seam when one
 * is installed (survives restart, retried, deduped), else fires in-process; a
 * `sync`-mode rule always fires in-process. A durable-enqueue hiccup falls back
 * to in-process so a reaction is never DROPPED.
 *
 * Everything host-specific — how a fire descriptor becomes a real call, and the
 * durable runner — is injected. The engine is pure orchestration over ports.
 */

import type { MatchedAction } from '@papercusp/rules';
import { guardReaction, type GuardDecision } from './loop-guard';
import type { ReactionCause, ReactionRule } from './types';

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** The result of firing a reaction in-process. */
export interface FireResult {
  ok: boolean;
  error?: string;
}

/** The dispatcher port — how a fire descriptor becomes a real, settled call. */
export type FireInProcess<TEvent, TFire = string> = (args: {
  fire: TFire;
  args: Record<string, unknown>;
  /** The triggering event (carries whatever scope the host needs to dispatch). */
  event: TEvent;
  /** The cause-chain to stamp on the call this reaction makes. */
  cause: ReactionCause;
  /** Capability scope for a sandboxed rule, if any. */
  capability?: string;
}) => Promise<FireResult>;

/** The in-memory input the engine hands the durable runner (the event is NOT serializable). */
export interface DurableReactionInput<TEvent, TFire = string> {
  rule: ReactionRule<TEvent, TFire>;
  fire: TFire;
  args: Record<string, unknown>;
  event: TEvent;
  cause: ReactionCause;
}

/** The durable-execution seam — omit (or `enabled()===false`) ⇒ everything runs in-process. */
export interface DurableSeam<TEvent, TFire = string> {
  /** Whether the durable path is live (a runner is installed). */
  enabled(): boolean;
  /** Enqueue a reaction durably. May throw — the engine then falls back in-process. */
  run(input: DurableReactionInput<TEvent, TFire>): Promise<void>;
}

/** Schedule one reaction: route durable-vs-in-process, with an in-process fallback. */
export async function scheduleReaction<TEvent, TFire = string>(opts: {
  rule: ReactionRule<TEvent, TFire>;
  fire: TFire;
  args: Record<string, unknown>;
  event: TEvent;
  cause: ReactionCause;
  fireInProcess: FireInProcess<TEvent, TFire>;
  durable?: DurableSeam<TEvent, TFire>;
  log?: (msg: string) => void;
}): Promise<void> {
  const { rule, fire, args, event, cause, fireInProcess, durable, log } = opts;
  try {
    // mode 'durable' (default) → durable seam when installed; else in-process.
    // mode 'sync' → always in-process (lightweight, no durability).
    const wantsDurable = (rule.mode ?? 'durable') === 'durable';
    if (wantsDurable && durable?.enabled()) {
      try {
        await durable.run({ rule, fire, args, event, cause });
        return;
      } catch (enqueueErr) {
        // A durable-enqueue hiccup must never DROP a reaction — fall back to
        // in-process so the side effect still happens (best-effort, no durability).
        log?.(`durable enqueue for ${rule.id} → ${String(fire)} failed; firing in-process: ${errMsg(enqueueErr)}`);
      }
    }
    const r = await fireInProcess({ fire, args, event, cause, capability: rule.capability });
    if (!r.ok) log?.(`reaction ${rule.id} → ${String(fire)} failed: ${r.error}`);
  } catch (err) {
    log?.(`reaction ${rule.id} → ${String(fire)} threw: ${errMsg(err)}`);
  }
}

/**
 * Run the matched reactions for one event: success-gate + loop-guard + schedule.
 * Synchronous up to the schedule point (matching + guard are cheap); each
 * reaction runs off the hot path via `void scheduleReaction`, so a reaction can
 * never delay or break its trigger.
 */
export function runReactions<TEvent, TFire = string>(opts: {
  /** The matched actions (from a `ReactionRegistry.match`). */
  actions: Array<MatchedAction<TEvent, TFire>>;
  /** The triggering event. */
  event: TEvent;
  /** Whether the trigger succeeded (for the per-rule `onlyOnSuccess` gate). */
  succeeded: boolean;
  /** The trigger's cause-chain, if it was itself a reaction. */
  cause?: ReactionCause;
  /** Root run id to root a new chain when `cause` is undefined. */
  rootRunId?: string | null;
  fireInProcess: FireInProcess<TEvent, TFire>;
  durable?: DurableSeam<TEvent, TFire>;
  log?: (msg: string) => void;
}): void {
  for (const action of opts.actions) {
    const rule = action.rule as ReactionRule<TEvent, TFire>;

    // Success gate (default true): don't react to a failed trigger.
    if ((rule.onlyOnSuccess ?? true) && !opts.succeeded) continue;

    // Loop / cascade guard (mandatory).
    const guard: GuardDecision = guardReaction({
      cause: opts.cause,
      ruleId: rule.id,
      rootRunId: opts.rootRunId ?? null,
    });
    if (!guard.allow) {
      opts.log?.(
        `dropped reaction ${rule.id} → ${String(action.fire)} (${guard.reason}; chain=${(opts.cause?.chain ?? []).join('→')})`,
      );
      continue;
    }

    // Schedule OFF the hot path. fire-and-forget; the trigger has already returned.
    void scheduleReaction({
      rule,
      fire: action.fire,
      args: action.args,
      event: opts.event,
      cause: guard.nextCause,
      fireInProcess: opts.fireInProcess,
      durable: opts.durable,
      log: opts.log,
    });
  }
}
