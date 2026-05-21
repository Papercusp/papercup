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
import type { BusyEntry } from '@papercusp/file-claim';
import {
  ensureBootstrap,
  normalizePaths,
  type AcquireBusy,
} from '@/lib/agent-tools/locks/su-lock-store';
import { SuLocksCoordinator } from '@/lib/agent-tools/locks/coordinator';
import { readIdentity, type IdentityCtx } from '@/lib/agent-tools/locks/identity';
import { getPlansDir, PLANS_DIR_REL, VALID_PLAN_SLUG, type PlanSourceOpts } from './source';

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
  // Slug guard — the write-path counterpart of `readPlanBySlug`'s
  // check. Without it a `slug` containing `/` + `..` escapes
  // `docs/plans/`: `path.join` normalises the `..` away *before*
  // the lock store's `validatePath` can see it, so a verb called with
  // `slug: '../../../CLAUDE'` would write `<repo>/apps/CLAUDE.md`.
  // Rejecting `/` (VALID_PLAN_SLUG) closes that — a `..` cannot
  // traverse without a slash. Throw rather than return: an unsafe
  // slug reaching here is caller abuse/bug, not a normal outcome.
  if (typeof opts.slug !== 'string' || !VALID_PLAN_SLUG.test(opts.slug)) {
    throw new Error(`withPlanLock: invalid plan slug ${JSON.stringify(opts.slug)}`);
  }
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

  // file-locking #11 dogfood: drive the SU-locks backend through the
  // shared FileClaimCoordinator interface rather than the underlying
  // tryAcquire / tryRelease primitives. Proves the alignment at a
  // real consumer site; the BusyError shape on the WAY OUT (snake_
  // case AcquireBusy) is preserved by translating BusyEntry at the
  // API boundary so MCP-tool callers' wire schema is unchanged.
  const coordinator = new SuLocksCoordinator({
    coordinationDomain: identity.coordinationDomain,
  });

  const acquireResult = await coordinator.acquire(identity.ownerId, paths, {
    ownerLabel: identity.ownerLabel,
    intent: opts.intent,
    ttlMs: ttl * 1000,
  });

  if (!acquireResult.ok) {
    return { kind: 'busy', busy: acquireResult.busy.map(toAcquireBusy) };
  }

  const claim = acquireResult.claim;

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
    await coordinator.release(claim);
  }
}

/** Translate the cross-backend BusyEntry shape back to the snake_
 *  case AcquireBusy that MCP-tool callers serialize over the wire.
 *  Keeps the boundary honest in both directions: in-process code uses
 *  the unified interface, JSON consumers see the stable JSON schema. */
function toAcquireBusy(b: BusyEntry): AcquireBusy {
  return {
    path: b.path,
    owner: b.owner,
    owner_label: b.ownerLabel ?? null,
    intent: b.intent ?? '',
    expires_ts: b.expiresAt ?? new Date(0),
  };
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
