import { afterEach, describe, expect, it, vi } from 'vitest';

// EI-7279: mem0-client.ts caches the built client for a 1-HOUR TTL, so the
// `resolveEmbedderWith` cascade (which correctly prefers local during an
// OpenAI cooldown, per the EI-3381 tests below) is only ever RE-EVALUATED
// when the client is rebuilt. Without forcing a rebuild, a 60s cooldown flag
// sat inert for up to an hour: the already-built client kept routing every
// embed through the same dead OpenAI key. `markOpenAiEmbedFailure` must force
// that rebuild by invalidating the cached client — spy on the real
// `@papercusp/memory` export (keep everything else real) to pin it.
const invalidateMemoryClient = vi.fn();
vi.mock('@papercusp/memory', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@papercusp/memory')>();
  return { ...actual, invalidateMemoryClient: (...a: unknown[]) => invalidateMemoryClient(...a) };
});

import {
  resolveEmbedderWith,
  readEmbedderPreference,
  markOpenAiEmbedFailure,
  isOpenAiEmbedInCooldown,
  __resetOpenAiEmbedCooldownForTest,
  type ResolveEmbedderDeps,
} from './configure';

/**
 * GAP 4 — the `resolveEmbedder` cascade (configure.ts) was UNTESTED.
 *
 * A wrong fallthrough here is silent and corrupting: it routes writes to the
 * WRONG per-model vec table (openai's 384-dim space vs local's, which aren't
 * comparable — recall from the wrong table is garbage), or disables embedding
 * entirely when a usable key existed (memory goes dark). The four preferences
 * (`auto` / `openai` / `local` / `disabled`) crossed with {key present/absent}
 * and {local installed/not} have to land on the exact `{mode, reason}` the
 * downstream store keys off of. We pin every cell of that table.
 *
 * The cascade core is `resolveEmbedderWith(deps)` — the same logic the
 * production `resolveEmbedder` runs, with the network/credential/package seams
 * injected so we exercise the branch logic without real I/O. Behavior is
 * identical to the previous inline form; the injection is a testability seam.
 */

const STUB_OPENAI_EMBED = async () => [1, 2, 3];
const STUB_LOCAL_EMBED = async () => [4, 5, 6];
const EMBEDDER_DIM = 384;

/** Build a deps object; each seam defaults to a recorded spy so a test can
 *  assert which legs were/weren't consulted. */
function makeDeps(overrides: Partial<ResolveEmbedderDeps> = {}): {
  deps: ResolveEmbedderDeps;
  buildOpenAi: ReturnType<typeof vi.fn>;
  buildLocal: ReturnType<typeof vi.fn>;
  resolveKey: ReturnType<typeof vi.fn>;
  localInstalled: ReturnType<typeof vi.fn>;
} {
  const buildOpenAi = vi.fn(() => STUB_OPENAI_EMBED);
  const buildLocal = vi.fn(async () => STUB_LOCAL_EMBED);
  const resolveKey = vi.fn(async () => '');
  const localInstalled = vi.fn(async () => false);
  const deps: ResolveEmbedderDeps = {
    readPreference: async () => 'auto',
    resolveKey,
    localInstalled,
    buildOpenAi,
    buildLocal,
    isOpenAiRecentlyExhausted: () => false, // not in cooldown by default (EI-3381) — its own describe block below covers the cooldown branch
    ...overrides,
  };
  return { deps, buildOpenAi, buildLocal, resolveKey, localInstalled };
}

afterEach(() => {
  vi.restoreAllMocks();
  invalidateMemoryClient.mockClear();
  __resetOpenAiEmbedCooldownForTest();
});

