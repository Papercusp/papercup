/**
 * conversations-list.test.ts — the conversations:list HANDLER projection + filter
 * mapping (listConversationsWithTopics is mocked). Pins the per-row shaping: the
 * title-fallback (title ?? body.slice(0,100)), the computed resolved flag
 * (state === 'resolved'), and the scope derivation that turns a harness arg into
 * { scope:'harness', harness_slug } (and omits scope otherwise). A regression in the
 * title fallback or filter mapping is what this catches.
 *
 * In-tree (operator-core, tab-visible).
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/coordination/tools/conversations-list.test.ts
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../conversations', () => ({ listConversationsWithTopics: vi.fn() }));

import { listConversationsWithTopics } from '../conversations';
const listM = vi.mocked(listConversationsWithTopics);
const tool = (await import('./conversations-list')).default;

type Out = { content: { text: string }[] };
const call = (args: Record<string, unknown> = {}) => tool.handler(args as never, {} as never) as Promise<Out>;
const body = (o: Out) => JSON.parse(o.content[0]!.text);

beforeEach(() => {
  vi.clearAllMocks();
  listM.mockResolvedValue([] as never);
});

describe('conversations:list handler', () => {
  it('projects rows: title falls back to the body slice, resolved flag is computed', async () => {
    const longBody = 'x'.repeat(150);
    listM.mockResolvedValue([
      { id: 'c1', kind: 'question', state: 'open', scope: 'global', harness_slug: null, title: null, body: longBody, asker_id: 'a', topics: ['t'], promoted_issue_id: null, created_ts: 't0' },
      { id: 'c2', kind: 'discussion', state: 'resolved', scope: 'global', harness_slug: null, title: 'Has Title', body: 'b', asker_id: 'a', topics: [], promoted_issue_id: null, created_ts: 't1' },
    ] as never);
    const b = body(await call());
    expect(b.count).toBe(2);
    expect(b.conversations[0].title).toBe('x'.repeat(100)); // fallback = first 100 of body
    expect(b.conversations[0].resolved).toBe(false);
    expect(b.conversations[1].title).toBe('Has Title');
    expect(b.conversations[1].resolved).toBe(true);
  });

  it('derives scope=harness from a harness filter', async () => {
    await call({ harness: 'web', kind: 'question' });
    expect(listM.mock.calls[0]![0]).toMatchObject({ scope: 'harness', harness_slug: 'web', kind: 'question' });
  });

  it('omits scope when no harness filter is given', async () => {
    await call({ topic: 'arch' });
    expect(listM.mock.calls[0]![0]).toMatchObject({ scope: undefined, topic: 'arch' });
  });

  // WI-1571 read side: a workspace-scoped caller must browse ITS OWN partition
  // (the one its writes land in), not 'default'. Live evidence 2026-07-07: 23
  // papercusp-workspace conversations were invisible to this tool.
  it('threads the caller identity into the read so reader and writer resolve the same partition', async () => {
    await tool.handler(
      { kind: 'question' } as never,
      { isSuperuser: true, uiClientId: 'client-1', workspaceId: 'ws-x' } as never,
    );
    expect(listM.mock.calls[0]![1]).toMatchObject({ workspaceId: 'ws-x' });
  });

  it('an unattributable context reads identity-less (fail-open — request-ALS chain unchanged)', async () => {
    await call({ kind: 'question' });
    expect(listM.mock.calls[0]![1]).toBeUndefined();
  });
});
