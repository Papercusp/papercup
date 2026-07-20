/**
 * Gap 1 — buildFleetRateStatus() read-model assembly (fleet-rate-status.ts:54-94),
 * in isolation. All collaborators in `@papercusp/papercusp-shared/agent` plus the config
 * getter and `summarizeUsage` are module-mocked, so this drives the pure assembly logic:
 *   (a) pause math — pausedUntil > now → paused + msUntilReset; past → not paused, 0;
 *   (b) the 60s window gate — a stale windowStart zeroes the window.*.used counters;
 *   (c) the cap fallback — an Infinity global cap falls back to cfg.maxSimultaneousAgents
 *       for both cap and effective;
 *   (d) the summarizeUsage rejection → emptyUsage() (.catch path).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  snapshotGovernors: vi.fn(() => [] as unknown[]),
  globalConcurrencySnapshot: vi.fn(() => ({ cap: 8, inFlight: 2 })),
  effectiveConcurrencySnapshot: vi.fn((): { effective: number | null; floor: number; cleanStreak: number } => ({ effective: 5, floor: 1, cleanStreak: 0 })),
  getCachedRateLimitConfig: vi.fn(() => ({ maxSimultaneousAgents: 8, concurrencyFloor: 1 })),
  summarizeUsage: vi.fn(async () => ({
    windowMs: 3600_000, calls: 1, inputTokens: 10, outputTokens: 5,
    cacheReadTokens: 0, cacheCreationTokens: 0, spendUsd: 0.01, buckets: [],
  })),
  loadAccountPool: vi.fn(async () => ({ accounts: [] as unknown[] })),
  listPresence: vi.fn(async () => [] as Array<{ heartbeatAt: string }>),
  activeWorkspaceId: vi.fn(() => 'ws-test'),
}));

vi.mock('@papercusp/papercusp-shared/agent', () => ({
  snapshotGovernors: h.snapshotGovernors,
  globalConcurrencySnapshot: h.globalConcurrencySnapshot,
  effectiveConcurrencySnapshot: h.effectiveConcurrencySnapshot,
}));
vi.mock('./rate-limit-config', () => ({ getCachedRateLimitConfig: h.getCachedRateLimitConfig }));
vi.mock('./agent-usage-telemetry', () => ({ summarizeUsage: h.summarizeUsage }));
// B-GW-4 opus-budget: mock only the pool loader; the pure summarizeOpusBudget runs for real.
vi.mock('./deployment/account-pool-store', () => ({ loadAccountPool: h.loadAccountPool }));
// EI-18106936190883400 (liveAgents): mock presence — the real PRESENCE_STALE_MS constant
// runs for real (it's a pure number, no need to mock it).
vi.mock('./agent-tools/coordination/presence', () => ({ listPresence: h.listPresence, PRESENCE_STALE_MS: 10 * 60 * 1000 }));
vi.mock('./workspace-registry', () => ({ activeWorkspaceId: h.activeWorkspaceId }));

import { buildFleetRateStatus } from './fleet-rate-status';

/** A governor snapshot with sane defaults; overrides patch the `state`. */
function bucket(state: Partial<Record<string, unknown>> = {}, key = 'anthropic:opus') {
  return {
    key,
    provider: 'anthropic',
    modelClass: 'opus',
    limitModel: 'apiKey' as const,
    state: {
      limits: { maxConcurrent: 4, rpm: 100, itpm: 50_000, otpm: 20_000 },
      inFlight: 1,
      windowStart: Date.now(), // fresh window by default
      reqInWindow: 7,
      inTokInWindow: 1_234,
      outTokInWindow: 567,
      pausedUntil: 0,
      paceDelayMs: 0,
      ...state,
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  h.globalConcurrencySnapshot.mockReturnValue({ cap: 8, inFlight: 2 });
  h.effectiveConcurrencySnapshot.mockReturnValue({ effective: 5, floor: 1, cleanStreak: 0 });
  h.getCachedRateLimitConfig.mockReturnValue({ maxSimultaneousAgents: 8, concurrencyFloor: 1 });
  h.summarizeUsage.mockResolvedValue({
    windowMs: 3600_000, calls: 1, inputTokens: 10, outputTokens: 5,
    cacheReadTokens: 0, cacheCreationTokens: 0, spendUsd: 0.01, buckets: [],
  });
  h.loadAccountPool.mockResolvedValue({ accounts: [] });
  h.listPresence.mockResolvedValue([]);
  h.activeWorkspaceId.mockReturnValue('ws-test');
});

describe('buildFleetRateStatus (Gap 1 — read-model assembly, isolated)', () => {
  it('(a) a future pausedUntil → paused:true with msUntilReset ≈ the remaining ms', async () => {
    const now = Date.now();
    h.snapshotGovernors.mockReturnValue([bucket({ pausedUntil: now + 5000 })]);
    const s = await buildFleetRateStatus();
    const b = s.buckets[0];
    expect(b.paused).toBe(true);
    expect(b.pausedUntil).not.toBeNull();
    // The fn reads its own Date.now() after we set pausedUntil; allow a few ms of clock drift.
    expect(b.msUntilReset).toBeGreaterThan(4_800);
    expect(b.msUntilReset).toBeLessThanOrEqual(5_000);
  });

  it('(a) a past pausedUntil → paused:false, pausedUntil:null, msUntilReset:0', async () => {
    h.snapshotGovernors.mockReturnValue([bucket({ pausedUntil: Date.now() - 1 })]);
    const s = await buildFleetRateStatus();
    const b = s.buckets[0];
    expect(b.paused).toBe(false);
    expect(b.pausedUntil).toBeNull();
    expect(b.msUntilReset).toBe(0);
  });

  it('(b) a stale window (windowStart = now-61s) zeroes window.*.used; limits still flow through', async () => {
    h.snapshotGovernors.mockReturnValue([
      bucket({ windowStart: Date.now() - 61_000, reqInWindow: 7, inTokInWindow: 1234, outTokInWindow: 567 }),
    ]);
    const s = await buildFleetRateStatus();
    const w = s.buckets[0].window;
    expect(w.rpm.used).toBe(0);
    expect(w.itpm.used).toBe(0);
    expect(w.otpm.used).toBe(0);
    // limits are not window-gated — they pass through from s.limits.
    expect(w.rpm.limit).toBe(100);
    expect(w.itpm.limit).toBe(50_000);
    expect(w.otpm.limit).toBe(20_000);
  });

  it('(b) a fresh window (windowStart = now) passes the used counters through; absent limits → null', async () => {
    h.snapshotGovernors.mockReturnValue([
      bucket({
        windowStart: Date.now(),
        reqInWindow: 7,
        inTokInWindow: 1234,
        outTokInWindow: 567,
        limits: { maxConcurrent: 4 }, // no rpm/itpm/otpm
      }),
    ]);
    const s = await buildFleetRateStatus();
    const w = s.buckets[0].window;
    expect(w.rpm.used).toBe(7);
    expect(w.itpm.used).toBe(1234);
    expect(w.otpm.used).toBe(567);
    expect(w.rpm.limit).toBeNull();
    expect(w.itpm.limit).toBeNull();
    expect(w.otpm.limit).toBeNull();
    expect(s.buckets[0].maxConcurrent).toBe(4);
  });

  it('(c) an Infinity global cap falls back to cfg.maxSimultaneousAgents for cap AND effective', async () => {
    h.globalConcurrencySnapshot.mockReturnValue({ cap: Infinity, inFlight: 3 });
    // effective null (AIMD inactive without a finite cap) → also falls back to the cfg cap.
    h.effectiveConcurrencySnapshot.mockReturnValue({ effective: null, floor: 2, cleanStreak: 0 });
    h.getCachedRateLimitConfig.mockReturnValue({ maxSimultaneousAgents: 6, concurrencyFloor: 2 });
    h.snapshotGovernors.mockReturnValue([]);
    const s = await buildFleetRateStatus();
    expect(s.fleet.cap).toBe(6);
    expect(s.fleet.effective).toBe(6);
    expect(s.fleet.inFlight).toBe(3);
    expect(s.fleet.floor).toBe(2); // floor always from cfg.concurrencyFloor
  });

  it('(c) a finite global cap is used directly for cap; effective passes through when set', async () => {
    h.globalConcurrencySnapshot.mockReturnValue({ cap: 4, inFlight: 1 });
    h.effectiveConcurrencySnapshot.mockReturnValue({ effective: 3, floor: 1, cleanStreak: 0 });
    h.getCachedRateLimitConfig.mockReturnValue({ maxSimultaneousAgents: 8, concurrencyFloor: 1 });
    h.snapshotGovernors.mockReturnValue([]);
    const s = await buildFleetRateStatus();
    expect(s.fleet.cap).toBe(4); // the finite registry cap, NOT the cfg cap
    expect(s.fleet.effective).toBe(3);
  });

  it('(d) a summarizeUsage rejection falls back to emptyUsage() via .catch', async () => {
    h.snapshotGovernors.mockReturnValue([]);
    h.summarizeUsage.mockRejectedValue(new Error('telemetry PG down'));
    const s = await buildFleetRateStatus();
    expect(s.usage).toEqual({
      windowMs: 0, calls: 0, inputTokens: 0, outputTokens: 0,
      cacheReadTokens: 0, cacheCreationTokens: 0, spendUsd: 0, buckets: [],
    });
    // assembly still succeeds.
    expect(s.ok).toBe(true);
  });

  it('passes windowMs straight through to summarizeUsage; default is 1h', async () => {
    h.snapshotGovernors.mockReturnValue([]);
    await buildFleetRateStatus(); // default
    expect(h.summarizeUsage).toHaveBeenLastCalledWith(60 * 60 * 1000);
    await buildFleetRateStatus(30 * 60_000);
    expect(h.summarizeUsage).toHaveBeenLastCalledWith(30 * 60_000);
  });

  it('(B-GW-4) surfaces opusBudget: empty pool → no signal, headroom zone, nothing shedding', async () => {
    h.snapshotGovernors.mockReturnValue([]);
    h.loadAccountPool.mockResolvedValue({ accounts: [] });
    const s = await buildFleetRateStatus();
    expect(s.opusBudget).toMatchObject({
      aggregateUtil: null,
      zone: 'headroom',
      shedding: { background: false, normal: false, critical: false },
      pacingCritical: false,
    });
  });

  it('(B-GW-4) surfaces opusBudget: a near-full pool → background+normal shed, critical paced', async () => {
    h.snapshotGovernors.mockReturnValue([]);
    h.loadAccountPool.mockResolvedValue({
      accounts: [{ id: 'a', credentialRef: 'token:/c/a', addedAt: 1, boundTo: [], rate: { pausedUntil: 0, lastPenaltyAt: 0, penaltyCount: 0, windowStartedAt: 0, utilization: 0.97, utilizationAt: Date.now() } }],
    });
    const s = await buildFleetRateStatus();
    expect(s.opusBudget?.zone).toBe('exhausted');
    expect(s.opusBudget?.shedding).toMatchObject({ background: true, normal: true, critical: false });
    expect(s.opusBudget?.pacingCritical).toBe(true);
  });

  it('(B-GW-4) opusBudget is null (never throws) when the pool load rejects', async () => {
    h.snapshotGovernors.mockReturnValue([]);
    h.loadAccountPool.mockRejectedValue(new Error('pool PG down'));
    const s = await buildFleetRateStatus();
    expect(s.opusBudget).toBeNull();
    expect(s.ok).toBe(true);
  });

  describe('(EI-18106936190883400) fleet.liveAgents — the real fleet-wide count, distinct from inFlight', () => {
    it('counts only non-stale presence rows for the active workspace', async () => {
      h.snapshotGovernors.mockReturnValue([]);
      const now = Date.now();
      h.listPresence.mockResolvedValue([
        { heartbeatAt: new Date(now).toISOString() }, // fresh
        { heartbeatAt: new Date(now - 60_000).toISOString() }, // fresh (1m old)
        { heartbeatAt: new Date(now - 11 * 60_000).toISOString() }, // stale (>10m)
      ]);
      const s = await buildFleetRateStatus();
      expect(s.fleet.liveAgents).toBe(2);
      expect(h.listPresence).toHaveBeenCalledWith({ workspaceId: 'ws-test' });
    });

    it('is independent of the governor-scoped inFlight (the divergence the bug reported)', async () => {
      h.snapshotGovernors.mockReturnValue([]);
      h.globalConcurrencySnapshot.mockReturnValue({ cap: 8, inFlight: 0 }); // governor sees 0 in-flight
      h.listPresence.mockResolvedValue(
        Array.from({ length: 59 }, () => ({ heartbeatAt: new Date().toISOString() })),
      );
      const s = await buildFleetRateStatus();
      expect(s.fleet.inFlight).toBe(0);
      expect(s.fleet.liveAgents).toBe(59);
    });

    it('degrades to 0 (never throws) when the presence store read rejects', async () => {
      h.snapshotGovernors.mockReturnValue([]);
      h.listPresence.mockRejectedValue(new Error('presence PG down'));
      const s = await buildFleetRateStatus();
      expect(s.fleet.liveAgents).toBe(0);
      expect(s.ok).toBe(true);
    });
  });
});
