/**
 * Tests for the ACTIVATE-ON-DEMAND boot policy (P-010).
 *
 * The rule is correctness-critical in ONE direction: wrongly ACTIVATING a
 * harness only costs footprint, but wrongly DEFERRING one can leave a write
 * unfederated (the EI-126 divergence class). So every test that asserts a
 * DEFERRAL is paired with the mutation that must flip it back to an activation.
 */

import { describe, expect, it } from 'vitest';
import {
  planSubstrateActivation,
  type ActivationPolicyClock,
  type HarnessActivationFacts,
} from './substrate-active-set-policy';

const NOW = 1_000_000_000;
const MINUTE = 60_000;

function clock(over: Partial<ActivationPolicyClock> = {}): ActivationPolicyClock {
  return { now: NOW, presenceActiveMs: 5 * MINUTE, ...over };
}

/** An entirely inert harness: private, idle, no pending writes. The baseline
 *  every "must activate" test mutates exactly one field of. */
function inert(over: Partial<HarnessActivationFacts> = {}): HarnessActivationFacts {
  return {
    key: 'ws::inert',
    pinned: false,
    pendingOutboxRows: 0,
    lastPresenceMs: null,
    federating: false,
    ...over,
  };
}

function reasonFor(d: ReturnType<typeof planSubstrateActivation>, key: string): string | undefined {
  return d.activate.find((a) => a.key === key)?.reason;
}

