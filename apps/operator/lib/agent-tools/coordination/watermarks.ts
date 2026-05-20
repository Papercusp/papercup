/**
 * watermarks.ts — per-agent "last-read" pointers.
 *
 * agent-coordination-architecture-v2 §7.2. Each agent has one
 * `coord/watermarks/<ownerId>.json` recording how far it has read each
 * coordination surface. The OMP turn-start extension uses the
 * `messages_since_ts` pointer to filter `coord:inbox` down to what is
 * genuinely *new since the last turn* — without it, an agent re-sees
 * every unacked notification on every turn.
 *
 * Single writer per file (the owning agent, via coord:watermark-set),
 * so `fs.writeFile` is sufficient — no lock.
 *
 * Conservative-by-design (§7.2): the watermark is advanced at *turn
 * end*, not turn start. An aborted turn never writes it, so the next
 * turn re-sees the same notifications — a missed notification is worse
 * than a repeated one.
 */

import { promises as fs } from 'node:fs';
import { dirname } from 'node:path';
import { watermarkFile } from './paths';

export interface Watermark {
  /** Inbox messages/acks/notifies/handoffs read up to this ISO ts. */
  messages_since_ts: string;
  /** Escalations read up to this ISO ts. */
  escalations_since_ts: string;
  /** plan-events read up to this ISO ts. */
  plan_events_since_ts: string;
  /** msg_ids of subscription `notify`s already surfaced. */
  subscriptions_fired: string[];
}

/** A fresh watermark — everything unread. */
export function emptyWatermark(): Watermark {
  return {
    messages_since_ts: '',
    escalations_since_ts: '',
    plan_events_since_ts: '',
    subscriptions_fired: [],
  };
}

/**
 * Read an agent's watermark. A missing or malformed file is treated as
 * "never read anything" — returns an empty watermark. Never throws for
 * the common cases; the caller can rely on a well-formed result.
 */
export async function readWatermark(ownerId: string): Promise<Watermark> {
  let buf: string;
  try {
    buf = await fs.readFile(watermarkFile(ownerId), 'utf8');
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException)?.code === 'ENOENT') return emptyWatermark();
    throw e;
  }
  try {
    const parsed = JSON.parse(buf) as Partial<Watermark>;
    const base = emptyWatermark();
    return {
      messages_since_ts:
        typeof parsed.messages_since_ts === 'string' ? parsed.messages_since_ts : base.messages_since_ts,
      escalations_since_ts:
        typeof parsed.escalations_since_ts === 'string' ? parsed.escalations_since_ts : base.escalations_since_ts,
      plan_events_since_ts:
        typeof parsed.plan_events_since_ts === 'string' ? parsed.plan_events_since_ts : base.plan_events_since_ts,
      subscriptions_fired: Array.isArray(parsed.subscriptions_fired)
        ? parsed.subscriptions_fired.filter((x): x is string => typeof x === 'string')
        : base.subscriptions_fired,
    };
  } catch {
    // Malformed file — treat as unread rather than failing the turn.
    return emptyWatermark();
  }
}

/**
 * Merge `patch` into the agent's watermark and persist it. Omitted
 * fields keep their current value (partial update). `subscriptions_fired`
 * is *replaced* when supplied, not appended — the caller owns dedup.
 */
export async function writeWatermark(
  ownerId: string,
  patch: Partial<Watermark>,
): Promise<Watermark> {
  const current = await readWatermark(ownerId);
  const next: Watermark = {
    messages_since_ts: patch.messages_since_ts ?? current.messages_since_ts,
    escalations_since_ts: patch.escalations_since_ts ?? current.escalations_since_ts,
    plan_events_since_ts: patch.plan_events_since_ts ?? current.plan_events_since_ts,
    subscriptions_fired: patch.subscriptions_fired ?? current.subscriptions_fired,
  };
  const file = watermarkFile(ownerId);
  await fs.mkdir(dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(next, null, 2), 'utf8');
  return next;
}
