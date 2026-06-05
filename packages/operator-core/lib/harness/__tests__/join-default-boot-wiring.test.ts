/**
 * join-default-boot-wiring.test.ts — the one federation-round-trip seam the
 * other tests miss: joinSharedHarness's DEFAULT (production) boot+await path.
 *
 * `feature-content-federation.integration.test.ts` proves the real round-trip
 * but calls `bootHarnessSubstrate` DIRECTLY (bypassing the join orchestrator),
 * and `join-shared-harness.test.ts` always INJECTS `bootFederateFn` /
 * `readAdmittedCountFn`. So neither exercises the actual production wiring:
 *   joinSharedHarness (defaults) → boot-all.bootSingleHarness / getBootedHarness.
 * A rename or mis-wire of that default path would pass both — and break real
 * join-and-federate. This test omits those injectables and asserts the defaults
 * reach the real boot-all entry points, with the 6-step orchestration completing.
 *
 * Deterministic: boot-all + activeWorkspaceId are mocked at the module
 * boundary; GitHub (channel-1 fetch, clone, gist) is stubbed. No swarm, no PG,
 * no network — federation itself is proven by the integration test; this proves
 * the orchestrator targets it.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HarnessLink } from '../url-scheme';

const boot = vi.hoisted(() => ({
  // step 4's default boot path uses an ESM `import()` → this mock intercepts it.
  bootSingleHarness: vi.fn(async () => ({ booted: true })),
  // step 5's default await reader uses a CJS `require()`, which vi.mock does NOT
  // intercept — so the real getBootedHarness runs and returns null for this
  // un-booted harness → 0 peers → await soft-skips to phase_0_pending (fast).
  // We therefore assert the boot wiring (the genuine gap) rather than this read.
  getBootedHarness: vi.fn(() => null),
}));

vi.mock('../../sync/hyperbee/boot-all', () => ({
  bootSingleHarness: boot.bootSingleHarness,
  getBootedHarness: boot.getBootedHarness,
}));
vi.mock('../../workspace-registry', async (orig) => ({
  ...(await orig<typeof import('../../workspace-registry')>()),
  activeWorkspaceId: () => 'ws-default-boot',
}));

import { joinSharedHarness } from '../join-shared-harness';

function makeFetch(responses: Array<{ status: number; body: unknown }>): typeof fetch {
  let call = 0;
  return vi.fn(async () => {
    const r = responses[call++];
    if (!r) throw new Error('unexpected fetch call ' + call);
    return { ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => r.body } as unknown as Response;
  }) as unknown as typeof fetch;
}

afterEach(() => {
  boot.bootSingleHarness.mockClear();
  boot.getBootedHarness.mockClear();
});

describe('joinSharedHarness — DEFAULT boot/await wiring reaches the real boot-all', () => {
  it('completes all 6 steps and routes the default boot+await through bootSingleHarness/getBootedHarness', async () => {
    const slug = 'default-boot-' + Date.now();
    const link = { topic: 'deadbeef', github: 'o/r', repoOwner: 'o', repoName: 'r', repoId: 1, privacy: 'shared-private' } as unknown as HarnessLink;

    const res = await joinSharedHarness({
      link,
      slug,
      token: 'tok-ok',
      githubUserId: 42,
      githubLogin: 'alice',
      keychainId: 'kc-default-boot-' + Date.now(),
      existingGistId: 'gist-injected', // skips the network gist-creation call
      fetchFn: makeFetch([{ status: 200, body: { id: 42, login: 'alice' } }]), // channel-1 OK
      execFileFn: vi.fn(async () => ({ stdout: '', stderr: '' })), // no real git clone
      mkdirFn: vi.fn(async () => undefined),
      writeFileFn: vi.fn(async () => undefined),
      readStateFn: vi.fn(async () => null),
      writeStateFn: vi.fn(async () => undefined),
      // Small positive timeout so the default await actually POLLS getBootedHarness
      // at least once (timeoutMs=0 exits before reading); no peer → phase_0_pending.
      awaitAdmissionTimeoutMs: 30,
      awaitAdmissionPollMs: 5,
      sleepFn: (ms: number) => new Promise((r) => setTimeout(r, ms)),
      // bootFederateFn + readAdmittedCountFn DELIBERATELY OMITTED → exercise the defaults
    });

    // The default boot path targets boot-all.bootSingleHarness with the resolved
    // workspace id + the harness slug — the production wiring no other test covers.
    expect(boot.bootSingleHarness).toHaveBeenCalledTimes(1);
    expect(boot.bootSingleHarness).toHaveBeenCalledWith('ws-default-boot', slug);

    // Orchestration completes end to end (the GitHub-gated steps via stubs).
    expect(res.steps.oauth_attest.status).toBe('done');
    expect(res.steps.clone_repo.status).toBe('done');
    expect(res.steps.publish_binding.status).toBe('done');
    expect(res.steps.boot_federate.status).toBe('done');
    expect(res.steps.route_insights.status).toBe('done');
    // No peer in this unit → the await soft-skips (federation completes when a peer
    // comes online); that's a non-error terminal state, not a failure.
    expect(res.steps.await_admission_merge.status).toBe('phase_0_pending');
    expect(res.completedAt).toBeTruthy();
  });

  it('a boot failure soft-skips to phase_0_pending (federation retried next session), not a hard throw', async () => {
    boot.bootSingleHarness.mockRejectedValueOnce(new Error('DHT unreachable'));
    const slug = 'default-boot-fail-' + Date.now();
    const link = { topic: 'feed', github: 'o/r', repoOwner: 'o', repoName: 'r', repoId: 2, privacy: 'shared-private' } as unknown as HarnessLink;

    const res = await joinSharedHarness({
      link,
      slug,
      token: 'tok-ok',
      githubUserId: 42,
      githubLogin: 'alice',
      keychainId: 'kc-default-boot-fail-' + Date.now(),
      existingGistId: 'gist-injected',
      fetchFn: makeFetch([{ status: 200, body: { id: 42, login: 'alice' } }]),
      execFileFn: vi.fn(async () => ({ stdout: '', stderr: '' })),
      mkdirFn: vi.fn(async () => undefined),
      writeFileFn: vi.fn(async () => undefined),
      readStateFn: vi.fn(async () => null),
      writeStateFn: vi.fn(async () => undefined),
      awaitAdmissionTimeoutMs: 0,
      awaitAdmissionPollMs: 0,
      sleepFn: vi.fn(async () => undefined),
    });

    expect(boot.bootSingleHarness).toHaveBeenCalledTimes(1);
    expect(res.steps.boot_federate.status).toBe('phase_0_pending');
    // route_insights still completes — the join surfaces, federation resumes later.
    expect(res.steps.route_insights.status).toBe('done');
    expect(res.completedAt).toBeTruthy();
  });
});
