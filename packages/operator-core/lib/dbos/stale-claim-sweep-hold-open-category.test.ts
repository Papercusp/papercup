/**
 * stale-claim-sweep-hold-open-category.test.ts — EI-18183171615661851.
 *
 * The `stale-claim-sweep` tick's hold-open-sweep broadcast (WI-4531, in the
 * `to: ['*']` sendMessage call inside in-process-periodic.ts) went out with NO
 * `category`, unlike every sibling system-routine broadcast (service-health,
 * doc-drift, agent-governor, resource-locks — see coord:inbox's
 * AMBIENT_CATEGORIES). Because the message differs (a different feature_id) on
 * every fire, coord:inbox's exact-text `coalesceRepeatedBroadcasts` can never
 * fold repeats — and with no `category`, `isAmbientBroadcast` couldn't
 * default-exclude them either. On a fleet where holds expire in a trickle, this
 * produced a run of near-identical "lifted N EXPIRED hold(s)" broadcasts (5 in
 * one wake's digest was the reported case) burying real signal.
 *
 * Regression: assert the tick tags this broadcast `category: 'service-health'`
 * — the same category the sibling system routines use — so it is silenced by
 * coord:inbox's default ambient exclusion (still visible via include_ambient).
 * Every OTHER reclaim leg in the tick is mocked to a no-op release set so this
 * test isolates the hold-open broadcast path alone.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { sendMessage } = vi.hoisted(() => ({
  sendMessage: vi.fn(async (_identity: unknown, _opts: Record<string, unknown>) => ({})),
}));

vi.mock('../agent-tools/coordination/messages', () => ({ sendMessage }));

// A minimal callable tagged-template stub — the P-017 lease-backstop leg (not
// under test here) calls `sql\`...\`` directly rather than through a mocked
// reclaim function; returning [] keeps it a real no-op instead of a caught
// "sql is not a function" exception (non-fatal, but it logs a console.warn
// that would otherwise trip this repo's fail-on-console test setup).
const sqlStub = Object.assign(async () => [], {}) as unknown as (
  strings: TemplateStringsArray,
  ...values: unknown[]
) => Promise<unknown[]>;
vi.mock('@papercusp/db-org', async (orig) => ({
  ...(await orig<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({ sql: sqlStub }),
}));

vi.mock('@papercusp/flags', () => ({ FLAGS: { RECLAIM_STALLED: 'RECLAIM_STALLED' } }));
vi.mock('@papercusp/flags/server', () => ({ getFlag: async () => false }));

vi.mock('../coord-liveness-config', () => ({
  readCoordLivenessConfig: async () => ({
    reclaimGraceMs: 10 * 60_000,
    reclaimParkedGraceMs: 30 * 60_000,
    reclaimRequeueCap: 3,
    holdOpenGraceMs: 2 * 3600_000,
    assignmentReclaimGraceMs: 3600_000,
  }),
}));

// PARTIAL mock (importOriginal) — stale-claim-sweep's tick() DESTRUCTURES every export
// it uses in ONE statement, up front, OUTSIDE the per-reaper try/catch. So a factory that
// omits an export production later adds doesn't just skip that leg — it throws
// "No <x> export is defined on the mock" and fails the WHOLE tick, in a test that has
// nothing to do with the new export (EI-18715782165335169: WI-6039 added
// reconcileStrandedWipWorkItems and this factory went stale). Spreading the real module
// keeps that drift from recurring; the three async DB-touching exports are still stubbed
// explicitly below. Every remaining export is a constant or a pure SQL-fragment builder.
vi.mock('../work-items-stale-claims', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../work-items-stale-claims')>()),
  reclaimStaleWorkItemClaims: async () => ({ released: [] }),
  reclaimStaleIssueClaims: async () => ({ released: [], orphanLeasesCleared: 0 }),
  reconcileStrandedWipWorkItems: async () => [],
}));

vi.mock('../dead-owner-control-sweep', () => ({
  sweepDeadOwnerControlState: async () => ({ owners: [], loopsTerminated: 0, holdsLifted: 0 }),
}));

// The one reaper this test exercises for real output: one NON-terminal expired
// hold, so the broadcast branch (`starved.length > 0`) actually fires.
const oneStarvedHold = {
  workspace_id: 'ws-1',
  harness_slug: 'papercusp',
  feature_id: 'EI-1',
  item_kind: 'issue',
  status: 'open',
  former_holder: 'su-dead',
  former_reason: 'long-running gate',
  held_open_at: new Date().toISOString(),
};
vi.mock('../work-items-hold-open', () => ({
  reclaimStaleHoldOpens: async () => ({ expired: [oneStarvedHold] }),
}));

vi.mock('../plan-items/stale-claims', () => ({
  reclaimExpiredPlanItemClaims: async () => ({ released: [] }),
  reclaimStaleDeadHolderPlanItemAssignments: async () => ({ released: [] }),
  reclaimStalledLivePlanItemAssignments: async () => ({ released: [] }),
}));

vi.mock('../work-queue-health', () => ({
  recordSweepRun: async () => {},
  STALE_CLAIM_SWEEP_NAME: 'stale-claim-sweep',
}));

import { buildDefaultChecks } from './in-process-periodic';

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('stale-claim-sweep tick — hold-open-sweep broadcast category (EI-18183171615661851)', () => {
  it('tags the hold-open-sweep "*" broadcast category: service-health', async () => {
    // The tick's own [hold-open] summary line (informational, not under test
    // here) is expected given the one starved hold this test manufactures.
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const tick = buildDefaultChecks().find((c) => c.name === 'stale-claim-sweep')!.tick;
    await tick();
    warnSpy.mockRestore();

    expect(sendMessage).toHaveBeenCalledTimes(1);
    const [identity, opts] = sendMessage.mock.calls[0] as [
      { ownerId: string },
      { to: string[]; summary: string; category?: string },
    ];
    expect(identity.ownerId).toBe('hold-open-sweep');
    expect(opts.to).toEqual(['*']);
    expect(opts.summary).toContain('hold-open sweep');
    // The regression: this must carry an ambient category so coord:inbox's
    // isAmbientBroadcast/coalesceRepeatedBroadcasts can default-exclude repeats
    // of it instead of every distinct-feature_id fire piling up as visible spam.
    expect(opts.category).toBe('service-health');
  });
});
