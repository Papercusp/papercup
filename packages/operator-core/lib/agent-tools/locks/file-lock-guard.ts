/**
 * file-lock-guard — per-PATH file-lock enforcement as a handler HOF.
 *
 * This is P-013 of `agent-capability-confinement-2026-06-13`: "reimplement the
 * file-lock check inside dispatch (replacing the client PreToolUse hook for
 * fleet agents) — server-side enforced, strictly better than a client hook."
 *
 * WHY a handler HOF, not a generic dispatch-stack step (mirrors locks D-016):
 * `defineTool` lives in the borrowable, domain-free `libs/generic/tooldef` lib;
 * threading a locks-domain field through the generic dispatcher would couple it
 * to the locks domain. A handler HOF gives the SAME guarantee — the tool body
 * cannot mutate the file unless the lock is held — while keeping all locks
 * knowledge operator-side. `withResourceLock` is the named-resource sibling of
 * this; `withFileLock` is the per-path file sibling, wrapping the capability
 * file-mutation tools (`capability:write`, `capability:edit`).
 *
 * PARITY WITH THE PreToolUse HOOK — load-bearing. The client hook
 * (`~/.papercusp/hooks/cc/pretooluse-locks-acquire.sh`) sends repo-relative
 * `paths` to `locks:acquire` PLUS an explicit `coordination_domain` (the
 * physical repo root it resolved from the edit path); when a caller omits that
 * argument the SERVER stamps it via `readFileLockIdentity(ctx)`
 * (= `fileLockCoordinationDomain()` — the tree agents EDIT, WI-38252; NOT
 * `lockCoordinationDomain()`, the tree whose code the process loaded, which on
 * `:3070` is a different checkout entirely).
 * For a fleet-agent dispatch lock to contend with an SU-session hook lock on
 * the SAME logical file, this HOF must produce the SAME `(coordinationDomain,
 * repo-relative-path)` key. So it:
 *   - resolves the domain via `readFileLockIdentity(ctx)` (identical to `locks:acquire`),
 *   - computes the repo-relative path the way the hook does (resolve against the
 *     tool cwd → nearest `.git` ancestor → relpath), then `normalizePaths`.
 * A path that escapes any repo, or canonicalizes to nothing, is left
 * UNCOORDINATED (allow) — exactly as the hook does (it only locks files inside
 * a workspace worktree).
 *
 * FAIL-OPEN. The PreToolUse hook always allows the edit when the operator is
 * unreachable / errors — "cooperative discipline only works while the system is
 * up." We mirror that: an unexpected fault in the acquire path runs the body
 * anyway (logged) rather than wedging a fleet agent's edit on a lock-infra blip.
 * A genuine CONTENTION (busy) still blocks — that is the whole point.
 */

