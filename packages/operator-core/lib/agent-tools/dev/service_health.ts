/**
 * dev:service_health — probe the dev endpoints right now (fleet-coordination-
 * painpoints Phase 3b, P-018 status surface). Up/down + latency per service.
 * The DBOS service-health workflow additionally broadcasts a coord message on
 * each up/down transition; this tool is the on-demand snapshot.
 */

import { z } from "zod";
import { defineTool } from "@papercusp/agent-mcp";
import { probeAll } from "../../service-health";
import { getTelemetryHealth } from "../../projected-tool-deps";
import { supervisionSnapshot, type SupervisionStatusEntry, type SupervisionFlapState } from "../../supervision/unit-reconciler";
import { substrateSidecarSupervisionStatus, type SidecarSupervisionStatus } from "../../sync/hyperbee/substrate-sidecar-spawn";
import { spawnerSidecarSupervisionStatus } from "../../fleet/spawner-sidecar-spawn";

function sidecarFlapState(s: SidecarSupervisionStatus): SupervisionFlapState {
  return s.gaveUp ? "gave-up" : s.respawnAttemptsInWindow > 0 ? "damping" : "ok";
}

/**
 * P-006 (critical-process-supervisor-2026-07-04): overlay the two node-child
 * sidecars' OWN respawn-with-backoff state (owned by their respective spawn
 * modules, not the systemd-user reconciler) onto `supervisionSnapshot()`'s
 * registry-shaped entries. PURE (both status reads are sync/in-memory) — every
 * OTHER entry (systemd-user, desktop-shell) passes through untouched.
 */
export function overlayNodeChildSupervision(
  entries: SupervisionStatusEntry[],
  substrate: SidecarSupervisionStatus,
  spawner: SidecarSupervisionStatus,
): SupervisionStatusEntry[] {
  return entries.map((entry) => {
    const status = entry.name === "substrate-sidecar" ? substrate : entry.name === "spawner-sidecar" ? spawner : null;
    if (!status) return entry;
    return {
      ...entry,
      consecutiveProbeFailures: status.running ? 0 : entry.consecutiveProbeFailures,
      lastRestartAt: status.lastRespawnScheduledAt,
      restartsLast10m: status.respawnAttemptsInWindow,
      flapState: sidecarFlapState(status),
    };
  });
}

export default defineTool({
  name: "dev:service_health",
  description:
    'Probe the dev services now (:3070 operator, :3055 vite, :3350 scout, the Tauri desktop via its dev-bridge eval + IPC socket + recent error toasts, AND the papercup-bg-host DBOS ticker via routine fire-freshness) — up/down + status + latency, PLUS a `supervision` block per critical-process-supervisor entry (layer/autoRestart/consecutiveProbeFailures/restartsLast10m/flapState) sourced from the failed-unit reconciler. The "bg-host-ticker" entry is a SEPARATE service from :3070: when it reads down, git-sync + every scheduled routine are FROZEN even though :3070 is up — do NOT dev:restart the operator for that, the bg-host needs reviving. The desktop entry reports present:false when no desktop is running. Use before relying on a service or after a "connection refused".',
  guidance: {
    when: 'Confirm which dev services are up before testing against one; diagnose a "connection refused" / stale-server symptom; OR diagnose a git-sync / routine-engine stall — the "bg-host-ticker" entry tells you whether the SEPARATE bg-host routine engine is frozen (so you do not misattribute it to :3070).',
    notWhen:
      "File/lock contention — that is locks:queue. Migration drift — db:check_drift.",
    seeAlso: [
      "dev:restart (restart a down service)",
      "dev:pg_health (Postgres health specifically)",
      "dev:build_status (build / smoke status)",
    ],
  },
  capability: "intel:read",
  requirePrincipal: false,
  agentRoles: [
    "scoper",
    "architect",
    "worker",
    "validator",
    "reviewer",
    "debugger",
    "operator",
    "documenter",
    "curator",
    "cup",
  ],
  args: z.object({}),
  async handler() {
    const services = await probeAll();
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({
            ok: true,
            services,
            telemetry: getTelemetryHealth(),
            // P-004/P-006 (critical-process-supervisor-2026-07-04): additive block, existing
            // fields above are UNCHANGED — the systemd-user layer is sourced from the P-002
            // reconciler's own flap state, the node-child sidecars from THEIR OWN respawn
            // modules (P-006) — no second probe pass, everything here is sync/in-memory.
            supervision: overlayNodeChildSupervision(
              supervisionSnapshot(),
              substrateSidecarSupervisionStatus(),
              spawnerSidecarSupervisionStatus(),
            ),
          }),
        },
      ],
    };
  },
});
