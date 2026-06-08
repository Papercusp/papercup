/**
 * Tests for ratePauseEventHooks — the gym's onPause/onReset wiring that emits
 * rate-limit:paused/reset events through the await-event primitive (fire-and-forget).
 * Run with: cd packages/operator-core && npx vitest run lib/gym/rate-pause-events.test.ts
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const emitMock = vi.hoisted(() => ({ fn: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../events/await/engine', () => ({ emitAwaitedEvent: emitMock.fn }));

import { ratePauseEventHooks } from './rate-pause-events';

const flush = () => new Promise((r) => setImmediate(r));
afterEach(() => emitMock.fn.mockClear());

describe('ratePauseEventHooks', () => {
  it('onPause emits rate-limit:paused:<scope> with rounded wait + attempt+1', async () => {
    ratePauseEventHooks('judge').onPause({ waitMs: 5000, attempt: 1 });
    await flush();
    const arg = emitMock.fn.mock.calls[0][0];
    expect(arg).toMatchObject({
      key: 'rate-limit:paused:judge',
      source: 'gym:judge',
      payload: { waitMs: 5000, attempt: 1 },
    });
    expect(arg.summary).toContain('5s');
    expect(arg.summary).toContain('attempt 2');
  });

  it('onReset emits rate-limit:reset:<scope> with the waited time', async () => {
    ratePauseEventHooks('sim').onReset({ waitedMs: 3000, attempt: 0 });
    await flush();
    const arg = emitMock.fn.mock.calls[0][0];
    expect(arg).toMatchObject({
      key: 'rate-limit:reset:sim',
      source: 'gym:sim',
      payload: { waitedMs: 3000, attempt: 0 },
    });
    expect(arg.summary).toContain('3s');
  });

  it('swallows an emit failure (visibility only — never breaks the pause)', async () => {
    emitMock.fn.mockRejectedValueOnce(new Error('bus down'));
    expect(() => ratePauseEventHooks('x').onPause({ waitMs: 1000, attempt: 0 })).not.toThrow();
    await flush();
    expect(emitMock.fn).toHaveBeenCalled();
  });
});
