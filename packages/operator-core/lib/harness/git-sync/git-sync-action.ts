/**
 * The `system:git-sync` routine action (git-sync-auto-commit P-005/P-009/P-010/P-012).
 * Registered into the system-action registry; the routines engine runs it inline as
 * one durable DBOS step per due git-sync routine.
 *
 * Wraps the pure pipeline (`run-git-sync.ts`) with the live concerns:
 *   - P-009 LOCKS (git-sync-any-hive P-006: per-slug): hold `git-sync:<slug>`
 *     (exclusive, auto-registered on first acquire) + every name in the routine's
 *     `trigger_config.extra_lock_resources` (exclusive, must be human-registered)
 *     for the whole commit→submodule-push→pointer-bump→push sequence, so a peer
 *     agent's in-flight git work doesn't race. Held by a peer → skip this tick
 *     (back-pressure). An UNREGISTERED extra resource → skip with a loud log (a
 *     deliberate coordination surface — never auto-registered). Every fire uses
 *     a unique lock owner so scheduled and manual paths contend even though
 *     both are represented by the `system:git-sync` action. SU-lock infra
 *     unavailable → proceed unlocked (the existing fail-open behavior remains
 *     an explicit degraded mode, with the next tick retrying the lock).
 *   - RUNTIME GATE (git-sync-any-hive P-008, action half): before anything else,
 *     a routine row pointing at a hive home / remote-hive view / non-local
 *     deployment / vanished or non-git checkout NO-OPS with a logged reason and a
 *     `last_status: 'skipped'` metadata patch instead of error-escalating.
 *   - P-010 ESCALATION: on a merge conflict, write a `git-sync-conflict` row to
 *     `harness_escalations` (the tree is already clean — the pipeline aborts the merge).
 *   - P-012 RESOLVER: spawn a `merge-resolver` role via the invoke route, deduped on
 *     the open escalation (one resolver per harness). A clean sync clears the escalation.
 *   - Records `{ last_synced_at, last_status, head_sha }` onto the routine's metadata.
 *   - Records `git_sync_activity` while the local commit stage and every bridged/P2P
 *     post-leg are still running, so `routines:list` cannot mistake local-stage
 *     completion for a terminal git-sync fire (EI-21049559233457671).
 */
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { managedSetInterval } from '@papercusp/scheduled-registry';
import { getOrgPg } from '@papercusp/db-org';
import { getFlag } from '@papercusp/flags/server';
import { FLAGS } from '@papercusp/flags';
import { inWorkspaceTxn } from '../../agent-tools/locks/in-workspace-txn';
import { acquireWithContentionRetry, isWorkspaceContended } from '../../agent-tools/locks/contention-retry';
import { tryAcquireResource, tryReleaseResource } from '../../agent-tools/locks/su-lock-store';
import { liveLockedPaths } from '../../agent-tools/locks/live-lock-paths';
import { agentsForScopedFiles, type AttributionRosterEntry } from './git-sync-attribution';
import { loadHarnessRegistry, type ProjectEntry } from '../../harness-registry';
import { loopbackFetch } from '../../loopback-fetch';
import { resolveLaunchTargetForEvent } from '../../blueprint/launch-blueprint';
import { sendMessage } from '../../agent-tools/coordination/messages';
import type { AgentIdentity } from '../../agent-tools/coordination/identity';
import { registerSystemAction, type SystemActionCtx } from '../routines/system-actions';
import { getBuildInfo } from '../../build-info';
import { runCheckpointedStep } from '../../dbos/checkpointed-step';
import { gitSyncEligibility, type GitSyncEligibility } from './git-sync-eligibility';
import { getPotGitMode, type PotGitMode } from './hive-git-mode';
import { parseGithubUrl } from '../clone-github';
import { fetchRepoPushPermission } from '../github-repo-permissions';
import { BRIDGE_CANONICAL_REF, runGithubBridgeTick } from '../../sync/pot-git/github-bridge-tick';
import { runIntegratorTick } from '../../sync/pot-git/integrator-tick';
import {
  runWorktreeBridgeTick,
  WORKTREE_BRIDGE_RETRY_TTL_MS,
} from '../../sync/pot-git/worktree-bridge-tick';
import { deriveIntegratorGrant, deriveMaxGrantedEpoch } from '../../sync/pot-git/authority-epoch';
import { publishHandoffToken } from '../../sync/pot-git/handoff-token';
import { lockAuthorityForHive } from '../../authority/lock-authority';
import {
  runRefAnnouncePublishTick,
  runRefAnnounceReceiveTick,
  decideRefAnnounceReceiveCursor,
} from '../../sync/pot-git/ref-announce-tick';
import {
  REF_ANNOUNCE_EVENT_KEY,
  isSignedRefAnnouncement,
  verifyRefAnnouncement,
  type SignedRefAnnouncement,
  type AnnounceBudgetState,
} from '../../sync/pot-git/ref-announce';
import {
  formatConvergenceVerdict,
  judgeConvergence,
  type AnnouncedSnapshot,
  type ConvergenceState,
  type ConvergenceVerdict,
  type LocalMirror,
} from '../../sync/pot-git/convergence-probe';
import { readSigrefs } from '../../sync/pot-git/sigrefs';
import { STAGING_ADVANCE_EVENT_KEY, isSignedStagingAdvance, type SignedStagingAdvance, type EpochSeq } from '../../sync/pot-git/staging-advance';
// EI-19332963201820362: the ONLY sanctioned way to build a `worktree_bridge`
// metadata value. patchRoutineMetadata is a top-level jsonb merge, so writing
// that key REPLACES it wholesale — constructing it here means a writer cannot
// omit (i.e. silently DELETE) a field. Read that module's header before adding one.
import {
  decideWorktreeBridgePersistence,
  nextWorktreeBridgeState,
  shouldWarnAcceptFree,
} from './worktree-bridge-state';
import {
  defaultRunGit,
  deviceNamespaceKey,
  ensurePotGitRepo,
  hiveGitRepoPath,
  listNamespaces,
  pathExists,
  readNamespaceRef,
  sweepStalePackTmpFiles,
} from '../../sync/pot-git/storage';
import { STAGING_REF } from '../../sync/pot-git/integrator';
// EI-19442274898324113: the ONLY sanctioned way to build an `integrator_progress`
// metadata value — same top-level-jsonb-merge hazard as `worktree_bridge` above,
// one layer more costly because this state GATES A TAKEOVER rather than merely
// reporting. Read that module's header before adding a field or a writer.
import {
  isIntegratorNamespaceBacklogged,
  nextIntegratorProgressState,
  shouldPreemptStalledIntegrator,
  type PriorIntegratorProgressState,
} from './integrator-progress-state';
import { canonicalRepoKey } from '../../sync/pot-git/repo-identity';
import { adoptRefusedRepoKey } from '../../sync/pot-git/adopt-refused-repo-key';
import {
  armNoSuchRepoBackoff,
  devicesToArmForNoSuchRepo,
  isNoSuchRepoBackoffActive,
  noSuchRepoBackoffKey,
  noSuchRepoBackoffSecondsLeft,
} from './no-such-repo-backoff';
import { runOwnHeadPublishTick, type OwnHeadPublishTickOutcome } from '../../sync/pot-git/own-head-publish';
import { describePublishRefusal } from '../../sync/pot-git/publish-guard';
import { bootstrapFromPeer, hasPendingQuarantine } from '../../sync/pot-git/bootstrap';
import { fetchCoalescerKey, withFetchCoalescing } from '../../sync/pot-git/fetch-coalescer';
import {
  openHiveGitDuplexToDevice,
  type HiveGitDuplexRequest,
} from '../../sync/pot-git/peer-dial-registry';
import { Duplex } from 'node:stream';
// EI-18777176681958978: `potHomeSlug` here is the LOCAL registry handle
// (`entry.hive_slug ?? entry.slug`), which on a joiner can differ from the
// OWNER-authored scope the pot_members projection writes under — reading it directly
// returns an EMPTY roster. The *ForLocalPot wrapper resolves the federated scope first
// (a no-op on an owner).
import { listHiveMembersForLocalPot } from '../../federated-pot-scope';
import { resolveUsageActor } from '../usage-actor';
import { loadCachedLocalAnnounceIdentity } from '../../sync/hyperbee/local-announce-identity';
import { resolveDeviceKeychainId } from '../../identity/device-keychain-id';
import { signWithDeviceKey } from '../../identity/sign-with-device-key';
import { resolveAuthorCommsTier } from '../../sync/hyperbee/comms-tier-gate';
import { emitAwaitedEvent } from '../../events/await/engine';
import { decideGitSyncEscalation, oversizedKey, type EscalationReason } from './git-sync-escalation';
import { deriveGenesisBaselineSha } from './genesis-baseline';
import { appendPipelineEvent } from './pipeline-events';
import {
  runGitSync,
  runGitBounded,
  gitTimeoutMsFor,
  discoverSubmodulesRecursive,
  listStashEntries,
  newStashEntries,
  partitionStashEntriesByAge,
  describeStashAge,
  type RunGit,
  type GitSyncConfig,
  type GitSyncOutcome,
  type RepoConflict,
  type RepoError,
  type ScopedOversized,
  type ScopedContentError,
  type StrandedSubmodule,
} from './run-git-sync';
import { emitGitSyncCommittedEvent, emitGitSyncEgressedEvent } from './git-sync-events';
import { parsePapercuspTrailers, recordCommitAttribution, type CommitAttributionRow } from '../../edit-attribution';

const GIT_SYNC_OWNER = 'system:git-sync';
const LOCK_TTL_SEC = 600;
const FULL_COMMIT_SHA = /^[0-9a-f]{40}$/i;
// Keep the lease refresh comfortably inside its expiry window. Long, progressing
// fetches can legitimately run well past LOCK_TTL_SEC; without a refresh the
// resource row expires mid-run and the next scheduled fire enters the same
// checkout concurrently (EI-20224276977835463).
const LOCK_HEARTBEAT_INTERVAL_MS = 60_000;

/**
 * Resource locks coalesce a same-owner acquire into a lease refresh. That is
 * correct for one long-lived caller, but the cron and `git-sync:run` paths both
 * identify themselves as `system:git-sync`; sharing that owner would let two
 * fires enter the same checkout concurrently. Keep the stable identity for
 * broadcasts, but give every fire its own lock owner so the resource store's
 * different-owner conflict path provides real single-flight protection.
 */
const newGitSyncLockOwner = (): string => `${GIT_SYNC_OWNER}:${randomUUID()}`;

/**
 * Return commits newly covered by a proven remote staging head. The bridge
 * emits the head on every up-to-date tick, but an exact-SHA waiter may target
 * an older commit carried by a later head. Restrict the ancestry walk to the
 * previous egress range when possible so a quiet tick does not re-emit an
 * entire repository's history; the event emitter always adds the head itself.
 * Best-effort: a failed local walk leaves the head signal intact.
 */
async function newlyEgressedCommitShas(
  headSha: string,
  repoPath: string,
  previousHeadSha: string | null,
): Promise<string[]> {
  if (previousHeadSha === headSha) return [];
  const range = previousHeadSha && FULL_COMMIT_SHA.test(previousHeadSha) ? `${previousHeadSha}..${headSha}` : headSha;
  const result = await defaultRunGit(['rev-list', '--topo-order', range], repoPath);
  if (result.code === 0) {
    return result.stdout
      .split(/\s+/)
      .map((sha) => sha.trim())
      .filter((sha) => FULL_COMMIT_SHA.test(sha));
  }
  // A stale/missing previous watermark must not suppress the ancestry proof;
  // retry against the head alone before falling back to the head-only event.
  if (range !== headSha) {
    const fallback = await defaultRunGit(['rev-list', '--topo-order', headSha], repoPath);
    if (fallback.code === 0) {
      return fallback.stdout
        .split(/\s+/)
        .map((sha) => sha.trim())
        .filter((sha) => FULL_COMMIT_SHA.test(sha));
    }
  }
  return [];
}
/**
 * The `harness_escalations` row key for ALL git-sync escalations is
 * `(harness_slug, 'git-sync')` — a CONSTANT phase, deliberately NOT the lifecycle
 * phase ('staging'/'testing'/'production') and NOT the routine's branch
 * (git-sync-any-hive P-007, B-05 decision):
 *   - branch-derived phases would orphan an open escalation whenever the routine's
 *     branch changes (the clear-on-clean-pass UPDATE would target a different row),
 *     and would collide with the lifecycle-phase namespace;
 *   - the old constant 'staging' SHARED its row with other phase='staging' writers
 *     (auto-rebase's rebase_conflict, brainstorm) — they clobbered each other via
 *     ON CONFLICT DO UPDATE. A git-sync-owned phase ends that.
 * Consumer audit (2026-06-12): every reader is phase-loose for git-sync rows —
 * `git-pipeline-stats.ts` filters by kind='git-sync-conflict' only; the
 * `harness:escalation` tool / `getEscalation` (harness-readers.ts — the
 * merge-resolver's read path) selects by slug ordered by mtime_ms with no phase
 * filter; the improvements watchdog collectors filter by workspace only. The one
 * phase-keyed reader (`device-harnesses.ts`, joining on the harness's lifecycle
 * status phase) reads LIFECYCLE escalations — git-sync rows moving out of it is
 * intended. Open rows were migrated 'staging' → 'git-sync' in db migration 237.
 */
const ESCALATION_PHASE = 'git-sync';
const ESCALATION_KIND = 'git-sync-conflict';
/** EI-18: repeated push failures / oversized-file exclusions — needs a human/agent,
 *  but is NOT a merge conflict (no resolver dispatch). */
const ESCALATION_ERROR_KIND = 'git-sync-error';
/** The event key the `merge-resolution` launch blueprint declares (its trigger). */
const CONFLICT_EVENT = 'git-sync:conflict';

/**
 * The durable action result returned to an on-demand caller. Cron callers ignore
 * the value, but `git-sync:run` must not collapse a typed pipeline outcome into
 * a void promise and then guess from a HEAD delta (EI-20197846888469383).
 */
export type GitSyncFireOutcome =
  | GitSyncOutcome
  | { status: 'skipped'; reason: string; blockedOn?: string };

/**
 * EI-438 content guard (git-sync-content-guard-2026-06-13 P-004/P-005). Broken
 * files (an .mdx that won't compile, a curly quote used as code) are quarantined
 * from the auto-commit by the content guard (run-git-sync) so they never reach
 * `staging`; the action layer escalates them + dispatches a `content-fixer`.
 *
 * Content escalations get their OWN phase ('git-sync-content'), a SEPARATE row
 * from the conflict/error escalation (phase 'git-sync') — so a content quarantine
 * and a merge conflict coexist + clear independently, never clobbering each other
 * on the single (harness_slug, phase) row. The content-fixer reads its files from
 * the `--git-sync-content-error` extra (below), not this row, so the phase-loose
 * `getEscalation` (mtime-ordered) reader can never feed it the wrong escalation.
 *
 * EI-17 rides this SAME pipeline: `outcome.contentErrors` also carries any dirty
 * deletion a surviving file still (relatively) imports (detectorKey
 * 'unsafe-deletion', see deletion-import-guard.ts) — this layer treats it exactly
 * like a broken .mdx (same quarantine/escalation/content-fixer dispatch/5-tick
 * human-escalation), no separate code path.
 */
const CONTENT_ESCALATION_PHASE = 'git-sync-content';
const CONTENT_ERROR_KIND = 'git-sync-content-error';
/** The event key the `content-fix` launch blueprint declares (its trigger). */
const CONTENT_ERROR_EVENT = 'git-sync:content-error';
/** After this many consecutive ticks with the file STILL broken, stop auto-dispatching
 *  the content-fixer and surface to a human (P-005: never an infinite silent fix loop).
 *  The file stays quarantined regardless, so `staging` is never at risk. */
const MAX_CONTENT_FIXER_ATTEMPTS = 5;

/**
 * EI-20402093158205519 (stranded-submodule census). A POPULATED but UNREGISTERED
 * submodule — a real worktree on disk that `.git/config` carries no
 * `submodule.<name>.url` for — is invisible to every leg of this pipeline:
 * `git submodule status` marks it '-', discovery skips it, so git-sync never
 * visits the repo and CANNOT commit its dirty files. The edit LOOKS landed (the
 * file is on disk and the local build is green) while a clean clone of the branch
 * does not have it at all. That divergence is the defect, and its signature is
 * SILENCE: the pass that strands the work is otherwise a perfectly clean 'synced'.
 *
 * Like the content guard this rides its OWN phase row, separate from the
 * conflict/error row ('git-sync'), so a strand and a merge conflict coexist and
 * clear independently. UNLIKE the content guard it dispatches no fixer, because
 * git-sync must not auto-resolve a strand: these worktrees are commonly parked on
 * deliberate detached pins, and registering one would fetch/merge/push it and
 * UNPIN it. Registering is the operator's call; losing the work silently is not.
 * The row is the whole deliverable — visible, queryable, and self-clearing on the
 * first pass that measures a clean tree.
 */
const STRAND_ESCALATION_PHASE = 'git-sync-strand';
const STRAND_KIND = 'git-sync-strand';

/** Coord identity for git-sync's own broadcasts (mirrors service-health's). */
const GIT_SYNC_IDENTITY: AgentIdentity = {
  ownerId: 'system:git-sync',
  ownerLabel: 'git-sync',
  source: 'static-client',
  workspaceId: null,
  userId: null,
};

/** The action-level knobs parsed from the routine's `trigger_config`: the pure
 *  pipeline config plus the lock surface (which never reaches `runGitSync`). */
interface ActionTrigger {
  config: GitSyncConfig;
  /**
   * Additional REGISTERED resource names to hold exclusively for the tick
   * (`trigger_config.extra_lock_resources`, git-sync-any-hive P-006). papercup's
   * row lists `['git-sync', 'libs-papercusp-submodule']` so the documented
   * back-off protocol ("acquire exclusive(git-sync) to make git-sync back off")
   * keeps working. Names here are a deliberate, human-registered coordination
   * surface — an UNKNOWN name skips the tick with a log, never auto-registers.
   */
  extraLockResources: string[];
}

function configFromTrigger(triggerConfig: Record<string, unknown>): ActionTrigger {
  const extras = Array.isArray(triggerConfig.extra_lock_resources)
    ? triggerConfig.extra_lock_resources.filter((r): r is string => typeof r === 'string' && r.trim().length > 0)
    : [];
  return {
    config: {
      push: triggerConfig.push !== false,
      pushSubmodules: triggerConfig.push_submodules !== false,
      pushSubmoduleOrigins:
        typeof triggerConfig.pushSubmoduleOrigins === 'boolean'
          ? triggerConfig.pushSubmoduleOrigins
          : undefined,
      branch: typeof triggerConfig.branch === 'string' ? triggerConfig.branch : undefined,
      remote: typeof triggerConfig.remote === 'string' ? triggerConfig.remote : undefined,
      maxBlobBytes: typeof triggerConfig.max_blob_bytes === 'number' ? triggerConfig.max_blob_bytes : undefined,
    },
    extraLockResources: extras,
  };
}

/** The per-harness lock resource this slug's tick holds (P-006). One global name
 *  used to serialize ALL harnesses' ticks against each other; now each harness
 *  serializes only against itself + whatever it lists in extra_lock_resources. */
const gitSyncResourceName = (slug: string): string => `git-sync:${slug}`;

/** Minimal tagged-template seam over the txn handle (postgres-js `Sql`), so this
 *  module needs no direct `postgres` type dependency. */
type SqlTag = (strings: TemplateStringsArray, ...values: unknown[]) => Promise<unknown>;

/**
 * Idempotently register the per-slug `git-sync:<slug>` resource (inside the SAME
 * inWorkspaceTxn as the acquire that follows). Without this, an unregistered name
 * makes `tryAcquireResource` return `{ ok:false, reason:'unknown_resource' }`,
 * which used to read as "held" → a PERMANENT silent no-op on any harness whose
 * name nobody had hand-registered. Modeled on sql/008-register-git-sync-resource.sql
 * (no register helper is exported from @papercusp/locks). ON CONFLICT DO NOTHING:
 * a human-edited row is never clobbered. ONLY the per-slug name is auto-registered —
 * extra_lock_resources names must already exist in the registry.
 */
export async function registerGitSyncResource(tx: SqlTag, slug: string): Promise<void> {
  const resource = gitSyncResourceName(slug);
  const description =
    `The automated git-sync pipeline for harness "${slug}" (commit + submodule push + merge + push to origin). ` +
    'Concurrent git-sync runs, or a run racing a peer\'s manual git work on this checkout, race the index/refs.';
  const ruleText =
    `The system:git-sync routine action holds exclusive(${resource}) for the whole ` +
    'commit -> submodule-push -> pointer-bump -> push sequence. A peer doing manual whole-tree git work in this ' +
    `harness's checkout can acquire exclusive(${resource}) to make its git-sync back off that tick.`;
  await tx`
    INSERT INTO agent_resource_registry (resource, description, rule_text, enforcement, match_patterns)
    VALUES (${resource}, ${description}, ${ruleText}, 'advisory', ARRAY[]::text[])
    ON CONFLICT (resource) DO NOTHING
  `;
}

type AcquireState = 'acquired' | 'held' | 'contended' | 'error';
interface AcquireOutcome {
  state: AcquireState;
  /** The resource that blocked the acquisition (state 'held' or 'contended'). */
  blockedOn?: string;
  /** The store's refusal reason (state 'held') — 'unknown_resource' means the
   *  name isn't registered, not that a peer holds it. */
  blockedReason?: string;
}

async function releaseAll(cd: string, owner: string, acquired: string[]): Promise<void> {
  for (const resource of acquired.reverse()) {
    try {
      await inWorkspaceTxn(cd, owner, (tx) =>
        tryReleaseResource(tx, { coordinationDomain: cd, owner, resource }));
    } catch {
      /* best-effort: TTL reaps it anyway */
    }
  }
}

/**
 * Refresh every acquired resource lock while the git pipeline is running.
 *
 * `tryAcquireResource` deliberately coalesces a same-owner acquire into a lease
 * refresh, so this uses the exact same store path and resource-domain contract as
 * the initial acquire. Only one refresh pass may be in flight; a slow lock-store
 * round trip must not build an unbounded interval backlog. The stop function
 * waits for an already-started pass before the caller releases the locks.
 */
