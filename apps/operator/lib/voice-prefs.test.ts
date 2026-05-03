import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmpRoot = mkdtempSync(join(tmpdir(), 'voice-prefs-'));
vi.mock('./papercusp-root', () => ({
  papercuspPath: (...parts: string[]) => join(tmpRoot, ...parts),
}));

import { loadVoicePrefs, saveVoicePrefs, DEFAULT_VOICE_PREFS } from './voice-prefs';

const PATH = join(tmpRoot, 'system', 'operator', 'voice-prefs.json');

beforeEach(() => {
  try { rmSync(PATH); } catch {}
});
afterEach(() => {
  try { rmSync(PATH); } catch {}
});

describe('voice-prefs', () => {
  it('returns defaults when file is missing', () => {
    expect(loadVoicePrefs()).toEqual(DEFAULT_VOICE_PREFS);
  });

  it('returns defaults on corrupt JSON', () => {
    mkdirSync(join(tmpRoot, 'system', 'operator'), { recursive: true });
    writeFileSync(PATH, '{not json');
    expect(loadVoicePrefs()).toEqual(DEFAULT_VOICE_PREFS);
  });

  it('round-trips a partial save', () => {
    saveVoicePrefs({ ttsEngine: 'elevenlabs', speakNudges: false });
    const loaded = loadVoicePrefs();
    expect(loaded.ttsEngine).toBe('elevenlabs');
    expect(loaded.speakNudges).toBe(false);
    expect(loaded.speakSuggestions).toBe(true); // unchanged default preserved
  });

  it('merges newly-added fields with defaults from older files', () => {
    mkdirSync(join(tmpRoot, 'system', 'operator'), { recursive: true });
    writeFileSync(PATH, JSON.stringify({ ttsEngine: 'browser' })); // missing every other field
    const loaded = loadVoicePrefs();
    expect(loaded.ttsEngine).toBe('browser');
    expect(loaded.kokoroSlowSuggestionDismissed).toBe(false); // default applied
    expect(loaded.nudgeDedup.budget.lastSpokenAt).toBeNull();
  });

  it('partial nudgeDedup patch preserves other kinds', () => {
    saveVoicePrefs({ nudgeDedup: { budget: { lastSpokenAt: '2026-05-02T10:00:00Z' } } as any });
    const loaded = loadVoicePrefs();
    expect(loaded.nudgeDedup.budget.lastSpokenAt).toBe('2026-05-02T10:00:00Z');
    expect(loaded.nudgeDedup.breaker.lastSpokenAt).toBeNull();
    expect(loaded.nudgeDedup.pause.lastSpokenAt).toBeNull();
  });
});
