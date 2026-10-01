/** Isolated candidate evaluation using the production canonical, lexical and
 * fusion implementations. Snapshot and labels are frozen before inference. */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { Client } from 'pg';
import {
  CanonicalVectorStore, Mem0Backend, HybridBackend, LexicalLegBackend,
  EMBEDDER_DIM_SPECS, CANDIDATE_DIM_SPECS, MEMORY_VECTOR_STORAGE_PROFILES,
  buildMdenseOnEmbedder, buildGemmaEmbedder, buildHarrierEmbedder,
  shutdownLocalEmbedder, getWorkerState,
  type EmbedderProfileSpec, type MemoryVectorStorageProfile,
} from '@papercusp/memory';
import { reciprocalRank, type CorpusEntry } from '@papercusp/memory/bench';
import { getHarnessAdminUrl } from '../../embedded-pg-discovery';
import { ensureBenchSchema, releaseBenchSchema } from './bench-host';
import { pickClusters } from './prose-corpus';
import { MDENSEON_REVISION } from '../../../../../libs/generic/memory/src/mdenseon-embedder';

export interface HeldoutQuery {
  id: string; class: string; query: string; expected: string[];
  partition: 'calibration' | 'test'; group: string;
}
export interface Snapshot {
  formatVersion: 1; snapshotAt: string; seed: string;
  suites: Record<'memory' | 'prose', { entries: CorpusEntry[] }>;
}
export function validateHeldout(entries: CorpusEntry[], queries: HeldoutQuery[]): void {
  const keys = new Set(entries.map((e) => e.key));
  if (keys.size !== entries.length || keys.size === 0) throw new Error('empty or duplicate corpus keys');
  const ids = new Set<string>();
  const groups = new Map<string, string>();
  for (const q of queries) {
    if (ids.has(q.id)) throw new Error('duplicate query id');
    ids.add(q.id);
    if (!q.query.trim() || !q.group) throw new Error('missing query text or group');
    if (q.partition !== 'test' && q.partition !== 'calibration') throw new Error('invalid partition');
    if (groups.has(q.group) && groups.get(q.group) !== q.partition) throw new Error('target group leaks across partitions');
    groups.set(q.group, q.partition);
    if (q.expected.some((key) => !keys.has(key))) throw new Error('gold key absent from frozen corpus');
    if ((q.class === 'hard-negative') !== (q.expected.length === 0)) throw new Error('negative label disagrees with expected keys');
  }
  if (!queries.some((q) => q.partition === 'calibration') || !queries.some((q) => q.partition === 'test')) {
    throw new Error('both independent partitions required');
  }
}

export function calibratedFloor(rows: Array<{ partition: string; expected: string[]; topScore: number }>): number {
  const calibration = rows.filter((r) => r.partition === 'calibration');
  const positives = calibration.filter((r) => r.expected.length > 0);
  const negatives = calibration.filter((r) => r.expected.length === 0);
  if (!positives.length || !negatives.length) throw new Error('calibration needs positive and negative queries');
  let best = -1; let floor = 0;
  for (let i = 0; i <= 100; i++) {
    const value = i / 100;
    const balanced = (positives.filter((r) => r.topScore >= value).length / positives.length
      + negatives.filter((r) => r.topScore < value).length / negatives.length) / 2;
    if (balanced > best) { best = balanced; floor = value; }
  }
  return floor;
}

