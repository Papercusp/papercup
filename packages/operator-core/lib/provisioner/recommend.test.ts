import { describe, expect, it } from 'vitest';
import { recommendCombo, tierOf } from './recommend';
import type { DetectedHardware } from './hardware-detect';
import type { CatalogEntry } from './catalog';

function hw(overrides: Partial<DetectedHardware> = {}): DetectedHardware {
  return { platform: 'linux', arch: 'x64', ramGB: 64, gpu: null, notes: [], ...overrides };
}

describe('tierOf', () => {
  it('buckets a 24GB+ NVIDIA card', () => {
    expect(tierOf(hw({ gpu: { vendor: 'nvidia', vramGB: 24 } }))).toBe('nvidia-24gb-plus');
    expect(tierOf(hw({ gpu: { vendor: 'nvidia', vramGB: 48 } }))).toBe('nvidia-24gb-plus');
  });
  it('buckets mid and low NVIDIA tiers', () => {
    expect(tierOf(hw({ gpu: { vendor: 'nvidia', vramGB: 16 } }))).toBe('nvidia-mid');
    expect(tierOf(hw({ gpu: { vendor: 'nvidia', vramGB: 8 } }))).toBe('nvidia-low');
  });
  it('buckets Apple Silicon separately', () => {
    expect(tierOf(hw({ gpu: { vendor: 'apple', vramGB: 36, unifiedMemory: true } }))).toBe('apple-silicon');
  });
  it('falls back to cpu-only for no GPU or an unmapped vendor (e.g. AMD, not yet catalogued)', () => {
    expect(tierOf(hw({ gpu: null }))).toBe('cpu-only');
    expect(tierOf(hw({ gpu: { vendor: 'amd', vramGB: 24 } }))).toBe('cpu-only');
  });
});

