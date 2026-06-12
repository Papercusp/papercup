/**
 * Tests for join-shared-harness.ts — 6 Model-B steps (D-005).
 *
 * Coverage:
 *   - ALL_STEP_IDS / JOIN_STEP_IDS equal the 6 expected step ids (no old stubs)
 *   - step1_oauthAttest: happy path, gh_auth_required (via channel-1 fail), gist injection
 *   - step2_cloneRepo: happy path, failure wrapping
 *   - stepPublishBinding: write-free — confirms a non-empty attestationGistId (no repo write)
 *   - stepBootFederate: calls injected booter
 *   - stepAwaitAdmissionMerge: resolves done when reader signals >0 peers; soft phase_0_pending on timeout
 *   - stepRouteInsights: correct path
 *   - Orchestrator: full happy-path (6 steps, cloneDir set, completedAt set)
 *   - Orchestrator: gh_auth_required in oauth_attest → JoinStepError thrown
 *   - Orchestrator: boot_federate failure → soft phase_0_pending (not hard error)
 *   - Orchestrator: await_admission_merge timeout → soft phase_0_pending (not hard error)
 *   - Orchestrator: idempotent resume (already-done steps skipped)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import {
  ALL_STEP_IDS,
  JOIN_STEP_IDS,
  step1_oauthAttest,
  step2_cloneRepo,
  stepPublishBinding,
  stepBootFederate,
  stepAwaitAdmissionMerge,
  stepRouteInsights,
  joinSharedHarness,
  JoinStepError,
  type JoinState,
  type JoinStepId,
} from '../join-shared-harness';

// ─── shared key fixture ───────────────────────────────────────────────────────

const { publicKey: _pub, privateKey: _priv } = generateKeyPairSync('ed25519');
const spkiDer = _pub.export({ type: 'spki', format: 'der' }) as Buffer;
const RAW_PUBKEY = spkiDer.subarray(-32);
const DEVICE_PUBKEY_B64 = RAW_PUBKEY.toString('base64');

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

// ─── Step list assertions ─────────────────────────────────────────────────────

describe('step id constants', () => {
  it('ALL_STEP_IDS equals the 6 Model-B steps in order', () => {
    expect(ALL_STEP_IDS).toEqual([
      'oauth_attest',
      'clone_repo',
      'publish_binding',
      'boot_federate',
      'await_admission_merge',
      'route_insights',
    ]);
  });

  it('JOIN_STEP_IDS is an alias for ALL_STEP_IDS', () => {
    expect(JOIN_STEP_IDS).toBe(ALL_STEP_IDS);
  });

  it('does NOT include old Autobase-era step ids', () => {
    const old = [
      'join_hyperswarm',
      'bootstrap_hyperbee',
      'seed_pg',
      'create_user_branch',
      'push_contributor_file',
      'verify_binding',
    ];
    for (const id of old) {
      expect(ALL_STEP_IDS).not.toContain(id);
    }
  });
});

// ─── step1_oauthAttest ───────────────────────────────────────────────────────

describe('step1_oauthAttest', () => {
  it('succeeds when token matches claimed user id and gist is injected', async () => {
    const keychainId = 'test-step1-' + Date.now();
    const fetchFn = makeFetch([{ status: 200, body: { id: 42, login: 'alice' } }]);
    const result = await step1_oauthAttest({
      token: 'tok-ok',
      claimedGithubUserId: 42,
      githubLogin: 'alice',
      keychainId,
      existingGistId: 'gist-injected',
      fetchFn,
    });
    expect(result.channel1).toEqual({ kind: 'ok' });
    expect(typeof result.keypair.pubkeyBase64).toBe('string');
    expect(result.keypair.pubkeyBase64.length).toBeGreaterThan(0);
    // Injected gist id is returned as-is (no network call to create gist).
    expect(result.attestationGistId).toBe('gist-injected');
  });

  it('throws JoinStepError with code matching channel1 reason when token id mismatches', async () => {
    const keychainId = 'test-step1-mismatch-' + Date.now();
    const fetchFn = makeFetch([{ status: 200, body: { id: 99, login: 'bob' } }]);
    await expect(
      step1_oauthAttest({
        token: 'tok-wrong',
        claimedGithubUserId: 42,
        githubLogin: 'alice',
        keychainId,
        fetchFn,
      }),
    ).rejects.toMatchObject({ name: 'JoinStepError', code: 'oauth_user_id_mismatch' });
  });

  it('throws JoinStepError on 401 (token revoked → gh_auth_required)', async () => {
    const keychainId = 'test-step1-401-' + Date.now();
    const fetchFn = makeFetch([{ status: 401, body: {} }]);
    await expect(
      step1_oauthAttest({
        token: 'tok-revoked',
        claimedGithubUserId: 1,
        githubLogin: 'alice',
        keychainId,
        fetchFn,
      }),
    ).rejects.toMatchObject({ name: 'JoinStepError', code: 'oauth_token_revoked' });
  });
});

// ─── step2_cloneRepo ──────────────────────────────────────────────────────────

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

// ─── stepPublishBinding ───────────────────────────────────────────────────────

describe('stepPublishBinding (write-free: confirm the attestation gist id)', () => {
  it('returns the attestation gist id and performs NO repo write', async () => {
    // Write-free join: step 3 does NOT touch the repo — it confirms the gist id
    // (created in step 1) is present and carries it forward. No Octokit, no
    // keychain, no Contents-API PUT.
    const result = await stepPublishBinding({ attestationGistId: 'gist-nonempty-123' });
    expect(result.attestationGistId).toBe('gist-nonempty-123');
  });

  it('throws JoinStepError(attestation_gist_missing) when the gist id is empty', async () => {
    await expect(stepPublishBinding({ attestationGistId: '' })).rejects.toMatchObject({
      name: 'JoinStepError',
      code: 'attestation_gist_missing',
    });
  });
});

// ─── stepBootFederate ────────────────────────────────────────────────────────

describe('stepBootFederate', () => {
  it('calls the injected bootFn with workspaceId and harnessSlug', async () => {
    const bootFn = vi.fn().mockResolvedValue({ state: 'booted' });
    await stepBootFederate({
      workspaceId: 'ws-test',
      harnessSlug: 'h-test',
      bootFn,
    });
    expect(bootFn).toHaveBeenCalledWith('ws-test', 'h-test');
  });

  it('throws when injected bootFn rejects', async () => {
    const bootFn = vi.fn().mockRejectedValue(new Error('DHT unreachable'));
    await expect(
      stepBootFederate({ workspaceId: 'ws', harnessSlug: 'h', bootFn }),
    ).rejects.toThrow('DHT unreachable');
  });
});

// ─── stepAwaitAdmissionMerge ─────────────────────────────────────────────────

describe('stepAwaitAdmissionMerge', () => {
  it('returns remoteOpLanded:true when reader signals >0 peers immediately', async () => {
    const readAdmittedCountFn = vi.fn().mockReturnValue(1);
    const result = await stepAwaitAdmissionMerge({
      workspaceId: 'ws',
      harnessSlug: 'h',
      timeoutMs: 5000,
      pollMs: 100,
      readAdmittedCountFn,
      sleep: async () => {},
      now: (() => {
        let t = 0;
        return () => t++;
      })(),
    });
    expect(result.remoteOpLanded).toBe(true);
    expect(readAdmittedCountFn).toHaveBeenCalled();
  });

  it('returns remoteOpLanded:false (soft) when timeout elapses with no peer', async () => {
    const readAdmittedCountFn = vi.fn().mockReturnValue(0);
    const fakeNow = (() => {
      let t = 0;
      return () => {
        const v = t;
        t += 1100; // advance past timeoutMs=1000 quickly
        return v;
      };
    })();
    const result = await stepAwaitAdmissionMerge({
      workspaceId: 'ws',
      harnessSlug: 'h',
      timeoutMs: 1000,
      pollMs: 100,
      readAdmittedCountFn,
      sleep: async () => {},
      now: fakeNow,
    });
    expect(result.remoteOpLanded).toBe(false);
  });

  it('returns remoteOpLanded:false immediately when timeoutMs=0', async () => {
    const readAdmittedCountFn = vi.fn().mockReturnValue(5);
    const result = await stepAwaitAdmissionMerge({
      workspaceId: 'ws',
      harnessSlug: 'h',
      timeoutMs: 0,
      readAdmittedCountFn,
    });
    expect(result.remoteOpLanded).toBe(false);
    // reader not even called when timeout is 0
    expect(readAdmittedCountFn).not.toHaveBeenCalled();
  });

  it('transitions from 0 to 1 peer during polling', async () => {
    let callCount = 0;
    const readAdmittedCountFn = vi.fn().mockImplementation(() => {
      callCount++;
      return callCount >= 3 ? 1 : 0; // peer appears on 3rd check
    });
    let t = 0;
    const now = () => {
      const v = t;
      t += 200; // advance 200ms per call
      return v;
    };
    const result = await stepAwaitAdmissionMerge({
      workspaceId: 'ws',
      harnessSlug: 'h',
      timeoutMs: 2000,
      pollMs: 200,
      readAdmittedCountFn,
      sleep: async () => {},
      now,
    });
    expect(result.remoteOpLanded).toBe(true);
  });
});

// ─── stepRouteInsights ───────────────────────────────────────────────────────

describe('stepRouteInsights', () => {
  it('returns the correct insights path', () => {
    const result = stepRouteInsights('my-harness');
    expect(result.insightsPath).toBe('/harness/my-harness/insights');
  });

  it('URL-encodes the slug', () => {
    const result = stepRouteInsights('has spaces');
    expect(result.insightsPath).toBe('/harness/has%20spaces/insights');
  });
});

// ─── orchestrator ─────────────────────────────────────────────────────────────

describe('joinSharedHarness orchestrator', () => {
  const TOPIC = 'b'.repeat(64);
  const SLUG = 'test-harness-6step';
  const GITHUB_FULL = 'myorg/myrepo';
  const USER_ID = 2001;
  const LOGIN = 'bob';
  const KEYCHAIN_ID = 'orch-6step-' + Date.now();

  const link = {
    topic: TOPIC,
    github: GITHUB_FULL,
    repoOwner: 'myorg',
    repoName: 'myrepo',
    repoId: 99999,
  };

  beforeEach(async () => {
    // Pre-populate keychain so oauth_attest + publish_binding work.
    const { keychainStore } = await import('../../identity/keychain');
    const privDer = _priv.export({ type: 'pkcs8', format: 'der' }) as Buffer;
    await keychainStore(KEYCHAIN_ID, privDer);
  });

  /** Build a minimal Octokit fake for publish_binding. */
  function makeFakeOctokit() {
    // getRef is called twice in ensureBranchExists:
    //   1st: check user/<id> branch → 404 (not yet created)
    //   2nd: get default branch HEAD → return a sha
    let getRefCallCount = 0;
    return {
      rest: {
        git: {
          getRef: vi.fn().mockImplementation(async () => {
            getRefCallCount++;
            if (getRefCallCount % 2 === 1) {
              // Odd calls: user branch check → not found
              const e: { status: number } = { status: 404 };
              throw e;
            }
            // Even calls: default branch HEAD
            return { data: { object: { sha: 'main-sha-abc' } } };
          }),
          createRef: vi.fn().mockResolvedValue({}),
        },
        repos: {
          getContent: vi.fn().mockRejectedValue({ status: 404 }),
          createOrUpdateFileContents: vi.fn().mockResolvedValue({
            data: { commit: { sha: 'commit-sha-xyz' } },
          }),
        },
      },
    };
  }

  it('synthesizes .papercusp/shared.json in the clone from the LINK when absent (joiner self-sufficiency)', async () => {
    const { mkdtempSync, rmSync, existsSync, readFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join: joinPath } = await import('node:path');
    const cloneDir = mkdtempSync(joinPath(tmpdir(), 'join-synth-'));
    try {
      // Resume path: persisted state says clone_repo is DONE with a REAL dir, so
      // the orchestrator goes straight to publish_binding → boot_federate.
      const persisted = {
        slug: SLUG,
        linkTopic: TOPIC,
        steps: {
          oauth_attest: { id: 'oauth_attest', status: 'done' },
          clone_repo: { id: 'clone_repo', status: 'done' },
          publish_binding: { id: 'publish_binding', status: 'pending' },
          boot_federate: { id: 'boot_federate', status: 'pending' },
          await_admission_merge: { id: 'await_admission_merge', status: 'pending' },
          route_insights: { id: 'route_insights', status: 'pending' },
        },
        cloneDir,
        attestationGistId: 'gist-injected-123',
      };
      const finalState = await joinSharedHarness({
        link,
        slug: SLUG,
        token: 'tok-ok',
        githubUserId: USER_ID,
        githubLogin: LOGIN,
        keychainId: KEYCHAIN_ID,
        registerCloneFn: async () => undefined, // EI-339: never the live registry
        existingGistId: 'gist-injected-123',
        fetchFn: makeFetch([{ status: 200, body: { id: USER_ID, login: LOGIN } }]),
        execFileFn: vi.fn().mockResolvedValue({ stdout: '', stderr: '' }),
        mkdirFn: vi.fn().mockResolvedValue(undefined),
        readStateFn: vi.fn().mockResolvedValue(persisted),
        writeStateFn: vi.fn().mockResolvedValue(undefined),
        bootFederateFn: vi.fn().mockResolvedValue({ state: 'booted' }),
        readAdmittedCountFn: vi.fn().mockReturnValue(1),
        awaitAdmissionTimeoutMs: 1000,
        awaitAdmissionPollMs: 50,
        sleepFn: async () => {},
        octokit: makeFakeOctokit(),
      });
      expect(finalState.steps.boot_federate.status).toBe('done');
      const cfgPath = joinPath(cloneDir, '.papercusp', 'shared.json');
      expect(existsSync(cfgPath)).toBe(true);
      const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
      expect(cfg).toMatchObject({
        topic: TOPIC,
        github_repository_id: link.repoId,
        github_remote: `https://github.com/${GITHUB_FULL}`,
        privacy: 'shared-private',
        claim_status: 'unclaimed',
        schema_version: 1,
      });
      // Must pass the REAL validator the boot path's loader applies — a shape
      // mismatch would silently boot local-only again.
      const { isHarnessSharedConfig } = await import('../harness-shared-config-types');
      expect(isHarnessSharedConfig(cfg)).toBe(true);
      const { loadSharedConfigFromProjectDir } = await import('../load-shared-config');
      expect(loadSharedConfigFromProjectDir(cloneDir)?.github_repository_id).toBe(link.repoId);
    } finally {
      rmSync(cloneDir, { recursive: true, force: true });
    }
  });

  it('completes all 6 steps and sets cloneDir + completedAt', async () => {
    // step1: channel1 verify (injected gist skips gist creation)
    const fetchFn = makeFetch([
      { status: 200, body: { id: USER_ID, login: LOGIN } },
    ]);

    const execFileFn = vi.fn().mockResolvedValue({ stdout: '', stderr: '' });
    const mkdirFn = vi.fn().mockResolvedValue(undefined);

    const readStateFn = vi.fn().mockResolvedValue(null);
    const writeStateFn = vi.fn().mockResolvedValue(undefined);

    const bootFederateFn = vi.fn().mockResolvedValue({ state: 'booted' });
    // Simulates peer admitted on first check:
    const readAdmittedCountFn = vi.fn().mockReturnValue(1);

    const finalState = await joinSharedHarness({
      link,
      slug: SLUG,
      token: 'tok-ok',
      githubUserId: USER_ID,
      githubLogin: LOGIN,
      keychainId: KEYCHAIN_ID,
      registerCloneFn: async () => undefined, // EI-339: never the live registry
      existingGistId: 'gist-injected-123', // non-empty → no network gist creation
      fetchFn,
      execFileFn,
      mkdirFn,
      readStateFn,
      writeStateFn,
      bootFederateFn,
      readAdmittedCountFn,
      awaitAdmissionTimeoutMs: 5000,
      awaitAdmissionPollMs: 100,
      sleepFn: async () => {},
      octokit: makeFakeOctokit(),
    });

    // All 6 steps done (or soft-done).
    expect(finalState.steps.oauth_attest.status).toBe('done');
    expect(finalState.steps.clone_repo.status).toBe('done');
    expect(finalState.steps.publish_binding.status).toBe('done');
    expect(finalState.steps.boot_federate.status).toBe('done');
    expect(finalState.steps.await_admission_merge.status).toBe('done');
    expect(finalState.steps.route_insights.status).toBe('done');

    // State has cloneDir and completedAt.
    expect(typeof finalState.cloneDir).toBe('string');
    expect(typeof finalState.completedAt).toBe('number');

    // bootFederateFn was called once.
    expect(bootFederateFn).toHaveBeenCalledTimes(1);

    // readAdmittedCountFn was called (at least once during await_admission_merge).
    expect(readAdmittedCountFn).toHaveBeenCalled();

    // attestationGistId is set to the injected value.
    expect(finalState.attestationGistId).toBe('gist-injected-123');
  });

  it('reports 6-step shape — does NOT contain old step ids', async () => {
    const fetchFn = makeFetch([{ status: 200, body: { id: USER_ID, login: LOGIN } }]);
    const execFileFn = vi.fn().mockResolvedValue({ stdout: '', stderr: '' });
    const mkdirFn = vi.fn().mockResolvedValue(undefined);
    const readStateFn = vi.fn().mockResolvedValue(null);
    let capturedState: JoinState | null = null;
    const writeStateFn = vi.fn().mockImplementation((_slug: string, s: JoinState) => {
      capturedState = s;
      return Promise.resolve();
    });

    await joinSharedHarness({
      link,
      slug: SLUG + '-shape',
      token: 'tok-ok',
      githubUserId: USER_ID,
      githubLogin: LOGIN,
      keychainId: KEYCHAIN_ID,
      registerCloneFn: async () => undefined, // EI-339: never the live registry
      existingGistId: 'gist-abc',
      fetchFn,
      execFileFn,
      mkdirFn,
      readStateFn,
      writeStateFn,
      bootFederateFn: vi.fn().mockResolvedValue({}),
      readAdmittedCountFn: vi.fn().mockReturnValue(0),
      awaitAdmissionTimeoutMs: 0,
      sleepFn: async () => {},
      octokit: makeFakeOctokit(),
    });

    const stepIds = Object.keys(capturedState!.steps) as string[];
    expect(stepIds.sort()).toEqual(
      ['oauth_attest', 'clone_repo', 'publish_binding', 'boot_federate', 'await_admission_merge', 'route_insights'].sort(),
    );
    // Old ids not present:
    expect(stepIds).not.toContain('join_hyperswarm');
    expect(stepIds).not.toContain('seed_pg');
    expect(stepIds).not.toContain('create_user_branch');
    expect(stepIds).not.toContain('push_contributor_file');
    expect(stepIds).not.toContain('verify_binding');
  });

  it('gh_auth_required in oauth_attest → throws JoinStepError and marks error', async () => {
    // 401 → channel1 kind='fail', reason='oauth_token_revoked'
    const fetchFn = makeFetch([{ status: 401, body: {} }]);
    const readStateFn = vi.fn().mockResolvedValue(null);
    const writeStateFn = vi.fn().mockResolvedValue(undefined);

    await expect(
      joinSharedHarness({
        link,
        slug: SLUG + '-gh-auth',
        token: 'tok-revoked',
        githubUserId: USER_ID,
        githubLogin: LOGIN,
        keychainId: KEYCHAIN_ID,
        registerCloneFn: async () => undefined, // EI-339: never the live registry
        fetchFn,
        readStateFn,
        writeStateFn,
      }),
    ).rejects.toMatchObject({
      name: 'JoinStepError',
      stepId: 'oauth_attest',
    });

    // The last written state should show oauth_attest as error.
    const lastState: JoinState = writeStateFn.mock.calls.at(-1)?.[1];
    expect(lastState?.steps.oauth_attest.status).toBe('error');
  });

  it('boot_federate failure → soft phase_0_pending, join still completes', async () => {
    const fetchFn = makeFetch([{ status: 200, body: { id: USER_ID, login: LOGIN } }]);
    const execFileFn = vi.fn().mockResolvedValue({ stdout: '', stderr: '' });
    const mkdirFn = vi.fn().mockResolvedValue(undefined);
    const readStateFn = vi.fn().mockResolvedValue(null);
    const writeStateFn = vi.fn().mockResolvedValue(undefined);

    // Boot fails (DHT unreachable)
    const bootFederateFn = vi.fn().mockRejectedValue(new Error('DHT unreachable'));

    const finalState = await joinSharedHarness({
      link,
      slug: SLUG + '-boot-fail',
      token: 'tok-ok',
      githubUserId: USER_ID,
      githubLogin: LOGIN,
      keychainId: KEYCHAIN_ID,
      registerCloneFn: async () => undefined, // EI-339: never the live registry
      existingGistId: 'gist-abc',
      fetchFn,
      execFileFn,
      mkdirFn,
      readStateFn,
      writeStateFn,
      bootFederateFn,
      readAdmittedCountFn: vi.fn().mockReturnValue(0),
      awaitAdmissionTimeoutMs: 0,
      sleepFn: async () => {},
      octokit: makeFakeOctokit(),
    });

    // boot_federate is soft phase_0_pending — NOT an error.
    expect(finalState.steps.boot_federate.status).toBe('phase_0_pending');
    // Join still completes (route_insights done).
    expect(finalState.steps.route_insights.status).toBe('done');
    expect(typeof finalState.completedAt).toBe('number');
  });

  it('await_admission_merge timeout → soft phase_0_pending, join still completes', async () => {
    const fetchFn = makeFetch([{ status: 200, body: { id: USER_ID, login: LOGIN } }]);
    const execFileFn = vi.fn().mockResolvedValue({ stdout: '', stderr: '' });
    const mkdirFn = vi.fn().mockResolvedValue(undefined);
    const readStateFn = vi.fn().mockResolvedValue(null);
    const writeStateFn = vi.fn().mockResolvedValue(undefined);

    const finalState = await joinSharedHarness({
      link,
      slug: SLUG + '-aam-timeout',
      token: 'tok-ok',
      githubUserId: USER_ID,
      githubLogin: LOGIN,
      keychainId: KEYCHAIN_ID,
      registerCloneFn: async () => undefined, // EI-339: never the live registry
      existingGistId: 'gist-abc',
      fetchFn,
      execFileFn,
      mkdirFn,
      readStateFn,
      writeStateFn,
      bootFederateFn: vi.fn().mockResolvedValue({}),
      // No peers ever appear:
      readAdmittedCountFn: vi.fn().mockReturnValue(0),
      awaitAdmissionTimeoutMs: 0, // immediate timeout
      sleepFn: async () => {},
      octokit: makeFakeOctokit(),
    });

    expect(finalState.steps.await_admission_merge.status).toBe('phase_0_pending');
    expect(finalState.steps.route_insights.status).toBe('done');
    expect(typeof finalState.completedAt).toBe('number');
  });

  it('publish_binding receives non-empty attestationGistId from oauth_attest', async () => {
    // Verify the attestationGistId flows from oauth_attest → publish_binding.
    const fetchFn = makeFetch([{ status: 200, body: { id: USER_ID, login: LOGIN } }]);
    const execFileFn = vi.fn().mockResolvedValue({ stdout: '', stderr: '' });
    const mkdirFn = vi.fn().mockResolvedValue(undefined);
    const readStateFn = vi.fn().mockResolvedValue(null);
    const writeStateFn = vi.fn().mockResolvedValue(undefined);

    const fakeOctokit = makeFakeOctokit();

    const finalState = await joinSharedHarness({
      link,
      slug: SLUG + '-gist-flow',
      token: 'tok-ok',
      githubUserId: USER_ID,
      githubLogin: LOGIN,
      keychainId: KEYCHAIN_ID,
      registerCloneFn: async () => undefined, // EI-339: never the live registry
      existingGistId: 'gist-nonempty-flow-test',
      fetchFn,
      execFileFn,
      mkdirFn,
      readStateFn,
      writeStateFn,
      bootFederateFn: vi.fn().mockResolvedValue({}),
      readAdmittedCountFn: vi.fn().mockReturnValue(1),
      awaitAdmissionTimeoutMs: 5000,
      awaitAdmissionPollMs: 100,
      sleepFn: async () => {},
      octokit: fakeOctokit,
    });

    // Write-free join (non-collaborator-join-fork-pr-2026-06-02): the binding IS
    // the attestation gist + the signed announce — stepPublishBinding no longer
    // writes a shared-repo contributor file (a non-collaborator needs no repo
    // write to join). Verify the non-empty gist id flowed oauth_attest →
    // publish_binding (carried on final state, step done) and that NO repo write
    // (Contents API PUT) happened.
    expect(finalState.attestationGistId).toBe('gist-nonempty-flow-test');
    expect(finalState.steps.publish_binding.status).toBe('done');
    expect(fakeOctokit.rest.repos.createOrUpdateFileContents).not.toHaveBeenCalled();
  });

  it('resumes from saved state, skipping already-done steps', async () => {
    // Pre-build a state where oauth_attest + clone_repo are done.
    const savedState: JoinState = {
      slug: SLUG + '-resume',
      linkTopic: TOPIC,
      startedAt: Date.now() - 10000,
      steps: {
        oauth_attest: { id: 'oauth_attest', status: 'done' },
        clone_repo: { id: 'clone_repo', status: 'done' },
        publish_binding: { id: 'publish_binding', status: 'pending' },
        boot_federate: { id: 'boot_federate', status: 'pending' },
        await_admission_merge: { id: 'await_admission_merge', status: 'pending' },
        route_insights: { id: 'route_insights', status: 'pending' },
      },
      cloneDir: '/fake/clones/' + SLUG + '-resume',
      pubkeyBase64: DEVICE_PUBKEY_B64,
      attestationGistId: 'gist-resume-abc',
      githubUserId: USER_ID,
      githubLogin: LOGIN,
    };

    // No fetch calls expected — oauth_attest + clone_repo are skipped.
    const fetchFn = makeFetch([]);
    const execFileFn = vi.fn().mockResolvedValue({ stdout: '', stderr: '' });
    const mkdirFn = vi.fn().mockResolvedValue(undefined);

    const readStateFn = vi.fn().mockResolvedValue(savedState);
    const writeStateFn = vi.fn().mockResolvedValue(undefined);

    const bootFederateFn = vi.fn().mockResolvedValue({ state: 'booted' });

    const fakeOctokit = makeFakeOctokit();

    const finalState = await joinSharedHarness({
      link,
      slug: SLUG + '-resume',
      token: 'tok-ok',
      githubUserId: USER_ID,
      githubLogin: LOGIN,
      keychainId: KEYCHAIN_ID,
      registerCloneFn: async () => undefined, // EI-339: never the live registry
      fetchFn,
      execFileFn,
      mkdirFn,
      readStateFn,
      writeStateFn,
      bootFederateFn,
      readAdmittedCountFn: vi.fn().mockReturnValue(1),
      awaitAdmissionTimeoutMs: 5000,
      awaitAdmissionPollMs: 100,
      sleepFn: async () => {},
      octokit: fakeOctokit,
    });

    // Steps 1+2 were already done.
    expect(finalState.steps.oauth_attest.status).toBe('done');
    expect(finalState.steps.clone_repo.status).toBe('done');

    // Remaining steps ran and completed.
    expect(finalState.steps.publish_binding.status).toBe('done');
    expect(finalState.steps.boot_federate.status).toBe('done');
    expect(finalState.steps.await_admission_merge.status).toBe('done');
    expect(finalState.steps.route_insights.status).toBe('done');

    // oauth_attest was skipped (no fetch call happened).
    expect(fetchFn).not.toHaveBeenCalled();

    // Preserved attestationGistId from saved state.
    expect(finalState.attestationGistId).toBe('gist-resume-abc');
  });
});
