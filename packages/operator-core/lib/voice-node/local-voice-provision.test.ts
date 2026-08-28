import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, mkdir, writeFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DetectedHardware } from '../provisioner/hardware-detect';
import {
  LEGACY_VOICE_UNITS,
  reconcileLegacyVoiceServices,
  startLocalVoiceProvision,
  getLocalVoiceProvisionStatus,
  __resetLocalVoiceProvisionForTests,
  type LegStatus,
} from './local-voice-provision';

const linuxHw: DetectedHardware = { platform: 'linux', arch: 'x64', ramGB: 32, gpu: null, notes: [] };

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

  it('reconciles the broken legacy Whisper owner and retains Kokoro compatibility by default', async () => {
    const runSystemctl = vi.fn(async () => ({ stdout: '', stderr: '' }));
    const result = await reconcileLegacyVoiceServices({ runSystemctl, platform: 'linux' });

    expect(result.whisper).toMatchObject({ unit: LEGACY_VOICE_UNITS.whisper, ok: true, action: 'disabled' });
    expect(result.kokoro).toMatchObject({ unit: LEGACY_VOICE_UNITS.kokoro, ok: true, action: 'retained' });
    expect(runSystemctl).toHaveBeenCalledTimes(1);
    expect(runSystemctl).toHaveBeenCalledWith(['--user', 'disable', '--now', LEGACY_VOICE_UNITS.whisper]);
  });

  it('can retire both legacy units once the in-process fallback is ready', async () => {
    const runSystemctl = vi.fn(async () => ({ stdout: '', stderr: '' }));
    const result = await reconcileLegacyVoiceServices({ runSystemctl, platform: 'linux', retireKokoro: true });

    expect(result.whisper.action).toBe('disabled');
    expect(result.kokoro.action).toBe('disabled');
    expect(runSystemctl).toHaveBeenCalledWith(['--user', 'disable', '--now', LEGACY_VOICE_UNITS.kokoro]);
  });

  it('treats an uninstalled legacy unit as an idempotent no-op', async () => {
    const runSystemctl = vi.fn(async (args: string[]) => {
      throw new Error(`Unit ${args.at(-1)} not loaded.`);
    });
    const result = await reconcileLegacyVoiceServices({ runSystemctl, platform: 'linux' });

    expect(result.whisper).toMatchObject({ ok: true, action: 'already-absent' });
    expect(result.kokoro.action).toBe('retained');
  });

  it('refreshes each leg from exact disk state instead of retaining stale done flags', async () => {
    const binDir = join(home, '.papercusp/backends/whisper-server/v1.9.1/linux-x64-cpu');
    const modelDir = join(home, '.papercusp/models/whisper');
    const kokoroDir = join(home, '.papercusp/models/kokoro');
    await mkdir(binDir, { recursive: true });
    await mkdir(modelDir, { recursive: true });
    await mkdir(kokoroDir, { recursive: true });
    const binPath = join(binDir, 'whisper-server');
    const binBytes = 'valid-test-whisper';
    await writeFile(binPath, binBytes);
    await writeFile(
      join(binDir, 'manifest.json'),
      JSON.stringify({ version: 'v1.9.1', platformKey: 'linux-x64-cpu', source: 'prebuilt', sha256: createHash('sha256').update(binBytes).digest('hex'), builtAt: 'test' }),
    );
    await writeFile(join(modelDir, 'ggml-base.bin'), 'weights');
    await writeFile(
      join(kokoroDir, '.provisioned.json'),
      JSON.stringify({ modelId: 'onnx-community/Kokoro-82M-v1.0-ONNX', dtype: 'q8', provisionedAt: 'test' }),
    );

    const present = await getLocalVoiceProvisionStatus({ home, detectHw: async () => linuxHw });
    expect(present.whisperBinary).toEqual({ done: true });
    expect(present.whisperModel).toEqual({ done: true });
    expect(present.kokoro).toEqual({ done: true });

    await unlink(binPath);
    await unlink(join(modelDir, 'ggml-base.bin'));
    await unlink(join(kokoroDir, '.provisioned.json'));
    const absent = await getLocalVoiceProvisionStatus({ home, detectHw: async () => linuxHw });
    expect(absent.whisperBinary.done).toBe(false);
    expect(absent.whisperModel.done).toBe(false);
    expect(absent.kokoro.done).toBe(false);
  });
});
