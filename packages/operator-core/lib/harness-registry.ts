/**
 * Single source of truth for the operator's harness-project registry.
 *
 * Persisted in `harness_shared.harness_registry` (PG, migration 025).
 * Was previously `<workspace-root>/registry.json`; the new home keeps
 * the same per-workspace scoping via the workspace_id PK column.
 *
 * Operator never reads any home-directory JSON registry. PG is the
 * single source of truth; merging in legacy files re-introduces a
 * workspace-leak bug we've already fixed.
 *
 * API converted to async as part of the migration. Callers in async
 * route handlers / page components add `await`; the few sync wrappers
 * become async functions of their own.
 */

import type { DeploymentConfig, Frame } from '@papercusp/deployment-driver';
import { getOrgPg } from '@papercusp/db-org';
import { readOperatorState, updateOperatorState, writeOperatorState } from './operator-state-pg';
import { activeWorkspaceId } from './workspace-registry';

export interface ProjectEntry {
  slug: string;
  path: string;
  harness_kind?: string;
  /** Department slug for harness_kind='department' projects (e.g. "business"). */
  department_slug?: string;
  /**
   * The home Hive this harness belongs to, for shared-Hive federation
   * (shared-hive-federation-2026-06-08 P-004). A MEMBER harness sets this to its
   * Hive's home slug so its substrate federates over the HIVE topic (the Hive
   * pubkey), with `harness_slug` staying the within-Hive component scope (D-003:
   * change only the topic key). A `harness_kind:'hive'` harness is its own Hive's
   * home and needs no `hive_slug`. Absent ⇒ not a Hive member (federates via
   * gh/local, or stays local-only).
   */
  hive_slug?: string;
  /**
   * Joiner-side hive VIEW (hive-from-repo-hardening-2026-06-11 P-007/D-007):
   * a `harness_kind:'hive'` entry materialized when this peer JOINED someone
   * else's hive — grouping/rail/strip UX only. NO identity mint, NO owned
   * directory meta, NEVER announces; ownership stays with the creator. The
   * federation gate already returns null for it (no hives row/identity).
   */
  remote_hive?: boolean;
  // ── Upstream GitHub coordinates (hive-from-github-url-2026-06-11 P-002) ──
  // Written at registration time by the projects-route githubUrl path and
  // hive:create_from_repo. Consumed by the hive directory announce derivation
  // (member_repos) and the fork-PR repo-context fallback (orchestrator-runner
  // resolveRepoContext). Absent ⇒ repo origin unknown (registered from a local
  // path) — consumers fall back to .papercusp/shared.json / git remote parsing.
  /** Normalized HTTPS clone URL of the upstream repo. */
  github_remote?: string;
  /** GitHub's immutable numeric repository id (needs API auth at registration —
   *  best-effort; the binding layer keys on this when present). */
  github_repository_id?: number;
  /** Upstream default branch (API-authoritative when available, else the fresh
   *  clone's HEAD). Fork-PRs target this instead of assuming 'main'. */
  github_default_branch?: string;
  /**
   * The user's OWN fork of the upstream repo, normalized HTTPS clone URL
   * (per-hive-learning-loops-2026-06-14 P-072 / D-007b). The CONTRIBUTION seam:
   * a platform self-hive (or any member without upstream write) git-syncs its
   * local commits to THIS fork remote — never the canonical upstream — and
   * improvements reach upstream only as human-reviewed PRs (open-fork-pr) or
   * moderated Comb learning-pack listings. Absent ⇒ no fork configured (the
   * default for every existing harness): git-sync stays commit-only / pushes the
   * upstream only when the operator has write (decideGitSyncPush). This is a LOCAL
   * config seam only — setting it performs NO outward git action (D-007: the live
   * fork-push / PR-open is the gated platform:contribute path).
   */
  fork_remote?: string;
  /**
   * Where this harness's execution plane runs (`cloud-deployment-layer-2026-06-06`
   * P-003). A sibling to the blueprint (D-001), supplied at instantiation and
   * persisted here in workspace PG. Absent ⇒ `{ target: 'local' }` (every existing
   * harness), so the launch path runs locally exactly as before.
   */
  deployment?: DeploymentConfig;
  /**
   * The currently-provisioned cloud frame handle, when this harness is deployed
   * (cloud-deployment-layer P-012). Persisted so teardown can DESTROY the right
   * machine across operator restarts (a frame outlives the process that made it).
   * Absent ⇒ not deployed / running locally.
   */
  deploymentFrame?: Frame;
  // ── Per-install INSTANCE config in workspace PG (cloud-deployment-layer P-008) ──
  // The instance fields that used to live in `.papercusp/config.json`; here they're
  // in workspace PG so they FEDERATE to a cloud frame (D-007) instead of being
  // stuck in a local file. Absent ⇒ fall back to config.json (un-migrated).
  /** Which prompt set the orchestrator pulls (staging/department/production). */
  phase?: string;
  /** Per-phase config (port / dbPath / …). */
  phases?: Record<string, Record<string, unknown>>;
  /** Department slug. */
  dept?: string;
  /** Per-instance overrides of blueprint knobs (maxCostUsd, parallelWorkers, …) —
   *  the residue of config.json after phase/phases/dept are split out. */
  configOverrides?: Record<string, unknown>;
}

