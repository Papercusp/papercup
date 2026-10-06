import type { Page } from '@playwright/test';

import { expect, test } from './_egress';
import {
  FAKE_MIC_LAUNCH_ARGS,
  REQUIRE_LIVE_VOICE,
  assertLiveVoiceWhenRequired,
  norm,
  prepareLiveVoiceFixtures,
  readVoiceEngineHealth,
  withLocalEnginePrefs,
} from './_voice-live';

/**
 * SYNTHETIC-VOICE ROUND TRIPS through the shipped client voice paths
 * (voice-final-public-release-2026-10-01 D-006). Kokoro speech is played into
 * Chrome's fake microphone and driven through the REAL push-to-talk code
 * (backtick hold → startPttRawCapture → local Whisper → voice state), and the
 * REAL reply-playback code (speak → operator-tts-preview → Audio) is captured
 * and transcribed back. Covered: STT, TTS playback per keyed engine,
 * stop/barge-in cleanup, microphone denial, and STT failure-then-retry.
 *
 * Voice mode stays 'off' during push-to-talk so VoiceAppBridge drops the final
 * utterance: these runs reuse a live operator and must never write into the
 * owner's real conversation thread. Every test asserts that no turn was posted.
 * The brain leg (question → agent reply → spoken) runs on the isolated-DB
 * desktop rig, where writes are safe.
 *
 * Synthetic evidence SUPPLEMENTS the plan's real-microphone bar (D-005); it
 * never substitutes for it.
 *
 *   OPERATOR_E2E_REUSE_SERVER=1 OPERATOR_E2E_BASE_URL=http://127.0.0.1:3170 \
 *     PAPERCUSP_REQUIRE_LIVE_VOICE=1 npx playwright test e2e/voice-synthetic-roundtrip.spec.ts
 */

const live = prepareLiveVoiceFixtures();
assertLiveVoiceWhenRequired(live);

test.use({ permissions: ['microphone'], launchOptions: { args: FAKE_MIC_LAUNCH_ARGS } });

const REPLY = 'Papercup heard you. The synthetic voice check is complete.';

interface VoiceHook {
  setMode(m: 'off' | 'push-to-talk' | 'always-on'): void;
  getState(): { status: string; lastTranscript: string; mode: string };
  lastSilenced(): { reason: string } | null;
  speak(t: string): void;
  cancel(): void;
  ttsEngine(): string | null;
}
type VoiceWindow = Window & { __pcVoiceTest?: VoiceHook; __voiceEvents?: Array<{ phase: string; message: string }> };

/** Install the dev-only voice hook + an event recorder, then open the shell. */
async function openShell(page: Page, opts: { denyMic?: boolean } = {}): Promise<{ postedTurns: string[] }> {
  await page.addInitScript((denyMic) => {
    const w = window as VoiceWindow & { __PAPERCUSP_DEV_WRAPPER__?: boolean };
    w.__PAPERCUSP_DEV_WRAPPER__ = true;
    sessionStorage.setItem('oracle-tutorial-complete', 'true');
    w.__voiceEvents = [];
    window.addEventListener('papercusp:voiceTimeout', (e) => {
      w.__voiceEvents!.push((e as CustomEvent<{ phase: string; message: string }>).detail);
    });
    if (denyMic) {
      navigator.mediaDevices.getUserMedia = () =>
        Promise.reject(new DOMException('Permission denied', 'NotAllowedError'));
    }
  }, opts.denyMic ?? false);
  const postedTurns: string[] = [];
  page.on('request', (r) => {
    if (r.method() === 'POST' && /\/api\/operator\/conversations\/[^/]+\/turns/.test(r.url())) postedTurns.push(r.url());
  });
  await page.goto('/harness');
  await expect(page.getByRole('button', { name: 'Voice mode' })).toBeVisible({ timeout: 60_000 });
  await page.waitForFunction(() => !!(window as VoiceWindow).__pcVoiceTest, undefined, { timeout: 30_000 });
  return { postedTurns };
}

