import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  getClaim: vi.fn(),
  create: vi.fn(),
  setCheckpoint: vi.fn(),
}));

vi.mock('../../work-item-claims', () => ({ getActiveClaimForOwner: h.getClaim }));
vi.mock('../work_items/_create-core', () => ({ createOneWorkItem: h.create }));
vi.mock('../../work-item-checkpoint', () => ({
  setWorkItemCheckpointWithPrior: h.setCheckpoint,
}));

import {
  appendSessionTaskProgress,
  createSessionTaskLedgerBridge,
} from './runtime';
import type { SessionTask } from '../../session-tasks';

const TASK: SessionTask = {
  id: 'task-1',
  content: 'Ship the bridge',
  activeForm: 'Shipping the bridge',
  status: 'in_progress',
  blockerRef: null,
  explanation: 'Runtime is wired',
  position: 0,
  createdAt: '2026-08-26T00:00:00.000Z',
  updatedAt: '2026-08-26T00:01:00.000Z',
  links: [],
};

beforeEach(() => {
  vi.clearAllMocks();
  h.getClaim.mockResolvedValue(null);
});

describe('createSessionTaskLedgerBridge', () => {
  it('seeds new tasks from the session owner claim, not the invoking actor', async () => {
    h.getClaim.mockResolvedValue({ workItemId: 'WI-7', harnessSlug: 'papercusp' });
    const bridge = await createSessionTaskLedgerBridge({
      workspaceId: 'ws-1',
      sessionId: 'session-owner',
      actorId: 'pui:avi',
      defaultHarness: 'papercusp',
    });

    expect(h.getClaim).toHaveBeenCalledWith('ws-1', 'session-owner');
    expect(bridge.seedWorkItem).toEqual({
      workItemId: 'WI-7',
      workItemHarness: 'papercusp',
      relation: 'for',
    });
  });

  it('attributes promotion creation to the invoking actor and returns a typed for edge', async () => {
    h.create.mockResolvedValue({
      ok: true,
      workItem: { id: 'WI-8', harness: 'papercusp' },
    });
    const bridge = await createSessionTaskLedgerBridge({
      workspaceId: 'ws-1',
      sessionId: 'chat-1',
      actorId: 'pui:avi',
      defaultHarness: 'papercusp',
    });
    const link = await bridge.promoteTask!(TASK, { kind: 'change', title: 'Durable bridge work' });

    expect(h.create).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'change',
      title: 'Durable bridge work',
      harness: 'papercusp',
    }), {
      ownerId: 'pui:avi',
      workspaceId: 'ws-1',
      harnessSlug: 'papercusp',
    });
    expect(link).toEqual({
      workItemId: 'WI-8',
      workItemHarness: 'papercusp',
      relation: 'for',
    });
  });

  it('appends a bounded automatic progress section without rewriting human checkpoint text', async () => {
    const oldEntries = Array.from({ length: 24 }, (_, index) => (
      `- 2026-08-26T00:00:${String(index).padStart(2, '0')}.000Z task:old-${index} edit → pending: old`
    )).join('\n');
    const prior = `Human-authored checkpoint\n\n## Session task progress (automatic)\n${oldEntries}`;
    h.setCheckpoint.mockImplementation(async (_ref, _note, options) => ({
      stored: options.transform(prior, null),
      priorLength: prior.length,
    }));
    const bridge = await createSessionTaskLedgerBridge({
      workspaceId: 'ws-1',
      sessionId: 'chat-1',
      actorId: 'pui:avi',
      defaultHarness: 'papercusp',
    });
    await bridge.syncProgress!(
      { workItemId: 'WI-8', workItemHarness: 'papercusp', relation: 'for' },
      TASK,
      'start',
    );

    const options = h.setCheckpoint.mock.calls[0]![2];
    const stored = options.transform(prior, null) as string;
    expect(stored).toContain('Human-authored checkpoint');
    expect(stored).toContain('task:task-1 start → in_progress: Ship the bridge');
    expect(stored.split('\n').filter((line: string) => line.startsWith('- '))).toHaveLength(20);
    expect(h.setCheckpoint.mock.calls[0]![0]).toEqual({
      workspaceId: 'ws-1',
      harness: 'papercusp',
      workItemId: 'WI-8',
    });
  });
});

describe('appendSessionTaskProgress', () => {
  it('starts the owned section on an empty checkpoint', () => {
    expect(appendSessionTaskProgress(null, TASK, 'done')).toContain(
      '## Session task progress (automatic)\n- 2026-08-26T00:01:00.000Z task:task-1 done → in_progress',
    );
  });
});
