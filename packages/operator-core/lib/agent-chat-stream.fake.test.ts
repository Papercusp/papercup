/**
 * Unit test for the fake-LLM env-gated injection seam in lib/agent-chat-stream.ts.
 * Confirms that with PAPERCUSP_FAKE_LLM=1, runAgentChat yields scripted deltas
 * instead of attempting to spawn the real agent binary.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

describe('agent-chat-stream fake-LLM seam', () => {
  const original = process.env.PAPERCUSP_FAKE_LLM;
  beforeEach(() => {
    process.env.PAPERCUSP_FAKE_LLM = '1';
  });
  afterEach(() => {
    if (original === undefined) delete process.env.PAPERCUSP_FAKE_LLM;
    else process.env.PAPERCUSP_FAKE_LLM = original;
  });

  it('yields three deltas + one result terminal event', async () => {
    const { runAgentChat } = await import('./agent-chat-stream');
    const events: unknown[] = [];
    for await (const ev of runAgentChat({
      promptText: 'hello fake',
      role: 'architect',
    } as Parameters<typeof runAgentChat>[0])) {
      events.push(ev);
    }
    expect(events.length).toBe(4);
    expect(events[0]).toMatchObject({ type: 'delta' });
    expect(events[1]).toMatchObject({ type: 'delta' });
    expect(events[2]).toMatchObject({ type: 'delta' });
    expect(events[3]).toMatchObject({ type: 'result' });
  });

  it('first delta echoes the user message tail', async () => {
    const { runAgentChat } = await import('./agent-chat-stream');
    const msg = 'unique-marker-XYZ123';
    const events: { type: string; text?: string }[] = [];
    for await (const ev of runAgentChat({
      promptText: msg,
      role: 'architect',
    } as Parameters<typeof runAgentChat>[0])) {
      events.push(ev as { type: string; text?: string });
    }
    const firstDelta = events[0];
    expect(firstDelta.type).toBe('delta');
    expect(firstDelta.text).toContain('unique-marker-XYZ123');
  });

  it('yields a single terminal error event when the prompt carries the error sentinel', async () => {
    const { runAgentChat, FAKE_LLM_ERROR_SENTINEL } = await import('./agent-chat-stream');
    const events: { type: string; message?: string }[] = [];
    for await (const ev of runAgentChat({
      promptText: `please fail ${FAKE_LLM_ERROR_SENTINEL}`,
      role: 'worker',
    } as Parameters<typeof runAgentChat>[0])) {
      events.push(ev as { type: string; message?: string });
    }
    expect(events.length).toBe(1);
    expect(events[0].type).toBe('error');
    expect(events[0].message).toContain('fake-llm');
    // No delta/result leaked through.
    expect(events.some((e) => e.type === 'delta' || e.type === 'result')).toBe(false);
  });

  it('result event terminal has zero cost (fake LLM is free)', async () => {
    const { runAgentChat } = await import('./agent-chat-stream');
    const events: { type: string; costUsd?: number }[] = [];
    for await (const ev of runAgentChat({
      promptText: 'cost check',
      role: 'oracle',
    } as Parameters<typeof runAgentChat>[0])) {
      events.push(ev as { type: string; costUsd?: number });
    }
    const result = events.find((e) => e.type === 'result');
    expect(result?.costUsd).toBe(0);
  });
});
