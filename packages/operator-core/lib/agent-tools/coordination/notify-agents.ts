/**
 * notify-agents — directly @-mention a LIST of specific agents about a freshly
 * created, subscribable artifact (an issue, improvement, plan, conversation…).
 *
 * Why this exists: the filing/creation verbs (issues:create, improvements:capture,
 * …) route by TOPIC — they fan out to whoever subscribed to an area. That's great
 * for "whoever cares about X" but has no DIRECTED mode: when you file something a
 * SPECIFIC peer should see/own (e.g. the agent who owns the code you just found a
 * bug in), you can't address them on the artifact. coord:message-agent's own
 * doc-comment spells out the friction — "reaching one specific agent takes three
 * steps" (open thread → subscribe → ping). This helper packages that three-step
 * reach-one pattern, generalized to an arbitrary object ref + a LIST, so any
 * create verb can offer a `notifyAgents` arg.
 *
 * For each addressee it:
 *   1. RESOLVES a short id / handle to the full ownerId against the live roster
 *      (fail-soft — an unmatched id is used as-is),
 *   2. SUBSCRIBES them to the object so every later update reaches them — DURABLE,
 *      so it survives their session dying (they see it on return / via the object),
 *   3. PINGS them with a direct coord message (the inject they read mid-turn)
 *      pointing back at the object.
 *
 * Self-sends and blanks are skipped. Best-effort throughout: a subscribe/ping miss
 * for one addressee never blocks the others (or the filing). This is `notify`/`cc`
 * semantics (you should SEE this) — NOT assignment (ownership), which stays a
 * separate, heavier act.
 */
import { objectToTargetRef, type ObjectRef } from '@papercusp/coordination/capabilities';
import type { AgentIdentity } from './identity';
import { sendMessage } from './messages';
import { wakeRecipients } from './inbox-wake';
import { resolveBestEffortAgainstRoster } from './recipient-resolve';
import { getCoordSubscriptionStore } from './subscription-store';

export interface NotifyAgentsOpts {
  /** Agent ownerId prefixes / handles to notify (resolved against the roster). */
  addressees: string[];
  /** The object they're being tagged on — e.g. `issueRef(id)`. Drives the subscribe. */
  objectRef: ObjectRef;
  /** The ping summary (what they read mid-turn). Keep it short + reference the object. */
  summary: string;
  /** The ping body — should point back at the object so they land on it. */
  body: string;
  harnessSlug?: string;
  planSlug?: string;
  /** Also re-invoke a sleeping addressee now (federated wake intent). Default false. */
  wake?: boolean;
}

export interface NotifyAgentsResult {
  /** Addressees that were pinged (resolved ownerIds). */
  notified: string[];
  /** Addressees subscribed to the object (durable; superset-ish of notified). */
  subscribed: string[];
  /** Count of addressees actively re-invoked (only when `wake` was set). */
  woke: number;
}

/** @see module docstring. Reach a LIST of named agents on a created object. */
export async function notifyAgents(
  identity: AgentIdentity,
  opts: NotifyAgentsOpts,
): Promise<NotifyAgentsResult> {
  const notified: string[] = [];
  const subscribed: string[] = [];
  const list = opts.addressees.map((a) => a?.trim()).filter((a): a is string => !!a);
  if (list.length === 0) return { notified, subscribed };

  // 1. Resolve short ids / handles → full ownerIds (fail-soft: input kept on miss).
  const resolved = await resolveBestEffortAgainstRoster(list, identity.workspaceId).catch(() => list);
  const targets = Array.from(
    new Set(resolved.map((r, i) => r || list[i])),
  ).filter((o) => o && o !== identity.ownerId); // dedupe + never self-notify
  if (targets.length === 0) return { notified, subscribed };

  const subs = new PgEntitySubscriptionStore({ getSql: () => getOrgPg().sql, ensureSchema: async () => {} });
  const targetRef = objectToTargetRef(opts.objectRef);
  const now = new Date().toISOString();

  for (const owner of targets) {
    // 2. Subscribe (durable — reaches them even if offline now / on future updates).
    try {
      await subs.subscribe({
        subscriber_id: owner,
        target_kind: 'object',
        target_ref: targetRef,
        delivery_mode: 'full',
        created_ts: now,
      });
      subscribed.push(owner);
    } catch {
      /* best-effort — the ping below still reaches them */
    }
    // 3. Ping (the inject they read mid-turn), pointing back at the object.
    try {
      await sendMessage(identity, {
        to: [owner],
        summary: opts.summary,
        body: opts.body,
        ...(opts.harnessSlug ? { harnessSlug: opts.harnessSlug } : {}),
        ...(opts.planSlug ? { plan_slug: opts.planSlug } : {}),
        ...(opts.wake ? { extra: { wake: true } } : {}),
      });
      notified.push(owner);
    } catch {
      /* best-effort */
    }
  }
  return { notified, subscribed };
}
