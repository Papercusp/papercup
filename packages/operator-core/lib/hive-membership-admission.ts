/**
 * hive-membership-admission — the P-MEMBER orchestration: compose the owner-signed
 * policy (EN-1 getHivePolicy) with the pending-join queue + the trust set to GATE a
 * joiner, and let the owner DECIDE pending requests (Brief EN-3 / P-MEMBER).
 *
 * Three entry points:
 *   - evaluateJoinAdmission  — the JOIN-PATH gate. Reads the policy, runs the pure
 *     decision (hive-membership-policy.evaluateMembershipAdmission), and for an
 *     `approval`-mode joiner records a PENDING request (federates to the owner). The
 *     join flow calls this BEFORE trust-admitting (upsertHiveMember) a joiner.
 *   - approvePendingJoin     — the OWNER approves: trust-admit (upsertHiveMember with
 *     the request's captured devices) + mark the pending row 'approved' (federates the
 *     decision back). This is what flips a pending joiner into the trust set.
 *   - denyPendingJoin        — the OWNER denies: mark 'denied'. The joiner is never
 *     trust-admitted.
 *
 * The owner-decision functions are gated on claimed-owner authority by their CALLERS
 * (the agent-tools / API routes that own the binding-service check), NOT here — this
 * module is the mechanism, the route is the gate (same split as hive-policy-author /
 * the policy-set route).
 *
 * `null`/absent policy ⇒ `open` ⇒ admit, so a Hive with no policy is completely
 * unaffected (today's behavior; EN-1 guarantee #2). All collaborators are injectable
 * seams for hermetic tests; `sql` threads a per-file test schema into the stores.
 */
import type { Sql } from 'postgres';
import { getHivePolicy } from './hive-policy-store';
import type { HivePolicy } from './hive-policy-schema';
import {
  evaluateMembershipAdmission,
  type JoinerIdentity,
} from './hive-membership-policy';
import {
  recordPendingJoin as realRecordPendingJoin,
  getPendingJoin as realGetPendingJoin,
  setPendingJoinDecision as realSetPendingJoinDecision,
  type PendingJoinRecord,
} from './hive-pending-joins-store';
import {
  upsertHiveMember as realUpsertHiveMember,
  type HiveMemberRecord,
} from './hive-membership-store';
import type { DeviceAttestationEntry } from './harness/contributor-row-types';

/** The joiner's identity + the devices to bind on (admission material). */
export interface JoinerInfo extends JoinerIdentity {
  displayName?: string | null;
  avatarUrl?: string | null;
  deviceAttestations?: DeviceAttestationEntry[];
}

export type JoinAdmissionOutcome =
  | { outcome: 'admit' }
  | { outcome: 'pending'; reason: string; pending: PendingJoinRecord }
  | { outcome: 'refuse'; reason: 'banned' | 'not_allowlisted' };

export interface MembershipAdmissionDeps {
  /** Read the current owner-VERIFIED policy. Default: getHivePolicy → .policy. */
  getPolicy?: (workspaceId: string, hiveHomeSlug: string) => Promise<HivePolicy | null>;
  recordPendingJoin?: typeof realRecordPendingJoin;
  getPendingJoin?: typeof realGetPendingJoin;
  setPendingJoinDecision?: typeof realSetPendingJoinDecision;
  upsertHiveMember?: typeof realUpsertHiveMember;
  /** Per-file test schema threaded into the stores. */
  sql?: Sql;
}

async function defaultGetPolicy(
  workspaceId: string,
  hiveHomeSlug: string,
  sql?: Sql,
): Promise<HivePolicy | null> {
  const resolved = await getHivePolicy(workspaceId, hiveHomeSlug, sql);
  return resolved?.policy ?? null;
}

/**
 * The JOIN-PATH gate. Evaluate the owner-signed policy against a prospective joiner:
 *   - admit   → the caller proceeds to trust-admit (upsertHiveMember).
 *   - pending → a pending-join request is RECORDED (federates to the owner); the
 *               caller does NOT trust-admit. The joiner waits for owner approval.
 *   - refuse  → banned or not-allowlisted; the caller aborts the join.
 *
 * Pure-decision delegated to hive-membership-policy; this adds the pending-request
 * side effect. `null` policy ⇒ admit (existing hives unaffected).
 */
