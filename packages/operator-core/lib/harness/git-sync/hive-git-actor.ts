/**
 * hive-git-actor.ts — WHICH device identity a git-sync hive leg signs, announces
 * and dials as.
 *
 * WHY THIS EXISTS (P-203 Leg A, live two-machine rig 2026-09-02): every hive-git
 * leg (own-head publish, bootstrap seed, ref-announce publish+receive, the
 * integrator and worktree-bridge legs) resolved its identity through
 * `resolveUsageActor()` — the gh-CLI login. The swarm plane resolves ITS
 * identity separately: `boot.ts` prefers the durable hive_members+keychain
 * binding so a known member can rejoin during a GitHub outage. On a box that
 * holds keypairs for two accounts those two resolvers disagree — the tower's
 * papercusp harness greeted the swarm as the aviynw device `XPAsvso1` (the
 * owner's, deliberately — see the EN-4 note beside `localAnnounceGithubUserId`
 * in boot.ts) while git-sync signed 4,300+ ref-announces as the papercupai
 * device `IXfGu216`. A peer dials `announcement.device_pubkey` against the
 * socket it filed under the HELLO's device, so every VM→tower fetch reported
 * "no live dial path" for as long as the pair had been up, and the VM's
 * receive cursor pinned behind announcements no peer could ever reach.
 *
 * THE RULE: one process, one pot, one device. The swarm join already decided
 * the identity peers attribute this harness to (`BootedHarnessHandle
 * .announceIdentity`); git-sync FOLLOWS it. The gh-login actor is the fallback
 * only when NOTHING anywhere is serving this pot — on a single-account box the
 * two coincide, which is why this was invisible everywhere but the tower.
 *
 * WHY THE FALLBACK IS NOW GUARDED (WI-2142873, measured 2026-09-02): the first
 * pass of this fix left the fallback unconditional, and that reopened the same
 * defect through a different door. The substrate owner and the routine that
 * runs git-sync are frequently SEPARATE OS PROCESSES, and the boot-all registry
 * is deliberately process-local, so a perfectly healthy harness is invisible to
 * the git-sync process. `booted` came back null there for a reason that says
 * NOTHING about which device serves the pot — and the code read it as "no swarm
 * identity exists", then signed as the gh-login device anyway.
 *
 * Measured consequence on the live two-machine rig: 216 papercusp ref-announces
 * signed as the papercupai device `IXfGu216` while the tower actually served
 * that pot's topic as `XPAsvso1`, alongside 387 correctly-signed ones — the SAME
 * code path resolving differently per process. A peer dials
 * `announcement.device_pubkey`, finds no socket filed under it, and parks. The
 * VM retried one such announcement 48 times over 8.4h; the pot read NOT
 * CONVERGED for 630+ minutes against a convergence bar that was unreachable by
 * construction.
 *
 * So an announcement signed under a device that does not serve the pot's topic
 * is strictly WORSE than no announcement: it is unfetchable, and it pins every
 * peer's convergence check behind it. When the owner tells us it holds a booted
 * handle for this pot but we could not obtain its identity, we therefore REFUSE
 * rather than fall back. The un-booted case keeps the gh fallback, so a genuine
 * single-account box is unaffected.
 */
import type { UsageActor } from '../usage-actor';

/** The identity a hive-git leg acts as, plus where it came from. */
export interface HiveGitActor {
  githubUserId: number;
  /** Raw 32-byte Ed25519 device pubkey, base64 (== binding device_pubkey). */
  devicePubkey: string;
  /** Keychain entry holding the private key for `devicePubkey`. */
  keychainId: string;
  /** `booted-swarm` = the identity this harness's live swarm announce/hello
   *  carries (peers file our socket under it); `gh-login` = the process-wide
   *  gh-CLI actor, used only when no swarm identity is available. */
  source: 'booted-swarm' | 'gh-login';
}

/** The shape `BootedHarnessHandle.announceIdentity` exposes — kept structural
 *  so this decision has no boot-module import and stays a pure unit. */
export interface BootedSwarmIdentityLike {
  devicePubkeyBase64: string;
  githubUserId: number;
  keychainId: string;
}

/**
 * What we know about the pot's substrate BEYOND this process's own registry.
 *
 * Exists to keep one specific inference out of the decision: "the local
 * registry has no handle" is evidence about THIS PROCESS, never about whether
 * something serves the pot. Only the substrate owner can answer that, so its
 * answer is passed in explicitly rather than assumed from a local miss.
 */
