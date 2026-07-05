/**
 * compaction-compliance-watchdog.test.ts — seeding + over-limit sweep
 * (agent-managed-compaction P-009 · context-trimming-tiers P-006/D-006).
 *
 * The seeding step is THE hook that arms agent-managed compaction: the
 * P-007 usage signal and self-compaction only engage for sessions whose
 * presence row carries a compaction_limit, and nothing else writes one by
 * default. Mocks the estimator/spec-resolver/presence writes; drives the
 * sweep with a fake `sql` tag that answers the two queries by shape.
 *
 * Run: cd packages/operator-core && npx vitest run lib/system-health/compaction-compliance-watchdog.test.ts
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  estimateMock,
  specMock,
  setEstimateMock,
  setLimitMock,
  deathMock,
  resolveSessionRefMock,
  openEscalationMock,
  getFlagMock,
  findLiveHostMock,
  hostSupportsMock,
  injectMock,
} = vi.hoisted(() => ({
  estimateMock: vi.fn(),
  specMock: vi.fn(),
  setEstimateMock: vi.fn(async () => {}),
  setLimitMock: vi.fn(async () => {}),
  deathMock: vi.fn(async (_owner: string) => false),
  resolveSessionRefMock: vi.fn(
    async (_owner: string) => null as null | { agent: string | null; sessionId: string | null },
  ),
  openEscalationMock: vi.fn(async () => ({ msg_id: 'esc-1' })),
  // P-012 force-compact deps. Defaults keep the EXISTING over-limit tests unaffected:
  // flag ON but NO live host ⇒ maybeForceCompact no-ops (out.forceCompacted stays []).
  getFlagMock: vi.fn(async () => true),
  findLiveHostMock: vi.fn((_ownerId: string) => null as null | { sock: string; caps?: string[] }),
  hostSupportsMock: vi.fn((_host: unknown, _cap: string) => false),
  injectMock: vi.fn(async () => true),
}));
vi.mock('../compaction-usage', () => ({
  estimateContextTokensForOwner: estimateMock,
  resolveModelSpecForOwner: specMock,
  detectContextDeathForOwner: deathMock,
  resolveSessionRef: resolveSessionRefMock,
}));
vi.mock('../agent-tools/coordination/presence', () => ({
  setContextEstimate: setEstimateMock,
  setCompactionLimit: setLimitMock,
}));
vi.mock('../agent-tools/coordination/escalations', () => ({
  openEscalation: openEscalationMock,
}));
// P-012: the force-compact rung's deps. FLAGS is stubbed to the one key the watchdog reads.
vi.mock('@papercusp/flags/server', () => ({ getFlag: getFlagMock }));
vi.mock('@papercusp/flags', () => ({
  FLAGS: {
    COMPACTION_WATCHDOG_FORCE_COMPACT: 'papercusp-compaction-watchdog-force-compact',
    CONTEXT_GAUGE: 'papercusp-context-gauge',
  },
}));
vi.mock('../events/await/psu-pty-discovery', () => ({
  findLiveHost: findLiveHostMock,
  hostSupports: hostSupportsMock,
  injectIntoHost: injectMock,
}));
// The spawn-record honor leg lazily imports the tier menu — pin a small one so
// the test never reads the real workspace agent-config.
vi.mock('../agent-config', () => ({
  readAgentConfig: async () => ({
    tiers: [{ name: 'deep', spec: 'opus:high', compactionLimit: 120_000 }],
  }),
}));
vi.mock('../fleet/model-tiers', () => ({
  effectiveTierConfig: (cfg: { tiers?: unknown } | null) => ({ tiers: cfg?.tiers }),
}));

import {
  checkCompactionCompliance,
  resetContextDeathEscalationsForTests,
  resetForceCompactedForTests,
  resetBootConfigAssertForTests,
} from './compaction-compliance-watchdog';
import {
  getContextUsage,
  isContextGaugeEnabled,
  resetContextUsageCacheForTests,
} from './context-usage-cache';

/** Fake postgres tag: routes on the query text — the seed query selects
 *  `compaction_limit IS NULL`, the sweep `IS NOT NULL`, the honor leg reads
 *  `spawned_agents` keyed by the interpolated ownerId (first tag value). */
