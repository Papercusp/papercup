/**
 * lock-authority — the D-005 authority-selection core + the Hive-scoped path
 * (shared-hive-federation P-009). Pure/seamed; no PG.
 */

import { describe, it, expect } from 'vitest';
import {
  selectAuthorityFromRows,
  lockAuthorityFor,
  lockAuthorityForHive,
  routeToAuthorityForHive,
} from '../lock-authority';

const NOW = 1_000_000_000_000;
const row = (pk: string, ageMs = 0) => ({ device_pubkey: pk, github_user_id: 1, machine_label: pk, last_seen_ms: NOW - ageMs });

describe('selectAuthorityFromRows (D-005 core)', () => {
  it('empty set + no self → isSelf (single box, liveCount 0)', () => {
    expect(selectAuthorityFromRows([], null, NOW, 90_000)).toEqual({ isSelf: true, liveCount: 0 });
  });

  it('self alone → isSelf, liveCount 1', () => {
    expect(selectAuthorityFromRows([], { githubUserId: 1, devicePubkey: 'mmm' }, NOW, 90_000)).toEqual({ isSelf: true, liveCount: 1 });
  });

  it('argmin(device_pubkey): the lowest live pubkey wins', () => {
    const r = selectAuthorityFromRows([row('ccc'), row('aaa'), row('bbb')], { githubUserId: 1, devicePubkey: 'zzz' }, NOW, 90_000);
    expect(r.isSelf).toBe(false);
    expect(r.peer?.devicePubkey).toBe('aaa');
    expect(r.liveCount).toBe(4); // aaa,bbb,ccc + self zzz
  });

  it('self is the authority when it is the lowest', () => {
    const r = selectAuthorityFromRows([row('ccc'), row('bbb')], { githubUserId: 1, devicePubkey: 'aaa' }, NOW, 90_000);
    expect(r).toMatchObject({ isSelf: true, liveCount: 3 });
  });

  it('stale peers are excluded → deterministic failover to the next-lowest', () => {
    const r = selectAuthorityFromRows([row('aaa', 200_000), row('bbb', 0)], { githubUserId: 1, devicePubkey: 'zzz' }, NOW, 90_000);
    expect(r.peer?.devicePubkey).toBe('bbb'); // aaa stale → dropped
  });

  it('dedups by pubkey, keeping the freshest row', () => {
    const r = selectAuthorityFromRows([row('aaa', 50_000), row('aaa', 0), row('bbb', 0)], null, NOW, 90_000);
    expect(r.liveCount).toBe(2);
    expect(r.peer?.devicePubkey).toBe('aaa');
  });
});

describe('lockAuthorityFor (harness scope — unchanged behavior)', () => {
  it('routes through the harness presence fetch + argmin', async () => {
    const r = await lockAuthorityFor('h', {
      fetchPresenceRows: async (slug) => {
        expect(slug).toBe('h');
        return [row('aaa'), row('ccc')];
      },
      resolveSelf: async () => ({ githubUserId: 1, devicePubkey: 'bbb' }),
      now: () => NOW,
    });
    expect(r).toMatchObject({ isSelf: false, liveCount: 3 });
    expect(r.peer?.devicePubkey).toBe('aaa');
  });

  it('throws on an empty harnessSlug', async () => {
    await expect(lockAuthorityFor('')).rejects.toThrow(/non-empty/);
  });
});

describe('lockAuthorityForHive (P-009 — Hive scope)', () => {
  it('elects the lowest pubkey across the HIVE presence (WHERE hive_slug)', async () => {
    const r = await lockAuthorityForHive('my-hive', {
      fetchHivePresenceRows: async (hive) => {
        expect(hive).toBe('my-hive');
        return [row('ddd'), row('aaa')];
      },
      resolveSelf: async () => ({ githubUserId: 1, devicePubkey: 'ccc' }),
      now: () => NOW,
    });
    expect(r).toMatchObject({ isSelf: false, liveCount: 3 });
    expect(r.peer?.devicePubkey).toBe('aaa');
  });

  it('self alone in the Hive → isSelf (single Swarm)', async () => {
    expect(
      await lockAuthorityForHive('my-hive', {
        fetchHivePresenceRows: async () => [],
        resolveSelf: async () => ({ githubUserId: 1, devicePubkey: 'only' }),
        now: () => NOW,
      }),
    ).toEqual({ isSelf: true, liveCount: 1 });
  });

  it('self is the Hive authority when it is the lowest', async () => {
    const r = await lockAuthorityForHive('my-hive', {
      fetchHivePresenceRows: async () => [row('zzz')],
      resolveSelf: async () => ({ githubUserId: 1, devicePubkey: 'aaa' }),
      now: () => NOW,
    });
    expect(r.isSelf).toBe(true);
  });

  it('throws on an empty potSlug', async () => {
    await expect(lockAuthorityForHive('')).rejects.toThrow(/non-empty/);
  });
});

describe('routeToAuthorityForHive (P-009 routing — local / fail-open)', () => {
  it('runs op.local directly when we are the Hive authority', async () => {
    let ran = false;
    const r = await routeToAuthorityForHive(
      'h',
      { local: async () => { ran = true; return 42; } },
      { fetchHivePresenceRows: async () => [], resolveSelf: async () => ({ githubUserId: 1, devicePubkey: 'aaa' }), now: () => NOW },
    );
    expect(ran).toBe(true);
    expect(r).toMatchObject({ value: 42, via: 'local-authority' });
  });

  it('fails open (local + warning) when the Hive authority is a remote Swarm and no transport exists', async () => {
    const r = await routeToAuthorityForHive(
      'h',
      { local: async () => 7 },
      { fetchHivePresenceRows: async () => [row('aaa')], resolveSelf: async () => ({ githubUserId: 1, devicePubkey: 'zzz' }), now: () => NOW },
    );
    expect(r.via).toBe('fail-open');
    expect(r.value).toBe(7);
    expect(r.warning).toMatch(/hive "h"/);
  });
});
