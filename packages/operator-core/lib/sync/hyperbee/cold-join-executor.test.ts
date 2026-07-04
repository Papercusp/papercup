/**
 * cold-join-executor.test.ts — the HEAVY cold-join canary executor (P-010 live-wire 3).
 *
 * Pure/hermetic: the heavy spawn+observe seam is INJECTED, so the whole decision
 * matrix (usable / not-usable / rig-unavailable / timing) runs with no DB and no
 * real join. Proves the honest-headless boundary: `evaluateColdJoinProbe` is a pure
 * function of the observations, and `buildDefaultColdJoinExecutor` times + evaluates
 * without ever fabricating a pass when the rig spawn is missing.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  evaluateColdJoinProbe,
  buildDefaultColdJoinExecutor,
  defaultColdJoinExecutor,
  resolveColdJoinSpawnObserve,
  setColdJoinSpawnObserve,
  unavailableColdJoinSpawn,
  COLD_JOIN_RIG_REQUIRED,
  DEFAULT_COLD_JOIN_THRESHOLDS,
  type ColdJoinObservations,
} from './cold-join-executor';

const USABLE: ColdJoinObservations = { plansVisible: 12, workItemsVisible: 340, repoUsable: true };

afterEach(() => setColdJoinSpawnObserve(null)); // never leak a registration across tests

describe('evaluateColdJoinProbe', () => {
  it('plans + work-items + repo all present ⇒ ok, detail names the counts', () => {
    const r = evaluateColdJoinProbe(USABLE, { elapsedMs: 42_000 });
    expect(r.ok).toBe(true);
    expect(r.detail).toMatch(/usable hive/);
    expect(r.detail).toMatch(/plans=12/);
    expect(r.detail).toMatch(/workItems=340/);
    expect(r.detail).toMatch(/repo=usable/);
    expect(r.detail).toMatch(/42000ms/);
  });

  it('no plans ⇒ not usable, detail names the missing plans', () => {
    const r = evaluateColdJoinProbe({ plansVisible: 0, workItemsVisible: 5, repoUsable: true });
    expect(r.ok).toBe(false);
    expect(r.detail).toMatch(/NOT a usable hive/);
    expect(r.detail).toMatch(/plans 0 < 1/);
  });

  it('no work-items ⇒ not usable', () => {
    const r = evaluateColdJoinProbe({ plansVisible: 3, workItemsVisible: 0, repoUsable: true });
    expect(r.ok).toBe(false);
    expect(r.detail).toMatch(/work-items 0 < 1/);
  });

  it('repo unusable ⇒ not usable even with plans + work-items', () => {
    const r = evaluateColdJoinProbe({ plansVisible: 3, workItemsVisible: 9, repoUsable: false });
    expect(r.ok).toBe(false);
    expect(r.detail).toMatch(/repo not usable/);
    expect(r.detail).toMatch(/repo=UNUSABLE/);
  });

  it('aggregates ALL failures in one detail (nothing federated)', () => {
    const r = evaluateColdJoinProbe({ plansVisible: 0, workItemsVisible: 0, repoUsable: false });
    expect(r.ok).toBe(false);
    expect(r.detail).toMatch(/plans 0 < 1/);
    expect(r.detail).toMatch(/work-items 0 < 1/);
    expect(r.detail).toMatch(/repo not usable/);
  });

  it('honors custom thresholds (a stricter delta bar)', () => {
    const obs = { plansVisible: 2, workItemsVisible: 2, repoUsable: true };
    expect(evaluateColdJoinProbe(obs, { thresholds: { minPlans: 1, minWorkItems: 1 } }).ok).toBe(true);
    expect(evaluateColdJoinProbe(obs, { thresholds: { minPlans: 5, minWorkItems: 5 } }).ok).toBe(false);
  });

  it('surfaces bytesTransferred in the detail when provided', () => {
    const r = evaluateColdJoinProbe({ ...USABLE, bytesTransferred: 5_000_000_000 });
    expect(r.detail).toMatch(/5000000000B/);
  });

  it('DEFAULT thresholds are 1 plan / 1 work-item', () => {
    expect(DEFAULT_COLD_JOIN_THRESHOLDS).toEqual({ minPlans: 1, minWorkItems: 1 });
  });
});

describe('buildDefaultColdJoinExecutor', () => {
  it('times the spawn and evaluates a usable observation ⇒ ok', async () => {
    let t = 1000;
    const now = vi.fn(() => t);
    const spawnObserve = vi.fn(async () => {
      t = 43_000; // 42s elapsed
      return USABLE;
    });
    const exec = buildDefaultColdJoinExecutor({ spawnObserve, now });
    const r = await exec();
    expect(r.ok).toBe(true);
    expect(r.detail).toMatch(/42000ms/);
    expect(spawnObserve).toHaveBeenCalledOnce();
  });

  it('a join that ran but produced no usable hive ⇒ ok:false (canary FAILED, not error)', async () => {
    const spawnObserve = vi.fn(async () => ({ plansVisible: 0, workItemsVisible: 0, repoUsable: false }));
    const r = await buildDefaultColdJoinExecutor({ spawnObserve })();
    expect(r.ok).toBe(false);
    expect(r.detail).toMatch(/NOT a usable hive/);
  });

  it('a spawn THROW propagates (canary maps it to error) — never a fake pass', async () => {
    const spawnObserve = vi.fn(async () => {
      throw new Error('rig unreachable');
    });
    await expect(buildDefaultColdJoinExecutor({ spawnObserve })()).rejects.toThrow(/rig unreachable/);
  });

  it('with no injected seam, defaults to the resolved (rig-required) spawn ⇒ throws honestly', async () => {
    await expect(buildDefaultColdJoinExecutor()()).rejects.toThrow(COLD_JOIN_RIG_REQUIRED);
  });
});

describe('cold-join spawn registration', () => {
  it('resolves the rig-required thrower by default', () => {
    expect(resolveColdJoinSpawnObserve()).toBe(unavailableColdJoinSpawn);
  });

  it('unavailableColdJoinSpawn throws the rig-required message', async () => {
    await expect(unavailableColdJoinSpawn()).rejects.toThrow(COLD_JOIN_RIG_REQUIRED);
  });

  it('a rig can register a real spawn; the default executor then uses it', async () => {
    setColdJoinSpawnObserve(async () => USABLE);
    expect(resolveColdJoinSpawnObserve()).not.toBe(unavailableColdJoinSpawn);
    const r = await defaultColdJoinExecutor();
    expect(r.ok).toBe(true);
    expect(r.detail).toMatch(/plans=12/);
  });

  it('setColdJoinSpawnObserve(null) clears back to the rig-required thrower', async () => {
    setColdJoinSpawnObserve(async () => USABLE);
    setColdJoinSpawnObserve(null);
    await expect(defaultColdJoinExecutor()).rejects.toThrow(COLD_JOIN_RIG_REQUIRED);
  });

  it('defaultColdJoinExecutor resolves the spawn at EACH call (late rig registration works)', async () => {
    // First call: no rig ⇒ honest throw.
    await expect(defaultColdJoinExecutor()).rejects.toThrow(COLD_JOIN_RIG_REQUIRED);
    // Rig registers afterwards ⇒ next call succeeds (resolution is per-call, not per-wire).
    setColdJoinSpawnObserve(async () => USABLE);
    const r = await defaultColdJoinExecutor();
    expect(r.ok).toBe(true);
  });
});
