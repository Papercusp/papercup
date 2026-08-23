import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  unsafe: vi.fn(),
}));

vi.mock('@papercusp/db-org', async (orig) => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return {
    ...(await orig<typeof import('@papercusp/db-org')>()),
    ...actual,
    getOrgPg: () => ({ sql: { unsafe: h.unsafe }, db: {} }),
  };
});

vi.mock('./workspace-registry', () => ({
  activeWorkspaceId: () => 'ws-default',
  resolveConcreteWorkspaceId: (value?: string) =>
    value && value.trim() && value !== '*' ? value.trim() : 'ws-default',
}));

import {
  getConversationById,
  getOrCreateWorkItemConversation,
  getWorkItemConversation,
} from './operator-conversations';

function row(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'conversation-1',
    workspace_id: 'ws-a',
    harness_slug: 'papercusp',
    subject_kind: 'work-item',
    subject_ref: 'WI-42',
    title: null,
    status: 'scoped',
    started_at: 123,
    ended_at: null,
    el_conversation_ids: [],
    has_audio: false,
    ...overrides,
  };
}

beforeEach(() => {
  h.unsafe.mockReset();
});

describe('work-item conversation identity helpers', () => {
  it('rejects incomplete keys before touching Postgres', async () => {
    await expect(
      getWorkItemConversation({ workspaceId: 'ws-a', harnessSlug: '', workItemId: 'WI-42' }),
    ).rejects.toThrow(/harnessSlug is required/);
    await expect(
      getOrCreateWorkItemConversation({
        workspaceId: 'ws-a',
        harnessSlug: 'papercusp',
        workItemId: '  ',
      }),
    ).rejects.toThrow(/workItemId is required/);
    expect(h.unsafe).not.toHaveBeenCalled();
  });

  it('reads by the full workspace+harness+work-item subject key', async () => {
    h.unsafe.mockResolvedValueOnce([row()]);
    const found = await getWorkItemConversation({
      workspaceId: 'ws-a',
      harnessSlug: ' papercusp ',
      workItemId: ' WI-42 ',
    });
    expect(found).toMatchObject({
      id: 'conversation-1',
      workspaceId: 'ws-a',
      harnessSlug: 'papercusp',
      subjectKind: 'work-item',
      subjectRef: 'WI-42',
      status: 'scoped',
    });
    const [query, params] = h.unsafe.mock.calls[0];
    expect(String(query)).toContain("subject_kind = 'work-item'");
    expect(params).toEqual(['ws-a', 'papercusp', 'WI-42']);
  });

  it('uses the partial unique key for idempotent creation', async () => {
    h.unsafe.mockResolvedValueOnce([row()]);
    const created = await getOrCreateWorkItemConversation({
      workspaceId: 'ws-a',
      harnessSlug: 'papercusp',
      workItemId: 'WI-42',
    });
    expect(created.id).toBe('conversation-1');
    const [query, params] = h.unsafe.mock.calls[0];
    expect(String(query)).toContain('ON CONFLICT (workspace_id, harness_slug, subject_ref)');
    expect(String(query)).toContain("WHERE subject_kind = 'work-item'");
    expect(params.slice(0, 3)).toEqual(['ws-a', 'papercusp', 'WI-42']);
  });

  it('reads the concurrent winner when INSERT DO NOTHING loses', async () => {
    h.unsafe.mockResolvedValueOnce([]).mockResolvedValueOnce([row()]);
    const conversation = await getOrCreateWorkItemConversation({
      workspaceId: 'ws-a',
      harnessSlug: 'papercusp',
      workItemId: 'WI-42',
    });
    expect(conversation.id).toBe('conversation-1');
    expect(h.unsafe).toHaveBeenCalledTimes(2);
  });

  it('fails closed when an explicit id belongs to another workspace', async () => {
    h.unsafe.mockResolvedValueOnce([]);
    await expect(getConversationById('conversation-1', 'ws-b')).resolves.toBeNull();
    expect(h.unsafe.mock.calls[0][1]).toEqual(['conversation-1', 'ws-b']);
  });
});

