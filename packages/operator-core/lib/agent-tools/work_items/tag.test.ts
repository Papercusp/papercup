/**
 * tag.test.ts — work_items:tag handler, dual-arity keyed-array contract
 * (bulk-endpoint-standardization-2026-06-21). Engine fns mocked. Pins: inline single
 * → one result; ids:[…]+topic homogeneous fan-out; items:[…] heterogeneous; remove:true
 * routes to untag; an engine {error} fails only that item.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../coordination/identity', () => ({ resolveAgentIdentity: () => ({ ownerId: 'me' }) }));
vi.mock('../../work-items', () => ({ tagWorkItem: vi.fn(), untagWorkItem: vi.fn() }));

import { tagWorkItem, untagWorkItem } from '../../work-items';
import { dispatchProjectedTool, lookupByMcpName } from '@papercusp/agent-mcp';
const tagM = vi.mocked(tagWorkItem);
const untagM = vi.mocked(untagWorkItem);
const tool = (await import('./tag')).default;

type Out = { data: any };
const body = async (args: unknown) => (((await tool.handler(args as never, {} as never)) as Out).data);

const MIRRORED = { ok: true, mirrored: true, mirrorOutcome: 'applied' } as never;

beforeEach(() => {
  vi.clearAllMocks();
  tagM.mockResolvedValue(MIRRORED);
  untagM.mockResolvedValue(MIRRORED);
});

describe('work_items:tag handler (keyed-array)', () => {
  it('rejecting the natural `tags` arg teaches `topic` and the mirror contract', async () => {
    const projected = lookupByMcpName('work_items:tag');
    expect(projected).toBeTruthy();

    const dispatched = await dispatchProjectedTool(
      projected!,
      'work_items:tag',
      { id: 'WI-1', tags: ['infra'] },
      {
        log: vi.fn(),
        signal: new AbortController().signal,
        progress: vi.fn(),
        emit: vi.fn(),
        workspaceId: 'papercusp-workspace',
        runId: 'work-items-tag-unknown-tags-test',
        role: 'su',
        gateBypass: { role: true, capability: true, quota: true },
        transport: 'mcp',
        requestedFormat: 'json',
        requestedStructured: true,
      },
      {},
    );

    expect(dispatched.ok).toBe(false);
    expect(dispatched.error?.message).toContain('Unrecognized key: "tags"');
    expect(dispatched.error?.message).toContain('work_items:tag({ "id": "WI-1", "topic": "<topic>" })');
    expect(dispatched.error?.message).not.toContain('declares no counterpart');
    expect(dispatched.error?.message).toContain('pass `topic`');
    expect(dispatched.error?.message).toContain('Check `mirrored`');
    expect(dispatched.error?.meta?.invalidInput).toEqual(
      expect.objectContaining({
        corrections: [
          expect.objectContaining({
            rejectedArg: 'tags',
            kind: 'authored-redirect',
            call: expect.objectContaining({
              tool: 'work_items:tag',
              args: { id: '<work-item-id>', topic: '<topic>' },
            }),
          }),
        ],
      }),
    );
    expect(tagM).not.toHaveBeenCalled();
  });

  it('tags one inline and returns a single result', async () => {
    const b = await body({ id: 'WI-1', topic: 'infra' });
    expect(b).toMatchObject({ ok: true, counts: { ok: 1, failed: 0 } });
    expect(b.results[0]).toEqual({ ok: true, id: 'WI-1', topic: 'infra', mirrored: true, mirrorOutcome: 'applied' });
    expect(tagM).toHaveBeenCalledWith('WI-1', 'infra', { harness: undefined, by: 'me' });
  });

  it('tags MANY with the same topic via ids:[…] (homogeneous)', async () => {
    const b = await body({ ids: ['WI-1', 'WI-2'], topic: 'infra', harness: 'h' });
    expect(b.counts).toEqual({ ok: 2, failed: 0 });
    expect(b.results.map((r: { id: string }) => r.id)).toEqual(['WI-1', 'WI-2']);
    expect(tagM).toHaveBeenCalledWith('WI-2', 'infra', { harness: 'h', by: 'me' });
  });

  it('items:[…] heterogeneous; remove:true routes to untag', async () => {
    const b = await body({ items: [{ id: 'WI-1', topic: 'a' }, { id: 'WI-2', topic: 'b', remove: true }] });
    expect(b.counts).toEqual({ ok: 2, failed: 0 });
    expect(untagM).toHaveBeenCalledWith('WI-2', 'b', { harness: undefined });
    expect(tagM).toHaveBeenCalledWith('WI-1', 'a', { harness: undefined, by: 'me' });
  });

  it('an engine {error} fails only that item', async () => {
    tagM.mockImplementation(async (id: string) => (id === 'WI-BAD' ? ({ error: 'not found' } as never) : MIRRORED));
    const b = await body({ ids: ['WI-1', 'WI-BAD'], topic: 'x' });
    expect(b.counts).toEqual({ ok: 1, failed: 1 });
    expect(b.results[1]).toMatchObject({ ok: false, id: 'WI-BAD', error: 'not found' });
  });

  describe('EI-18810823481386446 — an unmirrored tag must not read as a plain success', () => {
    it('a remote-origin row still reports ok:true, but carries mirrored:false + a warning naming the claim-spec consequence', async () => {
      // The tag DID land in the topic store; only the claim-visible mirror was
      // refused. Failing the whole item would be wrong — going quiet is what
      // produced the mis-serve.
      tagM.mockResolvedValue({ ok: true, mirrored: false, mirrorOutcome: 'remote-origin' } as never);
      const b = await body({ id: 'WI-3669', topic: 'p2p-excluded' });

      expect(b.counts).toEqual({ ok: 1, failed: 0 });
      expect(b.results[0]).toMatchObject({ ok: true, id: 'WI-3669', mirrored: false, mirrorOutcome: 'remote-origin' });
      expect(b.results[0].warning).toMatch(/remote-authored/);
      expect(b.results[0].warning).toMatch(/tags/);
    });

    it('warns on a non-remote miss too, naming the outcome', async () => {
      tagM.mockResolvedValue({ ok: true, mirrored: false, mirrorOutcome: 'no-row' } as never);
      const b = await body({ id: 'WI-GHOST', topic: 'x' });
      expect(b.results[0]).toMatchObject({ ok: true, mirrored: false, mirrorOutcome: 'no-row' });
      expect(b.results[0].warning).toMatch(/no-row/);
    });

    it('a mirrored row carries NO warning key — the signal stays rare enough to mean something', async () => {
      const b = await body({ id: 'WI-1', topic: 'infra' });
      expect(b.results[0]).not.toHaveProperty('warning');
    });
  });
});
