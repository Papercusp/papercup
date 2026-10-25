import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { expect, it, vi } from 'vitest';
import { createDesktopPortalLifecycle } from './desktop-portal-lifecycle';

// Explicit artifact profile: compile with desktop-portal-candidate.ts first.
// This opens only a newly initialized, test-owned PostgreSQL cluster. It uses
// the ordinary test config because it needs none of the shared baseline schema.
const manifest = process.env.PAPERCUSP_DESKTOP_CANDIDATE_MANIFEST;
const run = promisify(execFile);
const native = process.env.PAPERCUSP_TEST_DESKTOP_NATIVE === '1';
const nativeTimeoutMs = 30 * 60_000;
const testTimeoutMs = nativeTimeoutMs + 60_000;

it.skipIf(!manifest)('retains the actual private desktop portal preferences across host and PostgreSQL restart', async () => {
  if (native && Number(process.env.PAPERCUSP_TEST_FILE_TIMEOUT_MS ?? 600_000) < testTimeoutMs + 120_000) {
    throw new Error(`Native profile requires PAPERCUSP_TEST_FILE_TIMEOUT_MS>=${testTimeoutMs + 120_000}; refusing before PostgreSQL or dependency copying`);
  }
  const directory = dirname(manifest!);
  const receipt = JSON.parse(await readFile(manifest!, 'utf8'));
  expect(receipt.schemaVersion).toBe('desktop-portal-private-candidate-v1');
  for (const path of ['desktop-portal.cjs', 'spa/index.html', 'spa/wordmark.svg']) {
    const bytes = await readFile(join(directory, path));
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(
      receipt.files.find((file: { path: string }) => file.path === path)?.sha256,
    );
  }
  expect(await readFile(join(directory, 'spa/index.html'), 'utf8')).toContain('content="portal-candidate"');

  const repo = fileURLToPath(new URL('../../../', import.meta.url));
  const launcher = join(repo, 'apps/operator/scripts/ptool.mjs');
  if (native) {
    // The native rig changes cwd during preparation. Check its explicit
    // launcher before initializing PostgreSQL or copying the operator tree.
    expect((await readFile(launcher)).byteLength).toBeGreaterThan(0);
    const { stdout } = await run('ptool', ['coord:whoami', '--json', '{}'], {
      cwd: tmpdir(), timeout: 45_000,
      env: { ...process.env, PAPERCUSP_PTOOL_LAUNCHER: launcher },
    });
    expect(JSON.parse(stdout).ownerId).toBeTruthy();
  }

  const root = await mkdtemp(join(tmpdir(), 'desktop-portal-persistent-'));
  const data = join(root, 'data');
  const socket = join(root, 'socket');
  await mkdir(socket);
  const pg = process.env.PAPERCUSP_TEST_PG_BIN ?? '/usr/lib/postgresql/18/bin';
  const listener = createServer();
  await new Promise<void>(resolve => listener.listen(0, '127.0.0.1', resolve));
  const port = (listener.address() as { port: number }).port;
  await new Promise<void>((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
  let running = false;
  let host: ReturnType<typeof createDesktopPortalLifecycle> | undefined;
  const upstream: string[] = [];
  const operator = async (request: Request) => {
    upstream.push(new URL(request.url).pathname);
    return Response.json({ ok: true, source: 'test-inner-operator' });
  };
  const start = async () => {
    await run(join(pg, 'pg_ctl'), ['-D', data, '-l', join(root, 'postgres.log'), '-w', 'start',
      '-o', `-h 127.0.0.1 -p ${port} -k ${socket}`], { timeout: 20_000 });
    running = true;
  };
  const stop = async () => {
    await run(join(pg, 'pg_ctl'), ['-D', data, '-m', 'fast', '-w', 'stop'], { timeout: 20_000 });
    running = false;
  };
  const request = (path: string, init?: RequestInit) => host!.fetch(new Request(`http://localhost:21696${path}`, init));
  try {
    await run(join(pg, 'initdb'), ['-D', data, '--auth=trust', '--username=desktop_candidate', '--no-locale', '--encoding=UTF8'], { timeout: 20_000 });
    await start();
    vi.stubEnv('PORTAL_DATABASE_URL', `postgres://desktop_candidate@127.0.0.1:${port}/postgres`);
    vi.stubEnv('PORTAL_USE_MEMORY_STORE', '0');
    vi.stubEnv('PORTAL_PLATFORM_INVOKE_URL', '');
    vi.stubEnv('PAPERCUSP_DESKTOP_INTERFACE', 'portal-candidate');
    vi.stubEnv('PAPERCUSP_DESKTOP_PORTAL_HOST_BUNDLE', join(directory, 'desktop-portal.cjs'));
    host = createDesktopPortalLifecycle({ operator });
    const apps = await (await request('/api/apps')).json();
    expect(apps.ok).toBe(true);
    expect(apps.apps.some((app: { slug: string }) => app.slug === 'home')).toBe(true);
    const write = await request('/api/preferences', { method: 'PUT', headers: {
      origin: 'http://tauri.localhost', 'content-type': 'application/json',
    }, body: JSON.stringify({ theme: 'dark' }) });
    expect(write.status).toBe(200);
    expect(upstream).toEqual([]);
    await host.stop();
    await stop();
    await start();
    host = createDesktopPortalLifecycle({ operator });
    const preferences = await (await request('/api/preferences')).json();
    expect(preferences.preferences.theme).toBe('dark');
    expect(upstream).toEqual([]);
    expect((await request('/api/preferences', { headers: { origin: 'https://foreign.example' } })).status).toBe(403);
    expect((await (await request('/api/health')).json()).source).toBe('test-inner-operator');
    expect(upstream).toEqual(['/api/health']);
    if (native) {
      // Reuse the maintained native rig. Its full operator gets its own
      // isolated DB; portal state remains in this separately owned cluster.
      // The focused test router moves workers into a separate systemd scope;
      // an outer MemoryMax does not cover it. Bound the actual native child.
      const child = execFile('systemd-run', ['--user', '--scope', '--quiet', '-p', 'MemoryMax=16G',
        'bash', join(repo, 'scripts/verify-tauri-headless.sh'), '--',
        process.execPath, join(repo, 'scripts/test-files.mjs'),
        join(repo, 'apps/operator/bin/desktop-portal-native.test.ts')], {
        cwd: repo, timeout: nativeTimeoutMs, maxBuffer: 8 * 1024 * 1024,
        env: { ...process.env, VERIFY_TAURI_ISOLATED_DB: '1', VERIFY_TAURI_ISOLATED_SEED: 'ready',
          PAPERCUSP_SHARED_SPA_DIST: join(directory, 'spa'),
          PAPERCUSP_TEST_RUN_HARNESS: 'papercusp',
          PAPERCUSP_PTOOL_LAUNCHER: launcher,
          PAPERCUSP_TASK_DEADLINE_EPOCH_MS: String(Math.min(
            Number(process.env.PAPERCUSP_TASK_DEADLINE_EPOCH_MS) || Infinity,
            Date.now() + nativeTimeoutMs,
          )),
          VERIFY_TAURI_ASSERT_ESTIMATE_MS: '180000',
        },
      });
      child.stdout?.on('data', data => process.stdout.write(data));
      child.stderr?.on('data', data => process.stderr.write(data));
      await new Promise<void>((resolve, reject) => child.once('error', reject).once('exit', code => {
        if (code === 0) resolve(); else reject(new Error(`Native candidate verifier exited ${code}`));
      }));
    }
  } finally {
    await host?.stop();
    if (running) await stop();
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  }
}, native ? testTimeoutMs : 60_000);