export interface HarnessRegistry {
  projects: ProjectEntry[];
  /** Per-Hive Queen control-frame handles (cloud-deployment-layer P-016) — kept in
   *  the registry blob (workspace PG) alongside per-harness deployment frames, so
   *  teardown can DESTROY the Queen across restarts. Keyed by hiveId. */
  hiveControlFrames?: Record<string, Frame>;
  /** Per-Hive directory metadata (p2p-hive-directory P-004) — title/description/
   *  visibility/memberTopics/inviteSecret the directory announces. Kept in the
   *  registry blob (workspace PG, no migration) keyed by hiveId; a public/invite
   *  entry is announced on boot. Shape = the directory's `HiveDirectoryMeta`
   *  (lib/hive-publish.ts). */
  hiveDirectoryMeta?: Record<string, import('./hive-publish').HiveDirectoryMeta>;
}

export interface SaveRegistryOptions {
  /**
   * Permit reducing a populated registry to empty. Required by the
   * intentional-removal paths (DELETE /harness/projects/:slug,
   * /installed/prune). Every other caller only grows the registry, so
   * the default (false) guards against the silent total-wipe that lost
   * the `default` workspace's harnesses on 2026-05-25.
   */
  allowEmpty?: boolean;
}

export async function loadHarnessRegistry(workspaceId?: string): Promise<HarnessRegistry> {
  const raw = await readOperatorState<HarnessRegistry>('harness_registry', workspaceId);
  return {
    projects: raw?.projects ?? [],
    ...(raw?.hiveControlFrames ? { hiveControlFrames: raw.hiveControlFrames } : {}),
    ...(raw?.hiveDirectoryMeta ? { hiveDirectoryMeta: raw.hiveDirectoryMeta } : {}),
  };
}

/**
 * The registry's uniqueness invariant: `slug` is the primary key. Every
 * insert path guards with `projects.some(p => p.slug === …)` and every update
 * path replaces in place (`projects.map`), so a duplicate slug is always a
 * caller bug — and a duplicate makes the ubiquitous downstream
 * `projects.find(p => p.slug === …)` non-deterministic (which row wins depends
 * on array order). This is the single store-layer guard that enforces the
 * invariant at the write boundary regardless of caller discipline: collapse to
 * one entry per slug, LAST-write-wins (matching the upsert-replace intent), and
 * `onCollapse` surfaces the bug so it's traceable rather than silent. A
 * duplicate-free input is returned UNCHANGED (same reference) — the common case
 * pays nothing.
 *
 * Pure + exported so it's unit-testable without PG.
 */
