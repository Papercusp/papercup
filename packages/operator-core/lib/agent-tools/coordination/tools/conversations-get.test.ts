/**
 * conversations-get.test.ts — the conversations:get HANDLER projection, bulk
 * keyed-array contract (bulk-endpoint-standardization-2026-06-21; getConversation
 * mocked). Pins the not_found → per-item { ok:false } mapping, the deliberate
 * field-subset projection (the conversation's chosen fields are surfaced, each post
 * is projected to exactly {id, author_id, body, created_ts} — extra store columns
 * are dropped, not leaked), and that a missing id in an ids:[…] batch fails only
 * that item. A regression that leaks/loses a field, drops the not_found guard, or
 * lets one miss poison the batch is what this catches.
 *
 * In-tree (operator-core, tab-visible).
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/coordination/tools/conversations-get.test.ts
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../conversations', () => ({ getConversation: vi.fn(), getConsultStates: vi.fn() }));

import { getConversation, getConsultStates } from '../conversations';
const getM = vi.mocked(getConversation);
const consultM = vi.mocked(getConsultStates);
const tool = (await import('./conversations-get')).default;

type Out = { data: any };
const body = async (args: unknown) => (((await tool.handler(args as never, {} as never)) as Out).data);

const detail = (id: string) => ({
  conversation: {
    id, kind: 'question', state: 'resolved', scope: 'global', harness_slug: null,
    title: 'How?', body: 'the seed', asker_id: 'a1', accepted_answer: 'do X',
    accepted_post_id: 9, capture_target: 'mem0', promoted_issue_id: null,
    created_ts: 't0', resolved_ts: 't1',
  },
  topics: ['arch'],
  subscriber_count: 2,
  posts: [{ id: 1, author_id: 'b1', body: 'reply', created_ts: 't2', secret: 'DROP_ME' }],
});

beforeEach(() => {
  vi.clearAllMocks();
  // Default: no consult rows — the ordinary (non-consult) conversation path.
  // No `as never`: getConsultStates' real return type is
  // Promise<Map<string, ConsultLifecycleState>>, which an empty Map satisfies
  // outright, so the fixture stays genuinely typechecked against the signature.
  consultM.mockResolvedValue(new Map());
});

describe('conversations:get handler (bulk keyed-array)', () => {
  it('maps a missing conversation to a per-item { ok:false, reason→error:not_found }', async () => {
    getM.mockResolvedValue(null as never);
    const b = await body({ id: 'c1' });
    expect(b).toMatchObject({ ok: true, counts: { ok: 0, failed: 1 } });
    expect(b.results[0]).toMatchObject({ ok: false, id: 'c1', error: 'not_found' });
  });

  it('projects the conversation fields, topics, count, and trims post fields', async () => {
    getM.mockResolvedValue(detail('c1') as never);
    const b = await body({ id: 'c1' });
    expect(b).toMatchObject({ ok: true, counts: { ok: 1, failed: 0 } });
    const r = b.results[0];
    expect(r).toMatchObject({
      ok: true,
      id: 'c1',
      conversation: { id: 'c1', kind: 'question', state: 'resolved', accepted_post_id: 9, capture_target: 'mem0' },
      topics: ['arch'],
      subscriber_count: 2,
    });
    expect(r.posts).toEqual([{ id: 1, author_id: 'b1', body: 'reply', created_ts: 't2' }]);
    expect(r.posts[0]).not.toHaveProperty('secret'); // extra store columns are not leaked
  });

  it('ids:[…]: one found + one missing — the miss fails only its item', async () => {
    getM.mockImplementation(async (id: string) => (id === 'c404' ? null : detail(id)) as never);
    const b = await body({ ids: ['c1', 'c404'] });
    expect(b).toMatchObject({ ok: true, counts: { ok: 1, failed: 1 } });
    expect(b.results[0]).toMatchObject({ ok: true, id: 'c1' });
    expect(b.results[1]).toMatchObject({ ok: false, id: 'c404', error: 'not_found' });
  });

  // WI-1571 read side: a workspace-scoped caller must read ITS OWN partition
  // (the one its writes land in) — an identity-less read resolved 'default' and
  // returned not_found for the caller's own conversations (live 2026-07-07).
  it('threads the caller identity into the read so reader and writer resolve the same partition', async () => {
    getM.mockResolvedValue(null as never);
    await tool.handler(
      { id: 'c1' } as never,
      { isSuperuser: true, uiClientId: 'client-1', workspaceId: 'ws-x' } as never,
    );
    expect(getM).toHaveBeenCalledWith('c1', expect.objectContaining({ workspaceId: 'ws-x' }));
  });

  it('an unattributable context reads identity-less (fail-open — request-ALS chain unchanged)', async () => {
    getM.mockResolvedValue(null as never);
    await body({ id: 'c1' });
    expect(getM).toHaveBeenCalledWith('c1', undefined);
  });

  // EI-21510601647367544 — the divergence that makes this necessary.
  describe('consult lifecycle state', () => {
    const consultRow = (id: string) => ({
      conversation_id: id,
      state: 'expired',
      latency_contract: 'proceed',
      responder_id: 'su-884f6b9f',
      expires_at: '2026-08-26T07:44:56.262Z',
      closed_at: '2026-08-26T07:48:28.261Z',
      wakes_used: 1,
    });

    it('surfaces `consult` for a consult conversation whose CONVERSATION row still reads open', async () => {
      // The real observed shape: conversation.state 'open' while the consult
      // itself expired and closed 49 minutes earlier. Reading only the
      // conversation cannot tell that apart from a live consult, which is
      // exactly the wrong inference this field exists to prevent.
      getM.mockResolvedValue({
        ...detail('c-consult'),
        conversation: { ...detail('c-consult').conversation, kind: 'consult', state: 'open' },
      } as never);
      consultM.mockResolvedValue(new Map([['c-consult', consultRow('c-consult')]]));

      const r = (await body({ id: 'c-consult' })).results[0];
      expect(r.conversation.state).toBe('open'); // unchanged — still the conversation's own state
      expect(r.consult).toEqual({
        state: 'expired',
        latency_contract: 'proceed',
        responder_id: 'su-884f6b9f',
        expires_at: '2026-08-26T07:44:56.262Z',
        closed_at: '2026-08-26T07:48:28.261Z',
        wakes_used: 1,
      });
    });

    it('omits `consult` entirely for a non-consult conversation (no consumer shape changes)', async () => {
      getM.mockResolvedValue(detail('c1') as never);
      const r = (await body({ id: 'c1' })).results[0];
      expect(r).not.toHaveProperty('consult');
    });

    it('batches the lifecycle read ONCE for the whole ids:[…] set, not per id', async () => {
      // Guards the N+1 this was deliberately written to avoid: conversations:get
      // accepts up to 100 ids.
      getM.mockImplementation(async (id: string) => detail(id) as never);
      await body({ ids: ['c1', 'c2', 'c3'] });
      expect(consultM).toHaveBeenCalledTimes(1);
      expect(consultM).toHaveBeenCalledWith(['c1', 'c2', 'c3'], undefined);
    });
  });
});
