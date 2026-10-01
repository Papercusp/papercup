/** Frozen contracts shared by the existing candidate SQL and embedder runners.
 * Raw corpora/requests stay private; only bounded, hash-addressed receipts ship.
 * A guard passing qualifies the harness, never the model or measured population. */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { validateEmbedderProfile, EMBEDDER_DIM_SPECS, CANDIDATE_DIM_SPECS, MDENSEON_REVISION,
  gemmaPrompt, harrierPrompt, mdenseOnPrompt, embedRequestedExecution,
  type EmbedderProfileSpec, type SidecarEmbedResponse } from '@papercusp/memory';
import { ORT_SESSION_OPTIONS } from '../../../../../libs/generic/memory/src/local-embedder-worker';
import type { CorpusEntry, GoldQuery } from '@papercusp/memory/bench';

export const MEASUREMENT_BARS = ['relevance', 'reference', 'hybrid', 'performance', 'boundaries', 'reliability', 'answers'] as const;
export const MEASUREMENT_CLASSES = ['exact-identifier', 'lexical-gap', 'session-start-intent', 'hard-negative'] as const;
const id = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/);
const sha = z.string().regex(/^[a-f0-9]{64}$/);
const date = z.iso.datetime();
const fingerprint = z.strictObject({ path: z.string().min(1), sha256: sha, bytes: z.number().int().nonnegative() });
const profile = z.custom<EmbedderProfileSpec>((value) => {
  try { return validateEmbedderProfile('measurement', value as EmbedderProfileSpec).length === 0; }
  catch { return false; }
}, 'invalid embedding profile');
const armSchema = z.strictObject({
  id, model: z.enum(['mdenseon', 'gemma', 'harrier', 'gemma-corrected']), profile,
  // modelRev is the HTTP wire identity; artifactRevision pins vendor/local bytes.
  modelRev: z.string().min(1), artifactRevision: z.string().min(1),
  artifacts: z.strictObject({ graph: fingerprint, tokenizer: fingerprint, config: fingerprint,
    weightLayout: z.enum(['inline', 'external']), weights: z.array(fingerprint) }),
  prompts: z.strictObject({ query: z.string(), document: z.string() }),
  tokenizer: z.strictObject({ backend: z.string().min(1), version: z.string().min(1) }),
  runtime: z.strictObject({ name: z.string().min(1), version: z.string().min(1), wire: z.string().min(1), source: fingerprint }),
  execution: z.strictObject({ device: z.enum(['cpu', 'cuda']), dtype: z.literal('fp32'),
    intraOpThreads: z.number().int().positive(), interOpThreads: z.number().int().positive(),
    transport: z.enum(['worker', 'local-http-client-worker', 'python-reference']), cache: z.literal('bypass') }),
});

export const measurementManifestSchema = z.strictObject({
  formatVersion: z.literal(1), plan: z.literal('mdenseon-adoption-measurements-2026-10-01'),
  runId: id, ownerId: z.string().min(1), frozenAt: date, seed: z.string().min(1),
  // Provenance anchor; exact loaded bytes are the declared file fingerprints.
  // Unrelated shared-tree git-sync commits must not invalidate a pinned recipe.
  sourceCommit: z.string().regex(/^[a-f0-9]{40}$/),
  privateRoot: z.string().min(1), evidencePath: z.string().startsWith('docs/evidence/'),
  contracts: z.strictObject({
    labels: z.literal('independent-blind-before-inference'), sourceSplit: z.literal('source-target'),
    classes: z.tuple([z.literal('exact-identifier'), z.literal('lexical-gap'), z.literal('session-start-intent'), z.literal('hard-negative')]),
    mrrMargin: z.literal(0.03), stop: z.literal('margin-resolved-or-censused-population-exhausted'),
    cosineMin: z.literal(0.99999), maxAbs: z.literal(0.00003), freshProcessBlocks: z.number().int().min(5),
  }),
  inputs: z.record(id, fingerprint), arms: z.array(armSchema).min(3),
  datasets: z.array(z.strictObject({
    corpus: z.enum(['memory', 'prose']), snapshot: id, labels: id, judgments: id, census: id,
    keys: z.array(z.string().min(1)).min(1), queryIds: z.array(z.string().min(1)).min(1),
  })),
  cells: z.array(z.strictObject({
    id, bar: z.enum(MEASUREMENT_BARS), armId: id, inputIds: z.array(id).min(1),
    corpus: z.enum(['memory', 'prose']).optional(),
    parameters: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.array(z.string())])),
    output: id,
  })).min(7),
});
export type MeasurementManifest = z.infer<typeof measurementManifestSchema>;
export type MeasurementArm = MeasurementManifest['arms'][number];
export type MeasurementCell = MeasurementManifest['cells'][number];
export const FROZEN_MEASUREMENT_CONTRACTS: MeasurementManifest['contracts'] = {
  labels: 'independent-blind-before-inference', sourceSplit: 'source-target', classes: [...MEASUREMENT_CLASSES],
  mrrMargin: 0.03, stop: 'margin-resolved-or-censused-population-exhausted',
  cosineMin: 0.99999, maxAbs: 0.00003, freshProcessBlocks: 5,
};

