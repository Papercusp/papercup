/**
 * Tests for join-shared-harness.ts (P-009b/c).
 *
 * Each step function is tested in isolation (P-009b: independently testable).
 * The orchestrator test verifies idempotent resume (P-009c).
 *
 * Steps 3, 4, 5, 8 (Hyperswarm/Hyperbee stubs) are tested to confirm
 * they throw JoinStepError with code 'phase_0_pending'.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { generateKeyPairSync, sign as nodeSign } from 'node:crypto';
import {
  step1_oauthAttest,
  step2_cloneRepo,
  step3_joinHyperswarm,
  step4_bootstrapHyperbee,
  step5_seedPg,
  step6_createUserBranch,
  step7_pushContributorFile,
  step8_publishBinding,
  step9_verifyBinding,
  step10_routeInsights,
  joinSharedHarness,
  JoinStepError,
  type JoinState,
} from '../join-shared-harness';
import {
  CONTRIBUTOR_FILE_CANONICAL_FIELD_ORDER,
  contributorBranchRef,
} from '../../identity/contributor-file-types';

// ─── shared key fixture ───────────────────────────────────────────────────────

const { publicKey: _pub, privateKey: _priv } = generateKeyPairSync('ed25519');
const spkiDer = _pub.export({ type: 'spki', format: 'der' }) as Buffer;
const RAW_PUBKEY = spkiDer.subarray(-32);
const DEVICE_PUBKEY_B64 = RAW_PUBKEY.toString('base64');

/** Build a signed ContributorFileBody. */
function makeSignedFileBody(opts: {
  githubUserId: number;
  githubLogin: string;
  pubkeyBase64: string;
  privateKey: typeof _priv;
}) {
  const unsigned = {
    device_attestation_gist_id: 'gist-abc',
    device_pubkey: `ed25519:${opts.pubkeyBase64}`,
    github_login: opts.githubLogin,
    github_user_id: opts.githubUserId,
    joined_at: '2026-01-01T00:00:00.000Z',
    version: 1 as const,
  };
  const fields = CONTRIBUTOR_FILE_CANONICAL_FIELD_ORDER.filter((f) => f !== 'signature_by_device');
  const ordered: Record<string, unknown> = {};
  for (const f of fields) ordered[f] = (unsigned as Record<string, unknown>)[f];
  const sig = nodeSign(null, Buffer.from(JSON.stringify(ordered), 'utf8'), opts.privateKey).toString('base64');
  return { ...unsigned, signature_by_device: sig };
}

// ─── helper: mock fetch ───────────────────────────────────────────────────────

function makeFetch(responses: Array<{ status: number; body: unknown }>): typeof fetch {
  let call = 0;
  return vi.fn(async () => {
    const resp = responses[call++];
    if (!resp) throw new Error('unexpected fetch call ' + call);
    return {
      ok: resp.status >= 200 && resp.status < 300,
      status: resp.status,
      json: async () => resp.body,
    } as unknown as Response;
  }) as unknown as typeof fetch;
}

// ─── Step 1: oauth_attest ────────────────────────────────────────────────────

describe('step1_oauthAttest', () => {
  it('succeeds when token matches claimed user id', async () => {
    // Needs a real keychainId for loadOrGenerateDeviceKeypair — use a
    // temp keychainId so the encrypted-file fallback creates a fresh key.
    const keychainId = 'test-step1-' + Date.now();
    const fetchFn = makeFetch([{ status: 200, body: { id: 42, login: 'alice' } }]);
    const result = await step1_oauthAttest({
      token: 'tok-ok',
      claimedGithubUserId: 42,
      keychainId,
      fetchFn,
    });
    expect(result.channel1).toEqual({ kind: 'ok' });
    expect(typeof result.keypair.pubkeyBase64).toBe('string');
    expect(result.keypair.pubkeyBase64.length).toBeGreaterThan(0);
  });

  it('throws JoinStepError when token id mismatches', async () => {
    const keychainId = 'test-step1-mismatch-' + Date.now();
    const fetchFn = makeFetch([{ status: 200, body: { id: 99, login: 'bob' } }]);
    await expect(
      step1_oauthAttest({
        token: 'tok-wrong',
        claimedGithubUserId: 42,
        keychainId,
        fetchFn,
      }),
    ).rejects.toMatchObject({ name: 'JoinStepError', code: 'oauth_user_id_mismatch' });
  });

  it('throws JoinStepError on 401', async () => {
    const keychainId = 'test-step1-401-' + Date.now();
    const fetchFn = makeFetch([{ status: 401, body: {} }]);
    await expect(
      step1_oauthAttest({
        token: 'tok-revoked',
        claimedGithubUserId: 1,
        keychainId,
        fetchFn,
      }),
    ).rejects.toMatchObject({ name: 'JoinStepError', code: 'oauth_token_revoked' });
  });
});

