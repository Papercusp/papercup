import { describe, it, expect } from 'vitest';
import { mergeUserOverWorkspace, VOICE_USER_OVERRIDE_KEYS } from './user-preferences';
import { DEFAULT_VOICE_PREFS } from './voice-prefs';

describe('mergeUserOverWorkspace', () => {
  const KEYS = ['fullAgentIdleTimeoutMin', 'operatorActiveOnStartup', 'agentLanguage'] as const;

  it('returns workspace prefs unchanged when user has no overrides', () => {
    const workspace = { fullAgentIdleTimeoutMin: 5, operatorActiveOnStartup: true, agentLanguage: 'en' };
    const merged = mergeUserOverWorkspace(workspace, {}, KEYS);
    expect(merged).toEqual(workspace);
  });

  it('overrides workspace value when user has a value set', () => {
    const workspace = { fullAgentIdleTimeoutMin: 5, operatorActiveOnStartup: true, agentLanguage: 'en' };
    const user = { fullAgentIdleTimeoutMin: 2 };
    const merged = mergeUserOverWorkspace(workspace, user, KEYS);
    expect(merged.fullAgentIdleTimeoutMin).toBe(2);
    expect(merged.operatorActiveOnStartup).toBe(true);
    expect(merged.agentLanguage).toBe('en');
  });

  it('treats null as "not set" — falls through to workspace', () => {
    const workspace = { fullAgentIdleTimeoutMin: 5, operatorActiveOnStartup: true, agentLanguage: 'en' };
    const user = { fullAgentIdleTimeoutMin: null };
    const merged = mergeUserOverWorkspace(workspace, user, KEYS);
    expect(merged.fullAgentIdleTimeoutMin).toBe(5);
  });

  it('treats undefined as "not set" — falls through to workspace', () => {
    const workspace = { fullAgentIdleTimeoutMin: 5, operatorActiveOnStartup: true, agentLanguage: 'en' };
    const user = { fullAgentIdleTimeoutMin: undefined };
    const merged = mergeUserOverWorkspace(workspace, user, KEYS);
    expect(merged.fullAgentIdleTimeoutMin).toBe(5);
  });

  it('ignores user-pref keys not in overrideKeys allowlist', () => {
    const workspace = { fullAgentIdleTimeoutMin: 5 };
    const user = { fullAgentIdleTimeoutMin: 2, someOtherKey: 'should-be-ignored' };
    const merged = mergeUserOverWorkspace(workspace, user, ['fullAgentIdleTimeoutMin'] as const);
    expect(merged.fullAgentIdleTimeoutMin).toBe(2);
    expect((merged as Record<string, unknown>).someOtherKey).toBeUndefined();
  });

  it('overrides multiple keys when set', () => {
    const workspace = { fullAgentIdleTimeoutMin: 5, operatorActiveOnStartup: true, agentLanguage: 'en' };
    const user = { fullAgentIdleTimeoutMin: 2, operatorActiveOnStartup: false };
    const merged = mergeUserOverWorkspace(workspace, user, KEYS);
    expect(merged.fullAgentIdleTimeoutMin).toBe(2);
    expect(merged.operatorActiveOnStartup).toBe(false);
    expect(merged.agentLanguage).toBe('en');
  });

  it('preserves non-override workspace keys', () => {
    const workspace = { fullAgentIdleTimeoutMin: 5, monthlyCap: 600 };
    const user = { fullAgentIdleTimeoutMin: 2, monthlyCap: 9999 /* user can't override this */ };
    const merged = mergeUserOverWorkspace(workspace, user, ['fullAgentIdleTimeoutMin'] as const);
    expect(merged.fullAgentIdleTimeoutMin).toBe(2);
    expect((merged as { monthlyCap: number }).monthlyCap).toBe(600);
  });

  it('false (bool) is honored as an override (not "not set")', () => {
    // Edge case: a user wants to explicitly set operatorActiveOnStartup
    // to false even though workspace default is true. The current rule
    // says "null/undefined = not set". `false` is a real value.
    const workspace = { fullAgentIdleTimeoutMin: 5, operatorActiveOnStartup: true, agentLanguage: 'en' };
    const user = { operatorActiveOnStartup: false };
    const merged = mergeUserOverWorkspace(workspace, user, KEYS);
    expect(merged.operatorActiveOnStartup).toBe(false);
  });

  it('0 (number) is honored as an override (not "not set")', () => {
    // Edge case similar to false. A user setting idle=0 explicitly
    // (never auto-disconnect) should not fall through to workspace default.
    const workspace = { fullAgentIdleTimeoutMin: 5, operatorActiveOnStartup: true, agentLanguage: 'en' };
    const user = { fullAgentIdleTimeoutMin: 0 };
    const merged = mergeUserOverWorkspace(workspace, user, KEYS);
    expect(merged.fullAgentIdleTimeoutMin).toBe(0);
  });

  it('empty string ("") is honored as an override (caller decides validity)', () => {
    // The merge function does not interpret semantics — empty-string
    // override is the user's responsibility. Validation lives in the
    // saveUserPreferences route + tool args, not here.
    const workspace = { fullAgentIdleTimeoutMin: 5, operatorActiveOnStartup: true, agentLanguage: 'en' };
    const user = { agentLanguage: '' };
    const merged = mergeUserOverWorkspace(workspace, user, KEYS);
    expect(merged.agentLanguage).toBe('');
  });
});

describe('VOICE_USER_OVERRIDE_KEYS', () => {
  it('includes the documented voice/operator override keys', () => {
    // If this list changes, /settings/user/page.tsx and the user-prefs
    // resolver in voice-prefs.ts both need to track it. Snapshot to
    // catch accidental drift.
    expect(VOICE_USER_OVERRIDE_KEYS).toEqual([
      'agentLanguage',
      'elevenlabsVoiceId',
      'porcupineKeyword',
      'openwakewordKeyword',
      'voiceMaxSpokenWords',
      'fullAgentIdleTimeoutMin',
      'fullAgentSessionMaxMin',
      'operatorHistoryTokenBudget',
      'operatorContextMode',
      'operatorActiveOnStartup',
      'voicePrivacyMode',
      'speakSuggestions',
      'speakModeFlips',
      'speakCadenceStatus',
      'audienceMode',
      'proactiveTicksEnabled',
      'silenceVoice',
      'operatorBackstoryEnabled',
      'memoryEmbedderMode',
      'humanFacingRole',
    ]);
  });

  it('contains no duplicates', () => {
    expect(new Set(VOICE_USER_OVERRIDE_KEYS).size).toBe(VOICE_USER_OVERRIDE_KEYS.length);
  });

  // RECURRENCE GUARD (settings-audit 2026-07-09). The module doc states the
  // invariant "Each key MUST also exist in the workspace-level VoicePrefs schema
  // so the fallback works" — but nothing enforced it, so `wakeWordKeyword` sat in
  // this list for months as a PHANTOM: not a VoicePrefs field, happily copied onto
  // the merged object by mergeLayered, and read by nobody. The /settings/user "Wake
  // word" input therefore did nothing at all. TypeScript cannot catch this (the list
  // is a plain string tuple), so assert it here instead of trusting the comment.
  it('every override key exists in the workspace VoicePrefs schema', () => {
    const schemaKeys = new Set(Object.keys(DEFAULT_VOICE_PREFS));
    const phantoms = VOICE_USER_OVERRIDE_KEYS.filter((k) => !schemaKeys.has(k));
    expect(phantoms).toEqual([]);
  });
});
