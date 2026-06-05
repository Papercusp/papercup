/**
 * watermark.ts — per-agent "last-read" pointer shape + pure merge.
 * PURE.
 *
 * The watermark is a mutable single-doc-per-agent read cursor, NOT an
 * append-only channel — so its *persistence* stays host-side (a whole-
 * file/row read-modify-write, like presence), but the value shape and
 * the partial-merge rule are pure and live here.
 *
 * (Extracted from coordination/watermarks.ts —
 * agent-coordination-architecture-v2 §7.2.)
 */

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
 * Normalise a possibly-partial/malformed parsed object into a complete
 * Watermark (missing/typed-wrong fields fall back to empty). Lets a host
 * treat a corrupt file as "never read anything" rather than failing.
 */
export function normaliseWatermark(parsed: Partial<Watermark> | null | undefined): Watermark {
  const base = emptyWatermark();
  if (!parsed || typeof parsed !== 'object') return base;
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
}

/**
 * Merge `patch` into `current`. Omitted fields keep their current value
 * (partial update). `subscriptions_fired` is *replaced* when supplied,
 * not appended — the caller owns dedup.
 */
export function mergeWatermark(current: Watermark, patch: Partial<Watermark>): Watermark {
  return {
    messages_since_ts: patch.messages_since_ts ?? current.messages_since_ts,
    escalations_since_ts: patch.escalations_since_ts ?? current.escalations_since_ts,
    plan_events_since_ts: patch.plan_events_since_ts ?? current.plan_events_since_ts,
    subscriptions_fired: patch.subscriptions_fired ?? current.subscriptions_fired,
  };
}
