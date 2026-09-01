/**
 * agent_chats:chat — single-turn streaming handler (Phase B "Pair").
 *
 * The handler folds a runAgentChat async-iterable into:
 *   • assistantText — accumulated from every `delta.text`
 *   • a `result` reconciliation: finalText REPLACES the accumulation ONLY when
 *     it's strictly longer than what we accumulated (chat.ts:76). A shorter
 *     finalText (e.g. a summary) is ignored — the streamed deltas are truth.
 *   • DEFERRED errors: an `error` mid-stream is NOT emitted inline; it's stashed
 *     (lastErrorMessage/Stderr) and re-emitted exactly ONCE after the stream
 *     ends (chat.ts:82-84,96-98), mirroring the legacy "error is terminal" model.
 *   • token/cost rollup carried in the returned ToolResult JSON.
 *
 * We mock runAgentChat with a scripted async-iterable and surfaceBackend/Model
 * (no PG), then drive the tool's handler with a fake emit ctx and assert both the
 * emitted event sequence and the returned rollup JSON.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

type ChatEvent =
  | { type: 'delta'; text: string }
  | { type: 'result'; costUsd: number; tokensIn: number; tokensOut: number; finalText: string }
  | { type: 'error'; message: string; stderr?: string };

/** Scripted async-iterable standing in for runAgentChat(). */
async function* streamOf(events: ChatEvent[]): AsyncGenerator<ChatEvent> {
  for (const ev of events) yield ev;
}

const runAgentChatMock = vi.fn<(opts: unknown) => AsyncGenerator<ChatEvent>>();
const surfaceBackendMock = vi.fn();
const surfaceModelMock = vi.fn();

let tool: {
  handler: (
    a: { promptText: string; cwd?: string; surface?: 'agent_chats' | 'portal' },
    c: { emit: (n: string, d: unknown) => void; signal?: AbortSignal },
  ) => Promise<{ content: Array<{ text: string }> }>;
};

beforeAll(async () => {
  vi.doMock('../../../agent-chat-stream', () => ({
    runAgentChat: runAgentChatMock,
  }));
  vi.doMock('../../../agent-config', () => ({
    surfaceBackend: surfaceBackendMock,
    surfaceModel: surfaceModelMock,
  }));
  tool = (await import('../chat')).default as never;
});

afterAll(() => {
  vi.doUnmock('../../../agent-chat-stream');
  vi.doUnmock('../../../agent-config');
});

beforeEach(() => {
  runAgentChatMock.mockReset();
  surfaceBackendMock.mockReset().mockResolvedValue(undefined);
  surfaceModelMock.mockReset().mockResolvedValue(undefined);
});

/** Captures emitted (name, data) pairs + parses the returned rollup. */
function makeCtx() {
  const emitted: Array<{ name: string; data: unknown }> = [];
  const ctx = { emit: (name: string, data: unknown) => emitted.push({ name, data }), signal: undefined };
  return { ctx, emitted };
}
function rollup(r: { content: Array<{ text: string }> }) {
  return JSON.parse(r.content[0].text) as {
    finalText: string;
    tokensIn: number;
    tokensOut: number;
    costUsd: number;
  };
}

const resultEv = (over: Partial<Extract<ChatEvent, { type: 'result' }>> = {}): ChatEvent => ({
  type: 'result',
  costUsd: 0,
  tokensIn: 0,
  tokensOut: 0,
  finalText: '',
  ...over,
});