export function dedupeProjectsBySlug(
  projects: ProjectEntry[],
  onCollapse?: (slug: string) => void,
): ProjectEntry[] {
  // Fast path: scan for any dup before allocating.
  const seen = new Set<string>();
  let hasDup = false;
  for (const p of projects) {
    if (seen.has(p.slug)) {
      hasDup = true;
      break;
    }
    seen.add(p.slug);
  }
  if (!hasDup) return projects;

  // Last-write-wins: keep the LAST entry per slug, preserving first-seen order
  // of the surviving rows.
  const lastIndex = new Map<string, number>();
  projects.forEach((p, i) => lastIndex.set(p.slug, i));
  const collapsed: ProjectEntry[] = [];
  const emitted = new Set<string>();
  projects.forEach((p, i) => {
    if (lastIndex.get(p.slug) !== i) {
      onCollapse?.(p.slug);
      return; // a later entry for this slug wins
    }
    if (emitted.has(p.slug)) return;
    emitted.add(p.slug);
    collapsed.push(p);
  });
  return collapsed;
}

/**
 * The set of `harness:<slug>` improvement/work scopes belonging to one Hive
 * (per-hive-learning-loops P-040, D-008 — the Hive is the tenancy unit). A Hive
 * is identified by its HOME slug; its members are the home itself plus every
 * project whose `hive_slug` points at it (shared-hive-federation D-003 keeps the
 * within-Hive harness_slug as the component scope). Pure over the registry
 * projects so it's unit-testable without PG.
 */
export function hiveMemberHarnessScopes(
  projects: Pick<ProjectEntry, 'slug' | 'hive_slug'>[],
  hiveHomeSlug: string,
): string[] {
  const slugs = new Set<string>();
  // The home harness is always a member, even before any peer joins.
  slugs.add(hiveHomeSlug);
  for (const p of projects) {
    if (p.slug === hiveHomeSlug || p.hive_slug === hiveHomeSlug) slugs.add(p.slug);
  }
  return [...slugs].map((s) => `harness:${s}`);
}

/**
 * Append an audit_log row recording every registry size change, so a
 * future wipe is traceable to its actor + timestamp (the 2026-05-25
 * incident left no trail because this write was silent). Best-effort —
 * audit failure never blocks the registry write.
 */
