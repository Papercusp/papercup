/**
 * Unit tests for the Pot's self-declared wake (autoloop-pot-operator-rebuild
 * P0, D-002): the floor clamp, the fire-side debounce, home-slug resolution,
 * and the subscription → live-reaction-rule projection (against the real
 * in-memory registry — no PG).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  clampWakeAt,
  potWakeFloorSec,
  resolvePotHomeSlug,
  syncPotWakeRules,
  withinWakeFloor,
} from './wake';
import {
  _resetReactionsForTests,
  listReactionRules,
  matchReactions,
} from '../events/registry';

const ENV_KEYS = ['PAPERCUSP_POT_WAKE_FLOOR_SEC', 'PAPERCUSP_POT_HOME_SLUG'] as const;
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

describe('potWakeFloorSec', () => {
  it('defaults to 60 and honors the env override with a hard 5s minimum', () => {
    expect(potWakeFloorSec()).toBe(60);
    process.env.PAPERCUSP_POT_WAKE_FLOOR_SEC = '120';
    expect(potWakeFloorSec()).toBe(120);
    process.env.PAPERCUSP_POT_WAKE_FLOOR_SEC = '1'; // below the hard min
    expect(potWakeFloorSec()).toBe(60);
    process.env.PAPERCUSP_POT_WAKE_FLOOR_SEC = 'nonsense';
    expect(potWakeFloorSec()).toBe(60);
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
});

describe('withinWakeFloor (the fire-side debounce)', () => {
  it('is false with no prior wake, true inside the window, false after it', () => {
    const now = Date.parse('2026-06-05T12:00:00Z');
    expect(withinWakeFloor({ subscriptions: [] }, now)).toBe(false);
    expect(withinWakeFloor({ subscriptions: [], lastWakeAt: now - 30_000 }, now)).toBe(true);
    expect(withinWakeFloor({ subscriptions: [], lastWakeAt: now - 61_000 }, now)).toBe(false);
  });
});

describe('resolvePotHomeSlug', () => {
  it('prefers explicit arg, then ctx harness, then the env default', () => {
    process.env.PAPERCUSP_POT_HOME_SLUG = 'env-slug';
    expect(resolvePotHomeSlug('arg-slug', 'ctx-slug')).toBe('arg-slug');
    expect(resolvePotHomeSlug(undefined, 'ctx-slug')).toBe('ctx-slug');
    expect(resolvePotHomeSlug(undefined, undefined)).toBe('env-slug');
    delete process.env.PAPERCUSP_POT_HOME_SLUG;
    expect(resolvePotHomeSlug('', '')).toBe(null);
  });
});

describe('syncPotWakeRules (subscriptions → live reaction rules)', () => {
  const WS = 'ws-pot-test';

  it('registers one pot:wake rule per subscription, scoped to the workspace', () => {
    const n = syncPotWakeRules(WS, [
      { on: 'coord:escalate', note: 'watch escalations' },
      { on: ['work_items:complete', 'work_items:set_state'] },
    ]);
    expect(n).toBe(2);
    const mine = listReactionRules().filter((r) => r.id.startsWith(`pot-wake:${WS}#`));
    expect(mine).toHaveLength(2);
    expect(mine.every((r) => r.fire === 'pot:wake')).toBe(true);
    expect(mine.every((r) => r.source === 'pot-wake')).toBe(true);
  });

  it('REPLACE semantics: re-sync removes stale rules; empty clears all', () => {
    syncPotWakeRules(WS, [{ on: 'coord:escalate' }, { on: 'coord:handoff' }]);
    syncPotWakeRules(WS, [{ on: 'coord:escalate' }]);
    expect(listReactionRules().filter((r) => r.id.startsWith(`pot-wake:${WS}#`))).toHaveLength(1);
    syncPotWakeRules(WS, []);
    expect(listReactionRules().filter((r) => r.id.startsWith(`pot-wake:${WS}#`))).toHaveLength(0);
  });

  it('does not touch another workspace\'s rules', () => {
    syncPotWakeRules('ws-a', [{ on: 'coord:escalate' }]);
    syncPotWakeRules('ws-b', [{ on: 'coord:escalate' }]);
    syncPotWakeRules('ws-a', []);
    expect(listReactionRules().filter((r) => r.id.startsWith('pot-wake:ws-b#'))).toHaveLength(1);
  });

  it('a registered subscription MATCHES a tool event (with the declared when)', () => {
    syncPotWakeRules(WS, [
      { on: 'coord:escalate', when: { 'result.ok': true } },
    ]);
    const matched = matchReactions({
      tool: 'coord:escalate',
      args: {},
      result: { ok: true },
      ctx: {} as never,
    });
    expect(matched.some((m) => m.rule.id === `pot-wake:${WS}#0`)).toBe(true);
    // A failed trigger does not match the declared when.
    const unmatched = matchReactions({
      tool: 'coord:escalate',
      args: {},
      result: { ok: false },
      ctx: {} as never,
    });
    expect(unmatched.some((m) => m.rule.id === `pot-wake:${WS}#0`)).toBe(false);
  });
});
