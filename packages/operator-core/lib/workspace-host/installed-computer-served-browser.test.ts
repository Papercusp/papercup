import { execFileSync, spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createServer, type RequestListener, type Server } from 'node:http';
import { gzipSync } from 'node:zlib';
import { chromium } from 'playwright-core';
import { serve } from '@hono/node-server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { crossOriginIsolationHeaders } from '../../../../libs/generic/desktop-ipc/src/csp-policy';
import { assertInstalledPortalSession, assertInstalledRuntimeLoader, assertInstalledRuntimeSource, installedDesktopBinaries, installedHostFixtureScope, installedHostedIdentityProvider, installedPortalProxy, installedPortalSource, installedRuntimeNodeArgs, validateInstalledPortalRelease, waitForInstalledLocalConsent, waitForInstalledPortalSetup, waitForPortalDocument } from './installed-computer-served-browser.fixture';

vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, execFileSync: vi.fn(actual.execFileSync) };
});
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, readFile: vi.fn(actual.readFile) };
});

let child: ChildProcess | undefined, server: Server | undefined;
let nativeRoot: string | undefined;
afterEach(async () => {
  if (child && child.exitCode === null && child.signalCode === null) {
    const exited = once(child, 'exit'); child.kill(); await exited;
  }
  server?.closeAllConnections();
  if (server) await new Promise<void>(resolve => server!.close(() => resolve()));
  if (nativeRoot) { await rm(nativeRoot, { recursive: true, force: true }); nativeRoot = undefined; }
});

async function start(handler: RequestListener) {
  child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)']);
  await once(child, 'spawn');
  server = createServer(handler);
  await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

/** Isolate a byte-identical current harness helper outside the checkout so
 * tests can run before publication, with the actual guard registered FIRST.
 * Application modules retain the guard's normal committed-source policy. */
async function currentNativeLoader(repo: string) {
  nativeRoot ??= await mkdtemp(join(tmpdir(), 'installed-native-loader-'));
  const args = installedRuntimeNodeArgs(repo);
  const copy = join(nativeRoot, 'loader.mjs');
  await copyFile(args.at(-1)!, copy);
  await symlink(join(repo, 'node_modules'), join(nativeRoot, 'node_modules'), 'dir');
  args[args.length - 1] = copy;
  return ['--import', join(repo, 'scripts/lib/committed-source-loader.mjs'), ...args];
}

