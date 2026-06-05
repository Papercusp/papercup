/**
 * Coverage for session.ts profile helpers: readProfile defaulting, writeProfile
 * updated_at stamping + persistence, and the legacy PROFILE_PATH_CONST.
 * operator-state-pg is mocked.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const readOperatorState = vi.fn();
const writeOperatorState = vi.fn();
vi.mock('./operator-state-pg', () => ({
  readOperatorState: (...a: unknown[]) => readOperatorState(...a),
  writeOperatorState: (...a: unknown[]) => writeOperatorState(...a),
}));

import { readProfile, writeProfile, PROFILE_PATH_CONST } from './session';

beforeEach(() => {
  writeOperatorState.mockResolvedValue(undefined);
});
afterEach(() => vi.clearAllMocks());

describe('readProfile', () => {
  it('returns the stored profile', async () => {
    readOperatorState.mockResolvedValue({ theme_id: 'black', auto_scan: true });
    expect(await readProfile()).toEqual({ theme_id: 'black', auto_scan: true });
    expect(readOperatorState).toHaveBeenCalledWith('operator_user_profile', undefined);
  });

  it('defaults to {} when nothing is stored', async () => {
    readOperatorState.mockResolvedValue(null);
    expect(await readProfile()).toEqual({});
  });
});

describe('writeProfile', () => {
  it('stamps updated_at, persists under the profile key, and returns the stamped profile', async () => {
    const out = await writeProfile({ theme_id: 'frost' });
    expect(out.theme_id).toBe('frost');
    expect(typeof out.updated_at).toBe('string');
    expect(writeOperatorState).toHaveBeenCalledWith(
      'operator_user_profile',
      expect.objectContaining({ theme_id: 'frost', updated_at: expect.any(String) }),
    );
  });
});

describe('PROFILE_PATH_CONST', () => {
  it('returns the PG table name (legacy shim)', () => {
    expect(PROFILE_PATH_CONST()).toBe('harness_shared.operator_user_profile');
  });
});
