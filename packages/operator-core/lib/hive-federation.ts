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
 * GATE — only a SHARED Hive federates. "Shared" = the owner published the Hive to
 * the directory as `public`/`invite` (the existing owner-driven share-intent
 * signal, p2p-hive-directory). A `private`/un-published Hive stays local-only and
 * NEVER announces on the public DHT — so re-keying is a zero-risk, dormant-path
 * change for today's local-only hives (no privacy regression). [Decision: the
 * federation gate reuses directory visibility rather than minting a separate
 * `federate` flag; the axes can be split later if a Hive ever wants to be
 * directory-private but substrate-shared.]
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
 * The Hive federation `SwarmBinding` for `harnessSlug` if it belongs to a SHARED
 * Hive, else `null` (the caller falls back to the gh/local binding). Resolves the
 * harness's home Hive — itself if it is a `kind:'hive'` home, else its declared
 * `hive_slug` (a member harness) — then federates over that Hive's pubkey topic
 * iff the Hive is owner-published (public/invite). Both the home and every member
 * of a shared Hive join the SAME Hive topic; `harness_slug` stays the within-Hive
 * component scope (D-003: change only the topic key — no peer-log restructure).
 *
 * Pure resolution: PG reads for the Hive identity + a registry read for membership
 * and the share gate; no side effects, no swarm join.
 */
export async function resolveHiveSwarmBinding(
  workspaceId: string,
  harnessSlug: string,
): Promise<SwarmBinding | null> {
  const hiveHomeSlug = await hiveHomeSlugForHarness(workspaceId, harnessSlug);
  if (!hiveHomeSlug) return null; // not part of a Hive

  const hive = await getHiveBySlug(workspaceId, hiveHomeSlug);
  if (!hive) return null; // Hive identity not resolvable (e.g. un-backfilled)

  // Gate: keep an OWNER's private/un-published Hive local-only (zero DHT
  // footprint). But a JOINED (remote) Hive has NO owned meta on this peer — the
  // joiner federates over it precisely because they joined it. Previously the
  // `!meta` arm wrongly returned null for every joiner, so the OWNER re-keyed to
  // the Hive-pubkey topic while the JOINER fell through to the gh:<repo_id>
  // topic → the two peers sat on DIFFERENT swarm topics and never merged
  // (EI-681). Only block when WE own it AND it is private.
  const meta = await getOwnedHiveMeta(hiveHomeSlug, workspaceId);
  if (meta && meta.visibility === 'private') return null;

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
