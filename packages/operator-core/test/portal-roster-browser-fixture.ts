/** Actual Portal roster controls against the disposable cookie-authenticated API. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { build } from 'esbuild';
import { chromium, type BrowserContext, type Page } from 'playwright-core';
import { getMessageById, readAckedMsgIds, readInbox } from '../lib/agent-tools/coordination/messages';
import { verifyPrivateHistoryStreams, verifyPrivateStopReceipt } from './private-coord-receipt';
import { portalBrowserPackagesPlugin, portalBrowserSurfaceBuild } from './private-http-workspace-preflight';

const digest = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');

type PortalRosterBrowserInput = {
  evidence: string; base: string; workspace: string; selected: string; neighbor: string;
  portalSourceRoot: string;
  cookieName: string; ownToken: string; foreignToken: string;
  shortcuts?: boolean;
  settings?: boolean;
  prompts?: boolean;
  inbox?: { selectedMessageId: string; neighborMessageId: string; selectedTitle: string; neighborTitle: string };
  history?: { selectedSessionId: number; neighborSessionId: number; selectedRolloutId: string; neighborRolloutId: string;
    selectedMarker: string; neighborMarker: string };
  verifyReceipt?: (receipt: { status: number; body: any }, summary: string, wake: boolean) => Promise<string>;
  stop?: {
    selected: { id: number; startedAt: string }; neighbor: { id: number; startedAt: string };
    assertChildrenAlive: () => Promise<void>; assertSelectedStopped: () => Promise<void>;
    assertNeighborAlive: () => Promise<void>; invalidateNeighborLaunch: () => Promise<void>;
  };
};

/** Compile the actual component graph without a browser, API or private PG. */
export async function buildPortalRosterBrowser(input: Pick<PortalRosterBrowserInput,
  'portalSourceRoot' | 'selected' | 'neighbor' | 'history' | 'stop' | 'shortcuts' | 'settings' | 'prompts' | 'inbox'>) {
  const { selected, neighbor } = input;
  const portal = realpathSync(input.portalSourceRoot);
  const rows = [selected, neighbor].map(ownerId => ({ ownerId, label: ownerId, agent: 'codex', role: 'worker',
    intent: 'Private browser roster canary', feature: null, currentPlanSlug: null, liveness: 'live',
    sessionState: 'live', heartbeatAt: new Date().toISOString(), lastActiveAt: new Date().toISOString(),
    isLocal: true, transcriptFresh: false,
    ...(input.stop ? { managedSessionId: (ownerId === selected ? input.stop.selected : input.stop.neighbor).id,
      launchStartedAt: (ownerId === selected ? input.stop.selected : input.stop.neighbor).startedAt } : {}) }));
  // Only the host geometry and supplied roster population are fixtures. The
  // component's native fetch, callbacks and HTTP receipts stay unmodified.
  const operatorRoot = resolve(import.meta.dirname, '../../../apps/operator');
  const entry = input.inbox ? `
    import * as React from 'react';
    import { createRoot } from 'react-dom/client';
    import { NuqsAdapter } from 'nuqs/adapters/react';
    import { SyncProvider } from '@papercusp/sync';
    import { Toaster } from 'sonner';
    import InboxPane from ${JSON.stringify(join(operatorRoot, 'app/_components/inbox/InboxPane.tsx'))};
    createRoot(document.getElementById('root')).render(React.createElement(NuqsAdapter, null,
      React.createElement(SyncProvider, { syncType: 'POLLING', restEndpoint: '/api/zero-harness' },
        React.createElement(React.Fragment, null, React.createElement(InboxPane, { layout: 'split' }),
          React.createElement(Toaster)))));
  ` : input.prompts ? `
    import * as React from 'react';
    import { createRoot } from 'react-dom/client';
    import { NuqsAdapter } from 'nuqs/adapters/react';
    import { SyncProvider } from '@papercusp/sync';
    import { Toaster } from 'sonner';
    import PromptsTab from ${JSON.stringify(join(operatorRoot, 'app/quick-panel/PromptsTab.tsx'))};
    createRoot(document.getElementById('root')).render(React.createElement(NuqsAdapter, null,
      React.createElement(SyncProvider, { syncType: 'POLLING', restEndpoint: '/api/zero-harness' },
        React.createElement(React.Fragment, null, React.createElement(PromptsTab, { queryPrefix: 'qp' }),
          React.createElement(Toaster)))));
  ` : input.settings ? `
    import * as React from 'react';
    import { createRoot } from 'react-dom/client';
    import { NuqsAdapter } from 'nuqs/adapters/react';
    import { Toaster } from 'sonner';
    import ProfilePage from ${JSON.stringify(join(operatorRoot, 'app/settings/profile/page.tsx'))};
    createRoot(document.getElementById('root')).render(React.createElement(NuqsAdapter, null,
      React.createElement(React.Fragment, null, React.createElement(ProfilePage), React.createElement(Toaster))));
  ` : input.shortcuts ? `
    import * as React from 'react';
    import { createRoot } from 'react-dom/client';
    import { NuqsAdapter } from 'nuqs/adapters/react';
    import { parseAsString, useQueryState } from 'nuqs';
    import { PortalShortcuts } from './packages/ui/src/portal-shortcuts.tsx';
    import ShortcutsSettingsPage from ${JSON.stringify(join(operatorRoot, 'app/settings/shortcuts/page.tsx'))};
    function Fixture() {
      const [panel, setPanel] = useQueryState('panel', parseAsString);
      const [active, setActive] = useQueryState('app', parseAsString.withDefault('settings'));
      return React.createElement(React.Fragment, null,
        React.createElement(PortalShortcuts, { panel, setPanel, active, setActive,
          railKinds: ['overview', 'plans', 'inbox'], openCreatePot: () => setActive('overview') }),
        React.createElement(ShortcutsSettingsPage),
        React.createElement('output', { 'data-testid': 'private-shortcut-panel' }, panel || 'none'),
        React.createElement('output', { 'data-testid': 'private-shortcut-app' }, active));
    }
    createRoot(document.getElementById('root')).render(React.createElement(NuqsAdapter, null, React.createElement(Fixture)));
  ` : input.history ? `
    import * as React from 'react';
    import { createRoot } from 'react-dom/client';
    import { NuqsAdapter } from 'nuqs/adapters/react';
    import { SyncProvider } from '@papercusp/sync';
    import { parseAsString, useQueryState } from 'nuqs';
    import { PortalAgentsPopover, usePortalSessionHistoryActions } from './packages/ui/src/agents-popover.tsx';
    import SessionHistoryModal from ${JSON.stringify(join(operatorRoot, 'app/adv/sessions/SessionHistoryModal.tsx'))};
    function Fixture() {
      const actions = usePortalSessionHistoryActions();
      const [panel] = useQueryState('panel', parseAsString);
      const [conversation] = useQueryState('agentConversation', parseAsString);
      return React.createElement(React.Fragment, null,
        React.createElement(PortalAgentsPopover, {
          agents: ${JSON.stringify(rows)}, open: panel === 'agents', onClose: () => {},
          onInspectSession: actions.inspectAgentSession, onOpenEndedSession: actions.openEndedSession,
          loadEndedSessions: async () => ({ sessions: ${JSON.stringify([{ id: input.history.selectedSessionId,
            agent: 'codex', coordOwnerId: selected, mode: 'console', label: 'Pinned private session',
            startedAt: new Date().toISOString(), endedAt: new Date().toISOString(), exitCode: 0 }])}, hasMore: false, nextBefore: null }),
        }),
        React.createElement(SessionHistoryModal),
        React.createElement('output', { 'data-testid': 'private-conversation-selection' }, conversation || 'none'));
    }
    createRoot(document.getElementById('root')).render(React.createElement(NuqsAdapter, null,
      React.createElement(SyncProvider, { syncType: 'POLLING', restEndpoint: '/api/zero-harness' }, React.createElement(Fixture))));
  ` : `
    import * as React from 'react';
    import { createRoot } from 'react-dom/client';
    import { PortalAgentsPopover } from './packages/ui/src/agents-popover.tsx';
    createRoot(document.getElementById('root')).render(React.createElement(PortalAgentsPopover, {
      agents: ${JSON.stringify(rows)}, open: true, onClose: () => {},
      loadEndedSessions: async () => ({ sessions: [], hasMore: false, nextBefore: null }),
    }));
  `;
  const originals = new Map<string, { sha256: string; bytes: number }>();
  const boundary = input.inbox ? await portalBrowserSurfaceBuild(portal) : undefined;
  if (boundary) {
    const contents = readFileSync(boundary.source);
    originals.set(boundary.source, { sha256: digest(contents), bytes: contents.length });
  }
  const result = await build({ absWorkingDir: portal,
    stdin: { contents: entry, loader: 'ts', resolveDir: portal, sourcefile: 'private-roster-browser-entry.ts' },
    alias: { react: resolve(portal, 'node_modules/react'), 'react-dom': resolve(portal, 'node_modules/react-dom') },
    tsconfigRaw: { compilerOptions: { baseUrl: resolve(import.meta.dirname, '../../..'), paths: { '@/*': ['apps/operator/*'] }, jsx: 'react-jsx' } },
    loader: { '.css': 'empty', '.module.css': 'local-css' },
    ...(boundary ? { define: boundary.define } : {}),
    bundle: true, format: 'iife', platform: 'browser', target: 'es2022', write: false,
    outfile: join(portal, 'private-roster-browser.js'),
    logLevel: 'silent',
    plugins: [portalBrowserPackagesPlugin(portal), ...(boundary ? [boundary.plugin] : []), { name: 'retain-executed-browser-inputs', setup(builder) {
      builder.onLoad({ filter: /\.css$/ }, ({ path }) => {
        const contents = readFileSync(path);
        originals.set(path, { sha256: digest(contents), bytes: contents.length });
        return { contents, loader: path.endsWith('.module.css') ? 'local-css' : 'empty' };
      });
      builder.onLoad({ filter: /\.[cm]?[jt]sx?$/ }, ({ path }) => {
        const contents = readFileSync(path);
        originals.set(path, { sha256: digest(contents), bytes: contents.length });
        const extension = extname(path).slice(1);
        return { contents, loader: extension === 'tsx' || extension === 'jsx' ? extension : extension === 'ts' ? 'ts' : 'js' };
      });
    } }],
  });
  const bundle = result.outputFiles.find(file => file.path.endsWith('.js'))!.contents;
  const css = result.outputFiles.find(file => file.path.endsWith('.css'))?.text ?? '';
  for (const [path, identity] of originals) assert.equal(digest(readFileSync(path)), identity.sha256,
    `Browser input changed during build: ${path}`);
  assert.ok([...originals.keys()].some(path => path.endsWith(input.inbox
    ? '/apps/operator/app/_components/inbox/InboxPane.tsx' : input.prompts
    ? '/apps/operator/app/quick-panel/PromptsTab.tsx' : input.settings
      ? '/apps/operator/app/settings/profile/page.tsx' : input.shortcuts
      ? '/packages/ui/src/portal-shortcuts.tsx' : '/packages/ui/src/agents-popover.tsx')),
    'Executed bundle must contain the actual product control');
  return { portal, entry, bundle, css, originals };
}