// ─── Step 2: clone_repo ──────────────────────────────────────────────────────

describe('step2_cloneRepo', () => {
  it('calls git clone and returns cloneDir', async () => {
    const slug = 'test-clone-' + Date.now();
    const execFileFn = vi.fn().mockResolvedValue({ stdout: '', stderr: '' });
    const mkdirFn = vi.fn().mockResolvedValue(undefined);

    const result = await step2_cloneRepo({
      githubFullName: 'myorg/myrepo',
      slug,
      execFileFn,
      mkdirFn,
    });

    expect(result.cloneDir).toContain(slug);
    expect(execFileFn).toHaveBeenCalledWith(
      'git',
      expect.arrayContaining(['clone', '--depth', '1', 'https://github.com/myorg/myrepo']),
    );
  });

  it('throws JoinStepError on clone failure', async () => {
    const slug = 'test-clone-fail-' + Date.now();
    const execFileFn = vi.fn().mockRejectedValue(new Error('Permission denied'));
    const mkdirFn = vi.fn().mockResolvedValue(undefined);

    await expect(
      step2_cloneRepo({ githubFullName: 'org/repo', slug, execFileFn, mkdirFn }),
    ).rejects.toMatchObject({ name: 'JoinStepError', code: 'clone_failed' });
  });
});

// ─── Phase-0 stubs ───────────────────────────────────────────────────────────

