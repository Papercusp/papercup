/**
 * hardened-authority — composition of argmin election + D-006 hardening over an
 * injected record store. Deterministic; no PG. (locks-correctness-hardening-2026-06-04)
 */

import { describe, it, expect } from 'vitest';
import { resolveHardenedAuthority, type HardenedAuthorityDeps } from '../hardened-authority';
import type { AuthorityRecord, HardeningTiming } from '../authority-hardening';
import type { SelfSwarmIdentity } from '../lock-authority';

const TIMING: HardeningTiming = { heartbeatMs: 1000 }; // stale 3000, grace 1000, cooldown 2000

interface Row {
  device_pubkey: string;
  github_user_id: number;
  machine_label: string;
  last_seen_ms: number;
}

function harness(opts: {
  self: SelfSwarmIdentity | null;
  rows: () => Row[];
  now: () => number;
}): { deps: HardenedAuthorityDeps; record: () => AuthorityRecord | null } {
  const store = new Map<string, AuthorityRecord>();
  const deps: HardenedAuthorityDeps = {
    fetchPresenceRows: async () => opts.rows(),
    resolveSelf: async () => opts.self,
    loadRecord: async (slug) => store.get(slug) ?? null,
    saveRecord: async (slug, rec) => void store.set(slug, rec),
    now: opts.now,
    timing: TIMING,
  };
  return { deps, record: () => store.get('h') ?? null };
}

describe('resolveHardenedAuthority', () => {
  it('first election: self is the lowest pubkey → isSelf, epoch 1, persisted', async () => {
    let now = 1000;
    const { deps, record } = harness({
      self: { githubUserId: 1, devicePubkey: 'aaa' },
      rows: () => [{ device_pubkey: 'mmm', github_user_id: 2, machine_label: 'm2', last_seen_ms: now }],
      now: () => now,
    });
    const r = await resolveHardenedAuthority('h', deps);
    expect(r.isSelf).toBe(true);
    expect(r.epoch).toBe(1);
    expect(r.changed).toBe(true);
    expect(r.withinGrace).toBe(true);
    expect(record()?.pubkey).toBe('aaa');
  });

  it('a lower remote pubkey → isSelf false with the peer set', async () => {
    let now = 1000;
    const { deps } = harness({
      self: { githubUserId: 2, devicePubkey: 'mmm' },
      rows: () => [{ device_pubkey: 'aaa', github_user_id: 1, machine_label: 'm1', last_seen_ms: now }],
      now: () => now,
    });
    const r = await resolveHardenedAuthority('h', deps);
    expect(r.isSelf).toBe(false);
    expect(r.peer?.devicePubkey).toBe('aaa');
    expect(r.epoch).toBe(1);
  });

  it('a stable incumbent carries its epoch unchanged across calls', async () => {
    let now = 1000;
    const { deps } = harness({
      self: { githubUserId: 1, devicePubkey: 'aaa' },
      rows: () => [],
      now: () => now,
    });
    const first = await resolveHardenedAuthority('h', deps);
    expect(first.epoch).toBe(1);
    now = 5000;
    const second = await resolveHardenedAuthority('h', deps);
    expect(second.epoch).toBe(1);
    expect(second.changed).toBe(false);
  });

  it('failover bumps the epoch when the incumbent goes stale', async () => {
    let now = 1000;
    let rows: Row[] = [
      { device_pubkey: 'aaa', github_user_id: 1, machine_label: 'm1', last_seen_ms: 1000 }, // incumbent
      { device_pubkey: 'bbb', github_user_id: 2, machine_label: 'm2', last_seen_ms: 1000 },
    ];
    const { deps } = harness({
      self: { githubUserId: 2, devicePubkey: 'bbb' }, // we are bbb
      rows: () => rows,
      now: () => now,
    });
    // aaa wins first.
    const r1 = await resolveHardenedAuthority('h', deps);
    expect(r1.isSelf).toBe(false);
    expect(r1.epoch).toBe(1);

    // aaa stops heartbeating; advance past the stale window. Only bbb (self) is fresh.
    now = 9000;
    rows = [{ device_pubkey: 'aaa', github_user_id: 1, machine_label: 'm1', last_seen_ms: 1000 }];
    const r2 = await resolveHardenedAuthority('h', deps);
    expect(r2.isSelf).toBe(true); // bbb took over
    expect(r2.changed).toBe(true);
    expect(r2.epoch).toBe(2); // fencing epoch advanced
  });

  it('NO-PREEMPTION: a returning lower peer cannot thrash a live incumbent within cooldown', async () => {
    let now = 1000;
    let rows: Row[] = [{ device_pubkey: 'mmm', github_user_id: 2, machine_label: 'm2', last_seen_ms: 1000 }];
    const { deps } = harness({
      self: { githubUserId: 2, devicePubkey: 'mmm' },
      rows: () => rows,
      now: () => now,
    });
    // mmm elected at t=1000, epoch 1.
    const r1 = await resolveHardenedAuthority('h', deps);
    expect(r1.isSelf).toBe(true);
    expect(r1.epoch).toBe(1);

    // 'aaa' (lower) returns at t=2500 — still within mmm's cooldown (electedAt 1000 + 2000).
    now = 2500;
    rows = [
      { device_pubkey: 'mmm', github_user_id: 2, machine_label: 'm2', last_seen_ms: 2500 },
      { device_pubkey: 'aaa', github_user_id: 1, machine_label: 'm1', last_seen_ms: 2500 },
    ];
    const r2 = await resolveHardenedAuthority('h', deps);
    expect(r2.isSelf).toBe(true); // mmm KEPT — no flap
    expect(r2.changed).toBe(false);
    expect(r2.epoch).toBe(1);
  });

  it('alone (no candidates, no self identity) → isSelf, liveCount 0', async () => {
    const { deps } = harness({ self: null, rows: () => [], now: () => 1000 });
    const r = await resolveHardenedAuthority('h', deps);
    expect(r.isSelf).toBe(true);
    expect(r.liveCount).toBe(0);
  });
});
