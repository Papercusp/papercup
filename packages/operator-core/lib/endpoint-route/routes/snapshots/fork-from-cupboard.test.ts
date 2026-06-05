/**
 * Guard-clause tests for POST /snapshots/fork-from-cupboard
 * (revive-cupboard-distribution-2026-06-04, snapshot facet). Covers the
 * validation branches that return BEFORE the download/restore path — the
 * happy-path download+verify is covered in snapshot-blob.test.ts, and full
 * restore() is exercised live at deploy time (owner-gated worker deploy).
 */
import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';

vi.mock('../../../require-flag', () => ({ gateApiRoute: async () => null }));
vi.mock('../../../cupboard/snapshot-blob', () => ({
  fetchCupboardListing: vi.fn(),
  downloadSnapshotTarball: vi.fn(),
}));

import { fetchCupboardListing } from '../../../cupboard/snapshot-blob';
import route from './fork-from-cupboard';

type Route = { handler: (req: Request, ctx: { params: Record<string, unknown> }) => Promise<Response> };

function post(body: unknown): Promise<Response> {
  return (route as unknown as Route).handler(
    new Request('http://localhost:3070/api/snapshots/fork-from-cupboard', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
    { params: {} },
  );
}

describe('fork-from-cupboard guard clauses', () => {
  beforeEach(() => vi.clearAllMocks());

  it('400 without listing_id', async () => {
    const res = await post({});
    expect(res.status).toBe(400);
    expect(fetchCupboardListing).not.toHaveBeenCalled();
  });

  it('404 when the cupboard listing is not found', async () => {
    (fetchCupboardListing as Mock).mockResolvedValue(null);
    const res = await post({ listing_id: 'L1' });
    expect(res.status).toBe(404);
  });

  it('400 when the listing is not a snapshot', async () => {
    (fetchCupboardListing as Mock).mockResolvedValue({ id: 'L1', listing_kind: 'blueprint' });
    const res = await post({ listing_id: 'L1' });
    expect(res.status).toBe(400);
  });

  it('422 for a metadata-only snapshot (no tarball_content_hash — local-fork only)', async () => {
    (fetchCupboardListing as Mock).mockResolvedValue({ id: 'L1', listing_kind: 'snapshot', listing_ref: 'snap_x' });
    const res = await post({ listing_id: 'L1' });
    expect(res.status).toBe(422);
    expect(((await res.json()) as { error: string }).error).toContain('metadata-only');
  });
});
