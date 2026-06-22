/**
 * moderation_resolve.test.ts — hive:moderation_resolve HANDLER, bulk keyed-array
 * contract (bulk-endpoint-standardization-2026-06-21 P-006). The owner gate
 * (loadHivePubkey) + the reports store (setReportStatus) are mocked. Pins the
 * inline n=1 form, the items:[…] many form (per-item results keyed by reportId,
 * heterogeneous status), the owner gate firing ONCE for the batch, and a
 * no-report item failing only itself.
 *
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/hive/moderation_resolve.test.ts
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ loadHivePubkey: vi.fn(), setReportStatus: vi.fn() }));
vi.mock('../../workspace-registry', () => ({ activeWorkspaceId: () => 'default' }));
vi.mock('../../identity/hive-keypair', () => ({ loadHivePubkey: h.loadHivePubkey }));
vi.mock('../../hive-reports-store', () => ({ setReportStatus: h.setReportStatus }));

import tool from './moderation_resolve';

const CTX = { workspaceId: 'default' } as never;
type Out = { data?: any; content?: Array<{ text: string }> };
// The happy path returns the canonical { data: envelope }; the top-level owner
// gate still returns a raw { content } ToolResult — read whichever is present.
const env = async (args: unknown) => {
  const r = (await tool.handler(args as never, CTX)) as Out;
  return r.data ?? JSON.parse(r.content![0].text);
};

beforeEach(() => {
  vi.clearAllMocks();
  h.loadHivePubkey.mockResolvedValue('PUBKEY');
  h.setReportStatus.mockImplementation(async (_ws: string, _hive: string, reportId: string, status: string) => ({ reportId, status }));
});

describe('hive:moderation_resolve handler (bulk keyed-array, P-006)', () => {
  it('owner gate fails the WHOLE call when this Swarm does not hold the key', async () => {
    h.loadHivePubkey.mockResolvedValue(null);
    const b = await env({ hive: 'sheets', reportId: 'r1', status: 'actioned' });
    expect(b).toMatchObject({ ok: false, code: 'not_owner' });
  });

  it('n=1 inline { reportId, status } → one keyed result', async () => {
    const b = await env({ hive: 'sheets', reportId: 'r1', status: 'actioned' });
    expect(b).toMatchObject({ ok: true, counts: { ok: 1, failed: 0 } });
    expect(b.results[0]).toMatchObject({ ok: true, reportId: 'r1', report: { reportId: 'r1', status: 'actioned' } });
    expect(h.setReportStatus).toHaveBeenCalledWith('default', 'sheets', 'r1', 'actioned');
  });

  it('items:[…] resolves many heterogeneous statuses, keyed by reportId; owner gate fires ONCE', async () => {
    const b = await env({
      hive: 'sheets',
      items: [
        { reportId: 'r1', status: 'actioned' },
        { reportId: 'r2', status: 'dismissed' },
      ],
    });
    expect(b.counts).toEqual({ ok: 2, failed: 0 });
    expect(b.results.map((r: any) => [r.reportId, r.report.status])).toEqual([
      ['r1', 'actioned'],
      ['r2', 'dismissed'],
    ]);
    expect(h.loadHivePubkey).toHaveBeenCalledTimes(1);
  });

  it('a missing report fails ONLY that item (batch ok:true)', async () => {
    h.setReportStatus.mockImplementation(async (_ws: string, _hive: string, reportId: string, status: string) =>
      reportId === 'gone' ? null : { reportId, status },
    );
    const b = await env({
      hive: 'sheets',
      items: [
        { reportId: 'r1', status: 'actioned' },
        { reportId: 'gone', status: 'dismissed' },
      ],
    });
    expect(b.ok).toBe(true);
    expect(b.counts).toEqual({ ok: 1, failed: 1 });
    expect(b.results[1]).toMatchObject({ ok: false, reportId: 'gone', error: 'no report with that id' });
  });

  it('arg schema requires { reportId, status } (one) or items[]', () => {
    expect(tool.args.safeParse({ hive: 'sheets' }).success).toBe(false);
    expect(tool.args.safeParse({ hive: 'sheets', reportId: 'r1', status: 'actioned' }).success).toBe(true);
    expect(tool.args.safeParse({ hive: 'sheets', items: [{ reportId: 'r1', status: 'dismissed' }] }).success).toBe(true);
  });
});
