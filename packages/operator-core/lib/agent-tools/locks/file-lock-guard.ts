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
 * (`~/.papercusp/hooks/cc/pretooluse-locks-acquire.sh`) sends only
 * repo-relative `paths` to `locks:acquire`; the SERVER stamps
 * `coordination_domain` via `readIdentity(ctx)` (= `lockCoordinationDomain()`).
 * For a fleet-agent dispatch lock to contend with an SU-session hook lock on
 * the SAME logical file, this HOF must produce the SAME `(coordinationDomain,
 * repo-relative-path)` key. So it:
 *   - resolves the domain via `readIdentity(ctx)` (identical to `locks:acquire`),
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
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { readIdentity, type IdentityCtx } from './identity';
import { inWorkspaceTxn } from './in-workspace-txn';
import { normalizePaths, tryAcquire, tryRelease, type AcquireBusy } from './su-lock-store';
import { enrichBusy } from './enrich-busy';

/** Default lease — same as the PreToolUse hook (`ttl_sec: 1200`). The body runs
 *  while held and releases in a finally, so this is just the crash/abort
 *  backstop (a body that dies without releasing frees at TTL). */
const DEFAULT_TTL_SEC = 1200;

/** The ctx fields this HOF reads. A capability tool's `UnifiedToolContext`
 *  satisfies it (it carries `projectDir` + the identity fields). */
export type FileLockCtx = IdentityCtx & {
  projectDir?: string;
  log?: (msg: string) => void;
};

type ToolResultLike = { content: Array<{ type: 'text'; text: string }>; isError?: boolean };

export interface FileLockSpec {
  /** Lock intent recorded on the lock row (analogue of the hook's
   *  `PreToolUse:<tool>`). Keep it short + greppable. */
  intent: string;
  ttlSec?: number;
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
 *  `.git` entry — file (submodule/worktree) OR dir. Mirrors the hook's
 *  `find_repo_root`: deriving the root per-edit keeps keys correct across the
 *  many worktrees in this workspace. */
function findRepoRoot(absPath: string): string | null {
  let d = existsSync(absPath) && isDir(absPath) ? absPath : dirname(absPath);
  for (let i = 0; i < 40 && d && d !== '/'; i++) {
    if (existsSync(join(d, '.git'))) return d;
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
 * hook's `wait:{max_sec:0}`), run `run()` only if held, release in a finally.
 * Returns the busy snapshot (enriched with holder presence) without running the
 * body on contention. Fails OPEN: an unexpected acquire fault runs the body.
 */
export async function guardFileLock<T>(
  ctx: FileLockCtx,
  rawPaths: string[],
  spec: FileLockSpec,
  run: () => Promise<T>,
): Promise<{ acquired: true; result: T } | { acquired: false; busy: AcquireBusy[] }> {
  const cwd = ctx.projectDir ?? process.cwd();

  // Resolve to the repo-relative keys the hook + server agree on. A path that
  // is uncoordinated (outside a repo / escapes it) is simply not locked.
  let paths: string[];
  try {
    const rels = rawPaths
      .map((p) => toRepoRelative(p, cwd))
      .filter((r): r is string => r !== null);
    paths = rels.length > 0 ? normalizePaths(rels) : [];
  } catch {
    // Malformed path → uncoordinated (the hook also bails on its own
    // normalization failure rather than blocking).
    paths = [];
  }

  if (paths.length === 0) {
    // Nothing to coordinate — run the body directly.
    return { acquired: true, result: await run() };
  }

  const { ownerId, ownerLabel, coordinationDomain } = readIdentity(ctx);
  const ttlSec = spec.ttlSec ?? DEFAULT_TTL_SEC;

  let acquired: Awaited<ReturnType<typeof tryAcquire>>;
  try {
    acquired = await inWorkspaceTxn(coordinationDomain, ownerId, (tx) =>
      tryAcquire(tx, { coordinationDomain, owner: ownerId, ownerLabel, paths, intent: spec.intent, ttlSec }),
    );
  } catch (err) {
    // FAIL-OPEN: a lock-infra fault must never wedge a fleet agent's edit
    // (parity with the hook). Log + run the body.
    ctx.log?.(`[file-lock] acquire faulted, allowing edit (fail-open): ${err instanceof Error ? err.message : String(err)}`);
    return { acquired: true, result: await run() };
  }

  if (!acquired.ok) {
    return { acquired: false, busy: acquired.busy };
  }

  const lockId = acquired.lock_id;
  try {
    const result = await run();
    return { acquired: true, result };
  } finally {
    // Release like the PostToolUse hook does — by lock_id, owner-checked.
    await inWorkspaceTxn(coordinationDomain, ownerId, (tx) =>
      tryRelease(tx, { coordinationDomain, owner: ownerId, lockId }),
    ).catch((err) => {
      ctx.log?.(`[file-lock] release faulted (lock frees at TTL): ${err instanceof Error ? err.message : String(err)}`);
    });
  }
}

/**
 * The structured contention result — the same shape the PreToolUse hook's deny
 * surfaces, so a blocked agent learns who holds the file and can replan. The
 * `enrichBusy` call hydrates each holder's declared coord intent + focus.
 */
export async function fileLockedResult(busy: AcquireBusy[]): Promise<ToolResultLike> {
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify({
          ok: false,
          reason: 'file_locked',
          busy: await enrichBusy(busy),
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
    return fileLockedResult(outcome.busy);
  };
}
