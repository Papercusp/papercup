/**
 * Unit tests for the Pot's self-declared wake (autoloop-pot-operator-rebuild
 * P0, D-002): the floor clamp, the fire-side debounce, home-slug resolution,
 * and the subscription → live-reaction-rule projection (against the real
 * in-memory registry — no PG).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Sql } from 'postgres';
import {
  _resetReactionsForTests,
  listReactionRules,
  matchReactions,
} from '../events/registry';

// EI-3282 regression: `registerPotWakeRules` is the boot-time re-projection of
// PERSISTED event subscriptions into the in-memory reaction registry (see the
// module doc comment on wake.ts: "Re-registered at boot ... since the rule
// registry is in-memory"). Mock the operator-state-pg layer it reads through
// (readPotWakeState → readOperatorState) so the test can simulate "a fresh
// process boots with the in-memory registry EMPTY, while Postgres still holds
// subscriptions a prior (now-dead) process persisted" — exactly the EI-3282
// incident shape (a host reboot wiped the Queen's live event subscriptions).
const potWakeStateStore = new Map<string, unknown>();
vi.mock('../operator-state-pg', () => ({
  readOperatorState: async (_table: string, ws?: string) =>
    potWakeStateStore.get(ws ?? '') ?? null,
  updateOperatorState: async () => {
    throw new Error('updateOperatorState not mocked for this test file');
  },
}));

const {
  clampWakeAt,
  decidePotWakeAdmission,
  getPotTimeWake,
  potWakeFloorSec,
  registerPotWakeRules,
  resolvePotHomeSlug,
  syncPotWakeRules,
  withinWakeFloor,
} = await import('./wake');

const ENV_KEYS = ['PAPERCUSP_POT_WAKE_FLOOR_SEC', 'PAPERCUSP_POT_HOME_SLUG'] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  potWakeStateStore.clear();
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  _resetReactionsForTests();
  potWakeStateStore.clear();
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

describe('decidePotWakeAdmission', () => {
  it('records a fire before launch and makes the next concurrent trigger skip', () => {
    const now = Date.parse('2026-06-05T12:00:00Z');
    const first = decidePotWakeAdmission({ subscriptions: [] }, { now, floorSec: 60 });
    expect(first).toEqual({ fired: true, floorSec: 60 });

    const second = decidePotWakeAdmission(
      { subscriptions: [], lastWakeAt: now },
      { now: now + 500, floorSec: 60 },
    );
    expect(second.fired).toBe(false);
    expect(second.skipped).toBe('wake-floor');
    expect(second.nextAllowedAt).toBe('2026-06-05T12:01:00.000Z');
  });

  it('force bypasses the wake floor but not the separate in-flight Mug guard', () => {
    const now = Date.parse('2026-06-05T12:00:00Z');
    expect(
      decidePotWakeAdmission({ subscriptions: [], lastWakeAt: now - 1_000 }, { now, floorSec: 60, force: true }),
    ).toEqual({ fired: true, floorSec: 60 });
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

  it('canonicalizes retired home slugs before persisting wake launch targets', () => {
    delete process.env.PAPERCUSP_POT_HOME_SLUG;
    expect(resolvePotHomeSlug('papercup', 'ctx-slug')).toBe('papercusp');
    expect(resolvePotHomeSlug('  papercup-hive  ', undefined)).toBe('papercusp');
    process.env.PAPERCUSP_POT_HOME_SLUG = 'papercup';
    expect(resolvePotHomeSlug(undefined, undefined)).toBe('papercusp');
    delete process.env.PAPERCUSP_POT_HOME_SLUG;
  });

  it('treats a wildcard "*" as NOT a concrete pot home — skips it so the chain falls through (2026-07-01 404 fix)', () => {
    delete process.env.PAPERCUSP_POT_HOME_SLUG;
    // '*' at any level is skipped — before this fix it fired the launch with installSlug '*' → 404 "unknown project".
    expect(resolvePotHomeSlug('*')).toBe(null);
    expect(resolvePotHomeSlug(undefined, '*')).toBe(null);
    expect(resolvePotHomeSlug('  *  ', undefined)).toBe(null);
    // An explicit/ctx '*' falls THROUGH to a real slug lower in the chain rather than 404-ing.
    expect(resolvePotHomeSlug('*', 'papercusp')).toBe('papercusp');
    process.env.PAPERCUSP_POT_HOME_SLUG = 'papercusp';
    expect(resolvePotHomeSlug(undefined, '*')).toBe('papercusp');
    delete process.env.PAPERCUSP_POT_HOME_SLUG;
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

describe('registerPotWakeRules (EI-3282: event-wake subscriptions survive a host reboot)', () => {
  const WS = 'ws-reboot-test';

  it('re-projects PERSISTED subscriptions into the live registry when it starts EMPTY (simulated post-reboot boot)', async () => {
    // Simulate a prior process having persisted subscriptions to PG, then dying —
    // the in-memory registry (listReactionRules) starts genuinely empty, exactly
    // what a fresh operator boot sees before this runs.
    potWakeStateStore.set(WS, {
      subscriptions: [{ on: 'coord:escalate', note: 'watch escalations' }],
      declaredAt: 1,
    });
    expect(listReactionRules().filter((r) => r.id.startsWith(`pot-wake:${WS}#`))).toHaveLength(0);

    const n = await registerPotWakeRules(WS);

    expect(n).toBe(1);
    const mine = listReactionRules().filter((r) => r.id.startsWith(`pot-wake:${WS}#`));
    expect(mine).toHaveLength(1);
    expect(mine[0].fire).toBe('pot:wake');
    expect(mine[0].source).toBe('pot-wake');
  });

  it('is a no-op (0 rules, no throw) when nothing was ever persisted for this workspace', async () => {
    const n = await registerPotWakeRules('ws-never-declared');
    expect(n).toBe(0);
    expect(
      listReactionRules().filter((r) => r.id.startsWith('pot-wake:ws-never-declared#')),
    ).toHaveLength(0);
  });

  it('is idempotent — calling it twice (e.g. two boot passes) does not duplicate rules', async () => {
    potWakeStateStore.set(WS, { subscriptions: [{ on: 'coord:handoff' }], declaredAt: 1 });
    await registerPotWakeRules(WS);
    await registerPotWakeRules(WS);
    expect(listReactionRules().filter((r) => r.id.startsWith(`pot-wake:${WS}#`))).toHaveLength(1);
  });

  it('fails soft (returns 0, never throws) when the underlying read errors — a boot-blocking failure here must never block boot', async () => {
    potWakeStateStore.set(WS, { subscriptions: [{ on: 'coord:escalate' }] }); // valid shape...
    // ...but force a read failure by making the mocked table lookup throw for this ws.
    const original = potWakeStateStore.get;
    potWakeStateStore.get = ((key: string) => {
      if (key === WS) throw new Error('simulated PG hiccup / pre-migration missing table');
      return original.call(potWakeStateStore, key);
    }) as typeof potWakeStateStore.get;
    // registerPotWakeRules deliberately logs a warning on this fail-soft path
    // (never blocks boot) — expect it explicitly rather than letting the
    // repo's vitest-fail-on-console guard fail the test on an unasserted call.
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await expect(registerPotWakeRules(WS)).resolves.toBe(0);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('[pot] wake-rule registration skipped'));
    } finally {
      potWakeStateStore.get = original;
      warnSpy.mockRestore();
    }
  });
});

describe('getPotTimeWake (EI-257: string-timestamp pools)', () => {
  const fakeSql = (rows: unknown[]): Sql =>
    (async () => rows) as unknown as Sql;

  it('coerces ISO-string timestamps to Dates', async () => {
    const r = await getPotTimeWake(
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
    const r = await getPotTimeWake(
      fakeSql([{ active: false, next_fire_at: at, last_fired_at: null }]),
      'papercup-hive',
    );
    expect(r?.nextFireAt).toEqual(at);
    expect(r?.lastFiredAt).toBeNull();
    const g = await getPotTimeWake(
      fakeSql([{ active: false, next_fire_at: 'not-a-date', last_fired_at: undefined }]),
      'papercup-hive',
    );
    expect(g?.nextFireAt).toBeNull();
    expect(g?.lastFiredAt).toBeNull();
  });

  it('returns null when no routine row exists', async () => {
    expect(await getPotTimeWake(fakeSql([]), 'papercup-hive')).toBeNull();
  });
});
