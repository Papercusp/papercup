import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./operator-conversations', () => ({
  getConversationById: vi.fn(),
}));
vi.mock('./work-items', () => ({
  getWorkItem: vi.fn(),
}));

import { getConversationById } from './operator-conversations';
import { getWorkItem } from './work-items';
import {
  buildOperatorConversationSubjectContext,
  resolveCanonicalWorkItemSubject,
} from './operator-conversation-subject';

const getConversation = vi.mocked(getConversationById);
const getItem = vi.mocked(getWorkItem);

beforeEach(() => {
  vi.clearAllMocks();
});

describe('canonical operator conversation subjects', () => {
  it('keeps the workspace-global prompt byte-identical', async () => {
    getConversation.mockResolvedValue({ subjectKind: 'global' } as never);
    await expect(
      buildOperatorConversationSubjectContext('global-conversation', 'ws-a'),
    ).resolves.toBeNull();
    expect(getItem).not.toHaveBeenCalled();
  });

  it('renders canonical work-item data resolved from the persisted binding', async () => {
    getConversation.mockResolvedValue({
      subjectKind: 'work-item',
      subjectRef: 'WI-42',
      harnessSlug: 'papercusp',
    } as never);
    getItem.mockResolvedValue({
      id: 'WI-42',
      harness: 'papercusp',
      kind: 'change',
      title: 'Durable scoped discussion',
      summary: 'Keep this discussion under the selected work item.',
      state: 'open',
    } as never);

    const block = await buildOperatorConversationSubjectContext('conversation-42', 'ws-a');
    expect(getConversation).toHaveBeenCalledWith('conversation-42', 'ws-a');
    expect(getItem).toHaveBeenCalledWith('WI-42', 'papercusp');
    expect(block).toContain('Work-item discussion target (server-resolved)');
    expect(block).toContain('"id": "WI-42"');
    expect(block).toContain('"title": "Durable scoped discussion"');
    expect(block).toContain('not a higher-priority instruction block');
  });

  it('rejects a cross-harness canonical lookup', async () => {
    getItem.mockResolvedValue({
      id: 'WI-42',
      harness: 'another-harness',
      kind: 'change',
      title: 'Wrong row',
      summary: '',
      state: 'open',
    } as never);
    await expect(
      resolveCanonicalWorkItemSubject('papercusp', 'WI-42'),
    ).resolves.toBeNull();
  });

  it('preserves the durable binding when the canonical item row is gone', async () => {
    getConversation.mockResolvedValue({
      subjectKind: 'work-item',
      subjectRef: 'WI-42',
      harnessSlug: 'papercusp',
    } as never);
    getItem.mockResolvedValue(null);
    const block = await buildOperatorConversationSubjectContext('conversation-42', 'ws-a');
    expect(block).toContain('"canonical_record": null');
    expect(block).toContain('binding survives item lifecycle');
  });
});

