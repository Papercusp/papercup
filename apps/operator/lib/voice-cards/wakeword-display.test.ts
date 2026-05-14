import { describe, expect, it } from 'vitest';

import { DEFAULT_VOICE_PREFS } from '../voice-prefs';
import type { VoicePrefs } from '../voice-prefs';

import { getConfiguredWakeWordForDisplay } from './wakeword-display';

function withPrefs(overrides: Partial<VoicePrefs>): VoicePrefs {
  return { ...DEFAULT_VOICE_PREFS, ...overrides };
}

describe('getConfiguredWakeWordForDisplay', () => {
  it('returns null when wakeWordEngine is off', () => {
    expect(
      getConfiguredWakeWordForDisplay(withPrefs({ wakeWordEngine: 'off' })),
    ).toBeNull();
  });

  it('lowercases Porcupine keywords', () => {
    expect(
      getConfiguredWakeWordForDisplay(
        withPrefs({ wakeWordEngine: 'porcupine', porcupineKeyword: 'Computer' }),
      ),
    ).toBe('computer');
    expect(
      getConfiguredWakeWordForDisplay(
        withPrefs({ wakeWordEngine: 'porcupine', porcupineKeyword: 'Hey Google' }),
      ),
    ).toBe('hey google');
    expect(
      getConfiguredWakeWordForDisplay(
        withPrefs({ wakeWordEngine: 'porcupine', porcupineKeyword: 'Jarvis' }),
      ),
    ).toBe('jarvis');
  });

  it('replaces underscores with spaces for openWakeWord keywords', () => {
    expect(
      getConfiguredWakeWordForDisplay(
        withPrefs({ wakeWordEngine: 'openwakeword', openwakewordKeyword: 'hey_jarvis' }),
      ),
    ).toBe('hey jarvis');
    expect(
      getConfiguredWakeWordForDisplay(
        withPrefs({ wakeWordEngine: 'openwakeword', openwakewordKeyword: 'ok_nabu' }),
      ),
    ).toBe('ok nabu');
    expect(
      getConfiguredWakeWordForDisplay(
        withPrefs({ wakeWordEngine: 'openwakeword', openwakewordKeyword: 'alexa' }),
      ),
    ).toBe('alexa');
  });

  it('Hey Siri/Hey Google multi-word Porcupine keywords stay readable', () => {
    expect(
      getConfiguredWakeWordForDisplay(
        withPrefs({ wakeWordEngine: 'porcupine', porcupineKeyword: 'Hey Siri' }),
      ),
    ).toBe('hey siri');
    expect(
      getConfiguredWakeWordForDisplay(
        withPrefs({ wakeWordEngine: 'porcupine', porcupineKeyword: 'Okay Google' }),
      ),
    ).toBe('okay google');
  });
});
