/**
 * service-health — probe the local dev endpoints + detect up/down transitions
 * (plan fleet-coordination-painpoints, Phase 3b). Driven by the lightweight
 * in-process periodic scheduler; transitions broadcast to coord. External
 * liveness has no event source, so the probe is the one irreducible poll
 * (D-006) — but transition-only, never a per-tick firehose.
 *
 * `diffHealth` is pure (unit-tested); `probeAll` does the I/O.
 */

import { sendMessage } from './agent-tools/coordination/messages';
import type { AgentIdentity } from './agent-tools/coordination/identity';
import { probeDesktop } from './desktop-health';

export interface EndpointSpec {
  name: string;
  url: string;
}

/**
 * The dev services worth watching (operator/vite/scout/code-server; the Tauri
 * desktop is probed separately in `probeAll`).
 *
 * NB: two RETIRED surfaces are deliberately NOT monitored. Neither runs in this
 * deployment, so probing them produced a perpetual phantom "DOWN" signal that
 * the improvement watchdog re-captured every cycle AND re-broadcast on every
 * operator restart/deploy — a chronic false-alarm that trains agents/owner to
 * ignore service-health reds:
 *   - the standalone web app on :3001 (the retired "old Restart web app" — see
 *     `_retired/papercup`, "doesn't exist in this container") — removed per EI-188.
 *   - the Restart shop storefront on :4321 — not part of the running stack;
 *     removed per EI-276 (it fed the EI-187 CRITICAL "shop is down", re-announced
 *     on every boot). Verified down-because-absent, not a regression.
 * Don't re-add a retired surface here.
 */
export const HEALTH_ENDPOINTS: EndpointSpec[] = [
  { name: 'operator', url: 'http://127.0.0.1:3070/api/desktop/version' }, // 200 + build-info SHA (P-011)
  { name: 'vite', url: 'http://127.0.0.1:3055/' },
  { name: 'scout', url: 'http://127.0.0.1:3350/' },
  { name: 'code-server', url: 'http://127.0.0.1:8082/' },
];

export interface ProbeResult {
  name: string;
  up: boolean;
  status: number | null;
  latencyMs: number;
  /**
   * For services that may legitimately be ABSENT (the desktop — see
   * desktop-health.ts): false means "not running, don't alert". `diffHealth`
   * skips a result with `present === false`. HTTP endpoints leave it undefined
   * (always treated as present).
   */
  present?: boolean;
  /** Human-readable detail (which signal failed, recent error toasts, …). */
  note?: string;
  /** Desktop only: count of recent ERROR toasts (toastLog signal). */
  recentErrors?: number;
}

