/**
 * Coverage for search-provider-credentials: the merge/trim/delete write
 * semantics, maskKey, buildSpawnEnv (full keys, skip empty), and readMaskedView
 * (per-provider field expansion incl. primary+alternates / explicit fields,
 * isPrimary flag, masked values). operator-state-pg is mocked.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const readOperatorState = vi.fn();
const writeOperatorState = vi.fn();
vi.mock('./operator-state-pg', () => ({
  readOperatorState: (...a: unknown[]) => readOperatorState(...a),
  writeOperatorState: (...a: unknown[]) => writeOperatorState(...a),
}));

import {
  writeSearchProviderCredentials,
  readSearchProviderCredentials,
  maskKey,
  buildSpawnEnv,
  readMaskedView,
  SEARCH_PROVIDERS,
} from './search-provider-credentials';

beforeEach(() => {
  readOperatorState.mockResolvedValue({});
  writeOperatorState.mockResolvedValue(undefined);
});
afterEach(() => vi.clearAllMocks());

describe('maskKey', () => {
  it('masks to first-3 + ... + last-4, null when too short', () => {
    expect(maskKey('sk-12345678')).toBe('sk-...5678');
    expect(maskKey('short')).toBeNull();
    expect(maskKey(null)).toBeNull();
  });
});

describe('writeSearchProviderCredentials', () => {
  it('trims new values, deletes on null/empty, leaves others intact', async () => {
    readOperatorState.mockResolvedValue({ BRAVE_API_KEY: 'old', KEEP: 'me' });
    const next = await writeSearchProviderCredentials({
      TAVILY_API_KEY: '  abc  ', // trimmed
      BRAVE_API_KEY: '', // deleted
      JINA_API_KEY: null, // deleted (was absent — no-op delete)
    });
    expect(next).toEqual({ KEEP: 'me', TAVILY_API_KEY: 'abc' });
    expect(writeOperatorState).toHaveBeenCalledWith('operator_search_provider_credentials', next);
  });
});

describe('readSearchProviderCredentials', () => {
  it('returns {} when nothing is stored', async () => {
    readOperatorState.mockResolvedValue(null);
    expect(await readSearchProviderCredentials()).toEqual({});
  });
});

describe('buildSpawnEnv', () => {
  it('includes only non-empty string values (full keys)', async () => {
    readOperatorState.mockResolvedValue({ A: '1', EMPTY: '', C: '2' });
    expect(await buildSpawnEnv()).toEqual({ A: '1', C: '2' });
  });
});

describe('readMaskedView', () => {
  it('expands primary+alternates, flags the primary, and masks values', async () => {
    readOperatorState.mockResolvedValue({ PERPLEXITY_API_KEY: 'pk-abcd1234' });
    const view = await readMaskedView();
    const pplx = view.providers.find((p) => p.id === 'perplexity')!;
    // perplexity: primary PERPLEXITY_API_KEY + alternate PPLX_API_KEY
    expect(pplx.fields.map((f) => f.envVar)).toEqual(['PERPLEXITY_API_KEY', 'PPLX_API_KEY']);
    const primary = pplx.fields.find((f) => f.envVar === 'PERPLEXITY_API_KEY')!;
    expect(primary.isPrimary).toBe(true);
    expect(primary.masked).toBe('pk-...1234');
    expect(pplx.fields.find((f) => f.envVar === 'PPLX_API_KEY')!.masked).toBeNull(); // unset
  });

  it('uses the explicit fields[] list for a multi-field provider (searxng)', async () => {
    const view = await readMaskedView();
    const searxng = view.providers.find((p) => p.id === 'searxng')!;
    expect(searxng.fields.map((f) => f.envVar)).toEqual([
      'SEARXNG_ENDPOINT',
      'SEARXNG_TOKEN',
      'SEARXNG_BASIC_USERNAME',
      'SEARXNG_BASIC_PASSWORD',
    ]);
  });

  it('covers every provider', async () => {
    const view = await readMaskedView();
    expect(view.providers).toHaveLength(SEARCH_PROVIDERS.length);
  });
});
