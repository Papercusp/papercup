/**
 * memory-store.ts — InMemorySubscriptionStore: the test double + the proof
 * that SubscriptionStore is swappable. A Map<msg_id, row> with the SAME
 * active-filter semantics (not cancelled, not past expires_ts) and sort
 * order the PG impl uses, so both pass one conformance suite (P-050).
 */

import type {
  AddSubscriptionInput,
  SubscriptionRecord,
  SubscriptionStore,
} from './types';

interface Row extends SubscriptionRecord {
  cancelled: boolean;
}

export class InMemorySubscriptionStore implements SubscriptionStore {
  private rows = new Map<string, Row>();

  async add(sub: AddSubscriptionInput): Promise<void> {
    this.rows.set(sub.msg_id, {
      msg_id: sub.msg_id,
      owner_id: sub.owner_id,
      pattern: sub.pattern,
      trigger: sub.trigger,
      created_ts: sub.created_ts,
      expires_ts: sub.expires_ts ?? null,
      cancelled: false,
    });
  }

  async cancel(ownerId: string, msgId: string): Promise<void> {
    const row = this.rows.get(msgId);
    if (row && row.owner_id === ownerId) row.cancelled = true;
  }

  async listActive(opts: { owner?: string } = {}): Promise<SubscriptionRecord[]> {
    const now = Date.now();
    return [...this.rows.values()]
      .filter((r) => !r.cancelled)
      .filter((r) => r.expires_ts == null || new Date(r.expires_ts).getTime() > now)
      .filter((r) => opts.owner == null || r.owner_id === opts.owner)
      .map(({ cancelled: _cancelled, ...rec }) => rec)
      .sort((a, b) => a.created_ts.localeCompare(b.created_ts) || a.msg_id.localeCompare(b.msg_id));
  }
}
