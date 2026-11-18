/** Served Next Portal + installed operator acceptance, inside the existing
 * machine-first private-PG runtime. One real private display and synthetic
 * roster entries exercise pagination; the owner's account is never paired. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile, execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { openSync, closeSync } from 'node:fs';
import { access, cp, copyFile, mkdir, readFile, realpath, symlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { createServer as createHttpServer, type Server } from 'node:http';
import { chromium, request as playwrightRequest, type Browser, type Page } from 'playwright-core';
import type { HostedHandler } from '../../../../apps/operator/bin/hosted-handler';
import { createFakeHostedIdentityProvider, FAKE_HOSTED_IDENTITY_SESSION } from '../auth/hosted/fake-provider';
import { HOSTED_PRINCIPAL_DENIAL_REASONS } from '../auth/hosted-principal-resolver';
import type { CreateHostedSessionInput } from '../auth/hosted-session';
import type { PortalPlaywrightResult } from '../rubrics-playwright-checks';

type Input = {
  repo: string; privateRoot: string; evidence: string; control: string; config: NodeJS.ProcessEnv;
  origin: string; certPath: string; userId: string; orgId: string; hosted: HostedHandler;
  freePort: () => Promise<number>;
  stage: (phase: string) => Promise<void>;
  waitFor: <T>(name: string, probe: () => Promise<T | false>, ms?: number) => Promise<T>;
  start: (name: string, env: NodeJS.ProcessEnv, fixture?: { preload: string; args: string[] }) => ChildProcess;
  routePortal: (handler: (request: Request) => Promise<Response>) => void;
};

export const INSTALLED_FIXTURE_DESKTOP_NAME = 'served-0192-live';
const INSTALLED_FIXTURE_SESSION_ID = 'inst-private-served-browser';
const INSTALLED_FIXTURE_PROVIDER_ID = 'private-installed-browser';

export const INSTALLED_PORTAL_SPEC = 'e2e/portal-existing-local-connection.spec.ts';
export const INSTALLED_PORTAL_CASES = [
  'BROWSER-STOPPED-UNSUPPORTED-FALLBACK: opening a stopped app preserves the code and honest pending state',
  'BROWSER-UNSUPPORTED-VERSION-FALLBACK: a reachable older app preserves the code and honest pending state',
  'BROWSER-OPEN-LOOPBACK/SAME-ORIGIN-CONSENT/NOISE-ROSTER-FRAME/VIEW-INPUT-DENIED/STATUS-NAVIGATION',
].map(title => `existing installed computer on the served Portal > ${title}`);

/** Consume the maintained executor's exact file/case/ledger identities. Counts
 * alone would accept two unrelated passing cases in place of R2's detectors. */
export function assertInstalledPortalExecutor(executor: PortalPlaywrightResult, portal: string) {
  assert(executor.ok && executor.error === undefined && executor.passed === INSTALLED_PORTAL_CASES.length
    && executor.failed === 0 && executor.skipped === 0, 'Installed Portal executor did not pass the required cases');
  const file = join(portal, INSTALLED_PORTAL_SPEC);
  const cases = executor.casesByFile?.[file];
  assert(cases && cases.length === INSTALLED_PORTAL_CASES.length
    && cases.every(item => item.status === 'pass' && item.occurrence === 0), 'Installed Portal case receipts are incomplete');
  assert.deepEqual(cases.map(item => item.caseKey).sort(), [...INSTALLED_PORTAL_CASES].sort(),
    'Installed Portal executed different browser cases');
  const ids = executor.testRunIdsByFile?.[file];
  assert(ids?.length === 1 && Number.isSafeInteger(ids[0]) && ids[0]! > 0
    && executor.testRunIds?.length === 1 && executor.testRunIds[0] === ids[0],
  'Installed Portal requires the exact spec ledger receipt');
  assert.deepEqual(Object.keys(executor.casesByFile ?? {}), [file], 'Installed Portal case file identity changed');
  assert.deepEqual(Object.keys(executor.testRunIdsByFile ?? {}), [file], 'Installed Portal ledger file identity changed');
}

export type InstalledPortalCaseEvidence = {
  caseKey: string; runId: string; buildId: string; sourceRootDigest: string;
  scenario: 'stopped' | 'unsupported' | 'consent'; downloads: number;
  codePreserved?: boolean; pending?: boolean; approvalSaved?: boolean; localWrites?: number;
  stimulus?: 'connection-refused' | 'legacy-http-404';
};

export function assertInstalledPortalCaseEvidence(receipts: InstalledPortalCaseEvidence[],
  expected: { runId: string; buildId: string; sourceRootDigest: string }) {
  assert.equal(receipts.length, 3, 'Installed Portal requires every semantic case receipt');
  for (const [index, scenario] of (['stopped', 'unsupported', 'consent'] as const).entries()) {
    const receipt = receipts[index];
    assert(receipt && receipt.scenario === scenario && receipt.caseKey === INSTALLED_PORTAL_CASES[index],
      'Installed Portal semantic case identity changed');
    assert(Object.entries(expected).every(([key, value]) => receipt[key as keyof typeof expected] === value),
      'Installed Portal semantic receipt belongs to another run or artifact');
    assert.equal(receipt.downloads, 0, 'Installed Portal must not download an installer');
    if (scenario !== 'consent') {
      assert(receipt.codePreserved === true && receipt.pending === true && receipt.approvalSaved === false
        && receipt.localWrites === 0, 'Installed Portal fallback must preserve code without approval or local writes');
      assert.equal(receipt.stimulus, scenario === 'stopped' ? 'connection-refused' : 'legacy-http-404',
        'Installed Portal fallback stimulus was not observed');
    }
  }
}

/** Use the maintained provider contract with a current, private upstream session. */
export function installedHostedIdentityProvider(nowMs = Date.now()) {
  return createFakeHostedIdentityProvider({ providerId: INSTALLED_FIXTURE_PROVIDER_ID, nowMs,
    session: { ...FAKE_HOSTED_IDENTITY_SESSION, externalSessionId: INSTALLED_FIXTURE_SESSION_ID,
      issuedAtMs: nowMs - 60_000, authenticatedAtMs: nowMs - 30_000, expiresAtMs: nowMs + 30 * 60_000 } });
}

/** Snapshot fixture sessions through the production membership authority. */
export async function createHostedFixtureSession(
  components: Pick<HostedHandler['plane']['components'], 'sessionStore' | 'membershipAuthority'>,
  input: Omit<CreateHostedSessionInput, 'permissionVersion'>,
) {
  const membership = await components.membershipAuthority.resolveActive(input);
  assert(membership, 'Private browser session requires active membership');
  return components.sessionStore.create({ ...input, permissionVersion: membership.permissionVersion });
}

