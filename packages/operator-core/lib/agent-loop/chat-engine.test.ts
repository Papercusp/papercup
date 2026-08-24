/**
 * chat-engine unit tests — P-008 (own-tui-full-divorce-2026-08-24).
 * Scripted fake ModelPort + in-memory ApprovalPort; no PG, no network.
 * Pins the wire contract of the loop-engine chat lane: event vocabulary
 * forwarded verbatim, transcript→message mapping, totals returned for
 * persistence, wire clamping of large tool payloads, error degradation.
 */
import { describe, expect, it } from 'vitest';
import type { ModelPort, ModelStreamEvent } from './model-port';
import type { ApprovalPort, LoopTool } from './loop';
import {
  clampForWire,
  DEFAULT_LOOP_CHAT_MODEL,
  runLoopChatTurn,
  transcriptToMessages,
  WIRE_RESULT_MAX_CHARS,
  type LoopChatSink,
} from './chat-engine';
import type { TranscriptTurn } from '../agent-chats-data';
import type {
  LoopSessionRow,
  LoopSessionStore,
  SaveLoopSessionTurnArgs,
} from './session-store';

function scriptedPort(scripts: ModelStreamEvent[][]) {
  const requests: Parameters<ModelPort['stream']>[0][] = [];
  let call = 0;
  const port: ModelPort = {
    async *stream(req) {
      requests.push(req);
      const script = scripts[call++];
      if (!script) throw new Error(`scriptedPort: unscripted call #${call}`);
      for (const ev of script) yield ev;
    },
  };
  return { port, requests };
}

function recordingSink() {
  const events: Array<{ name: string; data: unknown }> = [];
  const sink: LoopChatSink = { event: (name, data) => events.push({ name, data }) };
  return { sink, events };
}

const turn = (role: TranscriptTurn['role'], content: string, extra: Partial<TranscriptTurn> = {}): TranscriptTurn => ({
  role,
  content,
  ts: new Date().toISOString(),
  ...extra,
});

const textStop = (text: string, usage?: { inputTokens: number; outputTokens: number }): ModelStreamEvent[] => [
  { type: 'text_delta', text },
  { type: 'stop', reason: 'end_turn', ...(usage ? { usage } : {}) },
];

describe('transcriptToMessages', () => {
  it('maps user/assistant text turns and skips error markers + empties', () => {
    const messages = transcriptToMessages([
      turn('user', 'first question'),
      turn('assistant', 'first answer'),
      turn('assistant', 'rate limited', { error: true } as Partial<TranscriptTurn>),
      turn('user', '   '),
      turn('user', 'second question'),
    ]);
    expect(messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'first question' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'first answer' }] },
      { role: 'user', content: [{ type: 'text', text: 'second question' }] },
    ]);
  });
});

describe('clampForWire', () => {
  it('passes small values through untouched', () => {
    expect(clampForWire({ a: 1 })).toEqual({ a: 1 });
  });
  it('replaces oversized values with a truncated preview', () => {
    const big = 'x'.repeat(WIRE_RESULT_MAX_CHARS + 100);
    const clamped = clampForWire(big) as { truncated: boolean; fullChars: number; preview: string };
    expect(clamped.truncated).toBe(true);
    expect(clamped.fullChars).toBeGreaterThan(WIRE_RESULT_MAX_CHARS);
    expect(clamped.preview.length).toBe(WIRE_RESULT_MAX_CHARS);
  });
});

