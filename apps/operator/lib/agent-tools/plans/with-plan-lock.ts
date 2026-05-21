/**
 * withPlanLock — acquire-mutate-release shape for plans:* write verbs.
 *
 * Per agent-plan-tracking-2026-05-20.md §4.4: every assisted-write verb
 * must serialize its read-modify-write through the SU lock system. The
 * OMP `tool_call` auto-lock hook only fires for `edit`/`write`/
 * `multi_edit`, so MCP tool calls don't get auto-locked — each write
 * verb owns its acquire/release.
 *
 * Critical invariant: ID allocation (D-NNN, P-NNN, slug uniqueness)
 * MUST happen *inside* the lock's mutator callback. The lock is held
 * across the entire read → allocate → write sequence; otherwise two
 * concurrent calls can both observe the same "max D-NNN" and collide.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
  ensureBootstrap,
  normalizePaths,
  tryAcquire,
  tryRelease,
  type AcquireBusy,
} from '@/lib/agent-tools/locks/su-lock-store';
import { inWorkspaceTxn } from '@/lib/agent-tools/locks/in-workspace-txn';
import { readIdentity, type IdentityCtx } from '@/lib/agent-tools/locks/identity';
import { getPlansDir, PLANS_DIR_REL, type PlanSourceOpts } from './source';

export interface WithPlanLockOpts extends PlanSourceOpts {
  /** Plan slug (filename stem). Resolves to `<plansDir>/<slug>.md`. */
  slug: string;
  /** One-line description of the mutation, surfaced to busy callers. */
  intent: string;
  /** Lock TTL — short by default since write verbs do a fast RMW. */
  ttlSec?: number;
}

export interface BusyError {
  kind: 'busy';
  busy: AcquireBusy[];
}

export interface AppliedResult<T> {
  kind: 'applied';
  value: T;
  /** Resolved file path on disk. */
  filePath: string;
}

export type WithPlanLockResult<T> = AppliedResult<T> | BusyError;

/**
 * Acquire a lock on `<plansDir>/<slug>.md`, read the file (if it
 * exists), run the mutator, write the result back, release.
 *
 * Mutator contract:
 *   - Receives the current file body (or null when creating).
 *   - Returns the new file body, or `null` to leave the file untouched
 *     (e.g. uniqueness check failed).
 *   - May allocate IDs by reading the body — the lock guarantees no
 *     concurrent allocator can observe the same state.
 */
export async function withPlanLock<T>(
  ctx: IdentityCtx,
  opts: WithPlanLockOpts,
  mutator: (current: string | null) => Promise<{ newBody: string | null; value: T }>,
): Promise<WithPlanLockResult<T>> {
  const plansDir = getPlansDir(opts);
  const filePath = path.join(plansDir, opts.slug + '.md');
  // Lock key is the workspace-canonical relative path so the same
  // plan always hashes to the same lock regardless of repoRoot. The
  // lock store rejects absolute paths.
  const lockKey = path.posix.join(PLANS_DIR_REL, opts.slug + '.md');
  const paths = normalizePaths([lockKey]);

  await ensureBootstrap();
  const identity = readIdentity(ctx);
  const ttl = opts.ttlSec ?? 60;

  const acquireResult = await inWorkspaceTxn(
    identity.coordinationDomain,
    identity.ownerId,
    (tx) =>
      tryAcquire(tx, {
        coordinationDomain: identity.coordinationDomain,
        owner: identity.ownerId,
        ownerLabel: identity.ownerLabel,
        paths,
        intent: opts.intent,
        ttlSec: ttl,
      }),
  );

  if (!acquireResult.ok) {
    return { kind: 'busy', busy: acquireResult.busy };
  }

  const lockId = acquireResult.lock_id;

  try {
    let current: string | null = null;
    try {
      current = await fs.readFile(filePath, 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }

    const { newBody, value } = await mutator(current);

    if (newBody !== null) {
      await fs.mkdir(plansDir, { recursive: true });
      await fs.writeFile(filePath, newBody, 'utf8');
    }

    return { kind: 'applied', value, filePath };
  } finally {
    await inWorkspaceTxn(identity.coordinationDomain, identity.ownerId, (tx) =>
      tryRelease(tx, {
        coordinationDomain: identity.coordinationDomain,
        owner: identity.ownerId,
        lockId,
        paths,
      }),
    );
  }
}

/**
 * Mutate the frontmatter's `updated:` field in place to today's
 * ISO-8601 date. If frontmatter is missing/invalid, returns the body
 * unchanged (legacy plans aren't assisted-write targets).
 */
export function bumpUpdatedDate(body: string, today = new Date()): string {
  const iso = today.toISOString().slice(0, 10);
  // Match top-of-file frontmatter only.
  if (!body.startsWith('---')) return body;
  const close = body.indexOf('\n---', 3);
  if (close === -1) return body;
  const fm = body.slice(0, close);
  const rest = body.slice(close);
  const updatedRe = /^(updated:\s*).*$/m;
  if (updatedRe.test(fm)) {
    return fm.replace(updatedRe, `$1${iso}`) + rest;
  }
  // Insert before the closing --- if absent.
  return fm + `\nupdated: ${iso}` + rest;
}