/** A failing action must leave its original rendered state before teardown. */
export async function retainPortalBrowserFailure(page: Pick<Page, 'url' | 'content' | 'locator' | 'screenshot'>,
  evidence: string, error: unknown, pageErrors: readonly string[]) {
  const results = await Promise.allSettled([
    page.content(), page.locator('body').innerText({ timeout: 3_000 }), page.locator('button').allTextContents(),
    page.screenshot({ path: join(evidence, 'portal-browser-failure.png'), timeout: 3_000, animations: 'disabled' }),
  ]);
  if (results[0].status === 'fulfilled') writeFileSync(join(evidence, 'portal-browser-failure.html'), results[0].value);
  const snapshot = { url: page.url(), message: error instanceof Error ? error.message : String(error), pageErrors,
    text: results[1].status === 'fulfilled' ? results[1].value : null,
    buttons: results[2].status === 'fulfilled' ? results[2].value : null,
    diagnosticErrors: results.flatMap((result, index) => result.status === 'rejected' ? [{ index, message: String(result.reason) }] : []) };
  writeFileSync(join(evidence, 'portal-browser-failure.json'), JSON.stringify(snapshot, null, 2));
}

export async function runPortalRosterBrowser(input: PortalRosterBrowserInput) {
  const { evidence, base, workspace, selected, neighbor } = input;
  const { portal, entry, bundle, css, originals } = await buildPortalRosterBrowser(input);
  const spa = join(evidence, 'portal-roster-spa');
  mkdirSync(spa, { recursive: true });
  writeFileSync(join(spa, 'portal-roster.js'), bundle);
  writeFileSync(join(spa, 'portal-roster.css'), readFileSync(join(portal, 'app/tokens.css'), 'utf8') + '\n'
    + readFileSync(join(portal, 'app/globals.css'), 'utf8')
    + (input.prompts ? '\n' + readFileSync(resolve(import.meta.dirname, '../../../apps/operator/app/quick-panel/quick-panel.css'), 'utf8') : '')
    + (input.inbox ? '\n' + ['app/_components/inbox/inbox-pane.css', 'app/admin/plans/plans.css']
      .map(path => readFileSync(resolve(import.meta.dirname, '../../../apps/operator', path), 'utf8')).join('\n')
      + '\nhtml,body,#root{height:100%;margin:0}#root{display:flex}' : '') + '\n' + css);
  writeFileSync(join(spa, 'index.html'), '<!doctype html><html><head><link rel="stylesheet" href="/portal-roster.css"></head>'
    + '<body><div id="root"></div><script src="/portal-roster.js"></script></body></html>');
  const sourceIdentity = { portal, head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: portal, encoding: 'utf8' }).trim(),
    entrySha256: digest(entry), bundleSha256: digest(Buffer.from(bundle)), originals: [...originals].map(([path, identity]) => ({ path, ...identity })),
    scope: 'Exactly the browser bundler inputs read above; no complete native/API bootstrap closure claim' };
  writeFileSync(join(evidence, 'portal-browser-source.json'), JSON.stringify(sourceIdentity, null, 2));
  console.log('ROSTER_STOP_HTTP_PHASE browser-bundle-ready');

  const browser = await chromium.launch({ channel: process.env.PORTAL_BROWSER_CHANNEL ?? 'chrome', headless: true });
  const context = await browser.newContext();
  const cookie = (value: string) => ({ name: input.cookieName, value, url: base, httpOnly: true, sameSite: 'Lax' as const });
  const receipts: Array<{ status: number; body: any }> = [];
  const selectedMessageIds: string[] = [];
  const marker = `private-browser-${process.pid}`;
  const pageErrors: string[] = [];
  let page: Page | undefined;
  try {
    await context.addCookies([cookie(input.ownToken)]);
    page = await context.newPage();
    page.setDefaultTimeout(15_000);
    page.on('pageerror', error => pageErrors.push(error.message));
    const url = new URL(input.inbox ? '/?app=inbox&opci=alerts&opck=coord-message&opcsort=newest&q=retained-shell-search'
      : input.prompts ? '/?app=overview&panel=quick&q=retained-shell-search'
      : input.settings || input.shortcuts ? '/?app=settings' : '/?panel=agents', base); url.searchParams.set('ws', workspace);
    await page.goto(url.href);
    if (input.inbox) {
      const receipt = await runPrivateInboxPage(page, context, input);
      assert.deepEqual(pageErrors, [], 'real inbox controls must complete without browser errors');
      const retained = { ...receipt, browserBundleSha256: sourceIdentity.bundleSha256, originalSourceCount: originals.size };
      writeFileSync(join(evidence, 'portal-browser-receipt.json'), JSON.stringify(retained, null, 2));
      return retained;
    }
    if (input.prompts) {
      const receipt = await runPrivatePromptsTab(page, context, input);
      assert.deepEqual(pageErrors, [], 'real saved-prompt controls must complete without browser errors');
      const retained = { ...receipt, browserBundleSha256: sourceIdentity.bundleSha256, originalSourceCount: originals.size };
      writeFileSync(join(evidence, 'portal-browser-receipt.json'), JSON.stringify(retained, null, 2));
      return retained;
    }
    if (input.settings) {
      const receipt = await runPrivateProfilePage(page, context, input);
      assert.deepEqual(pageErrors, [], 'real Profile form must complete without browser errors');
      const result = { ...receipt, browserBundleSha256: sourceIdentity.bundleSha256, originalSourceCount: originals.size };
      writeFileSync(join(evidence, 'portal-browser-receipt.json'), JSON.stringify(result, null, 2));
      return result;
    }
    if (input.shortcuts) {
      const receipt = await runPrivateShortcutsPage(page, context, input);
      assert.deepEqual(pageErrors, [], 'real shortcut settings and dispatcher must complete without browser errors');
      const retained = { ...receipt, browserBundleSha256: sourceIdentity.bundleSha256, originalSourceCount: originals.size };
      writeFileSync(join(evidence, 'portal-browser-receipt.json'), JSON.stringify(retained, null, 2));
      return retained;
    }
    if (input.history) {
      const receipt = await runHistoryPage(page, input);
      assert.deepEqual(pageErrors, [], 'real history components must complete without browser errors');
      const retained = { ...receipt, browserBundleSha256: sourceIdentity.bundleSha256, originalSourceCount: originals.size };
      writeFileSync(join(evidence, 'portal-browser-receipt.json'), JSON.stringify(retained, null, 2));
      return retained;
    }
    const select = page.getByTestId(`agent-select-${selected}`);
    await select.check();
    assert.equal(await page.getByTestId(`agent-select-${neighbor}`).isChecked(), false);
    if (input.stop) {
      const receipt = await runConfirmedStopPage(page, context, input);
      assert.deepEqual(pageErrors, [], 'real stop component must complete without browser errors');
      const retained = { ...receipt, browserBundleSha256: sourceIdentity.bundleSha256, originalSourceCount: originals.size };
      writeFileSync(join(evidence, 'portal-browser-receipt.json'), JSON.stringify(retained, null, 2));
      return retained;
    }
    assert.ok(input.verifyReceipt, 'coord browser proof requires its persisted receipt verifier');
    await page.getByTestId('agents-bulk-message').click();
    await page.getByTestId('agents-bulk-msg').fill(marker);

    const send = async (button: string) => {
      const response = page.waitForResponse(response => new URL(response.url()).pathname === '/api/admin/coord/send'
        && response.request().method() === 'POST');
      await page.getByTestId(button).click();
      const observed = await response;
      const receipt = { status: observed.status(), body: await observed.json() };
      receipts.push(receipt); return receipt;
    };
    // An authenticated foreign workspace cookie against a retained own-workspace
    // selection is a real server denial, not a canned UI failure response.
    await context.addCookies([cookie(input.foreignToken)]);
    const denied = await send('agents-bulk-msg-send');
    assert.equal(denied.status, 403, JSON.stringify(denied.body));
    await page.getByTestId('agents-bulk-note').filter({ hasText: 'failed' }).waitFor();
    assert.equal(await page.getByTestId('agents-bulk-msg').inputValue(), marker, 'denied draft must survive');
    assert.equal((await readInbox(selected)).some(message => message.summary === marker), false,
      'denial must persist no partial selected delivery');
    assert.equal((await readInbox(neighbor)).some(message => message.summary === marker), false);

    await context.addCookies([cookie(input.ownToken)]);
    const accepted = await send('agents-bulk-msg-send');
    selectedMessageIds.push(await input.verifyReceipt(accepted, marker, false));
    await page.getByTestId('agents-bulk-note').filter({ hasText: 'Sent to 1 agent' }).waitFor();
    assert.equal(await page.getByTestId('agents-bulk-compose').count(), 0);
    const stored = await getMessageById(selectedMessageIds[0]);
    assert.equal(stored?.summary, marker); assert.deepEqual(stored?.to, [selected]);
    // Keep the real private origin, workspace and panel deep link through reload.
    await page.reload();
    assert.equal(page.url(), url.href);
    await page.getByTestId(`agent-select-${selected}`).check();
    assert.equal(await page.getByTestId(`agent-select-${neighbor}`).isChecked(), false);
    const wake = await send('agents-bulk-wake');
    selectedMessageIds.push(await input.verifyReceipt(wake, '(nudge from the portal)', true));
    assert.equal(wake.body.results[0].wake.pickupConfirmed, false);
    const note = await readSettledNote(page);
    assert.match(note, /pickup not confirmed|wake not delivered|message is in inbox/);
    assert.notEqual(selectedMessageIds[0], selectedMessageIds[1]);
    const neighborInbox = await readInbox(neighbor);
    assert.equal(neighborInbox.some(message => selectedMessageIds.includes(message.msg_id)), false);
    // Falsifier: the same durable receipt cannot prove delivery to the neighbor.
    assert.notDeepEqual((await getMessageById(selectedMessageIds[0]))?.to, [neighbor]);
    assert.deepEqual(pageErrors, [], 'real component must complete without browser errors');
    const receipt = { workspace, selected, neighbor, selectedMessageIds, authMethod: 'cookie-session',
      denialStatus: denied.status, draftRetained: true, retryClearedDraft: true, deepLinkReload: true,
      neighborIsolated: true, positiveControl: 'wrong-recipient rejected', receipts, wakeNote: note,
      browserBundleSha256: sourceIdentity.bundleSha256, originalSourceCount: originals.size,
      scope: 'Actual mounted Portal controls and private HTTP/inbox effects; no whole-Portal or parked-turn acceptance' };
    writeFileSync(join(evidence, 'portal-browser-receipt.json'), JSON.stringify(receipt, null, 2));
    return receipt;
  } catch (error) {
    if (page) {
      try { await retainPortalBrowserFailure(page, evidence, error, pageErrors); }
      catch (diagnosticError) { console.error('PORTAL_BROWSER_FAILURE_CAPTURE_ERROR', diagnosticError); }
    }
    throw error;
  } finally { await context.close(); await browser.close(); }
}

