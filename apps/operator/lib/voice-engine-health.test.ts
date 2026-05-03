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