import { existsSync, statSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { resolveCapabilityBaseDir } from '../capability/base-dir';
import { hasValidGitEntry } from './valid-git-entry';
import { managedRepositoryPathToLockIdentity } from './external-path';
import { readFileLockIdentity, type IdentityCtx } from './identity';
import { inWorkspaceTxn } from './in-workspace-txn';
import { acquireWithContentionRetry, isWorkspaceContended } from './contention-retry';
import { normalizePaths, tryAcquire, tryFinishHookOperation, type AcquireBusy } from './su-lock-store';
import { notifyPlanLockChange } from './notify-lock-change';
import { enrichBusy } from './enrich-busy';
import { DEFAULT_LOCK_TTL_SEC } from './lock-config';
import type { CellReader } from '../../cell-registry';
import { readAgentStateStamp } from '../../agent-state-stamp';
import { preserveEditGeneration, recordEditAttributionStrict } from '../../edit-attribution';

/** Default lease — same as the PreToolUse hook (`ttl_sec: 1200`). Successful
 * edits preserve custody before handoff; TTL remains the crash backstop. */
const DEFAULT_TTL_SEC = DEFAULT_LOCK_TTL_SEC;

/** The ctx fields this HOF reads. A capability tool's `UnifiedToolContext`
 *  satisfies it (it carries `projectDir` + the identity fields). */
export type FileLockCtx = IdentityCtx & {
  projectDir?: string;
  log?: (msg: string) => void;
};

export interface FileLockRunContext {
  coordinated: boolean;
  /** The normalized keys passed to the lock store. */
  paths: string[];
  /** Keys acquired by this invocation; empty when a same-owner lock already existed. */
  newlyHeld: string[];
  coordinationDomain?: string;
  ownerId?: string;
}

type ToolResultLike = { content: Array<{ type: 'text'; text: string }>; isError?: boolean };

export interface FileLockSpec {
  /** Lock intent recorded on the lock row (analogue of the hook's
   *  `PreToolUse:<tool>`). Keep it short + greppable. */
  intent: string;
  ttlSec?: number;
  /**
   * Invert the fail-OPEN default documented at the top of this file: on a
   * lock-infra fault, REFUSE instead of running the body unlocked.
   *
   * Fail-open is right for the single-file capability tools it was written for
   * — parity with the PreToolUse hook, whose rule is "cooperative discipline
   * only works while the system is up", and whose blast radius on a blip is one
   * file one agent was already editing.
   *
   * It is wrong for a WIDE, OFFSET-BASED write (P-013's `lsp.apply`: a rename
   * across tens of files). There the unlocked window is precisely the event the
   * lock exists to prevent, the damage is silent — offsets land in a file a peer
   * moved out from under them — and the caller loses nothing by retrying, since
   * the whole operation is recomputable from the same cursor. So a caller whose
   * write cannot tolerate an unarbitrated window opts in here and gets a
   * `lock_unavailable` outcome to surface.
   */
  failClosed?: boolean;
}

/** Fail-CLOSED outcome: the acquire faulted and `failClosed` forbade proceeding. */
export interface FileLockUnavailable {
  acquired: false;
  busy: AcquireBusy[];
  reader?: CellReader;
  /** Set only on the fail-closed path, so a caller can tell a genuine holder
   *  (busy, someone else is editing) from infrastructure that could not answer. */
  lockUnavailable: true;
  error: string;
}

/** A final-write race is retryable, not confirmed holder contention. */
export interface FileLockRetryable {
  acquired: false;
  busy: AcquireBusy[];
  reader?: CellReader;
  reason: 'upsert_race';
  retryable: true;
}

/**
 * Resolve a raw file path (absolute or cwd-relative) to the repo-relative POSIX
 * form the lock store keys on — mirroring the PreToolUse hook's computation.
 * Returns `null` when the path is outside any git repo or escapes its repo root
 * (→ uncoordinated; the caller allows the edit, as the hook does).
 */
export function toRepoRelative(rawPath: string, cwd: string): string | null {
  const abs = isAbsolute(rawPath) ? rawPath : resolve(cwd, rawPath);
  const root = findRepoRoot(abs);
  if (!root) return null; // outside any repo — the lock store is repo-scoped.
  const rel = relative(root, abs);
  if (rel === '' || rel.startsWith('..')) return null; // the root itself, or escapes the repo.
  return rel;
}

/** Walk up from a path (or its nearest existing parent) to the dir holding a
 *  VALID `.git` entry — gitlink file (submodule/worktree) OR git dir with HEAD
 *  (see valid-git-entry.ts: a stray empty `.git` must not re-key locks).
 *  Mirrors the hook's `find_repo_root`: deriving the root per-edit keeps keys
 *  correct across the many worktrees in this workspace. */
function findRepoRoot(absPath: string): string | null {
  let d = existsSync(absPath) && isDir(absPath) ? absPath : dirname(absPath);
  for (let i = 0; i < 40 && d && d !== '/'; i++) {
    if (hasValidGitEntry(d)) return d;
    const parent = dirname(d);
    if (parent === d) break;
    d = parent;
  }
  return null;
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Acquire the per-path file lock for `paths` (single-shot, no wait — like the
 * hook's `wait:{max_sec:0}`), run `run()` only if held, preserve before handoff.
 * Returns the busy snapshot (enriched with holder presence) without running the
 * body on contention. Fails OPEN: an unexpected acquire fault runs the body.
 */
export async function guardFileLock<T>(
  ctx: FileLockCtx,
  rawPaths: string[],
  spec: FileLockSpec,
  run: (lock: FileLockRunContext) => Promise<T>,
): Promise<
  | { acquired: true; result: T; coordinated: boolean }
  | { acquired: false; busy: AcquireBusy[]; reader?: CellReader }
  | FileLockRetryable
  | FileLockUnavailable
> {
  // EI-20881501070735530: this was `ctx.projectDir ?? process.cwd()`, which broke the
  // hook-parity contract documented at the top of this file for exactly the callers it
  // guards. A superuser ctx has `projectDir: undefined`, so a RELATIVE path resolved
  // against the :3070 operator's own cwd — the release checkout's `apps/operator/`
  // subdir — while the capability tool wrote the file relative to
  // `resolveCapabilityBaseDir(ctx)`. Measured: `packages/…/git.ts` keyed as
  // `apps/operator/packages/…/git.ts`, a key no peer and no PreToolUse hook ever takes,
  // so arbitration was silently defeated (the write still landed on the right file).
  // Absolute paths were unaffected — `toRepoRelative` ignores cwd for those — which is
  // why it went unseen. Use the SAME resolver the capability tools use, so the lock key
  // and the byte that gets written can never disagree.
  const cwd = resolveCapabilityBaseDir(ctx);

  const baseRepoRoot = findRepoRoot(cwd);
  // Keep the repository and its relative key together. A submodule key paired
  // with the parent domain neither contends with its peer nor captures its bytes.
  // Only each path's repository root is resolved here. Mapping the base
  // repository to the caller's coordination domain needs the caller's identity,
  // which is read below, after the uncoordinated early return.
  let located: Array<{ root: string; path: string }>;
  let paths: string[];
  try {
    located = rawPaths.map((p) => {
      const absolute = isAbsolute(p) ? p : resolve(cwd, p);
      const managed = managedRepositoryPathToLockIdentity(absolute);
      const root = managed?.coordinationDomain ?? findRepoRoot(absolute);
      const path = managed?.path ?? toRepoRelative(absolute, cwd);
      return root && path ? { root, path } : null;
    }).filter((r): r is { root: string; path: string } => r !== null);
    paths = located.length > 0 ? normalizePaths(located.map((r) => r.path)) : [];
  } catch {
    // Preserve the existing handling of malformed/outside-repository paths.
    located = [];
    paths = [];
  }

  if (paths.length === 0) {
    // Nothing to coordinate — run the body directly.
    //
    // This is NOT a fail-open, which is why `failClosed` does not intercept it:
    // the lock store is repo-keyed, so for a path outside any repo there is no
    // key a peer could hold either. Arbitration here is vacuous, not defeated.
    // It IS reported (`coordinated: false`) rather than assumed, so a caller
    // that cares — anything claiming "this write was arbitrated" — can tell the
    // two apart instead of inferring safety from a bare success.
    return {
      acquired: true,
      result: await run({ coordinated: false, paths: [], newlyHeld: [] }),
      coordinated: false,
    };
  }

  // Read the identity only now. An uncoordinated write has no repository key and
  // so needs no attributable owner. Every coordinated write still fails closed
  // without one, and that throw stays outside the path-resolution try/catch, so
  // it can never downgrade an in-repository write to uncoordinated.
  const { ownerId, ownerLabel, coordinationDomain: defaultDomain } = readFileLockIdentity(ctx);
  const domains = [...new Set(located.map((r) => (r.root === baseRepoRoot ? defaultDomain : r.root)))];
  // This guard owns one repository transaction and one preservation receipt.
  // Never collapse an operation spanning repositories onto one of their keys.
  if (domains.length > 1) {
    throw new Error('file-lock-multiple-repositories: split the edit by repository');
  }
  const coordinationDomain = domains[0] ?? defaultDomain;

  const ttlSec = spec.ttlSec ?? DEFAULT_TTL_SEC;
  const goalRef = readAgentStateStamp(ownerId).goalRef ?? undefined;
  const operation = { id: randomUUID(), deadline: new Date(Date.now() + 120_000).toISOString() };

  let acquired: Awaited<ReturnType<typeof tryAcquire>>;
  try {
    // EI-1720 / worker-fire-path: retry a TRANSIENT pg 57014/55P03 (workspace-lock
    // timeout under box load) before failing open. Under load this acquire was
    // FAULTING on a single timeout and silently bypassing the file-lock (so
    // concurrent fleet edits raced); a few backoff retries ride out the dip.
    acquired = await acquireWithContentionRetry(() =>
      inWorkspaceTxn(coordinationDomain, ownerId, (tx) =>
        tryAcquire(tx, {
          coordinationDomain,
          owner: ownerId,
          ownerLabel,
          paths,
          intent: spec.intent,
          ttlSec,
          goalRef,
          automatic: true,
          operation,
        }),
        { paths },
      ));
  } catch (err) {
    const contended = isWorkspaceContended(err);
    const detail = err instanceof Error ? err.message : String(err);
    if (spec.failClosed || (err as { reason?: string })?.reason === 'file_lock_preservation_failed') {
      // The opt-in inversion. A wide offset-based write would rather not happen
      // at all than happen unarbitrated — see FileLockSpec.failClosed.
      ctx.log?.(`[file-lock] acquire ${contended ? 'contended after retries' : 'faulted'}, REFUSING edit (fail-closed): ${detail}`);
      return { acquired: false, busy: [], reader: { ownerId }, lockUnavailable: true, error: detail };
    }
    // FAIL-OPEN: a lock-infra fault must never wedge a fleet agent's edit
    // (parity with the hook). Reaching here on contention means the load window
    // outlasted the retries. Log + run the body.
    ctx.log?.(`[file-lock] acquire ${contended ? 'contended after retries' : 'faulted'}, allowing edit (fail-open): ${detail}`);
    return {
      acquired: true,
      result: await run({ coordinated: false, paths, newlyHeld: [], coordinationDomain, ownerId }),
      coordinated: false,
    };
  }

  if (!acquired.ok) {
    // Carry the BLOCKED caller's identity out with the contention snapshot: it is
    // resolved here and nowhere downstream, and P-026's holder context is
    // reader-relative, so without it `fileLockedResult` would have to default the
    // audience — which fails open. Absent ⇒ no context, never a wider one.
    if ('retryable' in acquired && acquired.retryable) {
      return {
        acquired: false,
        busy: acquired.busy,
        reader: { ownerId },
        reason: acquired.reason,
        retryable: true,
      };
    }
    return { acquired: false, busy: acquired.busy, reader: { ownerId } };
  }

  // A same-owner acquire can refresh an existing deliberate lock. Release
  // only the paths this invocation newly acquired; otherwise an automatic
  // guard would tear down the caller's longer-lived lock in its finally.
  // Older in-process callers/tests omit the additive field, so retain the
  // historical all-path fallback for those callers.
  const releasePaths = acquired.newly_held ?? paths;
  const newlyHeld = acquired.newly_held ?? paths;
  // P-025: push the ACQUIRE to the plan lock banner. Emitted after the txn has
  // committed, never inside it — a notify fired mid-transaction can be observed
  // before the row it announces is visible. No-ops for non-plan paths.
  notifyPlanLockChange(paths);
  let bodyReturned = false;
  let bodySucceeded = false;
  let completionConfirmed = false;
  const finish = (outcome: 'completed' | 'cancelled') =>
    inWorkspaceTxn(coordinationDomain, ownerId, (tx) => tryFinishHookOperation(tx, {
      coordinationDomain, owner: ownerId, ownerLabel, paths, intent: spec.intent,
      ttlSec, goalRef, automatic: true, operation, outcome,
      ...(outcome === 'completed' ? { beforeRelease: async (stored: {
        requestedPaths: string[]; goalRef: string | null;
        state: 'pending' | 'granted' | 'cancelled' | 'completed'; captureReceipt?: Record<string, unknown>;
      }) => {
        const input = { repoRoot: coordinationDomain, files: stored.requestedPaths, agentId: ownerId,
          sessionId: ownerId, intent: spec.intent, goalRef: stored.goalRef ?? undefined,
          workspaceId: ctx.workspaceId ?? undefined, dispatchCallId: operation.id };
        const receipt = await preserveEditGeneration({ ...input,
          operationState: stored.state, captureReceipt: stored.captureReceipt });
        await recordEditAttributionStrict({ ...input, captureReceipt: receipt });
        return receipt;
      } } : {}),
    }), { paths });
  try {
    const result = await run({ coordinated: true, paths, newlyHeld, coordinationDomain, ownerId });
    bodyReturned = true;
    const toolResult = result as { isError?: boolean; content?: Array<{ type?: string; text?: string }> } | null;
    let succeeded = toolResult?.isError !== true;
    for (const part of toolResult?.content ?? []) {
      if (part.type !== 'text' || !part.text) continue;
      try { if (JSON.parse(part.text)?.ok === false) succeeded = false; } catch { /* ordinary prose result */ }
    }
    bodySucceeded = succeeded;
    const finished = await finish(succeeded ? 'completed' : 'cancelled');
    if (!finished.ok) throw new Error(`file-lock completion refused: ${finished.reason}`);
    completionConfirmed = true;
    notifyPlanLockChange(releasePaths);
    return { acquired: true, result, coordinated: true };
  } catch (err) {
    // A preservation failure must retain the fence. Only a body that threw
    // before returning uses cancellation cleanup (without claiming capture).
    if (bodyReturned && !completionConfirmed) {
      // Reuse the durable hook operation as the recovery identity. A bare
      // custody error loses the fact that the mutation callback already ran
      // and invites callers to apply it again. Do not claim preservation or
      // handoff, or release the fence, merely to return a useful receipt.
      throw new Error(JSON.stringify({
        ok: false,
        reason: 'file_lock_completion_incomplete',
        operationId: operation.id,
        coordinationDomain,
        paths,
        bodyCompleted: true,
        bodySucceeded,
        custodyStatus: 'unconfirmed',
        lockReleaseConfirmed: false,
        retryMutation: false,
        cause: err instanceof Error ? err.message : String(err),
        advice: 'Inspect the resulting files and recover preservation for this operation; do not repeat the file mutation.',
      }), { cause: err });
    }
    if (!bodyReturned) {
      await finish('cancelled').catch((cleanupError) => {
        ctx.log?.(`[file-lock] cancellation faulted: ${String(cleanupError)}`);
      });
      notifyPlanLockChange(releasePaths);
    }
    throw err;
  }
}

/**
 * The structured contention result — the same shape the PreToolUse hook's deny
 * surfaces, so a blocked agent learns who holds the file and can replan. The
 * `enrichBusy` call hydrates each holder's declared coord intent + focus.
 */
export async function fileLockedResult(
  busy: AcquireBusy[],
  reader?: CellReader,
  reason?: 'upsert_race',
): Promise<ToolResultLike> {
  if (reason === 'upsert_race') {
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            ok: false,
            reason,
            transient: true,
            retryable: true,
            holder: 'unknown',
            busy: await enrichBusy(busy, reader),
            advice:
              'The lock changed during the final acquire write and no stable holder snapshot was confirmed. Retry the operation from scratch; do NOT treat this as a confirmed file holder.',
          }),
        },
      ],
      isError: true,
    };
  }
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify({
          ok: false,
          reason: 'file_locked',
          busy: await enrichBusy(busy, reader),
          advice:
            'File(s) held by another agent. Wait and retry, pivot to other work, or coordinate with the holder. The lock releases when they finish their edit (or at TTL).',
        }),
      },
    ],
    isError: true,
  };
}

