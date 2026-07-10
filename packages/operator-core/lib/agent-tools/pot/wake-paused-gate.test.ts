/**
 * WI-2012 — the paused-mug wake gates (owner directive 2026-07-03).
 *
 * Invariant: when no pot is started (getPotStarted=false), the mug CANNOT
 * be re-armed or autonomously woken:
 *   - pot:declare-wake REFUSES (hive_paused) — kills the self-perpetuating
 *     re-arm where an in-flight mug turn re-declared the timer pot:pause
 *     had just cleared.
 *   - pot:wake SKIPS source:'event' fires (subscriptions persist across
 *     pause) — but user/manual wakes still fire (explicit human intent).
 * pot:start sets started=true BEFORE arming, so the gates never strand resume.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const getPotStarted = vi.fn();
vi.mock('../../pot/started', () => ({
  getPotStarted: (...a: unknown[]) => getPotStarted(...a),
  setPotStarted: vi.fn(),
  setPotPlacementStarted: vi.fn(),
  anyPotPlacementStarted: vi.fn(),
}));

const declarePotTimeWake = vi.fn();
const clearPotTimeWake = vi.fn();
const setPotEventSubscriptions = vi.fn();
const setPotCarryNote = vi.fn();
const claimPotWakeFire = vi.fn();
vi.mock('../../pot/wake', () => ({
  POT_BLUEPRINT_ID: 'pot-blueprint',
  potWakeFloorSec: () => 60,
  effectivePotWakeFloorSec: async () => 60,
  resolvePotHomeSlug: (explicit?: string | null, ctxSlug?: string | null) =>
    explicit?.trim() || ctxSlug?.trim() || null,
  declarePotTimeWake: (...a: unknown[]) => declarePotTimeWake(...a),
  clearPotTimeWake: (...a: unknown[]) => clearPotTimeWake(...a),
  setPotEventSubscriptions: (...a: unknown[]) => setPotEventSubscriptions(...a),
  setPotCarryNote: (...a: unknown[]) => setPotCarryNote(...a),
  claimPotWakeFire: (...a: unknown[]) => claimPotWakeFire(...a),
}));

const fireLaunchBlueprint = vi.fn();
vi.mock('../../blueprint/launch-blueprint', () => ({
  fireLaunchBlueprint: (...a: unknown[]) => fireLaunchBlueprint(...a),
}));

// Frontier guard OFF for these tests — the gate under test runs before it anyway.
vi.mock('@papercusp/flags/server', () => ({ getFlag: async () => false }));
vi.mock('../../pot/wake-frontier-guard', () => ({
  evaluateWakeFrontierGuard: () => null,
  listUnplacedPotFrontier: async () => [],
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
import potWake from './wake';

const ctx = { workspaceId: 'ws-1', isSuperuser: true } as never;
const call = async (tool: { args: unknown; handler: Function }, x: unknown) => {
  const parsed = (tool.args as { parse: (v: unknown) => unknown }).parse(x);
  const res = await tool.handler(parsed, ctx);
  return JSON.parse(res.content[0].text);
};

beforeEach(() => {
  vi.clearAllMocks();
  declarePotTimeWake.mockResolvedValue({ at: new Date('2026-07-04T00:00:00Z'), clamped: false });
  setPotEventSubscriptions.mockResolvedValue(0);
  setPotCarryNote.mockResolvedValue(null);
  claimPotWakeFire.mockResolvedValue({ fired: true });
  fireLaunchBlueprint.mockResolvedValue({ role: 'mug' });
});

describe('pot:declare-wake paused gate (WI-2012)', () => {
  it('REFUSES to arm anything while the mug loop is not started', async () => {
    getPotStarted.mockResolvedValue(false);
    const out = await call(declareWake as never, { harness: 'my-pot', inSeconds: 300 });
    expect(out.ok).toBe(false);
    expect(out.error).toBe('hive_paused');
    expect(declarePotTimeWake).not.toHaveBeenCalled();
    expect(setPotEventSubscriptions).not.toHaveBeenCalled();
    expect(clearPotTimeWake).not.toHaveBeenCalled();
  });

  it('arms normally when the mug loop is started', async () => {
    getPotStarted.mockResolvedValue(true);
    const out = await call(declareWake as never, { harness: 'my-pot', inSeconds: 300 });
    expect(out.ok).toBe(true);
    expect(declarePotTimeWake).toHaveBeenCalledTimes(1);
  });
});

describe('pot:wake paused gate (WI-2012)', () => {
  it("SKIPS an event-sourced wake while the mug loop is not started (subscriptions outlive pause)", async () => {
    getPotStarted.mockResolvedValue(false);
    const out = await call(potWake as never, { harness: 'my-pot', source: 'event' });
    expect(out.ok).toBe(true);
    expect(out.fired).toBe(false);
    expect(out.skipped).toBe('pot-paused');
    expect(fireLaunchBlueprint).not.toHaveBeenCalled();
  });

  it('still fires an explicit user wake while paused (deliberate human intent)', async () => {
    getPotStarted.mockResolvedValue(false);
    const out = await call(potWake as never, { harness: 'my-pot', source: 'user' });
    expect(out.ok).toBe(true);
    expect(out.fired).toBe(true);
    expect(fireLaunchBlueprint).toHaveBeenCalledTimes(1);
  });

  it('fires an event wake normally when the mug loop is started', async () => {
    getPotStarted.mockResolvedValue(true);
    const out = await call(potWake as never, { harness: 'my-pot', source: 'event' });
    expect(out.ok).toBe(true);
    expect(out.fired).toBe(true);
  });
});
