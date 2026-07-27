/**
 * hive-descriptor-enrich — fresh per-announce enrichment of an owned hive's
 * descriptor (hive-from-repo-hardening-2026-06-11 P-004 / D-004).
 *
 * Before this, hivePubkey / memberRepos / memberLinks were derived only at
 * PUBLISH time (set_hive, boot, from-repo create) and frozen into the
 * registered descriptor — a member added through any other producer
 * (pot:add-member, harness:create { hive }) stayed invisible to the 5-min
 * reannounce until the next boot. This module is the announce-BUILD-time
 * enricher the directory calls via its injected `enrichDescriptor` seam, so
 * EVERY announce (timer, fresh-pair snapshot, explicit) reflects the registry
 * as of NOW.
 *
 * Best-effort by contract: any failure returns the descriptor unchanged (the
 * pre-P-004 behavior). Requires `desc.workspaceId` (stamped by the publish
 * call-sites) — without it there is nothing to derive against.
 */

import type { LocalHiveDescriptor } from './hive-directory';
import type { HarnessRegistry } from './harness-registry';
import type { HiveStatusBeacon } from './hive-beacon';

export interface EnrichDescriptorDeps {
  loadPubkey?: (workspaceId: string, potId: string) => Promise<string | null>;
  deriveMemberRepos?: (workspaceId: string, potId: string) => Promise<string[]>;
  loadRegistry?: (workspaceId?: string) => Promise<HarnessRegistry>;
  /**
   * Build the consent-gated status beacon for this hive (P-005 / brief B-06).
   * Returns undefined when the owner has not consented (no beacon on the wire).
   * Default: hive-beacon-publish.maybeBuildHiveBeacon (consent-gated + memoized).
   */
  buildBeacon?: (workspaceId: string, potId: string) => Promise<HiveStatusBeacon | undefined>;
}

export async function enrichLocalHiveDescriptor(
  desc: LocalHiveDescriptor,
  deps: EnrichDescriptorDeps = {},
): Promise<LocalHiveDescriptor> {
  if (!desc.workspaceId) return desc;
  const ws = desc.workspaceId;
  try {
    const loadPubkey =
      deps.loadPubkey ??
      (async (w: string, id: string) =>
        (await import('./identity/hive-keypair')).loadHivePubkey(w, id).catch(() => null));
    const deriveMemberRepos =
      deps.deriveMemberRepos ??
      (async (w: string, id: string) =>
        (await import('./hive-member-repos')).deriveHiveMemberRepoRefs(w, id));
    const loadRegistry =
      deps.loadRegistry ??
      (async (w?: string) => (await import('./harness-registry')).loadHarnessRegistry(w));
    const buildBeacon =
      deps.buildBeacon ??
      (async (w: string, id: string) =>
        (await import('./hive-beacon-publish')).maybeBuildHiveBeacon(w, id));

    const pk = desc.hivePubkey ?? ((await loadPubkey(ws, desc.potId).catch(() => null)) || undefined);
    const memberRepos = await deriveMemberRepos(ws, desc.potId).catch(() => [] as string[]);
    // P-005 (brief B-06): the consent-gated status beacon — undefined when the
    // owner has not opted in, so no beacon rides the announce. Best-effort.
    const beacon = await buildBeacon(ws, desc.potId).catch(() => undefined);

    // Fresh one-click member links over the HIVE federation topic — only when
    // the identity exists (a topic-less link is not joinable).
    let memberLinks = desc.memberLinks;
    if (pk) {
      const { parseGithubUrl } = await import('./harness/clone-github');
      const { formatHarnessLink } = await import('./harness/url-scheme');
      // A3 (EI-18788176839043286): publish the repoKey each member's store is
      // ACTUALLY named on this device, so a joiner adopts it instead of deriving
      // its own and silently landing on a different one.
      const { canonicalRepoKey } = await import('./sync/pot-git/repo-identity');
      const { deriveHiveFederationTopic, topicAsHex } = await import(
        './sync/hyperbee/derive-swarm-topic'
      );
      const reg = await loadRegistry(ws).catch(() => ({ projects: [] }) as HarnessRegistry);
      const topicHex = topicAsHex(deriveHiveFederationTopic(pk));
      const links: string[] = [];
      for (const m of reg.projects) {
        if (m.slug !== desc.potId && m.hive_slug !== desc.potId) continue;
        if (!m.github_remote || typeof m.github_repository_id !== 'number') continue;
        const parsed = parseGithubUrl(m.github_remote);
        if (!parsed) continue;
        links.push(
          formatHarnessLink({
            topic: topicHex,
            github: `${parsed.owner}/${parsed.repo}`,
            repoOwner: parsed.owner,
            repoName: parsed.repo,
            repoId: m.github_repository_id,
            repoKey: canonicalRepoKey(m),
          }),
        );
      }
      if (links.length) memberLinks = links;
    }

    // A3 (EI-18788176839043286): announce the repoKey the POT HOME's own bare
    // store is named here. The member links above can only be adopted by a peer
    // that already shares the upstream coords they are keyed on — and the home
    // entry is precisely the one that often has none (ensure-papercusp-hive
    // mints it upstream-less), so without this it can correlate against nothing
    // and derives its own key forever. Needs no correlator: a peer whose local
    // pot home matches this announce's potId adopts it directly.
    let homeRepoKey = desc.homeRepoKey;
    try {
      const { canonicalRepoKey } = await import('./sync/pot-git/repo-identity');
      const reg = await loadRegistry(ws);
      const home = reg.projects.find((p) => p.slug === desc.potId);
      if (home) homeRepoKey = canonicalRepoKey(home);
    } catch {
      /* registry unreadable — announce as registered, never fail the build */
    }

    return {
      ...desc,
      ...(pk ? { hivePubkey: pk } : {}),
      ...(memberRepos.length ? { memberRepos } : {}),
      ...(memberLinks?.length ? { memberLinks } : {}),
      ...(homeRepoKey ? { homeRepoKey } : {}),
      ...(beacon ? { beacon } : {}),
    };
  } catch {
    return desc;
  }
}
