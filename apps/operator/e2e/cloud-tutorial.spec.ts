/** Current-tree browser proof. Only authenticated network boundaries are
 * replaced: actual Cloud forms, Joyride, connector parser, launcher, owner
 * resolver, transcript stream and chat renderer all run in Chromium.
 * This proves product behavior; hosted exact-artifact proof is separate. */
import { expect, test, type Page } from './_egress';
import { stubSyncQueries } from './_sync-stub';
import { CLOUD_TUTORIAL_ID, CLOUD_TUTORIAL_VERSION } from '@papercusp/operator-core/lib/onboarding/cloud-tutorial-lesson';
import AxeBuilder from '@axe-core/playwright';
import { writeFile } from 'node:fs/promises';

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
  const progressByVersion = new Map<number, { revision: number; disposition: string; inspectedResult?: unknown; inspectedRevision?: unknown; inspectedPractice?: unknown }>();
  let progressStatus = 200;
  let helpStatus = 200;
  let sentPrompt = '';
  const submittedPrompts: string[] = [];
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
      const version = request.method() === 'POST' ? request.postDataJSON().version ?? CLOUD_TUTORIAL_VERSION : new URL(request.url()).searchParams.get('version') === '2' ? 2 : CLOUD_TUTORIAL_VERSION;
      const progress = progressByVersion.get(version) ?? { revision: 0, disposition: 'active' };
      if (request.method() === 'POST') {
        const patch = request.postDataJSON();
        expect(patch.expectedScope).toEqual(scope);
        expect(patch.expectedRevision).toBe(progress.revision);
        progress.revision++; progress.disposition = patch.disposition; progress.inspectedResult = patch.inspectedResult;
        progress.inspectedRevision = patch.inspectedRevision; progress.inspectedPractice = patch.inspectedPractice;
      }
      progressByVersion.set(version, progress);
      return json({ record: { revision: progress.revision, progress: { scope, lessonId: CLOUD_TUTORIAL_ID, version, disposition: progress.disposition,
        ...(progress.inspectedResult ? { inspectedResult: progress.inspectedResult } : {}),
        ...(progress.inspectedRevision ? { inspectedRevision: progress.inspectedRevision } : {}), ...(progress.inspectedPractice ? { inspectedPractice: progress.inspectedPractice } : {}) } } });
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
      const body = request.postDataJSON(); writes.push({ path, body }); sentPrompt = body.body; submittedPrompts.push(sentPrompt);
      expect(body.to).toEqual(['su-tutorial-first']);
      return json({ results: [{ wake: { queued: 1 } }] });
    }
    if (path === '/api/adv/session/thinking') {
      const timeline = submittedPrompts.flatMap((prompt, index) => [
        { kind: 'prompt', text: prompt, ts: `2026-10-01T12:00:${String(index * 3).padStart(2, '0')}Z` },
        { kind: 'text', text: prompt.includes('community book swap') ? 'Mira will ask the library about a room by Friday. Leon will collect book ideas. Date and budget are unknown.'
          : prompt.includes('Revise your action plan') ? 'Open decisions: date and budget. Confirmed: Mira asks about a room by Friday; Leon collects book ideas.'
          : prompt.includes('Answer this different task') ? 'Pack lunch, water, a notebook, a pen and workshop materials. Ask which materials are needed.' : ANSWER, ts: `2026-10-01T12:00:${String(index * 3 + 1).padStart(2, '0')}Z` },
        { kind: 'result', outcome: 'succeeded', text: '', ts: `2026-10-01T12:00:${String(index * 3 + 2).padStart(2, '0')}Z` },
      ]);
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

test('beginner entry selects a prepared workspace by keyboard with no provisioning or credentials and passes axe', async ({ page }) => {
  const fixture = await setupJourney(page, true);
  await page.goto('/cloud-workspaces', { waitUntil: 'domcontentloaded' });
  await fixture.sync.waitForServed(['workspaceHosts.control']);
  const entry = page.getByRole('region', { name: 'Beginner workspace entry' });
  await expect(entry).toContainText('existing model and account defaults');
  await expect(entry).toContainText('interactive mode');
  const choose = entry.getByRole('button', { name: 'Use prepared workspace My workspace' });
  await choose.focus(); await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/host=host-tutorial/);
  await expect(page).toHaveURL(/step=operate/);
  await expect(page.getByRole('textbox', { name: 'Connection label' })).toHaveCount(0);
  expect(fixture.writes).toEqual([]);
  const result = await new AxeBuilder({ page }).include('[aria-label="Beginner workspace entry"]')
    .withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
  await test.info().attach('prepared-entry-axe', { body: JSON.stringify(result), contentType: 'application/json' });
  expect(result.violations).toEqual([]);
  expect(fixture.browserErrors).toEqual([]);
});

