/**
 * Pure-logic tests for the gym control plane (gym-ui-handoff backend). The SQL
 * round-trips live in control-plane.integration.test.ts; here we cover the
 * domain-free helpers: which prompt keys are editable + the status summary.
 */
import { describe, it, expect } from 'vitest';
import { AGENT_ROLES } from '@papercusp/agent-mcp';
import {
  isGymEditablePromptKey,
  GYM_PROMPT_KEYS,
  JUDGE_PROMPT_KEY,
  summarizeGymStatus,
  type GymAutoloopConfig,
} from '../control-plane';

describe('isGymEditablePromptKey', () => {
  it('allows the judge rubric key', () => {
    expect(isGymEditablePromptKey(JUDGE_PROMPT_KEY)).toBe(true);
  });
  it('allows every known harness role', () => {
    for (const role of AGENT_ROLES) expect(isGymEditablePromptKey(role)).toBe(true);
  });
  it('rejects an unknown key', () => {
    expect(isGymEditablePromptKey('definitely-not-a-role')).toBe(false);
    expect(isGymEditablePromptKey('')).toBe(false);
  });
  it('GYM_PROMPT_KEYS = judge + all roles, judge first', () => {
    expect(GYM_PROMPT_KEYS[0]).toBe(JUDGE_PROMPT_KEY);
    expect(new Set(GYM_PROMPT_KEYS)).toEqual(new Set([JUDGE_PROMPT_KEY, ...AGENT_ROLES]));
  });
});

describe('summarizeGymStatus', () => {
  const autoloop = (over: Partial<GymAutoloopConfig> = {}): GymAutoloopConfig => ({
    workspaceId: 'w', harnessSlug: 'h', enabled: false, budgetUsd: null, spentUsd: 0,
    status: 'idle', lastCycle: null, lastCycleAt: null, updatedAt: 0, ...over,
  });

  it('counts pending proposals and takes the latest cycle from them', () => {
    const s = summarizeGymStatus([{ cycle: 1 }, { cycle: 3 }, { cycle: 2 }], autoloop({ lastCycle: 0 }));
    expect(s.pendingCount).toBe(3);
    expect(s.lastCycle).toBe(3); // max pending cycle wins over autoloop.lastCycle
  });

  it('falls back to autoloop.lastCycle when there are no pending proposals', () => {
    const s = summarizeGymStatus([], autoloop({ lastCycle: 5 }));
    expect(s.pendingCount).toBe(0);
    expect(s.lastCycle).toBe(5);
  });

  it('surfaces autoloop fields, and null autoloop → null', () => {
    const s = summarizeGymStatus([], autoloop({ enabled: true, status: 'running', budgetUsd: 10, spentUsd: 2.5 }));
    expect(s.autoloop).toEqual({ enabled: true, status: 'running', budgetUsd: 10, spentUsd: 2.5 });
    expect(summarizeGymStatus([], null).autoloop).toBeNull();
  });
});
