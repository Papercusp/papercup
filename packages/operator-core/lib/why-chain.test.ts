import { describe, it, expect } from 'vitest';
import { computeWhyChain, recentFailingFiles, type WhyChainDeps } from './why-chain';
import type { GitPipelineSnapshot } from './git-pipeline-stats';
import type { DevDeployState } from './dev-deploy-state';
import type { AccountStatusRow } from './deployment/account-pool-store';

const deploy = (over: Partial<DevDeployState> = {}): DevDeployState =>
  ({
    integrationRoot: '/repo',
    releaseRoot: '/release',
    releaseRef: 'ready',
    integrationBranch: 'main',
    mainHead: null,
    ready: null,
    deployed: null,
    deployedAtMs: null,
    deployedBehindMain: 0,
    readyBehindMain: 0,
    deployedBehindReady: 0,
    readyAtMainHead: true,
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

function deps(over: Partial<WhyChainDeps> & { snap?: GitPipelineSnapshot; accounts?: AccountStatusRow[] } = {}): WhyChainDeps {
  return {
    loadSnapshot: async () => over.snap ?? snap(),
    loadAccounts: async () => over.accounts ?? accounts([{}, {}]),
    sql: over.sql ?? (async () => [] as unknown[]) as WhyChainDeps['sql'],
    ...over,
  };
}

describe('computeWhyChain (EI-7349)', () => {
  it('all-green: every stage ok, no root cause', async () => {
    const res = await computeWhyChain(deps());
    expect(res.stages.map((s) => s.status)).toEqual(['ok', 'ok', 'ok']);
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

  it('gate green but main ahead of ready: deploy stage degraded, gate stays ok', async () => {
    const res = await computeWhyChain(deps({ snap: snap({ deploy: { readyBehindMain: 4 } }) }));
    expect(res.stages[0].status).toBe('ok');
    expect(res.stages[1].status).toBe('degraded');
    expect(res.stages[1].reason).toContain('4 commit');
    expect(res.rootCause?.stage).toBe('deploy');
  });

  it('ready green + ahead of deployed: deploy stage degraded (not yet promoted)', async () => {
    const res = await computeWhyChain(deps({ snap: snap({ deploy: { deployedBehindReady: 2 } }) }));
    expect(res.stages[1].status).toBe('degraded');
    expect(res.stages[1].reason).toContain('not yet promoted');
  });

  it('all accounts unavailable: pool stage blocked', async () => {
    const res = await computeWhyChain(deps({ accounts: accounts([{ available: false }, { available: false }]) }));
    expect(res.stages[2].status).toBe('blocked');
    expect(res.stages[2].reason).toContain('unavailable');
    expect(res.rootCause?.stage).toBe('pool');
  });

  it('some accounts sustained-limited but others available: pool stage degraded, not blocked', async () => {
    const res = await computeWhyChain(
      deps({ accounts: accounts([{ sustainedlyLimited: true }, { available: true }]) }),
    );
    expect(res.stages[2].status).toBe('degraded');
    expect(res.stages[2].reason).toContain('1/2');
  });

  it('multiple non-ok stages: rootCause is the upstream-most (gate before deploy before pool)', async () => {
    const res = await computeWhyChain(
      deps({
        snap: snap({ gate: { consecutiveReds: 2 }, deploy: { readyBehindMain: 1 } }),
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
      sql: (async () => []) as unknown as WhyChainDeps['sql'],
    });
    expect(res.stages[2].reason).toContain('no accounts registered');
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