/** Actual workspace prompts outline and its production sync/write clients. */
async function runPrivatePromptsTab(page: Page, context: BrowserContext, input: PortalRosterBrowserInput) {
  const endpoint = '/api/agent-mcp/saved-prompts';
  const marker = `private-prompt-${process.pid}`;
  const body = `Saved private prompt body ${process.pid}`;
  const initialUrl = page.url();
  const writes: Array<{ path: string; status: number; body: any }> = [];
  const post = async (path: string, action: () => Promise<unknown>, expectedStatus = 200) => {
    const pending = page.waitForResponse(response => new URL(response.url()).pathname === endpoint + path
      && response.request().method() === 'POST');
    await action();
    const response = await pending;
    const receipt = { path, status: response.status(), body: await response.json() };
    writes.push(receipt);
    writeFileSync(join(input.evidence, 'portal-prompt-writes.json'), JSON.stringify(writes, null, 2));
    assert.equal(receipt.status, expectedStatus, JSON.stringify(receipt.body));
    return receipt;
  };
  const stored = async () => {
    const response = await page.request.get(input.base + endpoint);
    assert.equal(response.status(), 200);
    return (await response.json()).prompts as Array<{ id: string; title: string | null; body: string }>;
  };
  const create = page.getByRole('button', { name: 'New prompt', exact: true });
  await page.getByRole('tree', { name: 'Saved prompts outline' }).waitFor();
  assert.deepEqual(await stored(), [], 'disposable workspace must begin without saved prompts');
  const first = await post('/node', () => create.click());
  const id = first.body.prompt.id as string;
  const title = page.locator('.pc-qp__nodetitle');
  await title.waitFor();
  await post('/node/update', async () => { await title.fill(marker); await title.blur(); });
  assert.equal((await stored()).find(row => row.id === id)?.title, marker);
  await title.press('Shift+Enter');
  const note = page.locator('.pc-qp__note');
  await note.waitFor();
  await post('/node/update', async () => { await note.fill(body); await note.blur(); });
  assert.equal((await stored()).find(row => row.id === id)?.body, body);
  await page.reload();
  await page.getByRole('textbox', { name: `Title of ${marker}`, exact: true }).waitFor();
  assert.equal(await note.inputValue(), body, 'exact saved body must survive reload');
  const filter = page.getByRole('textbox', { name: 'Filter prompts', exact: true });
  await filter.fill(marker);
  await page.waitForFunction(value => new URL(location.href).searchParams.get('qpq') === value, marker);
  const zoom = page.getByRole('button', { name: `Zoom into ${marker} (drag to move)`, exact: true });
  assert.notEqual(await zoom.getAttribute('aria-disabled'), 'true', 'filter disables dragging, not the independent zoom action');
  await zoom.click();
  await page.waitForFunction(value => new URL(location.href).searchParams.get('qpzoom') === value, id);
  const deepLink = page.url();
  await page.reload();
  await page.getByRole('textbox', { name: 'Zoomed node title', exact: true }).waitFor();
  assert.equal(page.url(), deepLink);
  assert.equal(await page.getByRole('textbox', { name: 'Zoomed node title', exact: true }).inputValue(), marker);
  assert.equal(await note.inputValue(), body);
  const params = new URL(page.url()).searchParams;
  assert.equal(params.get('q'), 'retained-shell-search');
  assert.equal(params.get('qpsel'), id);
  assert.equal(params.get('qpq'), marker);
  assert.equal(params.get('ws'), input.workspace);
  assert.equal(params.get('panel'), 'quick');
  await page.goto(initialUrl);
  await page.getByRole('textbox', { name: `Title of ${marker}`, exact: true }).waitFor();
  const beforeDenial = await stored();
  // As with Profile, relay a real upstream Origin denial unchanged. Ordinary
  // positive writes remain the production browser fetch; no fake API result.
  await context.route('**/api/agent-mcp/saved-prompts/node', async route => {
    const response = await route.fetch({ headers: { ...route.request().headers(), origin: 'https://unapproved.invalid' } });
    await route.fulfill({ response });
  });
  const denied = await post('/node', () => create.click(), 403);
  await page.getByText(/^Create failed:/).waitFor();
  assert.deepEqual(await stored(), beforeDenial,
    'denied create must preserve exactly the existing prompt');
  assert.equal(await title.inputValue(), marker, 'denied create must preserve the existing outline');
  await context.unroute('**/api/agent-mcp/saved-prompts/node');
  const retry = await post('/node', () => create.click());
  assert.notEqual(retry.body.prompt.id, id);
  const finalRows = await stored();
  assert.equal(finalRows.length, 2);
  assert.equal(finalRows.find(row => row.id === id)?.body, body);
  const result = { workspace: input.workspace, authMethod: 'private-loopback-prompts-with-cookie',
    createdId: id, retryId: retry.body.prompt.id, savedExactValue: true, bodySavedByKeyboard: true,
    deepLinkReload: true, shellQueryPreserved: true, denialStatus: denied.status,
    deniedWriteIsolated: true, existingOutlineRetained: true, retryPersisted: true, writes,
    denialTransport: 'real-upstream-response-forwarded',
    scope: 'Actual qp-prefixed PromptsTab with production polling sync and saved-prompt clients on a disposable private loopback API; exact create/title/note persistence, zoom/filter/selection reload and real upstream Origin-denial recovery. Host panel geometry is supplied; hosted tenant authorization and complete Quick Panel navigation are unmeasured' };
  writeFileSync(join(input.evidence, 'portal-prompts-dom.html'), await page.content());
  return result;
}

