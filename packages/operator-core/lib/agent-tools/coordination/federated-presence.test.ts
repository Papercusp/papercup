/**
 * Unit tests for federated-presence (Phase 0.3 of
 * distributed-coordination-shared-harness-2026-06-04). Pure — the mapper is pure
 * and the query is exercised with an injected fake sql.
 */
import { describe, expect, it } from 'vitest';
import { mapSharedPresenceRow, queryFederatedPresenceRows } from './federated-presence';

const NOW = 1_700_000_000_000;

const row = {
  workspace_id: 'ws-1',
  harness_slug: 'papercup',
  github_user_id: 4242,
  machine_label: 'thinkpad',
  device_pubkey: 'pubAAA',
  intent: 'reviewing the federation projections',
  current_view: 'harness/papercup',
  last_seen_ms: NOW - 5_000,
};

describe('mapSharedPresenceRow', () => {
  it('maps a shared_presence row to a unified federated presence record', () => {
    const r = mapSharedPresenceRow(row, { now: NOW, staleMs: 600_000 });
    expect(r.ownerId).toBe('fed:4242@thinkpad');
    expect(r.ownerLabel).toBe('gh:4242 · thinkpad');
    expect(r.source).toBe('federated');
    expect(r.federated).toBe(true);
    expect(r.intent).toBe('reviewing the federation projections');
    expect(r.host).toBe('thinkpad');
    expect(r.userId).toBe('4242');
    expect(r.devicePubkey).toBe('pubAAA');
    expect(r.harnessSlug).toBe('papercup');
    expect(r.currentView).toBe('harness/papercup');
    expect(r.stale).toBe(false);
    // synthetic ownerId is distinct from any local su-<uuid> → never collides on merge
    expect(r.ownerId.startsWith('fed:')).toBe(true);
  });

  it('marks a peer stale when last_seen is outside the window', () => {
    const fresh = mapSharedPresenceRow({ ...row, last_seen_ms: NOW - 1_000 }, { now: NOW, staleMs: 10_000 });
    const old = mapSharedPresenceRow({ ...row, last_seen_ms: NOW - 20_000 }, { now: NOW, staleMs: 10_000 });
    expect(fresh.stale).toBe(false);
    expect(old.stale).toBe(true);
  });

  it('tolerates null intent / current_view', () => {
    const r = mapSharedPresenceRow({ ...row, intent: null, current_view: null }, { now: NOW, staleMs: 600_000 });
    expect(r.intent).toBe('');
    expect(r.currentView).toBeNull();
  });
});

describe('queryFederatedPresenceRows — filtering', () => {
  // A fake postgres-js tagged template that ignores the query and returns rows.
  function fakeSql(rows: Array<Record<string, unknown>>) {
    return (() => Promise.resolve(rows)) as never;
  }
  const rows = [
    { workspace_id: 'ws-1', harness_slug: 'a', github_user_id: 1, machine_label: 'm1', device_pubkey: 'p1', intent: null, current_view: null, last_seen_ms: NOW },
    { workspace_id: 'ws-2', harness_slug: 'a', github_user_id: 2, machine_label: 'm2', device_pubkey: 'p2', intent: null, current_view: null, last_seen_ms: NOW },
    { workspace_id: 'ws-1', harness_slug: 'b', github_user_id: 3, machine_label: 'm3', device_pubkey: 'p3', intent: null, current_view: null, last_seen_ms: NOW },
  ];

  it('returns all rows when unfiltered', async () => {
    expect(await queryFederatedPresenceRows(fakeSql(rows))).toHaveLength(3);
  });
  it('filters by workspace', async () => {
    const r = await queryFederatedPresenceRows(fakeSql(rows), { workspaceId: 'ws-1' });
    expect(r.map((x) => x.github_user_id).sort()).toEqual([1, 3]);
  });
  it('filters by harness', async () => {
    const r = await queryFederatedPresenceRows(fakeSql(rows), { harnessSlug: 'a' });
    expect(r.map((x) => x.github_user_id).sort()).toEqual([1, 2]);
  });
  it('filters by workspace AND harness', async () => {
    const r = await queryFederatedPresenceRows(fakeSql(rows), { workspaceId: 'ws-1', harnessSlug: 'a' });
    expect(r.map((x) => x.github_user_id)).toEqual([1]);
  });
});