describe('runLoopChatTurn', () => {
  it('streams a text turn: native wire events + totals for persistence', async () => {
    const { port, requests } = scriptedPort([
      textStop('hello from the loop', { inputTokens: 11, outputTokens: 4 }),
    ]);
    const { sink, events } = recordingSink();
    const result = await runLoopChatTurn({
      chatId: 'c1',
      workspaceId: 'ws',
      system: 'You are the pane engine.',
      transcript: [turn('user', 'hi')],
      sink,
      port,
      model: 'm-test',
    });

    expect(result.errorMessage).toBeNull();
    expect(result.stopReason).toBe('complete');
    expect(result.finalText).toBe('hello from the loop');
    expect(result.tokensIn).toBe(11);
    expect(result.tokensOut).toBe(4);
    expect(result.stepCount).toBe(1);

    expect(events.map((e) => e.name)).toEqual(['step_start', 'text_delta', 'step_end', 'done']);
    const done = events.at(-1)!.data as { finalText: string; usage: { inputTokens: number }; stepCount: number };
    expect(done.finalText).toBe('hello from the loop');
    expect(done.usage.inputTokens).toBe(11);
    expect(done.stepCount).toBe(1);
    // The wire done must NOT carry the full messages snapshot.
    expect((done as Record<string, unknown>).messages).toBeUndefined();

    // The port saw the system prompt + mapped transcript.
    expect(requests[0].system).toBe('You are the pane engine.');
    expect(requests[0].messages).toEqual([{ role: 'user', content: [{ type: 'text', text: 'hi' }] }]);
    expect(requests[0].model).toBe('m-test');
  });

  it('runs a gated tool through the ApprovalPort and forwards the round-trip', async () => {
    const { port } = scriptedPort([
      [
        { type: 'tool_call', id: 't1', name: 'gated', input: { x: 1 } },
        { type: 'stop', reason: 'tool_use', usage: { inputTokens: 5, outputTokens: 2 } },
      ],
      textStop('done after tool', { inputTokens: 6, outputTokens: 3 }),
    ]);
    const approvalsSeen: string[] = [];
    const approvals: ApprovalPort = {
      async requestApproval(req) {
        approvalsSeen.push(req.call.id);
        return { approved: true };
      },
    };
    const gated: LoopTool = {
      name: 'gated',
      inputSchema: { type: 'object' },
      needsApproval: true,
      execute: async () => ({ ok: true }),
    };
    const { sink, events } = recordingSink();
    const result = await runLoopChatTurn({
      chatId: 'c2',
      workspaceId: 'ws',
      system: 's',
      transcript: [turn('user', 'run the tool')],
      sink,
      port,
      approvals,
      tools: [gated],
    });

    expect(result.errorMessage).toBeNull();
    expect(approvalsSeen).toEqual(['t1']);
    const names = events.map((e) => e.name);
    expect(names).toContain('tool_call');
    expect(names).toContain('approval_resolved');
    expect(names).toContain('tool_result');
    const toolCall = events.find((e) => e.name === 'tool_call')!.data as { call: { id: string }; needsApproval: boolean };
    expect(toolCall.needsApproval).toBe(true);
    expect(toolCall.call.id).toBe('t1');
    const resolved = events.find((e) => e.name === 'approval_resolved')!.data as { approved: boolean };
    expect(resolved.approved).toBe(true);
    expect(result.tokensIn).toBe(11); // 5 + 6 across both steps
  });

  it('denied approval surfaces a denied tool_result and the loop continues', async () => {
    const { port } = scriptedPort([
      [
        { type: 'tool_call', id: 't1', name: 'gated', input: {} },
        { type: 'stop', reason: 'tool_use' },
      ],
      textStop('acknowledged the deny'),
    ]);
    const approvals: ApprovalPort = {
      async requestApproval() {
        return { approved: false, reason: 'not on my watch' };
      },
    };
    const gated: LoopTool = {
      name: 'gated',
      inputSchema: { type: 'object' },
      needsApproval: true,
      execute: async () => ({ ok: true }),
    };
    const { sink, events } = recordingSink();
    const result = await runLoopChatTurn({
      chatId: 'c3',
      workspaceId: 'ws',
      system: 's',
      transcript: [turn('user', 'try it')],
      sink,
      port,
      approvals,
      tools: [gated],
    });
    expect(result.errorMessage).toBeNull();
    expect(result.finalText).toBe('acknowledged the deny');
    const toolResult = events.find((e) => e.name === 'tool_result')!.data as { denied?: boolean; error?: string };
    expect(toolResult.denied).toBe(true);
    expect(toolResult.error).toContain('not on my watch');
  });

  it('clamps oversized tool results on the wire only', async () => {
    const bigPayload = { blob: 'y'.repeat(WIRE_RESULT_MAX_CHARS * 2) };
    const { port } = scriptedPort([
      [
        { type: 'tool_call', id: 't1', name: 'bigtool', input: {} },
        { type: 'stop', reason: 'tool_use' },
      ],
      textStop('summarized'),
    ]);
    const bigtool: LoopTool = {
      name: 'bigtool',
      inputSchema: { type: 'object' },
      execute: async () => bigPayload,
    };
    const { sink, events } = recordingSink();
    await runLoopChatTurn({
      chatId: 'c4',
      workspaceId: 'ws',
      system: 's',
      transcript: [turn('user', 'fetch')],
      sink,
      port,
      tools: [bigtool],
    });
    const toolResult = events.find((e) => e.name === 'tool_result')!.data as {
      result: { truncated?: boolean; fullChars?: number };
    };
    expect(toolResult.result.truncated).toBe(true);
    expect(toolResult.result.fullChars).toBeGreaterThan(WIRE_RESULT_MAX_CHARS);
  });

  it('a stream error degrades to the error event + errorMessage, never a throw', async () => {
    const { port } = scriptedPort([[{ type: 'error', message: 'gateway exploded' }]]);
    const { sink, events } = recordingSink();
    const result = await runLoopChatTurn({
      chatId: 'c5',
      workspaceId: 'ws',
      system: 's',
      transcript: [turn('user', 'hi')],
      sink,
      port,
    });
    expect(result.errorMessage).toBe('gateway exploded');
    expect(events.some((e) => e.name === 'error')).toBe(true);
    // The loop still reports done('error') after an in-stream error.
    expect(result.stopReason).toBe('error');
  });
});

