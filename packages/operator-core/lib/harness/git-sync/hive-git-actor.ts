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
 * only when no in-process swarm identity exists for the pot (harness not booted
 * here, or relocated to a sidecar whose advertisement carries no identity) —
 * on a single-account box the two coincide, which is why this was invisible
 * everywhere but the tower.
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
 * Pure decision: prefer the booted swarm identity; fall back to the gh-login
 * actor (deriving its keychain via `buildKeychainId`); null when neither
 * exists (gh unauthenticated AND no swarm join — no identity to act as).
 */
export function pickHiveGitActor(
  booted: BootedSwarmIdentityLike | null | undefined,
  ghActor: UsageActor | null | undefined,
  buildKeychainId: (githubUserId: number) => string,
): HiveGitActor | null {
  if (booted && booted.devicePubkeyBase64 && booted.keychainId) {
    return {
      githubUserId: booted.githubUserId,
      devicePubkey: booted.devicePubkeyBase64,
      keychainId: booted.keychainId,
      source: 'booted-swarm',
    };
  }
  if (!ghActor?.devicePubkey) return null;
  return {
    githubUserId: ghActor.githubUserId,
    devicePubkey: ghActor.devicePubkey,
    keychainId: buildKeychainId(ghActor.githubUserId),
    source: 'gh-login',
  };
}