test('beginner entry explains no prepared workspace and navigates to advanced BYOC without a mutation', async ({ page }) => {
  const fixture = await setupJourney(page, false);
  await page.goto('/cloud-workspaces', { waitUntil: 'domcontentloaded' });
  await fixture.sync.waitForServed(['workspaceHosts.control']);
  const entry = page.getByRole('region', { name: 'Beginner workspace entry' });
  await expect(entry).toContainText('Ask your administrator to prepare one');
  await expect(entry.getByRole('button', { name: /Use prepared workspace/ })).toHaveCount(0);
  await entry.getByRole('button', { name: 'Advanced: connect my own cloud' }).click();
  await expect(page).toHaveURL(/tutorial=advanced/);
  await expect(page.getByRole('textbox', { name: 'Connection label' })).toBeVisible();
  expect(fixture.writes).toEqual([]);
  expect(fixture.browserErrors).toEqual([]);
});

test('beginner reviews a useful plan, explicit revision and different self-written task after safety instruction', async ({ page }) => {
  const fixture = await setupJourney(page, true);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/cloud-workspaces', { waitUntil: 'domcontentloaded' });
  await fixture.sync.waitForServed(['workspaceHosts.control']);
  if (process.env.PAPERCUSP_TUTORIAL_ORCA_REVIEW === '1') {
    await page.getByRole('button', { name: 'Use prepared workspace My workspace' }).focus();
    await page.pause();
  }
  await page.getByRole('button', { name: 'Use prepared workspace My workspace' }).click();
  await page.getByRole('button', { name: "I've reviewed the configuration and cost" }).click();
  await page.getByRole('region', { name: 'Browser workspace session for My workspace' }).getByRole('button', { name: 'Connect', exact: true }).click();
  const guide = page.getByRole('region', { name: 'First agent guide' });
  await expect(guide.getByRole('heading', { name: 'Launch your first agent' })).toBeVisible();
  await page.getByRole('button', { name: '+ New session' }).click();
  const first = page.locator('[data-tutorial-target="cloud-task"]');
  await expect(first).toContainText('a suggested action is not your approval');
  await expect(first).toContainText('Pausing or closing this guide only pauses its instructions');
  await expect(first).toContainText('retained disks can still cost money');
  expect(fixture.writes.filter(write => write.path.endsWith('/coord/send'))).toHaveLength(0);
  await expect(page.getByRole('textbox', { name: 'Your different task' })).toHaveCount(0);
  const launch = fixture.writes.find(write => write.path.endsWith('/launch-su'))!;
  expect(launch.body.mode).toBeNull();
  await page.getByRole('button', { name: 'Send action-plan task', exact: true }).click();
  await expect(page.locator('[data-tutorial-target="cloud-result"]')).toContainText('Date and budget are unknown');
  await page.getByRole('button', { name: "I've reviewed the action plan" }).click();
  await expect(guide.getByRole('heading', { name: 'Ask for a correction and review it' })).toBeVisible();
  await page.getByRole('button', { name: 'Send revision request' }).click();
  await expect(page.locator('[data-tutorial-target="cloud-revision"]')).toContainText('Open decisions: date and budget');
  await page.getByRole('button', { name: "I've reviewed the revision" }).click();
  const draft = page.getByRole('textbox', { name: 'Your different task' });
  const own = page.getByRole('button', { name: 'Send my own task' });
  await expect(draft).toHaveValue(''); await expect(own).toBeDisabled();
  const ownTask = 'Goal: draft a packing checklist. Context: a two-day library workshop, indoors, bring our own lunch. Output: five bullets and open questions.';
  await draft.fill(ownTask); await own.focus(); await page.keyboard.press('Enter');
  await expect(page.locator('[data-tutorial-target="cloud-practice"]')).toContainText('Ask which materials are needed');
  await page.getByRole('button', { name: "I've reviewed my own task's answer" }).click();
  await expect(guide).toContainText('7 of 7 steps confirmed');
  const sends = fixture.writes.filter(write => write.path.endsWith('/coord/send'));
  expect(sends).toHaveLength(3); expect(sends[2].body.body).toContain(ownTask);
  expect(fixture.writes.filter(write => write.path.includes('/workspace-hosts/'))).toEqual([]);
  const accessibility = await new AxeBuilder({ page }).include('[data-cloud-tutorial-guide]').withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
  await test.info().attach('beginner-guide-axe', { body: JSON.stringify(accessibility), contentType: 'application/json' });
  expect(accessibility.violations).toEqual([]); expect(fixture.browserErrors).toEqual([]);
});

