/**
 * workspace-brain-scope.ts — the SHARED K1 keying helper for the per-hive →
 * workspace brain re-key (workspace-scoped-coordination-2026-06-20, D-006/D-007).
 *
 * The Queen (P-003), Scout (P-002) and Overwatch (P-004) all move from per-HIVE
 * to one-per-WORKSPACE behind ONE shared flag (FLAGS.WORKSPACE_COORDINATION).
 * D-006 mandates ONE consistent keying pattern across all three — this module IS
 * that pattern, so the three brains can't drift apart.
 *
 * K1 (migration-light, reversible — D-006): the brain's per-hive state key
 * collapses to a stable WORKSPACE SENTINEL (= workspaceId) that REUSES the
 * existing per-hive index/column (operator_settings `<thing>:<ws>:<install>` →
 * `<thing>:<ws>`; routines (ws, install_slug, name) → install_slug=ws sentinel;
 * SQL tables keyed (workspace_id, hive_slug, …) → hive_slug = workspaceId). No
 * migration on a hot live table during the deploy-freeze. Every read ships a
 * READ-FALLBACK to the legacy per-hive row so a single-hive workspace
 * (papercusp == papercusp-workspace) pre-backfill has ZERO regression.
 *
 * Flag OFF (the dark default) ⇒ the legacy per-hive slug, byte-identical to
 * today. Flip ON only after the post-canary verify (D-006).
 */
import { FLAGS } from '@papercusp/flags';
import { getFlag } from '@papercusp/flags/server';
import { systemDistinctId } from './flag-distinct-id';

/**
 * Is the per-hive → workspace brain re-key (FLAGS.WORKSPACE_COORDINATION) ON?
 * Reads the shared master gate; on any error returns false (dark default =
 * legacy per-hive), so a flag-bus hiccup can never silently flip a live loop.
 * Mirrors the getFlag(systemDistinctId()) pattern used by the sibling keying
 * flags (configure-per-workspace.ts / coordination/log.ts).
 */
export async function isWorkspaceCoordinationOn(): Promise<boolean> {
  try {
    return await getFlag(FLAGS.WORKSPACE_COORDINATION, systemDistinctId());
  } catch {
    return false;
  }
}

/**
 * The K1 WRITE scope key for a workspace brain's per-hive state. ON → the
 * workspace sentinel (= workspaceId), reusing the existing per-hive key column so
 * there is one row per workspace. OFF → the legacy per-hive slug. Pure (the flag
 * value is passed in) so callers read the flag ONCE per operation and stay
 * deterministic + testable.
 */
export function workspaceBrainScopeKey(workspaceId: string, perHiveSlug: string, on: boolean): string {
  return on ? workspaceId : perHiveSlug;
}

/**
 * The K1 READ-FALLBACK keys, in priority order. ON → prefer the workspace
 * sentinel row, then fall back to the legacy per-hive row (so a workspace whose
 * sentinel row has not been written yet still resolves the live per-hive value —
 * zero regression). OFF → only the per-hive row. The sentinel is de-duplicated
 * when the per-hive slug already equals the workspaceId (a workspace==hive shape).
 * A reader consumes these in order and takes the first that yields a value.
 */
export function workspaceBrainReadKeys(workspaceId: string, perHiveSlug: string, on: boolean): string[] {
  if (!on) return perHiveSlug ? [perHiveSlug] : [];
  if (!perHiveSlug || perHiveSlug === workspaceId) return [workspaceId];
  return [workspaceId, perHiveSlug];
}
