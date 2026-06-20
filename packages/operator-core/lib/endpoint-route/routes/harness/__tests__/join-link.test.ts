/**
 * join-link.test.ts — unit tests for handleJoinLink (D-004).
 *
 * All deps injected: no fs / registry / gh CLI.
 * Tests cover:
 *   - gh authed → resolves identity server-side, calls joinHarness with correct
 *     { token, githubUserId, githubLogin, keychainId }; returns 200 { ok, state }
 *   - gh NOT authed → 401 { code: 'gh_auth_required' }; joinHarness NOT called
 *   - slug conflict → 409 { code: 'slug_conflict' }
 *   - invalid / missing harnessLinkUrl → 400 { code: 'invalid_link' } (via handler)
 *   - EI-382: seeds the joined clone's git-sync routine (joiner-side, salted
 *     cron, github coords from the link); skipped when no cloneDir; best-effort
 */

import { describe, it, expect, vi } from 'vitest';
import { handleJoinLink, type JoinLinkDeps, type JoinLinkInput } from '../join-link';
import type { LocalGithubIdentity } from '../../../../identity/resolve-local-github-identity';
import type { JoinState } from '../../../../harness/join-shared-harness';
import type { HarnessLink } from '../../../../harness/url-scheme';

// ─── fixtures ─────────────────────────────────────────────────────────────────

const VALID_LINK: HarnessLink = {
  topic: 'a'.repeat(64),
  github: 'Papercusp/papercup',
  repoOwner: 'Papercusp',
  repoName: 'papercup',
  repoId: 12345,
};

const GH_OK: LocalGithubIdentity = {
  kind: 'ok',
  token: 'ghs_test_token',
  githubUserId: 99,
  githubLogin: 'testuser',
};

const GH_UNAUTHED: LocalGithubIdentity = { kind: 'gh_auth_required' };

const FAKE_STATE: JoinState = {
  slug: 'my-harness',
  linkTopic: VALID_LINK.topic,
  startedAt: 1_700_000_000_000,
  steps: {} as JoinState['steps'],
  cloneDir: '/tmp/my-harness',
};

function makeDeps(overrides: Partial<JoinLinkDeps> = {}): JoinLinkDeps {
  return {
    resolveIdentity: vi.fn(async () => GH_OK),
    loadRegistry: vi.fn(async () => ({ projects: [] })),
    saveRegistry: vi.fn(async () => {}),
    joinHarness: vi.fn(async () => FAKE_STATE),
    scaffold: vi.fn(async () => {}),
    seedGitSync: vi.fn(async () => ({
      seeded: true as const,
      active: true,
      push: false,
      pushReason: 'joiner_side',
      cron: '0 0,10,20,30,40,50 * * * *',
    })),
    resolveWorkspaceId: vi.fn(() => 'ws-test'),
    ...overrides,
  };
}

const VALID_INPUT: JoinLinkInput = {
  slug: 'my-harness',
  link: VALID_LINK,
};

// ─── tests ────────────────────────────────────────────────────────────────────