describe('agent_chats:chat — delta accumulation + finalText reconciliation', () => {
  it('emits each delta and accumulates them into finalText when result.finalText is SHORTER', async () => {
    runAgentChatMock.mockReturnValueOnce(
      streamOf([
        { type: 'delta', text: 'Hello ' },
        { type: 'delta', text: 'world!' },
        // shorter finalText (e.g. a truncated summary) → accumulated wins
        resultEv({ finalText: 'Hi', tokensIn: 11, tokensOut: 22, costUsd: 0.5 }),
      ]),
    );
    const { ctx, emitted } = makeCtx();
    const r = await tool.handler({ promptText: 'hi' }, ctx);

    // both deltas were emitted, in order, with the JSON {text} wire shape
    const deltas = emitted.filter((e) => e.name === 'delta');
    expect(deltas.map((d) => (d.data as { text: string }).text)).toEqual(['Hello ', 'world!']);

    const out = rollup(r);
    expect(out.finalText).toBe('Hello world!'); // accumulated, NOT 'Hi'
    expect(out.tokensIn).toBe(11);
    expect(out.tokensOut).toBe(22);
    expect(out.costUsd).toBe(0.5);
  });

  it('lets result.finalText WIN when it is strictly longer than the accumulation', async () => {
    runAgentChatMock.mockReturnValueOnce(
      streamOf([
        { type: 'delta', text: 'Hel' },
        { type: 'delta', text: 'lo' },
        resultEv({ finalText: 'Hello, full reconciled text', tokensIn: 3, tokensOut: 9, costUsd: 0.1 }),
      ]),
    );
    const { ctx } = makeCtx();
    const r = await tool.handler({ promptText: 'hi' }, ctx);
    expect(rollup(r).finalText).toBe('Hello, full reconciled text');
  });

  it('keeps the accumulation when finalText is exactly equal-length (strict > only)', async () => {
    runAgentChatMock.mockReturnValueOnce(
      streamOf([
        { type: 'delta', text: 'abcd' },
        resultEv({ finalText: 'WXYZ' }), // same length → not strictly longer → accumulation wins
      ]),
    );
    const { ctx } = makeCtx();
    const r = await tool.handler({ promptText: 'hi' }, ctx);
    expect(rollup(r).finalText).toBe('abcd');
  });
});

describe('agent_chats:chat — public portal model/backend pin (P-005, D-004/D-008)', () => {
  it('keeps legacy callers on the shared agent_chats surface', async () => {
    runAgentChatMock.mockReturnValueOnce(streamOf([resultEv()]));
    const { ctx } = makeCtx();
    await tool.handler({ promptText: 'hi' }, ctx);

    expect(surfaceBackendMock).toHaveBeenCalledWith('agent_chats');
    expect(surfaceModelMock).toHaveBeenCalledWith('agent_chats');
  });

  it('uses the committed public pair when a fresh instance has no stored portal overrides', async () => {
    runAgentChatMock.mockReturnValueOnce(streamOf([resultEv()]));
    const { ctx } = makeCtx();
    await tool.handler({ promptText: 'hi', surface: 'portal' }, ctx);

    expect(surfaceBackendMock).toHaveBeenCalledWith('portal');
    expect(surfaceModelMock).toHaveBeenCalledWith('portal');
    expect(runAgentChatMock).toHaveBeenCalledWith(
      expect.objectContaining({ backend: 'claude-code', model: 'sonnet[1m]:high' }),
    );
  });

  it('runs a stored portal override only when model and backend are configured together', async () => {
    surfaceBackendMock.mockResolvedValueOnce('codex');
    surfaceModelMock.mockResolvedValueOnce('gpt-5.6-luna:high');
    runAgentChatMock.mockReturnValueOnce(streamOf([resultEv()]));
    const { ctx } = makeCtx();
    await tool.handler({ promptText: 'hi', surface: 'portal' }, ctx);

    expect(runAgentChatMock).toHaveBeenCalledWith(
      expect.objectContaining({ backend: 'codex', model: 'gpt-5.6-luna:high' }),
    );
  });

  it.each([
    ['model only', undefined, 'gpt-5.6-luna:high'],
    ['backend only', 'codex', undefined],
  ])('refuses a half-configured portal pair (%s)', async (_label, backend, model) => {
    surfaceBackendMock.mockResolvedValueOnce(backend);
    surfaceModelMock.mockResolvedValueOnce(model);
    const { ctx } = makeCtx();

    await expect(tool.handler({ promptText: 'hi', surface: 'portal' }, ctx)).rejects.toThrow(
      /surfaceModels\.portal and backends\.portal must be set together/,
    );
    expect(runAgentChatMock).not.toHaveBeenCalled();
  });
});