/** Streaming avoids holding another multi-GB model beside loaded weights. */
export async function fingerprintFile(file: string): Promise<z.infer<typeof fingerprint>> {
  const hash = crypto.createHash('sha256'); let bytes = 0;
  for await (const chunk of fs.createReadStream(file)) { bytes += chunk.length; hash.update(chunk); }
  return { path: file, sha256: hash.digest('hex'), bytes };
}
export function hashJson(value: unknown): string {
  const canonical = (v: unknown): unknown => Array.isArray(v) ? v.map(canonical)
    : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => [k, canonical(x)])) : v;
  return crypto.createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}
export function measurementPackageVersion(name: string): string {
  const require = createRequire(import.meta.url);
  // Literal loader targets keep the benchmark's import closure inspectable.
  const entry = name === '@huggingface/transformers' ? require.resolve('@huggingface/transformers')
    : name === '@huggingface/tokenizers' ? require.resolve('@huggingface/tokenizers')
    : name === 'tokenizers' ? require.resolve('tokenizers') : undefined;
  if (!entry) throw new Error(`undeclared benchmark runtime package ${name}`);
  let dir = path.dirname(entry);
  for (;;) {
    const file = path.join(dir, 'package.json');
    if (fs.existsSync(file)) { const p = JSON.parse(fs.readFileSync(file, 'utf8')); if (p.name === name) return p.version; }
    const next = path.dirname(dir); if (next === dir) throw new Error(`cannot identify runtime package ${name}`); dir = next;
  }
}
export function measurementOwner(): string { return process.env.PAPERCUSP_SID ?? `local-process-${process.pid}`; }
export function candidateProfile(model: 'mdenseon' | 'gemma' | 'harrier'): EmbedderProfileSpec {
  if (model !== 'mdenseon') return EMBEDDER_DIM_SPECS[model];
  return { ...CANDIDATE_DIM_SPECS.mdenseon, profileId: 'mdenseon-a5fdb000-768@v1', modelRevision: MDENSEON_REVISION,
    revisionPolicy: 'immutable-artifact', distanceMetric: 'cosine', pooling: 'cls',
    normalization: { kind: 'l2', timing: 'pipeline' }, outputDtype: 'float32',
    documentRecipe: 'mdenseon-document-prefix@v1', queryRecipe: 'mdenseon-query-prefix@v1' };
}
/** Identifies the shipped builders/worker before model construction. Shared
 * here so the self-contained embedder evaluator does not import PG host wiring. */
