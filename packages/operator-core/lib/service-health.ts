/**
 * service-health — probe the local dev endpoints + detect up/down transitions
 * (plan fleet-coordination-painpoints, Phase 3b). Driven by a DBOS scheduled
 * workflow (periodic-workflows); transitions broadcast to coord. External
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

export async function probeAll(specs: EndpointSpec[] = HEALTH_ENDPOINTS): Promise<ProbeResult[]> {
  // The Tauri desktop has no HTTP endpoint — probe it from its local signals
  // (bridge eval + IPC socket + recent error toasts) alongside the HTTP ones.
  const [http, desktop] = await Promise.all([
    Promise.all(specs.map((s) => probeEndpoint(s))),
    probeDesktop(),
  ]);
  return [...http, desktop];
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
 * (not notify — D-002) on each up/down transition. Driven by a DBOS scheduled
 * workflow. Returns the transitions for logging/tests.
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