/** The same Profile page the maintained Settings surface selects by default. */
async function runPrivateProfilePage(page: Page, context: BrowserContext, input: PortalRosterBrowserInput) {
  const profile = new URL('/api/profile', input.base).href;
  const name = page.getByPlaceholder('Your name', { exact: true });
  const save = page.getByRole('button', { name: 'Save', exact: true });
  const marker = `private-settings-${process.pid}`;
  const draft = marker + '-retry';
  const writes: Array<{ status: number; origin: string | undefined; body: unknown }> = [];
  const submit = async (expectedStatus: number) => {
    const pending = page.waitForResponse(r => r.url() === profile && r.request().method() === 'POST');
    await save.click();
    const response = await pending;
    const receipt = { status: response.status(), origin: response.request().headers().origin, body: await response.json() };
    writes.push(receipt);
    writeFileSync(join(input.evidence, 'portal-profile-writes.json'), JSON.stringify(writes, null, 2));
    assert.equal(receipt.status, expectedStatus, JSON.stringify(receipt.body));
    return receipt;
  };
  await name.waitFor();
  await name.fill(marker);
  await submit(200);
  await page.getByText('Profile saved', { exact: true }).waitFor();
  assert.equal((await (await page.request.get(profile)).json()).display_name, marker,
    'actual Profile submit must persist the exact displayed name');
  const reloadUrl = page.url();
  await page.reload();
  assert.equal(page.url(), reloadUrl);
  assert.equal(new URL(page.url()).searchParams.get('ws'), input.workspace);
  assert.equal(new URL(page.url()).searchParams.get('app'), 'settings');
  await name.waitFor();
  assert.equal(await name.inputValue(), marker);
  await name.fill(draft);
  // Chromium synthesizes Origin even after route.continue header overrides.
  // Forward an ACTUAL upstream denied response through the API transport;
  // no status/body is invented. This branch proves form error handling and
  // retry, not a native browser foreign-Origin request. Positive saves remain
  // unmodified browser fetches, and the cheap preflight verifies this seam.
  await context.route('**/api/profile', async route => {
    const response = await route.fetch({ headers: { ...route.request().headers(), origin: 'https://unapproved.invalid' } });
    await route.fulfill({ response });
  });
  const denied = await submit(403);
  await page.getByText('save failed: HTTP 403', { exact: true }).waitFor();
  assert.equal(await name.inputValue(), draft, 'denied Profile save must retain the form draft');
  await context.unroute('**/api/profile');
  assert.equal((await (await page.request.get(profile)).json()).display_name, marker,
    'denied Profile save must leave stored state untouched');
  await submit(200);
  assert.equal((await (await page.request.get(profile)).json()).display_name, draft,
    'retry must persist the retained draft');
  await page.reload();
  await name.waitFor();
  assert.equal(await name.inputValue(), draft);
  const result = { workspace: input.workspace, authMethod: 'private-loopback-profile-with-cookie',
    savedExactValue: true, deepLinkReload: true, denialStatus: denied.status, draftRetained: true,
    deniedWriteIsolated: true, retryPersisted: true, retryReload: true, writes,
    denialTransport: 'real-upstream-response-forwarded',
    scope: 'Actual default Settings Profile page, unmodified private loopback save/reload/retry, and form handling of a real upstream Origin denial forwarded by the test proxy; no native-browser foreign-Origin, full Settings navigation or hosted tenant-profile acceptance' };
  writeFileSync(join(input.evidence, 'portal-profile-dom.html'), await page.content());
  return result;
}