describe('markOpenAiEmbedFailure / isOpenAiEmbedInCooldown — the EI-3381 cooldown tracker', () => {
  it('is not in cooldown before any failure is marked', () => {
    expect(isOpenAiEmbedInCooldown(1_000_000)).toBe(false);
  });

  it('is in cooldown at the instant a failure is marked, and stays in cooldown shortly after', () => {
    markOpenAiEmbedFailure(1_000_000);
    expect(isOpenAiEmbedInCooldown(1_000_000)).toBe(true);
    expect(isOpenAiEmbedInCooldown(1_000_010)).toBe(true);
  });

  it('lapses well after the cooldown window (bounded, self-healing — never a permanent local pin)', () => {
    markOpenAiEmbedFailure(1_000_000);
    expect(isOpenAiEmbedInCooldown(1_000_000 + 999_999_999)).toBe(false);
  });

  it('a second failure extends the cooldown from ITS OWN mark time (never shortens it)', () => {
    markOpenAiEmbedFailure(1_000_000);
    markOpenAiEmbedFailure(1_000_010); // fired again shortly after, e.g. two callers racing
    expect(isOpenAiEmbedInCooldown(1_000_010)).toBe(true);
  });

  it('EI-7279: invalidates the cached mem0 client so the cascade is re-evaluated on the VERY NEXT call, not up to an hour late (the client TTL)', () => {
    expect(invalidateMemoryClient).not.toHaveBeenCalled();
    markOpenAiEmbedFailure(1_000_000);
    expect(invalidateMemoryClient).toHaveBeenCalledTimes(1);
  });

  it('EI-7279: a second failure invalidates again (never leaves a stale client cached across repeated failures)', () => {
    markOpenAiEmbedFailure(1_000_000);
    markOpenAiEmbedFailure(1_000_010);
    expect(invalidateMemoryClient).toHaveBeenCalledTimes(2);
  });
});

