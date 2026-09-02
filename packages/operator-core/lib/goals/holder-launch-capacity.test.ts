import { describe, expect, it } from 'vitest';
import type { AccountStatusRow } from '../deployment/account-pool-store';
import {
  assessGoalHolderLaunchCapacity,
  assessGoalHolderLaunchCapacityForGoal,
  formatCapacityUntil,
  holderLaunchTarget,
  holderLaunchTargetForSettings,
} from './holder-launch-capacity';

const NOW = 1_788_328_000_000; // 2026-09-02T05:46:40Z — the measured wall
const RESET_7D = 1_788_844_049_000; // chatgpt-sub-cli usageResetAt as observed

function row(overrides: Partial<AccountStatusRow> & { id: string }): AccountStatusRow {
  const fresh = overrides.readingStatus ?? 'fresh';
  return {
    provider: 'codex',
    label: overrides.id,
    credentialRef: `codex-cli:/tmp/${overrides.id}`,
    boundTo: [],
    available: true,
    usageWalled: false,
    sustainedlyLimited: false,
    edgeThrottleKnown: false,
    edgeThrottled: false,
    edgeThrottleCooledIps: 0,
    edgeThrottleBare429Streak: 0,
    rate: { pausedUntil: 0, lastPenaltyAt: 0, penaltyCount: 0, windowStartedAt: 0, utilizationAt: NOW - 60_000 },
    liveBuckets: [],
    readingStatus: fresh,
    readingAgeMs: 60_000,
    burn: {
      burnRatePerHr: null,
      headroomFraction: 0.5,
      projectedExhaustionAt: null,
      exhaustsBeforeReset: false,
      action: 'none',
      utilization7d: 0.5,
      disposition: 'no-verdict',
      reason: 'fixture',
    },
    ...overrides,
  };
}

/** The 2026-09-02 shape: the codex CLI-bridge account, weekly window at 100%, fresh reading. */
const walledCodex = row({
  id: 'chatgpt-sub-cli',
  available: false,
  usageWalled: true,
  usageResetAt: RESET_7D,
  sustainedlyLimited: true,
  burn: {
    burnRatePerHr: 0,
    headroomFraction: 0,
    projectedExhaustionAt: NOW,
    exhaustsBeforeReset: true,
    action: 'shed',
    utilization7d: 1,
    disposition: 'measured-wall',
    reason: '7d window already exhausted (utilization 1.00) — resets in 6d',
  },
});
const healthyClaude = row({ id: 'aviynw', provider: 'claude' });

describe('holderLaunchTarget — which account(s) the holder launch draws on', () => {
  it("maps agent 'codex' to the codex pool and an 'auto'/'default'/absent account to launch-time selection", () => {
    expect(holderLaunchTarget({ agent: 'codex', account: 'auto' })).toEqual({ provider: 'codex', accountId: null, agent: 'codex' });
    expect(holderLaunchTarget({ agent: 'codex', account: 'default' })).toMatchObject({ provider: 'codex', accountId: null });
    expect(holderLaunchTarget({ agent: 'codex' })).toMatchObject({ provider: 'codex', accountId: null });
    expect(holderLaunchTarget({ agent: 'claude', account: ' aviynw3 ' })).toEqual({ provider: 'claude', accountId: 'aviynw3', agent: 'claude' });
    expect(holderLaunchTarget(null)).toMatchObject({ provider: 'claude', accountId: null, agent: null });
  });

  it('reports an unmapped agent as a null provider rather than guessing a pool', () => {
    expect(holderLaunchTarget({ agent: 'omp' })).toMatchObject({ provider: null, agent: 'omp' });
  });

  it('folds the holder ROLE over the goal defaults, exactly like the launch does', () => {
    expect(
      holderLaunchTargetForSettings({
        defaults: { agent: 'claude', account: 'default' },
        roles: { goal: { agent: 'codex', account: 'auto' } },
      }),
    ).toMatchObject({ provider: 'codex', accountId: null });
    expect(holderLaunchTargetForSettings(null)).toMatchObject({ provider: 'claude', accountId: null });
  });
});

