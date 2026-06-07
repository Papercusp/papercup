import { describe, expect, it } from 'vitest';
import { groupHives } from './HivesTab';

const row = (
  host: string,
  key: string,
  user: string,
  harness: string,
  ts: string,
  stale: boolean,
) => ({
  ownerId: `fed:${user}@${host}`,
  ownerLabel: `gh:${user} · ${host}`,
  host,
  userId: user,
  intent: `working on ${harness}`,
  currentView: null,
  harnessSlug: harness,
  devicePubkey: key,
  heartbeatAt: ts,
  stale,
});

describe('groupHives (left-sidebar-tauri-2026-06-07 — pui group_hives parity)', () => {
  it('groups by device, unions users + harnesses, freshest row wins', () => {
    const groups = groupHives([
      row('mbp', 'key-a', '111', 'papercup', '2026-06-07T01:00:00Z', false),
      row('mbp', 'key-a', '222', 'restart', '2026-06-07T02:00:00Z', false),
      row('tower', 'key-b', '111', 'papercup', '2026-06-07T01:30:00Z', true),
    ]);
    expect(groups).toHaveLength(2);
    // Live hive first.
    expect(groups[0].machine).toBe('mbp');
    expect(groups[0].users).toEqual(['111', '222']);
    expect(groups[0].harnesses).toEqual(['papercup', 'restart']);
    expect(groups[0].doing).toBe('working on restart'); // freshest row wins
    expect(groups[0].stale).toBe(false);
    // All-stale device is stale.
    expect(groups[1].machine).toBe('tower');
    expect(groups[1].stale).toBe(true);
  });

  it('one live row keeps the hive live', () => {
    const groups = groupHives([
      row('mbp', 'key-a', '111', 'papercup', '2026-06-07T01:00:00Z', true),
      row('mbp', 'key-a', '111', 'restart', '2026-06-07T02:00:00Z', false),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].stale).toBe(false);
  });

  it('falls back to host when the device pubkey is empty', () => {
    const groups = groupHives([row('mbp', '', '111', 'papercup', '2026-06-07T01:00:00Z', false)]);
    expect(groups).toHaveLength(1);
    expect(groups[0].devicePubkey).toBe('mbp');
  });
});