/** Real shared split InboxPane and persisted private acknowledgment. */
async function runPrivateInboxPage(page: Page, context: BrowserContext, input: PortalRosterBrowserInput) {
  const inbox = input.inbox!;
  const selectedId = 'coord-message:' + inbox.selectedMessageId;
  const neighborId = 'coord-message:' + inbox.neighborMessageId;
  const selected = page.getByTestId('inbox-row-' + selectedId);
  const neighbor = page.getByTestId('inbox-row-' + neighborId);
  const detail = page.getByTestId('inbox-expanded-' + selectedId);
  const endpoint = new URL('/api/admin/coord/ack', input.base).href;
  const writes: Array<{ status: number; target: string; body: unknown }> = [];
  const assertState = async (acked: boolean) => {
    const ids = await readAckedMsgIds('pc-admin-coord-ui');
    assert.equal(ids.has(inbox.selectedMessageId), acked, 'only the selected acknowledgment may change');
    assert.equal(ids.has(inbox.neighborMessageId), false, 'neighbor acknowledgment must remain untouched');
  };
  await page.locator('[data-testid="inbox-tab"][data-layout="split"]').waitFor();
  await selected.waitFor(); await neighbor.waitFor();
  await assertState(false);
  await selected.focus(); await page.keyboard.press('Enter');
  await page.waitForURL(url => url.searchParams.get('opcis') === selectedId);
  await detail.getByText(inbox.selectedTitle + ' body', { exact: true }).waitFor();
  assert.equal(await detail.getByText(inbox.neighborTitle + ' body', { exact: true }).count(), 0);
  const selectedUrl = page.url();
  await page.reload();
  await detail.getByText(inbox.selectedTitle + ' body', { exact: true }).waitFor();
  assert.equal(page.url(), selectedUrl, 'inbox filters, selection and workspace must survive reload');
  const acknowledge = async () => {
    const pending = page.waitForResponse(response => response.url() === endpoint && response.request().method() === 'POST');
    await detail.getByRole('button', { name: 'Acknowledge', exact: true }).click();
    const response = await pending;
    const target = response.request().postDataJSON().msg_id;
    assert.equal(target, inbox.selectedMessageId, 'the rendered action must name the selected message');
    const receipt = { status: response.status(), target, body: await response.json() };
    writes.push(receipt);
    writeFileSync(join(input.evidence, 'portal-inbox-writes.json'), JSON.stringify(writes, null, 2));
    return receipt;
  };
  // Relay a real private API denial. The browser cannot override its own Origin.
  await context.route('**/api/admin/coord/ack', async route => {
    const response = await route.fetch({ headers: { ...route.request().headers(), origin: 'https://unapproved.invalid' } });
    await route.fulfill({ response });
  });
  const denied = await acknowledge();
  assert.equal(denied.status, 403);
  await page.getByText('Action failed', { exact: true }).waitFor();
  await assertState(false);
  assert.equal(new URL(page.url()).searchParams.get('opcis'), selectedId);
  await detail.getByRole('button', { name: 'Acknowledge', exact: true }).waitFor();
  await context.unroute('**/api/admin/coord/ack');
  const accepted = await acknowledge();
  assert.equal(accepted.status, 200, JSON.stringify(accepted));
  await assertState(true);
  await selected.waitFor({ state: 'detached' });
  await neighbor.waitFor();
  await page.reload();
  await neighbor.waitFor();
  assert.equal(await selected.count(), 0, 'acknowledged message must stay absent after a fresh real feed read');
  await assertState(true);
  const params = new URL(page.url()).searchParams;
  for (const [key, value] of [['app', 'inbox'], ['ws', input.workspace], ['q', 'retained-shell-search'],
    ['opci', 'alerts'], ['opck', 'coord-message'], ['opcsort', 'newest']]) assert.equal(params.get(key), value);
  return { workspace: input.workspace, authMethod: 'private-loopback-inbox-with-cookie', selectedId, neighborId,
    keyboardSelection: true, deepLinkReload: true, shellQueryPreserved: true, denialStatus: denied.status,
    selectionRetained: true, deniedWriteIsolated: true, retryPersisted: true, neighborIsolated: true, writes,
    denialTransport: 'real-upstream-response-forwarded',
    scope: 'Actual utility.inbox shared split InboxPane, attention sync/detail and private coord acknowledgment; two private producer messages, exact reload and real upstream Origin-denial recovery. Portal navigation geometry is supplied; hosted tenant authorization and bulk resolve are unmeasured' };
}

