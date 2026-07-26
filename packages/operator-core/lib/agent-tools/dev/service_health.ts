/**
 * dev:service_health — probe the dev endpoints right now (fleet-coordination-
 * painpoints Phase 3b, P-018 status surface). Up/down + latency per service.
 * The DBOS service-health workflow additionally broadcasts a coord message on
 * each up/down transition; this tool is the on-demand snapshot.
 */

import { z } from "zod";
import { defineTool } from "@papercusp/agent-mcp";
import { probeAll, supervisedProcesses, type ProbeResult } from "../../service-health";
import { getTelemetryHealth } from "../../projected-tool-deps";
import { supervisionSnapshot, type SupervisionStatusEntry, type SupervisionFlapState } from "../../supervision/unit-reconciler";
import { substrateSidecarSupervisionStatus, type SidecarSupervisionStatus } from "../../sync/hyperbee/substrate-sidecar-spawn";
import { spawnerSidecarSupervisionStatus } from "../../fleet/spawner-sidecar-spawn";
import { runtimeDiagnostic, type RuntimeDiagnostic } from "../../runtime-diagnostic";
import { probeServiceStart, type ServiceStartInfo } from "./systemd-service-probe";

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

/**
 * EI-13221: how recently a systemd-user unit's MainPID came up, before this
 * probe was seen as "down for real". A unit like `staging-api` (:3170) can be
 * cycled by automation the reconciler's own flap-count never observes — the
 * papercup-staging-sync.timer restarts it independently (~every 5min, whenever
 * `staging` has advanced) via a raw `systemctl --user restart`, outside the
 * HEALTH_ENDPOINTS HTTP-probe rotation this file drives, so `flapState` stays
 * 'ok' throughout even though the unit hard-cycles (SIGKILL, ~10-13s down)
 * every few minutes. A caller who hits a connection-refused against :3170 and
 * then reaches for `dev:service_health` deserves a real answer, not a blind
 * spot — so surface it directly from the OS (`probeServiceStart`, the same
 * ground-truth primitive `dev:restart`'s coalesce check already trusts),
 * independent of the reconciler's own bookkeeping.
 */
export const RECENT_RESTART_WINDOW_SEC = 20;

export type SupervisionStatusEntryWithRecency = SupervisionStatusEntry & {
  /** Seconds since the unit's current MainPID started (systemd ground truth).
   *  Omitted when not a systemd-user unit, or the probe couldn't determine it. */
  secondsSinceStart?: number;
  /** Present only when secondsSinceStart < RECENT_RESTART_WINDOW_SEC — a plain-
   *  English pointer so "connection refused right now" reads as "known restart
   *  window, retry" instead of "the service is down / under load". */
  recentRestartNote?: string;
  /**
   * EI-18700974567040702: ground-truth liveness for a systemd-user unit, read
   * directly from `probeServiceStart`'s `ActiveState` — a DETERMINATE answer,
   * not a flap/churn signal. `true` = systemd reports `active`; `false` =
   * systemd reports it is NOT active (inactive/failed/activating/…, the unit
   * is genuinely DOWN right now, or not yet fully up); omitted = not a
   * systemd-user unit, OR the probe itself could not determine an answer
   * (non-linux, no systemd, transient exec error) — an honest "unknown" that
   * must never be conflated with `false`. Deliberately keyed on `ActiveState`
   * rather than `MainPID`: a `.timer` unit has NO MainPID concept at all (it
   * runs no process itself), so a MainPID-only signal falsely read a healthy,
   * `active`/`waiting` timer as down. `ActiveState` is reported for every
   * systemd unit TYPE, so it is the one signal that generalizes. Previously
   * "down" and "probe failed" were BYTE-IDENTICAL in this payload (both just
   * left the entry untouched), so a caller could not tell one from the other
   * — this field is the fix.
   */
  active?: boolean;
};

/**
 * Overlay live systemd restart-recency onto supervision entries (EI-13221).
 * Additive + best-effort: a probe failure (no systemd, unit never started,
 * non-linux) leaves the entry untouched — this must never turn a healthy
 * snapshot into a failure. `probeFn` is injectable for tests.
 */
