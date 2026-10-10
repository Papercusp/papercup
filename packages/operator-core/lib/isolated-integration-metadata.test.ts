/** Cheap guard for the context API used by the expensive private-worker fixture. */
import { expect, it, vi } from 'vitest';
import { ChildProcess, fork, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { PassThrough } from 'node:stream';
import { build } from 'esbuild';
import { captureIsolatedWorker, isolatedIntegrationCases, isolatedTestFileWorkerOptions, isolatedWorkerFailureDetail } from '../test/isolated-integration-proof';
import { portalBrowserPackagesPlugin, preparePortalBrowserSource, preparePrivateDocsBrowserDocuments, preparePrivateHttpWorkspaces, preparePrivateRosterSocketRoot } from '../test/private-http-workspace-preflight';
import { verifyPrivateCoordReceipt, verifyPrivateHistoryStreams, verifyPrivateStopReceipt } from '../test/private-coord-receipt';
import { buildSessionStreamUrl, sessionTargetFromRoster } from '../../../apps/operator/app/_components/chat/use-owner-session-chat';
import { Hono } from 'hono';
import { workspaceContextMiddleware } from './workspace-context-middleware';
import { retainPortalBrowserFailure, verifyPrivateProfileOriginControl } from '../test/portal-roster-browser-fixture';

it('checks private socket capacity in bytes before runtime allocation, including multibyte scratch roots', () => {
  const suffix = '/papercusp-test-runtime-XXXXXX/tmp/rs-XXXXXX/su-rs-123456789-neighbor.sock';
  const rootAtLimit = '/' + 'x'.repeat(103 - Buffer.byteLength(suffix) - 1);
  expect(Buffer.byteLength(preparePrivateRosterSocketRoot(rootAtLimit))).toBe(103);
  expect(() => preparePrivateRosterSocketRoot(rootAtLimit + 'x')).toThrow('native socket capacity');
  expect(() => preparePrivateRosterSocketRoot('/mnt/backup/d813-history4-ldcW0D')).toThrow('native socket capacity');
  expect(() => preparePrivateRosterSocketRoot('/' + 'é'.repeat(20))).toThrow('native socket capacity');
  expect(() => preparePrivateRosterSocketRoot('relative')).toThrow('must be absolute');
  expect(preparePrivateRosterSocketRoot('/mnt/backup/h-XXXXXX')).toContain('/tmp/rs-XXXXXX/');
});

it('preserves a top-level native assertion and stack before long PG cleanup output', () => {
  const failure = 'AssertionError [ERR_ASSERTION]: private socket directory exceeds the native address limit\n'
    + '    at fixture.ts:28:8\n';
  const detail = isolatedWorkerFailureDetail('bootstrap\n' + failure + '\n' + 'cleanup observation\n'.repeat(2_000));
  expect(detail).toContain(failure.trim());
  expect(detail.length).toBeLessThan(500);
});

it.each([null, 'selected-rollout'])('correlates the production Codex stream key with native discovery %s', rolloutId => {
  const expected = {
    selected: { ownerId: 'selected', sessionId: 17, rolloutId: 'selected-rollout' },
    neighbor: { ownerId: 'neighbor', sessionId: 18, rolloutId: 'neighbor-rollout' },
  };
  const target = sessionTargetFromRoster({ agent: 'codex', advSessionId: 17,
    nativeSession: { backend: 'codex', source: 'adv_sessions', ownerId: 'selected', codexHome: '/private/codex',
      rolloutId, exactResumeSupported: Boolean(rolloutId), missingReason: null } });
  const url = 'http://private.test' + buildSessionStreamUrl('selected', target);
  expect(verifyPrivateHistoryStreams([{ url, status: 200 }], expected)).toEqual([{ url, status: 200 }]);
  // The old numeric-key-only oracle rejects a legitimate production rollout URL.
  expect(new URL(url).searchParams.get('codexSessionKey') === '17').toBe(rolloutId === null);
  for (const stream of [
    { url: url.replace('historyOwner=selected', 'historyOwner=neighbor'), status: 200 },
    { url: url.replace('17', '18').replace('selected-rollout', 'neighbor-rollout'), status: 200 },
    { url, status: 403 },
  ]) expect(() => verifyPrivateHistoryStreams([stream], expected)).toThrow();
  expect(() => verifyPrivateHistoryStreams([{ url, status: 200 }, {
    url: 'http://private.test/api/adv/session/thinking?codexRolloutId=neighbor-rollout&historyOwner=selected', status: 200,
  }], expected)).toThrow('no neighbor stream');
  expect(() => verifyPrivateHistoryStreams([{ url, status: 200 }, {
    url: 'http://private.test/api/adv/session/thinking?codexSessionKey=18&historyOwner=selected', status: 200,
  }], expected)).toThrow('no neighbor stream');
});

it('retains the original browser error and rendered controls when screenshot capture fails', async () => {
  const root = mkdtempSync(join(tmpdir(), 'private-browser-failure-'));
  try {
    const page = {
      url: () => 'http://private.test/?agentHistory=selected',
      content: async () => '<button>Open conversation</button>',
      locator: () => ({ innerText: async () => 'selected transcript', allTextContents: async () => ['Open conversation'] }),
      screenshot: async () => { throw new Error('screenshot unavailable'); },
    } as unknown as Parameters<typeof retainPortalBrowserFailure>[0];
    await retainPortalBrowserFailure(page, root, new Error('original missing-control failure'), ['original page error']);
    expect(JSON.parse(readFileSync(join(root, 'portal-browser-failure.json'), 'utf8'))).toMatchObject({
      url: 'http://private.test/?agentHistory=selected', message: 'original missing-control failure',
      text: 'selected transcript', buttons: ['Open conversation'], pageErrors: ['original page error'],
      diagnosticErrors: [{ index: 3, message: 'Error: screenshot unavailable' }],
    });
    expect(readFileSync(join(root, 'portal-browser-failure.html'), 'utf8')).toContain('Open conversation');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

function writeNuqsExportFixture(root: string) {
  const files = {
    'node_modules/nuqs/package.json': JSON.stringify({ name: 'nuqs', type: 'module', exports: {
      '.': './dist/index.js', './adapters/react': './dist/adapters/react.js' } }),
    'node_modules/nuqs/dist/index.js': "export { context } from './context.js';",
    'node_modules/nuqs/dist/adapters/react.js': "export { context } from '../context.js';",
    'node_modules/nuqs/dist/context.js': 'export const context = {};',
  };
  for (const [file, contents] of Object.entries(files)) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), contents);
  }
}

it('bundles exported Nuqs adapters and pins cross-checkout consumers to one Portal context', async () => {
  const root = mkdtempSync(join(tmpdir(), 'private-portal-nuqs-'));
  try {
    const portal = join(root, 'portal');
    const operator = join(root, 'operator');
    writeNuqsExportFixture(portal);
    writeNuqsExportFixture(operator);
    writeFileSync(join(operator, 'consumer.js'), "export { context } from 'nuqs';");
    const result = await build({ stdin: { contents: `import { context } from 'nuqs';
      import { context as adapter } from 'nuqs/adapters/react';
      import { context as operator } from ${JSON.stringify(join(operator, 'consumer.js'))};
      export const sameContext = context === adapter && context === operator;`, resolveDir: operator },
    bundle: true, write: false, format: 'cjs', platform: 'browser', metafile: true, plugins: [portalBrowserPackagesPlugin(portal)] });
    const module: { exports: { sameContext?: boolean } } = { exports: {} };
    new Function('exports', 'module', result.outputFiles[0].text)(module.exports, module);
    expect(module.exports.sameContext).toBe(true);
    expect(Object.keys(result.metafile!.inputs).some(path => path.includes('/operator/node_modules/nuqs/'))).toBe(false);
    // Directory-prefix rewriting must fail this exported-subpath control.
    await expect(build({ stdin: { contents: "import 'nuqs/adapters/react';", resolveDir: operator },
      alias: { nuqs: join(portal, 'node_modules/nuqs') }, bundle: true, write: false, logLevel: 'silent' })).rejects.toThrow('Could not resolve');
    await expect(build({ stdin: { contents: "import 'nuqs/private-internal';", resolveDir: operator },
      plugins: [portalBrowserPackagesPlugin(portal)], bundle: true, write: false, logLevel: 'silent' })).rejects.toThrow();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it('joins cross-checkout toast producers and observers into one Sonner module store', async () => {
  const root = mkdtempSync(join(tmpdir(), 'private-portal-sonner-'));
  try {
    const portal = join(root, 'portal');
    const operator = join(root, 'operator');
    for (const checkout of [portal, operator]) {
      const pkg = join(checkout, 'node_modules/sonner');
      mkdirSync(pkg, { recursive: true });
      writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: 'sonner', type: 'module', exports: './index.js' }));
      writeFileSync(join(pkg, 'index.js'), 'export const store = []; export const toast = value => store.push(value);');
    }
    writeFileSync(join(operator, 'consumer.js'), "export { toast } from 'sonner';");
    const entry = `import { store } from 'sonner';
      import { toast } from ${JSON.stringify(join(operator, 'consumer.js'))};
      toast('Profile saved'); export const observed = store;`;
    const run = async (shared: boolean) => {
      const result = await build({ stdin: { contents: entry, resolveDir: portal }, bundle: true,
        write: false, format: 'cjs', platform: 'browser',
        plugins: shared ? [portalBrowserPackagesPlugin(portal)] : [] });
      const module: { exports: { observed?: string[] } } = { exports: {} };
      new Function('exports', 'module', result.outputFiles[0].text)(module.exports, module);
      return module.exports.observed;
    };
    expect(await run(false)).toEqual([]); // Reproduce the silent split-store failure.
    expect(await run(true)).toEqual(['Profile saved']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it.runIf(Boolean(process.env.PAPERCUSP_TEST_PORTAL_SOURCE_ROOT))(
  'builds the real Plans browser graph through the maintained Portal client boundary before private PG', async () => {
    const { buildPortalRosterBrowser } = await import('../test/portal-roster-browser-fixture');
    const result = await buildPortalRosterBrowser({ portalSourceRoot: process.env.PAPERCUSP_TEST_PORTAL_SOURCE_ROOT!,
      selected: 'preflight-selected', neighbor: 'preflight-neighbor', plans: {
        selectedSlug: 'preflight-selected', neighborSlug: 'preflight-neighbor', selectedTitle: 'preflight-selected',
        neighborTitle: 'preflight-neighbor', harness: 'papercusp' } });
    const paths = [...result.originals.keys()];
    expect(paths.some(path => path.endsWith('/PlansPane.tsx'))).toBe(true);
    expect(paths.some(path => path.endsWith('/operator-surface-build.mjs'))).toBe(true);
    expect(paths.some(path => path.endsWith('/useConfirmDialog.tsx'))).toBe(true);
    expect(paths.some(path => path.includes('/node_modules/undici/'))).toBe(false);
    expect(result.css.length).toBeGreaterThan(0);
  });

it.runIf(Boolean(process.env.PAPERCUSP_TEST_PORTAL_SOURCE_ROOT))(
  'builds the real ADV Docs panel with production conditional stylesheet exports before private PG', async () => {
    const { buildPortalRosterBrowser } = await import('../test/portal-roster-browser-fixture');
    const result = await buildPortalRosterBrowser({ portalSourceRoot: process.env.PAPERCUSP_TEST_PORTAL_SOURCE_ROOT!,
      selected: 'preflight-selected', neighbor: 'preflight-neighbor', docs: {
        harness: 'preflight-docs', selectedDoc: 'selected.md', neighborDoc: 'neighbor.md',
        selectedHeading: 'selected', neighborHeading: 'neighbor' } });
    const paths = [...result.originals.keys()];
    expect(paths.some(path => path.endsWith('/AdvHarnessPanelPage.tsx'))).toBe(true);
    expect(paths.some(path => path.endsWith('/AdvDocsTab.tsx'))).toBe(true);
    expect(paths.some(path => path.endsWith('/operator-surface-build.mjs'))).toBe(true);
    expect(paths.some(path => path.endsWith('/@excalidraw/excalidraw/dist/prod/index.css'))).toBe(true);
    expect(result.bundle.length).toBeGreaterThan(0);
  }, 120_000);

it.runIf(Boolean(process.env.PAPERCUSP_TEST_PORTAL_SOURCE_ROOT))(
  'mounts the real standalone ADV Docs panel in a browser before private PG', async () => {
    const { verifyPrivateDocsBrowserMount } = await import('../test/portal-roster-browser-fixture');
    await expect(verifyPrivateDocsBrowserMount({ portalSourceRoot: process.env.PAPERCUSP_TEST_PORTAL_SOURCE_ROOT!,
      selected: 'preflight-selected', neighbor: 'preflight-neighbor', docs: {
        harness: 'preflight-docs', selectedDoc: 'selected.md', neighborDoc: 'neighbor.md',
        selectedHeading: 'selected', neighborHeading: 'neighbor' } })).resolves.toMatchObject({ mounted: true });
  }, 120_000);

it('validates the configured Docs corpus and rejects record-only targets before private PG', async () => {
  const root = realpathSync(join(import.meta.dirname, '../../..'));
  const prepared = await preparePrivateDocsBrowserDocuments(root);
  expect(prepared.docsRoot).toBe(join(root, 'apps/operator-docs/src/content/docs'));
  expect(prepared.bodies[prepared.selection.selectedDoc]).toContain('## Classic Identity');
  expect(prepared.bodies[prepared.selection.neighborDoc]).toContain('## What this is');
  await expect(preparePrivateDocsBrowserDocuments(root, {
    selectedDoc: 'reports/cloud-cross-feature-e2e-2026-10-08.md',
    neighborDoc: 'reports/desktop-design-drift-2026-09-08.md',
    selectedHeading: 'Cloud end-to-end campaign — 2026-10-08',
    neighborHeading: 'Desktop GUI design drift: findings, repair and prevention plan',
  })).rejects.toThrow('has no body in the configured corpus');
});

it.runIf(Boolean(process.env.PAPERCUSP_TEST_PORTAL_SOURCE_ROOT))(
  'renders the actual standalone Docs markdown body before private PG', async () => {
    const root = realpathSync(join(import.meta.dirname, '../../..'));
    const prepared = await preparePrivateDocsBrowserDocuments(root);
    const { verifyPrivateDocsBrowserMount } = await import('../test/portal-roster-browser-fixture');
    await expect(verifyPrivateDocsBrowserMount({ portalSourceRoot: process.env.PAPERCUSP_TEST_PORTAL_SOURCE_ROOT!,
      selected: 'preflight-selected', neighbor: 'preflight-neighbor',
      docs: { harness: 'preflight-docs', ...prepared.selection },
      markdownPreflight: { value: prepared.bodies[prepared.selection.selectedDoc], heading: prepared.selection.selectedHeading },
    })).resolves.toMatchObject({ mounted: true });
  }, 120_000);

it.runIf(Boolean(process.env.PAPERCUSP_TEST_PORTAL_SOURCE_ROOT))(
  'builds the real Inbox browser graph through the maintained Portal client boundary before private PG', async () => {
    const { buildPortalRosterBrowser } = await import('../test/portal-roster-browser-fixture');
    const result = await buildPortalRosterBrowser({ portalSourceRoot: process.env.PAPERCUSP_TEST_PORTAL_SOURCE_ROOT!,
      selected: 'preflight-selected', neighbor: 'preflight-neighbor', inbox: {
        selectedMessageId: 'preflight-selected', neighborMessageId: 'preflight-neighbor',
        selectedTitle: 'preflight-selected', neighborTitle: 'preflight-neighbor' } });
    const paths = [...result.originals.keys()];
    expect(paths.some(path => path.endsWith('/InboxPane.tsx'))).toBe(true);
    expect(paths.some(path => path.endsWith('/operator-surface-build.mjs'))).toBe(true);
    expect(paths.some(path => path.endsWith('/delegated-tasks-browser.ts'))).toBe(true);
    expect(paths.some(path => path.endsWith('/lib/delegated-tasks.ts'))).toBe(false);
    expect(paths.some(path => path.includes('/node_modules/undici/'))).toBe(false);
    expect(paths.some(path => path.endsWith('/presence-ui.module.css'))).toBe(true);
    expect(result.css.length).toBeGreaterThan(0);
  });

it.runIf(Boolean(process.env.PAPERCUSP_TEST_PORTAL_SOURCE_ROOT))(
  'preflights the browser Origin denial input on the wire before a private database run', async () => {
    const receipt = await verifyPrivateProfileOriginControl();
    expect(receipt.continuedControl).toEqual({ origin: 'https://unapproved.invalid', status: 403 });
    // Preserve what the browser actually sent with the old input mechanism.
    // Chromium builds may differ; the fixed precondition must work either way.
    expect([receipt.base, 'https://unapproved.invalid']).toContain(receipt.oldControl.origin);
  });

it('correlates a private browser stop to the exact owner, managed row, launch and disposition', () => {
  const expected = { ownerId: 'selected', managedSessionId: 17, startedAt: '2026-10-10T03:00:00Z' };
  const receipt = { status: 200, body: { ok: true, ownerId: expected.ownerId, managedSessionId: expected.managedSessionId,
    sessionStartedAt: expected.startedAt, status: 'stop-requested' } };
  expect(() => verifyPrivateStopReceipt(receipt, expected)).not.toThrow();
  expect(() => verifyPrivateStopReceipt(receipt, { ...expected, ownerId: 'neighbor' })).toThrow('selected-owner');
  expect(() => verifyPrivateStopReceipt(receipt, { ...expected, managedSessionId: 18 })).toThrow('selected-session');
  expect(() => verifyPrivateStopReceipt(receipt, { ...expected, startedAt: 'replacement' })).toThrow('selected-launch');
  expect(() => verifyPrivateStopReceipt({ ...receipt, status: 403 }, expected)).toThrow();
  expect(() => verifyPrivateStopReceipt({ ...receipt, body: { ...receipt.body, status: 'queued' } }, expected)).toThrow('stop disposition');
});

it.each([{ summary: 'private-browser-message', wake: false }, { summary: '(nudge from the portal)', wake: true }])(
  'correlates the actual private action payload $summary instead of the HTTP-only marker', async expected => {
    const result = { ok: true, to: ['selected'], msg_id: 'action-message',
      ...(expected.wake ? { wake: { pickupConfirmed: false } } : {}) };
    const receipt = { status: 200, body: { results: [result] } };
    const stored = { to: ['selected'], ...expected };
    expect(await verifyPrivateCoordReceipt(receipt, { ownerId: 'selected', ...expected }, async () => stored)).toBe('action-message');
    await expect(verifyPrivateCoordReceipt(receipt, { ownerId: 'selected', ...expected, summary: 'private-coord-marker' }, async () => stored))
      .rejects.toThrow('persisted action payload correlation');
    await expect(verifyPrivateCoordReceipt(receipt, { ownerId: 'neighbor', ...expected }, async () => stored))
      .rejects.toThrow('selected-recipient receipt correlation');
  });

it('refuses a synchronous private wake receipt that fabricates observed pickup', async () => {
  await expect(verifyPrivateCoordReceipt({ status: 200, body: { results: [{ ok: true, to: ['selected'], msg_id: 'wake',
    wake: { pickupConfirmed: true } }] } }, { ownerId: 'selected', summary: 'nudge', wake: true },
  async () => ({ to: ['selected'], summary: 'nudge', wake: true }))).rejects.toThrow('send-time wake cannot attest pickup');
});

it('validates explicit Portal source before a private runtime even after ambient selection is stripped', () => {
  const root = mkdtempSync(join(tmpdir(), 'private-portal-source-'));
  try {
    for (const file of ['packages/ui/src/agents-popover.tsx', 'app/tokens.css', 'app/globals.css',
      'node_modules/react/package.json', 'node_modules/react-dom/package.json']) {
      mkdirSync(dirname(join(root, file)), { recursive: true });
      writeFileSync(join(root, file), '{}');
    }
    writeNuqsExportFixture(root);
    vi.stubEnv('PAPERCUSP_TEST_PORTAL_SOURCE_ROOT', undefined);
    expect(preparePortalBrowserSource(['node', 'fixture.ts', '--portal-source=' + root])).toBe(realpathSync(root));
    expect(() => preparePortalBrowserSource(['node', 'fixture.ts'])).toThrow('exactly one explicit');
    expect(() => preparePortalBrowserSource(['--portal-source=relative'])).toThrow('absolute maintained');
    expect(() => preparePortalBrowserSource(['--portal-source=' + root, '--portal-source=' + root])).toThrow('exactly one explicit');
    rmSync(join(root, 'node_modules/nuqs/dist/adapters/react.js'));
    expect(() => preparePortalBrowserSource(['--portal-source=' + root])).toThrow();
    writeNuqsExportFixture(root);
    rmSync(join(root, 'packages/ui/src/agents-popover.tsx'));
    expect(() => preparePortalBrowserSource(['--portal-source=' + root])).toThrow();
  } finally { vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); }
});

it('prepares a private foreign workspace before the real HTTP middleware checks it', async () => {
  const root = mkdtempSync(join(tmpdir(), 'private-http-registry-'));
  const workspace = 'test-runtime-registry-control';
  try {
    vi.stubEnv('HOME', join(root, 'home'));
    vi.stubEnv('TMPDIR', join(root, 'tmp'));
    vi.stubEnv('PAPERCUSP_WORKSPACES_ROOT', join(root, 'workspaces'));
    vi.stubEnv('PAPERCUSP_WORKSPACE_ID', workspace);
    const app = new Hono();
    app.use('*', workspaceContextMiddleware);
    app.get('/probe', c => c.json({ admitted: true }));
    const request = () => app.request('/probe', { headers: { 'x-papercusp-workspace': workspace + '-foreign' } });
    expect((await request()).status).toBe(400);
    expect(preparePrivateHttpWorkspaces()).toEqual({ workspace, foreignWorkspace: workspace + '-foreign' });
    expect((await request()).status).toBe(200);
    const registry = JSON.parse(readFileSync(join(root, 'workspaces/registry.json'), 'utf8'));
    expect(registry.workspaces.map((entry: { id: string }) => entry.id)).toEqual([workspace, workspace + '-foreign']);
    // A shared or mismatched root must fail before writing a registry.
    const retained = readFileSync(join(root, 'workspaces/registry.json'), 'utf8');
    vi.stubEnv('TMPDIR', join(root, 'unrelated'));
    expect(preparePrivateHttpWorkspaces).toThrow('disposable runtime scratch');
    expect(readFileSync(join(root, 'workspaces/registry.json'), 'utf8')).toBe(retained);
  } finally { vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); }
});

it('retains the original structured worker failure after a long successful cleanup', () => {
  const failure = 'ROSTER_STOP_HTTP_FAILURE ' + JSON.stringify({ message: 'unknown_workspace', stack: 'original assertion' });
  const cleanup = '\npg cleanup progress'.repeat(500);
  expect(isolatedWorkerFailureDetail(failure + cleanup)).toBe(failure);
  expect(isolatedWorkerFailureDetail('unstructured error')).toBe('unstructured error');
});

it('pins the original short-lived Node worker before allowing its command to run', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'isolated-worker-start-'));
  const child = spawn(process.execPath, ['--import', join(import.meta.dirname, '../../../scripts/lib/isolated-runtime-start.mjs'),
    '-e', "console.log('command-after-observation'); process.exit(7);"], {
    env: { ...process.env, PC_ISOLATED_RUNTIME_START_TOKEN: 'original-token' }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  try {
    const captured = captureIsolatedWorker(child, dir, { timeoutMs: 10_000 });
    expect((await once(child, 'message'))[0]).toEqual({ kind: 'isolated-worker-ready', token: 'original-token' });
    const stat = readFileSync(`/proc/${child.pid}/stat`, 'utf8');
    child.send({ kind: 'isolated-worker-observed', token: 'wrong-token', accepted: true });
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(readFileSync(join(dir, 'worker.log'), 'utf8')).toBe('');
    expect(readFileSync(`/proc/${child.pid}/stat`, 'utf8').split(')').slice(1).join(')').trim().split(/\s+/)[19])
      .toBe(stat.split(')').slice(1).join(')').trim().split(/\s+/)[19]);
    child.send({ kind: 'isolated-worker-observed', token: 'original-token', accepted: true });
    const result = await captured;
    expect(result).toMatchObject({ code: 7, timedOut: false });
    expect(result.output).toContain('command-after-observation');
  } finally { child.kill('SIGKILL'); rmSync(dir, { recursive: true, force: true }); }
});

it('refuses to run command code when the original observer disconnects', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'isolated-worker-unobserved-'));
  const child = spawn(process.execPath, ['--import', join(import.meta.dirname, '../../../scripts/lib/isolated-runtime-start.mjs'),
    '-e', "console.log('unobserved-command-ran');"], {
    env: { ...process.env, PC_ISOLATED_RUNTIME_START_TOKEN: 'original-token' }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  try {
    const captured = captureIsolatedWorker(child, dir, { timeoutMs: 10_000 });
    await once(child, 'message');
    child.disconnect();
    const result = await captured;
    expect(result).toMatchObject({ code: 1, timedOut: false });
    expect(result.output).toContain('original worker observer disconnected');
    expect(result.output).not.toContain('unobserved-command-ran');
  } finally { child.kill('SIGKILL'); rmSync(dir, { recursive: true, force: true }); }
});

it('composes the nested router budgets without spending execution time on bootstrap', () => {
  const options = isolatedTestFileWorkerOptions({ PAPERCUSP_TEST_FILE_TIMEOUT_MS: '900000', PAPERCUSP_TEST_FILE_LIST_TIMEOUT_MS: '180000' }, 2);
  expect(options.phaseTimeouts).toMatchObject({ bootstrapMs: 180_000, executeMs: 1_082_000 });
  expect(options.phaseTimeouts.bootstrapMaxMs).toBe(900_000);
  expect(options.phaseTimeouts.teardownMaxMs).toBe(900_000);
  expect(options.killGraceMs).toBeGreaterThanOrEqual(10_000 + 5_000);
  expect(options.testTimeoutMs).toBeGreaterThan(options.phaseTimeouts.bootstrapMs + options.phaseTimeouts.executeMaxMs! + options.phaseTimeouts.teardownMs);
});

it('gives each lifecycle phase its own budget and refuses deadline renewal by repeated IPC', async () => {
  vi.useFakeTimers();
  const dir = mkdtempSync(join(tmpdir(), 'isolated-worker-phases-'));
  const child = new ChildProcess();
  const kill = vi.spyOn(child, 'kill').mockReturnValue(true);
  try {
    const captured = captureIsolatedWorker(child, dir, { phaseTimeouts: { bootstrapMs: 100, executeMs: 200, teardownMs: 150 }, killGraceMs: 50 });
    await vi.advanceTimersByTimeAsync(90);
    child.emit('message', { kind: 'isolated-runtime-start' });
    await vi.advanceTimersByTimeAsync(190);
    expect(kill).not.toHaveBeenCalled();
    child.emit('message', { kind: 'isolated-runtime-stopping' });
    await vi.advanceTimersByTimeAsync(140);
    child.emit('message', { kind: 'isolated-runtime-stopping' });
    expect(kill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(10);
    expect(kill).toHaveBeenCalledWith('SIGTERM');
    Object.assign(child, { exitCode: 1 }); child.emit('exit', 1, null); child.emit('close', 1, null);
    expect(await captured).toMatchObject({ timedOut: true, timeoutPhase: 'teardown', stdioDrainTimedOut: false });
  } finally { vi.useRealTimers(); rmSync(dir, { recursive: true, force: true }); }
});

it('bounds a missing runtime-start and cannot extend it with unrelated IPC', async () => {
  vi.useFakeTimers();
  const dir = mkdtempSync(join(tmpdir(), 'isolated-worker-bootstrap-'));
  const child = new ChildProcess();
  const kill = vi.spyOn(child, 'kill').mockReturnValue(true);
  try {
    const captured = captureIsolatedWorker(child, dir, { phaseTimeouts: { bootstrapMs: 100, executeMs: 200, teardownMs: 150 }, killGraceMs: 50 });
    await vi.advanceTimersByTimeAsync(90); child.emit('message', { kind: 'other' });
    await vi.advanceTimersByTimeAsync(10);
    expect(kill).toHaveBeenCalledWith('SIGTERM');
    await vi.advanceTimersByTimeAsync(50);
    expect(kill).toHaveBeenCalledWith('SIGKILL');
    Object.assign(child, { signalCode: 'SIGKILL' }); child.emit('exit', null, 'SIGKILL'); child.emit('close', null, 'SIGKILL');
    expect(await captured).toMatchObject({ timedOut: true, timeoutPhase: 'bootstrap', signal: 'SIGKILL' });
  } finally { vi.useRealTimers(); rmSync(dir, { recursive: true, force: true }); }
});

it('extends cleanup for measured original PG writes but refuses logs, counter replay and PID reuse', async () => {
  vi.useFakeTimers();
  const dir = mkdtempSync(join(tmpdir(), 'isolated-cleanup-progress-'));
  const child = new ChildProcess();
  const kill = vi.spyOn(child, 'kill').mockReturnValue(true);
  const sample = (startTicks: string, syscw: string) => child.emit('message', { kind: 'isolated-runtime-cleanup', stage: 'pg-stop-observation',
    processes: [{ pid: 100, startTicks, io: { syscw, write_bytes: '1000' } }] });
  try {
    const captured = captureIsolatedWorker(child, dir, { phaseTimeouts: { bootstrapMs: 100, executeMs: 100, teardownMs: 100, teardownMaxMs: 300 }, killGraceMs: 50 });
    child.emit('message', { kind: 'isolated-runtime-start' });
    child.emit('message', { kind: 'isolated-runtime-stopping' });
    sample('1', '0');
    await vi.advanceTimersByTimeAsync(90); sample('1', '1');
    await vi.advanceTimersByTimeAsync(10);
    expect(kill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(90);
    sample('1', '1'); sample('1', '0'); sample('1', '1'); sample('2', '100');
    child.emit('message', { kind: 'isolated-runtime-cleanup', stage: 'pg-log', message: 'noisy shutdown output' });
    // Ordinary CLI visibility must not turn elapsed waiting into measured I/O
    // progress or grant extra time to the original-worker proof route.
    child.emit('message', { kind: 'isolated-runtime-cleanup', stage: 'pg-stop-waiting', elapsedMs: 190 });
    await vi.advanceTimersByTimeAsync(10);
    expect(kill).toHaveBeenCalledWith('SIGTERM');
    Object.assign(child, { exitCode: 1 }); child.emit('exit', 1, null); child.emit('close', 1, null);
    expect(await captured).toMatchObject({ timedOut: true, timeoutPhase: 'teardown' });
  } finally { vi.useRealTimers(); rmSync(dir, { recursive: true, force: true }); }
});

it('separates ordinary cleanup stdout from bootstrap and refuses incomplete, foreign or elapsed-only progress', async () => {
  vi.useFakeTimers();
  const dir = mkdtempSync(join(tmpdir(), 'ordinary-cleanup-deadlines-'));
  const child = new ChildProcess();
  Object.assign(child, { pid: 123, stdout: new PassThrough(), stderr: new PassThrough() });
  const kill = vi.spyOn(child, 'kill').mockReturnValue(true);
  const line = (supervisorPid: number, stage: string) => '[with-test-pg] cleanup ' + JSON.stringify({
    kind: 'isolated-runtime-cleanup', supervisorPid, stage, elapsedMs: 90,
  }) + '\n';
  try {
    const captured = captureIsolatedWorker(child, dir, { cleanupFromStdout: true,
      phaseTimeouts: { bootstrapMs: 100, executeMs: 100, teardownMs: 100, teardownMaxMs: 300 }, killGraceMs: 50 });
    child.stdout!.emit('data', Buffer.from(line(999, 'start')));
    await vi.advanceTimersByTimeAsync(90);
    const start = line(123, 'start');
    child.stdout!.emit('data', Buffer.from(start.slice(0, -1)));
    await vi.advanceTimersByTimeAsync(5);
    child.stdout!.emit('data', Buffer.from('\n'));
    await vi.advanceTimersByTimeAsync(90);
    expect(kill).not.toHaveBeenCalled();
    child.stdout!.emit('data', Buffer.from(line(999, 'pg-stopped') + line(123, 'pg-stop-waiting')));
    await vi.advanceTimersByTimeAsync(10);
    // The maintained watchdog includes the stall-window boundary. Its first
    // checkpoint may extend from the genuine start; later waiting cannot.
    expect(kill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(90);
    expect(kill).not.toHaveBeenCalled();
    child.stdout!.emit('data', Buffer.from(line(123, 'pg-stop-waiting')));
    await vi.advanceTimersByTimeAsync(10);
    expect(kill).toHaveBeenCalledWith('SIGTERM');
    Object.assign(child, { exitCode: 1 }); child.emit('exit', 1, null); child.emit('close', 1, null);
    expect(await captured).toMatchObject({ timedOut: true, timeoutPhase: 'teardown' });
  } finally { vi.useRealTimers(); rmSync(dir, { recursive: true, force: true }); }
});

it('bounds continuously progressing cleanup at the existing absolute verification ceiling', async () => {
  vi.useFakeTimers();
  const dir = mkdtempSync(join(tmpdir(), 'isolated-cleanup-ceiling-'));
  const child = new ChildProcess();
  const kill = vi.spyOn(child, 'kill').mockReturnValue(true);
  try {
    const captured = captureIsolatedWorker(child, dir, { phaseTimeouts: { bootstrapMs: 100, executeMs: 100, teardownMs: 100, teardownMaxMs: 300 }, killGraceMs: 50 });
    child.emit('message', { kind: 'isolated-runtime-start' });
    child.emit('message', { kind: 'isolated-runtime-stopping' });
    for (const stage of ['pg-stop', 'pg-stopped', 'remove-private-state']) {
      await vi.advanceTimersByTimeAsync(90);
      child.emit('message', { kind: 'isolated-runtime-cleanup', stage });
      await vi.advanceTimersByTimeAsync(10);
    }
    expect(kill).toHaveBeenCalledWith('SIGTERM');
    Object.assign(child, { exitCode: 1 }); child.emit('exit', 1, null); child.emit('close', 1, null);
    expect(await captured).toMatchObject({ timedOut: true, timeoutPhase: 'teardown' });
  } finally { vi.useRealTimers(); rmSync(dir, { recursive: true, force: true }); }
});

it('allows actual TERM cleanup to finish before its declared grace and preserves timeout failure', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'isolated-worker-grace-'));
  const child = fork('-e', ["process.on('SIGTERM', () => setTimeout(() => { console.log('cleanup-finished'); process.exit(0); }, 200)); process.send({kind:'isolated-runtime-start'}); setInterval(() => {},1000);"], { execArgv: [], stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  try {
    const result = await captureIsolatedWorker(child, dir, { phaseTimeouts: { bootstrapMs: 10_000, executeMs: 100, teardownMs: 1000 }, killGraceMs: 1000 });
    expect(result).toMatchObject({ code: 0, signal: null, timedOut: true, timeoutPhase: 'execute', stdioDrainTimedOut: false });
    expect(result.output).toContain('cleanup-finished');
    expect(JSON.parse(readFileSync(join(dir, 'worker-result.json'), 'utf8'))).toMatchObject({ timedOut: true, timeoutPhase: 'execute' });
  } finally { child.kill('SIGKILL'); rmSync(dir, { recursive: true, force: true }); }
});

it('extends progressing bootstrap stages and refuses renewal by noise or repeated stages', async () => {
  vi.useFakeTimers();
  const dir = mkdtempSync(join(tmpdir(), 'isolated-boot-progress-'));
  const child = new ChildProcess();
  const stdout = new PassThrough(); Object.assign(child, { stdout });
  const kill = vi.spyOn(child, 'kill').mockReturnValue(true);
  try {
    const captured = captureIsolatedWorker(child, dir, { phaseTimeouts: {
      bootstrapMs: 100, bootstrapMaxMs: 300, executeMs: 100, teardownMs: 100,
    }, killGraceMs: 50 });
    await vi.advanceTimersByTimeAsync(90);
    child.emit('message', { kind: 'isolated-runtime-bootstrap-progress', stage: 'migration:000-baseline.sql' });
    await vi.advanceTimersByTimeAsync(10);
    expect(kill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(90);
    stdout.write('noisy NOTICE is not stage progress');
    child.emit('message', { kind: 'isolated-runtime-bootstrap-progress', stage: 'migration:000-baseline.sql' });
    child.emit('message', { kind: 'isolated-runtime-bootstrap-progress', stage: 'invented' });
    await vi.advanceTimersByTimeAsync(10);
    expect(kill).toHaveBeenCalledWith('SIGTERM');
    Object.assign(child, { exitCode: 1 }); child.emit('exit', 1, null); child.emit('close', 1, null);
    expect(await captured).toMatchObject({ timedOut: true, timeoutPhase: 'bootstrap' });
  } finally { stdout.destroy(); vi.useRealTimers(); rmSync(dir, { recursive: true, force: true }); }
});

it('enforces the absolute bootstrap ceiling despite distinct continuing stages', async () => {
  vi.useFakeTimers();
  const dir = mkdtempSync(join(tmpdir(), 'isolated-boot-ceiling-'));
  const child = new ChildProcess();
  const kill = vi.spyOn(child, 'kill').mockReturnValue(true);
  try {
    const captured = captureIsolatedWorker(child, dir, { phaseTimeouts: {
      bootstrapMs: 100, bootstrapMaxMs: 300, executeMs: 100, teardownMs: 100,
    }, killGraceMs: 50 });
    for (const stage of ['initdb', 'postmaster', 'database']) {
      await vi.advanceTimersByTimeAsync(90);
      child.emit('message', { kind: 'isolated-runtime-bootstrap-progress', stage });
      await vi.advanceTimersByTimeAsync(10);
    }
    expect(kill).toHaveBeenCalledWith('SIGTERM');
    Object.assign(child, { exitCode: 1 }); child.emit('exit', 1, null); child.emit('close', 1, null);
    expect(await captured).toMatchObject({ timedOut: true, timeoutPhase: 'bootstrap' });
  } finally { vi.useRealTimers(); rmSync(dir, { recursive: true, force: true }); }
});

it('waits for observed kernel exit before starting the shorter pipe-drain budget', async () => {
  vi.useFakeTimers();
  const dir = mkdtempSync(join(tmpdir(), 'isolated-worker-exit-race-'));
  const child = new ChildProcess();
  const kill = vi.spyOn(child, 'kill').mockReturnValue(true);
  let settled = false;
  try {
    const captured = captureIsolatedWorker(child, dir, { timeoutMs: 100, killGraceMs: 50, drainGraceMs: 20 }).then(result => { settled = true; return result; });
    await vi.advanceTimersByTimeAsync(150);
    expect(kill).toHaveBeenCalledWith('SIGKILL');
    await vi.advanceTimersByTimeAsync(100);
    expect(settled).toBe(false);
    Object.assign(child, { signalCode: 'SIGKILL' }); child.emit('exit', null, 'SIGKILL'); child.emit('close', null, 'SIGKILL');
    expect(await captured).toMatchObject({ signal: 'SIGKILL', exitWaitTimedOut: false, stdioDrainTimedOut: false });
  } finally { vi.useRealTimers(); rmSync(dir, { recursive: true, force: true }); }
});

it('cannot renew the execution deadline by repeating runtime-start', async () => {
  vi.useFakeTimers();
  const dir = mkdtempSync(join(tmpdir(), 'isolated-worker-execution-'));
  const child = new ChildProcess();
  const kill = vi.spyOn(child, 'kill').mockReturnValue(true);
  try {
    const captured = captureIsolatedWorker(child, dir, { phaseTimeouts: { bootstrapMs: 100, executeMs: 200, teardownMs: 100 }, killGraceMs: 50 });
    child.emit('message', { kind: 'isolated-runtime-start' });
    await vi.advanceTimersByTimeAsync(190); child.emit('message', { kind: 'isolated-runtime-start' });
    await vi.advanceTimersByTimeAsync(10);
    expect(kill).toHaveBeenCalledWith('SIGTERM');
    Object.assign(child, { exitCode: 1 }); child.emit('exit', 1, null); child.emit('close', 1, null);
    expect(await captured).toMatchObject({ timedOut: true, timeoutPhase: 'execute' });
  } finally { vi.useRealTimers(); rmSync(dir, { recursive: true, force: true }); }
});

it('uses the router progress watchdog and still enforces its absolute ceiling', async () => {
  vi.useFakeTimers();
  const dir = mkdtempSync(join(tmpdir(), 'isolated-worker-progress-'));
  const child = new ChildProcess();
  const stdout = new PassThrough(); Object.assign(child, { stdout });
  const kill = vi.spyOn(child, 'kill').mockReturnValue(true);
  try {
    const captured = captureIsolatedWorker(child, dir, { phaseTimeouts: { bootstrapMs: 100, executeMs: 200, executeMaxMs: 400, teardownMs: 100 }, killGraceMs: 50 });
    child.emit('message', { kind: 'isolated-runtime-start' });
    await vi.advanceTimersByTimeAsync(190); stdout.write('original-progress\n');
    await vi.advanceTimersByTimeAsync(10);
    expect(kill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(190); stdout.write('still-progressing\n');
    await vi.advanceTimersByTimeAsync(10);
    expect(kill).toHaveBeenCalledWith('SIGTERM');
    Object.assign(child, { exitCode: 1 }); child.emit('exit', 1, null); child.emit('close', 1, null);
    expect(await captured).toMatchObject({ timedOut: true, timeoutPhase: 'execute' });
  } finally { stdout.destroy(); vi.useRealTimers(); rmSync(dir, { recursive: true, force: true }); }
});

isolatedIntegrationCases('attaches per-case isolated runtime evidence after an async test (failing exit: %s)', async (failingExit, context) => {
  await Promise.resolve();
  const runId = failingExit ? '20261008T000001Z-100' : '20261008T000000Z-100';
  Object.assign(context.task.meta, { papercuspIsolatedRuntimeRunId: runId });
  expect(context.task.meta).toMatchObject({ papercuspIsolatedRuntimeRunId: runId });
});

it('retains output before a failing worker closes and preserves its actual exit', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'isolated-worker-capture-'));
  const child = spawn(process.execPath, ['-e', "console.log('original-before-failure'); setTimeout(() => process.exit(7), 100);"], { stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    const result = captureIsolatedWorker(child, dir, { timeoutMs: 10_000 });
    await once(child.stdout!, 'data');
    expect(readFileSync(join(dir, 'worker.log'), 'utf8')).toContain('original-before-failure');
    expect(await result).toMatchObject({ code: 7, signal: null, timedOut: false, stdioDrainTimedOut: false });
    expect(JSON.parse(readFileSync(join(dir, 'worker-result.json'), 'utf8'))).toMatchObject({ code: 7, timedOut: false });
  } finally { child.kill('SIGKILL'); rmSync(dir, { recursive: true, force: true }); }
});

it('terminates a worker that ignores TERM and retains the timeout as failure evidence', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'isolated-worker-timeout-'));
  const child = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); console.log('original-hung-worker'); setInterval(() => {}, 1000);"], { stdio: ['ignore', 'pipe', 'pipe'] });
  const exit = once(child, 'exit');
  try {
    const result = await captureIsolatedWorker(child, dir, { timeoutMs: 2_000, killGraceMs: 100 });
    await exit;
    expect(result).toMatchObject({ code: null, signal: 'SIGKILL', timedOut: true, stdioDrainTimedOut: false });
    expect(result.output).toContain('original-hung-worker');
    expect(JSON.parse(readFileSync(join(dir, 'worker-result.json'), 'utf8'))).toMatchObject({ signal: 'SIGKILL', timedOut: true });
    expect(() => process.kill(child.pid!, 0)).toThrow();
  } finally { child.kill('SIGKILL'); rmSync(dir, { recursive: true, force: true }); }
});

