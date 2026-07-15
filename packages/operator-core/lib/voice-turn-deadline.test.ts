import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createVoiceBrainFirstEventDeadline,
  VOICE_BRAIN_TIMEOUT_MESSAGE,
} from './voice-turn-deadline';

describe('createVoiceBrainFirstEventDeadline', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('aborts a silent brain and identifies its own timeout', async () => {
    const parent = new AbortController();
    const deadline = createVoiceBrainFirstEventDeadline(parent.signal, 1_000);

    await vi.advanceTimersByTimeAsync(1_001);

    expect(deadline.signal.aborted).toBe(true);
    expect(deadline.signal.reason).toMatchObject({ name: 'TimeoutError' });
    expect(deadline.didTimeout()).toBe(true);
    expect(VOICE_BRAIN_TIMEOUT_MESSAGE).toBe(
      'The voice response took too long. Please try again.',
    );
    deadline.dispose();
  });

  it('disarms the deadline after the first brain event', async () => {
    const parent = new AbortController();
    const deadline = createVoiceBrainFirstEventDeadline(parent.signal, 1_000);

    deadline.observeEvent();
    await vi.advanceTimersByTimeAsync(2_000);

    expect(deadline.signal.aborted).toBe(false);
    expect(deadline.didTimeout()).toBe(false);
    deadline.dispose();
  });

  it('propagates a caller disconnect without misclassifying it as a timeout', () => {
    const parent = new AbortController();
    const deadline = createVoiceBrainFirstEventDeadline(parent.signal, 1_000);

    parent.abort(new DOMException('phone disconnected', 'AbortError'));

    expect(deadline.signal.aborted).toBe(true);
    expect(deadline.signal.reason).toMatchObject({ name: 'AbortError' });
    expect(deadline.didTimeout()).toBe(false);
    deadline.dispose();
  });
});
