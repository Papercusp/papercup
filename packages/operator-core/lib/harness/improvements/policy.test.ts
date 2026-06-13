import { describe, it, expect } from 'vitest';
import {
  classifyImprovement,
  partitionByTier,
  matchGlob,
  infraEnvironmentHit,
  DEFAULT_RISK_TIER_POLICY,
  type ImprovementCandidate,
  type RiskTierPolicy,
} from './policy';

function cand(p: Partial<ImprovementCandidate> & { id: string }): ImprovementCandidate {
  return { kind: 'change', scope: 'operator', title: 'a thing', ...p };
}

describe('matchGlob', () => {
  it('matches single-segment * within a path segment', () => {
    expect(matchGlob('libs/flags/*', 'libs/flags/types.ts')).toBe(true);
    expect(matchGlob('libs/flags/*', 'libs/flags/sub/types.ts')).toBe(false);
  });
  it('matches ** across segments', () => {
    expect(matchGlob('libs/flags/**', 'libs/flags/sub/deep/types.ts')).toBe(true);
    expect(matchGlob('**/auth/**', 'apps/operator/lib/auth/login.ts')).toBe(true);
  });
  it('does not match a different prefix', () => {
    expect(matchGlob('packages/operator-core/lib/release/**', 'packages/operator-core/lib/foo.ts')).toBe(false);
  });
  it('treats regex specials literally', () => {
    expect(matchGlob('libs/a.b/**', 'libs/a.b/x.ts')).toBe(true);
    expect(matchGlob('libs/a.b/**', 'libs/axb/x.ts')).toBe(false);
  });
});

describe('classifyImprovement — kind gate (D-004)', () => {
  it('AUTO for kind=bug with nothing protected', () => {
    const d = classifyImprovement(cand({ id: '1', kind: 'bug', title: 'list overflows' }));
    expect(d.tier).toBe('auto');
  });
  it('HUMAN for kind=change (not in default autoKinds)', () => {
    const d = classifyImprovement(cand({ id: '2', kind: 'change' }));
    expect(d.tier).toBe('human');
    expect(d.reasons.join(' ')).toMatch(/not auto-eligible/);
  });
  it('HUMAN for kind=feature', () => {
    expect(classifyImprovement(cand({ id: '3', kind: 'feature' })).tier).toBe('human');
  });
  it('HUMAN for kind=research-task', () => {
    expect(classifyImprovement(cand({ id: '4', kind: 'research-task' })).tier).toBe('human');
  });
});

describe('classifyImprovement — protected paths force human even for a bug', () => {
  const protectedCases: Array<[string, string]> = [
    ['release machinery', 'packages/operator-core/lib/release/deploy.ts'],
    ['routines engine', 'packages/operator-core/lib/harness/routines/system-actions.ts'],
    ['dbos engine', 'packages/operator-core/lib/dbos/routines-workflow.ts'],
    ['git-sync', 'packages/operator-core/lib/git-sync/git-sync-action.ts'],
    ['migrations', 'libs/papercusp/libs/db/sql/140-something.sql'],
    ['flags', 'libs/flags/src/types.ts'],
    ['the loop itself', 'packages/operator-core/lib/harness/improvements/policy.ts'],
  ];
  it.each(protectedCases)('bug touching %s → human', (_label, path) => {
    const d = classifyImprovement(cand({ id: 'p', kind: 'bug', paths: [path] }));
    expect(d.tier).toBe('human');
    expect(d.protectedHit).toBeTruthy();
  });
  it('bug touching an ordinary path stays AUTO', () => {
    const d = classifyImprovement(cand({ id: 'ok', kind: 'bug', paths: ['packages/operator-core/lib/issues-engineer.ts'] }));
    expect(d.tier).toBe('auto');
  });
});

describe('classifyImprovement — protected keywords (pre-paths proxy)', () => {
  it('bug whose title mentions a migration → human', () => {
    const d = classifyImprovement(cand({ id: 'k1', kind: 'bug', title: 'migration 131 collision dark table' }));
    expect(d.tier).toBe('human');
    expect(d.protectedHit).toBe('migration');
  });
  it('bug mentioning auth/security in the body → human', () => {
    const d = classifyImprovement(cand({ id: 'k2', kind: 'bug', title: 'token refresh', body: 'the credential rotates' }));
    expect(d.tier).toBe('human');
  });
  it('plain bug with no protected keyword → auto', () => {
    const d = classifyImprovement(cand({ id: 'k3', kind: 'bug', title: 'presence list dumps 233 stale rows' }));
    expect(d.tier).toBe('auto');
  });
});