/** Browser wire precondition, not product/API authorization evidence. */
export async function verifyPrivateProfileOriginControl() {
  const forbidden = 'https://unapproved.invalid';
  const server = createServer((request, response) => {
    if (request.url === '/api/profile') {
      const origin = request.headers.origin ?? null;
      response.writeHead(origin === forbidden ? 403 : 200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ origin }));
    } else {
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end('<button>Save</button><script>document.querySelector("button").onclick=()=>fetch("/api/profile",{method:"POST",body:"{}"})</script>');
    }
  });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    browser = await chromium.launch({ channel: process.env.PORTAL_BROWSER_CHANNEL ?? 'chrome', headless: true });
    const context = await browser.newContext();
    const page = await context.newPage();
    page.setDefaultTimeout(10_000);
    await page.goto(base);
    const submit = async () => {
      const pending = page.waitForResponse(response => response.url() === base + '/api/profile');
      await page.getByRole('button', { name: 'Save', exact: true }).click();
      const response = await pending;
      return { status: response.status(), ...await response.json() };
    };
    await context.setExtraHTTPHeaders({ origin: forbidden });
    const oldControl = await submit();
    await context.setExtraHTTPHeaders({});
    await context.route('**/api/profile', async route => {
      const response = await route.fetch({ headers: { ...route.request().headers(), origin: forbidden } });
      await route.fulfill({ response });
    });
    const continuedControl = await submit();
    assert.equal(continuedControl.origin, forbidden, 'denial input must arrive on the wire');
    assert.equal(continuedControl.status, 403, 'wire control must exercise the denied response');
    const receipt = { base, oldControl, continuedControl, scope: 'Local echo-server browser wire preflight only' };
    console.info('PROFILE_ORIGIN_PREFLIGHT ' + JSON.stringify(receipt));
    return receipt;
  } finally {
    await browser?.close();
    server.closeAllConnections();
    await new Promise<void>(done => server.close(() => done()));
  }
}