describe('phase-0 stubs', () => {
  it('step3_joinHyperswarm throws phase_0_pending', async () => {
    await expect(step3_joinHyperswarm({ topic: 'a'.repeat(64) })).rejects.toMatchObject({
      name: 'JoinStepError',
      code: 'phase_0_pending',
    });
  });

  it('step4_bootstrapHyperbee throws phase_0_pending when substrate is not booted', async () => {
    await expect(
      step4_bootstrapHyperbee({
        workspaceId: 'ws-x',
        harnessSlug: 'h',
        resolveHandle: async () => null,
      }),
    ).rejects.toMatchObject({ name: 'JoinStepError', code: 'phase_0_pending' });
  });

  it('step4_bootstrapHyperbee returns caughtUp:true when getProgress reports caught up', async () => {
    const r = await step4_bootstrapHyperbee({
      workspaceId: 'ws-x',
      harnessSlug: 'h',
      resolveHandle: async () => ({}),
      getProgress: () => ({
        workspaceId: 'ws-x',
        harnessSlug: 'h',
        mergedOps: 10,
        highestSeen: 10,
        lastChangeMs: 0,
        caughtUp: true,
      }),
      sleep: async () => {},
    });
    expect(r.caughtUp).toBe(true);
    expect(r.timedOut).toBe(false);
    expect(r.observed).toBe(10);
  });

  it('step4_bootstrapHyperbee returns timedOut:true when deadline passes without catch-up', async () => {
    const fakeNow = (() => {
      let t = 1_000_000;
      return () => {
        const v = t;
        t += 30;
        return v;
      };
    })();
    const r = await step4_bootstrapHyperbee({
      workspaceId: 'ws-x',
      harnessSlug: 'h',
      timeoutMs: 50,
      pollMs: 10,
      now: fakeNow,
      resolveHandle: async () => ({}),
      getProgress: () => ({
        workspaceId: 'ws-x',
        harnessSlug: 'h',
        mergedOps: 3,
        highestSeen: 3,
        lastChangeMs: 0,
        caughtUp: false,
      }),
      sleep: async () => {},
    });
    expect(r.caughtUp).toBe(false);
    expect(r.timedOut).toBe(true);
    expect(r.observed).toBe(3);
  });

  it('step5_seedPg throws phase_0_pending', async () => {
    await expect(step5_seedPg({ slug: 'test' })).rejects.toMatchObject({
      name: 'JoinStepError',
      code: 'phase_0_pending',
    });
  });

  it('step8_publishBinding throws phase_0_pending when substrate is not booted', async () => {
    await expect(
      step8_publishBinding({
        workspaceId: 'ws-x',
        harnessSlug: 'h',
        githubUserId: 1,
        githubLogin: 'alice',
        pubkeyBase64: DEVICE_PUBKEY_B64,
        attestationGistId: 'g',
        resolveHandle: async () => null,
      }),
    ).rejects.toMatchObject({ name: 'JoinStepError', code: 'phase_0_pending' });
  });

  it('step8_publishBinding publishes a ContributorRow on the booted handle', async () => {
    let captured: { row: unknown } | null = null;
    await step8_publishBinding({
      workspaceId: 'ws-x',
      harnessSlug: 'h',
      githubUserId: 7,
      githubLogin: 'bob',
      pubkeyBase64: DEVICE_PUBKEY_B64,
      attestationGistId: 'g-123',
      now: 1700000000000,
      resolveHandle: async () =>
        ({
          workspaceId: 'ws-x',
          harnessSlug: 'h',
          store: {} as never,
          base: { base: {} as never, async close() {}, async append() {} },
          async close() {},
        }) as never,
      publishRow: async (p) => {
        captured = { row: p.row };
      },
    });
    expect(captured).not.toBeNull();
    const row = captured!.row as Record<string, unknown>;
    expect(row.harness_slug).toBe('h');
    expect(row.github_user_id).toBe(7);
    expect(row.github_username).toBe('bob');
    expect(row.binding_status).toBe('pending');
    expect(row.channel2_branch_ref).toBe('user/7');
    expect(row.joined_at).toBe(1700000000000);
    const attestations = row.device_attestations as Array<Record<string, unknown>>;
    expect(attestations).toHaveLength(1);
    expect(attestations[0].gist_id).toBe('g-123');
    expect(attestations[0].device_pubkey).toMatch(/^ed25519:/);
  });

  it('step8_publishBinding wraps publishRow throws as JoinStepError(publish_failed)', async () => {
    await expect(
      step8_publishBinding({
        workspaceId: 'ws-x',
        harnessSlug: 'h',
        githubUserId: 7,
        githubLogin: 'bob',
        pubkeyBase64: DEVICE_PUBKEY_B64,
        attestationGistId: 'g',
        resolveHandle: async () =>
          ({
            workspaceId: 'ws-x',
            harnessSlug: 'h',
            store: {} as never,
            base: { base: {} as never, async close() {}, async append() {} },
            async close() {},
          }) as never,
        publishRow: async () => {
          throw new Error('autobase append failed');
        },
      }),
    ).rejects.toMatchObject({
      name: 'JoinStepError',
      code: 'publish_failed',
    });
  });
});

// ─── Step 6: create_user_branch ──────────────────────────────────────────────

describe('step6_createUserBranch', () => {
  it('creates branch + worktree when neither exists', async () => {
    const calls: string[][] = [];
    const execFileFn = vi.fn().mockImplementation((_f: string, args: string[]) => {
      calls.push(args);
      // show-ref --verify fails (branch not found), worktree add succeeds
      if (args.includes('show-ref')) {
        const err = new Error('not found') as Error & { code?: number; stderr?: string };
        err.code = 1;
        err.stderr = 'fatal: bad reference';
        throw err;
      }
      return Promise.resolve({ stdout: '', stderr: '' });
    });

    const r = await step6_createUserBranch({
      cloneDir: '/fake',
      githubUserId: 42,
      execFileFn,
      pathExistsFn: () => false,
    });

    const branch = contributorBranchRef(42);
    expect(r.branchRef).toBe(branch);
    expect(r.worktreeAbsPath).toBe('/fake/.papercusp/user-trees/42');
    // worktree add -b user/42 <path> origin/main
    const addArgs = calls.find((a) => a.includes('worktree') && a.includes('-b'));
    expect(addArgs).toContain(branch);
    expect(addArgs).toContain('/fake/.papercusp/user-trees/42');
  });

  it('is a no-op when branch + worktree both already exist', async () => {
    const execFileFn = vi.fn().mockResolvedValue({ stdout: '', stderr: '' });

    const r = await step6_createUserBranch({
      cloneDir: '/fake',
      githubUserId: 42,
      execFileFn,
      pathExistsFn: () => true,
    });

    // Only show-ref ran — no worktree add.
    expect(execFileFn).toHaveBeenCalledTimes(1);
    expect(execFileFn.mock.calls[0][1]).toContain('show-ref');
    expect(r.branchRef).toBe(contributorBranchRef(42));
  });
});

