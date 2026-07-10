/**
 * Coverage for credentials: the secret-masking helpers (last-4 form, null when
 * too short) and the read/write round-trip (updated_at stamp). operator-state-pg
 * AND ./backup are mocked — writeCredentials now fires the `secret_change` backup
 * trigger (settings-audit 2026-07-09), and the real ./backup barrel runs an
 * `import './configure'` host-seam side-effect + reaches PG/kopia. Un-mocked, the
 * awaited triggerSnapshotEvent HANGS past its own `.catch` (a never-settling PG
 * read isn't a rejection), timing the write test out — it wedged the green gate
 * on 2026-07-10 alongside wake-executor.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const readOperatorState = vi.fn();
const writeOperatorState = vi.fn();
vi.mock('./operator-state-pg', () => ({
  readOperatorState: (...a: unknown[]) => readOperatorState(...a),
  writeOperatorState: (...a: unknown[]) => writeOperatorState(...a),
}));
// Hermetic: stub the backup trigger so writeCredentials never loads the real
// ./backup barrel (host-seam configure + PG/kopia). activeWorkspaceId() is pure
// (ALS / process-pin read) so ./workspace-registry needs no mock.
const triggerSnapshotEvent = vi.fn(async () => undefined);
vi.mock('./backup', () => ({ triggerSnapshotEvent: (...a: unknown[]) => triggerSnapshotEvent(...a) }));

import { readCredentials, writeCredentials, maskSecret, maskCredentials, CREDENTIALS_PATH } from './credentials';

beforeEach(() => writeOperatorState.mockResolvedValue(undefined));
afterEach(() => vi.clearAllMocks());

describe('maskSecret', () => {
  it('masks to first-7 + ... + last-4', () => {
    expect(maskSecret('sk-ant-api03-secretAbCd')).toBe('sk-ant-...AbCd');
  });
  it('returns null for short / empty / missing values', () => {
    expect(maskSecret('1234567')).toBeNull(); // 7 chars (< 8)
    expect(maskSecret('')).toBeNull();
    expect(maskSecret(undefined)).toBeNull();
    expect(maskSecret(null)).toBeNull();
  });
});

describe('maskCredentials', () => {
  it('masks every secret field and surfaces the table path', () => {
    const masked = maskCredentials({
      anthropic_api_key: 'sk-ant-aaaaBBBB',
      github_pat: 'ghp_xxxxYYYY',
      updated_at: '2026-05-31',
    });
    expect(masked.anthropic_api_key).toBe('sk-ant-...BBBB');
    expect(masked.github_pat).toBe('ghp_xxx...YYYY');
    expect(masked.openai_api_key).toBeNull(); // unset
    expect(masked.updated_at).toBe('2026-05-31');
    expect(masked.path).toBe('harness_shared.operator_credentials');
  });
});

describe('readCredentials / writeCredentials', () => {
  it('reads the stored credentials, defaulting to {}', async () => {
    readOperatorState.mockResolvedValue(null);
    expect(await readCredentials()).toEqual({});
    expect(readOperatorState).toHaveBeenCalledWith('operator_credentials');
  });

  it('stamps updated_at and persists under the credentials key', async () => {
    const out = await writeCredentials({ openai_api_key: 'sk-test' });
    expect(out.openai_api_key).toBe('sk-test');
    expect(typeof out.updated_at).toBe('string');
    expect(writeOperatorState).toHaveBeenCalledWith(
      'operator_credentials',
      expect.objectContaining({ openai_api_key: 'sk-test', updated_at: expect.any(String) }),
    );
    // Fires the secret_change backup trigger with key NAMES only (never values).
    expect(triggerSnapshotEvent).toHaveBeenCalledWith(
      expect.any(String),
      'secret_change',
      expect.objectContaining({ op: 'credentials_write', keys: ['openai_api_key'] }),
    );
  });
});

describe('CREDENTIALS_PATH', () => {
  it('returns the PG table name', () => {
    expect(CREDENTIALS_PATH()).toBe('harness_shared.operator_credentials');
  });
});
