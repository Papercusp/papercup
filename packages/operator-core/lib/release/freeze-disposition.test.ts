import { describe, expect, it } from 'vitest';
import {
  FREEZE_DISPOSITION_FRESH_MS,
  buildFreezeAndConvergeGateHealth,
  readFreezeAndConverge,
  summarizeFreezeAndConverge,
} from './freeze-disposition';

const T0 = Date.parse('2026-09-02T16:00:00.000Z');

describe('buildFreezeAndConvergeGateHealth', () => {
  it('writes every optional field EXPLICITLY as null, so a shallow merge cannot strand stale bounds', () => {
    // The gate_health write is `existing || fragment`. An OMITTED key leaves the previous
    // tick's value in place, so a hold that has since cleared would keep advertising its old
    // holdUntilMs — a dead deadline presented as live. That is the whole reason these are
    // written rather than spread.
    const fragment = buildFreezeAndConvergeGateHealth(
      { enabled: true, state: 'retired', reason: 'provider wall, attempts=0' },
      T0,
    );
    expect(fragment.freezeAndConverge).toEqual({
      enabled: true,
      state: 'retired',
      reason: 'provider wall, attempts=0',
      candidate: null,
      holdUntilMs: null,
      capacityRetryAtMs: null,
      observedAtMs: T0,
    });
    expect(Object.keys(fragment.freezeAndConverge)).toContain('holdUntilMs');
  });

  it('round-trips through the reader', () => {
    const fragment = buildFreezeAndConvergeGateHealth(
      {
        enabled: true,
        state: 'held',
        reason: 'wall outlasts the stall window',
        candidate: 'a'.repeat(40),
        holdUntilMs: T0 + 3 * 60 * 60 * 1_000,
        capacityRetryAtMs: T0 + 6 * 24 * 60 * 60 * 1_000,
      },
      T0,
    );
    expect(readFreezeAndConverge(fragment)).toMatchObject({
      state: 'held',
      candidate: 'a'.repeat(40),
      holdUntilMs: T0 + 3 * 60 * 60 * 1_000,
    });
  });
});

describe('readFreezeAndConverge fails CLOSED', () => {
  it('returns null for an absent record rather than a healthy-looking default', () => {
    // "Not measured" and "the freeze is fine" must never be the same value — that
    // equivalence is what hid a full day of suppression.
    expect(readFreezeAndConverge(undefined)).toBeNull();
    expect(readFreezeAndConverge(null)).toBeNull();
    expect(readFreezeAndConverge({})).toBeNull();
    expect(readFreezeAndConverge({ freezeAndConverge: null })).toBeNull();
  });

  it('rejects a half-written blob instead of coercing it into a plausible record', () => {
    const base = buildFreezeAndConvergeGateHealth(
      { enabled: true, state: 'held', reason: 'why' },
      T0,
    ).freezeAndConverge;
    // Each of these would otherwise render as a confident statement about the release gate.
    expect(
      readFreezeAndConverge({ freezeAndConverge: { ...base, state: 'paused' } }),
    ).toBeNull();
    expect(
      readFreezeAndConverge({ freezeAndConverge: { ...base, enabled: 'yes' } }),
    ).toBeNull();
    expect(
      readFreezeAndConverge({ freezeAndConverge: { ...base, reason: '' } }),
    ).toBeNull();
    expect(
      readFreezeAndConverge({ freezeAndConverge: { ...base, observedAtMs: 'now' } }),
    ).toBeNull();
  });

  it('CONTROL: the same reader accepts the well-formed record, so the rejections mean something', () => {
    const ok = buildFreezeAndConvergeGateHealth(
      { enabled: true, state: 'held', reason: 'why' },
      T0,
    );
    expect(readFreezeAndConverge(ok)).not.toBeNull();
  });

  it('drops a non-finite numeric rather than propagating NaN into a rendered deadline', () => {
    const base = buildFreezeAndConvergeGateHealth(
      { enabled: true, state: 'held', reason: 'why' },
      T0,
    ).freezeAndConverge;
    expect(
      readFreezeAndConverge({
        freezeAndConverge: { ...base, holdUntilMs: Number.NaN },
      }),
    ).toMatchObject({ holdUntilMs: null });
  });
});

describe('summarizeFreezeAndConverge', () => {
  it('answers the exact question the item names: OFF, and why', () => {
    const gh = buildFreezeAndConvergeGateHealth(
      {
        enabled: false,
        state: 'off',
        reason: 'FLAGS.RELEASE_FREEZE_AND_CONVERGE_DEFAULT is OFF (owner-set)',
        candidate: 'b'.repeat(40),
      },
      T0,
    );
    const line = summarizeFreezeAndConverge(gh, T0 + 1_000);
    expect(line).toContain('freeze-and-converge is OFF');
    expect(line).toContain('owner-set');
    expect(line).toContain('bbbbbbbbbbbb');
  });

  it('distinguishes an owner-suppressed freeze from one with nothing to freeze', () => {
    // `off` and `none` are BOTH `repairQueue: null` at the old surface. If the summary
    // collapsed them again the whole record would be pointless.
    const off = summarizeFreezeAndConverge(
      buildFreezeAndConvergeGateHealth(
        { enabled: false, state: 'off', reason: 'owner-set' },
        T0,
      ),
      T0,
    );
    const none = summarizeFreezeAndConverge(
      buildFreezeAndConvergeGateHealth(
        { enabled: true, state: 'none', reason: 'no frozen candidate this tick' },
        T0,
      ),
      T0,
    );
    expect(off).not.toEqual(none);
    expect(off).toContain('OFF');
    expect(none).toContain('ON, none');
  });

  it('marks a stale record as history rather than presenting it as current state', () => {
    const gh = buildFreezeAndConvergeGateHealth(
      { enabled: true, state: 'retired', reason: 'provider wall' },
      T0,
    );
    const line = summarizeFreezeAndConverge(
      gh,
      T0 + FREEZE_DISPOSITION_FRESH_MS + 60_000,
    );
    expect(line).toContain('history, not current state');
  });

  it('does NOT mark a fresh record stale', () => {
    const gh = buildFreezeAndConvergeGateHealth(
      { enabled: true, state: 'retired', reason: 'provider wall' },
      T0,
    );
    expect(
      summarizeFreezeAndConverge(gh, T0 + FREEZE_DISPOSITION_FRESH_MS - 60_000),
    ).not.toContain('history, not current state');
  });

  it('returns null — never a reassuring sentence — when nothing was measured', () => {
    expect(summarizeFreezeAndConverge({}, T0)).toBeNull();
  });
});