export async function assertCandidateArm(arm: MeasurementArm, model: 'mdenseon' | 'gemma' | 'harrier',
  transport: 'worker' | 'local-http-client-worker', httpRuntime?: string): Promise<void> {
  const prompt = model === 'mdenseon' ? mdenseOnPrompt : model === 'gemma' ? gemmaPrompt : harrierPrompt;
  if (arm.model !== model) throw new Error('runner/model identity mismatch');
  assertMeasurementArm(arm, { profile: candidateProfile(model), prompts: { query: prompt('query', ''), document: prompt('document', '') },
    tokenizer: { backend: model === 'mdenseon' ? 'rust' : 'transformers-js',
      version: measurementPackageVersion(model === 'mdenseon' ? 'tokenizers' : '@huggingface/tokenizers') },
    execution: { device: embedRequestedExecution().device, dtype: 'fp32', transport, cache: 'bypass',
      intraOpThreads: ORT_SESSION_OPTIONS.intraOpNumThreads, interOpThreads: ORT_SESSION_OPTIONS.interOpNumThreads } });
  const source = await fingerprintFile(fileURLToPath(new URL('../../../../../libs/generic/memory/src/local-embedder-worker.script.mjs', import.meta.url)));
  if (arm.runtime.name !== 'transformers-js-worker' || arm.runtime.version !== measurementPackageVersion('@huggingface/transformers')
    || arm.runtime.wire !== (transport === 'worker' ? 'worker-in-process' : httpRuntime)
    || source.sha256 !== arm.runtime.source.sha256 || source.bytes !== arm.runtime.source.bytes) throw new Error('actual worker/runtime identity mismatch');
}
function unique(values: string[], label: string): void {
  if (new Set(values).size !== values.length) throw new Error(`duplicate ${label}`);
}
export function validateMeasurementManifest(value: unknown): MeasurementManifest {
  const m = measurementManifestSchema.parse(value);
  unique(m.arms.map((a) => a.id), 'arm'); unique(m.cells.map((c) => c.id), 'cell');
  unique(m.cells.map((c) => c.output), 'output'); unique(m.datasets.map((d) => d.corpus), 'dataset');
  for (const model of ['mdenseon', 'gemma', 'harrier']) {
    if (!m.arms.some((a) => a.model === model)) throw new Error(`missing incumbent/candidate ${model}`);
  }
  for (const bar of MEASUREMENT_BARS) if (!m.cells.some((c) => c.bar === bar)) throw new Error(`missing promised bar ${bar}`);
  for (const arm of m.arms) {
    if ((arm.artifacts.weightLayout === 'external') !== (arm.artifacts.weights.length > 0)) throw new Error('external/inline weight identity mismatch');
    unique(arm.artifacts.weights.map((f) => f.path), 'weight file');
    if (arm.profile.targetDims !== arm.profile.nativeDims) throw new Error('adoption measurements require native dimensions');
    if (arm.model === 'gemma-corrected' && m.arms.some((a) => a.model === 'gemma' && a.profile.profileId === arm.profile.profileId)) {
      throw new Error('corrected Gemma must have a separate recipe/profile identity');
    }
  }
  for (const d of m.datasets) {
    unique(d.keys, 'corpus key'); unique(d.queryIds, 'query id');
    for (const ref of [d.snapshot, d.labels, d.judgments, d.census]) if (!m.inputs[ref]) throw new Error(`missing dataset input ${ref}`);
  }
  for (const cell of m.cells) {
    if (!m.arms.some((a) => a.id === cell.armId)) throw new Error(`unknown arm ${cell.armId}`);
    unique(cell.inputIds, 'cell input');
    for (const ref of cell.inputIds) if (!m.inputs[ref]) throw new Error(`unknown input ${ref}`);
    if (['relevance', 'hybrid', 'answers'].includes(cell.bar) && !m.datasets.some((d) => d.corpus === cell.corpus)) {
      throw new Error(`missing independent dataset for ${cell.id}`);
    }
  }
  return m;
}

