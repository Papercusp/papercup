import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const state = new Map<string, unknown>();
  const readOperatorState = vi.fn(async (key: string) => state.get(key) ?? null);
  const writeOperatorState = vi.fn(async (key: string, value: unknown) => {
    state.set(key, value);
  });
  return { state, readOperatorState, writeOperatorState };
});

vi.mock('./operator-state-pg', () => ({
  readOperatorState: h.readOperatorState,
  writeOperatorState: h.writeOperatorState,
}));

import {
  readAutoImplementPolicy,
  readStoredAutoImplementPolicy,
  resetAutoImplementPolicy,
  setStoredAutoImplementPolicy,
  writeAutoImplementPolicy,
  type StoredAutoImplementPolicy,
} from './auto-implement-policy';
import { getOverrideConcern } from './config-overrides/registry';
import { DEFAULT_RISK_TIER_POLICY, type WorkItemKind } from './harness/improvements/policy';

const STORE_KEY = 'operator_auto_implement_policy';

describe('auto-implement policy store', () => {
  beforeEach(() => {
    h.state.clear();
    h.readOperatorState.mockClear();
    h.writeOperatorState.mockClear();
  });

  it('resolves empty storage to baked defaults without setting dispatch limits', async () => {
    await expect(readStoredAutoImplementPolicy()).resolves.toEqual({});

    const effective = await readAutoImplementPolicy();

    expect(effective.riskTier.autoKinds).toEqual(DEFAULT_RISK_TIER_POLICY.autoKinds);
    expect(effective.riskTier.protectedPathPatterns).toEqual(DEFAULT_RISK_TIER_POLICY.protectedPathPatterns);
    expect(effective.riskTier.protectedKeywords).toEqual(DEFAULT_RISK_TIER_POLICY.protectedKeywords);
    expect(effective.maxPerRun).toBeUndefined();
    expect(effective.maxAttempts).toBeUndefined();
    expect(h.readOperatorState).toHaveBeenCalledWith(STORE_KEY);
  });

  it('merges stored additions over defaults without duplicating default protections', async () => {
    const duplicatePath = DEFAULT_RISK_TIER_POLICY.protectedPathPatterns[0];
    const duplicateKeyword = DEFAULT_RISK_TIER_POLICY.protectedKeywords[0];
    const autoKinds: WorkItemKind[] = ['bug', 'change'];
    h.state.set(STORE_KEY, {
      autoKinds,
      protectedPathAdditions: [duplicatePath, 'custom/safety/**', 'custom/safety/**'],
      protectedKeywordAdditions: [duplicateKeyword, 'custom keyword', 'custom keyword'],
      maxPerRun: 4,
      maxAttempts: 2,
    } satisfies StoredAutoImplementPolicy);

    const effective = await readAutoImplementPolicy();

    expect(effective.riskTier.autoKinds).toEqual(autoKinds);
    expect(effective.riskTier.protectedPathPatterns.filter((p) => p === duplicatePath)).toHaveLength(1);
    expect(effective.riskTier.protectedPathPatterns.filter((p) => p === 'custom/safety/**')).toHaveLength(1);
    expect(effective.riskTier.protectedKeywords.filter((k) => k === duplicateKeyword)).toHaveLength(1);
    expect(effective.riskTier.protectedKeywords.filter((k) => k === 'custom keyword')).toHaveLength(1);
    expect(effective.maxPerRun).toBe(4);
    expect(effective.maxAttempts).toBe(2);
  });

  it('writes patches additively for protections while replacing graduation and limit dials', async () => {
    h.state.set(STORE_KEY, {
      autoKinds: ['bug'],
      protectedPathAdditions: ['already/**'],
      protectedKeywordAdditions: ['already-keyword'],
      maxPerRun: 1,
    } satisfies StoredAutoImplementPolicy);

    const next = await writeAutoImplementPolicy({
      autoKinds: ['bug', 'feature'],
      addProtectedPaths: ['already/**', 'new/**'],
      addProtectedKeywords: ['already-keyword', 'new-keyword'],
      maxPerRun: 8,
      maxAttempts: 3,
    });

    expect(next).toEqual({
      autoKinds: ['bug', 'feature'],
      protectedPathAdditions: ['already/**', 'new/**'],
      protectedKeywordAdditions: ['already-keyword', 'new-keyword'],
      maxPerRun: 8,
      maxAttempts: 3,
    });
    expect(h.writeOperatorState).toHaveBeenCalledWith(STORE_KEY, next);
  });

  it('sets and resets the stored override shape', async () => {
    const stored: StoredAutoImplementPolicy = {
      autoKinds: ['bug', 'change'],
      protectedPathAdditions: ['extra/**'],
    };

    await setStoredAutoImplementPolicy(stored);
    expect(h.state.get(STORE_KEY)).toEqual(stored);

    await resetAutoImplementPolicy();
    expect(h.state.get(STORE_KEY)).toEqual({});
  });

  it('registers an override concern that reports, captures, resets, and restores divergence', async () => {
    const concern = getOverrideConcern('auto-implement-policy');
    expect(concern).toBeDefined();

    const snapshot: StoredAutoImplementPolicy = {
      autoKinds: ['bug', 'feature'],
      protectedPathAdditions: ['sensitive/**'],
      protectedKeywordAdditions: ['do-not-auto'],
      maxPerRun: 5,
      maxAttempts: 6,
    };
    h.state.set(STORE_KEY, snapshot);

    const diff = await concern!.diff();
    expect(diff.map((entry) => entry.key).sort()).toEqual([
      'autoKinds',
      'maxAttempts',
      'maxPerRun',
      'protectedKeywordAdditions',
      'protectedPathAdditions',
    ]);
    expect(await concern!.capture()).toEqual(snapshot);

    await concern!.reset();
    expect(h.state.get(STORE_KEY)).toEqual({});

    await concern!.restore(snapshot);
    expect(h.state.get(STORE_KEY)).toEqual(snapshot);
  });
});