export async function probeEndpoint(spec: EndpointSpec, timeoutMs = 3000): Promise<ProbeResult> {
  const start = Date.now();
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(spec.url, { method: 'GET', signal: ctl.signal });
    // < 500 = "up" (a 401/404 still means the server is answering); 5xx = down.
    return { name: spec.name, up: res.status < 500, status: res.status, latencyMs: Date.now() - start };
  } catch {
    return { name: spec.name, up: false, status: null, latencyMs: Date.now() - start };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * EI-1832: liveness of the papercup-bg-host DBOS TICKER — a SEPARATE service from
 * the :3070 operator. The ticker drives git-sync + every scheduled routine; when it
 * freezes (event-loop starvation), :3070 stays up while the whole commit/deploy
 * pipeline silently halts. On 2026-06-20 that froze the fleet ~48m, and the only
 * agent-visible signal (dev:service_health → ":3070 up") MISLED the diagnosis toward
 * a wrong `dev:restart` of the operator. The signal: the ticker fires routines, so the
 * NEWEST `last_fired_at` across active routines IS the last-tick age — if nothing has
 * fired in this window, the ticker is frozen. Generous so a normally-firing fleet
 * (git-sync alone fires every few minutes) never false-alarms, while a real freeze
 * (tens of minutes) trips it. Isolates "ticker frozen (ALL routines stop)" from "one
 * routine stuck" — the latter is git-pipeline-stats / the green-stall-watchdog.
 */
export const BG_HOST_STALE_MS = 15 * 60_000;

function toMs(v: Date | string | number | null | undefined): number | null {
  if (v == null) return null;
  if (v instanceof Date) return v.getTime();
  const t = typeof v === 'number' ? v : new Date(v).getTime();
  return Number.isFinite(t) ? t : null;
}

/**
 * Pure verdict for the bg-host ticker, from the newest routine `last_fired_at`
 * (ms, or null = no routine has fired) + `now`. Unit-tested like `diffHealth`.
 * `lastFiredMs == null` ⇒ liveness UNKNOWN (present:false, never alarm a fresh/idle
 * install). A fresh tick ⇒ up; an age past `staleAfterMs` ⇒ down with a note that
 * names the bg-host (NOT :3070) so the reader doesn't restart the wrong service.
 */
export function evaluateBgHostTicker(
  lastFiredMs: number | null,
  now: number,
  staleAfterMs: number = BG_HOST_STALE_MS,
): ProbeResult {
  const name = 'bg-host-ticker';
  if (lastFiredMs == null) {
    return { name, up: true, status: null, latencyMs: 0, present: false, note: 'no routine has fired — ticker liveness unknown' };
  }
  const ageMs = Math.max(0, now - lastFiredMs);
  const up = ageMs <= staleAfterMs;
  const ageMin = Math.round(ageMs / 60_000);
  const ageSec = Math.round(ageMs / 1000);
  return {
    name,
    up,
    status: null,
    latencyMs: 0,
    note: up
      ? `last routine tick ${ageSec}s ago — papercup-bg-host DBOS ticker alive`
      : `⚠ no routine has fired in ${ageMin}m — the SEPARATE papercup-bg-host DBOS ticker ` +
        `(git-sync + every scheduled routine) looks FROZEN. This is NOT the :3070 operator; ` +
        `do NOT dev:restart the operator. Revive the bg-host ticker (service-restart lane).`,
  };
}

/** Probe the bg-host ticker via the newest active-routine `last_fired_at`. Fail-soft:
 *  a PG/read failure → liveness UNKNOWN (present:false), never a fabricated DOWN. */
export async function probeBgHostTicker(now: number = Date.now()): Promise<ProbeResult> {
  const start = Date.now();
  try {
    const { getOrgPg } = await import('@papercusp/db-org');
    const { sql } = getOrgPg();
    // No install_slug filter — the ticker drives EVERY install's routines, so the
    // fleet-wide newest fire is the ticker heartbeat (and it stays robust while the
    // papercup→papercusp slug rename is in flight).
    const rows = await sql<{ last: Date | string | null }[]>`
      SELECT MAX(last_fired_at) AS last
        FROM harness_shared.routines
       WHERE active = true AND last_fired_at IS NOT NULL`;
    return { ...evaluateBgHostTicker(toMs(rows[0]?.last), now), latencyMs: Date.now() - start };
  } catch {
    return { name: 'bg-host-ticker', up: true, status: null, latencyMs: Date.now() - start, present: false, note: 'ticker liveness unknown (routines read failed)' };
  }
}

/**
 * WI-899 (A): liveness of the SUBSTRATE_SIDECAR process — a SEPARATE process from
 * :3070 that owns the federation engine (Corestore + own-log + merge/projection loop
 * + swarm/admission) when the flag is ON. Before this, `sidecar:healthz` was called
 * exactly once at boot (substrate-boot-wrapper.ts) and NEVER polled again — a sidecar
 * that died post-boot kept reading "healthy" everywhere (getInProcessSubstrateStatus
 * hardcoded `handlePresent: true` over the still-cached boot-time proxies), which is
 * exactly the class of silent failure this whole federation-observability plan chases.
 *
 * Fail-soft + flag-aware: SUBSTRATE_SIDECAR OFF (the default) ⇒ `present: false`
 * (nothing to probe, never a phantom DOWN — mirrors `probeBgHostTicker`'s unknown-is-
 * silent contract). ON + the healthz RPC succeeds within `timeoutMs` ⇒ up. ON + the
 * RPC throws/times out ⇒ DOWN with a note naming the sidecar specifically (so the
 * reader doesn't restart :3070 instead, the same pitfall `evaluateBgHostTicker`'s note
 * guards against).
 */
export async function probeSubstrateSidecar(timeoutMs = 5000): Promise<ProbeResult> {
  const name = 'substrate-sidecar';
  const start = Date.now();
  let sidecarOn = false;
  try {
    const { getFlag } = await import('@papercusp/flags/server');
    const { FLAGS } = await import('@papercusp/flags');
    sidecarOn = await getFlag(FLAGS.SUBSTRATE_SIDECAR, 'system');
  } catch {
    // Flag-read failure: liveness unknown, never fabricate a verdict either way.
    return { name, up: true, status: null, latencyMs: Date.now() - start, present: false, note: 'sidecar liveness unknown (flag read failed)' };
  }
  if (!sidecarOn) {
    return { name, up: true, status: null, latencyMs: Date.now() - start, present: false, note: 'SUBSTRATE_SIDECAR flag off — no sidecar to probe' };
  }
  try {
    const { getSubstrateIpcClient } = await import('./sync/hyperbee/substrate-ipc-client');
    const client = getSubstrateIpcClient();
    await Promise.race([
      client.call('sidecar:healthz'),
      new Promise((_resolve, reject) => setTimeout(() => reject(new Error('healthz probe timeout')), timeoutMs)),
    ]);
    return { name, up: true, status: null, latencyMs: Date.now() - start, note: 'sidecar:healthz OK' };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      name,
      up: false,
      status: null,
      latencyMs: Date.now() - start,
      note: `⚠ substrate sidecar DOWN (healthz: ${msg}) — the SEPARATE process that owns federation ` +
        `replication (Corestore/merge/swarm) for this install. Boot-time handle proxies stay cached in ` +
        `the main process regardless, so federation-status/boot-health can still read "booted" for a ` +
        `dead sidecar — this probe is the actual liveness signal. Respawn the sidecar (or dev:restart if ` +
        `it won't respawn), not :3070.`,
    };
  }
}