export async function takeCandidateSnapshot(file: string): Promise<Snapshot> {
  const seed = 'mdenseon-heldout-2026-10-01';
  const db = new Client({ connectionString: getHarnessAdminUrl() });
  await db.connect();
  try {
    await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const time = await db.query('SELECT now() AS snapshot_at');
    // Exclude this evaluation's own new memories and synthetic bench scopes.
    const memories = await db.query(`SELECT id, payload->>'data' AS text
      FROM harness_shared.memory_canonical WHERE row_kind='memory'
      AND payload->>'user_id'='harness:papercusp' AND invalid_at IS NULL
      AND length(payload->>'data') BETWEEN 100 AND 1600 AND created_at < '2026-09-30T22:18:00Z'
      ORDER BY md5(id::text || $1) LIMIT 48`, [seed]);
    const pages = await db.query(`SELECT source_key || ' ' || slug AS key, count(*)::int AS size
      FROM harness_shared.doc_sections WHERE source_key LIKE 'papercusp%'
      AND length(content) BETWEEN 100 AND 2000 GROUP BY 1`);
    const picked = pickClusters(pages.rows, 48, 4, seed);
    const docs: CorpusEntry[] = [];
    for (const group of picked.keys) {
      const split = group.indexOf(' ');
      const rows = await db.query(`SELECT source_key, slug, anchor, title, content
        FROM harness_shared.doc_sections WHERE source_key=$1 AND slug=$2
        AND length(content) BETWEEN 100 AND 2000 ORDER BY anchor LIMIT 4`, [group.slice(0, split), group.slice(split + 1)]);
      for (const row of rows.rows) docs.push({ key: `doc:${row.source_key}:${row.slug}:${row.anchor}`,
        text: `${row.title ?? ''}\n${row.content}`.slice(0, 2000), kind: 'doc',
        metadata: { cluster: group }, description: row.title ?? undefined });
    }
    await db.query('COMMIT');
    const snapshot: Snapshot = { formatVersion: 1, snapshotAt: time.rows[0].snapshot_at.toISOString(), seed,
      suites: { memory: { entries: memories.rows.map((row) => ({ key: `memory:${row.id}`,
        text: row.text, kind: 'fact', metadata: { cluster: row.id } })) }, prose: { entries: docs } } };
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(snapshot, null, 2), { flag: 'wx' });
    return snapshot;
  } finally { await db.end(); }
}

export function candidateProfile(model: 'mdenseon' | 'gemma' | 'harrier'): EmbedderProfileSpec {
  if (model !== 'mdenseon') return EMBEDDER_DIM_SPECS[model];
  return { ...CANDIDATE_DIM_SPECS.mdenseon,
    profileId: 'mdenseon-a5fdb000-768@v1', modelRevision: MDENSEON_REVISION,
    revisionPolicy: 'immutable-artifact', distanceMetric: 'cosine',
    pooling: 'cls', normalization: { kind: 'l2', timing: 'pipeline' }, outputDtype: 'float32',
    documentRecipe: 'mdenseon-document-prefix@v1', queryRecipe: 'mdenseon-query-prefix@v1' };
}

