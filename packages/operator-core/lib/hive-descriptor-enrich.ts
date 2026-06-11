/**
 * hive-descriptor-enrich — fresh per-announce enrichment of an owned hive's
 * descriptor (hive-from-repo-hardening-2026-06-11 P-004 / D-004).
 *
 * Before this, hivePubkey / memberRepos / memberLinks were derived only at
 * PUBLISH time (set_hive, boot, from-repo create) and frozen into the
 * registered descriptor — a member added through any other producer
 * (hive:add-member, harness:create { hive }) stayed invisible to the 5-min
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

export interface EnrichDescriptorDeps {
  loadPubkey?: (workspaceId: string, hiveId: string) => Promise<string | null>;
  deriveMemberRepos?: (workspaceId: string, hiveId: string) => Promise<string[]>;
  loadRegistry?: (workspaceId?: string) => Promise<HarnessRegistry>;
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

    const pk = desc.hivePubkey ?? ((await loadPubkey(ws, desc.hiveId).catch(() => null)) || undefined);
    const memberRepos = await deriveMemberRepos(ws, desc.hiveId).catch(() => [] as string[]);

    // Fresh one-click member links over the HIVE federation topic — only when
    // the identity exists (a topic-less link is not joinable).
    let memberLinks = desc.memberLinks;
    if (pk) {
      const { parseGithubUrl } = await import('./harness/clone-github');
      const { formatHarnessLink } = await import('./harness/url-scheme');
      const { deriveHiveFederationTopic, topicAsHex } = await import(
        './sync/hyperbee/derive-swarm-topic'
      );
      const reg = await loadRegistry(ws).catch(() => ({ projects: [] }) as HarnessRegistry);
      const topicHex = topicAsHex(deriveHiveFederationTopic(pk));
      const links: string[] = [];
      for (const m of reg.projects) {
        if (m.slug !== desc.hiveId && m.hive_slug !== desc.hiveId) continue;
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
          }),
        );
      }
      if (links.length) memberLinks = links;
    }

    return {
      ...desc,
      ...(pk ? { hivePubkey: pk } : {}),
      ...(memberRepos.length ? { memberRepos } : {}),
      ...(memberLinks?.length ? { memberLinks } : {}),
    };
  } catch {
    return desc;
  }
}
