import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// In-memory PG mock that models the two operator-conversation tables
// just well enough to exercise getOrCreate / appendTurn / listTurns /
// correctLastAssistantTurn end-to-end.
type Conv = {
  id: string;
  workspace_id: string;
  harness_slug: string | null;
  title: string | null;
  status: string;
  started_at: number;
  ended_at: number | null;
  el_conversation_ids: string[];
  has_audio: boolean;
};
type Turn = {
  id: string;
  conversation_id: string;
  seq: number;
  role: string;
  text: string;
  source: string;
  el_conv_id: string | null;
  audio_url: string | null;
  created_at: number;
};
const convs = new Map<string, Conv>();
const turns: Turn[] = [];
let convIdSeq = 0;
let turnIdSeq = 0;

vi.mock('./ensure-schema', () => ({ ensureOperatorConversationsTable: async () => {} }));
vi.mock('./workspace-registry', () => ({ activeWorkspaceId: () => 'test-ws' }));

vi.mock('@restart/db-org', () => {
  function tagged(strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown[]> {
    const sqlText = strings.join('?');

    if (/INSERT INTO harness_shared\.operator_conversations/.test(sqlText)) {
      const ws = values[0] as string;
      const slug = values[1] as string | null;
      const startedAt = values[2] as number;
      const id = `conv-${++convIdSeq}`;
      const row: Conv = {
        id, workspace_id: ws, harness_slug: slug,
        title: null, status: 'active', started_at: startedAt, ended_at: null,
        el_conversation_ids: [], has_audio: false,
      };
      convs.set(id, row);
      return Promise.resolve([row]);
    }
    if (/SELECT id, workspace_id, harness_slug[\s\S]*FROM harness_shared\.operator_conversations/.test(sqlText)) {
      const ws = values[0] as string;
      const slug = values[1] as string;
      const found = [...convs.values()]
        .filter((c) => c.workspace_id === ws && (c.harness_slug ?? '') === slug && c.status === 'active')
        .sort((a, b) => b.started_at - a.started_at);
      return Promise.resolve(found.slice(0, 1));
    }
    if (/SELECT COALESCE\(MAX\(seq\), -1\) \+ 1 AS s/.test(sqlText)) {
      const convId = values[0] as string;
      const max = turns.filter((t) => t.conversation_id === convId).reduce((m, t) => Math.max(m, t.seq), -1);
      return Promise.resolve([{ s: max + 1 }]);
    }
    if (/INSERT INTO harness_shared\.operator_turns/.test(sqlText)) {
      const id = `turn-${++turnIdSeq}`;
      const row: Turn = {
        id,
        conversation_id: values[0] as string,
        seq: values[1] as number,
        role: values[2] as string,
        text: values[3] as string,
        source: values[4] as string,
        el_conv_id: (values[5] as string | null) ?? null,
        audio_url: (values[6] as string | null) ?? null,
        created_at: values[7] as number,
      };
      // emulate the (conversation_id, seq) UNIQUE constraint
      if (turns.find((t) => t.conversation_id === row.conversation_id && t.seq === row.seq)) {
        return Promise.reject(Object.assign(new Error('unique violation'), { code: '23505' }));
      }
      turns.push(row);
      return Promise.resolve([row]);
    }
    if (/SELECT id, conversation_id, seq, role, text, source, el_conv_id, audio_url, created_at[\s\S]*FROM harness_shared\.operator_turns/.test(sqlText)) {
      const convId = values[0] as string;
      const out = turns
        .filter((t) => t.conversation_id === convId)
        .sort((a, b) => a.seq - b.seq);
      return Promise.resolve(out);
    }
    if (/UPDATE harness_shared\.operator_turns/.test(sqlText)) {
      const newText = values[0] as string;
      const convId = values[1] as string;
      const candidate = turns
        .filter((t) => t.conversation_id === convId && t.role === 'assistant')
        .sort((a, b) => b.seq - a.seq)[0];
      if (!candidate) return Promise.resolve([]);
      candidate.text = newText;
      return Promise.resolve([candidate]);
    }
    return Promise.resolve([]);
  }
  return { getOrgPg: () => ({ sql: tagged }) };
});

import {
  getOrCreateActiveConversation,
  appendTurn,
  listTurns,
  correctLastAssistantTurn,
} from './operator-conversations';

beforeEach(() => {
  convs.clear();
  turns.length = 0;
  convIdSeq = 0;
  turnIdSeq = 0;
});
afterEach(() => {
  convs.clear();
  turns.length = 0;
});

describe('getOrCreateActiveConversation', () => {
  it('creates a fresh active conversation when none exists', async () => {
    const c = await getOrCreateActiveConversation(null);
    expect(c.workspaceId).toBe('test-ws');
    expect(c.harnessSlug).toBeNull();
    expect(c.status).toBe('active');
    expect(c.startedAt).toBeGreaterThan(0);
  });

  it('returns the existing active conversation on second call', async () => {
    const c1 = await getOrCreateActiveConversation(null);
    const c2 = await getOrCreateActiveConversation(null);
    expect(c2.id).toBe(c1.id);
  });

  it('creates separate conversations per harness slug', async () => {
    const c1 = await getOrCreateActiveConversation('foo');
    const c2 = await getOrCreateActiveConversation('bar');
    expect(c1.id).not.toBe(c2.id);
    expect(c1.harnessSlug).toBe('foo');
    expect(c2.harnessSlug).toBe('bar');
  });
});

describe('appendTurn', () => {
  it('writes a turn with auto-incremented seq', async () => {
    const c = await getOrCreateActiveConversation(null);
    const t1 = await appendTurn({ conversationId: c.id, role: 'user', text: 'hello' });
    const t2 = await appendTurn({ conversationId: c.id, role: 'assistant', text: 'hi' });
    expect(t1.seq).toBe(0);
    expect(t2.seq).toBe(1);
  });

  it('defaults source to text_typed', async () => {
    const c = await getOrCreateActiveConversation(null);
    const t = await appendTurn({ conversationId: c.id, role: 'user', text: 'x' });
    expect(t.source).toBe('text_typed');
  });

  it('records voice source + EL conversation id', async () => {
    const c = await getOrCreateActiveConversation(null);
    const t = await appendTurn({
      conversationId: c.id,
      role: 'user',
      text: 'voice in',
      source: 'voice_stt',
      elConvId: 'conv_test_123',
    });
    expect(t.source).toBe('voice_stt');
    expect(t.elConvId).toBe('conv_test_123');
  });
});

describe('listTurns', () => {
  it('returns empty for a brand-new conversation', async () => {
    const c = await getOrCreateActiveConversation(null);
    expect(await listTurns(c.id)).toEqual([]);
  });

  it('returns turns ordered by seq', async () => {
    const c = await getOrCreateActiveConversation(null);
    await appendTurn({ conversationId: c.id, role: 'user', text: 'a' });
    await appendTurn({ conversationId: c.id, role: 'assistant', text: 'b' });
    await appendTurn({ conversationId: c.id, role: 'user', text: 'c' });
    const out = await listTurns(c.id);
    expect(out.map((t) => t.text)).toEqual(['a', 'b', 'c']);
    expect(out.map((t) => t.seq)).toEqual([0, 1, 2]);
  });
});

describe('correctLastAssistantTurn', () => {
  it('rewrites the last assistant turn (EL barge-in correction)', async () => {
    const c = await getOrCreateActiveConversation(null);
    await appendTurn({ conversationId: c.id, role: 'user', text: 'hi' });
    await appendTurn({ conversationId: c.id, role: 'assistant', text: 'wrong' });
    const updated = await correctLastAssistantTurn(c.id, 'right');
    expect(updated?.text).toBe('right');
    const all = await listTurns(c.id);
    expect(all[1].text).toBe('right');
  });

  it('returns null when no assistant turn exists', async () => {
    const c = await getOrCreateActiveConversation(null);
    expect(await correctLastAssistantTurn(c.id, 'x')).toBeNull();
  });

  it('targets the LAST assistant turn, not earlier ones', async () => {
    const c = await getOrCreateActiveConversation(null);
    await appendTurn({ conversationId: c.id, role: 'assistant', text: 'first' });
    await appendTurn({ conversationId: c.id, role: 'user', text: 'mid' });
    await appendTurn({ conversationId: c.id, role: 'assistant', text: 'second' });
    await correctLastAssistantTurn(c.id, 'second-fixed');
    const all = await listTurns(c.id);
    expect(all[0].text).toBe('first'); // unchanged
    expect(all[2].text).toBe('second-fixed');
  });
});
