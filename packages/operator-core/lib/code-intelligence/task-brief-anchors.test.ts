import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as ts from 'typescript';
import { buildTaskBrief, getClaimTimeTaskBrief, TASK_BRIEF_BUDGET_MS, TASK_BRIEF_MAX_CHARS, type TaskBriefDeps } from './task-brief';
import { firstPartyCallers } from './first-party-callers';
import { declarationContentHash, type PlanItemAnchor } from '../plan-items/anchors';
import { toolsetFromNames } from './push-toolset';

const roots: string[] = [];
afterEach(() => { vi.useRealTimers(); roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'anchor-claim-')); roots.push(root);
  writeFileSync(join(root, 'target.ts'), 'export function other() { return 0; }\nexport function target() { return 1; }\n');
  const deps: TaskBriefDeps = {
    toolset: async () => toolsetFromNames(['code:pack', 'work_items:get']),
    root: async () => root,
    effects: { exec: async () => ({ stdout: '', stderr: '' }), writeArtifact: async () => '', now: () => new Date(0) },
    graph: vi.fn(async () => ({ error: 'fixture graph unavailable' } as never)),
    pack: async (_op, args) => {
      const path = join(root, 'pack.xml');
      writeFileSync(path, args.include.map(file => `<file path="${file}">${readFileSync(join(root, file), 'utf8')}</file>`).join('\n'));
      return { answer: { error: null, sites: args.include.map(path => ({ path })) },
        artifact: { path, provenance: { commit: 'deterministic-fixture' } } } as never;
    },
  };
  return { root, deps, ref: { workspaceId: 'fixture-workspace', workItem: { id: 'WI-anchors-fixture', harness: 'fixture',
    payload: { paths: ['target.ts'] } } } };
}

