/** Real HTTP/client + migrated PostgreSQL protocol qualification. Synthetic
 * vectors deliberately do NOT satisfy real-weight measurement bars P-002..008. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CanonicalVectorStore, HybridBackend, LexicalLegBackend, MEMORY_VECTOR_STORAGE_PROFILES, sidecarEmbedBatch } from '@papercusp/memory';
import { createOrgTestDb, type OrgTestDb } from '../../../test/_org-test-db';
import { createEmbedSidecarServer, type EmbedSidecarHandle } from '../embed-sidecar-server';
import { ensureBenchSchema, releaseBenchSchema } from './bench-host';
import { canonicalCandidateBackend, candidateProfile } from './candidate-hybrid-bench';
import { independentCohortFixture, measurementManifestFixture } from './fixtures/measurement-manifest';
import { fingerprintFile, prepareMeasurementCell, measurementOutputPaths, writeMeasurementCell, assertMeasuredEmbedResponse,
  failMeasurementCell, type MeasurementManifest, type PreparedMeasurement } from './measurement-manifest';

describe('frozen candidate manifest crosses actual HTTP/client/SQL seams', () => {
  let db: OrgTestDb, client: Client, server: EmbedSidecarHandle, store: CanonicalVectorStore;
  let root: string, manifestFile: string, manifestHash: string, manifest: MeasurementManifest, prepared: PreparedMeasurement;
  let inferred = 0;
  const schema = `bench_memory_${process.pid}`;
  const repo = path.resolve(import.meta.dirname, '../../../../..');
  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'measurement-protocol-'));
    manifest = measurementManifestFixture(root, execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim());
    const { entries, queries, proof } = independentCohortFixture();
    const write = async (name: string, value: unknown) => { const file = path.join(root, `${name}.json`);
      fs.writeFileSync(file, JSON.stringify(value)); return fingerprintFile(file); };
    manifest.inputs.snapshot = await write('snapshot', { suites: { memory: { entries }, prose: { entries } } });
    manifest.inputs.labels = await write('labels', { memory: queries, prose: queries });
    const judges = await Promise.all([1, 2].map(async (n) => ({ ...proof.judges[n - 1], raw: await write(`judge-${n}`, { synthetic: true, transport: n, queryIds: proof.queryIds }) })));
    const receipt = { ...proof, judges, snapshotSha256: manifest.inputs.snapshot.sha256, labelsSha256: manifest.inputs.labels.sha256 };
    manifest.inputs.judgments = await write('judgments', { memory: receipt, prose: receipt });
    manifest.inputs.census = await write('census', { synthetic: true, accessibleSources: ['source-a', 'source-b'] });
    const asset = await write('synthetic-model', { synthetic: true });
    for (const arm of manifest.arms) { arm.artifacts = { graph: asset, tokenizer: asset, config: asset }; arm.runtime.source = asset; }
    manifestFile = path.join(root, 'manifest.json'); fs.writeFileSync(manifestFile, JSON.stringify(manifest));
    manifestHash = (await fingerprintFile(manifestFile)).sha256;
    prepared = await prepareMeasurementCell(manifestFile, manifestHash, 'hybrid', repo);
    await expect(prepareMeasurementCell(manifestFile, manifestHash, 'hybrid', repo)).rejects.toThrow('already owned');
    db = await createOrgTestDb(); client = new Client({ connectionString: db.adminDsn }); await client.connect();
    await ensureBenchSchema(client, schema);
    const url = new URL(db.adminDsn), profile = candidateProfile('mdenseon');
    store = new CanonicalVectorStore({ host: url.hostname, port: Number(url.port), user: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password), dbname: url.pathname.slice(1), schema,
      vecTable: MEMORY_VECTOR_STORAGE_PROFILES.gemma.table, embeddingModelDims: 768, embeddingProfile: profile,
      storageProfile: { ...MEMORY_VECTOR_STORAGE_PROFILES.gemma, acceptedProfileIds: [profile.profileId] } });
    server = createEmbedSidecarServer({ port: 0, warmAtBoot: false, concurrency: 1, log: () => {},
      modelRevisions: { mdenseon: manifest.arms[0].modelRev }, builders: { mdenseon: async () => async () => {
        inferred++; return [1, ...new Array(767).fill(0)]; } } });
  }, 120_000);
  afterAll(async () => {
    await server?.close(); await store?.dispose();
    if (client) { await releaseBenchSchema(client, schema); await client.end(); }
    await db?.cleanup(); if (root) fs.rmSync(root, { recursive: true, force: true });
  });
  it('accepts verified uncached HTTP vectors, seeds the actual store and replays lexical/semantic fusion', async () => {
    const response = await sidecarEmbedBatch(`http://127.0.0.1:${await server.listening}`, {
      model: 'mdenseon', kind: 'query', texts: ['original source A'], bypassCache: true });
    assertMeasuredEmbedResponse(prepared.arm, response, 1);
    expect(inferred).toBe(1);
    await store.insert(response.vectors, ['00000000-0000-4000-8000-000000000001'], [{ data: 'original source A', user_id: 'bench', metadata: { corpus_key: 'a' } }]);
    const canonical = canonicalCandidateBackend(store);
    const hybrid = new HybridBackend(new LexicalLegBackend(canonical), canonical, { name: 'hybrid-pg' });
    const hits = await hybrid.search('original source A', { scope: 'bench', limit: 10, vector: response.vectors[0], minScore: 0, fusionMode: 'floored-union' });
    expect(hits.map((h) => h.metadata?.corpus_key)).toContain('a');
    await expect(canonical.search('source A', { scope: 'production', vector: response.vectors[0] })).rejects.toThrow('isolated');
    const outcome = writeMeasurementCell(prepared, { protocolOnly: true, rankedKeys: hits.map((h) => h.metadata?.corpus_key) });
    expect(await fingerprintFile(outcome.artifacts[0].path)).toEqual(outcome.artifacts[0]);
    expect(() => writeMeasurementCell(prepared, {})).toThrow(/EEXIST/);
  });
  it('refuses altered frozen bytes and reused output before another HTTP request or SQL write', async () => {
    const before = inferred;
    fs.appendFileSync(manifest.inputs.labels.path, ' ');
    await expect(prepareMeasurementCell(manifestFile, manifestHash, 'performance', repo)).rejects.toThrow('fingerprint');
    const run = promisify(execFile);
    const common = ['--manifest', manifestFile, '--manifest-sha256', manifestHash];
    const runners = [
      ['candidate-hybrid-bench.ts', '--cell', 'hybrid', '--snapshot', manifest.inputs.snapshot.path,
        '--gold', manifest.inputs.labels.path, '--model', 'mdenseon', '--corpus', 'memory', '--out', prepared.rawOutput],
      ['embedder-eval-cli.ts', '--cell', 'performance', '--legs', 'sidecar:mdenseon', '--isolated-sidecar', '--mdenseon-model', root,
        '--out', path.join(root, manifest.runId, 'performance.json')],
    ];
    for (const [entry, ...args] of runners) {
      await expect(run(process.execPath, ['--import', 'tsx', path.join(import.meta.dirname, entry), ...args, ...common],
        { cwd: repo, timeout: 20_000 })).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('declared file fingerprint mismatch') });
    }
    fs.writeFileSync(manifest.inputs.labels.path, JSON.stringify({ memory: independentCohortFixture().queries, prose: independentCohortFixture().queries }));
    expect(() => measurementOutputPaths(manifest, manifest.cells.find((c) => c.id === 'hybrid')!, repo)).toThrow('already exists');
    expect(inferred).toBe(before);
    expect((await client.query(`SELECT count(*)::int AS n FROM ${schema}.memory_canonical`)).rows[0].n).toBe(1);
  }, 45_000);
  it('does not accept a real HTTP cache hit as a model measurement', async () => {
    const url = `http://127.0.0.1:${await server.listening}`;
    const call = () => sidecarEmbedBatch(url, { model: 'mdenseon', kind: 'query', texts: ['cache protocol'] });
    assertMeasuredEmbedResponse(prepared.arm, await call(), 1);
    const cached = await call(); expect(cached.cache?.hits).toBe(1);
    expect(() => assertMeasuredEmbedResponse(prepared.arm, cached, 1)).toThrow('accounting');
  });
  it('retains a phase failure and requires a new attempt instead of overwriting its diagnosis', async () => {
    const attempt = await prepareMeasurementCell(manifestFile, manifestHash, 'reliability', repo);
    const error = new Error('injected protocol failure before inference');
    failMeasurementCell(attempt, error);
    expect(JSON.parse(fs.readFileSync(`${attempt.rawOutput}.failure.json`, 'utf8'))).toMatchObject({
      manifestSha256: manifestHash, cellId: 'reliability', error: { message: error.message } });
    expect(fs.existsSync(attempt.claimPath)).toBe(false);
    await expect(prepareMeasurementCell(manifestFile, manifestHash, 'reliability', repo)).rejects.toThrow('already owned/failed');
  });
});
