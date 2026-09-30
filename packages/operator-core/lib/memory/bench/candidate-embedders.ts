/** Experimental benchmark adapters; these do not register production models. */
import fs from 'node:fs';
import crypto from 'node:crypto';
import { ORT_SESSION_OPTIONS } from '../../../../../libs/generic/memory/src/local-embedder-worker';

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
