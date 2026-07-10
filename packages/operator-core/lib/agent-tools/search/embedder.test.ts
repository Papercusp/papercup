/**
 * GAP 11 — `buildQueryEmbedder` mode-resolution (embedder.ts).
 *
 * The cascade that picks the query-embedding provider for `search:semantic`:
 *
 *   key   = operator_credentials.openai_api_key  ||  OPENAI_API_KEY env
 *   mode  = voice-pref `memoryEmbedderMode` ∈ {openai, local, auto, unset}
 *           resolved against key-presence:
 *             openai + key  → openai
 *             local         → local
 *             auto | unset  → key ? openai : local
 *           loadVoicePrefs throwing + key → openai (the catch fallback)
 *
 *   openai → an Embedder that POSTs OpenAI /embeddings with dimensions:384,
 *            throwing `openai_embed_<status>` on a non-2xx;
 *   local  → a transformers pipeline, or null when the dynamic import fails;
 *   no mode resolved → null (→ engine falls back to BM25-only).
 *
 * readCredentials / loadVoicePrefs / fetch / the dynamic local import are all
 * stubbed so this isolates the resolution logic with zero network / model.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Both deps are pulled in via dynamic import() inside buildQueryEmbedder, so the
// mocks below intercept those too (same shape rerank.test.ts uses).
vi.mock('../../credentials', () => ({ readCredentials: vi.fn() }));
vi.mock('../../voice-prefs', () => ({ loadVoicePrefs: vi.fn() }));

import { buildQueryEmbedder, withAcquireBudget } from './embedder';
import { readCredentials } from '../../credentials';
import { loadVoicePrefs } from '../../voice-prefs';

const savedKey = process.env.OPENAI_API_KEY;

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.OPENAI_API_KEY;
  // Defaults: no stored key, no voice pref. Each test overrides as needed.
  vi.mocked(readCredentials).mockResolvedValue({});
  vi.mocked(loadVoicePrefs).mockResolvedValue({ memoryEmbedderMode: 'auto' } as never);
});

afterEach(() => {
  if (savedKey === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = savedKey;
  vi.restoreAllMocks();
});

describe('buildQueryEmbedder — OpenAI path', () => {
  it('(a) openai mode + key → an embedder that POSTs OpenAI with dimensions:384, returns the vector', async () => {
    vi.mocked(readCredentials).mockResolvedValue({ openai_api_key: 'sk-stored' });
    vi.mocked(loadVoicePrefs).mockResolvedValue({ memoryEmbedderMode: 'openai' } as never);
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ data: [{ embedding: [0.1, 0.2, 0.3] }] }),
    }));
    vi.stubGlobal('fetch', fetchMock);

    const embedder = await buildQueryEmbedder();
    expect(embedder).toBeTypeOf('function');

    const vec = await embedder!('auth strategy');
    expect(vec).toEqual([0.1, 0.2, 0.3]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.openai.com/v1/embeddings');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer sk-stored');
    const body = JSON.parse(init.body as string);
    expect(body.dimensions).toBe(384);
    expect(body.model).toBe('text-embedding-3-small');
    expect(body.input).toBe('auth strategy');
  });

  it('(a2) the openai embedder throws `openai_embed_<status>` on a non-2xx response', async () => {
    vi.mocked(readCredentials).mockResolvedValue({ openai_api_key: 'sk-stored' });
    vi.mocked(loadVoicePrefs).mockResolvedValue({ memoryEmbedderMode: 'openai' } as never);
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 429, json: async () => ({}) })));

    const embedder = await buildQueryEmbedder();
    await expect(embedder!('x')).rejects.toThrow('openai_embed_429');
  });

  it('uses the OPENAI_API_KEY env var as the key when no credential is stored', async () => {
    process.env.OPENAI_API_KEY = 'sk-env';
    vi.mocked(readCredentials).mockResolvedValue({}); // no stored key
    vi.mocked(loadVoicePrefs).mockResolvedValue({ memoryEmbedderMode: 'openai' } as never);
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ data: [{ embedding: [1] }] }) }));
    vi.stubGlobal('fetch', fetchMock);

    const embedder = await buildQueryEmbedder();
    await embedder!('x');
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer sk-env');
  });

  it('(c) auto mode + key → openai (POSTs OpenAI)', async () => {
    process.env.OPENAI_API_KEY = 'sk-env';
    vi.mocked(loadVoicePrefs).mockResolvedValue({ memoryEmbedderMode: 'auto' } as never);
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ data: [{ embedding: [9] }] }) }));
    vi.stubGlobal('fetch', fetchMock);

    const embedder = await buildQueryEmbedder();
    expect(await embedder!('x')).toEqual([9]);
    expect(fetchMock).toHaveBeenCalled();
  });

  it('(e) loadVoicePrefs throwing + key → openai (the catch fallback)', async () => {
    process.env.OPENAI_API_KEY = 'sk-env';
    vi.mocked(loadVoicePrefs).mockRejectedValue(new Error('voice-prefs boom'));
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ data: [{ embedding: [7] }] }) }));
    vi.stubGlobal('fetch', fetchMock);

    const embedder = await buildQueryEmbedder();
    expect(embedder).toBeTypeOf('function');
    expect(await embedder!('x')).toEqual([7]);
  });
});

describe('buildQueryEmbedder — local / null fallback', () => {
  // The local branch dynamic-imports '@huggingface/transformers' via
  // `new Function('s','return import(s)')`, which vi.mock cannot intercept (it is
  // not a static specifier). In this test environment the package is not
  // installed, so the import rejects → the local branch returns null. That is
  // exactly the (b)/(d)/(f) contract: when local is selected but unavailable,
  // buildQueryEmbedder yields null and the engine degrades to BM25-only.

  it('(b) openai mode but NO key → does not pick openai; falls to local → null (import unavailable)', async () => {
    vi.mocked(readCredentials).mockResolvedValue({}); // no key
    vi.mocked(loadVoicePrefs).mockResolvedValue({ memoryEmbedderMode: 'openai' } as never);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    // mode='openai' but no key → the `m==='openai' && key` guard fails, and no
    // other branch matches (m is neither 'local' nor 'auto'/unset) → mode stays
    // null → returns null. No OpenAI call.
    const embedder = await buildQueryEmbedder();
    expect(embedder).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('(d) auto mode + NO key → local selected → null (local import unavailable) + no OpenAI call', async () => {
    vi.mocked(readCredentials).mockResolvedValue({});
    vi.mocked(loadVoicePrefs).mockResolvedValue({ memoryEmbedderMode: 'auto' } as never);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const embedder = await buildQueryEmbedder();
    // local was selected but the transformers import fails → null (BM25 fallback).
    expect(embedder).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('(f) explicit local mode (even with a key) → local import fails → null', async () => {
    process.env.OPENAI_API_KEY = 'sk-env'; // key present but mode pins local
    vi.mocked(loadVoicePrefs).mockResolvedValue({ memoryEmbedderMode: 'local' } as never);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const embedder = await buildQueryEmbedder();
    expect(embedder).toBeNull();
    // mode pinned local → OpenAI never used despite the key.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('unset mode + NO key → local → null (no mode resolved to a usable embedder)', async () => {
    vi.mocked(readCredentials).mockResolvedValue({});
    vi.mocked(loadVoicePrefs).mockResolvedValue({} as never); // memoryEmbedderMode undefined
    vi.stubGlobal('fetch', vi.fn());

    const embedder = await buildQueryEmbedder();
    expect(embedder).toBeNull();
  });

  it('readCredentials throwing falls back to the env key (try/catch around creds read)', async () => {
    process.env.OPENAI_API_KEY = 'sk-env';
    vi.mocked(readCredentials).mockRejectedValue(new Error('creds boom'));
    vi.mocked(loadVoicePrefs).mockResolvedValue({ memoryEmbedderMode: 'openai' } as never);
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ data: [{ embedding: [3] }] }) }));
    vi.stubGlobal('fetch', fetchMock);

    const embedder = await buildQueryEmbedder();
    expect(await embedder!('x')).toEqual([3]);
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer sk-env');
  });
});

describe('withAcquireBudget — bounds the query-embedder acquisition (WI-3922)', () => {
  // The acquisition itself resolves fast in this test env (the local transformers
  // import is unavailable → null immediately), so the race logic that guards a
  // slow cold-pipeline acquisition is exercised directly against a controllable
  // slow promise here.
  const slow = <T>(v: T, ms: number): Promise<T> => new Promise((r) => setTimeout(() => r(v), ms));
  const sentinel = { tag: 'embedder' as const };

  it('returns the acquisition value when it settles within budget', async () => {
    await expect(withAcquireBudget(slow(sentinel, 10), 200)).resolves.toBe(sentinel);
  });

  it('returns null when the acquisition exceeds the budget (cold pipeline → BM25 degrade)', async () => {
    await expect(withAcquireBudget(slow(sentinel, 200), 20)).resolves.toBeNull();
  });

  it('budget ≤ 0 ⇒ unbounded — awaits the acquisition however slow (background/batch callers)', async () => {
    await expect(withAcquireBudget(slow(sentinel, 30), 0)).resolves.toBe(sentinel);
  });

  it('a rejected acquisition within budget degrades to null, never throws', async () => {
    await expect(withAcquireBudget(Promise.reject(new Error('cold pipeline boom')), 200)).resolves.toBeNull();
  });
});