interface FrozenEntry { key: string; metadata?: Record<string, unknown> }
interface FrozenQuery { id: string; class: string; query: string; group: string; partition: string; expected: string[] }
/** Check ACTUAL source clusters, not the query author's self-reported group. */
export function validateIndependentCohort(entries: FrozenEntry[], queries: FrozenQuery[], receipt: unknown,
  snapshotSha256: string, labelsSha256: string, frozenAt: string): void {
  const proof = z.strictObject({
    formatVersion: z.literal(1), authority: z.literal('independent-blind-transport'),
    candidateRankingsExposed: z.literal(false), frozenAt: date, snapshotSha256: sha, labelsSha256: sha,
    judges: z.array(z.strictObject({ model: z.string().trim().min(1), revision: z.string().trim().min(1),
      transport: z.string().trim().min(1), promptSha256: sha, raw: fingerprint })).min(2),
    queryIds: z.array(z.string()), ambiguous: z.array(z.string()), excluded: z.array(z.string()),
    agreement: z.number().min(0).max(1),
  }).parse(receipt);
  // Two array entries cannot stand in for two independently transported calls.
  unique(proof.judges.map((j) => j.transport), 'judge transport');
  unique(proof.judges.map((j) => path.resolve(j.raw.path)), 'judge raw artifact');
  if (proof.snapshotSha256 !== snapshotSha256 || proof.labelsSha256 !== labelsSha256 || proof.frozenAt > frozenAt) {
    throw new Error('label receipt fingerprint/time mismatch');
  }
  unique(entries.map((e) => e.key), 'corpus key'); unique(queries.map((q) => q.id), 'query id');
  if (JSON.stringify(proof.queryIds) !== JSON.stringify(queries.map((q) => q.id))) throw new Error('judged query order mismatch');
  const sources = new Map(entries.map((e) => [e.key, String(e.metadata?.cluster ?? '')]));
  if ([...sources.values()].some((s) => !s)) throw new Error('missing actual source cluster');
  const partitions = new Map<string, string>();
  const counts = new Map<string, number>();
  for (const q of queries) {
    if (!MEASUREMENT_CLASSES.includes(q.class as typeof MEASUREMENT_CLASSES[number]) || !['calibration', 'test'].includes(q.partition)
      || !q.query.trim() || !q.group || !Array.isArray(q.expected)) throw new Error('invalid independent query');
    if ((q.class === 'hard-negative') !== (q.expected.length === 0)) throw new Error('contradictory negative label');
    const groups = new Set([q.group]);
    for (const key of q.expected) {
      if (!sources.has(key)) throw new Error('gold key absent from frozen corpus');
      groups.add(sources.get(key)!);
    }
    for (const group of groups) {
      if (partitions.has(group) && partitions.get(group) !== q.partition) throw new Error('actual source target leaks across partitions');
      partitions.set(group, q.partition);
    }
    const key = `${q.partition}:${q.class}`; counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  for (const partition of ['calibration', 'test']) {
    const ns = MEASUREMENT_CLASSES.map((c) => counts.get(`${partition}:${c}`) ?? 0);
    if (ns.some((n) => n === 0) || new Set(ns).size !== 1) throw new Error(`unbalanced/missing ${partition} query class`);
  }
}

/** Resolve through existing ancestors, including symlinks, before containment checks. */
function realDestination(file: string): string {
  const tail: string[] = []; let parent = path.resolve(file);
  while (!fs.existsSync(parent)) { tail.unshift(path.basename(parent)); const next = path.dirname(parent);
    if (next === parent) throw new Error('unresolvable output root'); parent = next; }
  return path.join(fs.realpathSync(parent), ...tail);
}
function inside(root: string, file: string): boolean {
  const rel = path.relative(root, file); return rel !== '' && !rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel);
}
export function measurementOutputPaths(m: MeasurementManifest, cell: MeasurementCell, repoRoot: string): { raw: string; summary: string } {
  const repo = fs.realpathSync(repoRoot); const privateRoot = realDestination(m.privateRoot);
  if (!path.isAbsolute(m.privateRoot) || privateRoot === repo || inside(repo, privateRoot)) throw new Error('raw evidence root must be private, outside repository');
  const summary = realDestination(path.resolve(repo, m.evidencePath));
  const evidenceRoot = path.join(repo, 'docs/evidence');
  if (!inside(evidenceRoot, summary) || !inside(repo, realDestination(evidenceRoot))) throw new Error('summary escapes tracked docs/evidence');
  const ignored = spawnSync('git', ['check-ignore', '--quiet', '--', path.relative(repo, summary)], { cwd: repo });
  if (ignored.status !== 1) throw new Error('summary is ignored or Git eligibility could not be verified');
  const raw = realDestination(path.join(privateRoot, m.runId, `${cell.output}.json`));
  if (!inside(privateRoot, raw)) throw new Error('output escapes private root');
  if (fs.existsSync(raw)) throw new Error('immutable cell output already exists; use a new run id for replay');
  if (fs.existsSync(`${raw}.running`) || fs.existsSync(`${raw}.failure.json`)) throw new Error('cell attempt already owned/failed; replay with a new run id');
  return { raw, summary };
}

export interface PreparedMeasurement { manifest: MeasurementManifest; manifestSha256: string; cell: MeasurementCell; arm: MeasurementArm; rawOutput: string; claimPath: string }
/** The relevance runner consumes the independently judged files, never the
 * legacy pilot fixtures. Recheck the bytes at load time to reject replacement
 * between preparation and scoring. Versions bind cross-run comparisons to both
 * the corpus and labels, including their exact order. */
