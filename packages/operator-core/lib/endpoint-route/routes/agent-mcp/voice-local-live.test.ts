/**
 * LIVE local voice E2E — kokoro TTS (:8880) + whisper STT (:2022).
 *
 * This is the ONLY test that exercises the real local voice services. Every
 * other TTS/STT test in the tree stubs `fetch`, so they prove the WIRING but
 * would stay green if kokoro's or whisper's real API changed underneath us.
 * This one proves the ASSUMPTIONS (voice-thorough-test-2026-07-09, WI-3527).
 *
 * The centrepiece is the ROUND TRIP: synthesize a known sentence with kokoro,
 * feed those exact bytes to whisper, and require the transcript to come back.
 * That single assertion covers the whole local pipeline end-to-end — the same
 * path the desktop chrome uses (kokoro → speaker; mic → whisper → text).
 *
 * Runs automatically when both services are reachable; SKIPS when they are not
 * (so CI stays green without a GPU). Set `PAPERCUSP_VOICE_LIVE=1` to FORCE it —
 * then an unreachable service is a hard failure instead of a silent skip:
 *
 *   PAPERCUSP_VOICE_LIVE=1 npx vitest run \
 *     lib/endpoint-route/routes/agent-mcp/voice-local-live.test.ts
 */
import { describe, expect, it } from 'vitest';

import { synthesize } from './tts-synth';
import { KOKORO_URL, VOICEMODE_URL, probeKokoroHealth, resolveTtsEngine } from './operator-voice-proxy-helpers';
import { transcribeChunk } from '../../../voice-engines/whisper';
import { DEFAULT_VOICE_PREFS } from '../../../voice-prefs';
import { decodeWavPcm16, resamplePcm16 } from '../../../voice-node/wav';
import { VOICE_FRAME_SAMPLES, VOICE_SAMPLE_RATE } from '../../../voice-node/codec';

const FORCE = process.env.PAPERCUSP_VOICE_LIVE === '1';

async function reachable(url: string): Promise<boolean> {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(2000) });
    return r.ok;
  } catch {
    return false;
  }
}

const kokoroUp = await reachable(`${KOKORO_URL}/health`);
const whisperUp = await reachable(`${VOICEMODE_URL}/health`);
const RUN = FORCE || (kokoroUp && whisperUp);

/** The sentence we speak and expect back. Pangram: broad phoneme coverage. */
const PHRASE = 'the quick brown fox jumps over the lazy dog';

/** Lowercase, strip punctuation, collapse whitespace — STT formatting is not under test. */
const norm = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

function peakOf(samples: Int16Array): number {
  let peak = 0;
  for (const s of samples) peak = Math.max(peak, Math.abs(s));
  return peak;
}

(RUN ? describe : describe.skip)('LIVE local voice pipeline (kokoro + whisper)', () => {
  it('both local services are reachable', () => {
    // With PAPERCUSP_VOICE_LIVE=1 this is the guard that turns a silent skip
    // into a loud failure — "the live suite ran" must mean the services ran.
    expect(kokoroUp, `kokoro unreachable at ${KOKORO_URL}`).toBe(true);
    expect(whisperUp, `whisper unreachable at ${VOICEMODE_URL}`).toBe(true);
  });

  it('probeKokoroHealth() sees the real server', async () => {
    expect(await probeKokoroHealth()).toBe(true);
  });

  it("resolveTtsEngine('browser') falls back to kokoro against the LIVE health probe", async () => {
    // speechSynthesis is meaningless server-side; with kokoro really up it must
    // resolve to kokoro rather than 503.
    const r = await resolveTtsEngine('browser', { ttsEngine: 'browser' }, probeKokoroHealth);
    expect(r).toMatchObject({ ok: true, engine: 'kokoro' });
  });

  it('kokoro synthesizes a real, decodable, non-silent 24kHz mono WAV', async () => {
    const synth = await synthesize('kokoro', PHRASE, undefined, DEFAULT_VOICE_PREFS);
    expect(synth.ok).toBe(true);
    if (!synth.ok) return;
    expect(synth.contentType).toBe('audio/wav');

    const bytes = new Uint8Array(synth.audio);
    expect(String.fromCharCode(...bytes.slice(0, 4))).toBe('RIFF');
    expect(String.fromCharCode(...bytes.slice(8, 12))).toBe('WAVE');

    const decoded = decodeWavPcm16(bytes);
    expect(decoded.sampleRate).toBe(24_000); // kokoro's native rate
    expect(decoded.channels).toBe(1);
    expect(decoded.samples.length).toBeGreaterThan(8_000); // a real ~2s utterance
    expect(peakOf(decoded.samples)).toBeGreaterThan(500); // not silence

    // The exact frame math the p2p say-path (voiceAgentSay) performs.
    const pcm48 = resamplePcm16(decoded.samples, decoded.sampleRate, VOICE_SAMPLE_RATE);
    expect(Math.floor(pcm48.length / VOICE_FRAME_SAMPLES)).toBeGreaterThan(0);
  }, 60_000);

  it('an explicit voiceId really changes the synthesized audio', async () => {
    const [bella, adam] = await Promise.all([
      synthesize('kokoro', 'voice check', 'af_bella', DEFAULT_VOICE_PREFS),
      synthesize('kokoro', 'voice check', 'am_adam', DEFAULT_VOICE_PREFS),
    ]);
    expect(bella.ok && adam.ok).toBe(true);
    if (!bella.ok || !adam.ok) return;
    const a = new Uint8Array(bella.audio);
    const b = new Uint8Array(adam.audio);
    // Different speaker ⇒ different waveform. Compare payload, not just length.
    const same = a.byteLength === b.byteLength && a.every((v, i) => v === b[i]);
    expect(same).toBe(false);
  }, 60_000);

  it('ROUND TRIP: kokoro speaks the phrase → whisper transcribes it back', async () => {
    const synth = await synthesize('kokoro', PHRASE, undefined, DEFAULT_VOICE_PREFS);
    expect(synth.ok).toBe(true);
    if (!synth.ok) return;

    // Exactly what the chrome does: hand the captured audio to transcribeChunk.
    // NB transcribeChunk labels the part `audio.webm` regardless of the real
    // container; whisper sniffs the CONTENT, so a WAV under a .webm name
    // transcribes fine. Pinned here so that quirk can't silently regress.
    const blob = new Blob([synth.audio], { type: 'audio/wav' });
    const transcript = await transcribeChunk(VOICEMODE_URL, blob);

    expect(transcript.length, 'whisper returned an empty transcript').toBeGreaterThan(0);

    const got = norm(transcript);
    expect(got).toContain('quick brown fox');
    expect(got).toContain('lazy dog');

    // Whole-phrase word recall — tolerant of STT punctuation/filler, strict on content.
    const want = norm(PHRASE).split(' ');
    const heard = new Set(got.split(' '));
    const recall = want.filter((w) => heard.has(w)).length / want.length;
    expect(recall, `transcript was: ${JSON.stringify(transcript)}`).toBeGreaterThanOrEqual(0.8);
  }, 90_000);

  it('whisper returns empty string (not a throw) for un-decodable audio', async () => {
    const junk = new Blob([new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])], { type: 'audio/wav' });
    await expect(transcribeChunk(VOICEMODE_URL, junk)).resolves.toBe('');
  }, 30_000);
});