describe('handleJoinLink', () => {
  it('resolves identity server-side, calls joinHarness with token/userId/login/keychainId, returns 200', async () => {
    const deps = makeDeps();
    const res = await handleJoinLink(VALID_INPUT, deps);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.state).toEqual(FAKE_STATE);

    // identity resolved without any body creds
    expect(deps.resolveIdentity).toHaveBeenCalledTimes(1);

    // joinHarness called with resolved token/userId/login + derived keychainId
    expect(deps.joinHarness).toHaveBeenCalledTimes(1);
    const callArg = (deps.joinHarness as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(callArg.token).toBe(GH_OK.token);
    expect(callArg.githubUserId).toBe(GH_OK.githubUserId);
    expect(callArg.githubLogin).toBe(GH_OK.githubLogin);
    // keychainId is derived from githubUserId — just check it's a non-empty string
    // containing the userId so we know it's the right derived value
    expect(typeof callArg.keychainId).toBe('string');
    expect(callArg.keychainId).toContain(String(GH_OK.githubUserId));
    expect(callArg.slug).toBe('my-harness');
    expect(callArg.link).toBe(VALID_LINK);
  });

  it('passes existingGistId when provided', async () => {
    const deps = makeDeps();
    const res = await handleJoinLink({ ...VALID_INPUT, existingGistId: 'gist_abc' }, deps);
    expect(res.status).toBe(200);
    const callArg = (deps.joinHarness as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(callArg.existingGistId).toBe('gist_abc');
  });

  it('returns 401 gh_auth_required when gh is not authed; joinHarness NOT called', async () => {
    const deps = makeDeps({
      resolveIdentity: vi.fn(async () => GH_UNAUTHED),
    });
    const res = await handleJoinLink(VALID_INPUT, deps);

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.code).toBe('gh_auth_required');
    expect(body.error).toMatch(/GitHub authentication required/i);

    expect(deps.joinHarness).not.toHaveBeenCalled();
  });

  it('returns 409 slug_conflict when slug already exists; joinHarness NOT called', async () => {
    const deps = makeDeps({
      loadRegistry: vi.fn(async () => ({
        projects: [{ slug: 'my-harness', path: '/some/path' }],
      })),
    });
    const res = await handleJoinLink(VALID_INPUT, deps);

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe('slug_conflict');
    expect(deps.joinHarness).not.toHaveBeenCalled();
  });

  it('returns 502 on JoinStepError', async () => {
    const { JoinStepError } = await import('../../../../harness/join-shared-harness');
    const deps = makeDeps({
      joinHarness: vi.fn(async () => {
        throw new JoinStepError('oauth_attest', 'GIST_CREATE_FAILED', 'could not create gist');
      }),
    });
    const res = await handleJoinLink(VALID_INPUT, deps);

    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.code).toBe('GIST_CREATE_FAILED');
    expect(body.stepId).toBe('oauth_attest');
  });

  it('registers harness and scaffolds when cloneDir is set', async () => {
    const deps = makeDeps();
    await handleJoinLink(VALID_INPUT, deps);

    expect(deps.saveRegistry).toHaveBeenCalledTimes(1);
    const saved = (deps.saveRegistry as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    // EI-1623: the link-join clone is registered as a self-describing JOINER member
    // (upstream coords + `joined_via_link`), so the boot git-sync reconcile can
    // backfill its routine joiner-side if the best-effort join-time seed fails.
    expect(saved.projects).toContainEqual({
      slug: 'my-harness',
      path: '/tmp/my-harness',
      github_remote: 'https://github.com/Papercusp/papercup',
      github_repository_id: 12345,
      joined_via_link: true,
    });
    expect(deps.scaffold).toHaveBeenCalledWith('my-harness');
  });

  it('does NOT register harness when cloneDir is missing', async () => {
    const stateNoClone: JoinState = { ...FAKE_STATE, cloneDir: undefined };
    const deps = makeDeps({
      joinHarness: vi.fn(async () => stateNoClone),
    });
    await handleJoinLink(VALID_INPUT, deps);

    expect(deps.saveRegistry).not.toHaveBeenCalled();
    expect(deps.scaffold).not.toHaveBeenCalled();
  });

  it('swallows scaffold errors — still returns 200', async () => {
    const deps = makeDeps({
      scaffold: vi.fn(async () => {
        throw new Error('scaffold boom');
      }),
    });
    const res = await handleJoinLink(VALID_INPUT, deps);
    expect(res.status).toBe(200);
  });

  // ── EI-382: bare-link joins seed their own git-sync routine ─────────────────

  it('seeds the joined clone git-sync routine joiner-side with github coords + salted cron', async () => {
    const deps = makeDeps();
    await handleJoinLink(VALID_INPUT, deps);

    expect(deps.seedGitSync).toHaveBeenCalledTimes(1);
    const seedArg = (deps.seedGitSync as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(seedArg).toMatchObject({
      workspaceId: 'ws-test',
      installSlug: 'my-harness',
      joinerSide: true, // D-002: push:false — a local mirror, not a pusher
      cronKey: 'my-harness:ws-test', // D-004: salted per-install (shared repo, N peers)
      entry: {
        slug: 'my-harness',
        path: '/tmp/my-harness',
        github_remote: 'https://github.com/Papercusp/papercup',
        github_repository_id: 12345,
      },
    });
  });

  it('does NOT seed git-sync when cloneDir is missing', async () => {
    const stateNoClone: JoinState = { ...FAKE_STATE, cloneDir: undefined };
    const deps = makeDeps({ joinHarness: vi.fn(async () => stateNoClone) });
    await handleJoinLink(VALID_INPUT, deps);
    expect(deps.seedGitSync).not.toHaveBeenCalled();
  });

  it('swallows git-sync seed errors — the join still returns 200', async () => {
    const deps = makeDeps({
      seedGitSync: vi.fn(async () => {
        throw new Error('seed boom (PG down)');
      }),
    });
    const res = await handleJoinLink(VALID_INPUT, deps);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
  });
});

// ─── handler-level: test invalid_link via the defineTool Request path ─────────

describe('joinLink defineTool handler (invalid input → 400)', () => {
  it('returns 400 invalid_link for a bad harnessLinkUrl', async () => {
    // Import the default export (the defineTool handler) and invoke via Request.
    const { default: joinLink } = await import('../join-link');
    const handler = (joinLink as unknown as { handler: (req: Request) => Promise<Response> })
      .handler;

    const req = new Request('http://localhost/api/harness/join-link', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slug: 'my-harness', harnessLinkUrl: 'not-a-valid-link' }),
    });
    const res = await handler(req);

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe('invalid_link');
  });

  it('returns 400 for missing slug', async () => {
    const { default: joinLink } = await import('../join-link');
    const handler = (joinLink as unknown as { handler: (req: Request) => Promise<Response> })
      .handler;

    const req = new Request('http://localhost/api/harness/join-link', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ harnessLinkUrl: 'papercusp://harness?topic=' + 'a'.repeat(64) + '&github=A/b&repo_id=1' }),
    });
    const res = await handler(req);

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/slug required/i);
  });
});
