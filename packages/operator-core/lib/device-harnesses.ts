/**
 * Workspace-scoped harness list + status for mobile callers.
 *
 * Bypasses the desktop's `activeWorkspaceId()` coupling: queries the
 * `harness_shared.operator_state` row + per-status table directly using
 * the JWT-supplied workspace_id, so a phone always sees the harnesses
 * for the workspace it paired into (regardless of which one the desktop
 * is currently looking at).
 */
import { getOrgPg, withWorkspace, generated } from '@papercusp/db-org';
import { eq } from 'drizzle-orm';
import { isRepoLessHiveHome } from './harness/hive-groups';

const hr = generated.harnessRegistryInHarnessShared;

export interface ProjectEntry {
  slug: string;
  path: string;
  harness_kind?: string;
  /** A `harness_kind:'hive'` home that IS its own repo checkout (self-hive) — stays listable. */
  self_repo?: boolean;
}

export interface HarnessLite {
  slug: string;
  path: string;
  harness_kind: string | null;
  has_state: boolean;
  status: string | null;
  iteration: number | null;
  last_active_ts: number | null;
}

export async function readHarnessRegistryFor(workspaceId: string): Promise<ProjectEntry[]> {
  // Per-workspace explicit lookup — mobile MUST not use activeWorkspaceId()
  // (the desktop's currently-selected workspace), it must use the JWT claim
  // it was paired into. Reads `harness_shared.harness_registry` directly
  // (post-migration 020 each state lives in its own table; the legacy
  // unified `operator_state` table no longer exists).
  const { db } = getOrgPg();
  const rows = await db
    .select({ payload: hr.payload })
    .from(hr)
    .where(eq(hr.workspaceId, workspaceId))
    .limit(1);
  return (rows[0]?.payload as { projects?: ProjectEntry[] } | null)?.projects ?? [];
}

/** True when the slug exists in the given workspace's harness registry. */
export async function harnessExistsInWorkspace(workspaceId: string, slug: string): Promise<boolean> {
  const projects = await readHarnessRegistryFor(workspaceId);
  return projects.some((p) => p.slug === slug);
}

export async function listHarnessesFor(
  workspaceId: string,
  opts: { includeHiveHomes?: boolean } = {},
): Promise<HarnessLite[]> {
  const all = await readHarnessRegistryFor(workspaceId);
  // Repo-less Hive homes are backend coordination homes, not selectable work
  // targets — hide them from the psu picker + mobile harness lists by default.
  const projects = opts.includeHiveHomes ? all : all.filter((p) => !isRepoLessHiveHome(p));
  if (projects.length === 0) return [];

  // Latest status row per slug (collapsing across phases — pick most recent).
  const statuses = await withWorkspace(workspaceId, async (tx) => {
    return tx<{ harness_slug: string; status: string; iteration: number; last_active_ts: number | null }[]>`
      SELECT DISTINCT ON (harness_slug)
        harness_slug, status, iteration, last_active_ts
      FROM harness_shared.harness_status
      ORDER BY harness_slug, COALESCE(last_active_ts, 0) DESC
    `;
  });
  const statusMap = new Map(statuses.map((s) => [s.harness_slug, s]));

  return projects.map((p) => {
    const s = statusMap.get(p.slug);
    return {
      slug: p.slug,
      path: p.path,
      harness_kind: p.harness_kind ?? null,
      has_state: s != null,
      status: s?.status ?? null,
      iteration: s?.iteration ?? null,
      last_active_ts: s?.last_active_ts ?? null,
    };
  });
}

export interface HarnessStatusFull {
  slug: string;
  status: string;
  phase: string;
  iteration: number;
  total_features: number;
  passed_count: number;
  todo_count: number;
  blocked_count: number;
  last_active_ts: number | null;
  cost_usd: number | null;
  active_roles: string[];
  escalation: string | null;
}

export async function harnessStatusFor(
  workspaceId: string,
  slug: string,
): Promise<HarnessStatusFull | null> {
  return withWorkspace(workspaceId, async (tx) => {
    const status = await tx<Omit<HarnessStatusFull, 'active_roles' | 'escalation' | 'slug'>[]>`
      SELECT phase, status, iteration,
             total_features, passed_count, todo_count, blocked_count,
             last_active_ts, cost_usd
      FROM harness_shared.harness_status
      WHERE harness_slug = ${slug}
      ORDER BY COALESCE(last_active_ts, 0) DESC
      LIMIT 1
    `;
    if (status.length === 0) return null;
    const top = status[0];

    const lanes = await tx<{ role: string }[]>`
      SELECT role
      FROM harness_shared.harness_lanes
      WHERE harness_slug = ${slug} AND phase = ${top.phase}
    `;
    const escalations = await tx<{ escalation: string | null }[]>`
      SELECT escalation
      FROM harness_shared.harness_escalations
      WHERE harness_slug = ${slug} AND phase = ${top.phase}
      LIMIT 1
    `;

    return {
      slug,
      ...top,
      active_roles: lanes.map((l) => l.role),
      escalation: escalations[0]?.escalation ?? null,
    };
  });
}
