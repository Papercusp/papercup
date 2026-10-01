/** Current-tree browser proof. Only authenticated network boundaries are
 * replaced: actual Cloud forms, Joyride, connector parser, launcher, owner
 * resolver, transcript stream and chat renderer all run in Chromium.
 * This proves product behavior; hosted exact-artifact proof is separate. */
import { expect, test, type Page } from './_egress';
import { stubSyncQueries } from './_sync-stub';
import { CLOUD_TUTORIAL_ID, CLOUD_TUTORIAL_VERSION } from '@papercusp/operator-core/lib/onboarding/cloud-tutorial-lesson';

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

async function setupJourney(page: Page, existing: boolean) {
  let rows: unknown[] = existing ? [connection, workspace] : [];
  let revision = 0;
  let disposition = 'active';
  let inspectedResult: unknown;
  let sentPrompt = '';
  const writes: Array<{ path: string; body: Record<string, any> }> = [];
  const socketMessages: Record<string, unknown>[] = [];
  const apiHits: string[] = [];
  const browserErrors: string[] = [];
  page.on('pageerror', error => browserErrors.push(error.message));
  await page.addInitScript(() => {
    window.__PAPERCUSP_HOSTED_BROWSER__ = {
      version: 1, controlPlaneWorkspaceId: 'tutorial-control', restEndpoint: '/api/hosted/browser', sseEndpoint: '/api/hosted/browser/sse',
      workspaceHostEndpoints: { connection: '/api/hosted/browser/workspace-hosts/connection', provision: '/api/hosted/browser/workspace-hosts/provision', action: '/api/hosted/browser/workspace-hosts/action' },
    };
    localStorage.clear();
    const resizeCalls: Array<{ at: number; stack: string; targets: string[] }> = [];
    const NativeObserver = window.ResizeObserver;
    window.ResizeObserver = class extends NativeObserver {
      constructor(callback: ResizeObserverCallback) {
        const stack = new Error().stack ?? '';
        super((entries, observer) => {
          resizeCalls.push({ at: performance.now(), stack, targets: entries.map(entry => entry.target.className) });
          if (resizeCalls.length > 12) resizeCalls.shift();
          callback(entries, observer);
        });
      }
    };
    const resizeErrors: Array<{ at: number; message: string; calls: typeof resizeCalls }> = [];
    Object.defineProperty(window, '__tutorialResizeErrors', { value: resizeErrors });
    window.addEventListener('error', event => {
      if (event.message.includes('ResizeObserver loop')) resizeErrors.push({ at: performance.now(), message: event.message, calls: [...resizeCalls] });
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
    if (path.endsWith('/onboarding/tutorial-progress')) {
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
  return { writes, socketMessages, apiHits, browserErrors, sync, get prompt() { return sentPrompt; } };
}

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
