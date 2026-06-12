/**
 * GET /api/discovery/hives → { count, rows: DiscoveredHiveRow[] }
 *
 * The HTTP projection of the P2P hive directory for the desktop webview's
 * HiveDirectoryPanel (p2p-hive-directory-2026-06-06 P-007). Mirrors the
 * `discovery:hives` MCP tool (P-005) — same verified, un-muted discovered set —
 * but as a cookie-less loopback GET the panel can fetch directly.
 *
 * `auth: 'loopback'` (auth-tier Wave 1) with an in-handler loopback assertion, exactly like
 * /api/deploy/frames: the desktop webview is cookie-less (the loopback bind is
 * the perimeter), and the discovered set is best-effort gossip (D-002 — listing
 * grants nothing; joining runs the full admission flow).
 */
import { defineTool } from '@papercusp/agent-mcp';
import { getHiveDirectory } from '../../../hive-directory-deps';

export default defineTool({
  method: 'GET',
  path: '/discovery/hives',
  auth: 'loopback',
  async handler(req) {
    // Lazy-wire the directory (fire-and-forget): a box that gh-authenticated
    // after boot starts listening on the directory topic from the first browse,
    // instead of staying dead until restart. Instant no-op when already wired.
    void import('../../../hive-directory-boot')
      .then(({ ensureHiveDirectoryWired }) =>
        import('../../../workspace-registry').then(({ activeWorkspaceId }) =>
          ensureHiveDirectoryWired(activeWorkspaceId()),
        ),
      )
      .catch(() => {});
    const url = new URL(req.url);
    const includeExpired = url.searchParams.get('includeExpired') === 'true';
    const rows = getHiveDirectory()
      .listDiscoveredHives({ includeExpired })
      .filter((h) => h.visibility !== 'private')
      .map((h) => ({
        hiveId: h.hiveId,
        title: h.title,
        description: h.description,
        owner: h.ownerGithubLogin,
        visibility: h.visibility === 'invite' ? 'invite' : 'public',
        memberTopics: h.memberTopics,
        memberLinks: h.memberLinks ?? [],
        memberCount: h.memberTopics.length,
        createdAt: h.createdAt,
        lastSeenMs: h.lastSeenMs,
        // The hive's identity pubkey (raw-32-byte base64) — lets the Comb's
        // ?hive= rollup match its listings (which carry the same encoding in
        // `hive_pubkey`) to this announce for the Join CTA
        // (comb-hive-native-sharing-2026-06-11 P-001).
        hivePubkey: h.hivePubkey ?? null,
      }));
    return Response.json({ count: rows.length, rows });
  },
});
