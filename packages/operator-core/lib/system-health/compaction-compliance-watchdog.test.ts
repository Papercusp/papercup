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
  FLAGS: { COMPACTION_WATCHDOG_FORCE_COMPACT: 'papercusp-compaction-watchdog-force-compact' },
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
} from './compaction-compliance-watchdog';

/** Fake postgres tag: routes on the query text — the seed query selects
 *  `compaction_limit IS NULL`, the sweep `IS NOT NULL`, the honor leg reads
 *  `spawned_agents` keyed by the interpolated ownerId (first tag value). */
function fakeSql(opts: {
  unseeded?: Array<{ owner_id: string; fleet_slug?: string | null; fleet_role?: string | null }>;
  seeded?: Array<{ owner_id: string; owner_label: string; compaction_limit: number }>;
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
    const [sock, payload] = injectMock.mock.calls[0] as unknown as [string, { mode: string; focus?: string }];
    expect(sock).toBe('/tmp/hot.sock');
    expect(payload.mode).toBe('compact');
    expect(payload.focus).toContain('identity block');
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