it('bounds drainage when an exited worker leaves a descendant holding its pipes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'isolated-worker-pipe-'));
  const child = spawn(process.execPath, ['-e', "const c = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: ['ignore', 1, 2] }); console.log('descendant=' + c.pid); process.exit(0);"], { stdio: ['ignore', 'pipe', 'pipe'] });
  let descendant: number | undefined;
  try {
    const result = await captureIsolatedWorker(child, dir, { timeoutMs: 10_000, killGraceMs: 100 });
    descendant = Number(result.output.match(/descendant=(\d+)/)?.[1]);
    expect(descendant).toBeGreaterThan(0);
    expect(result).toMatchObject({ code: 0, signal: null, timedOut: false, stdioDrainTimedOut: true });
    expect(JSON.parse(readFileSync(join(dir, 'worker-result.json'), 'utf8'))).toMatchObject({ stdioDrainTimedOut: true });
  } finally {
    if (descendant) { try { process.kill(descendant, 'SIGKILL'); } catch { /* already gone */ } }
    child.kill('SIGKILL'); rmSync(dir, { recursive: true, force: true });
  }
});

it('kills a TERM-ignoring worker and its owned descendant together', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'isolated-worker-group-'));
  const source = "const {fork}=require('node:child_process'); process.on('SIGTERM',()=>{}); const d=fork('-e',[\"process.on('SIGTERM',()=>{}); process.send({ready:true}); setInterval(()=>{},1000);\"],{execArgv:[],stdio:['ignore',1,2,'ipc']}); d.on('message',()=>{console.log('descendant='+d.pid); process.send({kind:'isolated-runtime-start'});}); setInterval(()=>{},1000);";
  const child = fork('-e', [source], { detached: true, execArgv: [], stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  let descendant: number | undefined;
  try {
    const result = await captureIsolatedWorker(child, dir, {
      phaseTimeouts: { bootstrapMs: 10_000, executeMs: 100, teardownMs: 1000 }, killGraceMs: 100,
    });
    descendant = Number(result.output.match(/descendant=(\d+)/)?.[1]);
    expect(descendant).toBeGreaterThan(0);
    expect(result).toMatchObject({ signal: 'SIGKILL', timedOut: true, timeoutPhase: 'execute', stdioDrainTimedOut: false });
    // An orphan may await the host reaper as a zombie; it has exited and cannot
    // keep PG, pipes or private files active. A live descendant fails this guard.
    await expect.poll(() => {
      try {
        const stat = readFileSync(`/proc/${descendant}/stat`, 'utf8');
        return stat.slice(stat.lastIndexOf(')') + 2).split(/\s+/)[0] === 'Z';
      } catch { return true; }
    }, { timeout: 5000 }).toBe(true);
    expect(() => process.kill(child.pid!, 0)).toThrow();
  } finally {
    if (descendant) { try { process.kill(descendant, 'SIGKILL'); } catch { /* already exited */ } }
    child.kill('SIGKILL'); rmSync(dir, { recursive: true, force: true });
  }
});
