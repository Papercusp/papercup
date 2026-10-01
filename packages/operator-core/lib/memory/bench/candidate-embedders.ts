/** Experimental benchmark adapters; these do not register production models. */
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { ORT_SESSION_OPTIONS } from '../../../../../libs/generic/memory/src/local-embedder-worker';
import { gemmaPrompt, harrierPrompt, mrlTruncate, embedViaWorker, embedRequestedExecution,
  shutdownLocalEmbedder, getWorkerState, EMBEDDER_DIM_SPECS } from '@papercusp/memory';

/** Independent pooling oracle for isolated qualification; production recipes
 * and profiles remain untouched. Padding must not contribute to the mean. */
export function benchmarkMaskedMean(hidden: ArrayLike<number>, mask: number[], dims: number): number[] {
  if (!Number.isInteger(dims) || dims < 1 || hidden.length !== mask.length * dims
    || !mask.every((x) => x === 0 || x === 1) || !mask.some(Boolean)) throw new Error('invalid masked hidden state');
  const sum = new Array<number>(dims).fill(0), count = mask.reduce<number>((a, b) => a + b, 0);
  for (let token = 0; token < mask.length; token++) if (mask[token]) {
    for (let d = 0; d < dims; d++) {
      const value = Number(hidden[token * dims + d]);
      if (!Number.isFinite(value)) throw new Error('nonfinite hidden state');
      sum[d] += value;
    }
  }
  return sum.map((x) => x / count);
}

export const INCUMBENT_REFERENCE_CASES = [
  ['plain', 'search for the pinned reference'], ['newline', 'first line\nsecond line'],
  ['whitespace', ' leading  repeated\tspace\n'], ['unicode', 'résumé 東京 naïve façade عربي'],
  ['normalization', 'café cafe\u0301'], ['code', 'const x = `${value}`;\nreturn x;'],
  ['special-token', '<image> <bos> <eos>'], ['empty', ''],
] as const;

export const CORRECTED_GEMMA_REFERENCE_ID = 'gemma-corrected-rust-768@benchmark-v1';
export const REFERENCE_PARITY_LIMITS = { minimumCosine: 0.99999, maximumAbsoluteError: 3e-5 } as const;

type ReferenceCase = { id: string; kind: 'query' | 'document'; text: string; promptedText: string;
  inputIds: number[]; attentionMask: number[]; vector: number[]; shippedVector?: number[] };
type NativeReferenceArm = { model: 'gemma' | 'harrier'; profileId: string; tokenizerBackend: string;
  pooling: string; dimensions: number; cases: ReferenceCase[] };
export type NativeReference = { requestSha256: string; protocolSha256: string;
  identities: { model: 'gemma' | 'harrier'; profile: { profileId: string; nativeDims: number; pooling: string };
    files: { locator: string; sha256: string; bytes: number }[] }[];
  cases: { id: string; kind: 'query' | 'document'; text: string }[]; arms: NativeReferenceArm[] };
export type PythonReference = { nativeSha256: string; requestSha256: string; executionProvider: string;
  versions: Record<string, string>; thresholds: typeof REFERENCE_PARITY_LIMITS;
  arms: { model: string; profileId: string; tokenizerBackend: string;
    cases: { id: string; referenceTokenIds: number[]; referenceVector: number[] }[] }[] };

function referenceVectorComparison(actual: number[], expected: number[], dims: number) {
  for (const vector of [actual, expected]) {
    assertVector(vector, dims, 'reference');
    if (Math.abs(Math.hypot(...vector) - 1) > 2e-5) throw new Error('reference vector must be normalized');
  }
  const cosine = actual.reduce((sum, v, i) => sum + v * expected[i], 0);
  const maximumAbsoluteError = Math.max(...actual.map((v, i) => Math.abs(v - expected[i])));
  return { cosine, maximumAbsoluteError, passed: cosine >= REFERENCE_PARITY_LIMITS.minimumCosine
    && maximumAbsoluteError <= REFERENCE_PARITY_LIMITS.maximumAbsoluteError };
}

