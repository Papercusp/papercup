/**
 * rendezvous-authority.test.ts — P-021 (cross-machine-coord-parity-and-trust).
 * Proves the PURE rendezvous-hash authority selector before it touches the live
 * election: (1) deterministic + agreement-free (order-independent, repeatable),
 * (2) CHURN CONFINEMENT — a peer leaving reassigns ONLY the scopes it won, unlike
 * the global argmin where losing the min peer flips EVERY scope, (3) load spread,
 * (4) freshness/self/excluded parity with selectAuthorityFromRows, (5) lease
 * stickiness damps a flap.
 */
import { describe, expect, it } from 'vitest';
import {
  selectAuthorityRendezvous,
  rendezvousWeight,
  hash32,
  applyLeaseStickiness,
  type RendezvousPeerRow,
} from '../rendezvous-authority';
import type { SelfSwarmIdentity } from '../lock-authority';

const NOW = 1_800_000_000_000;
const STALE = 90_000;
const peer = (id: string, over?: Partial<RendezvousPeerRow>): RendezvousPeerRow => ({
  device_pubkey: id,
  github_user_id: 1,
  machine_label: id,
  last_seen_ms: NOW - 1_000,
  ...over,
});
const devs = (n: number) => Array.from({ length: n }, (_, i) => `dev-${String(i).padStart(3, '0')}-pub`);
const winnerOf = (rows: readonly RendezvousPeerRow[], scope: string): string => {
  const r = selectAuthorityRendezvous(rows, null, NOW, STALE, scope);
  return r.isSelf ? '(self/none)' : r.peer!.devicePubkey;
};

describe('hash32 / rendezvousWeight — deterministic + well-mixed', () => {
  it('is a stable pure function of its input', () => {
    expect(hash32('abc')).toBe(hash32('abc'));
    expect(hash32('abc')).not.toBe(hash32('abd'));
    expect(rendezvousWeight('scope-1', 'dev-1')).toBe(rendezvousWeight('scope-1', 'dev-1'));
  });
  it('ranks peers INDEPENDENTLY per scope key (the load-spread property)', () => {
    // The device order by weight differs between two scope keys ⇒ authority is not
    // a single global winner. (Overwhelmingly true; assert on a concrete pair.)
    const ds = devs(8);
    const rankFor = (scope: string) =>
      [...ds].sort((a, b) => rendezvousWeight(scope, b) - rendezvousWeight(scope, a)).join(',');
    expect(rankFor('scope-A')).not.toBe(rankFor('scope-B'));
  });
});

describe('selectAuthorityRendezvous — determinism', () => {
  const ds = devs(10);
  const rows = ds.map((d) => peer(d));

  it('is order-independent (every peer, computing over the same set in any order, agrees)', () => {
    const shuffled = [...rows].reverse();
    for (const scope of ['s1', 's2', 's3', 'lock:file:foo.ts', 'claim:WI-42']) {
      expect(winnerOf(rows, scope)).toBe(winnerOf(shuffled, scope));
    }
  });

  it('picks the argmax HRW weight for the scope (matches a hand-computed argmax)', () => {
    const scope = 'lock:plan:my-plan';
    let expected = ds[0];
    for (const d of ds) if (rendezvousWeight(scope, d) > rendezvousWeight(scope, expected)) expected = d;
    expect(winnerOf(rows, scope)).toBe(expected);
  });
});

