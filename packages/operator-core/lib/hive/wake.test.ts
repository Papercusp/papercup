/**
 * Unit tests for the Hive's self-declared wake (autoloop-hive-operator-rebuild
 * P0, D-002): the floor clamp, the fire-side debounce, home-slug resolution,
 * and the subscription → live-reaction-rule projection (against the real
 * in-memory registry — no PG).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  clampWakeAt,
  decideHiveWakeAdmission,
  getHiveTimeWake,
  hiveWakeFloorSec,
  resolveHiveHomeSlug,
  syncHiveWakeRules,
  withinWakeFloor,
} from './wake';
import type { Sql } from 'postgres';
import {
  _resetReactionsForTests,
  listReactionRules,
  matchReactions,
} from '../events/registry';

const ENV_KEYS = ['PAPERCUSP_HIVE_WAKE_FLOOR_SEC', 'PAPERCUSP_HIVE_HOME_SLUG'] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  _resetReactionsForTests();
});

describe('hiveWakeFloorSec', () => {
  it('defaults to 60 and honors the env override with a hard 5s minimum', () => {
    expect(hiveWakeFloorSec()).toBe(60);
    process.env.PAPERCUSP_HIVE_WAKE_FLOOR_SEC = '120';
    expect(hiveWakeFloorSec()).toBe(120);
    process.env.PAPERCUSP_HIVE_WAKE_FLOOR_SEC = '1'; // below the hard min
    expect(hiveWakeFloorSec()).toBe(60);
    process.env.PAPERCUSP_HIVE_WAKE_FLOOR_SEC = 'nonsense';
    expect(hiveWakeFloorSec()).toBe(60);
  });
});

describe('clampWakeAt (the D-002 self-wake floor)', () => {
  const now = new Date('2026-06-05T12:00:00Z');

  it('clamps a too-soon (or past) wake to now + floor', () => {
    const past = new Date('2026-06-05T11:59:00Z');
    const r = clampWakeAt(past, now);
    expect(r.clamped).toBe(true);
    expect(r.at.toISOString()).toBe('2026-06-05T12:01:00.000Z');
  });

  it('passes a wake beyond the floor through unchanged', () => {
    const later = new Date('2026-06-05T13:00:00Z');
    const r = clampWakeAt(later, now);
    expect(r.clamped).toBe(false);
    expect(r.at).toEqual(later);
  });

  it('owner cadence-floor (P-006) RAISES the clamp — MAX(system, owner)', () => {
    // System floor is 60s; the owner set a 7-min (420s) floor. A wake 2 min out is
    // clamped UP to now + 420s; the owner can only raise the interval.
    const twoMinOut = new Date('2026-06-05T12:02:00Z');
    const r = clampWakeAt(twoMinOut, now, 420);
    expect(r.clamped).toBe(true);
    expect(r.at.toISOString()).toBe('2026-06-05T12:07:00.000Z');
  });

  it('owner cadence-floor below the system floor is a no-op (never drops below system)', () => {
    const past = new Date('2026-06-05T11:59:00Z');
    const r = clampWakeAt(past, now, 30); // 30s < system 60s
    expect(r.at.toISOString()).toBe('2026-06-05T12:01:00.000Z'); // still now + system 60s
  });
});

describe('withinWakeFloor (the fire-side debounce)', () => {
  it('is false with no prior wake, true inside the window, false after it', () => {
    const now = Date.parse('2026-06-05T12:00:00Z');
    expect(withinWakeFloor({ subscriptions: [] }, now)).toBe(false);
    expect(withinWakeFloor({ subscriptions: [], lastWakeAt: now - 30_000 }, now)).toBe(true);
    expect(withinWakeFloor({ subscriptions: [], lastWakeAt: now - 61_000 }, now)).toBe(false);
  });

  it('owner cadence-floor (P-006) widens the debounce window — MAX(system, owner)', () => {
    const now = Date.parse('2026-06-05T12:00:00Z');
    // 90s since the last wake: past the 60s system floor (would fire), but inside a
    // 420s owner floor (still debounced).
    expect(withinWakeFloor({ subscriptions: [], lastWakeAt: now - 90_000 }, now)).toBe(false);
    expect(withinWakeFloor({ subscriptions: [], lastWakeAt: now - 90_000 }, now, 420)).toBe(true);
    // Past even the owner floor ⇒ fires.
    expect(withinWakeFloor({ subscriptions: [], lastWakeAt: now - 421_000 }, now, 420)).toBe(false);
  });
});

describe('decideHiveWakeAdmission', () => {
  it('records a fire before launch and makes the next concurrent trigger skip', () => {
    const now = Date.parse('2026-06-05T12:00:00Z');
    const first = decideHiveWakeAdmission({ subscriptions: [] }, { now, floorSec: 60 });
    expect(first).toEqual({ fired: true, floorSec: 60 });

    const second = decideHiveWakeAdmission(
      { subscriptions: [], lastWakeAt: now },
      { now: now + 500, floorSec: 60 },
    );
    expect(second.fired).toBe(false);
    expect(second.skipped).toBe('wake-floor');
    expect(second.nextAllowedAt).toBe('2026-06-05T12:01:00.000Z');
  });

  it('force bypasses the wake floor but not the separate in-flight Queen guard', () => {
    const now = Date.parse('2026-06-05T12:00:00Z');
    expect(
      decideHiveWakeAdmission({ subscriptions: [], lastWakeAt: now - 1_000 }, { now, floorSec: 60, force: true }),
    ).toEqual({ fired: true, floorSec: 60 });
  });
});

describe('resolveHiveHomeSlug', () => {
  it('prefers explicit arg, then ctx harness, then the env default', () => {
    process.env.PAPERCUSP_HIVE_HOME_SLUG = 'env-slug';
    expect(resolveHiveHomeSlug('arg-slug', 'ctx-slug')).toBe('arg-slug');
    expect(resolveHiveHomeSlug(undefined, 'ctx-slug')).toBe('ctx-slug');
    expect(resolveHiveHomeSlug(undefined, undefined)).toBe('env-slug');
    delete process.env.PAPERCUSP_HIVE_HOME_SLUG;
    expect(resolveHiveHomeSlug('', '')).toBe(null);
  });

  it('canonicalizes retired home slugs before persisting wake launch targets', () => {
    delete process.env.PAPERCUSP_HIVE_HOME_SLUG;
    expect(resolveHiveHomeSlug('papercup', 'ctx-slug')).toBe('papercusp');
    expect(resolveHiveHomeSlug('  papercup-hive  ', undefined)).toBe('papercusp');
    process.env.PAPERCUSP_HIVE_HOME_SLUG = 'papercup';
    expect(resolveHiveHomeSlug(undefined, undefined)).toBe('papercusp');
    delete process.env.PAPERCUSP_HIVE_HOME_SLUG;
  });

  it('treats a wildcard "*" as NOT a concrete hive home — skips it so the chain falls through (2026-07-01 404 fix)', () => {
    delete process.env.PAPERCUSP_HIVE_HOME_SLUG;
    // '*' at any level is skipped — before this fix it fired the launch with installSlug '*' → 404 "unknown project".
    expect(resolveHiveHomeSlug('*')).toBe(null);
    expect(resolveHiveHomeSlug(undefined, '*')).toBe(null);
    expect(resolveHiveHomeSlug('  *  ', undefined)).toBe(null);
    // An explicit/ctx '*' falls THROUGH to a real slug lower in the chain rather than 404-ing.
    expect(resolveHiveHomeSlug('*', 'papercusp')).toBe('papercusp');
    process.env.PAPERCUSP_HIVE_HOME_SLUG = 'papercusp';
    expect(resolveHiveHomeSlug(undefined, '*')).toBe('papercusp');
    delete process.env.PAPERCUSP_HIVE_HOME_SLUG;
  });
});

describe('syncHiveWakeRules (subscriptions → live reaction rules)', () => {
  const WS = 'ws-hive-test';

  it('registers one hive:wake rule per subscription, scoped to the workspace', () => {
    const n = syncHiveWakeRules(WS, [
      { on: 'coord:escalate', note: 'watch escalations' },
      { on: ['work_items:complete', 'work_items:set_state'] },
    ]);
    expect(n).toBe(2);
    const mine = listReactionRules().filter((r) => r.id.startsWith(`hive-wake:${WS}#`));
    expect(mine).toHaveLength(2);
    expect(mine.every((r) => r.fire === 'hive:wake')).toBe(true);
    expect(mine.every((r) => r.source === 'hive-wake')).toBe(true);
  });

  it('REPLACE semantics: re-sync removes stale rules; empty clears all', () => {
    syncHiveWakeRules(WS, [{ on: 'coord:escalate' }, { on: 'coord:handoff' }]);
    syncHiveWakeRules(WS, [{ on: 'coord:escalate' }]);
    expect(listReactionRules().filter((r) => r.id.startsWith(`hive-wake:${WS}#`))).toHaveLength(1);
    syncHiveWakeRules(WS, []);
    expect(listReactionRules().filter((r) => r.id.startsWith(`hive-wake:${WS}#`))).toHaveLength(0);
  });

  it('does not touch another workspace\'s rules', () => {
    syncHiveWakeRules('ws-a', [{ on: 'coord:escalate' }]);
    syncHiveWakeRules('ws-b', [{ on: 'coord:escalate' }]);
    syncHiveWakeRules('ws-a', []);
    expect(listReactionRules().filter((r) => r.id.startsWith('hive-wake:ws-b#'))).toHaveLength(1);
  });

  it('a registered subscription MATCHES a tool event (with the declared when)', () => {
    syncHiveWakeRules(WS, [
      { on: 'coord:escalate', when: { 'result.ok': true } },
    ]);
    const matched = matchReactions({
      tool: 'coord:escalate',
      args: {},
      result: { ok: true },
      ctx: {} as never,
    });
    expect(matched.some((m) => m.rule.id === `hive-wake:${WS}#0`)).toBe(true);
    // A failed trigger does not match the declared when.
    const unmatched = matchReactions({
      tool: 'coord:escalate',
      args: {},
      result: { ok: false },
      ctx: {} as never,
    });
    expect(unmatched.some((m) => m.rule.id === `hive-wake:${WS}#0`)).toBe(false);
  });
});

describe('getHiveTimeWake (EI-257: string-timestamp pools)', () => {
  const fakeSql = (rows: unknown[]): Sql =>
    (async () => rows) as unknown as Sql;

  it('coerces ISO-string timestamps to Dates', async () => {
    const r = await getHiveTimeWake(
      fakeSql([
        {
          active: true,
          next_fire_at: '2026-06-10T12:00:00.000Z',
          last_fired_at: '2026-06-10T11:30:00.000Z',
        },
      ]),
      'papercup-hive',
    );
    expect(r?.nextFireAt).toBeInstanceOf(Date);
    expect(r?.lastFiredAt).toBeInstanceOf(Date);
    // the watchdog liveness expression that EI-257 crashed on:
    expect(r!.lastFiredAt!.getTime()).toBe(Date.parse('2026-06-10T11:30:00.000Z'));
  });

  it('passes real Dates through and maps null/garbage to null', async () => {
    const at = new Date('2026-06-10T12:00:00Z');
    const r = await getHiveTimeWake(
      fakeSql([{ active: false, next_fire_at: at, last_fired_at: null }]),
      'papercup-hive',
    );
    expect(r?.nextFireAt).toEqual(at);
    expect(r?.lastFiredAt).toBeNull();
    const g = await getHiveTimeWake(
      fakeSql([{ active: false, next_fire_at: 'not-a-date', last_fired_at: undefined }]),
      'papercup-hive',
    );
    expect(g?.nextFireAt).toBeNull();
    expect(g?.lastFiredAt).toBeNull();
  });

  it('returns null when no routine row exists', async () => {
    expect(await getHiveTimeWake(fakeSql([]), 'papercup-hive')).toBeNull();
  });
});
