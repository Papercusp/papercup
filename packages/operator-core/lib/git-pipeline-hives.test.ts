/**
 * git-pipeline-hives — the per-hive rows behind the /admin/git surface (P-014). The registry,
 * the per-hive resolver, and the snapshot are mocked; revListCount is real but resolves to
 * null because the fixture roots don't exist on disk (best-effort gap). No PG, no git.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Env = {
  enabled: boolean;
  isOperatorHome: boolean;
  hasDeploy: boolean;
  greenCmd?: string;
  greenCmdOverridden?: boolean;
  reason?: string;
  env: Record<string, string>;
};

let projects: Array<{ slug: string }>;
let envBySlug: Record<string, Env | 'THROW'>;
let snapBySlug: Record<string, unknown>;

function disabledEnv(reason = 'not_found'): Env {
  return { enabled: false, isOperatorHome: false, hasDeploy: false, reason, env: {} };
}
function enabledEnv(slug: string, over: Partial<Env> = {}): Env {
  return {
    enabled: true,
    isOperatorHome: false,
    hasDeploy: false,
    greenCmd: 'npm run test:affected',
    greenCmdOverridden: false,
    env: {
      PAPERCUSP_INTEGRATION_ROOT: `/tmp/does-not-exist/${slug}`,
      PAPERCUSP_INTEGRATION_BRANCH: 'staging',
      PAPERCUSP_RELEASE_REF: 'main',
    },
    ...over,
  };
}
function snap(over: Record<string, unknown> = {}) {
  return {
    gate: { consecutiveReds: 0, lastGreenAtMs: 123, stalled: false },
    recent: [],
    routines: { greenCheckpoint: { active: true } },
    ...over,
  };
}

beforeEach(() => {
  vi.resetModules();
  projects = [];
  envBySlug = {};
  snapBySlug = {};
  vi.doMock('./harness-registry', () => ({ loadHarnessRegistry: async () => ({ projects }) }));
  vi.doMock('./harness/routines/hive-release-env', () => ({
    resolveHiveReleaseEnv: async (slug: string) => {
      const e = envBySlug[slug];
      if (e === 'THROW') throw new Error('boom');
      return e ?? disabledEnv();
    },
  }));
  vi.doMock('./git-pipeline-stats', () => ({
    gitPipelineSnapshot: async (slug: string) => snapBySlug[slug] ?? snap(),
  }));
});
afterEach(() => {
  vi.doUnmock('./harness-registry');
  vi.doUnmock('./harness/routines/hive-release-env');
  vi.doUnmock('./git-pipeline-stats');
});

describe('gitPipelineHiveRows', () => {
  it('returns only GATED, NON-operator-home hives, sorted by slug', async () => {
    projects = [{ slug: 'b-hive' }, { slug: 'papercusp' }, { slug: 'a-hive' }, { slug: 'work-hive' }];
    envBySlug = {
      'a-hive': enabledEnv('a-hive'),
      'b-hive': enabledEnv('b-hive'),
      papercusp: enabledEnv('papercusp', { isOperatorHome: true }), // home → excluded
      'work-hive': disabledEnv('gate_disabled'), // non-coding → excluded
    };
    const { gitPipelineHiveRows } = await import('./git-pipeline-hives');
    const rows = await gitPipelineHiveRows('default');
    expect(rows.map((r) => r.slug)).toEqual(['a-hive', 'b-hive']);
  });

  it('projects the resolved greenCmd, override flag, branches, gate, last green sha + last deploy', async () => {
    projects = [{ slug: 'c-hive' }];
    envBySlug = {
      'c-hive': enabledEnv('c-hive', { greenCmd: 'npm run gate:custom', greenCmdOverridden: true, hasDeploy: true }),
    };
    snapBySlug = {
      'c-hive': snap({
        gate: { consecutiveReds: 2, lastGreenAtMs: 999, stalled: false },
        recent: [
          { id: '1', kind: 'green_checkpoint', status: 'advanced', detail: { candidate: 'abcdef123456', advancedTo: 'beef00112233' }, createdAtMs: 100 },
          { id: '2', kind: 'deploy', status: 'ok', detail: {}, createdAtMs: 200 },
        ],
      }),
    };
    const { gitPipelineHiveRows } = await import('./git-pipeline-hives');
    const [row] = await gitPipelineHiveRows('default');
    expect(row.greenCmd).toBe('npm run gate:custom');
    expect(row.greenCmdOverridden).toBe(true);
    expect(row.integrationBranch).toBe('staging');
    expect(row.releaseRef).toBe('main');
    expect(row.hasDeploy).toBe(true);
    expect(row.greenCheckpointActive).toBe(true);
    expect(row.gateStatus).toBe('held'); // consecutiveReds > 0
    expect(row.consecutiveReds).toBe(2);
    expect(row.lastGreenSha).toBe('beef00112233'); // advancedTo (partial advance) wins, 12-char
    expect(row.lastDeployStatus).toBe('ok');
    expect(row.lastDeployAtMs).toBe(200);
    expect(row.stagingMainGap).toBeNull(); // fixture root doesn't exist → best-effort null
  });

  it('gate status: stalled > held > green > unknown', async () => {
    projects = [{ slug: 's' }, { slug: 'g' }, { slug: 'u' }];
    envBySlug = { s: enabledEnv('s'), g: enabledEnv('g'), u: enabledEnv('u') };
    snapBySlug = {
      s: snap({ gate: { consecutiveReds: 3, lastGreenAtMs: 1, stalled: true } }),
      g: snap({ gate: { consecutiveReds: 0, lastGreenAtMs: 5, stalled: false } }),
      u: snap({ gate: { consecutiveReds: 0, lastGreenAtMs: null, stalled: false } }),
    };
    const { gitPipelineHiveRows } = await import('./git-pipeline-hives');
    const rows = await gitPipelineHiveRows('default');
    const m = Object.fromEntries(rows.map((r) => [r.slug, r.gateStatus]));
    expect(m.s).toBe('stalled');
    expect(m.g).toBe('green');
    expect(m.u).toBe('unknown');
  });

  it('best-effort: a resolver throw for one hive does not break the others', async () => {
    projects = [{ slug: 'ok-hive' }, { slug: 'boom-hive' }];
    envBySlug = { 'ok-hive': enabledEnv('ok-hive'), 'boom-hive': 'THROW' };
    const { gitPipelineHiveRows } = await import('./git-pipeline-hives');
    const rows = await gitPipelineHiveRows('default');
    expect(rows.map((r) => r.slug)).toEqual(['ok-hive']);
  });
});

// ── P-009: the bridge-state projection (github-bridge-hive-egress-2026-07-02) ──
describe('bridgeStateFromMetadata (P-009)', () => {
  it('maps a well-formed github_bridge blob', async () => {
    const { bridgeStateFromMetadata } = await import('./git-pipeline-hives');
    const s = bridgeStateFromMetadata(
      {
        at: 1751000000000,
        ran: true,
        skipped: null,
        egress_target: 'fork',
        last_admitted: 'a'.repeat(40),
        divergence: 'escalate',
        needs_owner: true,
        errors: ['x', 'y'],
      },
      'member-1',
    );
    expect(s).toEqual({
      atMs: 1751000000000,
      ran: true,
      skipped: null,
      egressTarget: 'fork',
      lastAdmitted: 'a'.repeat(40),
      divergence: 'escalate',
      needsOwner: true,
      errors: 2,
      memberSlug: 'member-1',
    });
  });

  it('is junk-safe: malformed fields degrade to defaults; non-object → null', async () => {
    const { bridgeStateFromMetadata } = await import('./git-pipeline-hives');
    expect(bridgeStateFromMetadata(null, 'm')).toBeNull();
    expect(bridgeStateFromMetadata('garbage', 'm')).toBeNull();
    const s = bridgeStateFromMetadata({ at: 'NaN', divergence: 'sideways', errors: 3 }, 'm');
    expect(s).toEqual({
      atMs: null,
      ran: false,
      skipped: null,
      egressTarget: null,
      lastAdmitted: null,
      divergence: null,
      needsOwner: false,
      errors: 0,
      memberSlug: 'm',
    });
  });
});
