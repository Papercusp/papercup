/**
 * contribution-admission — the CODE-PLANE contributor-revocation gate for the
 * fork→PR path (PLAN pr-system-completion-dogfood, PR-5 item 4).
 *
 * ## The silent no-op this closes
 * SUBSTRATE revocation already shipped: an owner adds a target's device pubkeys
 * to `revoked_pubkeys` (hive-revoke-contributor.ts), and the boot-time read
 * admission union (`loadRevokedHivePubkeys`) denies those devices on every peer's
 * next read-merge — the target stops being able to FEDERATE content.
 *
 * But the CODE plane — a contributor's fork→PR arriving over GitHub — never
 * consulted that set. `tryAutoApprove`/`tryAutoMerge` (and the manual `reviewPr`
 * path) gate on trust-list + checks-green, never on revocation. So a revoked
 * contributor's PR still got auto-approved + merged: the
 * `non-collaborator-join-fork-pr` D-001 owner-revocation was a SILENT NO-OP on
 * contribution admission. This module is that gate.
 *
 * ## The predicate
 * `isHiveContributorRevoked` answers "has this GitHub user lost contribution
 * admission to this Hive?" — TRUE iff they ARE a bound member (≥1 device
 * attestation) but EVERY one of their bound device pubkeys is now in the Hive's
 * revoked union (no active device left). That is exactly the state
 * `revokeHiveContributor` produces (it adds ALL the target's device pubkeys to
 * the owner's `revoked_pubkeys`). A user with no member row / no devices is NOT
 * "revoked" here — that case is owned by the existing trust gate (an unknown
 * author is never trusted), not by revocation.
 *
 * ## How it wires in
 * The pure decision functions (`tryAutoApprove`/`tryAutoMerge`) take an
 * `authorRevoked` boolean and short-circuit to `skipped_revoked` BEFORE the
 * trust/checks gates — revocation is the strongest deny. The live chokepoints
 * (the manual `reviewPr` route today; PR-1's poll daemon once it lands) resolve
 * the PR author's revocation via this predicate and pass the boolean in.
 *
 * Every external read is an injected seam so the predicate is unit-testable with
 * no PG. FAIL-SAFE: a read error yields `false` (NOT revoked) — revocation layers
 * ON TOP of the trust/checks gates, so a transient membership-read failure must
 * not lock out a legitimate contributor; the trust gate still protects against an
 * untrusted author. The error is logged, never thrown.
 */
import type { Sql } from 'postgres';
import {
  loadHiveMemberDevicePubkeys,
  loadRevokedHivePubkeys,
} from '../hive-membership-store';

export interface IsHiveContributorRevokedOpts {
  workspaceId: string;
  /** The Hive's home_slug (the hive_members PK handle). */
  hiveHomeSlug: string;
  /** The PR author's verified numeric GitHub user id. */
  githubUserId: number;
  /** Injected: the member's bound device pubkeys. Default: loadHiveMemberDevicePubkeys. */
  loadDevicePubkeys?: (
    workspaceId: string,
    hiveHomeSlug: string,
    githubUserId: number,
    sql?: Sql,
  ) => Promise<string[]>;
  /** Injected: the Hive's revoked-pubkey union. Default: loadRevokedHivePubkeys. */
  loadRevoked?: (workspaceId: string, hiveHomeSlug: string, sql?: Sql) => Promise<Set<string>>;
  /** Injected logger (tests). */
  log?: (msg: string) => void;
  sql?: Sql;
}

/**
 * Has this GitHub user lost contribution admission to the Hive? TRUE iff they are
 * a bound member with ≥1 device but every device pubkey is in the revoked union.
 * Fail-safe: false on any read error (the trust gate still protects).
 */
export async function isHiveContributorRevoked(
  opts: IsHiveContributorRevokedOpts,
): Promise<boolean> {
  if (!opts.workspaceId || !opts.hiveHomeSlug) return false;
  if (!Number.isInteger(opts.githubUserId) || opts.githubUserId <= 0) return false;

  const loadDevicePubkeys = opts.loadDevicePubkeys ?? loadHiveMemberDevicePubkeys;
  const loadRevoked = opts.loadRevoked ?? loadRevokedHivePubkeys;

  try {
    const devices = await loadDevicePubkeys(
      opts.workspaceId,
      opts.hiveHomeSlug,
      opts.githubUserId,
      opts.sql,
    );
    // No bound device ⇒ not a "revoked member" — the trust gate handles unknowns.
    if (devices.length === 0) return false;

    const revoked = await loadRevoked(opts.workspaceId, opts.hiveHomeSlug, opts.sql);
    // Revoked iff EVERY bound device is in the revoked union (no active device).
    return devices.every((pk) => revoked.has(pk));
  } catch (e) {
    opts.log?.(
      `[contribution-admission] revocation read failed for gh#${opts.githubUserId} on ${opts.hiveHomeSlug}: ${
        e instanceof Error ? e.message : String(e)
      }`,
    );
    return false;
  }
}

/**
 * Resolve the Hive home slug a harness belongs to, for the code-plane gate.
 * A member project is registered with `hive_slug = <hive home slug>`
 * (_create_from_repo.ts) — so the harness's own registry row carries it. Returns
 * null for a solo/unbound harness (no Hive ⇒ no contributor revocation applies).
 * Best-effort: null on any resolution failure.
 */
export async function resolveHarnessHiveHomeSlug(
  harnessSlug: string,
  resolveProject?: (slug: string) => Promise<unknown>,
): Promise<string | null> {
  try {
    const resolve =
      resolveProject ??
      (async (s: string) => (await import('../harness-core')).resolveProject(s));
    const project = (await resolve(harnessSlug)) as { hive_slug?: string | null } | null;
    const homeSlug = project?.hive_slug ?? null;
    return homeSlug && homeSlug.length > 0 ? homeSlug : null;
  } catch {
    return null;
  }
}

/**
 * Convenience for the live chokepoints: is the PR author a revoked contributor on
 * the Hive this harness belongs to? Resolves the harness→Hive link, then the
 * revocation predicate. False for a solo/unbound harness (no Hive) and false
 * fail-safe on any error.
 */
export async function isPrAuthorRevoked(opts: {
  workspaceId: string;
  harnessSlug: string;
  githubUserId: number;
  loadDevicePubkeys?: IsHiveContributorRevokedOpts['loadDevicePubkeys'];
  loadRevoked?: IsHiveContributorRevokedOpts['loadRevoked'];
  resolveProject?: (slug: string) => Promise<unknown>;
  log?: (msg: string) => void;
  sql?: Sql;
}): Promise<boolean> {
  const hiveHomeSlug = await resolveHarnessHiveHomeSlug(opts.harnessSlug, opts.resolveProject);
  if (!hiveHomeSlug) return false;
  return isHiveContributorRevoked({
    workspaceId: opts.workspaceId,
    hiveHomeSlug,
    githubUserId: opts.githubUserId,
    ...(opts.loadDevicePubkeys ? { loadDevicePubkeys: opts.loadDevicePubkeys } : {}),
    ...(opts.loadRevoked ? { loadRevoked: opts.loadRevoked } : {}),
    ...(opts.log ? { log: opts.log } : {}),
    ...(opts.sql ? { sql: opts.sql } : {}),
  });
}
