import { describe, expect, it } from 'vitest';
import { DEFAULT_VOICE_PREFS } from './voice-prefs';

// voice-prefs.ts moved from `<papercuspRoot>/system/operator/voice-prefs.json`
// to `harness_shared.operator_voice_prefs` (PG, migration 020) so the
// previous file-mocking tests don't apply. The PG-backed read/save path is
// covered by integration smoke tests in scripts (insert + GET round-trip);
// the pure-logic mergePrefs() helper is internal and not separately tested.
//
// If we want a unit test for voice-prefs again, the right shape is a mock
// of @papercusp/db-org's getOrgPg() with an in-memory tagged-template handler
// that records the SQL call and returns the canned row. That's a heavier
// scaffold than this module needed previously and isn't reused yet.

describe('voice-prefs (PG-backed)', () => {
  it.skip('migrated to PG — see operator-state-pg.ts smoke tests', () => {
    // intentionally empty — see comment above.
  });
});

// P2P voice-channel settings (holepunch-voice-channels-2026-06-05 P-016/D-008):
// the defaults ARE the contract the Voice Settings views render before any user
// write — pin them so a rename/retype breaks loudly here, not in a UI.
describe('voice-channel settings defaults (P-016)', () => {
  it('ships complete channel-voice defaults', () => {
    expect(DEFAULT_VOICE_PREFS).toMatchObject({
      voiceInputDevice: null,
      voiceOutputDevice: null,
      voiceInputMode: 'ptt',
      // Backtick is the real PTT key (hardcoded + reserved in VoiceButton); the
      // default mirrors it so prefs inspection isn't misled by a stale 'v'.
      voicePttKey: '`',
      voiceAec: true,
      voiceNoiseSuppression: true,
      voiceInputGain: 1,
      voiceOutputVolume: 1,
    });
  });

  it('keeps PTT (not open-mic) as the default — open-mic requires AEC hardening (P-010)', () => {
    expect(DEFAULT_VOICE_PREFS.voiceInputMode).toBe('ptt');
  });
});

// WI-3664: "keep local the default". The default embedder is the local BGE-ONNX
// engine, NOT 'auto' — 'auto' can pick the cloud key and thrashes on it (WI-3615),
// and @huggingface/transformers is a hard dependency so 'local' is always usable.
describe('embedder default (WI-3664 → EmbeddingGemma 2026-07-10)', () => {
  it('defaults memoryEmbedderMode to gemma (EmbeddingGemma-300m), the local default', () => {
    // Owner ask 2026-07-10: EmbeddingGemma-300m is the default local embedder
    // (a quality upgrade over BGE 'local', still fully local). Not 'auto' (which
    // would key-thrash, WI-3615) and not the cloud 'openai'.
    expect(DEFAULT_VOICE_PREFS.memoryEmbedderMode).toBe('gemma');
  });

  it('keeps the provider ack voice by default (P-002 — no behavior change)', () => {
    expect(DEFAULT_VOICE_PREFS.fullAgentAckVoice).toBe('provider');
  });
});
