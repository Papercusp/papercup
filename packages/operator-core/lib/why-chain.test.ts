import { describe, it, expect } from 'vitest';
import {
  computePipelineHealth,
  computeWhyChain,
  recentFailingFiles,
  type AdmissionSnapshotLite,
  type WhyChainDeps,
} from './why-chain';
import type { GitPipelineSnapshot } from './git-pipeline-stats';
import type { DevDeployState } from './dev-deploy-state';
import type { AccountStatusRow } from './deployment/account-pool-store';

const deploy = (over: Partial<DevDeployState> = {}): DevDeployState =>
  ({
    integrationRoot: '/repo',
    releaseRoot: '/release',
    releaseRef: 'ready',
    integrationBranch: 'main',
    stagingHead: null,
    ready: null,
    deployed: null,
    deployedAtMs: null,
    deployedBehindStaging: 0,
    greenPinBehindStaging: 0,
    deployedBehindGreenPin: 0,
    greenPinAtStagingHead: true,
    errors: [],
    ...over,
  }) as DevDeployState;

const snap = (over: {
  gate?: Partial<GitPipelineSnapshot['gate']>;
  deploy?: Partial<DevDeployState>;
  openConflict?: GitPipelineSnapshot['openConflict'];
} = {}): GitPipelineSnapshot =>
  ({
    gate: {
      consecutiveReds: 0,
      lastGreenAtMs: 1,
      firstRedAtMs: null,
      stalled: false,
      lastFiredAtMs: 1,
      fireStale: false,
      fireStaleReason: null,
      lastFixerStatus: null,
      lastFixerAtMs: null,
      lastFixerCandidate: null,
      flakyWorkspaces: [],
      ...over.gate,
    },
    deploy: deploy(over.deploy),
    openConflict: over.openConflict ?? null,
  }) as GitPipelineSnapshot;

const accounts = (rows: Partial<AccountStatusRow>[] = []): AccountStatusRow[] =>
  rows.map((r, i) => ({
    id: `acct-${i}`,
    provider: 'claude',
    credentialRef: 'ref',
    boundTo: [],
    available: true,
    usageWalled: false,
    sustainedlyLimited: false,
    rate: {} as AccountStatusRow['rate'],
    liveBuckets: [],
    ...r,
  })) as AccountStatusRow[];

/** A HEALTHY gateway admission snapshot (EI-10880) — the default so existing cases stay focused. */
const admission = (over: Partial<AdmissionSnapshotLite> = {}): AdmissionSnapshotLite => ({
  running: 2,
  queued: 0,
  maxConcurrent: 24,
  tier1Reserve: 4,
  byTier: [],
  aimdEffective: 24,
  aimdCap: 24,
  ...over,
});

function deps(over: Partial<WhyChainDeps> & { snap?: GitPipelineSnapshot; accounts?: AccountStatusRow[] } = {}): WhyChainDeps {
  return {
    loadSnapshot: async () => over.snap ?? snap(),
    loadAccounts: async () => over.accounts ?? accounts([{}, {}]),
    loadAdmission: over.loadAdmission ?? (async () => admission()),
    sql: over.sql ?? (async () => [] as unknown[]) as WhyChainDeps['sql'],
    ...over,
  };
}