describe('plan anchors P008 claim brief', () => {
  it('SPEC-P-008-NOLINKS preserves the deterministic pre-change whole-file golden', async () => {
    const { root, deps, ref } = fixture();
    const brief = await buildTaskBrief(ref, deps);
    expect(JSON.parse(JSON.stringify(brief).replaceAll(root, '<fixture-root>'))).toMatchInlineSnapshot(`
      {
        "commit": "deterministic-fixture",
        "excerpts": [
          {
            "path": "target.ts",
            "text": "export function other() { return 0; }
      export function target() { return 1; }",
          },
        ],
        "exclusions": [
          "Evidence outside the stored task scope is excluded; compiler dependencies may be read internally. Static consumers do not prove runtime execution.",
        ],
        "files": [
          {
            "kind": "implementation",
            "path": "target.ts",
            "sha256": "94091c4a23502e0b5913fc996e4aaecc8c504a0084faa794bb52b93d6eec98e1",
          },
        ],
        "graph": {
          "consumers": [],
          "reason": "fixture graph unavailable",
          "relationships": [],
          "status": "unknown",
        },
        "recover": {
          "args": {
            "include": [
              "target.ts",
            ],
            "op": "pack",
            "rootPath": "<fixture-root>",
          },
          "tool": "code:pack",
        },
        "repository": {
          "rootPath": "<fixture-root>",
          "workspaceId": "fixture-workspace",
        },
        "scope": {
          "harness": "fixture",
          "paths": [
            "target.ts",
          ],
        },
        "sourceFingerprint": "7716bbfb9351b40dd975be4697d76c3c4320ffc2fdd43dfc139c3ebcd7d7cee0",
        "status": "current",
      }
    `);
  });

  async function linkedFixture() {
    const f = fixture();
    writeFileSync(join(f.root, 'consumer.ts'), 'import { target } from "./target";\nexport function consumer() { return target(); }\n');
    writeFileSync(join(f.root, 'new.ts'), 'import { target } from "./target";\nexport const added = target();\n');
    writeFileSync(join(f.root, 'target.test.ts'), 'import { consumer } from "./consumer";\nexport const test = consumer();\n');
    writeFileSync(join(f.root, 'other-only.ts'), 'import { other } from "./target";\nexport const unrelated = other();\n');
    writeFileSync(join(f.root, 'other.test.ts'), 'import { unrelated } from "./other-only";\nexport const test = unrelated;\n');
    const contentHash = await declarationContentHash(readFileSync(join(f.root, 'target.ts'), 'utf8'), {
      id: 'target', name: 'target', path: 'target.ts', line: 2, column: 17, sha256: '', signature: '', aliases: [], callers: [],
    });
    const anchor: PlanItemAnchor = { anchorKind: 'symbol', requested: 'target', symbolId: 'target', symbolName: 'target',
      path: 'target.ts', line: 2, signature: null, contentHash, consumers: [{ path: 'consumer.ts', line: 2 }, { path: 'removed.ts', line: 1 }],
      consumersTotal: 2, tests: [], resolution: 'resolved', unknownReason: null, freshness: 'fresh', resolvedCommit: 'a'.repeat(40) };
    // The compiler is real. Capture before starting the interactive deadline; its source pins are rechecked by nativeChangeReport.
    const graph = firstPartyCallers({ ts, root: f.root, name: 'target', filePath: 'target.ts', paths: ['.'],
      op: 'impact', direction: 'downstream', maxDepth: 5, maxPaths: 20, limit: 50 });
    expect(graph.error).toBeNull();
    f.deps.anchors = { graph: vi.fn(async () => graph), writeArtifact: async () => 'fixture-artifact',
      links: vi.fn(async () => ({ docs: null, specs: null, byPath: { 'target.ts': { docs: ['target-guide'], specs: ['plan#REQ@1'] } } })),
      locks: vi.fn(async () => [
        { path: 'consumer.ts', owner: 'su-peer', goalRef: 'WI-peer', intent: 'consumer edit', coordinationDomain: f.root },
        { path: 'new.ts', owner: 'su-foreign', intent: 'another checkout', coordinationDomain: '/another/root' },
        { path: 'other-only.ts', owner: 'su-other', intent: 'unrelated function', coordinationDomain: f.root },
      ]),
    };
    return { ...f, anchor, linked: { workspaceId: 'fixture-workspace', owner: 'su-claim', workItem: {
      ...f.ref.workItem, payload: { anchors: [anchor], paths: ['other-only.ts'] } } } };
  }

  it('SPEC-P-008/SCOPE/DELTA/IMPACT: starts from the linked function, including callers outside payload.paths', async () => {
    const { deps, linked } = await linkedFixture();
    const brief = (await getClaimTimeTaskBrief(linked, deps))!.taskBrief;
    expect(brief.status, JSON.stringify(brief)).toBe('current');
    expect(brief.scope.paths).toEqual(['target.ts']);
    expect(deps.graph).not.toHaveBeenCalled();
    const subject = brief.anchors?.subjects[0];
    expect(subject, JSON.stringify(brief)).toMatchObject({ symbol: 'target', status: 'measured', freshness: 'fresh',
      callers: expect.arrayContaining(['consumer.ts:2', 'new.ts:2']), tests: ['target.test.ts'],
      impact: expect.arrayContaining(['consumer.ts', 'new.ts', 'target.test.ts']),
      addedSincePlanning: ['new.ts:2'], removedSincePlanning: ['removed.ts:1'] });
    expect(JSON.stringify(brief.anchors)).not.toMatch(/other-only|other.test/);
    expect(JSON.stringify(brief).length).toBeLessThanOrEqual(TASK_BRIEF_MAX_CHARS);
  });

  it('SPEC-P-008-CONTEXT: carries anchored docs, dependent specs and peer locks from the registered checkout', async () => {
    const { deps, linked } = await linkedFixture();
    const brief = await buildTaskBrief(linked, deps);
    expect(brief.anchors).toMatchObject({ docs: ['target-guide'], specs: ['plan#REQ@1'],
      locks: [{ path: 'consumer.ts', owner: 'su-peer', goalRef: 'WI-peer' }] });
    expect(deps.anchors!.links).toHaveBeenCalledWith(expect.objectContaining({ harness: 'fixture', workspace: 'fixture-workspace' }), ['target.ts']);
  });

  it('reports a renamed or deleted declaration as missing without choosing the other function', async () => {
    const { deps, linked, anchor } = await linkedFixture();
    anchor.symbolName = 'deleted';
    const brief = await buildTaskBrief(linked, deps);
    expect(brief.anchors?.subjects[0]).toMatchObject({ status: 'unknown', freshness: 'missing', callers: [], addedSincePlanning: null });
    expect(deps.anchors!.graph).not.toHaveBeenCalled();
    expect(deps.graph).not.toHaveBeenCalled();
  });

  it('reports a changed declaration as stale and rejects compiler evidence whose consumer bytes changed', async () => {
    const { root, deps, linked, anchor } = await linkedFixture();
    anchor.contentHash = 'f'.repeat(64);
    expect((await buildTaskBrief(linked, deps)).anchors?.subjects[0]?.freshness).toBe('stale');
    writeFileSync(join(root, 'consumer.ts'), 'export const changed = true;');
    expect((await buildTaskBrief(linked, deps)).anchors?.subjects[0]).toMatchObject({ status: 'unknown', callers: [], tests: [], impact: [] });
  });

  it('SPEC-P-008-RECORD: records distinct delivered claims and the explicit no-scope skip', async () => {
    const { deps, ref } = fixture();
    const recordClaim = vi.fn(async () => true);
    const claimDeps = { ...deps, recordClaim, reuse: { providers: [] } };
    const reuse = { owner: 'su-claim', invocation: 'claim-one' };
    const first = (await getClaimTimeTaskBrief({ ...ref, reuse }, claimDeps))!.taskBrief;
    await getClaimTimeTaskBrief({ ...ref, reuse: { ...reuse, invocation: 'claim-two' } }, claimDeps);
    expect(recordClaim.mock.calls[0]).toEqual([{ workspace: 'fixture-workspace', owner: 'su-claim',
      workItem: ref.workItem.id, invocation: 'claim-one' }, first]);
    expect(recordClaim.mock.calls[1]![0]).toMatchObject({ invocation: 'claim-two' });
    expect(await getClaimTimeTaskBrief({ ...ref, reuse: { ...reuse, invocation: 'claim-no-scope' },
      workItem: { ...ref.workItem, payload: {} } }, claimDeps)).toBeNull();
    expect(recordClaim.mock.calls[2]).toEqual([expect.objectContaining({ invocation: 'claim-no-scope' }), null]);
  });

  it('keeps claim recording inside the six-second budget even when capture and ledger never settle', async () => {
    const { deps, ref } = fixture();
    let captureStarted!: () => void;
    const started = new Promise<void>(resolve => { captureStarted = resolve; });
    deps.root = () => { captureStarted(); return new Promise<never>(() => {}); };
    deps.recordClaim = vi.fn(() => new Promise<never>(() => {}));
    deps.reuse = { providers: [] };
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    const before = Date.now();
    const pending = getClaimTimeTaskBrief({ ...ref, reuse: { owner: 'su-claim', invocation: 'claim-timeout' } }, deps);
    await started;
    await vi.advanceTimersByTimeAsync(TASK_BRIEF_BUDGET_MS);
    const brief = (await pending)!.taskBrief;
    expect(brief.status).toBe('unknown');
    expect(brief.recover).toBeDefined();
    expect(Date.now() - before).toBe(TASK_BRIEF_BUDGET_MS);
    expect(deps.recordClaim).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ status: 'unknown' }));
  });

  it('SPEC-P-008-BUDGET: a linked dependency that never settles returns at the fake-clock budget with recovery', async () => {
    const { deps, linked } = await linkedFixture();
    let graphStarted!: () => void;
    const started = new Promise<void>(resolve => { graphStarted = resolve; });
    deps.anchors!.graph = () => { graphStarted(); return new Promise<never>(() => {}); };
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    const pending = getClaimTimeTaskBrief(linked, deps);
    await started;
    await vi.advanceTimersByTimeAsync(TASK_BRIEF_BUDGET_MS);
    const brief = (await pending)!.taskBrief;
    expect(JSON.stringify(brief).length).toBeLessThanOrEqual(TASK_BRIEF_MAX_CHARS);
    expect(brief.recover).toBeDefined();
    expect(brief.anchors?.subjects[0]?.status ?? brief.status).toBe('unknown');
  });
});
