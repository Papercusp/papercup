/**
 * harness:generate-from-repo — kind #1 harness creation (P-009 / D-023).
 *
 * Given an EXISTING git repo, deterministically infer an `extends: coding-factory`
 * blueprint override (cheap; no LLM — the gym optimizes the seed later, D-022),
 * validate it through the frozen engine, then COMPOSE `harness:create` to
 * scaffold the harness. A successfully created coding checkout is also wired
 * into the existing `system:git-sync` spine: local origin/default-branch
 * coordinates are persisted on the registry entry, then the standard seeder
 * creates its active, deterministically staggered routine. The detection
 * (`detectFromRepo`) covers the four D-023
 * signals — test command (VERIFIED by running it once), the tool set, the
 * monorepo/frontend structural flags, and a harvest of AGENTS.md/CLAUDE.md/
 * TESTING.md into the override.
 *
 * Skips (returns `{ ok:true, skipped:true }`) when the repo already carries a
 * `.papercusp/blueprint.yaml`. `dryRun` returns the generated + validated
 * override WITHOUT creating the harness — preview the seed before committing.
 *
 * harness-blueprint-orchestration-2026-06-03 P-009 / B3. Composes — does not
 * rewrite — `harness:create` (per su-adb1b); consumes the frozen
 * `resolveAndValidate` + `@papercusp/orchestrator/blueprint`.
 */
import { z } from 'zod';
import { existsSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { stringify as stringifyYaml } from 'yaml';
import { defineTool } from '@papercusp/agent-mcp';
import { COORD_ROLES } from '../coordination/roles';
import { resolveAndValidate } from '../blueprint/_resolve';
import {
  detectFromRepo,
  detectionToOverride,
  DEFAULT_TEST_TIMEOUT_MS,
  type DetectionResult,
} from '../../blueprint/detect-from-repo';
import { resolveConcreteWorkspaceId } from '../../workspace-registry';
import createTool from './create';

const text = (payload: Record<string, unknown>) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(payload) }],
});

/** Detection summary for the tool response — omits the bulky harvested doc bodies (those live in the blueprint). */
function summarizeDetection(det: DetectionResult) {
  return {
    repoPath: det.repoPath,
    isGitRepo: det.isGitRepo,
    testCommand: det.testCommand
      ? {
          command: det.testCommand.command,
          source: det.testCommand.source,
          verified: det.testCommand.verified,
          exitCode: det.testCommand.exitCode,
          timedOut: det.testCommand.timedOut ?? false,
          durationMs: det.testCommand.durationMs,
        }
      : null,
    toolchains: det.toolchains,
    packageManager: det.packageManager,
    flags: det.flags,
    harvestedDocs: det.harvestedDocs.map((d) => ({ file: d.file, bytes: d.bytes, truncated: d.truncated })),
    notes: det.notes,
  };
}

