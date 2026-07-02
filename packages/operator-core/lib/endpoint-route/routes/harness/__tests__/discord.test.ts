/**
 * discord.test.ts — GET/PUT /api/harness/:slug/discord.
 *
 * Route-shaped (defineTool). All side effects mocked: the harness registry
 * (path resolution), project-files (config read/write), node:fs existsSync
 * (the `.papercusp/shared.json` shared check), and global fetch (the Discord
 * widget probe). No real FS, PG, or network.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RouteContext } from '@papercusp/tooldef';

const H = vi.hoisted(() => {
  const state: { shared: boolean; config: string | null; projects: Array<{ slug: string; path: string }> } = {
    shared: true,
    config: null,
    projects: [{ slug: 'shared-harness', path: '/repo/shared' }],
  };
  return {
    state,
    existsSync: vi.fn(() => state.shared),
    loadHarnessRegistry: vi.fn(async () => ({ projects: state.projects })),
    loadProjectFiles: vi.fn(async () => ({ config: state.config })),
    saveProjectFiles: vi.fn(async (..._args: unknown[]) => {}),
    fetchMock: vi.fn(),
  };
});

vi.mock('node:fs', async (orig) => ({ ...(await orig<typeof import('node:fs')>()), existsSync: H.existsSync }));
vi.mock('../../../../harness-registry', () => ({ loadHarnessRegistry: H.loadHarnessRegistry }));
vi.mock('../../../../harness-project-files', () => ({ loadProjectFiles: H.loadProjectFiles, saveProjectFiles: H.saveProjectFiles }));

import routes from '../discord';

const [getDiscord, putDiscord] = routes;

function ctx(slug: string): RouteContext {
  return { principal: null, input: undefined, params: { slug }, log: () => {}, signal: new AbortController().signal } as RouteContext;
}
const getReq = () => new Request('http://localhost/api/harness/x/discord');
const putReq = (body: unknown) =>
  new Request('http://localhost/api/harness/x/discord', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

beforeEach(() => {
  H.state.shared = true;
  H.state.config = null;
  H.state.projects = [{ slug: 'shared-harness', path: '/repo/shared' }];
  H.saveProjectFiles.mockClear();
  H.fetchMock.mockReset();
  vi.stubGlobal('fetch', H.fetchMock);
  // Clear the per-process widget cache between tests.
  (globalThis as Record<symbol, unknown>)[Symbol.for('papercusp.discordWidgetCache')] = undefined;
});

describe('GET /harness/:slug/discord', () => {
  it('404 for an unknown harness slug', async () => {
    const res = await getDiscord.handler(getReq(), ctx('does-not-exist'));
    expect(res.status).toBe(404);
  });

  it('returns isShared + parsed discord config + live widget data', async () => {
    H.state.config = JSON.stringify({ discord: { guildId: '12345', inviteUrl: 'https://discord.gg/x' } });
    H.fetchMock.mockResolvedValue(new Response(JSON.stringify({ presence_count: 7, name: 'My Guild' }), { status: 200 }));
    const res = await getDiscord.handler(getReq(), ctx('shared-harness'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.isShared).toBe(true);
    expect(body.discord).toEqual({ guildId: '12345', inviteUrl: 'https://discord.gg/x' });
    expect(body.widget).toEqual({ presenceCount: 7, name: 'My Guild' });
  });

  it('no discord config → null discord + no widget fetch', async () => {
    H.state.config = JSON.stringify({ other: true });
    const res = await getDiscord.handler(getReq(), ctx('shared-harness'));
    const body = await res.json();
    expect(body.discord).toBeNull();
    expect(body.widget).toBeNull();
    expect(H.fetchMock).not.toHaveBeenCalled();
  });

  it('a failed widget fetch degrades to null counts (does not throw)', async () => {
    H.state.config = JSON.stringify({ discord: { guildId: '999', inviteUrl: '' } });
    H.fetchMock.mockResolvedValue(new Response('nope', { status: 404 }));
    const body = await (await getDiscord.handler(getReq(), ctx('shared-harness'))).json();
    expect(body.widget).toEqual({ presenceCount: null, name: null });
  });
});

describe('PUT /harness/:slug/discord', () => {
  it('404 for an unknown harness', async () => {
    const res = await putDiscord.handler(putReq({ guildId: '1' }), ctx('nope'));
    expect(res.status).toBe(404);
  });

  it('400 when the harness is not shared', async () => {
    H.state.shared = false;
    const res = await putDiscord.handler(putReq({ guildId: '12345' }), ctx('shared-harness'));
    expect(res.status).toBe(400);
  });

  it('400 when guildId is missing or not a numeric snowflake', async () => {
    expect((await putDiscord.handler(putReq({ inviteUrl: 'x' }), ctx('shared-harness'))).status).toBe(400);
    expect((await putDiscord.handler(putReq({ guildId: 'abc' }), ctx('shared-harness'))).status).toBe(400);
  });

  it('saves a valid config to project-files and returns ok', async () => {
    const res = await putDiscord.handler(putReq({ guildId: '12345', inviteUrl: 'https://discord.gg/y' }), ctx('shared-harness'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.discord).toEqual({ guildId: '12345', inviteUrl: 'https://discord.gg/y' });
    expect(H.saveProjectFiles).toHaveBeenCalledTimes(1);
    const [, files] = H.saveProjectFiles.mock.calls[0];
    expect(JSON.parse((files as { config: string }).config).discord).toEqual({ guildId: '12345', inviteUrl: 'https://discord.gg/y' });
  });
});
