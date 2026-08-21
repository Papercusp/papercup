/**
 * plans:audit writer-contract guard (plan-completion-audit-and-acceptance-verdict
 * D-008). These are handler/schema tests, not just coverage-fold tests: they pin
 * the exact boundary that decides whether an auditor actually read code.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../_harness-scope', async (orig) => ({
  ...(await orig<typeof import('../_harness-scope')>()),
  harnessScopedCtx: (_h: unknown, ctx: unknown) => ctx,
}));
vi.mock('./_ctx-opts', () => ({ resolveCtxHarnessSlug: () => 'papercusp' }));
vi.mock('../coordination/identity', () => ({
  resolveAgentIdentity: () => ({ ownerId: 'su-auditor' }),
}));
vi.mock('../coordination/plan-events', () => ({ emitPlanEventForCaller: vi.fn(async () => {}) }));
vi.mock('../../plan-audits', async (orig) => {
  const actual = await orig<typeof import('../../plan-audits')>();
  return {
    ...actual,
    getPlanItemStatuses: vi.fn(),
    getEffectiveItemAudits: vi.fn(),
    repoCitationContextForHarness: vi.fn(),
    recordPlanAudit: vi.fn(),
  };
});

import {
  getEffectiveItemAudits,
  getPlanItemStatuses,
  recordPlanAudit,
  repoCitationContextForHarness,
} from '../../plan-audits';
import tool from './audit';

const mockItems = vi.mocked(getPlanItemStatuses);
const mockPrevious = vi.mocked(getEffectiveItemAudits);
const mockContext = vi.mocked(repoCitationContextForHarness);
const mockRecord = vi.mocked(recordPlanAudit);

const ctx = {
  log: vi.fn(),
  signal: new AbortController().signal,
  progress: vi.fn(),
  role: 'operator',
} as never;

const body = async (items: Array<Record<string, unknown>>) =>
  ((await tool.handler({ slug: 'plan-a', harness: 'papercusp', items } as never, ctx)) as { data: any }).data;

beforeEach(() => {
  vi.clearAllMocks();
  mockItems.mockResolvedValue([{ itemId: 'P-001', status: 'done', itemText: 'ship the audit gate' }]);
  mockPrevious.mockResolvedValue([]);
  mockContext.mockResolvedValue({
    repoRoot: '/repo',
    deps: {
      statFile: (path) => (path === 'src/gate.ts' ? { isFile: true } : null),
      readFile: (path) => (path === 'src/gate.ts' ? 'export const gate = true;\n' : null),
      blobSha: (path) => (path === 'src/gate.ts' ? '0123456789012345678901234567890123456789' : null),
    },
  });
  mockRecord.mockResolvedValue({ auditSeq: 1, auditedSha: 'head-1' } as never);
});

describe('plans:audit D-008 writer contract', () => {
  it.each([
    ['doc', { kind: 'doc', ref: '/internal/docs/gate', reason: 'the document describes it' }],
    ['none', { kind: 'none', reason: 'no source was inspected' }],
  ])('refuses implemented backed only by a %s declaration', async (_kind, citation) => {
    const result = await body([{ itemId: 'P-001', verdict: 'implemented', citations: [citation] }]);

    expect(result).toMatchObject({ ok: false, error: 'audit_invalid' });
    expect(result.problems).toEqual(
      expect.arrayContaining([expect.objectContaining({ itemId: 'P-001', code: 'implemented_without_code' })]),
    );
    expect(mockRecord).not.toHaveBeenCalled();
  });

  it('requires a reason for the metered not-code escape hatch', async () => {
    const result = await body([{ itemId: 'P-001', verdict: 'not-code', citations: [] }]);

    expect(result).toMatchObject({ ok: false, error: 'audit_invalid' });
    expect(result.problems).toEqual(
      expect.arrayContaining([expect.objectContaining({ itemId: 'P-001', code: 'not_code_without_reason' })]),
    );
    expect(mockRecord).not.toHaveBeenCalled();
  });

  it('rejects work-item intent as a citation kind at the live input schema', () => {
    const parsed = tool.args.safeParse({
      slug: 'plan-a',
      items: [{ itemId: 'P-001', verdict: 'implemented', citations: [{ kind: 'workitem', ref: 'WI-1' }] }],
    });

    expect(parsed.success).toBe(false);
  });

  it('records a resolving code citation with blob provenance and reports it verified', async () => {
    const result = await body([
      { itemId: 'P-001', verdict: 'implemented', citations: [{ kind: 'code', path: 'src/gate.ts', symbol: 'gate' }] },
    ]);

    expect(result).toMatchObject({
      ok: true,
      coverage: { auditedItems: 1, verifiedItems: 1, verifiedRatio: 1, unverifiedItemIds: [] },
    });
    expect(mockRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        items: [
          expect.objectContaining({
            itemId: 'P-001',
            citations: [expect.objectContaining({ kind: 'code', path: 'src/gate.ts', blobSha: expect.any(String) })],
          }),
        ],
      }),
    );
  });
});
