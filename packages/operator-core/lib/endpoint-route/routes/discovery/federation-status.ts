/**
 * GET /api/discovery/federation-status → { ok, substrate, hives }
 *
 * Brief M / G-004 — the desktop's first LIVE federation status read. Before this
 * the desktop had member counts (registry), "N/M set up" (local hasState), and a
 * declared-visibility badge, but NO surface for "is my hive reaching peers / is my
 * substrate live" — so a user who published to 0 peers (the G-001 stranded-publish
 * case) or whose substrate is degraded had no corrective in-app signal (findings-G
 * G-004: a gap, not a lie). This read closes the gap with the signals that are
 * HONEST and available today; the UI (HiveFederationStatus) labels each precisely.
 *
 * HONESTY CONTRACT (the brief's whole point is "the UI never lies"):
 *   - `hives[].reachablePeers` is `reachablePeersForHive` — peers on THIS hive's
 *     ANNOUNCE/discovery topic (who could find + join it), NOT content-replication
 *     peers. Owned + non-private only; the directory `owned` map is registry-hydrated
 *     at boot (ensureHiveDirectoryWired → listOwnedHiveMeta), so it is accurate once
 *     wired. A private hive never announces → 0 by construction (UI shows "private").
 *   - `substrate` is the install-wide local boot health (getInProcessSubstrateStatus),
 *     i.e. "is my federation infrastructure up", NOT a per-peer sync claim.
 *   - There is deliberately NO "synced" / "connected to peer X" field: the substrate
 *     uses a SHARED swarm with no clean per-hive content-peer count (see findings-M),
 *     so claiming it would be the exact dishonesty this surface exists to avoid.
 *
 * `auth: 'loopback'` — same perimeter as /api/discovery/hives: the cookie-less
 * desktop webview over the loopback bind. Read-only; lists nothing private.
 */
import { defineTool } from '@papercusp/agent-mcp';
import { getHiveDirectory } from '../../../hive-directory-deps';
import { activeWorkspaceId } from '../../../workspace-registry';
import { listOwnedHiveMeta } from '../../../hive-directory-meta';
import { getInProcessSubstrateStatus } from '../../../sync/hyperbee/in-process-status';

interface OwnedHiveStatusRow {
  hiveId: string;
  title: string;
  visibility: 'public' | 'invite' | 'private';
  /** Member harness count (display signal). */
  memberCount: number;
  /** Peers on this hive's announce topic (discovery reach). 0 for private/unwired. */
  reachablePeers: number;
}

export default defineTool({
  method: 'GET',
  path: '/discovery/federation-status',
  auth: 'loopback',
  async handler() {
    const workspaceId = activeWorkspaceId();

    // Wire the directory so reachablePeersForHive reflects the owned hives'
    // announce topics. Idempotent + instant once wired; awaited (not fire-and-
    // forget like /discovery/hives) so the FIRST read already has accurate reach
    // instead of a transient 0. Best-effort — a wire failure degrades to reach 0,
    // never throws the read.
    try {
      const { ensureHiveDirectoryWired } = await import('../../../hive-directory-boot');
      await ensureHiveDirectoryWired(workspaceId);
    } catch {
      /* unwired → reach reports 0 honestly; the UI polls + converges */
    }

    const dir = getHiveDirectory();
    let hives: OwnedHiveStatusRow[] = [];
    try {
      const owned = await listOwnedHiveMeta(workspaceId);
      hives = owned.map((h) => ({
        hiveId: h.hiveId,
        title: h.title,
        visibility: h.visibility,
        memberCount: h.memberTopics.length,
        // reachablePeersForHive: 0 for a private hive (never announced) or one not
        // yet registered in the directory — honest, not a hidden failure.
        reachablePeers: h.visibility === 'private' ? 0 : dir.reachablePeersForHive(h.hiveId),
      }));
    } catch {
      hives = [];
    }

    // Install-wide substrate health (local boot state). substrateActive is constant
    // true at runtime; bootedCount + per-harness verdicts are the real signal.
    let substrate = { active: true, bootedHarnesses: 0, healthy: 0, booting: 0, degraded: 0 };
    try {
      const status = getInProcessSubstrateStatus();
      let healthy = 0;
      let booting = 0;
      let degraded = 0;
      for (const h of status.harnesses) {
        if (h.verdict === 'healthy') healthy += 1;
        else if (h.verdict === 'booting') booting += 1;
        else if (h.verdict === 'degraded' || h.verdict === 'unhealthy') degraded += 1;
      }
      substrate = {
        active: status.substrateActive,
        bootedHarnesses: status.bootedCount,
        healthy,
        booting,
        degraded,
      };
    } catch {
      /* keep the conservative default */
    }

    return Response.json({ ok: true, substrate, hives });
  },
});