export function loadIndependentMeasurementInputs(prepared: PreparedMeasurement, corpus: 'memory' | 'prose'): {
  entries: CorpusEntry[]; queries: Array<GoldQuery & { group: string; partition: string }>;
  corpusVersion: string; goldVersion: string;
} {
  const { manifest, cell } = prepared;
  if (cell.bar !== 'relevance' || cell.corpus !== corpus) throw new Error('independent relevance corpus/cell mismatch');
  const dataset = manifest.datasets.find((d) => d.corpus === corpus);
  if (!dataset) throw new Error('missing independent relevance dataset');
  const read = (ref: string): unknown => {
    const declared = manifest.inputs[ref];
    const bytes = fs.readFileSync(declared.path);
    if (bytes.length !== declared.bytes || crypto.createHash('sha256').update(bytes).digest('hex') !== declared.sha256) {
      throw new Error('independent relevance input changed after preparation');
    }
    return JSON.parse(bytes.toString('utf8'));
  };
  const snapshot = read(dataset.snapshot) as { suites: Record<string, { entries: CorpusEntry[] }> };
  const labels = read(dataset.labels) as Record<string, Array<GoldQuery & { group: string; partition: string }>>;
  const receipt = read(dataset.judgments) as Record<string, unknown>;
  const entries = snapshot.suites[corpus].entries, queries = labels[corpus];
  if (JSON.stringify(dataset.keys) !== JSON.stringify(entries.map((e) => e.key))
    || JSON.stringify(dataset.queryIds) !== JSON.stringify(queries.map((q) => q.id))) throw new Error('independent relevance order mismatch');
  validateIndependentCohort(entries, queries, receipt[corpus], manifest.inputs[dataset.snapshot].sha256,
    manifest.inputs[dataset.labels].sha256, manifest.frozenAt);
  return { entries, queries, corpusVersion: `independent-${manifest.inputs[dataset.snapshot].sha256}`,
    goldVersion: `independent-${manifest.inputs[dataset.labels].sha256}` };
}
/** No inference or SQL writes happen until every selected identity is verified. */
export async function prepareMeasurementCell(file: string, expectedSha256: string, cellId: string,
  repoRoot: string = process.cwd()): Promise<PreparedMeasurement> {
  const actual = await fingerprintFile(file);
  if (!sha.safeParse(expectedSha256).success || actual.sha256 !== expectedSha256) throw new Error('frozen manifest fingerprint mismatch');
  const m = validateMeasurementManifest(JSON.parse(fs.readFileSync(file, 'utf8')));
  if (m.ownerId !== measurementOwner()) throw new Error('manifest output owner differs from executing session');
  if (m.frozenAt > new Date().toISOString()) throw new Error('manifest frozen in the future');
  const cell = m.cells.find((c) => c.id === cellId); if (!cell) throw new Error(`undeclared cell ${cellId}`);
  const arm = m.arms.find((a) => a.id === cell.armId)!;
  const anchor = spawnSync('git', ['merge-base', '--is-ancestor', m.sourceCommit, 'HEAD'], { cwd: repoRoot });
  if (anchor.status !== 0) throw new Error('measurement source anchor is not in current tree history');
  const dataset = ['relevance', 'hybrid', 'answers'].includes(cell.bar) ? m.datasets.find((d) => d.corpus === cell.corpus) : undefined;
  const inputIds = new Set([...cell.inputIds, ...(dataset ? [dataset.snapshot, dataset.labels, dataset.judgments, dataset.census] : [])]);
  const files = [...inputIds].map((ref) => m.inputs[ref]);
  files.push(arm.artifacts.graph, arm.artifacts.tokenizer, arm.artifacts.config, ...arm.artifacts.weights, arm.runtime.source);
  for (const declared of files) {
    const actual = await fingerprintFile(path.resolve(repoRoot, declared.path));
    if (actual.sha256 !== declared.sha256 || actual.bytes !== declared.bytes) throw new Error(`declared file fingerprint mismatch: ${declared.path}`);
  }
  if (dataset) {
    const snapshot = JSON.parse(fs.readFileSync(path.resolve(repoRoot, m.inputs[dataset.snapshot].path), 'utf8'));
    const labels = JSON.parse(fs.readFileSync(path.resolve(repoRoot, m.inputs[dataset.labels].path), 'utf8'));
    const receipt = JSON.parse(fs.readFileSync(path.resolve(repoRoot, m.inputs[dataset.judgments].path), 'utf8'));
    const entries = snapshot.suites[dataset.corpus].entries as FrozenEntry[];
    const queries = labels[dataset.corpus] as FrozenQuery[];
    if (JSON.stringify(dataset.keys) !== JSON.stringify(entries.map((e) => e.key))
      || JSON.stringify(dataset.queryIds) !== JSON.stringify(queries.map((q) => q.id))) throw new Error('frozen corpus/query order mismatch');
    validateIndependentCohort(entries, queries, receipt[dataset.corpus], m.inputs[dataset.snapshot].sha256,
      m.inputs[dataset.labels].sha256, m.frozenAt);
    const judgeRawFiles: string[] = [];
    for (const judge of receipt[dataset.corpus].judges) {
      const actual = await fingerprintFile(path.resolve(repoRoot, judge.raw.path));
      if (actual.sha256 !== judge.raw.sha256 || actual.bytes !== judge.raw.bytes) throw new Error('independent judgment raw fingerprint mismatch');
      judgeRawFiles.push(fs.realpathSync(path.resolve(repoRoot, judge.raw.path)));
    }
    unique(judgeRawFiles, 'judge raw artifact');
  }
  const { raw } = measurementOutputPaths(m, cell, repoRoot);
  fs.mkdirSync(path.dirname(raw), { recursive: true, mode: 0o700 });
  const claimPath = `${raw}.running`;
  fs.writeFileSync(claimPath, JSON.stringify({ ownerId: m.ownerId, pid: process.pid, manifestSha256: expectedSha256, cellId,
    startedAt: new Date().toISOString() }), { flag: 'wx', mode: 0o600 });
  return { manifest: m, manifestSha256: expectedSha256, cell, arm, rawOutput: raw, claimPath };
}

