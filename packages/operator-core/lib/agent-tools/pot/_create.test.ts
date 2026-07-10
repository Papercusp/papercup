/**
 * createPotHarness (hive-tool-namespace-2026-06-08 P-009, D-005). PG-free: the
 * registry, schema scaffold, trigger materialization and blueprint resolution
 * are mocked; a real tmp dir backs the FS steps. Asserts the two load-bearing
 * claims: (1) the home-harness registry entry is stamped harness_kind:'hive'
 * (the gap harness:create leaves — without it resolvePot can't find the pot),
 * and (2) a failure mid-provision ROLLS BACK fully (no orphan registry entry or
 * dir).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

type Entry = { slug: string; path: string; harness_kind?: string; [k: string]: unknown };
let registry: { projects: Entry[] };
let scaffoldImpl: () => Promise<void>;
let tmpParent: string;
let ensureCalls: Array<[string, string]>;
let deletePotCalls: Array<[string, string]>;
let provisionCalls: Array<{ workspaceId: string; potSlug: string }>;
let mugHomeCalls: Array<{ workspaceId: string; potSlug: string; devicePubkey: string }>;
// WI-280: owner self-registration in hive_members at create — see the mock block below.
let upsertPotMemberCalls: unknown[];
// per-hive-git-and-release-gate-2026-06-29: the mock blueprint's knobs + output sink are
// per-test configurable so we can exercise BOTH the repo-less non-coding path (default)
// and the coding-pot repo-enforcement path (the D-002 guard + fresh-repo self_repo).
let blueprintKnobs: Record<string, unknown>;
let blueprintOutput: { kind: string } | undefined;
// P-009: the self_repo-home pipeline seeds (git-sync + green-checkpoint) are mocked — their
// own behavior is pinned in git-sync-routine.test.ts / seed-pot-release-routines.test.ts.
let gitSyncSeedCalls: Array<{ installSlug: string }>;
let releaseSeedCalls: Array<{ potSlug: string }>;
// EI-3388: capture what `operatorResolveExtends` was called with, so we can assert
// createPotHarness threads an existingPath repo's `.papercusp/blueprints` in as a
// local resolver tier (mirroring harness:create's `path` -> localDirs pattern) instead
// of the old unconditional `localDirs: []`.
let resolveExtendsCalls: Array<{ localDirs?: string[] }>;

beforeEach(() => {
  vi.resetModules();
  registry = { projects: [] };
  scaffoldImpl = async () => {};
  tmpParent = mkdtempSync(join(tmpdir(), 'pot-create-test-'));
  ensureCalls = [];
  deletePotCalls = [];
  provisionCalls = [];
  mugHomeCalls = [];
  // Default: a NON-CODING, repo-less pot (output.kind:'artifacts'). The D-002 repo guard
  // only fires for a repo-COMMIT output blueprint that would be repo-less, so this keeps the
  // generic create-flow cases repo-less. The coding-path cases override these two.
  blueprintKnobs = { requiresRepo: false };
  blueprintOutput = { kind: 'artifacts' };
  gitSyncSeedCalls = [];
  releaseSeedCalls = [];
  resolveExtendsCalls = [];

  vi.doMock('../../blueprint/installed-blueprints', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../../blueprint/installed-blueprints')>();
    return {
      ...actual,
      operatorResolveExtends: (opts: { localDirs?: string[] } = {}) => {
        resolveExtendsCalls.push(opts);
        return actual.operatorResolveExtends(opts);
      },
    };
  });
  vi.doMock('../../harness-registry', () => ({
    loadHarnessRegistry: async () => ({ projects: registry.projects.map((p) => ({ ...p })) }),
    saveHarnessRegistry: async (reg: { projects: Entry[] }) => {
      registry.projects = reg.projects.map((p) => ({ ...p }));
    },
  }));
  vi.doMock('../../scaffold-harness-schema', () => ({
    scaffoldHarnessSchema: () => scaffoldImpl(),
    dropHarnessSchema: async () => {},
  }));
  vi.doMock('../../blueprint/materialize-triggers', () => ({ materializeBlueprintTriggers: async () => [] }));
  vi.doMock('../blueprint/_resolve', () => ({
    // Kind-aware so the P-019 not-a-pot guard can be exercised: the chosen blueprint
    // id rides `childObj.extends`; `research` resolves to kind:'harness', everything
    // else (the default pot / generic-pot) to kind:'pot'.
    resolveAndValidate: (childObj: { extends?: string }) => ({
      ok: true,
      parseError: null,
      blueprint: {
        id: 'hive',
        kind: childObj?.extends === 'research' ? 'harness' : 'pot',
        version: '0',
        knobs: blueprintKnobs,
        ...(blueprintOutput ? { output: blueprintOutput } : {}),
        dependencies: {},
      },
    }),
  }));
  // per-pot-git-and-release-gate P-003/P-004: the fresh-repo finalize (commit + branch +
  // remote publish) is mocked — its own behavior is pinned in pot-repo-init.test.ts; here
  // we only assert createPotHarness CALLS it for a fresh coding pot and records self_repo.
  vi.doMock('../../harness/pot-repo-init', () => ({
    commitInitialPotRepo: async (o: { branch?: string }) => ({ committed: true, branch: o.branch ?? 'staging' }),
    publishPotRepo: async () => ({ mode: 'local-only', pushed: false, reason: 'mocked' }),
  }));
  // P-009: the self_repo-home pipeline seeds — record the calls; behavior pinned elsewhere.
  vi.doMock('../../harness/git-sync/git-sync-routine', () => ({
    seedGitSyncRoutineForMember: async (o: { installSlug: string }) => {
      gitSyncSeedCalls.push({ installSlug: o.installSlug });
      return { seeded: true };
    },
  }));
  vi.doMock('../../harness/routines/seed-pot-release-routines', () => ({
    seedPotReleaseRoutines: async (o: { potSlug: string }) => {
      releaseSeedCalls.push({ potSlug: o.potSlug });
      return { seeded: false, reason: 'flag_off', undo: async () => {} };
    },
  }));
  // The first-class Pot identity mint (PG + keychain) is mocked — this test is
  // PG-free; the keypair->store->topic seam is covered by its own integration test.
  vi.doMock('../../pot-identity', () => ({
    ensurePotIdentity: async (ws: string, slug: string) => {
      ensureCalls.push([ws, slug]);
      return { record: {}, created: true };
    },
  }));
  vi.doMock('../../pot-store', () => ({
    deletePot: async (ws: string, slug: string) => {
      deletePotCalls.push([ws, slug]);
      return true;
    },
  }));
  // learning-packs P-005: the seed step is mocked (its own behavior is pinned in
  // lib/learning-packs/seed.test.ts); the flag gate resolves ON deterministically.
  vi.doMock('@papercusp/flags/server', () => ({ getFlag: async () => true, onFlagChange: () => () => {} }));
  vi.doMock('../../learning-packs/load-packs', () => ({
    loadLearningPack: async () => ({
      pack: {
        manifest: { id: 'papercusp-default', title: 'T', description: 'd', version: '1.0.0' },
        items: [{ id: 'a', title: 'A', kind: 'feedback', appliesTo: ['any'], text: 'a' }],
      },
      source: 'builtin',
      warnings: [],
    }),
  }));
  vi.doMock('../../learning-packs/seed', () => ({
    shapesFromDetection: () => undefined,
    seedPackIntoPot: async () => ({
      ok: true,
      packId: 'papercusp-default',
      packVersion: '1.0.0',
      seeded: 1,
      ids: ['mem-1'],
      skippedByShape: 0,
      failed: 0,
      undo: async () => {},
    }),
  }));
  // P-020: the per-pot learning-loop provision step is mocked (its own behavior is
  // pinned in lib/pot/provision-learning-loop.test.ts). It ignores the sql it's
  // handed, so the real getOrgPg flows through untouched (the wake-defaults step
  // shares that pool). The flag gate resolves ON via the @papercusp/flags/server
  // mock above.
  vi.doMock('../../pot/provision-learning-loop', () => ({
    provisionPotLearningLoop: async (input: { workspaceId: string; potSlug: string }) => {
      provisionCalls.push({ workspaceId: input.workspaceId, potSlug: input.potSlug });
      return { ok: true, potSlug: input.potSlug, gymAutoloop: true, scoutRoutine: true, scoutMaxCostUsd: 0.5, undo: async () => {} };
    },
  }));
  // P-021 (domain-generic-pot): the mug-home-pubkey record step is mocked (its
  // own behavior is pinned in pot-settings-store + steering-lease tests). Without
  // this the real setMugHomePubkey → setPotSetting → getPotBySlug hits the
  // pot-store mock above (which omits getPotBySlug) and console.warns, which
  // vitest-fail-on-console treats as a failure.
  vi.doMock('../../pot-settings-store', () => ({
    setMugHomePubkey: async (ws: string, slug: string, pk: string) => {
      mugHomeCalls.push({ workspaceId: ws, potSlug: slug, devicePubkey: pk });
    },
    deletePotSetting: async () => true,
    MUG_HOME_PUBKEY_SETTING_KEY: 'mug-home-pubkey',
  }));
  // P-021: a deterministic self identity so the mug-home record step fires (the
  // real resolveUsageActor reads the OS keychain/gh and is env-dependent).
  vi.doMock('../../harness/usage-actor', () => ({
    resolveUsageActor: async () => ({ githubUserId: 1, devicePubkey: 'pk-creator' }),
  }));
  // WI-280: the owner self-registration step (createPotHarness § "self-register the
  // OWNER in hive_members at create") ALSO resolves the local gh identity + calls
  // upsertPotMember — both real (env-dependent: real gh CLI / OS keychain, real PG)
  // in production, so both are mocked here too (mirroring the mug-home-pubkey /
  // usage-actor mock immediately above) instead of relying on them silently no-op'ing
  // in a PG-free sandbox, which would leave this fix completely untested.
  upsertPotMemberCalls = [];
  vi.doMock('../../identity/resolve-local-github-identity', () => ({
    resolveLocalGithubIdentity: async () => ({ kind: 'ok', token: 't', githubUserId: 1, githubLogin: 'owner-login' }),
  }));
  vi.doMock('../../pot-membership-store', () => ({
    upsertPotMember: async (input: unknown) => {
      upsertPotMemberCalls.push(input as never);
      return {};
    },
  }));
});

afterEach(() => {
  vi.doUnmock('../../harness-registry');
  vi.doUnmock('../../scaffold-harness-schema');
  vi.doUnmock('../../blueprint/materialize-triggers');
  vi.doUnmock('../blueprint/_resolve');
  vi.doUnmock('../../pot-identity');
  vi.doUnmock('../../pot-store');
  vi.doUnmock('@papercusp/flags/server');
  vi.doUnmock('../../learning-packs/load-packs');
  vi.doUnmock('../../learning-packs/seed');
  vi.doUnmock('../../pot/provision-learning-loop');
  vi.doUnmock('../../pot-settings-store');
  vi.doUnmock('../../harness/usage-actor');
  vi.doUnmock('../../harness/pot-repo-init');
  vi.doUnmock('../../harness/git-sync/git-sync-routine');
  vi.doUnmock('../../harness/routines/seed-pot-release-routines');
  vi.doUnmock('../../identity/resolve-local-github-identity');
  vi.doUnmock('../../pot-membership-store');
  try {
    rmSync(tmpParent, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe('createPotHarness', () => {
  it('provisions a home harness stamped harness_kind:pot (no wake)', async () => {
    const { createPotHarness } = await import('./_create');
    const res = await createPotHarness({ slug: 'test-pot', workspaceId: 'default', parentDir: tmpParent });
    expect(res.ok).toBe(true);
    expect(res.waked).toBe(false);
    const entry = registry.projects.find((p) => p.slug === 'test-pot');
    expect(entry).toBeTruthy();
    expect(entry?.harness_kind).toBe('hive'); // the gap-closer
    expect(existsSync(join(res.path!, '.papercusp', 'blueprint.yaml'))).toBe(true);
    // The Pot's first-class identity (Ed25519 keypair + entity row) is minted as
    // part of create (shared-pot-federation P-002).
    expect(ensureCalls).toEqual([['default', 'test-pot']]);
    // learning-packs P-005: the default pack seeded into the new pot's pool.
    expect(res.seededLearnings).toEqual({ packId: 'papercusp-default', packVersion: '1.0.0', count: 1 });
    // per-pot-learning-loops P-020: the per-pot loop is provisioned, keyed to the
    // pot's OWN slug, and reported in the result.
    expect(provisionCalls).toEqual([{ workspaceId: 'default', potSlug: 'test-pot' }]);
    // domain-generic-pot P-021: the creating node IS the local Mug home — its
    // device pubkey is recorded as the pot's mug-home-pubkey (the split-brain guard).
    expect(mugHomeCalls).toEqual([{ workspaceId: 'default', potSlug: 'test-pot', devicePubkey: 'pk-creator' }]);
    expect(res.provisionedLoop).toEqual({ gymAutoloop: true, scoutRoutine: true, scoutMaxCostUsd: 0.5 });
  });

  // WI-280: "C-001 re-key mints 0 epoch keys on the owner in the live from-repo flow"
  // — root cause #1 was that NOTHING registered the owner in `hive_members` at create,
  // so a subsequent member-remove/go-private boundary's remaining-member wrap-set was
  // empty and the re-key couldn't advance (CUR_EPOCH stuck at -1). The fix (this file,
  // the "self-register the OWNER in hive_members at create" block) already landed and
  // was live-witnessed once by a prior agent, but had NO regression test — a refactor
  // could silently drop it with nothing to catch it. This pins it.
  it('WI-280: self-registers the OWNER in hive_members at create (upsertPotMember called with the creator device pubkey)', async () => {
    const { createPotHarness } = await import('./_create');
    const res = await createPotHarness({ slug: 'wi280-pot', workspaceId: 'default', parentDir: tmpParent });
    expect(res.ok).toBe(true);
    expect(upsertPotMemberCalls).toEqual([
      expect.objectContaining({
        workspaceId: 'default',
        potHomeSlug: 'wi280-pot',
        githubUserId: 1,
        githubUsername: 'owner-login',
        bindingStatus: 'verified',
        deviceAttestations: [expect.objectContaining({ device_pubkey: 'pk-creator' })],
      }),
    ]);
  });

  it('provisionLearningLoop:false skips the per-pot loop entirely', async () => {
    const { createPotHarness } = await import('./_create');
    const res = await createPotHarness({
      slug: 'no-loop-pot',
      workspaceId: 'default',
      parentDir: tmpParent,
      provisionLearningLoop: false,
    });
    expect(res.ok).toBe(true);
    expect(provisionCalls).toEqual([]);
    expect(res.provisionedLoop).toBeUndefined();
  });

  it('learningPack: null skips seeding entirely', async () => {
    const { createPotHarness } = await import('./_create');
    const res = await createPotHarness({
      slug: 'no-seed-pot',
      workspaceId: 'default',
      parentDir: tmpParent,
      learningPack: null,
    });
    expect(res.ok).toBe(true);
    expect(res.seededLearnings).toBeUndefined();
  });

  it('rolls back fully when schema provisioning fails — no orphan entry or dir', async () => {
    scaffoldImpl = async () => {
      throw new Error('schema boom');
    };
    const { createPotHarness } = await import('./_create');
    const res = await createPotHarness({ slug: 'rollback-pot', workspaceId: 'default', parentDir: tmpParent });
    expect(res.ok).toBe(false);
    expect(res.error).toBe('create_failed');
    expect(registry.projects.find((p) => p.slug === 'rollback-pot')).toBeUndefined();
    expect(existsSync(join(tmpParent, 'rollback-pot'))).toBe(false);
    // Identity was minted (step 2b) then rolled back (deletePot) when the later
    // schema step failed — no orphan hives row.
    expect(ensureCalls).toEqual([['default', 'rollback-pot']]);
    expect(deletePotCalls).toEqual([['default', 'rollback-pot']]);
  });

  it('refuses a duplicate slug before any side effect', async () => {
    registry.projects.push({ slug: 'dup', path: '/x', harness_kind: 'hive' });
    const { createPotHarness } = await import('./_create');
    const res = await createPotHarness({ slug: 'dup', workspaceId: 'default', parentDir: tmpParent });
    expect(res.ok).toBe(false);
    expect(res.error).toBe('slug_exists');
    expect(existsSync(join(tmpParent, 'dup'))).toBe(false);
    expect(ensureCalls).toEqual([]); // no identity minted on the early reject
  });

  it('rejects a non-pot blueprint (kind:harness) + lists the pot templates, before any side effect (P-019)', async () => {
    const { createPotHarness } = await import('./_create');
    // `research` is a real built-in blueprint but kind:'harness' — a pot needs kind:'hive'.
    const res = await createPotHarness({
      slug: 'wrong-kind',
      workspaceId: 'default',
      parentDir: tmpParent,
      blueprintId: 'research',
    });
    expect(res.ok).toBe(false);
    expect(res.error).toBe('not_a_hive_blueprint');
    expect(res.message).toMatch(/work/); // surfaces the available pot templates
    expect(existsSync(join(tmpParent, 'wrong-kind'))).toBe(false); // no side effect
    expect(ensureCalls).toEqual([]); // rejected before identity mint
  });

  // ── per-pot-git-and-release-gate: coding-pot repo enforcement (P-002/P-003/P-004) ──
  describe('coding-pot repo enforcement', () => {
    it('rejects a repo-less coding pot (output.kind:repo-commit + requiresRepo:false + no existingPath) → hive_requires_repo', async () => {
      blueprintOutput = { kind: 'repo-commit' }; // coding profile (the independent signal)
      blueprintKnobs = { requiresRepo: false }; // …but no fresh repo would be initialized
      const { createPotHarness } = await import('./_create');
      const res = await createPotHarness({ slug: 'repoless-coding', workspaceId: 'default', parentDir: tmpParent });
      expect(res.ok).toBe(false);
      expect(res.error).toBe('hive_requires_repo');
      // Rejected before any side effect — no dir, no registry entry, no identity mint.
      expect(existsSync(join(tmpParent, 'repoless-coding'))).toBe(false);
      expect(registry.projects.find((p) => p.slug === 'repoless-coding')).toBeUndefined();
      expect(ensureCalls).toEqual([]);
    });

    it('a non-coding pot (output.kind:artifacts) may be repo-less — no guard, no self_repo, no repoInit', async () => {
      blueprintOutput = { kind: 'artifacts' };
      blueprintKnobs = { requiresRepo: false };
      const { createPotHarness } = await import('./_create');
      const res = await createPotHarness({ slug: 'workpot', workspaceId: 'default', parentDir: tmpParent });
      expect(res.ok).toBe(true);
      const entry = registry.projects.find((p) => p.slug === 'workpot');
      expect(entry?.self_repo).toBeUndefined(); // repo-less → unmarked (git-sync-ineligible by design)
      expect(existsSync(join(res.path!, '.git'))).toBe(false); // no git repo
      expect(res.repoInit).toBeUndefined(); // fresh-repo finalize never runs
      // P-009: a repo-less (non-coding) home seeds NO pipeline routines.
      expect(gitSyncSeedCalls).toEqual([]);
      expect(releaseSeedCalls).toEqual([]);
    });

    it('a fresh coding pot (requiresRepo:true) gets a repo, self_repo:true, and repoInit on staging', async () => {
      blueprintOutput = { kind: 'repo-commit' };
      blueprintKnobs = { requiresRepo: true };
      const { createPotHarness } = await import('./_create');
      const res = await createPotHarness({ slug: 'codingpot', workspaceId: 'default', parentDir: tmpParent });
      expect(res.ok).toBe(true);
      const entry = registry.projects.find((p) => p.slug === 'codingpot');
      expect(entry?.self_repo).toBe(true); // git-sync eligible — no 'hive_home' origin-freeze (2026-06-20 incident)
      expect(existsSync(join(res.path!, '.git'))).toBe(true); // real git init ran (initLocalHarnessDir)
      expect(res.repoInit?.branch).toBe('staging');
      expect(res.repoInit?.committed).toBe(true);
      expect(res.repoInit?.remoteMode).toBe('local-only'); // publish mocked → local-only
      expect(res.repoInit?.remoteReason).toBe('mocked'); // publish WAS called (default repoRemote:'auto')
      // P-009: the self_repo home seeds git-sync (staging accumulates) + the green-checkpoint.
      expect(gitSyncSeedCalls.map((c) => c.installSlug)).toContain('codingpot');
      expect(releaseSeedCalls.map((c) => c.potSlug)).toContain('codingpot');
    });

    it('repoRemote:local-only skips the remote publish entirely (stays local-only, no publish call)', async () => {
      blueprintOutput = { kind: 'repo-commit' };
      blueprintKnobs = { requiresRepo: true };
      const { createPotHarness } = await import('./_create');
      const res = await createPotHarness({
        slug: 'localonly-pot',
        workspaceId: 'default',
        parentDir: tmpParent,
        repoRemote: 'local-only',
      });
      expect(res.ok).toBe(true);
      expect(res.repoInit?.remoteMode).toBe('local-only');
      // reason 'mocked' only appears when publishPotRepo is CALLED; local-only never calls it.
      expect(res.repoInit?.remoteReason).toBeUndefined();
    });
  });

  // ── LINK-EXISTING mode ("every created Pot is a pot") ──────────────────────
  describe('existingPath: link an existing repo in place', () => {
    it('registers harness_kind:pot at the EXACT existing path; no sibling dir; blueprint into <existingPath>/.papercusp', async () => {
      // An existing repo dir to link in place (NOT under tmpParent, so we can also
      // assert no sibling dir is created at parentDir/slug).
      const existing = mkdtempSync(join(tmpdir(), 'pot-link-existing-'));
      try {
        const { createPotHarness } = await import('./_create');
        const res = await createPotHarness({
          slug: 'linked-pot',
          workspaceId: 'default',
          parentDir: tmpParent,
          existingPath: existing,
        });
        expect(res.ok).toBe(true);
        // The pot home is the existing path exactly (resolved) — not a fresh dir.
        expect(res.path).toBe(existing);
        const entry = registry.projects.find((p) => p.slug === 'linked-pot');
        expect(entry).toBeTruthy();
        expect(entry?.harness_kind).toBe('hive');
        expect(entry?.path).toBe(existing);
        // No sibling dir minted under parentDir.
        expect(existsSync(join(tmpParent, 'linked-pot'))).toBe(false);
        // Blueprint written INTO the existing dir.
        expect(existsSync(join(existing, '.papercusp', 'blueprint.yaml'))).toBe(true);
        // Identity minted, loop provisioned — the rest of create is unchanged.
        expect(ensureCalls).toEqual([['default', 'linked-pot']]);
        expect(provisionCalls).toEqual([{ workspaceId: 'default', potSlug: 'linked-pot' }]);
        // EI-3388: the blueprint resolver was given the linked repo's own
        // .papercusp/blueprints as a local tier, so a custom blueprint authored
        // there (e.g. a pot-scoped `extends` parent) resolves without a manual
        // copy into the global ~/.papercusp/blueprints installed tier.
        expect(resolveExtendsCalls).toEqual([{ localDirs: [join(existing, '.papercusp', 'blueprints')] }]);
      } finally {
        rmSync(existing, { recursive: true, force: true });
      }
    });

    it('a forced rollback NEVER deletes the existing dir (link-mode dir undo is a no-op)', async () => {
      // Force a later step (schema scaffold) to throw → rollback runs.
      scaffoldImpl = async () => {
        throw new Error('schema boom');
      };
      const existing = mkdtempSync(join(tmpdir(), 'pot-link-rollback-'));
      try {
        const { createPotHarness } = await import('./_create');
        const res = await createPotHarness({
          slug: 'rollback-link-pot',
          workspaceId: 'default',
          parentDir: tmpParent,
          existingPath: existing,
        });
        expect(res.ok).toBe(false);
        expect(res.error).toBe('create_failed');
        // The user's existing dir MUST still be there after rollback.
        expect(existsSync(existing)).toBe(true);
        // Registry undo ran — no orphan entry.
        expect(registry.projects.find((p) => p.slug === 'rollback-link-pot')).toBeUndefined();
        // Identity undo ran (deletePot) — same as the fresh-dir rollback.
        expect(deletePotCalls).toEqual([['default', 'rollback-link-pot']]);
      } finally {
        rmSync(existing, { recursive: true, force: true });
      }
    });

    it('existingPath that does not exist → path_not_found, before any side effect', async () => {
      const missing = join(tmpdir(), 'pot-link-does-not-exist-xyz', 'nope');
      expect(existsSync(missing)).toBe(false);
      const { createPotHarness } = await import('./_create');
      const res = await createPotHarness({
        slug: 'missing-path-pot',
        workspaceId: 'default',
        existingPath: missing,
      });
      expect(res.ok).toBe(false);
      expect(res.error).toBe('path_not_found');
      expect(registry.projects.find((p) => p.slug === 'missing-path-pot')).toBeUndefined();
      expect(ensureCalls).toEqual([]); // rejected before identity mint
      // Blueprint resolution runs before the path-exists guard (harmless — building
      // a resolver does no I/O), and still derives localDirs from existingPath.
      expect(resolveExtendsCalls).toEqual([{ localDirs: [join(missing, '.papercusp', 'blueprints')] }]);
    });

    it('the fresh-dir path (no existingPath) is unchanged', async () => {
      const { createPotHarness } = await import('./_create');
      const res = await createPotHarness({ slug: 'fresh-pot', workspaceId: 'default', parentDir: tmpParent });
      expect(res.ok).toBe(true);
      // A fresh dir was created under parentDir/slug.
      expect(res.path).toBe(join(tmpParent, 'fresh-pot'));
      expect(readdirSync(tmpParent)).toContain('fresh-pot');
      expect(existsSync(join(res.path!, '.papercusp', 'blueprint.yaml'))).toBe(true);
      // No existingPath -> no repo context for the resolver -> localDirs stays [] (unchanged).
      expect(resolveExtendsCalls).toEqual([{ localDirs: [] }]);
    });

    // WI-3646: a pre-existing harness registry entry that already lives at the
    // linked path never got `hive_slug` backfilled onto ITS OWN entry — only the
    // JOIN path (_create_from_repo.ts) writes that field. Without it, that harness
    // never resolves its swarm binding (potHomeSlugForHarness/resolvePotSwarmBinding
    // return null) and silently never federates with the pot it now belongs to
    // (confirmed live: rig-a's 'hello-world' harness vs its own 'hello-world-pot').
    it('backfills hive_slug onto a pre-existing sibling harness registry entry at the same path', async () => {
      const existing = mkdtempSync(join(tmpdir(), 'pot-link-backfill-'));
      try {
        // A harness ALREADY registered at this path, with no hive_slug (mirrors
        // rig-a's 'hello-world' before 'hello-world-pot' is created via existingPath).
        registry.projects.push({ slug: 'hello-world', path: existing, harness_kind: 'coding' });
        const { createPotHarness } = await import('./_create');
        const res = await createPotHarness({
          slug: 'hello-world-pot',
          workspaceId: 'default',
          parentDir: tmpParent,
          existingPath: existing,
        });
        expect(res.ok).toBe(true);
        const sibling = registry.projects.find((p) => p.slug === 'hello-world');
        expect(sibling?.hive_slug).toBe('hello-world-pot');
        // The new pot-home entry itself needs no hive_slug (it IS the home).
        const home = registry.projects.find((p) => p.slug === 'hello-world-pot');
        expect(home?.hive_slug).toBeUndefined();
      } finally {
        rmSync(existing, { recursive: true, force: true });
      }
    });

    it('does NOT backfill a sibling entry at a DIFFERENT path (only same-path siblings)', async () => {
      const existing = mkdtempSync(join(tmpdir(), 'pot-link-backfill-2-'));
      const elsewhere = mkdtempSync(join(tmpdir(), 'pot-link-elsewhere-'));
      try {
        registry.projects.push({ slug: 'unrelated', path: elsewhere, harness_kind: 'coding' });
        const { createPotHarness } = await import('./_create');
        const res = await createPotHarness({
          slug: 'another-pot',
          workspaceId: 'default',
          parentDir: tmpParent,
          existingPath: existing,
        });
        expect(res.ok).toBe(true);
        expect(registry.projects.find((p) => p.slug === 'unrelated')?.hive_slug).toBeUndefined();
      } finally {
        rmSync(existing, { recursive: true, force: true });
        rmSync(elsewhere, { recursive: true, force: true });
      }
    });

    it('a forced rollback undoes the hive_slug backfill on the sibling entry', async () => {
      scaffoldImpl = async () => {
        throw new Error('schema boom');
      };
      const existing = mkdtempSync(join(tmpdir(), 'pot-link-backfill-rollback-'));
      try {
        registry.projects.push({ slug: 'hello-world', path: existing, harness_kind: 'coding' });
        const { createPotHarness } = await import('./_create');
        const res = await createPotHarness({
          slug: 'hello-world-pot',
          workspaceId: 'default',
          parentDir: tmpParent,
          existingPath: existing,
        });
        expect(res.ok).toBe(false);
        // Sibling's hive_slug was rolled back (undo ran), and it's otherwise intact.
        const sibling = registry.projects.find((p) => p.slug === 'hello-world');
        expect(sibling).toBeTruthy();
        expect(sibling?.hive_slug).toBeUndefined();
      } finally {
        rmSync(existing, { recursive: true, force: true });
      }
    });
  });
});
