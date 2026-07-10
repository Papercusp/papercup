/**
 * registered-concerns.test.ts — the override mechanisms unified under the config-override
 * registry in sentinel-herald Phase 8 P-037.
 *
 * For each newly-registered concern (rate-limit-config, agent-config, voice-prefs,
 * account-session-override) this asserts:
 *   • it appears in config:list-overrides (i.e. registerOverrideConcern ran at module load), and
 *   • after a write, diff() reports the override, and reset() clears it (diff() goes empty).
 *
 * The operator-state PG layer is replaced with an in-memory store keyed by table name, so the
 * concerns' real read/diff/reset/restore logic runs with NO database. The rate-limit governor
 * host-seam + SSE bus are stubbed so importing rate-limit-config doesn't touch process globals.
 *
 * Run: cd packages/operator-core && npx vitest run lib/config-overrides/registered-concerns.test.ts
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

// In-memory operator-state store keyed by table name (single active workspace in the test).
const store = new Map<string, unknown>();
vi.mock('../operator-state-pg', () => ({
  readOperatorState: vi.fn(async (table: string) => (store.has(table) ? store.get(table) : null)),
  writeOperatorState: vi.fn(async (table: string, payload: unknown) => { store.set(table, payload); }),
  updateOperatorState: vi.fn(async (table: string, def: unknown, mut: (cur: unknown) => unknown) => {
    const next = mut(store.has(table) ? store.get(table) : def);
    store.set(table, next);
    return next;
  }),
  invalidateOperatorStateCache: vi.fn(),
}));
vi.mock('../workspace-registry', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  activeWorkspaceId: () => 'default',
}));
// rate-limit-config imports the governor host-seam + SSE bus at module load — stub them so the
// import is side-effect-free in the test process.
vi.mock('@papercusp/papercusp-shared/agent', () => ({
  // The mock replaces the WHOLE module, so it must carry every named export the SUT
  // (rate-limit-config.applyCached) imports — it lagged when governor-registry.ts
  // grew the provider-floor + AIMD tuning surface (a missing-mock-export drift).
  setGlobalConcurrencyCap: vi.fn(),
  setGlobalConcurrencyFloor: vi.fn(),
  setProviderFloorOverride: vi.fn(),
  setAimdTuning: vi.fn(),
  AIMD_CLEAN_TURNS_PER_STEP: 5,
}));
vi.mock('@papercusp/sse', () => ({
  getChannel: () => ({ onPublish: vi.fn(), publish: vi.fn() }),
}));
// agent-config writes a shell env file + mirrors process.env; the fs write is best-effort
// (already try/catch'd) and process.env mirroring is harmless in-test, so no extra mocking needed.

import { listOverrideConcerns, getOverrideConcern } from './registry';

// Import the concern store modules so their registerOverrideConcern side-effects run.
import { writeRateLimitConfig } from '../rate-limit-config';
import { writeAgentConfig, readAgentConfig } from '../agent-config';
import { saveVoicePrefs } from '../voice-prefs';
import { setAccountOverride } from '../deployment/account-session-override';

beforeEach(() => {
  store.clear();
});

const CONCERNS = ['rate-limit-config', 'agent-config', 'voice-prefs', 'account-session-override'] as const;

describe('P-037 newly-registered override concerns', () => {
  it('all four appear in the override registry (config:list-overrides surface)', () => {
    const names = new Set(listOverrideConcerns().map((c) => c.name));
    for (const c of CONCERNS) expect(names.has(c)).toBe(true);
  });

  it('every registered concern exposes diff + capture + reset + restore', () => {
    for (const name of CONCERNS) {
      const c = getOverrideConcern(name)!;
      expect(typeof c.diff).toBe('function');
      expect(typeof c.capture).toBe('function');
      expect(typeof c.reset).toBe('function');
      expect(typeof c.restore).toBe('function');
    }
  });

  it('rate-limit-config: write surfaces in diff, reset clears it', async () => {
    const c = getOverrideConcern('rate-limit-config')!;
    expect(await c.diff()).toEqual([]); // clean default
    await writeRateLimitConfig({ maxSimultaneousAgents: 2, concurrencyFloor: 2 });
    const diff = await c.diff();
    expect(diff.map((e) => e.key).sort()).toEqual(['concurrencyFloor', 'maxSimultaneousAgents']);
    await c.reset();
    expect(await c.diff()).toEqual([]);
  });

  it('agent-config: backend + model overrides surface in diff, reset clears them', async () => {
    const c = getOverrideConcern('agent-config')!;
    expect(await c.diff()).toEqual([]);
    await writeAgentConfig({
      backend: 'omp', cmd: 'omp -p', models: { worker: 'haiku' },
      backends: {}, surfaceModels: {}, tiers: [], tierCeilings: {},
    });
    const keys = (await c.diff()).map((e) => e.key).sort();
    expect(keys).toEqual(['backend', 'cmd', 'models']);
    await c.reset();
    expect(await c.diff()).toEqual([]);
    // reset wrote the default back
    expect((await readAgentConfig()).backend).toBe('claude-code');
  });

  it('voice-prefs: a flipped toggle surfaces in diff, reset clears it', async () => {
    const c = getOverrideConcern('voice-prefs')!;
    expect(await c.diff()).toEqual([]);
    // speakModeFlips defaults OFF (false) → flip ON to create an override.
    await saveVoicePrefs({ speakModeFlips: true });
    const diff = await c.diff();
    expect(diff.find((e) => e.key === 'speakModeFlips')?.effective).toBe(true);
    await c.reset();
    expect(await c.diff()).toEqual([]);
  });

  it('account-session-override: a forced-account steer surfaces in diff, reset clears it', async () => {
    const c = getOverrideConcern('account-session-override')!;
    expect(await c.diff()).toEqual([]);
    await setAccountOverride('default', { forcedAccounts: ['acct-1'] });
    const diff = await c.diff();
    expect(diff).toEqual([{ key: 'forcedAccounts', effective: ['acct-1'], default: [], layer: 'pg-settings' }]);
    await c.reset();
    expect(await c.diff()).toEqual([]);
  });

  it('capture → reset → restore round-trips an override (the audited-reset revert primitive)', async () => {
    const c = getOverrideConcern('rate-limit-config')!;
    await writeRateLimitConfig({ maxSimultaneousAgents: 2, concurrencyFloor: 1 });
    const snap = await c.capture();
    await c.reset();
    expect(await c.diff()).toEqual([]);
    await c.restore(snap);
    expect((await c.diff()).find((e) => e.key === 'maxSimultaneousAgents')?.effective).toBe(2);
  });
});
