/** Current-tree browser proof. Only authenticated network boundaries are
 * replaced: actual Cloud forms, Joyride, connector parser, launcher, owner
 * resolver, transcript stream and chat renderer all run in Chromium.
 * This proves product behavior; hosted exact-artifact proof is separate. */
import { expect, test, type Page } from './_egress';
import { stubSyncQueries } from './_sync-stub';
import { CLOUD_TUTORIAL_ID, CLOUD_TUTORIAL_VERSION } from '@papercusp/operator-core/lib/onboarding/cloud-tutorial-lesson';
import AxeBuilder from '@axe-core/playwright';

// The same maintained browser fixture can be paused for a real Orca/keyboard
// review on an isolated desktop. Normal automated runs do not pause.
test.use({ launchOptions: { args: process.env.PAPERCUSP_TUTORIAL_ORCA_REVIEW === '1' ? ['--force-renderer-accessibility'] : [] } });

const scope = { tenantId: 'tutorial-tenant', userId: 'tutorial-user', workspaceId: 'tutorial-customer' };
const connection = {
  kind: 'connection', id: 'tutorial-gcp', target: 'gcp', label: 'My GCP', status: 'connected', credentialRef: 'adc://default',
  scopes: [{ id: 'tutorial-project', label: 'Tutorial project' }],
  regions: [{ id: 'us-central1', label: 'Iowa', zones: ['us-central1-a'] }],
  sizes: [{ id: 'e2-small', label: 'Small', vcpu: 2, memoryGiB: 2, hourlyUsd: 0.02 }],
  images: [{ id: 'ubuntu', label: 'Ubuntu' }], networks: [{ id: 'managed', label: 'Managed' }],
};
const workspace = {
  kind: 'workspace', id: 'host-tutorial', name: 'My workspace', connectionId: connection.id, target: 'gcp',
  scopeLabel: 'Tutorial project', region: 'us-central1', size: 'e2-small', image: 'ubuntu', diskGiB: 100, network: 'managed',
  desiredState: 'running', observedState: 'running', health: { status: 'healthy', checks: [] },
  recoverability: { kind: 'none', label: 'No backup' }, capabilities: { stop: true, repair: true, snapshot: true, destroy: true },
  tunnel: { hostedConnector: { transport: 'websocket', routeLabel: 'tutorial-connector' } },
};
const ANSWER = 'Available tools: read files and search code.';

