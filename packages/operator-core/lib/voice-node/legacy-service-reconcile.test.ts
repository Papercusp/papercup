import { describe, expect, it, vi } from 'vitest';
import {
  LEGACY_VOICE_UNITS,
  reconcileLegacyVoiceServices,
} from './legacy-service-reconcile';

describe('legacy VoiceMode service reconciliation', () => {
  it('is a no-op on platforms without a user systemd manager', async () => {
    const runSystemctl = vi.fn(async () => ({ stdout: '', stderr: '' }));
    const result = await reconcileLegacyVoiceServices({ platform: 'darwin', runSystemctl });

    expect(result).toEqual({
      whisper: expect.objectContaining({ unit: LEGACY_VOICE_UNITS.whisper, action: 'unsupported', ok: true }),
      kokoro: expect.objectContaining({ unit: LEGACY_VOICE_UNITS.kokoro, action: 'unsupported', ok: true }),
    });
    expect(runSystemctl).not.toHaveBeenCalled();
  });

  it('stops the broken Whisper owner while retaining Kokoro compatibility by default', async () => {
    const runSystemctl = vi.fn(async () => ({ stdout: '', stderr: '' }));
    const result = await reconcileLegacyVoiceServices({ platform: 'linux', runSystemctl });

    expect(result.whisper).toMatchObject({ unit: LEGACY_VOICE_UNITS.whisper, ok: true, action: 'disabled' });
    expect(result.kokoro).toMatchObject({ unit: LEGACY_VOICE_UNITS.kokoro, ok: true, action: 'retained' });
    expect(runSystemctl).toHaveBeenCalledTimes(1);
    expect(runSystemctl).toHaveBeenCalledWith(['--user', 'disable', '--now', LEGACY_VOICE_UNITS.whisper]);
  });

  it('can runtime-mask Whisper so an old target cannot immediately resurrect it', async () => {
    const runSystemctl = vi.fn(async () => ({ stdout: '', stderr: '' }));
    const result = await reconcileLegacyVoiceServices({ platform: 'linux', runSystemctl, maskWhisper: true });

    expect(result.whisper).toMatchObject({ ok: true, action: 'disabled' });
    expect(runSystemctl).toHaveBeenNthCalledWith(2, ['--user', 'mask', '--runtime', LEGACY_VOICE_UNITS.whisper]);
  });

  it('retires Kokoro too when the in-process fallback is the only owner', async () => {
    const runSystemctl = vi.fn(async () => ({ stdout: '', stderr: '' }));
    const result = await reconcileLegacyVoiceServices({ platform: 'linux', runSystemctl, retireKokoro: true });

    expect(result.kokoro).toMatchObject({ unit: LEGACY_VOICE_UNITS.kokoro, ok: true, action: 'disabled' });
    expect(runSystemctl).toHaveBeenCalledWith(['--user', 'disable', '--now', LEGACY_VOICE_UNITS.kokoro]);
  });

  it('treats an absent unit as an idempotent success', async () => {
    const runSystemctl = vi.fn(async (args: string[]) => {
      throw new Error(`Unit ${args.at(-1)} not loaded`);
    });
    const result = await reconcileLegacyVoiceServices({ platform: 'linux', runSystemctl });

    expect(result.whisper).toMatchObject({ ok: true, action: 'already-absent' });
    expect(result.kokoro).toMatchObject({ ok: true, action: 'retained' });
  });

  it('returns a failed result without throwing when systemctl is unavailable', async () => {
    const runSystemctl = vi.fn(async () => {
      throw new Error('systemctl --user unavailable');
    });
    const result = await reconcileLegacyVoiceServices({ platform: 'linux', runSystemctl });

    expect(result.whisper).toMatchObject({ ok: false, action: 'failed' });
    expect(result.kokoro).toMatchObject({ ok: true, action: 'retained' });
  });
});

