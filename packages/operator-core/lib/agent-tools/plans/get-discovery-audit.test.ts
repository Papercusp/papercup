import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlanAudit } from '../../plan-audits';

vi.mock('./_ctx-opts', async (orig) => ({
  ...(await orig<typeof import('./_ctx-opts')>()),
  ctxToPlanSourceOpts: vi.fn(async () => ({ workspaceId: 'receipt-ws', harnessSlug: 'papercusp' })),
}));
vi.mock('./source', async (orig) => ({
  ...(await orig<typeof import('./source')>()),
  resolvePlanScope: vi.fn(async () => ({ workspaceId: 'receipt-ws', harnessSlug: 'papercusp' })),
  readPlanBySlug: vi.fn(),
}));
vi.mock('../../plan-audits', async (orig) => ({
  ...(await orig<typeof import('../../plan-audits')>()),
  getStoredDiscoveryAudit: vi.fn(), recordCurrentDiscoveryAudit: vi.fn(),
}));

import { assessDiscovery, getStoredDiscoveryAudit, recordCurrentDiscoveryAudit } from '../../plan-audits';
import { readPlanBySlug } from './source';
import tool from './get';

const discovery = assessDiscovery('# Draft\n', { targets: [], evidence: [] });
discovery.readiness.blockers = [{ code: 'discovery_evidence_unusable', path: 'findings.F-002', detail: 'Source changed.' }];
const audit: PlanAudit = { planSlug: 'draft', harnessSlug: 'papercusp', auditSeq: 76,
  auditKind: 'discovery', discovery, createdBy: 'su-auditor', createdAt: '2026-11-14T00:00:00Z',
  auditedSha: null, activation: null, auditedPlanRevision: null, items: [], findings: [], summary: null };
const mockRead = vi.mocked(getStoredDiscoveryAudit);
beforeEach(() => { vi.clearAllMocks(); mockRead.mockResolvedValue(audit); });

async function read(discoveryAudit: true | number) {
  return tool.handler(tool.args.parse({ slug: 'draft', harness: 'papercusp', discoveryAudit }),
    { workspaceId: 'receipt-ws', harnessSlug: 'papercusp', role: 'operator' } as never);
}

describe('stored Discovery receipt recovery', () => {
  it.each([true, 76] as const)('reads %s without re-running an audit or current enrichment', async (selector) => {
    expect(await read(selector)).toMatchObject({ data: { ok: true, results: [{
      slug: 'draft', harness: 'papercusp', readSource: 'stored-discovery-audit', historical: true,
      auditSeq: 76, readiness: discovery.readiness, audit,
    }] } });
    expect(mockRead).toHaveBeenCalledWith('draft', { workspaceId: 'receipt-ws', harnessSlug: 'papercusp',
      ...(selector === true ? {} : { auditSeq: selector }) });
    expect(recordCurrentDiscoveryAudit).not.toHaveBeenCalled();
    expect(readPlanBySlug).not.toHaveBeenCalled();
    expect(tool.capability).toBe('plans:read');
  });

  it('does not substitute another receipt for a missing sequence', async () => {
    mockRead.mockResolvedValueOnce(null);
    expect(await read(999)).toMatchObject({ data: { ok: false, results: [{
      ok: false, error: 'discovery_audit_not_found', requestedAudit: 999,
    }] } });
    expect(recordCurrentDiscoveryAudit).not.toHaveBeenCalled();
  });

  it('does not turn a storage failure into an absent or ready verdict', async () => {
    mockRead.mockRejectedValueOnce(new Error('receipt storage unavailable'));
    await expect(read(true)).rejects.toThrow('receipt storage unavailable');
  });

  it('exposes an absent legacy readiness payload as unknown', async () => {
    mockRead.mockResolvedValueOnce({ ...audit, discovery: null });
    expect(await read(76)).toMatchObject({ data: { results: [{ readiness: null, historical: true }] } });
  });

  it('requires an unambiguous single plan and a valid stored sequence', () => {
    for (const args of [{ discoveryAudit: 0 }, { discoveryAudit: false }, { discoveryAudit: 1.5 },
      { discoveryAudit: true, revision: 1 }, { discoveryAudit: true, slugs: ['draft'] }]) {
      expect(tool.args.safeParse({ slug: 'draft', ...args }).success).toBe(false);
    }
  });
});
