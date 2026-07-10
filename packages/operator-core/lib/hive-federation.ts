/**
 * hive-federation — resolve a harness's swarm binding to the HIVE federation
 * topic when the harness belongs to a SHARED Hive (shared-hive-federation-2026-06-08
 * P-004, D-001/D-003).
 *
 * A shared Hive federates its substrate over ONE topic derived from the Hive's
 * Ed25519 pubkey (`deriveHiveFederationTopic`) — the federation key that REPLACES
 * the per-harness gh/local swarm topic. This is the "re-key, don't rebuild" core
 * (D-003): the transport/peer-log/projection machinery is unchanged; only the
 * topic a Hive's harness joins moves from the harness slug/repo to the Hive id.
 *
 * GATE — a Hive HOME federates on its Hive-pubkey topic so owner-authored Hive
 * state (`hive_settings`, `hive_members`, epoch/key material) drains from the
 * owner's outbox and reaches joiners. A non-home member harness still federates
 * only when its Hive is directory-published (public/invite) or is a joined
 * remote_hive view; private owned members stay local-only.
 *
 * SCOPE — today a Hive == its `kind:'hive'` home harness, so this resolves the
 * home harness onto the Hive topic. Member-harness federation (a Hive's other
 * harnesses draining their work onto the Hive's single peer-log) is the per-Hive
 * handle restructure layered on top of this binding (P-004 increment 2).
 */
import type { SwarmBinding } from './sync/hyperbee/derive-swarm-topic';
import { getHiveBySlug } from './hive-store';
import { getOwnedHiveMeta } from './hive-directory-meta';
import { loadHarnessRegistry } from './harness-registry';

/**
 * The Hive federation `SwarmBinding` for `harnessSlug` if it belongs to a Hive
 * that should join the Hive topic, else `null` (the caller falls back to the
 * gh/local binding). Resolves the harness's home Hive — itself if it is a
 * `kind:'hive'` home, else its declared `hive_slug` (a member harness). The home
 * always joins its own Hive topic so its Hive-grained rows can drain; member
 * harnesses join the same topic only when the Hive is shared or a joined remote
 * view. `harness_slug` stays the within-Hive component scope (D-003: change only
 * the topic key — no peer-log restructure).
 *
 * Pure resolution: PG reads for the Hive identity + a registry read for membership
 * and the share gate; no side effects, no swarm join.
 */
export async function resolveHiveSwarmBinding(
  workspaceId: string,
  harnessSlug: string,
): Promise<SwarmBinding | null> {
  const potHomeSlug = await potHomeSlugForHarness(workspaceId, harnessSlug);
  if (!potHomeSlug) {
    return null; // not part of a Hive
  }

  const hive = await getHiveBySlug(workspaceId, potHomeSlug);
  if (!hive) {
    return null; // Hive identity not resolvable (e.g. un-backfilled)
  }

  // The owner/HOME harness must boot on the Hive topic even before a public
  // listing exists: it owns Hive-grained rows (hive_settings/hive_members), and
  // those rows are captured under `harness_slug = hive_home_slug`. If the home
  // stays local-only, its send-side drain never appends those rows to the shared
  // Hive log, so joiners never receive settings/membership/epoch state.
  if (harnessSlug === potHomeSlug) {
    return { kind: 'hive', hive_pubkey: hive.pubkeyBase64 };
  }

  // Member gate. A JOINED (remote) Hive view federates over the Hive-pubkey topic —
  // that is the whole reason the joiner joined it, and it MUST match the OWNER's
  // re-key so both peers sit on the SAME topic. Before EI-681 the joiner had no
  // `hives` identity row + no owned meta, so it fell through to the gh:<repo_id>
  // topic while the OWNER re-keyed to the Hive-pubkey topic → the two peers sat
  // on DIFFERENT swarm topics and a write never federated. An OWNED Hive only
  // federates when the owner directory-published it public/invite; a private OR
  // un-published (no meta = local-only) owned Hive stays local (zero DHT
  // footprint — no privacy regression).
  const reg = await loadHarnessRegistry(workspaceId);
  const isRemoteJoined = reg.projects.find((p) => p.slug === potHomeSlug)?.remote_hive === true;
  if (!isRemoteJoined) {
    const meta = await getOwnedHiveMeta(potHomeSlug, workspaceId);
    if (!meta || meta.visibility === 'private') {
      return null;
    }
  }

  return { kind: 'hive', hive_pubkey: hive.pubkeyBase64 };
}

