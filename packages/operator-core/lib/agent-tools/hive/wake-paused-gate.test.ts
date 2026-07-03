/**
 * WI-2012 — the paused-queen wake gates (owner directive 2026-07-03).
 *
 * Invariant: when no hive is started (getHiveStarted=false), the queen CANNOT
 * be re-armed or autonomously woken:
 *   - hive:declare-wake REFUSES (hive_paused) — kills the self-perpetuating
 *     re-arm where an in-flight queen turn re-declared the timer hive:pause
 *     had just cleared.
 *   - hive:wake SKIPS source:'event' fires (subscriptions persist across
 *     pause) — but user/manual wakes still fire (explicit human intent).
 * hive:start sets started=true BEFORE arming, so the gates never strand resume.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const getHiveStarted = vi.fn();
vi.mock('../../hive/started', () => ({
  getHiveStarted: (...a: unknown[]) => getHiveStarted(...a),
  setHiveStarted: vi.fn(),
  setHivePlacementStarted: vi.fn(),
  anyHivePlacementStarted: vi.fn(),
}));

const declareHiveTimeWake = vi.fn();
const clearHiveTimeWake = vi.fn();
const setHiveEventSubscriptions = vi.fn();
const setHiveCarryNote = vi.fn();
const claimHiveWakeFire = vi.fn();
vi.mock('../../hive/wake', () => ({
  HIVE_BLUEPRINT_ID: 'hive-blueprint',
  hiveWakeFloorSec: () => 60,
  effectiveHiveWakeFloorSec: async () => 60,
  resolveHiveHomeSlug: (explicit?: string | null, ctxSlug?: string | null) =>
    explicit?.trim() || ctxSlug?.trim() || null,
  declareHiveTimeWake: (...a: unknown[]) => declareHiveTimeWake(...a),
  clearHiveTimeWake: (...a: unknown[]) => clearHiveTimeWake(...a),
  setHiveEventSubscriptions: (...a: unknown[]) => setHiveEventSubscriptions(...a),
  setHiveCarryNote: (...a: unknown[]) => setHiveCarryNote(...a),
  claimHiveWakeFire: (...a: unknown[]) => claimHiveWakeFire(...a),
}));

const fireLaunchBlueprint = vi.fn();
vi.mock('../../blueprint/launch-blueprint', () => ({
  fireLaunchBlueprint: (...a: unknown[]) => fireLaunchBlueprint(...a),
}));

// Frontier guard OFF for these tests — the gate under test runs before it anyway.
vi.mock('@papercusp/flags/server', () => ({ getFlag: async () => false }));
vi.mock('../../hive/wake-frontier-guard', () => ({
  evaluateWakeFrontierGuard: () => null,
  listUnplacedHiveFrontier: async () => [],
  listNonTerminalPlacements: async () => [],
}));
vi.mock('../../owner-steering', () => ({
  getOwnerSteering: async () => null,
  isPausedNow: () => false,
}));

const fakeSql = (): Promise<unknown[]> => Promise.resolve([]);
vi.mock('@papercusp/db-org', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, getOrgPg: () => ({ sql: fakeSql }) };
});

import declareWake from './declare_wake';
import hiveWake from './wake';

const ctx = { workspaceId: 'ws-1', isSuperuser: true } as never;
const call = async (tool: { args: unknown; handler: Function }, x: unknown) => {
  const parsed = (tool.args as { parse: (v: unknown) => unknown }).parse(x);
  const res = await tool.handler(parsed, ctx);
  return JSON.parse(res.content[0].text);
};

beforeEach(() => {
  vi.clearAllMocks();
  declareHiveTimeWake.mockResolvedValue({ at: new Date('2026-07-04T00:00:00Z'), clamped: false });
  setHiveEventSubscriptions.mockResolvedValue(0);
  setHiveCarryNote.mockResolvedValue(null);
  claimHiveWakeFire.mockResolvedValue({ fired: true });
  fireLaunchBlueprint.mockResolvedValue({ role: 'queen' });
});

describe('hive:declare-wake paused gate (WI-2012)', () => {
  it('REFUSES to arm anything while the queen loop is not started', async () => {
    getHiveStarted.mockResolvedValue(false);
    const out = await call(declareWake as never, { harness: 'my-hive', inSeconds: 300 });
    expect(out.ok).toBe(false);
    expect(out.error).toBe('hive_paused');
    expect(declareHiveTimeWake).not.toHaveBeenCalled();
    expect(setHiveEventSubscriptions).not.toHaveBeenCalled();
    expect(clearHiveTimeWake).not.toHaveBeenCalled();
  });

  it('arms normally when the queen loop is started', async () => {
    getHiveStarted.mockResolvedValue(true);
    const out = await call(declareWake as never, { harness: 'my-hive', inSeconds: 300 });
    expect(out.ok).toBe(true);
    expect(declareHiveTimeWake).toHaveBeenCalledTimes(1);
  });
});

describe('hive:wake paused gate (WI-2012)', () => {
  it("SKIPS an event-sourced wake while the queen loop is not started (subscriptions outlive pause)", async () => {
    getHiveStarted.mockResolvedValue(false);
    const out = await call(hiveWake as never, { harness: 'my-hive', source: 'event' });
    expect(out.ok).toBe(true);
    expect(out.fired).toBe(false);
    expect(out.skipped).toBe('hive-paused');
    expect(fireLaunchBlueprint).not.toHaveBeenCalled();
  });

  it('still fires an explicit user wake while paused (deliberate human intent)', async () => {
    getHiveStarted.mockResolvedValue(false);
    const out = await call(hiveWake as never, { harness: 'my-hive', source: 'user' });
    expect(out.ok).toBe(true);
    expect(out.fired).toBe(true);
    expect(fireLaunchBlueprint).toHaveBeenCalledTimes(1);
  });

  it('fires an event wake normally when the queen loop is started', async () => {
    getHiveStarted.mockResolvedValue(true);
    const out = await call(hiveWake as never, { harness: 'my-hive', source: 'event' });
    expect(out.ok).toBe(true);
    expect(out.fired).toBe(true);
  });
});