async function setupJourney(page: Page, existing: boolean, speech = false) {
  let rows: unknown[] = existing ? [connection, workspace] : [];
  let revision = 0;
  let disposition = 'active';
  let inspectedResult: unknown;
  let progressStatus = 200;
  let helpStatus = 200;
  let sentPrompt = '';
  const writes: Array<{ path: string; body: Record<string, any> }> = [];
  const socketMessages: Record<string, unknown>[] = [];
  const apiHits: string[] = [];
  const browserErrors: string[] = [];
  const assistance: Array<{ path: string; body: Record<string, unknown> }> = [];
  page.on('pageerror', error => browserErrors.push(error.message));
  await page.addInitScript(() => {
    window.__PAPERCUSP_HOSTED_BROWSER__ = {
      version: 1, controlPlaneWorkspaceId: 'tutorial-control', restEndpoint: '/api/hosted/browser', sseEndpoint: '/api/hosted/browser/sse',
      workspaceHostEndpoints: { connection: '/api/hosted/browser/workspace-hosts/connection', provision: '/api/hosted/browser/workspace-hosts/provision', action: '/api/hosted/browser/workspace-hosts/action' },
    };
    localStorage.clear();
    const resizeErrors: Array<{ at: number; message: string }> = [];
    Object.defineProperty(window, '__tutorialResizeErrors', { value: resizeErrors });
    window.addEventListener('error', event => {
      if (event.message.includes('ResizeObserver loop')) resizeErrors.push({ at: performance.now(), message: event.message });
    });
  });
  // Fail closed for unmodelled API traffic; no test writes reach the real
  // control plane. The shared sync stub, registered after this handler, models
  // only workspaceHosts.control and asserts it was actually consumed.
  await page.route('**/api/**', async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    apiHits.push(path);
    const json = (body: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (path.endsWith('/onboarding/select-workspace')) return json({ error: 'workspace_already_selected' }, 409);
    if (path.endsWith('/onboarding/tutorial-help')) {
      assistance.push({ path, body: request.postDataJSON() });
      if (helpStatus !== 200) return json({ error: 'tutorial_help_unavailable' }, helpStatus);
      return json({ answer: 'Use the connection form to validate your Google Cloud project permissions.' });
    }
    if (path.endsWith('/onboarding/tutorial-speech')) {
      assistance.push({ path, body: request.postDataJSON() });
      if (!speech) return json({ error: 'tutorial_speech_unavailable' }, 503);
      // Real browser media playback; only the provider bytes are a fixed WAV.
      const rate = 16000, samples = rate / 2, wav = Buffer.alloc(44 + samples * 2);
      wav.write('RIFF', 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
      wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
      wav.writeUInt32LE(rate, 24); wav.writeUInt32LE(rate * 2, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
      wav.write('data', 36); wav.writeUInt32LE(samples * 2, 40);
      for (let i = 0; i < samples; i++) wav.writeInt16LE(Math.round(800 * Math.sin(2 * Math.PI * 220 * i / rate)), 44 + i * 2);
      return route.fulfill({ status: 200, contentType: 'audio/wav', body: wav });
    }
    if (path.endsWith('/onboarding/tutorial-progress')) {
      if (progressStatus !== 200) return json({ error: 'tutorial_scope_denied' }, progressStatus);
      if (request.method() === 'POST') {
        const patch = request.postDataJSON();
        expect(patch.expectedScope).toEqual(scope);
        expect(patch.expectedRevision).toBe(revision);
        revision++; disposition = patch.disposition; inspectedResult = patch.inspectedResult;
      }
      return json({ record: { revision, progress: { scope, lessonId: CLOUD_TUTORIAL_ID, version: CLOUD_TUTORIAL_VERSION, disposition, ...(inspectedResult ? { inspectedResult } : {}) } } });
    }
    if (path.endsWith('/workspace-hosts/connection')) {
      writes.push({ path, body: request.postDataJSON() }); rows = [connection];
      return json({ ok: true, message: 'Connection validated' });
    }
    if (path.endsWith('/workspace-hosts/provision')) {
      const body = request.postDataJSON(); writes.push({ path, body });
      rows = [connection, { ...workspace, id: body.desired.hostId, name: body.name }];
      return json({ ok: true, operationId: 'tutorial-provision' });
    }
    if (path === '/api/hosted/auth/session') return json({ ok: true, session: { workspaceId: scope.workspaceId } });
    if (path.endsWith('/connectors/session-ticket')) {
      const body = request.postDataJSON();
      expect(body.hostId).toBe((rows[1] as typeof workspace).id);
      expect(body.routeLabel).toBe('tutorial-connector');
      return json({ ok: true, ticket: `ht_${'a'.repeat(43)}` });
    }
    if (path.endsWith('/bootstrap-su/options')) return json({ status: 'ok', identities: [], unreadable: [], nextAfter: null, fleets: [], accounts: [], schemes: [], ompCatalog: { status: 'unavailable', models: [] } });
    if (path === '/api/adv/sessions/launch-su') {
      const body = request.postDataJSON(); writes.push({ path, body });
      return json({ status: 'ok', ownerId: 'su-tutorial-first' });
    }
    if (path.endsWith('/coordination/sessions/list')) {
      expect(request.postDataJSON().owner).toBe('su-tutorial-first');
      return json({ sessions: [{ source_kind: 'codex', session_id: 'tutorial-native', active: true, last_ts: null }] });
    }
    if (path.endsWith('/coord/send')) {
      const body = request.postDataJSON(); writes.push({ path, body }); sentPrompt = body.body;
      expect(body.to).toEqual(['su-tutorial-first']);
      return json({ results: [{ wake: { queued: 1 } }] });
    }
    if (path === '/api/adv/session/thinking') {
      const timeline = sentPrompt ? [
        { kind: 'prompt', text: sentPrompt, ts: '2026-10-01T12:00:00Z' },
        { kind: 'text', text: ANSWER, ts: '2026-10-01T12:00:01Z' },
        { kind: 'result', outcome: 'succeeded', text: '', ts: '2026-10-01T12:00:02Z' },
      ] : [];
      return route.fulfill({ status: 200, contentType: 'text/event-stream', body: `retry: 100\nevent: backfill\ndata: ${JSON.stringify(timeline)}\n\n` });
    }
    if (path.endsWith('/sse')) return route.fulfill({ status: 200, contentType: 'text/event-stream', body: ': fixture\n\n' });
    if (path === '/api/flags/bootstrap') return json({ flags: {} });
    if (path.endsWith('/operator-voice-prefs')) return json({ prefs: { enabled: false, muted: true } });
    return json({ error: 'unmodelled_tutorial_fixture_route', path }, 501);
  });
  const sync = await stubSyncQueries(page, name => name === 'workspaceHosts.control' ? rows : undefined, { transport: 'hosted' });
  await page.routeWebSocket(/\/api\/hosted\/connectors\/socket\?/, socket => {
    // Queue after the actual browser WebSocket registers its listeners.
    setTimeout(() => socket.send(JSON.stringify({ type: 'session.bound', protocol: 'papercusp-hosted-workspace.v1', channelId: 'tutorial-channel', role: 'observer', binding: { generation: 1, hostedSessionId: 'tutorial-session' } })), 20);
    socket.onMessage(raw => { socketMessages.push(JSON.parse(String(raw))); });
  });
  return { writes, socketMessages, apiHits, browserErrors, assistance, sync,
    setProgressStatus: (status: number) => { progressStatus = status; },
    setHelpStatus: (status: number) => { helpStatus = status; },
    get prompt() { return sentPrompt; } };
}

test('guide remains keyboard operable with reduced motion and passes axe in active and paused states', async ({ page }) => {
  const fixture = await setupJourney(page, false);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.addInitScript(() => {
    const behaviors: Array<ScrollBehavior | undefined> = [];
    Object.defineProperty(window, '__tutorialScrollBehaviors', { value: behaviors });
    const scroll = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = function (options) {
      if (typeof options === 'object') behaviors.push(options.behavior);
      scroll.call(this, options);
    };
  });
  await page.goto('/cloud-workspaces', { waitUntil: 'domcontentloaded' });
  await fixture.sync.waitForServed(['workspaceHosts.control']);
  const guide = page.getByRole('region', { name: 'First agent guide' });
  const show = guide.getByRole('button', { name: 'Show me' });
  if (process.env.PAPERCUSP_TUTORIAL_ORCA_REVIEW === '1') {
    await show.focus(); await page.pause();
  }
  await show.focus(); await page.keyboard.press('Enter');
  const label = page.getByRole('textbox', { name: 'Connection label' });
  await expect(label).toBeFocused();
  // Check before fill/Tab can scroll the newly mounted field into view.
  await expect(label).toBeInViewport({ ratio: 1 });
  await label.fill('Keyboard project'); await page.keyboard.press('Tab');
  const credential = page.getByRole('textbox', { name: 'Injected credential reference' });
  await expect(credential).toBeFocused();
  await expect(credential).toBeInViewport({ ratio: 1 });
  await expect.poll(() => page.evaluate(() => (window as unknown as { __tutorialScrollBehaviors: string[] }).__tutorialScrollBehaviors.length)).toBeGreaterThan(0);
  expect(await page.evaluate(() => (window as unknown as { __tutorialScrollBehaviors: string[] }).__tutorialScrollBehaviors)).not.toContain('smooth');
  const audit = () => new AxeBuilder({ page }).include('[data-cloud-tutorial-guide]').withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
  const active = await audit(); expect(active.violations).toEqual([]);
  await guide.getByRole('button', { name: 'Pause' }).focus(); await page.keyboard.press('Enter');
  await expect(guide).toContainText('Your lesson is paused.');
  await expect(page.locator('.react-joyride__overlay')).toHaveCount(0);
  await expect(guide.getByRole('button', { name: 'Resume guide' })).toBeFocused();
  const paused = await audit(); expect(paused.violations).toEqual([]);
  await page.keyboard.press('Enter');
  await expect(guide.getByRole('heading', { name: 'Connect Google Cloud' })).toBeVisible();
  await expect(guide.getByRole('button', { name: 'Show me' })).toBeFocused();
  await expect(label).toHaveValue('Keyboard project'); expect(fixture.writes).toEqual([]);
  await test.info().attach('guide-axe-active-paused', { body: JSON.stringify({ active, paused }), contentType: 'application/json' });
});

test('reload resumes saved pause, AI outage leaves controls operable, and Help replays without product writes', async ({ page }) => {
  const fixture = await setupJourney(page, false); fixture.setHelpStatus(503);
  await page.goto('/cloud-workspaces', { waitUntil: 'domcontentloaded' });
  await fixture.sync.waitForServed(['workspaceHosts.control']);
  const guide = page.getByRole('region', { name: 'First agent guide' });
  await guide.locator('textarea').fill('Why do I need project permissions?'); await guide.locator('textarea').press('Enter');
  await expect(guide).toContainText('AI help is unavailable. You can continue with the lesson instructions.');
  await expect(guide).toContainText('0 of 6 steps confirmed');
  const saved = page.waitForResponse(response => response.url().endsWith('/onboarding/tutorial-progress') && response.request().method() === 'POST');
  await guide.getByRole('button', { name: 'Pause' }).click(); await saved;
  await page.reload({ waitUntil: 'domcontentloaded' }); await expect(guide).toContainText('Your lesson is paused.');
  await expect(page.locator('.react-joyride__overlay')).toHaveCount(0);
  await guide.getByRole('button', { name: 'Resume guide' }).click(); await guide.getByRole('button', { name: 'Skip lesson' }).click();
  await expect(guide).toContainText('You can start this lesson again from Help.');
  await page.getByText('Help', { exact: true }).click();
  await page.getByRole('button', { name: 'Get your first agent running', exact: true }).click();
  await expect(guide.getByRole('heading', { name: 'Connect Google Cloud' })).toBeVisible();
  await guide.getByRole('button', { name: 'Close guide' }).click();
  await expect(guide).toHaveCount(0); await expect(page.locator('.react-joyride__overlay')).toHaveCount(0);
  expect(fixture.writes).toEqual([]);
  expect(fixture.assistance.filter(row => row.path.endsWith('tutorial-help'))).toHaveLength(1);
});

test('permission refusal keeps real Cloud forms usable and recovers only after an authorized progress read', async ({ page }) => {
  const fixture = await setupJourney(page, false); fixture.setProgressStatus(403);
  await page.goto('/cloud-workspaces?step=connect&connect=gcp', { waitUntil: 'domcontentloaded' });
  await fixture.sync.waitForServed(['workspaceHosts.control']);
  await expect(page.getByText('Sign in and select an authorized workspace, then check again.')).toBeVisible();
  const label = page.getByRole('textbox', { name: 'Connection label' }); await label.fill('Retain this draft');
  await expect(page.getByRole('region', { name: 'First agent guide' })).toHaveCount(0);
  fixture.setProgressStatus(200); await page.getByRole('button', { name: 'Check lesson again' }).click();
  await expect(page.getByRole('region', { name: 'First agent guide' })).toContainText('0 of 6 steps confirmed');
  await expect(label).toHaveValue('Retain this draft'); expect(fixture.writes).toEqual([]);
});

test('guide speaks current instructions and scoped help with real browser audio and no microphone', async ({ page }) => {
  const fixture = await setupJourney(page, false, true);
  await page.addInitScript(() => {
    const events: string[] = []; Object.defineProperty(window, '__tutorialAudioEvents', { value: events });
    // Observe the detached Audio element's native events, preserving play().
    const play = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function () {
      this.addEventListener('playing', () => events.push('playing'), { once: true });
      this.addEventListener('ended', () => events.push('ended'), { once: true });
      return play.call(this);
    };
    Object.defineProperty(window, '__tutorialMicCalls', { value: 0, writable: true });
    if (navigator.mediaDevices?.getUserMedia) {
      const acquire = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
      navigator.mediaDevices.getUserMedia = constraints => {
        (window as unknown as { __tutorialMicCalls: number }).__tutorialMicCalls++;
        return acquire(constraints);
      };
    }
  });
  await page.goto('/cloud-workspaces', { waitUntil: 'domcontentloaded' });
  await fixture.sync.waitForServed(['workspaceHosts.control']);
  const guide = page.getByRole('region', { name: 'First agent guide' });
  await guide.getByRole('button', { name: 'Replay speech' }).click();
  const playing = () => page.evaluate(() => (window as unknown as { __tutorialAudioEvents: string[] }).__tutorialAudioEvents.filter(value => value === 'playing').length);
  await expect.poll(playing).toBeGreaterThan(0);
  const prior = await playing();
  const composer = guide.locator('textarea');
  await composer.fill('Why do I need Google Cloud project permissions?');
  await composer.press('Enter');
  await expect(guide).toContainText('Use the connection form to validate your Google Cloud project permissions.');
  await expect.poll(playing).toBeGreaterThan(prior);
  await guide.getByRole('button', { name: 'Mute guide' }).click();
  await expect(guide.getByRole('button', { name: 'Replay speech' })).toBeDisabled();
  await expect(guide).toContainText('0 of 6 steps confirmed');
  expect(fixture.writes).toEqual([]);
  expect(await page.evaluate(() => (window as unknown as { __tutorialMicCalls: number }).__tutorialMicCalls)).toBe(0);
  const help = fixture.assistance.find(row => row.path.endsWith('tutorial-help'));
  expect(help?.body).toEqual({ expectedScope: scope, context: { step: 'connection', status: 'ready' }, question: 'Why do I need Google Cloud project permissions?' });
  await guide.getByRole('button', { name: 'Close guide' }).click();
  await expect(page.getByRole('region', { name: 'Lesson help and speech' })).toHaveCount(0);
  await test.info().attach('guide-audio-playback-events', { body: JSON.stringify(await page.evaluate(() => (window as unknown as { __tutorialAudioEvents: string[] }).__tutorialAudioEvents)), contentType: 'application/json' });
});

for (const existing of [false, true]) {
  test(`${existing ? 'existing workspace' : 'new user'} completes the actual Cloud first-agent journey`, async ({ page }) => {
    const fixture = await setupJourney(page, existing);
    await page.goto(existing ? '/cloud-workspaces?step=operate&host=host-tutorial&tab=cost' : '/cloud-workspaces', { waitUntil: 'domcontentloaded' });
    await fixture.sync.waitForServed(['workspaceHosts.control']);
    const guide = page.getByRole('region', { name: 'First agent guide' });
    await expect(guide).toBeVisible();
    expect(fixture.writes).toEqual([]);
    if (!existing) {
      await expect(guide.getByRole('heading', { name: 'Connect Google Cloud' })).toBeVisible();
      await guide.getByRole('button', { name: 'Show me' }).click();
      const label = page.getByRole('textbox', { name: 'Connection label' });
      await label.fill('My GCP');
      await label.press('Tab');
      await expect(page.getByRole('textbox', { name: 'Injected credential reference' })).toBeFocused();
      await page.getByRole('textbox', { name: 'Injected credential reference' }).fill('adc://default');
      await page.getByRole('textbox', { name: 'Google Cloud project ID' }).fill('tutorial-project');
      await page.getByRole('textbox', { name: 'Runtime service account email' }).fill('runtime@tutorial-project.iam.gserviceaccount.com');
      expect(fixture.writes).toEqual([]);
      await page.getByRole('button', { name: 'Connect and validate' }).click();
    }
    await expect(guide.getByRole('heading', { name: 'Review configuration and cost' })).toBeVisible();
    await guide.getByRole('button', { name: 'Show me' }).click();
    if (!existing) await page.getByRole('textbox', { name: 'Workspace name' }).fill('My workspace');
    await page.getByRole('button', { name: "I've reviewed the configuration and cost" }).click();
    await expect(guide.getByRole('heading', { name: 'Wait for a healthy workspace' })).toBeVisible();
    if (!existing) {
      expect(fixture.writes.filter(write => write.path.endsWith('/provision'))).toHaveLength(0);
      await page.getByRole('button', { name: 'Provision workspace' }).click();
      await page.getByRole('button', { name: 'Show me', exact: true }).click();
      await page.getByRole('button', { name: 'My workspace', exact: false }).first().click();
    }
    await page.getByRole('region', { name: 'Browser workspace session for My workspace' }).getByRole('button', { name: 'Connect', exact: true }).click();
    await expect(guide.getByRole('heading', { name: 'Launch your first agent' })).toBeVisible();
    const heights = await page.getByRole('region', { name: 'Browser workspace session for My workspace' }).locator('.xterm').evaluate(async element => {
      const samples: number[] = [];
      for (let frame = 0; frame < 20; frame++) {
        await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
        samples.push(element.parentElement!.getBoundingClientRect().height);
      }
      return samples;
    });
    await test.info().attach('connector-terminal-height', { body: JSON.stringify(heights), contentType: 'application/json' });
    // Fitting a terminal must not increase its own container every frame and
    // continuously move the lesson's real controls out from under the user.
    expect(Math.max(...heights.slice(5)) - Math.min(...heights.slice(5))).toBeLessThan(2);
    expect(fixture.writes.filter(write => write.path.endsWith('/launch-su'))).toHaveLength(0);
    expect(fixture.socketMessages.filter(message => message.type === 'desktop.start')).toHaveLength(0);
    await page.getByRole('button', { name: '+ New session', exact: true }).click();
    await expect(guide.getByRole('heading', { name: 'Submit a small read-only task' })).toBeVisible();
    const launch = fixture.writes.filter(write => write.path.endsWith('/launch-su'));
    expect(launch).toHaveLength(1); expect(launch[0].body.mode).toBeNull();
    await page.getByRole('button', { name: 'Send sample task', exact: true }).click();
    await expect.poll(() => fixture.prompt).toContain('Lesson request:');
    await expect(guide.getByRole('heading', { name: 'Inspect the result' })).toBeVisible();
    await expect(page.locator('[data-tutorial-target="cloud-result"]')).toContainText(ANSWER);
    await page.getByRole('button', { name: "I've inspected this answer" }).click();
    await expect(guide).toContainText('Your first agent lesson is complete.');
    await expect(guide).toContainText('6 of 6 steps confirmed');
    expect(fixture.writes.filter(write => write.path.endsWith('/coord/send'))).toHaveLength(1);
    const resizeErrors = await page.evaluate(() => (window as unknown as { __tutorialResizeErrors: unknown[] }).__tutorialResizeErrors);
    await test.info().attach('browser-resize-errors', { body: JSON.stringify(resizeErrors), contentType: 'application/json' });
    expect(resizeErrors).toEqual([]);
    fixture.sync.assertServed('workspaceHosts.control');
  });
}
