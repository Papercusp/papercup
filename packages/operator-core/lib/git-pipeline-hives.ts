/**
 * git-pipeline-hives — the PER-HIVE rows behind the /admin/git per-hive surface
 * (per-hive-git-and-release-gate-2026-06-29 P-014).
 *
 * The operator-home (papercusp) pipeline has its own full view (git-pipeline-stats.ts →
 * `dev.gitPipeline`). THIS enumerates the OTHER repo-backed coding hives that are green-gated
 * (resolveHiveReleaseEnv enabled, not operator-home) and projects one compact row each:
 * the resolved green command (+ whether it's an owner override), the gate status (🟩/🟥/held/
 * stalled), the staging↔main gap, last green sha, and last deploy — all from the SAME
 * substrate the home view reads (harness_shared.routines.metadata.gate_health +
 * harness_shared.pipeline_events, both already scoped per install_slug by gitPipelineSnapshot).
 *
 * READ-ONLY aggregation; every sub-read degrades to a best-effort default so a slow/missing
 * hive never breaks the surface. The list is empty until a coding hive with a repo is gated
 * (the PER_HIVE_RELEASE_GATE flag is default-OFF during rollout — D-008).
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { loadHarnessRegistry } from './harness-registry';
import { resolveHiveReleaseEnv } from './harness/routines/hive-release-env';
import { gitPipelineSnapshot, type GitPipelineSnapshot } from './git-pipeline-stats';
import { DEFAULT_WORKSPACE_ID } from './workspace-id-constant';

export type HiveGateStatus = 'green' | 'held' | 'stalled' | 'unknown';

export interface GitPipelineHiveRow {
  slug: string;
  /** The integration tree root (the hive's gated checkout). */
  root: string;
  /** Resolved green command the gate runs (override > knob > testCommand > build). */
  greenCmd: string;
  /** True when greenCmd is a per-hive owner override (editable on this surface). */
  greenCmdOverridden: boolean;
  integrationBranch: string;
  releaseRef: string;
  /** A deploy target is configured (release-trigger seeded). */
  hasDeploy: boolean;
  /** Whether the green-checkpoint routine is active for this hive. */
  greenCheckpointActive: boolean;
  // ── gate health ──
  gateStatus: HiveGateStatus;
  consecutiveReds: number;
  lastGreenAtMs: number | null;
  lastGreenSha: string | null;
  // ── pipeline position ──
  /** Commits on integrationBranch not yet on releaseRef (the untested buffer); null if unknown. */
  stagingMainGap: number | null;
  lastDeployAtMs: number | null;
  lastDeployStatus: string | null;
}

/** `git -C root rev-list --count <from>..<to>` — best-effort, null on any error/missing branch. */
function revListCount(root: string, from: string, to: string): Promise<number | null> {
  return new Promise((resolve) => {
    if (!root || !existsSync(root)) return resolve(null);
    execFile(
      'git',
      ['-C', root, 'rev-list', '--count', `${from}..${to}`],
      { timeout: 5_000 },
      (err, stdout) => {
        if (err) return resolve(null);
        const n = Number.parseInt(stdout.trim(), 10);
        resolve(Number.isFinite(n) ? n : null);
      },
    );
  });
}

function gateStatusOf(gate: GitPipelineSnapshot['gate']): HiveGateStatus {
  if (gate.stalled) return 'stalled';
  if (gate.consecutiveReds > 0) return 'held';
  if (gate.lastGreenAtMs != null) return 'green';
  return 'unknown';
}

/** The sha `main` was last fast-forwarded to: the newest green_checkpoint event's advancedTo
 *  (partial advance) or candidate (full advance). null when no green event yet. */
function lastGreenShaOf(recent: GitPipelineSnapshot['recent']): string | null {
  const ev = recent.find(
    (e) => e.kind === 'green_checkpoint' && (e.status === 'advanced' || e.status === 'up-to-date'),
  );
  if (!ev) return null;
  const d = ev.detail || {};
  const sha = typeof d.advancedTo === 'string' ? d.advancedTo : typeof d.candidate === 'string' ? d.candidate : null;
  return sha ? sha.slice(0, 12) : null;
}

/** Build one compact per-hive row. Reuses gitPipelineSnapshot(slug) (routines/gate/events
 *  are install_slug-scoped) and overlays the per-hive command/branches/gap. */
async function buildRow(slug: string, env: Awaited<ReturnType<typeof resolveHiveReleaseEnv>>): Promise<GitPipelineHiveRow> {
  const root = env.env.PAPERCUSP_INTEGRATION_ROOT ?? '';
  const integrationBranch = env.env.PAPERCUSP_INTEGRATION_BRANCH ?? 'staging';
  const releaseRef = env.env.PAPERCUSP_RELEASE_REF ?? 'main';

  let snap: GitPipelineSnapshot | null = null;
  try {
    snap = await gitPipelineSnapshot(slug);
  } catch {
    snap = null;
  }
  const gap = await revListCount(root, releaseRef, integrationBranch);
  const lastDeploy = snap?.recent.find((e) => e.kind === 'deploy') ?? null;

  return {
    slug,
    root,
    greenCmd: env.greenCmd ?? '',
    greenCmdOverridden: env.greenCmdOverridden === true,
    integrationBranch,
    releaseRef,
    hasDeploy: env.hasDeploy,
    greenCheckpointActive: snap?.routines.greenCheckpoint?.active ?? false,
    gateStatus: snap ? gateStatusOf(snap.gate) : 'unknown',
    consecutiveReds: snap?.gate.consecutiveReds ?? 0,
    lastGreenAtMs: snap?.gate.lastGreenAtMs ?? null,
    lastGreenSha: snap ? lastGreenShaOf(snap.recent) : null,
    stagingMainGap: gap,
    lastDeployAtMs: lastDeploy?.createdAtMs ?? null,
    lastDeployStatus: lastDeploy?.status ?? null,
  };
}

/**
 * The per-hive pipeline rows for the /admin/git surface: every repo-backed coding hive that
 * is green-gated, EXCLUDING the operator-home (it has its own full view). Sorted by slug.
 */
export async function gitPipelineHiveRows(workspaceId: string = DEFAULT_WORKSPACE_ID): Promise<GitPipelineHiveRow[]> {
  let projects: Array<{ slug: string }>;
  try {
    const reg = await loadHarnessRegistry(workspaceId);
    projects = reg.projects;
  } catch {
    return [];
  }

  const rows: GitPipelineHiveRow[] = [];
  for (const p of projects) {
    let env: Awaited<ReturnType<typeof resolveHiveReleaseEnv>>;
    try {
      env = await resolveHiveReleaseEnv(p.slug, workspaceId);
    } catch {
      continue;
    }
    // Only GATED, repo-backed, NON-home hives appear here (the home is the main view).
    if (!env.enabled || env.isOperatorHome) continue;
    rows.push(await buildRow(p.slug, env));
  }
  rows.sort((a, b) => a.slug.localeCompare(b.slug));
  return rows;
}