// ─── Step 7: push_contributor_file ───────────────────────────────────────────

describe('step7_pushContributorFile', () => {
  it('writes file, commits, pushes, returns commit sha', async () => {
    const keychainId = 'test-step7-' + Date.now();
    // Pre-populate keychain with our test key.
    const { keychainStore } = await import('../../identity/keychain');
    const privDer = _priv.export({ type: 'pkcs8', format: 'der' }) as Buffer;
    await keychainStore(keychainId, privDer);

    const writtenFiles: Record<string, string> = {};
    const execCalls: { args: string[] }[] = [];
    const execFileFn = vi.fn().mockImplementation((_f: string, args: string[]) => {
      execCalls.push({ args });
      if (args[0] === 'rev-parse' && args[1] === 'HEAD') {
        return Promise.resolve({ stdout: 'abc123\n', stderr: '' });
      }
      return Promise.resolve({ stdout: '', stderr: '' });
    });
    const writeFileFn = vi.fn().mockImplementation((p: string, c: string) => {
      writtenFiles[p] = c;
      return Promise.resolve();
    });
    const mkdirFn = vi.fn().mockResolvedValue(undefined);

    const result = await step7_pushContributorFile({
      worktreeDir: '/fake/.papercusp/user-trees/1001',
      githubUserId: 1001,
      githubLogin: 'alice',
      devicePubkeyBase64: DEVICE_PUBKEY_B64,
      attestationGistId: 'gist-abc',
      keychainId,
      execFileFn,
      writeFileFn,
      mkdirFn,
    });

    expect(result.commitSha).toBe('abc123');
    // File was written.
    const filePath = Object.keys(writtenFiles).find((k) => k.includes('alice'));
    expect(filePath).toBeDefined();
    const parsed = JSON.parse(writtenFiles[filePath!]);
    expect(parsed.github_login).toBe('alice');
    expect(parsed.github_user_id).toBe(1001);
    expect(typeof parsed.signature_by_device).toBe('string');
    // git push was called.
    expect(execCalls.some((c) => c.args[0] === 'push')).toBe(true);
  });
});

// ─── Step 9: verify_binding ──────────────────────────────────────────────────

describe('step9_verifyBinding', () => {
  it('returns verified when both channels pass', async () => {
    const fileBody = makeSignedFileBody({
      githubUserId: 42,
      githubLogin: 'alice',
      pubkeyBase64: DEVICE_PUBKEY_B64,
      privateKey: _priv,
    });
    const encoded = Buffer.from(JSON.stringify(fileBody)).toString('base64');
    const fetchFn = makeFetch([
      // channel 1: /user
      { status: 200, body: { id: 42, login: 'alice' } },
      // channel 2: contents API
      { status: 200, body: { content: encoded + '\n', encoding: 'base64', sha: 'deadbeef' } },
      // channel 2: commit
      { status: 200, body: { author: { login: 'alice' }, commit: { verification: { verified: true } } } },
    ]);

    const result = await step9_verifyBinding({
      token: 'tok-ok',
      githubUserId: 42,
      githubLogin: 'alice',
      repoOwner: 'org',
      repoName: 'repo',
      devicePubkeyBase64: DEVICE_PUBKEY_B64,
      fetchFn,
    });

    expect(result.status).toBe('verified');
  });

  it('returns pending when channel 2 file not yet visible', async () => {
    const fetchFn = makeFetch([
      { status: 200, body: { id: 42, login: 'alice' } },
      { status: 404, body: {} },
    ]);

    const result = await step9_verifyBinding({
      token: 'tok-ok',
      githubUserId: 42,
      githubLogin: 'alice',
      repoOwner: 'org',
      repoName: 'repo',
      devicePubkeyBase64: DEVICE_PUBKEY_B64,
      fetchFn,
    });

    expect(result.status).toBe('pending');
  });
});

