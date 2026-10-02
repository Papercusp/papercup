/**
 * Hold restricted writes at git-sync.
 * Plan personal-data-reader-set-labels-2026-10-01 P-014 (WI-10005571), D-006 point 3.
 *
 * Papercusp does not author an agent's file edits the way it authors a coord
 * message, so the seal-at-write rule (P-006 / P-012) cannot reach the working
 * tree. What it does own is the commit: git-sync sweeps the shared tree and
 * pushes it off the machine. So a file an agent wrote while it held an active
 * disclosure is HELD there instead:
 *
 *   A path an agent edited at time t is held when that agent has a disclosure
 *   with delivered_at <= t that is still unreleased. The hold lifts when every
 *   such disclosure is released (D-002 / D-005).
 *
 * The hold is fed to git-sync as extra rows of its live-lock census, the same
 * seam a peer's edit lock uses (git-sync-action.ts → runGitSync liveLockHoldings
 * / refreshLiveLockHoldings). It therefore inherits everything that seam already
 * does: coordinate translation across checkouts and submodules, exclusion from
 * the staging pathspecs, edit-cohort expansion, and the late-lock unstage at the
 * final commit seam. A held path is neither committed nor pushed.
 *
 * WHICH EDITS. The source is harness_shared.edit_attribution_ledger, which records
 * each native edit (Edit / Write / apply_patch …) with its editor and time. For an
 * owner holding an active disclosure, the row is written BEFORE the edit lock is
 * released (`recordRestrictedEditBeforeRelease`, called from locks:release), so
 * there is no instant where git-sync sees neither the lock nor the hold.
 *
 * FAIL CLOSED (D-006 point 6). Both reads throw `disclosure_ledger_unavailable`
 * rather than returning an empty set. git-sync skips the tick on a census read
 * failure, and locks:release refuses (keeping the lock) when the ledger row for a
 * restricted owner cannot be written.
 *
 * Not covered here, by design: writes that never pass through a native edit tool
 * (a Bash redirect or `sed -i`) leave no ledger row. Those bypass the edit-lock
 * hook too; native-tool binding is P-007's scope.
 */

import type postgres from 'postgres';
import { getOrgPg } from '@papercusp/db-org';
import { liveLockHoldingsStrict, type LiveLockHolding } from '../agent-tools/locks/live-lock-paths';
import { DisclosureRefused } from './disclosure-ledger';

type Db = postgres.Sql | postgres.TransactionSql;

/** The intent every restricted hold carries. git-sync renders it in skipped-path diagnostics. */
export const RESTRICTED_HOLD_INTENT =
  'restricted-disclosure hold (D-006/P-014): edited while its editor held an active personal disclosure; held from commit until that disclosure is released';

const RESTRICTED_HOLD_PREFIX = 'restricted-disclosure hold (D-006';

/** True for a census row this module produced (not a real, releasable edit lock). */
export function isRestrictedHoldIntent(intent: string | null | undefined): boolean {
  return typeof intent === 'string' && intent.startsWith(RESTRICTED_HOLD_PREFIX);
}

/**
 * One held path. Structurally a `LiveLockHolding`, so it joins git-sync's census
 * unchanged; `coordinationDomain` is the ledger's `repo_root`, the domain the
 * edit lock was held in, which git-sync translates exactly as it does that lock.
 */
export interface RestrictedEditHolding {
  path: string;
  owner: string;
  intent: string;
  goalRef?: string;
  coordinationDomain?: string;
}

/** A ledger row as `readRestrictedEditHoldings` selects it. */
export interface RestrictedEditRow {
  repo_root: string | null;
  file: string | null;
  agent_id: string | null;
  work_item_id: string | null;
}

