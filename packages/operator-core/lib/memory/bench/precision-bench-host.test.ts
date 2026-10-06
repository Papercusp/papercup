import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  configureMemory: vi.fn(),
  getHarnessAdminUrl: vi.fn(() => 'postgres://bench-host'),
  readCredentials: vi.fn(async () => ({ openai_api_key: 'openai-test', anthropic_api_key: 'anthropic-test' })),
  buildEmbedderForMode: vi.fn(async () => vi.fn(async () => [1, 2, 3])),
  resolveEmbedderForMode: vi.fn(async (mode: string) => ({
    mode,
    dims: 768,
    profile: { targetDims: 768 },
    embed: vi.fn(async () => [1, 2, 3]),
  })),
}));

vi.mock('@papercusp/memory', () => ({ configureMemory: mocks.configureMemory }));
vi.mock('../../credentials', () => ({ readCredentials: mocks.readCredentials }));
vi.mock('../../embedded-pg-discovery', () => ({ getHarnessAdminUrl: mocks.getHarnessAdminUrl }));
vi.mock('../worker-embedder', () => ({
  buildEmbedderForMode: mocks.buildEmbedderForMode,
  resolveEmbedderForMode: mocks.resolveEmbedderForMode,
}));

import {
  configurePrecisionBenchMemoryHost,
  createPrecisionBenchMemoryHost,
  PRECISION_BENCH_EMBEDDER_MODE_ENV,
} from './precision-bench-host';

describe('precision bench host bootstrap', () => {
  beforeEach(() => vi.clearAllMocks());

  it('configures the isolated process with the resolved embedder and bench-safe host seams', async () => {
    const host = createPrecisionBenchMemoryHost('gemma');
    expect(host.schema).toBe('harness_shared');
    expect(host.defaultDbName).toBe('papercusp');
    expect(host.localStoreDir).toBeNull();
    expect(host.backend).toBe('mem0');
    expect(host.getAdminUrl()).toBe('postgres://bench-host');
    expect(await host.getCredentials()).toEqual({
      openai_api_key: 'openai-test',
      anthropic_api_key: 'anthropic-test',
    });
    expect((await host.resolveEmbedder()).mode).toBe('gemma');
    expect(mocks.resolveEmbedderForMode).toHaveBeenCalledWith('gemma');
    expect(host.buildEmbedderForMode).toBe(mocks.buildEmbedderForMode);
  });

  it('installs the host only when the child received the resolved mode', () => {
    configurePrecisionBenchMemoryHost('local');
    expect(mocks.configureMemory).toHaveBeenCalledWith(expect.objectContaining({ schema: 'harness_shared' }));
    expect(() => configurePrecisionBenchMemoryHost(undefined)).toThrow(PRECISION_BENCH_EMBEDDER_MODE_ENV);
    expect(() => createPrecisionBenchMemoryHost('auto')).toThrow(/resolved embedder mode/);
  });
});
