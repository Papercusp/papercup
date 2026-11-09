/** Pre-feature execution evidence, deliberately independent of candidate imports.
 * This covers text artifact handlers on real PG. It does not qualify a native
 * client, the dispatch/transport boundary, shell capture, or the complete matrix.
 */
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { build } from 'esbuild';
import { afterAll, expect, it } from 'vitest';
import { defaultEvidenceRoot, runHarness } from '@papercusp/verification-harness';
import * as tooldef from '@papercusp/tooldef';
import { createOrgTestDb, type OrgTestDb } from '../test/_org-test-db';

const root = resolve(import.meta.dirname, '../../..');
const fixturePath = 'packages/operator-core/test/fixtures/task-artifacts/baseline-729986dd35.json';
const sourceSha = '729986dd35171f1e0cb11bd1505295917f2d946f';
const fixtureSha = '9c7e72bff652470ac294d0aa927e859989c0a3dfc47e56b1143acde4b8e1a7ea';
const digest = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');
type Tool = { args: { parse(input: unknown): unknown }; handler(args: unknown, context: unknown): Promise<unknown> };
type Request = { id: string; method: string; order: number; argsSha256: string; resultSha256?: string; failed?: boolean };
type Trace = { scenario: string; requests: Request[]; helperWakes: string[]; outcome?: string };
let db: OrgTestDb | undefined;
afterAll(async () => { await db?.cleanup(); });

async function originalTools() {
  const raw = readFileSync(join(root, fixturePath));
  expect(digest(raw)).toBe(fixtureSha);
  const fixture = JSON.parse(raw.toString('utf8')) as {
    sourceSha: string; originalCapture: { sha256: string };
    files: Array<{ path: string; content: string; sha256: string }>;
  };
  expect(fixture.sourceSha).toBe(sourceSha);
  const frozen = new Map(fixture.files.map(file => {
    expect(digest(file.content)).toBe(file.sha256);
    return [resolve(root, file.path), file];
  }));
  const tools: Record<string, Tool> = {};
  const dependencies = new Map<string, string>();
  const compiledHandlers: Array<{ method: string; sha256: string; code: string }> = [];
  for (const verb of ['save', 'append', 'load']) {
    const path = resolve(root, `packages/agent-mcp/src/tools/artifacts/${verb}.ts`);
    const original = frozen.get(path)!;
    const result = await build({ absWorkingDir: root, stdin: { contents: original.content, sourcefile: path,
      resolveDir: dirname(path), loader: 'ts' }, bundle: true, write: false,
      platform: 'node', format: 'cjs', packages: 'external', metafile: true,
      plugins: [{ name: 'original-captured-adapters', setup(builder) {
        builder.onLoad({ filter: /\.ts$/ }, args => {
          const captured = frozen.get(args.path);
          return captured ? { contents: captured.content, loader: 'ts', resolveDir: dirname(args.path) } : undefined;
        });
      } }],
    });
    // Resolve external packages normally from the original module's location.
    // The artifact handlers are the captured bytes, never candidate imports or
    // a candidate flag. The current pure helper/dependency pins remain explicit.
    for (const output of Object.values(result.metafile.outputs)) {
      for (const imported of output.imports) if (imported.external)
        expect(['@papercusp/tooldef', 'zod']).toContain(imported.path);
    }
    const module = { exports: {} as { default: Tool } };
    const require = createRequire(path);
    const resolvedRequire = (specifier: string) => specifier === '@papercusp/tooldef' ? tooldef : require(specifier);
    new Function('require', 'module', 'exports', result.outputFiles[0].text)(resolvedRequire, module, module.exports);
    tools[`artifacts:${verb}`] = module.exports.default;
    expect(typeof module.exports.default.handler).toBe('function');
    expect(typeof module.exports.default.args.parse).toBe('function');
    compiledHandlers.push({ method: `artifacts:${verb}`, code: result.outputFiles[0].text,
      sha256: digest(result.outputFiles[0].text) });
    for (const input of Object.keys(result.metafile.inputs)) {
      const full = resolve(root, input);
      const local = relative(root, full);
      expect(local !== '..' && !local.startsWith('../') && !isAbsolute(local), input).toBe(true);
      if (full !== path) dependencies.set(input, digest(frozen.get(full)?.content ?? readFileSync(full)));
    }
  }
  return { tools, sourceSha, portableFixtureSha256: fixtureSha,
    originalCaptureSha256: fixture.originalCapture.sha256,
    compiledHandlers, helperSources: [...dependencies].map(([path, sha256]) => ({ path, sha256 })),
    dependencyLockSha256: digest(readFileSync(join(root, 'package-lock.json'))),
    qualification: 'frozen text-handler execution only; current helpers/packages; no original full-build or transport verdict' };
}

function acceptsPair(baseline: Trace, candidate: Trace): boolean {
  return candidate.outcome === baseline.outcome && candidate.outcome !== undefined
    && candidate.requests.length <= baseline.requests.length && candidate.helperWakes.length === 0;
}

