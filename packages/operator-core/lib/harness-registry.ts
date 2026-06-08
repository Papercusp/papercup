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
import { readOperatorState, writeOperatorState } from './operator-state-pg';
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
  const next = reg.projects ?? [];
  const ws = workspaceId ?? activeWorkspaceId();
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
    { projects: next, ...(reg.hiveControlFrames ? { hiveControlFrames: reg.hiveControlFrames } : {}) },
    workspaceId,
  );
  if (next.length !== prevCount) {
    await auditRegistryWrite(ws, prevCount, next.length);
  }
}
