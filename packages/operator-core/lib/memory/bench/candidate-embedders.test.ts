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
import { buildPplxBenchmarkEmbedder, loadCandidateVectors, PPLX_OUTPUT, PPLX_REVISION, benchmarkMaskedMean, referenceAssetPath, qualifyIncumbentReferences, summarizeIncumbentReferences,
  validateNativeBoundaryRequest, summarizeNativeBoundaries, qualifyMdenseOnBoundaries, MDENSEON_BOUNDARY_IDS,
  type NativeBoundaryRequest, type NativeBoundaryRow, type CandidateVectors } from './candidate-embedders';
import { incumbentReferenceFixture } from './fixtures/incumbent-reference';

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
  it('keeps three recipes, computes all token/vector/rank comparisons and reports a zero measured tokenizer effect', () => {
    const { native, python } = incumbentReferenceFixture();
    const summary = summarizeIncumbentReferences(native, python);
    expect(summary.arms.map((a) => [a.caseCount, a.tokenMatches, a.passed, a.rankings.exactRankAgreements])).toEqual([[16, 16, true, 8], [16, 16, true, 8], [16, 16, true, 8]]);
    expect(summary.correctedGemmaEffect).toMatchObject({ population: 16, changedTokenCases: [], rankingQueriesChanged: [], minimumCosine: 1 });
    expect(mocks.loadTokenizer).not.toHaveBeenCalled(); expect(mocks.loadModel).not.toHaveBeenCalled();
  });
  it('refuses the exact falsifier: corrected and shipped arms under one recipe identity', () => {
    const { native, python } = incumbentReferenceFixture();
    native.arms[1].profileId = native.arms[0].profileId;
    expect(() => summarizeIncumbentReferences(native, python)).toThrow('identity collision');
  });
  it('reports a tokenizer/vector/ranking loss using actual arrays without accepting producer PASS metadata', () => {
    const { native, python } = incumbentReferenceFixture();
    native.arms[0].cases[0].inputIds = [99]; native.arms[0].cases[0].attentionMask = [1];
    native.arms[0].cases[0].vector = [...native.arms[0].cases[2].vector];
    const summary = summarizeIncumbentReferences(native, python);
    expect(summary.arms[0]).toMatchObject({ tokenMatches: 15, passed: false, minimumCosine: 0 });
    expect(summary.arms[0].rankings.exactRankAgreements).toBe(7);
    expect(summary.correctedGemmaEffect.changedTokenCases).toEqual(['query-plain']);
    expect(summary.correctedGemmaEffect.rankingQueriesChanged).toEqual(['query-plain']);
  });
  it.each(['missing-case', 'wrong-prompt', 'wrong-model', 'nonfinite', 'no-worker', 'unversioned', 'unpinned'])('refuses %s evidence', (failure) => {
    const { native, python } = incumbentReferenceFixture();
    if (failure === 'missing-case') python.arms[0].cases.pop();
    if (failure === 'wrong-prompt') native.arms[0].cases[0].promptedText = native.arms[0].cases[1].promptedText;
    if (failure === 'wrong-model') native.arms[0].model = 'harrier';
    if (failure === 'nonfinite') native.arms[0].cases[0].vector[0] = NaN;
    if (failure === 'no-worker') delete native.arms[0].cases[0].shippedVector;
    if (failure === 'unversioned') delete python.versions.tokenizers;
    if (failure === 'unpinned') native.identities[0].files[0].sha256 = 'wrong';
    expect(() => summarizeIncumbentReferences(native, python)).toThrow();
  });
});

afterEach(() => vi.resetAllMocks());

