/**
 * report.test.ts — pot:report HANDLER for member-filed moderation reports
 * (Brief EN-3 / P-MOD). Gates on owner-enabled reporting; files content or
 * member reports; federates to the owner's moderation queue.
 *
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/pot/report.test.ts
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  getPotPolicy: vi.fn(),
  resolveLocalGithubIdentity: vi.fn(),
  fileReport: vi.fn(),
  getPotMember: vi.fn(),
  countReportsSince: vi.fn(),
  resolveHiveWorkspaceId: vi.fn(),
  resolveFederatedPotScope: vi.fn(),
}));

vi.mock('../../workspace-registry', () => ({
  resolveConcreteWorkspaceId: (...candidates: Array<string | null | undefined>) =>
    candidates.find((candidate) => typeof candidate === 'string' && candidate.trim() && candidate.trim() !== '*')?.trim() ?? 'default',
}));
// hive-policy-store / hive-reports-store / hive-membership-store are OUT OF SCOPE for the
// cup-lexicon rename (persisted-store identifiers) — mock the REAL module paths + export
// names; only the local test-side aliases (h.getPotPolicy etc.) are renamed.
vi.mock('../../hive-policy-store', () => ({ getHivePolicy: h.getPotPolicy }));
vi.mock('../../identity/resolve-local-github-identity', () => ({
  resolveLocalGithubIdentity: h.resolveLocalGithubIdentity,
}));
vi.mock('../../hive-reports-store', () => ({ fileReport: h.fileReport, countReportsSince: h.countReportsSince }));
vi.mock('../../hive-membership-store', () => ({ getHiveMember: h.getPotMember }));
// WI-5334: resolveHiveWorkspaceId (../../hive-store) — mocked (not left to hit the real DB)
// so the ambient-vs-resolved-workspace-mismatch class has a fast, deterministic unit test
// instead of relying solely on the live two-instance smoke witness.
vi.mock('../../hive-store', () => ({ resolveHiveWorkspaceId: h.resolveHiveWorkspaceId }));
// WI-6318: the SLUG-axis twin of the WI-5334 mock above. `args.pot` is a tool argument, so on
// a joiner it is the LOCAL handle, while hive_policy / pot_members / hive_reports are all
// `hiveScoped` — persisted under the OWNER-authored slug. Mocked (like resolveHiveWorkspaceId)
// so the divergence has a fast deterministic unit test rather than only a live witness.
vi.mock('../../federated-pot-scope', () => ({
  resolveFederatedPotScope: h.resolveFederatedPotScope,
}));

import tool from './report';

const CTX = { workspaceId: 'default' } as never;

type Out = { data?: any; content?: Array<{ text: string }> };
const env = async (args: unknown) => {
  const r = (await tool.handler(args as never, CTX)) as Out;
  return r.data ?? JSON.parse(r.content![0].text);
};

beforeEach(() => {
  vi.clearAllMocks();
  h.getPotPolicy.mockResolvedValue({ policy: { moderation: { reportable: true } } });
  h.resolveLocalGithubIdentity.mockResolvedValue({ kind: 'ok', githubUserId: 123, githubLogin: 'alice' });
  h.getPotMember.mockResolvedValue({ githubUserId: 123, bindingStatus: 'verified' });
  h.countReportsSince.mockResolvedValue(0);
  h.fileReport.mockImplementation(async (input) => ({
    ...input,
    reportId: 'r-1',
    status: 'open',
    createdAt: 1000,
    updatedAt: 1000,
  }));
  // Default: no ambient/real-partition mismatch — echo the ambient workspaceId straight
  // back, exactly like the real resolveHiveWorkspaceId when the Hive IS minted under the
  // caller's ambient workspace (the common case; existing tests below assume 'default').
  h.resolveHiveWorkspaceId.mockImplementation(async (ambientWorkspaceId: string) => ambientWorkspaceId);
  // Default: no slug divergence either — echo the caller's slug back, exactly like the real
  // resolver on a Pot's OWNER (canonical == local). Existing tests below assume 'sheets'.
  h.resolveFederatedPotScope.mockImplementation(async (_ws: string, localSlug: string) => localSlug);
});

describe('WI-6318 — a joiner whose local pot handle differs from the owner slug', () => {
  it('every hive-home-grained read AND the report WRITE use the RESOLVED (federated) scope, never the caller’s local handle', async () => {
    // The joiner topology: the caller names its LOCAL handle, the projections persist under
    // the OWNER's slug. Before this fix each of the four operations below silently used the
    // local handle: the policy gate answered reporting_not_enabled, the WI-567 membership gate
    // refused an admitted member, the rate count was always 0, and the report WRITE landed in
    // a scope no reader queries — while the tool still returned ok:true.
    h.resolveFederatedPotScope.mockResolvedValue('sheets-owner');
    const b = await env({ pot: 'sheets-2', targetKind: 'content', targetRef: 'F-1' });
    expect(b).toMatchObject({ ok: true });

    expect(h.resolveFederatedPotScope).toHaveBeenCalledWith('default', 'sheets-2');
    // 1. the owner-signed policy gate
    expect(h.getPotPolicy).toHaveBeenCalledWith('default', 'sheets-owner');
    // 2. the WI-567 fail-closed membership gate
    expect(h.getPotMember).toHaveBeenCalledWith('default', 'sheets-owner', 123);
    // 3. the rate-limit count — must count under the scope the rows are WRITTEN to
    expect(h.countReportsSince).toHaveBeenCalledWith('default', 'sheets-owner', 123, expect.any(Number));
    // 4. the write itself — the one that silently vanished
    expect(h.fileReport).toHaveBeenCalledWith(expect.objectContaining({ potHomeSlug: 'sheets-owner' }));
    // The caller's own handle is NEVER what reaches the store.
    expect(h.fileReport).not.toHaveBeenCalledWith(expect.objectContaining({ potHomeSlug: 'sheets-2' }));
  });

  it('is a NO-OP on an owner (canonical == local): the caller’s slug is used unchanged', async () => {
    // The regression half: every owned Pot must behave byte-identically to pre-fix.
    const b = await env({ pot: 'sheets', targetKind: 'content', targetRef: 'F-1' });
    expect(b).toMatchObject({ ok: true });
    expect(h.getPotPolicy).toHaveBeenCalledWith('default', 'sheets');
    expect(h.fileReport).toHaveBeenCalledWith(expect.objectContaining({ potHomeSlug: 'sheets' }));
  });
});

describe('pot:report handler (member-filed moderation reports)', () => {
  it('reporting disabled → no-op (not_enabled)', async () => {
    h.getPotPolicy.mockResolvedValue({ policy: { moderation: { reportable: false } } });
    const b = await env({ pot: 'sheets', targetKind: 'content', targetRef: 'F-1' });
    expect(b).toMatchObject({ ok: false, code: 'reporting_not_enabled' });
    expect(h.fileReport).not.toHaveBeenCalled();
  });

  it('reporting policy missing/error → no-op (policy gate)', async () => {
    h.getPotPolicy.mockRejectedValue(new Error('not found'));
    const b = await env({ pot: 'sheets', targetKind: 'content', targetRef: 'F-1' });
    expect(b).toMatchObject({ ok: false, code: 'reporting_not_enabled' });
  });

  it('reporter identity resolution fails → no_reporter_identity', async () => {
    h.resolveLocalGithubIdentity.mockResolvedValue({ kind: 'error', detail: 'no identity' });
    const b = await env({ pot: 'sheets', targetKind: 'content', targetRef: 'F-1' });
    expect(b).toMatchObject({ ok: false, code: 'no_reporter_identity' });
    expect(h.fileReport).not.toHaveBeenCalled();
  });

  it('reports content (feature/work-item ref)', async () => {
    const b = await env({ pot: 'sheets', targetKind: 'content', targetRef: 'F-42' });
    expect(b).toMatchObject({ ok: true });
    expect(h.fileReport).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: 'default',
        potHomeSlug: 'sheets',
        targetKind: 'content',
        targetRef: 'F-42',
        reporterGithubUserId: 123,
        reporterGithubUsername: 'alice',
      }),
    );
  });

  it('reports member (by numeric github id)', async () => {
    const b = await env({ pot: 'sheets', targetKind: 'member', targetRef: '456' });
    expect(b).toMatchObject({ ok: true });
    expect(h.fileReport).toHaveBeenCalledWith(
      expect.objectContaining({
        targetKind: 'member',
        targetRef: '456',
      }),
    );
  });

  it('includes optional reportReason when provided', async () => {
    const b = await env({
      pot: 'sheets',
      targetKind: 'content',
      targetRef: 'F-1',
      reason: 'Contains spam',
    });
    expect(b).toMatchObject({ ok: true });
    expect(h.fileReport).toHaveBeenCalledWith(
      expect.objectContaining({
        reportReason: 'Contains spam',
      }),
    );
  });

  it('omits reportReason when absent', async () => {
    await env({ pot: 'sheets', targetKind: 'content', targetRef: 'F-1' });
    expect(h.fileReport).toHaveBeenCalledWith(
      expect.objectContaining({
        reportReason: null,
      }),
    );
  });

  it('arg schema requires targetKind + targetRef', () => {
    expect(tool.args.safeParse({ pot: 'sheets' }).success).toBe(false);
    expect(
      tool.args.safeParse({ pot: 'sheets', targetKind: 'content', targetRef: 'F-1' }).success,
    ).toBe(true);
  });

  it('arg schema rejects invalid targetKind', () => {
    expect(
      tool.args.safeParse({ pot: 'sheets', targetKind: 'invalid', targetRef: 'F-1' }).success,
    ).toBe(false);
  });

  it('file report captures full reporter identity', async () => {
    await env({ pot: 'sheets', targetKind: 'content', targetRef: 'F-1' });
    expect(h.fileReport).toHaveBeenCalledWith(
      expect.objectContaining({
        reporterGithubUserId: 123,
        reporterGithubUsername: 'alice',
      }),
    );
  });

  it('idempotent on same reportId (passed through fileReport)', async () => {
    h.fileReport.mockImplementation(async (input) => ({
      ...input,
      reportId: input.reportId || 'auto-generated-id',
      status: 'open',
      createdAt: 1000,
      updatedAt: 1500, // caller may retry with same id
    }));
    await env({
      pot: 'sheets',
      targetKind: 'content',
      targetRef: 'F-1',
    });
    // fileReport handles idempotency via ON CONFLICT in the store
    expect(h.fileReport).toHaveBeenCalledTimes(1);
  });

  it('WI-567: a non-member (left/banned/never-joined) cannot file a report', async () => {
    h.getPotMember.mockResolvedValue(null);
    const b = await env({ pot: 'sheets', targetKind: 'content', targetRef: 'F-1' });
    expect(b).toMatchObject({ ok: false, code: 'not_a_member' });
    expect(h.fileReport).not.toHaveBeenCalled();
  });

  it('WI-567: a membership-lookup error fails CLOSED (never silently admits the report)', async () => {
    h.getPotMember.mockRejectedValue(new Error('db unavailable'));
    const b = await env({ pot: 'sheets', targetKind: 'content', targetRef: 'F-1' });
    expect(b).toMatchObject({ ok: false, code: 'not_a_member' });
    expect(h.fileReport).not.toHaveBeenCalled();
  });

  it('WI-567: report-spam vector — reporter at the rate limit is rejected before fileReport is called', async () => {
    h.countReportsSince.mockResolvedValue(20);
    const b = await env({ pot: 'sheets', targetKind: 'content', targetRef: 'F-1' });
    expect(b).toMatchObject({ ok: false, code: 'rate_limited' });
    expect(h.fileReport).not.toHaveBeenCalled();
  });

  it('WI-567: reporter just under the rate limit is still allowed', async () => {
    h.countReportsSince.mockResolvedValue(19);
    const b = await env({ pot: 'sheets', targetKind: 'content', targetRef: 'F-1' });
    expect(b).toMatchObject({ ok: true });
    expect(h.fileReport).toHaveBeenCalled();
  });

  it('WI-567: rate-limit lookup checks the CURRENT reporter + pot, not a stale scope', async () => {
    await env({ pot: 'sheets', targetKind: 'content', targetRef: 'F-1' });
    expect(h.countReportsSince).toHaveBeenCalledWith('default', 'sheets', 123, expect.any(Number));
  });

  it('WI-567: a rate-limit lookup error fails OPEN (abuse guard, not a correctness gate)', async () => {
    h.countReportsSince.mockRejectedValue(new Error('db unavailable'));
    const b = await env({ pot: 'sheets', targetKind: 'content', targetRef: 'F-1' });
    expect(b).toMatchObject({ ok: true });
    expect(h.fileReport).toHaveBeenCalled();
  });

  it('WI-5334: a JOINED member whose ambient workspace differs from the Hive\'s real partition still resolves policy/membership/rate-limit/fileReport against the RESOLVED workspace, not the ambient one', async () => {
    // Reproduces the WI-5334/WI-5321/WI-5061 ambient-workspace-mismatch family: the
    // caller's ambient workspaceId ('default') is NOT where this Hive's rows (policy,
    // membership) actually live — resolveHiveWorkspaceId resolves to the Hive's real
    // partition ('hive-real-ws'). Before the fix, every downstream lookup used the
    // ambient id directly and silently missed (reportable read as false / not_a_member),
    // and fileReport would have persisted under a partition no reader ever queries.
    h.resolveHiveWorkspaceId.mockImplementation(async (_ambient: string, potHomeSlug: string) =>
      potHomeSlug === 'sheets' ? 'hive-real-ws' : _ambient,
    );
    const b = await env({ pot: 'sheets', targetKind: 'content', targetRef: 'F-1' });
    expect(b).toMatchObject({ ok: true });
    expect(h.resolveHiveWorkspaceId).toHaveBeenCalledWith('default', 'sheets');
    expect(h.getPotPolicy).toHaveBeenCalledWith('hive-real-ws', 'sheets');
    expect(h.getPotMember).toHaveBeenCalledWith('hive-real-ws', 'sheets', 123);
    expect(h.countReportsSince).toHaveBeenCalledWith('hive-real-ws', 'sheets', 123, expect.any(Number));
    expect(h.fileReport).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: 'hive-real-ws', potHomeSlug: 'sheets' }),
    );
  });

  it('self-report allowed (member can report own content)', async () => {
    const b = await env({
      pot: 'sheets',
      targetKind: 'content',
      targetRef: 'F-authored-by-alice',
      reason: 'I want this removed',
    });
    // No special gate on self-report; it's treated as a regular report
    expect(b.ok).toBe(true);
  });
});