describe('computeWhyChain (EI-7349)', () => {
  it('all-green: every stage ok, no root cause', async () => {
    const res = await computeWhyChain(deps());
    expect(res.stages.map((s) => s.status)).toEqual(['ok', 'ok', 'ok', 'ok']);
    expect(res.rootCause).toBeNull();
    expect(res.summary).toContain('nominal');
  });

  it('gate red but not stalled: degraded, cites recent failing files', async () => {
    const res = await computeWhyChain(
      deps({
        snap: snap({ gate: { consecutiveReds: 3 } }),
        sql: (async () => [
          { file_path: 'apps/x/y.test.ts', finished_at: new Date().toISOString() },
        ]) as unknown as WhyChainDeps['sql'],
      }),
    );
    expect(res.stages[0].status).toBe('degraded');
    expect(res.stages[0].reason).toContain('3 consecutive');
    expect(res.stages[0].reason).toContain('apps/x/y.test.ts');
    expect(res.rootCause?.stage).toBe('gate');
  });

  it('gate stalled: blocked root cause', async () => {
    const res = await computeWhyChain(deps({ snap: snap({ gate: { consecutiveReds: 20, stalled: true } }) }));
    expect(res.rootCause?.stage).toBe('gate');
    expect(res.rootCause?.status).toBe('blocked');
    expect(res.summary).toContain('ROOT CAUSE: gate');
  });

  it('gate wedged (fireStale) takes priority over a plain red streak', async () => {
    const res = await computeWhyChain(
      deps({ snap: snap({ gate: { fireStale: true, fireStaleReason: 'no fire in 90m' } }) }),
    );
    expect(res.stages[0].reason).toContain('WEDGED');
    expect(res.stages[0].reason).toContain('no fire in 90m');
  });

  it('open merge conflict blocks the gate stage regardless of red streak', async () => {
    const res = await computeWhyChain(
      deps({
        snap: snap({ openConflict: { scopes: ['libs/foo'], conflicts: [], emittedAtMs: Date.now() } }),
      }),
    );
    expect(res.stages[0].status).toBe('blocked');
    expect(res.stages[0].reason).toContain('merge conflict');
    expect(res.stages[0].reason).toContain('libs/foo');
  });

  // ── EI-11012: the staging buffer is NOT a deploy fault ────────────────────
  // These three pin the fix. The deploy stage MUST stay ok while staging runs ahead of the
  // green pin (the normal steady state: git-sync commits staging continuously; the gate FFs
  // main only hourly + only when green). The old behaviour degraded on it, which made the
  // deploy stage permanently degraded — and since rootCause is the FIRST non-ok stage, that
  // shadowed every real downstream cause.
  it('staging ahead of the green pin (the staging buffer) does NOT degrade the deploy stage', async () => {
    const res = await computeWhyChain(
      deps({ snap: snap({ deploy: { greenPinBehindStaging: 10, deployedBehindGreenPin: 0 } }) }),
    );
    expect(res.stages[1].status).toBe('ok');
    expect(res.rootCause).toBeNull();
  });

  it('a staging buffer is REPORTED (as normal) in the ok reason, not hidden', async () => {
    const res = await computeWhyChain(
      deps({ snap: snap({ deploy: { greenPinBehindStaging: 10, deployedBehindGreenPin: 0 } }) }),
    );
    expect(res.stages[1].reason).toContain('10 commit');
    expect(res.stages[1].reason).toContain('normal');
  });

  it('a staging buffer never shadows a real downstream cause (rootCause reaches the pool)', async () => {
    const res = await computeWhyChain(
      deps({
        snap: snap({ deploy: { greenPinBehindStaging: 10, deployedBehindGreenPin: 0 } }),
        accounts: accounts([{ available: false }, { available: false }]),
      }),
    );
    expect(res.stages[1].status).toBe('ok');
    expect(res.rootCause?.stage).toBe('pool');
  });

  it('green pin ahead of what is live on :3070: deploy stage degraded (the REAL deploy gap)', async () => {
    const res = await computeWhyChain(deps({ snap: snap({ deploy: { deployedBehindGreenPin: 2 } }) }));
    expect(res.stages[1].status).toBe('degraded');
    expect(res.stages[1].reason).toContain('2 commit');
    expect(res.stages[1].reason).toContain('not yet deployed');
    expect(res.rootCause?.stage).toBe('deploy');
  });

  it('all accounts unavailable: pool stage blocked', async () => {
    const res = await computeWhyChain(deps({ accounts: accounts([{ available: false }, { available: false }]) }));
    expect(res.stages[3].status).toBe('blocked');
    expect(res.stages[3].reason).toContain('unavailable');
    expect(res.rootCause?.stage).toBe('pool');
  });

  it('some accounts sustained-limited but others available: pool stage degraded, not blocked', async () => {
    const res = await computeWhyChain(
      deps({ accounts: accounts([{ sustainedlyLimited: true }, { available: true }]) }),
    );
    expect(res.stages[3].status).toBe('degraded');
    expect(res.stages[3].reason).toContain('1/2');
  });

  it('multiple non-ok stages: rootCause is the upstream-most (gate before deploy before pool)', async () => {
    const res = await computeWhyChain(
      deps({
        // deployedBehindGreenPin (NOT the staging buffer) is what makes the deploy stage
        // non-ok since EI-11012 — using greenPinBehindStaging here would leave deploy ok and
        // silently stop exercising the gate-before-deploy ordering this test exists to pin.
        snap: snap({ gate: { consecutiveReds: 2 }, deploy: { deployedBehindGreenPin: 1 } }),
        accounts: accounts([{ available: false }]),
      }),
    );
    expect(res.rootCause?.stage).toBe('gate');
  });

  it('accounts load failure degrades to empty pool (never throws)', async () => {
    const res = await computeWhyChain({
      loadSnapshot: async () => snap(),
      loadAccounts: async () => {
        throw new Error('boom');
      },
      // MUST inject: without it the default loader would fetch the REAL gateway on :8788 from a unit test.
      loadAdmission: async () => admission(),
      sql: (async () => []) as unknown as WhyChainDeps['sql'],
    });
    expect(res.stages[3].reason).toContain('no accounts registered');
  });

  // ── ADMISSION stage (EI-10880) — the WI-4541 class ──────────────────────────────────────────
  // The whole point: gate/deploy/pool can ALL be green while the fleet is crawling, because the
  // bottleneck is the queue itself. These pin the stage that makes that visible.

  it('WI-4541 repro: QUEUED while slots sit IDLE ⇒ admission BLOCKED and named ROOT CAUSE, even with a healthy pool', async () => {
    // The exact live shape: 12 slots, reserve 2, 1 running, 3 queued — 9 shared slots idle while
    // work waits, because the bottom tier's cap was shed to 1. Gate/deploy/pool are all fine.
    const res = await computeWhyChain(
      deps({
        loadAdmission: async () =>
          admission({
            running: 1,
            queued: 3,
            maxConcurrent: 12,
            tier1Reserve: 2,
            byTier: [
              { tier: 1, cap: 24, inFlight: 0, queued: 0 },
              { tier: 5, cap: 1, inFlight: 1, queued: 3 },
            ],
            aimdEffective: 12,
            aimdCap: 24,
          }),
      }),
    );
    const adm = res.stages[2];
    expect(adm.stage).toBe('admission');
    expect(adm.status).toBe('blocked');
    expect(adm.reason).toContain('QUEUED');
    expect(adm.reason).toContain('IDLE');
    expect(adm.reason).toContain('ADMISSION-PATH DEFECT');
    expect(adm.reason).toContain('tier 5');
    // The whole failure this stage exists to prevent: the pool is HEALTHY, so a gate/deploy/pool
    // chain would have reported "all nominal" and named no root cause at all.
    expect(res.stages[3].status).toBe('ok');
    expect(res.rootCause?.stage).toBe('admission');
    expect(res.summary).toContain('ROOT CAUSE: admission');
  });

  it('admission does NOT false-alarm when the idle slots are only the reserved tier-1 floor', async () => {
    // running 10, max 12, reserve 2 ⇒ freeShared = 0. Two slots ARE idle, but they are HELD for the
    // interactive lane on purpose. Queued work here is correct behavior, not a defect.
    const res = await computeWhyChain(
      deps({ loadAdmission: async () => admission({ running: 10, queued: 5, maxConcurrent: 12, tier1Reserve: 2 }) }),
    );
    expect(res.stages[2].status).toBe('degraded');
    expect(res.stages[2].reason).toContain('genuinely FULL');
    expect(res.stages[2].reason).not.toContain('DEFECT');
  });

  it('a deep AIMD shrink is flagged degraded (the WI-4541 precondition) even with nothing queued', async () => {
    const res = await computeWhyChain(
      deps({ loadAdmission: async () => admission({ running: 1, queued: 0, aimdEffective: 6, aimdCap: 24 }) }),
    );
    expect(res.stages[2].status).toBe('degraded');
    expect(res.stages[2].reason).toContain('6/24');
  });

  it('gateway unreachable ⇒ admission degraded, chain still returns (never throws)', async () => {
    const res = await computeWhyChain(deps({ loadAdmission: async () => null }));
    expect(res.stages[2].status).toBe('degraded');
    expect(res.stages[2].reason).toContain('unreachable');
  });

  it('a BLOCKED pool still wins root cause when admission is healthy (no over-claiming)', async () => {
    const res = await computeWhyChain(deps({ accounts: accounts([{ available: false }]) }));
    expect(res.stages[2].status).toBe('ok');
    expect(res.rootCause?.stage).toBe('pool');
  });

  it('recentFailingFiles degrades to [] on a query error instead of throwing', async () => {
    const files = await recentFailingFiles({
      sql: (async () => {
        throw new Error('no such table');
      }) as unknown as WhyChainDeps['sql'],
    });
    expect(files).toEqual([]);
  });
});