function fakeSql(opts: {
  unseeded?: Array<{ owner_id: string; fleet_slug?: string | null; fleet_role?: string | null }>;
  seeded?: Array<{
    owner_id: string;
    owner_label: string;
    compaction_limit: number;
    fleet_slug?: string | null;
    fleet_role?: string | null;
  }>;
  spawnRecords?: Record<string, { model_spec: string | null; model_tier: string | null }>;
  /** P-003: claim-freshness rows keyed by owner (the work_item_claims⋈carry_notes read). */
  claimFreshness?: Record<
    string,
    Array<{ work_item_id: string; acquired_ms: string; last_activity_ms: string; checkpoint_updated_ms: string | null }>
  >;
}) {
  return ((strings: TemplateStringsArray, ...values: unknown[]) => {
    const q = strings.join(' ');
    if (q.includes('compaction_limit IS NULL')) return Promise.resolve(opts.unseeded ?? []);
    if (q.includes('compaction_limit IS NOT NULL')) return Promise.resolve(opts.seeded ?? []);
    if (q.includes('spawned_agents')) {
      const rec = opts.spawnRecords?.[String(values[0])];
      return Promise.resolve(rec ? [rec] : []);
    }
    // P-003 freshness read: `c.owner = ${owner}` is the first interpolated value.
    if (q.includes('work_item_claims')) return Promise.resolve(opts.claimFreshness?.[String(values[0])] ?? []);
    return Promise.resolve([]);
  }) as never;
}