describe('recommendCombo', () => {
  it('recommends the ornith entry for a 24GB NVIDIA card (real ornith-box shape)', () => {
    const rec = recommendCombo(hw({ gpu: { vendor: 'nvidia', model: 'NVIDIA GeForce RTX 3090', vramGB: 24 } }));
    expect(rec.entry?.id).toBe('ornith-35b-iq3m-llama-server');
    expect(rec.tier).toBe('nvidia-24gb-plus');
    // ornith entry #1 is now CERTIFIED by the P-006 cert battery (was provisional).
    expect(rec.reason).toMatch(/CERTIFIED by the P-006 battery/);
    expect(rec.reason).not.toMatch(/PROVISIONAL/);
  });

  it('returns no entry + a cloud-fallback reason for cpu-only hardware', () => {
    const rec = recommendCombo(hw({ gpu: null }));
    expect(rec.entry).toBeNull();
    expect(rec.tier).toBe('cpu-only');
    expect(rec.reason).toMatch(/cloud gateway/);
  });

  it('returns no entry when VRAM is below the tier minimum', () => {
    const rec = recommendCombo(hw({ gpu: { vendor: 'nvidia', vramGB: 6 } }));
    expect(rec.entry).toBeNull();
    expect(rec.tier).toBe('nvidia-low');
  });

  it('picks the largest fitting model when multiple candidates match a tier', () => {
    const catalog: CatalogEntry[] = [
      {
        id: 'small',
        displayName: 'small model',
        backend: 'llama-server',
        model: { ollamaRef: 'x/small:Q4', quant: 'Q4', sizeGB: 5 },
        hardwareTier: 'nvidia-24gb-plus',
        minVramGB: 24,
        serve: { host: '127.0.0.1', portDefault: 11001, parallelSlots: 1, ctxTotal: 8192, kvCacheType: 'f16', flashAttn: false },
        status: 'certified',
        sourceRef: 'test',
      },
      {
        id: 'big',
        displayName: 'big model',
        backend: 'llama-server',
        model: { ollamaRef: 'x/big:Q4', quant: 'Q4', sizeGB: 20 },
        hardwareTier: 'nvidia-24gb-plus',
        minVramGB: 24,
        serve: { host: '127.0.0.1', portDefault: 11002, parallelSlots: 1, ctxTotal: 8192, kvCacheType: 'f16', flashAttn: false },
        status: 'certified',
        sourceRef: 'test',
      },
    ];
    const rec = recommendCombo(hw({ gpu: { vendor: 'nvidia', vramGB: 24 } }), catalog);
    expect(rec.entry?.id).toBe('big');
    expect(rec.reason).not.toMatch(/PROVISIONAL/);
  });

  it('reports no combo yet for a tier the catalog has nothing in', () => {
    const rec = recommendCombo(hw({ gpu: { vendor: 'nvidia', vramGB: 16 } }), []);
    expect(rec.entry).toBeNull();
    expect(rec.reason).toMatch(/no catalog combo targets tier/);
  });

  describe('containerRuntimeAvailable gate (D-009 #3 — downgrade to llama-server)', () => {
    const vllmEntry: CatalogEntry = {
      id: 'awq-vllm',
      displayName: 'awq model via vLLM',
      backend: 'vllm',
      model: { ollamaRef: 'awq-model', quant: 'AWQ', sizeGB: 20, hfRepo: 'org/awq-model', quantization: 'awq' },
      hardwareTier: 'nvidia-24gb-plus',
      minVramGB: 24,
      serve: { host: '127.0.0.1', portDefault: 8000, parallelSlots: 4, ctxTotal: 65536, kvCacheType: 'n/a', flashAttn: false, gpuMemoryUtilization: 0.9 },
      status: 'provisional',
      sourceRef: 'test',
    };
    const llamaServerEntry: CatalogEntry = {
      id: 'small-llama-server',
      displayName: 'small model via llama-server',
      backend: 'llama-server',
      model: { ollamaRef: 'x/small:Q4', quant: 'Q4', sizeGB: 5 },
      hardwareTier: 'nvidia-24gb-plus',
      minVramGB: 24,
      serve: { host: '127.0.0.1', portDefault: 11001, parallelSlots: 1, ctxTotal: 8192, kvCacheType: 'f16', flashAttn: false },
      status: 'certified',
      sourceRef: 'test',
    };

    it('prefers the (bigger) vllm candidate when containerRuntimeAvailable is unset (default, backward-compatible)', () => {
      const rec = recommendCombo(hw({ gpu: { vendor: 'nvidia', vramGB: 24 } }), [llamaServerEntry, vllmEntry]);
      expect(rec.entry?.id).toBe('awq-vllm');
    });

    it('still prefers the vllm candidate when containerRuntimeAvailable is explicitly true', () => {
      const rec = recommendCombo(hw({ gpu: { vendor: 'nvidia', vramGB: 24 } }), [llamaServerEntry, vllmEntry], { containerRuntimeAvailable: true });
      expect(rec.entry?.id).toBe('awq-vllm');
    });

    it('skips the vllm candidate and downgrades to llama-server when containerRuntimeAvailable is false', () => {
      const rec = recommendCombo(hw({ gpu: { vendor: 'nvidia', vramGB: 24 } }), [llamaServerEntry, vllmEntry], { containerRuntimeAvailable: false });
      expect(rec.entry?.id).toBe('small-llama-server');
      expect(rec.reason).toMatch(/vLLM candidate was skipped/);
    });

    it('reports no combo (with the skip noted) when vllm was the ONLY candidate for the tier and no runtime is available', () => {
      const rec = recommendCombo(hw({ gpu: { vendor: 'nvidia', vramGB: 24 } }), [vllmEntry], { containerRuntimeAvailable: false });
      expect(rec.entry).toBeNull();
      expect(rec.reason).toMatch(/no catalog combo targets tier/);
      expect(rec.reason).toMatch(/skipping vLLM candidates/);
    });
  });
});
