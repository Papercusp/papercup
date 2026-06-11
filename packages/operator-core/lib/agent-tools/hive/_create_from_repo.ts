/**
 * _create_from_repo — the create-a-Hive-from-a-GitHub-URL composition
 * (hive-from-github-url-2026-06-11 P-006; D-001 the unit is the Hive).
 *
 * Composes the shipped primitives — nothing here is new machinery:
 *
 *   lookupHiveForRepo (P-005)            → join offer when the repo's Hive exists
 *   cloneGithubRepo (P-008 dogfood-1b)   → the member checkout (+ default branch)
 *   detectFromRepo → detectionToOverride → the member's blueprint, test-verified
 *   createHiveHarness (hive:create)      → the Hive home (eager keypair mint)
 *   harness:create { hive }              → the member, born INTO the Hive (D-010)
 *   registry github coords (P-002)       → fork-PR context + member_repos derivation
 *   publishCreatedHive (P-007)           → visibility-gated announce + bindings
 *
 * Failure discipline: every side effect before the publish step is undone
 * best-effort in reverse on a later failure (clone dir, hive home, member
 * registration) — a failed create must not leave a half-hive in the registry.
 * The publish step itself is best-effort and NEVER fails the create (its
 * outcome is reported; a re-publish rides discovery:set_hive / the boot tick).
 */

import { rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';

import {
  cloneGithubRepo,
  isCloneError,
  parseGithubUrl,
  type CloneResult,
} from '../../harness/clone-github';
import {
  lookupHiveForRepo,
  type RepoHiveLookup,
} from '../../harness/lookup-hive-for-repo';
import { loadHarnessRegistry, mutateHarnessRegistry } from '../../harness-registry';
import type { HiveVisibility } from '../../sync/hyperbee/hive-announce';
import { createHiveHarness, type CreateHiveResult } from './_create';
import {
  publishCreatedHive,
  republishHiveAfterMemberAdd,
  type PublishCreatedHiveOutcome,
} from '../../hive-publish-from-repo';

// ── Options / results ─────────────────────────────────────────────────────────

export interface CreateHiveFromRepoOpts {
  githubUrl: string;
  /** Base slug — default: the repo name (lowercased). Member = `<base>`, Hive home = `<base>-hive`.
   *  On collision the base auto-suffixes `-2`..`-9` (plan OQ-1: tools never stall on a prompt). */
  slug?: string;
  /** D-002: default 'public' (auto-publish). 'private' = zero external writes (D-003). */
  visibility?: HiveVisibility;
  shallow?: boolean;
  /** Run the detected test command once to verify it (D-023). Default true. */
  runTests?: boolean;
  testTimeoutMs?: number;
  /** Parent dir for the HIVE HOME folder (default ~/.papercusp/hives). */
  parentDir?: string;
  /**
   * P-008 create-anyway: proceed even when the lookup finds an existing
   * Hive/share for this repo (e.g. it has no join links yet). The result is
   * explicitly flagged `duplicateOf` — the dispute lands in the claim/supersede
   * flow (a duplicate's Cupboard row is also refused by the per-repo
   * uniqueness, which surfaces in publish.cupboard.errors).
   */
  force?: boolean;
  /**
   * P-009 into-hive mode: add the repo as a member of this EXISTING
   * `kind:'hive'` home instead of standing up a new hive. No new identity, no
   * new listing — the hive's existing listing is re-published with the new
   * member's repo coords (+ its Cupboard/local rows only, for public hives).
   */
  intoHive?: string;
  workspaceId: string;
}

export interface CreateHiveFromRepoCreated {
  hiveSlug: string;
  memberSlug: string;
  memberPath: string;
  defaultBranch?: string;
  githubRepositoryId?: number;
  detection?: unknown;
  /** P-008: set when `force` created past an existing hive/share — the
   *  duplicate marker the supersede flow resolves. */
  duplicateOf?: { kind: 'hive' | 'legacy_shared_harness'; hivePubkey?: string; source: string };
}

export type CreateHiveFromRepoResult =
  | { ok: false; error: string; message?: string; cleanup?: string[] }
  | { ok: true; existing: Exclude<RepoHiveLookup, { kind: 'none' | 'invalid_url' }> }
  | {
      ok: true;
      created: CreateHiveFromRepoCreated;
      /** Cupboard reachability at lookup time (D-004 degradation flag). */
      bindingUnverified: boolean;
      publish:
        | PublishCreatedHiveOutcome
        | { skipped: 'private' }
        | { skipped: 'unpublished_hive' };
    };

// ── Injectable seams (tests pass fakes; production uses the defaults) ─────────

export interface CreateHiveFromRepoDeps {
  lookup?: typeof lookupHiveForRepo;
  clone?: typeof cloneGithubRepo;
  /** Build + validate the member blueprint for a fresh clone. Returns the inline
   *  blueprint object, or an error string. Default: detectFromRepo →
   *  detectionToOverride → resolveAndValidate (the generate-from-repo spine);
   *  a repo that already carries .papercusp/blueprint.yaml passes ITS OWN
   *  blueprint through (harness:create rewrites the same bytes). */
  buildBlueprint?: (
    slug: string,
    repoPath: string,
    opts: { runTests: boolean; testTimeoutMs?: number },
  ) => Promise<
    | { ok: true; blueprint: Record<string, unknown>; detection?: unknown }
    | { ok: false; error: string }
  >;
  createHive?: typeof createHiveHarness;
  republish?: typeof republishHiveAfterMemberAdd;
  /** harness:create composition for the member (inline blueprint + hive membership). */
  createMember?: (args: {
    slug: string;
    path: string;
    blueprint: Record<string, unknown>;
    hive: string;
  }) => Promise<{ ok: boolean; error?: string }>;
  publish?: typeof publishCreatedHive;
  loadRegistry?: typeof loadHarnessRegistry;
  mutateRegistry?: typeof mutateHarnessRegistry;
  /** Remove a half-created hive home (reverse of createHiveHarness). Best-effort. */
  removeHiveHome?: (slug: string, workspaceId: string) => Promise<void>;
  rmDir?: (path: string) => Promise<void>;
}

async function defaultBuildBlueprint(
  slug: string,
  repoPath: string,
  opts: { runTests: boolean; testTimeoutMs?: number },
): Promise<
  | { ok: true; blueprint: Record<string, unknown>; detection?: unknown }
  | { ok: false; error: string }
> {
  const { detectFromRepo, detectionToOverride } = await import('../../blueprint/detect-from-repo');
  const { resolveAndValidate } = await import('../blueprint/_resolve');
  const det = detectFromRepo(repoPath, {
    runTests: opts.runTests,
    ...(opts.testTimeoutMs ? { testTimeoutMs: opts.testTimeoutMs } : {}),
  });
  if (det.skip) {
    // The clone already carries .papercusp/blueprint.yaml — it IS a papercusp
    // project; adopt its own blueprint (harness:create re-writes the same file).
    try {
      const own = parseYaml(readFileSync(join(repoPath, '.papercusp', 'blueprint.yaml'), 'utf8'));
      if (own && typeof own === 'object') {
        return { ok: true, blueprint: own as Record<string, unknown> };
      }
      return { ok: false, error: 'repo blueprint.yaml is not an object' };
    } catch (e) {
      return { ok: false, error: `repo blueprint.yaml unreadable: ${e instanceof Error ? e.message : e}` };
    }
  }
  const override = detectionToOverride(slug, det);
  const validation = resolveAndValidate(override);
  if (validation.parseError || !validation.ok) {
    return { ok: false, error: validation.parseError ?? 'generated blueprint failed validation' };
  }
  const { testCommand, toolchains, flags, notes } = det;
  return {
    ok: true,
    blueprint: override,
    detection: {
      testCommand: testCommand
        ? { command: testCommand.command, verified: testCommand.verified }
        : null,
      toolchains,
      flags,
      notes,
    },
  };
}

async function defaultCreateMember(args: {
  slug: string;
  path: string;
  blueprint: Record<string, unknown>;
  hive: string;
}): Promise<{ ok: boolean; error?: string }> {
  const { default: createTool } = await import('../harness/create');
  const res = (await createTool.handler(args as never, {} as never)) as {
    content: { text: string }[];
  };
  try {
    const parsed = JSON.parse(res.content[0].text) as { ok?: boolean; error?: string };
    return { ok: parsed.ok === true, ...(parsed.error ? { error: parsed.error } : {}) };
  } catch {
    return { ok: false, error: 'harness:create returned an unparseable response' };
  }
}

async function defaultRemoveHiveHome(slug: string, workspaceId: string): Promise<void> {
  // Reverse of createHiveHarness's registry/dir effects, best-effort: drop the
  // registry entry; the home dir is removed by the caller (it knows the path).
  await mutateHarnessRegistry(
    (reg) => ({ ...reg, projects: reg.projects.filter((p) => p.slug !== slug) }),
    workspaceId,
  );
}

// ── Slug derivation ────────────────────────────────────────────────────────────

function kebab(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/--+/g, '-');
}