describe('agent_chats:chat — deferred error re-emission', () => {
  it('emits a mid-stream error EXACTLY ONCE, AFTER all deltas, at stream end', async () => {
    runAgentChatMock.mockReturnValueOnce(
      streamOf([
        { type: 'delta', text: 'partial ' },
        { type: 'error', message: 'backend exploded', stderr: 'stack trace' },
        { type: 'delta', text: 'more after error' },
        resultEv({ tokensIn: 1, tokensOut: 2, costUsd: 0.01 }),
      ]),
    );
    const { ctx, emitted } = makeCtx();
    const r = await tool.handler({ promptText: 'hi' }, ctx);

    // error is deferred: it appears once, and AFTER both deltas in emit order
    const errors = emitted.filter((e) => e.name === 'error');
    expect(errors).toHaveLength(1);
    expect(errors[0].data).toEqual({ message: 'backend exploded', stderr: 'stack trace' });

    const lastDeltaIdx = emitted.map((e) => e.name).lastIndexOf('delta');
    const errorIdx = emitted.findIndex((e) => e.name === 'error');
    expect(errorIdx).toBeGreaterThan(lastDeltaIdx); // error emitted after the last delta

    // deltas still accumulate normally; result rollup still returned
    expect(rollup(r).finalText).toBe('partial more after error');
    expect(rollup(r).tokensOut).toBe(2);
  });

  it('re-emits only the LAST error when several arrive (legacy last-wins)', async () => {
    runAgentChatMock.mockReturnValueOnce(
      streamOf([
        { type: 'error', message: 'first', stderr: 'e1' },
        { type: 'delta', text: 'x' },
        { type: 'error', message: 'second' }, // no stderr → undefined re-emitted
        resultEv(),
      ]),
    );
    const { ctx, emitted } = makeCtx();
    await tool.handler({ promptText: 'hi' }, ctx);
    const errors = emitted.filter((e) => e.name === 'error');
    expect(errors).toHaveLength(1);
    expect(errors[0].data).toEqual({ message: 'second', stderr: undefined });
  });

  it('emits NO error event on a clean stream', async () => {
    runAgentChatMock.mockReturnValueOnce(
      streamOf([{ type: 'delta', text: 'all good' }, resultEv({ tokensIn: 5, tokensOut: 7, costUsd: 0.2 })]),
    );
    const { ctx, emitted } = makeCtx();
    const r = await tool.handler({ promptText: 'hi' }, ctx);
    expect(emitted.some((e) => e.name === 'error')).toBe(false);
    expect(rollup(r)).toEqual({ finalText: 'all good', tokensIn: 5, tokensOut: 7, costUsd: 0.2 });
  });
});

describe('agent_chats:chat — rollup defaults + iterator failure', () => {
  it('returns zeroed rollup + empty finalText when the stream yields nothing', async () => {
    runAgentChatMock.mockReturnValueOnce(streamOf([]));
    const { ctx } = makeCtx();
    const r = await tool.handler({ promptText: 'hi' }, ctx);
    expect(rollup(r)).toEqual({ finalText: '', tokensIn: 0, tokensOut: 0, costUsd: 0 });
  });

  it('wraps an iterator throw in a descriptive error', async () => {
    async function* boom(): AsyncGenerator<ChatEvent> {
      yield { type: 'delta', text: 'x' };
      throw new Error('stream died');
    }
    runAgentChatMock.mockReturnValueOnce(boom());
    const { ctx } = makeCtx();
    await expect(tool.handler({ promptText: 'hi' }, ctx)).rejects.toThrow(
      /agent_chats chat failed: stream died/,
    );
  });
});