test('lesson help chat text passes axe when its empty state is in the viewport', async ({ page }) => {
  const fixture = await setupJourney(page, false);
  await page.goto('/cloud-workspaces', { waitUntil: 'domcontentloaded' });
  await fixture.sync.waitForServed(['workspaceHosts.control']);
  const help = page.getByRole('region', { name: 'Lesson help and speech' });
  const prompt = help.getByText('Ask a question about the current lesson step.', { exact: true });
  await prompt.scrollIntoViewIfNeeded();
  await expect(prompt).toBeInViewport({ ratio: 1 });
  const result = await new AxeBuilder({ page }).include('[aria-label="Lesson help and speech"]')
    .withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
  const path = test.info().outputPath('lesson-help-axe.json');
  await writeFile(path, JSON.stringify(result));
  await test.info().attach('lesson-help-axe', { contentType: 'application/json', path });
  expect(result.violations).toEqual([]);
});

test('guide remains keyboard operable with reduced motion and passes axe in active and paused states', async ({ page }) => {
  const fixture = await setupJourney(page, false);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const geometryReview = process.env.PAPERCUSP_TUTORIAL_GEOMETRY_REVIEW === '1';
  const orderReview = process.env.PAPERCUSP_TUTORIAL_FOCUS_ORDER_REVIEW === '1';
  const revealControl = process.env.PAPERCUSP_TUTORIAL_FOCUS_REVEAL_CONTROL === '1';
  const frameRevealControl = process.env.PAPERCUSP_TUTORIAL_FRAME_REVEAL_CONTROL === '1';
  await page.addInitScript(({ captureGeometry, captureOrder, explicitReveal, frameReveal }) => {
    const behaviors: Array<ScrollBehavior | undefined> = [];
    Object.defineProperty(window, '__tutorialScrollBehaviors', { value: behaviors });
    const snapshots: unknown[] = [];
    Object.defineProperty(window, '__tutorialFocusGeometry', { value: snapshots });
    const order: unknown[] = [];
    Object.defineProperty(window, '__tutorialFocusOrder', { value: order });
    const identify = (element: Element | null) => element?.getAttribute('aria-label')
      ?? element?.getAttribute('data-tutorial-target') ?? element?.tagName;
    // This arm records call order without forcing layout while the form mounts.
    const recordOrder = (event: string, target?: Element, options?: unknown) => {
      if (captureOrder && order.length < 100) order.push({ event, at: performance.now(),
        target: identify(target ?? null), active: identify(document.activeElement), options });
    };
    if (captureOrder || explicitReveal || frameReveal) {
      const focus = HTMLElement.prototype.focus;
      if (captureOrder) {
        const scrollWindow = window.scrollTo.bind(window);
        window.scrollTo = function (...args: [options?: ScrollToOptions] | [x: number, y: number]) {
          recordOrder('window.scrollTo', undefined, { args, stack: new Error().stack });
          if (typeof args[0] === 'number') scrollWindow(args[0], args[1] ?? 0);
          else scrollWindow(args[0]);
        };
        // Browser-produced rectangles identify layout shifts without forcing
        // geometry on the focus path (which can hide the original failure).
        const shifts = new PerformanceObserver(entries => {
          for (const entry of entries.getEntries()) {
            const shift = entry as PerformanceEntry & { value: number; sources?: Array<{
              node: Element | null; previousRect: DOMRectReadOnly; currentRect: DOMRectReadOnly;
            }> };
            recordOrder('layout-shift', undefined, { at: shift.startTime, value: shift.value,
              sources: shift.sources?.map(source => ({ node: identify(source.node),
                previousRect: source.previousRect.toJSON(), currentRect: source.currentRect.toJSON() })) });
          }
        });
        shifts.observe({ type: 'layout-shift', buffered: true });
        const intersections = new IntersectionObserver(entries => {
          for (const entry of entries) recordOrder('input-intersection', entry.target, {
            rect: entry.boundingClientRect.toJSON(), intersection: entry.intersectionRect.toJSON(),
            ratio: entry.intersectionRatio, scrollY: window.scrollY,
          });
        }, { threshold: [0, 1] });
        const sizes = new ResizeObserver(entries => {
          for (const entry of entries) recordOrder('container-resize', entry.target, {
            rect: entry.contentRect.toJSON(), scrollY: window.scrollY,
          });
        });
        let observedInput: Element | null = null;
        const observeInput = () => {
          const input = document.querySelector('input[aria-label="Connection label"]');
          if (!input || input === observedInput) return;
          observedInput = input;
          intersections.observe(input);
          if (input.closest('form')) sizes.observe(input.closest('form')!);
          if (input.closest('section')) sizes.observe(input.closest('section')!);
          recordOrder('input-mounted', input);
        };
        new MutationObserver(observeInput).observe(document, { childList: true, subtree: true });
        observeInput();
      }
      HTMLElement.prototype.focus = function (options) {
        recordOrder('focus:before', this, options);
        focus.call(this, options);
        recordOrder('focus:after', this, options);
        if (explicitReveal && this.getAttribute('aria-label') === 'Connection label' && options?.preventScroll === false)
          this.scrollIntoView({ behavior: 'instant', block: 'nearest' });
        if (frameReveal && this.getAttribute('aria-label') === 'Connection label' && options?.preventScroll === false)
          requestAnimationFrame(() => this.scrollIntoView({ behavior: 'instant', block: 'nearest' }));
      };
      document.addEventListener('scroll', event => recordOrder('scroll', event.target instanceof Element ? event.target : undefined,
        { scrollY: window.scrollY }), true);
    }
    const snapshot = (event: string, stack?: string) => {
      if (snapshots.length >= 80) return;
      const input = document.querySelector<HTMLElement>('input[aria-label="Connection label"]');
      const ancestors = [];
      for (let node = input?.parentElement; node; node = node.parentElement) {
        if (node.scrollHeight > node.clientHeight) ancestors.push({ tag: node.tagName, class: node.className,
          scrollTop: node.scrollTop, height: node.clientHeight, scrollHeight: node.scrollHeight, overflow: getComputedStyle(node).overflowY });
      }
      snapshots.push({ event, at: performance.now(), path: location.pathname + location.search,
        active: document.activeElement?.getAttribute('aria-label') ?? document.activeElement?.tagName,
        rect: input?.getBoundingClientRect().toJSON(), viewport: { width: innerWidth, height: innerHeight }, ancestors, stack });
    };
    if (captureGeometry) {
      document.addEventListener('focusin', () => snapshot('focusin'), true);
      document.addEventListener('scroll', () => snapshot('scroll'), true);
    }
    const scroll = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = function (options) {
      if (typeof options === 'object') behaviors.push(options.behavior);
      recordOrder('scrollIntoView:before', this, options);
      if (captureGeometry) snapshot(`scrollIntoView:${this.getAttribute('data-tutorial-target') ?? this.tagName}:before`, new Error().stack);
      scroll.call(this, options);
      recordOrder('scrollIntoView:after', this, options);
      if (captureGeometry) {
        snapshot('scrollIntoView:after');
        requestAnimationFrame(() => snapshot('scrollIntoView:next-frame'));
      }
    };
  }, { captureGeometry: geometryReview, captureOrder: orderReview, explicitReveal: revealControl, frameReveal: frameRevealControl });
  await page.goto('/cloud-workspaces', { waitUntil: 'domcontentloaded' });
  await fixture.sync.waitForServed(['workspaceHosts.control']);
  const guide = page.getByRole('region', { name: 'First agent guide' });
  const show = guide.getByRole('button', { name: 'Show me' });
  if (process.env.PAPERCUSP_TUTORIAL_ORCA_REVIEW === '1') {
    await show.focus(); await page.pause();
  }
  await show.focus(); await page.keyboard.press('Enter');
  const label = page.getByRole('textbox', { name: 'Connection label' });
  try {
    await expect(label).toBeFocused();
    // Check before fill/Tab can scroll the newly mounted field into view.
    await expect(label).toBeInViewport({ ratio: 1 });
  } finally {
    const preserveDiagnostic = async (name: string, data: unknown) => {
      const path = test.info().outputPath(`${name}.json`);
      await writeFile(path, JSON.stringify(data));
      await test.info().attach(name, { contentType: 'application/json', path });
    };
    if (orderReview) await preserveDiagnostic('connection-focus-order',
      await page.evaluate(() => {
        const input = document.querySelector('input[aria-label="Connection label"]');
        const ancestors = [];
        for (let node = input?.parentElement; node; node = node.parentElement) ancestors.push({ tag: node.tagName,
          class: node.className, scrollTop: node.scrollTop, clientHeight: node.clientHeight,
          scrollHeight: node.scrollHeight, overflow: getComputedStyle(node).overflowY,
          rect: node.getBoundingClientRect().toJSON() });
        return { order: (window as unknown as { __tutorialFocusOrder: unknown[] }).__tutorialFocusOrder,
          rect: input?.getBoundingClientRect().toJSON(), ancestors, viewport: { width: innerWidth, height: innerHeight } };
      }));
    if (geometryReview) await preserveDiagnostic('connection-focus-geometry',
      await page.evaluate(() => (window as unknown as { __tutorialFocusGeometry: unknown[] }).__tutorialFocusGeometry));
  }
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

test('connection focus stays visible when the docked rail reserves width after opening', async ({ page }) => {
  const fixture = await setupJourney(page, false);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/cloud-workspaces', { waitUntil: 'domcontentloaded' });
  await fixture.sync.waitForServed(['workspaceHosts.control']);
  await expect(page.locator('body')).toHaveClass(/has-dev-rail/);
  // Reproduce the measured late collapsed-rail reservation on the real form:
  // start without its 48px gutter, then allow the maintained CSS to reserve it.
  await page.evaluate(() => { document.body.style.paddingRight = '0px'; });
  const guide = page.getByRole('region', { name: 'First agent guide' });
  const show = guide.getByRole('button', { name: 'Show me' });
  await show.focus(); await page.keyboard.press('Enter');
  const label = page.getByRole('textbox', { name: 'Connection label' });
  await expect(label).toBeFocused();
  await expect.poll(() => label.evaluate(element => element.getBoundingClientRect().width)).toBe(408);
  await label.evaluate(element => {
    const rect = element.getBoundingClientRect();
    window.scrollBy({ top: rect.bottom - (innerHeight - 2), behavior: 'instant' });
  });
  await expect(label).toBeInViewport({ ratio: 1 });
  await page.evaluate(() => { document.body.style.removeProperty('padding-right'); });
  await expect.poll(() => label.evaluate(element => element.getBoundingClientRect().width)).toBe(360);
  await expect(label).toBeFocused();
  await expect(label).toBeInViewport({ ratio: 1 });
  expect(fixture.writes).toEqual([]);
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
  await expect(page.getByRole('button', { name: 'Get your first agent running', exact: true })).toBeFocused();
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
  await expect(page.getByRole('button', { name: 'Help', exact: true })).toBeFocused();
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
    const showConfiguration = guide.getByRole('button', { name: 'Show me' });
    await showConfiguration.focus(); await page.keyboard.press('Enter');
    if (!existing) {
      await expect(page.locator('[data-tutorial-target="cloud-configuration"]')).toBeFocused();
      await page.keyboard.press('Tab');
      const name = page.getByRole('textbox', { name: 'Workspace name' });
      await expect(name).toBeFocused();
      // Atomic fill hides dropped intermediate updates in a controlled,
      // URL-backed field. Exercise actual keystrokes after guide focus.
      let entered = '';
      for (const character of 'My workspace') {
        await page.keyboard.type(character, { delay: 20 });
        entered += character;
        await expect(name).toHaveValue(entered);
      }
      await page.keyboard.press('Tab');
      await expect(name).toHaveValue('My workspace');
    }
    await page.getByRole('button', { name: "I've reviewed the configuration and cost" }).click();
    await expect(guide.getByRole('heading', { name: 'Wait for a healthy workspace' })).toBeVisible();
    if (!existing) {
      expect(fixture.writes.filter(write => write.path.endsWith('/provision'))).toHaveLength(0);
      await page.getByRole('button', { name: 'Provision workspace' }).click();
      await expect.poll(() => fixture.writes.find(write => write.path.endsWith('/provision'))?.body.name).toBe('My workspace');
      await page.getByRole('button', { name: 'Show me', exact: true }).click();
      // The prepared-workspace entry also names this host. Select the actual
      // Operate row so this legacy BYOC journey never opts into version 2.
      await page.getByRole('list', { name: 'Managed workspace hosts' })
        .getByRole('button', { name: 'My workspace GCP', exact: false }).click();
      expect(new URL(page.url()).searchParams.get('tutorial')).not.toBe('beginner');
    }
    await expect(guide.getByRole('heading', { name: 'Get your first agent running', exact: true })).toBeVisible();
    // A 640 CSS-pixel viewport exercises the same layout width as the native
    // 200% zoom review. Measure rendered text, including overflowing glyphs.
    const fullViewport = page.viewportSize()!;
    await page.setViewportSize({ width: 640, height: 900 });
    const workspaceRow = page.getByRole('button', { name: 'My workspace GCP', exact: false }).first();
    await workspaceRow.scrollIntoViewIfNeeded();
    const rowLayout = await workspaceRow.evaluate(element => {
      const name = element.querySelector('strong')!;
      const chip = element.querySelector('[data-drifting]')!;
      const range = document.createRange(); range.selectNodeContents(name);
      const lines = Array.from(range.getClientRects());
      const status = chip.getBoundingClientRect();
      return { lines: lines.map(rect => rect.toJSON()), status: status.toJSON(),
        overlaps: lines.some(rect => rect.left < status.right && rect.right > status.left
          && rect.top < status.bottom && rect.bottom > status.top) };
    });
    await test.info().attach('narrow-workspace-name-layout', { body: JSON.stringify(rowLayout), contentType: 'application/json' });
    expect(rowLayout.lines.length).toBeGreaterThan(0);
    expect(rowLayout.overlaps).toBe(false);
    await page.setViewportSize(fullViewport);
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
    // An observer cannot send PTY input; the embedded terminal must let the
    // keyboard user return to the lesson and session controls.
    const terminalInput = page.getByRole('region', { name: 'Browser workspace session for My workspace' }).locator('.xterm-helper-textarea');
    await terminalInput.focus(); await page.keyboard.press('Tab');
    await expect(terminalInput).not.toBeFocused();
    await terminalInput.focus(); await page.keyboard.press('Shift+Tab');
    await expect(terminalInput).not.toBeFocused();
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
    // Pause through the product control so the spotlight no longer overlaps
    // the answer. An inconclusive axe row is not a measured contrast pass.
    await guide.getByRole('button', { name: 'Pause', exact: true }).click();
    for (const role of ['user', 'assistant'] as const) {
      const selector = `[data-tutorial-target="cloud-result"] .pc-chat__turn--${role} .pc-chat__p`;
      const resultText = page.locator(selector).first();
      await resultText.scrollIntoViewIfNeeded();
      await expect(resultText).toBeInViewport({ ratio: 1 });
      const resultContrast = await new AxeBuilder({ page }).include(selector).withRules(['color-contrast']).analyze();
      const contrastPath = test.info().outputPath(`lesson-result-${role}-contrast.json`);
      await writeFile(contrastPath, JSON.stringify(resultContrast));
      await test.info().attach(`lesson-result-${role}-contrast`, { contentType: 'application/json', path: contrastPath });
      expect(resultContrast.violations).toEqual([]);
      expect(resultContrast.incomplete.filter(result => result.id === 'color-contrast')).toEqual([]);
      expect(resultContrast.passes.find(result => result.id === 'color-contrast')?.nodes.length).toBeGreaterThan(0);
    }
    await guide.getByRole('button', { name: 'Resume guide', exact: true }).click();
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
