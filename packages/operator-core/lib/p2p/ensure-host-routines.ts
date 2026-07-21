/**
 * ensure-host-routines — boot-time seeding of THIS host's p2p production
 * routines (WI-5327: "resolve + seed this host's own identity"; closes the
 * seeding gap named in work-intake-action.ts / foreign-supervision-action.ts /
 * sweep-orphaned-foreign-harnesses-action.ts's own module docs, tracked on
 * WI-1937/P-406 and WI-5657/P-407, plan p2p-public-release-remaining-lanes-2026-07-16).
 *
 * HOST IDENTITY — resolved from EXISTING seams only, never fabricated
 * (see WI-5327 for the full trace):
 *   - responderGithubUserId ← resolveLocalGithubIdentity() (identity/
 *     resolve-local-github-identity.ts) — the same resolver
 *     hive-epoch-boot-deps.ts / fleet_registry/launch-on-plan.ts /
 *     delegated-spawn-honor.ts already use in production.
 *   - responderDevicePubkey / executorDevice ← the SAME value:
 *     loadOrGenerateDeviceKeypair(resolveDeviceKeychainId(githubUserId))
 *     .pubkeyBase64 (identity/attest.ts + identity/device-keychain-id.ts) —
 *     confirmed executorDevice IS the device pubkey base64 by cross-reading
 *     foreign-git-sync.ts's `Papercusp-Executor-Device` header and
 *     sync/pot-git/sigrefs.ts's identical use of `executorDevicePubkeyBase64`
 *     as `device_pubkey`.
 *   - sourceRepoPath / rootPath / workspaceRoot / canonicalTree ←
 *     projectDirForSlug(installSlug) (operator-notes.ts, backed by
 *     loadHarnessRegistry()) — the SAME resolver canonical git-sync itself
 *     uses for its own repo root (harness/git-sync/git-sync-action.ts).
 *   - hostRef ← machineFingerprint() (identity/device-keychain-id.ts) — a
 *     stable, pure, per-machine fingerprint (already half of the device
 *     keychain id). Safe to reuse: p2p/resource-allotments.ts is explicitly
 *     host-DIMENSIONLESS (M19, local-only — no host column exists anywhere in
 *     that table), so hostRef is purely an internal metering-ledger partition
 *     key (metering-ledger.ts's spendKey) — read side (host-availability.ts)
 *     and write side just need to agree on ONE stable string; it is never
 *     compared against any owner-typed value. NOT a D-001 trust-chain field
 *     (that's responderGithubUserId/responderDevicePubkey, both above).
 *   - installSlug ← operatorHomeHarnessSlug() (harness/operator-home-harness.ts)
 *     — the established convention for host-wide singleton routines (see
 *     seed-cargo-test-routine.ts's identical use: "self-gates to the
 *     operator-home installSlug").
 *
 * SEEDING ORDER (least to most identity-dependent — a missing field skips
 * only the routine(s) that need it, never fabricates, never throws):
 *   1. ensureSweepOrphanedForeignHarnessesRoutine — no identity needed.
 *   2. ensureP2pForeignSupervisionRoutine (P-407/WI-5657) — needs only
 *      responderGithubUserId/responderDevicePubkey.
 *   3. ensureWorkIntakeRoutine (P-406) — needs the full identity set
 *      including repo paths.
 *
 * Boot wiring posture mirrors git-sync-reconcile.ts's
 * ensureGitSyncRoutinesReconciledOnce EXACTLY (see boot-all.ts's sibling
 * hygiene block): once-per-process module-level guard, best-effort,
 * fire-and-forget — a seeding failure must NEVER affect harness boot.
 * ADD-only via each ensure*Routine's own upsert (existing rows — including a
 * human-edited active/config — are preserved by upsertRoutine's ON CONFLICT
 * update, which only ever refreshes trigger_config/target_role/active).
 */
import type { Sql } from 'postgres';
import { getOrgPg } from '@papercusp/db-org';
import { operatorHomeHarnessSlug } from '../harness/operator-home-harness';
import { projectDirForSlug } from '../operator-notes';
import { resolveLocalGithubIdentity } from '../identity/resolve-local-github-identity';
import { loadOrGenerateDeviceKeypair } from '../identity/attest';
import { resolveDeviceKeychainId, machineFingerprint } from '../identity/device-keychain-id';
import { ensureSweepOrphanedForeignHarnessesRoutine } from '../harness/routines/sweep-orphaned-foreign-harnesses-action';
import { ensureP2pForeignSupervisionRoutine } from '../harness/routines/foreign-supervision-action';
import { ensureWorkIntakeRoutine } from '../harness/routines/work-intake-action';

export interface EnsureP2pHostRoutinesResult {
  workspaceId: string;
  installSlug: string;
  sweepSeeded: boolean;
  supervisionSeeded: boolean;
  workIntakeSeeded: boolean;
  /** Human-readable reasons for anything skipped — NEVER a fabricated value,
   *  always a named, resolvable-later gap (see module doc). */
  skippedReasons: string[];
}

