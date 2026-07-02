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

const { estimateMock, specMock, setEstimateMock, setLimitMock, deathMock, openEscalationMock } =
  vi.hoisted(() => ({
    estimateMock: vi.fn(),
    specMock: vi.fn(),
    setEstimateMock: vi.fn(async () => {}),
    setLimitMock: vi.fn(async () => {}),
    deathMock: vi.fn(async (_owner: string) => false),
    openEscalationMock: vi.fn(async () => ({ msg_id: 'esc-1' })),
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
} from './compaction-compliance-watchdog';

/** Fake postgres tag: routes on the query text — the seed query selects
 *  `compaction_limit IS NULL`, the sweep `IS NOT NULL`, the honor leg reads
 *  `spawned_agents` keyed by the interpolated ownerId (first tag value). */
function fakeSql(opts: {
  unseeded?: Array<{ owner_id: string }>;
  seeded?: Array<{ owner_id: string; owner_label: string; compaction_limit: number }>;
  spawnRecords?: Record<string, { model_spec: string | null; model_tier: string | null }>;
}) {
  return ((strings: TemplateStringsArray, ...values: unknown[]) => {
    const q = strings.join(' ');
    if (q.includes('compaction_limit IS NULL')) return Promise.resolve(opts.unseeded ?? []);
    if (q.includes('compaction_limit IS NOT NULL')) return Promise.resolve(opts.seeded ?? []);
    if (q.includes('spawned_agents')) {
      const rec = opts.spawnRecords?.[String(values[0])];
      return Promise.resolve(rec ? [rec] : []);
    }
    return Promise.resolve([]);
  }) as never;
}

beforeEach(() => {
  vi.clearAllMocks();
  // The watchdog narrates seeds/over-limit crossings on the console by design;
  // silence it so vitest-fail-on-console doesn't flag the expected output.
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('checkCompactionCompliance seeding (context-trimming-tiers P-006)', () => {
  it('seeds the model-derived default for limit-less live sessions: fable [1m] → 500k cap, unresolvable → 158k', async () => {
    specMock.mockImplementation(async (owner: string) =>
      owner === 'su-wide' ? 'claude-fable-5[1m]' : null,
    );
    const out = await checkCompactionCompliance(
      fakeSql({ unseeded: [{ owner_id: 'su-wide' }, { owner_id: 'su-narrow' }] }),
    );
    expect(out.seeded).toEqual(['su-wide', 'su-narrow']);
    expect(setLimitMock).toHaveBeenCalledWith('su-wide', 500_000);
    expect(setLimitMock).toHaveBeenCalledWith('su-narrow', 158_000);
  });

  it('honors the spawn record: explicit tier limit > recorded spec default > resolver (D-006)', async () => {
    specMock.mockResolvedValue(null); // resolver would give the 158k fallback
    const out = await checkCompactionCompliance(
      fakeSql({
        unseeded: [
          { owner_id: 's-tier' }, // spawn record names tier "deep" → explicit 120k
          { owner_id: 's-spec' }, // spawn record carries only a fable [1m] spec → 500k cap
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
    expect(setLimitMock).toHaveBeenCalledWith('s-spec', 500_000);
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