beforeEach(() => {
  vi.clearAllMocks();
  // clearAllMocks wipes implementations too — restore the P-012 defaults (flag ON,
  // no live host, inject succeeds) so unrelated over-limit tests stay no-op.
  getFlagMock.mockResolvedValue(true);
  findLiveHostMock.mockReturnValue(null);
  hostSupportsMock.mockReturnValue(false);
  injectMock.mockResolvedValue(true);
  resetForceCompactedForTests();
  resetBootConfigAssertForTests(); // P-018 boot self-assert dedup + streak
  resetContextUsageCacheForTests(); // P-013 gauge cache + flag mirror
  // The watchdog narrates seeds/over-limit crossings on the console by design;
  // silence it so vitest-fail-on-console doesn't flag the expected output.
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('checkCompactionCompliance seeding (context-trimming-tiers P-006)', () => {
  it('seeds the model-derived default for limit-less live sessions: fable [1m] → 400k cap, unresolvable → 158k', async () => {
    specMock.mockImplementation(async (owner: string) =>
      owner === 'su-wide' ? 'claude-fable-5[1m]' : null,
    );
    const out = await checkCompactionCompliance(
      fakeSql({ unseeded: [{ owner_id: 'su-wide' }, { owner_id: 'su-narrow' }] }),
    );
    expect(out.seeded).toEqual(['su-wide', 'su-narrow']);
    expect(setLimitMock).toHaveBeenCalledWith('su-wide', 400_000);
    expect(setLimitMock).toHaveBeenCalledWith('su-narrow', 158_000);
  });

  it('shapes the [1m] default by fleet role: member → 300k, leader/solo → 400k (owner directive 2026-07-03)', async () => {
    specMock.mockResolvedValue('sonnet[1m]:high');
    const out = await checkCompactionCompliance(
      fakeSql({
        unseeded: [
          { owner_id: 'su-member', fleet_slug: 'backlog-clearance', fleet_role: 'member' },
          { owner_id: 'su-leader', fleet_slug: 'backlog-clearance', fleet_role: 'leader' },
          { owner_id: 'su-solo', fleet_slug: null, fleet_role: null },
          // member shaping reaches the spawn-record spec leg too (D-006 honor leg)
          { owner_id: 'su-spawned-member', fleet_slug: 'backlog-clearance', fleet_role: 'member' },
        ],
        spawnRecords: {
          'su-spawned-member': { model_spec: 'claude-fable-5[1m]', model_tier: null },
        },
      }),
    );
    expect(out.seeded).toEqual(['su-member', 'su-leader', 'su-solo', 'su-spawned-member']);
    expect(setLimitMock).toHaveBeenCalledWith('su-member', 300_000);
    expect(setLimitMock).toHaveBeenCalledWith('su-leader', 400_000);
    expect(setLimitMock).toHaveBeenCalledWith('su-solo', 400_000);
    expect(setLimitMock).toHaveBeenCalledWith('su-spawned-member', 300_000);
  });

  it('honors the spawn record: explicit tier limit > recorded spec default > resolver (D-006)', async () => {
    specMock.mockResolvedValue(null); // resolver would give the 158k fallback
    const out = await checkCompactionCompliance(
      fakeSql({
        unseeded: [
          { owner_id: 's-tier' }, // spawn record names tier "deep" → explicit 120k
          { owner_id: 's-spec' }, // spawn record carries only a fable [1m] spec → 400k cap
          { owner_id: 's-none' }, // no spawn record → resolver fallback → 158k
        ],
        spawnRecords: {
          's-tier': { model_spec: 'opus:high', model_tier: 'deep' },
          's-spec': { model_spec: 'claude-fable-5[1m]', model_tier: null },
        },
      }),
    );
    expect(out.seeded).toEqual(['s-tier', 's-spec', 's-none']);
    expect(setLimitMock).toHaveBeenCalledWith('s-tier', 120_000);
    expect(setLimitMock).toHaveBeenCalledWith('s-spec', 400_000);
    expect(setLimitMock).toHaveBeenCalledWith('s-none', 158_000);
    // the fs/argv resolver only ran for the record-less owner
    expect(specMock).toHaveBeenCalledTimes(1);
    expect(specMock).toHaveBeenCalledWith('s-none');
  });

  it('a per-owner seed failure never fails the pass (best-effort)', async () => {
    specMock.mockResolvedValue(null);
    setLimitMock.mockRejectedValueOnce(new Error('pg down'));
    const out = await checkCompactionCompliance(
      fakeSql({ unseeded: [{ owner_id: 'a' }, { owner_id: 'b' }] }),
    );
    expect(out.seeded).toEqual(['b']); // 'a' failed silently, 'b' seeded
  });
});

describe('checkCompactionCompliance sweep (agent-managed-compaction P-009)', () => {
  it('caches estimates and flags sessions over their own limit', async () => {
    estimateMock.mockImplementation(async (owner: string) => (owner === 'hot' ? 170_000 : 40_000));
    const out = await checkCompactionCompliance(
      fakeSql({
        seeded: [
          { owner_id: 'hot', owner_label: 'su · hot', compaction_limit: 158_000 },
          { owner_id: 'cool', owner_label: 'su · cool', compaction_limit: 158_000 },
        ],
      }),
    );
    expect(out.estimated).toEqual(['hot', 'cool']);
    expect(out.overLimit).toEqual(['hot']);
    expect(setEstimateMock).toHaveBeenCalledWith('hot', 170_000);
  });

  it('P-003: SURFACES an over-limit session\'s unflushed (stale-checkpoint) claim, and skips a fresh one', async () => {
    estimateMock.mockImplementation(async () => 170_000); // over 158k
    const now = Date.now();
    const out = await checkCompactionCompliance(
      fakeSql({
        seeded: [{ owner_id: 'hot', owner_label: 'su · hot', compaction_limit: 158_000 }],
        claimFreshness: {
          hot: [
            // never-checkpointed, held 20 min ⇒ stale 'never'
            { work_item_id: 'WI-500', acquired_ms: String(now - 20 * 60_000), last_activity_ms: String(now), checkpoint_updated_ms: null },
            // checkpointed 30s ago ⇒ fresh, NOT surfaced
            { work_item_id: 'WI-501', acquired_ms: String(now - 60 * 60_000), last_activity_ms: String(now), checkpoint_updated_ms: String(now - 30_000) },
          ],
        },
      }),
    );
    expect(out.overLimit).toEqual(['hot']);
    expect(out.unflushedClaims).toEqual([
      { owner: 'hot', workItemId: 'WI-500', reason: 'never', staleMs: expect.any(Number) },
    ]);
  });

  it('P-003: a session UNDER its limit is never scanned for unflushed claims', async () => {
    estimateMock.mockImplementation(async () => 40_000); // under 158k
    const now = Date.now();
    const out = await checkCompactionCompliance(
      fakeSql({
        seeded: [{ owner_id: 'cool', owner_label: 'su · cool', compaction_limit: 158_000 }],
        claimFreshness: {
          cool: [{ work_item_id: 'WI-9', acquired_ms: String(now - 60 * 60_000), last_activity_ms: String(now), checkpoint_updated_ms: null }],
        },
      }),
    );
    expect(out.overLimit).toEqual([]);
    expect(out.unflushedClaims).toEqual([]); // under limit ⇒ the claim read never runs
  });
});

describe('force-compact rung (agent-managed-compaction P-012)', () => {
  const seeded = [{ owner_id: 'hot', owner_label: 'su · hot', compaction_limit: 158_000 }];

  it('force-compacts an over-limit session with a compact-capable live host (mode:compact)', async () => {
    estimateMock.mockResolvedValue(200_000); // over 158k
    findLiveHostMock.mockReturnValue({ sock: '/tmp/hot.sock', caps: ['compact'] });
    hostSupportsMock.mockReturnValue(true);
    const out = await checkCompactionCompliance(fakeSql({ seeded }));
    expect(out.overLimit).toEqual(['hot']);
    expect(out.forceCompacted).toEqual(['hot']);
    expect(injectMock).toHaveBeenCalledTimes(1);
    const [sock, payload] = injectMock.mock.calls[0] as unknown as [
      string,
      { mode: string; data: string; focus?: string },
    ];
    expect(sock).toBe('/tmp/hot.sock');
    expect(payload.mode).toBe('compact');
    expect(payload.focus).toContain('identity block');
    // Unknown window (no spec resolvable) ⇒ the overshoot bound set forceAt — the
    // note must name THAT, not claim "≈ 1.3 ×" (false math; owner 2026-07-05).
    expect(payload.data).toContain('conservative bound used when the model window is unknown');
    expect(payload.data).toContain('1.2 × your soft limit of 158k');
    expect(payload.data).not.toContain('≈ 1.3 ×');
  });

  it('falls back to a plain /compact turn on a host without the compact capability', async () => {
    estimateMock.mockResolvedValue(200_000);
    findLiveHostMock.mockReturnValue({ sock: '/tmp/hot.sock' });
    hostSupportsMock.mockReturnValue(false);
    const out = await checkCompactionCompliance(fakeSql({ seeded }));
    expect(out.forceCompacted).toEqual(['hot']);
    const [, payload] = injectMock.mock.calls[0] as unknown as [string, { mode: string; data: string }];
    expect(payload.mode).toBe('turn');
    expect(payload.data).toMatch(/^\/compact /);
  });

  it('does NOT force-compact when the flag is OFF (warn-only, byte-identical to pre-P-012)', async () => {
    estimateMock.mockResolvedValue(200_000);
    getFlagMock.mockResolvedValue(false);
    findLiveHostMock.mockReturnValue({ sock: '/tmp/hot.sock', caps: ['compact'] });
    hostSupportsMock.mockReturnValue(true);
    const out = await checkCompactionCompliance(fakeSql({ seeded }));
    expect(out.overLimit).toEqual(['hot']); // still detected + warned
    expect(out.forceCompacted).toEqual([]);
    expect(injectMock).not.toHaveBeenCalled();
  });

  it('no live psu-pty host ⇒ over-limit but not force-compacted (context-death + P-014 cover it)', async () => {
    estimateMock.mockResolvedValue(200_000);
    findLiveHostMock.mockReturnValue(null);
    const out = await checkCompactionCompliance(fakeSql({ seeded }));
    expect(out.overLimit).toEqual(['hot']);
    expect(out.forceCompacted).toEqual([]);
    expect(injectMock).not.toHaveBeenCalled();
  });

  it('injects ONCE per crossing (deduped across passes), and re-arms after recovery', async () => {
    findLiveHostMock.mockReturnValue({ sock: '/tmp/hot.sock', caps: ['compact'] });
    hostSupportsMock.mockReturnValue(true);
    // Pass 1: over limit ⇒ force-compact.
    estimateMock.mockResolvedValue(200_000);
    const p1 = await checkCompactionCompliance(fakeSql({ seeded }));
    expect(p1.forceCompacted).toEqual(['hot']);
    expect(injectMock).toHaveBeenCalledTimes(1);
    // Pass 2: STILL over limit but already forced ⇒ no duplicate inject.
    const p2 = await checkCompactionCompliance(fakeSql({ seeded }));
    expect(p2.forceCompacted).toEqual([]);
    expect(injectMock).toHaveBeenCalledTimes(1);
    // Pass 3: recovered (under limit) — clears the dedup.
    estimateMock.mockResolvedValue(40_000);
    await checkCompactionCompliance(fakeSql({ seeded }));
    // Pass 4: over limit AGAIN ⇒ re-fires.
    estimateMock.mockResolvedValue(200_000);
    const p4 = await checkCompactionCompliance(fakeSql({ seeded }));
    expect(p4.forceCompacted).toEqual(['hot']);
    expect(injectMock).toHaveBeenCalledTimes(2);
  });

  it('a failed inject is not recorded, so the next pass retries', async () => {
    estimateMock.mockResolvedValue(200_000);
    findLiveHostMock.mockReturnValue({ sock: '/tmp/hot.sock', caps: ['compact'] });
    hostSupportsMock.mockReturnValue(true);
    injectMock.mockResolvedValueOnce(false); // pass 1 inject fails
    const p1 = await checkCompactionCompliance(fakeSql({ seeded }));
    expect(p1.forceCompacted).toEqual([]);
    const p2 = await checkCompactionCompliance(fakeSql({ seeded }));
    expect(p2.forceCompacted).toEqual(['hot']); // retried, succeeded
    expect(injectMock).toHaveBeenCalledTimes(2);
  });

  it('over limit but inside the grace band ⇒ warned, NOT forced (owner grace 2026-07-04)', async () => {
    // sonnet = 200k window ⇒ forceAt = min(158k × 1.3 ≈ 205k, 200k − 10k) = 190k.
    specMock.mockResolvedValue('sonnet');
    estimateMock.mockResolvedValue(170_000); // over the 158k limit, under 190k
    findLiveHostMock.mockReturnValue({ sock: '/tmp/hot.sock', caps: ['compact'] });
    hostSupportsMock.mockReturnValue(true);
    const out = await checkCompactionCompliance(fakeSql({ seeded }));
    expect(out.overLimit).toEqual(['hot']); // the 100% warn band is unchanged
    expect(out.forceCompacted).toEqual([]);
    expect(injectMock).not.toHaveBeenCalled();
  });

  it('the window cap bites before 130% on a 200k-window session (forces at window − margin)', async () => {
    specMock.mockResolvedValue('sonnet'); // 200k window ⇒ cap 190k, though 1.3 × 158k ≈ 205k
    estimateMock.mockResolvedValue(195_000); // past the cap, still under 1.3 × limit
    findLiveHostMock.mockReturnValue({ sock: '/tmp/hot.sock', caps: ['compact'] });
    hostSupportsMock.mockReturnValue(true);
    const out = await checkCompactionCompliance(fakeSql({ seeded }));
    expect(out.forceCompacted).toEqual(['hot']);
    // The note names the bound that actually bound: the window cap, not "≈ 1.3 ×".
    const [, payload] = injectMock.mock.calls[0] as unknown as [string, { data: string }];
    expect(payload.data).toContain('model-window cap');
    expect(payload.data).toContain('binds below 1.3 × your soft limit of 158k');
    expect(payload.data).not.toContain('≈ 1.3 ×');
    // Cap (190k) > soft limit (158k) ⇒ a self-compact band still exists.
    expect(payload.data).toContain('anywhere between it and the FORCE threshold');
  });

  it('window cap AT/BELOW the soft limit ⇒ the note says there is NO self-compact band (owner 2026-07-05: "~190k ≈ 1.3 × 400k" was false math)', async () => {
    specMock.mockResolvedValue('sonnet'); // 200k window ⇒ cap 190k, BELOW the 400k soft limit
    estimateMock.mockResolvedValue(676_000); // the real 2026-07-05 incident numbers
    findLiveHostMock.mockReturnValue({ sock: '/tmp/big.sock', caps: ['compact'] });
    hostSupportsMock.mockReturnValue(true);
    const out = await checkCompactionCompliance(
      fakeSql({ seeded: [{ owner_id: 'big', owner_label: 'su · big', compaction_limit: 400_000 }] }),
    );
    expect(out.forceCompacted).toEqual(['big']);
    const [, payload] = injectMock.mock.calls[0] as unknown as [string, { data: string }];
    expect(payload.data).toContain('model-window cap');
    expect(payload.data).toContain('no self-compact band');
    expect(payload.data).toContain('config:set-compaction-limit');
    expect(payload.data).not.toContain('≈ 1.3 ×');
    expect(payload.data).not.toContain('anywhere between it and the FORCE threshold');
  });

  it('a [1m] session gets the full 130% band: forced at ≥390k on a 300k limit, not before', async () => {
    specMock.mockResolvedValue('sonnet[1m]'); // 1M window ⇒ forceAt = 300k × 1.3 = 390k
    estimateMock.mockImplementation(async (owner: string) => (owner === 'past' ? 400_000 : 350_000));
    findLiveHostMock.mockReturnValue({ sock: '/tmp/wide.sock', caps: ['compact'] });
    hostSupportsMock.mockReturnValue(true);
    const out = await checkCompactionCompliance(
      fakeSql({
        seeded: [
          { owner_id: 'warm', owner_label: 'su · warm', compaction_limit: 300_000 },
          { owner_id: 'past', owner_label: 'su · past', compaction_limit: 300_000 },
        ],
      }),
    );
    expect(out.overLimit).toEqual(['warm', 'past']); // both past 100%
    expect(out.forceCompacted).toEqual(['past']); // only the ≥130% one is forced
    // Fraction regime (wide window): the ratified "≈ 1.3 × soft limit" wording holds.
    const [, payload] = injectMock.mock.calls[0] as unknown as [string, { data: string }];
    expect(payload.data).toContain('≈ 1.3 × your configured soft limit of 300k');
  });

  it('unknown window ⇒ falls back to the overshoot-factor bound (limit × 1.2); a spawn-record [1m] spec restores the full band', async () => {
    specMock.mockResolvedValue(null); // fs/argv resolver blind (the fleet-bee case)
    estimateMock.mockResolvedValue(370_000); // 300k limit: ≥ 1.2 × 300k = 360k, < 1.3 × 300k = 390k
    findLiveHostMock.mockReturnValue({ sock: '/tmp/bee.sock', caps: ['compact'] });
    hostSupportsMock.mockReturnValue(true);
    const seeded300 = [{ owner_id: 'bee', owner_label: 'bee · b', compaction_limit: 300_000 }];
    // No spawn record ⇒ window unknown ⇒ conservative 360k bound ⇒ forced at 370k.
    const blind = await checkCompactionCompliance(fakeSql({ seeded: seeded300 }));
    expect(blind.forceCompacted).toEqual(['bee']);
    resetForceCompactedForTests();
    // Same session WITH a [1m] spawn record ⇒ real 1M window ⇒ full 390k band ⇒ not forced yet.
    const known = await checkCompactionCompliance(
      fakeSql({
        seeded: seeded300,
        spawnRecords: { bee: { model_spec: 'claude-fable-5[1m]', model_tier: null } },
      }),
    );
    expect(known.overLimit).toEqual(['bee']);
    expect(known.forceCompacted).toEqual([]);
  });
});

describe('live-config reach (agent-managed-compaction P-017)', () => {
  it('lowers a stale-above-cap limit on a running MEMBER to the current shaped default (300k)', async () => {
    estimateMock.mockResolvedValue(40_000); // under the new limit ⇒ no force
    specMock.mockResolvedValue('sonnet[1m]:high');
    const out = await checkCompactionCompliance(
      fakeSql({
        seeded: [
          { owner_id: 'stale', owner_label: 'su · stale', compaction_limit: 500_000, fleet_slug: 'backlog-clearance', fleet_role: 'member' },
        ],
      }),
    );
    expect(setLimitMock).toHaveBeenCalledWith('stale', 300_000);
    expect(out.relimited).toEqual([{ owner: 'stale', from: 500_000, to: 300_000 }]);
    expect(out.overLimit).toEqual([]); // 40k < the corrected 300k
  });

  it('a leader/solo stale limit is lowered to the leader cap (400k), not the member 300k', async () => {
    estimateMock.mockResolvedValue(40_000);
    specMock.mockResolvedValue('opus[1m]');
    const out = await checkCompactionCompliance(
      fakeSql({
        seeded: [
          { owner_id: 'lead', owner_label: 'su · lead', compaction_limit: 500_000, fleet_slug: 'backlog-clearance', fleet_role: 'leader' },
          { owner_id: 'solo', owner_label: 'su · solo', compaction_limit: 500_000, fleet_slug: null, fleet_role: null },
        ],
      }),
    );
    expect(setLimitMock).toHaveBeenCalledWith('lead', 400_000);
    expect(setLimitMock).toHaveBeenCalledWith('solo', 400_000);
    expect(out.relimited.map((r) => r.to)).toEqual([400_000, 400_000]);
  });

  it('does NOT touch a limit AT/BELOW the cap (respects a valid explicit override; no spec resolution)', async () => {
    estimateMock.mockResolvedValue(40_000);
    const out = await checkCompactionCompliance(
      fakeSql({
        seeded: [
          { owner_id: 'ok', owner_label: 'su · ok', compaction_limit: 300_000, fleet_slug: 'backlog-clearance', fleet_role: 'member' },
          { owner_id: 'atcap', owner_label: 'su · atcap', compaction_limit: 400_000, fleet_slug: null, fleet_role: null },
        ],
      }),
    );
    expect(out.relimited).toEqual([]);
    expect(setLimitMock).not.toHaveBeenCalled();
    expect(specMock).not.toHaveBeenCalled(); // cheap >cap gate skipped the spec resolution entirely
  });

  it('a re-limit CASCADES: a now-over session (est between old & new limit) force-compacts the same pass', async () => {
    estimateMock.mockResolvedValue(450_000); // < old 500k (was safe) but ≥ the new 300k
    specMock.mockResolvedValue('sonnet[1m]');
    findLiveHostMock.mockReturnValue({ sock: '/tmp/stale.sock', caps: ['compact'] });
    hostSupportsMock.mockReturnValue(true);
    const out = await checkCompactionCompliance(
      fakeSql({
        seeded: [
          { owner_id: 'stale', owner_label: 'su · stale', compaction_limit: 500_000, fleet_slug: 'backlog-clearance', fleet_role: 'member' },
        ],
      }),
    );
    expect(out.relimited).toEqual([{ owner: 'stale', from: 500_000, to: 300_000 }]);
    expect(out.overLimit).toEqual(['stale']); // 450k ≥ the corrected 300k
    expect(out.forceCompacted).toEqual(['stale']); // and the P-012 rung fires on the corrected limit
  });
});

describe('context-death detector (context-trimming-tiers P-019)', () => {
  it('a "Prompt is too long" transcript raises ONE blocker escalation, deduped across passes', async () => {
    resetContextDeathEscalationsForTests();
    estimateMock.mockResolvedValue(40_000);
    deathMock.mockImplementation(async (owner: string) => owner === 'dead');
    const seeded = [
      { owner_id: 'dead', owner_label: 'bee · dead', compaction_limit: 158_000 },
      { owner_id: 'fine', owner_label: 'bee · fine', compaction_limit: 158_000 },
    ];
    const out = await checkCompactionCompliance(fakeSql({ seeded }));
    expect(out.contextDeaths).toEqual(['dead']);
    expect(out.estimated).toEqual(['fine']); // the dead session is not estimated
    expect(openEscalationMock).toHaveBeenCalledTimes(1);
    const [identity, input] = openEscalationMock.mock.calls[0] as unknown as [
      { ownerId: string },
      { severity: string; summary: string },
    ];
    expect(identity.ownerId).toBe('compaction-watchdog');
    expect(input.severity).toBe('blocker');
    expect(input.summary).toContain('Prompt is too long');
    expect(input.summary).toContain('dead');
    // Second pass: still dead, but already escalated — no duplicate.
    const again = await checkCompactionCompliance(fakeSql({ seeded }));
    expect(again.contextDeaths).toEqual(['dead']);
    expect(openEscalationMock).toHaveBeenCalledTimes(1);
  });
});

describe('gauge cache + flag mirror wiring (agent-managed-compaction P-013)', () => {
  const seeded = [{ owner_id: 'hot', owner_label: 'su · hot', compaction_limit: 300_000 }];

  it('mirrors each estimated session into the in-process gauge cache', async () => {
    estimateMock.mockResolvedValue(210_000); // 70% of 300k
    expect(getContextUsage('hot')).toBeNull();
    const out = await checkCompactionCompliance(fakeSql({ seeded }));
    expect(out.estimated).toEqual(['hot']);
    expect(getContextUsage('hot')).toEqual({ tokens: 210_000, limit: 300_000 });
  });

  it('does not cache a session whose estimate is unresolvable (null)', async () => {
    estimateMock.mockResolvedValue(null);
    const out = await checkCompactionCompliance(fakeSql({ seeded }));
    expect(out.estimated).toEqual([]);
    expect(getContextUsage('hot')).toBeNull();
  });

  it('mirrors FLAGS.CONTEXT_GAUGE into the sync gauge switch each pass', async () => {
    estimateMock.mockResolvedValue(210_000);
    expect(isContextGaugeEnabled()).toBe(true); // default
    getFlagMock.mockResolvedValue(false); // gauge (and force) flag OFF this pass
    await checkCompactionCompliance(fakeSql({ seeded }));
    expect(isContextGaugeEnabled()).toBe(false);
    // Flag flipped back ON reaches the switch on the next sweep.
    getFlagMock.mockResolvedValue(true);
    await checkCompactionCompliance(fakeSql({ seeded }));
    expect(isContextGaugeEnabled()).toBe(true);
  });
});

describe('boot self-assert: dark telemetry (agent-managed-compaction P-018)', () => {
  const seeded = [{ owner_id: 'blind', owner_label: 'su · blind', compaction_limit: 300_000 }];

  // The genuinely-blind session this detector targets is a REAL launched session: it has an
  // adv_sessions row, so resolveSessionRef resolves to a non-null ref (agent 'claude'/unknown) —
  // only its transcript/estimate won't resolve. Default the mock to that so the 'blind' tests
  // model reality. WI-2917 made a NULL ref mean "synthetic principal, not a session" (exempt), so
  // without this default the blind tests would silently exercise the synthetic-exempt path instead.
  beforeEach(() => {
    resolveSessionRefMock.mockResolvedValue({ agent: 'claude', sessionId: 's-blind' });
  });

  it('escalates a session whose estimate never resolves — only after the grace sweeps, once (deduped)', async () => {
    estimateMock.mockResolvedValue(null); // context estimate never resolves ⇒ dark telemetry
    // Sweeps 1-2 are within the grace window (a normal boot reads null briefly) ⇒ no escalation.
    const p1 = await checkCompactionCompliance(fakeSql({ seeded }));
    const p2 = await checkCompactionCompliance(fakeSql({ seeded }));
    expect(p1.bootConfigAlerts).toEqual([]);
    expect(p2.bootConfigAlerts).toEqual([]);
    expect(p1.estimated).toEqual([]); // a null-estimate session is never cached/estimated
    expect(openEscalationMock).not.toHaveBeenCalled();
    // Sweep 3 crosses DARK_TELEMETRY_MAX_NULL_SWEEPS ⇒ one advisory escalation.
    const p3 = await checkCompactionCompliance(fakeSql({ seeded }));
    expect(p3.bootConfigAlerts).toEqual([{ owner: 'blind', kind: 'dark-telemetry', detail: '3 null sweeps' }]);
    expect(openEscalationMock).toHaveBeenCalledTimes(1);
    const [identity, input] = openEscalationMock.mock.calls[0] as unknown as [
      { ownerId: string },
      { severity: string; summary: string },
    ];
    expect(identity.ownerId).toBe('compaction-watchdog');
    expect(input.severity).toBe('advisory'); // self-clearing band, not a blocker
    expect(input.summary).toContain('DARK context telemetry');
    expect(input.summary).toContain('blind');
    // Sweep 4 still dark, but already escalated ⇒ alert still surfaced, escalation deduped.
    const p4 = await checkCompactionCompliance(fakeSql({ seeded }));
    expect(p4.bootConfigAlerts).toEqual([{ owner: 'blind', kind: 'dark-telemetry', detail: '4 null sweeps' }]);
    expect(openEscalationMock).toHaveBeenCalledTimes(1);
  });

  it('a resolved estimate clears the streak — a brief null run never reaches the escalation threshold', async () => {
    estimateMock.mockResolvedValue(null);
    await checkCompactionCompliance(fakeSql({ seeded })); // streak 1
    await checkCompactionCompliance(fakeSql({ seeded })); // streak 2
    estimateMock.mockResolvedValue(210_000);
    const p3 = await checkCompactionCompliance(fakeSql({ seeded })); // resolves ⇒ streak cleared
    expect(p3.estimated).toEqual(['blind']);
    estimateMock.mockResolvedValue(null);
    const p4 = await checkCompactionCompliance(fakeSql({ seeded })); // streak back to 1
    const p5 = await checkCompactionCompliance(fakeSql({ seeded })); // streak 2 — still under grace
    expect(p4.bootConfigAlerts).toEqual([]);
    expect(p5.bootConfigAlerts).toEqual([]);
    expect(openEscalationMock).not.toHaveBeenCalled(); // never 3 CONSECUTIVE nulls
  });

  it('a context-DEAD session (P-019) is not double-counted as dark telemetry', async () => {
    resetContextDeathEscalationsForTests();
    estimateMock.mockResolvedValue(null);
    deathMock.mockImplementation(async (owner: string) => owner === 'blind');
    // Even across the grace window, the death detector `continue`s before the dark-telemetry
    // counter, so it is escalated as a context-death (blocker), never as dark-telemetry.
    for (let i = 0; i < 4; i++) await checkCompactionCompliance(fakeSql({ seeded }));
    const out = await checkCompactionCompliance(fakeSql({ seeded }));
    expect(out.contextDeaths).toEqual(['blind']);
    expect(out.bootConfigAlerts).toEqual([]); // never reached the dark-telemetry counter
  });

  it('does NOT flag an OMP/Codex session — its null estimate is BY DESIGN, not blindness (WI-2910)', async () => {
    // OMP self-compacts natively and Codex has no compaction, so estimateContextTokensForOwner
    // returns null for those agents by design. The watchdog must NOT raise a dark-telemetry
    // alarm for them (they cannot silently overflow); only genuinely-blind Claude sessions do.
    const ompSeeded = [{ owner_id: 'omp-sess', owner_label: 'su · omp-sess', compaction_limit: 300_000 }];
    estimateMock.mockResolvedValue(null);
    resolveSessionRefMock.mockResolvedValue({ agent: 'omp', sessionId: 's-omp' });
    openEscalationMock.mockClear();
    let last;
    for (let i = 0; i < 5; i++) last = await checkCompactionCompliance(fakeSql({ seeded: ompSeeded }));
    expect(last!.bootConfigAlerts).toEqual([]); // never flagged despite 5 consecutive null sweeps
    expect(openEscalationMock).not.toHaveBeenCalled();

    // A codex session is likewise exempt.
    resolveSessionRefMock.mockResolvedValue({ agent: 'codex', sessionId: 's-codex' });
    const codexSeeded = [{ owner_id: 'codex-sess', owner_label: 'su · codex-sess', compaction_limit: 300_000 }];
    for (let i = 0; i < 4; i++) last = await checkCompactionCompliance(fakeSql({ seeded: codexSeeded }));
    expect(last!.bootConfigAlerts).toEqual([]);
    expect(openEscalationMock).not.toHaveBeenCalled();

    resolveSessionRefMock.mockResolvedValue(null); // reset default for any later tests
  });

  it('does NOT flag a SYNTHETIC principal (mcp-call / UI-client) — a null adv_sessions ref means it is not a launched session, not a blind one (WI-2917)', async () => {
    // A synthetic coord_presence principal — an MCP-call principal (`mcp-call-<pid>`) or a bare-UUID
    // UI client — carries a live heartbeat, so the seed pass hands it a compaction_limit. But it is
    // NOT a launched agent session: it has no adv_sessions row, so resolveSessionRef returns null and
    // there is no transcript to compact. Its null estimate is meaningless, not blindness, and must
    // never raise a dark-telemetry alarm (the ~2/3h mcp-call false positives observed 2026-07-05).
    const synthSeeded = [
      { owner_id: 'mcp-call-2666139', owner_label: 'su · mcp-call', compaction_limit: 300_000 },
    ];
    estimateMock.mockResolvedValue(null);
    resolveSessionRefMock.mockResolvedValue(null); // no adv_sessions row ⇒ not a real session
    openEscalationMock.mockClear();
    let last;
    for (let i = 0; i < 5; i++) last = await checkCompactionCompliance(fakeSql({ seeded: synthSeeded }));
    expect(last!.bootConfigAlerts).toEqual([]); // never flagged despite 5 consecutive null sweeps
    expect(openEscalationMock).not.toHaveBeenCalled();
  });
});