it('captures original budget.save/budget.append/budget.read handlers on PG and rejects added requests or helper wakes', async context => {
  const captured = await originalTools();
  const workspace = 'ws-artifact-baseline';
  const slug = 'artifact-baseline';
  const traces: Trace[] = [];
  const result = await runHarness({
    contract: { name: 'managed-artifact-text-baseline', phases: [
      { id: 'prepare' }, { id: 'capture', dependsOn: ['prepare'] }, { id: 'teardown' },
    ] }, evidenceRoot: defaultEvidenceRoot('isolated-integration'),
    retainedArtifacts: ['phases/capture/baseline-traces.json', 'phases/prepare/source.json'],
    runPhase: async phase => {
      if (phase.phase === 'prepare') {
        writeFileSync(join(phase.evidenceDir, 'source.json'), JSON.stringify({ ...captured, tools: undefined }));
        db = await createOrgTestDb();
      } else if (phase.phase === 'capture') {
        const retainTrace = () => writeFileSync(join(phase.evidenceDir, 'baseline-traces.json'), JSON.stringify({
          sourcePacket: '../prepare/source.json', sourceSha, portableFixtureSha256: fixtureSha,
          adapter: 'frozen-text-handler', traces, completedMatrix: false,
          unmeasured: ['dispatch/transport', 'shell', 'native clients',
            'takeover/handoff', 'test runner', 'computer', 'candidate comparison'],
        }, null, 2));
        const request = async (trace: Trace, method: string, args: Record<string, unknown>) => {
          const entry: Request = { id: randomUUID(), method, order: trace.requests.length,
            argsSha256: digest(JSON.stringify(args)) };
          trace.requests.push(entry);
          retainTrace();
          try {
            const tool = captured.tools[method];
            const response = await db!.appSql.begin(async tx => {
              await tx`SELECT set_config('app.workspace_id', ${workspace}, true)`;
              return tool.handler(tool.args.parse(args), { tx, workspaceId: workspace, harnessSlug: slug,
                role: 'operator', log: () => {}, signal: new AbortController().signal,
                emit: async () => {}, progress: async () => {} });
            });
            entry.resultSha256 = digest(JSON.stringify(response));
            // The shared bulkContent writer returns typed ToolResponse.data;
            // this fixture calls handlers, not the MCP serialization wrapper.
            const envelope = (response as { data: { ok: boolean; results: Array<{ content: string }> } }).data;
            expect(envelope.ok).toBe(true);
            return envelope.results[0];
          } catch (error) { entry.failed = true; throw error; }
          finally { retainTrace(); }
        };
        const start = (scenario: string): Trace => {
          const trace = { scenario, requests: [], helperWakes: [] };
          traces.push(trace); return trace;
        };
        const save = start('budget.save');
        await request(save, 'artifacts:save', { slug, rel_path: 'save.txt', content: 'baseline bytes 🧪' });
        const saved = await request(save, 'artifacts:load', { slug, rel_path: 'save.txt' });
        expect(saved.content).toBe('baseline bytes 🧪');
        save.outcome = digest(saved.content);
        const append = start('budget.append');
        await request(append, 'artifacts:save', { slug, rel_path: 'append.txt', content: 'A' });
        for (const suffix of ['B', 'C']) await request(append, 'artifacts:append', { slug, rel_path: 'append.txt', suffix });
        const appended = await request(append, 'artifacts:load', { slug, rel_path: 'append.txt' });
        expect(appended.content).toBe('ABC'); append.outcome = digest(appended.content);
        const read = start('budget.read');
        const loaded = await request(read, 'artifacts:load', { slug, rel_path: 'save.txt' });
        expect(loaded.content).toBe(saved.content); read.outcome = digest(loaded.content);
        expect(traces.map(trace => trace.requests.length)).toEqual([2, 4, 1]);
        for (const trace of traces) {
          expect(acceptsPair(trace, structuredClone(trace))).toBe(true);
          for (const method of ['allocate', 'finalize', 'register', 'list', 'pin', 'page']) {
            const extra = structuredClone(trace);
            extra.requests.push({ id: randomUUID(), method, order: extra.requests.length, argsSha256: digest('{}') });
            expect(acceptsPair(trace, extra), method).toBe(false);
          }
          const hidden = structuredClone(trace); hidden.helperWakes.push('forbidden-helper-wake');
          expect(acceptsPair(trace, hidden)).toBe(false);
          const partial = structuredClone(trace); partial.outcome = undefined;
          expect(acceptsPair(trace, partial)).toBe(false);
        }
        retainTrace();
      } else {
        await db?.cleanup(); db = undefined;
      }
      return { ok: true };
    },
  });
  Object.assign(context.task.meta, { managedArtifactBaselineRun: result.runId });
  console.info('MANAGED_ARTIFACT_TEXT_BASELINE ' + JSON.stringify({ runId: result.runId,
    evidenceDir: result.evidenceDir, verdict: result.verdict, completedMatrix: false }));
  expect(result.verdict, JSON.stringify(result.phases)).toBe('pass');
}, 180_000);