/** Keep safe auth codes and known denial reasons, never arbitrary response data. */
export async function assertInstalledPortalSession(response: { status(): number; json(): Promise<unknown> },
  expected: { userId: string; organizationId: string; workspaceId: string }) {
  const body = await response.json().catch(() => null) as {
    ok?: boolean; error?: { code?: unknown; message?: unknown }; session?: Record<string, unknown> } | null;
  const code = typeof body?.error?.code === 'string' && /^[a-z_]{1,80}$/.test(body.error.code)
    ? body.error.code : 'unknown';
  const reason = HOSTED_PRINCIPAL_DENIAL_REASONS.find(known => known === body?.error?.message) ?? 'unknown';
  assert(response.status() === 200 && body?.ok === true,
    `Installed Portal auth preflight failed: HTTP ${response.status()} code=${code} reason=${reason}`);
  assert(body.session && Object.entries(expected).every(([key, value]) => body.session![key] === value),
    'Installed Portal auth preflight returned a different private session');
}

export function installedRuntimeNodeArgs(repo: string) {
  return ['--experimental-transform-types', '--import',
    join(repo, 'packages/operator-core/lib/workspace-host/installed-computer-runtime-loader.mjs')];
}

/** Exercise actual SPA mixed-format and identity type-import boundaries before expensive
 * setup. The full hosted graph is exercised once by the actual runtime;
 * importing it here duplicates thousands of unrelated route/tool modules.
 * Source equality cannot detect a subsequent CommonJS transformation. */
export async function assertInstalledRuntimeLoader(repo: string,
  options: { nodeArgs?: string[]; env?: NodeJS.ProcessEnv } = {}) {
  const { stdout } = await promisify(execFile)(process.execPath, [
    ...(options.nodeArgs ?? installedRuntimeNodeArgs(repo)), '--input-type=module', '-e',
    `const host = await import(${JSON.stringify(pathToFileURL(join(repo, 'apps/operator/bin/host-spa.ts')).href)});
     if (typeof host.createSpaRoutes !== 'function') throw new Error('Missing native SPA exports');
     const response = await host.createSpaRoutes().request('/');
     if (![200, 503].includes(response.status)) throw new Error('Native SPA route did not execute');
     const identity = await import(${JSON.stringify(pathToFileURL(join(repo, 'packages/operator-core/lib/identity/two-channel-verifier.ts')).href)});
     if (typeof identity.verifyChannel1 !== 'function') throw new Error('Missing identity verifier export');
     console.log('INSTALLED_NATIVE_LOADER_OK');
     process.exit(0);`,
  ], { cwd: repo, env: options.env ?? process.env, timeout: 30_000, maxBuffer: 1024 * 1024 });
  assert(stdout.includes('INSTALLED_NATIVE_LOADER_OK'), 'Installed native loader smoke did not complete');
}

/** Election is confined to the wrapper-owned, background-disabled process.
 * The production singleton policy remains unchanged in every normal host. */
export function installedHostFixtureScope(env: NodeJS.ProcessEnv) {
  const workspaceId = env.PAPERCUSP_WORKSPACE_ID ?? '';
  assert(workspaceId.startsWith('test-runtime-') && workspaceId.endsWith('-installed')
    && env.PAPERCUSP_SKIP_PG_DISCOVERY === '1' && env.PAPERCUSP_BACKGROUND_WORKERS === '0'
    && env.PAPERCUSP_DBOS_ENABLE === '0', 'Installed host fixture requires isolated operator-api scope');
  const admin = new URL(env.HARNESS_ADMIN_DATABASE_URL ?? 'file:missing');
  const app = new URL(env.HARNESS_DATABASE_URL ?? 'file:missing');
  assert(['127.0.0.1', 'localhost'].includes(admin.hostname) && admin.host === app.host
    && admin.pathname === app.pathname && admin.port === env.PAPERCUSP_PG_PORT,
  'Installed host fixture requires wrapper-owned private database');
  const port = Number(env.PAPERCUSP_HONO_PORT);
  assert(Number.isInteger(port) && port > 0 && port < 65536, 'Installed host fixture requires explicit operator port');
  assert(env.PAPERCUSP_HOME, 'Installed host fixture requires private home');
  return { workspaceId, origin: `http://127.0.0.1:${port}`, home: env.PAPERCUSP_HOME };
}