function referenceRanks(arm: NativeReferenceArm, vectors: number[][]) {
  const docs = arm.cases.flatMap((c, i) => c.kind === 'document' ? [{ id: c.id, vector: vectors[i] }] : []);
  return arm.cases.flatMap((c, i) => c.kind === 'query' ? [{ queryId: c.id, rankedDocIds: docs.map((d) => ({
    id: d.id, score: vectors[i].reduce((sum, v, j) => sum + v * d.vector[j], 0),
  })).sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)).map((d) => d.id) }] : []);
}

/** Evidence joins are strict; measured parity failures remain visible outcomes.
 * Recompute comparisons from vectors rather than trusting a producer's PASS. */
export function summarizeIncumbentReferences(native: NativeReference, python: PythonReference) {
  if (native.requestSha256 !== python.requestSha256 || python.executionProvider !== 'CPUExecutionProvider'
    || JSON.stringify(python.thresholds) !== JSON.stringify(REFERENCE_PARITY_LIMITS)) throw new Error('reference execution/request contract mismatch');
  const expectedCases = INCUMBENT_REFERENCE_CASES.flatMap(([id, text]) => ['query', 'document'].map((kind) => ({ id: `${kind}-${id}`, kind, text })));
  if (JSON.stringify(native.cases) !== JSON.stringify(expectedCases)) throw new Error('reference controlled case coverage/order mismatch');
  const expectedArms = [
    { model: 'gemma', profileId: EMBEDDER_DIM_SPECS.gemma.profileId, backend: 'shipped-sdk' },
    { model: 'gemma', profileId: CORRECTED_GEMMA_REFERENCE_ID, backend: 'corrected-rust' },
    { model: 'harrier', profileId: EMBEDDER_DIM_SPECS.harrier.profileId, backend: 'shipped-sdk' },
  ];
  if (native.identities.length !== 2 || new Set(native.identities.map((i) => i.model)).size !== 2) throw new Error('reference model identity coverage mismatch');
  for (const model of ['gemma', 'harrier'] as const) {
    const identity = native.identities.find((i) => i.model === model), spec = EMBEDDER_DIM_SPECS[model];
    if (!identity || identity.profile.profileId !== spec.profileId || identity.profile.nativeDims !== spec.nativeDims
      || identity.profile.pooling !== spec.pooling || !['config.json', 'tokenizer.json', 'onnx/model.onnx'].every((name) => identity.files.some((f) => f.locator.endsWith(`/${name}`)))
      || !identity.files.every((f) => /^cache:(validation|transformers)\//.test(f.locator) && /^[a-f0-9]{64}$/.test(f.sha256) && f.bytes > 0)) throw new Error('reference pinned model asset contract mismatch');
  }
  if (!['numpy', 'onnxruntime', 'tokenizers', 'transformers'].every((name) => typeof python.versions[name] === 'string' && python.versions[name].length > 0)) throw new Error('reference runtime versions missing');
  if (native.arms.length !== 3 || python.arms.length !== 3
    || new Set(native.arms.map((a) => a.profileId)).size !== 3
    || new Set(python.arms.map((a) => a.profileId)).size !== 3) throw new Error('reference recipe identity collision/missing arm');
  const ids = expectedCases.map((c) => c.id);
  const arms = expectedArms.map((expected) => {
    const arm = native.arms.find((a) => a.profileId === expected.profileId);
    const reference = python.arms.find((a) => a.profileId === expected.profileId);
    const spec = EMBEDDER_DIM_SPECS[expected.model as 'gemma' | 'harrier'];
    if (!arm || !reference || arm.model !== expected.model || reference.model !== expected.model
      || arm.tokenizerBackend !== expected.backend || reference.tokenizerBackend !== expected.backend
      || arm.dimensions !== spec.nativeDims || arm.pooling !== spec.pooling) throw new Error('reference arm recipe mismatch');
    if (JSON.stringify(arm.cases.map((c) => c.id)) !== JSON.stringify(ids)
      || JSON.stringify(reference.cases.map((c) => c.id)) !== JSON.stringify(ids)) throw new Error('reference arm case coverage/order mismatch');
    const cases = arm.cases.map((c, i) => {
      const frozen = expectedCases[i], ref = reference.cases[i];
      const prompt = arm.model === 'gemma' ? gemmaPrompt(c.kind, c.text) : harrierPrompt(c.kind, c.text);
      if (c.kind !== frozen.kind || c.text !== frozen.text || c.promptedText !== prompt) throw new Error('reference prompt recipe mismatch');
      for (const tokens of [c.inputIds, ref.referenceTokenIds]) if (!tokens.length || !tokens.every((x) => Number.isInteger(x) && x >= 0)) throw new Error('invalid reference token IDs');
      if (c.attentionMask.length !== c.inputIds.length || !c.attentionMask.every((x) => x === 0 || x === 1)
        || !c.attentionMask.some(Boolean)) throw new Error('invalid reference attention mask');
      if ((expected.backend === 'shipped-sdk') !== Boolean(c.shippedVector)) throw new Error('reference shipped worker coverage mismatch');
      return { id: c.id, tokenIdsEqual: JSON.stringify(c.inputIds) === JSON.stringify(ref.referenceTokenIds),
        nativeParity: referenceVectorComparison(c.vector, ref.referenceVector, spec.nativeDims),
        shippedWorkerParity: c.shippedVector ? referenceVectorComparison(c.shippedVector, c.vector, spec.nativeDims) : null };
    });
    const ranks = referenceRanks(arm, arm.cases.map((c) => c.vector));
    const referenceRankings = referenceRanks(arm, reference.cases.map((c) => c.referenceVector));
    const exactRankAgreements = ranks.filter((r, i) => JSON.stringify(r) === JSON.stringify(referenceRankings[i])).length;
    return { model: expected.model, profileId: expected.profileId, tokenizerBackend: expected.backend,
      pooling: arm.pooling, dimensions: arm.dimensions, caseCount: cases.length,
      tokenMatches: cases.filter((c) => c.tokenIdsEqual).length,
      minimumCosine: Math.min(...cases.map((c) => c.nativeParity.cosine)),
      maximumAbsoluteError: Math.max(...cases.map((c) => c.nativeParity.maximumAbsoluteError)),
      passed: cases.every((c) => c.tokenIdsEqual && c.nativeParity.passed && c.shippedWorkerParity?.passed !== false),
      rankings: { queryCount: ranks.length, exactRankAgreements, native: ranks, reference: referenceRankings }, cases };
  });
  const shipped = native.arms.find((a) => a.profileId === expectedArms[0].profileId)!;
  const corrected = native.arms.find((a) => a.profileId === CORRECTED_GEMMA_REFERENCE_ID)!;
  const effects = shipped.cases.map((c, i) => ({ id: c.id,
    tokensChanged: JSON.stringify(c.inputIds) !== JSON.stringify(corrected.cases[i].inputIds),
    ...referenceVectorComparison(c.vector, corrected.cases[i].vector, 768) }));
  return { formatVersion: 1, protocolSha256: native.protocolSha256, requestSha256: native.requestSha256,
    executionProvider: python.executionProvider, referenceVersions: python.versions, thresholds: REFERENCE_PARITY_LIMITS,
    arms, correctedGemmaEffect: { population: effects.length, changedTokenCases: effects.filter((c) => c.tokensChanged).map((c) => c.id),
      minimumCosine: Math.min(...effects.map((c) => c.cosine)), maximumAbsoluteError: Math.max(...effects.map((c) => c.maximumAbsoluteError)),
      rankingQueriesChanged: arms[0].rankings.native.filter((r, i) => JSON.stringify(r) !== JSON.stringify(arms[1].rankings.native[i])).map((r) => r.queryId), cases: effects },
    limitation: 'Controlled tokenizer/runtime qualification: eight texts in query/document forms. No corpus-wide defect-absence or relevance claim.' };
}

export function summarizeIncumbentReferenceFiles(nativeFile: string, pythonFile: string) {
  const bytes = (p: string) => fs.readFileSync(p), hash = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex');
  const nativeBytes = bytes(nativeFile), pythonBytes = bytes(pythonFile), requestBytes = bytes(`${nativeFile}.request.json`);
  const native = JSON.parse(nativeBytes.toString()), python = JSON.parse(pythonBytes.toString()), request = JSON.parse(requestBytes.toString());
  if (hash(nativeBytes) !== python.nativeSha256 || hash(requestBytes) !== native.requestSha256) throw new Error('reference raw artifact fingerprint mismatch');
  for (const key of ['protocolSha256', 'ownerId', 'execution', 'identities', 'cases']) {
    if (JSON.stringify(native[key]) !== JSON.stringify(request[key])) throw new Error('reference frozen request drift');
  }
  if (native.execution.device !== 'cpu' || native.execution.dtype !== 'fp32') throw new Error('reference execution must be explicit CPU/fp32');
  return { ...summarizeIncumbentReferences(native, python), nativeSha256: hash(nativeBytes), pythonSha256: hash(pythonBytes),
    assets: native.identities.map((i: NativeReference['identities'][number]) => ({ model: i.model, profile: i.profile,
      files: i.files.map((f) => ({ locator: f.locator, sha256: f.sha256, bytes: f.bytes })) })) };
}

/** Portable dossier locators resolve only in the declared local caches. */
export function referenceAssetPath(locator: string, repo: string, home = os.homedir()): string {
  const match = /^cache:(validation|transformers)\/(.+)$/.exec(locator);
  if (!match || match[2].split('/').some((part) => !part || part === '.' || part === '..') || match[2].includes('\\')) throw new Error('invalid portable reference asset locator');
  const root = match[1] === 'validation' ? path.join(home, '.cache/papercusp/model-validation')
    : path.join(repo, 'node_modules/@huggingface/transformers/.cache');
  return path.join(root, match[2]);
}

/** Freeze requests/assets before any forward pass, then qualify shipped worker
 * vectors and a distinct corrected Gemma arm. Consumed by the maintained Python
 * ONNX/tokenizer reference mode in mdenseon-vectors.py. No production registration. */
export async function qualifyIncumbentReferences(protocolFile: string, expectedSha: string, outputFile: string): Promise<void> {
  const hash = (file: string) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  if (!/^[a-f0-9]{64}$/.test(expectedSha) || hash(protocolFile) !== expectedSha) throw new Error('reference protocol SHA mismatch');
  const protocol = JSON.parse(fs.readFileSync(protocolFile, 'utf8'));
  if (protocol.plan !== 'mdenseon-adoption-measurements-2026-10-01' || protocol.ownerId !== process.env.PAPERCUSP_SID) throw new Error('reference protocol owner/plan mismatch');
  if (embedRequestedExecution().device !== 'cpu') throw new Error('reference qualification requires explicit CPU; no fallback');
  const output = path.resolve(outputFile), repo = path.resolve(import.meta.dirname, '../../../../..');
  if (output === repo || output.startsWith(`${repo}${path.sep}`)) throw new Error('raw reference vectors must remain private outside repository');
  const identities = ['gemma', 'harrier'].map((model) => {
    const arm = protocol.modelIdentities.find((a: any) => a.model === model);
    if (!arm || arm.profile.nativeDims !== (model === 'gemma' ? 768 : 1024)) throw new Error('reference native profile mismatch');
    const files = arm.files.map((asset: any) => ({ ...asset, locator: asset.path, path: referenceAssetPath(asset.path, repo) }));
    for (const asset of files) if (hash(asset.path) !== asset.sha256 || fs.statSync(asset.path).size !== asset.bytes) throw new Error('reference asset fingerprint mismatch');
    const directory = path.dirname(files.find((a: any) => path.basename(a.path) === 'config.json').path);
    return { ...arm, files, directory };
  });
  const cases = INCUMBENT_REFERENCE_CASES.flatMap(([id, text]) => ['query', 'document'].map((kind) => ({ id: `${kind}-${id}`, kind, text })));
  fs.mkdirSync(path.dirname(output), { recursive: true });
  const request = { formatVersion: 1, protocolSha256: expectedSha, frozenAt: new Date().toISOString(), ownerId: process.env.PAPERCUSP_SID,
    execution: { device: 'cpu', dtype: 'fp32', ...ORT_SESSION_OPTIONS }, identities, cases };
  fs.writeFileSync(`${output}.request.json`, JSON.stringify(request), { flag: 'wx', mode: 0o600 });
  const { AutoTokenizer, PreTrainedModel, Tensor } = await import('@huggingface/transformers');
  const { Tokenizer } = await import('tokenizers');
  const report: any = { ...request, requestSha256: hash(`${output}.request.json`), arms: [] };
  try {
    for (const identity of identities) {
      const tokenizer = await AutoTokenizer.from_pretrained(identity.directory, { local_files_only: true });
      const model = await PreTrainedModel.from_pretrained(identity.directory, { local_files_only: true, device: 'cpu', dtype: 'fp32', session_options: ORT_SESSION_OPTIONS });
      try {
        const rust = await Tokenizer.fromFile(path.join(identity.directory, 'tokenizer.json'));
        const maxLength = Number(tokenizer.model_max_length);
        if (!Number.isInteger(maxLength) || maxLength < 1) throw new Error('invalid declared tokenizer limit');
        await rust.setTruncation(maxLength);
        for (const backend of identity.model === 'gemma' ? ['shipped-sdk', 'corrected-rust'] : ['shipped-sdk']) {
          const arm: any = { model: identity.model, profileId: backend === 'corrected-rust' ? CORRECTED_GEMMA_REFERENCE_ID : identity.profile.profileId,
            tokenizerBackend: backend, pooling: identity.profile.pooling, dimensions: identity.profile.nativeDims, cases: [] };
          for (const item of cases) {
            const text = identity.model === 'gemma' ? gemmaPrompt(item.kind as 'query' | 'document', item.text) : harrierPrompt(item.kind as 'query' | 'document', item.text);
            let ids: number[], mask: number[];
            if (backend === 'corrected-rust') {
              const encoded = await rust.encode(text); ids = encoded.getIds(); mask = encoded.getAttentionMask();
            } else {
              const encoded = tokenizer(text, { padding: true, truncation: true });
              ids = Array.from(encoded.input_ids.data, Number); mask = Array.from(encoded.attention_mask.data, Number);
            }
            const inputs = { input_ids: new Tensor('int64', BigInt64Array.from(ids, BigInt), [1, ids.length]),
              attention_mask: new Tensor('int64', BigInt64Array.from(mask, BigInt), [1, mask.length]) };
            const outputs = await model(inputs);
            const vector = identity.model === 'harrier' ? Array.from(outputs.sentence_embedding.data, Number)
              : mrlTruncate(benchmarkMaskedMean(outputs.last_hidden_state.data, mask, 768), 768);
            assertVector(vector, identity.profile.nativeDims, arm.profileId);
            let shippedVector: number[] | undefined;
            if (backend === 'shipped-sdk') {
              const native = await embedViaWorker(text, { model: identity.profile.modelRevision,
                ...(identity.model === 'harrier' ? { output: 'sentence_embedding' } : { pooling: 'mean' as const, normalize: false }) });
              shippedVector = mrlTruncate(native, identity.profile.nativeDims);
              if (!getWorkerState().alive || getWorkerState().disabled) throw new Error('shipped worker not alive');
            }
            arm.cases.push({ ...item, promptedText: text, inputIds: ids, attentionMask: mask, vector, shippedVector });
          }
          report.arms.push(arm);
          fs.writeFileSync(`${output}.${arm.profileId.replace(/[^a-zA-Z0-9._-]/g, '_')}.json`, JSON.stringify(arm), { flag: 'wx', mode: 0o600 });
        }
      } finally { await model.dispose(); await shutdownLocalEmbedder(); }
    }
    fs.writeFileSync(output, JSON.stringify(report), { flag: 'wx', mode: 0o600 });
  } finally { await shutdownLocalEmbedder(); }
}

export const PPLX_MODEL = 'perplexity-ai/pplx-embed-v1-0.6b';
export const PPLX_REVISION = '2c4d510dd4a732063c31a0f70193e35067b51fd8';
export const PPLX_OUTPUT = 'pooler_output_int8';

/** The publisher's graph already performs bidirectional attention and mean pooling.
 * Its documented retrieval output is int8, NOT the token-level first output.
 * PreTrainedModel runs the encoder graph directly, avoiding AutoModel's unsupported
 * custom Python model type without substituting a causal Qwen implementation. */
export function buildPplxBenchmarkEmbedder(): (text: string) => Promise<number[]> {
  const load = async () => {
    const { AutoTokenizer, PreTrainedModel } = await import('@huggingface/transformers');
    const [tokenizer, model] = await Promise.all([
      AutoTokenizer.from_pretrained(PPLX_MODEL, { revision: PPLX_REVISION }),
      PreTrainedModel.from_pretrained(PPLX_MODEL, {
        revision: PPLX_REVISION, device: 'cpu', dtype: 'fp32',
        session_options: ORT_SESSION_OPTIONS,
      }),
    ]);
    return { tokenizer, model };
  };
  let loaded: ReturnType<typeof load> | undefined;
  return async (text) => {
    const { tokenizer, model } = await (loaded ??= load());
    // The model card uses raw texts for BOTH queries and documents.
    const inputs = tokenizer(text, { padding: true, truncation: true, max_length: 32768 });
    const outputs = await model(inputs);
    const tensor = outputs[PPLX_OUTPUT];
    if (!tensor) throw new Error(`pplx missing ${PPLX_OUTPUT}; outputs: ${Object.keys(outputs).join(', ')}`);
    const vector = Array.from(tensor.data, Number);
    assertVector(vector, 1024, 'pplx');
    return vector;
  };
}

function assertVector(vector: number[], dims: number, label: string): void {
  if (vector.length !== dims || vector.some((x) => !Number.isFinite(x)) || !vector.some((x) => x !== 0)) {
    throw new Error(`${label}: expected a finite, nonzero ${dims}-dimensional vector`);
  }
}

export interface VectorSuite {
  corpusSha256: string;
  goldSha256: string;
  keys: string[];
  queryIds: string[];
  docVectors: number[][];
  queryVectors: number[][];
  docSeconds: number;
  querySeconds: number;
  peakRssMB: number;
}
export interface CandidateVectors {
  name: string;
  model: string;
  revision: string;
  runtime: string;
  dimensions: number;
  loadSeconds: number;
  assetBytes: number;
  suites: Partial<Record<'memory' | 'prose', VectorSuite>>;
}

/** Imported inference is scored by the SAME evaluator as the shipped builders.
 * Bind vectors to exact fixture bytes AND order, and refuse incomplete passes;
 * never time reading these cached vectors as though it were model inference. */
export function loadCandidateVectors(
  file: string,
  corpus: 'memory' | 'prose',
  corpusFile: string,
  goldFile: string,
  keys: string[],
  queryIds: string[],
): { manifest: CandidateVectors; suite: VectorSuite } {
  const manifest = JSON.parse(fs.readFileSync(file, 'utf8')) as CandidateVectors;
  const suite = manifest.suites?.[corpus];
  if (!suite) throw new Error(`candidate vectors have no completed ${corpus} suite`);
  const hash = (p: string) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
  if (suite.corpusSha256 !== hash(corpusFile) || suite.goldSha256 !== hash(goldFile)) {
    throw new Error('candidate vectors fixture fingerprint mismatch');
  }
  if (JSON.stringify(suite.keys) !== JSON.stringify(keys) || JSON.stringify(suite.queryIds) !== JSON.stringify(queryIds)) {
    throw new Error('candidate vectors corpus/query order mismatch');
  }
  if (suite.docVectors.length !== keys.length || suite.queryVectors.length !== queryIds.length) {
    throw new Error('candidate vectors incomplete document/query pass');
  }
  if (!Number.isInteger(manifest.dimensions) || manifest.dimensions < 1) throw new Error('invalid candidate dimensions');
  for (const vector of [...suite.docVectors, ...suite.queryVectors]) assertVector(vector, manifest.dimensions, manifest.name);
  for (const n of [suite.docSeconds, suite.querySeconds, suite.peakRssMB]) {
    if (!Number.isFinite(n) || n <= 0) throw new Error('candidate vectors missing measured inference timing/footprint');
  }
  return { manifest, suite };
}
