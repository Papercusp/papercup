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

  // WI-934065. The test that used to live here asserted only that the mask
  // COMMAND was ISSUED — the same mistake, one level down, as the acceptance
  // criterion that passed this host while the unit was startable: it confirmed
  // wiring and called it protection. Measured on systemd 255, `mask --runtime`
  // exits 0 and prints "Created symlink" while the unit stays fully startable,
  // because the mask lands in /run/user/$UID/systemd/user (unit-path rank 9)
  // and the legacy fragment sits in ~/.config/systemd/user (rank 5). Nothing
  // throws, so no exit-code check can catch it. These pin the READBACK.
  const maskingSystemctl = (loadState: string) =>
    vi.fn(async (args: string[]) => ({
      stdout: args.includes('LoadState') ? `${loadState}\n` : '',
      stderr: '',
    }));

  it('reports masked ONLY when systemd confirms LoadState=masked', async () => {
    const runSystemctl = maskingSystemctl('masked');
    const result = await reconcileLegacyVoiceServices({ platform: 'linux', runSystemctl, maskWhisper: true });

    expect(result.whisper).toMatchObject({
      ok: true,
      action: 'disabled',
      masked: true,
      maskVerification: { loadState: 'masked', effective: true },
    });
    expect(runSystemctl).toHaveBeenNthCalledWith(2, ['--user', 'mask', '--runtime', LEGACY_VOICE_UNITS.whisper]);
    expect(runSystemctl).toHaveBeenNthCalledWith(3, [
      '--user', 'show', LEGACY_VOICE_UNITS.whisper, '-p', 'LoadState', '--value',
    ]);
  });

  it('does NOT claim masked when systemctl succeeds but the unit is still loaded', async () => {
    // The real failure: exit 0, symlink created, unit still startable.
    const runSystemctl = maskingSystemctl('loaded');
    const result = await reconcileLegacyVoiceServices({ platform: 'linux', runSystemctl, maskWhisper: true });

    expect(result.whisper.masked).toBe(false);
    expect(result.whisper.maskVerification).toEqual({ loadState: 'loaded', effective: false });
    // The detail must say the host is unprotected — a health surface reading
    // only `ok` would otherwise go green over a unit anyone can start.
    expect(result.whisper.detail).toMatch(/DID NOT TAKE EFFECT/);
    expect(result.whisper.detail).toMatch(/still startable/);
    // …and it must name the cause, so the reader is not left to rediscover the
    // unit-path precedence rule the hard way.
    expect(result.whisper.detail).toMatch(/higher-precedence/);
  });

  it('treats an unreadable LoadState as unverified rather than as success', async () => {
    const runSystemctl = vi.fn(async (args: string[]) => {
      if (args.includes('LoadState')) throw new Error('systemctl show failed');
      return { stdout: '', stderr: '' };
    });
    const result = await reconcileLegacyVoiceServices({ platform: 'linux', runSystemctl, maskWhisper: true });

    expect(result.whisper.masked).toBe(false);
    expect(result.whisper.maskVerification).toEqual({ loadState: 'unknown', effective: false });
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