const voice = <T>(page: Page, fn: (hook: VoiceHook) => T) =>
  page.evaluate((src) => {
    // eslint-disable-next-line no-new-func
    return new Function('hook', `return (${src})(hook)`)((window as VoiceWindow).__pcVoiceTest);
  }, fn.toString()) as Promise<T>;

/** Hold the push-to-talk key (Backquote) while the fake mic plays the pangram. */
async function holdToTalk(page: Page, ms = 5_000): Promise<void> {
  await page.keyboard.down('Backquote');
  await page.waitForTimeout(ms);
  await page.keyboard.up('Backquote');
}

const events = (page: Page) => page.evaluate(() => (window as VoiceWindow).__voiceEvents ?? []);

interface CapturedTts { status: number; engine: unknown; text: string; body: Buffer }

/**
 * Capture the exact TTS bytes the reply player receives. `response.body()` from
 * waitForResponse is NOT usable for this route: the reply plays as a streamed
 * media resource and Playwright hands back an EMPTY body (also documented in
 * voice-live-e2e.spec.ts). Rig run 3 on 2026-10-06 decoded those 0 bytes and
 * failed with "EncodingError: Unable to decode audio data". Fulfilling the
 * request from route.fetch() gives the page the same bytes this test keeps.
 */
async function captureNextTtsReply(page: Page, timeoutMs = 60_000): Promise<() => Promise<CapturedTts>> {
  let resolve!: (c: CapturedTts) => void;
  const captured = new Promise<CapturedTts>((r) => { resolve = r; });
  await page.route('**/api/agent-mcp/operator-tts-preview', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    const response = await route.fetch();
    const body = await response.body();
    const sent = JSON.parse(route.request().postData() ?? '{}') as { engine?: unknown; text?: unknown };
    resolve({ status: response.status(), engine: sent.engine, text: String(sent.text ?? ''), body });
    await route.fulfill({ response, body });
  });
  return () => Promise.race([
    captured,
    new Promise<never>((_, reject) => setTimeout(
      () => reject(new Error(`no operator-tts-preview POST within ${timeoutMs}ms`)), timeoutMs,
    )),
  ]);
}

/** Decode reply audio in the browser (any format it can play), re-encode 16k WAV, transcribe. */
async function transcribeInPage(page: Page, audio: Buffer): Promise<{ status: number; text: string }> {
  return page.evaluate(async (b64) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const decoded = await new OfflineAudioContext(1, 1, 16_000).decodeAudioData(bytes.buffer);
    const pcm = decoded.getChannelData(0);
    const out = new DataView(new ArrayBuffer(44 + pcm.length * 2));
    const tag = (o: number, s: string) => { for (let i = 0; i < 4; i++) out.setUint8(o + i, s.charCodeAt(i)); };
    tag(0, 'RIFF'); out.setUint32(4, 36 + pcm.length * 2, true); tag(8, 'WAVE'); tag(12, 'fmt ');
    out.setUint32(16, 16, true); out.setUint16(20, 1, true); out.setUint16(22, 1, true);
    out.setUint32(24, 16_000, true); out.setUint32(28, 32_000, true); out.setUint16(32, 2, true);
    out.setUint16(34, 16, true); tag(36, 'data'); out.setUint32(40, pcm.length * 2, true);
    for (let i = 0; i < pcm.length; i++) {
      const s = Math.max(-1, Math.min(1, pcm[i]));
      out.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    }
    const u8 = new Uint8Array(out.buffer);
    let bin = '';
    for (let i = 0; i < u8.length; i += 0x8000) bin += String.fromCharCode(...u8.subarray(i, i + 0x8000));
    const r = await fetch('/api/agent-mcp/operator-stt', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ audioBase64: btoa(bin), format: 'wav' }),
    });
    const j = (await r.json().catch(() => null)) as { text?: unknown } | null;
    return { status: r.status, text: String(j?.text ?? '') };
  }, audio.toString('base64'));
}

