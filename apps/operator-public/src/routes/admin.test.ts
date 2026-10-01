/**
 * routes/admin.test.ts — colocated unit coverage for the Cupboard /admin surface,
 * targeting the endpoints + branches NOT exercised by the in-memory-D1 suite in
 * src/__tests__/admin.test.ts (which already covers /admin/reports + the
 * reports/:id/resolve + harnesses/:id/unlist happy paths and the core auth
 * gates). Here we mock ../auth.ts + ../db.ts directly so we can drive the
 * untested endpoints precisely:
 *   - the shared requireOperator gate (401 unauthenticated / 403 non-operator),
 *   - GET /admin/pending (review queue),
 *   - POST /admin/listings/:id/review (approve/reject, validation, 404/409),
 *   - GET/POST /admin/banned-pubkeys + /remove (ban list),
 *   - the invalid_json / invalid_field validation branches on the write routes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const h = vi.hoisted(() => {
  class FakeAuthError extends Error {
    constructor(public reason: string) {
      super(reason);
    }
  }
  return {
  FakeAuthError,
  resolveGithubBearer: vi.fn(),
  isCupboardOperator: vi.fn(() => true),
  // Type the hoisted mocks whose return/args the tests read (WI-4519). `vi.fn(async () => [])`
  // infers Promise<never[]> — so mockResolvedValue([{ id }]) hits TS2322 (never) — and a
  // zero-arg factory makes `.mock.calls[0]` a length-0 tuple — so [0][2]/[0][3] reads hit
  // TS2493. Give each an explicit function-type generic. Returns stay permissive
  // (Record<string, unknown>[]) because the tests pass PARTIAL rows ({ id }, { pubkey }),
  // not full HarnessRow/BannedPubkeyRow; `audit`'s param tuple mirrors db.ts so the
  // call-arg index reads (kind at [2], detail at [3]) type-check.
  audit: vi.fn<(db: unknown, ts: number, kind: string, detail?: Record<string, unknown>) => Promise<void>>(async () => {}),
  getHarnessById: vi.fn(),
  getReportById: vi.fn(),
  listReports: vi.fn(async () => []),
  listPendingReview: vi.fn<(db: unknown, limit?: number) => Promise<Array<Record<string, unknown>>>>(async () => []),
  setReviewStatus: vi.fn(async () => {}),
  // P-008: approval goes through approveListingVersion (records the reviewed SHA,
  // re-pins a drifted row, retires superseded versions); the two readers feed the
  // audit detail and the review-diff surface.
  approveListingVersion: vi.fn(async () => {}),
  getPreviouslyApprovedVersion: vi.fn(async () => null),
  listVersionsSupersededByApproval: vi.fn(async () => []),
  markHarnessUnlisted: vi.fn(async () => {}),
  resolveReport: vi.fn(async () => 1),
  listBannedPubkeys: vi.fn<(db: unknown) => Promise<Array<Record<string, unknown>>>>(async () => []),
  banPublisherPubkey: vi.fn(async () => {}),
  unbanPublisherPubkey: vi.fn(async () => {}),
  };
});

vi.mock('../auth.ts', () => ({
  AuthError: h.FakeAuthError,
  resolveGithubBearer: h.resolveGithubBearer,
  isCupboardOperator: h.isCupboardOperator,
}));
vi.mock('../db.ts', () => ({
  approveListingVersion: h.approveListingVersion,
  audit: h.audit,
  banPublisherPubkey: h.banPublisherPubkey,
  getHarnessById: h.getHarnessById,
  getPreviouslyApprovedVersion: h.getPreviouslyApprovedVersion,
  listVersionsSupersededByApproval: h.listVersionsSupersededByApproval,
  getReportById: h.getReportById,
  listBannedPubkeys: h.listBannedPubkeys,
  listPendingReview: h.listPendingReview,
  listReports: h.listReports,
  markHarnessUnlisted: h.markHarnessUnlisted,
  resolveReport: h.resolveReport,
  setReviewStatus: h.setReviewStatus,
  unbanPublisherPubkey: h.unbanPublisherPubkey,
}));

import { adminRoute } from './admin.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const env: any = { DB: {}, CUPBOARD_OPERATOR_GITHUB_IDS: '7' };
const OP = { id: 7, login: 'op' };

function req(path: string, init: RequestInit = {}) {
  return adminRoute().request(path, init, env);
}
function jsonPost(path: string, body: unknown, auth = true) {
  return req(path, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(auth ? { authorization: 'Bearer t' } : {}),
    },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}
const authedGet = (path: string) => req(path, { headers: { authorization: 'Bearer t' } });

beforeEach(() => {
  vi.clearAllMocks();
  h.resolveGithubBearer.mockResolvedValue(OP);
  h.isCupboardOperator.mockReturnValue(true);
  h.resolveReport.mockResolvedValue(1);
});
afterEach(() => vi.clearAllMocks());

describe('requireOperator gate (shared by every /admin route)', () => {
  it('401s when no bearer is present (AuthError)', async () => {
    h.resolveGithubBearer.mockRejectedValue(new h.FakeAuthError('missing_bearer'));
    const res = await req('/admin/pending');
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: 'auth', reason: 'missing_bearer' });
  });

  it('403s a valid GitHub user who is not an operator', async () => {
    h.isCupboardOperator.mockReturnValue(false);
    const res = await authedGet('/admin/pending');
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: 'forbidden', reason: 'not_an_operator' });
  });

  it('re-throws a non-AuthError (surfaces as 500 via the parent app onError)', async () => {
    h.resolveGithubBearer.mockRejectedValue(new Error('boom'));
    // Mirror production: adminRoute is mounted under a parent app whose onError
    // (buildApi's) maps a thrown error to a 500 JSON body — and silences the
    // default stderr log so the fail-on-console gate stays happy.
    const parent = new Hono();
    parent.route('/', adminRoute());
    parent.onError((err, c) => c.json({ error: 'internal', detail: (err as Error).message }, 500));
    const res = await parent.request('/admin/pending', { headers: { authorization: 'Bearer t' } }, env);
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ error: 'internal' });
  });
});

describe('GET /admin/pending', () => {
  it('returns the pre-publication review queue for an operator', async () => {
    h.listPendingReview.mockResolvedValue([{ id: 'p1' }, { id: 'p2' }]);
    const res = await authedGet('/admin/pending');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ pending: [{ id: 'p1' }, { id: 'p2' }] });
  });
});

describe('POST /admin/listings/:id/review', () => {
  beforeEach(() => {
    h.getHarnessById.mockResolvedValue({
      id: 'l1',
      review_status: 'pending',
      unlisted_at: null,
      listing_kind: 'knowledge-pack',
      publisher_github_user_id: 42,
      pinned_commit_sha: null,
      pinned_tree_digest: null,
    });
  });

  it('400s invalid JSON', async () => {
    const res = await jsonPost('/admin/listings/l1/review', 'not json');
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'invalid_json' });
  });

  it('400s an invalid decision', async () => {
    const res = await jsonPost('/admin/listings/l1/review', { decision: 'maybe' });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'invalid_field', field: 'decision' });
  });

  it('400s an over-long reason', async () => {
    const res = await jsonPost('/admin/listings/l1/review', {
      decision: 'approve',
      reason: 'x'.repeat(1001),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'invalid_field', field: 'reason' });
  });

  it('404s an unknown or unlisted listing', async () => {
    h.getHarnessById.mockResolvedValue(null);
    expect((await jsonPost('/admin/listings/l1/review', { decision: 'approve' })).status).toBe(404);
    h.getHarnessById.mockResolvedValue({ id: 'l1', review_status: 'pending', unlisted_at: 123 });
    expect((await jsonPost('/admin/listings/l1/review', { decision: 'approve' })).status).toBe(404);
  });

  it('409s a listing that is not pending', async () => {
    h.getHarnessById.mockResolvedValue({ id: 'l1', review_status: 'approved', unlisted_at: null });
    const res = await jsonPost('/admin/listings/l1/review', { decision: 'approve' });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: 'not_pending', review_status: 'approved' });
  });

  it('approves a pending listing, persists status + audits the decision', async () => {
    const res = await jsonPost('/admin/listings/l1/review', { decision: 'approve', reason: '  good  ' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      id: 'l1',
      review_status: 'approved',
      approved_commit_sha: null,
      repinned: false,
      retired_ids: [],
    });
    // Approval is one atomic version-aware write (P-008), not a bare status flip. A
    // non-self-describing 'harness' listing carries no content pin, so nothing is
    // recorded as approved, nothing re-pinned, nothing retired.
    expect(h.approveListingVersion).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ id: 'l1', reason: 'good', approved: null, repinned: false, retire: null }),
    );
    expect(h.setReviewStatus).not.toHaveBeenCalled();
    // WI-10004643: the audit row rides in the approval's OWN atomic batch (D1 has no transaction
    // across two calls), so the route no longer issues a separate audit() for an approval.
    expect(h.audit).not.toHaveBeenCalled();
    const input = (h.approveListingVersion.mock.calls as unknown as unknown[][])[0][1] as { audit: { kind: string; detail: Record<string, unknown> } };
    expect(input.audit.kind).toBe('review_decided');
    expect(input.audit.detail).toMatchObject({ decision: 'approved', operator_github_user_id: 7, publisher_github_user_id: 42 });
  });

  it('refuses approval of an unpinned self-describing listing', async () => {
    h.getHarnessById.mockResolvedValue({
      id: 'plan-legacy',
      review_status: 'pending',
      unlisted_at: null,
      listing_kind: 'plan',
      publisher_github_user_id: 42,
      pinned_commit_sha: null,
      pinned_tree_digest: null,
    });
    const res = await jsonPost('/admin/listings/plan-legacy/review', { decision: 'approve' });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: 'content_pin_required',
      listing_kind: 'plan',
      reason: 'republish_required_before_approval',
    });
    expect(h.setReviewStatus).not.toHaveBeenCalled();
  });

  it('rejects a pending listing (status rejected, null reason when blank)', async () => {
    const res = await jsonPost('/admin/listings/l1/review', { decision: 'reject' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ review_status: 'rejected' });
    expect(h.setReviewStatus).toHaveBeenCalledWith(expect.anything(), 'l1', 'rejected', null, expect.any(Number));
  });
});

describe('GET /admin/banned-pubkeys', () => {
  it('lists operator-banned publisher pubkeys', async () => {
    h.listBannedPubkeys.mockResolvedValue([{ pubkey: 'k1' }]);
    const res = await authedGet('/admin/banned-pubkeys');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ banned: [{ pubkey: 'k1' }] });
  });
});

describe('POST /admin/banned-pubkeys', () => {
  it('400s invalid JSON', async () => {
    const res = await jsonPost('/admin/banned-pubkeys', 'nope');
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'invalid_json' });
  });

  it('400s a missing / empty pubkey', async () => {
    expect((await jsonPost('/admin/banned-pubkeys', {})).status).toBe(400);
    expect((await jsonPost('/admin/banned-pubkeys', { pubkey: '' })).status).toBe(400);
  });

  it('400s an over-long pubkey', async () => {
    const res = await jsonPost('/admin/banned-pubkeys', { pubkey: 'x'.repeat(201) });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'invalid_field', field: 'pubkey' });
  });

  it('bans a pubkey (default reason when omitted) and audits it', async () => {
    const res = await jsonPost('/admin/banned-pubkeys', { pubkey: 'k+/9' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(h.banPublisherPubkey).toHaveBeenCalledWith(expect.anything(), 'k+/9', 'unspecified', 7, expect.any(Number));
    expect(h.audit.mock.calls[0][2]).toBe('publisher_pubkey_banned');
  });

  it('trims a supplied reason before persisting', async () => {
    await jsonPost('/admin/banned-pubkeys', { pubkey: 'k1', reason: '  malware  ' });
    expect(h.banPublisherPubkey).toHaveBeenCalledWith(expect.anything(), 'k1', 'malware', 7, expect.any(Number));
  });
});

describe('POST /admin/banned-pubkeys/remove', () => {
  it('400s a missing pubkey', async () => {
    const res = await jsonPost('/admin/banned-pubkeys/remove', {});
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'invalid_field', field: 'pubkey' });
  });

  it('lifts a ban and audits the unban', async () => {
    const res = await jsonPost('/admin/banned-pubkeys/remove', { pubkey: 'k1' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(h.unbanPublisherPubkey).toHaveBeenCalledWith(expect.anything(), 'k1');
    expect(h.audit.mock.calls[0][2]).toBe('publisher_pubkey_unbanned');
  });

  it('is gated: 403s a non-operator (no unban)', async () => {
    h.isCupboardOperator.mockReturnValue(false);
    const res = await jsonPost('/admin/banned-pubkeys/remove', { pubkey: 'k1' });
    expect(res.status).toBe(403);
    expect(h.unbanPublisherPubkey).not.toHaveBeenCalled();
  });
});

describe('POST /admin/reports/:id/resolve — uncovered concurrency + validation branches', () => {
  beforeEach(() => {
    h.getReportById.mockResolvedValue({ id: 'r1', harness_id: 'h1', status: 'pending' });
    h.getHarnessById.mockResolvedValue({ id: 'h1', unlisted_at: null });
  });

  it('400s an over-long note', async () => {
    const res = await jsonPost('/admin/reports/r1/resolve', { action: 'dismiss', note: 'x'.repeat(1001) });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'invalid_field', field: 'note' });
  });

  it('409s when a concurrent resolve won the guarded UPDATE (changes === 0)', async () => {
    h.resolveReport.mockResolvedValue(0);
    const res = await jsonPost('/admin/reports/r1/resolve', { action: 'dismiss' });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: 'already_resolved' });
    expect(h.markHarnessUnlisted).not.toHaveBeenCalled();
  });

  it('unlist on an already-unlisted harness resolves the report but does NOT re-unlist', async () => {
    h.getHarnessById.mockResolvedValue({ id: 'h1', unlisted_at: 999 });
    const res = await jsonPost('/admin/reports/r1/resolve', { action: 'unlist' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: 'resolved_unlist', harness_unlisted: false });
    expect(h.markHarnessUnlisted).not.toHaveBeenCalled();
  });
});

describe('POST /admin/harnesses/:id/unlist — uncovered branches', () => {
  it('is idempotent: an already-unlisted harness returns already_unlisted without re-writing', async () => {
    h.getHarnessById.mockResolvedValue({ id: 'h1', unlisted_at: 123 });
    const res = await jsonPost('/admin/harnesses/h1/unlist', { reason: 'again' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, already_unlisted: true });
    expect(h.markHarnessUnlisted).not.toHaveBeenCalled();
  });

  it('404s an unknown harness', async () => {
    h.getHarnessById.mockResolvedValue(null);
    const res = await jsonPost('/admin/harnesses/nope/unlist', {});
    expect(res.status).toBe(404);
  });

  it('accepts an empty body (no JSON) and takes the harness down', async () => {
    h.getHarnessById.mockResolvedValue({ id: 'h1', unlisted_at: null });
    const res = await req('/admin/harnesses/h1/unlist', {
      method: 'POST',
      headers: { authorization: 'Bearer t' },
    });
    expect(res.status).toBe(200);
    expect(h.markHarnessUnlisted).toHaveBeenCalledWith(expect.anything(), 'h1', 'by_operator', expect.any(Number));
  });

  it('400s a malformed JSON body', async () => {
    const res = await jsonPost('/admin/harnesses/h1/unlist', '{ bad');
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'invalid_json' });
  });
});
