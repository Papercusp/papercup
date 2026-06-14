import { describe, it, expect, beforeEach, vi } from 'vitest';
import decideTool from './decide_candidate';
import { getFlag } from '@papercusp/flags/server';
import { decideLearningPackCandidate } from '../../learning-packs/candidates';
import { getSessionUserOrDefault } from '../../auth';

// PG-free unit: the decide core has its own suite; this pins the TOOL — flag
// gate, the by=session-user wiring, the failure pass-through, and the adopt-only
// hint (self-improvement-consume-edges P-032 / B-11).
vi.mock('@papercusp/flags/server', () => ({ getFlag: vi.fn() }));
vi.mock('../../workspace-registry', () => ({ activeWorkspaceId: vi.fn(() => 'ws-active') }));
vi.mock('../../learning-packs/candidates', () => ({ decideLearningPackCandidate: vi.fn() }));
vi.mock('../../auth', () => ({ getSessionUserOrDefault: vi.fn() }));

const mockFlag = vi.mocked(getFlag);
const mockDecide = vi.mocked(decideLearningPackCandidate);
const mockUser = vi.mocked(getSessionUserOrDefault);

function callTool(args: Record<string, unknown>, ctx: Record<string, unknown> = {}) {
  return (
    decideTool as unknown as {
      handler: (a: unknown, c: unknown) => Promise<{ content: Array<{ text: string }> }>;
    }
  ).handler(args, ctx);
}
const body = (r: { content: Array<{ text: string }> }) => JSON.parse(r.content[0].text);

describe('learning_packs:decide_candidate tool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFlag.mockResolvedValue(true);
    mockUser.mockResolvedValue({ id: 'owner-1' } as Awaited<ReturnType<typeof getSessionUserOrDefault>>);
    mockDecide.mockResolvedValue({ ok: true, action: 'adopt', packVersion: '1.1.0' } as unknown as Awaited<
      ReturnType<typeof decideLearningPackCandidate>
    >);
  });

  it('refuses when the flag is off', async () => {
    mockFlag.mockResolvedValue(false);
    expect(body(await callTool({ id: 'c1', action: 'adopt' }))).toMatchObject({ ok: false, reason: 'feature-disabled' });
  });

  it('decides with the session user as `by`, forwarding optional edits', async () => {
    await callTool({ id: 'c1', action: 'adopt', note: 'good lesson', title: 'T', text: 'B' });
    expect(mockDecide).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'c1', action: 'adopt', by: 'owner-1', note: 'good lesson', title: 'T', text: 'B' }),
    );
  });

  it('passes a core failure straight through', async () => {
    mockDecide.mockResolvedValue({ ok: false, reason: 'not_found' } as unknown as Awaited<
      ReturnType<typeof decideLearningPackCandidate>
    >);
    expect(body(await callTool({ id: 'gone', action: 'dismiss' }))).toMatchObject({ ok: false, reason: 'not_found' });
  });

  it('adds the upgrade hint on adopt, but not on dismiss', async () => {
    const adopted = body(await callTool({ id: 'c1', action: 'adopt' }));
    expect(adopted.hint).toMatch(/fleet-lessons pack/);

    mockDecide.mockResolvedValue({ ok: true, action: 'dismiss' } as unknown as Awaited<
      ReturnType<typeof decideLearningPackCandidate>
    >);
    const dismissed = body(await callTool({ id: 'c1', action: 'dismiss' }));
    expect(dismissed.hint).toBeUndefined();
  });
});
