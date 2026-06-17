import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  resolveEmbedderWith,
  readEmbedderPreference,
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
    ...overrides,
  };
  return { deps, buildOpenAi, buildLocal, resolveKey, localInstalled };
}

afterEach(() => vi.restoreAllMocks());

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
