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
import { emitServiceHealthTransitionEvent } from './service-health-events';

export interface EndpointSpec {
  name: string;
  url: string;
  /** Per-endpoint probe timeout override (default 3000ms — see {@link probeEndpoint}). */
  timeoutMs?: number;
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
  // EI-6902: vite's dev-server request handler can legitimately take 4-6s+ to answer
  // under this box's typical concurrent build/vitest load (confirmed live: a plain
  // GET / took 5.4s to resolve while otherwise healthy) — the shared 3000ms default
  // was firing a persistent false "vite DOWN" alarm (aged 2 days, escalated to
  // critical) purely from probe impatience, not an actual outage. A generous
  // per-endpoint override here fixes the false positive without loosening the
  // timeout for the other (consistently fast, <100ms) endpoints.
  { name: 'vite', url: 'http://127.0.0.1:3055/', timeoutMs: 10_000 },
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

export async function probeEndpoint(spec: EndpointSpec, timeoutMs = spec.timeoutMs ?? 3000): Promise<ProbeResult> {
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

/**
 * WI-1867: the routine hot paths — code that changes ROUTINE BEHAVIOR and therefore
 * only takes effect on the bg-host after a `papercup-bg-host.service` restart. When
 * the newest commit touching one of these is YOUNGER than the bg-host process, the
 * routines primary is running STALE code: every loop fire / scheduled routine / wake
 * emit behaves as-of its boot, however green the tree. This is exactly how the
 * 2026-07-03 cold-auto bug hid — flag ON, code landed 08:46, bg-host up since 07:37,
 * so every cold loop fire went out payload-less (warm) with zero error anywhere.
 */
export const BG_HOST_HOT_PATHS = [
  'packages/operator-core/lib/dbos',
  'packages/operator-core/lib/harness/routines',
  'packages/operator-core/lib/events',
  'packages/operator-core/lib/agent-tools/loop',
] as const;

/**
 * Pure verdict for bg-host CODE DRIFT (WI-1867), from the bg-host process start (ms)
 * + the newest hot-path ON-DISK CHANGE (ms; the bg-host tsx-loads the WORKING TREE at
 * import, so file mtime — not commit time — is the honest "what code would a restart
 * load" signal). Unknown inputs ⇒ present:false (fail-soft, never a fabricated
 * verdict). Drift is reported `up:true` — the service WORKS, it just behaves as-of an
 * older snapshot — so it never fires a down-transition alarm or nudges an auto-restart
 * (EI-2186: a bg-host restart reclaims in-flight spawns; the restart is a HUMAN/agent
 * decision, this is the loud signal that it's due).
 */
export function evaluateBgHostCodeDrift(
  bootMs: number | null,
  hotChangeMs: number | null,
  newestFile?: string | null,
): ProbeResult {
  const name = 'bg-host-code';
  if (bootMs == null || hotChangeMs == null) {
    return { name, up: true, status: null, latencyMs: 0, present: false, note: 'bg-host code-drift unknown (boot time or hot-path change time unreadable)' };
  }
  const drifted = hotChangeMs > bootMs;
  if (!drifted) {
    return { name, up: true, status: null, latencyMs: 0, note: 'bg-host code current (no routine hot-path change on disk since its boot)' };
  }
  const behindMin = Math.max(1, Math.round((hotChangeMs - bootMs) / 60_000));
  const which = newestFile ? ` (newest: ${newestFile})` : '';
  return {
    name,
    up: true,
    status: null,
    latencyMs: 0,
    note:
      `⚠ bg-host CODE DRIFT: routine hot-path code changed on disk${which} ~${behindMin}m AFTER papercup-bg-host booted — ` +
      `loop fires / scheduled routines / wake emits are running STALE code until ` +
      `\`systemctl --user restart papercup-bg-host.service\`. If you just landed routine-behavior code and it ` +
      `"doesn't take effect", this is why (see agent-insights/bg-host-runs-stale-routine-code).`,
  };
}

/** Probe bg-host code drift (WI-1867): unit MainPID elapsed-seconds vs the newest
 *  *.ts mtime under BG_HOST_HOT_PATHS in the integration tree (the working tree the
 *  bg-host tsx-loads from — mtime, not commit time, is what a restart would pick up).
 *  Fail-soft at every step (no systemd / no unit / no tree ⇒ present:false, never a
 *  phantom drift). */
export async function probeBgHostCodeDrift(now: number = Date.now()): Promise<ProbeResult> {
  const start = Date.now();
  try {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const run = promisify(execFile);
    // Boot time: MainPID → ps etimes (elapsed seconds). Robust across locales/TZ
    // (systemd's ActiveEnterTimestamp is a locale/TZ-formatted string).
    const unit = process.env.PAPERCUSP_BGHOST_WATCHDOG_UNIT || 'papercup-bg-host';
    const { stdout: pidOut } = await run('systemctl', ['--user', 'show', '-p', 'MainPID', '--value', `${unit}.service`], { timeout: 3000 });
    const pid = Number(pidOut.trim());
    if (!Number.isFinite(pid) || pid <= 0) {
      return { ...evaluateBgHostCodeDrift(null, null), latencyMs: Date.now() - start };
    }
    const { stdout: etimesOut } = await run('ps', ['-o', 'etimes=', '-p', String(pid)], { timeout: 3000 });
    const etimes = Number(etimesOut.trim());
    const bootMs = Number.isFinite(etimes) && etimes >= 0 ? now - etimes * 1000 : null;
    // Newest hot-path *.ts mtime in the integration tree (the tree the bg-host runs from).
    let integrationRoot = process.env.PAPERCUSP_INTEGRATION_ROOT ?? '';
    if (!integrationRoot) {
      const { stdout } = await run('git', ['rev-parse', '--show-toplevel'], { timeout: 3000 });
      integrationRoot = stdout.trim();
    }
    const { stdout: findOut } = await run(
      'find',
      [...BG_HOST_HOT_PATHS, '-name', '*.ts', '-not', '-name', '*.test.ts', '-printf', '%T@ %p\n'],
      { timeout: 5000, cwd: integrationRoot, maxBuffer: 4 * 1024 * 1024 },
    );
    let hotChangeMs: number | null = null;
    let newestFile: string | null = null;
    for (const line of findOut.split('\n')) {
      const sp = line.indexOf(' ');
      if (sp <= 0) continue;
      const t = Number(line.slice(0, sp)) * 1000;
      if (Number.isFinite(t) && (hotChangeMs == null || t > hotChangeMs)) {
        hotChangeMs = t;
        newestFile = line.slice(sp + 1);
      }
    }
    return { ...evaluateBgHostCodeDrift(bootMs, hotChangeMs, newestFile), latencyMs: Date.now() - start };
  } catch {
    return { name: 'bg-host-code', up: true, status: null, latencyMs: Date.now() - start, present: false, note: 'bg-host code-drift unknown (probe failed)' };
  }
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
  // WI-895 discrimination (2026-07-03): this probe can only see a sidecar spawned by
  // THIS process family — the client dials PAPERCUSP_SUBSTRATE_IPC_SOCKET when set,
  // else /tmp/papercusp-substrate-<own pid>.sock. Flag ON with NO socket at that
  // path is NOT an outage: no sidecar was spawned here (lazy substrate not yet
  // booted, in-process fallback, or the install's sidecar belongs to ANOTHER host,
  // e.g. the bg-host owns it while dev-api runs this probe). Before this check that
  // state read as a phantom "sidecar DOWN (Connection timeout)" — it burned ~40min
  // of fleet incident-response on 2026-07-03 against a perfectly healthy sidecar.
  let sockPath = '';
  try {
    const { resolveSubstrateSocketPath } = await import('./sync/hyperbee/substrate-socket-path');
    sockPath = resolveSubstrateSocketPath();
    const { existsSync } = await import('node:fs');
    if (!existsSync(sockPath)) {
      return {
        name,
        up: true,
        status: null,
        latencyMs: Date.now() - start,
        present: false,
        note: `no sidecar spawned by this process — flag ON but no socket at ${sockPath} ` +
          `(lazy substrate not yet booted, in-process mode, or the sidecar spawner is another ` +
          `host e.g. bg-host). NOT a liveness verdict on the install's sidecar.`,
      };
    }
  } catch {
    // Path-resolution failure: fall through to the RPC probe — never fabricate a verdict.
  }
  try {
    const { getSubstrateIpcClient } = await import('./sync/hyperbee/substrate-ipc-client');
    const client = getSubstrateIpcClient();
    await Promise.race([
      client.call('sidecar:healthz'),
      new Promise((_resolve, reject) => setTimeout(() => reject(new Error('healthz probe timeout')), timeoutMs)),
    ]);
    return { name, up: true, status: null, latencyMs: Date.now() - start, note: `sidecar:healthz OK (${sockPath})` };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      name,
      up: false,
      status: null,
      latencyMs: Date.now() - start,
      note: `⚠ substrate sidecar DOWN (healthz to ${sockPath || 'unresolved socket'}: ${msg}) — the SEPARATE process that owns federation ` +
        `replication (Corestore/merge/swarm) for this install. Boot-time handle proxies stay cached in ` +
        `the main process regardless, so federation-status/boot-health can still read "booted" for a ` +
        `dead sidecar — this probe is the actual liveness signal. The socket EXISTS but healthz failed: ` +
        `a real sidecar fault (spawn-side auto-respawn should recover it; dev:restart if not), not :3070.`,
    };
  }
}

export async function probeAll(specs: EndpointSpec[] = HEALTH_ENDPOINTS): Promise<ProbeResult[]> {
  // The Tauri desktop has no HTTP endpoint — probe it from its local signals
  // (bridge eval + IPC socket + recent error toasts) alongside the HTTP ones; the
  // bg-host DBOS ticker has no port either — probe it from routine fire-freshness (EI-1832);
  // the substrate sidecar (WI-899) is a third portless process, probed via its own IPC RPC.
  const [http, desktop, bgHostTicker, bgHostCode, substrateSidecar] = await Promise.all([
    Promise.all(specs.map((s) => probeEndpoint(s))),
    probeDesktop(),
    probeBgHostTicker(),
    probeBgHostCodeDrift(),
    probeSubstrateSidecar(),
  ]);
  return [...http, desktop, bgHostTicker, bgHostCode, substrateSidecar];
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
    // P-104: also fire the awaitable key so "block until recovered" (events:await
    // service:up:<name>) replaces re-polling dev:service_health. Fire-and-forget;
    // transition-only by construction (diffHealth already returns only changes).
    emitServiceHealthTransitionEvent(t.name, t.to, r?.note);
  }
  return { checked: results.length, transitions };
}

/** Test-only — reset the cross-tick state. */
export function _resetServiceHealthState(): void {
  lastHealth = {};
  lastResults = [];
  lastResultsAt = null;
}