/**
 * WI-4533 — the gate's COLOUR, and the two things it must refuse to say.
 *
 * The chain is what an agent reads to decide what to go fix, so a wrong colour here does not just
 * misinform: it DISPATCHES someone. Both silences below are load-bearing.
 */
const withRoutines = (s: GitPipelineSnapshot, hasGate = true): GitPipelineSnapshot =>
  ({
    ...s,
    routines: {
      gitSync: null,
      greenCheckpoint: hasGate ? ({ name: 'green-checkpoint', active: true } as unknown) : null,
      releaseTrigger: null,
    },
  }) as GitPipelineSnapshot;

/** A gate whose recorded RED is stale (WI-4489): the streak is real, the verdict is superseded. */
const staleRed = (reds = 4) =>
  withRoutines(
    snap({
      gate: {
        consecutiveReds: reds,
        verdictStale: true,
        verdictStaleReason: 'the release pin advanced past the pin this red was recorded against',
      } as Partial<GitPipelineSnapshot['gate']>,
    }),
  );

describe('WI-4533 — gateLabel + the stale-verdict rule', () => {
  it('a STALE red is NOT reported as red — it is an UNKNOWN colour', async () => {
    const res = await computeWhyChain(deps({ snap: staleRed() }));
    const gate = res.stages[0];
    expect(gate.status).toBe('degraded'); // not 'blocked' — we do NOT know it is broken
    expect(gate.reason).toContain('STALE');
    expect(gate.reason).toContain('UNKNOWN');
    // The precise regression WI-4489 was filed for: a starved gate_health blob reported 4 reds
    // while every real run was green, and the chain's confident RED dispatched the release-fixer.
    expect(gate.reason).not.toMatch(/gate red \(/);
  });

  it('a stale verdict names NO failing tests — naming them is what re-arms the phantom dispatch', async () => {
    const res = await computeWhyChain(
      deps({
        snap: staleRed(),
        sql: (async () => [{ file_path: 'lib/innocent.test.ts', finished_at: new Date().toISOString() }]) as unknown as WhyChainDeps['sql'],
      }),
    );
    // The file is in recentFailingFiles (it really did fail in the window) — but the STALE gate
    // stage must not hand it to anyone as "the thing to go fix".
    expect(res.recentFailingFiles).toContain('lib/innocent.test.ts');
    expect(res.stages[0].reason).not.toContain('innocent.test.ts');
  });

  it('a FRESH red still reports red, with its failing files (the stale rule must not muzzle a real red)', async () => {
    const res = await computeWhyChain(
      deps({
        snap: withRoutines(snap({ gate: { consecutiveReds: 2 } })),
        sql: (async () => [{ file_path: 'lib/broken.test.ts', finished_at: new Date().toISOString() }]) as unknown as WhyChainDeps['sql'],
      }),
    );
    expect(res.stages[0].status).toBe('degraded');
    expect(res.stages[0].reason).toContain('gate red (2 consecutive');
    expect(res.stages[0].reason).toContain('lib/broken.test.ts');
  });

  it('a WEDGED (non-firing) gate outranks a stale verdict — the routine not running is the bigger fact', async () => {
    const s = withRoutines(
      snap({ gate: { consecutiveReds: 3, verdictStale: true, fireStale: true, fireStaleReason: 'no fire in 6h' } as Partial<GitPipelineSnapshot['gate']> }),
    );
    const res = await computeWhyChain(deps({ snap: s }));
    expect(res.stages[0].status).toBe('blocked');
    expect(res.stages[0].reason).toContain('WEDGED');
  });
});

describe('WI-4533 — computePipelineHealth (the coord:orient fold)', () => {
  it('reports known:false for a harness with NO green-checkpoint routine (never a false green)', async () => {
    const res = await computePipelineHealth(deps({ snap: withRoutines(snap(), false) }));
    // A harness that runs no checkpoint has a zero-red gate_health by default — which would render
    // as a confident "green" to a waking agent. A detector with no data must say UNKNOWN.
    expect(res.known).toBe(false);
    expect(res.rootCause).toBeNull();
  });

  it('a GREEN gate pays for NO failing-files query (the hot-path cost discipline)', async () => {
    let queried = 0;
    const res = await computePipelineHealth(
      deps({
        snap: withRoutines(snap()),
        sql: (async () => {
          queried++;
          return [];
        }) as unknown as WhyChainDeps['sql'],
      }),
    );
    expect(res.gateLabel).toBe('green');
    expect(res.known).toBe(true);
    expect(queried).toBe(0); // no red ⇒ no query. This leg rides orient; it must be ~free when healthy.
  });

  it('a RED gate fetches its failing files and names the gate as root cause', async () => {
    const res = await computePipelineHealth(
      deps({
        snap: withRoutines(snap({ gate: { consecutiveReds: 1 } })),
        sql: (async () => [{ file_path: 'lib/red.test.ts', finished_at: new Date().toISOString() }]) as unknown as WhyChainDeps['sql'],
      }),
    );
    expect(res.gateLabel).toBe('red');
    expect(res.recentFailingFiles).toEqual(['lib/red.test.ts']);
    expect(res.rootCause?.stage).toBe('gate');
  });

  it('carries the DEPLOY position — a green gate whose tip is not live is still not-shipped', async () => {
    const res = await computePipelineHealth(
      deps({ snap: withRoutines(snap({ deploy: { greenPinBehindStaging: 49 } })) }),
    );
    expect(res.gateLabel).toBe('green');
    expect(res.greenPinBehindStaging).toBe(49);
    expect(res.rootCause?.stage).toBe('deploy'); // the gate is fine; the promotion is not
  });

  it('labels a stale verdict distinctly, so the orient fold can refuse to name its tests', async () => {
    const res = await computePipelineHealth(deps({ snap: staleRed(2) }));
    expect(res.gateLabel).toBe('stale-verdict');
    expect(res.verdictStale).toBe(true);
  });
});

/**
 * WI-4533 — WHAT is red. The gate records the tests that redded it (`gate_health.failingTests`);
 * nothing surfaced them, so every consumer fell back to a 2h `test_runs` scan that answers a
 * DIFFERENT question. Live on a red gate the scan returned nothing while the gate's own record held
 * all four culprits: the chain said "gate red" and named no one.
 */
describe('WI-4533 — namedFailures: the gate\'s own verdict beats the time-window proxy', () => {
  const redNaming = (tests: string[]) =>
    withRoutines(snap({ gate: { consecutiveReds: 1, failingTests: tests } as Partial<GitPipelineSnapshot['gate']> }));

  it('names the tests the GATE named, and does not even run the proxy scan', async () => {
    let scanned = 0;
    const res = await computePipelineHealth(
      deps({
        snap: redNaming(['lib/a.test.ts', 'lib/b.test.ts']),
        sql: (async () => {
          scanned++;
          return [];
        }) as unknown as WhyChainDeps['sql'],
      }),
    );
    expect(res.recentFailingFiles).toEqual(['lib/a.test.ts', 'lib/b.test.ts']);
    expect(res.gate.reason).toContain('lib/a.test.ts');
    expect(scanned).toBe(0); // first-hand evidence in hand ⇒ no proxy query at all
  });

  it('falls back to the proxy scan for an OLD blob that never recorded failingTests', async () => {
    // `undefined`, not `[]` — the pre-WI-4533 shape. This is the case a `?.length === 0` guard
    // would have silently skipped, leaving exactly the oldest gates with no names at all.
    const old = withRoutines(snap({ gate: { consecutiveReds: 1 } }));
    delete (old.gate as { failingTests?: unknown }).failingTests;
    const res = await computePipelineHealth(
      deps({
        snap: old,
        sql: (async () => [{ file_path: 'lib/proxy.test.ts', finished_at: new Date().toISOString() }]) as unknown as WhyChainDeps['sql'],
      }),
    );
    expect(res.recentFailingFiles).toEqual(['lib/proxy.test.ts']);
  });

  it('a STALE verdict still names NOBODY, even though it has failingTests recorded', async () => {
    // The strongest case for the stale rule: the blob is FULL of names, and they are exactly the
    // names a phantom dispatch would chase (WI-4489). The gate's colour is unknown ⇒ say nothing.
    const s = withRoutines(
      snap({
        gate: {
          consecutiveReds: 4,
          verdictStale: true,
          verdictStaleReason: 'the release pin advanced past this red',
          failingTests: ['lib/innocent.test.ts', 'lib/also-innocent.test.ts'],
        } as Partial<GitPipelineSnapshot['gate']>,
      }),
    );
    const res = await computeWhyChain(deps({ snap: s }));
    expect(res.stages[0].reason).toContain('STALE');
    expect(res.stages[0].reason).not.toContain('innocent');
  });
});