export async function probeAll(specs: EndpointSpec[] = HEALTH_ENDPOINTS): Promise<ProbeResult[]> {
  // The Tauri desktop has no HTTP endpoint — probe it from its local signals
  // (bridge eval + IPC socket + recent error toasts) alongside the HTTP ones; the
  // bg-host DBOS ticker has no port either — probe it from routine fire-freshness (EI-1832);
  // the substrate sidecar (WI-899) is a third portless process, probed via its own IPC RPC.
  const [http, desktop, bgHostTicker, substrateSidecar] = await Promise.all([
    Promise.all(specs.map((s) => probeEndpoint(s))),
    probeDesktop(),
    probeBgHostTicker(),
    probeSubstrateSidecar(),
  ]);
  return [...http, desktop, bgHostTicker, substrateSidecar];
}

export interface HealthTransition {
  name: string;
  to: 'up' | 'down';
}

/**
 * Pure transition detector: compare the latest probe to the last-known
 * up/down per endpoint. Returns only ENDPOINTS THAT CHANGED (transition-only
 * — never the full set), plus the next state map to persist. A name absent
 * from `prev` is treated as previously-up (so a first-seen DOWN alerts, a
 * first-seen UP is silent — no startup spam).
 */
export function diffHealth(
  prev: Record<string, boolean>,
  now: ProbeResult[],
): { transitions: HealthTransition[]; next: Record<string, boolean> } {
  const transitions: HealthTransition[] = [];
  const next: Record<string, boolean> = { ...prev };
  for (const r of now) {
    if (r.present === false) {
      // A legitimately-absent service (e.g. the desktop is not running): forget
      // it — don't alert a phantom DOWN, and don't fire a false "recovered" when
      // it comes back (it'll be a silent first-seen-up instead).
      delete next[r.name];
      continue;
    }
    const was = prev[r.name] ?? true; // unknown → assume up (only alert on a real drop)
    if (was !== r.up) {
      transitions.push({ name: r.name, to: r.up ? 'up' : 'down' });
    }
    next[r.name] = r.up;
  }
  return { transitions, next };
}

// Cross-tick last-known state. A module singleton (not PG): on operator
// restart it resets, and diffHealth's unknown-as-up default means a restart
// re-alerts only services that are actually DOWN — no spurious spam.
let lastHealth: Record<string, boolean> = {};

const HEALTH_IDENTITY: AgentIdentity = {
  ownerId: 'service-health',
  ownerLabel: 'service-health',
  source: 'static-client',
  workspaceId: null,
  userId: null,
};

/** Last probe results (for the on-demand status tool / UI). */
let lastResults: ProbeResult[] = [];
/**
 * When `lastResults` was last populated (epoch ms), or null if never probed this
 * process. The watchdog's service-down collector reads this to skip a STALE
 * snapshot — if the probe workflow has stopped, the module singleton would
 * otherwise feed the watchdog phantom up/down data (watchdog-robustness P-004).
 */
let lastResultsAt: number | null = null;
export function lastServiceHealth(): ProbeResult[] {
  return lastResults;
}
/** Epoch-ms timestamp of the last probe, or null if never probed (P-004). */
export function lastServiceHealthAt(): number | null {
  return lastResultsAt;
}

/**
 * One service-health tick: probe all endpoints, broadcast a coord MESSAGE
 * (not notify — D-002) on each up/down transition. Driven by the in-process
 * periodic scheduler. Returns the transitions for logging/tests.
 */
export async function runServiceHealthTick(): Promise<{ checked: number; transitions: HealthTransition[] }> {
  const results = await probeAll();
  lastResults = results;
  lastResultsAt = Date.now();
  const { transitions, next } = diffHealth(lastHealth, results);
  lastHealth = next;
  for (const t of transitions) {
    const r = results.find((x) => x.name === t.name);
    const downDetail = r?.note
      ? ` — ${r.note}`
      : r?.status
        ? ` (HTTP ${r.status})`
        : ' (no response)';
    const summary =
      t.to === 'down'
        ? `⚠ service "${t.name}" is DOWN${downDetail}`
        : `✅ service "${t.name}" recovered`;
    await sendMessage(HEALTH_IDENTITY, { to: ['*'], summary, category: 'service-health' }).catch(() => {});
  }
  return { checked: results.length, transitions };
}

/** Test-only — reset the cross-tick state. */
export function _resetServiceHealthState(): void {
  lastHealth = {};
  lastResults = [];
  lastResultsAt = null;
}