async function auditRegistryWrite(
  ws: string,
  prevCount: number,
  nextCount: number,
): Promise<void> {
  try {
    const { sql } = getOrgPg();
    const id = `hreg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    await sql.unsafe(
      `INSERT INTO harness_shared.audit_log (id, ts, actor, action, subject, details, workspace_id)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)`,
      [
        id,
        Date.now(),
        'operator',
        'harness_registry.write',
        ws,
        JSON.stringify({ prevCount, nextCount, delta: nextCount - prevCount }),
        ws,
      ],
    );
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[harness-registry] audit write failed:', err);
  }
}

export async function saveHarnessRegistry(
  reg: HarnessRegistry,
  workspaceId?: string,
  opts: SaveRegistryOptions = {},
): Promise<void> {
  const ws = workspaceId ?? activeWorkspaceId();
  // Uniqueness invariant (store-layer guard): collapse any accidental
  // duplicate slug last-write-wins before persisting, so a buggy caller can
  // never leave the row with two entries sharing a slug (which would make
  // downstream find(p=>p.slug===…) non-deterministic). A clean input is
  // unchanged; a collapse is logged so the offending caller is traceable.
  const next = dedupeProjectsBySlug(reg.projects ?? [], (slug) =>
    // eslint-disable-next-line no-console
    console.warn(`[harness-registry] saveHarnessRegistry collapsed duplicate slug '${slug}' (workspace '${ws}')`),
  );
  const prev = await readOperatorState<HarnessRegistry>('harness_registry', workspaceId);
  const prevCount = prev?.projects?.length ?? 0;

  // Catastrophic-empty guard: refuse to wipe a populated registry unless
  // the caller explicitly opts in. This is the single barrier that would
  // have prevented the 2026-05-25 silent loss of every `default` harness.
  if (next.length === 0 && prevCount > 0 && !opts.allowEmpty) {
    throw new Error(
      `saveHarnessRegistry refused: emptying ${prevCount} project(s) in workspace ` +
        `'${ws}' requires { allowEmpty: true }. Only intentional-removal paths ` +
        `(project delete / installed prune) should pass it.`,
    );
  }

  await writeOperatorState(
    'harness_registry',
    {
      projects: next,
      ...(reg.hiveControlFrames ? { hiveControlFrames: reg.hiveControlFrames } : {}),
      // Was silently dropped on every save before 2026-06-10 (audit P-006
      // adjacency) — any registry write wiped the Hive directory metadata.
      ...(reg.hiveDirectoryMeta ? { hiveDirectoryMeta: reg.hiveDirectoryMeta } : {}),
    },
    workspaceId,
  );
  if (next.length !== prevCount) {
    await auditRegistryWrite(ws, prevCount, next.length);
  }
  notifyRegistryChanged();
}

/**
 * Push invalidation + per-process lite-cache bust after any registry
 * mutation, so open harness lists live-update without a remount (EI-206).
 * The notify rides pg_notify, so writes from OTHER operator processes
 * (e.g. an MCP-side harness:create) reach this process's SSE subscribers
 * too. Fire-and-forget — a notify failure never blocks the write.
 */
function notifyRegistryChanged(): void {
  void (async () => {
    try {
      const [{ bustProjectsLiteCache }, { notifySyncInvalidate }] = await Promise.all([
        import('./harness/projects-lite'),
        import('./sync-sse'),
      ]);
      bustProjectsLiteCache();
      await notifySyncInvalidate('harnessProjects.lite', {});
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[harness-registry] sync invalidate failed:', err);
    }
  })();
}

/**
 * Atomic read-modify-write on the registry (audit P-006 / EI-82).
 *
 * `loadHarnessRegistry()` + mutate + `saveHarnessRegistry()` is a lost-update
 * race: two concurrent mutators (e.g. a POST create and a DELETE) both read,
 * then the second save silently reverts the first. This helper runs the
 * mutator inside the operator-state row's `SELECT … FOR UPDATE` transaction,
 * so concurrent mutations serialize and each sees the previous committed
 * value.
 *
 * The mutator must return the FULL next registry (return `reg` unchanged to
 * no-op). The catastrophic-empty guard applies unless `opts.allowEmpty`.
 */
export async function mutateHarnessRegistry(
  mutator: (reg: HarnessRegistry) => HarnessRegistry,
  workspaceId?: string,
  opts: SaveRegistryOptions = {},
): Promise<HarnessRegistry> {
  const ws = workspaceId ?? activeWorkspaceId();
  let prevCount = 0;
  let nextCount = 0;
  const next = await updateOperatorState<HarnessRegistry>(
    'harness_registry',
    { projects: [] },
    (raw) => {
      const current: HarnessRegistry = {
        projects: raw?.projects ?? [],
        ...(raw?.hiveControlFrames ? { hiveControlFrames: raw.hiveControlFrames } : {}),
        ...(raw?.hiveDirectoryMeta ? { hiveDirectoryMeta: raw.hiveDirectoryMeta } : {}),
      };
      prevCount = current.projects.length;
      const mutated = mutator(current);
      // Uniqueness invariant (store-layer guard): collapse any accidental
      // duplicate slug last-write-wins inside the tx, so the committed row is
      // always one entry per slug regardless of the mutator's discipline.
      const dedupedProjects = dedupeProjectsBySlug(mutated.projects ?? [], (slug) =>
        // eslint-disable-next-line no-console
        console.warn(`[harness-registry] mutateHarnessRegistry collapsed duplicate slug '${slug}' (workspace '${ws}')`),
      );
      nextCount = dedupedProjects.length;
      if (nextCount === 0 && prevCount > 0 && !opts.allowEmpty) {
        // Throwing rolls the FOR UPDATE transaction back.
        throw new Error(
          `mutateHarnessRegistry refused: emptying ${prevCount} project(s) in workspace ` +
            `'${ws}' requires { allowEmpty: true }. Only intentional-removal paths ` +
            `(project delete / installed prune) should pass it.`,
        );
      }
      return { ...mutated, projects: dedupedProjects };
    },
    workspaceId,
  );
  if (nextCount !== prevCount) {
    await auditRegistryWrite(ws, prevCount, nextCount);
  }
  notifyRegistryChanged();
  return next;
}
