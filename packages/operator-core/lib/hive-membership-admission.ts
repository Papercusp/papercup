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
  getHiveMember as realGetHiveMember,
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
  /** Read an existing member row — the ownerAdmitOrPend already-member fast path.
   *  Default: getHiveMember. */
  getHiveMember?: typeof realGetHiveMember;
  /**
   * BUG B self-heal (shared-hive-member-content-federation D-028, layer 3): RE-grant +
   * re-FEDERATE the reconnecting member's epoch keys [0..current]. Called from
   * ownerAdmitOrPend's already_member branch so a member that MISSED the original
   * federated grant (joined-after-grant / forward-only cursor / re-session) gets it
   * re-sent on reconnect. Default: re-grant via reconcileEpochKeysForCurrentMembers
   * with refederate=true + onlyDevices=the member's devices (C-001: revoked excluded).
   * Injectable so the unit tests can assert it fires on reconnect (and only then).
   */
  refederateMemberEpochKeys?: (args: {
    workspaceId: string;
    hiveHomeSlug: string;
    memberDevicePubkeys: readonly string[];
  }) => Promise<void>;
  /** Per-file test schema threaded into the stores. */
  sql?: Sql;
}

/**
 * Default BUG-B reconnect re-grant: re-send the reconnecting member's epoch keys
 * [0..current] with refederate=true so the mig-411 AFTER INSERT OR UPDATE capture
 * re-federates them. Owner-only + flag-gated (the delegate self-gates: loadHivePubkey
 * is null / the flag is off ⇒ no-op), C-001-safe (reconcileEpochKeysForCurrentMembers
 * excludes the revoked union, intersected with onlyDevices). DYNAMIC import avoids the
 * admission ↔ boundary-wiring module cycle (same pattern as upsertHiveMember's grant).
 */