export async function installedDesktopBinaries(root?: string) {
  const binary = (name: string) => root ? join(root, 'usr/bin', name)
    : execFileSync('which', [name], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  const server = binary('Xkasmvnc'), passwd = binary('kasmvncpasswd');
  await Promise.all([access(server), access(passwd)]);
  return { server, passwd };
}

function argument(name: string) {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}

/** Preloaded by the SAME serve.ts child that owns the desktop lease map.
 * No connector or media backend is replaced. Only private owner election is
 * explicit because the request-only wrapper disables global background work. */
async function runInstalledHostFixture(receiptPath: string) {
  const scope = installedHostFixtureScope(process.env);
  const server = argument('--installed-desktop-server'), passwd = argument('--installed-desktop-passwd');
  assert(server && passwd && process.send, 'Installed host requires media binaries and an owned IPC channel');
  const until = Date.now() + 120_000;
  for (;;) {
    try {
      if ((await fetch(`${scope.origin}/api/health`, { signal: AbortSignal.timeout(2000) })).ok) break;
    } catch { /* serve.ts has not bound yet. */ }
    assert(Date.now() < until, 'Installed host boot deadline before desktop provisioning');
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  const { ensureDesktop, desktopSessionIdFor, releaseDesktop } = await import('../agent-tools/computer/desktop-lease');
  const { defaultPortalRelayDeps, reconcilePortalRelay, startPortalRelayReconciler } = await import('../remote-access/relay-opt-in');
  const { stopPortalRelayConnector } = await import('../remote-access/portal-relay-runtime');
  const target = { scope: 'agent' as const, ownerId: 'private-installed-fixture', name: INSTALLED_FIXTURE_DESKTOP_NAME };
  let cleanup: Promise<unknown> | undefined;
  const release = () => cleanup ??= (async () => { stopPortalRelayConnector(); return releaseDesktop(target); })();
  process.on('message', message => {
    if ((message as { type?: string })?.type !== 'installed-fixture-release') return;
    void release().then(() => process.send?.({ type: 'installed-fixture-released' }))
      .catch(error => { console.error(error); process.exitCode = 1; });
  });
  process.once('disconnect', () => { void release(); });
  const desktop = await ensureDesktop(target, { xServer: 'kasmvnc',
    xServerBinaryPath: server, kasmvncPasswdBinaryPath: passwd,
    credentialDir: join(scope.home, 'installed-desktop-credentials'),
    width: 1024, height: 768, rootColor: '#194f72', apps: [['xterm', '-title', INSTALLED_FIXTURE_DESKTOP_NAME]],
    launchedBy: target.ownerId });
  const desktopSessionId = desktopSessionIdFor(target);
  assert(desktopSessionId && desktop.endpoint && desktop.isAlive?.(), 'Real installed desktop must have a live lease and registry identity');
  const deps = defaultPortalRelayDeps({ isConnectorOwner: () => true });
  const reconciled = await reconcilePortalRelay(deps);
  assert(['started', 'running'].includes(reconciled.action), `Private production relay failed: ${JSON.stringify(reconciled)}`);
  startPortalRelayReconciler(deps);
  await writeFile(receiptPath, JSON.stringify({ pid: process.pid, workspaceId: scope.workspaceId,
    desktopSessionId, name: target.name, display: desktop.display, xServer: desktop.xServer,
    endpoint: desktop.endpoint, relayAction: reconciled.action }), { mode: 0o600 });
}

export async function installedPortalSource(source: string | undefined): Promise<string> {
  assert(source, 'Pass --portal-source-root or PAPERCUSP_PORTAL_SOURCE_ROOT for the maintained Portal checkout');
  const portal = await realpath(source);
  await Promise.all(['app/page.tsx', 'apps', 'packages', 'pot-app-seam', 'public', 'proxy.ts',
    'instrumentation.ts', 'next.config.mjs', 'package.json', 'node_modules/next/dist/bin/next',
    'next-env.d.ts', 'tsconfig.json'].map(entry => access(join(portal, entry))));
  return portal;
}

type PortalReleaseIdentity = {
  schemaVersion: number; buildId: string; release: string; sourceRoot: string;
  sourceRootDigest: string; publishedAt: string; buildProvenance: unknown;
};

/** Bind the artifact to the source being tested, rather than fabricating a
 * release manifest for Next dev or silently accepting an older deployment. */
export function validateInstalledPortalRelease(portal: string, releaseRoot: string,
  identity: PortalReleaseIdentity, currentDigest: string) {
  assert(identity.schemaVersion === 2 && identity.sourceRoot === portal,
    'Installed acceptance requires a maintained release from this Portal checkout');
  assert(identity.release === basename(releaseRoot) && /^[A-Za-z0-9._-]+$/.test(identity.release)
    && identity.buildId.trim() && Number.isFinite(Date.parse(identity.publishedAt)),
  'Installed acceptance requires an immutable Portal release identity');
  assert(/^[a-f0-9]{64}$/.test(identity.sourceRootDigest) && identity.sourceRootDigest === currentDigest,
    'Installed Portal release is stale relative to the current source');
  assert(identity.buildProvenance, 'Installed Portal release requires maintained build provenance');
  return { ...identity, releaseRoot, releasesDir: dirname(releaseRoot), entry: join(releaseRoot, 'standalone-entry.mjs') };
}

export async function installedPortalRelease(portal: string, source?: string) {
  assert(source, 'Pass --portal-release-root for the maintained immutable Portal artifact');
  const root = await realpath(source);
  const identity = JSON.parse(await readFile(join(root, '.papercusp-release.json'), 'utf8')) as PortalReleaseIdentity;
  const integrity = await import(pathToFileURL(join(portal, 'scripts/source-integrity.mjs')).href);
  // Root freshness consumes only this checkout's records. Linked server code
  // is checked independently against the immutable artifact's bundle bytes.
  console.info('[installed-portal-release] source root fingerprint start');
  const fingerprint = await integrity.fingerprintReleaseSource(portal, { includeLinkedSources: false });
  console.info('[installed-portal-release] source root fingerprint complete');
  const release = validateInstalledPortalRelease(portal, root, identity, fingerprint.rootDigest);
  await access(release.entry);
  console.info('[installed-portal-release] artifact provenance start');
  await integrity.assertBuildProvenance(identity.buildProvenance, root, identity.sourceRootDigest);
  console.info('[installed-portal-release] artifact provenance complete');
  return release;
}

export function installedPortalProxy(nextOrigin: string) {
  return async (request: Request) => {
    const url = new URL(request.url);
    const headers = new Headers(request.headers); headers.delete('host');
    headers.set('accept-encoding', 'identity');
    const response = await fetch(new Request(nextOrigin + url.pathname + url.search, { method: request.method, headers,
      ...(!['GET', 'HEAD'].includes(request.method) ? { body: await request.arrayBuffer() } : {}),
      signal: request.signal, redirect: 'manual' }));
    // Fetch decodes upstream compression. The HTTP server must describe the
    // decoded stream, including when an upstream ignores identity encoding.
    const outgoing = new Headers(response.headers);
    outgoing.delete('content-encoding');
    outgoing.delete('content-length');
    outgoing.delete('transfer-encoding');
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers: outgoing });
  };
}

/** Native node children honor the committed-source loader. Refuse before
 * private-PG boot when the intended rig/transport would be replaced or denied. */
export async function assertInstalledRuntimeSource(repo: string) {
  const paths = [
    // The hosted handler loads scorecard tools before either operator starts.
    // Keep the provider and consumer in the same committed-source preflight:
    // a committed consumer can otherwise load an older provider from HEAD.
    'apps/operator/bin/hosted-handler.ts',
    'packages/operator-core/lib/endpoint-route/hosted-runtime.ts',
    'packages/operator-core/lib/auth/hosted/fake-provider.ts',
    'packages/operator-core/lib/rubrics.ts',
    'packages/operator-core/lib/agent-tools/scorecards/emit.ts',
    // These Zod adapters must be published together with consumers. Native
    // children otherwise re-export removed framework symbols from old HEAD.
    'packages/agent-mcp/src/_bulk.ts',
    'packages/operator-core/lib/agent-tools/_bulk.ts',
    'packages/operator-core/lib/workspace-host/machine-first-browser-runtime.fixture.ts',
    'packages/operator-core/lib/workspace-host/installed-computer-served-browser.fixture.ts',
    'packages/operator-core/lib/workspace-host/installed-computer-runtime-loader.mjs',
    'packages/operator-core/lib/workspace-host/byoc-sealed-channel.ts',
    'packages/operator-core/lib/workspace-host/sodium-browser.cjs',
    'apps/operator/app/cloud-workspaces/installed-computer-connection.ts',
    'packages/operator-core/lib/remote-access/relay-opt-in.ts',
    'packages/operator-core/lib/remote-access/portal-relay-runtime.ts',
  ];
  const pending: string[] = [];
  for (const path of paths) {
    try {
      const committed = execFileSync('git', ['show', `HEAD:${path}`], { cwd: repo, stdio: ['ignore', 'pipe', 'ignore'] });
      if (!committed.equals(await readFile(join(repo, path)))) pending.push(path);
    } catch { pending.push(path); }
  }
  assert.deepEqual(pending, [], `Native served runtime requires maintained source sync before execution: ${pending.join(', ')}`);
}

