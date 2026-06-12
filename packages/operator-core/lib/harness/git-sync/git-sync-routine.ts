/**
 * Per-harness git-sync routine config (git-sync-auto-commit P-003). A harness's
 * git-sync schedule is a `harness_shared.routines` row with
 * target_role='system:git-sync' — these wrap db-org's routine primitives so the
 * schedule is editable as ordinary harness config (the routines:list/set tools +
 * the P-015 seed use these).
 *
 * Pass the owning `workspaceId` explicitly — `harness_shared.routines.workspace_id`
 * is NOT NULL with no column default and no fill trigger (there is no
 * `app.workspace_id` GUC trigger, despite earlier comments here that claimed one).
 */
import type { Sql } from 'postgres';
import { getOrgPg, upsertRoutine, setRoutineActive, type RoutineRow } from '@papercusp/db-org';
import type { ProjectEntry } from '../../harness-registry';
import { parseGithubUrl } from '../clone-github';
import { fetchRepoPushPermission } from '../github-repo-permissions';
import { computeNextFireAt } from '../routines/cron';
import { decideGitSyncPush, type PushDecision, type PushDecisionInput } from './decide-git-sync-push';
import {
  gitSyncEligibility,
  gitSyncCronForKey,
  GIT_SYNC_SEED_ACTIVE_CREATOR,
  GIT_SYNC_SEED_ACTIVE_JOINER,
  type GitSyncEligibility,
  type IneligibleReason,
} from './git-sync-eligibility';

export const GIT_SYNC_ROUTINE_NAME = 'git-sync';
export const GIT_SYNC_TARGET = 'system:git-sync';
// Every 10 minutes — matches the live `papercup` cadence (trigger_config.cron); the
// superproject's branch is `staging` and lives in trigger_config, not here.
export const DEFAULT_GIT_SYNC_CRON = '0 */10 * * * *';

export interface GitSyncRoutineInput {
  /** Owning workspace_id (routines.workspace_id is NOT NULL, no default). */
  workspaceId: string;
  installSlug: string;
  cron?: string;
  push?: boolean;
  pushSubmodules?: boolean;
  /** Seeded INACTIVE by default — go-live flips this to true. */
  active?: boolean;
  /**
   * Superproject branch for the sync (git-sync-any-hive P-001) — written into
   * `trigger_config.branch`, which `configFromTrigger` (git-sync-action.ts)
   * already reads into the pipeline config. Omit ⇒ the pipeline's per-repo
   * default-branch resolution applies (cfg.branch ?? 'main' in the resolver
   * kickoff). Seed callers pass the member's `github_default_branch`.
   */
  branch?: string;
}

/** Create or update a harness's `system:git-sync` routine. */
export async function upsertGitSyncRoutine(sql: Sql, input: GitSyncRoutineInput): Promise<RoutineRow> {
  return upsertRoutine(
    sql,
    {
      workspaceId: input.workspaceId,
      installSlug: input.installSlug,
      name: GIT_SYNC_ROUTINE_NAME,
      triggerKind: 'cron',
      triggerConfig: {
        cron: input.cron ?? DEFAULT_GIT_SYNC_CRON,
        push: input.push ?? true,
        push_submodules: input.pushSubmodules ?? true,
        ...(input.branch ? { branch: input.branch } : {}),
        // P-015: `merge_strategy` removed — it was read by nothing (configFromTrigger
        // never consumed it); the pipeline always merges (`git merge --no-edit`).
      },
      targetRole: GIT_SYNC_TARGET,
      active: input.active ?? false,
    },
    computeNextFireAt,
  );
}

/** Read a harness's git-sync routine, or null if none seeded. */
export async function getGitSyncRoutine(sql: Sql, installSlug: string): Promise<RoutineRow | null> {
  const rows = await sql<Array<Record<string, unknown>>>`
    SELECT * FROM harness_shared.routines
     WHERE install_slug = ${installSlug} AND target_role = ${GIT_SYNC_TARGET}
     LIMIT 1
  `;
  if (!rows.length) return null;
  const r = rows[0];
  return {
    id: String(r.id),
    workspaceId: String(r.workspace_id ?? ''),
    installSlug: String(r.install_slug),
    name: String(r.name),
    triggerKind: r.trigger_kind as RoutineRow['triggerKind'],
    triggerConfig: (r.trigger_config ?? {}) as RoutineRow['triggerConfig'],
    targetRole: String(r.target_role),
    payloadTemplate: (r.payload_template ?? null) as RoutineRow['payloadTemplate'],
    concurrency: r.concurrency as RoutineRow['concurrency'],
    catchup: r.catchup as RoutineRow['catchup'],
    active: Boolean(r.active),
    lastFiredAt: (r.last_fired_at ?? null) as Date | null,
    nextFireAt: (r.next_fire_at ?? null) as Date | null,
  };
}

/** Enable/disable a harness's git-sync routine (go-live = setGitSyncRoutineActive(sql, slug, true)). */
export async function setGitSyncRoutineActive(sql: Sql, installSlug: string, active: boolean): Promise<boolean> {
  return setRoutineActive(sql, installSlug, GIT_SYNC_ROUTINE_NAME, active);
}

// ── Member seeding (git-sync-any-hive P-001/P-008, seed side) ──────────────────

