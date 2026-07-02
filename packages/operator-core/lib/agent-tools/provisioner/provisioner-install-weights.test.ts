/**
 * provisioner-install-weights.test.ts — the `provisioner:install` tool's `pullWeights:true`
 * branch (WI-1598, mirroring the route coverage). Kept separate because this branch needs its
 * own mocked weight-pull + re-plan wiring without touching the real ollama CLI or local store.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const planProvisionMock = vi.fn();
const applyProvisionMock = vi.fn();
vi.mock('../../provisioner/provision', () => ({
  planProvision: (...args: unknown[]) => planProvisionMock(...args),
  applyProvision: (...args: unknown[]) => applyProvisionMock(...args),
}));

vi.mock('../../provisioner/hardware-detect', () => ({
  detectHardware: vi.fn(),
}));

vi.mock('../../provisioner/llama-binary', () => ({
  resolveLlamaBinary: vi.fn(),
  computeCapToArch: (cc: string) => cc.replace(/\./g, ''),
}));

vi.mock('../../provisioner/vllm-container', () => ({
  detectContainerRuntime: vi.fn(),
  pullVllmImage: vi.fn(),
  VLLM_PINNED_IMAGE: 'vllm/vllm-openai:v0.24.0',
}));

const pullOllamaWeightsMock = vi.fn();
vi.mock('../../provisioner/weights', () => ({
  pullOllamaWeights: (...args: unknown[]) => pullOllamaWeightsMock(...args),
}));

vi.mock('../../provisioner/recommend', () => ({ recommendCombo: vi.fn() }));

import { provisionerInstallTool } from './provisioner';

const body = (o: unknown) => JSON.parse((o as { content: { text: string }[] }).content[0]!.text);

beforeEach(() => {
  planProvisionMock.mockClear();
  applyProvisionMock.mockClear();
  pullOllamaWeightsMock.mockClear();
});

describe('provisioner:install pullWeights (WI-1598)', () => {
  it('pulls llama-server weights and re-plans before apply when requested', async () => {
    planProvisionMock
      .mockResolvedValueOnce({
        blocked: 'weights missing',
        recommendation: { entry: { backend: 'llama-server', model: { ollamaRef: 'maxwell1500/ornith-35b:IQ3_M' } } },
        weights: { needsDownload: true },
      })
      .mockResolvedValueOnce({
        blocked: null,
        recommendation: { entry: { backend: 'llama-server', model: { ollamaRef: 'maxwell1500/ornith-35b:IQ3_M' } } },
        weights: { needsDownload: false, weightsPath: '/blob' },
      });
    pullOllamaWeightsMock.mockResolvedValue({ ok: true, ollamaRef: 'maxwell1500/ornith-35b:IQ3_M' });
    applyProvisionMock.mockResolvedValue({ ok: true, wroteUnit: true, registered: true, started: false });

    const r = body(await provisionerInstallTool.handler({ pullWeights: true }, {} as never));

    expect(pullOllamaWeightsMock).toHaveBeenCalledWith('maxwell1500/ornith-35b:IQ3_M');
    expect(planProvisionMock).toHaveBeenCalledTimes(2);
    expect(applyProvisionMock).toHaveBeenCalledWith(expect.objectContaining({ blocked: null }), { start: false });
    expect(r.ok).toBe(true);
  });

  it('fails before apply when the pull is blocked', async () => {
    planProvisionMock.mockResolvedValue({
      blocked: 'weights missing',
      recommendation: { entry: { backend: 'llama-server', model: { ollamaRef: 'maxwell1500/ornith-35b:IQ3_M' } } },
      weights: { needsDownload: true },
    });
    pullOllamaWeightsMock.mockResolvedValue({ ok: false, blocked: 'ollama missing' });

    const r = body(await provisionerInstallTool.handler({ pullWeights: true }, {} as never));

    expect(r.ok).toBe(false);
    expect(r.error).toContain('ollama missing');
    expect(applyProvisionMock).not.toHaveBeenCalled();
  });
});