/**
 * The home Hive slug for a harness: itself if it is a `kind:'hive'` home (carries
 * an identity row), else its declared `hive_slug` (a member harness), else null
 * (not part of a Hive). Shared by the swarm-binding re-key (P-004) and the
 * per-Hive admission union (P-006 seam) — both answer "which Hive is this harness
 * in". Pure resolution (a PG identity read + a registry read).
 */
export async function potHomeSlugForHarness(
  workspaceId: string,
  harnessSlug: string,
  // WI-1378: forwarded to loadHarnessRegistry so a { fresh:true } resolve bypasses
  // the cross-process-stale registry cache (see joinerPotHomeSlug / boot.ts).
  opts?: { fresh?: boolean },
): Promise<string | null> {
  // Registry FIRST: it answers in EVERY process. The PG identity read used to
  // run first, but the substrate SIDECAR (and in-process test harnesses) may
  // have no org-PG configured — getOrgPg().sql is undefined there and the read
  // THREW (TypeError: reading 'unsafe'), taking down every caller on this path:
  // the owner announce-admit (boot.ts admitAnnouncedPeerAsOwner) and the
  // joiner's home-resolve → rekey/forceReFold (empty-roster live symptom,
  // 2026-07-01, Brief-3 rig).
  const reg = await loadHarnessRegistry(workspaceId, opts);
  const entry = reg.projects.find((x) => x.slug === harnessSlug);
  if (entry?.harness_kind === 'hive') return harnessSlug;
  if (entry?.hive_slug) return entry.hive_slug;
  // Registry didn't answer — the PG identity row is the fallback discriminator
  // for a hive home with no (or a legacy) registry entry. GUARDED: an
  // unconfigured org-PG must mean "no identity row visible here", never a crash.
  try {
    if (await getHiveBySlug(workspaceId, harnessSlug)) return harnessSlug;
  } catch {
    /* no org-PG in this process — the registry above was the best answer */
  }
  return null;
}

/**
 * A-003 (shared-pot-release-testing Brief I): the HIVE-HOME slug a JOINER's
 * member harness must bind its `hive_members` / `hive_settings` projections to,
 * else null (no rebind — today's behavior).
 *
 * Returns the home slug iff this harness's Hive home is a `remote_hive` (joined)
 * VIEW — the joiner topology. In that topology the joiner boots the MEMBER harness
 * (the home view itself is never booted by the join flow, which only re-keys
 * members), so the home-grained `hive_members`/`hive_settings` ops the member's
 * merge reads off the shared Hive topic are dropped by the member-slug projection
 * guard → the member list/settings never reach the joiner, and
 * `loadRevokedHivePubkeys(<home>)` is empty so a revoked member is never refused.
 * Binding those two projections to the home slug (register-all's `potHomeSlug`)
 * lets the running member merge land them.
 *
 * Returns null when the Hive home is OWNED (not a remote view): the owner's home
 * harness owns the write side + applies the rows `origin='local'`, so an
 * owned-hive member must NOT rebind (it would double-apply the owner's own rows as
 * `origin='remote'`). Also null for a non-Hive harness. Uses the SAME
 * `remote_hive` registry signal `resolveHiveSwarmBinding` keys the joiner topic on
 * — so the rebind triggers exactly when the joiner topic does. Pure resolution
 * (a PG identity read + a registry read); fail-open is the caller's job.
 */
export async function joinerPotHomeSlug(
  workspaceId: string,
  harnessSlug: string,
  // WI-1378 (federation roster-empty, no-restart): pass { fresh:true } on the
  // in-place-rekey resolve so the registry read bypasses the operator-state cache.
  // The rekey runs in the substrate SIDECAR process (SUBSTRATE_SIDECAR), a different
  // process from join-hive's registry write, so the writer's same-process cache
  // invalidation never reached here — a warm-stale read returned null → the rekey
  // rebind (and its forceReFold re-fold) never engaged → the member-slug binding
  // latched → the owner's roster rows dropped forever (empty until restart).
  opts?: { fresh?: boolean },
): Promise<string | null> {
  const home = await potHomeSlugForHarness(workspaceId, harnessSlug, opts);
  if (!home) return null;
  const reg = await loadHarnessRegistry(workspaceId, opts);
  const isRemoteJoined = reg.projects.find((p) => p.slug === home)?.remote_hive === true;
  return isRemoteJoined ? home : null;
}

