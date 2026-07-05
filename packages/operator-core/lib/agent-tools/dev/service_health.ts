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

export default defineTool({
  name: "dev:service_health",
  description:
    'Probe the dev services now (:3070 operator, :3055 vite, :3350 scout, :8082 code-server, the Tauri desktop via its dev-bridge eval + IPC socket + recent error toasts, AND the papercup-bg-host DBOS ticker via routine fire-freshness) — up/down + status + latency. The "bg-host-ticker" entry is a SEPARATE service from :3070: when it reads down, git-sync + every scheduled routine are FROZEN even though :3070 is up — do NOT dev:restart the operator for that, the bg-host needs reviving. The desktop entry reports present:false when no desktop is running. Use before relying on a service or after a "connection refused".',
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
          }),
        },
      ],
    };
  },
});