/** Map ledger rows to census holdings: one per (domain, path), blanks dropped. Pure. */
export function restrictedHoldingsFromRows(rows: readonly RestrictedEditRow[]): RestrictedEditHolding[] {
  const out: RestrictedEditHolding[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const path = row.file?.trim() ?? '';
    const owner = row.agent_id?.trim() ?? '';
    if (!path || !owner) continue;
    const domain = row.repo_root?.trim() ?? '';
    const key = `${domain}\u0000${path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const goalRef = row.work_item_id?.trim() ?? '';
    out.push({
      path,
      owner,
      intent: RESTRICTED_HOLD_INTENT,
      // A work-item seeds git-sync's edit-cohort expansion, so a restricted edit's
      // source+test siblings stay together instead of one reaching HEAD alone.
      ...(goalRef ? { goalRef } : {}),
      ...(domain ? { coordinationDomain: domain } : {}),
    });
  }
  return out;
}

function ledgerUnavailable(what: string, error: unknown): DisclosureRefused {
  return new DisclosureRefused(
    'disclosure_ledger_unavailable',
    `${what}: the disclosure ledger could not be read (${(error as Error)?.message ?? error})`,
  );
}

/**
 * Every path edited by an agent while it held a disclosure that is still active.
 * Driven from the (small) active-disclosure set, so the ledger is reached only
 * through its (agent_id, ts) index (migration 1345). Throws
 * `disclosure_ledger_unavailable` on any read failure: a census that silently
 * read as empty would commit the very files this exists to hold.
 */
export async function readRestrictedEditHoldings(sql: Db = getOrgPg().sql): Promise<RestrictedEditHolding[]> {
  let rows: RestrictedEditRow[];
  try {
    rows = await sql<RestrictedEditRow[]>`
      SELECT DISTINCT ON (l.repo_root, l.file)
             l.repo_root, l.file, l.agent_id, l.work_item_id
        FROM harness_shared.personal_disclosures d
        JOIN harness_shared.edit_attribution_ledger l
          ON l.agent_id = d.agent_owner_id
         AND l.ts >= d.delivered_at
       WHERE d.released_at IS NULL
       ORDER BY l.repo_root, l.file, l.ts DESC`;
  } catch (error) {
    throw ledgerUnavailable('git-sync restricted-write hold', error);
  }
  return restrictedHoldingsFromRows(rows);
}

/**
 * git-sync's commit-gate census: every live edit lock plus every restricted hold.
 * Both halves are strict, so either read failing throws and git-sync fails the tick
 * closed rather than staging a held path. Used for the initial census AND the
 * final-commit-seam refresh (git-sync-action.ts).
 */
export async function readGitSyncCensusStrict(
  deps: {
    locks?: () => Promise<LiveLockHolding[]>;
    restricted?: () => Promise<RestrictedEditHolding[]>;
  } = {},
): Promise<LiveLockHolding[]> {
  const [locks, restricted] = await Promise.all([
    (deps.locks ?? liveLockHoldingsStrict)(),
    (deps.restricted ?? (() => readRestrictedEditHoldings()))(),
  ]);
  return [...locks, ...restricted];
}

/** Whether `ownerId` holds any unreleased disclosure. Throws `disclosure_ledger_unavailable`. */
export async function ownerHasActiveDisclosure(sql: Db, ownerId: string): Promise<boolean> {
  try {
    const [row] = await sql<Array<{ active: boolean }>>`
      SELECT EXISTS (SELECT 1 FROM harness_shared.personal_disclosures
                      WHERE agent_owner_id = ${ownerId} AND released_at IS NULL) AS active`;
    return row?.active === true;
  } catch (error) {
    throw ledgerUnavailable('restricted-edit hold check', error);
  }
}

export interface RestrictedEditBeforeRelease {
  /** The lock's coordination domain: the root the paths are relative to. */
  repoRoot: string;
  /** The paths the native-edit proof says were written. */
  files: string[];
  ownerId: string;
  intent?: string;
  workspaceId?: string;
  contributor?: string;
}

export interface RestrictedEditBeforeReleaseDeps {
  hasActiveDisclosure?: (ownerId: string) => Promise<boolean>;
  /** Must THROW when the row is not written (the best-effort recorder swallows). */
  recordStrict?: (input: RestrictedEditBeforeRelease) => Promise<void>;
}

/**
 * Called by locks:release BEFORE it releases a native-edit lock. When the owner
 * holds an active disclosure, write the edit's ledger row first and return true,
 * so git-sync's census sees the hold before the lock disappears. Returns false
 * (and writes nothing) for an unrestricted owner. Throws
 * `disclosure_ledger_unavailable` when the check or the write fails; the caller
 * must then keep the lock rather than release it.
 */
export async function recordRestrictedEditBeforeRelease(
  input: RestrictedEditBeforeRelease,
  deps: RestrictedEditBeforeReleaseDeps = {},
): Promise<boolean> {
  const files = input.files.map((f) => f.trim()).filter(Boolean);
  if (files.length === 0 || !input.ownerId || !input.repoRoot) return false;
  const hasActive = deps.hasActiveDisclosure ?? ((owner: string) => ownerHasActiveDisclosure(getOrgPg().sql, owner));
  if (!(await hasActive(input.ownerId))) return false;
  const record =
    deps.recordStrict ??
    (async (i: RestrictedEditBeforeRelease) => {
      const { recordEditAttributionStrict } = await import('../edit-attribution');
      await recordEditAttributionStrict({
        repoRoot: i.repoRoot,
        files: i.files,
        agentId: i.ownerId,
        intent: i.intent,
        workspaceId: i.workspaceId,
        contributor: i.contributor,
      });
    });
  try {
    await record({ ...input, files });
  } catch (error) {
    throw new DisclosureRefused(
      'disclosure_ledger_unavailable',
      `restricted-edit hold: the edit could not be recorded, so the lock is kept (${(error as Error)?.message ?? error})`,
    );
  }
  return true;
}