function startLockHeartbeat(
  cd: string,
  slug: string,
  resources: string[],
  owner: string,
): () => Promise<void> {
  let inFlight: Promise<void> | null = null;

  const refresh = async (): Promise<void> => {
    for (const resource of resources) {
      try {
        const result = await acquireWithContentionRetry(() =>
          inWorkspaceTxn(cd, owner, (tx) =>
            tryAcquireResource(tx, {
              coordinationDomain: cd,
              resource,
              mode: 'exclusive',
              owner,
              ownerLabel: `git-sync:${slug}`,
              reason: `auto-commit ${slug}`,
              ttlSec: LOCK_TTL_SEC,
            })),
        );
        if (!result.ok) {
          console.error(
            `[git-sync] ${slug}: LOST exclusive lock ${resource} during lease refresh (${result.reason ?? 'refused'})`,
          );
        }
      } catch (e) {
        console.warn(
          `[git-sync] ${slug}: lock heartbeat failed for ${resource}: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }
  };

  const timer = managedSetInterval(
    `git-sync-lock-heartbeat:${slug}`,
    LOCK_HEARTBEAT_INTERVAL_MS,
    () => {
      if (inFlight) return;
      inFlight = refresh().finally(() => {
        inFlight = null;
      });
    },
    { category: 'ephemeral-harness', classification: 'must-sample' },
  );

  return async () => {
    timer.stop();
    if (inFlight) await inFlight;
  };
}

// EI-1720 + worker-fire-path zombie spawns: the lock-acquire contention retry
// (acquireWithContentionRetry / isWorkspaceContended) now lives in the shared
// locks module (also used by file-lock-guard). Re-exported so the existing
// git-sync-action suite keeps importing acquireWithContentionRetry from here.
export { acquireWithContentionRetry } from '../../agent-tools/locks/contention-retry';

/** Acquire `git-sync:<slug>` (auto-registered) + every extra resource exclusively,
 *  or signal held/error (releasing partials). */
async function acquireLocks(
  cd: string,
  slug: string,
  resources: string[],
  acquired: string[],
  owner: string,
): Promise<AcquireOutcome> {
  const perSlug = gitSyncResourceName(slug);
  for (const resource of resources) {
    let r: { ok: boolean; reason?: string };
    try {
      // EI-1720: retry-with-backoff on a TRANSIENT pg 57014/55P03 so a load-driven
      // workspace-lock contention spike delays — but does not multi-minute-stall —
      // the commit, instead of skipping the tick outright.
      r = await acquireWithContentionRetry(() =>
        inWorkspaceTxn(cd, owner, async (tx) => {
          // Auto-register ONLY the per-slug name, in the same txn as its acquire.
          if (resource === perSlug) await registerGitSyncResource(tx as SqlTag, slug);
          return tryAcquireResource(tx, {
            coordinationDomain: cd,
            resource,
            mode: 'exclusive',
            owner,
            ownerLabel: `git-sync:${slug}`,
            reason: `auto-commit ${slug}`,
            ttlSec: LOCK_TTL_SEC,
          });
        }));
    } catch (e) {
      // Reaching here on contention means the load window outlasted the retries;
      // the next tick retries without running unlocked. A non-contention error is
      // SU-lock DB unreachable / not bootstrapped — proceed unlocked (best-effort).
      const contended = isWorkspaceContended(e);
      console.warn(
        `[git-sync] lock ${contended ? 'contended after retries' : 'infra unavailable'} (${resource}): ${e instanceof Error ? e.message : e}`,
      );
      await releaseAll(cd, owner, acquired);
      acquired.length = 0;
      return {
        state: contended ? 'contended' : 'error',
        ...(contended ? { blockedOn: resource, blockedReason: 'lock_contended' } : {}),
      };
    }
    if (!r.ok) {
      // A peer holds it (or an extra name is unregistered) — skip this tick, retry next.
      await releaseAll(cd, owner, acquired);
      acquired.length = 0;
      return { state: 'held', blockedOn: resource, blockedReason: r.reason };
    }
    acquired.push(resource);
  }
  return { state: 'acquired' };
}

/** The /invoke timeout for a merge-resolver run: it drains+takes the git-sync
 *  lock (≤120s) then merges, all within this ceiling. Used BOTH as the invoke
 *  `timeoutMs` AND as the floor the in-flight TTL must clear — one source of
 *  truth so the two can never drift apart. */
const RESOLVER_INVOKE_TIMEOUT_MS = 900_000;
/** Margin past the invoke timeout before a 'dispatched' marker is presumed stale —
 *  covers settle-recording latency + clock skew. */
const RESOLVER_INFLIGHT_MARGIN_MS = 5 * 60_000;
/** How long a 'dispatched' resolver is presumed to still be running before we'd
 *  re-dispatch (P-010). DERIVED from the invoke timeout (+ margin) so it ALWAYS
 *  exceeds it — a still-running resolver is never double-dispatched on the next
 *  conflict tick (git-sync-dx-hardening P-009: the audit's "TTL ≤ timeout" would
 *  have INVERTED this invariant and double-dispatched; the real fix is making the
 *  two constants one derivation, not free-floating magic numbers). Instance-tagging
 *  already re-dispatches a restart-orphaned run immediately; this TTL is only the
 *  backstop for a same-process run whose settle-recording never fires. */
const RESOLVER_INFLIGHT_MS = RESOLVER_INVOKE_TIMEOUT_MS + RESOLVER_INFLIGHT_MARGIN_MS;

/**
 * This operator process incarnation (P-006). Resolver/fixer dispatches are
 * FIRE-AND-FORGET `loopbackFetch` calls whose settle-recording `.then`/`.catch`
 * lives only in the dispatching process, so the marker retains this id for
 * forensic attribution. It is NOT a liveness oracle: several live operator
 * processes share the same routine row, and a reader seeing another instance's
 * marker does not mean that writer died. In-flight dedup therefore uses the
 * durable status + timestamp below; its TTL is the restart-orphan backstop.
 */
const PROCESS_INSTANCE_ID = `${process.pid}.${Date.now().toString(36)}`;

/** The shape of the `metadata->'last_resolver'` marker the dedup reads. */
export interface ResolverMarker {
  status?: string;
  at?: number;
  /** The operator instance that fired the dispatch (P-006), retained for
   *  attribution only. Absent on legacy markers written before instance-tagging. */
  instance?: string;
}

/**
 * Whether a merge-resolver is GENUINELY in-flight for this harness — pure so the
 * dedup WINDOW is directly unit-testable (P-007: the window is keyed on PG
 * timestamps, never on git round-trip timing, so seconds of real fetch/push
 * latency are negligible against the minutes-scale RESOLVER_INFLIGHT_MS / 900s
 * resolver ceiling). This replaced the old "is an escalation open?" dedup, which
 * permanently suppressed the resolver after a SILENT dispatch failure. The rules:
 *   - never-run / already-settled (status !== 'dispatched') → NOT in flight (retry);
 *   - 'dispatched' from ANY instance → in flight until RESOLVER_INFLIGHT_MS
 *     lapses. Multiple live operator processes share this row, so instance
 *     inequality cannot prove an orphan; treating it as one caused overlapping
 *     6-GiB content-fixers and host memory PSI/OOM pressure (EI-20336929607862174);
 *   - the TTL is both the genuinely-slow-run ceiling and the restart-orphan
 *     backstop. A crashed writer may delay one retry, but can never spawn an
 *     unbounded concurrent repair storm.
 */
export function isResolverInFlight(
  lr: ResolverMarker | null | undefined,
  now: number,
  _instanceId: string,
): boolean {
  if (!lr || lr.status !== 'dispatched') return false; // never-run or already settled → retry
  // Instance ids are attribution, not liveness. A different id may be another
  // healthy operator process serving the same workspace, so only the durable TTL
  // may declare a dispatched marker stale.
  return typeof lr.at === 'number' && now - lr.at < RESOLVER_INFLIGHT_MS;
}

async function resolverInFlight(slug: string, workspaceId: string): Promise<boolean> {
  const { sql } = getOrgPg();
  const rows = await sql<{ lr: ResolverMarker | null }[]>`
    SELECT metadata->'last_resolver' AS lr
      FROM harness_shared.routines
     WHERE install_slug = ${slug} AND workspace_id = ${workspaceId} AND target_role = 'system:git-sync'
     LIMIT 1
  `;
  return isResolverInFlight(rows[0]?.lr, Date.now(), PROCESS_INSTANCE_ID);
}

async function writeGitSyncEscalation(slug: string, workspaceId: string, conflicts: RepoConflict[]): Promise<void> {
  const { sql } = getOrgPg();
  const scopes = conflicts.map((c) => c.scope);
  const body = JSON.stringify({
    kind: ESCALATION_KIND,
    harness_slug: slug,
    // Every (sub)repo that conflicted this pass — the escalation (UNIQUE per
    // harness+phase) carries them all so the resolver sees the full set.
    conflicts: conflicts.map((c) => ({ scope: c.scope, conflicted_files: c.conflictedFiles })),
    scope: scopes.join(', '),
    emitted_at: Date.now(),
    detail: `git-sync auto-merge conflicted in ${scopes.join(', ')}; trees aborted clean, merge-resolver dispatched.`,
  });
  await sql.unsafe(
    `INSERT INTO harness_shared.harness_escalations (harness_slug, phase, escalation, mtime_ms, workspace_id)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (harness_slug, phase)
     DO UPDATE SET escalation = EXCLUDED.escalation, mtime_ms = EXCLUDED.mtime_ms`,
    [slug, ESCALATION_PHASE, body, Date.now(), workspaceId],
  );
}

/** Clear git-sync escalations of the given kinds after a clean sync (other kinds intact).
 *  `phase` defaults to the conflict/error phase; content escalations pass their own. */
async function clearGitSyncEscalation(slug: string, kinds: string[], phase: string = ESCALATION_PHASE): Promise<void> {
  const { sql } = getOrgPg();
  await sql.unsafe(
    `UPDATE harness_shared.harness_escalations
        SET escalation = NULL, mtime_ms = $2
      WHERE harness_slug = $1 AND phase = $3
        AND escalation IS NOT NULL
        AND (escalation::jsonb ->> 'kind') = ANY($4)`,
    [slug, Date.now(), phase, kinds],
  );
}

/**
 * EI-438 (P-004): write/refresh the `git-sync-content-error` escalation — the
 * human-visible record that broken files are quarantined (and, once it has failed
 * MAX_CONTENT_FIXER_ATTEMPTS ticks, that a human must step in). Its own phase row,
 * unconditional upsert (no other kind shares 'git-sync-content').
 */
async function writeGitSyncContentEscalation(
  slug: string,
  workspaceId: string,
  contentErrors: ScopedContentError[],
  consecutiveTicks: number,
  needsHuman: boolean,
): Promise<void> {
  const { sql } = getOrgPg();
  const files = contentErrors.map((c) => ({ scope: c.scope, file: c.file, detector: c.detectorKey, error: c.error }));
  const list = contentErrors.map((c) => `${c.scope}/${c.file} [${c.detectorKey}]`).join(', ');
  const body = JSON.stringify({
    kind: CONTENT_ERROR_KIND,
    harness_slug: slug,
    files,
    consecutive_content_error_ticks: consecutiveTicks,
    needs_human: needsHuman,
    emitted_at: Date.now(),
    detail: needsHuman
      ? `git-sync content guard: ${files.length} file(s) STILL failing their content check after ${consecutiveTicks} ticks — the content-fixer could not repair them; a human must fix: ${list}. (They are quarantined — excluded from every auto-commit — so staging stays clean while they wait.)`
      : `git-sync quarantined ${files.length} broken file(s) (excluded from the auto-commit so staging stays clean); content-fixer dispatched: ${list}.`,
  });
  await sql.unsafe(
    `INSERT INTO harness_shared.harness_escalations (harness_slug, phase, escalation, mtime_ms, workspace_id)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (harness_slug, phase)
     DO UPDATE SET escalation = EXCLUDED.escalation, mtime_ms = EXCLUDED.mtime_ms`,
    [slug, CONTENT_ESCALATION_PHASE, body, Date.now(), workspaceId],
  );
}

/**
 * EI-20402093158205519: write/refresh the `git-sync-strand` escalation — the
 * human-visible record that N populated-but-unregistered submodules hold tracked
 * work this pass could not reach. Its own phase row, unconditional upsert (no other
 * kind shares 'git-sync-strand'), so it can never clobber the conflict/error row.
 *
 * The body names the FILES, not just a count: the whole failure mode is an agent
 * believing an edit landed, so a reader must be able to see which edits did not
 * without going to hunt for them. `files` is already capped upstream (20/submodule).
 */
async function writeGitSyncStrandEscalation(
  slug: string,
  workspaceId: string,
  stranded: StrandedSubmodule[],
): Promise<void> {
  const { sql } = getOrgPg();
  const totalFiles = stranded.reduce((n, s) => n + s.trackedFiles, 0);
  const list = stranded.map((s) => `${s.path} (${s.trackedFiles} tracked file(s))`).join(', ');
  const body = JSON.stringify({
    kind: STRAND_KIND,
    harness_slug: slug,
    submodules: stranded.map((s) => ({ path: s.path, tracked_files: s.trackedFiles, files: s.files })),
    stranded_submodule_count: stranded.length,
    stranded_file_count: totalFiles,
    emitted_at: Date.now(),
    detail:
      `git-sync CANNOT COMMIT ${totalFiles} tracked file(s) in ${stranded.length} POPULATED but UNREGISTERED ` +
      `submodule(s): ${list}. They are absent from .git/config (no submodule.<name>.url), so ` +
      `'git submodule status' marks them '-' and discovery skips them entirely — the edits are NOT committed, ` +
      `NOT on origin, and a clean clone of this branch does not have them, even though they are on disk and the ` +
      `local build passes. Fix with: git submodule init <path> (idempotent; copies the .gitmodules URL into ` +
      `.git/config), then re-check the pin before the next tick. git-sync deliberately does NOT auto-resolve ` +
      `this — these worktrees are often parked on deliberate detached pins, and registering one here would ` +
      `fetch/merge/push it and UNPIN it.`,
  });
  await sql.unsafe(
    `INSERT INTO harness_shared.harness_escalations (harness_slug, phase, escalation, mtime_ms, workspace_id)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (harness_slug, phase)
     DO UPDATE SET escalation = EXCLUDED.escalation, mtime_ms = EXCLUDED.mtime_ms`,
    [slug, STRAND_ESCALATION_PHASE, body, Date.now(), workspaceId],
  );
}

/**
 * EI-18: write/refresh the `git-sync-error` escalation (repeated push failures and/or
 * oversized-file exclusions). The (harness_slug, phase) row is SHARED with the
 * conflict escalation — the conditional DO UPDATE makes this a strict non-clobber:
 * an open `git-sync-conflict` (which a merge-resolver may be reading) always wins.
 */
async function writeGitSyncErrorEscalation(
  slug: string,
  workspaceId: string,
  info: { reasons: EscalationReason[]; consecutiveErrorTicks: number; errors: RepoError[]; oversized: ScopedOversized[] },
): Promise<void> {
  const { sql } = getOrgPg();
  const body = JSON.stringify({
    kind: ESCALATION_ERROR_KIND,
    harness_slug: slug,
    reasons: info.reasons,
    consecutive_error_ticks: info.consecutiveErrorTicks,
    errors: info.errors.map((e) => ({ scope: e.scope, message: e.message.slice(0, 500) })),
    oversized: info.oversized.map((f) => ({ scope: f.scope, path: f.path, size_bytes: f.sizeBytes })),
    emitted_at: Date.now(),
    detail:
      `git-sync needs attention: ${info.reasons.join(' + ')}` +
      (info.reasons.includes('push-failure') ? ` — push failed ${info.consecutiveErrorTicks} consecutive ticks (commits NOT reaching origin)` : '') +
      (info.oversized.length > 0 ? ` — ${info.oversized.length} oversized file(s) excluded from auto-commit (gitignore or remove them)` : ''),
  });
  await sql.unsafe(
    `INSERT INTO harness_shared.harness_escalations (harness_slug, phase, escalation, mtime_ms, workspace_id)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (harness_slug, phase)
     DO UPDATE SET escalation = EXCLUDED.escalation, mtime_ms = EXCLUDED.mtime_ms
     WHERE harness_escalations.escalation IS NULL
        OR (harness_escalations.escalation::jsonb ->> 'kind') = $6`,
    [slug, ESCALATION_PHASE, body, Date.now(), workspaceId, ESCALATION_ERROR_KIND],
  );
}

/** Previous tick's EI-18 + content-guard counters from the routine metadata. */
async function readEscalationCounters(
  slug: string,
  workspaceId: string,
): Promise<{ errTicks: number; oversizedKeys: string[]; contentTicks: number }> {
  const { sql } = getOrgPg();
  const rows = await sql<{ et: number; lo: string[] | null; ct: number }[]>`
    SELECT coalesce((metadata->>'consecutive_error_ticks')::int, 0) AS et,
           array(SELECT jsonb_array_elements_text(coalesce(metadata->'last_oversized', '[]'::jsonb))) AS lo,
           coalesce((metadata->>'consecutive_content_error_ticks')::int, 0) AS ct
      FROM harness_shared.routines
     WHERE install_slug = ${slug} AND workspace_id = ${workspaceId} AND target_role = 'system:git-sync'
     LIMIT 1
  `;
  return { errTicks: rows[0]?.et ?? 0, oversizedKeys: rows[0]?.lo ?? [], contentTicks: rows[0]?.ct ?? 0 };
}

/**
 * Spawn a merge-resolver role via the invoke route (P-012) — OBSERVABLY (GAP-2).
 *
 * The `/invoke` route is synchronous (it runs the agent to completion — up to the
 * timeoutMs below, now 900s), so we MUST NOT await it: this runs inside the git-sync
 * routine's DBOS step and blocking it for the resolver's full runtime would stall the
 * routines tick. (The resolver acquires the git-sync resource lock ITSELF when it merges;
 * git-sync's own locks are already released by the time control reaches here.) So this
 * stays fire-and-forget — but it is no longer SILENT:
 *   1. a durable `last_resolver: { status:'dispatched', … }` marker is written FIRST
 *      (awaited), so the attempt is recorded even if the process restarts mid-run;
 *   2. the eventual result (HTTP status, agent exitCode/timedOut, or a network error)
 *      is recorded when the dangling promise settles — instead of vanishing into a
 *      `void … .catch(console.warn)` that went to uncaptured stdout.
 * Query `metadata->'last_resolver'` on the routine to see whether the resolver ran.
 */
async function spawnMergeResolver(slug: string, workspaceId: string, conflicts: RepoConflict[], superprojectBranch: string): Promise<void> {
  // unify-agent-launches-as-blueprints D-002/D-004: the launch is now DECLARATIVE.
  // The `merge-resolution` launch blueprint declares `triggers.event:
  // git-sync:conflict` + its role (decider merge-resolver); we resolve the role +
  // invoke URL from it by the event key, instead of hardcoding `role=merge-resolver`.
  // The conflict DETECTION + the in-flight dedup (`last_resolver`) + the observe
  // loop below stay git-sync's concern — behavior-preserving.
  const target = await resolveLaunchTargetForEvent(CONFLICT_EVENT, { installSlug: slug, workspaceId });
  if (!target) {
    console.warn(`[git-sync] no launch blueprint declares "${CONFLICT_EVENT}" — skipping merge-resolver dispatch`);
    return;
  }
  const { url } = target;
  const scopes = conflicts.map((c) => c.scope);
  const filesSummary = conflicts.map((c) => `${c.scope}: ${c.conflictedFiles.join(', ')}`).join('; ');
  // P-006: pre-compute authorship/intent for the conflicted files (deterministic, best-effort)
  // so the resolver integrates per each side's intent without spending tool calls to discover it.
  let authorship: Awaited<ReturnType<typeof computeConflictAuthorship>> = [];
  try {
    const { projectDirForSlug } = await import('../../operator-notes');
    const repoRoot = await projectDirForSlug(slug, workspaceId);
    if (repoRoot) authorship = await computeConflictAuthorship(repoRoot, conflicts);
  } catch {
    /* best-effort: the resolver prompt has a git-log fallback */
  }
  const dispatchedAt = Date.now();

  // (1) durable "dispatched" marker, awaited — observable even if (2) is lost.
  // Stamp THIS process instance for attribution; liveness is deliberately derived
  // from status + TTL because a different live operator instance shares this row.
  await recordResolverDispatch(slug, workspaceId, { at: dispatchedAt, status: 'dispatched', scopes, instance: PROCESS_INSTANCE_ID });

  // Pipeline history (mig 177): log each resolver SETTLE (not the dispatch) so the
  // Git tab can show resolver success rate. Best-effort, like recordResolverDispatch.
  const logResolverSettle = (status: 'ok' | 'failed' | 'error', extra: Record<string, unknown>): Promise<void> =>
    appendPipelineEvent({ workspaceId, installSlug: slug, kind: 'merge_resolver', status, detail: { scopes, ...extra } });

  // (2) async result recording. The /invoke route reads `extra` (forwarded to
  // invoke-once) — `kickoff` is for human readability only (the route ignores it);
  // the merge-resolver also reads the open escalation, which now lists every scope.
  loopbackFetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      // P-007: the superproject branch comes from the routine's resolved config
      // (cfg.branch ?? 'main') — it is NOT papercup's 'staging' for other harnesses.
      kickoff: `Resolve the git-sync merge conflict(s) in ${scopes.join(', ')} (on the branch each conflicted repo has checked out — superproject = \`${superprojectBranch}\`, submodules = their own default). Conflicted: ${filesSummary}`,
      extra: ['--git-sync-conflict', JSON.stringify({ scopes, files: filesSummary, authorship })],
      // P-010: a real multi-file merge by a higher-effort model needs well beyond the
      // route's 90s default. The invoke-route ceiling is 1200s (the old "~300s ceiling"
      // comment was stale). It drains+takes the git-sync lock (≤120s) first, then merges;
      // RESOLVER_INFLIGHT_MS is DERIVED from this (+5min margin) so it always exceeds it
      // and we never re-dispatch a still-running resolver.
      timeoutMs: RESOLVER_INVOKE_TIMEOUT_MS,
    }),
  })
    .then(async (res) => {
      let exitCode: number | undefined;
      let timedOut: boolean | undefined;
      let detail = '';
      try {
        const j = (await res.json()) as { ok?: boolean; exitCode?: number; timedOut?: boolean; stderr?: string; decisionLine?: string };
        exitCode = j?.exitCode;
        timedOut = j?.timedOut;
        if (j?.ok === false) detail = (j.decisionLine || j.stderr || '').slice(0, 400);
        const settled = res.ok && j?.ok !== false ? 'ok' : 'failed';
        await recordResolverDispatch(slug, workspaceId, {
          at: dispatchedAt,
          status: settled,
          httpStatus: res.status, exitCode, timedOut, detail,
        });
        await logResolverSettle(settled, { httpStatus: res.status, exitCode, timedOut, detail });
      } catch {
        const settled = res.ok ? 'ok' : 'failed';
        await recordResolverDispatch(slug, workspaceId, { at: dispatchedAt, status: settled, httpStatus: res.status });
        await logResolverSettle(settled, { httpStatus: res.status });
      }
    })
    .catch(async (e) => {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn(`[git-sync] merge-resolver dispatch failed (${slug}): ${msg}`);
      await recordResolverDispatch(slug, workspaceId, { at: dispatchedAt, status: 'error', error: msg.slice(0, 300) });
      await logResolverSettle('error', { error: msg.slice(0, 300) });
    });
}

/** Record the merge-resolver dispatch lifecycle onto the routine metadata (GAP-2). */
async function recordResolverDispatch(slug: string, workspaceId: string, info: Record<string, unknown>): Promise<void> {
  try {
    await patchRoutineMetadata(slug, workspaceId, { last_resolver: info });
  } catch (e) {
    console.warn(`[git-sync] failed to record resolver dispatch (${slug}): ${e instanceof Error ? e.message : e}`);
  }
}

/**
 * EI-438 content-fixer dedup (P-004): the SAME in-flight model as the
 * merge-resolver (`isResolverInFlight` is generic over the marker), keyed on its
 * OWN `last_content_fixer` routine-metadata marker so the two dispatchers never
 * suppress each other. A clean re-check tick clears the escalation.
 */
async function contentFixerInFlight(slug: string, workspaceId: string): Promise<boolean> {
  const { sql } = getOrgPg();
  const rows = await sql<{ lr: ResolverMarker | null }[]>`
    SELECT metadata->'last_content_fixer' AS lr
      FROM harness_shared.routines
     WHERE install_slug = ${slug} AND workspace_id = ${workspaceId} AND target_role = 'system:git-sync'
     LIMIT 1
  `;
  return isResolverInFlight(rows[0]?.lr, Date.now(), PROCESS_INSTANCE_ID);
}

/** Record the content-fixer dispatch lifecycle onto the routine metadata. */
async function recordContentFixerDispatch(slug: string, workspaceId: string, info: Record<string, unknown>): Promise<void> {
  try {
    await patchRoutineMetadata(slug, workspaceId, { last_content_fixer: info });
  } catch (e) {
    console.warn(`[git-sync] failed to record content-fixer dispatch (${slug}): ${e instanceof Error ? e.message : e}`);
  }
}

/**
 * Spawn a content-fixer via the invoke route (P-004) — fire-and-forget + observed,
 * the SAME shape as spawnMergeResolver. The fixer needs no git-sync lock: every
 * commit is gated by the content detector, so git-sync can never commit a
 * half-fixed file; the fixer just edits the named files and the next tick re-checks
 * + commits when they pass. It reads its file list from the `--git-sync-content-error`
 * extra (the open escalation is for human visibility, not the fixer's read path).
 */
async function spawnContentFixer(slug: string, workspaceId: string, contentErrors: ScopedContentError[]): Promise<void> {
  const target = await resolveLaunchTargetForEvent(CONTENT_ERROR_EVENT, { installSlug: slug, workspaceId });
  if (!target) {
    console.warn(`[git-sync] no launch blueprint declares "${CONTENT_ERROR_EVENT}" — skipping content-fixer dispatch`);
    return;
  }
  const { url } = target;
  const files = contentErrors.map((c) => ({ scope: c.scope, file: c.file, detector: c.detectorKey, error: c.error }));
  const filePaths = files.map((f) => `${f.scope}/${f.file}`);
  const filesSummary = contentErrors.map((c) => `${c.scope}/${c.file} [${c.detectorKey}]: ${c.error}`).join('; ');
  const dispatchedAt = Date.now();
  // WI-37471: `unsafe-deletion` isn't a syntax fix (there's no syntax — the file
  // doesn't exist) and "restore vs. finish the deletion" is a judgment call about
  // intent the fixer cannot verify from the file system alone. Never tell it to
  // "fix the syntax" for this detectorKey — the persona's own rules escalate it.
  const hasUnsafeDeletion = contentErrors.some((c) => c.detectorKey === 'unsafe-deletion');
  const kickoffInstruction = hasUnsafeDeletion
    ? 'For each file: if its detector is `mdx` or `smart-quotes`, fix ONLY the flagged syntax; ' +
      'if its detector is `unsafe-deletion`, do NOT guess whether to restore the file or finish the ' +
      'deletion — escalate it per your persona\'s "when you cannot fix" instructions. ' +
      'Change nothing else, leave the tree clean, and do NOT push (the next git-sync tick re-checks + commits).'
    : 'Fix ONLY the syntax so each passes its detector, change nothing else, leave the tree clean, and do NOT push (the next git-sync tick re-checks + commits).';

  // (1) durable "dispatched" marker, awaited. The instance tag is forensic
  //     attribution only; status + TTL provide cross-process in-flight dedup.
  await recordContentFixerDispatch(slug, workspaceId, { at: dispatchedAt, status: 'dispatched', files: filePaths, instance: PROCESS_INSTANCE_ID });

  const logSettle = (status: 'ok' | 'failed' | 'error', extra: Record<string, unknown>): Promise<void> =>
    appendPipelineEvent({ workspaceId, installSlug: slug, kind: 'content_fixer', status, detail: { files: filePaths, ...extra } });

  // (2) async result recording. Fire-and-forget — never awaited inside the routine step.
  loopbackFetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      kickoff:
        `Fix the git-sync content-guard quarantine in ${slug}: ${files.length} file(s) fail their content detector and were EXCLUDED from the auto-commit so staging stays clean. ` +
        `${kickoffInstruction} Files: ${filesSummary}`,
      extra: ['--git-sync-content-error', JSON.stringify({ files })],
      // A small, mechanical syntax fix scoped to the named files — well under the
      // invoke route's 1200s ceiling. RESOLVER_INFLIGHT_MS (20 min) exceeds this so a
      // still-running fixer is never double-dispatched.
      timeoutMs: 600_000,
    }),
  })
    .then(async (res) => {
      let exitCode: number | undefined;
      let timedOut: boolean | undefined;
      let detail = '';
      try {
        const j = (await res.json()) as { ok?: boolean; exitCode?: number; timedOut?: boolean; stderr?: string; decisionLine?: string };
        exitCode = j?.exitCode;
        timedOut = j?.timedOut;
        if (j?.ok === false) detail = (j.decisionLine || j.stderr || '').slice(0, 400);
        const settled = res.ok && j?.ok !== false ? 'ok' : 'failed';
        await recordContentFixerDispatch(slug, workspaceId, { at: dispatchedAt, status: settled, httpStatus: res.status, exitCode, timedOut, detail });
        await logSettle(settled, { httpStatus: res.status, exitCode, timedOut, detail });
      } catch {
        const settled = res.ok ? 'ok' : 'failed';
        await recordContentFixerDispatch(slug, workspaceId, { at: dispatchedAt, status: settled, httpStatus: res.status });
        await logSettle(settled, { httpStatus: res.status });
      }
    })
    .catch(async (e) => {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn(`[git-sync] content-fixer dispatch failed (${slug}): ${msg}`);
      await recordContentFixerDispatch(slug, workspaceId, { at: dispatchedAt, status: 'error', error: msg.slice(0, 300) });
      await logSettle('error', { error: msg.slice(0, 300) });
    });
}

/** EI-18775478513129278: the shape of a previously-recorded `bootstrap` metadata
 *  record, read back when a tick has no fresh `outcome` of its own so the durable
 *  on-disk-progress fields (namespaceCount/quarantineRefs/phase/shallow/deepenNext)
 *  can be carried forward instead of clobbered with 0/null. Loosely typed (every
 *  field optional/unknown-ish) because it comes back from `metadata->'bootstrap'`
 *  jsonb written by whatever build wrote the prior tick — never assume its shape. */
interface PriorBootstrapMeta {
  phase?: string | null;
  quarantineRefs?: number;
  shallow?: boolean | null;
  deepenNext?: number | null;
  namespaceCount?: number;
  // WI-37226: the RUN-LENGTH of consecutive dial misses, and when the current run
  // started. The miss warning below has always ended "persistent misses across many
  // ticks are the real signal" — and nothing counted them, so the one signal the log
  // names as real was the one thing it could not show. A single miss is noise (a
  // churning hello channel de-registers between ticks); a sustained run is not.
  consecutiveMisses?: number;
  firstMissAt?: number | null;
}

/** Read the `bootstrap` record a PRIOR tick wrote for this install.
 *
 *  Split out of the dial writer (WI-37226) because the no-topic-stub writer needs the
 *  same read: `patchRoutineMetadata` replaces the WHOLE `bootstrap` key, so any writer
 *  that omits a field DELETES it. That is not hypothetical here — it is the documented
 *  hazard at the stub writer (WI-6284) and the tick-to-tick field erasure of
 *  EI-18799556647570956. A miss-run counter is exactly the kind of field that would be
 *  silently zeroed by the other writer and read as "the run ended".
 */
async function readPriorBootstrapMeta(slug: string, workspaceId: string): Promise<PriorBootstrapMeta | null> {
  const { sql } = getOrgPg();
  const rows = await sql<{ bootstrap: PriorBootstrapMeta | null }[]>`
    SELECT metadata->'bootstrap' AS bootstrap
      FROM harness_shared.routines
     WHERE install_slug = ${slug} AND workspace_id = ${workspaceId} AND target_role = 'system:git-sync'
     LIMIT 1
  `;
  return rows[0]?.bootstrap ?? null;
}

/** Consecutive dial misses before the miss warning ESCALATES.
 *
 *  Deliberately not 1: the miss log itself documents that one miss proves nothing about
 *  reachability. At the observed ~10-minute git-sync cadence this is ~an hour of an
 *  install making zero progress, which is no longer explicable as hello-channel churn.
 *  The escalation reports WALL-CLOCK duration alongside the count, so the message stays
 *  meaningful if the cadence ever changes and the count stops standing in for time.
 */
const BOOTSTRAP_PERSISTENT_MISS_THRESHOLD = 6;

/** Merge a partial metadata patch onto the git-sync routine's JSONB.
 *
 *  The `workspace_id` predicate is LOAD-BEARING, not defensive: `install_slug` is NOT
 *  unique across workspaces, so an unscoped UPDATE here is UNBOUNDED — with N workspaces
 *  holding the same install slug, one tick overwrites all N tenants' routine metadata
 *  with this tenant's state, and that metadata is what `bootstrap.ok`/`bootstrap.converged`
 *  are read from (EI-18799539619330782).
 *
 *  Param order deliberately matches the signature ($1 slug, $2 workspaceId, $3 patch) —
 *  do not "simplify" workspaceId to a trailing $3 to avoid re-indexing test assertions. */
async function patchRoutineMetadata(slug: string, workspaceId: string, patch: Record<string, unknown>): Promise<void> {
  const { sql } = getOrgPg();
  await sql.unsafe(
    `UPDATE harness_shared.routines
        SET metadata = COALESCE(metadata, '{}'::jsonb) || $3::jsonb, updated_at = now()
      WHERE install_slug = $1 AND workspace_id = $2 AND target_role = 'system:git-sync'`,
    [slug, workspaceId, JSON.stringify(patch)],
  );
}

type GitSyncActivityPhase = 'local-sync' | 'post-legs' | 'complete' | 'error';

/**
 * Writer-backed liveness for the whole git-sync action, not just its local commit
 * stage. `recordOutcome` runs before the GitHub bridge and P2P legs, so
 * `last_status: 'synced'` alone is deliberately not terminal evidence. Keep every
 * field in this object on every write: `patchRoutineMetadata` is a top-level JSONB
 * merge and nested omission would otherwise silently erase the marker's state.
 */
async function writeGitSyncActivity(
  slug: string,
  workspaceId: string,
  activity: {
    active: boolean;
    phase: GitSyncActivityPhase;
    started_at: number;
    updated_at: number;
    completed_at: number | null;
    outcome_status: GitSyncOutcome['status'] | null;
  },
): Promise<void> {
  await patchRoutineMetadata(slug, workspaceId, { git_sync_activity: activity });
}

