import { describe, expect, it } from 'vitest';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createEmbedSidecarServer } from '../embed-sidecar-server';
import { collectSidecarPerformance, summarizePerformanceReceipts, performanceSchedule, isolatedEvaluationBuilders, type PerformanceInput, type PerformanceReceipt } from './sidecar-performance';
import { sidecarEmbedBatch } from '@papercusp/memory';
import { measurementManifestFixture } from './fixtures/measurement-manifest';
import { failMeasurementCell, type PreparedMeasurement } from './measurement-manifest';

const input: PerformanceInput = { formatVersion: 1, seed: 'synthetic', blocks: 5, warmSamples: 3, rounds: 2,
  batches: [1, 2], concurrency: [1, 2], cachedSamples: 2, serverConcurrency: 2,
  requests: { query: [{ id: 'q', corpus: 'memory', text: 'query' }], document: [{ id: 'd', corpus: 'prose', text: 'document' }] } };
describe('performance collector through real HTTP/client/sidecar queue', () => {
  it('keeps the shared client usable across an idle-boundary event-loop pause without retry', async () => {
    // The real warm128 probe failed on the first POST after a 10s gap. Run
    // the same server/client in a production Node child so pausing its loop
    // cannot stall Vitest or its other tests. Synthetic weights isolate the
    // transport; this is a recurrence guard, not model-performance evidence.
    const serverModule = fileURLToPath(new URL('../embed-sidecar-server.ts', import.meta.url));
    const clientModule = fileURLToPath(new URL('../../../../../libs/generic/memory/src/sidecar-embedder.ts', import.meta.url));
    const script = `
      import { createEmbedSidecarServer } from ${JSON.stringify(serverModule)};
      import { sidecarEmbedBatch } from ${JSON.stringify(clientModule)};
      const sidecar = createEmbedSidecarServer({ port: 0, warmAtBoot: false, concurrency: 4,
        builders: { harrier: async () => async () => [1, ...Array(1023).fill(0)] }, log: () => {} });
      const events = [];
      sidecar.server.on('connection', socket => {
        socket.on('timeout', () => events.push({ event: 'timeout', at: Date.now() }));
        socket.on('close', () => events.push({ event: 'close', at: Date.now() }));
      });
      const url = 'http://127.0.0.1:' + await sidecar.listening;
      const report = { keepAliveTimeout: sidecar.server.keepAliveTimeout,
        headersTimeout: sidecar.server.headersTimeout, completed: 0, error: null, events };
      try {
        for (let i = 0; i < 4; i++) {
          await sidecarEmbedBatch(url, { model: 'harrier', kind: 'query', texts: ['frozen'], bypassCache: true });
          report.completed++;
          await new Promise(resolve => setTimeout(resolve, 20));
        }
        report.pauseStartedAt = Date.now();
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 6500);
        report.pauseEndedAt = Date.now();
        await sidecarEmbedBatch(url, { model: 'harrier', kind: 'query', texts: ['frozen'], bypassCache: true });
        report.completed++;
      } catch (error) {
        report.error = { message: error.message, code: error.cause?.code,
          cause: error.cause?.message };
      } finally {
        await sidecar.close();
        console.log(JSON.stringify(report));
        process.exit(0);
      }
    `;
    const result = await new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      const env: NodeJS.ProcessEnv = { ...process.env, PAPERCUSP_FORBID_REAL_PG: '1', PAPERCUSP_EMBED_DEVICE: 'cpu' };
      delete env.VITEST;
      delete env.PAPERCUSP_HTTP_KEEPALIVE_TIMEOUT_MS;
      delete env.PAPERCUSP_HTTP_HEADERS_TIMEOUT_MS;
      const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], { env });
      let stdout = '', stderr = '';
      const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('idle-boundary child exceeded 25s')); }, 25000);
      child.stdout.on('data', (chunk) => { stdout += chunk; });
      child.stderr.on('data', (chunk) => { stderr += chunk; });
      child.once('error', (error) => { clearTimeout(timer); reject(error); });
      child.once('exit', (status) => { clearTimeout(timer); resolve({ status, stdout, stderr }); });
    });
    expect(result.status, result.stderr).toBe(0);
    const report = JSON.parse(result.stdout.trim().split('\n').at(-1)!);
    expect(report.error, JSON.stringify(report)).toBeNull();
    expect(report.completed).toBe(5);
    expect(report.keepAliveTimeout).toBe(61000);
    expect(report.headersTimeout).toBeGreaterThan(report.keepAliveTimeout);
  }, 30000);
  it('retains the actual socket failure cause and frozen request identity in its failure receipt', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'performance-socket-failure-'));
    const server = http.createServer((req) => req.socket.destroy());
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const manifest = measurementManifestFixture(dir);
    const prepared = { manifest, manifestSha256: 'a'.repeat(64), arm: manifest.arms[0], cell: manifest.cells[0],
      rawOutput: path.join(dir, 'out.json'), claimPath: path.join(dir, 'out.running') } as PreparedMeasurement;
    fs.writeFileSync(prepared.claimPath, 'owned');
    try {
      let failure: unknown;
      try { await collectSidecarPerformance(`http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`, prepared.arm, input); }
      catch (error) { failure = error; }
      expect(failure).toBeInstanceOf(Error);
      failMeasurementCell(prepared, failure);
      const receipt = JSON.parse(fs.readFileSync(`${prepared.rawOutput}.failure.json`, 'utf8'));
      expect(receipt.error.cause.cause.code).toBe('UND_ERR_SOCKET');
      expect(receipt.error.request).toMatchObject({ phase: 'cold', kind: 'query', sequence: 0,
        model: prepared.arm.model, requestIds: ['q'], batchSize: 1, concurrency: 1 });
      expect(fs.existsSync(prepared.claimPath)).toBe(false);
      expect(fs.existsSync(prepared.rawOutput)).toBe(false);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
  it('admits all three model arms through the exact isolated CLI builder-map assembler', async () => {
    const arms = measurementManifestFixture('/private').arms;
    const builder = (dims: number) => async () => async () => [1, ...Array(dims - 1).fill(0)];
    const server = createEmbedSidecarServer({ port: 0, concurrency: 1, warmAtBoot: false,
      builders: isolatedEvaluationBuilders(builder(768), { gemma: builder(768), harrier: builder(1024) }),
      modelRevisions: Object.fromEntries(arms.map((a) => [a.model, a.modelRev])) });
    try {
      const url = `http://127.0.0.1:${await server.listening}`;
      for (const arm of arms) {
        const response = await sidecarEmbedBatch(url, { model: arm.model, kind: 'query', texts: ['same frozen request'], bypassCache: true });
        expect(response.modelRev).toBe(arm.modelRev); expect(response.dims).toBe(arm.profile.targetDims);
        expect(response.cache).toEqual({ hits: 0, coalesced: 0, inferred: 1 });
      }
    } finally { await server.close(); }
  });
  it('retains every uncached request and separates real cache hits with group-wall throughput', async () => {
    let calls = 0;
    const arm = measurementManifestFixture('/private').arms[0];
    const server = createEmbedSidecarServer({ port: 0, concurrency: 2, warmAtBoot: false,
      builders: { mdenseon: async () => async () => { calls++; return [1, ...Array(767).fill(0)]; } },
      modelRevisions: { mdenseon: arm.modelRev } });
    try {
      const report = await collectSidecarPerformance(`http://127.0.0.1:${await server.listening}`, arm, input);
      expect(report.samples).toHaveLength(38);
      expect(report.samples.filter((s) => s.phase === 'warm')).toHaveLength(6);
      expect(report.samples.filter((s) => s.phase === 'cached')).toHaveLength(4);
      expect(report.samples.filter((s) => s.phase === 'cached').every((s) => s.cache.hits === 1 && s.cache.inferred === 0)).toBe(true);
      expect(report.samples.filter((s) => s.phase !== 'cached').every((s) => s.cache.inferred === s.batchSize)).toBe(true);
      expect(calls).toBe(report.samples.reduce((n, s) => n + s.cache.inferred, 0));
      expect(report.groups).toHaveLength(8);
      for (const group of report.groups) {
        expect(group.sampleIndices).toHaveLength(input.rounds * group.concurrency);
        expect(group.textsPerSecond).toBeCloseTo(group.sampleIndices.length * group.batchSize * 1000 / group.wallMs);
      }
      expect(report.resource.gpuMemory.status).toBe('not-applicable');
      // Synthetic replay of the collected HTTP rows qualifies the five-block
      // admission guard, never the real-model performance acceptance bar.
      const manifest = measurementManifestFixture('/private'); manifest.seed = input.seed;
      const receipts = performanceSchedule(input.seed, 5, manifest.arms.map((a) => a.id)).map((s, i) => {
        const a = manifest.arms.find((x) => x.id === s.armId)!;
        const copy = structuredClone(report);
        copy.pid = 100000 + i;
        copy.samples = copy.samples.map((x) => ({ ...x, modelRev: a.modelRev, dims: a.profile.targetDims }));
        return { manifestSha256: 'a'.repeat(64), ownerId: manifest.ownerId, cellId: s.cellId, armId: s.armId,
          measuredAt: new Date().toISOString(), report: { ...copy, block: s.block, order: s.order,
            execution: { device: 'cpu', verified: true }, workerState: { alive: true, disabled: false } } } as PerformanceReceipt;
      });
      expect(summarizePerformanceReceipts(manifest, 'a'.repeat(64), input, receipts).performanceComplete).toBe(true);
      const missing = structuredClone(receipts); missing.pop();
      expect(() => summarizePerformanceReceipts(manifest, 'a'.repeat(64), input, missing)).toThrow('cell');
      const shared = structuredClone(receipts); shared[1].report.pid = shared[0].report.pid;
      expect(() => summarizePerformanceReceipts(manifest, 'a'.repeat(64), input, shared)).toThrow('non-fresh');
      const stale = structuredClone(receipts); stale[0].report.warm.query.p99Ms += 1;
      expect(() => summarizePerformanceReceipts(manifest, 'a'.repeat(64), input, stale)).toThrow('raw samples');
      const cached = structuredClone(receipts); cached[0].report.samples.find((s) => s.phase === 'warm')!.cache.hits = 1;
      expect(() => summarizePerformanceReceipts(manifest, 'a'.repeat(64), input, cached)).toThrow('raw samples');
      const group = structuredClone(receipts); group[0].report.groups[1].sampleIndices[0] = group[0].report.groups[0].sampleIndices[0];
      expect(() => summarizePerformanceReceipts(manifest, 'a'.repeat(64), input, group)).toThrow('group sample');
    } finally { await server.close(); }
  });
  it('refuses a stale model revision before producing a performance result', async () => {
    const arm = measurementManifestFixture('/private').arms[0];
    const server = createEmbedSidecarServer({ port: 0, concurrency: 1, warmAtBoot: false,
      builders: { mdenseon: async () => async () => [1, ...Array(767).fill(0)] }, modelRevisions: { mdenseon: 'wrong' } });
    try {
      await expect(collectSidecarPerformance(`http://127.0.0.1:${await server.listening}`, arm, input)).rejects.toThrow('identity mismatch');
    } finally { await server.close(); }
  });
});