/**
 * Wrap a role-gated tool handler so its body runs only while the per-path file
 * lock(s) it will mutate are held. On contention returns the structured
 * `file_locked` result WITHOUT running the body. (Most call sites call
 * `guardFileLock` + `fileLockedResult` directly — this HOF is the ergonomic
 * sugar for the common single-path case.)
 *
 * `extractPaths` returns the raw file paths (absolute or cwd-relative) the call
 * will mutate; for the file tools that's just `[args.file_path]`.
 */
export function withFileLock<A, C extends FileLockCtx>(
  spec: FileLockSpec,
  extractPaths: (args: A, ctx: C) => string[],
  handler: (args: A, ctx: C) => Promise<ToolResultLike> | ToolResultLike,
): (args: A, ctx: C) => Promise<ToolResultLike> {
  return async (args: A, ctx: C): Promise<ToolResultLike> => {
    const rawPaths = extractPaths(args, ctx);
    const outcome = await guardFileLock<ToolResultLike>(ctx, rawPaths, spec, async () => handler(args, ctx));
    if (outcome.acquired) return outcome.result;
    return fileLockedResult(
      outcome.busy,
      outcome.reader,
      'reason' in outcome && outcome.reason === 'upsert_race' ? outcome.reason : undefined,
    );
  };
}