async function defaultRefederateMemberEpochKeys(
  args: { workspaceId: string; hiveHomeSlug: string; memberDevicePubkeys: readonly string[] },
  sql?: Sql,
): Promise<void> {
  const devices = args.memberDevicePubkeys.filter(
    (pk): pk is string => typeof pk === 'string' && pk.length > 0,
  );
  if (devices.length === 0) return;
  const { reconcileEpochKeysForCurrentMembers, isHiveRekeyEnabled } = await import(
    './sync/hyperbee/hive-epoch-boundary-wiring'
  );
  await reconcileEpochKeysForCurrentMembers({
    workspaceId: args.workspaceId,
    hiveHomeSlug: args.hiveHomeSlug,
    enabled: await isHiveRekeyEnabled(),
    refederate: true,
    onlyDevices: devices,
    sql,
  });
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

/**
 * The OWNER-SIDE admit-or-pend decision, applied at the substrate admission seam
 * (boot.ts `drainAdmissionQueue`) when the owner admits a binding-verified peer's
 * announce. This is what WIRES the previously-dead `evaluateJoinAdmission` gate into
 * the live join path (WI-639): before this, the owner UNCONDITIONALLY trust-admitted
 * (`upsertHiveMember`) every verified peer — so `membership:'approval'` did nothing.
 *
 * Precedence:
 *   1. ALREADY a member → refresh the row (re-upsert). This preserves the prior
 *      open-mode reconnect behavior: the upsert idempotently re-grants the member's
 *      epoch keys (shared-hive-rekey). An established member is NEVER re-routed
 *      through the policy gate (approval mode must not "un-admit" an approved member
 *      on reconnect, and must not re-open a pending/decided request for them).
 *   2. NOT yet a member → consult the owner-signed policy via `evaluateJoinAdmission`:
 *        - admit   (open / allowlisted)  → trust-admit (upsertHiveMember).
 *        - pending (approval mode)       → a federated pending-join request is
 *          recorded (by the OWNER here, origin='local' → it reaches the joiner and
 *          shows in the owner's pot:membership_pending queue); the peer is NOT
 *          trust-admitted. The owner later decides via pot:membership_decide.
 *        - refuse  (banned / not-allowlisted) → neither admit nor pending.
 *
 * SECURITY/INVARIANTS: this gates ONLY the membership UPSERT decision. It does NOT
 * touch core admission, the revoked set, the read-cut/epoch decrypt gate, or per-op
 * policy enforcement — those run unchanged at their own seams. With no policy (or
 * `open` mode) the outcome is `admit`, so existing hives are byte-for-byte unaffected.
 * The joiner's CORE is admitted by boot.ts independent of this decision; a pending /
 * refused peer's CONTENT is still gated by the P-002 membership guard + per-op
 * enforcement, so nothing leaks before approval.
 *
 * Authority (this is the owner box, holding the Hive key) is the CALLER's check
 * (boot.ts self-gates on loadHivePubkey), same split as the rest of this module.
 */
export type OwnerAdmitOutcome =
  | { action: 'admitted'; member: HiveMemberRecord; reason: 'already_member' | 'policy_admit' }
  | { action: 'pending'; pending: PendingJoinRecord }
  | { action: 'refuse'; reason: 'banned' | 'not_allowlisted' };

export async function ownerAdmitOrPend(
  input: { workspaceId: string; hiveHomeSlug: string; joiner: JoinerInfo },
  deps: MembershipAdmissionDeps = {},
): Promise<OwnerAdmitOutcome> {
  const { workspaceId, hiveHomeSlug, joiner } = input;
  const getMember = deps.getHiveMember ?? realGetHiveMember;
  const upsertMember = deps.upsertHiveMember ?? realUpsertHiveMember;

  const upsert = (): Promise<HiveMemberRecord> =>
    upsertMember(
      {
        workspaceId,
        hiveHomeSlug,
        githubUserId: joiner.githubUserId,
        githubUsername: joiner.githubUsername,
        displayName: joiner.displayName ?? null,
        avatarUrl: joiner.avatarUrl ?? null,
        deviceAttestations: joiner.deviceAttestations ?? [],
        bindingStatus: 'verified',
      },
      deps.sql,
    );

  // 1 — already a member: refresh (idempotent epoch re-grant on reconnect). Never
  //     re-route an established member through the policy gate.
  const existing = await getMember(workspaceId, hiveHomeSlug, joiner.githubUserId, deps.sql);
  if (existing) {
    const member = await upsert();
    // BUG B self-heal (D-028, layer 3): upsert's own grant is ON CONFLICT DO NOTHING, so a
    // member that MISSED the original federated epoch-key grant (joined-after-grant /
    // forward-only cursor / re-session) is never re-sent it — the owner's gap-check reads its
    // OWN hive_epoch_keys (sees "no gap") and the capture trigger was AFTER INSERT only. On
    // RECONNECT, re-grant [0..current] to THIS member's devices with refederate=true: the row
    // is re-stamped (origin='local', fed_ts/fed_hlc cleared) → the mig-411 AFTER INSERT OR
    // UPDATE capture re-federates → the member's LWW accepts the re-sent key. C-001 preserved
    // (revoked devices excluded). Best-effort: a re-grant hiccup must NOT fail admission.
    try {
      const refederate =
        deps.refederateMemberEpochKeys ?? ((a) => defaultRefederateMemberEpochKeys(a, deps.sql));
      await refederate({
        workspaceId,
        hiveHomeSlug,
        memberDevicePubkeys: (joiner.deviceAttestations ?? [])
          .map((d) => d.device_pubkey)
          .filter((pk): pk is string => typeof pk === 'string' && pk.length > 0),
      });
    } catch {
      /* best-effort — never fail a reconnect admission on an epoch-key re-grant */
    }
    return { action: 'admitted', member, reason: 'already_member' };
  }

  // 2 — not yet a member: the owner-signed policy decides. evaluateJoinAdmission
  //     RECORDS the pending request under approval mode (federates to the joiner).
  const outcome = await evaluateJoinAdmission({ workspaceId, hiveHomeSlug, joiner }, deps);
  if (outcome.outcome === 'admit') {
    return { action: 'admitted', member: await upsert(), reason: 'policy_admit' };
  }
  if (outcome.outcome === 'pending') {
    return { action: 'pending', pending: outcome.pending };
  }
  return { action: 'refuse', reason: outcome.reason };
}

/** The result of the owner's substrate-seam admission of an announced peer (the
 *  testable extraction of boot.ts drainAdmissionQueue's membership step, WI-639). */
export type OwnerAnnounceAdmitResult =
  | { action: 'skip'; reason: 'no_hive_home' | 'not_owner' }
  | { action: 'admitted'; hiveHomeSlug: string; reason: 'already_member' | 'policy_admit' }
  | { action: 'pending'; hiveHomeSlug: string }
  | { action: 'refuse'; hiveHomeSlug: string; reason: 'banned' | 'not_allowlisted' };

export interface AdmitAnnouncedPeerDeps extends MembershipAdmissionDeps {
  /** Resolve a harness slug → its Hive home slug. Default: hive-federation
   *  hiveHomeSlugForHarness (a fresh registry read). */
  hiveHomeSlugForHarness?: (workspaceId: string, harnessSlug: string) => Promise<string | null>;
  /** Truthy iff THIS Swarm holds the Hive private key (the owner box). Default:
   *  identity/hive-keypair loadHivePubkey. */
  loadHivePubkey?: (workspaceId: string, hiveHomeSlug: string) => Promise<unknown>;
  /** The admit-or-pend decision. Default: ownerAdmitOrPend. */
  admit?: typeof ownerAdmitOrPend;
}

/**
 * The OWNER substrate-seam admission of a binding-verified announced peer — the
 * testable extraction of what boot.ts `drainAdmissionQueue` runs when it admits a
 * new peer's core (WI-639). Resolves the Hive home, self-gates to the OWNER box,
 * then routes the membership decision through `ownerAdmitOrPend`.
 *
 * WI-280: hive_members is keyed by the HIVE-HOME slug, but a peer joins via the
 * MEMBER topic, so the booted `harnessSlug` is the MEMBER slug. We resolve the home
 * via `hiveHomeSlugForHarness` (a fresh registry read: member → its hive_slug;
 * hive-home → itself) — NOT a boot-time projection slug, which is undefined on the
 * owner's MEMBER boot and silently skipped registration before. `skip` outcomes:
 * `no_hive_home` (not part of a hive) / `not_owner` (no Hive key on this box — the
 * local upsert is the owner's; federation projects it to the others).
 *
 * Returns the outcome (+ the resolved hiveHomeSlug) so the caller can record the
 * matching boot-event; it performs no boot-history I/O itself.
 */
export async function admitAnnouncedPeerAsOwner(
  input: {
    workspaceId: string;
    harnessSlug: string;
    peer: { githubUserId: number; githubLogin: string; devicePubkey: string; attestationGistId: string };
  },
  deps: AdmitAnnouncedPeerDeps = {},
): Promise<OwnerAnnounceAdmitResult> {
  const resolveHome =
    deps.hiveHomeSlugForHarness ??
    (async (ws: string, slug: string) => (await import('./hive-federation')).hiveHomeSlugForHarness(ws, slug));
  const loadPubkey =
    deps.loadHivePubkey ??
    (async (ws: string, home: string) => (await import('./identity/hive-keypair')).loadHivePubkey(ws, home));
  const admit = deps.admit ?? ownerAdmitOrPend;

  const hiveHomeSlug = await resolveHome(input.workspaceId, input.harnessSlug);
  if (!hiveHomeSlug) return { action: 'skip', reason: 'no_hive_home' };
  if (!(await loadPubkey(input.workspaceId, hiveHomeSlug))) return { action: 'skip', reason: 'not_owner' };

  const outcome = await admit(
    {
      workspaceId: input.workspaceId,
      hiveHomeSlug,
      joiner: {
        githubUserId: input.peer.githubUserId,
        githubUsername: input.peer.githubLogin,
        deviceAttestations: [
          {
            device_pubkey: input.peer.devicePubkey,
            gist_id: input.peer.attestationGistId,
            gist_url: '',
            device_label: input.peer.githubLogin,
            created_at: Date.now(),
            signature_by_device: '',
          },
        ],
      },
    },
    deps,
  );
  if (outcome.action === 'admitted') return { action: 'admitted', hiveHomeSlug, reason: outcome.reason };
  if (outcome.action === 'pending') return { action: 'pending', hiveHomeSlug };
  return { action: 'refuse', hiveHomeSlug, reason: outcome.reason };
}
