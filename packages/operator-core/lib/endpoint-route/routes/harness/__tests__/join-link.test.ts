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
    // Atomic upsert-or-enrich seam (EI-82 hardening). The fake applies the
    // mutator to an empty registry; tests re-apply the recorded mutator to
    // their own fixtures to assert its behavior.
    mutateRegistry: vi.fn(async (fn: (r: { projects: never[] }) => unknown) => fn({ projects: [] })) as never,
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
    seedOwnerBinding: vi.fn(async () => ({ seeded: true as const })),
    upsertHiveIdentity: vi.fn(async () => {}),
    ...overrides,
  };
}

const VALID_LINK_WITH_OWNER_BINDING: HarnessLink = {
  ...VALID_LINK,
  hivePubkey: 'a'.repeat(44),
  ownerDevicePubkey: 'b'.repeat(44),
  ownerGithubUserId: 42,
  attestationGistId: 'c'.repeat(20),
};

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

  it('registers harness (atomic upsert) and scaffolds when cloneDir is set', async () => {
    const deps = makeDeps();
    await handleJoinLink(VALID_INPUT, deps);

    expect(deps.mutateRegistry).toHaveBeenCalledTimes(1);
    const mutator = (deps.mutateRegistry as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    // EI-1623: the link-join clone is registered as a self-describing JOINER member
    // (upstream coords + `joined_via_link`), so the boot git-sync reconcile can
    // backfill its routine joiner-side if the best-effort join-time seed fails.
    const next = mutator({ projects: [] });
    expect(next.projects).toContainEqual({
      slug: 'my-harness',
      path: '/tmp/my-harness',
      github_remote: 'https://github.com/Papercusp/papercup',
      github_repository_id: 12345,
      joined_via_link: true,
      // WI-3891: stamped so isRegisteredHive()/isHiveProject() (probe:emit,
      // pot:get, pot:list) recognize this joiner-side clone as a real hive
      // member — mirrors bootstrap-papercusp-hive.ts's self-admit pattern.
      harness_kind: 'hive',
      remote_hive: true,
      self_repo: true,
    });
    expect(deps.scaffold).toHaveBeenCalledWith('my-harness');
  });

  it('ENRICHES a minimal pre-boot row in place (EI-1623 revival) — no duplicate entry', async () => {
    const deps = makeDeps();
    await handleJoinLink(VALID_INPUT, deps);

    const mutator = (deps.mutateRegistry as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    // The join orchestrator's pre-boot registration inserts { slug, path } —
    // the mutator must fill the missing coords on THAT row, not append a dup.
    const next = mutator({ projects: [{ slug: 'my-harness', path: '/tmp/my-harness' }] });
    expect(next.projects).toHaveLength(1);
    expect(next.projects[0]).toEqual({
      slug: 'my-harness',
      path: '/tmp/my-harness',
      github_remote: 'https://github.com/Papercusp/papercup',
      github_repository_id: 12345,
      joined_via_link: true,
      harness_kind: 'hive',
      remote_hive: true,
      self_repo: true,
    });
  });

  it('an already self-describing row is returned UNCHANGED (idempotent re-join)', async () => {
    const deps = makeDeps();
    await handleJoinLink(VALID_INPUT, deps);

    const mutator = (deps.mutateRegistry as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    const full = {
      slug: 'my-harness',
      path: '/existing/clone',
      github_remote: 'https://github.com/someone/else',
      github_repository_id: 777,
      joined_via_link: false,
      hive_slug: 'some-hive',
      harness_kind: 'hive',
      remote_hive: true,
      self_repo: true,
    };
    const reg = { projects: [full] };
    const next = mutator(reg);
    // Same object back — existing coords (even divergent ones) are never clobbered.
    expect(next).toBe(reg);
  });

  it('WI-3891: BACKFILLS harness_kind/remote_hive/self_repo onto a pre-fix row that already has the older coords', async () => {
    const deps = makeDeps();
    await handleJoinLink(VALID_INPUT, deps);

    const mutator = (deps.mutateRegistry as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    // A row registered by the OLD join-link.ts (before WI-3891) — fully
    // "self-describing" by the old definition, but missing the hive-kind
    // stamp that probe:emit / pot:get / pot:list need.
    const preFixRow = {
      slug: 'my-harness',
      path: '/existing/clone',
      github_remote: 'https://github.com/Papercusp/papercup',
      github_repository_id: 12345,
      joined_via_link: true,
    };
    const next = mutator({ projects: [preFixRow] });
    expect(next.projects).toHaveLength(1);
    expect(next.projects[0]).toEqual({
      ...preFixRow,
      harness_kind: 'hive',
      remote_hive: true,
      self_repo: true,
    });
  });

  it('does NOT register harness when cloneDir is missing', async () => {
    const stateNoClone: JoinState = { ...FAKE_STATE, cloneDir: undefined };
    const deps = makeDeps({
      joinHarness: vi.fn(async () => stateNoClone),
    });
    await handleJoinLink(VALID_INPUT, deps);

    expect(deps.mutateRegistry).not.toHaveBeenCalled();
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

  // ── D-007 / WI-4134: owner-binding seed uses the current `-pot` slug suffix ──

  it('D-007: seeds the owner binding with a `-pot`-suffixed potId (not the stale `-hive` suffix)', async () => {
    const deps = makeDeps();
    await handleJoinLink({ ...VALID_INPUT, link: VALID_LINK_WITH_OWNER_BINDING }, deps);

    expect(deps.seedOwnerBinding).toHaveBeenCalledTimes(1);
    const seedArg = (deps.seedOwnerBinding as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(seedArg).toMatchObject({
      workspaceId: 'ws-test',
      hivePubkey: VALID_LINK_WITH_OWNER_BINDING.hivePubkey,
      ownerDevicePubkey: VALID_LINK_WITH_OWNER_BINDING.ownerDevicePubkey,
      ownerGithubUserId: VALID_LINK_WITH_OWNER_BINDING.ownerGithubUserId,
      // cup-lexicon-full-rename-2026-07-09: MUST match createPotFromRepo's
      // deriveSlugs() `-pot` convention — a real owner announce stamps
      // hive_id: desc.potId (HiveDirectory.announceLocalHive), so a stale
      // `-hive` suffix here would key the synthetic seed entry differently
      // from the later real beacon entry, landing as a duplicate in
      // HiveDirectory.discovered (keyed on potId) instead of merging.
      potId: `${VALID_LINK.repoName}-pot`,
    });
  });

  it('does NOT seed the owner binding when the link lacks the full binding (no hivePubkey/ownerDevicePubkey/etc.)', async () => {
    const deps = makeDeps();
    await handleJoinLink(VALID_INPUT, deps); // plain VALID_LINK — no owner-binding fields
    expect(deps.seedOwnerBinding).not.toHaveBeenCalled();
  });

  it('WI-10003134: a member link materializes the joined Pot identity row (the pot_members FK parent) under the local slug', async () => {
    const deps = makeDeps();
    await handleJoinLink({ ...VALID_INPUT, link: VALID_LINK_WITH_OWNER_BINDING }, deps);

    expect(deps.upsertHiveIdentity).toHaveBeenCalledTimes(1);
    expect(deps.upsertHiveIdentity).toHaveBeenCalledWith({
      workspaceId: 'ws-test',
      homeSlug: 'my-harness',
      pubkeyBase64: VALID_LINK_WITH_OWNER_BINDING.hivePubkey,
      // a NON-SIGNING remote:* placeholder: upsertRemoteHiveIdentity refuses anything else
      keychainId: `remote:${VALID_LINK.repoName}-pot`,
    });
  });

  it('WI-10003134: a bare link (no hive pubkey) writes no identity row', async () => {
    const deps = makeDeps();
    await handleJoinLink(VALID_INPUT, deps);
    expect(deps.upsertHiveIdentity).not.toHaveBeenCalled();
  });

  it('WI-10003134: swallows identity-row write errors — the join still returns 200 and still seeds the owner binding', async () => {
    const deps = makeDeps({
      upsertHiveIdentity: vi.fn(async () => {
        throw new Error('duplicate key value violates unique constraint "pots_public_key_key"');
      }),
    });
    const res = await handleJoinLink({ ...VALID_INPUT, link: VALID_LINK_WITH_OWNER_BINDING }, deps);
    expect(res.status).toBe(200);
    expect(deps.seedOwnerBinding).toHaveBeenCalledTimes(1);
  });

  it('swallows seedOwnerBinding errors — the join still returns 200', async () => {
    const deps = makeDeps({
      seedOwnerBinding: vi.fn(async () => {
        throw new Error('seed boom (attestation unreachable)');
      }),
    });
    const res = await handleJoinLink({ ...VALID_INPUT, link: VALID_LINK_WITH_OWNER_BINDING }, deps);
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