describe('served Portal prerequisite and document readiness', () => {
  const expectedSession = { userId: 'private-user', organizationId: 'private-org', workspaceId: 'private-workspace' };

  it('waits for the actual local consent controls to render after the HTML entry', async () => {
    const origin = await start((_, response) => {
      response.setHeader('content-type', 'text/html');
      response.end(`<html><title>Local settings</title><body>Loading<script>
        setTimeout(() => { document.body.innerHTML = '<section aria-label="Desktop access"><label><input type="checkbox">Allow this browser to view desktops</label><button disabled>Approve desktop access</button></section>'; }, 100);
      </script></body></html>`);
    });
    const browser = await chromium.launch({ channel: 'chrome', headless: true });
    try {
      await expect(waitForInstalledLocalConsent(await browser.newPage(), origin, 1000))
        .resolves.toMatchObject({ status: 200, title: 'Local settings' });
    } finally { await browser.close(); }
  });

  it('refuses a local HTML shell even when it has the Portal launcher', async () => {
    const origin = await start((_, response) => {
      response.setHeader('content-type', 'text/html');
      response.end('<html><title>Wrong surface</title><body><button>Connect your computer</button></body></html>');
    });
    const browser = await chromium.launch({ channel: 'chrome', headless: true });
    try {
      await expect(waitForInstalledLocalConsent(await browser.newPage(), origin, 300))
        .rejects.toThrow('Local consent browser prerequisite failed');
    } finally { await browser.close(); }
  });

  it('retains local consent bootstrap failures before the private context closes', async () => {
    const origin = await start((request, response) => {
      if (request.url === '/missing-local.js') { response.writeHead(404); response.end('missing'); return; }
      response.setHeader('content-type', 'text/html');
      response.end('<html><title>Local bootstrap</title><body>Starting settings<script src="/missing-local.js"></script><script>throw new Error("local hydration failure")</script></body></html>');
    });
    const browser = await chromium.launch({ channel: 'chrome', headless: true });
    try {
      const error = await waitForInstalledLocalConsent(await browser.newPage(), origin, 300)
        .then(() => '', cause => String(cause));
      for (const evidence of ['Local consent browser prerequisite failed', 'Starting settings',
        'Local bootstrap', 'local hydration failure', '404 /missing-local.js']) expect(error).toContain(evidence);
    } finally { await browser.close(); }
  });

  it.each([false, true])('measures the local isolation policy severing the cross-origin approval opener: %s', async isolated => {
    const local = createServer((_, response) => {
      response.writeHead(200, { 'content-type': 'text/html', ...(isolated ? crossOriginIsolationHeaders() : {}) });
      response.end('<html><body><button onclick="window.opener?.postMessage(\'approval\', \'*\')">Approve</button></body></html>');
    });
    await new Promise<void>(resolve => local.listen(0, '127.0.0.1', resolve));
    const localOrigin = `http://127.0.0.1:${(local.address() as { port: number }).port}`;
    const origin = await start((_, response) => {
      response.setHeader('content-type', 'text/html');
      response.end(`<html><body><button onclick="window.open('${localOrigin}')">Open</button><script>window.received = false; addEventListener('message', () => { window.received = true; });</script></body></html>`);
    });
    const browser = await chromium.launch({ channel: 'chrome', headless: true });
    try {
      const context = await browser.newContext();
      const page = await context.newPage();
      await page.goto(origin);
      const opened = page.waitForEvent('popup');
      await page.getByRole('button', { name: 'Open', exact: true }).click();
      const popup = await opened;
      await popup.waitForLoadState('domcontentloaded');
      expect(await popup.evaluate(() => window.opener === null)).toBe(isolated);
      expect(await popup.evaluate(() => window.crossOriginIsolated)).toBe(isolated);
      await popup.getByRole('button', { name: 'Approve', exact: true }).click();
      if (!isolated) await page.waitForFunction(() => (window as unknown as { received: boolean }).received);
      expect(await page.evaluate(() => (window as unknown as { received: boolean }).received)).toBe(!isolated);
    } finally {
      await browser.close(); local.closeAllConnections();
      await new Promise<void>(resolve => local.close(() => resolve()));
    }
  });

  it('creates an upstream fixture session valid at the current time', async () => {
    const now = Date.now();
    const provider = installedHostedIdentityProvider(now);
    expect(provider.providerId).toBe('private-installed-browser');
    const result = await provider.validateSession({ externalSessionId: 'inst-private-served-browser' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.issuedAtMs).toBeLessThan(now);
      expect(result.value.expiresAtMs).toBeGreaterThan(now);
    }
  });

  it.each(['session_invalid', 'session_required', 'membership_not_active'])(
    'fails early with only the safe auth code %s', async code => {
      const error = await assertInstalledPortalSession({ status: () => 401,
        json: async () => ({ ok: false, error: { code, safeMessage: 'sensitive fixture detail' }, cookie: 'secret' }) },
      expectedSession).catch(String);
      expect(error).toContain(`HTTP 401 code=${code}`);
      expect(error).not.toMatch(/sensitive|secret/);
    });

  it('accepts only the expected authenticated private session', async () => {
    const response = (session: Record<string, string>) => ({ status: () => 200,
      json: async () => ({ ok: true, session }) });
    await expect(assertInstalledPortalSession(response(expectedSession), expectedSession)).resolves.toBeUndefined();
    await expect(assertInstalledPortalSession(response({ ...expectedSession, workspaceId: 'other' }), expectedSession))
      .rejects.toThrow('different private session');
  });

  it.each(['session_permission_version_stale', 'session_cookie_missing'])(
    'retains the safe mounted authorization reason %s', async reason => {
      await expect(assertInstalledPortalSession({ status: () => 401,
        json: async () => ({ error: { code: 'unauthorized', message: reason } }) }, expectedSession))
        .rejects.toThrow(`code=unauthorized reason=${reason}`);
    });

  it('does not retain an arbitrary authorization message', async () => {
    const error = await assertInstalledPortalSession({ status: () => 401,
      json: async () => ({ error: { code: 'unauthorized', message: 'secret cookie and database details' } }) },
    expectedSession).catch(String);
    expect(error).toContain('code=unauthorized reason=unknown');
    expect(error).not.toMatch(/secret|cookie and|database/);
  });

  it('waits for the actual browser launcher after document readiness', async () => {
    const origin = await start((_, response) => {
      response.setHeader('content-type', 'text/html');
      response.end('<html><body>Loading<script>setTimeout(() => { document.body.innerHTML = "<button>Connect your computer</button>" }, 50)</script></body></html>');
    });
    const browser = await chromium.launch({ channel: 'chrome', headless: true });
    try {
      await expect(waitForInstalledPortalSetup(await browser.newPage(), origin, 2000))
        .resolves.toMatchObject({ status: 200 });
    } finally { await browser.close(); }
  });

  it.each([0, 50])('opens the launcher through the fresh account guide after %ims hydration', async delay => {
    const mutations: unknown[] = [];
    const origin = await start((request, response) => {
      if (request.url === '/api/hosted/browser/onboarding/tutorial-progress') {
        expect(request.method).toBe('POST');
        let body = '';
        request.on('data', chunk => { body += chunk; });
        request.on('end', () => {
          mutations.push(JSON.parse(body));
          response.setHeader('content-type', 'application/json');
          response.end(JSON.stringify({ record: { disposition: 'skipped' } }));
        });
        return;
      }
      response.setHeader('content-type', 'text/html');
      response.end(`<html><body>Loading<script>
        setTimeout(() => {
          document.body.innerHTML = '<main>Product guide<button>Skip guide</button></main>';
          document.querySelector('button').onclick = async () => {
            const response = await fetch('/api/hosted/browser/onboarding/tutorial-progress', {
              method: 'POST', headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ disposition: 'skipped' }) });
            const body = await response.json();
            if (response.ok && body.record.disposition === 'skipped')
              document.body.innerHTML = '<button>Connect your computer</button>';
          };
        }, ${delay});
      </script></body></html>`);
    });
    const browser = await chromium.launch({ channel: 'chrome', headless: true });
    try {
      const page = await browser.newPage();
      await expect(waitForInstalledPortalSetup(page, origin, 2000))
        .resolves.toMatchObject({ status: 200, guideDisposition: 'skipped' });
      expect(mutations).toEqual([{ disposition: 'skipped' }]);
      await expect(page.getByRole('button', { name: 'Connect your computer', exact: true }).isVisible())
        .resolves.toBe(true);
    } finally { await browser.close(); }
  });

  it.each([{ status: 403, disposition: 'skipped' }, { status: 200, disposition: 'active' }])(
    'refuses a guide save without acknowledgement ($status/$disposition) even if the launcher appears',
    async ({ status, disposition }) => {
      const origin = await start((request, response) => {
        if (request.url === '/api/hosted/browser/onboarding/tutorial-progress') {
          response.writeHead(status, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ record: { disposition } }));
          return;
        }
        response.setHeader('content-type', 'text/html');
        response.end(`<html><body>Product guide<button>Skip guide</button><script>
          document.querySelector('button').onclick = async () => {
            await fetch('/api/hosted/browser/onboarding/tutorial-progress', { method: 'POST' });
            document.body.innerHTML = '<button>Connect your computer</button>';
          };
        </script></body></html>`);
      });
      const browser = await chromium.launch({ channel: 'chrome', headless: true });
      try {
        await expect(waitForInstalledPortalSetup(await browser.newPage(), origin, 1000))
          .rejects.toThrow(status === 403 ? 'Guide skip HTTP 403' : 'Guide skip was not acknowledged');
      } finally { await browser.close(); }
    });

  it('retains browser errors and rendered state when HTTP 200 never hydrates the launcher', async () => {
    const origin = await start((request, response) => {
      if (request.url === '/missing-bootstrap.js') { response.writeHead(404); response.end('missing'); return; }
      response.setHeader('content-type', 'text/html');
      response.end('<html><title>Private fixture</title><body>Checking your portal session<script src="/missing-bootstrap.js"></script><script>throw new Error("fixture hydration failure")</script></body></html>');
    });
    const browser = await chromium.launch({ channel: 'chrome', headless: true });
    try {
      const error = await waitForInstalledPortalSetup(await browser.newPage(), origin, 500)
        .then(() => '', cause => String(cause));
      expect(error).toContain('Portal browser prerequisite failed');
      expect(error).toContain('Checking your portal session');
      expect(error).toContain('fixture hydration failure');
      expect(error).toContain('Private fixture');
      expect(error).toContain('404 /missing-bootstrap.js');
    } finally { await browser.close(); }
  });

  it('serves a compressed upstream document through the real HTTP Portal proxy', async () => {
    const html = '<html><body>Private Portal document</body></html>';
    const wire = gzipSync(html);
    const upstream = await start((req, res) => {
      expect(req.url).toBe('/?app=desktops&ws=private');
      expect(req.headers.cookie).toBe('private-session=fixture');
      res.writeHead(200, { 'content-type': 'text/html', 'content-encoding': 'gzip',
        'content-length': String(wire.length) });
      res.end(wire);
    });
    const proxy = serve({ fetch: installedPortalProxy(upstream), hostname: '127.0.0.1', port: 0 }) as Server;
    await once(proxy, 'listening');
    try {
      const port = (proxy.address() as { port: number }).port;
      const response = await fetch(`http://127.0.0.1:${port}/?app=desktops&ws=private`, {
        headers: { cookie: 'private-session=fixture', 'accept-encoding': 'gzip' },
        signal: AbortSignal.timeout(2000),
      });
      expect(response.headers.get('content-encoding')).toBeNull();
      expect(await response.text()).toBe(html);
    } finally {
      proxy.closeAllConnections();
      await new Promise<void>(resolve => proxy.close(() => resolve()));
    }
  });

  it('executes native TypeScript, extensionless imports, JSON and an ESM TSX dependency', async () => {
    nativeRoot = await mkdtemp(join(tmpdir(), 'installed-native-loader-'));
    await mkdir(join(nativeRoot, 'leaves'));
    await writeFile(join(nativeRoot, 'package.json'), '{}');
    await writeFile(join(nativeRoot, 'leaves/value.ts'), 'export const value: string = "native";');
    await writeFile(join(nativeRoot, 'leaves/widget.tsx'), 'export function Widget() { return <div />; }');
    await writeFile(join(nativeRoot, 'data.json'), '{"answer":42}');
    await writeFile(join(nativeRoot, 'entry.ts'), [
      "import { value } from './leaves/value';", "import data from './data.json';",
      "import { Widget } from './leaves/widget';",
      'enum State { ready = 1 }',
      'if (value !== "native" || data.answer !== 42 || State.ready !== 1) throw new Error("Wrong native result");',
      'if (typeof Widget !== "function") throw new Error("Missing TSX dependency");',
      'console.log("NATIVE_SOURCE_OK");',
    ].join('\n'));
    const repo = fileURLToPath(new URL('../../../..', import.meta.url));
    const audit = join(nativeRoot, 'source-audit.jsonl');
    const result = spawnSync(process.execPath, [...await currentNativeLoader(repo),
      join(nativeRoot, 'entry.ts')], { cwd: nativeRoot, encoding: 'utf8', timeout: 15_000,
      env: { ...process.env, NODE_OPTIONS: '', PAPERCUSP_COMMITTED_SOURCE_AUDIT: audit } });
    expect(result.status, result.stderr || String(result.error)).toBe(0);
    expect(result.stdout).toContain('NATIVE_SOURCE_OK');
    const rows = (await readFile(audit, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    for (const path of ['leaves/value.ts', 'leaves/widget.tsx']) {
      const file = join(nativeRoot, path);
      const sha = createHash('sha256').update(await readFile(file)).digest('hex');
      expect(rows.find(row => row.boundary === 'node-esm-load-return' && row.file === file))
        .toMatchObject({ inputSha256: sha, returnedSha256: sha });
    }
  });

  it('erases type-only imports in the actual identity verifier after the source guard', async () => {
    const repo = fileURLToPath(new URL('../../../..', import.meta.url));
    const args = await currentNativeLoader(repo);
    const file = join(repo, 'packages/operator-core/lib/identity/two-channel-verifier.ts');
    const entry = join(nativeRoot!, 'identity.ts');
    const audit = join(nativeRoot!, 'identity-source-audit.jsonl');
    await writeFile(entry, [
      `import { verifyChannel1 } from ${JSON.stringify(pathToFileURL(file).href)};`,
      'const result = await verifyChannel1({ token: "fixture", claimedGithubUserId: 7,',
      'fetchFn: async () => new Response(JSON.stringify({ id: 7 }), { status: 200 }) });',
      'if (result.kind !== "ok") throw new Error("Identity verifier failed");',
      'console.log("IDENTITY_IMPORT_OK");',
    ].join('\n'));
    const result = spawnSync(process.execPath, [...args, entry], {
      cwd: nativeRoot!, encoding: 'utf8', timeout: 15_000,
      env: { ...process.env, NODE_OPTIONS: '', PAPERCUSP_COMMITTED_SOURCE_AUDIT: audit },
    });
    expect(result.status, result.stderr || String(result.error)).toBe(0);
    expect(result.stdout).toContain('IDENTITY_IMPORT_OK');
    const rows = (await readFile(audit, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    const sha = createHash('sha256').update(await readFile(file)).digest('hex');
    expect(rows.find(row => row.boundary === 'node-esm-load-return' && row.file === file))
      .toMatchObject({ kind: 'committed', inputSha256: sha, returnedSha256: sha });
  });

  it('executes the actual SPA mixed-format boundary with the source guard before the native loader', async () => {
    const repo = fileURLToPath(new URL('../../../..', import.meta.url));
    const args = await currentNativeLoader(repo);
    const audit = join(nativeRoot!, 'spa-source-audit.jsonl');
    await assertInstalledRuntimeLoader(repo, { nodeArgs: args,
      env: { ...process.env, NODE_OPTIONS: '', PAPERCUSP_COMMITTED_SOURCE_AUDIT: audit } });
    const records = (await readFile(audit, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
    const file = join(repo, 'apps/operator/lib/spa-build-status.ts');
    const sha = createHash('sha256').update(await readFile(file)).digest('hex');
    expect(records.find(row => row.boundary === 'node-esm-load-return' && row.file === file))
      .toMatchObject({ kind: 'committed', inputSha256: sha, returnedSha256: sha });
  }, 35_000);

  it('accepts a committed runtime dependency cohort', async () => {
    await vi.mocked(execFileSync).withImplementation(() => Buffer.from('committed'), async () => {
      await vi.mocked(readFile).withImplementation(async () => Buffer.from('committed'), async () => {
        await expect(assertInstalledRuntimeSource('/private/repo')).resolves.toBeUndefined();
      });
    });
  });

  it.each(['packages/operator-core/lib/rubrics.ts',
    'packages/operator-core/lib/agent-tools/scorecards/emit.ts'])(
    'refuses an unpublished import-cohort member before runtime work: %s', async provider => {
      await vi.mocked(execFileSync).withImplementation(() => Buffer.from('committed'), async () => {
        await vi.mocked(readFile).withImplementation(async path =>
          Buffer.from(String(path).endsWith(provider) ? 'unpublished export change' : 'committed'), async () => {
          await expect(assertInstalledRuntimeSource('/private/repo')).rejects.toThrow(provider);
        });
      });
    });

  it('refuses stale, foreign and unidentified Portal artifacts before starting a runtime', () => {
    const digest = 'a'.repeat(64), portal = '/tmp/private-portal', root = '/tmp/releases/build-one';
    const identity = { schemaVersion: 2, buildId: 'build', release: 'build-one', sourceRoot: portal,
      sourceRootDigest: digest, publishedAt: '2026-11-15T00:00:00Z', buildProvenance: { schemaVersion: 1 } };
    expect(validateInstalledPortalRelease(portal, root, identity, digest)).toMatchObject({ releasesDir: '/tmp/releases' });
    for (const patch of [{ schemaVersion: 1 }, { sourceRoot: '/tmp/other-portal' },
      { release: 'another-release' }, { buildId: '' }, { publishedAt: 'invalid' },
      { sourceRootDigest: 'b'.repeat(64) }, { buildProvenance: null }]) {
      expect(() => validateInstalledPortalRelease(portal, root, { ...identity, ...patch }, digest)).toThrow();
    }
  });

  it('refuses fixture owner election outside the wrapper-owned private runtime', () => {
    const env = { PAPERCUSP_WORKSPACE_ID: 'test-runtime-example-installed', PAPERCUSP_SKIP_PG_DISCOVERY: '1',
      PAPERCUSP_BACKGROUND_WORKERS: '0', PAPERCUSP_DBOS_ENABLE: '0', PAPERCUSP_HOME: '/tmp/private-fixture',
      HARNESS_ADMIN_DATABASE_URL: 'postgres://admin@127.0.0.1:12345/private',
      HARNESS_DATABASE_URL: 'postgres://app@127.0.0.1:12345/private', PAPERCUSP_PG_PORT: '12345', PAPERCUSP_HONO_PORT: '12346' };
    expect(installedHostFixtureScope(env)).toMatchObject({ workspaceId: env.PAPERCUSP_WORKSPACE_ID });
    for (const patch of [{ PAPERCUSP_WORKSPACE_ID: 'papercusp-workspace' }, { PAPERCUSP_BACKGROUND_WORKERS: '1' },
      { HARNESS_ADMIN_DATABASE_URL: 'postgres://admin@example.invalid:12345/private' },
      { HARNESS_DATABASE_URL: 'postgres://app@127.0.0.1:12345/another' }, { PAPERCUSP_HONO_PORT: '0' }]) {
      expect(() => installedHostFixtureScope({ ...env, ...patch })).toThrow();
    }
  });

  it('rejects unavailable real media binaries before starting private runtime work', async () => {
    await expect(installedDesktopBinaries(import.meta.dirname)).rejects.toThrow('ENOENT');
  });

  it('rejects a missing external checkout before starting runtime work', async () => {
    await expect(installedPortalSource(undefined)).rejects.toThrow('portal-source-root');
    await expect(installedPortalSource(import.meta.dirname)).rejects.toThrow('ENOENT');
  });

  it('waits for the complete root document even when health is already green', async () => {
    let completed = false;
    const origin = await start((req, res) => {
      if (req.url === '/api/health') { res.end('{"ok":true}'); return; }
      res.writeHead(200, { 'content-type': 'text/html' }); res.write('<html>');
      setTimeout(() => { completed = true; res.end('<body>Portal</body></html>'); }, 80);
    });
    expect((await fetch(`${origin}/api/health`)).ok).toBe(true);
    expect(completed).toBe(false);
    await expect(waitForPortalDocument(child!, `${origin}/?app=desktops`, 2000)).resolves.toMatchObject({ status: 200 });
    expect(completed).toBe(true);
  });

  it('rejects a nonexistent entry rather than accepting a healthy API', async () => {
    const origin = await start((_, res) => { res.writeHead(404); res.end('missing page'); });
    await expect(waitForPortalDocument(child!, `${origin}/desktops`, 2000)).rejects.toThrow('Portal document HTTP 404');
  });

  it('fails on child exit while a document request is pending', async () => {
    const origin = await start(() => { child!.kill(); });
    await expect(waitForPortalDocument(child!, origin, 5000)).rejects.toThrow('Private Next exited');
  });
});
