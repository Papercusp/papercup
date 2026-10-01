/**
 * EI-24688584300743328: the D-022(a) benchmark fixture must cover EVERY local
 * embedder cascade, not only the memory host.
 *
 * Measured failure: with the fixture installed, the P-013 benchmark parent
 * still constructed the real gemma ONNX model (onnxruntime CUDA, ~5 GB of GPU)
 * through search/embed-backfill → buildSidecarAwareEmbedder, a cascade the
 * memory-host swap does not reach. The fixture now also installs the
 * process-wide local-engine override in embed-sidecar-wiring; these tests pin
 * that the override serves all three local spaces from the fixture counter,
 * does no sidecar I/O, and that the negative control fails on real evidence.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { EMBEDDER_DIM_SPECS } from '@papercusp/memory';
import {
  buildSidecarAwareEmbedder,
  hasLocalEmbedEngineOverride,
  setLocalEmbedEngineOverride,
} from '../lib/memory/embed-sidecar-wiring';
import {
  assertNoLocalModelLoaded,
  deterministicEmbedding,
  installDeterministicEmbedder,
  localModelLoadEvidence,
} from './_deterministic-embedder';

/** Sidecar deps that fail the test if the override ever lets resolution run. */
const forbiddenSidecarDeps = {
  resolveUrl: (): string | null => {
    throw new Error('sidecar URL resolution ran although the fixture override is installed');
  },
  ensure: async (): Promise<string | null> => {
    throw new Error('sidecar ensure ran although the fixture override is installed');
  },
  probeHealth: async (): Promise<unknown> => {
    throw new Error('sidecar probe ran although the fixture override is installed');
  },
};

afterAll(() => setLocalEmbedEngineOverride(null));

describe('installDeterministicEmbedder covers the sidecar-aware local cascade', () => {
  it('serves gemma, harrier and local builds from the fixture, at each space width, with no sidecar I/O', async () => {
    const fixture = await installDeterministicEmbedder();
    expect(hasLocalEmbedEngineOverride()).toBe(true);
    const before = fixture.calls();

    for (const model of ['gemma', 'harrier', 'local'] as const) {
      for (const kind of ['document', 'query'] as const) {
        const embed = await buildSidecarAwareEmbedder(model, kind, forbiddenSidecarDeps);
        const vector = await embed(`text for ${model}:${kind}`);
        expect(vector).toHaveLength(EMBEDDER_DIM_SPECS[model].targetDims);
        expect(vector).toEqual(deterministicEmbedding(`text for ${model}:${kind}`, EMBEDDER_DIM_SPECS[model].targetDims));
      }
    }

    // Positive control: every one of the six embeds was counted.
    expect(fixture.calls() - before).toBe(6);
    // Negative control: nothing above constructed a real local model.
    expect(assertNoLocalModelLoaded('deterministic-embedder.test')).toEqual(localModelLoadEvidence());
  });

  it('an override returning null falls through to the normal cascade', async () => {
    let consulted = 0;
    setLocalEmbedEngineOverride(() => {
      consulted++;
      return null;
    });
    try {
      // Fall-through reaches sidecar resolution, which the forbidden deps reject.
      await expect(buildSidecarAwareEmbedder('gemma', 'document', forbiddenSidecarDeps)).rejects.toThrow(
        /sidecar URL resolution ran/,
      );
      expect(consulted).toBe(1);
    } finally {
      setLocalEmbedEngineOverride(null);
    }
    expect(hasLocalEmbedEngineOverride()).toBe(false);
  });
});

describe('assertNoLocalModelLoaded', () => {
  it('passes on clean evidence', () => {
    const clean = { pipelines: {}, workerAlive: false, onnxruntimeMappings: [] };
    expect(assertNoLocalModelLoaded('clean', clean)).toBe(clean);
  });

  it.each([
    ['a constructed pipeline', { pipelines: { 'onnx-community/embeddinggemma-300m-ONNX': 'cuda' }, workerAlive: false, onnxruntimeMappings: [] }, /ONNX pipelines constructed/],
    ['a live worker thread', { pipelines: {}, workerAlive: true, onnxruntimeMappings: [] }, /worker thread is alive/],
    ['an onnxruntime mapping', { pipelines: {}, workerAlive: false, onnxruntimeMappings: ['/x/libonnxruntime.so.1'] }, /onnxruntime is mapped/],
  ])('throws on %s', (_label, evidence, message) => {
    expect(() => assertNoLocalModelLoaded('dirty', evidence)).toThrow(message);
  });
});