/** Real settings mutation and shortcut bus; only host navigation geometry is supplied. */
async function runPrivateShortcutsPage(page: Page, context: BrowserContext, input: PortalRosterBrowserInput) {
  const profile = new URL('/api/profile', input.base).href;
  const panel = page.getByTestId('private-shortcut-panel');
  const row = page.locator('.kbd-settings-row').filter({ has: page.getByRole('textbox', {
    name: 'Combo for Open or close the command palette', exact: true }) });
  const combo = row.getByRole('textbox');
  await combo.waitFor();
  const defaultCombo = await combo.inputValue();
  assert.match(defaultCombo, /mod\+k/);
  const writes: Array<{ status: number; body: unknown }> = [];
  const change = async (action: () => Promise<unknown>) => {
    const response = page.waitForResponse(r => r.url() === profile && r.request().method() === 'POST');
    await action();
    const r = await response;
    const receipt = { status: r.status(), body: await r.json() };
    writes.push(receipt);
    assert.equal(receipt.status, 200, JSON.stringify(receipt.body));
  };
  await change(() => combo.fill('alt+k'));
  await page.locator('h1').click();
  await page.keyboard.press('Control+k');
  assert.equal(await panel.innerText(), 'none', 'old default must stop dispatching after remap');
  await page.keyboard.press('Alt+k');
  await panel.filter({ hasText: /^launcher$/ }).waitFor();
  assert.equal(new URL(page.url()).searchParams.get('panel'), 'launcher');
  await page.keyboard.press('Alt+k');
  await panel.filter({ hasText: /^none$/ }).waitFor();
  const stored = await page.request.get(profile);
  assert.equal(stored.status(), 200);
  const storedBody = await stored.json();
  assert.equal(storedBody.shortcut_overrides['palette.toggle'], 'alt+k', 'real private profile must retain remap');
  const reloadUrl = page.url();
  await page.reload();
  assert.equal(page.url(), reloadUrl);
  assert.equal(new URL(page.url()).searchParams.get('ws'), input.workspace);
  await combo.waitFor();
  assert.equal(await combo.inputValue(), 'alt+k');
  await page.locator('h1').click();
  await page.keyboard.press('Alt+k');
  await panel.filter({ hasText: /^launcher$/ }).waitFor();
  await page.keyboard.press('Alt+k');
  await panel.filter({ hasText: /^none$/ }).waitFor();
  // Profile POST uses the real loopback boundary, not roster cookie auth.
  const denied = await page.request.post(profile, { headers: { origin: 'https://unapproved.invalid' },
    data: { shortcut_overrides: { 'palette.toggle': 'alt+x' } } });
  assert.equal(denied.status(), 403);
  assert.equal((await (await page.request.get(profile)).json()).shortcut_overrides['palette.toggle'], 'alt+k');
  await change(() => row.getByRole('button', { name: 'Reset', exact: true }).click());
  assert.equal(await combo.inputValue(), defaultCombo);
  await page.locator('h1').click();
  await page.keyboard.press('Alt+k');
  assert.equal(await panel.innerText(), 'none', 'reset must retire the customized chord');
  await page.keyboard.press('Control+k');
  await panel.filter({ hasText: /^launcher$/ }).waitFor();
  const reset = await page.request.get(profile);
  assert.equal(reset.status(), 200);
  assert.equal((await reset.json()).shortcut_overrides['palette.toggle'], undefined);
  return { workspace: input.workspace, authMethod: 'private-loopback-profile-with-cookie', remapImmediate: true, remapPersisted: true,
    deepLinkReload: true, resetRestoredDefault: true, denialStatus: denied.status(), deniedWriteIsolated: true,
    oldChordFalsifier: true, writes,
    scope: 'Actual Portal shortcut bindings, shared settings/dispatcher and private loopback profile HTTP with Origin denial; host navigation geometry is a fixture, no hosted tenant-profile or full Portal acceptance' };
}

async function runHistoryPage(page: Page, input: PortalRosterBrowserInput) {
  const history = input.history!;
  const streams: Array<{ url: string; status: number }> = [];
  const requests: string[] = [];
  const expected = {
    selected: { ownerId: input.selected, sessionId: history.selectedSessionId, rolloutId: history.selectedRolloutId },
    neighbor: { ownerId: input.neighbor, sessionId: history.neighborSessionId, rolloutId: history.neighborRolloutId },
  };
  const retainStreams = () => writeFileSync(join(input.evidence, 'portal-history-streams.json'),
    JSON.stringify({ expected, requests, streams }, null, 2));
  page.on('request', request => {
    if (new URL(request.url()).pathname !== '/api/adv/session/thinking') return;
    requests.push(request.url()); retainStreams();
  });
  page.on('response', response => {
    if (new URL(response.url()).pathname !== '/api/adv/session/thinking') return;
    streams.push({ url: response.url(), status: response.status() }); retainStreams();
  });
  await page.getByTestId('agent-row-' + input.selected).click();
  await page.waitForURL(url => url.searchParams.get('agentHistory') === input.selected && !url.searchParams.has('panel'));
  assert.equal(new URL(page.url()).searchParams.has('agentConversation'), false, 'history activation must not silently open the HUD conversation');
  await page.getByText(history.selectedMarker, { exact: true }).waitFor();
  assert.equal(await page.getByText(history.neighborMarker, { exact: true }).count(), 0, 'selected history cannot render the neighbor transcript');
  const historyUrl = page.url();
  await page.reload();
  await page.getByText(history.selectedMarker, { exact: true }).waitFor();
  assert.equal(page.url(), historyUrl, 'history selection and workspace must survive reload');
  await page.getByTestId('agent-history-open-conversation').click();
  await page.waitForURL(url => url.searchParams.get('agentConversation') === input.selected
    && url.searchParams.get('hudsession') === input.selected && url.searchParams.get('app') === 'hud'
    && !url.searchParams.has('agentHistory') && !url.searchParams.has('agentHistorySession'));
  assert.equal(await page.getByTestId('private-conversation-selection').innerText(), input.selected);
  const conversationUrl = page.url();
  await page.reload();
  assert.equal(await page.getByTestId('private-conversation-selection').innerText(), input.selected);
  assert.equal(page.url(), conversationUrl);
  retainStreams();
  verifyPrivateHistoryStreams(streams, expected);
  return { workspace: input.workspace, selected: input.selected, neighbor: input.neighbor,
    selectedSessionId: history.selectedSessionId, authMethod: 'cookie-session', historyUrl, conversationUrl,
    historyKeptSeparate: true, historyReload: true, explicitGuiSelection: true, conversationSelectionReload: true,
    neighborIsolated: true, streams,
    scope: 'Actual Portal roster URL action, operator history modal, owner-session resolver and private native transcript SSE; HUD target selection only, no full HUD rendering or parked-turn proof' };
}

