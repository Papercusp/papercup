import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { measureTestingBackgroundScenario } from '../test/testing-background-http-scenario';

vi.mock('./harness-registry', () => ({
  loadHarnessRegistry: vi.fn(async () => ({ projects: [] })),
  saveHarnessRegistry: vi.fn(async () => {}),
}));

const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

it('recovers the full status before consuming result, command and source custody', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'background-status-consumer-')); roots.push(directory);
  const evidenceDir = join(directory, 'execute');
  const prepare = join(directory, 'prepare');
  const artifacts = join(directory, 'original-artifacts');
  await Promise.all([evidenceDir, prepare, artifacts].map(path => mkdir(path)));
  const core = 'export const fixture = true;';
  const witness = { schemaVersion: 1, sourceSha256: 'a'.repeat(64),
    artifactSha256: createHash('sha256').update(core).digest('hex') };
  await writeFile(join(prepare, 'testing-core.worker.mjs'), core);
  await writeFile(join(prepare, 'testing-core.worker.witness.json'), JSON.stringify({ witness }));
  const deadline = { taskDeadlineAtMs: Date.now() + 60_000, childCutoffAtMs: Date.now() + 50_000,
    cleanupReserveMs: 10_000 };
  const phases = ['core-import-start', 'core-import-complete', 'core-witness-verified',
    'core-execution-start', 'core-execution-complete'];
  const result = { ok: true, passed: 1, failed: 0,
    artifacts: { directory: artifacts, manifest: join(artifacts, 'manifest.json') } };
  const output = [...phases.map(phase => JSON.stringify({ schemaVersion: 'testing-run-bootstrap-v1',
    phase, runId: 'consumer-run', ...deadline,
    ...(phase === 'core-witness-verified' ? { coreMode: 'compiled', witnessSchemaVersion: 1,
      sourceSha256: witness.sourceSha256, artifactSha256: witness.artifactSha256 } : {}) })),
  JSON.stringify(result), 'cleanup detail\n'.repeat(1000)].join('\n');
  const requests: Array<{ name: string; args: Record<string, unknown> }> = [];
  vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init?: RequestInit) => {
    const request = JSON.parse(String(init?.body)); requests.push(request);
    let data: unknown;
    if (request.name === 'testing:run') {
      const corpus = join(evidenceDir, 'dirty-corpus');
      const source = await readFile(join(corpus, 'dirty.integration.test.ts'));
      await writeFile(join(corpus, 'executions.txt'), 'once\n');
      await writeFile(join(artifacts, 'source.json'), JSON.stringify({ inputs: [{ path: 'dirty.integration.test.ts',
        sha256: createHash('sha256').update(source).digest('hex') }] }));
      await writeFile(result.artifacts.manifest, JSON.stringify({ childState: 'closed', cleanup: { complete: true }, deadline }));
      data = { ok: true, mode: 'background', status: 'pending', detachedRunId: 'consumer-run',
        detachedDurable: true, deadline };
    } else {
      expect(request.name).toBe('testing:run-status');
      const full = request.args.payloadTier === 'full';
      data = { ok: true, snapshot: { runId: 'consumer-run', taskId: 'consumer-task', status: 'pass',
        output: full ? output : '[TRUNCATED — request full output]\n' + output.slice(-2048),
        ...(full ? { command: [process.execPath, '--input-type=module', '-e', 'compiled fixture'] }
          : { commandOmitted: true }) } };
    }
    return new Response(JSON.stringify({ ok: true, result: { structuredContent: data } }), { status: 200 });
  }));

  const receipt = await measureTestingBackgroundScenario({ workspace: 'test-runtime-consumer', harness: 'papercusp',
    base: 'http://private-fixture.invalid', headers: {}, evidenceDir, root: resolve(import.meta.dirname, '../../..') });

  expect(receipt).toMatchObject({ executions: 1, cleanupComplete: true, bootstrapPhases: phases,
    terminal: { runId: 'consumer-run', status: 'pass' }, compiledCore: witness });
  expect(requests.map(row => row.name)).toEqual(['testing:run', 'testing:run-status']);
  expect(requests[1]!.args).toEqual({ runId: 'consumer-run', payloadTier: 'full' });
  await rm(artifacts, { recursive: true });
  expect(JSON.parse(await readFile(join(evidenceDir, 'background-core-artifacts', 'manifest.json'), 'utf8')))
    .toMatchObject({ childState: 'closed', cleanup: { complete: true }, deadline });
});
