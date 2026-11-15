/**
 * work_items:links — family dispatch, direction, per-item limit, and tag
 * omission. The underlying stores are mocked so this stays a focused handler
 * test rather than a database integration test.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LinkRow, ObjectRef } from '@papercusp/coordination/capabilities';
import type { BlockingEdgeReader } from '../../work-item-blocking';

const fakes = vi.hoisted(() => {
  const issueReader = { listOut: vi.fn<BlockingEdgeReader['listOut']>(), listIn: vi.fn<BlockingEdgeReader['listIn']>(), listOutMany: vi.fn<BlockingEdgeReader['listOutMany']>(), listInMany: vi.fn<BlockingEdgeReader['listInMany']>() };
  const featureReader = { listOut: vi.fn<BlockingEdgeReader['listOut']>(), listIn: vi.fn<BlockingEdgeReader['listIn']>(), listOutMany: vi.fn<BlockingEdgeReader['listOutMany']>(), listInMany: vi.fn<BlockingEdgeReader['listInMany']>() };
  const state: { storeOpts: unknown[]; readerStores: unknown[] } = { storeOpts: [], readerStores: [] };
  const PgLinkStore = vi.fn(function (this: { opts: unknown }, opts: unknown) {
    this.opts = opts;
    state.storeOpts.push(opts);
  });
  const createBlockingEdgeReader = vi.fn((store: unknown) => {
    state.readerStores.push(store);
    return issueReader;
  });
  return { issueReader, featureReader, PgLinkStore, createBlockingEdgeReader, state };
});

vi.mock('@papercusp/coordination/capabilities', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@papercusp/coordination/capabilities')>();
  return { ...actual, PgLinkStore: fakes.PgLinkStore };
});
vi.mock('../coordination/log', async (importOriginal) => ({
  ...await importOriginal<typeof import('../coordination/log')>(),
  coordScopeWorkspace: vi.fn(() => 'workspace-live'),
}));
vi.mock('../../workspace-registry', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../workspace-registry')>(),
  activeWorkspaceId: vi.fn(() => 'workspace-live'),
}));
vi.mock('../../work-item-blocking', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../work-item-blocking')>();
  return {
    ...actual,
    createBlockingEdgeReader: fakes.createBlockingEdgeReader,
    blockingEdgeReader: fakes.featureReader,
  };
});
vi.mock('../../work-items', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../work-items')>(),
  getWorkItem: vi.fn(), workItemObjectRef: vi.fn(),
}));
vi.mock('../../context-doors-config', async (importOriginal) => {
  const { BAKED_DOOR_CONSTANTS } = await import('../../context-doors');
  return { ...await importOriginal<typeof import('../../context-doors-config')>(),
    getDoorConstantsSync: () => BAKED_DOOR_CONSTANTS };
});

import { getWorkItem, workItemObjectRef } from '../../work-items';
import { workItemFixture } from '../../testing/work-item-fixture';
import { coordScopeWorkspace } from '../coordination/log';
import tool from './links';
import type { WorkItemLink } from './links';

type Out = { data: any };
type LinkPage = {
  links: WorkItemLink[];
  total: number;
  offset: number;
  returned: number;
  omitted: number;
  next: { tool: string; args: Record<string, unknown> } | null;
};
const getM = vi.mocked(getWorkItem);
const refM = vi.mocked(workItemObjectRef);
const issueOutM = fakes.issueReader.listOut;
const issueInM = fakes.issueReader.listIn;
const featureOutM = fakes.featureReader.listOut;
const featureInM = fakes.featureReader.listIn;

const issueRef = { kind: 'issue', ref: 'EI-1' } as const;
const featureRef = { kind: 'feature', ref: 'papercusp#F-1' } as const;
const issueReaderStoreAtImport = fakes.state.readerStores.at(-1);
type Edge = LinkRow & { satisfaction?: 'settled' | 'success' };
const row = (over: Partial<Edge> = {}): Edge => ({
  id: 1,
  src: issueRef,
  dst: { kind: 'issue', ref: 'EI-2' },
  rel: 'relates',
  created_by: 'agent',
  created_ts: '2026-08-27T00:00:00.000Z',
  ...over,
});

const args = (over: Record<string, unknown> = {}) => tool.args.parse({ id: 'EI-1', ...over }) as never;
const run = async (over: Record<string, unknown> = {}) => ((await tool.handler(args(over), {} as never)) as Out).data;

beforeEach(() => {
  vi.clearAllMocks();
  getM.mockResolvedValue(workItemFixture({ family: 'issue', harness: 'papercusp', id: 'EI-1' }));
  refM.mockReturnValue(issueRef);
  issueOutM.mockResolvedValue([]);
  issueInM.mockResolvedValue([]);
  featureOutM.mockResolvedValue([]);
  featureInM.mockResolvedValue([]);
  vi.mocked(coordScopeWorkspace).mockReturnValue('workspace-live');
});

describe('work_items:links handler', () => {
  it('reads outgoing issue links through the dynamically scoped issue reader and omits tagged rows', async () => {
    issueOutM.mockResolvedValue([
      row({ rel: 'tagged', dst: { kind: 'topic', ref: 'coord' } }),
      row({ rel: 'fixes', dst: { kind: 'issue', ref: 'EI-2' } }),
    ]);
    const b = await run({ direction: 'out' });
    expect(b).toMatchObject({ ok: true, counts: { ok: 1, failed: 0 } });
    expect(b.results[0]).toMatchObject({
      ok: true,
      id: 'EI-1',
      direction: 'out',
      links: [{ rel: 'fixes', dst: { kind: 'issue', ref: 'EI-2' } }],
    });
    expect(issueOutM).toHaveBeenCalledWith(issueRef);
    expect(featureOutM).not.toHaveBeenCalled();
    const opts = fakes.state.storeOpts.find(
      (candidate) => typeof (candidate as { getWorkspaceId?: unknown }).getWorkspaceId === 'function',
    ) as { getWorkspaceId: () => string } | undefined;
    expect(opts).toBeDefined();
    expect(opts!.getWorkspaceId()).toBe('workspace-live');
  });

  it('reads incoming feature links through the canonical feature reader', async () => {
    getM.mockResolvedValue(workItemFixture({ family: 'feature', harness: 'papercusp', id: 'F-1' }));
    refM.mockReturnValue(featureRef);
    featureInM.mockResolvedValue([
      row({ src: { kind: 'issue', ref: 'EI-9' }, dst: featureRef, rel: 'blocks' }),
      row({ src: { kind: 'topic', ref: 'coord' }, dst: featureRef, rel: 'tagged' }),
    ]);
    const b = await run({ id: 'F-1', direction: 'in' });
    expect(b.results[0]).toMatchObject({
      ok: true,
      id: 'F-1',
      direction: 'in',
      links: [{ rel: 'blocks', src: { kind: 'issue', ref: 'EI-9' } }],
    });
    expect(featureInM).toHaveBeenCalledWith(featureRef);
    expect(issueInM).not.toHaveBeenCalled();
  });

  it('projects the dependency satisfaction requirement from canonical edge rows', async () => {
    issueOutM.mockResolvedValue([
      row({ rel: 'blocks', dst: { kind: 'feature', ref: 'papercusp#F-2' }, satisfaction: 'success' }),
    ]);
    const b = await run({ direction: 'out' });
    expect(b.results[0].links).toEqual([
      { rel: 'blocks', dst: { kind: 'feature', ref: 'papercusp#F-2' }, satisfaction: 'success' },
    ]);
  });

  it('applies the limit independently to every requested id', async () => {
    getM.mockImplementation(async (id: string) => workItemFixture({ family: 'issue', harness: 'papercusp', id }));
    refM.mockImplementation((item): ObjectRef => ({ kind: 'issue', ref: item.id }));
    issueOutM.mockResolvedValue([
      row({ id: 1 }),
      row({ id: 2, dst: { kind: 'issue', ref: 'EI-3' } }),
      row({ id: 3, dst: { kind: 'issue', ref: 'EI-4' } }),
    ]);
    const b = await run({ id: undefined, ids: ['EI-1', 'EI-2'], limit: 2 });
    expect(b.counts).toEqual({ ok: 2, failed: 0 });
    expect(b.results.map((r: { links: unknown[] }) => r.links)).toHaveLength(2);
    expect(b.results[0].links).toHaveLength(2);
    expect(b.results[1].links).toHaveLength(2);
    for (const result of b.results) {
      expect(result).toMatchObject({ total: 3, returned: 2, omitted: 1, truncated: true });
      expect(result.next).toMatchObject({ tool: 'work_items:links', args: { id: result.id, limit: 2 } });
      const resumed = await run(result.next.args);
      expect(resumed.results[0]).toMatchObject({ total: 3, returned: 1, omitted: 0, truncated: false, next: null });
      expect([...result.links, ...resumed.results[0].links].map((link: any) => link.dst.ref))
        .toEqual(['EI-2', 'EI-3', 'EI-4']);
    }
  });

  it.each([19, 20, 21, 99, 100, 101])('reports and recovers all %i matching edges at default/maximum boundaries', async (count) => {
    const source = Array.from({ length: count }, (_, i) => row({
      id: i + 1, rel: 'blocks', dst: { kind: 'issue', ref: `EI-${String(i).padStart(4, '0')}` },
      satisfaction: i === count - 1 ? 'success' : 'settled',
    }));
    issueOutM.mockResolvedValue([row({ rel: 'tagged' }), ...source].reverse());
    for (const limit of [20, 100]) {
      let request: Record<string, unknown> = { limit };
      const recovered: any[] = [];
      do {
        const page = (await run(request)).results[0];
        expect(page.total).toBe(count);
        expect(page.returned).toBe(page.links.length);
        expect(page.offset + page.returned + page.omitted).toBe(page.total);
        recovered.push(...page.links);
        expect(page.omitted).toBe(count - recovered.length);
        expect(page.truncated).toBe(page.omitted > 0);
        if (page.next) expect(page.nextCursor).toBe(page.next.args.cursor);
        request = page.next?.args;
      } while (request);
      expect(recovered.map((link) => link.dst.ref)).toEqual(source.map((link) => link.dst.ref));
      expect(recovered.at(-1).satisfaction).toBe('success');
    }
  });

  it('consumer follows many pages through permutations, changed page sizes and a fresh module after restart', async () => {
    const source = Array.from({ length: 143 }, (_, i) => row({
      id: i + 1, rel: 'blocks', satisfaction: 'success',
      dst: { kind: 'issue', ref: `EI-${String(i).padStart(4, '0')}` },
    }));
    const stores = fakes.state.storeOpts.length;
    const readers = fakes.state.readerStores.length;
    let currentTool = tool;
    let request: Record<string, unknown> | undefined = { id: 'EI-1', limit: 20 };
    const recovered: any[] = [];
    let pages = 0;
    try {
      while (request) {
        const reordered = source.map((edge) => ({ ...edge, dst: { ref: edge.dst.ref, kind: edge.dst.kind } }));
        const permutation = pages % 3 === 0 ? [...reordered].reverse()
          : pages % 3 === 1 ? [...source.filter((_, i) => i % 2 === 0), ...source.filter((_, i) => i % 2 === 1)]
            : source;
        issueOutM.mockResolvedValue(permutation);
        const page: LinkPage = ((await currentTool.handler(currentTool.args.parse(request), {} as never)) as Out).data.results[0];
        recovered.push(...page.links);
        expect(page.offset + page.returned + page.omitted).toBe(page.total);
        expect(page.omitted).toBe(source.length - recovered.length);
        request = page.next ? JSON.parse(JSON.stringify(page.next.args)) : undefined;
        if (++pages === 2) {
          vi.resetModules();
          currentTool = (await import('./links')).default;
          if (request) request.limit = 7;
        }
      }
      expect(pages).toBeGreaterThan(10);
      expect(recovered.map((link) => link.dst.ref)).toEqual(source.map((link) => link.dst.ref));
      expect(new Set(recovered.map((link) => link.dst.ref)).size).toBe(source.length);
      expect(recovered.at(-1)).toEqual({ rel: 'blocks', dst: source.at(-1)!.dst, satisfaction: 'success' });
    } finally {
      fakes.state.storeOpts.length = stores;
      fakes.state.readerStores.length = readers;
    }
  });

  it.each(['add', 'remove', 'satisfaction'])('requires consumer resync after source %s', async (change) => {
    let source = [row(), row({ id: 2, dst: { kind: 'issue', ref: 'EI-3' } }),
      row({ id: 3, dst: { kind: 'issue', ref: 'EI-4' } })];
    issueOutM.mockImplementation(async () => source);
    const first = (await run({ limit: 1 })).results[0];
    expect((await run(first.next.args)).results[0]).toEqual((await run(first.next.args)).results[0]);
    if (change === 'add') source = [...source, row({ id: 4, dst: { kind: 'issue', ref: 'EI-5' } })];
    if (change === 'remove') source = source.slice(1);
    if (change === 'satisfaction') source = source.map((edge): Edge => ({ ...edge, satisfaction: 'success' }));
    const failed = (await run(first.next.args)).results[0];
    expect(failed).toMatchObject({ ok: false, error: 'stale_cursor', restart: { tool: 'work_items:links' } });
    let next = failed.restart;
    const recovered: any[] = [];
    while (next) {
      const page = (await run(next.args)).results[0];
      recovered.push(...page.links);
      next = page.next;
    }
    expect(recovered.map((link) => link.dst.ref)).toEqual(source.map((edge) => edge.dst.ref));
    if (change === 'satisfaction') expect(recovered.every((link) => link.satisfaction === 'success')).toBe(true);
  });

  it('rejects invalid and foreign cursors without changing IDs, direction or workspace', async () => {
    getM.mockImplementation(async (id: string) => workItemFixture({ family: 'issue', harness: 'papercusp', id }));
    refM.mockImplementation((item): ObjectRef => ({ kind: 'issue', ref: item.id }));
    issueOutM.mockResolvedValue([row(), row({ dst: { kind: 'issue', ref: 'EI-3' } })]);
    const first = (await run({ limit: 1 })).results[0];
    for (const cursor of ['not-a-cursor', Buffer.from('{}').toString('base64url')]) {
      expect((await run({ cursor })).results[0]).toMatchObject({ ok: false, error: 'invalid_cursor' });
    }
    const decoded = JSON.parse(Buffer.from(first.nextCursor, 'base64url').toString('utf8'));
    for (const offset of [0, -1, 99]) {
      const cursor = Buffer.from(JSON.stringify({ ...decoded, offset })).toString('base64url');
      expect((await run({ cursor })).results[0]).toMatchObject({ error: 'invalid_cursor' });
    }
    expect((await run({ ...first.next.args, id: 'EI-2' })).results[0]).toMatchObject({ error: 'invalid_cursor' });
    expect((await run({ ...first.next.args, direction: 'in' })).results[0]).toMatchObject({ error: 'invalid_cursor' });
    vi.mocked(coordScopeWorkspace).mockReturnValue('another-workspace');
    expect((await run(first.next.args)).results[0]).toMatchObject({ error: 'invalid_cursor' });
    expect(() => args({ ids: ['EI-2'], cursor: first.nextCursor })).toThrow(/exactly one item/);
  });

  it('recovers incoming feature edges with their complete identities and distinguishes empty IDs from failures', async () => {
    getM.mockImplementation(async (id: string) => id === 'F-404' ? null : workItemFixture({ family: 'feature', harness: 'papercusp', id }));
    refM.mockImplementation((item): ObjectRef => ({ kind: 'feature', ref: `papercusp#${item.id}` }));
    const completeRef = `papercusp#WI-${'1234567890'.repeat(50)}`;
    featureInM.mockImplementation(async (ref: { ref: string }) => ref.ref === 'papercusp#F-1' ? [
      row({ rel: 'blocks', src: { kind: 'feature', ref: completeRef }, satisfaction: 'success' }),
      row({ rel: 'relates', src: { kind: 'issue', ref: 'EI-9' } }),
    ] : []);
    const bulk = await run({ id: undefined, ids: ['F-1', 'F-2', 'F-404'], direction: 'in', limit: 1 });
    expect(bulk.emptyIds).toEqual(['F-2']);
    expect(bulk.results.find((entry: any) => entry.id === 'F-404')).toMatchObject({ ok: false });
    const first = bulk.results.find((entry: any) => entry.id === 'F-1');
    const last = (await run(first.next.args)).results[0];
    expect([...first.links, ...last.links]).toContainEqual({ rel: 'blocks', src: { kind: 'feature', ref: completeRef }, satisfaction: 'success' });
    expect(last).toMatchObject({ total: 2, omitted: 0, truncated: false, next: null });
  });

  it.each(['direct', 'nested', 'code-run'])('consumer recovers the outer spill and every actual handler page through %s', async (route) => {
    const { applyResultDoor, resetResultDoorAggregatesForTests } = await import('../../result-door');
    const { parseScratchReference } = await import('../../scratch-reference');
    const { shapeCodeRunSummary } = await import('../code/run');
    const root = mkdtempSync(join(tmpdir(), 'links-consumer-'));
    const previous = process.env.PAPERCUSP_SCRATCH_ROOT;
    const killSwitch = process.env.PAPERCUSP_RESULT_DOOR_OFF;
    process.env.PAPERCUSP_SCRATCH_ROOT = root;
    delete process.env.PAPERCUSP_RESULT_DOOR_OFF;
    resetResultDoorAggregatesForTests();
    const source = Array.from({ length: 23 }, (_, i) => row({ id: i + 1, rel: 'blocks',
      dst: { kind: 'issue', ref: `EI-${String(i).padStart(4, '0')}-${'complete-record-'.repeat(20)}` },
      satisfaction: i === 22 ? 'success' : 'settled',
    }));
    issueOutM.mockResolvedValue([...source].reverse());
    const recovered: any[] = [];
    let request: Record<string, unknown> | undefined = { limit: 2 };
    let spills = 0;
    try {
      while (request) {
        const page = await run(request);
        const produced = route === 'code-run' ? shapeCodeRunSummary({ ok: true, summary: page }) : page;
        expect(produced).not.toHaveProperty('summaryNotice');
        const emitted = { ...produced, padding: 'force outer recovery '.repeat(800) };
        const out = applyResultDoor({ content: [{ type: 'text', text: JSON.stringify(emitted) }] }, {
          toolName: route === 'nested' ? 'tools:invoke' : route === 'code-run' ? 'code:run' : 'work_items:links',
          ...(route === 'nested' ? { nestedTargetToolName: 'work_items:links' } : {}),
          workspaceId: 'ws-1', runId: randomUUID(),
        });
        const inline = JSON.parse((out.content[0] as { text: string }).text);
        const cursor = inline._projection.cursor;
        const reference = parseScratchReference(readFileSync(cursor.args.file_path));
        expect(reference).not.toBeNull();
        const full = JSON.parse(reference!.payload.subarray(cursor.bodyOffsetInPayload ?? 0).toString('utf8'));
        spills++;
        const actual = (route === 'code-run' ? full.summary : full).results[0];
        recovered.push(...actual.links);
        expect(actual.omitted).toBe(source.length - recovered.length);
        if (actual.next) expect(actual.next.tool).toBe('work_items:links');
        request = actual.next ? JSON.parse(JSON.stringify(actual.next.args)) : undefined;
      }
      expect(spills).toBe(12);
      expect(recovered.map((link) => link.dst.ref)).toEqual(source.map((edge) => edge.dst.ref));
      expect(recovered.at(-1)).toMatchObject({ satisfaction: 'success', dst: source.at(-1)!.dst });
    } finally {
      if (previous === undefined) delete process.env.PAPERCUSP_SCRATCH_ROOT;
      else process.env.PAPERCUSP_SCRATCH_ROOT = previous;
      if (killSwitch === undefined) delete process.env.PAPERCUSP_RESULT_DOOR_OFF;
      else process.env.PAPERCUSP_RESULT_DOOR_OFF = killSwitch;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('omits empty successes and reports exact checked-set coverage for a 100-id selection', async () => {
    const ids = Array.from({ length: 100 }, (_, i) => `EI-${50_000 + i}`);
    const linkedIds = ids.filter((_, i) => i % 10 === 0);
    getM.mockImplementation(async (id: string) => workItemFixture({ family: 'issue', harness: 'papercusp', id }));
    refM.mockImplementation((item): ObjectRef => ({ kind: 'issue', ref: item.id }));
    issueOutM.mockImplementation(async (ref: { ref: string }) =>
      Number(ref.ref.split('-').at(-1)) % 10 === 0 ? [row({ dst: { kind: 'issue', ref: `${ref.ref}-linked` } })] : [],
    );

    const b = await run({ id: undefined, ids, limit: 100 });

    expect(b.counts).toEqual({ ok: 100, failed: 0 });
    expect(b.results.map((result: { id: string }) => result.id)).toEqual(linkedIds);
    expect(b.coverage).toEqual({
      selectedCount: 100,
      checkedCount: 100,
      complete: true,
      linkedCount: linkedIds.length,
    });
    expect(getM).toHaveBeenCalledTimes(100);
  });

  it('defaults and caps the per-item limit, and rejects an empty id selection', () => {
    expect(tool.args.parse({ id: 'EI-1' })).toMatchObject({ direction: 'out', limit: 20 });
    expect(() => tool.args.parse({ id: 'EI-1', limit: 101 })).toThrow();
    expect(() => tool.args.parse({ id: 'EI-1', limit: 0 })).toThrow();
    expect(() => tool.args.parse({ direction: 'in' })).toThrow();
  });
});

describe('work_items:links wiring', () => {
  it('builds the issue reader with the hybrid canonical merge seam', () => {
    expect(issueReaderStoreAtImport).toMatchObject({ opts: { getWorkspaceId: expect.any(Function) } });
    const store = issueReaderStoreAtImport as { opts: { getWorkspaceId: () => string } };
    expect(fakes.state.storeOpts).toContain(store.opts);
    expect(fakes.state.readerStores).toContain(store);
    expect(store.opts.getWorkspaceId()).toBe('workspace-live');
  });
});