export default defineTool({
  name: 'harness:generate-from-repo',
  description:
    'Generate a coding harness from an EXISTING git repo (kind #1 creation). Deterministically detects the test command (and VERIFIES it by running it once), the toolchain, monorepo/frontend flags, and harvests AGENTS.md/CLAUDE.md/TESTING.md into an `extends: coding-factory` blueprint override; validates it; then creates the harness via harness:create, persists its discovered origin/default branch, and seeds its active recurring git-sync routine. Skips if the repo already has .papercusp/blueprint.yaml. Use `dryRun` to preview the generated override without creating. Returns {ok, slug?, skipped?, override?, detection, validation, upstream?, gitSync?}.',
  guidance: {
    when: 'Onboarding an existing code repository as a managed coding harness — you want the blueprint inferred from the repo (test command, stack, monorepo/frontend) rather than authored by hand.',
    notWhen:
      'The repo already has a .papercusp/blueprint.yaml (it is skipped — edit the file instead). Creating a repo-less / research harness, or one whose blueprint you author explicitly — harness:create with blueprintId/blueprint. Generate-from-plan (kinds #2/#3) is out of scope.',
    chaining:
      'harness:generate-from-repo { slug, path, dryRun:true } → (inspect override) → harness:generate-from-repo { slug, path } (creates). Or blueprint:validate the returned override.',
    seeAlso: [
      'harness:create (create from a folder/blueprint instead of a repo)',
      'blueprint:validate (validate the returned override)',
      'harness:overview (inspect the generated harness)',
    ],
  },
  capability: 'harness:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    slug: z
      .string()
      .min(1)
      .regex(/^[a-z0-9][a-z0-9-]*$/, 'slug must be lowercase alphanumeric + dashes')
      .describe('Unique harness slug for the new harness'),
    path: z.string().min(1).describe('Absolute path to the existing git repo'),
    dryRun: z
      .boolean()
      .default(false)
      .describe('Detect + build + validate the override, but do NOT create the harness'),
    runTests: z.boolean().default(true).describe('Run the detected test command once to verify it (D-023)'),
    testTimeoutMs: z
      .number()
      .int()
      .positive()
      .default(DEFAULT_TEST_TIMEOUT_MS)
      .describe('Budget for the single test-verify run'),
  }),
  async handler(args, ctx) {
    const path = resolvePath(args.path);
    if (!existsSync(path)) return text({ ok: false, error: 'path does not exist' });

    // 1. Deterministic detection (+ the verify run).
    const det = detectFromRepo(path, { runTests: args.runTests, testTimeoutMs: args.testTimeoutMs });
    if (det.skip) {
      return text({ ok: true, skipped: true, reason: det.skip.reason, detection: summarizeDetection(det) });
    }

    // 2. Map detection → an `extends: coding-factory` override, and validate it through the engine.
    const override = detectionToOverride(args.slug, det);
    const validation = resolveAndValidate(override);
    if (validation.parseError || !validation.ok) {
      return text({
        ok: false,
        error: 'generated blueprint invalid',
        parseError: validation.parseError,
        errors: validation.validation?.errors,
        warnings: validation.validation?.warnings,
        override,
        detection: summarizeDetection(det),
      });
    }

    const validationSummary = {
      ok: validation.ok,
      errors: validation.validation!.errors,
      warnings: validation.validation!.warnings,
    };

    // 3a. dryRun — return the seed for inspection, don't create.
    if (args.dryRun) {
      return text({
        ok: true,
        dryRun: true,
        slug: args.slug,
        override,
        yaml: stringifyYaml(override, { lineWidth: 100 }),
        validation: validationSummary,
        detection: summarizeDetection(det),
      });
    }

    // 3b. Compose harness:create with the inline override (its handler writes the
    //     git-canonical .papercusp/blueprint.yaml + registers + provisions PG).
    const createRes = (await createTool.handler({ slug: args.slug, path, blueprint: override } as never, ctx)) as {
      content: { text: string }[];
    };
    const created = JSON.parse(createRes.content[0].text);
    if (!created.ok) {
      return text({
        ok: false,
        error: 'harness:create failed',
        create: created,
        override,
        detection: summarizeDetection(det),
      });
    }

    // 4. A generated coding harness is a managed checkout even when it is not
    //    a Pot member. `harness:create` intentionally seeds git-sync only for
    //    explicit Pot members, so this existing-repo composition must close the
    //    standalone gap itself. Resolve the already-configured local origin,
    //    persist those coords atomically, then compose the SAME seeding spine
    //    used by Pot members. This keeps push/permission policy, active defaults,
    //    cron jitter, and idempotency in one place.
    let upstream: Awaited<ReturnType<typeof import('../../harness/upstream-repo-context').resolveUpstreamRepoSource>> =
      null;
    let gitSync: import('../../harness/git-sync/git-sync-routine').SeedGitSyncRoutineOutcome | undefined;
    try {
      const workspaceId = resolveConcreteWorkspaceId(undefined, ctx?.workspaceId, ctx?.principal?.workspaceId);
      const [{ resolveUpstreamRepoSource }, { mutateHarnessRegistry }, { seedGitSyncRoutineForMember }] =
        await Promise.all([
          import('../../harness/upstream-repo-context'),
          import('../../harness-registry'),
          import('../../harness/git-sync/git-sync-routine'),
        ]);
      upstream = await resolveUpstreamRepoSource({ path });

      const entry = {
        slug: args.slug,
        path,
        ...(upstream?.github_remote ? { github_remote: upstream.github_remote } : {}),
        ...(upstream?.github_repository_id !== undefined
          ? { github_repository_id: upstream.github_repository_id }
          : {}),
        ...(upstream?.default_branch ? { github_default_branch: upstream.default_branch } : {}),
      };

      if (upstream) {
        await mutateHarnessRegistry(
          (reg) => ({
            ...reg,
            projects: reg.projects.map((project) => (project.slug === args.slug ? { ...project, ...entry } : project)),
          }),
          workspaceId,
        );
      }

      gitSync = await seedGitSyncRoutineForMember({
        workspaceId,
        installSlug: args.slug,
        entry,
        joinerSide: false,
      });
    } catch (e) {
      // Same best-effort posture as harness:create's trigger/member seeds: a
      // control-plane hiccup must not erase a successfully created harness, but
      // the shaped result makes the missing durability explicit to the caller.
      gitSync = {
        seeded: false,
        reason: 'error',
        message: (e instanceof Error ? e.message : String(e)).slice(0, 300),
      };
    }

    return text({
      ok: true,
      slug: created.slug,
      path: created.path,
      blueprintFile: created.blueprintFile,
      requiresRepo: created.requiresRepo,
      provisioning: created.provisioning,
      upstream: upstream
        ? {
            remote: upstream.github_remote,
            defaultBranch: upstream.default_branch,
            source: upstream.source,
          }
        : null,
      gitSync,
      validation: validationSummary,
      detection: summarizeDetection(det),
    });
  },
});
