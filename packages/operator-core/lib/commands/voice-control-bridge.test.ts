import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  __resetVoiceControlsForTest,
  loadVoiceControls,
  registerVoiceControlsLoader,
  type VoiceControls,
} from './voice-control-bridge';

afterEach(() => __resetVoiceControlsForTest());

describe('voice-control bridge (injection inversion)', () => {
  it('throws a clear error when no UI loader is registered', async () => {
    await expect(loadVoiceControls()).rejects.toThrow(/loader not registered/i);
  });

  it('returns the registered controls and invokes the loader lazily', async () => {
    const setVoiceMode = vi.fn();
    const controls: VoiceControls = { setVoiceMode };
    const loader = vi.fn(async () => controls);
    registerVoiceControlsLoader(loader);

    // Registration alone must NOT call the loader — it stays lazy until use.
    expect(loader).not.toHaveBeenCalled();

    const got = await loadVoiceControls();
    expect(loader).toHaveBeenCalledTimes(1);
    expect(got).toBe(controls);

    got.setVoiceMode('always-on');
    expect(setVoiceMode).toHaveBeenCalledWith('always-on');
  });

  it('the last registered loader wins', async () => {
    const first: VoiceControls = { setVoiceMode: vi.fn() };
    const second: VoiceControls = { setVoiceMode: vi.fn() };
    registerVoiceControlsLoader(async () => first);
    registerVoiceControlsLoader(async () => second);
    expect(await loadVoiceControls()).toBe(second);
  });
});
