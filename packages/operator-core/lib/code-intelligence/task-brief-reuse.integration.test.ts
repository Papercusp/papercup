import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildTaskBrief, enrichTaskBriefWithReuse, getClaimTimeTaskBrief,
  registerTaskBriefReuseAdapter, type TaskBrief, type TaskBriefDeps } from './task-brief';
import { createReuseBriefIdentity, registerReuseBriefProvider,
  type ReuseBriefProvider, type ReuseContribution, type ReuseProviderId } from './reuse-brief-providers';
import { reuseIssuedSubjects, type ReuseIssuedRecord } from './reuse-brief-ledger';

const dirs: string[] = [];
afterEach(async () => { vi.useRealTimers(); await Promise.all(dirs.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const source = (id: ReuseProviderId): ReuseBriefProvider => ({ id, read: async context => ({
  status: 'measured', lines: [`${id} target.ts:1; bounded static evidence only`],
  sourceVersion: context.sourceVersion, indexVersion: `index-${id}`, citedPaths: ['target.ts'],
}) });
const append = (base: TaskBrief, value: ReuseContribution): TaskBrief => ({ ...base,
  graph: { ...base.graph, relationships: [...base.graph.relationships, JSON.stringify(value)] } });
const ref = { workspaceId: 'fixture-workspace', workItem: { id: 'WI-target', harness: 'fixture-harness',
  sourcePlanSlug: 'fixture-plan', sourcePlanItemIds: ['P-009'], payload: { paths: ['target.ts'] } } };
async function fixture(): Promise<TaskBriefDeps> {
  const root = await mkdtemp(join(tmpdir(), 'task-brief-reuse-')); dirs.push(root);
  await writeFile(join(root, 'target.ts'), 'export const target = 1;');
  return { root: async () => root, effects: { exec: async () => ({ stdout: '' }), now: () => new Date(), writeArtifact: async () => '' },
    graph: async () => { throw new Error('No named declaration in this source'); },
    pack: async (_op, args) => {
      const path = join(root, 'pack.xml');
      await writeFile(path, `<file path="target.ts">${await readFile(join(root, 'target.ts'), 'utf8')}</file>`);
      return { answer: { error: null, sites: args.include.map((path: string) => ({ path })) },
        artifact: { path, provenance: { commit: 'fixture-commit' } } } as never;
    } };
}

describe('P009 real taskBrief production adapter boundary', () => {
  it('uses the registered provider/adapter at claim time, preserves mandatory evidence and records dispatch identity', async () => {
    const deps = await fixture();
    // This fixture intentionally holds coverage out while exercising the
    // registered clone provider. Treatment/holdout coverage has its own case.
    const claimRef = { ...ref, workItem: { ...ref.workItem, id: 'WI-fixture' } };
    const base = await buildTaskBrief(claimRef, deps);
    const emit = vi.fn();
    const identity = createReuseBriefIdentity('su-fixture', 'real-dispatch-fixture', emit)!;
    const record = vi.fn(async (_input: ReuseIssuedRecord) => true);
    const unregisterProvider = registerReuseBriefProvider(source('clones'));
    const unregisterAdapter = registerTaskBriefReuseAdapter('impact', append);
    try {
      const result = await getClaimTimeTaskBrief({ ...claimRef, reuse: identity }, { ...deps, reuse: { recordIssued: record } });
      expect(result?.taskBrief.status).toBe('current');
      expect(result?.taskBrief).toEqual({ ...base, graph: { ...base.graph,
        relationships: [expect.stringContaining('clones')] } });
      expect(record).toHaveBeenCalledOnce();
      const issued = reuseIssuedSubjects(record.mock.calls[0]![0]);
      expect(JSON.parse(issued[0]!.subject)).toMatchObject({ invocation: 'real-dispatch-fixture', provider: 'clones',
        surface: 'claim', workItem: 'WI-fixture', plan: 'fixture-plan', planItems: ['P-009'],
        sourceVersion: base.sourceFingerprint, indexVersion: 'index-clones', outcome: 'complete' });
      expect(emit.mock.calls[0]![0][0]).toMatchObject({ ledger: 'recorded', recover: base.recover });
      expect(Array.from(JSON.stringify(result?.taskBrief)).length).toBeLessThanOrEqual(3000);
    } finally { unregisterAdapter(); unregisterProvider(); }
  });

  it('does not read unavailable destinations or issue fictitious rows; keeps recovery in invocation outcomes', async () => {
    const deps = await fixture(), base = await buildTaskBrief(ref, deps);
    const read = vi.fn(source('coverage').read), observe = vi.fn(), record = vi.fn(async () => true);
    const result = await enrichTaskBriefWithReuse(base, { ...ref, reuse: { owner: 'su', invocation: 'dispatch', observe } },
      { ...deps, reuse: { providers: [{ id: 'coverage', read }], adapters: {}, recordIssued: record } }, Date.now() + 6000);
    expect(result).toBe(base); expect(read).not.toHaveBeenCalled(); expect(record).not.toHaveBeenCalled();
    expect(observe.mock.calls[0]![0]).toMatchObject({ ledger: 'not-needed', recover: base.recover,
      observations: [{ provider: 'coverage', status: 'unknown', reason: 'destination-unavailable', chars: 0 }] });
  });

  it('persists an all-holdout claim through the actual adapter without changing mandatory content', async () => {
    const deps = await fixture(), base = await buildTaskBrief(ref, deps), observe = vi.fn();
    const record = vi.fn(async (_input: ReuseIssuedRecord) => true);
    const result = await enrichTaskBriefWithReuse(base, { ...ref, workItem: { ...ref.workItem, id: 'WI-12' },
      reuse: { owner: 'su-fixture', invocation: 'all-holdout', observe } },
    { ...deps, reuse: { providers: [source('coverage')], adapters: { tests: append }, recordIssued: record } }, Date.now() + 6000);
    expect(result).toBe(base);
    expect(record).toHaveBeenCalledOnce();
    expect(record.mock.calls[0]![0].observations[0]).toMatchObject({ provider: 'coverage', status: 'held-out',
      cohort: 'holdout', chars: 0, citedPaths: ['target.ts'] });
    expect(observe.mock.calls[0]![0].ledger).toBe('recorded');
  });

  it('isolates adapter replacement and provider failure while retaining independent destination content', async () => {
    const deps = await fixture(), base = await buildTaskBrief(ref, deps), observe = vi.fn();
    const result = await enrichTaskBriefWithReuse(base, { ...ref, reuse: { owner: 'su', invocation: 'dispatch', observe } },
      { ...deps, reuse: { providers: [source('clones'), source('coverage'), { id: 'cochange', read: async () => { throw new Error(); } }],
        adapters: { impact: b => ({ ...b, files: [], sourceFingerprint: 'replacement' }), tests: append, coChange: append },
        recordIssued: async () => true } }, Date.now() + 6000);
    expect(result.files).toEqual(base.files); expect(result.sourceFingerprint).toBe(base.sourceFingerprint);
    expect(result.graph.relationships).toEqual([expect.stringContaining('coverage')]);
    expect(observe.mock.calls[0]![0].observations.map((row: { status: string }) => row.status)).toEqual(['unknown', 'unknown', 'issued']);
  });

  it('charges adapter labels to the provider cap and never invents a top-level section', async () => {
    const deps = await fixture(), base = await buildTaskBrief(ref, deps), observe = vi.fn();
    for (const adapter of [((b: TaskBrief) => ({ ...b, tests: [] })),
      ((b: TaskBrief) => ({ ...b, graph: { ...b.graph, relationships: ['label'.repeat(150)] } }))]) {
      const result = await enrichTaskBriefWithReuse(base, { ...ref, reuse: { owner: 'su', invocation: 'dispatch', observe } },
        { ...deps, reuse: { providers: [source('clones')], adapters: { impact: adapter }, recordIssued: async () => true } }, Date.now() + 6000);
      expect(result).toBe(base);
    }
  });

  it('does not reset the hard deadline after base assembly and cancels slow ledger I/O without dropping base', async () => {
    const deps = await fixture(), base = await buildTaskBrief(ref, deps);
    vi.useFakeTimers();
    const observe = vi.fn(), read = vi.fn(source('clones').read), record = vi.fn(async (_input: ReuseIssuedRecord, signal: AbortSignal) => {
      await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve())); return false;
    });
    const options = { ...deps, reuse: { providers: [{ id: 'clones' as const, read }], adapters: { impact: append }, recordIssued: record } };
    const expired = await enrichTaskBriefWithReuse(base, { ...ref, reuse: { owner: 'su', invocation: 'expired', observe } }, options, Date.now());
    expect(expired).toBe(base); expect(read).not.toHaveBeenCalled();
    const pending = enrichTaskBriefWithReuse(base, { ...ref, reuse: { owner: 'su', invocation: 'dispatch', observe } }, options, Date.now() + 500);
    await vi.advanceTimersByTimeAsync(500);
    const result = await pending;
    expect(result.files).toEqual(base.files); expect(result.graph.relationships).toHaveLength(1);
    expect(record.mock.calls[0]![1].aborted).toBe(true);
    expect(observe.mock.calls.at(-1)![0].ledger).toBe('unknown');
  });

  it('preserves the base without identity and retains each item in bulk invocation telemetry', async () => {
    const deps = await fixture(), base = await buildTaskBrief(ref, deps), emit = vi.fn();
    const missing = createReuseBriefIdentity('su', undefined, emit);
    expect(missing).toBeUndefined();
    expect(await enrichTaskBriefWithReuse(base, ref, deps, Date.now() + 6000)).toBe(base);
    const identity = createReuseBriefIdentity('su', 'dispatch', emit)!;
    identity.observe({ workItem: 'first' }); identity.observe({ workItem: 'second' });
    expect(emit.mock.calls.at(-1)![0]).toEqual([{ workItem: 'first' }, { workItem: 'second' }]);
  });
});
