/**
 * SPEC-P001-NOT-IN-V1-DISABLED (p2p-v1-core-release-2026-11-13 P-001, D-001): in a v1 release
 * build every capability in the not-in-v1 registry refuses at each of its public activation and
 * dispatch seams, and no flag gating one resolves enabled through getFlag.
 *
 * The seams are invoked through their real modules. Every invocation below must match a registry
 * seam and every registry seam must have an invocation, so a seam added to the registry without a
 * proof (or a proof for a seam the registry no longer names) fails this suite. The R-8 seam is also
 * proven against the database in v1-core-acceptance.integration.test.ts.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getFlag } from '@papercusp/flags/server';
import { flagEnvVarName } from '@papercusp/flags';
import { setFlagOverridesForTest } from '@papercusp/flags/test';
import { isV1ScopeRefusal, V1_HIVE_SIZE_LIMIT, V1_NOT_IN_SCOPE } from './v1-scope-contract';

/** The documented launch switch of the v1 release build. */
const RELEASE_ENV = 'PAPERCUSP_FLAG_PAPERCUSP_P2P_V1_RELEASE_BUILD';
const libDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** A store handle the refused flip must never touch: any call or member access throws a non-v1 error. */
const reachedStore = () => {
  throw new Error('the refused call reached the store');
};
const untouchable = new Proxy(function sqlHandle() {}, { apply: reachedStore, get: reachedStore }) as never;
const SCOPE = { hive_id: 'v1-hive-id', repo_key: 'v1-repo' };

/** A hive already at the limit, with no policy and no pending-request store. */
const fullHiveDeps = {
  getPolicy: async () => null,
  countHiveMembers: async () => V1_HIVE_SIZE_LIMIT,
  recordPendingJoin: async () => {
    throw new Error('a full hive must queue nobody');
  },
};
const joiner = { githubUserId: 9101, githubUsername: 'over-limit' };

/** One invocation per registry seam; resolves with the seam's value or rejects with its error. */
const INVOKE: Record<string, () => Promise<unknown>> = {
  'harness/git-sync/hive-git-mode.ts#setPotGitMode': async () =>
    (await import('../../harness/git-sync/hive-git-mode')).setPotGitMode('w', 'v1-hive', 'bridged', untouchable),
  'p2p/accept-delegated-seats.ts#assertHostAcceptsDelegatedSeats': async () =>
    (await import('../accept-delegated-seats')).assertHostAcceptsDelegatedSeats(),
  'sync/pot-git/hive-effect-authority.ts#requireHiveEffectAuthority': async () =>
    (await import('../../sync/pot-git/hive-effect-authority')).requireHiveEffectAuthority(null, SCOPE, ['v1-probe']),
  'sync/pot-git/hive-effect-authority.ts#loadHiveEffectAuthority': async () =>
    (await import('../../sync/pot-git/hive-effect-authority')).loadHiveEffectAuthority('w', 'v1-hive', SCOPE),
  'hive-membership-admission.ts#evaluateJoinAdmission': async () =>
    (await import('../../hive-membership-admission')).evaluateJoinAdmission(
      { workspaceId: 'w', potHomeSlug: 'v1-hive', joiner },
      fullHiveDeps as never,
    ),
};
for (const seam of V1_NOT_IN_SCOPE.flatMap((c) => c.seams)) {
  if (seam.endsWith('#module')) {
    INVOKE[seam] = async () => import(/* @vite-ignore */ path.join(libDir, seam.slice(0, -'#module'.length)));
  }
}

type Outcome = { threw: true; error: unknown } | { threw: false; value: unknown };
async function run(seam: string): Promise<Outcome> {
  try {
    return { threw: false, value: await INVOKE[seam]!() };
  } catch (error) {
    return { threw: true, error };
  }
}

/** A refusal is the v1 scope refusal (thrown) or, for the R-8 admission decision, a size-limit refuse. */
function isRefusal(seam: string, outcome: Outcome): boolean {
  if (outcome.threw) return isV1ScopeRefusal(outcome.error);
  if (seam.startsWith('hive-membership-admission.ts#')) {
    return (outcome.value as { outcome?: string; reason?: string }).outcome === 'refuse' &&
      (outcome.value as { reason?: string }).reason === 'hive_size_limit';
  }
  return false;
}

afterEach(() => {
  vi.unstubAllEnvs();
  setFlagOverridesForTest(null);
  vi.resetModules();
});

describe('SPEC-P001-NOT-IN-V1-DISABLED: every not-in-v1 capability refuses at its seams in the release build', () => {
  const registrySeams = V1_NOT_IN_SCOPE.flatMap((c) => c.seams).sort();

  it('every registry seam has exactly one invocation, and every invocation is a registry seam', () => {
    expect(Object.keys(INVOKE).sort()).toEqual(registrySeams);
    expect(registrySeams.length).toBeGreaterThanOrEqual(V1_NOT_IN_SCOPE.length);
  });

  for (const capability of V1_NOT_IN_SCOPE) {
    for (const seam of capability.seams) {
      it(`${capability.id}: ${seam} refuses`, async () => {
        vi.resetModules();
        vi.stubEnv(RELEASE_ENV, '1');
        const outcome = await run(seam);
        expect(isRefusal(seam, outcome), `${seam} did not refuse: ${JSON.stringify(outcome, (_k, v) => (v instanceof Error ? v.message : v))}`).toBe(true);
      }, 60_000);
    }

    for (const flag of capability.flags) {
      it(`${capability.id}: ${flag} has no enabled registration, even when forced ON by env and test override`, async () => {
        vi.stubEnv(RELEASE_ENV, '1');
        vi.stubEnv(flagEnvVarName(flag), '1');
        setFlagOverridesForTest({ [flag]: true } as never);
        expect(await getFlag(flag, 'v1-probe')).toBe(false);
      });
    }
  }

  it('control: outside the release build the seams run their own behaviour, not the v1 refusal', async () => {
    vi.stubEnv(RELEASE_ENV, '');
    const flip = await run('harness/git-sync/hive-git-mode.ts#setPotGitMode');
    expect(flip.threw && String((flip.error as Error).message)).toContain('reached the store');
    const seats = await run('p2p/accept-delegated-seats.ts#assertHostAcceptsDelegatedSeats');
    expect(seats.threw && (seats.error as { code?: string }).code).toBe('accept_delegated_seats_disabled');
    const fence = await run('sync/pot-git/hive-effect-authority.ts#requireHiveEffectAuthority');
    expect(fence.threw && (fence.error as Error).name).toBe('HiveEffectAuthorityError');
    const admission = await run('hive-membership-admission.ts#evaluateJoinAdmission');
    expect(admission).toEqual({ threw: false, value: { outcome: 'admit' } });
  }, 60_000);
});