export interface SeedGitSyncRoutineOpts {
  /** Owning workspace_id (routines.workspace_id is NOT NULL, no default). */
  workspaceId: string;
  installSlug: string;
  /** Registry snapshot of the member entry — eligibility + github coords input.
   *  Callers that just registered the member may synthesize it from the same
   *  fields they wrote (slug/path/hive_slug/github_* — cf. _create_from_repo). */
  entry: ProjectEntry;
  /** Joiner-side member clone? Creator-side producers pass false (the default).
   *  Drives both the P-005 active split and B-02's push decision. */
  joinerSide?: boolean;
}

export interface SeedGitSyncRoutineDeps {
  sql?: Sql;
  eligibility?: (p: ProjectEntry) => GitSyncEligibility;
  /** B-02's permissions probe (default fetchRepoPushPermission — best-effort, never throws). */
  fetchPushPermission?: (owner: string, repo: string) => Promise<boolean | null>;
  /** B-02's push decider (default decideGitSyncPush — pure). */
  decidePush?: (i: PushDecisionInput) => PushDecision;
  getRoutine?: typeof getGitSyncRoutine;
  upsert?: typeof upsertGitSyncRoutine;
}

export type SeedGitSyncRoutineOutcome =
  | { seeded: true; active: boolean; push: boolean; pushReason: string; cron: string; branch?: string }
  /** Not a syncable member checkout (hive home / remote view / cloud / no repo). */
  | { seeded: false; reason: 'ineligible'; ineligibleReason: IneligibleReason }
  /** A routine row already exists — NEVER clobbered (a human/peer may have edited it). */
  | { seeded: false; reason: 'routine_exists' }
  /** Anything threw (PG down, probe seam exploded, …) — reported, never rethrown. */
  | { seeded: false; reason: 'error'; message: string };

/**
 * Best-effort seed of one MEMBER checkout's `system:git-sync` routine — the one
 * composition behind the creator-side producers (hive:create_from_repo,
 * hive:add-member, harness:create { hive }) and B-03's joiner path. NEVER
 * throws and never fails the caller's create: every failure folds into the
 * returned outcome, which the calling tool reports in its result (the same
 * discipline as _create_from_repo's publish step).
 *
 * Behavior:
 *   - eligibility first (gitSyncEligibility, pure) — homes/views/cloud/non-repos
 *     are reported `ineligible` BEFORE any PG/network I/O is attempted;
 *   - idempotent — an existing routine row is never clobbered (getGitSyncRoutine
 *     first; a re-add/re-create reports `routine_exists` and leaves the row,
 *     including any human-edited `active`/config, intact);
 *   - `push` from B-02: `hasUpstreamRemote` = the entry's registry-known
 *     `github_remote` (the seed-time signal; B-04's reconcile can revisit), with
 *     the GitHub permissions probe run only when it could change the answer
 *     (creator-side + upstream known — the decider short-circuits the rest);
 *   - `active` from the P-005 provisional split (creator true / joiner false);
 *   - `cron` = gitSyncCronForKey(installSlug) (deterministic jitter, D-004);
 *   - `branch` = the entry's `github_default_branch` when present.
 */
export async function seedGitSyncRoutineForMember(
  opts: SeedGitSyncRoutineOpts,
  deps: SeedGitSyncRoutineDeps = {},
): Promise<SeedGitSyncRoutineOutcome> {
  try {
    const eligibility = deps.eligibility ?? gitSyncEligibility;
    const verdict = eligibility(opts.entry);
    if (!verdict.eligible) {
      return { seeded: false, reason: 'ineligible', ineligibleReason: verdict.reason ?? 'no_path' };
    }

    const sql = deps.sql ?? getOrgPg().sql;
    const getRoutine = deps.getRoutine ?? getGitSyncRoutine;
    if ((await getRoutine(sql, opts.installSlug)) != null) {
      return { seeded: false, reason: 'routine_exists' };
    }

    const joinerSide = opts.joinerSide === true;
    const hasUpstreamRemote = Boolean(opts.entry.github_remote);
    // Probe only when the answer can matter: rules 1+2 of the decider win
    // outright for fetch-less repos and joiner clones.
    let permissionsPush: boolean | null = null;
    if (hasUpstreamRemote && !joinerSide) {
      const parsed = parseGithubUrl(opts.entry.github_remote!);
      if (parsed) {
        const probe = deps.fetchPushPermission ?? fetchRepoPushPermission;
        permissionsPush = await probe(parsed.owner, parsed.repo);
      }
    }
    const decide = deps.decidePush ?? decideGitSyncPush;
    const decision = decide({ joinerSide, hasUpstreamRemote, permissionsPush });

    const cron = gitSyncCronForKey(opts.installSlug);
    const active = joinerSide ? GIT_SYNC_SEED_ACTIVE_JOINER : GIT_SYNC_SEED_ACTIVE_CREATOR;
    const branch = opts.entry.github_default_branch;
    const upsert = deps.upsert ?? upsertGitSyncRoutine;
    await upsert(sql, {
      workspaceId: opts.workspaceId,
      installSlug: opts.installSlug,
      cron,
      push: decision.push,
      active,
      ...(branch ? { branch } : {}),
    });
    return { seeded: true, active, push: decision.push, pushReason: decision.reason, cron, ...(branch ? { branch } : {}) };
  } catch (e) {
    return {
      seeded: false,
      reason: 'error',
      message: (e instanceof Error ? e.message : String(e)).slice(0, 300),
    };
  }
}