export async function evaluateJoinAdmission(
  input: { workspaceId: string; hiveHomeSlug: string; joiner: JoinerInfo },
  deps: MembershipAdmissionDeps = {},
): Promise<JoinAdmissionOutcome> {
  const { workspaceId, hiveHomeSlug, joiner } = input;
  const getPolicy = deps.getPolicy ?? ((ws, home) => defaultGetPolicy(ws, home, deps.sql));
  const recordPending = deps.recordPendingJoin ?? realRecordPendingJoin;

  const policy = await getPolicy(workspaceId, hiveHomeSlug);
  const decision = evaluateMembershipAdmission(policy, {
    githubUserId: joiner.githubUserId,
    githubUsername: joiner.githubUsername,
  });

  if (decision.decision === 'admit') return { outcome: 'admit' };
  if (decision.decision === 'refuse') return { outcome: 'refuse', reason: decision.reason };

  // pending — record the federated request so it reaches the owner queue.
  const pending = await recordPending(
    {
      workspaceId,
      hiveHomeSlug,
      githubUserId: joiner.githubUserId,
      githubUsername: joiner.githubUsername,
      displayName: joiner.displayName ?? null,
      avatarUrl: joiner.avatarUrl ?? null,
      deviceAttestations: joiner.deviceAttestations ?? [],
    },
    deps.sql,
  );
  return { outcome: 'pending', reason: decision.reason, pending };
}

export type DecidePendingResult =
  | { ok: true; status: 'approved'; member: HiveMemberRecord; pending: PendingJoinRecord }
  | { ok: true; status: 'denied'; pending: PendingJoinRecord }
  | { ok: false; code: 'no_pending'; detail?: string };

/**
 * OWNER approves a pending joiner: trust-admit them (upsertHiveMember with the devices
 * captured in the request) THEN mark the request 'approved' (federates the decision
 * back). The owner is the writer, so the new hive_members row + the approved status
 * federate to every peer incl. the joiner — robust even if the joiner is offline.
 *
 * Authority (claimed-owner) is the CALLER's responsibility.
 */
export async function approvePendingJoin(
  input: { workspaceId: string; hiveHomeSlug: string; githubUserId: number; decidedByGithubUserId: number },
  deps: MembershipAdmissionDeps = {},
): Promise<DecidePendingResult> {
  const getPending = deps.getPendingJoin ?? realGetPendingJoin;
  const upsertMember = deps.upsertHiveMember ?? realUpsertHiveMember;
  const setDecision = deps.setPendingJoinDecision ?? realSetPendingJoinDecision;

  const pending = await getPending(input.workspaceId, input.hiveHomeSlug, input.githubUserId, deps.sql);
  if (!pending) return { ok: false, code: 'no_pending' };

  const member = await upsertMember(
    {
      workspaceId: input.workspaceId,
      hiveHomeSlug: input.hiveHomeSlug,
      githubUserId: pending.githubUserId,
      githubUsername: pending.githubUsername,
      displayName: pending.displayName,
      avatarUrl: pending.avatarUrl,
      deviceAttestations: pending.deviceAttestations,
      bindingStatus: 'verified',
    },
    deps.sql,
  );

  const decided = await setDecision(
    input.workspaceId,
    input.hiveHomeSlug,
    input.githubUserId,
    'approved',
    input.decidedByGithubUserId,
    null,
    deps.sql,
  );
  return { ok: true, status: 'approved', member, pending: decided ?? pending };
}

/** OWNER denies a pending joiner: mark 'denied' (federates back). Never trust-admitted. */
export async function denyPendingJoin(
  input: {
    workspaceId: string;
    hiveHomeSlug: string;
    githubUserId: number;
    decidedByGithubUserId: number;
    reason?: string | null;
  },
  deps: MembershipAdmissionDeps = {},
): Promise<DecidePendingResult> {
  const setDecision = deps.setPendingJoinDecision ?? realSetPendingJoinDecision;
  const decided = await setDecision(
    input.workspaceId,
    input.hiveHomeSlug,
    input.githubUserId,
    'denied',
    input.decidedByGithubUserId,
    input.reason ?? null,
    deps.sql,
  );
  if (!decided) return { ok: false, code: 'no_pending' };
  return { ok: true, status: 'denied', pending: decided };
}