export function assertMeasurementArm(arm: MeasurementArm, actual: Pick<MeasurementArm, 'profile' | 'prompts' | 'tokenizer' | 'execution'>): void {
  for (const key of ['profile', 'prompts', 'tokenizer', 'execution'] as const) {
    if (hashJson(arm[key]) !== hashJson(actual[key])) throw new Error(`measured arm ${key} identity mismatch`);
  }
}
export function assertMeasuredEmbedResponse(arm: MeasurementArm, response: SidecarEmbedResponse, n: number): void {
  if (response.modelRev !== arm.modelRev || response.runtime !== arm.runtime.wire || response.dims !== arm.profile.targetDims
    || response.vectors.length !== n) throw new Error('HTTP model/revision/runtime/dimension identity mismatch');
  if (response.cache?.hits !== 0 || response.cache.coalesced !== 0 || response.cache.inferred !== n) throw new Error('uncached inference accounting mismatch');
  for (const v of response.vectors) {
    const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
    if (v.length !== arm.profile.targetDims || v.some((x) => !Number.isFinite(x)) || Math.abs(norm - 1) > 0.001) throw new Error('invalid measured native unit vector');
  }
}
export function assertMeasuredExecution(arm: MeasurementArm, actual: { device: string; dtype: string | null; verified: boolean },
  threads: { intraOpNumThreads: number; interOpNumThreads: number }, worker: { alive: boolean; disabled: boolean }): void {
  // Production records null for default fp32; artifact hashes pin the fp32
  // graph separately. Null is never interpreted as a measured dtype override.
  if (!actual.verified || actual.device !== arm.execution.device || (actual.dtype !== null && actual.dtype !== arm.execution.dtype)
    || threads.intraOpNumThreads !== arm.execution.intraOpThreads || threads.interOpNumThreads !== arm.execution.interOpThreads
    || !worker.alive || worker.disabled) throw new Error('unverified/mismatched device, threads or worker fallback');
}

export interface CellOutcome { cellId: string; manifestSha256: string; status: 'measured' | 'incompatible';
  artifacts: Array<{ path: string; sha256: string; bytes: number }>; defect?: { owner: string; item: string; rootCause: string; guard: string } }