/**
 * Resolve + seed all three p2p host routines for one workspace. Pure
 * orchestration over already-tested resolvers/upserts — every IO edge is the
 * real production seam (see module doc), nothing here invents a value.
 */
export async function ensureP2pHostRoutinesForWorkspace(
  workspaceId: string,
  sql: Sql = getOrgPg().sql,
): Promise<EnsureP2pHostRoutinesResult> {
  const installSlug = operatorHomeHarnessSlug();
  const skippedReasons: string[] = [];
  let sweepSeeded = false;
  let supervisionSeeded = false;
  let workIntakeSeeded = false;

  // 1. No identity needed at all.
  try {
    await ensureSweepOrphanedForeignHarnessesRoutine({ workspaceId, installSlug }, sql);
    sweepSeeded = true;
  } catch (err) {
    skippedReasons.push(
      `sweep-orphaned-foreign-harnesses: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // Identity fields shared by the two identity-requiring routines below.
  const ident = await resolveLocalGithubIdentity().catch(
    () => ({ kind: 'gh_auth_required' as const }),
  );
  if (ident.kind !== 'ok') {
    skippedReasons.push(
      'p2p-foreign-supervision + p2p-work-intake: gh not authenticated (resolveLocalGithubIdentity) — never fabricated, will resolve once `gh auth login` succeeds on this host.',
    );
    return { workspaceId, installSlug, sweepSeeded, supervisionSeeded, workIntakeSeeded, skippedReasons };
  }

  let devicePubkeyBase64: string | null = null;
  try {
    const keychainId = resolveDeviceKeychainId(ident.githubUserId);
    const kp = await loadOrGenerateDeviceKeypair(keychainId);
    devicePubkeyBase64 = kp.pubkeyBase64;
  } catch (err) {
    skippedReasons.push(`device keypair: ${err instanceof Error ? err.message : String(err)}`);
  }

  // 2. p2p-foreign-supervision (P-407/WI-5657) — needs only the two identity fields above.
  try {
    await ensureP2pForeignSupervisionRoutine(
      {
        workspaceId,
        installSlug,
        host: {
          responderGithubUserId: ident.githubUserId,
          responderDevicePubkey: devicePubkeyBase64,
        },
      },
      sql,
    );
    supervisionSeeded = true;
  } catch (err) {
    skippedReasons.push(`p2p-foreign-supervision: ${err instanceof Error ? err.message : String(err)}`);
  }

  // 3. p2p-work-intake (P-406) — needs the full identity set including repo paths.
  const repoRoot = await projectDirForSlug(installSlug);
  if (!repoRoot) {
    skippedReasons.push(
      `p2p-work-intake: no registered project dir for installSlug '${installSlug}' (harness registry miss).`,
    );
  } else if (!devicePubkeyBase64) {
    skippedReasons.push('p2p-work-intake: device pubkey unresolved (see device keypair reason above).');
  } else {
    try {
      await ensureWorkIntakeRoutine(
        {
          workspaceId,
          installSlug,
          host: {
            hostRef: machineFingerprint(),
            responderGithubUserId: ident.githubUserId,
            responderDevicePubkey: devicePubkeyBase64,
            executorDevice: devicePubkeyBase64,
            sourceRepoPath: repoRoot,
            rootPath: repoRoot,
            workspaceRoot: repoRoot,
            canonicalTree: repoRoot,
          },
        },
        sql,
      );
      workIntakeSeeded = true;
    } catch (err) {
      skippedReasons.push(`p2p-work-intake: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return { workspaceId, installSlug, sweepSeeded, supervisionSeeded, workIntakeSeeded, skippedReasons };
}

let seededOnce = false;

/** Test seam: reset the once-guard between test cases. */
export function _resetEnsureP2pHostRoutinesForTests(): void {
  seededOnce = false;
}

/**
 * Once-per-process, best-effort, fire-and-forget boot hook — mirrors
 * ensureGitSyncRoutinesReconciledOnce's posture exactly (boot-all.ts's
 * sibling hygiene block). A seeding failure must NEVER affect harness boot.
 */
export function ensureP2pHostRoutinesSeededOnce(workspaceIds: string[]): void {
  if (seededOnce) return;
  seededOnce = true;
  void (async () => {
    for (const workspaceId of workspaceIds) {
      try {
        const result = await ensureP2pHostRoutinesForWorkspace(workspaceId);
        if (result.skippedReasons.length) {
          console.log(
            `[p2p-host-routines] ${workspaceId}: partial seed (sweep=${result.sweepSeeded} supervision=${result.supervisionSeeded} workIntake=${result.workIntakeSeeded}) — ${result.skippedReasons.join('; ')}`,
          );
        } else {
          console.log(
            `[p2p-host-routines] ${workspaceId}: seeded sweep+supervision+work-intake for installSlug '${result.installSlug}'.`,
          );
        }
      } catch (err) {
        console.log(
          `[p2p-host-routines] ${workspaceId}: seed failed — ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  })();
}
