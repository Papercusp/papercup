/**
 * pot-git/integrator-tick.ts — P-203: the RUNTIME DRIVER for the staging
 * integrator (p2p-git-live-activation-2026-07-09 P-203).
 *
 * Every OTHER piece of the integrator already exists as a pure library:
 * `integrator.ts` (G-5 merge-queue), `integration-requests.ts` (G-5c trust
 * gate + ratify queue), `staging-advance.ts` (G-5d signed, epoch-fenced
 * announcement). NONE of it runs on a schedule yet — this module is that
 * missing tick, composed exactly the way `github-bridge-tick.ts` composes its
 * own already-landed legs (D-003: no new scheduler — the caller rides the
 * existing `system:git-sync` tick, mode-gated to `hiveGit.mode != legacy`).
 *
 * ONE TICK:
 *   1. isIntegrator gate (default: `lockAuthorityForHive(potHomeSlug).isSelf`,
 *      D-002) — only the lock-authority lease holder computes + publishes
 *      staging; every other member's tick no-ops here (their worktree-bridge
 *      driver, P-204, follows the announcement instead — never both writing).
 *   2. Read every verified member's current namespace work head.
 *   3. `gateMemberHeadsForIntegration` (G-5c): steer-tier / owner-ratified
 *      heads integrate now; below-steer heads QUEUE for ratification — never
 *      silently merged, never silently dropped.
 *   4. `integrateMemberHeads` (G-5): pure merge-queue integration, publishes
 *      the new staging in the integrator's own namespace.
 *   5. On advance: sign a staging-advance announcement (G-5d). `epoch` is the
 *      caller's current granted lease epoch (never invented here — this
 *      module only STAMPS it); `seq` is the caller-persisted per-epoch
 *      counter, bumped by one on every publish. The caller EMITS the
 *      announcement hive-wide (`events:emit { event:
 *      STAGING_ADVANCE_EVENT_KEY, scope: 'hive' }`) and persists the new
 *      `{ epoch, seq }` watermark — mirroring how the bridge leg persists
 *      `last_admitted` on `routines.metadata`.
 *
 * Never throws — every failure is folded into `errors` and the tick reports
 * `ran: false` rather than wedging the enclosing git-sync tick.
 */
import type { CommsTier } from '../../trust/comms-trust';
import { lockAuthorityForHive, type LockAuthorityDeps } from '../../authority/lock-authority';
import {
  defaultRunGit,
  hiveGitRepoPath,
  readNamespaceRef,
  type RunGit,
} from './storage';
import { WORK_REF, integrateMemberHeads, type IntegrationResult, type MemberHead } from './integrator';
import { gateMemberHeadsForIntegration, type GateableHead } from './integration-requests';
import { signStagingAdvance, type SignedStagingAdvance } from './staging-advance';

export interface IntegratorTickInput {
  potHomeSlug: string;
  workspaceId: string;
  /** The (hive, managed repo) key under the pot-git root — matches
   *  `hiveGitRepoPath` / `BridgeTickInput.repoKey`'s convention. */
  repoKey: string;
  /** The current verified member device set (sigrefs-verified upstream — same
   *  contract `collectMemberHeads` / `gateMemberHeadsForIntegration` assume). */
  memberDevicePubkeysBase64: string[];
  /** THIS device's identity pubkey (base64) — the integrator device when we
   *  hold the lease; the namespace staging publishes under. */
  integratorDevicePubkeyBase64: string;
  /** The current granted lease epoch (G-0 handoff / lock-authority) — stamped
   *  into the announcement, never invented here. */
  epoch: number;
  /** The caller-persisted per-epoch advance counter (0 before the first
   *  publish in this epoch). This tick signs `priorSeq + 1` on advance. */
  priorSeq: number;
  /** Device signer seam (prod: `bytes => signWithDeviceKey(keychainId, bytes)`). */
  sign: (bytes: Buffer) => Promise<Buffer>;
  /** Comms-trust seam (prod: `resolveAuthorCommsTier(...).then(r => r.tier)`). */
  resolveTier: (devicePubkeyBase64: string) => CommsTier | null | Promise<CommsTier | null>;
  resolveAuthorGithubUserId?: (devicePubkeyBase64: string) => number | null | Promise<number | null>;
  nowMs?: number;
  deps?: {
    runGit?: RunGit;
    repoPath?: string;
    /** Am I the integrator lease holder? Default: `lockAuthorityForHive(...).isSelf`. */
    isIntegrator?: () => Promise<boolean>;
    lockAuthorityDeps?: LockAuthorityDeps;
    /** Threaded to `gateMemberHeadsForIntegration` (its own `sql` override). */
    sql?: Parameters<typeof gateMemberHeadsForIntegration>[0]['sql'];
  };
}

