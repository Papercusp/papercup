/**
 * haiku.test.ts — runHaiku, the best-effort single-turn LLM primitive.
 *
 * Contract: returns the trimmed final text; OVERWRITES on each delta/result
 * (never accumulates → no doubled output); returns null on an error event, on a
 * thrown iterator, and on empty output; passes maxTokens through. runAgentChat is
 * mocked as an async generator so no real LLM call happens.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const runAgentChatMock = vi.fn();
vi.mock('./agent-chat-stream', () => ({
  runAgentChat: (...a: unknown[]) => runAgentChatMock(...a),
}));

import { runHaiku } from './haiku';

// runHaiku logs failures loudly (by design); suppress the warn so
// vitest-fail-on-console doesn't treat the expected log as a failure.
let warnSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  warnSpy.mockRestore();
});

/** Make runAgentChat yield the given events as an async generator. */
function emits(...events: Array<Record<string, unknown>>) {
  runAgentChatMock.mockImplementation(async function* () {
    for (const ev of events) yield ev;
  });
}

describe('runHaiku', () => {
  it('returns the trimmed final text from the result event', async () => {
    emits({ type: 'delta', text: 'partial' }, { type: 'result', finalText: '  the answer  ' });
    expect(await runHaiku('summarise this')).toBe('the answer');
  });

  it('overwrites rather than accumulates across delta/result (no doubling)', async () => {
    // anthropic-direct emits the full text in the delta, then the same in result.
    emits({ type: 'delta', text: 'full text' }, { type: 'result', finalText: 'full text' });
    expect(await runHaiku('x')).toBe('full text'); // not "full textfull text"
  });

  it('falls back to the last delta when result carries no finalText', async () => {
    emits({ type: 'delta', text: 'only-delta' }, { type: 'result', finalText: '' });
    expect(await runHaiku('x')).toBe('only-delta');
  });

  it('returns null on an error event', async () => {
    emits({ type: 'delta', text: 'ignored' }, { type: 'error', message: 'boom' });
    expect(await runHaiku('x')).toBeNull();
    expect(warnSpy).toHaveBeenCalled(); // logs loudly on failure
  });

  it('returns null when the iterator throws (best-effort, never surfaces)', async () => {
    runAgentChatMock.mockImplementation(async function* () {
      throw new Error('transport died');
       
      yield {};
    });
    await expect(runHaiku('x')).resolves.toBeNull();
  });

  it('returns null for empty/whitespace output', async () => {
    emits({ type: 'result', finalText: '   ' });
    expect(await runHaiku('x')).toBeNull();
  });

  it('passes maxTokens through to runAgentChat (default 200)', async () => {
    emits({ type: 'result', finalText: 'ok' });
    await runHaiku('x');
    expect(runAgentChatMock).toHaveBeenCalledWith(expect.objectContaining({ maxTokens: 200, backend: 'anthropic-direct' }));
    await runHaiku('x', 50);
    expect(runAgentChatMock).toHaveBeenLastCalledWith(expect.objectContaining({ maxTokens: 50 }));
  });
});
