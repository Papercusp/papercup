import { describe, expect, it, vi } from 'vitest';
import { currentRequestWorkspaceId } from '../../workspace-als';
import type { ExpirySweepDeps } from '../../consult/consult-expiry-core';

const seams = vi.hoisted(() => ({
  register: vi.fn(),
  sweep: vi.fn(async (_deps: ExpirySweepDeps) => undefined),
  send: vi.fn(async () => undefined),
}));
vi.mock('./system-actions', () => ({ registerSystemAction: seams.register }));
vi.mock('@papercusp/db-org', async (original) => ({
  ...await original<typeof import('@papercusp/db-org')>(),
  getOrgPg: () => ({ sql: {} }),
}));
vi.mock('../../consult/consult-expiry-core', async (original) => ({
  ...await original<typeof import('../../consult/consult-expiry-core')>(),
  sweepExpiredConsults: seams.sweep,
}));
vi.mock('../../events/await/engine', () => ({ emitAwaitedEvent: vi.fn() }));
vi.mock('../../agent-tools/coordination/messages', () => ({ sendMessage: seams.send }));

describe('consult expiry production wiring', () => {
  it('registers an executable sweep with the durable requester-alert adapter bound', async () => {
    await import('./consult-expiry-action');
    const registration = seams.register.mock.calls.find(([name]) => name === 'consult-expiry-sweep');
    expect(registration).toBeDefined();
    await registration![1]();
    expect(seams.sweep).toHaveBeenCalledOnce();
    const deps = seams.sweep.mock.calls[0]![0];
    expect(deps.notifyRequester).toBeTypeOf('function');
    expect(deps.resumeCascadeDispatch).toBeTypeOf('function');
    // P-014: prod binds the review conversion leg; without it silent review
    // consults would keep cascading.
    expect(deps.fileReviewWorkItem).toBeTypeOf('function');
    seams.send.mockImplementationOnce(async () => {
      expect(currentRequestWorkspaceId()).toBe('row-workspace');
    });
    await deps.notifyRequester({
      requesterId: 'requester', conversationId: 'conv-exact', workspaceId: 'row-workspace',
      msgId: 'stable-alert-key', summary: 'stalled', body: 'Recovery pending; inspect conv-exact.',
    });
    expect(seams.send).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: 'row-workspace' }),
      expect.objectContaining({ msgId: 'stable-alert-key', to: ['requester'] }),
    );
  });
});
