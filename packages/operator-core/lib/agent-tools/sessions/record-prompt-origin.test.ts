import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../coordination/identity', () => ({
  resolveAgentIdentity: vi.fn(() => ({ ownerId: 'su-1', workspaceId: 'ws-1' })),
  requireWorkspaceId: vi.fn(() => 'ws-1'),
}));
vi.mock('../../telemetry-call-origin', () => ({ classifyCallOrigin: vi.fn() }));
const query = vi.fn();
vi.mock('@papercusp/db-org', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getOrgPg: () => ({ sql: query }),
}));
const { classifyCallOrigin } = await import('../../telemetry-call-origin');
const tool = (await import('./record-prompt-origin')).default as any;
const call = (args: any, ctx: any = {}) => tool.handler(args, ctx);
beforeEach(() => {
  query.mockClear();
  vi.mocked(classifyCallOrigin).mockReset();
});
describe('sessions:record-prompt-origin', () => {
  it('accepts only a declared hook origin', async () => {
    vi.mocked(classifyCallOrigin).mockReturnValue({ origin: 'hook', source: 'declared' });
    query.mockResolvedValue({ count: 1 });
    const out = await call({ sessionId: 'native-1', sourceKind: 'claude', promptHash: 'a'.repeat(64), submittedAtMs: 1700000000000 }, { requestOrigin: { query: { origin: 'hook' } } });
    expect(out.data.ok).toBe(true);
    expect(query).toHaveBeenCalled();
  });
  it('refuses derived or model origins', async () => {
    vi.mocked(classifyCallOrigin).mockReturnValue({ origin: 'agent', source: 'derived' });
    const out = await call({ sessionId: 'native-1', promptHash: 'a'.repeat(64), submittedAtMs: 1700000000000 });
    expect(out.data).toEqual({ ok: false, recorded: false, error: 'hook_origin_required' });
    expect(query).not.toHaveBeenCalled();
  });
});
