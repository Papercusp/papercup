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
 *   - `substrate.drain` (EI-1618/EI-1599) is the install-wide SYNC-health signal:
 *     how many booted harnesses have content CAPTURED in `substrate_outbox` but not
 *     yet drained to the federation log (the EI-681 silent-stall class). It is an
 *     honest "is my local content reaching the log" measurement, NOT a per-peer /
 *     per-hive "synced to peer X" claim — it only ever reports a STALL, never a
 *     positive "synced" (which the shared swarm has no clean per-hive count to back).
 *   - There is still deliberately NO "synced" / "connected to peer X" field: the
 *     substrate uses a SHARED swarm with no clean per-hive content-peer count (see
 *     findings-M), so claiming it would be the exact dishonesty this surface avoids.
 *
 * `auth: 'loopback'` — same perimeter as /api/discovery/hives: the cookie-less
 * desktop webview over the loopback bind. Read-only; lists nothing private.
 */
import { defineTool } from '@papercusp/agent-mcp';
import { getOrgPg } from '@papercusp/db-org';
import { getHiveDirectory } from '../../../hive-directory-deps';
import { activeWorkspaceId } from '../../../workspace-registry';
import { listOwnedHiveMeta } from '../../../hive-directory-meta';
import { getInProcessSubstrateStatus } from '../../../sync/hyperbee/in-process-status';
import {
  loadSubstrateDrainStats,
  type SubstrateDrainStat,
} from '../../../sync/hyperbee/load-drain-stats';

/**
 * Oldest-undrained age (ms) past which a harness's outbox counts as STALLED in
 * the install-wide drain summary. Mirrors `assessHarnessSubstrateHealth`'s
 * `drainStalledThresholdMs` default (60s) so the summary and the per-harness
 * verdict agree on what "stalled" means, and a few rows briefly undrained
 * between the capture and the next periodic drain tick are NOT flagged.
 */
const DRAIN_STALL_LAG_MS = 60_000;

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

    // EI-1618/EI-1599 — prefetch per-harness substrate-outbox drain stats so the
    // (sync) resolveDrainStats below can flip a stalled-outbox harness off
    // "healthy". Without this a captured-but-not-federating harness (EI-681 class)
    // reads "healthy" — the silent stall this surface exists to expose. Best-effort:
    // a PG failure degrades to zero drain (honest), never throws the read.
    let drainByKey = new Map<string, SubstrateDrainStat>();
    try {
      const { sql } = getOrgPg();
      const runQuery = async <T,>(query: string, params: unknown[]): Promise<T[]> =>
        (await sql.unsafe(query, params as never)) as unknown as T[];
      drainByKey = await loadSubstrateDrainStats({ runQuery });
    } catch {
      /* PG-less → zero drain, honest */
    }

    // Install-wide substrate health (local boot state). substrateActive is constant
    // true at runtime; bootedCount + per-harness verdicts are the real signal. The
    // `drain` rollup is the honest install-wide SYNC-health signal: how many booted
    // harnesses have content captured-but-not-federating (a stall, never a positive
    // "synced" — see the honesty contract above).
    let substrate: {
      active: boolean;
      bootedHarnesses: number;
      healthy: number;
      booting: number;
      degraded: number;
      drain: {
        stalledHarnesses: number;
        worstUndrainedCount: number;
        worstOldestUndrainedAgeMs: number | null;
      };
    } = {
      active: true,
      bootedHarnesses: 0,
      healthy: 0,
      booting: 0,
      degraded: 0,
      drain: { stalledHarnesses: 0, worstUndrainedCount: 0, worstOldestUndrainedAgeMs: null },
    };
    try {
      const status = getInProcessSubstrateStatus({
        // A stalled outbox flips this harness's verdict off 'healthy' AND feeds the
        // drain rollup below.
        resolveDrainStats: (ws, slug) =>
          drainByKey.get(`${ws}::${slug}`) ?? { undrainedCount: 0, oldestUndrainedAgeMs: null },
      });
      let healthy = 0;
      let booting = 0;
      let degraded = 0;
      let stalledHarnesses = 0;
      let worstUndrainedCount = 0;
      let worstOldestUndrainedAgeMs: number | null = null;
      for (const h of status.harnesses) {
        if (h.verdict === 'healthy') healthy += 1;
        else if (h.verdict === 'booting') booting += 1;
        else if (h.verdict === 'degraded' || h.verdict === 'unhealthy') degraded += 1;
        const d = h.drain;
        if (
          d &&
          d.undrainedCount > 0 &&
          d.oldestUndrainedAgeMs != null &&
          d.oldestUndrainedAgeMs >= DRAIN_STALL_LAG_MS
        ) {
          stalledHarnesses += 1;
          if (d.undrainedCount > worstUndrainedCount) worstUndrainedCount = d.undrainedCount;
          if (
            worstOldestUndrainedAgeMs == null ||
            d.oldestUndrainedAgeMs > worstOldestUndrainedAgeMs
          ) {
            worstOldestUndrainedAgeMs = d.oldestUndrainedAgeMs;
          }
        }
      }
      substrate = {
        active: status.substrateActive,
        bootedHarnesses: status.bootedCount,
        healthy,
        booting,
        degraded,
        drain: { stalledHarnesses, worstUndrainedCount, worstOldestUndrainedAgeMs },
      };
    } catch {
      /* keep the conservative default */
    }

    return Response.json({ ok: true, substrate, hives });
  },
});