export async function runCandidateHybrid(opts: { snapshot: string; gold: string; model: 'mdenseon' | 'gemma' | 'harrier';
  modelDirectory?: string; corpus: 'memory' | 'prose'; out: string }) {
  const snapshot = JSON.parse(fs.readFileSync(opts.snapshot, 'utf8')) as Snapshot;
  const labels = JSON.parse(fs.readFileSync(opts.gold, 'utf8')) as Record<'memory' | 'prose', HeldoutQuery[]>;
  const entries = snapshot.suites[opts.corpus].entries;
  const queries = labels[opts.corpus];
  validateHeldout(entries, queries);
  const profile = candidateProfile(opts.model);
  const build = (kind: 'document' | 'query') => opts.model === 'mdenseon'
    ? buildMdenseOnEmbedder({ kind, model: opts.modelDirectory! })
    : opts.model === 'gemma' ? buildGemmaEmbedder({ kind, dims: 768 }) : buildHarrierEmbedder({ kind });
  if (opts.model === 'mdenseon' && !opts.modelDirectory) throw new Error('mDenseOn requires its validated local model');
  const doc = build('document'); const query = build('query');
  const schema = `bench_memory_candidate_${process.pid}`;
  const admin = new URL(getHarnessAdminUrl());
  const db = new Client({ connectionString: admin.href });
  await db.connect();
  let store: CanonicalVectorStore | undefined;
  try {
    await ensureBenchSchema(db, schema);
    // Reuse a physical layout ONLY in this candidate-owned schema. Its explicit
    // accepted profile remains mDenseOn; equal width never aliases it to Gemma.
    const layout = opts.model === 'harrier' ? MEMORY_VECTOR_STORAGE_PROFILES.harrier : MEMORY_VECTOR_STORAGE_PROFILES.gemma;
    const storage: MemoryVectorStorageProfile = { ...layout, acceptedProfileIds: [profile.profileId] };
    store = new CanonicalVectorStore({ host: admin.hostname, port: Number(admin.port), user: decodeURIComponent(admin.username),
      password: decodeURIComponent(admin.password), dbname: admin.pathname.slice(1), schema,
      vecTable: storage.table, embeddingModelDims: profile.targetDims, embeddingProfile: profile, storageProfile: storage });
    const vectors: number[][] = [];
    const started = performance.now();
    for (const entry of entries) vectors.push(await doc(entry.text));
    const documentMs = performance.now() - started;
    await store.insert(vectors, entries.map((e) => e.key), entries.map((e) => ({ data: e.text, name: e.description ?? e.key,
      user_id: 'bench', metadata: { ...e.metadata, corpus_key: e.key }, createdAt: new Date().toISOString() })));
    const canonical = store;
    // The production precomputed-vector rung needs no extraction client or
    // entity graph. Fail-closed if it ever tries to use either absent path.
    const cosine = new Mem0Backend({ getClient: async () => null,
      vectorSearch: (v, k, f) => canonical.search(v, k, f), lexicalSearch: (q, k, f) => canonical.lexicalSearch(q, k, f) });
    const hybrid = new HybridBackend(new LexicalLegBackend(cosine), cosine, { name: 'hybrid-pg' });
    const embedded = [];
    for (const q of queries) {
      const t0 = performance.now(); const vector = await query(q.query); const embeddingMs = performance.now() - t0;
      const raw = await store.search(vector, 10, { user_id: 'bench' });
      embedded.push({ ...q, vector, embeddingMs, topScore: raw[0]?.score ?? 0 });
    }
    const floor = calibratedFloor(embedded);
    const rows = [];
    for (const q of embedded.filter((q) => q.partition === 'test')) {
      const t0 = performance.now();
      const hits = await hybrid.search(q.query, { scope: 'bench', limit: 10, vector: q.vector,
        minScore: floor, minLexScore: 0.04, fusionMode: 'floored-union' });
      const unfloored = await hybrid.search(q.query, { scope: 'bench', limit: 10, vector: q.vector,
        minScore: 0, minLexScore: 0.04, fusionMode: 'floored-union' });
      const keys = hits.map((h) => String(h.metadata?.corpus_key ?? h.id));
      const rawKeys = unfloored.map((h) => String(h.metadata?.corpus_key ?? h.id));
      rows.push({ id: q.id, class: q.class, expected: q.expected, rankedKeys: keys, rawRankedKeys: rawKeys,
        reciprocalRank: reciprocalRank(q.expected, keys), rawReciprocalRank: reciprocalRank(q.expected, rawKeys),
        rawHits: hits.length, embeddingMs: q.embeddingMs, sqlAndFusionMs: (performance.now() - t0) / 2 });
    }
    const hash = (file: string) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    const report = { model: opts.model, profile, storage: { schema, ...storage }, corpus: opts.corpus,
      snapshotAt: snapshot.snapshotAt, snapshotSha256: hash(opts.snapshot), goldSha256: hash(opts.gold),
      documents: entries.length, calibrationQueries: embedded.filter((q) => q.partition === 'calibration').length,
      calibratedCosineFloor: floor, lexicalFloor: 0.04, documentMs, worker: getWorkerState(), rows,
      limitations: ['small structurally sampled corpus', 'agent-authored labels frozen before inference',
        'calibration and test split by source target', 'SQL timing uses precomputed vectors and averages two fusion calls',
        'entity graph and extraction excluded; production canonical SQL, lexical and hybrid fusion retained'] };
    fs.mkdirSync(path.dirname(opts.out), { recursive: true });
    fs.writeFileSync(opts.out, JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ model: opts.model, corpus: opts.corpus, docs: entries.length, heldout: rows.length, floor, out: opts.out }));
    return report;
  } finally {
    await store?.close();
    await releaseBenchSchema(db, schema);
    await db.end();
    await shutdownLocalEmbedder();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const arg = (name: string) => process.argv[process.argv.indexOf(name) + 1];
  const run = process.argv.includes('--snapshot-out') ? takeCandidateSnapshot(arg('--snapshot-out'))
    : runCandidateHybrid({ snapshot: arg('--snapshot'), gold: arg('--gold'), model: arg('--model') as 'mdenseon',
      modelDirectory: arg('--mdenseon-model'), corpus: arg('--corpus') as 'memory', out: arg('--out') });
  void run.catch((e) => { console.error(e instanceof Error ? e.message : e); process.exitCode = 1; });
}