async function runConfirmedStopPage(page: Page, context: BrowserContext, input: PortalRosterBrowserInput) {
  const stop = input.stop!;
  const path = '/api/adv/sessions/close-window';
  const requests: Record<string, unknown>[] = [];
  page.on('request', request => {
    if (new URL(request.url()).pathname === path && request.method() === 'POST') requests.push(request.postDataJSON());
  });
  const button = page.getByTestId('agents-bulk-kill');
  const arm = async () => {
    await button.click();
    assert.match(await button.innerText(), /Confirm stop 1/);
  };
  const confirm = async () => {
    const response = page.waitForResponse(response => new URL(response.url()).pathname === path && response.request().method() === 'POST');
    await button.click();
    const observed = await response;
    return { status: observed.status(), body: await observed.json() };
  };
  await arm();
  await page.getByTestId('agents-bulk-kill-cancel').click();
  assert.doesNotMatch(await button.innerText(), /Confirm/);
  await stop.assertChildrenAlive();
  assert.equal(requests.length, 0, 'arming and cancelling must send no stop request');

  const cookie = (value: string) => ({ name: input.cookieName, value, url: input.base, httpOnly: true, sameSite: 'Lax' as const });
  await context.addCookies([cookie(input.foreignToken)]);
  await arm();
  const denied = await confirm();
  assert.equal(denied.status, 403, JSON.stringify(denied.body));
  await page.getByTestId('agents-bulk-note').filter({ hasText: /stale|foreign|403/ }).waitFor();
  assert.equal(await page.getByTestId(`agent-select-${input.selected}`).isChecked(), true, 'denial must retain exact selection');
  assert.equal(await page.getByTestId(`agent-select-${input.neighbor}`).isChecked(), false);
  await stop.assertChildrenAlive();

  await context.addCookies([cookie(input.ownToken)]);
  await arm();
  const accepted = await confirm();
  const expected = { ownerId: input.selected, managedSessionId: stop.selected.id, startedAt: stop.selected.startedAt };
  verifyPrivateStopReceipt(accepted, expected);
  // The actual receipt cannot attest a neighbor or a replacement launch.
  assert.throws(() => verifyPrivateStopReceipt(accepted, { ...expected, managedSessionId: stop.neighbor.id }), /selected-session receipt correlation/);
  assert.throws(() => verifyPrivateStopReceipt(accepted, { ...expected, startedAt: stop.neighbor.startedAt + '-replacement' }), /selected-launch stop receipt correlation/);
  await page.getByTestId('agents-bulk-note').filter({ hasText: 'Stop requested for 1 session' }).waitFor();
  assert.equal(await page.getByTestId(`agent-select-${input.selected}`).isChecked(), false);
  assert.deepEqual(requests, [expected, expected].map(target => ({ ownerId: target.ownerId,
    managedSessionId: target.managedSessionId, expectedStartedAt: target.startedAt, confirmed: true })),
  'denial and retry must preserve the same server-resolved launch; no process/window handles');
  await stop.assertSelectedStopped();
  const url = page.url();
  await page.reload();
  assert.equal(page.url(), url);
  await page.getByTestId(`agent-select-${input.neighbor}`).waitFor();
  // A second session remains controllable after the selected stop. Cancelling
  // its confirmation cannot dispatch; an old launch must then be refused.
  await page.getByTestId(`agent-select-${input.neighbor}`).check();
  await arm();
  await page.getByTestId('agents-bulk-kill-cancel').click();
  await stop.assertNeighborAlive();
  assert.equal(requests.length, 2, 'cancelling a second stop must not dispatch');
  await stop.invalidateNeighborLaunch();
  await arm();
  const stale = await confirm();
  assert.equal(stale.status, 403, JSON.stringify(stale.body));
  await page.getByTestId('agents-bulk-note').filter({ hasText: /stale|foreign/ }).waitFor();
  await stop.assertNeighborAlive();
  assert.deepEqual(requests[2], { ownerId: input.neighbor, managedSessionId: stop.neighbor.id,
    expectedStartedAt: stop.neighbor.startedAt, confirmed: true }, 'stale replay must name the original launch');
  assert.equal(requests.length, 3);
  return { workspace: input.workspace, authMethod: 'cookie-session', selected: { owner: input.selected, id: stop.selected.id, ended: true },
    neighbor: { owner: input.neighbor, id: stop.neighbor.id, alive: true }, cancelSentNoRequest: true, denialStatus: denied.status,
    selectionRetained: true, retryClearedSelection: true, deepLinkReload: true, neighborIsolated: true,
    secondCancelSentNoRequest: true, staleDenialStatus: stale.status,
    positiveControl: 'wrong-session and replacement-launch rejected', denied, accepted, stale, requests,
    scope: 'Actual mounted Portal confirmation and private cookie API/native effects; no whole-Portal or shipment acceptance' };
}

async function readSettledNote(page: Page) {
  const note = page.getByTestId('agents-bulk-note');
  await note.waitFor();
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const text = await note.innerText();
    if (/pickup not confirmed|wake not delivered|message is in inbox/.test(text)) return text;
    await page.waitForTimeout(50);
  }
  throw new Error('Wake receipt did not settle to a truthful delivery disposition');
}
