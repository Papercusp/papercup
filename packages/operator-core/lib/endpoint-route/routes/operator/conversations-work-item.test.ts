import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@papercusp/db-org', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@papercusp/db-org')>();
  return { ...actual, getOrgPg: vi.fn() };
});
vi.mock('../../../operator-conversations', () => ({
  getOrCreateActiveConversation: vi.fn(),
  getOrCreateWorkItemConversation: vi.fn(),
  getWorkItemConversation: vi.fn(),
  listTurns: vi.fn(),
  listTurnsRecent: vi.fn(),
}));
vi.mock('../../../operator-conversation-subject', () => ({
  resolveCanonicalWorkItemSubject: vi.fn(),
}));
vi.mock('../../../workspace-registry', () => ({
  activeWorkspaceId: () => 'ws-a',
}));
vi.mock('../../../sync-sse', () => ({
  notifySyncInvalidate: vi.fn(async () => {}),
}));

import routes from './conversations';
import {
  getOrCreateWorkItemConversation,
  getWorkItemConversation,
} from '../../../operator-conversations';
import { resolveCanonicalWorkItemSubject } from '../../../operator-conversation-subject';
import { notifySyncInvalidate } from '../../../sync-sse';

type RouteTool = {
  handler: (req: Request, ctx: { params: Record<string, string> }) => Promise<Response>;
};
const [, , getWorkItemRoute, postWorkItemRoute] = routes as unknown as RouteTool[];
const getConversation = vi.mocked(getWorkItemConversation);
const createConversation = vi.mocked(getOrCreateWorkItemConversation);
const resolveSubject = vi.mocked(resolveCanonicalWorkItemSubject);
const invalidate = vi.mocked(notifySyncInvalidate);

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GET/POST /operator/conversations/work-items/:workItemId', () => {
  it('GET requires an explicit harness and performs a side-effect-free lookup', async () => {
    const missing = await getWorkItemRoute.handler(
      new Request('http://localhost/api/operator/conversations/work-items/WI-42'),
      { params: { workItemId: 'WI-42' } },
    );
    expect(missing.status).toBe(400);

    getConversation.mockResolvedValue({ id: 'conversation-42' } as never);
    const found = await getWorkItemRoute.handler(
      new Request(
        'http://localhost/api/operator/conversations/work-items/WI-42?harness=papercusp',
      ),
      { params: { workItemId: 'WI-42' } },
    );
    expect(found.status).toBe(200);
    expect(getConversation).toHaveBeenCalledWith({
      harnessSlug: 'papercusp',
      workItemId: 'WI-42',
    });
    expect(createConversation).not.toHaveBeenCalled();
  });

  it('POST validates the canonical harness-scoped item before creating', async () => {
    resolveSubject.mockResolvedValue(null);
    const response = await postWorkItemRoute.handler(
      new Request('http://localhost/api/operator/conversations/work-items/WI-42', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ harness: 'papercusp' }),
      }),
      { params: { workItemId: 'WI-42' } },
    );
    expect(response.status).toBe(404);
    expect(createConversation).not.toHaveBeenCalled();
  });

  it('POST is an idempotent get-or-create mutation and invalidates the focused key', async () => {
    resolveSubject.mockResolvedValue({
      id: 'WI-42',
      harness: 'papercusp',
      kind: 'change',
      title: 'Scoped chat',
      summary: '',
      state: 'open',
    });
    createConversation.mockResolvedValue({ id: 'conversation-42' } as never);
    const response = await postWorkItemRoute.handler(
      new Request('http://localhost/api/operator/conversations/work-items/WI-42', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ harness: 'papercusp' }),
      }),
      { params: { workItemId: 'WI-42' } },
    );
    expect(response.status).toBe(200);
    expect(createConversation).toHaveBeenCalledWith({
      harnessSlug: 'papercusp',
      workItemId: 'WI-42',
    });
    expect(invalidate).toHaveBeenCalledWith('operatorConversations.byWorkItem', {
      workspaceId: 'ws-a',
      harness: 'papercusp',
      workItemId: 'WI-42',
    });
  });
});
