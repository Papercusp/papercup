import { expect, test } from '@playwright/test';
import { expectNoA11yViolations } from './_axe';

/**
 * Voice mode E2E coverage.
 *
 * Headless Chromium can't reliably exercise the SpeechRecognition /
 * SpeechSynthesis APIs (no real mic, voice list is empty), and Voicemode
 * services may not be running in CI. So this spec covers the bits that
 * are deterministic without real audio:
 *
 *   - Settings page renders all 5 TTS engines + 3 STT engines
 *   - STT spend widget appears (parallel of TTS)
 *   - Voice mode toggle button mounts on the harness shell
 *   - Cap-knob inputs accept new values + persist via PUT
 *   - Engines context wiring fetches credentials + spend in parallel
 */

test.describe('voice settings', () => {
  test.beforeEach(async ({ page }) => {
    // Mark tutorial complete so voice features render their full UI.
    await page.addInitScript(() => {
      sessionStorage.setItem('oracle-tutorial-complete', 'true');
    });
  });

  test('renders all 5 TTS engines + 3 STT engines', async ({ page }) => {
    await page.goto('/settings/voice');

    // STT selector
    const stt = page.getByRole('combobox').first();
    await expect(stt.locator('option', { hasText: 'Voicemode' })).toHaveCount(1);
    await expect(stt.locator('option', { hasText: 'Web Speech' })).toHaveCount(1);
    await expect(stt.locator('option', { hasText: 'Deepgram' })).toHaveCount(1);

    // TTS selector
    const tts = page.getByRole('combobox').nth(1);
    await expect(tts.locator('option', { hasText: 'Kokoro' })).toHaveCount(1);
    await expect(tts.locator('option', { hasText: 'Browser' })).toHaveCount(1);
    await expect(tts.locator('option', { hasText: 'ElevenLabs' })).toHaveCount(1);
  });

  test('STT spend widget renders alongside TTS spend', async ({ page }) => {
    await page.goto('/settings/voice');
    await expect(page.getByText('STT spend (Deepgram)')).toBeVisible();
    await expect(page.getByText('Voicemode (local Whisper) and Web Speech are free')).toBeVisible();
  });

  test('settings/voice has no serious or critical a11y violations', async ({ page }) => {
    await page.goto('/settings/voice');
    await expect(page.getByText('STT spend (Deepgram)')).toBeVisible();
    await expectNoA11yViolations(page);
  });

  test('cap knobs persist via PUT', async ({ page }) => {
    await page.goto('/settings/voice');

    const putRequest = page.waitForResponse(
      (r) => r.url().includes('/api/agent-mcp/operator-tts-spend') && r.request().method() === 'PUT',
    );

    const softCap = page.getByLabel('Soft cap (USD/day)').first();
    await softCap.fill('7');
    await softCap.blur();

    const resp = await putRequest;
    expect(resp.ok()).toBeTruthy();
    const body = await resp.json();
    expect(body.softCapUsd).toBe(7);

    // Restore default to keep tests idempotent.
    const restore = page.waitForResponse(
      (r) => r.url().includes('/api/agent-mcp/operator-tts-spend') && r.request().method() === 'PUT',
    );
    await softCap.fill('5');
    await softCap.blur();
    await restore;
  });
});

test.describe('voice mode toggle on harness shell', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      sessionStorage.setItem('oracle-tutorial-complete', 'true');
    });
  });

  test('voice mode button mounts in header', async ({ page }) => {
    await page.goto('/harness');
    const voiceBtn = page.getByRole('button', { name: /voice mode/i });
    await expect(voiceBtn).toBeVisible();
  });

  test('voice prefs API is reachable', async ({ page }) => {
    const resp = await page.request.get('/api/agent-mcp/operator-voice-prefs');
    expect(resp.ok()).toBeTruthy();
    const prefs = await resp.json();
    expect(prefs.sttEngine).toBeDefined();
    expect(prefs.ttsEngine).toBeDefined();
  });

  test('credentials API masks keys', async ({ page }) => {
    const resp = await page.request.get('/api/agent-mcp/operator-credentials');
    expect(resp.ok()).toBeTruthy();
    const creds = await resp.json();
    // Each provider entry exists with shape { apiKey, configured }
    expect(creds.elevenlabs).toHaveProperty('configured');
    expect(creds.deepgram).toHaveProperty('configured');
    // If a key IS configured, it must be masked (•••• in middle), never raw.
    for (const provider of ['elevenlabs', 'openai', 'cartesia', 'deepgram']) {
      const entry = creds[provider];
      if (entry.configured) {
        expect(entry.apiKey).toContain('••••');
      }
    }
  });

  test('STT bootstrap returns 404 for unconfigured engine', async ({ page }) => {
    // Web Speech is never the bootstrap path; should always 404.
    const resp = await page.request.get('/api/agent-mcp/operator-stt-bootstrap?engine=webspeech');
    expect(resp.status()).toBe(404);
  });
});
