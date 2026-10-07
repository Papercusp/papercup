import { describe, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({ start: vi.fn(), get: vi.fn(), list: vi.fn(), artifact: vi.fn(), csrf: vi.fn(() => null) }));
vi.mock('../../plan-audit-runs', () => ({ startPlanAudit: h.start, getPlanAuditRun: h.get, listPlanAuditRuns: h.list, readAuditArtifact: h.artifact }));
vi.mock('../cors', () => ({ requireAllowedOriginOr403: h.csrf }));
import { planAuditHandler } from '../routes/admin/plan-audit';
import type { RouteContext } from '@papercusp/agent-mcp';
const ctx = {} as RouteContext;
describe('owner audit endpoint', () => {
  it('opens a durable running record and rejects malformed JSON', async () => {
    h.start.mockResolvedValue({ id: 'run', status: 'running' });
    const response = await planAuditHandler(new Request('http://localhost/api/admin/plan-audit', { method: 'POST', body: JSON.stringify({ scope: 'single', planSlugs: ['a'] }) }), ctx);
    expect(response.status).toBe(202);expect(h.start).toHaveBeenCalledWith({ scope: 'single', planSlugs: ['a'] });
    expect((await planAuditHandler(new Request('http://localhost/api/admin/plan-audit', { method: 'POST', body: '{' }), ctx)).status).toBe(400);
  });
  it('serves only completed artifacts with sandbox protection and no cache', async () => {
    h.get.mockResolvedValue({ id: 'run', status: 'complete' });h.artifact.mockResolvedValue('<html>audit</html>');
    const response = await planAuditHandler(new Request('http://localhost/api/admin/plan-audit?runId=run&format=html'), ctx);
    expect(response.headers.get('Content-Security-Policy')).toContain('sandbox allow-scripts');
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(await response.text()).toContain('audit');
    h.get.mockResolvedValue({ status: 'failed', error: 'failed generation' });
    expect((await planAuditHandler(new Request('http://localhost/api/admin/plan-audit?runId=run&format=html'), ctx)).status).toBe(409);
    h.get.mockResolvedValue(null);
    expect((await planAuditHandler(new Request('http://localhost/api/admin/plan-audit?runId=foreign'), ctx)).status).toBe(404);
  });
});