// ─── Step 10: route_insights ─────────────────────────────────────────────────

describe('step10_routeInsights', () => {
  it('returns the correct insights path', () => {
    const result = step10_routeInsights('my-harness');
    expect(result.insightsPath).toBe('/harness/my-harness/insights');
  });
});

// ─── orchestrator: happy path ─────────────────────────────────────────────────

describe('joinSharedHarness orchestrator', () => {
  const TOPIC = 'b'.repeat(64);
  const SLUG = 'test-harness';
  const GITHUB_FULL = 'myorg/myrepo';
  const USER_ID = 2001;
  const LOGIN = 'bob';
  const KEYCHAIN_ID = 'orch-test-' + Date.now();

  const link = {
    topic: TOPIC,
    github: GITHUB_FULL,
    repoOwner: 'myorg',
    repoName: 'myrepo',
    repoId: 99999,
  };

  beforeEach(async () => {
    // Pre-populate keychain so step1 + step7 work.
    const { keychainStore } = await import('../../identity/keychain');
    const privDer = _priv.export({ type: 'pkcs8', format: 'der' }) as Buffer;
    await keychainStore(KEYCHAIN_ID, privDer);
  });

  it('completes non-phase-0 steps and marks phase-0 steps as phase_0_pending', async () => {
    const fileBody = makeSignedFileBody({
      githubUserId: USER_ID,
      githubLogin: LOGIN,
      pubkeyBase64: DEVICE_PUBKEY_B64,
      privateKey: _priv,
    });
    const encoded = Buffer.from(JSON.stringify(fileBody)).toString('base64');

    const fetchFn = makeFetch([
      // step1: channel1 verify
      { status: 200, body: { id: USER_ID, login: LOGIN } },
      // step9 channel1
      { status: 200, body: { id: USER_ID, login: LOGIN } },
      // step9 channel2 contents
      { status: 200, body: { content: encoded + '\n', encoding: 'base64', sha: 'sha123' } },
      // step9 commit
      { status: 200, body: { author: { login: LOGIN }, commit: { verification: { verified: true } } } },
    ]);

    const execFileFn = vi.fn().mockImplementation((_f: string, args: string[]) => {
      if (args[0] === 'rev-parse' && args[1] === '--verify') throw new Error('no branch');
      if (args[0] === 'checkout' && args[1] === '--track') throw new Error('no remote');
      if (args[0] === 'rev-parse' && args[1] === 'HEAD') return Promise.resolve({ stdout: 'sha123\n', stderr: '' });
      return Promise.resolve({ stdout: '', stderr: '' });
    });

    const writeFileFn = vi.fn().mockResolvedValue(undefined);
    const mkdirFn = vi.fn().mockResolvedValue(undefined);

    const states: string[][] = [];
    const readStateFn = vi.fn().mockResolvedValue(null);
    const writeStateFn = vi.fn().mockImplementation((_slug: string, s: JoinState) => {
      states.push(Object.values(s.steps).map((st) => `${st.id}:${st.status}`));
      return Promise.resolve();
    });

    const finalState = await joinSharedHarness({
      link,
      slug: SLUG,
      token: 'tok-ok',
      githubUserId: USER_ID,
      githubLogin: LOGIN,
      keychainId: KEYCHAIN_ID,
      existingGistId: 'gist-xyz',
      fetchFn,
      execFileFn,
      writeFileFn,
      mkdirFn,
      readStateFn,
      writeStateFn,
    });

    // Non-stub steps are done.
    expect(finalState.steps.oauth_attest.status).toBe('done');
    expect(finalState.steps.clone_repo.status).toBe('done');
    expect(finalState.steps.create_user_branch.status).toBe('done');
    expect(finalState.steps.push_contributor_file.status).toBe('done');
    expect(finalState.steps.verify_binding.status).toBe('done');
    expect(finalState.steps.route_insights.status).toBe('done');

    // Stub steps are phase_0_pending.
    expect(finalState.steps.join_hyperswarm.status).toBe('phase_0_pending');
    expect(finalState.steps.bootstrap_hyperbee.status).toBe('phase_0_pending');
    expect(finalState.steps.seed_pg.status).toBe('phase_0_pending');
    expect(finalState.steps.publish_binding.status).toBe('phase_0_pending');

    // State has a completedAt.
    expect(typeof finalState.completedAt).toBe('number');
  });

  it('resumes from a saved state, skipping already-done steps (P-009c)', async () => {
    // Pre-build a state where step 1+2 are done.
    const savedState: JoinState = {
      slug: SLUG,
      linkTopic: TOPIC,
      startedAt: Date.now() - 10000,
      steps: {
        oauth_attest: { id: 'oauth_attest', status: 'done' },
        clone_repo: { id: 'clone_repo', status: 'done' },
        join_hyperswarm: { id: 'join_hyperswarm', status: 'phase_0_pending' },
        bootstrap_hyperbee: { id: 'bootstrap_hyperbee', status: 'phase_0_pending' },
        seed_pg: { id: 'seed_pg', status: 'phase_0_pending' },
        create_user_branch: { id: 'create_user_branch', status: 'pending' },
        push_contributor_file: { id: 'push_contributor_file', status: 'pending' },
        publish_binding: { id: 'publish_binding', status: 'phase_0_pending' },
        verify_binding: { id: 'verify_binding', status: 'pending' },
        route_insights: { id: 'route_insights', status: 'pending' },
      },
      cloneDir: '/fake/clones/' + SLUG,
      pubkeyBase64: DEVICE_PUBKEY_B64,
      attestationGistId: 'gist-xyz',
      githubUserId: USER_ID,
      githubLogin: LOGIN,
    };

    const fileBody = makeSignedFileBody({
      githubUserId: USER_ID,
      githubLogin: LOGIN,
      pubkeyBase64: DEVICE_PUBKEY_B64,
      privateKey: _priv,
    });
    const encoded = Buffer.from(JSON.stringify(fileBody)).toString('base64');

    const fetchFn = makeFetch([
      // step9 channel1
      { status: 200, body: { id: USER_ID, login: LOGIN } },
      // step9 channel2 contents
      { status: 200, body: { content: encoded + '\n', encoding: 'base64', sha: 'sha456' } },
      // step9 commit
      { status: 200, body: { author: { login: LOGIN }, commit: { verification: { verified: true } } } },
    ]);

    const execFileFn = vi.fn().mockImplementation((_f: string, args: string[]) => {
      if (args[0] === 'rev-parse' && args[1] === '--verify') throw new Error('no branch');
      if (args[0] === 'checkout' && args[1] === '--track') throw new Error('no remote');
      if (args[0] === 'rev-parse' && args[1] === 'HEAD') return Promise.resolve({ stdout: 'sha456\n', stderr: '' });
      return Promise.resolve({ stdout: '', stderr: '' });
    });

    const readStateFn = vi.fn().mockResolvedValue(savedState);
    const writeStateFn = vi.fn().mockResolvedValue(undefined);

    const finalState = await joinSharedHarness({
      link,
      slug: SLUG,
      token: 'tok-ok',
      githubUserId: USER_ID,
      githubLogin: LOGIN,
      keychainId: KEYCHAIN_ID,
      existingGistId: 'gist-xyz',
      fetchFn,
      execFileFn,
      writeFileFn: vi.fn().mockResolvedValue(undefined),
      mkdirFn: vi.fn().mockResolvedValue(undefined),
      readStateFn,
      writeStateFn,
    });

    // Steps 1+2 were already done, should still be done.
    expect(finalState.steps.oauth_attest.status).toBe('done');
    expect(finalState.steps.clone_repo.status).toBe('done');
    // Remaining non-stub steps completed.
    expect(finalState.steps.create_user_branch.status).toBe('done');
    expect(finalState.steps.push_contributor_file.status).toBe('done');
    expect(finalState.steps.verify_binding.status).toBe('done');
    expect(finalState.steps.route_insights.status).toBe('done');
  });
});