describe('planSubstrateActivation', () => {
  it('defers a fully inert private harness — the whole point of the policy', () => {
    const d = planSubstrateActivation([inert()], clock());
    expect(d.defer).toEqual(['ws::inert']);
    expect(d.activate).toEqual([]);
  });

  it('activates a pinned harness even though it is otherwise inert', () => {
    const d = planSubstrateActivation([inert({ pinned: true })], clock());
    expect(d.defer).toEqual([]);
    expect(reasonFor(d, 'ws::inert')).toBe('pinned');
  });

  // ── pending writes: the signal that is dangerous to get wrong ──────────────

  it('activates on a SINGLE pending outbox row (undrained local write must federate)', () => {
    const d = planSubstrateActivation([inert({ pendingOutboxRows: 1 })], clock());
    expect(d.defer).toEqual([]);
    expect(reasonFor(d, 'ws::inert')).toBe('pending-writes');
  });

  it('pending writes outrank staleness — an ancient idle harness with a queued row still activates', () => {
    const d = planSubstrateActivation(
      [inert({ pendingOutboxRows: 3, lastPresenceMs: NOW - 400 * MINUTE })],
      clock(),
    );
    expect(reasonFor(d, 'ws::inert')).toBe('pending-writes');
  });

  // ── presence window: differential pair on the SAME topology ────────────────

  it('activates on presence inside the window and defers the same harness outside it', () => {
    const fresh = planSubstrateActivation(
      [inert({ lastPresenceMs: NOW - 1 * MINUTE })],
      clock({ presenceActiveMs: 5 * MINUTE }),
    );
    const stale = planSubstrateActivation(
      [inert({ lastPresenceMs: NOW - 30 * MINUTE })],
      clock({ presenceActiveMs: 5 * MINUTE }),
    );
    expect(reasonFor(fresh, 'ws::inert')).toBe('live-presence');
    expect(stale.defer).toEqual(['ws::inert']);
  });

  it('treats the window edge as stale (strictly-inside), so the boundary is not ambiguous', () => {
    const exactlyAtEdge = planSubstrateActivation(
      [inert({ lastPresenceMs: NOW - 5 * MINUTE })],
      clock({ presenceActiveMs: 5 * MINUTE }),
    );
    expect(exactlyAtEdge.defer).toEqual(['ws::inert']);
  });

  it('a future-dated presence row (clock skew between machines) still counts as live', () => {
    const d = planSubstrateActivation([inert({ lastPresenceMs: NOW + 2 * MINUTE })], clock());
    expect(reasonFor(d, 'ws::inert')).toBe('live-presence');
  });

  it('a zero presence window disables the presence signal without darkening pinned/pending work', () => {
    const d = planSubstrateActivation(
      [
        inert({ key: 'ws::a', lastPresenceMs: NOW }),
        inert({ key: 'ws::b', lastPresenceMs: NOW, pendingOutboxRows: 1 }),
      ],
      clock({ presenceActiveMs: 0 }),
    );
    expect(d.defer).toEqual(['ws::a']);
    expect(reasonFor(d, 'ws::b')).toBe('pending-writes');
  });

  // ── the P-012 safety interlock ─────────────────────────────────────────────

  it('does NOT defer a federating harness by default — no remote wake signal exists yet', () => {
    const d = planSubstrateActivation([inert({ federating: true })], clock());
    expect(d.defer).toEqual([]);
    expect(reasonFor(d, 'ws::inert')).toBe('federating-no-remote-wake');
  });

  it('defers the SAME federating harness once deferFederating is on (the P-012 flip)', () => {
    const facts = [inert({ federating: true })];
    const before = planSubstrateActivation(facts, clock());
    const after = planSubstrateActivation(facts, clock({ deferFederating: true }));
    expect(before.defer).toEqual([]);
    expect(after.defer).toEqual(['ws::inert']);
  });

  it('deferFederating never overrides pinned / pending / live-presence', () => {
    const d = planSubstrateActivation(
      [
        inert({ key: 'ws::pin', federating: true, pinned: true }),
        inert({ key: 'ws::pending', federating: true, pendingOutboxRows: 2 }),
        inert({ key: 'ws::live', federating: true, lastPresenceMs: NOW - MINUTE }),
        inert({ key: 'ws::idle', federating: true }),
      ],
      clock({ deferFederating: true }),
    );
    expect(reasonFor(d, 'ws::pin')).toBe('pinned');
    expect(reasonFor(d, 'ws::pending')).toBe('pending-writes');
    expect(reasonFor(d, 'ws::live')).toBe('live-presence');
    expect(d.defer).toEqual(['ws::idle']);
  });

  // ── precedence + shape ─────────────────────────────────────────────────────

  it('reports the DOMINANT reason when several apply, so telemetry is not arbitrary', () => {
    const d = planSubstrateActivation(
      [inert({ pinned: true, pendingOutboxRows: 5, lastPresenceMs: NOW, federating: true })],
      clock(),
    );
    expect(reasonFor(d, 'ws::inert')).toBe('pinned');
  });

  it('partitions a mixed registry exactly once, with no key in both sets', () => {
    const registry = [
      inert({ key: 'ws::1', pinned: true }),
      inert({ key: 'ws::2', pendingOutboxRows: 1 }),
      inert({ key: 'ws::3', lastPresenceMs: NOW - MINUTE }),
      inert({ key: 'ws::4' }),
      inert({ key: 'ws::5' }),
    ];
    const d = planSubstrateActivation(registry, clock());
    const activated = d.activate.map((a) => a.key);
    expect(activated).toEqual(['ws::1', 'ws::2', 'ws::3']);
    expect(d.defer).toEqual(['ws::4', 'ws::5']);
    expect(activated.length + d.defer.length).toBe(registry.length);
    expect(activated.filter((k) => d.defer.includes(k))).toEqual([]);
  });

  it('preserves input order in both sets (stable, deterministic sweeps)', () => {
    const registry = [
      inert({ key: 'ws::z', pinned: true }),
      inert({ key: 'ws::a' }),
      inert({ key: 'ws::m', pinned: true }),
      inert({ key: 'ws::b' }),
    ];
    const d = planSubstrateActivation(registry, clock());
    expect(d.activate.map((a) => a.key)).toEqual(['ws::z', 'ws::m']);
    expect(d.defer).toEqual(['ws::a', 'ws::b']);
  });

  it('is a no-op on an empty registry', () => {
    const d = planSubstrateActivation([], clock());
    expect(d).toEqual({ activate: [], defer: [] });
  });

  it('does NOT cap the activate set — a large genuine active set is activated in full', () => {
    const registry = Array.from({ length: 500 }, (_, i) =>
      inert({ key: `ws::h${i}`, lastPresenceMs: NOW - MINUTE }),
    );
    const d = planSubstrateActivation(registry, clock());
    expect(d.activate).toHaveLength(500);
    expect(d.defer).toEqual([]);
  });
});
