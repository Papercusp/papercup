import { describe, it, expect } from 'vitest';
import { fakeRunAgentChat, collectEvents } from './fake-agent-chat';

describe('fakeRunAgentChat', () => {
  it('yields deltas in order then a result terminal event', async () => {
    const events = await collectEvents(
      fakeRunAgentChat({
        deltas: [{ text: 'Hello ' }, { text: 'world' }],
      }),
    );
    expect(events).toHaveLength(3);
    expect(events[0]).toEqual({ type: 'delta', text: 'Hello ' });
    expect(events[1]).toEqual({ type: 'delta', text: 'world' });
    expect(events[2]).toMatchObject({ type: 'result', finalText: 'Hello world' });
  });

  it('emits tool_call after the matching delta index', async () => {
    const events = await collectEvents(
      fakeRunAgentChat({
        deltas: [{ text: 'a' }, { text: 'b' }, { text: 'c' }],
        toolCalls: [{ afterDelta: 1, name: 'demo:ping', input: { x: 1 } }],
      }),
    );
    // delta a, delta b, tool_call, delta c, result
    expect(events.map((e) => e.type)).toEqual([
      'delta',
      'delta',
      'tool_call',
      'delta',
      'result',
    ]);
    expect((events[2] as { name: string }).name).toBe('demo:ping');
  });

  it('error short-circuits after the indicated delta', async () => {
    const events = await collectEvents(
      fakeRunAgentChat({
        deltas: [{ text: 'a' }, { text: 'b' }, { text: 'c' }],
        error: { message: 'boom', afterDelta: 1 },
      }),
    );
    expect(events.map((e) => e.type)).toEqual(['delta', 'delta', 'error']);
    expect((events[2] as { message: string }).message).toBe('boom');
  });

  it('error without afterDelta terminates after all deltas', async () => {
    const events = await collectEvents(
      fakeRunAgentChat({
        deltas: [{ text: 'a' }],
        error: { message: 'late-boom' },
      }),
    );
    expect(events.map((e) => e.type)).toEqual(['delta', 'error']);
  });

  it('result rollup carries cost + tokens', async () => {
    const events = await collectEvents(
      fakeRunAgentChat({
        deltas: [{ text: 'hi' }],
        result: { costUsd: 0.0125, tokensIn: 12, tokensOut: 3, finalText: 'hi' },
      }),
    );
    const result = events[events.length - 1];
    expect(result).toEqual({
      type: 'result',
      costUsd: 0.0125,
      tokensIn: 12,
      tokensOut: 3,
      finalText: 'hi',
    });
  });

  it('empty script yields only a result event', async () => {
    const events = await collectEvents(fakeRunAgentChat({}));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'result', finalText: '' });
  });
});