// ── P-009: session resume + persistence ────────────────────────────────────

function fakeSessions(row: LoopSessionRow | null) {
  const saves: SaveLoopSessionTurnArgs[] = [];
  const store: LoopSessionStore = {
    load: async () => row,
    saveTurn: async (a) => {
      saves.push(a);
    },
  };
  return { store, saves };
}

function mkRow(over: Partial<LoopSessionRow> = {}): LoopSessionRow {
  return {
    workspaceId: 'ws',
    chatId: 'c9',
    messages: [],
    summary: null,
    compactedCount: 0,
    transcriptTurns: 0,
    model: null,
    turnCount: 0,
    totals: {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      costUsd: 0,
      unpricedTurns: 0,
    },
    ...over,
  };
}

describe('P-009 session resume + persist', () => {
  const storedMessages = [
    { role: 'user' as const, content: [{ type: 'text' as const, text: 'q1' }] },
    {
      role: 'assistant' as const,
      content: [{ type: 'tool_call' as const, id: 'c1', name: 'do_thing', input: { x: 1 } }],
    },
    {
      role: 'user' as const,
      content: [{ type: 'tool_result' as const, toolCallId: 'c1', content: 'ok' }],
    },
    { role: 'assistant' as const, content: [{ type: 'text' as const, text: 'a1' }] },
  ];
  // Transcript the TEXT projection of those turns produced: 2 text turns,
  // then the freshly-appended user turn.
  const transcript = [turn('user', 'q1'), turn('assistant', 'a1'), turn('user', 'q2')];

  it('resumes from the stored working set (tool detail replayed) + summary in system', async () => {
    const { store, saves } = fakeSessions(
      mkRow({ messages: storedMessages, summary: 'earlier stuff', compactedCount: 3, transcriptTurns: 2 }),
    );
    const { port, requests } = scriptedPort([
      textStop('a2', { inputTokens: 10, outputTokens: 5 }),
    ]);
    const { sink } = recordingSink();
    const result = await runLoopChatTurn({
      chatId: 'c9',
      workspaceId: 'ws',
      system: 'SYS',
      transcript,
      sink,
      port,
      sessions: store,
    });
    expect(result.errorMessage).toBeNull();
    // The model saw the FULL stored history — tool parts included — plus the
    // fresh user turn (not the lossy text rebuild).
    expect(requests[0].messages).toEqual([
      ...storedMessages,
      { role: 'user', content: [{ type: 'text', text: 'q2' }] },
    ]);
    expect(requests[0].system).toContain('SYS');
    expect(requests[0].system).toContain('## Earlier conversation (compacted summary)');
    expect(requests[0].system).toContain('earlier stuff');
    // Persisted: done snapshot, anchored one turn past the incoming transcript.
    expect(saves.length).toBe(1);
    const save = saves[0];
    expect(save.transcriptTurns).toBe(transcript.length + 1);
    expect(save.model).toBe(DEFAULT_LOOP_CHAT_MODEL);
    expect(save.summary).toBe('earlier stuff');
    expect(save.compactedCount).toBe(3);
    expect(save.usage).toEqual({ inputTokens: 10, outputTokens: 5 });
    expect(save.priced).toBe(false); // no costUsd on usage ⇒ unpriced turn
    expect(save.messages).toEqual([
      ...storedMessages,
      { role: 'user', content: [{ type: 'text', text: 'q2' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'a2' }] },
    ]);
  });

  it('falls back to the text rebuild when the anchor mismatches', async () => {
    const { store, saves } = fakeSessions(
      mkRow({ messages: storedMessages, transcriptTurns: 7 }), // stale anchor
    );
    const { port, requests } = scriptedPort([textStop('a2')]);
    const { sink } = recordingSink();
    await runLoopChatTurn({
      chatId: 'c9',
      workspaceId: 'ws',
      system: 'SYS',
      transcript,
      sink,
      port,
      sessions: store,
    });
    expect(requests[0].messages).toEqual(transcriptToMessages(transcript));
    expect(requests[0].system).toBe('SYS'); // no summary section
    // The save re-anchors the session for the next turn.
    expect(saves.length).toBe(1);
    expect(saves[0].transcriptTurns).toBe(transcript.length + 1);
  });

  it('marks the turn priced when usage carries costUsd', async () => {
    const { store, saves } = fakeSessions(null);
    const { port } = scriptedPort([
      [
        { type: 'text_delta', text: 'hi' },
        {
          type: 'stop',
          reason: 'end_turn',
          usage: { inputTokens: 100, outputTokens: 50, costUsd: 0.00105 },
        },
      ],
    ]);
    const { sink } = recordingSink();
    const result = await runLoopChatTurn({
      chatId: 'c9',
      workspaceId: 'ws',
      system: 'SYS',
      transcript: [turn('user', 'q1')],
      sink,
      port,
      sessions: store,
    });
    expect(result.costUsd).toBeCloseTo(0.00105, 8);
    expect(saves[0].priced).toBe(true);
    expect(saves[0].usage.costUsd).toBeCloseTo(0.00105, 8);
  });

  it('persists the session even when the stream errors (user turn is real)', async () => {
    const { store, saves } = fakeSessions(null);
    const { port } = scriptedPort([[{ type: 'error', message: 'boom' }]]);
    const { sink } = recordingSink();
    const result = await runLoopChatTurn({
      chatId: 'c9',
      workspaceId: 'ws',
      system: 'SYS',
      transcript: [turn('user', 'q1')],
      sink,
      port,
      sessions: store,
    });
    expect(result.errorMessage).toBe('boom');
    expect(saves.length).toBe(1);
    expect(saves[0].messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'q1' }] },
    ]);
  });

  it('a saveTurn failure never fails the completed turn', async () => {
    const store: LoopSessionStore = {
      load: async () => null,
      saveTurn: async () => {
        throw new Error('pg down');
      },
    };
    const { port } = scriptedPort([textStop('fine')]);
    const { sink } = recordingSink();
    const result = await runLoopChatTurn({
      chatId: 'c9',
      workspaceId: 'ws',
      system: 'SYS',
      transcript: [turn('user', 'q1')],
      sink,
      port,
      sessions: store,
    });
    expect(result.errorMessage).toBeNull();
    expect(result.finalText).toBe('fine');
  });
});
