import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  recordTtsSpeakSuccess,
  recordTtsSpeakError,
  isTtsDisabled,
  reEnableTts,
  _resetTtsHealthForTests,
  startSttHealthMonitor,
} from './voice-engine-health';

afterEach(() => {
  _resetTtsHealthForTests();
});

describe('TTS failure tracking', () => {
  it('does not disable on a single error', () => {
    expect(recordTtsSpeakError('boom').kind).toBe('none');
    expect(isTtsDisabled()).toBe(false);
  });

  it('disables on 3rd consecutive error', () => {
    recordTtsSpeakError('e1');
    recordTtsSpeakError('e2');
    const t = recordTtsSpeakError('e3');
    expect(t.kind).toBe('now-disabled');
    expect(isTtsDisabled()).toBe(true);
  });

  it('success between errors resets the counter', () => {
    recordTtsSpeakError('e1');
    recordTtsSpeakError('e2');
    recordTtsSpeakSuccess();
    expect(recordTtsSpeakError('e3').kind).toBe('none');
    expect(isTtsDisabled()).toBe(false);
  });

  it('once disabled, further errors do not re-fire the transition', () => {
    recordTtsSpeakError('e1');
    recordTtsSpeakError('e2');
    recordTtsSpeakError('e3');
    expect(recordTtsSpeakError('e4').kind).toBe('none'); // already disabled
  });

  it('reEnableTts clears state', () => {
    recordTtsSpeakError('e1');
    recordTtsSpeakError('e2');
    recordTtsSpeakError('e3');
    expect(isTtsDisabled()).toBe(true);
    reEnableTts();
    expect(isTtsDisabled()).toBe(false);
  });
});

describe('STT health monitor', () => {
  it('detects disconnect transition (up → down)', async () => {
    let online = true;
    const events: string[] = [];
    const m = startSttHealthMonitor(
      'voicemode',
      async () => online,
      {
        onDisconnect: (k) => events.push(`disconnect:${k}`),
        onReconnect: (k) => events.push(`reconnect:${k}`),
      },
      20,
    );
    // Allow first probe to anchor lastUp=true.
    await new Promise((r) => setTimeout(r, 10));
    online = false;
    await new Promise((r) => setTimeout(r, 60));
    m.stop();
    expect(events).toContain('disconnect:voicemode');
  });

  it('detects reconnect transition (down → up)', async () => {
    let online = false;
    const events: string[] = [];
    const m = startSttHealthMonitor(
      'voicemode',
      async () => online,
      {
        onDisconnect: (k) => events.push(`disconnect:${k}`),
        onReconnect: (k) => events.push(`reconnect:${k}`),
      },
      20,
    );
    await new Promise((r) => setTimeout(r, 30));
    online = true;
    await new Promise((r) => setTimeout(r, 60));
    m.stop();
    expect(events).toContain('reconnect:voicemode');
  });
});

// P-018 (voice-production-test-coverage): the branches the real-timer tests
// above don't exercise — a throwing probe, the no-transition (stable) case,
// and stop() halting the loop. Fake timers keep these deterministic.
describe('STT health monitor — branch coverage', () => {
  afterEach(() => vi.useRealTimers());

  function mk(probe: () => Promise<boolean>, intervalMs = 20) {
    const events: string[] = [];
    const m = startSttHealthMonitor(
      'voicemode',
      probe,
      {
        onDisconnect: (k) => events.push(`disconnect:${k}`),
        onReconnect: (k) => events.push(`reconnect:${k}`),
      },
      intervalMs,
    );
    return { events, m };
  }

  it('treats a throwing probe as down → fires disconnect', async () => {
    vi.useFakeTimers();
    const { events, m } = mk(async () => {
      throw new Error('engine gone');
    });
    await vi.advanceTimersByTimeAsync(25); // anchor tick resolves
    m.stop();
    expect(events).toContain('disconnect:voicemode');
  });

  it('fires nothing while the engine stays up (no spurious transitions)', async () => {
    vi.useFakeTimers();
    const { events, m } = mk(async () => true);
    await vi.advanceTimersByTimeAsync(100); // several intervals
    m.stop();
    expect(events).toEqual([]);
  });

  it('stop() halts the probe loop and is idempotent', async () => {
    vi.useFakeTimers();
    const probe = vi.fn(async () => true);
    const { m } = mk(probe);
    await vi.advanceTimersByTimeAsync(25);
    const callsAtStop = probe.mock.calls.length;
    m.stop();
    m.stop(); // idempotent — must not throw
    await vi.advanceTimersByTimeAsync(200);
    expect(probe.mock.calls.length).toBe(callsAtStop); // no probes after stop
  });
});
