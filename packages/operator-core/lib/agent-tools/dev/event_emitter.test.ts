/**
 * event_emitter.test.ts — the dev:event_emitter HANDLER (the replay-buffer probe). No
 * module mocks: the handler's logic is the emit loop itself, driven by ctx. Pins that it
 * emits `steps` serial `tick` events ({i:0..N-1}) and reports emitted, and that an
 * already-aborted signal short-circuits the loop (no emits). A regression that loses the
 * serial counter or ignores the abort signal is what this catches.
 *
 * In-tree (operator-core, tab-visible).
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/dev/event_emitter.test.ts
 */
import { describe, expect, it, vi } from 'vitest';

const tool = (await import('./event_emitter')).default;

type Out = { content: { text: string }[] };
const run = (args: Record<string, unknown>, aborted = false) => {
  const emit = vi.fn();
  const p = tool.handler({ delayMs: 0, ...args } as never, { emit, signal: { aborted } } as never) as Promise<Out>;
  return { emit, p };
};
const body = (o: Out) => JSON.parse(o.content[0]!.text);

describe('dev:event_emitter handler', () => {
  it('emits `steps` serial tick events and reports emitted', async () => {
    const { emit, p } = run({ steps: 3 });
    const b = body(await p);
    expect(b).toMatchObject({ ok: true, emitted: 3 });
    expect(emit).toHaveBeenCalledTimes(3);
    expect(emit.mock.calls.map((c) => c[1])).toEqual([{ i: 0 }, { i: 1 }, { i: 2 }]);
    expect(emit.mock.calls[0]![0]).toBe('tick');
  });

  it('an already-aborted signal short-circuits the loop (no emits)', async () => {
    const { emit, p } = run({ steps: 5 }, true);
    await p;
    expect(emit).not.toHaveBeenCalled();
  });
});
