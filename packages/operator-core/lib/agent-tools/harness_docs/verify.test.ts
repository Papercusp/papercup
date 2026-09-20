/**
 * verify.test.ts — the harness_docs:verify HANDLER (verifyManualDoc mocked), bulk
 * keyed-array contract (bulk-endpoint-standardization-2026-06-21). Pins the single
 * inline form, the docIds:[…] / items:[…] fan-out, the per-item harness override
 * over the batch default, the per-item failure mapping (batch survives), and the
 * top-level harness-scope gate (no resolvable harness → top-level harness_required,
 * touches no delegate).
 *
 * PG/git-free: verifyManualDoc has its own coverage in manual-anchor; this is the
 * tool-level envelope.
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/harness_docs/verify.test.ts
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../harness/docs/manual-anchor', () => ({ verifyManualDoc: vi.fn() }));

import { verifyManualDoc } from '../../harness/docs/manual-anchor';
const verifyM = vi.mocked(verifyManualDoc);
const tool = (await import('./verify')).default;

type Out = { content?: { text: string }[]; data?: unknown; isError?: boolean };
const call = (args: Record<string, unknown>, ctx: Record<string, unknown> = { harnessSlug: 'demo' }) =>
  tool.handler(args as never, ctx as never) as Promise<Out>;
// The bulk path returns the canonical { data: envelope }; the harness_required
// early-return is still a raw { content, isError } ToolResult (read directly below).
const envelope = async (args: Record<string, unknown>, ctx?: Record<string, unknown>) =>
  (await call(args, ctx)).data as any;

beforeEach(() => {
  vi.clearAllMocks();
  verifyM.mockImplementation(async () => ({ ok: true, verifiedSha: 'abc123' }) as never);
});

describe('harness_docs:verify handler (bulk keyed-array)', () => {
  it('single inline { docId } → { ok, results:[{ ok, docId, verifiedSha }], counts }', async () => {
    const b = await envelope({ docId: 'guides/setup.md' });
    expect(verifyM).toHaveBeenCalledWith('demo', 'guides/setup.md');
    expect(b).toMatchObject({ ok: true, counts: { ok: 1, failed: 0 } });
    expect(b.results[0]).toEqual({ ok: true, docId: 'guides/setup.md', verifiedSha: 'abc123' });
  });

  it('docIds:[…] verifies MANY in the ctx harness (homogeneous)', async () => {
    const b = await envelope({ docIds: ['a.md', 'b.md'] });
    expect(b.counts).toEqual({ ok: 2, failed: 0 });
    expect(b.results.map((r: { docId: string }) => r.docId)).toEqual(['a.md', 'b.md']);
    expect(verifyM).toHaveBeenCalledWith('demo', 'a.md');
    expect(verifyM).toHaveBeenCalledWith('demo', 'b.md');
  });

  it('items:[…] heterogeneous; a per-item harness overrides the batch/ctx default', async () => {
    const b = await envelope({ harness: 'batchH', items: [{ docId: 'a.md' }, { docId: 'b.md', harness: 'otherH' }] });
    expect(b.counts).toEqual({ ok: 2, failed: 0 });
    expect(verifyM).toHaveBeenNthCalledWith(1, 'batchH', 'a.md');
    expect(verifyM).toHaveBeenNthCalledWith(2, 'otherH', 'b.md');
  });

  it('a verify failure on one item → { ok:false, docId, error } without failing the rest', async () => {
    verifyM.mockImplementation(async (_h: string, docId: string) =>
      (docId === 'missing.md' ? { ok: false, error: 'unknown_doc' } : { ok: true, verifiedSha: 'sha' }) as never,
    );
    const b = await envelope({ docIds: ['ok.md', 'missing.md'] });
    // EI-23737206446729041: envelope `ok` is DERIVED from items, so failed>0 => ok:false.
    // Per-item isolation (what this test proves) is unchanged: the batch still ran every item.
    expect(b.ok).toBe(false);
    expect(b.counts).toEqual({ ok: 1, failed: 1 });
    expect(b.results[1]).toMatchObject({ ok: false, docId: 'missing.md', error: 'unknown_doc' });
  });

  it('a per-item throw self-describes its docId; the batch survives', async () => {
    verifyM.mockImplementation(async (_h: string, docId: string) => {
      if (docId === 'boom.md') throw new Error('git failed');
      return { ok: true, verifiedSha: 'sha' } as never;
    });
    const b = await envelope({ docIds: ['ok.md', 'boom.md'] });
    expect(b.counts).toEqual({ ok: 1, failed: 1 });
    expect(b.results[1]).toMatchObject({ ok: false, docId: 'boom.md', error: 'git failed' });
  });

  it('no resolvable harness (ctx "*", no arg) → top-level harness_required, touches nothing', async () => {
    const res = await call({ docId: 'guides/setup.md' }, { harnessSlug: '*' });
    expect(res.isError).toBe(true);
    expect(JSON.parse(res.content![0]!.text)).toEqual({ ok: false, error: 'harness_required' });
    expect(verifyM).not.toHaveBeenCalled();
  });
});