async function recordOutcome(
  slug: string,
  workspaceId: string,
  outcome: GitSyncOutcome,
  consecutiveErrorTicks: number,
  consecutiveContentErrorTicks: number,
  /** EI-18812945811758018: 'push' | 'commit-only:<reason>' — see effectivePushMode. */
  pushMode: string,
): Promise<void> {
  const pushed = 'pushed' in outcome ? outcome.pushed : [];
  const merged = 'merged' in outcome ? outcome.merged : [];
  const mergeCompleted = outcome.mergeCompleted ?? [];
  // errors[] exists on both 'conflict' and 'error' outcomes — record it ALWAYS so a
  // sibling (sub)repo error on a conflict tick isn't invisible (it was: a non-error
  // status used to drop the error list entirely, e.g. a libs/papercusp push failure
  // hidden behind a libs/generic/sync conflict).
  const errors = 'errors' in outcome ? outcome.errors : [];
  const localSyncRecordedAt = Date.now();
  await patchRoutineMetadata(slug, workspaceId, {
    last_status: outcome.status,
    last_synced_at: localSyncRecordedAt,
    // EI-20315742298217655: the github-bridge leg runs after this write and may
    // promote an owner-actionable egress failure into the top-level last_status /
    // last_error fields. Keep the local commit stage explicit so readers can still
    // distinguish a clean/local commit result from a bridge-only failure. The head
    // value is sticky, just like the legacy head_sha field: only a new local commit
    // writes it, while nothing/error/conflict ticks preserve the last observed head.
    local_sync_status: outcome.status,
    // A completed non-skipped outcome supersedes any earlier eligibility skip.
    // JSONB patches are additive, so leaving these fields untouched makes a later
    // `synced` tick look contradictory (`last_status: synced` alongside an old
    // `last_skip_reason: remote_hive_view`). That stale pair caused readers to
    // compare a commit-only/P2P worktree head with origin and diagnose a false
    // remote-sync failure (EI-20269018542485023).
    last_skip_reason: null,
    last_skipped_at: null,
    last_pushed: pushed,
    // EI-18812945811758018: rides the SAME single write, so `last_pushed` is never
    // readable without the mode that says what an empty one MEANS for this member.
    push_mode: pushMode,
    last_merged: merged,
    // A successful merge stage is stronger evidence than `last_merged` (which only
    // reports a merge commit). Clear the proof on every tick that did not earn it so
    // a later reader can never mistake an old merge for this tick's evidence.
    last_merge_completed: mergeCompleted,
    last_merge_completed_at: mergeCompleted.length > 0 ? localSyncRecordedAt : null,
    last_conflicts: outcome.status === 'conflict' ? outcome.conflicts.map((c) => c.scope) : [],
    last_errors: errors.map((e) => `${e.scope}: ${e.message}`),
    // GAP-3: clear the stale single error on any non-error outcome (JSONB `||` keeps old keys).
    last_error: outcome.status === 'error' ? errors.map((e) => `${e.scope}: ${e.message}`).join('; ') : null,
    // EI-18 counters: ticks-of-uninterrupted-error + the oversized set (scope:path keys).
    consecutive_error_ticks: consecutiveErrorTicks,
    last_oversized: outcome.oversized.map(oversizedKey),
    // EI-438 content-guard counters: consecutive ticks with a quarantined file + the set.
    consecutive_content_error_ticks: consecutiveContentErrorTicks,
    last_content_errors: outcome.contentErrors.map((c) => `${c.scope}/${c.file} [${c.detectorKey}]`),
    // WI-1416: a COMPLETED fire resets the consecutive-reap counter the executor
    // reaper increments on each cancel+requeue — so `reaped_count` reads as "reaps
    // since the last completed fire" (the git-sync-stall-watchdog's persistent-reap
    // signal), never a forever-growing total.
    reaped_count: 0,
    ...(outcome.status === 'synced'
      ? { head_sha: outcome.headSha, local_sync_head_sha: outcome.headSha }
      : {}),
  });
}

/**
 * WI-3072: recurrence guard for the EI-7685 class — an agent ran `git stash` on the
 * shared canonical staging tree (or a submodule) and it sat there silently, LOOKING
 * like vanished/reverted work to every other agent (git-sync only ever commits the
 * WORKING TREE; it never sees, let alone recovers, a stash). Detect any stash entry
 * NOT in the known baseline and broadcast loudly — a silent-fleet-work-vanish
 * detector, not a fix (stashing is sometimes deliberate; this only makes it VISIBLE).
 *
 * Deliberately outside the commit/push pipeline: PURELY ADDITIVE, read-only
 * (`git stash list`, never `pop`/`drop`/`apply`), and must NEVER throw or block a
 * commit/push — a detection failure here is silently skipped, not surfaced as a
 * sync error (this is a courtesy alert, not a safety gate). The known-SHA baseline
 * persists on the routine's own metadata (`known_stash_shas`), the same
 * `patchRoutineMetadata` mechanism `recordOutcome` already uses for
 * `last_pushed`/`last_conflicts` — no new table (reuse-first).
 */
async function checkForNewStashes(slug: string, workspaceId: string, superRepoPath: string): Promise<void> {
  try {
    const runGit: RunGit = (args, cwd) => runGitBounded(args, cwd, gitTimeoutMsFor(args));
    const subPaths = await discoverSubmodulesRecursive(runGit, superRepoPath);
    const repos: { scope: string; path: string }[] = [
      { scope: 'superproject', path: superRepoPath },
      ...subPaths.map((s) => ({ scope: s, path: join(superRepoPath, s) })),
    ];

    const { sql } = getOrgPg();
    const [row] = await sql<{ known: unknown }[]>`
      SELECT metadata->'known_stash_shas' AS known
        FROM harness_shared.routines
       WHERE install_slug = ${slug} AND workspace_id = ${workspaceId} AND target_role = 'system:git-sync'
       LIMIT 1`;
    // EI-19449313204576061 — THE ROOT CAUSE. `metadata->'known_stash_shas'` returns SQL
    // NULL when the key has never been written, which is a categorically different fact
    // from "the baseline was recorded and it was empty". Collapsing both into `[]` made
    // the FIRST observation report every pre-existing stash as 🚨 NEW — which is exactly
    // what happened on 2026-08-03, broadcasting two stashes aged 12 and 13 WEEKS to the
    // whole fleet, with `git stash pop`/`drop` as the implied remedy on a shared tree
    // holding a peer's 36-file, +2205/-804 stash. The detector never observed those
    // stashes being created; it inferred "new" from the absence of its own baseline.
    const baselineRecorded = row !== undefined && row.known !== null && row.known !== undefined;
    const knownShas = Array.isArray(row?.known) ? (row.known as unknown[]).filter((s): s is string => typeof s === 'string') : [];

    const allShas: string[] = [];
    const fresh: { scope: string; sha: string; subject: string; createdAt: string }[] = [];
    for (const r of repos) {
      const entries = await listStashEntries(runGit, r.path);
      for (const e of entries) allShas.push(e.sha);
      for (const e of newStashEntries(entries, knownShas)) fresh.push({ scope: r.scope, ...e });
    }

    // First observation ever: SEED the baseline silently. Anything present now predates
    // the detector, so there is nothing it can honestly call new.
    if (!baselineRecorded) {
      await patchRoutineMetadata(slug, workspaceId, { known_stash_shas: allShas });
      if (allShas.length > 0) {
        console.warn(
          `[git-sync] ${slug}: stash baseline BOOTSTRAPPED with ${allShas.length} pre-existing ` +
            `entr${allShas.length === 1 ? 'y' : 'ies'} — not alerting (a first observation cannot ` +
            `establish that anything is new). Future entries will diff against this baseline.`,
        );
      }
      return;
    }

    // Persist the CURRENT set every tick (not an ever-growing history) — a stash later
    // popped/dropped and never recreated should not linger in the baseline forever, and
    // an identical-content stash re-pushed after a drop legitimately re-alerts (it IS a
    // new event worth re-surfacing, not noise).
    await patchRoutineMetadata(slug, workspaceId, { known_stash_shas: allShas });
    if (fresh.length === 0) return;

    const nowMs = Date.now();
    const { recent, preExisting } = partitionStashEntriesByAge(fresh, nowMs);
    const describe = (e: (typeof fresh)[number]) =>
      `${e.scope}: ${e.sha.slice(0, 8)} (${describeStashAge(e, nowMs)}) "${e.subject.slice(0, 80)}"`;

    // Newly-VISIBLE but old entries are not an emergency and must never carry the
    // pop/drop prompt — a false urgency pointed at a destructive op on a shared tree is
    // worse than silence, and crying wolf trains agents to ignore the real signal.
    if (preExisting.length > 0) {
      console.warn(
        `[git-sync] ${slug}: ${preExisting.length} previously-unseen but PRE-EXISTING stash ` +
          `entr${preExisting.length === 1 ? 'y' : 'ies'} (older than 24h — NOT new work, no action implied): ` +
          `${preExisting.map(describe).join('; ')}`,
      );
    }
    if (recent.length === 0) return;

    const context =
      preExisting.length > 0
        ? ` (plus ${preExisting.length} older pre-existing entr${preExisting.length === 1 ? 'y' : 'ies'}, not counted above)`
        : '';
    const summary =
      `🚨 NEW git-stash entry on the canonical ${slug} tree (${recent.length})${context} — a stash HIDES ` +
      `uncommitted work from every agent (git-sync only ever commits the working tree, never a stash). ` +
      `INSPECT FIRST: 'git stash show --stat <sha>' (read-only) in the affected repo. Do NOT reflexively ` +
      `'stash pop'/'drop' — this checkout is shared, the stash is very likely a PEER's in-flight work, and ` +
      `popping it into a tree you don't own is the destructive-git-op class CLAUDE.md forbids. Recovery is ` +
      `the stash owner's call. ${recent.map(describe).join('; ')}`;
    console.warn(`[git-sync] ${slug}: ${summary}`);
    await sendMessage(GIT_SYNC_IDENTITY, { to: ['*'], summary, category: 'git-sync' }).catch(() => {});
  } catch (e) {
    console.warn(`[git-sync] ${slug}: stash-check failed (non-fatal, best-effort, never blocks the sync): ${e instanceof Error ? e.message : e}`);
  }
}

// ── Runtime eligibility gate (git-sync-any-hive P-008, action half) ─────────────

/**
 * Belt-and-braces gate before the pipeline runs: a routine row pointing at a hive
 * HOME (non-repo state dir), a joiner-side remote-hive VIEW, a non-local
 * deployment, or a vanished / non-git checkout must NO-OP (logged + recorded as
 * skipped) instead of error-escalating every 10 minutes. The verdict (including
 * the on-disk vanished-checkout / missing-.git checks) is B-01's
 * `gitSyncEligibility` — the SAME module the seed sites consult, so seed time
 * and run time can never disagree on the vocabulary. Best-effort: an unreadable
 * registry FAILS OPEN (the pipeline's own path resolution will surface the error).
 */
async function gitSyncRuntimeGate(
  slug: string,
  workspaceId: string,
  repoPathOverride?: string | null,
): Promise<{ gate: GitSyncEligibility; entry?: ProjectEntry }> {
  let entry: ProjectEntry | undefined;
  try {
    entry = (await loadHarnessRegistry(workspaceId)).projects.find((p) => p.slug === slug);
  } catch (e) {
    console.warn(`[git-sync] ${slug}: registry unreadable for the eligibility gate — proceeding: ${e instanceof Error ? e.message : e}`);
    return { gate: { eligible: true } };
  }
  // A vanished registry entry reads the same as a vanished checkout: no path.
  if (!entry) return { gate: { eligible: false, reason: 'no_path' } };
  // A manual fire pins the exact tree it measured before entering the action.
  // Validate that pinned path rather than silently gating a freshly-resolved
  // sibling checkout if the ambient registry changes underneath the call.
  const gatedEntry = repoPathOverride === undefined
    ? entry
    : { ...entry, path: repoPathOverride ?? '' };
  return { gate: gitSyncEligibility(gatedEntry), entry: gatedEntry };
}

/** P-004/P-006: build the live attribution roster (active agents + their declared files) from
 *  coord presence. Best-effort — a presence-read failure degrades to [] (no attribution). The lazy
 *  import breaks a load-time cycle (git-sync-action is loaded by the system-action registry). */
async function loadAttributionRoster(workspaceId: string | null): Promise<AttributionRosterEntry[]> {
  return (await loadPresenceAttribution(workspaceId)).roster;
}

/**
 * ONE presence read, TWO derived views (WI-37668).
 *
 * `roster` keeps the historical semantics: only agents that declared `current_files`, because an
 * entry with no files can attribute nothing.
 *
 * `declaredIntentByAgent` deliberately spans ALL live agents, files or not — it supplies a commit
 * SUBJECT, which needs no declared files to be meaningful. Deriving it from the FILTERED roster
 * was a real bug (caught on the live hot path 2026-08-10): the ledger's whole purpose is to
 * attribute agents who never declared files, and those are exactly the agents the filter drops —
 * so every sentinel intent fell through to the default subject and the recovery never fired.
 */
async function loadPresenceAttribution(
  workspaceId: string | null,
): Promise<{ roster: AttributionRosterEntry[]; declaredIntentByAgent: Map<string, string> }> {
  try {
    const { listPresence } = await import('../../agent-tools/coordination/presence');
    const recs = await listPresence({ workspaceId });
    const declaredIntentByAgent = new Map<string, string>();
    for (const r of recs) {
      const declared = (r.intent ?? '').trim();
      if (!isGenericLockIntent(declared) && !declaredIntentByAgent.has(r.ownerId)) {
        declaredIntentByAgent.set(r.ownerId, declared);
      }
    }
    const roster = recs
      .map((r) => ({
        agent: r.ownerId,
        agentLabel: r.ownerLabel ?? undefined,
        intent: r.intent ?? undefined,
        files: Array.isArray(r.currentFiles) ? r.currentFiles : [],
      }))
      .filter((e) => e.files.length > 0);
    return { roster, declaredIntentByAgent };
  } catch {
    return { roster: [], declaredIntentByAgent: new Map() };
  }
}

/**
 * A ledger `intent` that is really the LOCK HOOK'S OWN NAME, not a declared intent (WI-37668).
 *
 * The automatic per-edit file-lock hook acquires with `intent: f'PreToolUse:{tool_name}'`
 * (~/.papercusp/hooks/cc/pretooluse-locks-acquire.sh), and locks:acquire persists that verbatim
 * into the edit ledger. It is a lifecycle label, never a description of the work — and since it
 * is non-empty, `intentToSubject` would happily render it as a commit SUBJECT
 * ("PreToolUse:Edit (su · su-1bf26)"). Measured 2026-08-10: 3,180 of ~3,260 ledger rows in the
 * last 24h (97.5%) carry exactly this sentinel, so ungated it would be the subject of nearly
 * every attributed commit — strictly worse than the single `chore(git-sync): auto-commit`
 * it replaces, on the fleet-wide commit hot path.
 *
 * Treating it as ABSENT (so the agent's declared coord intent wins, else the default subject)
 * is the same precedent the lock hook already applies to its own blocked-peer message:
 * `intent = b.get('holder_intent') or b.get('intent')` — declared intent first, generic second.
 */
const GENERIC_LOCK_INTENT_RE = /^(?:Pre|Post)ToolUse:/i;

/** True when a roster `intent` is the lock hook's lifecycle label rather than declared work. */
export function isGenericLockIntent(intent: string | undefined | null): boolean {
  const line = (intent ?? '').trim();
  return line.length === 0 || GENERIC_LOCK_INTENT_RE.test(line);
}

/**
 * WI-37668: merge the ledger + presence rosters, recovering a real commit SUBJECT for ledger
 * entries whose `intent` is only the lock hook's sentinel.
 *
 * The ledger stays authoritative for WHICH FILES belong to WHICH AGENT (durable — it outlives
 * the session, which is the whole point of D-002); presence is consulted ONLY to supply the
 * agent's declared intent when the ledger's is a generic label. An agent with no usable intent
 * on either side yields `undefined`, which `intentToSubject` renders as
 * DEFAULT_GIT_SYNC_SUBJECT — today's message, never the sentinel.
 *
 * Pure + exported so the subject-recovery rule is guarded directly.
 */
export function mergeAttributionRosters(
  ledger: AttributionRosterEntry[],
  presence: AttributionRosterEntry[],
  /** Agent → declared intent, spanning ALL live agents (see loadPresenceAttribution). Omitted ⇒
   *  derived from `presence`, which is correct only when that array is itself unfiltered. */
  declaredIntents?: Map<string, string>,
): AttributionRosterEntry[] {
  const declaredIntentByAgent = declaredIntents ?? new Map<string, string>();
  if (!declaredIntents) {
    for (const p of presence) {
      const declared = (p.intent ?? '').trim();
      if (!isGenericLockIntent(declared) && !declaredIntentByAgent.has(p.agent)) {
        declaredIntentByAgent.set(p.agent, declared);
      }
    }
  }
  const repaired = ledger.map((e) => ({
    ...e,
    intent: isGenericLockIntent(e.intent) ? declaredIntentByAgent.get(e.agent) : e.intent?.trim(),
  }));
  return [...repaired, ...presence];
}

/** P-003 (deterministic-commit-workitem-attribution-2026-06-22): the attribution roster,
 *  preferring the DURABLE edit ledger (keyed by workspace) over live presence — so a commit is
 *  attributed even after the editing agent's session ended (D-002), and carries the work-item(s)
 *  it was claimed under. Ledger entries come FIRST so attributionMapForRepo's first-wins gives
 *  them priority; presence fills any files the ledger window missed (and supplies agentLabels).
 *  Best-effort throughout: a ledger-read failure degrades to presence, exactly as before. */
async function loadAttributionRosterMerged(
  workspaceId: string | null,
): Promise<AttributionRosterEntry[]> {
  let ledger: AttributionRosterEntry[] = [];
  try {
    // WI-37668: scope the ledger read by WORKSPACE, not by this repo's root. `repo_root` in the
    // ledger is the lock coordination domain (the repo root of whichever operator process served
    // locks:acquire), not the repo the edited files live in — keying on it matched zero rows and
    // made this whole flag inert. See readEditAttributionRoster's doc comment.
    const { readEditAttributionRoster } = await import('../../edit-attribution');
    ledger = (await readEditAttributionRoster({ workspaceId })).map((e) => ({
      agent: e.agent,
      intent: e.intent,
      files: e.files,
      workItems: e.workItems,
      planSlug: e.planSlug,
      sessionId: e.sessionId,
    }));
  } catch {
    /* best-effort: fall through to presence */
  }
  const { roster, declaredIntentByAgent } = await loadPresenceAttribution(workspaceId);
  return mergeAttributionRosters(ledger, roster, declaredIntentByAgent);
}

/** P-006 (assign-don't-broadcast / F5): recipients for a content-guard escalation — the agents who
 *  declared the quarantined files (ASSIGNED, not a fleet broadcast). Returns ['*'] when derived
 *  attribution is OFF or nothing matched, so it degrades to today's broadcast. Gated on the same
 *  GIT_SYNC_DERIVED_ATTRIBUTION flag as P-004 (both DERIVE who from presence). */
async function assigneesForContentErrors(
  slug: string,
  workspaceId: string | null,
  contentErrors: ScopedContentError[],
): Promise<string[]> {
  try {
    if (!(await getFlag(FLAGS.GIT_SYNC_DERIVED_ATTRIBUTION, slug))) return ['*'];
    const roster = await loadAttributionRoster(workspaceId);
    // Resolve the superproject root so absolute current_files normalize to repo-relative (lazy
    // import to keep the registry load-graph acyclic, like loadAttributionRoster's presence read).
    const { projectDirForSlug } = await import('../../operator-notes');
    const superRoot = (await projectDirForSlug(slug, workspaceId ?? undefined)) ?? undefined;
    const agents = agentsForScopedFiles(
      roster,
      contentErrors.map((c) => ({ scope: c.scope, file: c.file })),
      superRoot,
    );
    return agents.length ? agents : ['*'];
  } catch {
    return ['*'];
  }
}

/**
 * P-004 (deterministic-commit-workitem-attribution-2026-06-22): after a synced tick, read the
 * `Papercusp-Work-Item/Agent/Session/Plan` trailers off the per-agent commits git-sync just made
 * (run-git-sync wrote them) + their changed files, and persist them as git_sync_commit_attribution
 * rows — the fast reverse-index the doc-drift (P-005) + merge-resolver (P-006) consumers join.
 * DETERMINISTIC + best-effort (D-006): pure git reads + a bulk insert, NO LLM. Dedup by commit_sha
 * (idempotent across ticks); bounded to the last 50 commits; superproject only for now (a
 * superproject commit that touched a submodule shows the gitlink path — submodule-inner attribution
 * is a follow-on). Never throws.
 */
async function recordSyncedCommitAttribution(slug: string, workspaceId: string): Promise<void> {
  try {
    const { projectDirForSlug } = await import('../../operator-notes');
    const repoRoot = await projectDirForSlug(slug, workspaceId);
    if (!repoRoot) return;
    const { runGit } = await import('../docs/git-runner');

    const logRes = await runGit(['log', '-n', '50', '--format=%H'], repoRoot);
    if (logRes.code !== 0) return;
    const shas = logRes.stdout.split('\n').map((s) => s.trim()).filter(Boolean);
    if (shas.length === 0) return;

    // Which of these are already recorded? (idempotent re-run across ticks.)
    const { sql } = getOrgPg();
    const existing = await sql<{ commit_sha: string }[]>`
      SELECT DISTINCT commit_sha FROM harness_shared.git_sync_commit_attribution
       WHERE commit_sha = ANY(${shas})`;
    const seen = new Set(existing.map((r) => r.commit_sha));

    const rows: CommitAttributionRow[] = [];
    for (const sha of shas) {
      if (seen.has(sha)) continue;
      const body = (await runGit(['show', '-s', '--format=%B', sha], repoRoot)).stdout;
      const t = parsePapercuspTrailers(body);
      // Only OUR attributed git-sync commits carry these — skip everything else.
      if (!t.agent && t.workItems.length === 0) continue;
      const filesRes = await runGit(['show', '--name-only', '--format=', sha], repoRoot);
      const files = filesRes.stdout.split('\n').map((s) => s.trim()).filter(Boolean);
      for (const file of files) {
        const base = {
          workspaceId,
          harnessSlug: slug,
          repo: 'superproject',
          commitSha: sha,
          file,
          agentId: t.agent,
          sessionId: t.sessionId,
          planSlug: t.planSlug,
        };
        if (t.workItems.length === 0) {
          rows.push(base);
        } else {
          // one row per (file × work-item) — honest multiplicity (D-003).
          for (const wi of t.workItems) rows.push({ ...base, workItemId: wi });
        }
      }
    }
    await recordCommitAttribution(rows);
  } catch {
    // best-effort: commit attribution must never affect git-sync.
  }
}

/**
 * P-006 (deterministic-commit-workitem-attribution-2026-06-22): pre-compute authorship/intent
 * context for the conflicted files so the merge-resolver receives it WITHOUT spending tool calls
 * to discover it (D-006). Reads the recent commits that touched each conflicted file + their
 * `Papercusp-Work-Item/Agent` trailers (git-sync's per-agent commits write them; the commit
 * subject IS the authoring agent's intent). Deterministic git reads, best-effort: returns [] on
 * any failure — the merge-resolver.md prompt has a git-log fallback. Bounded to 20 files/scope.
 */
async function computeConflictAuthorship(
  repoRoot: string,
  conflicts: RepoConflict[],
): Promise<
  Array<{ scope: string; file: string; recent: Array<{ sha: string; subject: string; workItems: string[]; agent?: string }> }>
