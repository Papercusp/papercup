/**
 * pot-review-integration-mode P-020 (D-006/D-007): where green-checkpoint
 * PUBLISHES a promoted commit.
 *
 * git-sync already routes a working-copy (review-mode) pot's pushes to the
 * pot's own fork (`pot-fork` remote) and never to the main repository. The
 * green gate's promotion push used to bypass that: it pushed the tested
 * candidate to `origin` — the MAIN repository — unconditionally, so a
 * review-mode pot's promoted `main` landed straight on the upstream `main`
 * without any PR. This module is the single decision both halves now share:
 * it resolves the pot that owns the integration checkout, reads its
 * integration mode through the SAME `resolveIntegrationPushRemote` git-sync
 * uses, and maps that to a promotion target.
 *
 *  - `origin` — direct mode, or a checkout no registered pot owns: today's
 *    behaviour, unchanged.
 *  - `fork`   — review mode with a fork: push the promoted commit to the fork,
 *    then refresh the standing PR (fork main → upstream main).
 *  - `skip`   — review mode with no fork: publish nowhere (the local gate is
 *    still authoritative, like a local-only repository). Never falls back to
 *    the main repository.
 *  - `hold`   — the mode could not be determined (settings read error,
 *    malformed value, unreadable registry). Fail CLOSED: the caller throws so
 *    promotion is held rather than risking an upstream leak.
 */
import { realpathSync } from 'node:fs';
import type { ProjectEntry } from '../../harness-registry';
import {
  POT_FORK_REMOTE_NAME,
  resolveIntegrationPushRemote,
  type PotIntegrationModeRead,
} from './pot-integration-mode';

export type PromotionPushTarget =
  | { kind: 'origin'; reason: string }
  | {
      kind: 'fork';
      remoteName: typeof POT_FORK_REMOTE_NAME;
      url: string;
      potHomeSlug: string;
      integration: PotIntegrationModeRead;
      /** The main repository's GitHub remote (registry `github_remote`), for the standing PR. */
      upstreamRemote?: string;
      reason: string;
    }
  | { kind: 'skip'; reason: 'working_copy_fork_missing'; message: string }
  | {
      kind: 'hold';
      reason: 'integration_mode_unknown' | 'integration_mode_malformed' | 'registry_unreadable';
      message: string;
    };

export interface ResolvePromotionPushTargetInput {
  /** The integration checkout green-checkpoint promotes (cfg.integrationRoot). */
  repoPath: string;
  /** Workspace whose registry owns the checkout; undefined = the registry default. */
  workspaceId?: string;
}

export interface ResolvePromotionPushTargetDeps {
  loadProjects: (workspaceId: string | undefined) => Promise<readonly ProjectEntry[]>;
  readMode: (workspaceId: string, potHomeSlug: string) => Promise<PotIntegrationModeRead>;
  /** Canonicalise a path for comparison; defaults to realpath with a raw fallback. */
  canonical?: (p: string) => string;
}

function defaultCanonical(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p.replace(/\/+$/, '');
  }
}

/** Decide where a promoted commit is published. Never throws. */
export async function resolvePromotionPushTarget(
  input: ResolvePromotionPushTargetInput,
  deps: ResolvePromotionPushTargetDeps,
): Promise<PromotionPushTarget> {
  const canonical = deps.canonical ?? defaultCanonical;
  let projects: readonly ProjectEntry[];
  try {
    projects = await deps.loadProjects(input.workspaceId);
  } catch (err) {
    return {
      kind: 'hold',
      reason: 'registry_unreadable',
      message:
        `could not load the harness registry (${err instanceof Error ? err.message : String(err)}) — ` +
        'holding promotion: without it a working-copy pot cannot be told apart from a direct one',
    };
  }
  const target = canonical(input.repoPath);
  const entry = projects.find((p) => typeof p.path === 'string' && p.path && canonical(p.path) === target);
  if (!entry) return { kind: 'origin', reason: 'no registered pot owns this checkout — publishing to origin' };
  // Same pot-home resolution as git-sync (git-sync-action.ts): hive members use
  // their hive_slug, a self_repo hive home uses its own slug.
  const potHomeSlug = entry.hive_slug ?? (entry.self_repo ? entry.slug : undefined);
  if (!potHomeSlug) {
    return { kind: 'origin', reason: `${entry.slug} is not a pot home or member — publishing to origin` };
  }
  const workspaceId = input.workspaceId;
  if (!workspaceId) {
    return {
      kind: 'hold',
      reason: 'integration_mode_unknown',
      message:
        `no workspace id for pot ${potHomeSlug}, so its integration mode cannot be read — holding promotion ` +
        'rather than risking a working-copy pot publishing to the main repository',
    };
  }
  const read = await deps.readMode(workspaceId, potHomeSlug);
  const decision = resolveIntegrationPushRemote({
    read,
    ...(entry.fork_remote ? { forkRemote: entry.fork_remote } : {}),
  });
  if (decision.kind === 'unchanged') return { kind: 'origin', reason: decision.reason };
  if (decision.kind === 'fork') {
    return {
      kind: 'fork',
      remoteName: decision.remoteName,
      url: decision.url,
      potHomeSlug,
      integration: read,
      ...(entry.github_remote ? { upstreamRemote: entry.github_remote } : {}),
      reason: decision.reason,
    };
  }
  if (decision.reason === 'working_copy_fork_missing') {
    return { kind: 'skip', reason: 'working_copy_fork_missing', message: decision.message };
  }
  return { kind: 'hold', reason: decision.reason, message: decision.message };
}