describe('native mDenseOn boundary evidence', () => {
  function fixture() {
    const request: NativeBoundaryRequest = { formatVersion: 1, model: 'lightonai/mDenseOn', revision: 'a5fdb000f7a21da96c3bddde3a782ef777316df3',
      export: '/private/export', snapshot: '/private/snapshot', execution: { dtype: 'fp32', intraOpThreads: 4, interOpThreads: 1, maxLength: 8192 },
      thresholds: { minimumCosine: 0.99999, maximumAbsoluteError: 3e-5, ranking: 'exact' },
      assets: [{ path: '/private/export/onnx/model.onnx', bytes: 1, sha256: 'a'.repeat(64) }],
      cases: MDENSEON_BOUNDARY_IDS.map((id, i) => ({ id, kind: i % 2 ? 'document' : 'query', text: id,
        untruncatedTokens: i === 6 ? 8192 : i === 7 ? 8256 : 6 + i })),
      batches: [{ id: 'padded', caseIds: ['short-query', 'unicode', 'code', 'whitespace', 'empty'] },
        { id: 'mixed-length', caseIds: ['short-query', 'full-8192'] }] };
    const rows: NativeBoundaryRow[] = request.cases.map((c, i) => {
      const vector = Array.from({ length: 768 }, (_, d) => Number(d === Math.min(i, 6)));
      const tokens = Array(Math.min(8192, c.untruncatedTokens)).fill(i);
      return { id: c.id, inputIds: tokens, referenceInputIds: [...tokens], vector, referenceVector: [...vector],
        execution: { device: 'cpu', verified: true }, worker: { alive: true, disabled: false } };
    });
    return { request, rows };
  }
  it('keeps the 8192/over-limit population and stable near-tie ranking gates', () => {
    const { request, rows } = fixture();
    const result = summarizeNativeBoundaries(request, rows, 'cpu');
    expect(result.singlePopulationCompatible).toBe(true);
    expect(result.comparisons.slice(-2).map((c) => c.tokenLength)).toEqual([8192, 8192]);
    expect(result.actualRankings[6].slice(0, 2)).toEqual([6, 7]);
    // Near ties can reorder while all vectors meet the fixed cosine/error gates.
    rows[6].vector = [...rows[6].vector]; rows[6].vector[0] = 0.00001;
    rows[7].vector = [...rows[7].vector]; rows[7].vector[0] = -0.00001;
    const changed = summarizeNativeBoundaries(request, rows, 'cpu');
    expect(changed.passedFixedVectorGates).toBe(true);
    expect(changed.rankingsEqual).toBe(false);
    expect(changed.singlePopulationCompatible).toBe(false);
  });
  it('records actual token and numerical losses without trusting PASS metadata', () => {
    const { request, rows } = fixture();
    rows[0].inputIds[0]++;
    rows[1].vector = [...rows[2].vector];
    const result = summarizeNativeBoundaries(request, rows, 'cpu');
    expect(result).toMatchObject({ tokenIdsEqual: false, passedFixedVectorGates: false, singlePopulationCompatible: false });
    expect(result.comparisons[0].tokenIdsEqual).toBe(false);
    expect(result.comparisons[1].maximumAbsoluteError).toBe(1);
  });
  it.each(['partial', 'fallback', 'unverified', 'disabled', 'nonfinite', 'truncation'])('refuses %s evidence', (failure) => {
    const { request, rows } = fixture();
    if (failure === 'partial') rows.pop();
    if (failure === 'fallback') rows[0].execution.device = 'cuda';
    if (failure === 'unverified') rows[0].execution.verified = false;
    if (failure === 'disabled') rows[0].worker.disabled = true;
    if (failure === 'nonfinite') rows[0].vector[0] = NaN;
    if (failure === 'truncation') rows[7].inputIds.push(2);
    expect(() => summarizeNativeBoundaries(request, rows, 'cpu')).toThrow();
  });
  it.each(['maxLength', 'relaxedCosine', 'relaxedError', 'batch', 'fullLength'])('rejects %s contract drift', (failure) => {
    const { request } = fixture();
    if (failure === 'maxLength') request.execution.maxLength = 512;
    if (failure === 'relaxedCosine') request.thresholds.minimumCosine = 0.99;
    if (failure === 'relaxedError') request.thresholds.maximumAbsoluteError = 0.001;
    if (failure === 'batch') request.batches.pop();
    if (failure === 'fullLength') request.cases[6].untruncatedTokens = 512;
    expect(() => validateNativeBoundaryRequest(request)).toThrow();
  });
  it('rejects an unpinned request before opening references or model weights', async () => {
    await expect(qualifyMdenseOnBoundaries('/absent.json', 'invalid', '/absent', 'invalid', '/private/out.json')).rejects.toThrow('SHA mismatch');
    expect(mocks.loadModel).not.toHaveBeenCalled(); expect(mocks.loadTokenizer).not.toHaveBeenCalled();
  });
});

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