export interface HiveGitActorSubstrateEvidence {
  /**
   * Does the substrate owner currently report a booted handle for this pot?
   *
   * `true` — the owner holds one, so a device IS serving this pot's topic and
   * the gh-login actor is provably not it. Refuse rather than sign as it.
   * `false` — the owner reports no handle for this pot; nothing serves it, and
   * the gh fallback is the honest best effort (the pre-existing behaviour).
   * `undefined` — UNKNOWN: no fresh advertisement to read. Deliberately NOT
   * treated as `false`; it preserves the historical fallback rather than
   * turning an unreadable row into a refusal that would silence a healthy
   * single-account box.
   */
  ownerReportsBooted?: boolean | undefined;
  /**
   * The device the owner LAST advertised as serving this pot, even if that
   * advertisement has since gone stale — `undefined` when nothing was ever
   * advertised for it.
   *
   * WHY (WI-2142873 follow-on, measured 2026-09-04): `ownerReportsBooted` is
   * UNKNOWN whenever the advertisement is merely too OLD to trust, and UNKNOWN
   * preserves the gh-login fallback. On a box where one process is BOTH the
   * substrate owner and the git-sync host, its own restart guarantees that
   * window: the previous owner's row ages out (30s) before the new one has
   * booted the harness, so a leg firing in between signed as the gh-login
   * device and minted an announcement no peer can dial — once per restart,
   * which on the live tower re-armed every peer's convergence bar faster than
   * the 500-row announcement window could age it out. P-203 Leg A stayed RED
   * with the identity fix already running, for exactly this reason.
   *
   * A stale claim is weak evidence about whether that device is still UP. It is
   * strong evidence about WHICH device serves the pot, and that is the only
   * question being asked here — so it is enough to refuse on, and never enough
   * to sign on (no identity travels with it).
   */
  lastAdvertisedServingDevicePubkey?: string | undefined;
}

/** Why no actor could be chosen. `refused-owner-booted-identity-unavailable`
 *  is a DELIBERATE refusal, not an absence — the caller should log it and skip
 *  the leg, never treat it as "no identity configured". */
export type HiveGitActorRefusal =
  | 'no-identity'
  | 'refused-owner-booted-identity-unavailable'
  | 'refused-stale-advertisement-names-another-device';

/**
 * Pure decision: prefer the booted swarm identity; fall back to the gh-login
 * actor (deriving its keychain via `buildKeychainId`); null when neither
 * exists (gh unauthenticated AND no swarm join — no identity to act as), or
 * when the owner proves something serves this pot but its identity could not
 * be obtained (see the WI-2142873 note at the top of this file).
 *
 * `booted` is the swarm identity however it was OBTAINED — this process's own
 * boot-all registry, or the substrate owner's cross-process advertisement. Both
 * are the same fact (the identity this harness's swarm hello carries), so both
 * report `source: 'booted-swarm'`; the transport that carried it is a detail
 * for the caller's log, not a different kind of identity.
 */
export function pickHiveGitActor(
  booted: BootedSwarmIdentityLike | null | undefined,
  ghActor: UsageActor | null | undefined,
  buildKeychainId: (githubUserId: number) => string,
  evidence?: HiveGitActorSubstrateEvidence,
): HiveGitActor | null {
  if (booted && booted.devicePubkeyBase64 && booted.keychainId) {
    return {
      githubUserId: booted.githubUserId,
      devicePubkey: booted.devicePubkeyBase64,
      keychainId: booted.keychainId,
      source: 'booted-swarm',
    };
  }
  // The owner holds a booted handle for this pot, so SOMETHING is serving its
  // topic under an identity we failed to read. The gh-login actor is therefore
  // provably not that device (if it were, we would have read it). Signing as it
  // mints an announcement no peer can dial — the WI-2142873 failure.
  if (evidence?.ownerReportsBooted === true) return null;
  if (!ghActor?.devicePubkey) return null;
  // The owner's advertisement is too stale to trust as liveness, but it still
  // NAMES the device that serves this pot, and it is not this one. Signing
  // anyway mints the unfetchable announcement described in the header — so the
  // stale-but-present case refuses, while the never-advertised case (undefined)
  // keeps the fallback and leaves a genuine single-account box untouched.
  if (
    evidence?.lastAdvertisedServingDevicePubkey &&
    evidence.lastAdvertisedServingDevicePubkey !== ghActor.devicePubkey
  ) {
    return null;
  }
  return {
    githubUserId: ghActor.githubUserId,
    devicePubkey: ghActor.devicePubkey,
    keychainId: buildKeychainId(ghActor.githubUserId),
    source: 'gh-login',
  };
}

/**
 * Why `pickHiveGitActor` returned null, for the caller's log. Kept beside the
 * decision so the two cannot drift: a refusal and a plain absence look
 * identical at the call site otherwise, and they call for different operator
 * responses (fix the identity plumbing vs. authenticate gh).
 */
export function explainHiveGitActorAbsence(
  booted: BootedSwarmIdentityLike | null | undefined,
  ghActor: UsageActor | null | undefined,
  evidence?: HiveGitActorSubstrateEvidence,
): HiveGitActorRefusal {
  const haveBooted = Boolean(booted?.devicePubkeyBase64 && booted?.keychainId);
  if (!haveBooted && evidence?.ownerReportsBooted === true) {
    return 'refused-owner-booted-identity-unavailable';
  }
  if (
    !haveBooted &&
    ghActor?.devicePubkey &&
    evidence?.lastAdvertisedServingDevicePubkey &&
    evidence.lastAdvertisedServingDevicePubkey !== ghActor.devicePubkey
  ) {
    return 'refused-stale-advertisement-names-another-device';
  }
  return 'no-identity';
}