/** A health route does not compile Next's document. Fully consume the actual
 * entry before browser acceptance; a wrong route or dead server is terminal. */
export async function waitForPortalDocument(child: ChildProcess, url: string, timeoutMs = 180_000) {
  const until = Date.now() + timeoutMs;
  let last = 'connection not ready';
  while (Date.now() < until) {
    assert(child.pid && child.exitCode === null && child.signalCode === null,
      `Private Next exited (${child.exitCode ?? child.signalCode}); inspect retained log`);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), until - Date.now());
    const onExit = () => controller.abort();
    child.once('exit', onExit); child.once('error', onExit);
    let response: Response | undefined, html = '';
    try {
      response = await fetch(url, { signal: controller.signal, redirect: 'manual' });
      html = await response.text();
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
      response = undefined;
    } finally {
      clearTimeout(timer); child.off('exit', onExit); child.off('error', onExit);
    }
    assert(child.exitCode === null && child.signalCode === null,
      `Private Next exited (${child.exitCode ?? child.signalCode}); inspect retained log`);
    if (response) {
      assert.equal(response.status, 200, `Portal document HTTP ${response.status}: ${html.slice(0, 300)}`);
      assert(/<html[\s>]/i.test(html) && /<\/html>/i.test(html), 'Portal entry must be a complete HTML document');
      return { url, status: response.status, bytes: Buffer.byteLength(html) };
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Portal document readiness deadline: ${last}`);
}

/** HTTP 200 alone does not prove the authenticated shell hydrated. Keep the
 * browser's actual failure evidence in the outer log before private cleanup. */
export async function waitForInstalledPortalSetup(page: Page, url: string, timeoutMs = 10_000) {
  return waitForInstalledBrowserSurface(page, url, 'portal', timeoutMs);
}

export async function waitForInstalledLocalConsent(page: Page, url: string, timeoutMs = 10_000) {
  return waitForInstalledBrowserSurface(page, url, 'local-consent', timeoutMs);
}

async function waitForInstalledBrowserSurface(page: Page, url: string,
  surface: 'portal' | 'local-consent', timeoutMs: number) {
  const label = surface === 'portal' ? 'Portal' : 'Local consent';
  const errors: string[] = [], failedRequests: string[] = [], httpErrors: string[] = [];
  const onError = (error: Error) => { if (errors.length < 8) errors.push(error.message.slice(0, 500)); };
  const onFailed = (request: import('playwright-core').Request) => {
    if (failedRequests.length < 8) failedRequests.push(`${request.method()} ${new URL(request.url()).pathname}: ${request.failure()?.errorText}`);
  };
  const onResponse = (response: import('playwright-core').Response) => {
    if (response.status() >= 400 && httpErrors.length < 8) httpErrors.push(`${response.status()} ${new URL(response.url()).pathname}`);
  };
  page.on('pageerror', onError); page.on('requestfailed', onFailed); page.on('response', onResponse);
  try {
    const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    assert.equal(response?.status(), 200, `${label} entry must return HTTP 200`);
    if (surface === 'local-consent') {
      const consent = page.getByRole('region', { name: 'Desktop access', exact: true });
      await consent.waitFor({ state: 'visible', timeout: timeoutMs });
      await consent.getByRole('checkbox', { name: 'Allow this browser to view desktops', exact: true })
        .waitFor({ state: 'visible', timeout: timeoutMs });
      await consent.getByRole('button', { name: 'Approve desktop access', exact: true })
        .waitFor({ state: 'visible', timeout: timeoutMs });
      return { status: response!.status(), title: await page.title(), guideDisposition: 'not-shown' as const };
    }
    const launcher = page.getByRole('button', { name: 'Connect your computer', exact: true }).first();
    const skipGuide = page.getByRole('button', { name: 'Skip guide', exact: true });
    await launcher.or(skipGuide).first().waitFor({ state: 'visible', timeout: timeoutMs });
    let guideDisposition: 'skipped' | 'not-shown' = 'not-shown';
    if (await skipGuide.isVisible()) {
      // Fresh hosted accounts enter the account-first guide. Follow the same
      // public control and acknowledged save as the maintained Portal journey.
      const [saved] = await Promise.all([
        page.waitForResponse(reply => reply.request().method() === 'POST'
          && new URL(reply.url()).origin === new URL(url).origin
          && new URL(reply.url()).pathname === '/api/hosted/browser/onboarding/tutorial-progress',
        { timeout: timeoutMs }),
        skipGuide.click({ timeout: timeoutMs }),
      ]);
      assert(saved.ok(), `Guide skip HTTP ${saved.status()}`);
      const body = await saved.json();
      assert.equal(body?.record?.disposition, 'skipped', 'Guide skip was not acknowledged');
      guideDisposition = 'skipped';
    }
    await launcher.waitFor({ state: 'visible', timeout: timeoutMs });
    return { status: response!.status(), title: await page.title(), guideDisposition };
  } catch (cause) {
    const rendered = await page.locator('body').innerText({ timeout: 1000 }).catch(() => 'body unavailable');
    const buttons = await page.getByRole('button').allTextContents().catch(() => []);
    throw new Error(`${label} browser prerequisite failed: ${JSON.stringify({
      location: new URL(page.url()).origin + new URL(page.url()).pathname,
      title: await page.title().catch(() => ''), rendered: rendered.slice(0, 4000),
      buttons: buttons.slice(0, 20), errors, failedRequests, httpErrors,
      cause: cause instanceof Error ? cause.message : String(cause),
    })}`);
  } finally { page.off('pageerror', onError); page.off('requestfailed', onFailed); page.off('response', onResponse); }
}

export async function runInstalledComputerServedBrowser(input: Input) {
  const { repo, privateRoot, evidence, control, origin, certPath, userId, orgId, hosted, stage, waitFor } = input;
  await stage('installed-prerequisites');
  const sourceArg = process.argv.indexOf('--portal-source-root');
  const portal = await installedPortalSource(sourceArg >= 0 ? process.argv[sourceArg + 1]
    : process.env.PAPERCUSP_PORTAL_SOURCE_ROOT);
  const binaries = await installedDesktopBinaries(argument('--kasmvnc-root'));
  const releaseRoot = argument('--portal-release-root');
  const release = releaseRoot ? await installedPortalRelease(portal, releaseRoot) : undefined;
  const portalDatabase = input.config.HARNESS_ADMIN_DATABASE_URL;
  assert(portalDatabase && ['127.0.0.1', 'localhost'].includes(new URL(portalDatabase).hostname),
    'Portal requires the wrapper-owned private database');
  const { getOrgPg, withHostedServiceContext, withWorkspace } = await import('@papercusp/db-org');
  const { PostgresHostedCliStore } = await import('../endpoint-route/routes/hosted-cli/store');
  const cli = new PostgresHostedCliStore(withHostedServiceContext, fn => withWorkspace(control, fn), control);
  await stage('installed-linked-identity');
  const installId = INSTALLED_FIXTURE_SESSION_ID;
  const linked = await cli.upsertLinkedWorkspace({ organizationId: orgId, installId,
    displayName: 'Private installed computer', userId, at: new Date() });
  await stage('installed-sealed-hosting-preflight');
  const { readCustomerWorkspaceHosting, readHostedWorkspaceHosting } =
    await import('../../../../apps/operator/bin/hosted-handler');
  assert.equal(await readCustomerWorkspaceHosting(control, linked.customerWorkspaceId), 'byoc',
    'Private linked workspace must select sealed BYOC without cloud provisioning');
  assert.equal(await readHostedWorkspaceHosting({ ...linked, controlPlaneWorkspaceId: control,
    organizationId: orgId, generation: 1, transport: 'websocket', state: 'active' }), 'byoc',
  'Private linked connector must select sealed BYOC before installed-host startup');
  const session = await createHostedFixtureSession(hosted.plane.components, { userId, organizationId: orgId,
    workspaceId: linked.customerWorkspaceId, upstreamProvider: INSTALLED_FIXTURE_PROVIDER_ID,
    upstreamSessionId: installId, expiresAt: new Date(Date.now() + 30 * 60_000) });
  const { HOSTED_SESSION_COOKIE } = await import('../auth/hosted-session');
  const expectedSession = { userId, organizationId: orgId, workspaceId: linked.customerWorkspaceId };
  await stage('installed-authenticated-session-preflight');
  const authProbe = await playwrightRequest.newContext({ ignoreHTTPSErrors: true,
    extraHTTPHeaders: { cookie: `${HOSTED_SESSION_COOKIE}=${hosted.plane.components.sessionCookieCodec.encode(session.id)}` } });
  try {
    await assertInstalledPortalSession(await authProbe.get(`${origin}/api/hosted/auth/session`,
      { timeout: 10_000 }), expectedSession);
  } finally { await authProbe.dispose(); }
  const gateway = hosted.plane.components.connectorGateway!;
  const enrollment = await gateway.enroll({ controlPlaneWorkspaceId: control, organizationId: orgId,
    customerWorkspaceId: linked.customerWorkspaceId, hostId: linked.hostId,
    routeLabel: linked.routeLabel, transport: 'websocket' });
  const credential = await gateway.register(enrollment.ticket);
  assert(credential, 'Private linked connector must enroll through the production gateway');
  const port = await input.freePort(), guiPort = await input.freePort(), nextPort = await input.freePort();
  const localOrigin = `http://127.0.0.1:${port}`, guiOrigin = `http://127.0.0.1:${guiPort}`;
  const localWorkspace = `${control}-installed`, workspaces = join(privateRoot, 'installed-workspaces');
  await mkdir(join(workspaces, localWorkspace), { recursive: true });
  await writeFile(join(workspaces, 'registry.json'), JSON.stringify({ current: localWorkspace,
    workspaces: [{ id: localWorkspace, name: 'Private installed workspace', createdAt: Date.now() }] }));
  const { ensurePortalRelayRow, recordPortalRelayConsent, savePortalRelayLinked } = await import('../remote-access/portal-relay-store');
  const { PORTAL_RELAY_NOTICE_VERSION } = await import('../remote-access/relay-notice');
  await ensurePortalRelayRow({ installId, portalOrigin: origin });
  await recordPortalRelayConsent({ noticeVersion: PORTAL_RELAY_NOTICE_VERSION, by: userId });
  await savePortalRelayLinked({ userId, organizationId: orgId, customerWorkspaceId: linked.customerWorkspaceId,
    appBaseUrl: `${origin}/apps/${linked.customerWorkspaceId}`, connectorUrl: origin.replace('https:', 'wss:') + '/api/hosted/connectors/socket',
    connectorBearer: credential.bearer, operatorPort: port });
  const hostReceiptPath = `${evidence}-installed-host.json`;
  const local = input.start('installed', { ...process.env,
    PAPERCUSP_HONO_PORT: String(port), PORT: String(port),
    PAPERCUSP_WORKSPACE: localWorkspace, PAPERCUSP_WORKSPACE_ID: localWorkspace,
    PAPERCUSP_WORKSPACES_ROOT: workspaces,
    OPERATOR_E2E_BASE_URL: guiOrigin, OPERATOR_BASE_URL: guiOrigin, NODE_EXTRA_CA_CERTS: certPath }, {
    preload: 'packages/operator-core/lib/workspace-host/installed-computer-served-browser.fixture.ts',
    args: ['--installed-host-receipt', hostReceiptPath, '--installed-desktop-server', binaries.server,
      '--installed-desktop-passwd', binaries.passwd],
  });
  assert(local.pid && local.pid !== process.pid, 'Installed operator must be a separate process');
  await stage('installed-operator-ready');
  await waitFor('installed operator', async () => {
    const response = await fetch(`${localOrigin}/api/remote-access/portal-relay`);
    return response.ok && (await response.json()).relay.state === 'linked';
  });
  const hostReceipt = await waitFor('installed desktop and production reconciler', async () => {
    try { return JSON.parse(await readFile(hostReceiptPath, 'utf8')) as {
      pid: number; workspaceId: string; desktopSessionId: string; name: string; xServer: string };
    } catch { return false; }
  });
  assert.equal(hostReceipt.pid, local.pid, 'Relay and live desktop must belong to the separate installed operator');
  assert.equal(hostReceipt.workspaceId, localWorkspace);
  assert.equal(hostReceipt.xServer, 'kasmvnc');
  // The adapter sorts by session id. Seed ids below the actual lease id so
  // the live display is deterministically beyond three complete roster pages.
  const { registerDesktopSession, markDesktopReady } = await import('../desktop/desktop-session-registry');
  const desktopIds: string[] = [hostReceipt.desktopSessionId];
  const realId = BigInt(`0x${hostReceipt.desktopSessionId.replace(/-/g, '')}`);
  assert(realId > 192n, 'Fixture desktop id must leave room for inventory ids');
  for (let index = 0; index < 192; index++) {
    const hex = (realId - BigInt(index + 1)).toString(16).padStart(32, '0');
    const id = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    const row = await registerDesktopSession({ id, workspaceId: localWorkspace, kind: 'xvfb-local', scope: 'agent',
      scopeRef: `private-installed-agent-${index}`, name: `served-${String(index).padStart(4, '0')}`,
      display: `:${20000 + index}`, displayGeometry: { width: 1024, height: 768 }, ownerPid: local.pid });
    await markDesktopReady(row.id); desktopIds.push(row.id);
  }
  const liveRosterIndex = [...desktopIds].sort().indexOf(hostReceipt.desktopSessionId);
  assert.equal(liveRosterIndex, 192, 'Live media acceptance must require roster continuation');
  const project = join(privateRoot, 'installed-portal-next');
  await mkdir(project, { recursive: true });
  // Reuse the Portal's maintained web-host isolation pattern. Never link its
  // .env.local: only the wrapper-owned database and private auth config enter.
  if (!release) {
    await cp(join(portal, 'app'), join(project, 'app'), { recursive: true });
    for (const entry of ['apps', 'packages', 'pot-app-seam', 'public', 'proxy.ts', 'instrumentation.ts',
      'next.config.mjs', 'package.json', 'node_modules']) await symlink(join(portal, entry), join(project, entry));
    for (const entry of ['next-env.d.ts', 'tsconfig.json']) await copyFile(join(portal, entry), join(project, entry));
  }
  const fd = openSync(`${evidence}-portal-next.log`, 'w', 0o600);
  const next = spawn(process.execPath, release ? [release.entry] : [join(portal, 'node_modules/next/dist/bin/next'),
    'dev', '--webpack', '-H', '127.0.0.1', '-p', String(nextPort)], {
    cwd: release?.releaseRoot ?? project, detached: true, stdio: ['ignore', fd, fd], env: { ...input.config,
      PORT: String(nextPort), HOSTNAME: '127.0.0.1',
      PORTAL_HOME: join(project, '.portal-home'), PORTAL_LOCAL_MODE: '0',
      PORTAL_DATABASE_URL: portalDatabase,
      PORTAL_HOSTED_CONTROL_PLANE_ORIGIN: origin, PORTAL_OPERATOR_ORIGIN: localOrigin,
      NODE_EXTRA_CA_CERTS: certPath, NEXT_TELEMETRY_DISABLED: '1' },
  });
  // Keep spawn errors observable even if they arrive before readiness starts.
  let nextError: Error | undefined;
  next.on('error', error => { nextError = error; });
  closeSync(fd);
  let browser: Browser | undefined, gui: import('vite').ViteDevServer | undefined, legacy: Server | undefined;
  try {
    await stage('installed-portal-document-ready');
    const nextOrigin = `http://127.0.0.1:${nextPort}`;
    assert(!nextError, nextError?.message);
    const portalDocument = await waitForPortalDocument(next, `${nextOrigin}/?app=desktops`);
    input.routePortal(installedPortalProxy(nextOrigin));
    // Next readiness alone cannot detect proxy framing or TLS delivery bugs.
    // Consume the same HTTPS document the browser will receive before its run.
    await stage('installed-proxied-portal-document-ready');
    const documentProbe = await playwrightRequest.newContext({ ignoreHTTPSErrors: true });
    try {
      const response = await documentProbe.get(`${origin}/?app=desktops`, { timeout: 10_000 });
      assert.equal(response.status(), 200, 'Proxied Portal document must be available');
      const html = await response.text();
      assert(/<html[\s>]/i.test(html) && /<\/html>/i.test(html),
        'Proxied Portal entry must deliver a complete HTML document');
    } finally { await documentProbe.dispose(); }
    const { createServer } = await import('vite');
    process.env.PAPERCUSP_API_TARGET = localOrigin;
    gui = await createServer({ root: join(repo, 'apps/operator-vite'),
      configFile: join(repo, 'apps/operator-vite/vite.config.ts'), configLoader: 'runner',
      cacheDir: join(privateRoot, 'installed-vite-cache'), server: {
        host: '127.0.0.1', port: guiPort, strictPort: true, hmr: false, watch: null,
        // Preserve the real browser origin through the private same-origin
        // proxy so the production local-only consent guard executes unchanged.
        proxy: { '/api': { target: localOrigin, ws: true, changeOrigin: false } },
      } });
    await stage('installed-local-gui-ready');
    await gui.listen();
    const guiDocument = await fetch(guiOrigin);
    assert.equal(guiDocument.status, 200, 'Actual local operator GUI must serve its entry');
    await guiDocument.text();
    if (release) {
      await stage('installed-portal-executor-fixture');
      const storageStatePath = join(privateRoot, 'installed-portal-storage.json');
      await writeFile(storageStatePath, JSON.stringify({ cookies: [{ name: HOSTED_SESSION_COOKIE,
        value: hosted.plane.components.sessionCookieCodec.encode(session.id), domain: new URL(origin).hostname,
        path: '/', expires: -1, secure: true, httpOnly: true, sameSite: 'Lax' }], origins: [] }), { mode: 0o600 });
      await stage('installed-portal-browser-prerequisites');
      browser = await chromium.launch({ channel: 'chrome', headless: true });
      const preflight = await browser.newContext({ storageState: storageStatePath, ignoreHTTPSErrors: true });
      try {
        await stage('installed-local-consent-browser-prerequisite');
        await waitForInstalledLocalConsent(await preflight.newPage(), `${guiOrigin}/settings/remote-access`);
        await assertInstalledPortalSession(await preflight.request.get(`${origin}/api/hosted/auth/session`,
          { timeout: 10_000 }), expectedSession);
        const url = new URL('/', origin);
        url.search = new URLSearchParams({ app: 'desktops', desktopHost: linked.hostId,
          ws: linked.customerWorkspaceId, accountsPane: 'false', chatPane: 'false' }).toString();
        await waitForInstalledPortalSetup(await preflight.newPage(), url.href);
      } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        throw error;
      } finally { await preflight.close(); await browser.close(); browser = undefined; }
      const fixturePath = `${evidence}-portal-fixture.json`;
      const stoppedOrigin = `http://127.0.0.1:${await input.freePort()}`;
      // A real reachable HTTP legacy-client stimulus, distinct from refused TCP.
      const legacyServer = createHttpServer((_, response) => {
        response.writeHead(404, { 'content-type': 'text/html' });
        response.end('<html><title>Legacy Papercusp</title><body>This installed version lacks desktop access.</body></html>');
      });
      legacy = legacyServer;
      await new Promise<void>((resolve, reject) => {
        legacyServer.once('error', reject);
        legacyServer.listen(0, '127.0.0.1', resolve);
      });
      const unsupportedOrigin = `http://127.0.0.1:${(legacyServer.address() as { port: number }).port}`;
      const runId = `installed-portal-${basename(privateRoot)}-${Date.now()}`;
      const caseEvidencePath = `${evidence}-portal-case`;
      await writeFile(fixturePath, JSON.stringify({ portalOrigin: origin, localOrigin: guiOrigin, stoppedOrigin,
        unsupportedOrigin, runId, caseEvidencePath,
        controlWorkspaceId: control, workspaceId: linked.customerWorkspaceId, hostId: linked.hostId,
        hostName: 'Private installed computer', installedHostPid: local.pid,
        desktopNameAfterFirstPage: hostReceipt.name, desktopCount: desktopIds.length,
        releasesDir: release.releasesDir, buildId: release.buildId, sourceRootDigest: release.sourceRootDigest,
        storageStatePath }), { mode: 0o600 });
      const { runPortalPlaywrightChecks } = await import('../rubrics-playwright-checks');
      const previousFixture = process.env.PORTAL_LOCAL_CONNECTION_FIXTURE;
      process.env.PORTAL_LOCAL_CONNECTION_FIXTURE = fixturePath;
      let executor;
      try {
        await stage('installed-maintained-portal-playwright');
        executor = await runPortalPlaywrightChecks({ root: portal,
          files: [INSTALLED_PORTAL_SPEC], runId,
          actorId: argument('--portal-actor-id'), workspaceId: argument('--portal-ledger-workspace'),
          harnessSlug: argument('--portal-ledger-harness'), timeoutMs: 7 * 60_000,
          artifactDirectory: dirname(evidence) });
      } finally {
        if (previousFixture === undefined) delete process.env.PORTAL_LOCAL_CONNECTION_FIXTURE;
        else process.env.PORTAL_LOCAL_CONNECTION_FIXTURE = previousFixture;
      }
      await writeFile(`${evidence}-portal-executor.json`, JSON.stringify(executor, null, 2));
      assertInstalledPortalExecutor(executor, portal);
      const caseEvidence = await Promise.all(['stopped', 'unsupported', 'consent'].map(async scenario =>
        JSON.parse(await readFile(`${caseEvidencePath}-${scenario}.json`, 'utf8')) as InstalledPortalCaseEvidence));
      assertInstalledPortalCaseEvidence(caseEvidence, { runId, buildId: release.buildId,
        sourceRootDigest: release.sourceRootDigest });
      const state = await (await fetch(`${localOrigin}/api/remote-access/portal-relay`)).json();
      assert.equal(state.relay.desktop.grant, null, 'Portal executor must revoke its private grant');
      assert(state.relay.linked, 'Desktop revocation must preserve the installation link');
      const rows = await getOrgPg().sql`SELECT id FROM harness_shared.customer_workspaces
        WHERE workspace_id=${control} AND linked_install_id=${installId} AND organization_id=${orgId}::uuid`;
      assert.equal(rows.length, 1, 'Maintained Portal journey must reuse the linked installation');
      return { status: 'passed', portalEngine: 'Next/Playwright', portalDocument,
        artifact: { buildId: release.buildId, sourceRootDigest: release.sourceRootDigest, releaseRoot: release.releaseRoot },
        executor, caseEvidence, installedHost: hostReceipt, operatorPid: local.pid, desktopRegistryCount: desktopIds.length,
        liveRosterIndex, linkedWorkspaceCount: rows.length, fixturePath,
        limitations: ['One private live display plus synthetic inventory; no owner account pairing', 'Mutation/BAR proof remains separate'] };
    }
    browser = await chromium.launch({ channel: 'chrome', headless: true });
    const context = await browser.newContext({ ignoreHTTPSErrors: true });
    await context.addCookies([{ name: HOSTED_SESSION_COOKIE,
      value: hosted.plane.components.sessionCookieCodec.encode(session.id), url: origin,
      secure: true, httpOnly: true, sameSite: 'Lax' }]);
    const page = await context.newPage();
    const errors: string[] = [];
    const wire: Array<{ type: string; contentType?: string | null }> = [];
    page.on('websocket', socket => {
      if (!new URL(socket.url()).pathname.includes('/hosted/')) return;
      socket.on('framesent', event => {
        try { const frame = JSON.parse(String(event.payload)); wire.push({ type: frame.type, contentType: frame.contentType }); }
        catch { errors.push('Non-JSON hosted browser frame'); }
      });
    });
    page.on('pageerror', error => errors.push(error.message));
    await stage('installed-portal-browser');
    await page.goto(`${origin}/?app=desktops&ws=${encodeURIComponent(linked.customerWorkspaceId)}&desktopHost=${encodeURIComponent(linked.hostId)}`,
      { waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: 'Connect your computer', exact: true }).first().click();
    await page.getByLabel('Papercusp app address').fill(guiOrigin);
    const code = page.getByLabel('Public connection code');
    await code.waitFor();
    await page.waitForFunction(() => !!document.querySelector<HTMLTextAreaElement>('textarea[readonly]')?.value);
    const publicCode = await code.inputValue();
    const beforeKey = await page.evaluate(() => localStorage.getItem('papercusp.installed-computer.browser-seed.v1'));
    assert(beforeKey, 'Real Portal must establish a persistent browser Noise identity');
    const popupEvent = page.waitForEvent('popup');
    await page.getByRole('button', { name: 'Open Papercusp', exact: true }).click();
    const popup = await popupEvent;
    await stage('installed-local-consent');
    await popup.getByTestId('portal-desktop-grant').waitFor({ timeout: 120_000 });
    assert.equal(await popup.getByRole('button', { name: 'Approve desktop access', exact: true }).isDisabled(), true);
    assert.equal(await popup.getByLabel('Portal connection code', { exact: true }).inputValue(), publicCode);
    await popup.getByRole('checkbox', { name: 'Allow this browser to view desktops', exact: true }).click();
    assert.equal(await popup.getByRole('checkbox', { name: 'Also allow keyboard and mouse control', exact: true }).isChecked(), false);
    const receiptResponse = popup.waitForResponse(response => response.url().endsWith('/api/remote-access/portal-relay/desktop-grant')
      && response.request().method() === 'POST');
    await popup.getByRole('button', { name: 'Approve desktop access', exact: true }).click();
    const receipt = await receiptResponse;
    assert.equal(receipt.status(), 200, await receipt.text());
    const saved = await receipt.json();
    assert.equal(saved.relay.desktop.grant.control, false);
    assert.equal(saved.relay.desktop.grant.userId, userId);
    assert.equal(saved.relay.desktop.grant.localWorkspaceId, localWorkspace);
    await page.getByText('Approval saved.', { exact: false }).waitFor();
    const connectAndWatch = async () => {
      const connection = page.getByRole('region', { name: 'Installed computer Private installed computer', exact: true });
      await connection.getByRole('button', { name: 'Connect', exact: true }).click();
      await waitFor('installed Noise discovery channel', async () => /live/.test(await connection.getByRole('status').innerText()));
      const grid = page.getByRole('region', { name: 'Desktop grid', exact: true });
      await waitFor('complete 193-entry roster', async () => /193 desktops/.test(await grid.getByRole('status').innerText()));
      await grid.getByRole('searchbox', { name: 'Filter desktops', exact: true }).fill(hostReceipt.name);
      await grid.getByRole('button').filter({ hasText: hostReceipt.name }).first().click();
      const viewer = page.getByRole('region', { name: `Desktop viewer for ${hostReceipt.name}`, exact: true });
      await waitFor('live private desktop stream', async () => await viewer.getAttribute('data-state') === 'connected');
      assert.equal(await viewer.getAttribute('data-input-allowed'), 'false');
      await viewer.getByText('Keyboard/pointer: watch-only', { exact: true }).waitFor();
      // Inspect the real canvas rather than mistaking an RFB handshake for a
      // received screen. The private provisioner's blue root must be present.
      await page.waitForFunction(name => {
        const canvas = document.querySelector<HTMLCanvasElement>(`[aria-label="Desktop viewer for ${name}"] canvas`);
        if (!canvas || !canvas.width || !canvas.height) return false;
        const context = canvas.getContext('2d');
        if (!context) return false;
        const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
        for (let i = 0; i < pixels.length; i += 4) if (pixels[i] === 25 && pixels[i + 1] === 79 && pixels[i + 2] === 114 && pixels[i + 3] === 255) return true;
        return false;
      }, hostReceipt.name);
    };
    await stage('installed-roster-media-watch-only');
    await connectAndWatch();
    await stage('installed-portal-reload');
    await page.reload({ waitUntil: 'domcontentloaded' });
    assert.equal(await page.evaluate(() => localStorage.getItem('papercusp.installed-computer.browser-seed.v1')), beforeKey);
    await stage('installed-roster-media-recovery');
    await connectAndWatch();
    await page.screenshot({ path: `${evidence}-portal.png`, fullPage: true });
    await popup.screenshot({ path: `${evidence}-local-consent.png`, fullPage: true });
    assert.deepEqual(errors, []);
    assert(wire.some(frame => frame.contentType === 'desktop.roster'), 'Browser must exercise real sealed discovery');
    assert(wire.every(frame => frame.type === 'sealed.packet'), 'No plaintext application frames may reach the relay');
    await popup.getByRole('button', { name: 'Revoke desktop access', exact: true }).click();
    await waitFor('desktop grant revocation', async () => {
      const state = await (await fetch(`${localOrigin}/api/remote-access/portal-relay`)).json();
      return state.relay.desktop.grant === null && state.relay.linked !== null;
    });
    const sql = getOrgPg().sql;
    const rows = await sql`SELECT id FROM harness_shared.customer_workspaces
      WHERE workspace_id=${control} AND linked_install_id=${installId} AND organization_id=${orgId}::uuid`;
    assert.equal(rows.length, 1, 'Approval and reload must reuse the original linked installation');
    return { status: 'passed', portalEngine: 'Next/Chromium', portalDocument, operatorPid: local.pid,
      desktopRegistryCount: desktopIds.length, linkedWorkspaceCount: rows.length,
      browserIdentitySha256: createHash('sha256').update(beforeKey).digest('hex'),
      viewOnlyConsent: true, grantId: saved.relay.desktop.grant.id,
      installedHost: hostReceipt, liveRosterIndex, mediaFrame: true, reloadRecovery: true, sealedWire: true,
      limitations: ['Synthetic inventory plus one private live display; no owner account pairing', 'Mutation/BAR proof remains separate'] };
  } finally {
    await browser?.close(); await gui?.close();
    legacy?.closeAllConnections();
    if (legacy?.listening) await new Promise<void>((resolve, reject) => legacy!.close(error => error ? reject(error) : resolve()));
    if (legacy) {
      legacy.closeAllConnections();
      await new Promise<void>(resolve => legacy!.close(() => resolve()));
    }
    if (local.connected && local.exitCode === null && local.signalCode === null) {
      await new Promise<void>((resolve, reject) => {
        const done = (message: unknown) => {
          if ((message as { type?: string })?.type !== 'installed-fixture-released') return;
          clearTimeout(timer); local.off('message', done); resolve();
        };
        const timer = setTimeout(() => { local.off('message', done); reject(new Error('Installed desktop release deadline')); }, 10_000);
        local.on('message', done); local.send({ type: 'installed-fixture-release' });
      });
    }
    if (next.pid) {
      try { process.kill(-next.pid, 'SIGTERM'); } catch { /* Already exited. */ }
      const until = Date.now() + 5000;
      while (next.exitCode === null && next.signalCode === null && Date.now() < until)
        await new Promise(resolve => setTimeout(resolve, 50));
      try { process.kill(-next.pid, 'SIGKILL'); } catch { /* Whole group exited. */ }
    }
  }
}

const installedHostReceipt = argument('--installed-host-receipt');
if (installedHostReceipt) {
  void runInstalledHostFixture(installedHostReceipt).catch(error => {
    console.error('[installed-host-fixture]', error);
    process.exit(1);
  });
}