describe('classifyImprovement — infra-environment never auto (EI-408 / D-002 / D-005)', () => {
  it('infra kind=bug via watchdog signal class → human (EI-187 service-down shape)', () => {
    const d = classifyImprovement(cand({ id: 'i1', kind: 'bug', title: 'Service shop is down', watchdogKey: 'service-down:shop' }));
    expect(d.tier).toBe('human');
    expect(d.protectedHit).toMatch(/service-down/);
    expect(d.reasons.join(' ')).toMatch(/infra-environment/);
  });
  it('infra kind=bug via an environment path → human (.service file)', () => {
    const d = classifyImprovement(cand({ id: 'i2', kind: 'bug', title: 'restart loop', paths: ['deploy/papercup-staging-api.service'] }));
    expect(d.tier).toBe('human');
    expect(d.protectedHit).toMatch(/\.service/);
  });
  it('fire-circuit-open + migration-drift signal classes are infra too', () => {
    expect(classifyImprovement(cand({ id: 'i3', kind: 'bug', title: 'gym backoff', watchdogKey: 'fire-circuit-open:gym' })).tier).toBe('human');
    expect(classifyImprovement(cand({ id: 'i4', kind: 'bug', title: 'drift', watchdogKey: 'migration-drift:live' })).tier).toBe('human');
  });
  it('infra beats graduation — even with every kind graduated, an infra item stays human', () => {
    const graduated: RiskTierPolicy = { ...DEFAULT_RISK_TIER_POLICY, autoKinds: ['bug', 'change', 'feature'] };
    const d = classifyImprovement(cand({ id: 'i5', kind: 'bug', watchdogKey: 'service-down:openai' }), graduated);
    expect(d.tier).toBe('human');
  });
  it('a non-infra signal class (red-test) does NOT trip the infra gate', () => {
    const d = classifyImprovement(cand({ id: 'i6', kind: 'bug', title: 'red e2e', watchdogKey: 'red-test:apps/operator/e2e/foo' }));
    expect(d.tier).toBe('auto');
  });
  it('infraEnvironmentHit: signal class > path > null', () => {
    expect(infraEnvironmentHit({ watchdogKey: 'service-down:shop' })).toMatch(/service-down/);
    expect(infraEnvironmentHit({ paths: ['ops/docker-compose.dev.yml'] })).toMatch(/docker-compose/);
    expect(infraEnvironmentHit({ watchdogKey: 'red-test:e2e', paths: ['packages/operator-core/lib/x.ts'] })).toBeNull();
    expect(infraEnvironmentHit({})).toBeNull();
  });
});

describe('needs-human routing (close-loop D-001 — the resolve back-edge)', () => {
  it('needsHuman forces the human tier even for a plain auto-eligible bug', () => {
    const d = classifyImprovement(cand({ id: 'nh1', kind: 'bug', title: 'plain bug', needsHuman: true }));
    expect(d.tier).toBe('human');
    expect(d.reasons[0]).toMatch(/needs-human/);
  });
  it('needsHuman beats even a graduated policy', () => {
    const graduated: RiskTierPolicy = { ...DEFAULT_RISK_TIER_POLICY, autoKinds: ['bug', 'change', 'feature'] };
    expect(classifyImprovement(cand({ id: 'nh2', kind: 'bug', needsHuman: true }), graduated).tier).toBe('human');
  });
});

describe('Phase 4 graduation is a CONFIG change', () => {
  it('adding change to autoKinds graduates change items to auto', () => {
    const graduated: RiskTierPolicy = { ...DEFAULT_RISK_TIER_POLICY, autoKinds: ['bug', 'change'] };
    expect(classifyImprovement(cand({ id: 'g', kind: 'change' }), graduated).tier).toBe('auto');
    // feature is still human until further graduated
    expect(classifyImprovement(cand({ id: 'g2', kind: 'feature' }), graduated).tier).toBe('human');
  });
  it('empty autoKinds pauses ALL auto (everything human)', () => {
    const paused: RiskTierPolicy = { ...DEFAULT_RISK_TIER_POLICY, autoKinds: [] };
    expect(classifyImprovement(cand({ id: 'pz', kind: 'bug' }), paused).tier).toBe('human');
  });
  it('protected surface stays human even after graduation', () => {
    const graduated: RiskTierPolicy = { ...DEFAULT_RISK_TIER_POLICY, autoKinds: ['bug', 'change', 'feature'] };
    const d = classifyImprovement(cand({ id: 'gp', kind: 'feature', paths: ['packages/operator-core/lib/release/deploy.ts'] }), graduated);
    expect(d.tier).toBe('human');
  });
});

describe('partitionByTier', () => {
  it('splits a mixed set and records a decision per id', () => {
    const items = [
      cand({ id: 'b1', kind: 'bug', title: 'plain bug' }),
      cand({ id: 'c1', kind: 'change', title: 'make it bigger' }),
      cand({ id: 'b2', kind: 'bug', title: 'deploy script flake' }), // keyword → human
    ];
    const { auto, human, decisions } = partitionByTier(items);
    expect(auto.map((c) => c.id)).toEqual(['b1']);
    expect(human.map((c) => c.id).sort()).toEqual(['b2', 'c1']);
    expect(Object.keys(decisions).sort()).toEqual(['b1', 'b2', 'c1']);
  });
});
