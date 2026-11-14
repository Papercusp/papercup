import { describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { sharedSystemShapes } from './shared-system-shapes';

vi.mock('@papercusp/flags/server', () => ({ getFlag: vi.fn().mockResolvedValue(true) }));
vi.mock('@papercusp/host-platform/home', async original => {
  const actual = await original<typeof import('@papercusp/host-platform/home')>();
  const { homedir } = await import('node:os');
  const { join } = await import('node:path');
  return { ...actual, papercuspPath: (...parts: string[]) => join(homedir(), '.papercusp', ...parts) };
});

import { agentAntipatterns as scanAdvisories } from './agent-antipatterns';
import { codeIntelPushText, snapshotAntipatternLeg, type PushFact, type PushInput } from './push-channel';
import { parsePushSnapshot } from './push-snapshot';
import { collectAntipatternEdits } from '../../../../apps/operator/scripts/hooks/inject/core.mjs';

// Isolate the unrelated R8 ast-grep rules; the new syntax parser and the shared
// introduction/delivery logic are real. These unit cases need no provisioned host tool.
const agentAntipatterns = (before: string | null, after: string) => scanAdvisories(before, after, 'ts', 'edit.ts', async () => []);

const fixtures = [
  { id: 'bespoke-condition-operators', source: `function compare(op) { switch (op) {
    case 'eq': return a === b; case 'ne': return a !== b; case 'gt': return a > b;
  } }`, calls: ['evaluateOperatorTest', 'libs/generic/rules'] },
  { id: 'status-poll-comparison', source: `setInterval(async () => {
    const row = await getTask(); if (row.status !== previousStatus) react(row);
  }, 1000);`, calls: ['emitSystemEvent', 'reaction rule', 'useSyncQuery'] },
  { id: 'cross-module-event-bus', source: `import { EventEmitter } from 'node:events';
    export const bus = new EventEmitter();`, calls: ['emitSystemEvent', 'reaction rule'] },
] as const;
const shapeIds = new Set(fixtures.map(fixture => fixture.id));
const shapeHits = (result: Awaited<ReturnType<typeof agentAntipatterns>>) =>
  result.hits.filter(hit => shapeIds.has(hit.ruleId as typeof fixtures[number]['id']));
const snapshot = parsePushSnapshot(JSON.stringify({ schema: 'graph-dependency-snapshot-v1',
  index: { backend: 'first-party-imports', lastCommit: 'a'.repeat(40) }, generatedAt: new Date().toISOString(),
  edges: [{ importer: 'consumer.ts', imported: 'edit.ts', importerSha256: 'c'.repeat(64) }] }))!;

describe('rules events reuse', () => {
  it('R-67 warns with exact shared calls for each positive shape and no negative shape', async () => {
    for (const fixture of fixtures) {
      const result = await agentAntipatterns('', fixture.source);
      expect(result.status, result.error).toBe('measured');
      expect(shapeHits(result)).toMatchObject([{ ruleId: fixture.id }]);
      const facts = snapshotAntipatternLeg({ owner: 'agent', workspace: 'ws', calls: [{ tool: 'Edit',
        antipatternEdits: [{ path: 'edit.ts', ...result }] }] });
      expect(facts).toHaveLength(1);
      for (const call of fixture.calls) expect(facts[0].text).toContain(call);
    }
    for (const source of [
      `switch (op) { case 'eq': break; case 'ne': break; }`,
      `setInterval(() => { if (cached.status !== previousStatus) react(); }, 1000);`,
      `import { EventEmitter } from 'node:events'; const local = new EventEmitter(); local.emit('ready');`,
    ]) {
      const result = await agentAntipatterns('', source);
      expect(result.status, result.error).toBe('measured');
      expect(shapeHits(result)).toEqual([]);
    }
  });

  it('R-68 routes Edit and Write shape warnings through the existing advisory only', async () => {
    const root = await mkdtemp(join(tmpdir(), 'shared-system-shapes-'));
    try {
      await mkdir(join(root, 'scripts'));
      await writeFile(join(root, 'scripts/check-required-field-strands.mjs'), '// repository marker');
      for (const tool of ['Edit', 'Write']) for (const fixture of fixtures) {
        await writeFile(join(root, 'edit.ts'), fixture.source);
        const body = { cwd: root, toolCalls: [{ tool, editedPaths: ['edit.ts'] }] };
        const prepare = vi.fn(async (file: string, repo: string) => ({ path: relative(repo, file),
          ...await agentAntipatterns('', await readFile(file, 'utf8')) }));
        // The collector discovers the real root; this seam isolates only that filesystem boundary.
        await collectAntipatternEdits(body, async (file: string) => prepare(file, root));
        expect(prepare).toHaveBeenCalledTimes(1);
        const commit = vi.fn(async (_input: PushInput, _snapshot: unknown, facts: PushFact[]) => facts.map(f => f.text).join('\n'));
        const input: PushInput = { owner: 'agent', workspace: 'ws', root, calls: body.toolCalls };
        const deps = { snapshot: async () => snapshot, enabled: async () => true,
          legs: () => new Map([['antipattern' as const, snapshotAntipatternLeg]]), commit };
        const text = await codeIntelPushText(input, deps);
        expect(commit).toHaveBeenCalledTimes(1);
        expect(commit.mock.calls[0][2]).toMatchObject([{ leg: 'antipattern', citedPaths: ['edit.ts'] }]);
        for (const call of fixture.calls) expect(text).toContain(call);
        expect(snapshotAntipatternLeg({ ...input, calls: [{ ...body.toolCalls[0], tool: 'Read' }] })).toEqual([]);
        await writeFile(join(root, 'edit.ts'), '// superseded edit');
        expect(await codeIntelPushText(input, deps)).toBe('');
        expect(commit).toHaveBeenCalledTimes(1);
      }
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});

describe('shared-system shape controls', () => {
  it('parses declaration modules, decorators and TSX without changing the syntax population', () => {
    expect(sharedSystemShapes('export const schema: Readonly<Record<string, unknown>>;', 'schema.d.mts')).toEqual([]);
    expect(sharedSystemShapes('@Entity() export class Model { @field() status!: string; }', 'model.ts')).toEqual([]);
    const result = sharedSystemShapes(`const view = <div />; ${fixtures[1].source}`, 'panel.tsx');
    expect(result.map(hit => hit.ruleId)).toEqual(['status-poll-comparison']);
  });

  it('keeps compiler startup outside the cold advisory worker dependency graph', async () => {
    const moduleUrl = new URL('./agent-antipatterns.ts', import.meta.url).href;
    const script = `const { agentAntipatterns } = await import(${JSON.stringify(moduleUrl)});
      const { createRequire } = await import('node:module');
      const require = createRequire(${JSON.stringify(moduleUrl)});
      const result = await agentAntipatterns('', ${JSON.stringify(fixtures[0].source)}, 'ts', 'edit.ts', async () => []);
      console.log(JSON.stringify({ status: result.status, ids: result.hits.map(hit => hit.ruleId),
        compilerLoaded: Object.keys(require.cache).some(path => /node_modules[\\/](?:typescript|@typescript[\\/]old)[\\/]/.test(path)) }));`;
    const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script], { timeout: 5000 });
    expect(JSON.parse(stdout)).toEqual({ status: 'measured', ids: ['bespoke-condition-operators'], compilerLoaded: false });
  });

  it('declares the runtime syntax parser in both workspace manifests', async () => {
    const manifest = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8'));
    const lock = JSON.parse(await readFile(new URL('../../../../package-lock.json', import.meta.url), 'utf8'));
    expect(manifest.dependencies['@babel/parser']).toBeTruthy();
    expect(lock.packages['packages/operator-core'].dependencies['@babel/parser']).toBe(manifest.dependencies['@babel/parser']);
    expect(lock.packages['node_modules/@babel/parser'].version).toBe(manifest.dependencies['@babel/parser']);
  });

  it.each([
    ['same-subject if chain', `if (op === 'eq') a(); else if (op === 'ne') b(); else if (op === 'gt') c();`, 'bespoke-condition-operators'],
    ['early returns and reversed comparisons', `function test(op) { if ('eq' === op) return 1; if ('ne' === op) return 2; if ('gt' === op) return 3; }`, 'bespoke-condition-operators'],
    ['named timer callback', `async function poll() { const status = await readStatus(); if (status !== prior) react(); } setInterval(poll, 100);`, 'status-poll-comparison'],
    ['direct timer read comparison', `setTimeout(async () => { if (await readStatus() === 'ready') react(); }, 100);`, 'status-poll-comparison'],
    ['aliased exported emitter', `import { EventEmitter as Bus } from 'events'; const bus = new Bus(); export { bus };`, 'cross-module-event-bus'],
    ['namespace default export', `import * as events from 'node:events'; export default new events.EventEmitter();`, 'cross-module-event-bus'],
  ])('recognizes %s', async (_label, source, id) => {
    const result = await agentAntipatterns('', source);
    expect(result.status, result.error).toBe('measured');
    expect(shapeHits(result).map(hit => hit.ruleId)).toContain(id);
    expect((await agentAntipatterns(source, '\n' + source)).hits).toEqual([]);
  });

  it.each([
    ['repeated operator', `if (op === 'eq') a(); else if (op === 'eq') b(); else if (op === 'ne') c();`],
    ['unrelated comparison subjects', `if (a === 'eq') a(); if (b === 'ne') b(); if (c === 'gt') c();`],
    ['separate functions', `function a() { if (op === 'eq') return 1; } function b() { if (op === 'ne') return 2; } function c() { if (op === 'gt') return 3; }`],
    ['comments and strings', `// switch(op) { case 'eq': case 'ne': case 'gt': }\nconst sample = "export const bus = new EventEmitter()";`],
    ['timer without comparison', `setInterval(async () => { const row = await getTask(); render(row.status); }, 1000);`],
    ['timer with unrelated read', `setInterval(async () => { await loadUsers(); if (cached.status !== prior) react(); }, 1000);`],
    ['nested callback only', `setInterval(() => { const later = async () => { if (await readStatus() !== prior) react(); }; save(later); }, 1000);`],
    ['unrelated constructor', `class EventEmitter {} export const bus = new EventEmitter();`],
    ['exported unrelated value', `import { EventEmitter } from 'events'; const local = new EventEmitter(); export const answer = 42;`],
  ])('does not warn for %s', async (_label, source) => {
    const result = await agentAntipatterns('', source);
    expect(result.status, result.error).toBe('measured');
    expect(shapeHits(result)).toEqual([]);
  });
});
