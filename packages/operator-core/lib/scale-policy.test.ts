/**
 * Scale-policy persistence must not reintroduce a window shorter than the slow
 * account-keyed re-probe cadence.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  readOperatorState: vi.fn(),
  writeOperatorState: vi.fn(),
  registerOverrideConcern: vi.fn(),
}));

vi.mock('./operator-state-pg', () => ({
  readOperatorState: mocks.readOperatorState,
  writeOperatorState: mocks.writeOperatorState,
}));
vi.mock('./config-overrides/registry', () => ({
  registerOverrideConcern: mocks.registerOverrideConcern,
}));

import {
  DEFAULT_SCALE_POLICY,
  MIN_SCALE_POLICY_WINDOW_MS,
} from './deployment/account-pool';
import { normalizeScalePolicy, readScalePolicy, writeScalePolicy } from './scale-policy';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.readOperatorState.mockResolvedValue(null);
  mocks.writeOperatorState.mockResolvedValue(undefined);
});

describe('scale-policy re-probe window floor', () => {
  it('clamps an undersized persisted window while preserving other fields', () => {
    expect(normalizeScalePolicy({ windowMs: 1_000, sustainedPenaltyThreshold: 5 })).toEqual({
      windowMs: MIN_SCALE_POLICY_WINDOW_MS,
      sustainedPenaltyThreshold: 5,
    });
  });

  it('normalizes a legacy stored override on read', async () => {
    mocks.readOperatorState.mockResolvedValue({ windowMs: 1_000, sustainedPenaltyThreshold: 4 });

    await expect(readScalePolicy()).resolves.toEqual({
      windowMs: MIN_SCALE_POLICY_WINDOW_MS,
      sustainedPenaltyThreshold: 4,
    });
  });

  it('normalizes a low write patch before persisting it', async () => {
    await expect(writeScalePolicy({ windowMs: 1_000 })).resolves.toEqual(DEFAULT_SCALE_POLICY);
    expect(mocks.writeOperatorState).toHaveBeenCalledWith('operator_scale_policy', DEFAULT_SCALE_POLICY);
  });
});