export async function overlaySystemdRestartRecency(
  entries: SupervisionStatusEntry[],
  probeFn: (unit: string) => Promise<ServiceStartInfo> = probeServiceStart,
  // Injectable for tests; defaults to the real registry. `SupervisionStatusEntry`
  // (the snapshot shape) drops `unit` — only the source `SupervisionEntry`
  // registry carries it — so we look it up by name rather than widening the
  // reconciler's own snapshot type.
  registry: { name: string; unit?: string }[] = supervisedProcesses(),
): Promise<SupervisionStatusEntryWithRecency[]> {
  const unitByName = new Map(registry.map((r) => [r.name, r.unit]));
  return Promise.all(
    entries.map(async (entry) => {
      const unit = entry.layer === "systemd-user" ? unitByName.get(entry.name) : undefined;
      if (!unit) return entry;
      const info = await probeFn(unit).catch(() => ({ ok: false }) as ServiceStartInfo);
      if (!info.ok) return entry; // probe genuinely couldn't determine an answer — honest "unknown", untouched
      // EI-18700974567040702: `ActiveState` is a DETERMINATE liveness answer from systemd
      // itself, not a probe failure — it must not be dropped alongside the `!info.ok` case
      // above (that was the bug: a stopped unit and a failed probe were byte-identical).
      // `undefined` here means even ActiveState couldn't be read (a probe edge case) — leave
      // the entry untouched rather than guess. Keyed on ActiveState, NOT MainPID, because a
      // `.timer` unit has no MainPID concept at all — see the field's own doc comment above.
      if (info.activeState === undefined) return entry;
      const active = info.activeState === "active";
      if (!active || info.secondsSinceStart === undefined) return { ...entry, active };
      const withRecency: SupervisionStatusEntryWithRecency = {
        ...entry,
        active,
        secondsSinceStart: info.secondsSinceStart,
      };
      if (info.secondsSinceStart < RECENT_RESTART_WINDOW_SEC) {
        withRecency.recentRestartNote =
          `${entry.name} restarted ${info.secondsSinceStart}s ago — a connection-refused seen ` +
          `in roughly that window is most likely this restart cycling the listener (e.g. ` +
          `papercup-staging-sync's auto-track for staging-api), not an outage or load signal. Retry.`;
      }
      return withRecency;
    }),
  );
}

type ServiceRootCause = { component: string; reason: string };

function nextVerbForService(name: string): string {
  if (name.includes("bg-host")) return 'dev:restart { target:"bg-host" }';
  if (name === "operator") return 'dev:restart { target:"dev" }';
  if (name === "staging-api") return 'dev:restart { target:"staging" }';
  if (name.includes("gateway")) return 'dev:restart { target:"gateway" }';
  if (name.includes("embed")) return 'dev:restart { target:"embed-sidecar" }';
  return "dev:processes";
}

/** Additive stable scan path over the existing service/supervision payload. */
export function buildServiceHealthDiagnostic(
  services: ProbeResult[],
  supervision: SupervisionStatusEntry[],
): RuntimeDiagnostic<
  { services: string[]; supervised: string[] },
  { up: number; down: number; absent: number; supervisionUnhealthy: number },
  { checked: number; failures: ProbeResult[]; unhealthySupervision: SupervisionStatusEntry[] },
  ServiceRootCause
> {
  const absent = services.filter((s) => s.present === false);
  const failures = services.filter((s) => s.present !== false && !s.up);
  const unhealthySupervision = supervision.filter((s) => s.flapState !== "ok");
  const first = failures[0];
  const supervisor = unhealthySupervision[0];
  const rootCause: ServiceRootCause | null = first
    ? { component: first.name, reason: first.note ?? `probe failed (status ${first.status ?? "none"})` }
    : supervisor
      ? { component: supervisor.name, reason: `supervisor state ${supervisor.flapState}` }
      : null;
  return runtimeDiagnostic({
    configured: {
      services: services.map((s) => s.name),
      supervised: supervision.map((s) => s.name),
    },
    effective: {
      up: services.length - absent.length - failures.length,
      down: failures.length,
      absent: absent.length,
      supervisionUnhealthy: unhealthySupervision.length,
    },
    evidence: { checked: services.length, failures, unhealthySupervision },
    rootCause,
    nextVerb: rootCause ? nextVerbForService(rootCause.component) : null,
  });
}

export default defineTool({
  name: "dev:service_health",
  description:
    'Probe dev services now (:3070, :3055, :3350, Tauri desktop, bg-host ticker) and return the standard runtime fields { configured, effective, evidence, rootCause, nextVerb } alongside per-service latency/status/URL and supervisor flap state. Each HTTP-probed entry in `services` carries the exact `url` it hit (e.g. operator → http://127.0.0.1:3070/...) — read that instead of guessing a port. The "bg-host-ticker" is separate from :3070; if it is down, nextVerb points at the bg-host restart rather than the operator. An intentionally absent desktop is absent, not failed. `supervision[].active` (systemd-user entries only) is a determinate up/down read: `false` means the unit is confirmed DOWN, omitted means the probe genuinely could not tell — never treat a missing `active` as "down". First read for connection-refused, process-running-with-no-window, or "which port is the operator on" symptoms.',
  guidance: {
    when: 'Confirm which dev services are up before testing against one; find the canonical local URL/port for the operator or vite instead of guessing; diagnose a "connection refused" / stale-server symptom; OR diagnose a git-sync / routine-engine stall — the "bg-host-ticker" entry tells you whether the SEPARATE bg-host routine engine is frozen (so you do not misattribute it to :3070).',
    notWhen:
      "File/lock contention — that is locks:queue. Migration drift — db:check_drift.",
    returns: "{ configured, effective, evidence, rootCause, nextVerb, services, telemetry, supervision }",
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
    const supervision = await overlaySystemdRestartRecency(
      overlayNodeChildSupervision(
        supervisionSnapshot(),
        substrateSidecarSupervisionStatus(),
        spawnerSidecarSupervisionStatus(),
      ),
    );
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
            supervision,
            ...buildServiceHealthDiagnostic(services, supervision),
          }),
        },
      ],
    };
  },
});