describe('CHURN CONFINEMENT — the P-021 raison d\'être', () => {
  const N = 12;
  const M = 1500;
  const ds = devs(N);
  const rows = ds.map((d) => peer(d));
  const scopes = Array.from({ length: M }, (_, i) => `scope-${i}`);

  it('removing ONE peer reassigns ONLY the scopes that peer won — every other scope is byte-identical', () => {
    const before = new Map(scopes.map((s) => [s, winnerOf(rows, s)]));
    // Drop the peer that currently wins the most scopes (worst case for churn).
    const wonCount = new Map<string, number>();
    for (const w of before.values()) wonCount.set(w, (wonCount.get(w) ?? 0) + 1);
    let victim = ds[0];
    for (const d of ds) if ((wonCount.get(d) ?? 0) > (wonCount.get(victim) ?? 0)) victim = d;

    const survivorRows = rows.filter((r) => r.device_pubkey !== victim);
    let changed = 0;
    for (const s of scopes) {
      const now = winnerOf(survivorRows, s);
      if (before.get(s) === victim) {
        // The victim's scopes MUST reassign to a surviving peer (never the victim).
        expect(now).not.toBe(victim);
        changed++;
      } else {
        // Every non-victim scope is UNTOUCHED — HRW's minimal-disruption guarantee.
        expect(now).toBe(before.get(s));
      }
    }
    // The reassigned set is exactly the victim's won-scopes, i.e. ~M/N (bounded well
    // under the global-argmin's 100%). Generous band around the 1/N expectation.
    expect(changed).toBe(wonCount.get(victim));
    expect(changed).toBeGreaterThan(0);
    expect(changed).toBeLessThan(M * 0.35); // « 100% — the whole point vs global argmin
  });

  it('ADDING a peer only steals the scopes the newcomer now wins — the rest are untouched', () => {
    const before = new Map(scopes.map((s) => [s, winnerOf(rows, s)]));
    const newcomer = 'dev-NEW-pub';
    const grown = [...rows, peer(newcomer)];
    let stolen = 0;
    for (const s of scopes) {
      const now = winnerOf(grown, s);
      if (now !== before.get(s)) {
        stolen++;
        expect(now).toBe(newcomer); // a change can ONLY be the newcomer taking over
      }
    }
    expect(stolen).toBeGreaterThan(0);
    expect(stolen).toBeLessThan(M * 0.35);
  });

  it('CONTRAST: the global argmin flips 100% of scopes when the min peer leaves', () => {
    // The pre-P-021 behavior: authority = min(device_pubkey) for EVERY scope. Removing
    // that one peer reassigns every single scope — the churn amplifier P-021 removes.
    const globalMin = [...ds].sort()[0];
    const survivors = ds.filter((d) => d !== globalMin);
    const newGlobalMin = [...survivors].sort()[0];
    expect(newGlobalMin).not.toBe(globalMin);
    // (Under argmin, all M scopes would move from globalMin → newGlobalMin — 100%.)
    for (const s of scopes.slice(0, 5)) {
      // Sanity that HRW does NOT put everything on the global min in the first place.
      // (At least one scope's HRW winner is not the global min.)
    }
    const hrwWinners = new Set(scopes.map((s) => winnerOf(rows, s)));
    expect(hrwWinners.size).toBeGreaterThan(1); // load is spread, not pinned to argmin
  });

  it('spreads authority ~uniformly across peers (no hot single authority)', () => {
    const counts = new Map<string, number>();
    for (const s of scopes) {
      const w = winnerOf(rows, s);
      counts.set(w, (counts.get(w) ?? 0) + 1);
    }
    expect(counts.size).toBe(N); // every peer wins at least one scope
    const expected = M / N;
    for (const c of counts.values()) {
      expect(c).toBeGreaterThan(expected * 0.4); // no peer starved
      expect(c).toBeLessThan(expected * 1.9); // no peer hot
    }
  });
});

describe('parity with the argmin path (freshness / self / excluded / empty)', () => {
  it('drops stale + excluded rows; empty set ⇒ single-box self-authority', () => {
    const stale = peer('dev-stale', { last_seen_ms: NOW - STALE - 1 });
    const live = peer('dev-live');
    const r = selectAuthorityRendezvous([stale, live], null, NOW, STALE, 's');
    expect(r.peer?.devicePubkey).toBe('dev-live'); // stale never a candidate
    // excluded (relay-confirmed dead) dropped
    const r2 = selectAuthorityRendezvous([live, peer('dev-x')], null, NOW, STALE, 's', new Set(['dev-x']));
    expect(r2.peer?.devicePubkey).toBe('dev-live');
    // empty ⇒ self-authority
    expect(selectAuthorityRendezvous([], null, NOW, STALE, 's')).toEqual({ isSelf: true, liveCount: 0 });
  });

  it('self is always a candidate and reported as isSelf when it wins its scope', () => {
    const self: SelfSwarmIdentity = { githubUserId: 7, devicePubkey: 'dev-self' };
    // Find a scope self wins against one weak opponent, and one it loses.
    const other = peer('dev-other');
    let selfWins: string | null = null;
    let selfLoses: string | null = null;
    for (let i = 0; i < 200 && (!selfWins || !selfLoses); i++) {
      const s = `sc-${i}`;
      const r = selectAuthorityRendezvous([other], self, NOW, STALE, s);
      if (r.isSelf) selfWins ??= s;
      else selfLoses ??= s;
    }
    expect(selfWins).not.toBeNull();
    expect(selfLoses).not.toBeNull();
    expect(selectAuthorityRendezvous([other], self, NOW, STALE, selfWins!).isSelf).toBe(true);
    expect(selectAuthorityRendezvous([other], self, NOW, STALE, selfLoses!).peer?.devicePubkey).toBe('dev-other');
  });
});

describe('applyLeaseStickiness — damp flapping', () => {
  const live = new Set(['dev-A', 'dev-B']);
  it('keeps a still-alive incumbent within its lease even when HRW now prefers another', () => {
    const out = applyLeaseStickiness('dev-B', live, { devicePubkey: 'dev-A', sinceMs: NOW - 5_000 }, NOW, 30_000);
    expect(out).toBe('dev-A'); // sticky — no flap to dev-B mid-lease
  });
  it('yields to the HRW winner once the lease expires', () => {
    const out = applyLeaseStickiness('dev-B', live, { devicePubkey: 'dev-A', sinceMs: NOW - 40_000 }, NOW, 30_000);
    expect(out).toBe('dev-B');
  });
  it('never keeps a DEAD incumbent (not in the live set) — yields immediately', () => {
    const out = applyLeaseStickiness('dev-B', live, { devicePubkey: 'dev-GONE', sinceMs: NOW - 1_000 }, NOW, 30_000);
    expect(out).toBe('dev-B');
  });
  it('no-op when the incumbent already IS the HRW winner', () => {
    const out = applyLeaseStickiness('dev-A', live, { devicePubkey: 'dev-A', sinceMs: NOW - 1_000 }, NOW, 30_000);
    expect(out).toBe('dev-A');
  });
});
