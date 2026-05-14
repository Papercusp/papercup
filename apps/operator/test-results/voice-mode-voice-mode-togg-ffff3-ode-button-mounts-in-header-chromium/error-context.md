# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: voice-mode.spec.ts >> voice mode toggle on harness shell >> voice mode button mounts in header
- Location: e2e/voice-mode.spec.ts:88:7

# Error details

```
Error: page.goto: net::ERR_CONNECTION_REFUSED at http://localhost:3055/harness
Call log:
  - navigating to "http://localhost:3055/harness", waiting until "load"

```

# Test source

```ts
  1   | import { expect, test } from '@playwright/test';
  2   | import { expectNoA11yViolations } from './_axe';
  3   | 
  4   | /**
  5   |  * Voice mode E2E coverage.
  6   |  *
  7   |  * Headless Chromium can't reliably exercise the SpeechRecognition /
  8   |  * SpeechSynthesis APIs (no real mic, voice list is empty), and Voicemode
  9   |  * services may not be running in CI. So this spec covers the bits that
  10  |  * are deterministic without real audio:
  11  |  *
  12  |  *   - Settings page renders all 5 TTS engines + 3 STT engines
  13  |  *   - STT spend widget appears (parallel of TTS)
  14  |  *   - Voice mode toggle button mounts on the harness shell
  15  |  *   - Cap-knob inputs accept new values + persist via PUT
  16  |  *   - Engines context wiring fetches credentials + spend in parallel
  17  |  */
  18  | 
  19  | test.describe('voice settings', () => {
  20  |   test.beforeEach(async ({ page }) => {
  21  |     // Mark tutorial complete so voice features render their full UI.
  22  |     await page.addInitScript(() => {
  23  |       sessionStorage.setItem('oracle-tutorial-complete', 'true');
  24  |     });
  25  |   });
  26  | 
  27  |   test('renders all 5 TTS engines + 3 STT engines', async ({ page }) => {
  28  |     await page.goto('/settings/voice');
  29  | 
  30  |     // STT selector
  31  |     const stt = page.getByRole('combobox').first();
  32  |     await expect(stt.locator('option', { hasText: 'Voicemode' })).toHaveCount(1);
  33  |     await expect(stt.locator('option', { hasText: 'Web Speech' })).toHaveCount(1);
  34  |     await expect(stt.locator('option', { hasText: 'Deepgram' })).toHaveCount(1);
  35  | 
  36  |     // TTS selector
  37  |     const tts = page.getByRole('combobox').nth(1);
  38  |     await expect(tts.locator('option', { hasText: 'Kokoro' })).toHaveCount(1);
  39  |     await expect(tts.locator('option', { hasText: 'Browser' })).toHaveCount(1);
  40  |     await expect(tts.locator('option', { hasText: 'ElevenLabs' })).toHaveCount(1);
  41  |   });
  42  | 
  43  |   test('STT spend widget renders alongside TTS spend', async ({ page }) => {
  44  |     await page.goto('/settings/voice');
  45  |     await expect(page.getByText('STT spend (Deepgram)')).toBeVisible();
  46  |     await expect(page.getByText('Voicemode (local Whisper) and Web Speech are free')).toBeVisible();
  47  |   });
  48  | 
  49  |   test('settings/voice has no serious or critical a11y violations', async ({ page }) => {
  50  |     await page.goto('/settings/voice');
  51  |     await expect(page.getByText('STT spend (Deepgram)')).toBeVisible();
  52  |     await expectNoA11yViolations(page);
  53  |   });
  54  | 
  55  |   test('cap knobs persist via PUT', async ({ page }) => {
  56  |     await page.goto('/settings/voice');
  57  | 
  58  |     const putRequest = page.waitForResponse(
  59  |       (r) => r.url().includes('/api/agent-mcp/operator-tts-spend') && r.request().method() === 'PUT',
  60  |     );
  61  | 
  62  |     const softCap = page.getByLabel('Soft cap (USD/day)').first();
  63  |     await softCap.fill('7');
  64  |     await softCap.blur();
  65  | 
  66  |     const resp = await putRequest;
  67  |     expect(resp.ok()).toBeTruthy();
  68  |     const body = await resp.json();
  69  |     expect(body.softCapUsd).toBe(7);
  70  | 
  71  |     // Restore default to keep tests idempotent.
  72  |     const restore = page.waitForResponse(
  73  |       (r) => r.url().includes('/api/agent-mcp/operator-tts-spend') && r.request().method() === 'PUT',
  74  |     );
  75  |     await softCap.fill('5');
  76  |     await softCap.blur();
  77  |     await restore;
  78  |   });
  79  | });
  80  | 
  81  | test.describe('voice mode toggle on harness shell', () => {
  82  |   test.beforeEach(async ({ page }) => {
  83  |     await page.addInitScript(() => {
  84  |       sessionStorage.setItem('oracle-tutorial-complete', 'true');
  85  |     });
  86  |   });
  87  | 
  88  |   test('voice mode button mounts in header', async ({ page }) => {
> 89  |     await page.goto('/harness');
      |                ^ Error: page.goto: net::ERR_CONNECTION_REFUSED at http://localhost:3055/harness
  90  |     const voiceBtn = page.getByRole('button', { name: /voice mode/i });
  91  |     await expect(voiceBtn).toBeVisible();
  92  |   });
  93  | 
  94  |   test('voice prefs API is reachable', async ({ page }) => {
  95  |     const resp = await page.request.get('/api/agent-mcp/operator-voice-prefs');
  96  |     expect(resp.ok()).toBeTruthy();
  97  |     const prefs = await resp.json();
  98  |     expect(prefs.sttEngine).toBeDefined();
  99  |     expect(prefs.ttsEngine).toBeDefined();
  100 |   });
  101 | 
  102 |   test('credentials API masks keys', async ({ page }) => {
  103 |     const resp = await page.request.get('/api/agent-mcp/operator-credentials');
  104 |     expect(resp.ok()).toBeTruthy();
  105 |     const creds = await resp.json();
  106 |     // Each provider entry exists with shape { apiKey, configured }
  107 |     expect(creds.elevenlabs).toHaveProperty('configured');
  108 |     expect(creds.deepgram).toHaveProperty('configured');
  109 |     // If a key IS configured, it must be masked (•••• in middle), never raw.
  110 |     for (const provider of ['elevenlabs', 'openai', 'cartesia', 'deepgram']) {
  111 |       const entry = creds[provider];
  112 |       if (entry.configured) {
  113 |         expect(entry.apiKey).toContain('••••');
  114 |       }
  115 |     }
  116 |   });
  117 | 
  118 |   test('STT bootstrap returns 404 for unconfigured engine', async ({ page }) => {
  119 |     // Web Speech is never the bootstrap path; should always 404.
  120 |     const resp = await page.request.get('/api/agent-mcp/operator-stt-bootstrap?engine=webspeech');
  121 |     expect(resp.status()).toBe(404);
  122 |   });
  123 | });
  124 | 
```