/** Coverage is an exact partition of promised cells. Unknown/skipped is unfinished. */
export function validateMeasurementCoverage(m: MeasurementManifest, manifestSha256: string, outcomes: CellOutcome[]): void {
  unique(outcomes.map((o) => o.cellId), 'outcome');
  const promised = new Set(m.cells.map((c) => c.id));
  for (const o of outcomes) {
    if (!promised.delete(o.cellId) || o.manifestSha256 !== manifestSha256 || !['measured', 'incompatible'].includes(o.status)
      || !o.artifacts.length || o.artifacts.some((a) => !fingerprint.safeParse(a).success)) throw new Error('unknown/unbound/unmeasured coverage outcome');
    if (o.status === 'incompatible' && (!o.defect?.owner || !/^(WI|EI)-\d+$/.test(o.defect.item) || !o.defect.rootCause || !o.defect.guard)) throw new Error('incompatibility lacks owned root diagnosis/guard');
  }
  if (promised.size) throw new Error(`unfinished promised cells: ${[...promised].join(', ')}`);
}

export async function verifyMeasurementCoverage(m: MeasurementManifest, manifestSha256: string, outcomes: CellOutcome[]): Promise<void> {
  validateMeasurementCoverage(m, manifestSha256, outcomes);
  for (const outcome of outcomes) {
    const cell = m.cells.find((c) => c.id === outcome.cellId)!;
    for (const artifact of outcome.artifacts) {
      const actual = await fingerprintFile(artifact.path);
      if (actual.sha256 !== artifact.sha256 || actual.bytes !== artifact.bytes) throw new Error('cell evidence file fingerprint mismatch');
    }
    const receipt = JSON.parse(fs.readFileSync(outcome.artifacts[0].path, 'utf8'));
    if (receipt.manifestSha256 !== manifestSha256 || receipt.cellId !== cell.id || receipt.armId !== cell.armId
      || receipt.ownerId !== m.ownerId || !receipt.measuredAt || !receipt.report) throw new Error('stored cell receipt identity mismatch');
  }
}

export function writeMeasurementCell(prepared: PreparedMeasurement, report: unknown): CellOutcome {
  const { rawOutput, manifestSha256, cell, arm } = prepared;
  const owner = JSON.parse(fs.readFileSync(prepared.claimPath, 'utf8'));
  if (owner.ownerId !== prepared.manifest.ownerId || owner.pid !== process.pid || owner.manifestSha256 !== manifestSha256
    || owner.cellId !== cell.id) throw new Error('cell output claim identity mismatch');
  fs.mkdirSync(path.dirname(rawOutput), { recursive: true });
  fs.writeFileSync(rawOutput, JSON.stringify({ formatVersion: 1, manifestSha256, cellId: cell.id,
    armId: arm.id, ownerId: prepared.manifest.ownerId, measuredAt: new Date().toISOString(), report }, null, 2), { flag: 'wx', mode: 0o600 });
  fs.unlinkSync(prepared.claimPath);
  const bytes = fs.readFileSync(rawOutput);
  return { cellId: cell.id, manifestSha256, status: 'measured', artifacts: [{ path: rawOutput,
    sha256: crypto.createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length }] };
}

/** Failure is retained under this attempt, never converted to a model loss. */
/** Keep non-enumerable Error.cause/code evidence, with bounded depth and cycles.
 * The SQL bulk-operation serializer cannot be imported into this PG-free CLI. */
function measurementFailure(error: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (depth >= 8) return '[cause chain truncated]';
  if (typeof error === 'string') return error.slice(0, 8000);
  if (typeof error === 'bigint') return String(error);
  if (error === null || typeof error !== 'object') return error;
  if (seen.has(error)) return '[circular cause]';
  seen.add(error);
  if (Array.isArray(error)) return error.slice(0, 256).map((value) => measurementFailure(value, depth + 1, seen));
  const source = error as Record<string, unknown>;
  const keys = error instanceof Error
    ? ['name', 'message', 'stack', 'code', 'status', 'errno', 'syscall', 'address', 'port', 'socket', 'request', 'cause']
    : Object.keys(error).slice(0, 32);
  return Object.fromEntries(keys.filter((key) => source[key] !== undefined)
    .map((key) => [key, measurementFailure(source[key], depth + 1, seen)]));
}

export function failMeasurementCell(prepared: PreparedMeasurement, error: unknown): void {
  if (!fs.existsSync(prepared.claimPath)) return;
  fs.writeFileSync(`${prepared.rawOutput}.failure.json`, JSON.stringify({ formatVersion: 1,
    manifestSha256: prepared.manifestSha256, cellId: prepared.cell.id, ownerId: prepared.manifest.ownerId,
    failedAt: new Date().toISOString(), error: measurementFailure(error) }, null, 2),
  { flag: 'wx', mode: 0o600 });
  fs.unlinkSync(prepared.claimPath);
}
