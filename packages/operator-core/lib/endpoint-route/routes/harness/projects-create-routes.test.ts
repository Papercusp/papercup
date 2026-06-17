/**
 * projects-create-routes.test.ts — the error→HTTP status maps for the two
 * mutating "create a hive" HTTP routes in projects.ts (the CreateHarnessPicker's
 * new-hive + GitHub-URL entry points). Following the join-invite.test.ts
 * template: inject the side-effecting composition (createHive* mocked) and
 * assert each {ok:false,error} variant lands on the documented status, plus the
 * malformed-body fast-fails before any side effect.
 *
 *   Gap 7 — POST /harness/hives/from-repo (createHiveFromRepoRoute, :470-540):
 *     invalid_url|invalid_slug→400, hive_not_found→404, slug_exhausted/
 *     clone_dest_exists*→409, clone_auth_required→401, clone_not_found→404,
 *     else→502; malformed body (no githubUrl)→400 invalid_url; bogus visibility
 *     coerced to 'public'.
 *   Gap 8 — POST /harness/hives (createHive, :423-461): invalid slug→400
 *     invalid_slug, slug_exists/dest_exists→409, other error→400.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// The routes dynamic-import these inside the handler — mock the modules so the
// composition never runs (no clone, no PG, no registry mutation).
const createHiveFromRepo = vi.fn();
const createHiveHarness = vi.fn();

vi.mock('../../../agent-tools/hive/_create_from_repo', () => ({
  createHiveFromRepo: (...a: unknown[]) => createHiveFromRepo(...a),
}));
vi.mock('../../../agent-tools/hive/_create', () => ({
  createHiveHarness: (...a: unknown[]) => createHiveHarness(...a),
}));
vi.mock('../../../workspace-registry', () => ({
  activeWorkspaceId: () => 'ws-test',
}));
vi.mock('../../../harness/projects-lite', () => ({
  bustProjectsLiteCache: vi.fn(),
  buildProjectsLitePayload: vi.fn(async () => ({ projects: [] })),
}));

import routes from './projects';

const byPath = (path: string) => {
  const r = (routes as Array<{ path: string }>).find((x) => x.path === path);
  if (!r) throw new Error(`no route for ${path}`);
  return r as unknown as { path: string; auth?: string; handler: (req: Request, ctx: unknown) => Promise<Response> };
};

const fromRepoRoute = byPath('/harness/hives/from-repo');
const createHiveRoute = byPath('/harness/hives');

async function post(
  route: { path: string; handler: (req: Request, ctx: unknown) => Promise<Response> },
  body: unknown,
  { raw }: { raw?: string } = {},
) {
  const req = new Request('http://127.0.0.1/api' + route.path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: raw !== undefined ? raw : JSON.stringify(body),
  });
  const res = await route.handler(req, {});
  return { status: res.status, body: (await res.json().catch(() => null)) as Record<string, unknown> | null };
}

beforeEach(() => {
  createHiveFromRepo.mockReset();
  createHiveHarness.mockReset();
});

// ── Gap 7: POST /harness/hives/from-repo status map ──────────────────────────
describe('POST /api/harness/hives/from-repo — error→status map (Gap 7)', () => {
  it('declares the loopback auth tier (mutating route, Wave 1)', () => {
    expect(fromRepoRoute.auth).toBe('loopback');
  });

  it.each([
    ['invalid_url', 400],
    ['invalid_slug', 400],
    ['hive_not_found', 404],
    ['slug_exhausted', 409],
    ['clone_dest_exists', 409],
    ['clone_dest_exists: /tmp/x already exists', 409], // startsWith match
    ['clone_auth_required', 401],
    ['clone_not_found', 404],
    ['clone_git_missing', 502], // unmapped clone_* → fallthrough 502
    ['something_unexpected', 502],
  ])('maps error %s → HTTP %i', async (error, status) => {
    createHiveFromRepo.mockResolvedValue({ ok: false, error, message: `msg:${error}` });
    const { status: got, body } = await post(fromRepoRoute, { githubUrl: 'https://github.com/o/r' });
    expect(got).toBe(status);
    expect(body).toMatchObject({ code: error });
    expect(createHiveFromRepo).toHaveBeenCalledTimes(1);
  });

  it('passes res.cleanup through on a failure that carries it', async () => {
    createHiveFromRepo.mockResolvedValue({ ok: false, error: 'something', message: 'm', cleanup: ['/tmp/a'] });
    const { body } = await post(fromRepoRoute, { githubUrl: 'https://github.com/o/r' });
    expect(body).toMatchObject({ cleanup: ['/tmp/a'] });
  });

  it('falls back to res.error as the message when message is absent', async () => {
    createHiveFromRepo.mockResolvedValue({ ok: false, error: 'invalid_url' });
    const { status, body } = await post(fromRepoRoute, { githubUrl: 'https://github.com/o/r' });
    expect(status).toBe(400);
    expect(body).toMatchObject({ error: 'invalid_url', code: 'invalid_url' });
  });

  it('400s invalid_url for a missing githubUrl WITHOUT touching the composition', async () => {
    const { status, body } = await post(fromRepoRoute, {});
    expect(status).toBe(400);
    expect(body).toMatchObject({ code: 'invalid_url' });
    expect(createHiveFromRepo).not.toHaveBeenCalled();
  });

  it('400s invalid_url for a malformed (non-JSON) body without touching the composition', async () => {
    const { status, body } = await post(fromRepoRoute, undefined, { raw: 'not json{' });
    expect(status).toBe(400);
    expect(body).toMatchObject({ code: 'invalid_url' });
    expect(createHiveFromRepo).not.toHaveBeenCalled();
  });

  it('coerces a bogus visibility to "public" (only public|invite|private pass through)', async () => {
    createHiveFromRepo.mockResolvedValue({ ok: true, created: { hiveSlug: 'r', memberSlug: 'r', memberPath: '/p' } });
    await post(fromRepoRoute, { githubUrl: 'https://github.com/o/r', visibility: 'bogus' });
    expect(createHiveFromRepo).toHaveBeenCalledTimes(1);
    expect(createHiveFromRepo.mock.calls[0][0]).toMatchObject({ visibility: 'public' });
  });

  it.each(['private', 'invite', 'public'])('passes a valid visibility %s through verbatim', async (vis) => {
    createHiveFromRepo.mockResolvedValue({ ok: true, created: { hiveSlug: 'r', memberSlug: 'r', memberPath: '/p' } });
    await post(fromRepoRoute, { githubUrl: 'https://github.com/o/r', visibility: vis });
    expect(createHiveFromRepo.mock.calls[0][0]).toMatchObject({ visibility: vis });
  });

  it('returns the success envelope (200) on ok', async () => {
    const created = { ok: true, created: { hiveSlug: 'repo', memberSlug: 'repo', memberPath: '/p' } };
    createHiveFromRepo.mockResolvedValue(created);
    const { status, body } = await post(fromRepoRoute, { githubUrl: 'https://github.com/o/repo' });
    expect(status).toBe(200);
    expect(body).toMatchObject({ ok: true });
  });
});

// ── Gap 8: POST /harness/hives status map ────────────────────────────────────
describe('POST /api/harness/hives — createHive error→status map (Gap 8)', () => {
  it('declares the loopback auth tier', () => {
    expect(createHiveRoute.auth).toBe('loopback');
  });

  it.each([
    ['', 'empty slug'],
    ['Bad_Slug', 'uppercase/underscore'],
    ['-leading', 'leading dash'],
    ['has space', 'whitespace'],
  ])('400s invalid_slug for %s (%s) WITHOUT touching createHiveHarness', async (slug) => {
    const { status, body } = await post(createHiveRoute, { slug });
    expect(status).toBe(400);
    expect(body).toMatchObject({ code: 'invalid_slug' });
    expect(createHiveHarness).not.toHaveBeenCalled();
  });

  it('400s invalid_slug for a malformed (non-JSON) body', async () => {
    const { status, body } = await post(createHiveRoute, undefined, { raw: '{bad' });
    expect(status).toBe(400);
    expect(body).toMatchObject({ code: 'invalid_slug' });
    expect(createHiveHarness).not.toHaveBeenCalled();
  });

  it.each([
    ['slug_exists', 409],
    ['dest_exists', 409],
    ['blueprint_invalid', 400],
    ['not_a_hive_blueprint', 400],
    ['create_failed', 400],
  ])('maps createHive error %s → HTTP %i', async (error, status) => {
    createHiveHarness.mockResolvedValue({ ok: false, error, message: `m:${error}` });
    const { status: got, body } = await post(createHiveRoute, { slug: 'good-slug' });
    expect(got).toBe(status);
    expect(body).toMatchObject({ code: error });
    expect(createHiveHarness).toHaveBeenCalledTimes(1);
  });

  it('returns the success envelope (200) with hive:true on ok', async () => {
    createHiveHarness.mockResolvedValue({ ok: true, slug: 'good-slug', path: '/p', waked: false });
    const { status, body } = await post(createHiveRoute, { slug: 'good-slug' });
    expect(status).toBe(200);
    expect(body).toMatchObject({ ok: true, hive: true, project: { slug: 'good-slug', path: '/p' } });
  });
});