describe('assessGoalHolderLaunchCapacity', () => {
  const codexAuto = holderLaunchTarget({ agent: 'codex', account: 'auto' });

  it('DEFERS an unpinned codex holder when every fresh codex row is usage-walled — the measured 2026-09-02 case', () => {
    const v = assessGoalHolderLaunchCapacity([walledCodex, healthyClaude], codexAuto, NOW);
    expect(v.kind).toBe('deferred');
    if (v.kind !== 'deferred') return;
    expect(v.binding).toBe('usage-wall');
    expect(v.untilMs).toBe(RESET_7D);
    expect(v.accountIds).toEqual(['chatgpt-sub-cli']);
    expect(v.pool).toMatchObject({ provider: 'codex', atCapacity: true, walledFresh: 1 });
  });

  it("judges ONLY the target provider — a walled codex pool never defers a claude holder, and vice versa", () => {
    const claudeAuto = holderLaunchTarget({ agent: 'claude', account: 'auto' });
    expect(assessGoalHolderLaunchCapacity([walledCodex, healthyClaude], claudeAuto, NOW).kind).toBe('clear');
    const walledClaude = row({ ...walledCodex, id: 'aviynw', provider: 'claude' });
    const healthyCodex = row({ id: 'aviynw5_codex' });
    expect(assessGoalHolderLaunchCapacity([walledClaude, healthyCodex], codexAuto, NOW).kind).toBe('clear');
  });

  it('clears when ANY fresh row of the pool can serve (launch-time selection would pick it)', () => {
    const v = assessGoalHolderLaunchCapacity([walledCodex, row({ id: 'aviynw5_codex' })], codexAuto, NOW);
    expect(v.kind).toBe('clear');
  });

  it('judges a PINNED account alone: a walled pin defers even with a healthy sibling, a healthy pin clears beside a walled sibling', () => {
    const pinnedWalled = holderLaunchTarget({ agent: 'codex', account: 'chatgpt-sub-cli' });
    const pinnedHealthy = holderLaunchTarget({ agent: 'codex', account: 'aviynw5_codex' });
    const rows = [walledCodex, row({ id: 'aviynw5_codex' })];
    expect(assessGoalHolderLaunchCapacity(rows, pinnedWalled, NOW)).toMatchObject({ kind: 'deferred', accountIds: ['chatgpt-sub-cli'] });
    expect(assessGoalHolderLaunchCapacity(rows, pinnedHealthy, NOW).kind).toBe('clear');
  });

  it('never defers on a STALE or never-observed reading — that is unknown, not a wall', () => {
    const staleWalled = row({ ...walledCodex, readingStatus: 'stale', readingAgeMs: 3_600_000 });
    expect(assessGoalHolderLaunchCapacity([staleWalled], codexAuto, NOW).kind).toBe('unknown');
    const probeFailed = row({ ...walledCodex, lastProbeFailedAt: NOW - 1000 });
    expect(assessGoalHolderLaunchCapacity([probeFailed], codexAuto, NOW).kind).toBe('unknown');
    // One fresh wall + one stale sibling: a partial answer is never "at capacity".
    expect(assessGoalHolderLaunchCapacity([walledCodex, staleWalled], codexAuto, NOW).kind).toBe('unknown');
  });

  it('is unknown for an unregistered pin, an empty provider pool, or an unmapped agent', () => {
    expect(assessGoalHolderLaunchCapacity([walledCodex], holderLaunchTarget({ agent: 'codex', account: 'ghost' }), NOW)).toMatchObject({ kind: 'unknown' });
    expect(assessGoalHolderLaunchCapacity([healthyClaude], codexAuto, NOW)).toMatchObject({ kind: 'unknown' });
    expect(assessGoalHolderLaunchCapacity([walledCodex], holderLaunchTarget({ agent: 'omp' }), NOW)).toMatchObject({ kind: 'unknown' });
  });

  it('names a RATE PAUSE as its own binding, with the pause expiry, when nothing is usage-walled', () => {
    const paused = row({ id: 'chatgpt-sub-cli', available: false, rate: { pausedUntil: NOW + 300_000, lastPenaltyAt: NOW - 1000, penaltyCount: 1, windowStartedAt: NOW - 1000, utilizationAt: NOW - 1000 } });
    const v = assessGoalHolderLaunchCapacity([paused], codexAuto, NOW);
    expect(v).toMatchObject({ kind: 'deferred', binding: 'rate-pause', untilMs: NOW + 300_000, accountIds: ['chatgpt-sub-cli'] });
  });

  it('folds the goal settings and reads the live rows through the I/O door', async () => {
    const v = await assessGoalHolderLaunchCapacityForGoal(
      { workspaceId: 'papercusp-workspace', launchSettings: { roles: { goal: { agent: 'codex', account: 'auto' } } } },
      { readAccountStatus: async (ws) => (ws === 'papercusp-workspace' ? [walledCodex, healthyClaude] : []), now: () => NOW },
    );
    expect(v).toMatchObject({ kind: 'deferred', binding: 'usage-wall', target: { provider: 'codex' } });
  });
});

describe('formatCapacityUntil', () => {
  it('renders hours past two hours, minutes below, and names a missing reset', () => {
    expect(formatCapacityUntil(NOW + 3 * 3_600_000, NOW)).toMatch(/\(~3h\)$/);
    expect(formatCapacityUntil(NOW + 5 * 60_000, NOW)).toMatch(/\(~5m\)$/);
    expect(formatCapacityUntil(null, NOW)).toContain('no reset time');
  });
});
