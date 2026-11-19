/**
 * P2P v1 scope contract — p2p-v1-core-release-2026-11-13 P-001.
 *
 * R-7 / SPEC-P001-EXCLUDED-SET-EQUAL: the commerce population is DERIVED here from the
 * tree (static value-import reachability from the commerce roots named in the scope
 * contract), never read from the not-in-v1 list it is compared against. Every derived
 * module must then refuse to load under the release-build configuration.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { COMMERCE_CORE_ROOT, COMMERCE_SCAN_ROOTS, deriveCommerceReachability, isCommerceSourcePath } from './commerce-reachability';
import {
  isV1ReleaseBuild,
  isV1ScopeRefusal,
  refuseCommerceLoadInV1ReleaseBuild,
  V1_COMMERCE_HOST_MODULES,
  V1_COMMERCE_MODULES,
  V1_COMMERCE_ROOTS,
  V1_HIVE_SIZE_LIMIT,
  V1_NOT_IN_SCOPE,
  V1ScopeRefusal,
} from './v1-scope-contract';
import { FLAG_DEFAULTS, flagEnvVarName, P2P_V1_RELEASE_BUILD_FORCED_OFF, resolveFlagFromEnv } from '@papercusp/flags';

/** The documented launch switch of the v1 release build (see the contract's header). */
const RELEASE_ENV = 'PAPERCUSP_FLAG_PAPERCUSP_P2P_V1_RELEASE_BUILD';

const here = path.dirname(fileURLToPath(import.meta.url));
const libDir = path.resolve(here, '../..');
const repoRoot = path.resolve(libDir, '../../..');

function readCommerceSources(directory: string, files: Map<string, string>): void {
  const absolute = path.join(repoRoot, directory);
  if (!fs.existsSync(absolute)) return;
  for (const entry of fs.readdirSync(absolute, { withFileTypes: true })) {
    const relative = `${directory}/${entry.name}`;
    if (entry.isSymbolicLink() && (isCommerceSourcePath(relative) || isCommerceSourcePath(`${relative}/_.ts`))) {
      throw new Error(`commerce scan cannot follow symlink ${relative}`);
    }
    if (entry.isDirectory() && isCommerceSourcePath(`${relative}/_.ts`)) {
      readCommerceSources(relative, files);
    } else if (entry.isFile() && isCommerceSourcePath(relative)) {
      files.set(relative, fs.readFileSync(path.join(repoRoot, relative), 'utf8'));
    }
  }
}

