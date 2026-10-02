import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ enabled: true, order: [] as string[], route: {} as Record<string, string | undefined> }));
vi.mock('@papercusp/flags', () => ({ FLAGS: { INFERENCE_GATEWAY: 'inference-gateway' } }));
vi.mock('@papercusp/flags/server', () => ({ getFlag: vi.fn(async () => { state.order.push('flag'); return state.enabled; }) }));
vi.mock('../../llm-testing/llm-client', () => ({ llmCall: vi.fn() }));
vi.mock('./judged', () => ({
  collectIndependentCohort: vi.fn(async () => {
    state.order.push('collect');
    state.route = { sdk: process.env.PAPERCUSP_ANTHROPIC_URL, cli: process.env.ANTHROPIC_BASE_URL };
    return { labels: { path: 'fixture-labels' }, judgments: { path: 'fixture-judgments' } };
  }),
  parseBlindTargetBudget: vi.fn((value: string) => value),
  runJudgedTier: vi.fn(), writeJudgedReport: vi.fn(),
}));
vi.mock('../../../../../scripts/lib/write-stdout-sync.mjs', () => ({ writeStdoutSync: vi.fn() }));

describe('blind collector CLI gateway entry (WI-10005666)', () => {
  const originalArgv = process.argv;
  beforeEach(() => {
    vi.resetModules(); state.enabled = true; state.order = []; state.route = {};
    vi.stubEnv('PAPERCUSP_GATEWAY_PORT', '18788');
    vi.stubEnv('PAPERCUSP_ANTHROPIC_URL', undefined); vi.stubEnv('ANTHROPIC_BASE_URL', undefined);
    process.argv = [process.execPath, 'judged-cli.ts', '--label-cohort', '--snapshot', 'fixture', '--label-out', 'fixture'];
    vi.spyOn(process, 'exit').mockImplementation((code) => { throw new Error(`fixture-exit-${code}`); });
  });
  afterEach(() => { process.argv = originalArgv; vi.restoreAllMocks(); vi.unstubAllEnvs(); });
  const enter = () => expect(import('./judged-cli')).rejects.toThrow('fixture-exit-0');
  it('configures both SDK and subprocess gateway endpoints before the first blind collection call', async () => {
    await enter();
    expect(state.order).toEqual(['flag', 'collect']);
    expect(state.route).toEqual({ sdk: 'http://127.0.0.1:18788', cli: 'http://127.0.0.1:18788' });
  });
  it('replaces inherited direct-API defaults while preserving explicit custom endpoint selection', async () => {
    vi.stubEnv('PAPERCUSP_ANTHROPIC_URL', 'https://api.anthropic.com');
    vi.stubEnv('ANTHROPIC_BASE_URL', 'http://127.0.0.1:18789');
    await enter();
    expect(state.route).toEqual({ sdk: 'http://127.0.0.1:18788', cli: 'http://127.0.0.1:18789' });
  });
  it('leaves endpoints untouched when the standing gateway flag is disabled', async () => {
    state.enabled = false; await enter();
    expect(state.order).toEqual(['flag', 'collect']);
    expect(state.route).toEqual({ sdk: undefined, cli: undefined });
  });
});