> {
  try {
    const { runGit } = await import('../docs/git-runner');
    const out: Array<{
      scope: string;
      file: string;
      recent: Array<{ sha: string; subject: string; workItems: string[]; agent?: string }>;
    }> = [];
    for (const c of conflicts) {
      // a submodule conflict's files are relative to the submodule repo; cd there (D-015).
      const repoDir = c.scope === 'superproject' ? repoRoot : `${repoRoot}/${c.scope}`;
      for (const file of c.conflictedFiles.slice(0, 20)) {
        // %x1f field-sep, %x1e record-sep so a multi-line %B body parses unambiguously.
        const res = await runGit(['log', '-n', '5', '--format=%H%x1f%B%x1e', '--', file], repoDir);
        if (res.code !== 0) continue;
        const recent = res.stdout
          .split('\x1e')
          .map((s) => s.trim())
          .filter(Boolean)
          .map((block) => {
            const sep = block.indexOf('\x1f');
            const sha = (sep >= 0 ? block.slice(0, sep) : block).trim();
            const body = sep >= 0 ? block.slice(sep + 1) : '';
            const t = parsePapercuspTrailers(body);
            return { sha: sha.slice(0, 12), subject: body.split('\n')[0]?.trim() ?? '', workItems: t.workItems, agent: t.agent };
          })
          .filter((r) => r.sha.length > 0);
        if (recent.length > 0) out.push({ scope: c.scope, file, recent });
      }
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * The registered `system:git-sync` handler.
 *
 * WI-1416 (bg-host-freeze-eventloop-stall P-006): registered with `ownSteps`, so the
 * routine engine runs this at the WORKFLOW layer and the phases below checkpoint as
 * DBOS sub-steps (`git-sync:eligibility` → `git-sync:submodules` →
 * `git-sync:pointer-bump` → `git-sync:push` → `git-sync:record`). Before, the whole
 * handler was ONE opaque step recording no operation_output until it fully completed —
 * on the big tree that routinely takes >90s, so the executor reaper's orphan heuristic
 * cancelled+requeued every fire mid-flight (restart-from-scratch loop, ~1 commit/40min,
 * WI-1415). Checkpointed, the reaper sees genuine progress within seconds, and a
 * stalled/killed fire RESUMES from its last checkpoint. Every git phase is replay-safe
 * (see GitSyncStepRunner in run-git-sync.ts): a re-run commit is `nothing to commit`,
 * a re-run push is `Everything up-to-date` — no double-commit.
 */
async function handleGitSync(
  ctx: SystemActionCtx,
  repoPathOverride?: string | null,
): Promise<GitSyncFireOutcome> {
  const { installSlug: slug, workspaceId } = ctx;
  const { config: cfg, extraLockResources } = configFromTrigger(ctx.triggerConfig);
  const cd = workspaceId || '*';

  // STEP `git-sync:eligibility` — checkpoints within seconds of the fire starting, so
  // even a fire stalled in the lock/git phases below already shows function_id > 0.
  // Also stamps the `fire_started_at` breadcrumb: paired with `reaped_count` (stamped
  // by the executor reaper on each cancel, cleared by recordOutcome on completion) it
  // makes a persistent reap-loop a durable, queryable signal for the
  // git-sync-stall-watchdog. P-008 runtime gate: ineligible rows no-op (logged +
  // recorded), never escalate.
  const gate = await runCheckpointedStep(
    'git-sync:eligibility',
    async (): Promise<GitSyncEligibility & { hiveGitMode?: PotGitMode; repoPath?: string }> => {
      await patchRoutineMetadata(slug, workspaceId, { fire_started_at: Date.now() });
      const { gate: g, entry } = await gitSyncRuntimeGate(slug, workspaceId, repoPathOverride);
      if (!g.eligible) {
        await patchRoutineMetadata(slug, workspaceId, {
          last_status: 'skipped',
          local_sync_status: 'skipped',
          last_skip_reason: g.reason,
          last_skipped_at: Date.now(),
        });
        return g;
      }
      // github-bridge P-003 (S-5, run-time half): re-consult the hive's git mode
      // EVERY tick — a hive flipped legacy→bridged must stop origin-pushing without
      // a routine re-seed (the seeded trigger_config.push predates the flip). Only
      // resolved for hive members (hive_slug) / self_repo hive homes; getPotGitMode
      // is fail-open: absent/junk/store-error all read 'legacy' (today's behavior).
      const potHomeSlug = entry ? entry.hive_slug ?? (entry.self_repo ? entry.slug : undefined) : undefined;
      if (potHomeSlug && workspaceId) {
        const mode = await getPotGitMode(workspaceId, potHomeSlug);
        if (mode !== 'legacy') return { ...g, hiveGitMode: mode, ...(entry?.path ? { repoPath: entry.path } : {}) };
      }
      return { ...g, ...(entry?.path ? { repoPath: entry.path } : {}) };
    },
  );
  if (!gate.eligible) {
    console.log(`[git-sync] ${slug}: ineligible (${gate.reason}) — skipping this tick`);
    return { status: 'skipped', reason: gate.reason ?? 'ineligible' };
  }
  // The scoped eligibility snapshot already resolved the canonical tree. Keep
  // that ONE path through the entire tick; only the fail-open unreadable-registry
  // case needs a final workspace-scoped lookup. Explicit null from a manual fire
  // remains authoritative and must not fall back to ambient state.
  const repoPath = repoPathOverride !== undefined
    ? repoPathOverride
    : gate.repoPath ?? await (await import('../../operator-notes')).projectDirForSlug(slug, workspaceId);
  // github-bridge P-003: on a bridged/p2p-only hive, member git-sync is COMMIT-ONLY —
  // the bridge writer (integrator lease holder) is the sole origin pusher (S-1).
  // The local commit still runs; the dedicated GitHub-ingress/admission and P2P
  // worktree-bridge legs below own remote-to-worktree flow.
  if (gate.hiveGitMode) {
    // EI-20232774599730947: do not bypass the P2P/GitHub admission path with a
    // second direct origin fetch+merge. In particular, a restored installer
    // seed retains an intentionally unrelated local lineage; retrying its
    // one-time transplant every tick eventually conflicts with ordinary local
    // git-sync commits and paints an otherwise healthy P2P writer red.
    cfg.reconcileSuperprojectOrigin = false;
    // WI-40066: a bridged GitHub hive still needs the fail-closed release-main
    // ancestry repair. The ordinary origin reconciler stays disabled (content
    // continues through GitHub admission + P2P), while runGitSync may record an
    // `ours` parent only when every main-only tree entry is already represented
    // exactly on local staging. A p2p-only hive has no GitHub release channel
    // and must not fetch one opportunistically.
    cfg.bridgeContainedReleaseMainOnCommitOnly = gate.hiveGitMode === 'bridged';
    if (cfg.push) {
      console.log(`[git-sync] ${slug}: hive git mode '${gate.hiveGitMode}' — commit-only this tick (the bridge owns origin pushes)`);
      cfg.push = false;
      // EI-18689553108460319 + WI-6016: the bridge writer owns the
      // SUPERPROJECT's canonical refs — NOT an independently-hosted submodule
      // library that nothing else ever pushes. Only a runtime legacy→P2P flip
      // opts this previously-pushing member back in. A joiner whose persisted
      // config was already push:false and omitted this key must still push
      // nothing anywhere (AH-6).
      if (cfg.pushSubmoduleOrigins === undefined) cfg.pushSubmoduleOrigins = true;
    }
  }
  // EI-18812945811758018: the EFFECTIVE push mode for this tick, recorded later as part
  // of recordOutcome's SINGLE metadata write (never its own patch — a skipped tick must
  // still write nothing, and the settle write is asserted as the only one).
  //
  // Read surfaces need this to tell "this member never pushes, BY DESIGN" apart from
  // "the push leg is broken": an empty `last_pushed` means opposite things in those two
  // cases. Without it dev:pipeline_position read both as a fault and prescribed
  // `git-sync:run` — a lever structurally INERT on a bridged hive (a forced run commits
  // and still pushes nothing, exactly as designed).
  const effectivePushMode = cfg.push
    ? 'push'
    : gate.hiveGitMode
      ? `commit-only:${gate.hiveGitMode}`
      : 'commit-only:config';

  // P-006: per-slug resource first (auto-registered), then the routine's extras
  // (papercup: legacy 'git-sync' + 'libs-papercusp-submodule' — the back-off protocol).
  // Locks stay at the WORKFLOW layer — deliberately NOT a checkpointed step, so a
  // resumed/replayed fire re-acquires them instead of trusting a checkpoint whose
  // lease may have expired mid-stall. Every fire gets a fresh owner token: if a
  // prior process still owns the lease, the replay must wait/skip rather than
  // coalescing with that potentially concurrent process.
  const resources = [...new Set([gitSyncResourceName(slug), ...extraLockResources])];
  const acquired: string[] = [];
  const lockOwner = newGitSyncLockOwner();
  const lock = await acquireLocks(cd, slug, resources, acquired, lockOwner);
  if (lock.state === 'held' || lock.state === 'contended') {
    if (lock.state === 'contended') {
      console.log(`[git-sync] ${slug}: lock contention persisted on ${lock.blockedOn} — skipping this tick`);
    } else if (lock.blockedReason === 'unknown_resource') {
      console.warn(
        `[git-sync] ${slug}: lock resource "${lock.blockedOn}" is not registered in agent_resource_registry — ` +
        'skipping this tick. Register it or remove it from trigger_config.extra_lock_resources.');
    } else {
      console.log(`[git-sync] ${slug}: a peer holds ${lock.blockedOn} — skipping this tick`);
    }
    return {
      status: 'skipped',
      reason: lock.blockedReason ?? (lock.state === 'contended' ? 'lock_contended' : 'lock_held'),
      ...(lock.blockedOn ? { blockedOn: lock.blockedOn } : {}),
    };
  }
  const activityStartedAt = Date.now();
  await writeGitSyncActivity(slug, workspaceId, {
    active: true,
    phase: 'local-sync',
    started_at: activityStartedAt,
    updated_at: activityStartedAt,
    completed_at: null,
    outcome_status: null,
  });
  // EI-18: previous tick's counters BEFORE this tick overwrites them.
  const prev = await readEscalationCounters(slug, workspaceId);

  // Capture HEAD before the sync so the doc-freshness sweep (P-003) can diff the
  // exact paths this tick moved. Best-effort — never gate the sync on it.
  let prevHeadSha: string | null = null;
  try {
    prevHeadSha = await (await import('../docs/sweep-after-sync')).captureHeadSha(slug, workspaceId, repoPath);
  } catch {
    /* best-effort */
  }

  // EI-438 content-guard KILL-SWITCH (default ON): when OFF, pass an EMPTY detector
  // set so runGitSync commits exactly as before this plan (no quarantine/escalation/
  // fixer) — the instant off-switch on the shared commit path, no deploy needed. A
  // flag-infra error falls back to the default (ON), keeping the safety on.
  const contentGuardOn = await getFlag(FLAGS.GIT_SYNC_CONTENT_GUARD, slug);
  // EI-17 kill-switch: default ON (see FLAGS.GIT_SYNC_DELETION_GUARD doc). A flag-infra
  // error falls back to the default (ON), keeping the safety on — same as content-guard.
  const deletionGuardOn = await getFlag(FLAGS.GIT_SYNC_DELETION_GUARD, slug);
  // P-004 (git-sync-dx-hardening): derived commit attribution (default OFF). When ON, supply the
  // LIVE roster of active agents + their declared files (coord presence current_files) so runGitSync
  // peels per-agent commits. DERIVED, never authored — agents stay git-free. Flag-gated read; a
  // presence-read failure degrades to no attribution (today's single commit).
  const attributionOn = await getFlag(FLAGS.GIT_SYNC_DERIVED_ATTRIBUTION, slug);
  // WI-38594: diff-derived commit subjects (default ON) — subject = the staged diff,
  // intent line demoted to the body. OFF = pre-WI-38594 subjects, no deploy needed.
  const diffSubjectsOn = await getFlag(FLAGS.GIT_SYNC_DIFF_SUBJECTS, slug);
  // File locks are the automatic edit-plane authority. Keep git-sync's broad
  // whole-tree sweep from staging a peer's in-flight paths; the pure pipeline
  // maps these superproject-root-relative paths into each submodule before add.
  const liveLockPaths = await liveLockedPaths();

  // 'acquired' (locked) or 'error' (unlocked best-effort) → run.
  let outcome: GitSyncOutcome;
  const stopLockHeartbeat = lock.state === 'acquired'
    ? startLockHeartbeat(cd, slug, [...acquired], lockOwner)
    : async () => {};
  try {
    outcome = await runGitSync(slug, {
      repoPath,
      config: cfg,
      contentDetectors: contentGuardOn ? undefined : [],
      deletionGuard: deletionGuardOn,
      diffSubjects: diffSubjectsOn,
      ...(liveLockPaths.length > 0 ? { excludePaths: liveLockPaths } : {}),
      loadRoster: attributionOn ? () => loadAttributionRosterMerged(workspaceId) : undefined,
      // WI-1416: checkpoint each pipeline phase (submodules → pointer-bump → push) as
      // a DBOS sub-step; a passthrough outside a workflow (fireGitSyncNow, tests).
      step: runCheckpointedStep,
    });
  } catch (error) {
    await writeGitSyncActivity(slug, workspaceId, {
      active: false,
      phase: 'error',
      started_at: activityStartedAt,
      updated_at: Date.now(),
      completed_at: Date.now(),
      outcome_status: null,
    }).catch(() => {});
    throw error;
  } finally {
    await stopLockHeartbeat();
    if (lock.state === 'acquired') await releaseAll(cd, lockOwner, acquired);
  }

  // WI-3072: stash-detection recurrence guard — read-only (no lock needed), runs
  // regardless of the sync outcome (even a conflict/error tick should still surface a
  // surprise stash). Best-effort end-to-end, including resolving the repo path itself
  // (lazy-imported like the other operator-notes call sites in this file) — a failure
  // here must never break the tick this deep into the pipeline.
  try {
    if (repoPath) {
      await runCheckpointedStep('git-sync:stash-check', () => checkForNewStashes(slug, workspaceId, repoPath));
    }
  } catch {
    // Best-effort, silent degrade — mirrors loadAttributionRoster's fallback above:
    // an unresolvable repo path (or a load-graph hiccup) skips this courtesy check,
    // never the tick itself.
  }

  // P-003: count any tick whose errors[] is non-empty — a sibling push failure that
  // co-occurs with a conflict produces status 'conflict' (worst-outcome), which used
  // to RESET this counter to 0 every tick and defer the EI-18 push-failure escalation
  // indefinitely. The error LIST drives the counter now, not the worst status.
  const tickErrors = 'errors' in outcome ? outcome.errors : [];
  const errTicks = tickErrors.length > 0 ? prev.errTicks + 1 : 0;
  // EI-438: consecutive ticks with a file still quarantined (drives P-005 escalate-to-human).
  const contentTicks = outcome.contentErrors.length > 0 ? prev.contentTicks + 1 : 0;

  try {
    // STEP `git-sync:record` — outcome recording + the whole escalation/dispatch tail as
    // ONE checkpoint: a resumed fire that already recorded never re-appends the pipeline
    // event or re-decides escalations (the resolver/fixer dispatches inside are further
    // deduped by their own in-flight markers).
    await runCheckpointedStep('git-sync:record', () =>
      recordAndEscalateTick({
        slug,
        workspaceId,
        outcome,
        errTicks,
        contentTicks,
        prevContentTicks: prev.contentTicks,
        prevOversizedKeys: prev.oversizedKeys,
        cfgBranch: cfg.branch,
        prevHeadSha,
        repoPath,
        attributionOn,
        pushMode: effectivePushMode,
      }));

    // `recordOutcome` writes the local stage's status before any GitHub bridge or
    // P2P post-leg runs. Keep that local result visible, but explicitly mark the
    // whole action non-terminal until every later leg has settled.
    await writeGitSyncActivity(slug, workspaceId, {
      active: true,
      phase: 'post-legs',
      started_at: activityStartedAt,
      updated_at: Date.now(),
      completed_at: null,
      outcome_status: outcome.status,
    });

  // event-await-… P-102: git-sync:committed[:<sha>] — wake anyone awaiting "is my
  // edit a local git commit yet". Remote origin/staging egress is a distinct,
  // later git-sync:egressed event emitted by runGithubBridgeLeg.
  // Only on a real commit (status 'synced' ⇒ something moved + headSha is set);
  // fire-and-forget, never gates the tick, benign to replay past the record step.
  if (outcome.status === 'synced') {
    emitGitSyncCommittedEvent(outcome.headSha, { scope: { installSlug: slug, workspaceId } });
  }

  // github-bridge P-008 (D-003: piggyback, no new scheduler): on a BRIDGED hive,
  // one bridge pass per tick — ingress origin → admission → egress canonical →
  // divergence verdict (all FF-only; origin never forced). Its own checkpoint so
  // a resumed fire that already bridged never re-runs the pass. Kill-switch:
  // FLAGS.GITHUB_BRIDGE (default ON; the per-hive `hiveGit.mode` setting is the
  // real activation — this leg only exists when the gate resolved 'bridged').
  if (gate.hiveGitMode === 'bridged' && (await getFlag(FLAGS.GITHUB_BRIDGE, slug))) {
    await runCheckpointedStep('git-sync:github-bridge', () => runGithubBridgeLeg(slug, workspaceId));
  }

  // p2p-git-live-activation P-205 (WI-3591, G-8): on ANY non-legacy hive, one
  // bootstrap-tick pass per git-sync tick, BEFORE ref-announce (P-202) — a
  // genuinely cold local mirror (zero `refs/namespaces/*` yet) has nothing for
  // ref-announce/integrator/worktree-bridge to read; seeding it first lets
  // this SAME tick's later legs already see the seeded heads. Self-gates as a
  // fast no-op the moment ANY namespace exists locally (runBootstrapLeg's own
  // `listNamespaces` check) — this is what makes G-8 safe across a
  // legacy→bridged→p2p-only→legacy→bridged mode cycle with NO re-seed: once a
  // repo has been seeded (by this leg or by normal own-work commits), no
  // later tick — regardless of how many times mode flips — ever re-attempts
  // it, per bootstrap.ts's own re-run contract (bootstrap.integration.test.ts
  // "a re-run seeds only namespaces NEW on the peer; existing ones are
  // skipped untouched"). Own checkpoint so a resumed fire never re-attempts
  // past it.
  if (gate.hiveGitMode) {
    await runCheckpointedStep('git-sync:bootstrap', () => runBootstrapLeg(slug, workspaceId));
  }

  // G-2a (WI-5146): on ANY non-legacy hive, publish THIS device's own worktree
  // branch head into its own namespace in the bare store — the `git push rad`
  // analogue and the FIRST link every leg below consumes. MUST run after the
  // bootstrap leg (own-head-first would warm a genuinely cold store and
  // permanently skip G-8's one-shot cold-join) and before ref-announce (so the
  // same tick that ingests a new head signs + announces it). The G-10 publish
  // guard runs INSIDE the tick, before the ref write makes objects servable.
  // Own checkpoint so a resumed fire never re-publishes past it.
  if (gate.hiveGitMode) {
    await runCheckpointedStep('git-sync:own-head-publish', () => runOwnHeadPublishLeg(slug, workspaceId, cfg.branch));
  }

  // p2p-git-live-activation P-202: on ANY non-legacy hive (bridged OR
  // p2p-only), one ref-announce-tick pass per git-sync tick — publish this
  // device's own namespace advance (if any) hive-wide, then process any
  // pending peer ref-announcements into the local mirror. Runs BEFORE the
  // integrator leg (P-203) so it reads freshly-fetched member heads this
  // same tick, not last tick's. Own checkpoint so a resumed fire never
  // re-announces/re-receives past it.
  if (gate.hiveGitMode) {
    await runCheckpointedStep('git-sync:ref-announce', () => runRefAnnounceLeg(slug, workspaceId));
  }

  // p2p-git-live-activation P-203: on ANY non-legacy hive (bridged OR
  // p2p-only), one integrator-tick pass per git-sync tick — the lock-authority
  // lease holder merges member namespace heads into staging + announces the
  // advance hive-wide; every other member's tick is a fast, correct no-op
  // (`skipped: 'not-integrator'`). Own checkpoint so a resumed fire never
  // re-integrates/re-announces past it.
  if (gate.hiveGitMode) {
    await runCheckpointedStep('git-sync:integrator', () => runIntegratorLeg(slug, workspaceId));
  }

  // P-302/Leg A: the integrator may advance refs/hive/staging and publish its
  // handoff token after the normal ref-announce pass above has already signed
  // this device's namespace. Refresh the signed snapshot immediately after the
  // integrator so those integrator-authored refs are announced in the SAME
  // git-sync tick. This pass is publish-only: receiving the same pending peer
  // announcements twice would double-drive fetch failures and their budgets.
  if (gate.hiveGitMode) {
    await runCheckpointedStep('git-sync:ref-announce-post-integrator', () =>
      runRefAnnounceLeg(slug, workspaceId, { receive: false }),
    );
  }

  // p2p-git-live-activation P-204: on ANY non-legacy hive (bridged OR
  // p2p-only), one worktree-bridge-tick pass per git-sync tick — process any
  // pending `hive-git:staging-advance` announcements this device hasn't
  // consumed yet and ff-advance the local worktree (G-7c/G-7b). Every
  // member's tick runs this (including the integrator's own — its worktree
  // follows staging too). Own checkpoint so a resumed fire never re-processes
  // past it.
  if (gate.hiveGitMode) {
    await runCheckpointedStep('git-sync:worktree-bridge', () => runWorktreeBridgeLeg(slug, workspaceId));
  }

  } catch (error) {
    await writeGitSyncActivity(slug, workspaceId, {
      active: false,
      phase: 'error',
      started_at: activityStartedAt,
      updated_at: Date.now(),
      completed_at: Date.now(),
      outcome_status: outcome.status,
    }).catch(() => {});
    throw error;
  }

  const completedAt = Date.now();
  await writeGitSyncActivity(slug, workspaceId, {
    active: false,
    phase: 'complete',
    started_at: activityStartedAt,
    updated_at: completedAt,
    completed_at: completedAt,
    outcome_status: outcome.status,
  });
  return outcome;
}

/** The P-008 bridge leg of one bridged-hive git-sync tick. Best-effort: never
 *  throws (the code plane must keep syncing even when GitHub is unreachable);
 *  outcome + the `last_admitted` watermark persist on the routine metadata. */
export async function runGithubBridgeLeg(slug: string, workspaceId: string): Promise<void> {
  try {
    let entry: ProjectEntry | undefined;
    try {
      entry = (await loadHarnessRegistry(workspaceId)).projects.find((p) => p.slug === slug);
    } catch {
      return; // registry unreadable — next tick retries
    }
    if (!entry) return;
    const potHomeSlug = entry.hive_slug ?? (entry.self_repo ? entry.slug : undefined);
    if (!potHomeSlug) return;
    // WI-5168: the wire+store repoKey is the FEDERATED cross-device identity
    // (github_repository_id when known), never the local install `slug` —
    // see repo-identity.ts's module header for why keying on `slug` broke G-8
    // for any two devices whose install slugs differ (nearly always).
    const repoKey = canonicalRepoKey(entry);
    const bareRepoPath = hiveGitRepoPath(potHomeSlug, repoKey);

    // The admission watermark (P-005): the last ADMITTED github-origin head.
    const { sql } = getOrgPg();
    const rows = await sql<{ la: string | null; wb_sha: string | null; prev_egress_head: string | null }[]>`
      SELECT metadata->'github_bridge'->>'last_admitted' AS la,
             metadata->'worktree_bridge'->>'stagingSha' AS wb_sha,
             metadata->'github_bridge'->>'egress_head' AS prev_egress_head
        FROM harness_shared.routines
       WHERE install_slug = ${slug} AND workspace_id = ${workspaceId} AND target_role = 'system:git-sync'
       LIMIT 1
    `;
    const lastAdmitted = rows[0]?.la ?? null;
    const prevEgressHead = rows[0]?.prev_egress_head ?? null;

    // Catch-up pin (WI-3500): the bare-side canonical mirror (refs/hive/staging)
    // is maintained on staging-advance ACCEPTANCE (worktree-bridge step 3.5),
    // but advances accepted before that pin shipped — or a failed pin — leave
    // the ref missing while the watermark is already persisted, and egress then
    // silently no-ops every tick. Re-derive it from the accepted watermark when
    // absent (update-ref itself refuses a sha whose object is missing, so a
    // pruned mirror can't produce a dangling canonical ref).
    const wbSha = rows[0]?.wb_sha ?? null;
    if (wbSha) {
      // WI-6282: a COLD device has no store yet — `hiveGitRepoPath` only COMPUTES
      // a path (it never creates, unlike `ensurePotGitRepo`), and this leg runs
      // BEFORE the bootstrap leg that does. Spawning git with a nonexistent cwd
      // makes Node report ENOENT ON THE BINARY, so the warning below used to read
      // "spawn git ENOENT" — i.e. "git is not installed", which sends whoever is
      // debugging a failed join looking for the wrong thing entirely.
      // LIVE-REPRODUCED on the P-302 rig 2026-07-27: exactly once, on the first
      // tick after the store was deliberately removed, never on a warm tick.
      // SKIP rather than create: the pin is meaningless on a store with no
      // objects (update-ref refuses a sha whose object is missing), and store
      // lifecycle belongs to the bootstrap leg, not here. This makes the failure
      // impossible instead of merely handled — the next tick, post-bootstrap,
      // finds a real store and pins normally.
      if (await pathExists(join(bareRepoPath, 'HEAD'))) {
        const existing = await defaultRunGit(['rev-parse', '--verify', '--quiet', BRIDGE_CANONICAL_REF], bareRepoPath);
        if (existing.code !== 0) {
          const pinned = await defaultRunGit(['update-ref', BRIDGE_CANONICAL_REF, wbSha], bareRepoPath);
          if (pinned.code !== 0) {
            // Name the PATH: `pinned.stderr` alone produced a message with no
            // path in it, which is why the original report could not tell a
            // missing cwd from a missing binary.
            console.warn(
              `[git-sync] ${slug}: bare canonical catch-up pin failed for ${bareRepoPath}: ${pinned.stderr.trim()}`,
            );
          }
        } else {
          // EI-18751829787526583: the ref EXISTS but can still be STALE — the
          // absent-only branch above never re-derives it. worktree-bridge's
          // step-3.5 `update-ref` (worktree-bridge.ts) is best-effort and
          // UNCHECKED, so it can fail without leaving canonical absent,
          // pinning it at an old sha instead. Egress then publishes exactly
          // that stale content and reports `upToDate`/`clear` — green — while
          // origin freezes (the incident this fixes: 21 commits / ~3h). Only
          // re-pin a STRICT ANCESTOR (never a diverged/ahead ref — that is a
          // different problem, not this pin's to silently resolve), and CAS
          // against what we just read so a genuinely concurrent legitimate
          // advance loses cleanly instead of being clobbered.
          const existingSha = existing.stdout.trim();
          if (existingSha && existingSha !== wbSha) {
            const isAncestor = await defaultRunGit(['merge-base', '--is-ancestor', existingSha, wbSha], bareRepoPath);
            if (isAncestor.code === 0) {
              const pinned = await defaultRunGit(['update-ref', BRIDGE_CANONICAL_REF, wbSha, existingSha], bareRepoPath);
              if (pinned.code !== 0) {
                console.warn(
                  `[git-sync] ${slug}: bare canonical stale re-pin failed for ${bareRepoPath} ` +
                    `(${existingSha.slice(0, 12)} → ${wbSha.slice(0, 12)}): ${pinned.stderr.trim()}`,
                );
              } else {
                console.warn(
                  `[git-sync] ${slug}: bare canonical ${BRIDGE_CANONICAL_REF} was STALE at ${existingSha.slice(0, 12)} ` +
                    `(behind accepted watermark ${wbSha.slice(0, 12)}) — re-pinned`,
                );
              }
            }
          }
        }
      }
    }

    // Upstream-write probe only when it can matter (a fork always wins — D-007b).
    let upstreamWrite: boolean | null = null;
    if (entry.github_remote && !entry.fork_remote) {
      const parsed = parseGithubUrl(entry.github_remote);
      if (parsed) upstreamWrite = await fetchRepoPushPermission(parsed.owner, parsed.repo);
    }

    const outcome = await runGithubBridgeTick({
      potHomeSlug,
      workspaceId,
      repoKey,
      githubRemote: entry.github_remote,
      forkRemote: entry.fork_remote,
      branches: [entry.github_default_branch ?? 'main'],
      upstreamWrite,
      lastAdmitted,
      // EI-18751829787526583: the same watermark the catch-up pin above just
      // re-derived from — passed through as a BACKSTOP so a case the pin
      // declined to touch (diverged rather than a strict ancestor) or a
      // re-pin that itself failed still surfaces as `egress-canonical-stale`
      // instead of silently reading `divergence: clear`.
      expectedCanonicalSha: wbSha,
    });

    // A bridge egress rejection is reported by the bridge escalation writer, but
    // this leg runs AFTER recordOutcome (which may have recorded a clean commit
    // tick). Promote owner-actionable bridge verdicts into the routine's primary
    // health metadata too; otherwise a missing GitHub workflow scope leaves
    // `last_status: synced` + `last_error: null` beside a red github_bridge row.
    // Self-healing bridge residues (for example a stale canonical ref) stay in
    // github_bridge only and must not turn the whole git-sync tick red.
    // Do not write local_sync_status/local_sync_head_sha here: those fields are
    // the stage-aware evidence recorded by recordOutcome immediately before this
    // leg, and must survive an egress-only failure for the watchdog to classify it
    // as a failing bridge leg rather than a commit strand.
    const ownerActionableBridgeFailure = outcome.verdict.action === 'escalate' && outcome.verdict.needsOwner;
    const bridgeError = ownerActionableBridgeFailure
      ? outcome.verdict.detail || outcome.errors.join('; ') || 'github-bridge owner action required'
      : null;

    await patchRoutineMetadata(slug, workspaceId, {
      ...(bridgeError
        ? {
            last_status: 'error',
            last_error: bridgeError,
            last_errors: outcome.errors.slice(0, 10),
          }
        : {}),
      github_bridge: {
        at: Date.now(),
        ran: outcome.ran,
        skipped: outcome.skipped ?? null,
        egress_target: outcome.egressTarget,
        ingressed: outcome.ingressed,
        egress: outcome.egress,
        last_admitted: outcome.lastAdmitted,
        divergence: outcome.verdict.action,
        needs_owner: outcome.verdict.needsOwner,
        agent_actionable: outcome.verdict.agentActionable === true,
        agent_remedies: outcome.verdict.agentRemedies ?? [],
        // WI-5738: the truthful egress watermark the origin-freshness watchdog
        // measures against (see GithubBridgeTickOutcome.egressHead).
        //
        // STICKY — a tick that egressed nothing must NOT erase it. This whole
        // `github_bridge` object is replaced wholesale on every patch, so
        // writing a bare `?? null` let one quiet tick (nothing to push, or the
        // leg skipped before egress) blank the field. The watchdog then falls
        // back to the ingress mirror of `github_default_branch` — the exact
        // signal proven blind in this incident, because the release pipeline
        // fast-forwards it hourly regardless of whether egress is wedged. So a
        // single quiet tick silently reverted the watchdog to the broken
        // detector it was fixed to stop using. The field means "what egress
        // LAST landed", so absence of a new observation must leave the last
        // one standing.
        egress_head: outcome.egressHead ?? prevEgressHead,
        errors: outcome.errors.slice(0, 10),
      },
    });

    // EI-20331175777179195: a local `synced` outcome is NOT proof that a bridged
    // hive reached origin/staging. GithubBridgeTickOutcome.egressHead is populated
    // only when the remote staging ref was pushed or was already at canonicalSha.
    // Emit after the metadata write so a woken waiter can immediately verify the
    // same writer-backed watermark. A skipped/failed/no-egress tick emits nothing.
    if (outcome.egressHead) {
      const includedShas = await newlyEgressedCommitShas(outcome.egressHead, bareRepoPath, prevEgressHead);
      if (includedShas.length > 0) {
        emitGitSyncEgressedEvent(
          outcome.egressHead,
          { scope: { installSlug: slug, workspaceId } },
          { includedShas },
        );
      } else {
        emitGitSyncEgressedEvent(outcome.egressHead, { scope: { installSlug: slug, workspaceId } });
      }
    }
  } catch (e) {
    console.warn(`[git-sync] ${slug}: github-bridge pass failed: ${e instanceof Error ? e.message : e}`);
  }
}

/** The G-2a own-head publish leg of one non-legacy-hive git-sync tick
 *  (WI-5146): resolve this device + the harness worktree and run ONE
 *  own-head-publish pass — worktree branch head → own namespace in the
 *  (hive, repo) bare store, G-10-guarded inside the tick. Best-effort like
 *  its sibling legs: never throws; a guard REFUSAL is logged loudly (a
 *  planted secret silently un-published is exactly the failure G-10 exists
 *  to make visible) and recorded on the routine metadata. */
/* WI-6243: the genesis-publish baseline moved to ./genesis-baseline.ts so it is
 * testable over the injected git seam (importing THIS module needs the action
 * suite's full mock harness). Both G-10 consumers below call it unchanged. */

/**
 * EI-19341838904344665: `outcome.headSha` is the worktree head JUDGED this tick —
 * current by construction, every tick — NOT what became servable. WI-5738 made
 * this publish INCREMENTAL: it CAS-writes `outcome.publishedSha`, which can trail
 * the head by hundreds of commits. Logging `headSha` beside "published" asserted a
 * sha was published when it was not — the false, authoritative-looking line that
 * produced two OPPOSITE wrong diagnoses from two separate agents during the
 * 2026-08-02 freeze (one read it as "the ref is stuck", the other as "the producer
 * is healthy"). Reports what actually became servable, and says plainly when
 * backlog remains (see EI-19341709637436070 for why the field is named
 * `backlogRemains`, not `drained`).
 *
 * Extracted as a pure function (rather than inlined at the `console.log` call
 * site) so the exact wording is unit-testable without running a real git tick.
 */
export function formatOwnHeadPublishedLine(slug: string, outcome: OwnHeadPublishTickOutcome): string {
  const published = outcome.publishedSha?.slice(0, 12) ?? 'nothing';
  const backlogNote = outcome.backlogRemains
    ? ` (BACKLOG REMAINS; worktree head ${outcome.headSha?.slice(0, 12)})`
    : '';
  return `[git-sync] ${slug}: own-head published ${outcome.branch}@${published} into own namespace${backlogNote}`;
}

async function runOwnHeadPublishLeg(slug: string, workspaceId: string, branch: string | undefined): Promise<void> {
  try {
    let entry: ProjectEntry | undefined;
    try {
      entry = (await loadHarnessRegistry(workspaceId)).projects.find((p) => p.slug === slug);
    } catch {
      return; // registry unreadable — next tick retries
    }
    if (!entry?.path) return;
    const potHomeSlug = entry.hive_slug ?? (entry.self_repo ? entry.slug : undefined);
    if (!potHomeSlug) return;
    // WI-5168: federated repoKey — see repo-identity.ts.
    const repoKey = canonicalRepoKey(entry);

    const actor = await resolveUsageActor();
    if (!actor?.devicePubkey) return; // gh unauthenticated — no device identity to publish as

    const genesisBaselineSha = await deriveGenesisBaselineSha(entry, branch);

    const outcome = await runOwnHeadPublishTick({
      potHomeSlug,
      repoKey,
      worktreePath: entry.path,
      branch,
      devicePubkeyBase64: actor.devicePubkey,
      genesisBaselineSha,
      workspaceId,
    });
    if (outcome.refused) {
      console.warn(
        `[git-sync] ${slug}: own-head publish REFUSED — ${describePublishRefusal(outcome.refused)}; ` +
          `head ${outcome.headSha?.slice(0, 12)} NOT published (namespace ref unchanged, nothing servable). ` +
          `Recovery (WI-5591, no restart needed): if this is a false positive, insert a row into ` +
          `harness_shared.secrets_guard_path_exemptions for the offending path(s) — the next tick will retry.`,
      );
    }
    if (outcome.exemptedFindings.length > 0) {
      // WI-5591 audit trail: a runtime path exemption suppressed finding(s) this
      // tick — always logged (whether or not the publish ultimately admitted) so
      // an exemption's use is never silent.
      console.warn(
        `[git-sync] ${slug}: own-head publish — ${outcome.exemptedFindings.length} secret-scanner finding(s) ` +
          `suppressed by a runtime path exemption: ${outcome.exemptedFindings
            .slice(0, 5)
            .map((f) => `${f.path}:${f.line} [${f.rule}]`)
            .join('; ')}`,
      );
    }
    if (outcome.errors.length) {
      console.warn(`[git-sync] ${slug}: own-head publish reported errors: ${outcome.errors.join('; ').slice(0, 500)}`);
    }
    if (outcome.changed) {
      console.log(formatOwnHeadPublishedLine(slug, outcome));
    }
    await patchRoutineMetadata(slug, workspaceId, {
      own_head_publish: {
        at: Date.now(),
        changed: outcome.changed,
        branch: outcome.branch,
        sha: outcome.headSha,
        // WI-7009: `sha` above is the worktree head JUDGED this tick — NOT what
        // became servable. WI-5738 made this publish INCREMENTAL: it drains the
        // range and CAS-writes `publishedSha` (the guard's furthest safe sha),
        // which can trail the head by hundreds of commits while the remainder
        // drains over following ticks. Recording only `sha` beside
        // `changed: true` reads on every health surface as "the head is
        // published", and that is precisely how a canonical-staging freeze hid
        // for ~6h on 2026-08-02: the namespace head sat ~114 commits back, so
        // the integrator could only announce shas that were ANCESTORS of the
        // already-accepted watermark; the bridge rejected each one
        // non-fast-forward — a TERMINAL reason, which skips-and-continues and
        // logs NOTHING — and `last_status` stayed 'synced' throughout. Every
        // field needed to see it was already computed here and then dropped
        // (`oversizedCommit`'s own doc-comment says it is named "so the health
        // layer can raise it" — the health layer was never given it).
        publishedSha: outcome.publishedSha ?? null,
        // EI-19341709637436070: persisted key renamed drained -> backlogRemains (was
        // named backwards — see OwnHeadPublishTickOutcome.backlogRemains's doc comment).
        // Alpha, no users: migrate the key outright rather than aliasing it.
        backlogRemains: outcome.backlogRemains ?? false,
        blockedAtCommit: outcome.blockedAtCommit ?? null,
        oversizedCommit: outcome.oversizedCommit ?? null,
        refused: outcome.refused?.refusalCode ?? null,
        // WI-5591: count of findings suppressed by a runtime path exemption
        // this tick — a health check reading `refused` alone would otherwise
        // stay blind to an exemption quietly keeping the plane un-wedged.
        exemptedFindingsCount: outcome.exemptedFindings.length,
      },
    });
  } catch (e) {
    console.warn(`[git-sync] ${slug}: own-head publish leg failed: ${e instanceof Error ? e.message : e}`);
  }
}

/**
 * p2p-git-live-activation P-205 (WI-3591) / P-302 (dial wiring): the G-8
 * cold-clone bootstrap leg — the production path a fresh JOINER's git-sync
 * tick actually hits. Best-effort: never throws; outcome persists on the
 * routine metadata under the `bootstrap` key (distinct from
 * `ref_announce`/`integrator`/`worktree_bridge` so the four legs never
 * clobber each other's watermark).
 *
 * SELF-GATE (the "reachable but only when it matters" contract): fast no-op
 * unless the local hive-git bare store has ZERO `refs/namespaces/*` yet
 * (`listNamespaces` — storage.ts). Any prior namespace (this device's own
 * work, or a namespace already seeded by an earlier bootstrap tick) means
 * this leg has nothing to do — `bootstrapFromPeer` itself is also safe to
 * re-run (existing namespaces are left untouched per its own rewind-safety
 * contract), but gating here avoids paying a wildcard-fetch attempt on every
 * tick once a repo is warm.
 *
 * DIAL-REGISTRY (WI-3583, landed 2026-07-10; wired HERE 2026-07-10 P-302):
 * this leg used to always hand `bootstrapFromPeer` an already-destroyed stub
 * duplex (no way to name a peer to dial), the ONE of the four Phase-3 legs
 * left on that pre-WI-3583 shape after `runRefAnnounceLeg`/worktree-bridge
 * picked up the real dial. Same pattern as `runRefAnnounceLeg`'s `openStream`
 * above: resolve this harness's live swarm topic via
 * `getBootedHarness(...).swarm.topicHex`, pick any ONE attested member peer
 * that is not this device (bootstrap only needs ONE source — "the caller
 * picks any live peer", per bootstrap.ts's own doc), and dial it through
 * `openHiveGitDuplexToDevice`. Two fail-soft floors, neither ever throws: (a)
 * no live swarm join yet for this harness ⇒ an already-destroyed local stub,
 * same shape as before WI-3583; (b) no member peer other than self yet (a
 * lone device) ⇒ skip, nothing to bootstrap from. Either way a cold repo
 * reports the documented clean `ok:false` (`fetch-failed`, matching
 * `fetchOverDuplex`'s fail-soft contract) and retries next tick; only genuine
 * cross-machine reachability (Phase 3's live rig, P-302) exercises the happy
 * path end-to-end.
 */
/**
 * Resolve the live swarm topic for a hive-git-enabled LOCAL install, DEMANDING
 * a boot when the substrate isn't currently resident in this process
 * (WI-5247).
 *
 * The lookup key is deliberately the runnable install slug, NOT the pot-home
 * slug. They are identical on a hive home, which hid this distinction in the
 * original tests, but differ on a joined member (`hello-world` locally views
 * the `hello-world-3-pot` hive). `boot-all` indexes its in-memory handles by
 * that local registry entry; looking up the pot home on a joiner therefore
 * returned a permanent no-topic stub even while the joiner's actual swarm was
 * healthy and connected (WI-3496 physical Phase A, 2026-08-14).
 *
 * `getBootedHarness` only re-boots an engine the P-008 reaper EVICTED —  a
 * harness that was simply never booted in this process (a joined hive whose
 * workspace didn't happen to boot-sweep it, or any process restart with an
 * empty in-memory handle cache) falls through it as a silent, permanent
 * `null`: LAZY_SUBSTRATE_BOOT's "boot sweep boots only actively-demanded
 * harnesses" contract requires SOMETHING to register that demand, and
 * nothing did. Every git-sync tick for a hiveGit-enabled harness IS genuine
 * demand for its substrate, so treat "not currently booted" the same as
 * "evicted": fire a background `bootSingleHarness` (idempotent — coalesces
 * on its own `inflight` map, and a no-op once already booted, so calling it
 * every tick from every leg here is safe) so the substrate eventually comes
 * up and a LATER tick finds a live topic instead of the harness staying
 * stranded forever. Best-effort: never throws into the calling git-sync tick.
 */
interface HiveGitDialContext {
  /** Present only for an in-process swarm. A relocated sidecar owns its topic
   * and observability maps, so main-process diagnostics must stay UNKNOWN. */
  topicHex?: string;
  path: 'in-process' | 'sidecar' | 'sidecar-advertised';
  openDuplex(devicePubkeyBase64: string, request: HiveGitDuplexRequest): Promise<Duplex>;
}

interface RelocatedHiveGitDialHandle {
  openHiveGitDuplexToDevice(
    devicePubkeyBase64: string,
    request: HiveGitDuplexRequest,
  ): Promise<Duplex>;
}

function hasRelocatedHiveGitDial(handle: unknown): handle is RelocatedHiveGitDialHandle {
  return (
    typeof handle === 'object' &&
    handle !== null &&
    typeof (handle as Partial<RelocatedHiveGitDialHandle>).openHiveGitDuplexToDevice === 'function'
  );
}

async function resolveHiveGitDialContext(
  workspaceId: string,
  installSlug: string,
): Promise<HiveGitDialContext | undefined> {
  const { getBootedHarness, bootSingleHarness } = await import('../../sync/hyperbee/boot-all');
  const handle = getBootedHarness(workspaceId, installSlug);
  if (!handle) {
    // EI-20438405483051865: routines and the substrate owner can be separate OS
    // processes.  The boot-all registry is intentionally process-local, so a
    // healthy relocated handle is invisible here.  Reuse the existing
    // cross-service owner advertisement and accept it only for this exact
    // (workspace, install) pair; the open helper's FIRST RPC is an
    // existing-only boot (`createIfMissing:false`), so a stale/wrong socket can
    // never mint a store or identity.
    const { getPgRelocatedHarnessEndpoint } = await import(
      '../../sync/hyperbee/substrate-booted-handles-pg'
    );
    const advertised = await getPgRelocatedHarnessEndpoint(workspaceId, installSlug).catch(
      () => null,
    );
    if (advertised) {
      return {
        path: 'sidecar-advertised',
        openDuplex: async (devicePubkeyBase64, request) => {
          const [{ openHiveGitDuplexViaExistingSidecar }, { workspacesRoot }] = await Promise.all([
            import('../../sync/hyperbee/remote-booted-harness'),
            import('../../workspace-registry'),
          ]);
          return openHiveGitDuplexViaExistingSidecar({
            socketPath: advertised.socketPath,
            workspaceRoot: join(workspacesRoot(), workspaceId),
            workspaceId,
            harnessSlug: installSlug,
            devicePubkeyBase64,
            request,
          });
        },
      };
    }
    void bootSingleHarness(workspaceId, installSlug).catch(() => {
      // best-effort demand-boot; a failure just leaves the harness unbooted
      // for this tick — the next tick's access retries.
    });
    return undefined;
  }
  if (hasRelocatedHiveGitDial(handle)) {
    return {
      path: 'sidecar',
      openDuplex: (devicePubkeyBase64, request) =>
        handle.openHiveGitDuplexToDevice(devicePubkeyBase64, request),
    };
  }
  const topicHex = handle.swarm?.topicHex;
  if (!topicHex) return undefined;
  return {
    path: 'in-process',
    topicHex,
    openDuplex: (devicePubkeyBase64, request) =>
      openHiveGitDuplexToDevice(Buffer.from(topicHex, 'hex'), devicePubkeyBase64, request),
  };
}

/**
 * WI-6372 (fix D) — is our mirror actually LEVEL WITH THE POT, or merely the
 * result of a fetch that completed?
 *
 * `bootstrapFromPeer` answers "did a fetch succeed". That is NOT the same
 * question, and conflating them is what let WI-6364 run silently for 7 days: a
 * joiner served a complete, internally-consistent pack from a store frozen a
 * week earlier reported COLD JOIN COMPLETE and stamped `ok:true`.
 *
 * The correlator is the REF-ANNOUNCE plane, and its value comes entirely from
 * being a DIFFERENT channel: announcements ride the hive-keyed fed-event log,
 * so they are independent of `repoKey` and of the pot-git transport. A repoKey
 * divergence makes the two channels disagree while each looks internally
 * healthy — a disagreement no amount of asking pot-git about itself can
 * surface.
 *
 * Best-effort by contract: a probe failure must never break the tick (it is a
 * detector, not a gate), so everything here is caught and reported.
 */
async function runConvergenceProbe(input: {
  slug: string;
  workspaceId: string;
  potHomeSlug: string;
  repoPath: string;
  candidateDevicePubkeys: string[];
}): Promise<ConvergenceVerdict | null> {
  const { slug, workspaceId, potHomeSlug, repoPath, candidateDevicePubkeys } = input;
  try {
    const { sql } = getOrgPg();
    // Read announcements INDEPENDENTLY of the ref-announce leg's own cursor:
    // that cursor is a CONSUMPTION watermark and has already moved past exactly
    // the rows we need to judge against. Deliberately NO sql cast on `version`
    // (one garbage row would throw the whole query) and no ORDER BY on it —
    // rows come back newest-first by `id` and the CURRENT (not highest) version
    // per device is taken in JS AFTER the signature check. The 500-row bound is
    // a scan ceiling: a device that has not announced within it simply cannot be
    // judged, which is the conservative direction (no alarm) rather than a false
    // one.
    //
    // `id` is selected and threaded through as `sequence` because it is the only
    // recency key that survives a re-key: `version` restarts on a fresh store
    // lineage, so ordering by it latches a permanent false alarm (WI-6372 fix D
    // defect — see convergence-probe.ts GUARD 7).
    const rows = await sql<{ id: string | number; body: Record<string, unknown> }[]>`
      SELECT id, body
        FROM harness_shared.coord_event_log
       WHERE workspace_id = ${workspaceId}
         AND harness_slug = ${potHomeSlug}
         AND surface = 'messages'
         AND body->'fed_event'->>'key' = ${REF_ANNOUNCE_EVENT_KEY}
       ORDER BY id DESC
       LIMIT 500
    `;
    const announced: AnnouncedSnapshot[] = [];
    for (const row of rows) {
      const fe = row.body?.fed_event as { payload?: unknown } | undefined;
      const payload = fe?.payload;
      if (!isSignedRefAnnouncement(payload)) continue;
      // ANYTHING can write a fed-event row, so an unverified one must never be
      // able to pin this device NOT-CONVERGED forever. Verify against the
      // EMBEDDED key; hive membership is gated separately by the candidate set.
      if (!verifyRefAnnouncement(payload)) continue;
      // `id` is a bigint and may arrive as a string — coerce, and drop an
      // unparseable one rather than passing NaN into the recency comparison.
      const seq = typeof row.id === 'number' ? row.id : Number.parseInt(String(row.id), 10);
      announced.push({
        devicePubkeyBase64: payload.device_pubkey,
        version: payload.version,
        sequence: Number.isSafeInteger(seq) ? seq : undefined,
        sigrefsOid: payload.sigrefs_oid,
      });
    }

    // Read local sigrefs ONLY for devices that actually announced. GUARD 2 means
    // a device without an announcement can never be judged behind, so reading
    // its namespace is pure waste — and it is not cheap: each read spawns git
    // (twice, via readNamespaceRef + cat-file). Live-measured on the tower
    // 2026-07-27: 20 attested candidate devices but exactly ONE announcing peer,
    // i.e. ~38 of 40 subprocess spawns per tick, per harness, for nothing.
    const announcingDevices = new Set(announced.map((a) => a.devicePubkeyBase64));
    const local: LocalMirror[] = [];
    for (const device of candidateDevicePubkeys) {
      if (!announcingDevices.has(device)) continue;
      const stored = await readSigrefs(repoPath, device).catch(() => null);
      local.push({ devicePubkeyBase64: device, version: stored?.version ?? null });
    }

    const stateRows = await sql<{ convergence: { devices?: ConvergenceState } | null }[]>`
      SELECT metadata->'convergence' AS convergence
        FROM harness_shared.routines
       WHERE install_slug = ${slug} AND workspace_id = ${workspaceId} AND target_role = 'system:git-sync'
       LIMIT 1
    `;
    const priorState = stateRows[0]?.convergence?.devices ?? null;

    const verdict = judgeConvergence({
      candidateDevicePubkeys,
      announced,
      local,
      priorState,
      nowMs: Date.now(),
    });

    await patchRoutineMetadata(slug, workspaceId, {
      convergence: {
        at: Date.now(),
        // THE field a release reviewer must read instead of `bootstrap.ok`.
        converged: verdict.converged,
        judged: verdict.judged,
        behindCount: verdict.behind.length,
        notConverged: verdict.notConverged.map((d) => ({
          device: d.devicePubkeyBase64.slice(0, 12),
          announced: d.announced,
          local: d.local,
          stuckForMs: d.lagMs,
        })),
        summary: formatConvergenceVerdict(verdict),
        // Re-keys observed this tick. Persisted because "the peer's version fell
        // off a cliff" is otherwise reconstructed by hand across two ticks of
        // metadata, and it is the reason a persistence clock was dropped.
        lineageResets: verdict.lineageResets.map((r) => ({
          device: r.devicePubkeyBase64.slice(0, 12),
          priorAnnounced: r.priorAnnounced,
          announced: r.announced,
        })),
        // The per-device persistence watermark the NEXT tick carries forward.
        devices: verdict.state,
      },
    });

    if (!verdict.converged) {
      // The loudest line this leg can emit, and deliberately so: this is the
      // exact condition that previously printed nothing at all while every
      // green artifact kept saying the join had succeeded.
      console.warn(
        `[git-sync] ${slug}: pot-git NOT CONVERGED WITH THE POT — ${formatConvergenceVerdict(verdict)}. ` +
          `A completed fetch is NOT convergence: our mirror has not advanced while the pot announced newer ` +
          `snapshots on the (repoKey-independent) ref-announce plane. Treat any 'COLD JOIN COMPLETE' / ` +
          `bootstrap ok:true for this pot as UNSOUND until this clears.`,
      );
    }
    return verdict;
  } catch (e) {
    console.warn(`[git-sync] ${slug}: convergence probe failed: ${e instanceof Error ? e.message : e}`);
    return null;
  }
}

export async function runBootstrapLeg(slug: string, workspaceId: string): Promise<void> {
  try {
    let entry: ProjectEntry | undefined;
    try {
      entry = (await loadHarnessRegistry(workspaceId)).projects.find((p) => p.slug === slug);
    } catch {
      return; // registry unreadable — next tick retries
    }
    if (!entry) return;
    const potHomeSlug = entry.hive_slug ?? (entry.self_repo ? entry.slug : undefined);
    if (!potHomeSlug) return;
    // WI-5168: federated repoKey — see repo-identity.ts.
    const repoKey = canonicalRepoKey(entry);

    // G-8 cold-start (live-caught on the P-302 rig, WI-3496): the bare store
    // must EXIST before any git runs against it — bootstrap.ts's documented
    // precondition ("The local bare repo must exist (G-1 ensurePotGitRepo)").
    // Without this, every runGit on a cold device dies `spawn git ENOENT`
    // (missing cwd), and the first store is only ever created by the LATER
    // own-head leg — which then poisons the warm check below forever.
    const repoPath = await ensurePotGitRepo(potHomeSlug, repoKey);

    // EI-18745600910177355: reclaim leaked partial packs HERE, before any of
    // the gates below can return early. `bootstrapFromPeer` also sweeps, but
    // the leg exits ahead of it on every "nothing to do" path — no attested
    // peers, no live dial path, already warm — and "no live dial path" is
    // PRECISELY the stuck state in which a joiner sits accumulating them tick
    // after tick (live-caught on the rig: 21 GB of orphans in a store that
    // could not dial anyone, so the sweep inside bootstrap was unreachable).
    // A joiner that cannot make progress is the one that most needs its disk
    // back. Best-effort, never throws into the tick.
    const swept = await sweepStalePackTmpFiles(repoPath).catch(() => null);
    if (swept && swept.removed.length > 0) {
      // Report the two reclaim kinds SEPARATELY. They are not the same event and
      // must not read as one: a temp pack is disk hygiene, while `shallow.lock`
      // is the thing that WEDGES the cold-join ladder — clearing it is the
      // moment a stuck joiner becomes able to make progress again, and it is the
      // single highest-signal line in this whole feature's logs. Live-caught on
      // the rig 2026-07-26: the unwedge printed as "reclaimed 1 orphaned pack
      // temp file(s), 0.00 GB", which names the wrong artifact AND rounds the
      // 41-byte lock to nothing — i.e. the one line a future debugger most needs
      // said, in effect, that nothing had happened.
      const unwedged = swept.removed.filter((n) => n.endsWith('.lock'));
      const packs = swept.removed.filter((n) => !n.endsWith('.lock'));
      if (packs.length > 0) {
        // MB, not GB: a 2-decimal GB reads "0.00" for anything under ~5 MB.
        console.log(
          `[git-sync] ${slug}: reclaimed ${packs.length} orphaned pack temp file(s), ` +
            `${(swept.bytesReclaimed / 1e6).toFixed(1)} MB`,
        );
      }
      if (unwedged.length > 0) {
        console.log(
          `[git-sync] ${slug}: cleared stranded ${unwedged.join(', ')} — ` +
            `the cold-join ladder was WEDGED (every shallow fetch failing) and can now advance`,
        );
      }
    }

    const actor = await resolveUsageActor();
    // Self-identification must NOT ride on gh reachability: resolveUsageActor
    // returns null whenever `gh` is unauthenticated or GET /user fails (rate
    // limit), and an undefined self here used to (a) let `find(d => d !==
    // undefined)` pick THIS device's own attestation on the home box — dialing
    // yourself never has a registry entry, so every tick reported the decoy
    // "no live dial path" — and (b) make the warm gate below count OUR OWN
    // namespace as a peer seed, silently skipping bootstrap forever. Fall back
    // to the persisted, keychain-verified announce-identity cache (no network).
    const selfDevicePubkey =
      actor?.devicePubkey ??
      (await loadCachedLocalAnnounceIdentity().catch(() => null))?.devicePubkeyBase64;

    const members = await listHiveMembersForLocalPot(workspaceId, potHomeSlug);
    const memberDevicePubkeysBase64 = [
      ...new Set(members.flatMap((m) => m.deviceAttestations.map((a) => a.device_pubkey).filter(Boolean))),
    ];
    if (memberDevicePubkeysBase64.length === 0) return; // no attested peers to seed from yet

    // ALL non-self attested devices are candidates — a single `.find()` pick
    // wedged G-8 permanently when its one candidate was offline/stale (any
    // dead first candidate starved every later tick; live-caught on the P-303
    // reverse-leg drill 2026-07-17 with a live registered peer sitting unused).
    const candidateDevicePubkeys = memberDevicePubkeysBase64.filter((d) => d !== selfDevicePubkey);
    if (candidateDevicePubkeys.length === 0) return; // no member peer other than self yet — nothing to seed from

    // WI-6372 (fix D) — CRITICAL PLACEMENT: the convergence probe runs HERE,
    // ABOVE the warm gate, and its position is the whole point of the fix.
    //
    // The warm gate below returns the moment a peer namespace exists with no
    // pending quarantine. A joiner that is SEEDED BUT STALE — the WI-6364 shape
    // exactly — satisfies that gate on every tick and therefore never re-enters
    // this leg at all, while the ref-announce leg keeps dialing under the same
    // diverged repoKey. So a probe placed on the cold-join path (or anywhere
    // after the gate) would never fire on precisely the machine that needs it:
    // the stuck one. Being above the gate is what makes this a detector of
    // ONGOING divergence rather than a post-condition of a join we happened to
    // run this tick.
    //
    // Its verdict never gates the leg — a detector that can block the thing it
    // watches is a second outage waiting to happen.
    const convergence = await runConvergenceProbe({
      slug,
      workspaceId,
      potHomeSlug,
      repoPath,
      candidateDevicePubkeys,
    });

    // Warm means "already seeded from a PEER MEMBER's device" — nothing else
    // counts. Our own namespace is local (own-head-publish), and the
    // github-ingress namespace is ALSO locally synthesized (runGithubBridgeLeg
    // runs BEFORE this leg in the same tick, so on a GitHub-bridged repo the
    // very first tick writes the ingress namespace before we ever check —
    // live-caught on the WI-3496 rig: counting it made every bridged pot skip
    // G-8 cold-join forever). So the gate intersects the store's namespaces
    // with the ATTESTED MEMBER devices (excluding self): only a real peer
    // member's namespace proves a prior seed. A stale member-set false-cold
    // just re-runs bootstrapFromPeer, which is rewind-safe by contract.
    const memberNamespaceKeys = new Set(
      candidateDevicePubkeys.flatMap((d) => {
        try {
          return [deviceNamespaceKey(d)];
        } catch {
          return []; // malformed attestation pubkey — never counts as warm
        }
      }),
    );
    // WI-6189: a seeded peer namespace is NECESSARY but no longer SUFFICIENT.
    // The resumable ladder seeds all-or-nothing PER NAMESPACE, so a store can
    // hold a fully-seeded namespace while ANOTHER device's history is still
    // mid-ladder in quarantine. Testing only "does a peer namespace exist?"
    // (which was equivalent back when bootstrap was all-or-nothing) declares
    // that PARTIAL join complete and returns warm on every later tick, so the
    // ladder never runs again and the unfinished namespaces are stranded
    // forever — a silent partial cold-join that looks like a successful one.
    //
    // Live-caught on the P-302 rig 2026-07-26, in the very tick after the first
    // successful cold join: 5 namespaces seeded, 4 quarantine refs pending,
    // store permanently shallow, zero further bootstrap ticks.
    //
    // So: warm ⇔ seeded from a peer member AND nothing still staged. Re-running
    // with quarantine pending is safe and is the whole point — bootstrapFromPeer
    // is rewind-safe by contract and resumes from those very refs.
    const existing = await listNamespaces(repoPath);
    if (existing.some((n) => memberNamespaceKeys.has(n))) {
      const pending = await hasPendingQuarantine(repoPath).catch(() => false);
      if (!pending) return; // warm — seeded from a peer member, nothing left staged
    }

    // DIAL-REGISTRY (WI-3583) — see module doc above. Real per-device dial
    // once this harness has a live swarm topic; falls back to the same
    // pre-WI-3583 destroyed stub when it doesn't (private/local-only harness,
    // or not yet booted onto a swarm) — mirrors runRefAnnounceLeg's own
    // openStream floor exactly.
    const dialContext = await resolveHiveGitDialContext(workspaceId, slug);
    if (!dialContext) {
      const stub = new Duplex({
        read() {},
        write(_chunk, _enc, cb) {
          cb();
        },
      });
      // Swallow the destroy-time error BEFORE destroy(err) schedules it —
      // with no listener, Node emits an UNHANDLED 'error' next tick =
      // uncaughtException = the whole host exits (live-caught: this
      // crash-looped the tower bg-host at boot, WI-3496/WI-5177 —
      // bootstrapFromPeer awaits dropQuarantine before fetchOverDuplex can
      // attach its own listener). Same idiom as openHiveGitDuplexToDevice's
      // no-live-connection stub: callers read `.destroyed`, never 'error'.
      stub.on('error', () => {});
      stub.destroy(new Error('hive-git: no live swarm join for this harness yet'));
      const outcome = await bootstrapFromPeer(repoPath, stub, { selfDevicePubkey });
      // WI-37226: this writer replaces the WHOLE `bootstrap` key, so omitting the
      // miss-run fields DELETES them — and a deleted run reads as "the run ended",
      // i.e. it would silently CLEAR a real persistent-miss escalation. This path
      // attempts no dial at all, so it can neither advance a run nor end one: carry
      // the counter through untouched. (Precisely the accidental-erasure hazard the
      // WI-6284 comment below warns about, now with a field that would actually hurt.)
      const priorStubBootstrap = await readPriorBootstrapMeta(slug, workspaceId);
      await patchRoutineMetadata(slug, workspaceId, {
        bootstrap: {
          at: Date.now(),
          // WI-6284: say WHICH path produced this record. Until this existed, the
          // only way to tell a real dial from this destroyed-stub no-op was to
          // notice that the dial writer below emits `phase`/`rungs`/`shallow` and
          // this one does not — an accidental discriminator that one added key
          // here would have silently erased, on the exact record a release
          // reviewer uses to decide whether the live cold join ever ran.
          path: 'no-topic-stub',
          ok: outcome.ok,
          // WI-6372: `ok` means A FETCH COMPLETED. `converged` is the question a
          // release reviewer actually cares about, carried here so the two can
          // never again be read as the same thing from this record. `null` =
          // the probe could not judge (no announcements to compare against).
          converged: convergence?.converged ?? null,
          namespaceCount: outcome.namespaces.length,
          skippedExisting: outcome.skippedExisting.length,
          // WI-37226: carried, not recomputed — see the note above the prior read.
          consecutiveMisses: priorStubBootstrap?.consecutiveMisses ?? 0,
          firstMissAt: priorStubBootstrap?.firstMissAt ?? null,
          // EI-18799556647570956: two host processes CAN run this leg concurrently
          // for the same install (nothing here takes a per-install lease), and each
          // `patchRoutineMetadata` call replaces the WHOLE `bootstrap` key — so a
          // stale process (older code, missing a field like `converged`) racing a
          // freshly-restarted one silently erases fields tick-to-tick with no way
          // to tell which process/build wrote the record you're looking at. This is
          // the cheap half of the fix (self-evident staleness, not the lease): stamp
          // the writer's identity so a reader can tell "this record came from a
          // stale process" instead of "the fix regressed". `instance` reuses
          // PROCESS_INSTANCE_ID (pid + process-start stamp, already used for the
          // resolver/content-fixer dispatch markers above) so all three "who wrote
          // this" stamps in this file share one identity, never three.
          writer: { pid: process.pid, instance: PROCESS_INSTANCE_ID, sha: getBuildInfo().sha },
        },
      });
      if (!outcome.ok) {
        console.warn(`[git-sync] ${slug}: bootstrap-tick reported errors: ${outcome.stderr.trim().slice(0, 500)}`);
      }
      return;
    }

    // Try each candidate until one seeds: a dial-registry miss (pre-destroyed
    // decoy duplex) costs nothing and moves on; a LIVE duplex whose fetch then
    // fails also moves on (bootstrapFromPeer is rewind-safe by contract, and a
    // half-dead channel must not starve a healthy later candidate). Attempts
    // are capped so a large member set can't stack fetch ceilings in one tick.
    const MAX_LIVE_ATTEMPTS = 3;
    const dialLog: string[] = [];
    let outcome: Awaited<ReturnType<typeof bootstrapFromPeer>> | null = null;
    let liveAttempts = 0;
    // WI-6418 (bootstrap half): ONE in-flight ladder per repo, process-wide.
    //
    // This is the fetch driver that matters for a cold join, and N staggered
    // git-sync routines all reach it for the SAME repo. Unguarded, each opens its
    // own session, and the serve side then refuses (or, pre-WI-6412, supersedes)
    // the transfer already streaming. A multi-GB pot needs longer than the
    // aggregate drive interval, so it restarts forever — at ANY throughput. The
    // ceiling is a PERIOD, not a RATE, which is why throughput work never moved it.
    //
    // Keyed on the REPO rather than (repo, device) because that is the unit the
    // PEER rations: `inFlightServes` in serve-wiring.ts is a process-wide Set whose
    // cap counts same-repo serves across every connection. It also matches this
    // loop's own rule below — it breaks on first progress instead of dialing a
    // second peer, since stacking another fetch ceiling only duplicates work the
    // next tick resumes anyway. Every candidate here mirrors the same
    // `+refs/namespaces/*`, so peers are interchangeable; that is exactly why
    // ref-announce keeps a per-DEVICE key (there each device is a different
    // namespace on a different remote process) and this leg must not.
    const ladder = await withFetchCoalescing(fetchCoalescerKey(repoPath, '<bootstrap-ladder>'), async () => {
    for (const peerDevicePubkeyBase64 of candidateDevicePubkeys) {
      if (liveAttempts >= MAX_LIVE_ATTEMPTS) break;
      // EI-15333: skip a peer we already know (within the backoff window)
      // definitively refuses this exact repo — never counts as a live
      // attempt (nothing was dialed), same as a registry no-path miss.
      const backoffKey = noSuchRepoBackoffKey(repoKey, peerDevicePubkeyBase64);
      if (isNoSuchRepoBackoffActive(backoffKey)) {
        dialLog.push(`${peerDevicePubkeyBase64.slice(0, 8)}:backoff(no-such-repo)`);
        continue;
      }
      const duplex = await dialContext.openDuplex(peerDevicePubkeyBase64, {
        repoKey,
        peerGithubUserId: actor?.githubUserId,
      });
      if (duplex.destroyed) {
        dialLog.push(`${peerDevicePubkeyBase64.slice(0, 8)}:no-path`);
        continue;
      }
      liveAttempts++;
      // WI-6189: hand the ladder a re-dial so ONE tick can climb several rungs
      // against this same peer — each rung is a separate `git fetch` and a
      // pot-git duplex serves exactly one. A dial that fails or comes back dead
      // resolves to null, which stops the ladder cleanly with its progress
      // already durable on disk.
      outcome = await bootstrapFromPeer(repoPath, duplex, {
        selfDevicePubkey,
        dial: async () => {
          const next = await dialContext
            .openDuplex(peerDevicePubkeyBase64, {
              repoKey,
              peerGithubUserId: actor?.githubUserId,
            })
            .catch(() => null);
          return next && !next.destroyed ? next : null;
        },
      });
      // Surface WHY a LIVE dial then failed — otherwise the tick log only ever
      // shows the generic ":failed" + fetch-transport's "duplex already
      // destroyed before fetch began", and the ACTUAL cause (the peer's serve
      // decision) is invisible on THIS machine, forcing a cross-machine
      // serve.log read to learn it (P-303 reverse-leg drill 2026-07-17: five
      // diagnosis wakes stalled on a reason the dialing box already received
      // over the wire). The peer's `refuse` frame destroys our client duplex
      // with `pot-git serve refused: <reason>` (serve-wiring.ts handleRefuse) —
      // no-such-repo / mode-legacy / scope-repo:* / not-serving — and a
      // transport drop destroys it with `serve channel closed`; node retains
      // whichever on `duplex.errored` (set synchronously by .destroy(err), so
      // no event-timing race). Fail-soft: absent/undefined ⇒ bare ":failed".
      const dialErr = (duplex as { errored?: Error | null }).errored;
      // WI-6189: a ladder that climbed rungs without finishing is HEALTHY
      // IN-PROGRESS, not a failure — reporting it as ":failed" is what made a
      // large cold-join look permanently broken when it was in fact advancing.
      dialLog.push(
        `${peerDevicePubkeyBase64.slice(0, 8)}:${
          outcome.ok
            ? 'ok'
            : outcome.progressed
              ? `progress(${outcome.phase} +${outcome.steps} rungs, ${outcome.quarantineRefs} refs staged${outcome.shallow ? ', still shallow' : ''})`
              : `failed${dialErr?.message ? `(${dialErr.message})` : ''}`
        }`,
      );
      // EI-15333: a definitive no-such-repo refusal (not a generic/transient
      // dial failure) arms the backoff so this exact pair stops being
      // re-dialed every tick.
      if (!outcome.ok && dialErr?.message?.includes('no-such-repo')) {
        armNoSuchRepoBackoff(backoffKey);
      }
      // WI-6364 (fix C, joiner half): the peer refused because the key we asked
      // for names a store IT ABANDONED, and told us what its store is really
      // called. Adopt it — this is the one repair channel that needs nothing but
      // the dial we just made (see adopt-refused-repo-key.ts). Deliberately NOT
      // arming any backoff: the whole point is that the NEXT tick dials again,
      // under the corrected key, against this same peer.
      const refusedKey = await adoptRefusedRepoKey(slug, dialErr?.message);
      if (refusedKey.adopted) {
        console.log(
          `[git-sync] ${slug}: pot-git RE-KEYED ${refusedKey.from ?? repoKey} → ${refusedKey.adopted} ` +
            `— peer ${peerDevicePubkeyBase64.slice(0, 8)} refused the old key as a store it has abandoned. ` +
            `The next tick bootstraps from the live store; the old one at ` +
            `${refusedKey.from ?? repoKey} is now orphaned locally and can be reclaimed.`,
        );
        break; // nothing more this tick can do under a key we just replaced
      }
      // Stop on a finished join, and ALSO on real durable progress: the rungs
      // this tick climbed are on disk, so re-dialing a second peer now would
      // only stack another fetch ceiling for work the next tick resumes anyway.
      if (outcome.ok || outcome.progressed) break;
    }
    // Hand the ladder's verdict back OUT rather than leaning on the closure's
    // write to `outcome`: TypeScript's control-flow analysis does not track
    // assignments made inside a nested function, so without this every read below
    // narrows to `never` and the whole reporting/metadata block stops
    // typechecking (the same trap that produced the priorBootstrap `never` errors).
    return outcome;
    });
    if (!ladder.ran) {
      // NOT a failure: a fetch for this repo is already streaming, so this tick
      // has nothing to add. Returning HERE — before patchRoutineMetadata — is
      // deliberate: that writer stamps `path: 'dialed'` unconditionally, so
      // falling through would record a dial that never happened AND overwrite the
      // durable ladder telemetry (phase/rungs/quarantineRefs) that
      // EI-18775478513129278 exists to carry forward. Progress stays on disk in
      // the quarantine refs, which are the resume checkpoint; the next tick
      // continues from there.
      console.log(
        `[git-sync] ${slug}: bootstrap-tick stood down — a fetch for this repo is already in flight`,
      );
      return;
    }
    // Re-anchor the narrowing in THIS scope (see the closure's `return` above).
    outcome = ladder.result;
    // EI-18775478513129278: `outcome` stays null when this tick never got a
    // live dial at all (every candidate hit backoff or a registry miss) — the
    // "no live dial path" case. `rungs:0`/`ok:false` are HONEST for THIS tick
    // (nothing was dialed), but namespaceCount/quarantineRefs/phase/shallow/
    // deepenNext describe DURABLE ON-DISK ladder progress this tick never
    // touched — forcing them to 0/null erased the record of every earlier
    // rung a prior tick had climbed (a release reviewer's only surface for
    // "is this cold join progressing?"). Carry those fields forward from the
    // last recorded tick instead of clobbering them; only a tick that actually
    // dialed (a real `outcome`) gets to report a fresh disk read.
    let priorBootstrap: PriorBootstrapMeta | null = null;
    if (!outcome) {
      priorBootstrap = await readPriorBootstrapMeta(slug, workspaceId);
    }
    // WI-37226: run-length of consecutive dial misses. A real dial (any `outcome`,
    // including one that errored — it PROVED a live path existed) ends the run; only a
    // tick that never got a dial at all extends it.
    const missRunLength = outcome ? 0 : (priorBootstrap?.consecutiveMisses ?? 0) + 1;
    const missRunStartedAt = outcome ? null : (priorBootstrap?.firstMissAt ?? Date.now());
    await patchRoutineMetadata(slug, workspaceId, {
      bootstrap: {
        at: Date.now(),
        // WI-6284: see the stub writer above — this record must SAY it came from
        // a real dial rather than leaving a reader to infer it from key presence.
        path: 'dialed',
        ok: outcome?.ok ?? false,
        // WI-6372: see the stub writer above — `ok` is "a fetch completed",
        // `converged` is "we are level with the pot". Never the same question.
        converged: convergence?.converged ?? null,
        namespaceCount: outcome?.namespaces.length ?? priorBootstrap?.namespaceCount ?? 0,
        skippedExisting: outcome?.skippedExisting.length ?? 0,
        // WI-6189 ladder telemetry — the burn-down a watcher needs to tell a
        // converging cold-join from a stalled one WITHOUT a cross-machine log
        // read: staged refs should only ever grow, and `shallow` flips false
        // on the last rung before the namespaces appear.
        phase: outcome?.phase ?? priorBootstrap?.phase ?? null,
        rungs: outcome?.steps ?? 0,
        quarantineRefs: outcome?.quarantineRefs ?? priorBootstrap?.quarantineRefs ?? 0,
        shallow: outcome?.shallow ?? priorBootstrap?.shallow ?? null,
        deepenNext: outcome?.deepenNext ?? priorBootstrap?.deepenNext ?? null,
        // WI-37226: the promised "persistent misses" signal, made readable WITHOUT a
        // cross-machine log read — the same reason the WI-6189 ladder telemetry above
        // is persisted rather than only logged.
        consecutiveMisses: missRunLength,
        firstMissAt: missRunStartedAt,
        // EI-18799556647570956: see the stub writer above — same writer stamp, same
        // rationale (two processes CAN race this leg for one install; the stamp makes
        // a stale-process overwrite self-evident instead of reading as a regression).
        writer: { pid: process.pid, instance: PROCESS_INSTANCE_ID, sha: getBuildInfo().sha },
      },
    });
    if (!outcome) {
      // topicHex is in the message deliberately: a registry miss with a peer
      // PROVABLY registered means the handle's topic and the hello channel's
      // topic diverged — the one distinction the decoy stub otherwise erases
      // (live-caught P-303: every tick decoyed while a verified hello for the
      // exact requested device key sat registered).
      // EI-18740968796318403: say what `no-path` ACTUALLY means. It reads as
      // "the peer is unreachable / the topic is dead" and is neither — it means
      // the dial registry held no entry for that device AT THE INSTANT we looked,
      // which under hello-channel churn is routinely true of a peer that is
      // connected and exchanging data one second either side. That misreading
      // cost two separate investigations a wrong root cause (this item, and the
      // WI-6299 cold-join drill), so the log now carries the distinction.
      const topicLabel = dialContext.topicHex?.slice(0, 12) ?? 'sidecar-owned';
      const missBase =
        `[git-sync] ${slug}: bootstrap-tick: no candidate member device was registered in the pot-git dial registry at this instant ` +
        `(topic ${topicLabel}${dialContext.topicHex ? '…' : ''}, dial path ${dialContext.path}, dialed: ${dialLog.join(', ')})`;
      if (missRunLength >= BOOTSTRAP_PERSISTENT_MISS_THRESHOLD) {
        // WI-37226: this is the branch the old wording PROMISED and never had. Note what
        // it does NOT say: it names no cause. The single-miss text below is right that a
        // miss is not proof of unreachability, and the temptation on a long run is to
        // upgrade it to a diagnosis ("the peer is dark / the rig is at loginwindow").
        // That exact upgrade already cost TWO investigations a wrong root cause
        // (EI-18740968796318403 and the WI-6299 cold-join drill), so what escalates here
        // is the CONFIDENCE THAT SOMETHING IS WRONG plus the checks that discriminate —
        // never a verdict this code has no evidence for.
        const runMin = missRunStartedAt ? Math.max(1, Math.round((Date.now() - missRunStartedAt) / 60_000)) : 0;
        // WI-37574: of the three discriminators below, (2) is the ONE this process
        // can answer from its own memory — (1) needs the rig over SSH and (3) needs a
        // topic comparison, but the content-announce peer count for THIS topic is an
        // O(1) Map read we are already holding. Asking the READER to go measure it
        // cost two consecutive wakes a manual journal dig on EI-18808621019872598,
        // and its absence invited the wrong reading — "pot-git pairing is COMPLETELY
        // down", i.e. a swarm fault — when the swarm was healthy and simply had no
        // peer (the rig guest was dark; ARP FAILED).
        //
        // Dynamically imported for exactly the reason getBootedHarness is (see
        // resolveHiveGitDialContext): a static import drags swarm.ts's real module graph
        // into every caller's test, and swarm.ts pulls symbols from peer-dial-registry
        // that partial mocks do not provide.
        //
        // ⚠ It degrades to UNKNOWN, never to 0. "no peers" and "could not measure"
        // route the investigation to OPPOSITE conclusions, and this is a logging path
        // that must never throw.
        let swarmEvidence = 'contentPeers=UNKNOWN lastAnnounceRecv=UNKNOWN (swarm state unreadable this tick)';
        try {
          if (!dialContext.topicHex) {
            throw new Error('swarm observability is sidecar-owned');
          }
          const { contentPeerCountForTopic, lastContentAnnounceRecvMs } = await import('../../sync/hyperbee/swarm');
          const peers = contentPeerCountForTopic(dialContext.topicHex);
          const lastMs = lastContentAnnounceRecvMs(dialContext.topicHex);
          const lastTxt = lastMs == null ? 'never' : `~${Math.max(0, Math.round((Date.now() - lastMs) / 60_000))}m ago`;
          swarmEvidence = `contentPeers=${peers} lastAnnounceRecv=${lastTxt}`;
        } catch {
          // keep UNKNOWN — an unmeasurable swarm is not an empty one
        }
        console.warn(
          `${missBase}. ⚠ PERSISTENT-MISS ESCALATION: ${missRunLength} consecutive ticks over ~${runMin}m with ZERO dials ` +
            `for this install. That is past the point hello-channel churn explains — this run is a REAL signal, unlike any ` +
            `single miss. This log names NO cause; run these to discriminate: ` +
            `(1) is the peer PROCESS even up? on the macOS rig, bin/vm-rig/preflight-login.sh exits 2 on the kcpassword/` +
            `loginwindow silent-death class (WI-4070/EI-13010), which presents EXACTLY as a swarm wedge with no error; ` +
            `(2) ANSWERED IN-BAND, do not re-derive it — swarm content-announce state for THIS topic at this instant: ` +
            `${swarmEvidence}. Reading: contentPeers>0 ⇒ the peers ARE talking, so this is a registry/topic problem and ` +
            `NOT reachability; contentPeers=0 with lastAnnounceRecv=never ⇒ nothing has ever paired on this topic, which ` +
            `points at reachability (check 1). This is a MEASUREMENT, not a cause; ` +
            `(3) does the dial topic match the hello channel's topic (the divergence the topicHex above exists to expose). ` +
            `Run-length + start are persisted at routines.metadata->'bootstrap'.{consecutiveMisses,firstMissAt}.`,
        );
      } else {
        console.warn(
          `${missBase}. ` +
            `NOTE: "no-path" = registry miss at sample time, NOT proof the peer is unreachable — a churning hello channel ` +
            `de-registers between ticks. Retried next tick; persistent misses across many ticks are the real signal ` +
            `(this run: ${missRunLength}/${BOOTSTRAP_PERSISTENT_MISS_THRESHOLD} before escalation).`,
        );
      }
    } else if (outcome.progressed && !outcome.ok) {
      // WI-6189: in-progress, not broken. Logged at info so a converging
      // multi-tick cold-join reads as burn-down rather than a repeating error.
      console.log(
        `[git-sync] ${slug}: bootstrap-tick advanced (dialed: ${dialLog.join(', ')}): ` +
          `+${outcome.steps} rung(s) → ${outcome.quarantineRefs} refs staged, ` +
          `${outcome.shallow ? `still shallow (next deepen ${outcome.deepenNext})` : 'history complete, seeding next tick'}`,
      );
    } else if (!outcome.ok) {
      console.warn(
        `[git-sync] ${slug}: bootstrap-tick reported errors (dialed: ${dialLog.join(', ')}): ${outcome.stderr.trim().slice(0, 500)}`,
      );
    } else {
      // WI-6284: the COMPLETED cold join — the one event this whole feature
      // exists to produce, and until now the ONLY outcome of this leg with no
      // log branch at all (every failure and every partial had one). That
      // asymmetry is not cosmetic: on 2026-07-27 a deliberate cold-join drill on
      // the P-302 rig SUCCEEDED here — 2 namespaces seeded in 2 rungs, history
      // complete — and emitted nothing, so the drill was checkpointed as
      // "may never have run" and the answer had to be re-derived from
      // `harness_shared.routines.metadata->'bootstrap'` on a later wake. A
      // release whose open question is "does the live cold join work" cannot
      // have success be the silent case.
      // WI-6372: this line is the single most-trusted artifact this feature
      // produces, and for 7 days it said COMPLETE about a mirror that was a
      // week stale. It must never again assert completion while the probe
      // says we are not level with the pot.
      console.log(
        `[git-sync] ${slug}: bootstrap-tick ${
          convergence?.converged === false ? 'FETCH COMPLETE BUT NOT CONVERGED' : 'COLD JOIN COMPLETE'
        } (dialed: ${dialLog.join(', ')}): ` +
          `seeded ${outcome.namespaces.length} namespace(s) in ${outcome.steps ?? 0} rung(s)` +
          `${outcome.skippedExisting.length > 0 ? `, ${outcome.skippedExisting.length} already present` : ''}` +
          `${outcome.shallow ? ' — still shallow' : ' — history complete'}` +
          `${convergence?.converged === false ? ` — ${formatConvergenceVerdict(convergence)}` : ''}`,
      );
    }
  } catch (e) {
    console.warn(`[git-sync] ${slug}: bootstrap-tick failed: ${e instanceof Error ? e.message : e}`);
  }
}

/**
 * p2p-git-live-activation P-202: the ref-announce-tick leg of one non-legacy
 * hive's git-sync tick. Best-effort: never throws (the code plane must keep
 * committing even when this pass fails); the fed-event cursor + per-device
 * budget-state map persist on the routine metadata (the `lastAdmitted` idiom
 * above, under the `ref_announce` key — distinct from P-204's
 * `worktree_bridge` key and P-203's `integrator` key, so the three legs never
 * clobber each other's watermark).
 *
 * TWO SUB-LEGS, same repo (`hiveGitRepoPath(potHomeSlug, repoKey)` — one bare
 * store per (hive, repo) key holding every member's namespace, exactly like
 * the integrator/worktree-bridge legs read/write; `repoKey` is the FEDERATED
 * cross-device identity, WI-5168 / repo-identity.ts — never the local slug):
 *   1. PUBLISH — `runRefAnnouncePublishTick`: no-ops unless this device's own
 *      namespace advanced since its last sigrefs snapshot; on advance, emits
 *      the signed announcement hive-wide (local `emitAwaitedEvent` +
 *      federated `sendMessage` fed_event — the same two-emission idiom
 *      `runIntegratorLeg` uses for its staging-advance).
 *   2. RECEIVE — pending `hive-git:ref-announce` fed-events collected off
 *      `coord_event_log` since our watermark (the same collection shape
 *      `runWorktreeBridgeLeg` uses for `hive-git:staging-advance`), fed
 *      through `runRefAnnounceReceiveTick` against the local mirror.
 *
 * DIAL-REGISTRY (WI-3583, peer-dial-registry.ts, landed 2026-07-10): `openStream`
 * resolves this harness's live swarm topic via `getBootedHarness(...).swarm
 * .topicHex` and dials the announcing device through `openHiveGitDuplexToDevice`
 * — a real per-device Protomux fetch duplex over the same shared muxer P-201's
 * serve plane answers on. Two fail-soft floors, neither ever throws: (a) no
 * live swarm join yet for this harness (private/local-only, or not booted) ⇒
 * an already-destroyed local stub, same shape as before WI-3583; (b) a live
 * topic but no open connection to THIS device yet ⇒ `openHiveGitDuplexToDevice`
 * itself resolves an already-destroyed Duplex (its own documented contract).
 * Either way the fetch reports through the documented `fetch-failed` result
 * (matching `fetchOverDuplex`'s fail-soft contract) and the batch continues;
 * only genuine cross-machine reachability (Phase 3's live rig) exercises the
 * happy path end-to-end.
 */
async function runRefAnnounceLeg(
  slug: string,
  workspaceId: string,
  options: { receive?: boolean } = {},
): Promise<void> {
  try {
    let entry: ProjectEntry | undefined;
    try {
      entry = (await loadHarnessRegistry(workspaceId)).projects.find((p) => p.slug === slug);
    } catch {
      return; // registry unreadable — next tick retries
    }
    if (!entry) return;
    const potHomeSlug = entry.hive_slug ?? (entry.self_repo ? entry.slug : undefined);
    if (!potHomeSlug) return;
    // WI-5168: federated repoKey — see repo-identity.ts.
    const repoKey = canonicalRepoKey(entry);

    const actor = await resolveUsageActor();
    if (!actor) return; // gh unauthenticated — no device identity to sign/announce as

    const members = await listHiveMembersForLocalPot(workspaceId, potHomeSlug);
    const memberDevicePubkeysBase64 = [
      ...new Set(members.flatMap((m) => m.deviceAttestations.map((a) => a.device_pubkey).filter(Boolean))),
    ];

    // P-505 cold-rejoin fence: sigrefs' normal rollback watermark lives in the
    // bare store itself. A deliberate full-store cold join removes that ref, so
    // retain this device's last published version in the already-durable routine
    // metadata and feed it back as a floor before signing the rebuilt namespace.
    // This is per git-sync routine/repo, and it never imports a peer-controlled
    // copy of our own namespace.
    const { sql } = getOrgPg();
    type RefAnnounceRoutineState = {
      lastEventId: number;
      budgetStates: Record<string, AnnounceBudgetState | null>;
      publishVersion?: number;
    };
    const stateRows = await sql<{ ref_announce: RefAnnounceRoutineState | null }[]>`
      SELECT metadata->'ref_announce' AS ref_announce
        FROM harness_shared.routines
       WHERE install_slug = ${slug} AND workspace_id = ${workspaceId} AND target_role = 'system:git-sync'
       LIMIT 1
    `;
    const priorState = stateRows[0]?.ref_announce ?? null;
    const priorPublishVersion = Number.isSafeInteger(priorState?.publishVersion)
      ? Math.max(0, priorState?.publishVersion ?? 0)
      : 0;

    const repoPath = hiveGitRepoPath(potHomeSlug, repoKey);
    const keychainId = resolveDeviceKeychainId(actor.githubUserId);
    const sign = (bytes: Buffer): Promise<Buffer> => signWithDeviceKey(keychainId, bytes);

    // 1. Publish: announce our own namespace advance, if any.
    const publishOutcome = await runRefAnnouncePublishTick({
      repoPath,
      devicePubkeyBase64: actor.devicePubkey,
      sign,
      // Same genesis contract as the own-head leg — without it the FIRST
      // sigrefs of a pre-existing repo judges the whole history and the flood
      // caps refuse it forever (peers then never fetch the repo at all).
      genesisBaselineSha: await deriveGenesisBaselineSha(entry, undefined),
      // WI-5738: runtime secrets-guard path exemptions apply here too.
      workspaceId,
      versionFloor: priorPublishVersion,
    });
    if (publishOutcome.announcement) {
      const announcement = publishOutcome.announcement;
      await emitAwaitedEvent({
        key: REF_ANNOUNCE_EVENT_KEY,
        summary: `hive-git ref-announce v${announcement.version} from ${actor.devicePubkey.slice(0, 12)}`,
        payload: announcement,
        source: 'git-sync-ref-announce',
      });
      const identity: AgentIdentity = {
        ownerId: 'git-sync-ref-announce',
        ownerLabel: 'git-sync-ref-announce',
        source: 'static-client',
        userId: null,
        workspaceId,
      };
      await sendMessage(identity, {
        to: [],
        summary: `[fed-event] ${REF_ANNOUNCE_EVENT_KEY}`,
        harnessSlug: potHomeSlug,
        extra: {
          fed_event: { key: REF_ANNOUNCE_EVENT_KEY, payload: announcement, source: identity.ownerId },
        },
      });
      // Persist only after the signed snapshot + announcement exist. A crash
      // before this write leaves the store-local version authoritative; a later
      // full-store rebuild resumes above the greatest version recorded here.
      await patchRoutineMetadata(slug, workspaceId, {
        ref_announce: {
          lastEventId: priorState?.lastEventId ?? 0,
          budgetStates: priorState?.budgetStates ?? {},
          publishVersion: Math.max(priorPublishVersion, announcement.version),
          at: Date.now(),
        },
      });
    }
    if (publishOutcome.errors.length) {
      console.warn(`[git-sync] ${slug}: ref-announce publish reported errors: ${publishOutcome.errors.join('; ')}`);
    }

    if (options.receive === false) return;
    if (memberDevicePubkeysBase64.length === 0) return; // no attested peers to receive from yet

    // 2. Receive: pending peer ref-announce fed-events since our watermark.
    const lastEventId = priorState?.lastEventId ?? 0;
    const priorBudgetStates = new Map<string, AnnounceBudgetState | null>(Object.entries(priorState?.budgetStates ?? {}));

    const feRows = await sql<{ id: number; body: Record<string, unknown> }[]>`
      SELECT id, body
        FROM harness_shared.coord_event_log
       WHERE workspace_id = ${workspaceId}
         AND harness_slug = ${potHomeSlug}
         AND surface = 'messages'
         AND id > ${lastEventId}
         AND body->'fed_event'->>'key' = ${REF_ANNOUNCE_EVENT_KEY}
       ORDER BY id ASC
       LIMIT 200
    `;
    if (feRows.length === 0) return; // fast no-op — nothing new to receive

    const pending: { rowId: number; announcement: SignedRefAnnouncement }[] = [];
    let maxRowId = lastEventId;
    for (const row of feRows) {
      maxRowId = Math.max(maxRowId, row.id);
      const fe = row.body?.fed_event as { payload?: unknown } | undefined;
      if (fe && isSignedRefAnnouncement(fe.payload)) pending.push({ rowId: row.id, announcement: fe.payload });
    }
    if (pending.length === 0) {
      // Rows existed (e.g. a malformed payload) but nothing usable — still
      // advance the cursor past them so a bad row can't loop forever.
      await patchRoutineMetadata(slug, workspaceId, {
        ref_announce: {
          lastEventId: maxRowId,
          budgetStates: priorState?.budgetStates ?? {},
          publishVersion: Math.max(priorPublishVersion, publishOutcome.announcement?.version ?? 0),
          at: Date.now(),
        },
      });
      return;
    }

    // A duplex that is already dead when the receive tick gets it: the tick
    // renders that as a `fetch-failed` carrying `message` as its stderr, which
    // is how a "we did not even dial, and here is why" outcome reaches the
    // operator log without inventing a second result shape.
    const destroyedStub = (message: string): Duplex => {
      const stub = new Duplex({
        read() {},
        write(_chunk, _enc, cb) {
          cb();
        },
      });
      // Same unhandled-'error' footgun as runBootstrapLeg's stub above —
      // attach the no-op listener BEFORE destroy(err) or the host dies
      // on an uncaughtException next tick.
      stub.on('error', () => {});
      stub.destroy(new Error(message));
      return stub;
    };
    // EI-15333, SECOND LEG. Which devices this tick genuinely put on the wire —
    // the arming gate below reads it. See that comment for why a bare stderr
    // test is not sufficient.
    const dialedThisTick = new Set<string>();

    const receiveOutcome = await runRefAnnounceReceiveTick({
      repoPath,
      pending: pending.map((p) => p.announcement),
      selfDevice: actor.devicePubkey,
      allowedDevices: memberDevicePubkeysBase64,
      budgetStates: priorBudgetStates,
      openStream: async (device) => {
        // EI-15333 — THE SAME REPAIR, ON THE LEG THAT ACTUALLY KEEPS DIALING.
        // The backoff was wired into `runBootstrapLeg` only, and this is the leg
        // that storms: that one returns early on a seeded store, while this one
        // re-drives EVERY pending announcement EVERY tick against a fed-event
        // cursor that a permanent refusal PINS (EI-15335 holds it below the
        // oldest failed row), so the held backlog is re-dialed forever and grows
        // as new announcements pile up behind it. Structurally identical to the
        // WI-6364 (fix C) miss below — a repair the stuck machine cannot reach is
        // not a repair. Rationale, the live 5.9-day stall it was caught on, and
        // why this is a backoff rather than a cursor-advance: see
        // `no-such-repo-backoff.ts`.
        const backoffKey = noSuchRepoBackoffKey(repoKey, device);
        if (isNoSuchRepoBackoffActive(backoffKey)) {
          return destroyedStub(
            `no-such-repo backoff: ${device.slice(0, 8)} definitively refused ${repoKey}; ` +
              `next dial in ${noSuchRepoBackoffSecondsLeft(backoffKey)}s`,
          );
        }
        // DIAL-REGISTRY (WI-3583) — see module doc above. Real per-device
        // dial once this harness has a live swarm topic; falls back to the
        // same pre-WI-3583 destroyed stub when it doesn't (private/local-only
        // harness, or not yet booted onto a swarm). `boot-all.ts` is a heavy,
        // wide-fan-out module (projections, coordination) this per-tick leaf
        // has no other reason to touch — imported dynamically, matching this
        // codebase's own convention for pulling in cross-cutting substrate
        // modules from a leaf call site (e.g. boot.ts's own
        // `await import('../../hive-membership-store')`), so it loads only
        // when a fetch is actually attempted, never at module-init time.
        const dialContext = await resolveHiveGitDialContext(workspaceId, slug);
        if (!dialContext) {
          return destroyedStub('hive-git: no live swarm join for this harness yet');
        }
        dialedThisTick.add(device);
        return dialContext.openDuplex(device, {
          repoKey,
          peerGithubUserId: actor.githubUserId,
        });
      },
      timeoutMs: 15_000,
    });

    // EI-15335: the receive tick returns one result per pending announcement,
    // positionally aligned. A `fetch-failed` result means the announced
    // namespace was NEVER mirrored (a transient transport failure — e.g. no
    // live swarm dial yet). Do NOT advance the fed-event cursor past it: hold
    // the cursor below the oldest failed row so the next tick re-dials, rather
    // than silently dropping the announce and leaving a permanent
    // namespace-mirror gap until the remote happens to announce again.
    const cursorDecision = decideRefAnnounceReceiveCursor(
      receiveOutcome.results,
      pending.map((p) => p.rowId),
      maxRowId,
    );

    await patchRoutineMetadata(slug, workspaceId, {
      ref_announce: {
        lastEventId: cursorDecision.cursor,
        budgetStates: Object.fromEntries(receiveOutcome.budgetStates),
        publishVersion: Math.max(priorPublishVersion, publishOutcome.announcement?.version ?? 0),
        at: Date.now(),
      },
    });

    // EI-15333 (second leg): arm the backoff for a pair that was ACTUALLY
    // DIALED this tick and came back with a definitive `no-such-repo`. The
    // `dialedThisTick` gate is load-bearing — see `devicesToArmForNoSuchRepo`.
    for (const device of devicesToArmForNoSuchRepo(cursorDecision.fetchFailed, dialedThisTick)) {
      armNoSuchRepoBackoff(noSuchRepoBackoffKey(repoKey, device));
    }
    // Log fetch failures LOUDLY (the bootstrap leg already does) — otherwise a
    // missed receive is invisible: no operator signal distinguishes "nothing
    // to receive" from "receive failed".
    //
    // COLLAPSED per (device, reason): the cursor holds BELOW the oldest failed
    // row, so a stalled pair re-reads its whole held backlog every tick and
    // emitted one identical line per announcement per tick — nine lines every
    // ~5 min on the live tower stall above, growing with the age of the stall,
    // which is what buried the one line that actually distinguished the cause.
    // One line per distinct failure, carrying the event span it stands for.
    const failureGroups = new Map<string, { device: string; reason: string; detail: string; rowIds: number[] }>();
    for (const f of cursorDecision.fetchFailed) {
      // WI-6277: this line used to end in `${f.stderr}` and nothing else, which
      // on the ceiling path is the EMPTY STRING — a SIGKILLed git writes no
      // stderr. Live on the P-302 rig that produced a stuck replication cursor
      // whose operator line literally ended in a bare colon, with a timeout, a
      // transient dial miss and a real git error all printing identically.
      // Lead with the discriminator the transport already knew.
      // WI-6189: `code === -1` is an OVERLOADED sentinel (see TransportResult.code)
      // — a git that RAN and was then killed by a signal reports `close(null)`,
      // which `code ?? -1` folds onto the same value as a spawn that never
      // happened. Labelling every -1 "no git process ran" produced the live
      // self-contradiction `no git process ran: fatal: early EOF` on the tower —
      // git's own stderr inside the clause denying git ran — and that mislabel is
      // why a mid-stream truncation kept reading as a transport seam bug.
      // Non-empty stderr is positive proof a process ran, so only claim otherwise
      // when there is genuinely nothing to show.
      const detail = f.stderr.trim();
      const reason = f.timedOut
        ? `TIMED OUT (git SIGKILLed at the fetch ceiling)`
        : f.code === -1
          ? detail
            ? `git died without an exit status (killed by a signal, or the stream closed under it)`
            : `no git process ran`
          : `git exited ${f.code}`;
      const groupKey = `${f.device}\x00${reason}\x00${detail}`;
      const group = failureGroups.get(groupKey);
      if (group) group.rowIds.push(f.rowId);
      else failureGroups.set(groupKey, { device: f.device, reason, detail, rowIds: [f.rowId] });
    }
    for (const { device, reason, detail, rowIds } of failureGroups.values()) {
      // Name the SPAN, not just the first row: "9 announcements, events
      // 7431043..7646648" is the fact that says this is a held backlog rather
      // than a one-off miss, and it is the number that grows while the stall
      // persists.
      const span =
        rowIds.length === 1
          ? `event ${rowIds[0]}`
          : `${rowIds.length} announcements, events ${rowIds[0]}..${rowIds[rowIds.length - 1]}`;
      console.warn(
        `[git-sync] ${slug}: ref-announce receive fetch FAILED for ${device.slice(0, 12)} (${span}); ` +
          `holding cursor at ${cursorDecision.cursor} to re-dial next tick: ${reason}` +
          (detail ? `: ${detail}` : ` (no stderr)`),
      );
    }
    // WI-6364 (fix C) — THE SAME REPAIR, ON THE LEG THAT ACTUALLY RECEIVES IT.
    //
    // A `superseded-repo-key:<K>` refusal is the store holder telling us,
    // first-hand, what its store is really named, and for an already-established
    // member it is the ONLY repair channel left (the join link is long gone; the
    // announce frame needs the owner already running a build that publishes it).
    //
    // It was originally wired ONLY into the bootstrap leg's dial path — and that
    // is the bug this block fixes. The bootstrap leg returns early on any
    // already-seeded store, and on a diverged pair it may never dial at all,
    // while THIS leg keeps dialing and therefore keeps collecting the refusal
    // every single tick. Live-caught tower<->rig 2026-07-27: the rig took five
    // of these per tick for hours, running a build that CONTAINED the adoption
    // code, with the canonical key sitting in plain text in the error — and
    // adopted nothing, because the only receiver was on a leg it never reached.
    // Structurally the same mistake as a detector placed below the warm gate: a
    // repair the stuck machine cannot reach is not a repair.
    //
    // Idempotent by contract (`already-canonical` is a clean no-op on every
    // later refused dial), so running it on both legs is safe by construction.
    // One adoption per tick is enough — the re-key takes effect on the NEXT
    // tick, so stop at the first refusal that resolves.
    for (const f of cursorDecision.fetchFailed) {
      const adoption = await adoptRefusedRepoKey(slug, f.stderr);
      if (adoption.adopted) {
        console.warn(
          `[git-sync] ${slug}: pot-git RE-KEYED ${adoption.from ?? '(unpinned)'} → ${adoption.adopted} ` +
            `— peer ${f.device.slice(0, 8)} refused the old key on the ref-announce leg as a store it has ` +
            `abandoned. The next tick dials under the corrected key.`,
        );
        break;
      }
      // A refusal we RECEIVED and declined to act on is the failure mode that
      // hid this bug for hours, so it must never be silent. `already-canonical`
      // and `not-a-superseded-refusal` are the boring no-ops (every ordinary
      // transport failure lands there); anything else means the repair arrived
      // and we turned it down — say which guard did it.
      if (adoption.skipped && adoption.skipped !== 'not-a-superseded-refusal' && adoption.skipped !== 'already-canonical') {
        console.warn(
          `[git-sync] ${slug}: pot-git did NOT adopt the key peer ${f.device.slice(0, 8)} named in its refusal ` +
            `(${adoption.skipped}) — the pair stays diverged until this is resolved.`,
        );
        break;
      }
    }
    if (receiveOutcome.errors.length) {
      console.warn(`[git-sync] ${slug}: ref-announce receive reported errors: ${receiveOutcome.errors.join('; ')}`);
    }
  } catch (e) {
    console.warn(`[git-sync] ${slug}: ref-announce-tick failed: ${e instanceof Error ? e.message : e}`);
  }
}

/**
 * p2p-git-live-activation P-203: the integrator-tick leg of one non-legacy
 * hive's git-sync tick. Best-effort: never throws (the code plane must keep
 * committing even when this pass fails); outcome + the `{epoch, seq}`
 * watermark persist on the routine metadata (the `lastAdmitted` idiom above).
 *
 * EPOCH GRANT (P-505 — closes the former "EPOCH NOTE" gap): the publish epoch
 * comes from `deriveIntegratorGrant` (authority-epoch.ts), which composes the
 * G-0 handoff-token library: adopt the best verified member token
 * (token.epoch + 1, FF-seeded base) on a graceful takeover; the P-038 crash
 * path (bridge watermark ahead of own publish watermark ⇒ epoch + 1, base =
 * max observed staging) when the previous authority died tokenless; standing
 * authorities keep their epoch and bump seq exactly as before. After every
 * announced advance this leg re-publishes its OWN handoff token (a
 * continuously-maintained "will"), so a successor can always adopt — crash or
 * graceful — as long as the namespace replicated.
 */
async function runIntegratorLeg(slug: string, workspaceId: string): Promise<void> {
  // Every decline below used to be a bare `return` that recorded NOTHING, so a
  // hive whose canonical ref never advances looked identical to one with
  // nothing to integrate — `metadata.integrator` is written only on a real
  // announcement. That cost hours on the hello-world-3-pot canary: the elected
  // authority (the mac) had no bare store OR git-sync routine for the repo,
  // while the only capable machine (the tower) correctly declined as
  // non-authority, so NOBODY integrated and origin silently froze. Recording
  // the reason makes "why is canonical stuck" a one-query answer.
  const decline = async (skipped: string, detail?: string): Promise<void> => {
    try {
      await patchRoutineMetadata(slug, workspaceId, { integrator_status: { at: Date.now(), skipped, detail: detail ?? null } });
    } catch {
      /* best-effort: diagnostics must never break the tick */
    }
  };
  try {
    let entry: ProjectEntry | undefined;
    try {
      entry = (await loadHarnessRegistry(workspaceId)).projects.find((p) => p.slug === slug);
    } catch {
      await decline('registry_unreadable');
      return; // next tick retries
    }
    if (!entry) return void (await decline('no_registry_entry'));
    const potHomeSlug = entry.hive_slug ?? (entry.self_repo ? entry.slug : undefined);
    if (!potHomeSlug) return void (await decline('no_hive_home'));
    // WI-5168: federated repoKey — see repo-identity.ts.
    const repoKey = canonicalRepoKey(entry);

    const actor = await resolveUsageActor();
    // gh unauthenticated — no device identity to sign/integrate as
    if (!actor) return void (await decline('no_device_identity'));

    const members = await listHiveMembersForLocalPot(workspaceId, potHomeSlug);
    const memberDevicePubkeysBase64 = [
      ...new Set(members.flatMap((m) => m.deviceAttestations.map((a) => a.device_pubkey).filter(Boolean))),
    ];
    if (memberDevicePubkeysBase64.length === 0) return void (await decline('no_attested_devices'));

    // WI-38968: lockAuthorityForHive deliberately adds SELF after applying its
    // peer eligibility filter, so an otherwise-empty election always makes
    // progress. That liveness floor is unsafe for the integrator when this
    // process's device key is NOT one of the Pot's admitted devices: SELF can
    // win, sign a staging-advance, and then every worktree bridge (including
    // this same process) correctly rejects the envelope as `wrong-device`.
    // Live papercusp reproduction 2026-08-14: the actor signed epoch 87 / seq
    // 17 for 37c20c2, while its own bridge consumed and terminally rejected the
    // event, freezing canonical + GitHub egress at 143af9. Never relax the
    // receiver gate to repair this. Refuse the unadmitted signer before the
    // election and name the identity drift in the existing status surface.
    if (!isIntegratorActorAdmitted(actor.devicePubkey, memberDevicePubkeysBase64)) {
      const detail =
        `local device ${actor.devicePubkey.slice(0, 12)} is not in the Pot's ` +
        `${memberDevicePubkeysBase64.length} attested device(s); refusing to sign a canonical advance`;
      console.warn(`[git-sync] ${slug}: ${detail}`);
      await decline('self_device_not_attested', detail);
      return;
    }

    // WI-5395: capability-gated election. Integration is per (hive, REPO), but
    // the lease used to be elected per HIVE over raw presence — so a member
    // with no bare store for THIS repo could win the lease and stall the repo
    // hive-wide while every capable member correctly declined as non-authority
    // (the canary's exact failure: the mac held the lease for
    // hello-world-3-pot with no store or routine for it). Constrain candidacy
    // to devices this machine can locally judge CAPABLE of integrating this
    // repo: self iff the local store exists (checked here — a machine without
    // the store never even runs an election), and a peer iff its device
    // namespace exists in the local store (a device that has published a head
    // for this repo demonstrably holds it). The judgment is local-knowledge
    // only, so two capable members can transiently disagree during replication
    // lag and both integrate — the FF-only + CAS + epoch fence resolves that
    // noisily but safely (the documented accepted-risk posture, proven P-308);
    // views converge with the stores.
    const repoPath = hiveGitRepoPath(potHomeSlug, repoKey);
    const storeCheck = await defaultRunGit(['rev-parse', '--git-dir'], repoPath);
    if (storeCheck.code !== 0) {
      await decline('no_local_store', `no bare store at ${repoPath} — this device cannot integrate this repo`);
      return;
    }
    const nsKeys = new Set(await listNamespaces(repoPath));
    const eligibleDevices = new Set<string>([actor.devicePubkey]);
    for (const pk of memberDevicePubkeysBase64) {
      try {
        if (nsKeys.has(deviceNamespaceKey(pk))) eligibleDevices.add(pk);
      } catch {
        /* junk pubkey in an attestation — not a candidate */
      }
    }

    // ── Progress-based candidacy (EI-19442274898324113) ──────────────────────
    // `requiresRoutine` (below) proves the holder's routine is ARMED. It does
    // NOT prove the holder is ADVANCING this pot's canonical ref — and twice in
    // two days a device published `git-sync` legitimately, won the lease with a
    // fresh heartbeat, then integrated nothing for ~5h while origin/staging fell
    // 70 and 28 commits behind with every health surface reporting green.
    // Liveness plus claimed capability is not evidence of PROGRESS.
    //
    // So measure progress, REMEMBER it across ticks, and drop a holder stuck
    // past the budget. The measured pair is deliberately the same one the
    // detector uses — canonical `refs/hive/staging` vs THIS device's published
    // namespace head — because an integrator stall pins canonical and origin
    // TOGETHER, which zeroes the ahead-count every other signal keys on.
    //
    // Best-effort throughout: ANY failure here leaves `preemptStalled` false,
    // i.e. exactly the pre-existing behaviour. A takeover must never be
    // triggered by our own inability to measure.
    const nowMs = Date.now();
    let canonicalSha: string | null = null;
    let integratorBacklogCommits: number | null = null;
    let preemptStalled = false;
    let stalledForMs = 0;
    try {
      const canonicalRead = await defaultRunGit(
        ['rev-parse', '--verify', '-q', `${BRIDGE_CANONICAL_REF}^{object}`],
        repoPath,
      );
      canonicalSha = canonicalRead.code === 0 ? canonicalRead.stdout.trim() || null : null;
      if (canonicalSha) {
        const selfNamespaceSha = await readNamespaceRef(repoPath, actor.devicePubkey, STAGING_REF);
        if (selfNamespaceSha === canonicalSha) {
          integratorBacklogCommits = 0;
        } else if (selfNamespaceSha) {
          const counted = await defaultRunGit(['rev-list', '--count', `${canonicalSha}..${selfNamespaceSha}`], repoPath);
          if (counted.code === 0) {
            const n = Number.parseInt(counted.stdout.trim(), 10);
            integratorBacklogCommits = Number.isFinite(n) ? n : null;
          }
        }

        // Namespace presence proves only that a peer has participated in this
        // repo. It does not prove that the peer currently has work to merge.
        // Exclude a peer whose staging namespace is readable and at canonical;
        // otherwise the deterministic election can repeatedly choose an idle
        // authority while another peer holds the unintegrated commits. Keep a
        // peer on measurement failures so a transient git read cannot make the
        // election disappear (the helper's fail-open contract).
        for (const peerDevicePubkey of [...eligibleDevices]) {
          if (peerDevicePubkey === actor.devicePubkey) continue;
          try {
            const peerNamespaceSha = await readNamespaceRef(repoPath, peerDevicePubkey, STAGING_REF);
            let peerBacklogCommits: number | null = null;
            if (peerNamespaceSha) {
              const counted = await defaultRunGit(
                ['rev-list', '--count', `${canonicalSha}..${peerNamespaceSha}`],
                repoPath,
              );
              if (counted.code === 0) {
                const n = Number.parseInt(counted.stdout.trim(), 10);
                peerBacklogCommits = Number.isFinite(n) ? n : null;
              }
            }
            if (!isIntegratorNamespaceBacklogged({
              namespaceSha: peerNamespaceSha,
              canonicalSha,
              aheadCommits: peerBacklogCommits,
            })) {
              eligibleDevices.delete(peerDevicePubkey);
            }
          } catch {
            /* retain a capable peer when its backlog measurement is unavailable */
          }
        }
      }

      const { sql: progressSql } = getOrgPg();
      const progressRows = await progressSql<{ integrator_progress: PriorIntegratorProgressState | null }[]>`
        SELECT metadata->'integrator_progress' AS integrator_progress
          FROM harness_shared.routines
         WHERE install_slug = ${slug} AND workspace_id = ${workspaceId} AND target_role = 'system:git-sync'
         LIMIT 1
      `;
      const progress = nextIntegratorProgressState(progressRows[0]?.integrator_progress ?? null, {
        canonicalSha,
        backlogCommits: integratorBacklogCommits,
        nowMs,
      });
      await patchRoutineMetadata(slug, workspaceId, { integrator_progress: progress });
      preemptStalled = shouldPreemptStalledIntegrator({
        state: progress,
        backlogCommits: integratorBacklogCommits,
        nowMs,
      });
      stalledForMs = progress.stalledSinceMs == null ? 0 : nowMs - progress.stalledSinceMs;
    } catch {
      /* best-effort: never block the tick, never preempt on a measurement failure */
    }

    // P-505: gate on the lease ONCE here (the tick's own default gate would
    // re-query presence) — only the current authority derives a grant; grant
    // derivation on a non-authority could wrongly seed its staging ref.
    // WI-6996: candidacy is restricted to devices that actually RUN THIS routine.
    // Without any such restriction the election is argmin/HRW over the live
    // presence roster with no notion of whether the winner integrates, which is
    // the EXACT failure EI-18761517980514694 documents for gym-cycle ("the
    // election succeeded and elected a node that does not run the loop, which is
    // why it never self-corrected"). It fired here on 2026-08-02: an iMac with a
    // fresh 10s heartbeat but no papercusp integrator held this lease for ~5h
    // while the one machine doing the committing declined `not_authority` every
    // tick. Canonical `refs/hive/staging` froze, so egress saw canonical==origin
    // and pushed nothing, and origin/staging sat 70 commits behind with every
    // health surface reporting green (see the watchdog note in
    // origin-freshness-watchdog.ts — it compares canonical-vs-origin, so this
    // class of freeze silently disables its own detector).
    //
    // EI-19330771435294981: this used to pass `routineHostsOnly: true`, which is
    // the CADENCE-loop predicate (`gym-cycle`/`scout-cycle`). Papercusp runs no
    // cadence routine, so that bit is null on EVERY row here — the narrowing
    // excluded ALL peers rather than the incapable ones, leaving integrator
    // arbitration OFF rather than tightened. It was a time bomb, not a fix: the
    // moment one peer armed a cadence routine it would have become the sole
    // eligible integrator for a routine it does not run. `requiresRoutine` asks
    // this election's OWN question instead — is `'git-sync'` in the peer's
    // published `shared_presence.active_routines` (mig 724).
    //
    // Matching is EXACT array membership, not substring: `foreign-git-sync` is a
    // real routine here and must never satisfy this predicate.
    //
    // Safe by construction: eligibility constrains PEERS only — both selectors
    // add SELF unconditionally AFTER the exclusion filter (lock-authority.ts
    // `selectAuthorityFromRows`), so the degenerate case (no device publishes
    // the set yet) is "every peer excluded ⇒ self wins ⇒ this node integrates
    // its own repo", which is strictly better than freezing. Two nodes briefly
    // both integrating is the already-accepted risk this leg documents above
    // (FF-only + CAS + epoch fence, proven P-308).
    let authority: Awaited<ReturnType<typeof lockAuthorityForHive>>;
    try {
      authority = await lockAuthorityForHive(potHomeSlug, {
        eligibleDevices,
        requiresRoutine: 'git-sync',
      });
    } catch {
      // presence unreadable — the real authority still runs its own tick
      await decline('presence_unreadable');
      return;
    }

    // The takeover. Only a NON-self holder can be preempted, and only past the
    // budget: dropping it re-runs the election without it, and lock-authority
    // adds SELF unconditionally AFTER the exclusion filter, so the degenerate
    // case is "self wins ⇒ this node integrates its own repo" — which this leg
    // already documents (above) as strictly better than freezing. Two nodes
    // briefly both integrating is the accepted risk here (FF-only + CAS + epoch
    // fence, proven P-308), so the worst case of a WRONG preemption is a
    // redundant integration, never corruption. That asymmetry is what makes
    // acting on a local, best-effort measurement sound.
    if (preemptStalled && !authority.isSelf && authority.peer?.devicePubkey) {
      const stalledHolder = authority.peer.devicePubkey;
      if (eligibleDevices.delete(stalledHolder)) {
        console.warn(
          `[git-sync] ${slug}: PREEMPTING stalled integrator ${stalledHolder.slice(0, 12)} — canonical ${canonicalSha?.slice(0, 8) ?? '?'} frozen ${Math.round(stalledForMs / 60_000)}min with ${integratorBacklogCommits ?? '?'} commit(s) unintegrated`,
        );
        try {
          authority = await lockAuthorityForHive(potHomeSlug, { eligibleDevices, requiresRoutine: 'git-sync' });
        } catch {
          /* keep the pre-preemption verdict — the decline below records it */
        }
        // Recorded so "why did the lease move" is a one-query answer, exactly as
        // `integrator_status` made "why is canonical stuck" one.
        try {
          await patchRoutineMetadata(slug, workspaceId, {
            integrator_preempt: {
              at: nowMs,
              stalledHolder,
              stalledForMs,
              canonicalSha,
              backlogCommits: integratorBacklogCommits,
              wonLease: authority.isSelf,
            },
          });
        } catch {
          /* diagnostics must never break the tick */
        }
      }
    }

    if (!authority.isSelf) {
      // The COMMON, healthy case (someone else holds the lease) — named so a
      // stuck canonical is a one-query diagnosis: the holder shown here is
      // always a CAPABLE device now (eligibility-gated above).
      await decline(
        'not_authority',
        `lease held by ${authority.peer?.machineLabel ?? 'unknown'} (${authority.peer?.devicePubkey?.slice(0, 12) ?? '?'}); liveCount=${authority.liveCount}; eligible=${eligibleDevices.size}/${memberDevicePubkeysBase64.length}`,
      );
      return;
    }

    const { sql } = getOrgPg();
    const rows = await sql<
      {
        integrator: { epoch: number; seq: number } | null;
        worktree_bridge: { epochSeq: EpochSeq | null; stagingSha?: string | null } | null;
      }[]
    >`
      SELECT metadata->'integrator' AS integrator, metadata->'worktree_bridge' AS worktree_bridge
        FROM harness_shared.routines
       WHERE install_slug = ${slug} AND workspace_id = ${workspaceId} AND target_role = 'system:git-sync'
       LIMIT 1
    `;
    const prior = rows[0]?.integrator ?? null;

    const grant = await deriveIntegratorGrant({
      repoPath,
      selfDevicePubkeyBase64: actor.devicePubkey,
      memberDevicePubkeysBase64,
      priorIntegrator: prior,
      bridgeWatermark: rows[0]?.worktree_bridge?.epochSeq ?? null,
    });
    if (!grant.ready) {
      console.warn(`[git-sync] ${slug}: ${grant.detail}`);
      await decline(grant.basis, grant.detail);
      return;
    }
    if (grant.basis !== 'standing') {
      console.info(`[git-sync] ${slug}: ${grant.detail}`);
    }
    const { epoch } = grant;
    const { priorSeq } = grant;

    const keychainId = resolveDeviceKeychainId(actor.githubUserId);
    const outcome = await runIntegratorTick({
      potHomeSlug,
      workspaceId,
      repoKey,
      memberDevicePubkeysBase64,
      integratorDevicePubkeyBase64: actor.devicePubkey,
      epoch,
      priorSeq,
      // Announcement watermark (see IntegratorTickInput.lastAnnouncedStagingSha):
      // the worktree-bridge acceptance record is the persisted "last announced +
      // accepted" staging on this machine; comparing against it (not just the
      // per-pass ref motion) is what makes the integrator-is-the-author case
      // announce at all. Null (never accepted) ⇒ the first integration announces.
      lastAnnouncedStagingSha: rows[0]?.worktree_bridge?.stagingSha ?? null,
      sign: (bytes: Buffer) => signWithDeviceKey(keychainId, bytes),
      resolveTier: async (devicePubkeyBase64) =>
        (await resolveAuthorCommsTier({ workspaceId, potHomeSlug, devicePubkey: devicePubkeyBase64 })).tier,
      deps: { isIntegrator: async () => true }, // gated above — skip the re-query
    });

    // A healthy authority that simply had nothing to merge must be
    // distinguishable from one that never ran: `metadata.integrator` is only
    // written on a real announcement, so without this an idle-but-working
    // integrator and a stalled one look identical (both absent). Record the
    // trust-gate counts too — a head QUEUED for ratification (below
    // AUTO_INTEGRATE_TIER) reads as "no advance" and cost a live diagnosis
    // (canary hello-world-3-pot: every device tier 'message' < 'steer', so
    // the integrator queued its own head forever with no visible reason).
    if (!outcome.announcement) {
      await decline(
        'ran_no_advance',
        `integrator ran; no advance (gate: ${outcome.gated ? `integrated=${outcome.gated.integrated} queued=${outcome.gated.queued} errors=${outcome.gated.errors}` : 'none'};` +
          ` conflicts=${outcome.integration?.skippedConflicts?.length ?? 0}; errors=${outcome.errors.length})`,
      );
    }

    if (outcome.announcement) {
      // Local wake for any same-machine waiter, then federate hive-wide (the
      // ref-announce.ts idiom) so every OTHER member's worktree-bridge driver
      // (P-204) wakes on the same key.
      await emitAwaitedEvent({
        key: STAGING_ADVANCE_EVENT_KEY,
        summary: `hive-git staging advanced to ${outcome.integration?.staging?.slice(0, 12)}`,
        payload: outcome.announcement,
        source: 'git-sync-integrator',
      });
      const identity: AgentIdentity = {
        ownerId: 'git-sync-integrator',
        ownerLabel: 'git-sync-integrator',
        source: 'static-client',
        userId: null,
        workspaceId,
      };
      await sendMessage(identity, {
        to: [],
        summary: `[fed-event] ${STAGING_ADVANCE_EVENT_KEY}`,
        harnessSlug: potHomeSlug,
        extra: {
          fed_event: {
            key: STAGING_ADVANCE_EVENT_KEY,
            payload: outcome.announcement,
            source: identity.ownerId,
            // Repo scoping (WI-5395 family): staging-advance events are
            // hive-scoped, but a hive binds SEVERAL repos and the sha belongs
            // to exactly one — without this, every OTHER repo's worktree-bridge
            // consumes the event, fails `rev-parse` in its own store, and
            // holds its cursor retryable (live-caught: the papercusp install
            // wedged behind a hive-canary announcement minutes after the
            // bridged flip). Envelope metadata, NOT inside the signed payload.
            // WI-5168: the FEDERATED repoKey (see repo-identity.ts) — every
            // member device must filter on the SAME key the integrator
            // published under, which the local install `slug` is not.
            repo_key: repoKey,
          },
        },
      });
      await sql`
        UPDATE harness_shared.routines
           SET metadata = jsonb_set(
             COALESCE(metadata, '{}'::jsonb),
             '{integrator}',
             ${JSON.stringify({ epoch, seq: outcome.announcement.seq, at: Date.now() })}::text::jsonb
           )
         WHERE install_slug = ${slug} AND workspace_id = ${workspaceId} AND target_role = 'system:git-sync'
      `;
      // P-505 continuous will: refresh our handoff token to the state we just
      // published, so a successor (crash OR graceful) adopts epoch+1 from it.
      // Best-effort — a miss only degrades a future takeover to the crash path.
      try {
        await publishHandoffToken(
          repoPath,
          actor.devicePubkey,
          {
            epoch,
            seq: outcome.announcement.seq,
            stagingSha: outcome.announcement.staging_sha,
            parked: (outcome.integration?.skippedConflicts ?? []).map((c) => ({
              deviceHex: c.deviceHex,
              sha: c.sha,
            })),
            nowMs: Date.now(),
          },
          (bytes: Buffer) => signWithDeviceKey(keychainId, bytes),
        );
      } catch (e) {
        console.warn(
          `[git-sync] ${slug}: handoff-token refresh failed (successor falls back to crash-path takeover): ${
            e instanceof Error ? e.message : e
          }`,
        );
      }
    }
    if (outcome.errors.length) {
      console.warn(`[git-sync] ${slug}: integrator-tick reported errors: ${outcome.errors.join('; ')}`);
    }
  } catch (e) {
    console.warn(`[git-sync] ${slug}: integrator-tick failed: ${e instanceof Error ? e.message : e}`);
  }
}

/**
 * The integrator signs an authority-bearing canonical advance, so its local
 * actor must pass the same exact device-membership gate as the receiver. Kept
 * pure/exported so the election's self-admission boundary has a direct
 * regression test instead of being inferred from an end-to-end mock.
 */
export function isIntegratorActorAdmitted(
  actorDevicePubkey: string,
  admittedDevicePubkeys: readonly string[],
): boolean {
  return actorDevicePubkey.length > 0 && admittedDevicePubkeys.includes(actorDevicePubkey);
}

/**
 * p2p-git-live-activation P-204: the worktree-bridge-tick leg of one
 * non-legacy hive's git-sync tick. Best-effort: never throws (the code plane
 * must keep committing even when this pass fails); outcome + the
 * `{epoch, seq, sha}` watermark + the fed-event cursor persist on the routine
 * metadata (the `lastAdmitted` idiom above).
 *
 * FED-EVENT COLLECTION: `hive-git:staging-advance` announcements land in this
 * machine's `harness_shared.coord_event_log` as a no-recipient, hive-scoped
 * `fed_event` row — either written locally (this device IS the integrator
 * and just emitted one, see `runIntegratorLeg`) or replicated from a peer's
 * machine (P-009 rail). Collected here directly off that table since the
 * last-processed row id (a persisted watermark) — the same "fed-event log
 * since a watermark" collection `ref-announce-tick.ts`'s header describes as
 * needed for P-202, scoped here to just the one `STAGING_ADVANCE_EVENT_KEY`.
 *
 * FETCH-ON-DEMAND (EI-14555 — closes the former OPENDUPLEX GAP): this leg now
 * wires `worktree-bridge-tick.ts`'s `openDuplex` seam through WI-3583's
 * per-peer dial registry (device pubkey → live swarm socket), the same way the
 * ref-announce leg wires its `openStream`. A pending announcement whose sha
 * isn't in the local mirror is FETCHED from the announcing device instead of
 * being rejected `unknown-sha` until the remote happens to re-announce.
 *
 * Two properties keep this safe on the machines where the old omission was
 * already correct:
 *   - the dial is PER-ANNOUNCEMENT CONDITIONAL (handleStagingAdvance skips it
 *     whenever the sha is already a local commit), so the integrator's own
 *     machine and any mirror kept current by P-202 never dial at all — and a
 *     SELF-announcement can't dial our own pubkey and wedge the cursor;
 *   - identity/topic resolution is best-effort, so a host with no gh identity
 *     or no swarm join silently keeps the pre-EI-14555 local-mirror behaviour.
 *
 * Consequence for the cursor: `fetch-failed` IS now reachable here, so the
 * P-505 cursor-hold below (retryable stop + age-bound TTL) is load-bearing
 * rather than defensive — it was already implemented for exactly this.
 */
async function runWorktreeBridgeLeg(slug: string, workspaceId: string): Promise<void> {
  try {
    let entry: ProjectEntry | undefined;
    try {
      entry = (await loadHarnessRegistry(workspaceId)).projects.find((p) => p.slug === slug);
    } catch {
      return; // registry unreadable — next tick retries
    }
    if (!entry) return;
    const potHomeSlug = entry.hive_slug ?? (entry.self_repo ? entry.slug : undefined);
    if (!potHomeSlug) return;
    // WI-5168: federated repoKey — see repo-identity.ts. Must match what
    // runIntegratorLeg published as `repo_key` on the staging-advance
    // fed-event (below), or this device's own bridge never sees it.
    const repoKey = canonicalRepoKey(entry);

    const members = await listHiveMembersForLocalPot(workspaceId, potHomeSlug);
    const memberDevicePubkeysBase64 = [
      ...new Set(members.flatMap((m) => m.deviceAttestations.map((a) => a.device_pubkey).filter(Boolean))),
    ];
    if (memberDevicePubkeysBase64.length === 0) return; // no attested devices yet

    const { sql } = getOrgPg();
    const rows = await sql<
      {
        worktree_bridge: {
          lastEventId: number;
          epochSeq: EpochSeq | null;
          stagingSha: string | null;
          /** EI-19332963201820362: consecutive ticks that consumed >=1
           *  announcement and accepted NONE. Optional — absent on any row
           *  written before this field existed. */
          acceptFreeTicks?: number | null;
          acceptFreeSince?: number | null;
        } | null;
        integrator: { epoch: number } | null;
      }[]
    >`
      SELECT metadata->'worktree_bridge' AS worktree_bridge, metadata->'integrator' AS integrator
        FROM harness_shared.routines
       WHERE install_slug = ${slug} AND workspace_id = ${workspaceId} AND target_role = 'system:git-sync'
       LIMIT 1
    `;
    const priorState = rows[0]?.worktree_bridge ?? null;
    const lastEventId = priorState?.lastEventId ?? 0;
    const priorWatermark = { epochSeq: priorState?.epochSeq ?? null, stagingSha: priorState?.stagingSha ?? null };

    // Pending hive-git:staging-advance fed-events since the watermark.
    const feRows = await sql<{ id: number; ts_ms: string | number | null; body: Record<string, unknown> }[]>`
      SELECT id, (extract(epoch FROM ts) * 1000)::bigint AS ts_ms, body
        FROM harness_shared.coord_event_log
       WHERE workspace_id = ${workspaceId}
         AND harness_slug = ${potHomeSlug}
         AND surface = 'messages'
         AND id > ${lastEventId}
         AND body->'fed_event'->>'key' = ${STAGING_ADVANCE_EVENT_KEY}
         AND body->'fed_event'->>'repo_key' = ${repoKey}
       ORDER BY id ASC
       LIMIT 200
    `;
    if (feRows.length === 0) return; // fast no-op — nothing new to bridge

    const pending: SignedStagingAdvance[] = [];
    /** Row id + age per PENDING entry, index-aligned with `pending` — the
     *  cursor-hold math (P-505) needs the stopped item's row id and age. */
    const pendingRows: { id: number; tsMs: number | null }[] = [];
    let maxRowId = lastEventId;
    for (const row of feRows) {
      maxRowId = Math.max(maxRowId, row.id);
      const fe = row.body?.fed_event as { payload?: unknown } | undefined;
      if (fe && isSignedStagingAdvance(fe.payload)) {
        pending.push(fe.payload);
        pendingRows.push({ id: row.id, tsMs: row.ts_ms === null ? null : Number(row.ts_ms) });
      }
    }
    if (pending.length === 0) {
      // Rows existed (e.g. a malformed payload) but nothing usable — still
      // advance the cursor past them so a bad row can't loop forever.
      // EI-19332963201820362: this write once omitted the accept-free census,
      // and because patchRoutineMetadata is a TOP-LEVEL jsonb merge that DELETED
      // it — one malformed row mid-freeze restarted the streak, so the detector
      // built to catch a stalled bridge went quiet during the stall. Building
      // the value through nextWorktreeBridgeState is what makes that omission
      // impossible rather than merely discouraged. Nothing was BRIDGED here
      // (consumed: 0), so the streak is CARRIED — not incremented, not reset.
      await patchRoutineMetadata(slug, workspaceId, {
        worktree_bridge: nextWorktreeBridgeState(priorState, {
          lastEventId: maxRowId,
          epochSeq: priorWatermark.epochSeq,
          stagingSha: priorWatermark.stagingSha,
          consumed: 0,
          accepted: 0,
          rejectedTerminal: {},
          nowMs: Date.now(),
        }),
      });
      return;
    }

    const repoPath = hiveGitRepoPath(potHomeSlug, repoKey);
    const { projectDirForSlug } = await import('../../operator-notes');
    const worktreePath = await projectDirForSlug(slug, workspaceId);
    if (!worktreePath) return; // no checked-out tree for this slug — next tick retries

    // P-505: the insider-poisoning cap must recognize a LEGITIMATE grant — the
    // receiver's own publish epoch alone would reject a successor authority's
    // (epoch + 1) advances as `ungranted-epoch` forever. Verified handoff
    // tokens are the grant evidence (staging-advance.ts's documented source).
    const maxGrantedEpoch = await deriveMaxGrantedEpoch({
      repoPath,
      memberDevicePubkeysBase64,
      ownIntegratorEpoch: rows[0]?.integrator?.epoch,
    });

    // EI-14555: fetch-on-demand, closing the last leg of WI-3583. The dial
    // registry (peer-dial-registry.ts) resolves device pubkey -> live swarm
    // socket, so a machine whose mirror lacks the announced sha now FETCHES it
    // instead of rejecting `unknown-sha` until the remote happens to re-announce.
    // Wired exactly like the ref-announce leg's `openStream` above.
    //
    // Identity here is BEST-EFFORT, deliberately unlike the ref-announce leg:
    // that leg must SIGN, so it returns early without an actor. This leg only
    // VERIFIES, so a machine with no gh identity (or not yet joined to a swarm)
    // must keep bridging exactly as before rather than lose the leg entirely —
    // we simply omit `openDuplex` and serve from the local mirror. The dial is
    // additionally per-announcement conditional inside handleStagingAdvance
    // (it only fires when the sha is genuinely missing), which is what makes it
    // safe to wire unconditionally on a self-announcing single-machine box.
    const actor = await resolveUsageActor();
    const dialContext = actor ? await resolveHiveGitDialContext(workspaceId, slug) : null;
    const openDuplex =
      actor && dialContext
        ? (devicePubkeyBase64: string): Promise<Duplex> =>
            dialContext.openDuplex(devicePubkeyBase64, {
              repoKey,
              peerGithubUserId: actor.githubUserId,
            })
        : undefined;

    const outcome = await runWorktreeBridgeTick({
      bareRepoPath: repoPath,
      worktreePath,
      pending,
      prior: priorWatermark,
      accept: {
        allowedDevices: memberDevicePubkeysBase64,
        ...(typeof maxGrantedEpoch === 'number' ? { maxGrantedEpoch } : {}),
      },
      ...(openDuplex ? { openDuplex } : {}),
    });

    // P-505 cursor-hold (the WI-3497 drop-forever fix): a stop (fetch-failed or
    // a RETRYABLE rejection — unknown-sha / ungranted-epoch) means the stopped
    // item and everything after it must RE-COLLECT next tick, so the cursor
    // only consumes rows strictly before it. Age-bound the hold: an item stuck
    // retryable past the TTL is a genuinely lost object, not a race — consume
    // it (loudly) so one poisoned row can never wedge the bridge forever.
    const persistenceDecision = decideWorktreeBridgePersistence({
      prior: priorState,
      maxRowId,
      pendingRows,
      outcome,
      nowMs: Date.now(),
    });
    const { cursorDecision, bridgeState } = persistenceDecision;
    const newCursor = cursorDecision.cursor;
    if (cursorDecision.expiredRow) {
      console.warn(
        `[git-sync] ${slug}: staging-advance fed-event row ${cursorDecision.expiredRow.id} stuck retryable past ` +
          `${Math.round(WORKTREE_BRIDGE_RETRY_TTL_MS / 3_600_000)}h — consuming it as lost (objects/token never federated)`,
      );
    }

    // EI-19332963201820362: the acceptance census + the accept-free streak.
    //
    // A tick that CONSUMED announcements and ACCEPTED none is the signature of
    // a bridge whose cursor is draining the announcement log while its
    // watermark stands still. One such tick is ordinary (a stale or replayed
    // envelope); a STEADY STATE of them is never healthy, and it is exactly
    // what hid a ~6h canonical-staging freeze on 2026-08-02 (85 commits with
    // no off-box copy) behind `last_status: 'synced'`, a null `last_error`,
    // and a `worktree_bridge.at` advancing every tick. Terminal rejections
    // ('non-fast-forward' for every announcement, because the namespace head
    // trailed the accepted watermark) skip-and-continue and logged NOTHING,
    // so no surface anywhere could distinguish it from a healthy idle bridge.
    // EI-19332963201820362: the census a health check reads. `consumed` and
    // `accepted` together answer "is this bridge idle, or starving?" — a
    // question no persisted field could answer before, and whose absence hid a
    // ~6h canonical-staging freeze behind `last_status: 'synced'`.
    //
    // The streak arithmetic lives in the helper because it is a THREE-way
    // decision (carry / increment / reset) that read as a two-way ternary here;
    // the collapsed case silently let a quiet tick erase an in-progress freeze
    // signal. See worktree-bridge-state.ts + its unit tests.
    await patchRoutineMetadata(slug, workspaceId, { worktree_bridge: bridgeState });

    // Warn on the STREAK, not on a single accept-free tick — one stale envelope
    // is not a fault and warning on it would train readers to ignore this line.
    // Re-warn periodically (not every tick) so a persistent freeze keeps a live
    // signal without flooding the log across hours.
    if (shouldWarnAcceptFree(bridgeState.acceptFreeTicks)) {
      const stuckForMs = bridgeState.acceptFreeSince === null ? null : Date.now() - bridgeState.acceptFreeSince;
      const byReason = Object.entries(outcome.terminalRejections)
        .map(([reason, n]) => `${reason}=${n}`)
        .join(',');
      console.warn(
        `[git-sync] ${slug}: worktree-bridge has accepted NOTHING for ${bridgeState.acceptFreeTicks} consecutive ticks` +
          (stuckForMs === null ? '' : ` (~${Math.round(stuckForMs / 60_000)}m)`) +
          ` while consuming announcements (this tick: ${bridgeState.consumed} consumed, 0 accepted` +
          (byReason ? `, terminal rejections ${byReason}` : '') +
          `). The watermark is standing still at ` +
          `epoch=${outcome.watermark.epochSeq?.epoch ?? 'null'},seq=${outcome.watermark.epochSeq?.seq ?? 'null'} — ` +
          `canonical staging is NOT advancing. Check whether our published namespace head trails the accepted ` +
          `watermark (own_head_publish.publishedSha vs .sha).`,
      );
    }

    if (outcome.errors.length) {
      console.warn(`[git-sync] ${slug}: worktree-bridge-tick reported errors: ${outcome.errors.join('; ')}`);
    }
  } catch (e) {
    console.warn(`[git-sync] ${slug}: worktree-bridge-tick failed: ${e instanceof Error ? e.message : e}`);
  }
}

/** WI-1416: the outcome-recording + escalation/dispatch tail of one tick — runs as the
 *  `git-sync:record` checkpoint (see handleGitSync). */
async function recordAndEscalateTick(a: {
  slug: string;
  workspaceId: string;
  outcome: GitSyncOutcome;
  errTicks: number;
  contentTicks: number;
  prevContentTicks: number;
  prevOversizedKeys: string[];
  cfgBranch: string | undefined;
  prevHeadSha: string | null;
  repoPath: string | null;
  attributionOn: boolean;
  /** EI-18812945811758018: 'push' | 'commit-only:<reason>' for THIS tick. */
  pushMode: string;
}): Promise<void> {
  const { slug, workspaceId, outcome, errTicks, contentTicks } = a;
  const mergeCompleted = outcome.mergeCompleted ?? [];
  await recordOutcome(slug, workspaceId, outcome, errTicks, contentTicks, a.pushMode);

  // Pipeline history (mig 177): log every tick so the /admin Git tab can show
  // sync/conflict/error rates over time (routines.metadata only keeps the LAST).
  await appendPipelineEvent({
    workspaceId,
    installSlug: slug,
    kind: 'git_sync',
    status: outcome.status,
    detail: {
      pushed: 'pushed' in outcome ? outcome.pushed : [],
      merged: 'merged' in outcome ? outcome.merged : [],
      mergeCompleted,
      conflicts:
        outcome.status === 'conflict'
          ? outcome.conflicts.map((c) => ({ scope: c.scope, files: c.conflictedFiles }))
          : [],
      errors: ('errors' in outcome ? outcome.errors : []).map((e) => ({ scope: e.scope, message: e.message.slice(0, 300) })),
      oversized: outcome.oversized.length,
      contentErrors: outcome.contentErrors.length,
      consecutiveErrorTicks: errTicks,
      ...(outcome.status === 'synced' ? { headSha: outcome.headSha } : {}),
    },
  });

  if (outcome.status === 'conflict') {
    // P-010/P-012: refresh the escalation (listing every conflicted scope) + dispatch
    // a resolver UNLESS one is genuinely in-flight. Sibling submodules still pushed (GAP-1).
    await writeGitSyncEscalation(slug, workspaceId, outcome.conflicts);
    if (!(await resolverInFlight(slug, workspaceId))) {
      const scopes = outcome.conflicts.map((c) => c.scope).join(', ');
      console.warn(`[git-sync] ${slug}: merge conflict(s) in ${scopes} — dispatching merge-resolver`);
      await spawnMergeResolver(slug, workspaceId, outcome.conflicts, a.cfgBranch ?? 'main');
    }
  } else if (
    outcome.status === 'synced' ||
    outcome.status === 'nothing' ||
    (outcome.status === 'error' && mergeCompleted.length > 0)
  ) {
    // A clean pass means any prior conflict is resolved — clear the escalation.
    // An error tick may also clear it, but only when the producer proved that its
    // merge stage completed without conflicts; a push failure alone is not proof.
    await clearGitSyncEscalation(slug, [ESCALATION_KIND]);
    // P-004 (deterministic-commit-workitem-attribution): persist the commit->work-item link
    // from the attributed commits git-sync just made (their trailers). Same flag-gate as the
    // attribution roster; best-effort + deterministic (no LLM). Only on 'synced' — a 'nothing'
    // tick made no new commits.
    if (a.attributionOn && outcome.status === 'synced') {
      await recordSyncedCommitAttribution(slug, workspaceId);
    }
  }

  // EI-438 content guard (P-004/P-005): broken files were QUARANTINED this tick
  // (excluded from the auto-commit so staging stays clean). Escalate + dispatch a
  // content-fixer (deduped), counting consecutive failing ticks so a file the fixer
  // can't repair surfaces to a human instead of looping forever. A clean tick clears
  // the escalation + resets the counter. INDEPENDENT of outcome.status — content
  // errors ride alongside on any status (like oversized), so this runs unconditionally.
  const contentErrors = outcome.contentErrors;
  if (contentErrors.length > 0) {
    const needsHuman = contentTicks >= MAX_CONTENT_FIXER_ATTEMPTS;
    await writeGitSyncContentEscalation(slug, workspaceId, contentErrors, contentTicks, needsHuman);
    if (needsHuman) {
      // P-005: the fixer has had MAX_CONTENT_FIXER_ATTEMPTS ticks and the file is STILL
      // broken — STOP auto-dispatching (no infinite silent loop) and surface to a human
      // ONCE, on the transition. The file stays quarantined (never reaches staging), so
      // nothing is at risk while it waits for a human.
      if (a.prevContentTicks < MAX_CONTENT_FIXER_ATTEMPTS) {
        const summary =
          `git-sync: ${contentErrors.length} broken file(s) STILL failing their content check after ${contentTicks} ticks — ` +
          `the content-fixer couldn't repair them; a human is needed. Quarantined (staging stays clean): ` +
          contentErrors.map((c) => `${c.scope}/${c.file}`).join(', ');
        console.warn(`[git-sync] ${slug}: ${summary}`);
        // P-006: ASSIGN to the agents who edited the quarantined files (derived from presence),
        // not a fleet broadcast. Falls back to ['*'] when attribution is off / unattributable.
        const to = await assigneesForContentErrors(slug, workspaceId, contentErrors);
        await sendMessage(GIT_SYNC_IDENTITY, { to, summary, category: 'git-sync' }).catch(() => {});
      }
    } else if (!(await contentFixerInFlight(slug, workspaceId))) {
      console.warn(`[git-sync] ${slug}: ${contentErrors.length} content error(s) quarantined — dispatching content-fixer`);
      await spawnContentFixer(slug, workspaceId, contentErrors);
    }
  } else if (a.prevContentTicks > 0) {
    // Clean re-check after a quarantine — the previously-broken files now pass: clear the
    // content-error escalation (mirror the merge-resolver's clean-pass clear). Gated on the
    // prior counter so a no-content tick doesn't issue a pointless UPDATE every 10 min.
    await clearGitSyncEscalation(slug, [CONTENT_ERROR_KIND], CONTENT_ESCALATION_PHASE);
  }

  // EI-20402093158205519 strand census: populated-but-unregistered submodules holding
  // tracked work this pass could not see. INDEPENDENT of outcome.status (like the
  // content guard) — a strand is orthogonal to whether the visible tree synced, and
  // the pass that strands work is otherwise a perfectly clean 'synced'.
  //
  // THREE-WAY on purpose. `null` means the census did not RUN (discovery failed, or a
  // submodulePaths override bypassed it), which is NOT the same as running and finding
  // nothing: treating it as clean would let an unmeasured pass retire a live warning —
  // the exact silence this field exists to break, reintroduced one level up. So an
  // unmeasured tick leaves any existing row untouched, and only a MEASURED clean tick
  // clears it.
  const stranded = outcome.strandedSubmodules;
  if (stranded === null) {
    // Not measured this pass — say nothing, retire nothing.
  } else if (stranded.length > 0) {
    console.warn(
      `[git-sync] ${slug}: ${stranded.length} unregistered submodule(s) hold uncommitted tracked work — ` +
        stranded.map((s) => `${s.path} (${s.trackedFiles})`).join(', '),
    );
    await writeGitSyncStrandEscalation(slug, workspaceId, stranded);
  } else {
    // Measured and clean: every populated submodule is registered (or has nothing dirty).
    // Unconditional, matching the conflict-clear above rather than the content path's
    // counter gate — there is no strand counter in routine metadata, and the clear is a
    // primary-key UPDATE guarded by `escalation IS NOT NULL`, so a no-strand tick costs
    // one statement that matches zero rows.
    await clearGitSyncEscalation(slug, [STRAND_KIND], STRAND_ESCALATION_PHASE);
  }

  // P-003/D-004: after a real sync, sweep this harness's docs for drift — flip
  // status, enqueue documenter regenerations, flag manual re-verifies. Best-effort
  // + lazily imported so it never wedges or slows git-sync.
  if (outcome.status === 'synced') {
    try {
      const { runDocFreshnessSweepAfterSync } = await import('../docs/sweep-after-sync');
      await runDocFreshnessSweepAfterSync({
        harnessSlug: slug,
        workspaceId,
        repoRoot: a.repoPath,
        prevSha: a.prevHeadSha ?? undefined,
        headSha: outcome.headSha,
      });
    } catch {
      /* best-effort — doc drift never gates git-sync */
    }
  }
  // status === 'error' (no conflict): leave any open conflict escalation untouched;
  // errors aren't merge conflicts and shouldn't trigger/clear the resolver.

  // EI-18: repeated push failures / oversized exclusions must be LOUD — a silent
  // metadata-only error once accumulated 20h of unpushable history. The escalation
  // row never clobbers an open conflict escalation (conditional upsert); the coord
  // broadcast fires on transitions only.
  const decision = decideGitSyncEscalation({
    status: outcome.status,
    consecutiveErrorTicks: errTicks,
    errors: 'errors' in outcome ? outcome.errors : [],
    oversized: outcome.oversized,
    prevOversizedKeys: a.prevOversizedKeys,
  });
  if (decision.escalate) {
    await writeGitSyncErrorEscalation(slug, workspaceId, {
      reasons: decision.reasons,
      consecutiveErrorTicks: errTicks,
      errors: 'errors' in outcome ? outcome.errors : [],
      oversized: outcome.oversized,
    });
  } else if (decision.clear) {
    await clearGitSyncEscalation(slug, [ESCALATION_ERROR_KIND]);
  }
  if (decision.broadcast) {
    console.warn(`[git-sync] ${slug}: ${decision.broadcast}`);
    await sendMessage(GIT_SYNC_IDENTITY, { to: ['*'], summary: decision.broadcast, category: 'git-sync' }).catch(() => {});
  }
}

/**
 * Fire the git-sync action ONCE, on demand — the SAME work a cron tick does (lock,
 * content-guard, attribution, commit + push). Shared by the git-sync:run verb and by
 * release:deploy (fire-before-deploy so a (force-)deploy ships CURRENT staging, not a
 * stale tree when git-sync is lagging/wedged — WI-1320). Reads the routine's own
 * trigger_config so it behaves exactly like a tick; default config when the row is absent.
 */
export async function fireGitSyncNow(
  installSlug: string,
  workspaceId: string,
  repoPath?: string | null,
): Promise<GitSyncFireOutcome> {
  const { sql } = getOrgPg();
  const rows = (await sql`
    SELECT trigger_config FROM harness_shared.routines
     WHERE workspace_id = ${workspaceId} AND install_slug = ${installSlug} AND name = 'git-sync'
     LIMIT 1`) as Array<{ trigger_config: Record<string, unknown> | null }>;
  const triggerConfig = rows[0]?.trigger_config ?? {};
  return handleGitSync({ installSlug, workspaceId, triggerConfig, payloadTemplate: null }, repoPath);
}

// WI-1416: ownSteps — the handler checkpoints its OWN DBOS sub-steps, so the routine
// engine must run it at the WORKFLOW layer (nested inside the engine's single step,
// DBOS.runStep silently degrades to a plain call and nothing checkpoints).
// The routine engine only consumes its documented SystemActionResult hook
// (durable child spawns); the typed pipeline outcome is for on-demand callers
// such as git-sync:run, which invoke fireGitSyncNow directly. Keep the cron
// registration's contract explicit instead of leaking the action-specific
// result through the generic registry type.
registerSystemAction(
  'git-sync',
  async (ctx: SystemActionCtx): Promise<void> => {
    await handleGitSync(ctx);
  },
  { ownSteps: true },
);
