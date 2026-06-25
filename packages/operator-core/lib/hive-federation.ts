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
  const hiveHomeSlug = await hiveHomeSlugForHarness(workspaceId, harnessSlug);
  if (!hiveHomeSlug) {
    return null; // not part of a Hive
  }

  const hive = await getHiveBySlug(workspaceId, hiveHomeSlug);
  if (!hive) {
    return null; // Hive identity not resolvable (e.g. un-backfilled)
  }

  // The owner/HOME harness must boot on the Hive topic even before a public
  // listing exists: it owns Hive-grained rows (hive_settings/hive_members), and
  // those rows are captured under `harness_slug = hive_home_slug`. If the home
  // stays local-only, its send-side drain never appends those rows to the shared
  // Hive log, so joiners never receive settings/membership/epoch state.
  if (harnessSlug === hiveHomeSlug) {
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
  const isRemoteJoined = reg.projects.find((p) => p.slug === hiveHomeSlug)?.remote_hive === true;
  if (!isRemoteJoined) {
    const meta = await getOwnedHiveMeta(hiveHomeSlug, workspaceId);
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
export async function hiveHomeSlugForHarness(
  workspaceId: string,
  harnessSlug: string,
): Promise<string | null> {
  if (await getHiveBySlug(workspaceId, harnessSlug)) return harnessSlug;
  const reg = await loadHarnessRegistry(workspaceId);
  const member = reg.projects.find((x) => x.slug === harnessSlug);
  return member?.hive_slug ?? null;
}

/**
 * A-003 (shared-hive-release-testing Brief I): the HIVE-HOME slug a JOINER's
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
 * Binding those two projections to the home slug (register-all's `hiveHomeSlug`)
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
export async function joinerHiveHomeSlug(
  workspaceId: string,
  harnessSlug: string,
): Promise<string | null> {
  const home = await hiveHomeSlugForHarness(workspaceId, harnessSlug);
  if (!home) return null;
  const reg = await loadHarnessRegistry(workspaceId);
  const isRemoteJoined = reg.projects.find((p) => p.slug === home)?.remote_hive === true;
  return isRemoteJoined ? home : null;
}
