/**
 * Coverage for marketplace-token: the env-override-wins precedence over the
 * PG-backed store, malformed-override fallthrough, readFirstServiceToken, and
 * the write path. operator-state-pg is mocked.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const readOperatorState = vi.fn();
const writeOperatorState = vi.fn();
vi.mock('./operator-state-pg', () => ({
  readOperatorState: (...a: unknown[]) => readOperatorState(...a),
  writeOperatorState: (...a: unknown[]) => writeOperatorState(...a),
}));

import { readServiceTokens, readFirstServiceToken, writeServiceTokens } from './marketplace-token';

const ENV = 'PAPERCUSP_MARKETPLACE_SERVICE_TOKENS';
beforeEach(() => {
  readOperatorState.mockResolvedValue(null);
  writeOperatorState.mockResolvedValue(undefined);
});
afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

describe('readServiceTokens', () => {
  it('env override wins over PG when it is a valid JSON array', async () => {
    vi.stubEnv(ENV, JSON.stringify([{ host: 'h', token: 'env-tok' }]));
    expect(await readServiceTokens()).toEqual([{ host: 'h', token: 'env-tok' }]);
    expect(readOperatorState).not.toHaveBeenCalled(); // short-circuited
  });

  it('falls through to PG when the override is malformed JSON', async () => {
    vi.stubEnv(ENV, '{not json');
    readOperatorState.mockResolvedValue({ tokens: [{ token: 'pg-tok' }] });
    expect(await readServiceTokens()).toEqual([{ token: 'pg-tok' }]);
  });

  it('falls through to PG when the override is JSON but not an array', async () => {
    vi.stubEnv(ENV, JSON.stringify({ token: 'x' }));
    readOperatorState.mockResolvedValue({ tokens: [{ token: 'pg-tok' }] });
    expect(await readServiceTokens()).toEqual([{ token: 'pg-tok' }]);
  });

  it('returns [] when no env override and no PG row', async () => {
    readOperatorState.mockResolvedValue(null);
    expect(await readServiceTokens()).toEqual([]);
  });
});

describe('readFirstServiceToken', () => {
  it('returns the first token string', async () => {
    readOperatorState.mockResolvedValue({ tokens: [{ token: 'first' }, { token: 'second' }] });
    expect(await readFirstServiceToken()).toBe('first');
  });
  it('returns null when there are no tokens', async () => {
    readOperatorState.mockResolvedValue({ tokens: [] });
    expect(await readFirstServiceToken()).toBeNull();
  });
});

describe('writeServiceTokens', () => {
  it('persists the tokens under the operator_marketplace_token key', async () => {
    await writeServiceTokens([{ token: 't' }]);
    expect(writeOperatorState).toHaveBeenCalledWith('operator_marketplace_token', {
      tokens: [{ token: 't' }],
    });
  });
});
