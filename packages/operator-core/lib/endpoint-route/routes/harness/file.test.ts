import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { loadHarnessRegistry } = vi.hoisted(() => ({
  loadHarnessRegistry: vi.fn(),
}));

vi.mock('../../../harness-registry', () => ({ loadHarnessRegistry }));

import routes from './file';

type Route = {
  method: string;
  path: string;
  handler: (request: Request, ctx: { params: Record<string, string> }) => Promise<Response>;
};

const routeSet = routes as Route[];
const getRoute = routeSet.find((route) => route.method === 'GET')!;
const putRoute = routeSet.find((route) => route.method === 'PUT')!;

const projectSlug = 'test-harness';
const roots: string[] = [];

async function makeProject(configFiles: unknown[], files: Record<string, string> = {}) {
  const project = await mkdtemp(join(tmpdir(), 'papercusp-file-route-'));
  roots.push(project);
  await mkdir(join(project, '.papercusp'));
  await writeFile(
    join(project, '.papercusp', 'papercusp.json'),
    JSON.stringify({ configFiles }),
  );
  await Promise.all(
    Object.entries(files).map(async ([path, content]) => {
      const destination = join(project, path);
      await mkdir(join(destination, '..'), { recursive: true });
      await writeFile(destination, content);
    }),
  );
  loadHarnessRegistry.mockResolvedValue({ projects: [{ slug: projectSlug, path: project }] });
  return project;
}

function context() {
  return { params: { slug: projectSlug } };
}

async function get(path: string) {
  const response = await getRoute.handler(
    new Request(`http://127.0.0.1/api/harness/${projectSlug}/file?path=${encodeURIComponent(path)}`),
    context(),
  );
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}

async function put(path: string, content: string) {
  const response = await putRoute.handler(
    new Request(`http://127.0.0.1/api/harness/${projectSlug}/file`, {
      method: 'PUT',
      body: JSON.stringify({ path, content }),
      headers: { 'content-type': 'application/json' },
    }),
    context(),
  );
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}

describe('GET/PUT /harness/:slug/file', () => {
  beforeEach(() => {
    loadHarnessRegistry.mockReset();
  });

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it('reads and writes an allowlisted file inside the project root', async () => {
    const project = await makeProject([{ path: 'config.json' }], { 'config.json': 'before' });

    await expect(get('config.json')).resolves.toMatchObject({
      status: 200,
      body: { path: 'config.json', content: 'before', exists: true },
    });
    await expect(put('config.json', 'after')).resolves.toMatchObject({
      status: 200,
      body: { ok: true, path: 'config.json', bytes: 5 },
    });
    await expect(readFile(join(project, 'config.json'), 'utf8')).resolves.toBe('after');
  });

  it('preserves an allowlisted final symlink whose target remains inside the project', async () => {
    const project = await makeProject([{ path: 'config.json' }], { 'actual.json': 'before' });
    await symlink('actual.json', join(project, 'config.json'));

    await expect(get('config.json')).resolves.toMatchObject({
      status: 200,
      body: { content: 'before', exists: true },
    });
    await expect(put('config.json', 'after')).resolves.toMatchObject({
      status: 200,
      body: { ok: true, path: 'config.json' },
    });
    await expect(readFile(join(project, 'actual.json'), 'utf8')).resolves.toBe('after');
  });

  it('rejects a final symlink whose target escapes the project root', async () => {
    const project = await makeProject([{ path: 'config.json' }]);
    const outsideRoot = await mkdtemp(join(tmpdir(), 'papercusp-outside-'));
    roots.push(outsideRoot);
    await writeFile(join(outsideRoot, 'config.json'), 'secret');
    await symlink(join(outsideRoot, 'config.json'), join(project, 'config.json'));

    await expect(get('config.json')).resolves.toMatchObject({
      status: 403,
      body: { error: 'path_escape' },
    });
    await expect(put('config.json', 'changed')).resolves.toMatchObject({
      status: 403,
      body: { error: 'path_escape' },
    });
    await expect(readFile(join(outsideRoot, 'config.json'), 'utf8')).resolves.toBe('secret');
  });

  it('rejects a parent symlink whose target escapes the project root', async () => {
    const project = await makeProject([{ path: 'nested/config.json' }]);
    const outsideRoot = await mkdtemp(join(tmpdir(), 'papercusp-outside-'));
    roots.push(outsideRoot);
    await writeFile(join(outsideRoot, 'config.json'), 'secret');
    await symlink(outsideRoot, join(project, 'nested'));

    await expect(get('nested/config.json')).resolves.toMatchObject({
      status: 403,
      body: { error: 'path_escape' },
    });
    await expect(put('nested/config.json', 'changed')).resolves.toMatchObject({
      status: 403,
      body: { error: 'path_escape' },
    });
    await expect(readFile(join(outsideRoot, 'config.json'), 'utf8')).resolves.toBe('secret');
  });

  it('allows a parent symlink that resolves inside the project root', async () => {
    const project = await makeProject([{ path: 'nested/config.json' }], { 'actual/config.json': 'before' });
    await symlink('actual', join(project, 'nested'));

    await expect(get('nested/config.json')).resolves.toMatchObject({
      status: 200,
      body: { content: 'before', exists: true },
    });
    await expect(put('nested/config.json', 'after')).resolves.toMatchObject({
      status: 200,
      body: { ok: true, path: 'nested/config.json' },
    });
    await expect(readFile(join(project, 'actual', 'config.json'), 'utf8')).resolves.toBe('after');
  });

  it('uses an explicit manifest root grant for deliberately shared config', async () => {
    const sharedRoot = await mkdtemp(join(tmpdir(), 'papercusp-shared-'));
    roots.push(sharedRoot);
    await writeFile(join(sharedRoot, 'settings.json'), 'before');
    await makeProject([{ path: 'settings.json', root: sharedRoot }]);

    await expect(get('settings.json')).resolves.toMatchObject({
      status: 200,
      body: { content: 'before', exists: true },
    });
    await expect(put('settings.json', 'after')).resolves.toMatchObject({
      status: 200,
      body: { ok: true, path: 'settings.json' },
    });
    await expect(readFile(join(sharedRoot, 'settings.json'), 'utf8')).resolves.toBe('after');
  });
});
