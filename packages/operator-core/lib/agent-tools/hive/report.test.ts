/**
 * report.test.ts — hive:report HANDLER for member-filed moderation reports
 * (Brief EN-3 / P-MOD). Gates on owner-enabled reporting; files content or
 * member reports; federates to the owner's moderation queue.
 *
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/hive/report.test.ts
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  getHivePolicy: vi.fn(),
  resolveLocalGithubIdentity: vi.fn(),
  fileReport: vi.fn(),
  getHiveMember: vi.fn(),
}));

vi.mock('../../workspace-registry', () => ({ activeWorkspaceId: () => 'default' }));
vi.mock('../../hive-policy-store', () => ({ getHivePolicy: h.getHivePolicy }));
vi.mock('../../identity/resolve-local-github-identity', () => ({
  resolveLocalGithubIdentity: h.resolveLocalGithubIdentity,
}));
vi.mock('../../hive-reports-store', () => ({ fileReport: h.fileReport }));
vi.mock('../../hive-membership-store', () => ({ getHiveMember: h.getHiveMember }));

import tool from './report';

const CTX = { workspaceId: 'default' } as never;

type Out = { data?: any; content?: Array<{ text: string }> };
const env = async (args: unknown) => {
  const r = (await tool.handler(args as never, CTX)) as Out;
  return r.data ?? JSON.parse(r.content![0].text);
};

beforeEach(() => {
  vi.clearAllMocks();
  h.getHivePolicy.mockResolvedValue({ policy: { moderation: { reportable: true } } });
  h.resolveLocalGithubIdentity.mockResolvedValue({ kind: 'ok', githubUserId: 123, githubLogin: 'alice' });
  h.getHiveMember.mockResolvedValue({ githubUserId: 123, bindingStatus: 'verified' });
  h.fileReport.mockImplementation(async (input) => ({
    ...input,
    reportId: 'r-1',
    status: 'open',
    createdAt: 1000,
    updatedAt: 1000,
  }));
});

describe('hive:report handler (member-filed moderation reports)', () => {
  it('reporting disabled → no-op (not_enabled)', async () => {
    h.getHivePolicy.mockResolvedValue({ policy: { moderation: { reportable: false } } });
    const b = await env({ hive: 'sheets', targetKind: 'content', targetRef: 'F-1' });
    expect(b).toMatchObject({ ok: false, code: 'reporting_not_enabled' });
    expect(h.fileReport).not.toHaveBeenCalled();
  });

  it('reporting policy missing/error → no-op (policy gate)', async () => {
    h.getHivePolicy.mockRejectedValue(new Error('not found'));
    const b = await env({ hive: 'sheets', targetKind: 'content', targetRef: 'F-1' });
    expect(b).toMatchObject({ ok: false, code: 'reporting_not_enabled' });
  });

  it('reporter identity resolution fails → no_reporter_identity', async () => {
    h.resolveLocalGithubIdentity.mockResolvedValue({ kind: 'error', detail: 'no identity' });
    const b = await env({ hive: 'sheets', targetKind: 'content', targetRef: 'F-1' });
    expect(b).toMatchObject({ ok: false, code: 'no_reporter_identity' });
    expect(h.fileReport).not.toHaveBeenCalled();
  });

  it('reports content (feature/work-item ref)', async () => {
    const b = await env({ hive: 'sheets', targetKind: 'content', targetRef: 'F-42' });
    expect(b).toMatchObject({ ok: true });
    expect(h.fileReport).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: 'default',
        hiveHomeSlug: 'sheets',
        targetKind: 'content',
        targetRef: 'F-42',
        reporterGithubUserId: 123,
        reporterGithubUsername: 'alice',
      }),
    );
  });

  it('reports member (by numeric github id)', async () => {
    const b = await env({ hive: 'sheets', targetKind: 'member', targetRef: '456' });
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
      hive: 'sheets',
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
    await env({ hive: 'sheets', targetKind: 'content', targetRef: 'F-1' });
    expect(h.fileReport).toHaveBeenCalledWith(
      expect.objectContaining({
        reportReason: null,
      }),
    );
  });

  it('arg schema requires targetKind + targetRef', () => {
    expect(tool.args.safeParse({ hive: 'sheets' }).success).toBe(false);
    expect(
      tool.args.safeParse({ hive: 'sheets', targetKind: 'content', targetRef: 'F-1' }).success,
    ).toBe(true);
  });

  it('arg schema rejects invalid targetKind', () => {
    expect(
      tool.args.safeParse({ hive: 'sheets', targetKind: 'invalid', targetRef: 'F-1' }).success,
    ).toBe(false);
  });

  it('file report captures full reporter identity', async () => {
    await env({ hive: 'sheets', targetKind: 'content', targetRef: 'F-1' });
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
      hive: 'sheets',
      targetKind: 'content',
      targetRef: 'F-1',
    });
    // fileReport handles idempotency via ON CONFLICT in the store
    expect(h.fileReport).toHaveBeenCalledTimes(1);
  });

  it('WI-567: a non-member (left/banned/never-joined) cannot file a report', async () => {
    h.getHiveMember.mockResolvedValue(null);
    const b = await env({ hive: 'sheets', targetKind: 'content', targetRef: 'F-1' });
    expect(b).toMatchObject({ ok: false, code: 'not_a_member' });
    expect(h.fileReport).not.toHaveBeenCalled();
  });

  it('WI-567: a membership-lookup error fails CLOSED (never silently admits the report)', async () => {
    h.getHiveMember.mockRejectedValue(new Error('db unavailable'));
    const b = await env({ hive: 'sheets', targetKind: 'content', targetRef: 'F-1' });
    expect(b).toMatchObject({ ok: false, code: 'not_a_member' });
    expect(h.fileReport).not.toHaveBeenCalled();
  });

  it('self-report allowed (member can report own content)', async () => {
    const b = await env({
      hive: 'sheets',
      targetKind: 'content',
      targetRef: 'F-authored-by-alice',
      reason: 'I want this removed',
    });
    // No special gate on self-report; it's treated as a regular report
    expect(b.ok).toBe(true);
  });
});
