/**
 * LIVE ElevenLabs synth verification (B1, offsite-planner demo narrator voice).
 *
 * OPT-IN — runs only when `PAPERCUSP_EL_LIVE=1` AND an ElevenLabs key is present
 * (env `ELEVENLABS_API_KEY`); otherwise the whole describe is SKIPPED — no
 * network, no spend, safe in CI. Run it with:
 *
 *   PAPERCUSP_EL_LIVE=1 npx vitest run \
 *     lib/endpoint-route/routes/agent-mcp/operator-tts-elevenlabs-live.test.ts
 *
 * Why it exists: B1's fix assumes ElevenLabs `output_format=pcm_24000` returns
 * raw little-endian PCM16 @ 24kHz that, once wrapped into a RIFF/WAVE, decodes
 * cleanly and yields >0 paced channel frames (voiceAgentSay). The mocked unit
 * tests prove the WIRING; this proves that ASSUMPTION against the real API +
 * the real key. It exercises the real `synthesize()` elevenlabs+wav branch and
 * the real `decodeWavPcm16` — only the key SOURCE is mocked (prod reads it from
 * PG via readElevenLabsKey; on the demo box it's an env export).
 */
import { afterAll, describe, expect, it, vi } from 'vitest';
import { DEFAULT_VOICE_PREFS } from '../../../voice-prefs';
import { decodeWavPcm16, resamplePcm16 } from '../../../voice-node/wav';
import { VOICE_FRAME_SAMPLES, VOICE_SAMPLE_RATE } from '../../../voice-node/codec';

// Source the EL key from env for this live run (synthesize reads it from PG via
// readElevenLabsKey). Everything else in synthesize runs for real.
vi.mock('../../../voice-credentials', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../../voice-credentials')>();
  return {
    ...orig,
    readElevenLabsKey: vi.fn(async () => process.env.ELEVENLABS_API_KEY ?? null),
  };
});

import { synthesize } from './operator-tts';

const RUN = process.env.PAPERCUSP_EL_LIVE === '1' && !!process.env.ELEVENLABS_API_KEY;

(RUN ? describe : describe.skip)('LIVE ElevenLabs synth (opt-in)', () => {
  afterAll(() => vi.restoreAllMocks());

  it("container:'wav' → real pcm_24000 → decodable 24k WAV → frames>0", async () => {
    const synth = await synthesize(
      'elevenlabs',
      'Testing the narrator voice for the offsite planner demo, one two three.',
      undefined,
      DEFAULT_VOICE_PREFS, // elevenlabsVoiceId default = Adam 21m00Tcm4TlvDq8ikWAM
      { container: 'wav' },
    );
    expect(synth.ok).toBe(true);
    if (!synth.ok) return;
    expect(synth.contentType).toBe('audio/wav');

    // The bytes the channel say-path would decode — must be a real RIFF/WAVE.
    const decoded = decodeWavPcm16(new Uint8Array(synth.audio));
    expect(decoded.sampleRate).toBe(24_000);
    expect(decoded.channels).toBe(1);
    // A real ~1s+ utterance → many thousands of samples.
    expect(decoded.samples.length).toBeGreaterThan(8_000);
    // Non-silent: a real voice has substantial peak amplitude.
    let peak = 0;
    for (const s of decoded.samples) peak = Math.max(peak, Math.abs(s));
    expect(peak).toBeGreaterThan(500);

    // The exact frame math voiceAgentSay does → frames>0 (the brief's accept).
    const pcm48 = resamplePcm16(decoded.samples, decoded.sampleRate, VOICE_SAMPLE_RATE);
    const frames = Math.floor(pcm48.length / VOICE_FRAME_SAMPLES);
    expect(frames).toBeGreaterThan(0);
  }, 40_000);
});
