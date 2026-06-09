/**
 * discovery:hives — the operator endpoint serving the discovered P2P hive list
 * (p2p-hive-directory-2026-06-06 P-005).
 *
 * The read projection of the hive directory: it returns the verified, un-muted
 * hives this peer has seen announced on the directory topic (HiveDirectory.
 * listDiscoveredHives) for the browse-and-join UIs — the pui apiary-pane (P-006)
 * and the desktop HiveDirectoryPanel (P-007, `discovery:hives`). Each entry is a
 * best-effort gossip listing (D-002): the join CTA runs the full admission flow,
 * the listing grants nothing.
 *
 * Read-only; reuses the live directory service unchanged (no replicated log).
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { getHiveDirectory } from '../../hive-directory-deps';

export interface DiscoveredHiveRow {
  hiveId: string;
  title: string;
  description: string;
  owner: string;
  visibility: 'public' | 'invite';
  /**
   * The Hive's Ed25519 identity pubkey (raw-32-byte base64) — the cross-Hive DIAL
   * ADDRESS. Pass it to `hive:cross_grant { peerHivePubkey }` to admit this Hive.
   * Empty string when the announce carried no identity (not cross-Hive-addressable).
   */
  hivePubkey: string;
  /** Member harness topics (hex) — the display signal. */
  memberTopics: string[];
  /** Full join links per member harness (one-click join), when the hive carries them. */
  memberLinks: string[];
  /** Number of member harnesses a join would run join-shared-harness for. */
  memberCount: number;
  createdAt: number;
  lastSeenMs: number;
}

export default defineTool({
  name: 'discovery:hives',
  description:
    'Browse the P2P hive directory — the verified hives this peer has seen announced on the well-known directory topic (title · description · owner · member harnesses). Best-effort gossip: joining a listed hive still runs the full admission/attestation flow. Feeds the pui apiary-pane + the desktop HiveDirectoryPanel.',
  capability: 'discovery:read',
  guidance: {
    when: 'You want to see hives available to join across the P2P network (the browse list behind the apiary pane / HiveDirectoryPanel).',
    notWhen:
      'To list the workspace-local deployed hive frames (hiveControlFrames) use the harness/hive surfaces. To actually join a listed hive, run the join-shared-harness flow per member topic.',
  },
  requirePrincipal: false,
  args: z.object({
    /** Include hives whose last announce is past the freshness TTL (default false). */
    includeExpired: z.boolean().optional(),
    /** Max rows (default 200). */
    limit: z.number().int().positive().max(500).optional(),
  }),
  async handler(args) {
    const dir = getHiveDirectory();
    const hives = dir
      .listDiscoveredHives({ includeExpired: args.includeExpired })
      .filter((h) => h.visibility !== 'private');
    const rows: DiscoveredHiveRow[] = hives.slice(0, args.limit ?? 200).map((h) => ({
      hiveId: h.hiveId,
      title: h.title,
      description: h.description,
      owner: h.ownerGithubLogin,
      visibility: h.visibility === 'invite' ? 'invite' : 'public',
      hivePubkey: h.hivePubkey ?? '',
      memberTopics: h.memberTopics,
      memberLinks: h.memberLinks ?? [],
      memberCount: h.memberTopics.length,
      createdAt: h.createdAt,
      lastSeenMs: h.lastSeenMs,
    }));
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({ ok: true, count: rows.length, rows }),
        },
      ],
    };
  },
});