export interface IntegratorTickOutcome {
  ran: boolean;
  /** Set when this device is not (currently) the integrator lease holder —
   *  the correct, common no-op outcome on every non-authority member's tick. */
  skipped?: 'not-integrator';
  integration: IntegrationResult | null;
  gated: { integrated: number; queued: number; errors: number } | null;
  /** Set ONLY when staging advanced this tick. The caller MUST emit it
   *  hive-wide and persist `{ epoch, seq: announcement.seq }` as the new
   *  watermark — mirroring `lastAdmitted` in the github-bridge-tick leg. */
  announcement: SignedStagingAdvance | null;
  errors: string[];
}

/** One read per member of its current namespace work head (skips members with
 *  none yet) — the gate-ready `{devicePubkeyBase64, sha}` shape, distinct from
 *  `collectMemberHeads`'s already-hexed `MemberHead[]` (the gate needs the RAW
 *  identity pubkey to resolve trust + re-derives the hex itself on admit). */
async function collectGateableHeads(
  repoPath: string,
  memberDevicePubkeysBase64: string[],
  runGit: RunGit,
): Promise<GateableHead[]> {
  const out: GateableHead[] = [];
  for (const dev of memberDevicePubkeysBase64) {
    const sha = await readNamespaceRef(repoPath, dev, WORK_REF, runGit);
    if (sha) out.push({ devicePubkeyBase64: dev, sha });
  }
  return out;
}

export async function runIntegratorTick(input: IntegratorTickInput): Promise<IntegratorTickOutcome> {
  const errors: string[] = [];
  const runGit = input.deps?.runGit ?? defaultRunGit;
  const repoPath = input.deps?.repoPath ?? hiveGitRepoPath(input.potHomeSlug, input.repoKey);
  const nowMs = input.nowMs ?? Date.now();
  const empty: IntegratorTickOutcome = { ran: false, integration: null, gated: null, announcement: null, errors };

  // 1. Lease gate — only the current authority integrates + publishes.
  const isIntegrator =
    input.deps?.isIntegrator ??
    (async () => (await lockAuthorityForHive(input.potHomeSlug, input.deps?.lockAuthorityDeps)).isSelf);
  let iAmIntegrator: boolean;
  try {
    iAmIntegrator = await isIntegrator();
  } catch (e) {
    errors.push(
      `isIntegrator check failed (skipping this tick — safe: the real authority still runs its own): ${
        e instanceof Error ? e.message : e
      }`,
    );
    return { ...empty, skipped: 'not-integrator' };
  }
  if (!iAmIntegrator) return { ...empty, skipped: 'not-integrator' };

  // 2. Collect every member's current work head (gate-ready shape).
  let heads: GateableHead[];
  try {
    heads = await collectGateableHeads(repoPath, input.memberDevicePubkeysBase64, runGit);
  } catch (e) {
    errors.push(`collecting member work heads failed: ${e instanceof Error ? e.message : e}`);
    return empty;
  }

  // 3. G-5c trust gate: partition into integrate-now vs queued-for-ratification.
  const gated = await gateMemberHeadsForIntegration({
    workspaceId: input.workspaceId,
    potSlug: input.potHomeSlug,
    repoKey: input.repoKey,
    heads,
    resolveTier: input.resolveTier,
    resolveAuthorGithubUserId: input.resolveAuthorGithubUserId,
    sql: input.deps?.sql,
    nowMs,
  });
  errors.push(...gated.errors.map((e) => `gate ${e.devicePubkeyBase64.slice(0, 12)}: ${e.error}`));

  // 4. G-5 integration of the admitted heads only.
  let integration: IntegrationResult;
  try {
    integration = await integrateMemberHeads(
      repoPath,
      input.integratorDevicePubkeyBase64,
      gated.integrate as MemberHead[],
      { runGit },
    );
  } catch (e) {
    errors.push(`integrateMemberHeads failed: ${e instanceof Error ? e.message : e}`);
    return {
      ran: true,
      integration: null,
      gated: { integrated: gated.integrate.length, queued: gated.queued.length, errors: gated.errors.length },
      announcement: null,
      errors,
    };
  }

  // 5. G-5d: sign + return the announcement on advance (caller emits + persists).
  let announcement: SignedStagingAdvance | null = null;
  if (integration.advanced && integration.staging) {
    try {
      announcement = await signStagingAdvance(
        {
          devicePubkeyBase64: input.integratorDevicePubkeyBase64,
          epoch: input.epoch,
          seq: input.priorSeq + 1,
          stagingSha: integration.staging,
          nowMs,
        },
        input.sign,
      );
    } catch (e) {
      errors.push(`signStagingAdvance failed (staging advanced locally but was NOT announced): ${
        e instanceof Error ? e.message : e
      }`);
    }
  }

  return {
    ran: true,
    integration,
    gated: { integrated: gated.integrate.length, queued: gated.queued.length, errors: gated.errors.length },
    announcement,
    errors,
  };
}
