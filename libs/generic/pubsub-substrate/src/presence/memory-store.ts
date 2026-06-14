/**
 * memory-store.ts — InMemoryPresenceStore: the test double + the proof
 * that PresenceStore is swappable. No roster join; `userId`/`revoked`
 * come from the written identity (userId) / default false.
 *
 * A `now()` clock is injectable so staleness is deterministic in tests.
 */

import {
  PRESENCE_STALE_MS,
  type PresenceIdentity,
  type PresenceInput,
  type PresenceRecord,
  type PresenceStore,
} from './types';

interface StoredRow {
  identity: PresenceIdentity;
  input: PresenceInput;
  startedAt: number;
  heartbeatAt: number;
  /** Last genuine-activity time (ms); null until first activity (D-003). */
  lastActiveAt: number | null;
}

export interface InMemoryPresenceStoreOptions {
  /** Injectable clock (ms epoch). Defaults to Date.now. */
  now?: () => number;
}

export class InMemoryPresenceStore implements PresenceStore {
  private rows = new Map<string, StoredRow>();
  private now: () => number;

  constructor(opts: InMemoryPresenceStoreOptions = {}) {
    this.now = opts.now ?? (() => Date.now());
  }

  async write(identity: PresenceIdentity, input: PresenceInput = {}): Promise<void> {
    const t = this.now();
    const existing = this.rows.get(identity.ownerId);
    // populate-once-then-keep for role/hive — mirror the PG COALESCE.
    const merged: PresenceInput = {
      ...input,
      agentRole: input.agentRole ?? existing?.input.agentRole ?? null,
      hiveSlug: input.hiveSlug ?? existing?.input.hiveSlug ?? null,
    };
    this.rows.set(identity.ownerId, {
      identity,
      input: merged,
      startedAt: existing?.startedAt ?? t,
      heartbeatAt: t,
      lastActiveAt: t, // a write IS activity
    });
  }

  async touchHeartbeat(ownerId: string): Promise<void> {
    // KEEPALIVE only — never lastActiveAt (D-003).
    const row = this.rows.get(ownerId);
    if (row) row.heartbeatAt = this.now();
  }

  async touchActivity(ownerId: string): Promise<void> {
    // ACTIVITY — bump both (D-003).
    const row = this.rows.get(ownerId);
    if (row) {
      row.heartbeatAt = this.now();
      row.lastActiveAt = row.heartbeatAt;
    }
  }

  async heartbeat(identity: PresenceIdentity): Promise<void> {
    const t = this.now();
    const existing = this.rows.get(identity.ownerId);
    if (existing) {
      existing.heartbeatAt = t;
      existing.lastActiveAt = t; // a coord:inbox read IS activity (D-003)
      existing.identity = identity; // refresh label/source/ws; KEEP input (intent/files)
    } else {
      this.rows.set(identity.ownerId, {
        identity,
        input: {},
        startedAt: t,
        heartbeatAt: t,
        lastActiveAt: t,
      });
    }
  }

  async clear(ownerId: string): Promise<void> {
    this.rows.delete(ownerId);
  }

  async list(opts: { workspaceId?: string | null } = {}): Promise<PresenceRecord[]> {
    const ws = opts.workspaceId ?? null;
    const now = this.now();
    return [...this.rows.values()]
      .map((r) => this.toRecord(r, now))
      .filter((r) => ws == null || r.workspaceId === ws)
      .sort((a, b) => b.heartbeatAt.localeCompare(a.heartbeatAt));
  }

  async get(ownerId: string): Promise<PresenceRecord | null> {
    const row = this.rows.get(ownerId);
    return row ? this.toRecord(row, this.now()) : null;
  }

  async sweepStale(maxAgeMs: number): Promise<number> {
    const cutoff = this.now() - maxAgeMs;
    let removed = 0;
    for (const [ownerId, r] of this.rows) {
      if (r.heartbeatAt < cutoff) {
        this.rows.delete(ownerId);
        removed++;
      }
    }
    return removed;
  }

  private toRecord(r: StoredRow, now: number): PresenceRecord {
    return {
      ownerId: r.identity.ownerId,
      ownerLabel: r.identity.ownerLabel,
      workspaceId: r.identity.workspaceId ?? 'default',
      source: r.identity.source,
      intent: r.input.intent ?? '',
      currentPlanSlug: r.input.currentPlanSlug ?? null,
      currentFiles: r.input.currentFiles ?? [],
      host: r.input.host ?? '',
      pid: r.input.pid ?? null,
      startedAt: new Date(r.startedAt).toISOString(),
      heartbeatAt: new Date(r.heartbeatAt).toISOString(),
      lastActiveAt: r.lastActiveAt != null ? new Date(r.lastActiveAt).toISOString() : null,
      agentRole: r.input.agentRole ?? null,
      hiveSlug: r.input.hiveSlug ?? null,
      stale: now - r.heartbeatAt > PRESENCE_STALE_MS,
      userId: r.identity.userId ?? null,
      revoked: false,
    };
  }
}
