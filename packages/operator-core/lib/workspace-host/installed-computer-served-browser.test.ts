import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { createServer, type RequestListener, type Server } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { assertInstalledRuntimeSource, installedDesktopBinaries, installedHostFixtureScope, installedPortalSource, validateInstalledPortalRelease, waitForPortalDocument } from './installed-computer-served-browser.fixture';

vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, execFileSync: vi.fn(actual.execFileSync) };
});
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, readFile: vi.fn(actual.readFile) };
});

let child: ChildProcess | undefined, server: Server | undefined;
afterEach(async () => {
  if (child && child.exitCode === null && child.signalCode === null) {
    const exited = once(child, 'exit'); child.kill(); await exited;
  }
  server?.closeAllConnections();
  if (server) await new Promise<void>(resolve => server!.close(() => resolve()));
});

async function start(handler: RequestListener) {
  child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)']);
  await once(child, 'spawn');
  server = createServer(handler);
  await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

describe('served Portal prerequisite and document readiness', () => {
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
