import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  startLocalVoiceProvision,
  getLocalVoiceProvisionStatus,
  __resetLocalVoiceProvisionForTests,
  type LegStatus,
} from './local-voice-provision';

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('local-voice-provision', () => {
  // A fresh EMPTY home for every disk-refresh read: getLocalVoiceProvisionStatus falls back
  // to the durable caches when idle, and the DEV BOX's real home is genuinely provisioned —
  // tests must never read it.
  let home: string;
  beforeEach(async () => {
    __resetLocalVoiceProvisionForTests();
    home = await mkdtemp(join(tmpdir(), 'local-voice-provision-test-'));
  });
  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it('runs the three legs sequentially and lands done+finishedAt', async () => {
    const order: string[] = [];
    const kick = startLocalVoiceProvision({
      now: () => '2026-07-12T00:00:00.000Z',
      provisionWhisperBinary: async () => {
        order.push('bin');
        return { done: true };
      },
      provisionWhisperModel: async () => {
        order.push('model');
        return { done: true };
      },
      provisionKokoro: async () => {
        order.push('kokoro');
        return { done: true };
      },
    });
    expect(kick).toEqual({ started: true, alreadyRunning: false });
    await vi.waitFor(async () => {
      const s = await getLocalVoiceProvisionStatus({ home });
      expect(s.running).toBe(false);
      expect(s.finishedAt).toBeTruthy();
    });
    expect(order).toEqual(['bin', 'model', 'kokoro']);
  });

  it('concurrent starts coalesce (single-flight)', async () => {
    const gate = deferred<LegStatus>();
    const first = startLocalVoiceProvision({
      provisionWhisperBinary: () => gate.promise,
      provisionWhisperModel: async () => ({ done: true }),
      provisionKokoro: async () => ({ done: true }),
    });
    const second = startLocalVoiceProvision({
      provisionWhisperBinary: async () => {
        throw new Error('second run must not start');
      },
    });
    expect(first.started).toBe(true);
    expect(second).toEqual({ started: false, alreadyRunning: true });
    const during = await getLocalVoiceProvisionStatus({ home });
    expect(during.running).toBe(true);
    gate.resolve({ done: true });
    await vi.waitFor(async () => {
      expect((await getLocalVoiceProvisionStatus({ home })).running).toBe(false);
    });
  });

  it('a failed leg records blocked, the run still completes, and a re-run is possible', async () => {
    startLocalVoiceProvision({
      provisionWhisperBinary: async () => ({ done: true }),
      provisionWhisperModel: async () => ({ done: false, blocked: 'HTTP 503 from the mirror' }),
      provisionKokoro: async () => ({ done: true }),
    });
    await vi.waitFor(async () => {
      expect((await getLocalVoiceProvisionStatus({ home })).running).toBe(false);
    });
    const s = await getLocalVoiceProvisionStatus({ home });
    expect(s.whisperBinary.done).toBe(true);
    expect(s.whisperModel).toEqual({ done: false, blocked: 'HTTP 503 from the mirror' });
    expect(s.kokoro.done).toBe(true);

    // Re-run after a failure is allowed (inflight cleared).
    const again = startLocalVoiceProvision({
      provisionWhisperBinary: async () => ({ done: true }),
      provisionWhisperModel: async () => ({ done: true }),
      provisionKokoro: async () => ({ done: true }),
    });
    expect(again.started).toBe(true);
    await vi.waitFor(async () => {
      expect((await getLocalVoiceProvisionStatus({ home })).running).toBe(false);
    });
  });

  it('a THROWING leg is captured as blocked, never an unhandled rejection', async () => {
    startLocalVoiceProvision({
      provisionWhisperBinary: async () => {
        throw new Error('boom');
      },
      provisionWhisperModel: async () => ({ done: true }),
      provisionKokoro: async () => ({ done: true }),
    });
    await vi.waitFor(async () => {
      expect((await getLocalVoiceProvisionStatus({ home })).running).toBe(false);
    });
    const s = await getLocalVoiceProvisionStatus({ home });
    expect(s.whisperBinary.done).toBe(false);
    expect(s.whisperBinary.blocked).toMatch(/boom/);
  });
});