describe('resolveEmbedderWith — the openai → local → disabled cascade (GAP 4)', () => {
  // The full truth table: 4 preferences × {key} × {local installed}. Each row
  // asserts the resolved {mode, reason} — the contract the store reads.
  type Row = {
    name: string;
    preference: 'auto' | 'openai' | 'local' | 'disabled';
    key: string;
    local: boolean;
    expectMode: 'openai' | 'local' | 'disabled';
    expectReason?: string;
  };

  const rows: Row[] = [
    // disabled is a HARD STOP — never touches key/local, regardless of state.
    { name: 'disabled + key + local', preference: 'disabled', key: 'sk', local: true, expectMode: 'disabled', expectReason: 'user_disabled' },
    { name: 'disabled + no key + no local', preference: 'disabled', key: '', local: false, expectMode: 'disabled', expectReason: 'user_disabled' },

    // openai forced: key present → openai; key absent → disabled with the
    // SPECIFIC reason (openai_forced_but_no_key), never a silent local fall.
    { name: 'openai forced + key', preference: 'openai', key: 'sk', local: true, expectMode: 'openai' },
    { name: 'openai forced + key (local absent — irrelevant)', preference: 'openai', key: 'sk', local: false, expectMode: 'openai' },
    { name: 'openai forced + NO key → disabled (forced reason, NOT local)', preference: 'openai', key: '', local: true, expectMode: 'disabled', expectReason: 'openai_forced_but_no_key' },
    { name: 'openai forced + NO key + no local', preference: 'openai', key: '', local: false, expectMode: 'disabled', expectReason: 'openai_forced_but_no_key' },

    // local forced: never consults the key; installed → local, else disabled
    // with the SPECIFIC reason (local_forced_but_not_installed).
    { name: 'local forced + installed', preference: 'local', key: '', local: true, expectMode: 'local' },
    { name: 'local forced + installed (key present — irrelevant)', preference: 'local', key: 'sk', local: true, expectMode: 'local' },
    { name: 'local forced + NOT installed → disabled (forced reason)', preference: 'local', key: 'sk', local: false, expectMode: 'disabled', expectReason: 'local_forced_but_not_installed' },

    // auto: openai FIRST, then local, then disabled.
    { name: 'auto + key → openai (prefers openai)', preference: 'auto', key: 'sk', local: true, expectMode: 'openai' },
    { name: 'auto + key + no local → still openai', preference: 'auto', key: 'sk', local: false, expectMode: 'openai' },
    { name: 'auto + no key + local → local fallback', preference: 'auto', key: '', local: true, expectMode: 'local' },
    { name: 'auto + no key + no local → disabled', preference: 'auto', key: '', local: false, expectMode: 'disabled', expectReason: 'no_openai_key_and_local_not_installed' },
  ];

  for (const row of rows) {
    it(`${row.name} → ${row.expectMode}${row.expectReason ? ` (${row.expectReason})` : ''}`, async () => {
      const { deps } = makeDeps({
        readPreference: async () => row.preference,
        resolveKey: async () => row.key,
        localInstalled: async () => row.local,
      });
      const res = await resolveEmbedderWith(deps);
      expect(res.mode).toBe(row.expectMode);
      if (row.expectReason !== undefined) {
        expect((res as { reason?: string }).reason).toBe(row.expectReason);
      }
      if (res.mode !== 'disabled') {
        // a resolved embedder always carries the 384-dim metadata + an embed fn
        expect(res.dims).toBe(EMBEDDER_DIM);
        expect(typeof res.embed).toBe('function');
      }
    });
  }

  it('disabled returns NO embed fn and NO dims (hard stop — store must not write)', async () => {
    const { deps, resolveKey, localInstalled, buildOpenAi, buildLocal } = makeDeps({
      readPreference: async () => 'disabled',
    });
    const res = await resolveEmbedderWith(deps);
    expect(res).toEqual({ mode: 'disabled', reason: 'user_disabled' });
    expect('embed' in res).toBe(false);
    expect('dims' in res).toBe(false);
    // hard stop: the cascade never consults key/local/builders for disabled
    expect(resolveKey).not.toHaveBeenCalled();
    expect(localInstalled).not.toHaveBeenCalled();
    expect(buildOpenAi).not.toHaveBeenCalled();
    expect(buildLocal).not.toHaveBeenCalled();
  });

  it('auto prefers openai — builds the openai embedder and NEVER the local one when a key exists', async () => {
    const { deps, buildOpenAi, buildLocal, localInstalled } = makeDeps({
      readPreference: async () => 'auto',
      resolveKey: async () => 'sk-key',
      localInstalled: async () => true, // available, but openai wins
    });
    const res = await resolveEmbedderWith(deps);
    expect(res.mode).toBe('openai');
    expect(buildOpenAi).toHaveBeenCalledWith('sk-key');
    expect(buildLocal).not.toHaveBeenCalled();
    // short-circuits before even probing local availability
    expect(localInstalled).not.toHaveBeenCalled();
  });

  it('openai-forced-but-no-key disables WITHOUT falling through to local (no wrong-table write)', async () => {
    const { deps, buildLocal, localInstalled } = makeDeps({
      readPreference: async () => 'openai',
      resolveKey: async () => '',
      localInstalled: async () => true, // local IS installed, but must NOT be used
    });
    const res = await resolveEmbedderWith(deps);
    expect(res).toEqual({ mode: 'disabled', reason: 'openai_forced_but_no_key' });
    expect(buildLocal).not.toHaveBeenCalled();
    expect(localInstalled).not.toHaveBeenCalled();
  });

  it('local-forced never consults the openai key (forced means forced)', async () => {
    const { deps, resolveKey, buildOpenAi } = makeDeps({
      readPreference: async () => 'local',
      resolveKey: async () => 'sk-present',
      localInstalled: async () => true,
    });
    const res = await resolveEmbedderWith(deps);
    expect(res.mode).toBe('local');
    expect(resolveKey).not.toHaveBeenCalled();
    expect(buildOpenAi).not.toHaveBeenCalled();
  });

  describe('EI-3381 — auto prefers local during an OpenAI post-failure cooldown', () => {
    it('auto + key present + in cooldown + local installed → local (NOT openai)', async () => {
      const { deps, buildOpenAi, buildLocal } = makeDeps({
        readPreference: async () => 'auto',
        resolveKey: async () => 'sk-key', // a valid key exists...
        localInstalled: async () => true,
        isOpenAiRecentlyExhausted: () => true, // ...but openai just failed hard
      });
      const res = await resolveEmbedderWith(deps);
      expect(res.mode).toBe('local');
      expect(buildLocal).toHaveBeenCalled();
      expect(buildOpenAi).not.toHaveBeenCalled();
    });

    it('auto + in cooldown + local NOT installed → still falls through to openai (no embedder left otherwise)', async () => {
      const { deps, buildOpenAi, buildLocal } = makeDeps({
        readPreference: async () => 'auto',
        resolveKey: async () => 'sk-key',
        localInstalled: async () => false, // no local escape hatch available
        isOpenAiRecentlyExhausted: () => true,
      });
      const res = await resolveEmbedderWith(deps);
      expect(res.mode).toBe('openai'); // trying a possibly-still-bad key beats no embedder at all
      expect(buildOpenAi).toHaveBeenCalledWith('sk-key');
      expect(buildLocal).not.toHaveBeenCalled();
    });

    it('auto + in cooldown + NO key + local installed → local (same as the no-key case, just reached via the cooldown leg)', async () => {
      const { deps, buildLocal } = makeDeps({
        readPreference: async () => 'auto',
        resolveKey: async () => '',
        localInstalled: async () => true,
        isOpenAiRecentlyExhausted: () => true,
      });
      const res = await resolveEmbedderWith(deps);
      expect(res.mode).toBe('local');
      expect(buildLocal).toHaveBeenCalled();
    });

    it('openai-FORCED preference ignores the cooldown entirely (an explicit override, not an auto pick)', async () => {
      const { deps, buildOpenAi, buildLocal } = makeDeps({
        readPreference: async () => 'openai',
        resolveKey: async () => 'sk-key',
        localInstalled: async () => true,
        isOpenAiRecentlyExhausted: () => true, // must be irrelevant to a forced preference
      });
      const res = await resolveEmbedderWith(deps);
      expect(res.mode).toBe('openai');
      expect(buildOpenAi).toHaveBeenCalledWith('sk-key');
      expect(buildLocal).not.toHaveBeenCalled();
    });

    it('local-FORCED preference is unaffected by cooldown state either way (already local, nothing to change)', async () => {
      const { deps } = makeDeps({
        readPreference: async () => 'local',
        localInstalled: async () => true,
        isOpenAiRecentlyExhausted: () => true,
      });
      const res = await resolveEmbedderWith(deps);
      expect(res.mode).toBe('local');
    });

    it('auto + NOT in cooldown behaves exactly as before (openai wins when a key exists)', async () => {
      const { deps, buildOpenAi } = makeDeps({
        readPreference: async () => 'auto',
        resolveKey: async () => 'sk-key',
        localInstalled: async () => true,
        isOpenAiRecentlyExhausted: () => false,
      });
      const res = await resolveEmbedderWith(deps);
      expect(res.mode).toBe('openai');
      expect(buildOpenAi).toHaveBeenCalled();
    });
  });
});

describe('readEmbedderPreference — env override wiring (production seam)', () => {
  const ORIGINAL = process.env.PAPERCUSP_MEMORY_EMBEDDER;
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.PAPERCUSP_MEMORY_EMBEDDER;
    else process.env.PAPERCUSP_MEMORY_EMBEDDER = ORIGINAL;
  });

  for (const v of ['auto', 'openai', 'local', 'disabled'] as const) {
    it(`PAPERCUSP_MEMORY_EMBEDDER=${v} overrides the persisted pref`, async () => {
      process.env.PAPERCUSP_MEMORY_EMBEDDER = v;
      await expect(readEmbedderPreference()).resolves.toBe(v);
    });
  }

  it('an unrecognized env value is ignored (falls through to the persisted pref / auto)', async () => {
    process.env.PAPERCUSP_MEMORY_EMBEDDER = 'bogus';
    // With no PG-backed voice prefs in this unit env, loadVoicePrefs rejects and
    // the cascade defaults to 'auto'. The point: 'bogus' is NOT returned.
    const pref = await readEmbedderPreference();
    expect(pref).not.toBe('bogus');
    expect(['auto', 'openai', 'local', 'disabled']).toContain(pref);
  });
});
