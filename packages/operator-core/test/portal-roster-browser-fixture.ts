/** Actual Portal roster controls against the disposable cookie-authenticated API. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { build } from 'esbuild';
import { chromium, type BrowserContext, type Page } from 'playwright-core';
import { getMessageById, readInbox } from '../lib/agent-tools/coordination/messages';
import { verifyPrivateStopReceipt } from './private-coord-receipt';

const digest = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');

type PortalRosterBrowserInput = {
  evidence: string; base: string; workspace: string; selected: string; neighbor: string;
  portalSourceRoot: string;
  cookieName: string; ownToken: string; foreignToken: string;
  verifyReceipt?: (receipt: { status: number; body: any }, summary: string, wake: boolean) => Promise<string>;
  stop?: {
    selected: { id: number; startedAt: string }; neighbor: { id: number; startedAt: string };
    assertChildrenAlive: () => Promise<void>; assertSelectedStopped: () => Promise<void>;
  };
};

export async function runPortalRosterBrowser(input: PortalRosterBrowserInput) {
  const { evidence, base, workspace, selected, neighbor } = input;
  const portal = realpathSync(input.portalSourceRoot);
  const spa = join(evidence, 'portal-roster-spa');
  mkdirSync(spa, { recursive: true });
  const rows = [selected, neighbor].map(ownerId => ({ ownerId, label: ownerId, agent: 'codex', role: 'worker',
    intent: 'Private browser roster canary', feature: null, currentPlanSlug: null, liveness: 'live',
    sessionState: 'live', heartbeatAt: new Date().toISOString(), lastActiveAt: new Date().toISOString(),
    isLocal: true, transcriptFresh: false,
    ...(input.stop ? { managedSessionId: (ownerId === selected ? input.stop.selected : input.stop.neighbor).id,
      launchStartedAt: (ownerId === selected ? input.stop.selected : input.stop.neighbor).startedAt } : {}) }));
  // Only the host geometry and supplied roster population are fixtures. The
  // component's native fetch, callbacks and HTTP receipts stay unmodified.
  const entry = `
    import * as React from 'react';
    import { createRoot } from 'react-dom/client';
    import { PortalAgentsPopover } from './packages/ui/src/agents-popover.tsx';
    createRoot(document.getElementById('root')).render(React.createElement(PortalAgentsPopover, {
      agents: ${JSON.stringify(rows)}, open: true, onClose: () => {},
      loadEndedSessions: async () => ({ sessions: [], hasMore: false, nextBefore: null }),
    }));
  `;
  const originals = new Map<string, { sha256: string; bytes: number }>();
  const result = await build({ absWorkingDir: portal,
    stdin: { contents: entry, loader: 'ts', resolveDir: portal, sourcefile: 'private-roster-browser-entry.ts' },
    alias: { react: resolve(portal, 'node_modules/react'), 'react-dom': resolve(portal, 'node_modules/react-dom') },
    bundle: true, format: 'iife', platform: 'browser', target: 'es2022', write: false,
    plugins: [{ name: 'retain-executed-browser-inputs', setup(builder) {
      builder.onLoad({ filter: /\.[cm]?[jt]sx?$/ }, ({ path }) => {
        const contents = readFileSync(path);
        originals.set(path, { sha256: digest(contents), bytes: contents.length });
        const extension = extname(path).slice(1);
        return { contents, loader: extension === 'tsx' || extension === 'jsx' ? extension : extension === 'ts' ? 'ts' : 'js' };
      });
    } }],
  });
  const bundle = result.outputFiles[0].contents;
  for (const [path, identity] of originals) assert.equal(digest(readFileSync(path)), identity.sha256,
    `Browser input changed during build: ${path}`);
  assert.ok([...originals.keys()].some(path => path.endsWith('/packages/ui/src/agents-popover.tsx')),
    'Executed bundle must contain the actual Portal control');
  writeFileSync(join(spa, 'portal-roster.js'), bundle);
  writeFileSync(join(spa, 'portal-roster.css'), readFileSync(join(portal, 'app/tokens.css'), 'utf8') + '\n'
    + readFileSync(join(portal, 'app/globals.css'), 'utf8'));
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
  try {
    await context.addCookies([cookie(input.ownToken)]);
    const page = await context.newPage();
    page.setDefaultTimeout(15_000);
    page.on('pageerror', error => pageErrors.push(error.message));
    const url = new URL('/?panel=agents', base); url.searchParams.set('ws', workspace);
    await page.goto(url.href);
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
  } finally { await context.close(); await browser.close(); }
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
  return { workspace: input.workspace, authMethod: 'cookie-session', selected: { owner: input.selected, id: stop.selected.id, ended: true },
    neighbor: { owner: input.neighbor, id: stop.neighbor.id, alive: true }, cancelSentNoRequest: true, denialStatus: denied.status,
    selectionRetained: true, retryClearedSelection: true, deepLinkReload: true, neighborIsolated: true,
    positiveControl: 'wrong-session and replacement-launch rejected', denied, accepted, requests,
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