describe('P2P v1 release-build switch', () => {
  it('is on only when the documented launch variable is set', () => {
    expect(isV1ReleaseBuild({})).toBe(false);
    expect(isV1ReleaseBuild({ [RELEASE_ENV]: '0' })).toBe(false);
    expect(isV1ReleaseBuild({ [RELEASE_ENV]: '1' })).toBe(true);
    expect(isV1ReleaseBuild({ [RELEASE_ENV]: 'true' })).toBe(true);
  });

  it('the commerce load guard refuses only in the release build', () => {
    expect(() => refuseCommerceLoadInV1ReleaseBuild('p2p/microcharge.ts', {})).not.toThrow();
    let thrown: unknown;
    try {
      refuseCommerceLoadInV1ReleaseBuild('p2p/microcharge.ts', { [RELEASE_ENV]: '1' });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(V1ScopeRefusal);
    expect(isV1ScopeRefusal(thrown)).toBe(true);
    expect(isV1ScopeRefusal(new Error('wrapped', { cause: thrown }))).toBe(true);
    expect(isV1ScopeRefusal(new Error('unrelated'))).toBe(false);
  });
});

describe('R-7 SPEC-P001-EXCLUDED-SET-EQUAL: the release build cannot load a commerce module', () => {
  const files = new Map<string, string>();
  for (const root of COMMERCE_SCAN_ROOTS) readCommerceSources(root, files);
  const reach = deriveCommerceReachability(files, V1_COMMERCE_ROOTS);
  const prefix = `${COMMERCE_CORE_ROOT}/p2p/`;
  const libRelative = (file: string) => path.posix.relative(COMMERCE_CORE_ROOT, file);
  const derivedP2p = reach.filter(file => file.startsWith(prefix)).map(libRelative).sort();
  const derivedOutside = reach.filter(file => !file.startsWith(prefix)).map(libRelative).sort();

  it('R-7: the derived p2p commerce population equals the not-in-v1 commerce list', () => {
    expect(derivedP2p.length).toBeGreaterThan(V1_COMMERCE_ROOTS.length);
    for (const root of V1_COMMERCE_ROOTS) expect(derivedP2p).toContain(root);
    expect(derivedP2p).toEqual([...V1_COMMERCE_MODULES].sort());
  });

  it('R-7: only the declared commerce host island imports commerce outside lib/p2p, so no boot path reaches it', () => {
    expect(derivedOutside).toEqual([...V1_COMMERCE_HOST_MODULES].sort());
  });

  it('R-7 control: outside the release build a commerce root loads normally', async () => {
    vi.resetModules();
    vi.stubEnv(RELEASE_ENV, '');
    try {
      const root = await import(/* @vite-ignore */ path.join(libDir, 'p2p/microcharge.ts'));
      expect(Object.keys(root).length).toBeGreaterThan(0);
    } finally {
      vi.unstubAllEnvs();
      vi.resetModules();
    }
  }, 60_000);

  describe('under the release-build configuration', () => {
    afterEach(() => {
      vi.unstubAllEnvs();
      vi.resetModules();
    });

    for (const mod of [...V1_COMMERCE_MODULES, ...V1_COMMERCE_HOST_MODULES]) {
      it(`R-7: loading ${mod} is refused`, async () => {
        vi.resetModules();
        vi.stubEnv(RELEASE_ENV, '1');
        let outcome: 'loaded' | unknown = 'loaded';
        try {
          await import(/* @vite-ignore */ path.join(libDir, mod));
        } catch (error) {
          outcome = error;
        }
        expect(outcome, `${mod} loaded in the release build`).not.toBe('loaded');
        expect(isV1ScopeRefusal(outcome), `${mod} failed for a reason other than the v1 refusal: ${String(outcome)}`).toBe(true);
      }, 60_000);
    }
  });
});

describe('SPEC-P001-EXCLUDED-SET-EQUAL: the release build disables exactly the not-in-v1 population', () => {
  /** D-001's exclusions plus R-8's above-limit hive, pinned here; never read from the contract. */
  const PINNED_FAMILIES = [
    'above-limit-hive',
    'commerce',
    'delegated-seats',
    'git-bridge-live-flip',
    'owner-recovery',
    'protected-effect-fencing',
  ];
  const ALL_FLAGS = Object.keys(FLAG_DEFAULTS);
  /** Locked off: resolves OFF in the release build even when the flag is explicitly turned ON. */
  const lockedOffInRelease = (key: string) =>
    resolveFlagFromEnv(key, { [RELEASE_ENV]: '1', [flagEnvVarName(key)]: '1' }).value === false;
  const releaseDisabledFlags = ALL_FLAGS.filter(lockedOffInRelease).sort();

  it('the registry names exactly the pinned D-001 families', () => {
    expect(V1_NOT_IN_SCOPE.map((c) => c.id).sort()).toEqual(PINNED_FAMILIES);
  });

  it('the flags the release build locks off equal the registry flags, in both directions', () => {
    const registryFlags = [...new Set(V1_NOT_IN_SCOPE.flatMap((c) => c.flags))].sort();
    expect(registryFlags.length).toBeGreaterThan(0);
    expect(releaseDisabledFlags).toEqual(registryFlags);
    expect([...P2P_V1_RELEASE_BUILD_FORCED_OFF].sort()).toEqual(registryFlags);
  });

  it('the set disabled in the release build equals the pinned population', () => {
    const disabled = V1_NOT_IN_SCOPE
      .filter((c) => c.flags.length + c.seams.length > 0 && c.flags.every(lockedOffInRelease))
      .map((c) => c.id)
      .sort();
    expect(disabled).toEqual(PINNED_FAMILIES);
  });

  it('the release lock outranks an explicit ON and reports its source', () => {
    for (const key of P2P_V1_RELEASE_BUILD_FORCED_OFF) {
      expect(resolveFlagFromEnv(key, { [RELEASE_ENV]: '1', [flagEnvVarName(key)]: '1' }))
        .toEqual({ value: false, source: 'release-build-lock' });
    }
  });

  it('control: outside the release build no flag is locked off', () => {
    expect(ALL_FLAGS.filter((key) => resolveFlagFromEnv(key, { [flagEnvVarName(key)]: '1' }).value === false)).toEqual([]);
  });

  it('every registry seam names a module and export that exist in the tree', () => {
    for (const seam of V1_NOT_IN_SCOPE.flatMap((c) => c.seams)) {
      const [rel, name] = seam.split('#');
      const file = path.join(libDir, rel!);
      expect(fs.existsSync(file), `${seam}: module missing`).toBe(true);
      if (name !== 'module') {
        expect(fs.readFileSync(file, 'utf8'), `${seam}: export missing`).toMatch(
          new RegExp(`export (async )?function ${name}\\b`),
        );
      }
    }
  });
});

describe('R-8: a hive refuses a join beyond the v1 size limit (hermetic; the integration case is v1-core-acceptance)', () => {
  const N = V1_HIVE_SIZE_LIMIT;

  /** A roster owned by this test, so the observed count never comes from the code under test. */
  function roster() {
    const members = new Map<number, { githubUserId: number; devices: string[] }>();
    const deps = {
      getPolicy: async () => null,
      getHiveMember: async (_ws: string, _home: string, id: number) => (members.has(id) ? ({ githubUserId: id } as never) : null),
      upsertHiveMember: async (input: { githubUserId: number; deviceAttestations?: { device_pubkey: string }[] }) => {
        const devices = (input.deviceAttestations ?? []).map((d) => d.device_pubkey);
        members.set(input.githubUserId, { githubUserId: input.githubUserId, devices });
        return { githubUserId: input.githubUserId } as never;
      },
      countHiveMembers: async () => members.size,
      recordPendingJoin: async () => {
        throw new Error('open mode must never record a pending join');
      },
      refederateMemberEpochKeys: async () => {},
    };
    return { members, deps };
  }

  const joiner = (i: number, device = `dev-${i}`) => ({
    githubUserId: 7000 + i,
    githubUsername: `member-${i}`,
    deviceAttestations: [{ device_pubkey: device, gist_id: 'g', gist_url: 'u', device_label: 'd', created_at: 1, signature_by_device: 's' }],
  });

  afterEach(() => vi.unstubAllEnvs());

  it('R-8: joins up to N members succeed, the N+1th is refused, and a reconnect at N uses no slot', async () => {
    vi.stubEnv(RELEASE_ENV, '1');
    const { ownerAdmitOrPend } = await import('../../hive-membership-admission');
    const { members, deps } = roster();
    const home = 'v1-hive' as never;
    const admit = (i: number, device?: string) =>
      ownerAdmitOrPend({ workspaceId: 'w', potHomeSlug: home, joiner: joiner(i, device) }, deps as never);

    for (let i = 0; i < N; i++) {
      expect(await admit(i), `join ${i + 1} of ${N}`).toMatchObject({ action: 'admitted', reason: 'policy_admit' });
      expect(members.size).toBe(i + 1);
    }
    expect(await admit(N)).toMatchObject({ action: 'refuse', reason: 'hive_size_limit' });
    expect(members.size).toBe(N);
    expect(await admit(0, 'dev-0-second-device')).toMatchObject({ action: 'admitted', reason: 'already_member' });
    expect(members.size).toBe(N);
    expect(members.has(joiner(N).githubUserId)).toBe(false);
  });

  it('R-8 control: a dev build (no release flag) admits the N+1th joiner', async () => {
    vi.stubEnv(RELEASE_ENV, '');
    const { ownerAdmitOrPend } = await import('../../hive-membership-admission');
    const { members, deps } = roster();
    for (let i = 0; i <= N; i++) {
      await ownerAdmitOrPend({ workspaceId: 'w', potHomeSlug: 'v1-hive' as never, joiner: joiner(i) }, deps as never);
    }
    expect(members.size).toBe(N + 1);
  });
});
