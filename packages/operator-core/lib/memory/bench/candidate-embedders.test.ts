import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ tokenizer: vi.fn(), model: vi.fn(), loadModel: vi.fn(), loadTokenizer: vi.fn() }));
vi.mock('@huggingface/transformers', () => ({
  AutoTokenizer: { from_pretrained: mocks.loadTokenizer },
  PreTrainedModel: { from_pretrained: mocks.loadModel },
}));
import { buildPplxBenchmarkEmbedder, loadCandidateVectors, PPLX_OUTPUT, PPLX_REVISION, benchmarkMaskedMean, referenceAssetPath, qualifyIncumbentReferences, type CandidateVectors } from './candidate-embedders';

describe('incumbent reference qualification', () => {
  it('resolves published locators locally and refuses machine-specific or escaping paths', () => {
    expect(referenceAssetPath('cache:validation/model/config.json', '/repo', '/person')).toBe('/person/.cache/papercusp/model-validation/model/config.json');
    expect(referenceAssetPath('cache:transformers/model/onnx/model.onnx', '/repo', '/person')).toBe('/repo/node_modules/@huggingface/transformers/.cache/model/onnx/model.onnx');
    for (const bad of ['/machine/private/config.json', 'cache:validation/../config.json', 'cache:unknown/config.json', 'cache:validation//config.json']) {
      expect(() => referenceAssetPath(bad, '/repo', '/person')).toThrow('invalid portable');
    }
  });
  it('uses only attended tokens for the independent mean and rejects invalid model output', () => {
    expect(benchmarkMaskedMean([2, 4, 4, 8, 999, 999], [1, 1, 0], 2)).toEqual([3, 6]);
    expect(() => benchmarkMaskedMean([1, 2], [0], 2)).toThrow('invalid');
    expect(() => benchmarkMaskedMean([NaN, 2], [1], 2)).toThrow('nonfinite');
    expect(() => benchmarkMaskedMean([1, 2, 3], [1], 2)).toThrow('invalid');
  });
  it('refuses an untrusted protocol SHA before any tokenizer/model construction', async () => {
    await expect(qualifyIncumbentReferences('/absent/reference.json', 'invalid', '/private/result.json')).rejects.toThrow('SHA mismatch');
    expect(mocks.loadTokenizer).not.toHaveBeenCalled(); expect(mocks.loadModel).not.toHaveBeenCalled();
  });
});

afterEach(() => vi.resetAllMocks());

describe('Perplexity publisher ONNX contract', () => {
  it('selects pooled int8 output, sends raw texts, pins weights, and reuses the loaded graph', async () => {
    mocks.tokenizer.mockReturnValue({ input_ids: 'tokens', attention_mask: 'mask' });
    mocks.loadTokenizer.mockResolvedValue(mocks.tokenizer);
    mocks.loadModel.mockResolvedValue(mocks.model);
    mocks.model.mockResolvedValue({ last_hidden_state: { data: new Float32Array(4096) }, [PPLX_OUTPUT]: { data: new Int8Array(1024).fill(7) } });
    const embed = buildPplxBenchmarkEmbedder();
    expect(await embed('stored document')).toEqual(new Array(1024).fill(7));
    await embed('search question');
    expect(mocks.tokenizer.mock.calls.map((x) => x[0])).toEqual(['stored document', 'search question']);
    expect(mocks.loadModel).toHaveBeenCalledOnce();
    expect(mocks.loadModel.mock.calls[0][1]).toMatchObject({ revision: PPLX_REVISION, device: 'cpu', dtype: 'fp32' });
  });

  it.each(['missing', 'token-level', 'zero'])('refuses a %s retrieval output rather than scoring a false loss', async (kind) => {
    mocks.tokenizer.mockReturnValue({});
    mocks.loadTokenizer.mockResolvedValue(mocks.tokenizer);
    mocks.loadModel.mockResolvedValue(mocks.model);
    mocks.model.mockResolvedValue(kind === 'missing' ? { last_hidden_state: { data: new Float32Array(1024) } } : {
      [PPLX_OUTPUT]: { data: new Int8Array(kind === 'token-level' ? 2048 : 1024) },
    });
    await expect(buildPplxBenchmarkEmbedder()('text')).rejects.toThrow(/missing|finite, nonzero/);
  });
});

describe('external inference evidence', () => {
  it('binds results to fixture bytes/order, rejects partial or invalid vectors, and preserves inference timings', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'candidate-vectors-test-'));
    try {
      const corpus = path.join(dir, 'corpus.json');
      const gold = path.join(dir, 'gold.json');
      const vectors = path.join(dir, 'vectors.json');
      fs.writeFileSync(corpus, '{"frozen":"corpus"}');
      fs.writeFileSync(gold, '{"frozen":"gold"}');
      const hash = (p: string) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
      const manifest: CandidateVectors = { name: 'candidate', model: 'test/model', revision: 'pinned', runtime: 'python', dimensions: 2, loadSeconds: 1, assetBytes: 100,
        suites: { memory: { corpusSha256: hash(corpus), goldSha256: hash(gold), keys: ['a'], queryIds: ['q'], docVectors: [[1, 0]], queryVectors: [[0, 1]], docSeconds: 3, querySeconds: 4, peakRssMB: 50 } } };
      const save = () => fs.writeFileSync(vectors, JSON.stringify(manifest));
      const read = () => loadCandidateVectors(vectors, 'memory', corpus, gold, ['a'], ['q']);
      save();
      expect(read().suite.docSeconds).toBe(3);
      expect(() => loadCandidateVectors(vectors, 'prose', corpus, gold, ['a'], ['q'])).toThrow('completed prose');
      const suite = manifest.suites.memory!;
      suite.keys = ['wrong']; save(); expect(read).toThrow('order mismatch');
      suite.keys = ['a']; suite.docVectors = []; save(); expect(read).toThrow('incomplete');
      suite.docVectors = [[1, 0, 0]]; save(); expect(read).toThrow('2-dimensional');
      suite.docVectors = [[0, 0]]; save(); expect(read).toThrow('nonzero');
      suite.docVectors = [[1, 0]]; suite.docSeconds = 0; save(); expect(read).toThrow('timing');
      suite.docSeconds = 3; suite.corpusSha256 = 'changed'; save(); expect(read).toThrow('fingerprint');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});