(live ? test.describe : test.describe.skip)('SYNTHETIC voice round trips (D-006)', () => {
  test.describe.configure({ mode: 'serial' }); // shared voice prefs + one local Whisper

  test('push-to-talk: fake-mic speech is transcribed by the real PTT path', async ({ page }) => {
    test.setTimeout(150_000);
    await withLocalEnginePrefs(page, async () => {
      const { postedTurns } = await openShell(page);
      await voice(page, (h) => h.setMode('off'));
      await holdToTalk(page);
      await expect.poll(async () => norm((await voice(page, (h) => h.getState())).lastTranscript), {
        timeout: 60_000,
      }).toContain('quick brown fox');
      expect(norm((await voice(page, (h) => h.getState())).lastTranscript)).toContain('lazy dog');
      expect((await events(page)).filter((e) => e.phase === 'no-audio' || e.phase === 'transcript')).toEqual([]);
      expect(postedTurns, 'PTT in mode off must not write a conversation turn').toEqual([]);
    });
  });

  for (const engine of ['kokoro', 'elevenlabs'] as const) {
    test(`reply playback (${engine}): speak() plays audio that transcribes back to the reply`, async ({ page }) => {
      test.setTimeout(150_000);
      if (engine === 'elevenlabs' && readVoiceEngineHealth()?.elevenlabs !== true) {
        // Fails a release-acceptance run, where ElevenLabs TTS is in scope (D-006).
        expect(REQUIRE_LIVE_VOICE, 'ElevenLabs TTS is in release scope but not healthy').toBe(false);
        test.skip(true, 'ElevenLabs is not keyed on this operator');
      }
      await withLocalEnginePrefs(page, async () => {
        const { postedTurns } = await openShell(page);
        await voice(page, (h) => h.setMode('push-to-talk'));
        // Wait for the prefs sync to deliver the engine to the client before speaking.
        await expect.poll(() => voice(page, (h) => h.ttsEngine()), { timeout: 30_000 }).toBe(engine);
        const nextReply = await captureNextTtsReply(page);
        await page.evaluate((t) => (window as VoiceWindow).__pcVoiceTest!.speak(t), REPLY);
        const reply = await nextReply();
        expect(reply.status).toBe(200);
        expect(reply.engine).toBe(engine);
        expect(reply.body.length, 'captured TTS reply bytes').toBeGreaterThan(1_000);
        // The client really played it, rather than one of speak()'s silent gates.
        await expect.poll(async () => (await voice(page, (h) => h.getState())).status, { timeout: 30_000 })
          .toBe('speaking');
        const heard = await transcribeInPage(page, reply.body);
        expect(heard.status).toBe(200);
        expect(norm(heard.text), `whisper heard: ${JSON.stringify(heard.text)}`).toContain('synthetic voice');
        await expect.poll(async () => (await voice(page, (h) => h.getState())).status, { timeout: 60_000 })
          .not.toBe('speaking');
        expect((await events(page)).filter((e) => e.phase === 'playback')).toEqual([]);
        expect(postedTurns).toEqual([]);
      }, { ttsEngine: engine });
    });
  }

  test('stop: cancelling mid-reply ends playback and stays stopped', async ({ page }) => {
    test.setTimeout(120_000);
    await withLocalEnginePrefs(page, async () => {
      await openShell(page);
      await voice(page, (h) => h.setMode('push-to-talk'));
      await page.evaluate((t) => (window as VoiceWindow).__pcVoiceTest!.speak(t), `${REPLY} `.repeat(6));
      await expect.poll(async () => (await voice(page, (h) => h.getState())).status, { timeout: 60_000 })
        .toBe('speaking');
      await voice(page, (h) => h.cancel());
      await expect.poll(async () => (await voice(page, (h) => h.getState())).status, { timeout: 2_000 })
        .not.toBe('speaking');
      await page.waitForTimeout(3_000); // a queued or still-playing clip must not resurrect it
      expect((await voice(page, (h) => h.getState())).status).not.toBe('speaking');
    });
  });

  test('denial: a blocked microphone names the permission problem', async ({ page }) => {
    test.setTimeout(90_000);
    await withLocalEnginePrefs(page, async () => {
      const whisperCalls: string[] = [];
      page.on('request', (r) => { if (r.url().includes('/v1/audio/transcriptions')) whisperCalls.push(r.url()); });
      const { postedTurns } = await openShell(page, { denyMic: true });
      await voice(page, (h) => h.setMode('off'));
      await holdToTalk(page, 1_500);
      await expect.poll(async () => (await events(page)).find((e) => e.phase === 'no-audio')?.message ?? '', {
        timeout: 15_000,
      }).toMatch(/Microphone access is blocked/);
      expect(whisperCalls).toEqual([]);
      expect(postedTurns).toEqual([]);
    });
  });

  test('retry: an STT failure says so, and the next hold transcribes', async ({ page }) => {
    test.setTimeout(180_000);
    await withLocalEnginePrefs(page, async () => {
      let failNext = true;
      await page.route(/\/v1\/audio\/transcriptions/, async (route) => {
        if (failNext) {
          failNext = false;
          await route.fulfill({ status: 500, body: 'synthetic outage' });
          return;
        }
        await route.continue();
      });
      const { postedTurns } = await openShell(page);
      await voice(page, (h) => h.setMode('off'));
      await holdToTalk(page);
      await expect.poll(async () => (await events(page)).some((e) => e.phase === 'transcript'), { timeout: 30_000 })
        .toBe(true);
      expect((await voice(page, (h) => h.getState())).lastTranscript).toBe('');
      await holdToTalk(page);
      await expect.poll(async () => norm((await voice(page, (h) => h.getState())).lastTranscript), {
        timeout: 60_000,
      }).toContain('quick brown fox');
      expect(postedTurns).toEqual([]);
    });
  });

  // The brain leg: question (fake mic) → PTT → STT → posted turn → agent reply →
  // spoken reply. It writes a real conversation turn, so it runs only on the
  // isolated-DB desktop rig (verify-tauri-headless VERIFY_TAURI_ISOLATED_DB=1).
  test('brain: a spoken question is posted, answered by the agent, and the answer is spoken', async ({ page }) => {
    test.skip(process.env.PAPERCUSP_VERIFY_TAURI_ISOLATED !== '1',
      'writes a real conversation turn: isolated-DB desktop rig only');
    test.setTimeout(330_000);
    await withLocalEnginePrefs(page, async () => {
      const { postedTurns } = await openShell(page);
      await voice(page, (h) => h.setMode('push-to-talk'));
      const nextReply = await captureNextTtsReply(page, 240_000);
      await holdToTalk(page);
      await expect.poll(() => postedTurns.length, { timeout: 60_000, message: 'the spoken question was posted as a turn' })
        .toBeGreaterThan(0);
      const reply = await nextReply();
      expect(reply.status).toBe(200);
      expect(reply.text.length, 'the agent reply sent to TTS').toBeGreaterThan(0);
      expect(reply.text).not.toBe(REPLY);
      expect(reply.body.length, 'captured TTS reply bytes').toBeGreaterThan(1_000);
      const heard = await transcribeInPage(page, reply.body);
      expect(heard.status).toBe(200);
      const sentWords = new Set(norm(reply.text).split(' ').filter((w) => w.length > 3));
      const matched = norm(heard.text).split(' ').filter((w) => sentWords.has(w));
      expect(matched.length, `reply sent to TTS: ${JSON.stringify(reply.text)}; whisper heard: ${JSON.stringify(heard.text)}`)
        .toBeGreaterThanOrEqual(Math.min(2, sentWords.size));
      expect((await events(page)).filter((e) => e.phase === 'playback')).toEqual([]);
    });
  });
});
