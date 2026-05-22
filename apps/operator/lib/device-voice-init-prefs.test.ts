import { describe, expect, it } from 'vitest';

import { resolveVoiceInit, type VoicePrefsSubset } from './device-voice-init-prefs';

const defaultPrefs: VoicePrefsSubset = {
  fullAgentVoiceMode: 'continuous',
  fullAgentIdleTimeoutMin: 2,
  fullAgentSessionMaxMin: 30,
};

describe('resolveVoiceInit — mode resolution', () => {
  it('uses query mode when valid', () => {
    expect(resolveVoiceInit({ mode: 'hybrid' }, defaultPrefs).voiceMode).toBe('hybrid');
    expect(resolveVoiceInit({ mode: 'single-utterance' }, defaultPrefs).voiceMode).toBe('single-utterance');
    expect(resolveVoiceInit({ mode: 'continuous' }, defaultPrefs).voiceMode).toBe('continuous');
  });
  it('falls back to prefs when mode missing', () => {
    expect(resolveVoiceInit({}, defaultPrefs).voiceMode).toBe('continuous');
    expect(resolveVoiceInit({}, { ...defaultPrefs, fullAgentVoiceMode: 'hybrid' }).voiceMode).toBe('hybrid');
  });
  it('falls back to prefs when mode is empty string', () => {
    expect(resolveVoiceInit({ mode: '' }, defaultPrefs).voiceMode).toBe('continuous');
  });
  it('rejects unknown mode values and falls back', () => {
    expect(resolveVoiceInit({ mode: 'garbage' }, defaultPrefs).voiceMode).toBe('continuous');
    expect(resolveVoiceInit({ mode: 'Continuous' }, defaultPrefs).voiceMode).toBe('continuous');
    expect(resolveVoiceInit({ mode: 'half-duplex' }, defaultPrefs).voiceMode).toBe('continuous');
  });
});

describe('resolveVoiceInit — idleTimeoutMin', () => {
  it('uses query idleMin when valid', () => {
    expect(resolveVoiceInit({ idleMin: '5' }, defaultPrefs).idleTimeoutMin).toBe(5);
    expect(resolveVoiceInit({ idleMin: '0' }, defaultPrefs).idleTimeoutMin).toBe(0);
  });
  it('falls back to prefs when missing', () => {
    expect(resolveVoiceInit({}, defaultPrefs).idleTimeoutMin).toBe(2);
  });
  it('falls back to prefs when negative or NaN', () => {
    expect(resolveVoiceInit({ idleMin: '-1' }, defaultPrefs).idleTimeoutMin).toBe(2);
    expect(resolveVoiceInit({ idleMin: 'abc' }, defaultPrefs).idleTimeoutMin).toBe(2);
    expect(resolveVoiceInit({ idleMin: '' }, defaultPrefs).idleTimeoutMin).toBe(2);
  });
});

describe('resolveVoiceInit — sessionMaxMin', () => {
  it('uses query sessionMaxMin when valid', () => {
    expect(resolveVoiceInit({ sessionMaxMin: '15' }, defaultPrefs).sessionMaxMin).toBe(15);
    expect(resolveVoiceInit({ sessionMaxMin: '0' }, defaultPrefs).sessionMaxMin).toBe(0);
  });
  it('falls back to prefs', () => {
    expect(resolveVoiceInit({}, defaultPrefs).sessionMaxMin).toBe(30);
  });
});

describe('resolveVoiceInit — single-utterance clamp', () => {
  it('forces idle to ≤1 even if query asks for more', () => {
    const r = resolveVoiceInit(
      { mode: 'single-utterance', idleMin: '5' },
      defaultPrefs,
    );
    expect(r.voiceMode).toBe('single-utterance');
    expect(r.idleTimeoutMin).toBe(1);
  });
  it('bumps idle=0 up to 1 in single-utterance (otherwise session never ends)', () => {
    const r = resolveVoiceInit(
      { mode: 'single-utterance', idleMin: '0' },
      defaultPrefs,
    );
    expect(r.idleTimeoutMin).toBe(1);
  });
  it('does not affect continuous mode', () => {
    expect(resolveVoiceInit({ mode: 'continuous', idleMin: '5' }, defaultPrefs).idleTimeoutMin).toBe(5);
  });
  it('does not clamp sessionMax — only idle', () => {
    const r = resolveVoiceInit(
      { mode: 'single-utterance', sessionMaxMin: '30' },
      defaultPrefs,
    );
    expect(r.sessionMaxMin).toBe(30);
  });
});

describe('resolveVoiceInit — full combinations', () => {
  it('all three query params override prefs', () => {
    const r = resolveVoiceInit(
      { mode: 'hybrid', idleMin: '7', sessionMaxMin: '20' },
      defaultPrefs,
    );
    expect(r).toEqual({
      voiceMode: 'hybrid',
      idleTimeoutMin: 7,
      sessionMaxMin: 20,
    });
  });
  it('prefs apply when no query params', () => {
    const r = resolveVoiceInit(
      {},
      { fullAgentVoiceMode: 'hybrid', fullAgentIdleTimeoutMin: 3, fullAgentSessionMaxMin: 45 },
    );
    expect(r).toEqual({
      voiceMode: 'hybrid',
      idleTimeoutMin: 3,
      sessionMaxMin: 45,
    });
  });
});