/** member `<base>`, home `<base>-hive`; auto-suffix the base on collision (OQ-1). */
export function deriveSlugs(
  base: string,
  taken: ReadonlySet<string>,
): { memberSlug: string; hiveSlug: string } | null {
  for (let i = 0; i < 9; i++) {
    const candidate = i === 0 ? base : `${base}-${i + 1}`;
    const member = candidate;
    const hive = `${candidate}-hive`;
    if (!taken.has(member) && !taken.has(hive)) return { memberSlug: member, hiveSlug: hive };
  }
  return null;
}

// ── The composition ────────────────────────────────────────────────────────────

export async function createHiveFromRepo(
  opts: CreateHiveFromRepoOpts,
  deps: CreateHiveFromRepoDeps = {},
): Promise<CreateHiveFromRepoResult> {
  const lookup = deps.lookup ?? lookupHiveForRepo;
  const clone = deps.clone ?? cloneGithubRepo;
  const buildBlueprint = deps.buildBlueprint ?? defaultBuildBlueprint;
  const createHive = deps.createHive ?? createHiveHarness;
  const createMember = deps.createMember ?? defaultCreateMember;
  const publish = deps.publish ?? publishCreatedHive;
  const loadRegistry = deps.loadRegistry ?? loadHarnessRegistry;
  const mutateRegistry = deps.mutateRegistry ?? mutateHarnessRegistry;
  const removeHiveHome = deps.removeHiveHome ?? defaultRemoveHiveHome;
  const rmDir = deps.rmDir ?? (async (p: string) => rm(p, { recursive: true, force: true }));

  const visibility: HiveVisibility = opts.visibility ?? 'public';
  const runTests = opts.runTests !== false;

  const parsed = parseGithubUrl(opts.githubUrl);
  if (!parsed) return { ok: false, error: 'invalid_url', message: `not a GitHub URL: ${opts.githubUrl}` };

  // 1 — paste-time lookup (P-005). An existing Hive/legacy share → join offer,
  //     ZERO side effects.
  const found = await lookup(opts.githubUrl);
  if (found.kind === 'invalid_url') {
    return { ok: false, error: 'invalid_url', message: found.message };
  }
  let duplicateOf: CreateHiveFromRepoCreated['duplicateOf'];
  if (found.kind === 'hive' || found.kind === 'legacy_shared_harness') {
    if (!opts.force) return { ok: true, existing: found };
    // P-008 create-anyway: proceed, explicitly flagged for the supersede flow.
    duplicateOf = {
      kind: found.kind,
      ...(found.kind === 'hive' && found.hive.hivePubkey
        ? { hivePubkey: found.hive.hivePubkey }
        : {}),
      source: found.source,
    };
  }
  const bindingUnverified = found.kind === 'none' ? found.bindingUnverified : false;
  const repoId = found.coords.githubRepositoryId;
  const repoIsPrivate = found.coords.private;

  // 2 — slugs (collision-resilient, OQ-1) + into-hive validation (fail-fast,
  //     before any clone side effect).
  const reg = await loadRegistry(opts.workspaceId);
  const taken = new Set(reg.projects.map((p) => p.slug));
  const base = kebab(opts.slug ?? parsed.repo);
  if (!base) return { ok: false, error: 'invalid_slug', message: `cannot derive a slug from '${parsed.repo}'` };

  let memberSlug: string;
  let hiveSlug: string;
  const intoHive = opts.intoHive;
  if (intoHive) {
    const home = reg.projects.find((p) => p.slug === intoHive);
    if (!home || home.harness_kind !== 'hive') {
      return {
        ok: false,
        error: 'hive_not_found',
        message: `'${intoHive}' is not a kind:'hive' home in this workspace`,
      };
    }
    const member = deriveSlugs(base, taken); // reuse the suffixing; we only need the member half
    if (!member) {
      return { ok: false, error: 'slug_exhausted', message: `slugs ${base}..${base}-9 are all taken` };
    }
    memberSlug = member.memberSlug;
    hiveSlug = intoHive;
  } else {
    const slugs = deriveSlugs(base, taken);
    if (!slugs) {
      return { ok: false, error: 'slug_exhausted', message: `slugs ${base}..${base}-9 are all taken` };
    }
    memberSlug = slugs.memberSlug;
    hiveSlug = slugs.hiveSlug;
  }

  const cleanup: string[] = [];

  // 3 — clone the member checkout.
  const cloned = await clone(opts.githubUrl, { ...(opts.shallow !== undefined ? { shallow: opts.shallow } : {}) });
  if (isCloneError(cloned)) {
    return { ok: false, error: `clone_${cloned.code}`, message: cloned.message };
  }
  const memberPath = (cloned as CloneResult).path;
  const defaultBranch = (cloned as CloneResult).defaultBranch;

  const fail = async (error: string, message: string): Promise<CreateHiveFromRepoResult> => {
    return { ok: false, error, message, cleanup };
  };

  // 4 — the member blueprint (test-verified detection, or the repo's own).
  const bp = await buildBlueprint(memberSlug, memberPath, {
    runTests,
    ...(opts.testTimeoutMs ? { testTimeoutMs: opts.testTimeoutMs } : {}),
  });
  if (!bp.ok) {
    await rmDir(memberPath).catch(() => {});
    cleanup.push('clone removed');
    return fail('blueprint_failed', bp.error);
  }

  // 5 — the Hive home (eager identity mint; transactional inside). Skipped in
  //     into-hive mode — the home already exists.
  let hive: CreateHiveResult | null = null;
  if (!intoHive) {
    hive = await createHive({
      slug: hiveSlug,
      workspaceId: opts.workspaceId,
      ...(opts.parentDir ? { parentDir: opts.parentDir } : {}),
    });
    if (!hive.ok) {
      await rmDir(memberPath).catch(() => {});
      cleanup.push('clone removed');
      return fail(`hive_${hive.error ?? 'create_failed'}`, hive.message ?? 'hive create failed');
    }
  }

  // 6 — the member, born INTO the hive (harness:create { hive } — D-010 producer).
  const member = await createMember({
    slug: memberSlug,
    path: memberPath,
    blueprint: bp.blueprint,
    hive: hiveSlug,
  });
  if (!member.ok) {
    if (hive) {
      await removeHiveHome(hiveSlug, opts.workspaceId).catch(() => {});
      if (hive.path) await rmDir(hive.path).catch(() => {});
      cleanup.push('hive home removed');
    }
    await rmDir(memberPath).catch(() => {});
    cleanup.push('clone removed');
    return fail('member_create_failed', member.error ?? 'harness:create failed');
  }

  // 7 — stamp the upstream coords on the member entry (P-002): the fork-PR
  //     context + the member_repos announce derivation both read these.
  await mutateRegistry((cur) => {
    return {
      ...cur,
      projects: cur.projects.map((p) =>
        p.slug === memberSlug
          ? {
              ...p,
              github_remote: parsed.cloneUrl,
              ...(repoId !== undefined ? { github_repository_id: repoId } : {}),
              ...(defaultBranch ? { github_default_branch: defaultBranch } : {}),
            }
          : p,
      ),
    };
  }, opts.workspaceId).catch(() => {});

  // 8 — publish per visibility (P-007). Best-effort: NEVER fails the create.
  //     into-hive mode (P-009) re-publishes the EXISTING listing instead — new
  //     member rows only; an unpublished/private hive stays untouched.
  let publishOutcome:
    | PublishCreatedHiveOutcome
    | { skipped: 'private' }
    | { skipped: 'unpublished_hive' };
  if (intoHive) {
    const republish = deps.republish ?? republishHiveAfterMemberAdd;
    publishOutcome = await republish({
      workspaceId: opts.workspaceId,
      hiveSlug,
      onlyRepoIds: repoId !== undefined ? [repoId] : [],
      ...(repoIsPrivate !== undefined ? { repoIsPrivate } : {}),
    }).catch((e) => ({
      announced: false,
      cupboard: { attempted: false as const },
      error: e instanceof Error ? e.message : String(e),
    }));
  } else if (visibility === 'private') {
    publishOutcome = { skipped: 'private' }; // D-003: zero external writes
  } else {
    publishOutcome = await publish({
      workspaceId: opts.workspaceId,
      hiveSlug,
      title: `${parsed.owner}/${parsed.repo}`,
      description: `Hive for ${parsed.cloneUrl}`,
      visibility,
      ...(repoIsPrivate !== undefined ? { repoIsPrivate } : {}),
    }).catch((e) => ({
      announced: false,
      cupboard: { attempted: false as const },
      error: e instanceof Error ? e.message : String(e),
    }));
  }

  return {
    ok: true,
    created: {
      hiveSlug,
      memberSlug,
      memberPath,
      ...(defaultBranch ? { defaultBranch } : {}),
      ...(repoId !== undefined ? { githubRepositoryId: repoId } : {}),
      ...(bp.detection !== undefined ? { detection: bp.detection } : {}),
      ...(duplicateOf ? { duplicateOf } : {}),
    },
    bindingUnverified,
    publish: publishOutcome,
  };
}
