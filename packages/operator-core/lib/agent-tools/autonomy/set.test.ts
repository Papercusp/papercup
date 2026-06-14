import { describe, it, expect, beforeEach, vi } from 'vitest';
import setTool from './set';
import { setAutonomyPolicy } from '../../autonomy/policy-store';
import { effectiveCeiling } from '../../autonomy/policy';
import { notifySyncInvalidate } from '../../sync-sse';
import { activeWorkspaceId } from '../../workspace-registry';

// PG-free unit: store invariants are enforced + tested in policy-store; this pins
// the TOOL — the actor resolution, the success path (write → sync-invalidate →
// effectiveCeiling envelope) and the store-error → { ok:false, isError } path
// (B-03 / P-022).
vi.mock('@papercusp/db-org', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return { ...actual, getOrgPg: () => ({ sql: {} }) };
});
vi.mock('../../workspace-registry', () => ({ activeWorkspaceId: vi.fn(() => 'ws-active') }));
vi.mock('../../autonomy/policy-store', () => ({ setAutonomyPolicy: vi.fn() }));
vi.mock('../../autonomy/policy', () => ({ effectiveCeiling: vi.fn() }));
vi.mock('../../sync-sse', () => ({ notifySyncInvalidate: vi.fn() }));

const mockSet = vi.mocked(setAutonomyPolicy);
const mockEffective = vi.mocked(effectiveCeiling);
const mockInvalidate = vi.mocked(notifySyncInvalidate);
const mockActiveWs = vi.mocked(activeWorkspaceId);

function callTool(args: Record<string, unknown>, ctx: Record<string, unknown> = {}) {
  return (
    setTool as unknown as {
      handler: (a: unknown, c: unknown) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>;
    }
  ).handler(args, ctx);
}

const OK_ARGS = { category: 'docs-publish', ceiling: 'low', reason: 'owner lowered ceiling' };

describe('autonomy:policy_set tool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockActiveWs.mockReturnValue('ws-active');
    mockEffective.mockReturnValue('low' as ReturnType<typeof effectiveCeiling>);
    mockInvalidate.mockResolvedValue(undefined as never);
    mockSet.mockResolvedValue({ category: 'docs-publish', ceiling: 'low', graduatedLevel: 'low', locked: false } as unknown as Awaited<
      ReturnType<typeof setAutonomyPolicy>
    >);
  });

  it('writes the policy with the resolved actor + workspace, then fires the sync invalidate', async () => {
    await callTool(OK_ARGS, { principal: { workspaceId: 'ws-prin', slug: 'owner-sue' } });
    expect(mockSet).toHaveBeenCalledWith(
      expect.anything(),
      'ws-prin',
      expect.objectContaining({ category: 'docs-publish', ceiling: 'low', reason: 'owner lowered ceiling' }),
      'owner-sue',
    );
    expect(mockInvalidate).toHaveBeenCalledWith('autonomy.policy', { workspaceId: 'ws-prin' });
  });

  it('defaults the actor to "agent" when no principal slug', async () => {
    await callTool(OK_ARGS, {});
    expect(mockSet).toHaveBeenCalledWith(expect.anything(), 'ws-active', expect.anything(), 'agent');
  });

  it('decorates the written policy with effectiveCeiling in the envelope', async () => {
    const res = await callTool(OK_ARGS);
    const body = JSON.parse(res.content[0].text);
    expect(body.ok).toBe(true);
    expect(body.policy.effectiveCeiling).toBe('low');
  });

  it('maps a store invariant error to { ok:false, isError } with the message, and does NOT invalidate', async () => {
    mockSet.mockRejectedValue(new Error('graduated > ceiling'));
    const res = await callTool(OK_ARGS);
    expect(res.isError).toBe(true);
    const body = JSON.parse(res.content[0].text);
    expect(body).toMatchObject({ ok: false, reason: 'graduated > ceiling', category: 'docs-publish' });
    expect(mockInvalidate).not.toHaveBeenCalled();
  });
});
