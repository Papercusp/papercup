#!/usr/bin/env node
/**
 * psu-launcher.mjs — the `psu` command.
 *
 * Picks an SU agent + harness + plan, records a tracked `adv_sessions`
 * row via the bootstrap-su endpoint, then exec's the chosen `*-su`
 * wrapper (claude-su / omp-su / codex-su) in the harness cwd with the
 * tracking env. The `*-su` wrappers (installed by
 * install-standalone-mcp.sh) already inject the engineer playbook +
 * skip-permissions + MCP — `psu` adds the picker + plan tracking on top.
 *
 * Per `psu-wrappers-and-plan-tracked-launch-2026-05-30` Phase B (pivot:
 * single `psu` entry point exec'ing the existing `*-su` wrappers).
 *
 * Lives in the repo so it resolves `@inquirer/prompts` from the
 * operator's node_modules; the on-PATH `psu` shim is a one-liner that
 * exec's this file by absolute path.
 *
 * Interactive:   psu
 * Scripting:     psu --no-picker --agent=<claude|omp|codex> --harness=<slug> [--plan=<slug>|--no-plan]
 */
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, cpSync, mkdirSync, writeFileSync, chmodSync, rmSync, renameSync, realpathSync, statSync, lstatSync, readlinkSync, symlinkSync, copyFileSync, openSync, readSync, writeSync, closeSync } from 'node:fs';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { homedir, hostname } from 'node:os';
import { join, dirname, delimiter, basename } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  hostThroughPty,
  fleetOscFromEnv,
  findLiveHostFor,
  hostIdleMs,
  readHostHandoff,
  reexecExitCodeFrom,
} from './psu-pty-host.mjs';
// Shared with the proxy itself (WI-6738) — psu must not give up while the proxy is still
// retrying on its behalf. Plain .mjs so this bare-node script and the tsx-run proxy can
// import the SAME definition.
import { PSU_REQUEST_TIMEOUT_MS } from '../lib/mcp-proxy/budgets.mjs';
import {
  RUNTIME_OVERHEAD_TOKENS,
  buildContextBudget,
  codexContextConfigArgs,
  codexContextConfigToml,
  normalizeCodexCliModel,
} from '../../../packages/operator-core/lib/model-context-budget.mjs';
// EI-996: the ONE su-tier role list, shared with the server-side allow-list in
// su-role-addendum.ts. Plain .mjs so this bare-node script and the tsx/bundled
// operator import the SAME definition — a second copy here would drift silently.
import { SU_TIER_ROLES } from '../../../packages/operator-core/lib/su-tier-roles.mjs';
// WI-37920: ONE definition of where a backend CLI can live + how to reach it,
// shared with the operator's spawn-env injection (console-launcher). See that
// file's header for why detection and execution are two separate layers.
import {
  wellKnownBackendBin as sharedWellKnownBackendBin,
  readShebangInterpreter,
  resolveOnPath,
  resolveInWellKnownDirs,
} from '../../../packages/operator-core/lib/backend-bin-resolve.mjs';
// WI-37841: the ONE derivation of a launch's boot-log path, shared with
// launch-su.ts (which points the keep-window-open receipt at the same file) and
// with the reader that surfaces its tail on the failed-launch banner. Plain .mjs
// for the same reason as the imports above.
import {
  ensurePsuLaunchLogPath,
  prunePsuLaunchLogs,
  PSU_LAUNCH_LOG_MAX_BYTES,
} from '../../../packages/operator-core/lib/psu-launch-log.mjs';
import { CODEX_GATEWAY_PROVIDER_ID, codexGatewayConfigToml } from '@papercusp/orchestrator/codex-gateway-config';
import {
  ompGatewayModelsConfig,
  ompGatewayModelFromSpec,
} from '@papercusp/orchestrator/omp-gateway-config';

export const AGENTS = ['claude', 'omp', 'codex'];

/**
 * Does `--role=<role>` launch on the SU tier (full engineer playbook + superuser
 * MCP + that role's addendum) rather than via the role-scoped bootstrap? EI-996.
 *
 * `su` itself is the plain SU flow and is NOT a su-tier ROLE — it carries no
 * addendum — but both fall through to the same launch path, which is why this
 * answers the ROUTING question ("skip roleFlow") and `suRoleFor` separately
 * answers the ADDENDUM question ("which role's lines, if any").
 */
export function launchesOnSuTier(role) {
  return role === 'su' || SU_TIER_ROLES.includes(role);
}

/** The su_role to send for a launch, or null for a plain su session. EI-996. */
export function suRoleFor(role) {
  return role !== 'su' && SU_TIER_ROLES.includes(role) ? role : null;
}
/** Sentinel value for the "NO PLAN" picker row. Uses non-slug chars
 *  (`<`/`>`) so it can never collide with a real plan slug. */
export const NO_PLAN = '<no-plan>';

/**
 * Is the resilient MCP proxy (mcp-host-availability-resilience-2026-06-22 P-005,
 * systemd user unit `papercup-mcp-proxy`, default :9071 → :3070) alive on this
 * box? The ROUTE decision is the systemd unit being `active` — the unit is the
 * sole legitimate port owner per the P-006 cutover, so a stale role MCP host
 * squatting the port (role hosts have historically used e.g. :9071) still can't
 * false-positive: it has no active unit. The /api/health check THROUGH the proxy
 * is ADVISORY ONLY (warn, never reroute). It used to be a hard second factor,
 * but a transient health blip at launch (busy box, or :3070 mid-deploy-restart —
 * the very window the proxy exists to bridge) then minted a LIFETIME direct
 * :3070 pin into the child session's env, which is the exact availability
 * failure the proxy was built to prevent (observed live on two sessions,
 * mcp-outage-triage-2026-07-02). A genuinely wedged proxy fails loudly on first
 * use and gets fixed; a silent direct pin severs the session's tools on every
 * subsequent deploy.
 * Sync (resolveOperatorUrl runs at module top level); each check is loopback +
 * bounded, so the added launch latency is ~10–50ms. Exported for tests.
 */
export function defaultMcpProxyProbe(port) {
  try {
    const proxyHealth = spawnSync(
      'curl',
      ['-s', '-o', '/dev/null', '-m', '2', '-w', '%{http_code}', `http://127.0.0.1:${port}/__mcp_proxy_health`],
      { encoding: 'utf8', timeout: 3_000 },
    );
    if ((proxyHealth.stdout ?? '').trim() === '200') return true;

    const unit = spawnSync('systemctl', ['--user', 'is-active', 'papercup-mcp-proxy'], {
      encoding: 'utf8',
      timeout: 2_000,
    });
    if ((unit.stdout ?? '').trim() !== 'active') return false;
    const health = spawnSync(
      'curl',
      ['-s', '-o', '/dev/null', '-m', '6', '-w', '%{http_code}', `http://127.0.0.1:${port}/api/health`],
      { encoding: 'utf8', timeout: 8_000 },
    );
    if ((health.stdout ?? '').trim() !== '200') {
      console.warn(
        `psu: MCP proxy unit is active on :${port} but /api/health through it did not return 200 — ` +
          `routing via the proxy anyway (it bridges operator restarts; a direct pin would be permanent). ` +
          `If tools fail, check papercup-mcp-proxy.service and :3070.`,
      );
    }
    return true;
  } catch {
    return false; // no systemctl / any error ⇒ treat as no proxy (safe fallback)
  }
}

/**
 * Resolve the operator's base URL. Precedence:
 *   1. PAPERCUSP_OPERATOR_URL env — explicit override (highest). If it targets
 *      the fixed :3070 while the resilient proxy is active, a loud warning is
 *      emitted (WI-1457: proxy active-but-unrouted) — the override still wins.
 *   2. The RESILIENT MCP PROXY (`http://127.0.0.1:9071`, WI-1457 hardening) —
 *      when it is verifiably alive. This is the dev-box steady state, and now
 *      also the packaged steady state: sessions ride the always-up proxy so a
 *      dynamic operator port restart is invisible (retry-on-refused, never
 *      double-applies a write). Opt out with PAPERCUSP_MCP_PROXY=0; port
 *      override via PAPERCUSP_MCP_PROXY_PORT. The proxy is a generic
 *      passthrough, so the whole operator HTTP surface (not just /api/mcp)
 *      works through it.
 *   3. ~/.papercusp/operator.json `httpUrl` (or `port`) — the DESKTOP operator's
 *      ACTUAL address. A shipped Tauri desktop app runs its operator on a
 *      dynamically-assigned localhost port (rewritten on every boot), NOT a
 *   4. http://localhost:3070 — the dev-box direct default (no proxy installed).
 * The desktop never has operator.json missing, and the dev box never WRITES
 * operator.json in steady state, so each environment lands on the right branch
 * with no cross-contamination. Exported for tests; `probe`/`warn` injectable.
 */
/**
 * WI-6821 DEFECT A — `PAPERCUSP_OPERATOR_URL` is contractually a BARE BASE: every
 * caller appends the path itself (`${base}/api/mcp?…`, `${base}/api/admin/…`).
 * A value that ALREADY ends in `/api/mcp` therefore builds `…/api/mcp/api/…`,
 * which 404s — and psu died on that with a bare `not_found` and exit 1 about
 * 0.4s in. That is not a cosmetic failure: `launch-su.ts` runs psu as
 * `exec <psu …>` inside `gnome-terminal --wait`, so psu exiting IS the window
 * closing. The terminal flashed open and shut, the recorded pid died, the
 * session never registered, and its adv_sessions row sat at `session_id NULL`
 * advertising "Starting up — waiting for this session to come online…" for the
 * whole 15-minute window (the owner-reported symptom, 2026-08-02).
 *
 * Reproduced with a one-variable control: `http://127.0.0.1:3070` launched
 * cleanly (exit 0), `http://127.0.0.1:3070/api/mcp` died in 0.4s. Nothing else
 * differed.
 *
 * The launcher that leaked it is fixed at its own source, but this is the choke
 * point EVERY psu launch passes through and psu can be started by any parent (a
 * human shell with a stale export, another tool), so normalize here too rather
 * than leaving the trap armed for the next caller. Every OTHER branch of
 * resolveOperatorTarget already returns a bare base — this env branch was the
 * only one that could return a path-suffixed url.
 *
 * A base can never legitimately END in the path about to be appended to it, so
 * stripping is unambiguous, not a guess. Anything unparseable is returned
 * untouched — the connection path reports that far better than a silent rewrite.
 * Exported for tests; `warn` injectable.
 */
export function normalizeOperatorBaseUrl(raw, { warn = (m) => console.warn(m) } = {}) {
  if (typeof raw !== 'string') return raw;
  const trimmed = raw.trim();
  if (!trimmed) return trimmed;
  let u;
  try {
    u = new URL(trimmed);
  } catch {
    return trimmed;
  }
  if (!/\/api\/mcp\/?$/i.test(u.pathname)) return trimmed.replace(/\/+$/, '');
  u.pathname = u.pathname.replace(/\/api\/mcp\/?$/i, '');
  // The suffixed form is the agent MCP url, which carries the session's signed
  // query (`?sid=…`). Those params address /api/mcp specifically and are
  // meaningless — and misleading — on a base, so drop them with the path.
  u.search = '';
  u.hash = '';
  const fixed = u.toString().replace(/\/+$/, '');
  warn(
    `psu: PAPERCUSP_OPERATOR_URL is "${trimmed}", but it must be a BARE BASE — the /api/mcp path is appended per call, ` +
      `so this pin would request …/api/mcp/api/… and EVERY operator call would 404 (psu would exit "not_found" in well ` +
      `under a second, closing its terminal window immediately). Using "${fixed}" instead — fix whatever exports the ` +
      `suffixed value (WI-6821).`,
  );
  return fixed;
}

export function resolveOperatorTarget({
  env = process.env,
  home = homedir(),
  probe = defaultMcpProxyProbe,
  warn = (m) => console.warn(m),
} = {}) {
  const proxyOptedOut = env.PAPERCUSP_MCP_PROXY === '0';
  const proxyPort = Number(env.PAPERCUSP_MCP_PROXY_PORT) > 0 ? Number(env.PAPERCUSP_MCP_PROXY_PORT) : 9071;
  if (env.PAPERCUSP_OPERATOR_URL) {
    const pinned = normalizeOperatorBaseUrl(env.PAPERCUSP_OPERATOR_URL, { warn });
    // WI-1457: an explicit :3070 pin while the proxy is alive is exactly the
    // active-but-unrouted regression — honor the override, but say so loudly.
    if (!proxyOptedOut && /:3070\b/.test(pinned) && probe(proxyPort)) {
      warn(
        `psu: PAPERCUSP_OPERATOR_URL pins ${pinned} but the resilient MCP proxy is ACTIVE on :${proxyPort} — ` +
          `this session bypasses deploy-restart resilience (WI-1457). Unset the override (or point it at :${proxyPort}) to ride the proxy.`,
      );
    }
    return { url: pinned, source: 'env', startedAt: null };
  }
  // WI-3247: prefer the stable proxy over desktop operator.json when present.
  // operator.json carries a per-boot dynamic port; exporting it into a long-lived
  // child makes that session lose MCP after the operator restarts. The proxy
  // re-resolves operator.json per attempt, so the child env stays stable.
  if (!proxyOptedOut && probe(proxyPort)) return { url: `http://127.0.0.1:${proxyPort}`, source: 'proxy', startedAt: null };
  try {
    const d = JSON.parse(readFileSync(join(home, '.papercusp', 'operator.json'), 'utf8'));
    // startedAt (epoch ms, written by serve on come-up) dates the record: a
    // desktop whose operator died leaves a STALE record behind, and psu's
    // connection-failure handling uses that age to fail fast with real guidance
    // instead of a quiet 30s retry (WI-3271).
    const startedAt = Number(d?.startedAt) > 0 ? Number(d.startedAt) : null;
    if (d && typeof d.httpUrl === 'string' && d.httpUrl) return { url: d.httpUrl, source: 'discovery', startedAt };
    if (d && d.port) return { url: `http://127.0.0.1:${d.port}`, source: 'discovery', startedAt };
  } catch {
    /* no/!readable operator.json (the dev box) → proxy / dev-port fallback below */
  }
  return { url: 'http://localhost:3070', source: 'dev-default', startedAt: null };
}

/** Back-compat string form of resolveOperatorTarget (exported for tests/callers). */
export function resolveOperatorUrl(opts = {}) {
  return resolveOperatorTarget(opts).url;
}

// `let` (not const): fetchWithResilience fails over to a live alternative when
// the resolved target is dead (stale-shell heal below) — every later api()
// call / child-session URL derivation picks up the adopted target because the
// defaults at those call sites read these bindings per call.
let OPERATOR_TARGET = resolveOperatorTarget();
let OPERATOR_URL = OPERATOR_TARGET.url;

/**
 * The candidate ladder for HEALING a dead operator target mid-session — the
 * same ladder as resolveOperatorTarget MINUS the env pin (the env pin is
 * exactly what's being healed). Candidates are NOT liveness-checked here;
 * fetchWithResilience health-checks each in order. Exported for tests.
 *
 * Why this exists (owner repro, mac VM 2026-07-07): every console/fleet
 * terminal exports PAPERCUSP_OPERATOR_URL for the operator instance that
 * spawned it, but a desktop operator's port is per-boot dynamic — a window
 * that outlives its operator pins a DEAD port, and psu burned the whole
 * connect budget on it and failed ("operator unreachable") while a healthy
 * operator sat one operator.json read away.
 */
export function resolveFallbackOperatorTargets({ env = process.env, home = homedir(), excludeUrls = [] } = {}) {
  const out = [];
  const push = (url, source, startedAt = null) => {
    if (url && !excludeUrls.includes(url) && !out.some((c) => c.url === url)) out.push({ url, source, startedAt });
  };
  const proxyOptedOut = env.PAPERCUSP_MCP_PROXY === '0';
  const proxyPort = Number(env.PAPERCUSP_MCP_PROXY_PORT) > 0 ? Number(env.PAPERCUSP_MCP_PROXY_PORT) : 9071;
  if (!proxyOptedOut) push(`http://127.0.0.1:${proxyPort}`, 'proxy');
  try {
    const d = JSON.parse(readFileSync(join(home, '.papercusp', 'operator.json'), 'utf8'));
    const startedAt = Number(d?.startedAt) > 0 ? Number(d.startedAt) : null;
    if (d && typeof d.httpUrl === 'string' && d.httpUrl) push(d.httpUrl, 'discovery', startedAt);
    else if (d && d.port) push(`http://127.0.0.1:${d.port}`, 'discovery', startedAt);
  } catch {
    /* no/!readable operator.json (the dev box) */
  }
  push('http://localhost:3070', 'dev-default');
  return out;
}

/**
 * Adopt a healed operator target session-wide: later api() calls and child
 * sessions derive their URL from these bindings, and the env export means any
 * child that inherits raw process.env gets the WORKING address instead of the
 * dead pin this process was started with. Exported for tests.
 */
export function adoptOperatorTarget(t) {
  OPERATOR_TARGET = t;
  OPERATOR_URL = t.url;
  process.env.PAPERCUSP_OPERATOR_URL = t.url;
}

/**
 * Per-request timeout (ms). `fetch` has no default timeout, so a wedged or
 * CPU-saturated operator used to make `psu` hang FOREVER on its first picker
 * call (`bootstrap-su/options`) with no output. A bounded timeout fails fast
 * with an actionable message instead. Override with PAPERCUSP_PSU_TIMEOUT_MS.
 */
// Per-request timeout. History: 15s→45s (2026-06-07, a busy operator can take 10-30s on a
// hop-heavy bootstrap route under fleet load), then 45s→DERIVED (WI-6738).
//
// 45s was wrong for a reason no amount of tuning fixes: psu dials the mcp-proxy, and the
// proxy retries a refused upstream for up to MCP_PROXY_RETRY_WINDOW_MS (90s). Giving up at
// 45s meant abandoning a request the front door was still actively retrying — so every
// :3070 gap between 45s and 90s became a hard, user-visible psu failure that the proxy
// existed to absorb. Owner hit exactly that on 2026-08-01 and reported the system down; it
// self-recovered ~90s later.
//
// The number now DERIVES from the proxy's window (+ headroom) so the two cannot drift apart
// again; budgets.test.ts asserts the invariant. A truly wedged host still fails with the
// same guidance — just after the proxy has actually exhausted its retries, not during them.
// Override still honored: PAPERCUSP_PSU_TIMEOUT_MS.
const REQUEST_TIMEOUT_MS = PSU_REQUEST_TIMEOUT_MS;
// A TIMEOUT means the host accepted but didn't answer within REQUEST_TIMEOUT_MS
// (wedged, not restarting) — a retry just burns another full timeout, so keep
// these few. Tunable via PAPERCUSP_PSU_RETRIES (kept for back-compat).
const TIMEOUT_RETRIES = Number(process.env.PAPERCUSP_PSU_RETRIES) || 1;
// A CONNECTION failure (refused/reset — undici's "fetch failed") almost always
// means the operator is mid-recycle: the memory-watchdog drains + exits and
// systemd restarts a fresh process (~10-15s unreachable per cycle), which on a
// busy box recurs. These fail in milliseconds, so rather than one fixed retry we
// keep retrying on a short backoff until this wall-clock budget elapses — riding
// THROUGH the restart window instead of failing the launch on the first dead
// tick. A genuine outage still fails once the budget is spent. 0 disables.
const _connectRetryRaw = Number(process.env.PAPERCUSP_PSU_CONNECT_RETRY_MS);
const CONNECT_RETRY_BUDGET_MS = Number.isFinite(_connectRetryRaw) ? _connectRetryRaw : 30_000;
// WI-3271: the 30s ride-through is for a MID-RESTART operator. On a desktop
// install whose operator DIED (app closed / supervision gave up), operator.json
// keeps the dead port with an old startedAt — burning the full budget there is
// the owner-reported "psu → nothing happened" UX. When the discovery record is
// older than this, a connection failure fails FAST (budget below) with an
// actionable "start the Papercusp app" message instead. A record younger than
// this still gets the full ride-through (a restarting operator rewrites
// operator.json on come-up, so a fresh record = plausibly mid-boot).
const STALE_DISCOVERY_MS = 10 * 60_000;
const STALE_FAST_FAIL_BUDGET_MS = 5_000;

/** Coarse human age ("3m" / "2h" / "5d") for the stale-operator message. */
function fmtAgo(ms) {
  if (!Number.isFinite(ms) || ms < 0) return 'an unknown time';
  const m = Math.round(ms / 60_000);
  if (m < 1) return 'under a minute';
  if (m < 120) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

/** Floor for `--compaction-limit`, mirroring MIN_COMPACTION_LIMIT_TOKENS in
 *  packages/operator-core/lib/agent-config-constants.ts. Duplicated (this launcher
 *  is plain .mjs and imports no TS) and pinned by a parity assertion in
 *  apps/operator/lib/psu-launcher.test.ts — the same pattern validateModelSpec uses. */
export const MIN_COMPACTION_LIMIT_TOKENS = 20_000;

/** Parse the scripting-escape flags. Pure — exported for tests. */
export function parseArgs(argv) {
  const out = { picker: true, resume: false, resumeId: null, fork: false, agent: null, role: null, feature: null, workspace: null, harness: null, plan: null, noPlan: false, model: null, resumeSession: null, launchContext: null, launchedBy: null, ownerId: null, profile: null, contextSize: null, personaTier: null, compactionLimit: null, force: false, yes: false, brain: false, account: null, fleet: null, fleetRole: null, fleetName: null, fleetScheme: null, auto: null, mode: null, seat: null, carry: null, addDir: [], passthrough: [], setClaudeToken: false, setClaudeTokenValue: null, clearClaudeToken: false, allowSubagents: null, kickoffPromptText: null, label: null, headless: false };
  // Everything after a literal `--` is forwarded VERBATIM to the underlying agent
  // CLI (claude/omp/codex) — a generic escape hatch so a new backend flag needs no
  // psu change. Appended at the END of the launch/resume argv (launchFreshSu /
  // launchResume); ordering past that is the caller's responsibility.
  let rest = false;
  let pendingAddDir = false;
  let pendingAccount = false;
  let pendingFleet = false;
  // EI-181: the space-separated form of the six most-scripted value flags
  // (`psu --role operator` etc.) used to be SILENTLY DROPPED — `--role` matched
  // no `--role=` prefix (ignored) and the bare value `operator` matched no
  // positional case either (ignored), so role/agent/etc. resolved to null and
  // psu fell through to the interactive picker with zero error or warning (cost
  // a multi-round debugging session when a dock pane launched exactly this
  // form). Mirrors the pre-existing --add-dir/--account/--fleet space-form
  // pattern below: the flag token arms a `pending*` latch, the NEXT token
  // (verbatim, even if it happens to start with `--`) is taken as the value.
  let pendingRole = false;
  let pendingAgent = false;
  let pendingWorkspace = false;
  let pendingFeature = false;
  let pendingHarness = false;
  let pendingPlan = false;
  for (const a of argv) {
    if (rest) { out.passthrough.push(a); continue; }
    // `--add-dir <dir>` (space form) — the previous token armed this; take the
    // value verbatim (even if it looks like a flag, it's the dir the user meant).
    if (pendingAddDir) { pendingAddDir = false; out.addDir.push(a); continue; }
    if (pendingRole) { pendingRole = false; out.role = a; continue; }
    if (pendingAgent) { pendingAgent = false; out.agent = a; continue; }
    if (pendingWorkspace) { pendingWorkspace = false; out.workspace = a; continue; }
    if (pendingFeature) { pendingFeature = false; out.feature = a; continue; }
    if (pendingHarness) { pendingHarness = false; out.harness = a; continue; }
    if (pendingPlan) { pendingPlan = false; out.plan = a; continue; }
    // `--account <id>` (space form) — the previous token armed this; take the
    // value verbatim (an account id never starts with `--`).
    if (pendingAccount) { pendingAccount = false; out.account = a; continue; }
    // `--fleet <slug>` (space form) — join an EXISTING named fleet by slug
    // (member role). A new fleet is only created interactively (the picker
    // prompts for a name → leader), so the flag form always means "member".
    if (pendingFleet) { pendingFleet = false; out.fleet = a; out.fleetRole = 'member'; continue; }
    if (a === '--') { rest = true; continue; }
    // One-time credential commands (handled at the top of main(), before any
    // launch). Store/clear the default-account Claude OAuth token that
    // default-account claude psu sessions inherit cross-platform (esp. macOS,
    // where keychain-per-config-dir defeats file inheritance). The inline
    // `=<token>` form is for scripting; bare prompts for a paste.
    if (a === '--set-claude-token') { out.setClaudeToken = true; continue; }
    else if (a.startsWith('--set-claude-token=')) { out.setClaudeToken = true; out.setClaudeTokenValue = a.slice('--set-claude-token='.length) || null; continue; }
    else if (a === '--clear-claude-token') { out.clearClaudeToken = true; continue; }
    if (a === '--no-picker') out.picker = false;
    // headless-fleet-launch (P-001): run with NO desktop window + no TTY, but STILL
    // through the managed-pty host so the session keeps its control socket and stays
    // injectable (warm `loop:arm` wakes land as `psu-socket-inject`, not a Channel-3
    // park). Sets PAPERCUSP_PSU_HEADLESS=1 for usePtyHost + the child env. Implies
    // --no-picker: there is no terminal to prompt at.
    else if (a === '--headless') { out.headless = true; out.picker = false; }
    // Fleet-launch attestation token (WI-38513). Carry behavior still comes from
    // the member baseline's loop:arm directive; this flag makes the resolved
    // choice durable in adv_sessions.launch_argv so launch verification can prove
    // the child received warm vs cold instead of trusting the caller's receipt.
    else if (a.startsWith('--carry=')) {
      const carry = a.slice('--carry='.length);
      if (carry !== 'warm' && carry !== 'cold') {
        throw new Error(`--carry must be warm|cold (got ${carry || 'empty'})`);
      }
      out.carry = carry;
    }
    // THE brain (native-terminal-desktop D-013): resume the canonical pinned
    // brain session exactly (no picker); when none is pinned (or it no longer
    // resolves) launch a fresh claude SU session and pin it server-side.
    else if (a === '--brain') out.brain = true;
    // `--resume` alone → pick from the recent-session list. `--resume=<id>`
    // (or a bare id after `--resume`) → resume THAT session directly, no
    // picker. The id is the /adv adv_sessions row id OR a backend-native handle:
    // claude session UUID, OMP thread id, or Codex rollout UUID under a tracked
    // CODEX_HOME.
    else if (a === '--resume') out.resume = true;
    else if (a.startsWith('--resume=')) { out.resume = true; out.resumeId = a.slice('--resume='.length) || null; }
    // Fork the resumed session instead of appending to it. Claude uses
    // `--fork-session`; Codex uses `codex fork`. Both mint a NEW native session
    // seeded with the original's history, leaving the original id + transcript
    // untouched. psu additionally hands the fork a FRESH coord identity (new
    // PAPERCUSP_SID, no adv-row link unless the tracked Claude fork path can mint
    // one — see resumeEnvFor) so it can run CONCURRENTLY with the still-live
    // original without colliding on locks/presence/inbox-wake. OMP still has no
    // native branch command.
    else if (a === '--fork' || a === '--fork-session') out.fork = true;
    else if (a === '--no-plan') out.noPlan = true;
    // Subagent-launch tool (Task/Agent) governance (owner mandate 2026-07-02):
    // DENIED BY DEFAULT for every psu launch (su + role + resume), matching the
    // headless/bee posture. `--allow-subagents` is the explicit opt-IN that KEEPS
    // the tool for THIS launch; `--no-subagents` is kept as an (now-redundant)
    // explicit opt-OUT alias. Tri-state: null = unset (picker prompts; falls back
    // to deny), true = allow, false = deny. Threaded into roleLaunchArgs /
    // suLaunchArgs / resumeArgsFor, and re-emitted by fleet:launch-on-plan
    // ({ allowSubagents } → `--allow-subagents`). claude-only (the deny flag is a
    // claude CLI flag; omp/codex have no equivalent and are unaffected).
    else if (a === '--allow-subagents') out.allowSubagents = true;
    else if (a === '--no-subagents') out.allowSubagents = false;
    // improve-fleet-launch-autokickoff (EI-5503): opt OUT of the auto-kickoff first
    // user turn that a scripted plan launch (`--no-picker --plan=…`) otherwise seeds.
    // Default ON for scripted plan launches; this flag restores the old open-at-an-
    // empty-prompt behavior. (Interactive picker launches never auto-kickoff.)
    else if (a === '--no-kickoff') out.kickoff = false;
    else if (a === '--agent') pendingAgent = true;
    else if (a.startsWith('--agent=')) out.agent = a.slice('--agent='.length);
    else if (a === '--role') pendingRole = true;
    else if (a.startsWith('--role=')) out.role = a.slice('--role='.length);
    else if (a === '--feature') pendingFeature = true;
    else if (a.startsWith('--feature=')) out.feature = a.slice('--feature='.length);
    else if (a === '--workspace') pendingWorkspace = true;
    else if (a.startsWith('--workspace=')) out.workspace = a.slice('--workspace='.length);
    else if (a === '--harness') pendingHarness = true;
    else if (a.startsWith('--harness=')) out.harness = a.slice('--harness='.length);
    else if (a === '--plan') pendingPlan = true;
    else if (a.startsWith('--plan=')) out.plan = a.slice('--plan='.length);
    // P-032 omp-convergence passthroughs: a model fuzzy-match, resume of a
    // specific recorded session, and a kickoff/launch-context file the server
    // pre-generated (fed to the *-su wrapper as its launch-context).
    else if (a.startsWith('--model=')) {
      // Guard a malformed model spec (WI-1979) — a hand-typed `[1m]` marker / misspelled alias
      // (`fabel5[1m]`) is rejected HERE with a corrective suggestion, so it never reaches the CLI
      // as an unrunnable model that fails the launch silently. throw → the top-level main().catch
      // prints `psu: <message>` + exits. Covers EVERY launch path (raw psu, capability:terminal,
      // fleet:launch-on-plan) since all --model input funnels through parseArgs.
      const rawModel = a.slice('--model='.length);
      const v = validateModelSpec(rawModel);
      if (!v.ok) throw new Error(v.message);
      // Normalization is backend-specific and therefore happens after the
      // complete argv has resolved `--agent` below. OMP is multi-provider and
      // must receive configured model ids verbatim; Claude's `[1m]` marker is
      // not part of OMP's model grammar.
      out.model = rawModel;
    }
    else if (a.startsWith('--resume-session=')) out.resumeSession = a.slice('--resume-session='.length);
    else if (a.startsWith('--launch-context=')) out.launchContext = a.slice('--launch-context='.length);
    // Free-form KICKOFF first user turn — the general form of the EI-5503 plan
    // auto-kickoff, decoupled from plans. A caller (e.g. the desktop tutorial's
    // "ask an agent" launcher) that wants the session to START by working a
    // specific prompt passes `--kickoff='<text>'`; it becomes the trailing
    // positional first turn (kickoffPositionalArgs), taking precedence over the
    // server's plan-derived kickoff. Same --no-picker + --no-kickoff gating.
    else if (a.startsWith('--kickoff=')) out.kickoffPromptText = a.slice('--kickoff='.length);
    // Opaque LABEL stamped on this session's adv_sessions row (bootstrap-su reads
    // body.label). Lets the launcher later CORRELATE the booted session back to
    // its coord owner id (adv_sessions.coord_owner_id) — e.g. the tutorial's
    // docs-agent reuse: find the live `docs-tutor`-labelled session for a workspace.
    else if (a.startsWith('--label=')) out.label = a.slice('--label='.length);
    // solo-launch-provenance: the ownerId of the agent that launched this session
    // (capability:terminal auto-injects it into psu commands). Forwarded to
    // bootstrap-su, which bakes it into the system prompt + env + a standing fact.
    else if (a.startsWith('--launched-by=')) out.launchedBy = a.slice('--launched-by='.length);
    // WI-5002/EI-13277 programmatic-spawner contract: PRE-PIN this fresh session's
    // coord owner id (bootstrap-su validates + uses it instead of minting). Exists
    // because the spawner's exported PAPERCUSP_SID is overridden by the launch
    // envelope — state a spawner keys pre-spawn (doors overrides, transcript reads)
    // otherwise binds to an owner the session never runs as.
    else if (a.startsWith('--owner-id=')) out.ownerId = a.slice('--owner-id='.length);
    // su-context-size-variants: 'full' | 'trimmed' — the initial-context size variant
    // (orthogonal to --agent). Forwarded to bootstrap-su; applied per-client at launch.
    else if (a.startsWith('--context-size=')) out.contextSize = a.slice('--context-size='.length);
    // context-trimming-tiers P-017: persona tier — full | fleet. Omitted ⇒ the
    // server auto-selects from the model window (≤200k known model → fleet).
    else if (a.startsWith('--persona-tier=')) out.personaTier = a.slice('--persona-tier='.length);
    // per-member-declarative-launch-specs P-005: this session's explicit soft
    // compaction limit in TOKENS (MemberSpec.compactionLimit). Recorded onto
    // adv_sessions.launch_argv by psuLaunchArgvRecord; the compaction watchdog's
    // seeding pass reads it back and applies it AHEAD of the tier/model default,
    // clamped to the fleet-role ceiling. Before this, a per-member limit could only
    // be REQUESTED in a brief ("set your own limit to N") — an instruction a member
    // could ignore, mis-apply, or reach only after its first compaction.
    // Malformed input THROWS (like --model/--mode): a limit silently dropped back to
    // the default is exactly the failure this flag exists to remove.
    else if (a.startsWith('--compaction-limit=')) {
      const rawLimit = a.slice('--compaction-limit='.length);
      const n = Number(rawLimit);
      if (!Number.isInteger(n) || n < MIN_COMPACTION_LIMIT_TOKENS) {
        throw new Error(
          `--compaction-limit=${rawLimit} is not valid — pass a whole number of TOKENS >= ${MIN_COMPACTION_LIMIT_TOKENS} ` +
            `(e.g. --compaction-limit=200000). The seed clamps it DOWN to your fleet-role ceiling; it never raises it.`,
        );
      }
      out.compactionLimit = n;
    }
    // context-trimming-tiers P-018: override the preflight window-guard refusal.
    else if (a === '--force') out.force = true;
    // P-023: su playbook profile (engineer|power) — assembled per-launch now,
    // so it's a launch flag, not a per-install choice. Default (server-side) engineer.
    else if (a.startsWith('--profile=')) out.profile = a.slice('--profile='.length);
    // First-class `--add-dir <dir>` / `--add-dir=<dir>` (repeatable): the most-asked
    // backend passthrough, lifted out of the generic `--` for discoverability +
    // backend-aware placement. Maps to claude's + codex's native `--add-dir` (omp
    // has none → warned + skipped at launch). Both space + `=` forms; values are
    // forwarded verbatim. See addDirArgs for the per-backend flag mapping.
    else if (a === '--add-dir') pendingAddDir = true;
    else if (a.startsWith('--add-dir=')) { const v = a.slice('--add-dir='.length); if (v) out.addDir.push(v); }
    // account-routing-3-options (P-001 + 2026-06-30): the ONE `--account` value picks ONE of three
    // explicit routing modes (`psu --account <id|auto|default>`, space or `=` form):
    //   • <pool-id> → pin this session to that account via the inference gateway (hard, no failover)
    //   • auto      → route through the gateway with NO pin; it picks an available account + fails over
    //   • default (or omitted) → skip the gateway, use the system / CLI-login credential (THE DEFAULT)
    // Threaded to bootstrap-su (resolveAccountPin) for a fresh launch / tracked fork; resolved
    // client-side (chooseResumeAccount) for an in-place resume. Explicit auto/pin choices fail
    // closed when unavailable; only default/omitted may use the system login.
    else if (a === '--account') pendingAccount = true;
    else if (a.startsWith('--account=')) out.account = a.slice('--account='.length);
    // named-su-agent-fleets P-006: pin this session into a named fleet (`psu
    // --fleet ops-team` or `--fleet=ops-team`). Threaded to bootstrap-su, which
    // folds PAPERCUSP_FLEET_SLUG/PAPERCUSP_FLEET_ROLE into the spawn env (mirrors
    // --account). The flag joins an EXISTING fleet → member; creating a new fleet
    // (→ leader) is only offered through the interactive picker.
    else if (a === '--fleet') pendingFleet = true;
    else if (a.startsWith('--fleet=')) { out.fleet = a.slice('--fleet='.length); out.fleetRole = 'member'; }
    // agent-allocation P-005 (launch-from-seats): the delegated agent_slot template
    // this member consumes ('<model>:<effort>:<account>', emitted by
    // fleet:launch-on-plan as `--seat=<ref>`). Forwarded to bootstrap-su, which
    // records the consumption (mig 487) and REFUSES the boot when the fleet's
    // delegated seats are exhausted — the flag only makes sense with `--fleet`.
    else if (a.startsWith('--seat=')) out.seat = a.slice('--seat='.length) || null;
    // fleet-auto-mode (WI-1356): start the session in AUTO mode (the persona's
    // act/don't-ask/loop-until-done standing state). A fleet member has no human at
    // its keyboard, so `--fleet` defaults AUTO ON (see effectiveAutoMode); `--auto`
    // forces it on for any launch, `--no-auto` forces it off even for a fleet member.
    else if (a === '--auto') out.auto = true;
    else if (a === '--no-auto') out.auto = false;
    // drain-mode-2026-07-03 P-003: named operating mode. Only 'drain' is recognized —
    // launch the session in DRAIN mode (drain the target work queue to terminal; implies
    // AUTO). A typo'd mode must fail the launch loudly, not silently launch a plain
    // session — same throw-to-main() pattern as the --model guard (WI-1979).
    else if (a.startsWith('--mode=')) {
      const rawMode = a.slice('--mode='.length);
      if (rawMode !== 'drain') {
        throw new Error(`--mode=${rawMode} is not recognized — the only supported mode is \`drain\` (psu --mode=drain: drain the work queue to terminal; implies AUTO).`);
      }
      out.mode = rawMode;
    }
    // Skip the confirm when resuming an UNTRACKED (non-psu) session (for scripts).
    else if (a === '--yes' || a === '-y') out.yes = true;
    // Bare positional id after `--resume` (ergonomic `psu --resume 42` form).
    else if (!a.startsWith('--') && out.resume && !out.resumeId) out.resumeId = a;
    // EI-181 defense-in-depth: any OTHER `--`-prefixed token that reached here
    // matched none of the branches above — a typo'd/unknown flag, or a value
    // flag's space-form we haven't special-cased. Before this, such a token was
    // silently swallowed with zero signal (the same silent-drop this item's
    // repro hit for --role); now the caller gets a one-line stderr note instead
    // of a mysteriously-unscoped session. Never throws — a genuinely-unknown
    // flag shouldn't hard-fail the launch, just be visible.
    else if (a.startsWith('--')) {
      console.error(`psu: warning — unrecognized flag \`${a}\` was ignored (did you mean \`${a}=<value>\`? psu --help lists supported flags).`);
    }
  }
  // Model-family/backend coupling: a supplied native cloud model selects its
  // backend when --agent is omitted, and an explicit mismatch fails before any
  // wrapper/terminal opens. OMP stays exempt because it is multi-provider.
  const hintedBackend = cloudModelBackendHint(out.model);
  if (!out.agent && hintedBackend) out.agent = hintedBackend;
  const pairing = validateAgentModelPair(out.agent, out.model);
  if (!pairing.ok) throw new Error(pairing.message);
  out.model = normalizeModelSpecForAgent(out.agent, out.model);
  return out;
}

/**
 * Map a psu model spec (`<model>[:<effort>]`) onto ONE backend's native model
 * flags. Shared by the fresh-launch wrapper path (suWrapperExtraArgs) and the
 * resume path (resumeArgsFor — WI-3758 `psu --resume … --model`). Pure —
 * exported for tests.
 *
 *   - claude: the CLI takes effort as its OWN flag — a verbatim suffixed spec
 *     sets the model and silently DROPS the effort, so the session falls back
 *     to the box's saved default (how a sonnet-5:high fleet came up at xhigh,
 *     2026-07-01). Split a recognized effort tail into `--effort`; anything
 *     else (a bare id, or a non-effort `:` segment like bedrock's `…-v2:0`)
 *     passes through verbatim.
 *   - codex: `-m` wants a BARE model id; reasoning effort is a CONFIG override
 *     (`-c model_reasoning_effort="high"`, preserving every recognized level,
 *     including `max`, exactly as requested). A verbatim suffixed
 *     spec would set an unknown MODEL and silently drop the effort — the same
 *     effort-drop class the claude branch fixed (2026-07-01), found for codex
 *     launching the backlog-clearance fleet (2026-07-03).
 *   - omp: understands the `<model>[:<effort>]` spec natively. One provider/model
 *     exception is refused below: Vertex Gemini 3.1 Pro currently returns a
 *     deterministic empty STOP stream at `:high`. Psu must not silently lower an
 *     explicitly requested effort level, so that exact combination fails before spawn.
 */
const OMP_GEMINI_31_PRO_HIGH_RE = /^google-vertex\/gemini-3\.1-pro-preview:high$/i;

/**
 * Guard a provider-specific OMP failure without changing the user's OMP
 * installation or other model/effort selections. The controlled reproduction
 * for WI-37890 showed `google-vertex/gemini-3.1-pro-preview:high` emits only a
 * `STOP` with no content and retries until exhaustion, while the same request
 * at `:low` completes and can call tools. D-011 forbids treating an implicit
 * high-to-low downgrade as terminal: refuse the unsupported exact path and make
 * the caller choose a lower effort explicitly. Keep the guard exact and reversible;
 * an unrelated Vertex model, provider, or effort remains byte-identical.
 * Pure + exported for regression tests.
 */
export function normalizeOmpModelSpec(model) {
  if (typeof model === 'string' && OMP_GEMINI_31_PRO_HIGH_RE.test(model)) {
    throw new Error(
      `OMP cannot launch ${model}: this exact high-effort path returns deterministic empty STOP responses. ` +
      'Refusing to silently lower the requested effort; choose :low explicitly or use a client/provider whose :high path is supported.',
    );
  }
  return model;
}

/** Compatibility notices are reserved for non-semantic adjustments; WI-37890 now fails loud. */
export function ompModelCompatibilityNotice(model) {
  normalizeOmpModelSpec(model);
  return null;
}

export function modelArgsFor(agent, model) {
  if (!model) return [];
  const effectiveModel =
    agent === 'codex'
      ? normalizeCodexCliModel(model)
      : agent === 'omp'
        ? normalizeOmpModelSpec(model)
        : model;
  const m = /^(.+):(low|medium|high|xhigh|max)$/.exec(effectiveModel);
  if (agent === 'codex') {
    // Extended-window models are launched at their declared window with the
    // native auto-compact pushed to a 90% backstop (plan
    // codex-1m-context-window-2026-08-17 D-002). Without this, codex runs its
    // 272k default -> 258,400 effective and its OWN summarizer fires before
    // papercusp's 400k su/leader carry cut is ever reached, so the soft limit
    // in D-001 never gets to run. `[]` for a model with no extended window, so
    // those launches stay byte-identical to before.
    const windowArgs = codexContextConfigArgs(m ? m[1] : effectiveModel);
    if (m) {
      return ['-m', m[1], '-c', `model_reasoning_effort="${m[2]}"`, ...windowArgs];
    }
    return ['-m', effectiveModel, ...windowArgs];
  }
  if (agent === 'claude' && m) return ['--model', m[1], '--effort', m[2]];
  return ['--model', effectiveModel];
}

/**
 * Extra args to pass THROUGH a `*-su` wrapper to the underlying CLI (the
 * wrappers all end with `"$@"`). Maps a model fuzzy-match + a resume-by-id
 * onto each backend's native flags. Pure — exported for tests.
 *
 * This is what gives psu launches model/resume parity with the retired
 * `buildEngineerOmpLaunchCommand` (P-032): omp `--model`/`-r`, claude
 * `--model`/`--resume`, codex `-m`/`resume`.
 */
export function suWrapperExtraArgs(agent, { model, resumeSession } = {}) {
  const args = [];
  if (model) args.push(...modelArgsFor(agent, model));
  if (resumeSession) {
    if (agent === 'omp' || agent === 'claude') args.push('-r', resumeSession);
    else if (agent === 'codex') args.push('resume', resumeSession);
  }
  return args;
}

/**
 * Map psu's repeated `--add-dir <dir>` onto each backend's native flag. claude
 * AND codex both expose `--add-dir` (extra tool-accessible directories); omp has
 * no equivalent → [] (the launch path warns so the user isn't surprised). Pure —
 * exported for tests.
 *
 * Emits the single-`=` token form (`--add-dir=<dir>`), NOT the space form: claude's
 * `--add-dir` is VARIADIC, so a space-form value at the end of the argv would
 * greedily swallow whatever followed (e.g. a `--` passthrough token). The `=` form
 * binds exactly one value per occurrence — the same greed-guard reason
 * NATIVE_SCHEDULER_DENY_FLAG is one `=` token. clap (codex) accepts `=` too.
 */
export function addDirArgs(agent, dirs = []) {
  if (!dirs.length) return [];
  if (agent === 'claude' || agent === 'codex') return dirs.map((d) => `--add-dir=${d}`);
  return [];
}

export function forkUnsupportedMessage(agent) {
  return (
    `psu: --fork is not supported for ${agent} sessions; ${agent} has no native branch command. ` +
    `To branch safely, write a brief/transcript excerpt and launch a new ${agent} session with ` +
    `\`psu --agent=${agent} --launch-context=<brief.md>\` plus the same workspace/harness/plan flags as needed, ` +
    `or re-run without --fork to resume in place. psu will not silently append to the original when a fork was requested.`
  );
}

/**
 * Native-scheduler lockout (native-scheduler-lockout-2026-06-09 D-001/D-002):
 * AGENT sessions (role panes + the brain/Queen) lose claude-code's own
 * scheduling surfaces — Cron* tools, ScheduleWakeup, the schedule/loop
 * skills, and Bash-reachable OS schedulers — so a wake can only live in the
 * harness routines table (the one scheduler Pause/`hive:status`/the liveness
 * backstop can see). The human `psu su` session keeps them (D-003).
 *
 * MUST stay one `=` token: the flag is variadic and the space form greedily
 * eats every following argv element. This plain-node script can't import TS,
 * so the literal mirrors NATIVE_SCHEDULER_DENY + OS_SCHEDULER_BASH_DENY in
 * `@papercusp/orchestrator/native-scheduler-deny`; the lockstep test in
 * `lib/psu-launcher.test.ts` pins the two copies together. Exported for tests.
 */
export const NATIVE_SCHEDULER_DENY_FLAG =
  '--disallowedTools=CronCreate,CronDelete,CronList,ScheduleWakeup,Skill(schedule),Skill(loop),Bash(crontab:*),Bash(systemd-run:*),Bash(batch:*)';

/**
 * Subagent-fanout deny (owner request 2026-07-01): AGENT role/bee sessions
 * lose the built-in subagent-launch tool — unconditional, no opt-out, mirrors
 * the native-scheduler lockout's posture for role sessions. `Task` is the
 * pre-rename name (verified vs claude 2.1.158); `Agent` is the name as of
 * 2.1.198 — re-verifying live found the `Task`-only form had become a silent
 * no-op (a spawned Agent-tool subagent still ran), so both are carried.
 * `Workflow` (added 2026-07-05) is the SEPARATE multi-agent orchestration tool —
 * a subagents-denied `psu --resume` session still fanned out via it because the
 * deny listed only Task/Agent; it is a distinct top-level tool, so it's denied
 * explicitly too. A
 * SEPARATE `--disallowedTools=` token from NATIVE_SCHEDULER_DENY_FLAG
 * (verified live: claude unions repeated `--disallowedTools` occurrences) so
 * this doesn't disturb that flag's own lockstep-pinned literal. MUST stay one
 * `=` token — same greed-guard reason as NATIVE_SCHEDULER_DENY_FLAG. The
 * literal mirrors `NO_SUBAGENT_TOOLS_DENY` in
 * `@papercusp/orchestrator/no-subagent-deny`; the lockstep test in
 * `lib/psu-launcher.test.ts` pins the two copies together. Exported for tests.
 *
 * DENIED BY DEFAULT for every psu launch (su + role + resume) as of the
 * 2026-07-02 owner mandate — `--allow-subagents` is the explicit opt-IN that
 * KEEPS the tool for a launch (also surfaced as a psu picker toggle + a
 * `fleet:launch-on-plan { allowSubagents }` arg). No longer follows the
 * native-scheduler-lockout D-003 human-keeps-it carve-out.
 */
export const NO_SUBAGENTS_DENY_FLAG = '--disallowedTools=Task,Agent,Workflow';

/**
 * EI-3294 known-risk warning: an opted-in subagent (Task/Agent tool) session
 * running on the DEFAULT (no-gateway, direct local OAuth) account route died
 * with 401 "Please run /login" after 12-39 tool calls, while the PARENT
 * session kept working fine (repro: su-7c7f465d, 2026-06-24). Root cause
 * (unconfirmed against Anthropic's closed-source CLI — no repro access from
 * a papercusp-denied session — but consistent with the evidence): the
 * built-in Task/Agent tool's spawned subagents likely run long enough to
 * cross the local OAuth token's refresh/rotation window, and either don't
 * share the parent's refresh or race it (a rotating refresh can invalidate
 * the token a subagent is still holding) — a client-side behavior papercusp
 * does not control. Gateway-routed sessions (`--account auto` / a pinned
 * pool account) sidestep this ENTIRELY: the CLI holds a static
 * `ANTHROPIC_AUTH_TOKEN` placeholder that never expires (spawn-env.ts
 * `gatewaySpawnEnv` — the gateway does the real OAuth server-side), so a
 * long-running subagent can't hit a client-side refresh race. Subagents are
 * DENIED BY DEFAULT fleet-wide (owner mandate 2026-07-02) specifically
 * because of this class of unreliable behavior, so most sessions never hit
 * this — this warning only fires for the explicit opt-in
 * (`--allow-subagents`) combined with the default (non-gateway) account
 * route, i.e. exactly the untested combination. Non-fatal: prints once and
 * proceeds — account routing is the OWNER's call (su playbook: never
 * silently switch it), so this only surfaces the tradeoff, never changes it.
 * Full writeup: agent-insights doc `task-tool-subagent-401-on-default-account`.
 */
export function subagentGatewayRiskNotice(agent, allowSubagents, envelopeEnv) {
  if (agent !== 'claude' || !allowSubagents) return null;
  if (envelopeEnv?.PAPERCUSP_ACCOUNT_ROUTING_MODE !== 'default') return null;
  return (
    'psu: WARNING — subagents are enabled on the default (non-gateway) account route. ' +
    'A long-running Task/Agent subagent can die with a 401 "Please run /login" while the ' +
    'parent session keeps working (EI-3294) — a known Claude-Code-CLI local-OAuth-refresh risk that ' +
    'gateway routing (`--account auto` or a pinned pool account) sidesteps. Not auto-switching your ' +
    'account route (that choice is yours) — just flagging it before you rely on subagent output.'
  );
}

/**
 * Owner-desktop-notification lockout (owner directive 2026-07-14): agents were
 * hand-firing `notify-send` popups at the owner's desktop. Deny the easy Bash
 * paths (bare name + the absolute paths that would trivially bypass the
 * ~/.papercusp/bin PATH shim) on EVERY claude launch — su + role + resume,
 * unconditional, no opt-out (claude unions repeated --disallowedTools
 * occurrences, so this composes with the other deny flags). Layered with the
 * PATH shim (all backends, compound forms) + the root-CLAUDE.md standing rule
 * (route human-facing alerts via coord:escalate / notifyAttention). MUST stay
 * one `=` token — same greed-guard reason as NATIVE_SCHEDULER_DENY_FLAG. The
 * literal mirrors `OWNER_DESKTOP_NOTIFY_BASH_DENY` in
 * `@papercusp/orchestrator/owner-desktop-notify-deny`; the lockstep test in
 * `lib/psu-launcher.test.ts` pins the two copies together. Exported for tests.
 */
export const OWNER_DESKTOP_NOTIFY_DENY_FLAG =
  '--disallowedTools=Bash(notify-send:*),Bash(/usr/bin/notify-send:*),Bash(/bin/notify-send:*)';
export const BRAIN_TOMBSTONE_MESSAGE =
  'psu: --brain is deprecated and no longer launches a pinned brain session. Use the live operator/sentinel converse surface or a normal `psu` session.';

/**
 * Per-backend args for an interactive ROLE session — exec the raw CLI
 * (NOT the *-su wrapper, which bakes the engineer playbook + superuser
 * MCP) with the role prompt as system prompt + the signed role-scoped
 * `.mcp.json`. Pure — exported for tests.
 *
 * claude gets `--strict-mcp-config` so it's restricted to ONLY the
 * role-scoped server (true tool-scoping); omp path-discovers the cwd's
 * `.mcp.json`. codex has no --mcp-config / --append-system-prompt flags,
 * so bootstrap-role mints a per-session CODEX_HOME (AGENTS.md = role
 * prompt, config.toml = role-scoped MCP) and exports it via
 * `envelopeEnv.CODEX_HOME`; the launcher just execs `codex` with the
 * approvals/sandbox bypass Papercusp still uses for managed Codex launches
 * until the MCP-under-sandbox path has a fresh live smoke on the current CLI
 * (mirrors the codex-su wrapper).
 */
export function roleLaunchArgs(backend, { promptFile, mcpJsonPath, coordExtPath, injectHookPath, nativeSessionId, replaceClaudeBase, allowSubagents, model } = {}) {
  if (backend === 'claude') {
    // domain-generic-agent-personas-2026-06-17 P-014 (REPLACE_CLAUDE_BASE, default-off):
    // mirror suLaunchArgs — when armed, the role prompt REPLACES the Claude coding base
    // (--system-prompt-file + --exclude-dynamic-system-prompt-sections) so an interactive
    // role session runs on OUR base too (coherent with the fleet + su/brain paths). Flag-off
    // ⇒ --append-system-prompt-file, byte-identical to today.
    const systemPromptArgs = replaceClaudeBase
      ? ['--system-prompt-file', promptFile, '--exclude-dynamic-system-prompt-sections']
      : ['--append-system-prompt-file', promptFile];
    return {
      bin: 'claude',
      args: [
        '--dangerously-skip-permissions',
        ...systemPromptArgs,
        '--mcp-config', mcpJsonPath,
        '--strict-mcp-config',
        // Force the spec-minted session id (mirrors suLaunchArgs) so `psu --resume`
        // and wake-executor resume the EXACT conversation, not `--continue`'s
        // most-recent-in-cwd (a random peer on the shared tree). claude-only.
        ...(nativeSessionId ? ['--session-id', nativeSessionId] : []),
        '--permission-mode', 'bypassPermissions',
        // Agent sessions must schedule ONLY via the harness routines table —
        // never claude's own cron/schedule/loop surfaces (D-001).
        NATIVE_SCHEDULER_DENY_FLAG,
        // Owner-desktop notify-send lockout (owner directive 2026-07-14).
        OWNER_DESKTOP_NOTIFY_DENY_FLAG,
        // Subagent-launch (Task/Agent) is DENIED BY DEFAULT (owner mandate
        // 2026-07-02) — a role/bee never fans out via its own subagent tool
        // unless the launch explicitly opts in (`--allow-subagents`). See
        // NO_SUBAGENTS_DENY_FLAG's doc comment.
        ...(allowSubagents ? [] : [NO_SUBAGENTS_DENY_FLAG]),
        // P-019/D-007 (voice-public-release-readiness-2026-07-12): role sessions
        // previously NEVER emitted model argv — `psu --role=papercup --model=sonnet:medium`
        // silently dropped the spec (only PAPERCUSP_MODEL env was exported, which the
        // CLI ignores), so the "fast" voice pane came up on the box's saved default
        // (Opus) — the root cause behind the heavy-pane "Agent did not respond" class.
        // Same effort-splitting rules as the su flow (modelArgsFor). NOTE: the omp/codex
        // role branches below still lack model argv (claude-minimal for P-019).
        ...modelArgsFor('claude', model),
      ],
    };
  }
  if (backend === 'omp') {
    // omp path-discovers <cwd>/.mcp.json; --append-system-prompt takes a file path.
    // -e loads the coordination extension (lock enforcement + coord + the activity
    // bridge port) when one is supplied — a role omp session is a worker that edits
    // files + whose activity belongs in the fleet view, so it gets the same hook the
    // su omp launch + role codex/claude do. (claude/codex role hooks are user-level /
    // baked; omp's is the `-e` module.)
    // P-014: --system-prompt (replace) when REPLACE_CLAUDE_BASE armed, else --append.
    const args = [
      '--approval-mode', 'yolo',
      // weak-model-tool-tier: strip the `lsp` builtin. A weak ornith model reaches for
      // lsp/read to try to INVOKE MCP tools (session 9885 abused `lsp` as a tools:call
      // wrapper before recovering); lsp is pure code-intelligence a coordination worker
      // never needs, so dropping it deletes one tool-call attractor. The other attractor,
      // `eval`, is a REAL omp shell builtin (NOT hallucinated as this comment long claimed)
      // and the WORST offender — ornith DOOM-LOOPED on it 56-80× (sessions 10234/10239)
      // despite the coord-hook block + an escalating steer; message-based fixes can't break
      // the reflex, so it is disabled at the omp-config layer instead (eval.py/eval.js=false,
      // ensureOmpAgentToolTierConfig in ensure-omp-su.ts / WI-2382) and never reaches the
      // surface. The kickoff tools:invoke escape hatch remains the positive redirect.
      '--no-lsp',
      replaceClaudeBase ? '--system-prompt' : '--append-system-prompt', promptFile,
      ...modelArgsFor('omp', model),
    ];
    if (coordExtPath) args.push('-e', coordExtPath);
    // omp-context-injection-parity-2026-08-09 P-003: turn-start + mid-turn
    // context injection, the omp half of what claude gets from its
    // UserPromptSubmit/PostToolBatch hooks. STRICTLY ADDITIVE — one more module
    // alongside the coord extension, no model and no routing touched, so
    // psu->omp keeps launching on OMP's own default config and the owner still
    // picks the model interactively [owner 2026-06-29].
    // `--hook` and `-e` are the SAME loader in omp (main.ts:1049 merges both
    // into additionalExtensionPaths); both flags are repeatable and accumulate,
    // so this appends to — never replaces — any hook the user already has.
    if (injectHookPath) args.push('--hook', injectHookPath);
    return { bin: 'omp', args };
  }
  if (backend === 'codex') {
    // CODEX_HOME (with AGENTS.md + role-scoped config.toml + lock-hook
    // settings.json) is supplied via envelopeEnv.
    // --dangerously-bypass-hook-trust runs the home's SU-locks hooks (P-030;
    // the only hooks there are ours). The approvals/sandbox bypass remains the
    // managed-launch default until the current Codex MCP-under-sandbox path has
    // a live Papercusp smoke; the orchestrator fleet path wraps Codex externally.
    return {
      bin: 'codex',
      args: [
        '--dangerously-bypass-hook-trust',
        '--dangerously-bypass-approvals-and-sandbox',
        ...modelArgsFor('codex', model),
      ],
    };
  }
  throw new Error(`roleLaunchArgs: backend '${backend}' has no interactive role launch`);
}

/**
 * Raw-CLI launch args for a SUPERUSER (`su`) session — the engineer/
 * collaborator path. Pure — exported for tests. The su counterpart to
 * `roleLaunchArgs`: same raw backends, but the prompt is the engineer
 * playbook (`buildLaunchSpec({kind:'su'})`).
 *
 * MCP is USER-LEVEL for claude + omp and survives a raw launch (the Phase 0
 * finding) — claude's `papercusp-su` lives in `~/.claude.json` (its url
 * env-expands `${PAPERCUSP_SID}`, so per-session identity flows once psu
 * exports the SID), omp's in `~/.omp/agent/mcp.json`. So psu supplies NO
 * `--mcp-config`: it would double the `papercusp-su` server. This also
 * realizes D-005 (su keeps its FULL toolkit — every user server loads, not
 * just papercusp) more directly than `--mcp-config` + non-strict would.
 *
 * Lock-hook enforcement is likewise USER-LEVEL for claude (Pre/PostToolUse
 * in `~/.claude/settings.json`); omp loads it as a module via `-e`
 * (P-021, `~/.papercusp/papercusp-coord.ts`). codex is the only one whose
 * MCP + hooks are NOT user-level — it has no --mcp-config/-e/-prompt flag,
 * so a per-session CODEX_HOME is minted server-side (P-030: AGENTS.md =
 * playbook, config.toml = superuser MCP w/ bearer, settings.json = lock
 * hooks) and supplied via `envelopeEnv.CODEX_HOME`; the launcher execs
 * `codex` with `--dangerously-bypass-hook-trust` (the home's only hooks are
 * ours) + the approvals/sandbox bypass Papercusp still uses for managed
 * Codex launches pending a current MCP-under-sandbox live smoke.
 */
export function suLaunchArgs(backend, { promptFile, coordExtPath, injectHookPath, nativeSessionId, replaceClaudeBase, allowSubagents } = {}) {
  if (backend === 'claude') {
    // domain-generic-agent-personas-2026-06-17 P-014 (REPLACE_CLAUDE_BASE, default-off):
    // when armed, the playbook REPLACES the Claude coding base (--system-prompt-file +
    // --exclude-dynamic-system-prompt-sections to drop the residual env block) instead of
    // appending to it. Flag-off ⇒ --append-system-prompt-file, byte-identical to today.
    const systemPromptArgs = replaceClaudeBase
      ? ['--system-prompt-file', promptFile, '--exclude-dynamic-system-prompt-sections']
      : ['--append-system-prompt-file', promptFile];
    return {
      bin: 'claude',
      args: [
        '--dangerously-skip-permissions',
        ...systemPromptArgs,
        // Force the session id bootstrap-su recorded so `psu --resume <uuid>`
        // can correlate this session to its adv row — and resume the EXACT
        // session, not `--continue`'s most-recent-in-cwd. claude-only (omp/codex
        // pass null; they don't take a forced session id).
        ...(nativeSessionId ? ['--session-id', nativeSessionId] : []),
        // No --mcp-config: claude's papercusp-su is user-level (~/.claude.json)
        // and survives a raw launch; adding it would duplicate the server.
        '--permission-mode', 'bypassPermissions',
        // Subagent-launch (Task/Agent) DENIED BY DEFAULT (owner mandate 2026-07-02);
        // `--allow-subagents` opts THIS su launch back IN. See NO_SUBAGENTS_DENY_FLAG.
        ...(allowSubagents ? [] : [NO_SUBAGENTS_DENY_FLAG]),
        // Owner-desktop notify-send lockout (owner directive 2026-07-14) —
        // unconditional, su sessions included (an su agent fired the popups).
        OWNER_DESKTOP_NOTIFY_DENY_FLAG,
      ],
    };
  }
  if (backend === 'omp') {
    // omp's papercusp-su is user-level (~/.omp/agent/mcp.json);
    // --append-system-prompt takes a file path; -e loads the coordination
    // extension (P-021) for lock enforcement when one is provided.
    // P-014: --system-prompt (replace) when REPLACE_CLAUDE_BASE armed, else --append.
    const args = [
      '--approval-mode', 'yolo',
      // weak-model-tool-tier: strip the `lsp` builtin. A weak ornith model reaches for
      // lsp/read to try to INVOKE MCP tools (session 9885 abused `lsp` as a tools:call
      // wrapper before recovering); lsp is pure code-intelligence a coordination worker
      // never needs, so dropping it deletes one tool-call attractor. The other attractor,
      // `eval`, is a REAL omp shell builtin (NOT hallucinated as this comment long claimed)
      // and the WORST offender — ornith DOOM-LOOPED on it 56-80× (sessions 10234/10239)
      // despite the coord-hook block + an escalating steer; message-based fixes can't break
      // the reflex, so it is disabled at the omp-config layer instead (eval.py/eval.js=false,
      // ensureOmpAgentToolTierConfig in ensure-omp-su.ts / WI-2382) and never reaches the
      // surface. The kickoff tools:invoke escape hatch remains the positive redirect.
      '--no-lsp',
      replaceClaudeBase ? '--system-prompt' : '--append-system-prompt', promptFile,
    ];
    if (coordExtPath) args.push('-e', coordExtPath);
    // omp-context-injection-parity-2026-08-09 P-003: turn-start + mid-turn
    // context injection, the omp half of what claude gets from its
    // UserPromptSubmit/PostToolBatch hooks. STRICTLY ADDITIVE — one more module
    // alongside the coord extension, no model and no routing touched, so
    // psu->omp keeps launching on OMP's own default config and the owner still
    // picks the model interactively [owner 2026-06-29].
    // `--hook` and `-e` are the SAME loader in omp (main.ts:1049 merges both
    // into additionalExtensionPaths); both flags are repeatable and accumulate,
    // so this appends to — never replaces — any hook the user already has.
    if (injectHookPath) args.push('--hook', injectHookPath);
    return { bin: 'omp', args };
  }
  if (backend === 'codex') {
    // codex has no --system-prompt flag: its system prompt IS the per-session
    // CODEX_HOME AGENTS.md (the playbook), so codex already carries no Claude base —
    // REPLACE_CLAUDE_BASE is a no-op here (nothing to switch from append to replace).
    return { bin: 'codex', args: ['--dangerously-bypass-hook-trust', '--dangerously-bypass-approvals-and-sandbox'] };
  }
  throw new Error(`suLaunchArgs: backend '${backend}' has no interactive su launch`);
}

/**
 * improve-fleet-launch-autokickoff (EI-5503): the TRAILING POSITIONAL kickoff arg(s)
 * to append to the backend CLI argv — the first user turn that makes a SCRIPTED plan
 * launch (a fleet/automation member) start working the plan immediately instead of
 * orienting once and parking idle. All three backends take a positional prompt that
 * keeps the session interactive (claude `[prompt]`, omp `… "prompt"`, codex `[PROMPT]`),
 * so this is the same for every agent.
 *
 * Empty (today's behavior) unless ALL hold: the server supplied `res.kickoffPrompt`
 * (a plan is bound) · this is a `--no-picker` launch (`args.picker === false`) so an
 * interactive human picker launch still opens at an empty prompt · `--no-kickoff` was
 * not passed (`args.kickoff !== false`). Pure — exported for tests.
 */
/**
 * turn-provenance P-002 (turn-provenance-owner-vs-agent-2026-07-11): envelope +
 * ledger-tag a SCRIPTED kickoff first turn so the session's UserPromptSubmit
 * hook classifies it as verified agent-origin (`fleet-kickoff`), never owner
 * input. MIRROR of packages/operator-core/lib/turn-provenance/turn-provenance.ts
 * (the launcher is plain node and cannot import the TS module) — keep the
 * envelope format + JSONL row shape in lockstep. Fail-soft: any error returns
 * the untagged text (the turn then classifies owner/unverified — visible, and
 * never a broken launch). No-sid launches (interactive, untracked) stay untagged.
 */
export function tagKickoffProvenance(text, sid, env = process.env, nowMs = Date.now()) {
  try {
    if (!text || !sid) return text;
    const nonce = randomBytes(8).toString('hex');
    const sha256 = createHash('sha256')
      .update(String(text).replace(/\r\n?/g, '\n').trim(), 'utf8')
      .digest('hex');
    const dir = env.PAPERCUSP_TURN_PROVENANCE_DIR || join(homedir(), '.papercusp', 'turn-provenance');
    mkdirSync(dir, { recursive: true });
    const safe = String(sid).replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 200);
    // Ledger row FIRST, then the tagged text (the hook classifies at prompt-submit).
    writeFileSync(
      join(dir, `${safe}.jsonl`),
      JSON.stringify({ sid, nonce, origin: 'fleet-kickoff', sha256, ts: nowMs }) + '\n',
      { flag: 'a' },
    );
    return `⟦turn-origin:fleet-kickoff nonce:${nonce}⟧\n${text}`;
  } catch {
    return text;
  }
}

export function kickoffPositionalArgs(res, args) {
  // A client-supplied free-form `--kickoff='<text>'` wins over the server's
  // plan-derived kickoff (res.kickoffPrompt) — it's the general "start by working
  // THIS prompt" seam (no plan required), used by the tutorial docs-agent launcher.
  const text = args?.kickoffPromptText || res?.kickoffPrompt;
  if (!text) return [];
  if (args?.picker !== false) return []; // interactive picker launch → empty prompt
  if (args?.kickoff === false) return []; // explicit --no-kickoff opt-out
  return [text];
}

/**
 * The free-form first-turn text for a launch, with the SPAWN-SAFE env fallback:
 * an explicit `--kickoff=<text>` flag wins, else `PAPERCUSP_KICKOFF_PROMPT` from
 * the environment (else null → no kickoff). The env var is how the desktop
 * tutorial's docs-agent launcher delivers the question: a `--kickoff=<text>`
 * VALUE inside a console greetingCmd gets DOUBLE-single-quoted by
 * buildConsoleOneliner and breaks the shell (the gnome-terminal exit-2 the
 * docs-agent hit), whereas an env value is exported via a correctly-escaped
 * `export K=…` in the oneliner prelude and arrives intact (multiline / embedded
 * quotes included). Pure — exported for tests.
 */
export function resolveKickoffText(args, env = process.env) {
  return args?.kickoffPromptText || env?.PAPERCUSP_KICKOFF_PROMPT || null;
}

/**
 * Finish a fresh ROLE launch argv with the same scripted first-turn seam used by
 * fresh SU launches. Role launches used to stop after flags/passthrough, so a
 * headless acceptance judge could inherit PAPERCUSP_KICKOFF_PROMPT yet open at
 * an empty prompt forever. Keep the positional prompt last (after every flag),
 * tag it as machine-origin, and expose whether a turn was actually seeded so
 * the caller can report the launch honestly. Pure except for the existing
 * provenance-ledger write performed by tagKickoffProvenance.
 *
 * @param {any[]} launchArgs
 */
export function finalizeFreshRoleArgs(backend, launchArgs, res, args, env = process.env) {
  const baseArgs = [
    ...launchArgs,
    ...addDirArgs(backend, args?.addDir || []),
    ...(args?.passthrough || []),
  ];
  const kickoffArgs = kickoffPositionalArgs(res, {
    ...args,
    kickoffPromptText: resolveKickoffText(args, env),
  });
  if (!kickoffArgs.length) return { args: baseArgs, kickoffSeeded: false };

  const sidForTag = res?.envelopeEnv?.PAPERCUSP_SID || env?.PAPERCUSP_SID || null;
  return {
    args: [
      ...baseArgs,
      ...kickoffArgs.map((text) => tagKickoffProvenance(text, sidForTag, env)),
    ],
    kickoffSeeded: true,
  };
}

/**
 * The kickoff text for a RESUME / FORK launch, under the SAME gating as the
 * fresh path (scripted `--no-picker` only, honors `--no-kickoff`) — but with no
 * server-supplied plan kickoff to fall back on, because a resume does no
 * bootstrap POST. Null ⇒ the resumed session opens idle, exactly as before.
 *
 * A resume cannot deliver its first turn the way a fresh launch does: the CLI's
 * positional-prompt seam belongs to a NEW session, and a session that just came
 * back from the dead is unreachable through the roster (coord:wake / coord:send
 * answer `unknown_recipient` — its presence rows were reaped at death). So the
 * text is handed to the managed-pty host, which injects it as a turn once the
 * child settles at its prompt (agent-launch-resume-primitives P-011/D-008 —
 * live-proven on the two desktop-release-0-0-8 legs, 2026-07-12). Pure —
 * exported for tests.
 */
export function resumeKickoffText(args, env = process.env) {
  const [text] = kickoffPositionalArgs({}, { ...args, kickoffPromptText: resolveKickoffText(args, env) });
  return text ?? null;
}

/**
 * Per-agent resume command — RAW CLI (no `*-su` wrapper, P-042). Pure —
 * exported for tests. Returns the raw `bin` + resume args, re-supplying the
 * same launch flags the fresh-launch path uses (the wrappers used to bake
 * these). Semantics: claude/omp continue the most recent conversation in the
 * session's cwd (omp targets an exact thread when one was captured); codex
 * resumes its most recent session from its per-session CODEX_HOME (set by the
 * caller via env — derived from the session id, which still holds that
 * session's history).
 *
 * MCP + (claude) lock hooks are user-level → survive a raw resume. omp re-adds
 * the coordination extension via `-e <coordExtPath>` (per-invocation, not saved
 * in the thread). codex re-supplies its bypass flags; its hooks/MCP live in the
 * CODEX_HOME the caller points at.
 */
/**
 * Path to the omp CONTEXT-INJECTION hook, or undefined when it should not be
 * passed (omp-context-injection-parity-2026-08-09 P-003). Pure apart from the
 * existsSync probe; exported for tests.
 *
 * Mirrors the coord-extension resolution directly above its call sites: a
 * stable installed path, added ONLY when the file is actually there, so a box
 * that has not run the installer launches exactly as it does today instead of
 * failing on a missing --hook target.
 *
 * omp ONLY. claude gets this via its own UserPromptSubmit/PostToolBatch hooks
 * and codex via its own config; passing --hook to either is meaningless.
 */
export function resolveOmpInjectHookPath(agent, home = homedir()) {
  if (agent !== 'omp') return undefined;
  const hook = join(home, '.papercusp', 'hooks', 'omp', 'inject-hook.ts');
  return existsSync(hook) ? hook : undefined;
}

export function resumeArgsFor(session, { coordExtPath, injectHookPath, fork = false, forkSessionId = null, addDir = [], allowSubagents, model = null } = {}) {
  // --fork is native for claude and codex; omp has no branch-the-session flag,
  // and silently appending to the original would be the very clobber the user asked
  // to avoid. Refuse loudly instead.
  if (fork && session.agent !== 'claude' && session.agent !== 'codex') {
    throw new Error(forkUnsupportedMessage(session.agent));
  }
  // `session.sessionId` is the agent's NATIVE session id (a UUID) when known —
  // set for store-found (untracked) sessions, so we resume that EXACT session.
  // Without it (tracked rows don't carry the native id) we fall back to the
  // agent's "most-recent-in-cwd" resume.
  if (session.agent === 'claude') {
    const resume = session.sessionId ? ['--resume', session.sessionId] : ['--continue'];
    // --fork-session: branch the resumed conversation into a NEW session id, leaving
    // the original's id + transcript untouched (so the fork is safe to run alongside it).
    // `--session-id <forkSessionId>` FORCES that new id to one psu pre-minted (a
    // tracked fork — launchTrackedFork) so the fork is resumable from the picker, not
    // only by raw uuid. The plain `--session-id`/`--resume` conflict is LIFTED by
    // --fork-session (verified: claude accepts the trio), so only emit the forced id
    // alongside --fork-session.
    const forkFlag = fork
      ? ['--fork-session', ...(forkSessionId ? ['--session-id', forkSessionId] : [])]
      : [];
    // Subagent-launch (Task/Agent) DENIED BY DEFAULT (owner mandate 2026-07-02).
    // CLI flags don't persist into a resume, so re-arm the deny every resume —
    // unless this resume explicitly opts in (`psu --resume … --allow-subagents`).
    // `--model`/`--effort` are top-level claude flags — a resume honors them like a
    // fresh launch (WI-3758: model select on resume).
    return { bin: 'claude', args: [...resume, '--dangerously-skip-permissions', '--permission-mode', 'bypassPermissions', ...(allowSubagents ? [] : [NO_SUBAGENTS_DENY_FLAG]), OWNER_DESKTOP_NOTIFY_DENY_FLAG, ...forkFlag, ...addDirArgs('claude', addDir), ...modelArgsFor('claude', model)] };
  }
  if (session.agent === 'omp') {
    const args = session.ompThreadId ? ['-r', session.ompThreadId] : ['-c'];
    args.push('--approval-mode', 'yolo');
    if (coordExtPath) args.push('-e', coordExtPath);
    // omp-context-injection-parity P-003. CLI flags do not persist into an omp
    // resume, so the injection hook must be re-passed every resume exactly like
    // the coord extension above — otherwise a resumed session silently loses
    // turn-start/mid-turn context while a fresh one has it.
    if (injectHookPath) args.push('--hook', injectHookPath);
    if (model) args.push(...modelArgsFor('omp', model));
    return { bin: 'omp', args };
  }
  if (session.agent === 'codex') {
    // Bypass flags + model + any --add-dir BEFORE the `resume` subcommand (all
    // top-level codex options — `-m`/`-c` AFTER the subcommand would be parsed as
    // resume's own args and fail; WI-3758). CODEX_HOME (the session's home) is set
    // by the caller. `resume <uuid>` / `fork <uuid>` (UUIDs take precedence) for an
    // exact session; `resume --last` / `fork --last` otherwise.
    const subcommand = fork ? 'fork' : 'resume';
    const target = session.sessionId ? [subcommand, session.sessionId] : [subcommand, '--last'];
    return { bin: 'codex', args: ['--dangerously-bypass-hook-trust', '--dangerously-bypass-approvals-and-sandbox', ...modelArgsFor('codex', model), ...addDirArgs('codex', addDir), ...target] };
  }
  throw new Error(`resumeArgsFor: unknown agent: ${session.agent}`);
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function safeReaddir(dir) {
  try { return readdirSync(dir, { withFileTypes: true }); } catch { return []; }
}

/**
 * The per-session isolated `CLAUDE_CONFIG_DIR` root + dir for a tracked claude
 * session, keyed by its coord owner id — the .mjs mirror of the TS helper
 * `@papercusp/orchestrator/session-launch-dirs` `sessionClaudeConfigDir` (EI-155).
 *
 * An interactive claude session launches with `CLAUDE_CONFIG_DIR` pointed here
 * (bootstrap-su/role → writeInteractiveClaudeConfig), so it writes its transcript
 * under `<dir>/projects/**` — NOT the shared `~/.claude`. Every resume reader
 * (launchResume, claudeStoreHasSession, findUntrackedSession) must therefore look
 * here, or `claude --resume <uuid>` finds nothing. Pure — `home` for tests; honors
 * the same `PAPERCUSP_SESSION_CLAUDE_DIR` override the materializer uses.
 */
function sessionClaudeRoot(home = homedir()) {
  return process.env.PAPERCUSP_SESSION_CLAUDE_DIR || join(home, '.papercusp', 'session-claude');
}
function sessionClaudeConfigDir(ownerId, home = homedir()) {
  return join(sessionClaudeRoot(home), ownerId);
}

/** First `"cwd":"…"` in a session jsonl (claude events + codex rollout meta both
 *  carry it), so we recover the launch dir WITHOUT knowing where it started. */
function cwdFromSessionFile(file) {
  try {
    const m = readFileSync(file, 'utf8').match(/"cwd"\s*:\s*"((?:[^"\\]|\\.)*)"/);
    return m ? JSON.parse(`"${m[1]}"`) : null;
  } catch { return null; }
}

/** Recursively find the codex rollout file whose name ends with `-<id>.jsonl`. */
function findCodexRollout(root, id) {
  for (const e of safeReaddir(root)) {
    const p = join(root, e.name);
    if (e.isDirectory()) { const hit = findCodexRollout(p, id); if (hit) return hit; }
    else if (e.name.endsWith(`-${id}.jsonl`)) return p;
  }
  return null;
}

/**
 * Does this codex sessions root hold ANY rollout at all — i.e. would `codex resume --last`
 * find something? The by-uuid sibling {@link findCodexRollout} cannot answer for a row with
 * no recorded `session_id`, and that is the majority case: measured 2026-08-12, 127 of the
 * 241 most recent codex rows had no session_id AND no rollout on disk (128 had no CODEX_HOME
 * directory at all). Those are launches that died before persisting a first turn, and the
 * picker offered every one of them because "no id to check" was read as "assume resumable".
 * Exported for tests.
 */
export function codexHomeHasAnyRollout(root) {
  for (const e of safeReaddir(root)) {
    const p = join(root, e.name);
    if (e.isDirectory()) { if (codexHomeHasAnyRollout(p)) return true; }
    else if (e.name.endsWith('.jsonl')) return true;
  }
  return false;
}

function findOmpTranscript(root, id) {
  for (const entry of safeReaddir(root)) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      const hit = findOmpTranscript(path, id);
      if (hit) return hit;
    } else if (entry.name.endsWith(`_${id}.jsonl`)) {
      return path;
    }
  }
  return null;
}

function trackedCodexSessionsRoot(session, home = homedir()) {
  if (session.id == null) return null;
  return join(home, '.papercusp', 'su-codex-homes', `session-${session.id}`, 'sessions');
}

/**
 * WI-3884: scan ALL tracked per-session CODEX_HOMEs
 * (`~/.papercusp/su-codex-homes/session-<advId>/sessions`) for a rollout uuid.
 * resolveTrackedResumeSession only scans the homes of the RESUMABLE WINDOW
 * (/api/adv/sessions/resumable, default 30 rows) — a tracked codex session
 * older than that window is invisible to it, and findUntrackedSession's codex
 * branch only searched the SHARED ~/.codex/sessions store (owner-hit live:
 * psu #11582 / rollout 019f4d46…). The dir name recovers the adv session id,
 * and the hit's home is REQUIRED for the resume — the rollout is invisible to
 * codex under any other CODEX_HOME. Returns
 * `{ advSessionId, codexHome, rollout }` or null. Exported for tests.
 */
export function findTrackedCodexHomeRollout(id, { home = homedir() } = {}) {
  if (!id) return null;
  const root = join(home, '.papercusp', 'su-codex-homes');
  for (const d of safeReaddir(root)) {
    if (!d.isDirectory() || !d.name.startsWith('session-')) continue;
    const rollout = findCodexRollout(join(root, d.name, 'sessions'), id);
    if (!rollout) continue;
    const advSessionId = Number(d.name.slice('session-'.length));
    return {
      advSessionId: Number.isFinite(advSessionId) ? advSessionId : null,
      codexHome: join(root, d.name),
      rollout,
    };
  }
  return null;
}

/**
 * Resolve a direct `psu --resume <id>` against tracked adv_sessions rows.
 *
 * Claude records its native UUID at bootstrap, so `sessionId` is enough. OMP
 * learns its native thread id after launch via the coord hook, so match
 * `ompThreadId` too. Codex cannot be forced to a pre-minted id, but its rollout
 * UUID is persisted under the tracked row's isolated CODEX_HOME; when the user
 * passes that UUID, discover the owning row and graft the id onto the transient
 * session object so `resumeArgsFor` can emit `codex resume <uuid>` while
 * `launchResume` still restores that row's CODEX_HOME.
 */
export function resolveTrackedResumeSession(sessions, id, { home = homedir() } = {}) {
  if (!id) return null;
  const wanted = String(id);
  const direct = sessions.find(
    (s) =>
      String(s.id) === wanted ||
      (s.sessionId && s.sessionId === wanted) ||
      (s.ompThreadId && s.ompThreadId === wanted),
  );
  if (direct) return direct;

  if (!UUID_RE.test(wanted)) return null;
  for (const session of sessions) {
    if (session.agent !== 'codex') continue;
    const root = trackedCodexSessionsRoot(session, home);
    if (root && findCodexRollout(root, wanted)) {
      return { ...session, sessionId: wanted };
    }
  }
  return null;
}

/**
 * Find a session the user did NOT launch via psu, by searching each agent's
 * OWN session store for the id — NOT a filesystem crawl: claude keeps every
 * session under `~/.claude/projects/<dir>/<id>.jsonl`, codex under
 * `~/.codex/sessions/**​/rollout-*-<uuid>.jsonl`. The store IS the index, and
 * the matched file records its own `cwd`, so the launch dir falls out of it.
 * Returns `{ agent, sessionId|ompThreadId, cwd, untracked:true }` or null.
 * A UUID → claude/codex (whichever store has it); a non-UUID → an omp thread
 * name (resumed in the current dir, since omp's store isn't path-indexed here).
 * Pure-ish (reads FS); exported for tests.
 */
export function findUntrackedSession(id, { home = homedir(), cwd = process.cwd() } = {}) {
  if (!id) return null;
  if (UUID_RE.test(id)) {
    const claudeProjects = join(home, '.claude', 'projects');
    for (const d of safeReaddir(claudeProjects)) {
      if (!d.isDirectory()) continue;
      const f = join(claudeProjects, d.name, `${id}.jsonl`);
      if (existsSync(f)) return { agent: 'claude', sessionId: id, cwd: cwdFromSessionFile(f) || cwd, untracked: true };
    }
    // EI-155: interactive claude sessions write transcripts under per-session
    // isolated dirs (`<session-claude>/<owner>/projects`), not the shared store —
    // scan those too, so an isolated session whose adv row was pruned still
    // resolves by its native uuid (and carries its `configDir` so the resume
    // points CLAUDE_CONFIG_DIR back at it).
    //
    // EI-9756: a hit here is found ONLY because psu's own per-owner isolation
    // dir structure exists — a genuinely vanilla (non-psu) claude session can
    // never land under `session-claude/<owner>/`. So, exactly like the
    // WI-3884 tracked-CODEX_HOME case below, mark it `psuTracked` — the most
    // common reason this branch is reached at all is an ENDED session whose
    // adv row fell outside the (default 30-row) `/adv/sessions/resumable`
    // window, NOT an untracked/foreign session; the prior unconditional
    // "isn't linked to a tracked psu launch" warning was actively misleading
    // for that (very common) case and is exactly what the owner-reported
    // repro saw.
    const isoRoot = sessionClaudeRoot(home);
    for (const owner of safeReaddir(isoRoot)) {
      if (!owner.isDirectory()) continue;
      const configDir = join(isoRoot, owner.name);
      const projects = join(configDir, 'projects');
      for (const d of safeReaddir(projects)) {
        if (!d.isDirectory()) continue;
        const f = join(projects, d.name, `${id}.jsonl`);
        if (existsSync(f)) {
          return {
            agent: 'claude',
            sessionId: id,
            cwd: cwdFromSessionFile(f) || cwd,
            untracked: true,
            configDir,
            psuTracked: true,
          };
        }
      }
    }
    const codexRollout = findCodexRollout(join(home, '.codex', 'sessions'), id);
    if (codexRollout) return { agent: 'codex', sessionId: id, cwd: cwdFromSessionFile(codexRollout) || cwd, untracked: true };
    // WI-3884: a psu-TRACKED codex session OLDER than the resumable window
    // (default 30 rows) falls through to here — its adv row wasn't in the API
    // slice, so resolveTrackedResumeSession never scanned its home, and the
    // shared ~/.codex store above doesn't hold tracked rollouts. Scan the
    // tracked-home store itself: `id` (from the dir name) re-attaches the adv
    // row (reactivation on resume), `codexHome` points the resume at the ONLY
    // CODEX_HOME that can see this rollout, and `psuTracked` skips the
    // "not launched by psu" confirm (it WAS — the home carries the baked
    // config.toml + AGENTS.md, so nothing is lost on resume).
    const trackedHome = findTrackedCodexHomeRollout(id, { home });
    if (trackedHome) {
      return {
        agent: 'codex',
        sessionId: id,
        cwd: cwdFromSessionFile(trackedHome.rollout) || cwd,
        untracked: true,
        psuTracked: true,
        id: trackedHome.advSessionId,
        codexHome: trackedHome.codexHome,
      };
    }
    return null;
  }
  // Non-UUID → treat as an omp thread name; resume in the current dir.
  return { agent: 'omp', ompThreadId: id, cwd, untracked: true };
}

/**
 * Durable native-session-id → coordination-ownerId index — the fix for the
 * untracked-resume identity split (owner bug 2026-07-02): `psu --resume <uuid>`
 * on a session with no visible adv row fell through to findUntrackedSession,
 * which knows no coordOwnerId, so resumeEnvFor MINTED a fresh SID. The resumed
 * body then registered its pty host, took file locks, and answered presence
 * under the NEW sid while the fleet/coordination plane still addressed the OLD
 * one — orphaning fleet leadership and locks, and breaking wake/recolor
 * injection (findLiveHost looks for `<oldSid>.json`, which no longer exists).
 *
 * One file per native session id under `~/.papercusp/psu-session-owners/` so
 * concurrent launches never contend on a shared file. FIRST WRITE WINS: the
 * binding records the identity the session was BORN with; a later launch under
 * a different SID (the pre-fix bug, or any future drift) must not rebind it.
 * The psu-pty registry can't serve this purpose — its json is removed when the
 * host ends; these entries persist, and that durability is the point.
 */
export function sessionOwnersRoot(home = homedir()) {
  return join(home, '.papercusp', 'psu-session-owners');
}

/** Record `nativeSessionId → coordOwnerId` (first write wins; `wx` create keeps
 *  a concurrent double-launch to one winner). Never throws — an index miss only
 *  costs the old minted-SID behavior, so no launch is ever blocked on it. */
export function recordSessionOwner(nativeSessionId, coordOwnerId, { home = homedir(), advSessionId = null } = {}) {
  if (!nativeSessionId || !coordOwnerId) return false;
  const file = join(sessionOwnersRoot(home), String(nativeSessionId));
  try {
    if (existsSync(file)) return false;
    mkdirSync(sessionOwnersRoot(home), { recursive: true });
    writeFileSync(
      file,
      JSON.stringify({ v: 1, ownerId: coordOwnerId, advSessionId, recordedAt: new Date().toISOString() }) + '\n',
      { flag: 'wx' },
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * Tee this launcher's OWN stderr into the launch's boot log — WI-37841.
 *
 * WHAT THIS BUYS. When a HUD "+ New session" launch dies before psu registers,
 * the operator can say only "its terminal closed before the session came online"
 * — it has no access to the one artifact that names the cause, because psu's
 * diagnostics go to the spawned window's pty and nowhere else. That has now cost
 * two full forensic sessions for two different root causes. Every explanation
 * was already printed; none was readable afterwards.
 *
 * WHY A STREAM WRAPPER AND NOT INSTRUMENTED EXIT PATHS. This launcher has 60+
 * `console.error` / `process.exit` sites. Instrumenting them is unmaintainable
 * and, worse, fails silently in the direction that matters: the exit path nobody
 * remembered to annotate is precisely the novel failure a future forensic
 * session will be spent on. One wrapper at the stream captures all of them —
 * including an uncaught exception's stack, which no per-site annotation would.
 *
 * WHY STDERR ONLY, NEVER STDOUT. psu hands stdout to an INTERACTIVE agent client
 * (the claude/codex REPL owns the pty). Routing it through a tee — the obvious
 * shell-level `psu … | tee` shape — destroys the tty and breaks every launch it
 * was meant to diagnose. This wrapper also only ever ADDS a file write; the
 * original `write` still runs first, so the window shows exactly what it did
 * before.
 *
 * SCOPE IS SELF-LIMITING, BY CONSTRUCTION. Only a launch that was handed a
 * PRE-PINNED `--owner-id` (i.e. a programmatic one — launch-su) gets a log; a
 * human typing `psu` at a terminal has the window in front of them and needs no
 * side-channel. And once psu hands the tty to the agent child, the child writes
 * to fd 2 directly rather than through this JS wrapper, so capture naturally
 * stops at the boot boundary instead of trailing a session for hours.
 *
 * Never throws, and returns null when it captured nothing: a diagnostic
 * side-channel must never be able to fail a launch. Every failure degrades to
 * exactly the pre-WI-37841 behaviour.
 *
 * ⚠ `stream` is TYPED AS THE MINIMAL WRITABLE ON PURPOSE, not as
 * `typeof process.stderr`. Inferring it from the default value narrows the
 * generated declaration to `WriteStream & { fd: 2 }`, which no test double can
 * satisfy — that would make the one DI seam here reachable only by a cast, and
 * a seam you must lie to the compiler to use is not a seam. Everything this
 * function needs is `write`.
 *
 * @param {string|null|undefined} ownerId the PRE-PINNED coord owner id
 * @param {{
 *   home?: string,
 *   maxBytes?: number,
 *   stream?: { write: (chunk: any, encoding?: any, cb?: any) => boolean },
 *   argv?: string[],
 *   now?: () => Date,
 * }} [opts]
 * @returns {{ path: string, uninstall: () => void } | null}
 */
export function installBootLogCapture(
  ownerId,
  { home = homedir(), maxBytes = PSU_LAUNCH_LOG_MAX_BYTES, stream = process.stderr, argv = process.argv.slice(2), now = () => new Date() } = {},
) {
  const file = ensurePsuLaunchLogPath(ownerId, { home });
  if (!file) return null;
  let fd;
  try {
    // 'w' — TRUNCATE. Owner ids are unique per launch, so this file belongs to
    // this launch alone; truncating means a reader can never be handed a
    // previous launch's diagnostic, which would be worse than no diagnostic.
    fd = openSync(file, 'w');
  } catch {
    return null;
  }
  let written = 0;
  let live = true;
  const append = (text) => {
    if (!live || written >= maxBytes) return;
    try {
      const buf = Buffer.from(text, 'utf8');
      const room = maxBytes - written;
      writeSync(fd, room >= buf.length ? buf : buf.subarray(0, room));
      written += buf.length;
    } catch {
      // A broken fd must not take the launch down with it, and retrying every
      // subsequent write would turn one fault into a storm.
      live = false;
    }
  };
  // The header is half the value: a failed launch's argv is what distinguishes
  // "psu refused these arguments" from "psu never got that far", and it is not
  // recoverable from the adv_sessions row once the launch dies.
  append(`# psu launch ${ownerId} at ${now().toISOString()}\n# argv: ${argv.join(' ')}\n`);
  // Keep the UNBOUND original and re-dispatch with `.call(stream, …)`, rather
  // than storing a `.bind(stream)` copy: uninstall must put back the exact
  // function that was there, or a second install/uninstall cycle leaves a stack
  // of bound wrappers behind and the stream never returns to its own method.
  const original = stream.write;
  stream.write = (chunk, encoding, cb) => {
    try {
      append(typeof chunk === 'string' ? chunk : Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk));
    } catch {
      // fall through — the real write below is what the user sees, and it must
      // happen whatever the tee did.
    }
    return original.call(stream, chunk, encoding, cb);
  };
  // Housekeeping, not correctness: one small file per launch would otherwise
  // accrete forever. Best-effort and bounded (see prunePsuLaunchLogs).
  try {
    prunePsuLaunchLogs({ home });
  } catch {
    /* never blocks a launch */
  }
  return {
    path: file,
    /** Restore the original stream + stop writing. Tests use it; production
     *  never needs to — the process exiting is the natural end of capture. */
    uninstall() {
      live = false;
      stream.write = original;
      try {
        closeSync(fd);
      } catch {
        /* already gone */
      }
    },
  };
}

/** The coordOwnerId this native session was born with, or null (no entry /
 *  unreadable / malformed — all degrade to the caller minting, never throw). */
export function recoverSessionOwner(nativeSessionId, { home = homedir() } = {}) {
  if (!nativeSessionId) return null;
  try {
    const parsed = JSON.parse(readFileSync(join(sessionOwnersRoot(home), String(nativeSessionId)), 'utf8'));
    return typeof parsed?.ownerId === 'string' && parsed.ownerId ? parsed.ownerId : null;
  } catch {
    return null;
  }
}

/**
 * The native session id a launch argv identifies AS THIS SESSION, or null.
 * Precedence matters because a fork's argv names TWO sessions:
 *   1. `--session-id <uuid>` wins — it declares the launched session's OWN id
 *      (fresh launches force it; a tracked claude fork emits
 *      `--resume <orig> --fork-session --session-id <forkId>`, and binding the
 *      ORIGINAL's id to the fork's fresh SID would poison the index).
 *   2. `--fork-session` with no forced id → null: the fork's new native id is
 *      minted by claude at runtime and unknowable here. Codex forks
 *      (`codex fork <uuid>`) likewise match nothing.
 *   3. Else `--resume <uuid>` (claude) / `resume <uuid>` subcommand (codex) —
 *      a plain resume IS the named session. OMP threads are non-UUID names,
 *      deliberately skipped.
 * Pure — exported for tests.
 */
export function nativeSessionIdFromLaunchArgs(args = []) {
  const argStrs = args.map((a) => String(a ?? ''));
  for (let i = 0; i < argStrs.length; i++) {
    const a = argStrs[i];
    if (a === '--session-id' && UUID_RE.test(argStrs[i + 1] ?? '')) return argStrs[i + 1];
    if (a.startsWith('--session-id=')) {
      const v = a.slice('--session-id='.length);
      if (UUID_RE.test(v)) return v;
    }
  }
  if (argStrs.includes('--fork-session')) return null;
  for (let i = 0; i < argStrs.length; i++) {
    const a = argStrs[i];
    if ((a === '--resume' || a === 'resume') && UUID_RE.test(argStrs[i + 1] ?? '')) return argStrs[i + 1];
    if (a.startsWith('--resume=')) {
      const v = a.slice('--resume='.length);
      if (UUID_RE.test(v)) return v;
    }
  }
  return null;
}

/**
 * WI-1980: build the argv for a cold-loop RECYCLE respawn.
 *
 * The initial launch forces the launched session's OWN id via `--session-id
 * <uuid>` (not resume — it DECLARES the id, see nativeSessionIdFromLaunchArgs).
 * The recycle host reused that argv verbatim, so every respawn re-declared the
 * SAME id whose transcript already existed on disk from the first boot → claude
 * refused to create an already-existing session → boot-error → supervisor
 * respawn → boot-retry storm (4× in 31s at wake 8, su-8ab32510 repro).
 *
 * A RECYCLE is a HARD cold reset — its intent IS a clean conversation, so we
 * mint a FRESH `--session-id` and strip any warm-resume flags
 * (`--resume`/`--continue`/`--fork-session`). The coord identity (PAPERCUSP_SID
 * in `env`) is deliberately UNCHANGED (D-003) — only the native claude id
 * rotates. Returns { args, nativeId } where nativeId is the fresh id (so the
 * caller can re-anchor native→coord via recordSessionOwner), or null when the
 * argv carries no `--session-id` (e.g. omp launches) — then args is returned
 * untouched and the respawn is a no-op change.
 *
 * Pure — exported for tests. `mintId` is injectable for deterministic tests.
 */
/** The provenance envelope every SCRIPTED kickoff carries (tagKickoffProvenance
 *  above, and turn-provenance.ts's ENVELOPE_RE which this mirrors). Minted ONLY
 *  for a kickoff first turn, so a token bearing one is definitively a kickoff
 *  positional and never a flag's value. */
const KICKOFF_ENVELOPE_RE = /^\s*⟦turn-origin:[A-Za-z0-9:._@-]+ nonce:[a-f0-9]{8,64}⟧/;

/** True for a SELF-CONTAINED inline flag (`--key=value`). It cannot consume the
 *  FOLLOWING token as its value, which is what makes whatever follows it a
 *  provable positional rather than a maybe-value. */
function isInlineFlag(tok) {
  return tok.startsWith('--') && tok.includes('=');
}

/**
 * Drop the trailing KICKOFF POSITIONAL from a launch argv.
 *
 * WI-37939: `kickoffPositionalArgs` seeds a scripted launch's first turn as a
 * TRAILING POSITIONAL (psu-launcher ~L7726). `mintRecycleArgs`'s copy loop then
 * carried it through verbatim on every recycle / carry-respawn, so each fresh
 * child re-exec'd `claude` with the ORIGINAL kickoff still on its argv and
 * opened on that stale prompt as turn 1 — forever, however many respawns later.
 * Measured on su-12b70e95: a fleet-kickoff minted 2026-08-10T16:57:23Z was
 * re-delivered 26.6h later, asserting a GOAL-mode contract that session never
 * held, for a goal already achieved. Same bug shape as the P-002 staleness fix
 * below (argv copied through verbatim), one argv element over. A recycle is a
 * CLEAN BOOT whose first prompt is the carry text the host types in
 * (recycleChild -> injectTurnAtPrompt), so the launch prompt must not survive.
 *
 * CONSERVATIVE BY CONSTRUCTION — strips only on POSITIVE identification, because
 * wrongly eating a flag's VALUE would launch the successor with a broken flag
 * (strictly worse than the staleness this fixes). Two provably-safe signals:
 *   1. the token carries a kickoff provenance envelope; or
 *   2. it is not a flag AND the token before it is an inline `--key=value`,
 *      which cannot own a following value — so this one is a positional.
 * Anything else is left alone (an untagged kickoff behind a value-taking flag
 * keeps today's behaviour rather than risking a mangled argv). Pure; exported
 * for tests.
 */
export function stripKickoffPositional(args = []) {
  const out = args.map((a) => String(a ?? ''));
  while (out.length) {
    const last = out[out.length - 1];
    const prev = out.length >= 2 ? out[out.length - 2] : null;
    const taggedKickoff = KICKOFF_ENVELOPE_RE.test(last);
    const provablePositional = !last.startsWith('-') && prev !== null && isInlineFlag(prev);
    if (!taggedKickoff && !provablePositional) break;
    out.pop();
  }
  return out;
}

export function mintRecycleArgs(
  args = [],
  { mintId = () => randomUUID(), agent = null, personaFile = null } = {},
) {
  const raw = args.map((a) => String(a ?? ''));
  // stale-prompt-render-in-live-sessions-2026-08-02 P-002: the freshly re-rendered
  // base persona, when the operator produced one. See the --system-prompt-file case
  // in the copy loop below for why this exists.
  const persona = typeof personaFile === 'string' && personaFile.trim() ? personaFile.trim() : null;
  const hasSessionId = raw.some((a) => a === '--session-id' || a.startsWith('--session-id='));
  // A RESUME-launched Claude session (`claude --resume <id>`) has no --session-id
  // to rotate — but a recycle/carry-respawn successor never wants the old
  // transcript anyway (the carry document replaces it), so for claude we
  // SYNTHESIZE a fresh --session-id instead of bailing. Before this, every
  // `psu --resume`d session was un-respawnable: the watchdog's forced
  // carry-respawn failed argv-build on EVERY sweep, spamming the terminal with
  // "carry-respawn requires a Claude --session-id launch" and leaving the
  // session unpoliced (owner-reported 2026-07-18). Non-claude argv is never
  // touched here (--session-id is a claude flag).
  const isClaude = String(agent ?? '').trim().toLowerCase() === 'claude';
  if (!hasSessionId && !isClaude) return { args, nativeId: null };
  // WI-37939: drop the launch kickoff BEFORE the copy loop, so no path below can
  // carry it into the successor argv. See stripKickoffPositional above.
  const src = stripKickoffPositional(raw);
  const freshId = mintId();
  const out = [];
  for (let i = 0; i < src.length; i++) {
    const a = src[i];
    if (a === '--session-id') {
      out.push('--session-id', freshId);
      i++; // consume the stale id token
      continue;
    }
    if (a.startsWith('--session-id=')) {
      out.push(`--session-id=${freshId}`);
      continue;
    }
    // A recycle is a clean boot — drop every warm-resume flag (and its value).
    if (a === '--resume') {
      i++; // consume the resumed-session id token
      continue;
    }
    if (a.startsWith('--resume=')) continue;
    if (a === '--continue' || a === '--fork-session') continue;
    // stale-prompt-render-in-live-sessions-2026-08-02 P-002: THE staleness bug lived
    // in the bare `out.push(a)` below. It copies every remaining flag through
    // verbatim — including `--system-prompt-file <the PREDECESSOR's render>` — so a
    // session's base persona was pinned to the first launch of its chain forever,
    // however many times it respawned. Only the carry document was ever refreshed.
    // Measured 2026-08-02: 27 of 53 live claude sessions ran a render up to 14 days
    // old, so every prompt fix of that fortnight reached only half the fleet.
    //
    // REPLACE the value, never append a second flag (claude takes the last one, but
    // relying on that would be an accident waiting to be reordered), and only when
    // the caller actually obtained a fresh render — a null personaFile means the
    // refresh was unavailable or failed, and then keeping the inherited path is the
    // deliberate fail-soft: a stale prompt beats a lost session. An argv with no
    // --system-prompt-file at all (omp/codex) is left alone; we never ADD the flag.
    if (persona && a === '--system-prompt-file') {
      out.push('--system-prompt-file', persona);
      i++; // consume the stale render path
      continue;
    }
    if (persona && a.startsWith('--system-prompt-file=')) {
      out.push(`--system-prompt-file=${persona}`);
      continue;
    }
    out.push(a);
  }
  if (!hasSessionId) out.push('--session-id', freshId);
  return { args: out, nativeId: freshId };
}

/**
 * P-018 deterministic carry respawn: rotate the native Claude session id using
 * {@link mintRecycleArgs}, persist the bounded carry document as one owner-scoped
 * 0600 launch-context file, and layer it onto the fresh child. The original argv
 * is the input on every respawn, so generated carry flags never accumulate.
 */
export function mintCarryRespawnArgs(
  args = [],
  {
    systemPromptAddendum,
    ownerId = null,
    mintId = () => randomUUID(),
    home = homedir(),
    agent = 'claude',
    personaFile = null,
    codexHome = null,
  } = {},
) {
  const text = String(systemPromptAddendum ?? '').trim();
  if (!text) throw new Error('carry-respawn requires a non-empty system-prompt addendum');
  const normalizedAgent = String(agent ?? '').trim().toLowerCase();
  // Claude rotates its native id and consumes the carry through
  // --append-system-prompt-file. Codex has no equivalent CLI flag; its system
  // prompt is CODEX_HOME/AGENTS.md, handled below. OMP still has no managed
  // carry-respawn consumer.
  // `personaFile` (P-002) rides through to mintRecycleArgs, which owns the
  // --system-prompt-file swap — the copy-through it fixes lives there, so both
  // respawn modes (carry AND plain recycle) get the fresh render from one code
  // path. This function stays PURE: the network call that produces personaFile is
  // the caller's, where its failure can be caught and fail-softed.
  const rotated = mintRecycleArgs(args, { mintId, agent, personaFile });
  const dir = join(home, '.papercusp', 'launch-context');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const key = String(ownerId || rotated.nativeId || 'unknown')
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .slice(0, 200);
  const launchContextPath = join(dir, `carry-${key || rotated.nativeId || 'unknown'}.md`);
  writeFileSync(launchContextPath, `${text}\n`, { mode: 0o600 });
  chmodSync(launchContextPath, 0o600);

  if (normalizedAgent === 'codex') {
    const targetHome = String(codexHome ?? '').trim();
    if (!targetHome) throw new Error('Codex carry-respawn requires CODEX_HOME');
    const agentsPath = join(targetHome, 'AGENTS.md');
    const basePath = join(targetHome, '.papercusp-carry-base-AGENTS.md');

    // Snapshot the launch-time prompt ONCE, then replace (never accumulate) the
    // managed carry section on each successor. A fleet member can respawn many
    // times; appending to the previous AGENTS.md would grow context without
    // bound and replay stale checkpoints.
    let baseText;
    if (existsSync(basePath)) {
      baseText = readFileSync(basePath, 'utf8');
    } else {
      baseText = readFileSync(agentsPath, 'utf8');
      writeFileSync(basePath, baseText, { mode: 0o600 });
      chmodSync(basePath, 0o600);
    }
    const nextAgents = [
      baseText.trimEnd(),
      '',
      '---',
      '## Managed carry checkpoint',
      '',
      text,
      '',
    ].join('\n');
    const tmp = `${agentsPath}.${process.pid}.carry.tmp`;
    writeFileSync(tmp, nextAgents, { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, agentsPath);
    chmodSync(agentsPath, 0o600);

    // A carry-respawn is a FRESH Codex thread. Drop the original launch's
    // positional kickoff and any resume/fork subcommand; preserving either
    // replays stale work or collides with the predecessor's active-writer lock.
    const strippedKickoff = stripKickoffPositional(args);
    const subcommandAt = strippedKickoff.findIndex((arg) => arg === 'resume' || arg === 'fork');
    return {
      args: subcommandAt >= 0 ? strippedKickoff.slice(0, subcommandAt) : strippedKickoff,
      nativeId: null,
      launchContextPath,
      codexAgentsPath: agentsPath,
    };
  }

  if (normalizedAgent !== 'claude' || !rotated.nativeId) {
    throw new Error('carry-respawn is supported only for Claude and Codex launches');
  }
  return {
    args: [...rotated.args, '--append-system-prompt-file', launchContextPath],
    nativeId: rotated.nativeId,
    launchContextPath,
  };
}

/**
 * Does claude's OWN store hold a transcript for this session id? A tracked
 * adv row alone doesn't prove resumability: a launch that died before its
 * first persisted turn leaves the adv row behind with NO
 * `~/.claude/projects/<dir>/<id>.jsonl`, and `claude --resume <id>` then
 * fails "No conversation found". Pure-ish (reads FS); exported for tests.
 */
export function claudeStoreHasSession(id, { home = homedir(), configDir = null } = {}) {
  return Boolean(claudeSessionTranscriptFile(id, { home, configDir }));
}

/** The transcript jsonl PATH for a claude session id (isolated configDir first —
 *  EI-155 — then the shared ~/.claude store), or null. Pure-ish (reads FS). */
export function claudeSessionTranscriptFile(id, { home = homedir(), configDir = null } = {}) {
  if (!id) return null;
  // EI-155: an interactive session's transcript lives in its isolated configDir,
  // not the shared ~/.claude — check that first (when known) before the shared store.
  const roots = [configDir, join(home, '.claude')].filter(Boolean);
  for (const root of roots) {
    const projects = join(root, 'projects');
    for (const d of safeReaddir(projects)) {
      if (!d.isDirectory()) continue;
      const f = join(projects, d.name, `${id}.jsonl`);
      if (existsSync(f)) return f;
    }
  }
  return null;
}

/**
 * Can this tracked session actually be RESUMED — does the agent's own store
 * hold a persisted transcript for it? An adv row is recorded at LAUNCH time
 * (bootstrap-su, before the agent's first turn), but an agent only persists
 * its transcript on the first message — so a launch that died at startup, or
 * a session closed at the prompt, leaves a permanent "ghost" row with nothing
 * to resume (`claude --resume` fails "No conversation found"; measured ~50%
 * of recent rows on the standing dev box, 2026-06-12). The resume picker
 * filters by this so it only offers sessions that can really be resumed.
 *
 * Verification is per-agent and deliberately errs toward KEEPING a row when
 * the store can't be checked by id:
 *   - claude + known sessionId → the EI-155 isolated config dir (else the
 *     shared ~/.claude) must hold `projects/<dir>/<sid>.jsonl`.
 *   - claude, no sessionId (pre-native-id rows) → resume falls back to
 *     `--continue` (most-recent-in-cwd) — not verifiable by id, keep.
 *   - codex + adv row id → the per-session CODEX_HOME must hold the rollout named by
 *     sessionId, or (when no sessionId was recorded) ANY rollout, since that resume runs
 *     `codex resume --last` inside that same isolated home. Without a row id there is no
 *     home to check — keep.
 *   - omp → the thread store isn't path-indexed here — keep.
 * Pure-ish (reads FS); `home` injectable for tests; exported for tests.
 */
export function sessionHasTranscript(session, { home = homedir() } = {}) {
  if (session.agent === 'claude') {
    if (!session.sessionId) return true;
    const configDir =
      session.configDir ||
      (session.coordOwnerId ? sessionClaudeConfigDir(session.coordOwnerId, home) : null);
    return claudeStoreHasSession(session.sessionId, { home, configDir });
  }
  if (session.agent === 'codex') {
    // No adv row id ⇒ no tracked home to look in ⇒ genuinely unverifiable, keep.
    if (session.id == null) return true;
    const sessionsRoot = trackedCodexSessionsRoot(session, home);
    // No recorded session_id is NOT unverifiable: resume runs `codex resume --last` against
    // this row's own isolated CODEX_HOME (resumeArgsFor + the CODEX_HOME pin in launchResume),
    // so "is there anything to resume" is exactly "does that home hold a rollout" — which we
    // can just look at. Keeping the blanket `return true` here filled the picker with launches
    // that die on selection (measured: over half of recent codex rows).
    if (!session.sessionId) return codexHomeHasAnyRollout(sessionsRoot);
    return Boolean(findCodexRollout(sessionsRoot, session.sessionId));
  }
  if (session.agent === 'omp') {
    if (!session.ompThreadId) return true;
    return Boolean(sessionTranscriptFile(session, { home }));
  }
  return true;
}

/**
 * Whether a session is resumable for the `psu --resume` PICKER — an on-disk
 * transcript OR a DB session-archive (`session.hasArchive`, stamped by the
 * /adv/sessions/resumable endpoint). The archive-at-death lifecycle deletes an
 * ended session's on-disk transcript ~15s after end and keeps it only in the DB,
 * so an on-disk-only check (sessionHasTranscript) misclassifies every off-disk-
 * but-archived session as a permanent ghost and hides it (owner-hit 2026-07-13:
 * `psu --resume` reported "hiding N session(s) with no persisted transcript" after
 * sessions moved off disk to the DB). An archived pick is rematerialized to disk
 * on selection before resume. Exported for unit testing.
 */
export function sessionIsResumable(session, opts = {}) {
  return sessionHasTranscript(session, opts) || Boolean(session.hasArchive);
}

/**
 * The persisted transcript file for a resolved session (tracked or untracked),
 * or null: claude → `<store>/projects/<dir>/<sid>.jsonl` (isolated configDir
 * first, EI-155); codex → the rollout jsonl under the tracked per-session
 * CODEX_HOME, else the shared ~/.codex store (an untracked resume); omp → null
 * (its thread store isn't path-indexed here). Pure-ish (reads FS); `home`
 * injectable for tests; exported for tests.
 */
export function sessionTranscriptFile(session, { home = homedir() } = {}) {
  if (session.agent === 'claude' && session.sessionId) {
    const configDir =
      session.configDir ||
      (session.coordOwnerId ? sessionClaudeConfigDir(session.coordOwnerId, home) : null);
    return claudeSessionTranscriptFile(session.sessionId, { home, configDir });
  }
  if (session.agent === 'codex' && session.sessionId) {
    const roots = [];
    if (session.id != null) {
      const r = trackedCodexSessionsRoot(session, home);
      if (r) roots.push(r);
    }
    roots.push(join(home, '.codex', 'sessions'));
    for (const root of roots) {
      const hit = findCodexRollout(root, session.sessionId);
      if (hit) return hit;
    }
  }
  if (session.agent === 'omp' && session.ompThreadId) {
    const roots = [];
    if (session.id != null) {
      roots.push(join(home, '.papercusp', 'su-omp-homes', `session-${session.id}`, 'agent', 'sessions'));
    }
    roots.push(join(home, '.omp', 'agent', 'sessions'));
    for (const root of roots) {
      const hit = findOmpTranscript(root, session.ompThreadId);
      if (hit) return hit;
    }
  }
  return null;
}

/** How much of a transcript's tail lastActiveModelFor reads — the model appears
 *  on every assistant event (claude) / turn_context (codex), so a quarter-MB of
 *  tail always covers the latest turn without reading a multi-MB file. */
const LAST_MODEL_TAIL_BYTES = 256 * 1024;

/**
 * The model that was LAST ACTIVE in a session, read from its own transcript
 * (WI-3758: `psu --resume` shows it and offers to keep it). Tail-reads the
 * final ~256KB and scans lines newest-first:
 *   - claude: `{"type":"assistant","message":{"model":"…"}}` — the model that
 *     actually answered; `<synthetic>` (error/system events) is skipped.
 *   - codex: `{"type":"turn_context","payload":{"model":"…"}}` — stamped every
 *     turn (verified codex CLI 0.144.0; session_meta carries only
 *     model_provider).
 *   - omp / no transcript / unreadable → null (callers degrade to "unknown").
 * Pure-ish (reads FS); `home` injectable for tests; exported for tests.
 */
export function lastActiveModelFor(session, { home = homedir() } = {}) {
  const file = sessionTranscriptFile(session, { home });
  if (!file) return null;
  let tail;
  try {
    const size = statSync(file).size;
    const want = Math.min(size, LAST_MODEL_TAIL_BYTES);
    const fd = openSync(file, 'r');
    try {
      const buf = Buffer.alloc(want);
      readSync(fd, buf, 0, want, size - want);
      tail = buf.toString('utf8');
    } finally {
      closeSync(fd);
    }
  } catch {
    return null;
  }
  const lines = tail.split('\n');
  // A truncated read starts mid-line — drop the partial first line so a stray
  // `"model":"…"` fragment can never half-parse into a wrong answer.
  if (tail.length === LAST_MODEL_TAIL_BYTES) lines.shift();
  const marker = session.agent === 'codex'
    ? '"turn_context"'
    : session.agent === 'omp'
      ? '"model_change"'
      : '"assistant"';
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line.includes(marker) || !line.includes('"model"')) continue; // cheap prefilter
    try {
      const o = JSON.parse(line);
      const m =
        session.agent === 'codex'
          ? (o?.type === 'turn_context' ? o?.payload?.model : null)
          : session.agent === 'omp'
            ? (o?.type === 'model_change' ? (o?.model ?? o?.payload?.model) : null)
          : (o?.type === 'assistant' ? o?.message?.model : null);
      if (typeof m === 'string' && m && m !== '<synthetic>') return m;
    } catch {
      /* malformed / partial line — keep scanning */
    }
  }
  return null;
}

/** Map a plan picker value to the bootstrap-su `plan_slug` (NO_PLAN → null). Pure. */
export function planValue(picked) {
  return picked === NO_PLAN || picked == null || picked === '' ? null : picked;
}

/**
 * An interactive SU omp session path-discovers `<cwd>/.mcp.json` (omp's
 * `mcp.discoveryMode`; claude auto-loads it too). A ROLE session (console-launch
 * `doSpawn` / a fleet role) writes a SIGNED role-scoped `.mcp.json` there and never
 * removes it — it spawns a DETACHED, unref'd terminal with no exit hook — so a later
 * SU launch in the same cwd inherits the stale role server (a per-role MCP host URL,
 * e.g. :9071) and hangs ~30s on "papercusp timed out". An SU session needs only the
 * USER-LEVEL papercusp-su (or, for omp, the per-session RELOCATED copy of it — see
 * writeOmpSessionConfigDir), never a co-located `.mcp.json`, so PARK ANY existing one
 * before launch — unconditionally, not just role-scoped ones.
 *
 * EI-10388 (2026-07-12): the prior version only parked a URL matching `role=` AND
 * NOT `superuser=1` — on the (false) assumption that any superuser-scoped project
 * file must already BE the current papercusp-su server, so it's harmless to leave.
 * That let a STALE superuser-scoped file with a DIFFERENT server name ("papercusp",
 * not "papercusp-su") and NO `tools=` seed slip through unparked. OMP then discovered
 * it ALONGSIDE the correctly-seeded per-session "papercusp-su" server and merged
 * BOTH tool catalogs — the seeded ~39-tool spine plus the stale server's full
 * ~700+-tool catalog (~778 total, hard 400 on a small-context local model:
 * `mcp_tools:papercusp` (unfiltered) + `mcp_tools:papercusp-su` (39, correct) both
 * present in OMP's own tool cache; confirmed server-side filtering itself works
 * correctly via a direct probe of the exact seeded URL). A co-located `.mcp.json`
 * is NEVER wanted for an SU launch regardless of its shape — park it, full stop.
 *
 * No restore: role launchers recreate `.mcp.json` fresh on their next launch (they
 * back up any existing one first), so parking is safe. Returns the parked path, or
 * null when nothing was parked. Side-effects fs only; exported for tests.
 */
export function parkRoleScopedMcpJson(cwd) {
  if (!cwd) return null;
  const p = join(cwd, '.mcp.json');
  if (!existsSync(p)) return null;
  const parked = join(cwd, '.mcp.json.su-parked');
  try {
    if (existsSync(parked)) rmSync(parked, { force: true }); // overwrite a stale prior park
    renameSync(p, parked);
    return parked;
  } catch {
    return null;
  }
}

/**
 * P-004 (omp-psu-interactive-parity-hardening-2026-06-29): an SU omp session loads
 * `~/.omp/agent/config.yml` `modelRoles.default`. When that's a LOCAL ollama model
 * (e.g. `ollama/ornith:fast` — 32k + text-only), the very first turn overflows the SU
 * toolset (~33k > 32k) BEFORE the user can `/model` to a bigger one — the exact cryptic
 * `exceeds the available context size (32768)` failure the owner hit. Return a one-line
 * advisory (else null) so the launcher warns UP FRONT. The owner's default is deliberately
 * left untouched (their "use my default" steer); this only surfaces the gotcha. Reads
 * config.yml; side-effects fs read only; exported for tests.
 */
// weak-model-tool-tier-2026-07-01: the UNIVERSAL core MCP spine handed to a weak/local
// OMP model up-front (bootstrap + coordination + work + discovery — ~19 tools) instead of
// the full ~580-tool superuser surface it cannot wield. The server honors `?tools=` as a
// LISTING allowlist only, so everything omitted stays REACHABLE via `tools:find` (intent
// search) → OMP's native `search_tool_bm25` activation. MIRROR of the orchestrator's
// CORE_MCP_TOOL_NAMES (libs/papercusp/packages/orchestrator/src/invoke.ts) — kept in
// lockstep by the drift guard in apps/operator/lib/psu-launcher.test.ts (psu-launcher.mjs
// is a plain node script with no TS imports, so the list is inlined, not imported).
export const OMP_CORE_MCP_TOOL_NAMES = [
  // (coord:ack cut in the 2026-07-05 demand-evidence rebalance, in lockstep with the
  // canonical list — 47 calls/7d; a coord:send reply covers it. coord:ask cut
  // 2026-07-19 by the same bar — 16 calls/14d seeded, zero fallback reaches.)
  'coord:orient', 'coord:inbox', 'coord:send', 'coord:glance',
  // plans:new (P-002, cross-platform-hardening-and-agent-ergonomics-2026-07-05) authors a
  // whole plan in ONE call (P-001 `body` arg) so an agent never hunts for a create verb —
  // the Mac-app plan-authoring fumble (owner: "plans should be a core trimmed tool").
  // plans:set-now: the "## Now" narration duty (467 fallback + 807 direct calls/7d).
  'plans:new', 'plans:get', 'plans:set-status', 'plans:items', 'plans:set-now',
  // work_items:create: #1 gap of the 2026-07-05 rebalance (608 fallback + 1,354 direct
  // across 5 roles/7d) — the spine had claim/complete but not the verb that CREATES one.
  'work_items:list', 'work_items:create', 'work_items:claim',
  // EI-6770/EI-8588: self-pull (claim_next) + read (get) + finish (complete) +
  // release — the rest of the canonical worker loop; their absence caused "tool
  // not available" self-halts and stranded claim handoffs.
  // EI-10946: work_items:comment + work_items:update RE-ADDED to the canonical CORE
  // (the 2026-07-05 cut's premise — "set_state + comment cover it" — was false: comment
  // was never seeded either, so an agent could CREATE/close an item but had no seeded way
  // to correct or annotate one, and abused work_items:checkpoint as an erratum channel).
  // Mirror them here or the lockstep drift guard fails.
  'work_items:claim_next', 'work_items:get', 'work_items:complete',
  'work_items:release', 'work_items:set_state',
  'work_items:comment', 'work_items:update',
  // scheduler:get_next: the fleet-member feed loop (claim-spec pull, 732 fallback
  // reaches/7d) — a drain member hits this every iteration.
  'scheduler:get_next',
  // locks:*_granular are NOT in the weak-model spine: file-edit locks are acquired
  // AUTOMATICALLY by the omp `-e` coord extension on every Edit/Write, so a worker
  // never needs the manual lock tools. Advertising them up-front just invited misuse
  // — weak models treated them as an operation-mutex (locking the plan file to
  // "serialize fleet creation", churning acquire/release, losing track of lock_ids).
  // They stay REACHABLE via tools:find for the rare genuine multi-file cross-turn hold.
  // (2026-07-05: the canonical list dropped them too — this is no longer a divergence.)
  'docs:search', 'memory:search', 'memory:remember',
  // improvements:capture: the universal "file what you notice" reflex (227 fallback +
  // 1,128 direct calls across 3 roles/7d).
  'improvements:capture',
  // 2026-07-03 canonical-core catch-up (drift guard): batching (code:run + recipes),
  // standing facts, and the loop/work-item checkpoint verbs joined the canonical
  // CORE_MCP_TOOL_NAMES — mirror them here or the lockstep test fails.
  // (recipes:run cut 2026-07-05 — 78 calls/7d, one role; recipes:search returns the
  // run pointer and the run routes via tools:invoke.)
  'code:run', 'recipes:search',
  // dev:pg_query added 2026-07-19: the loudest unmet need in the fallback-reach ledger
  // (1,132 tools:invoke reaches/14d, 2.4× the next entry) + the storage-policy-mandated
  // read path for PG-canonical state. Mirror of the canonical CORE addition.
  'dev:pg_query',
  // EI-10946/EI-10947: facts:retract is the ONLY exit from a standing fact (folded VERBATIM
  // into every future orient as binding context) — seeding assert+list without retract armed
  // the stale-fact trap with no disarm. Mirror the canonical CORE order (retract after list).
  'facts:assert', 'facts:list', 'facts:retract',
  // loop:arm joins loop:checkpoint (2026-07-05): checkpoint was in the spine while the
  // verb that CREATES the loop was not (253 fallback reaches/7d).
  // loop:status + loop:end join (2026-07-07, EI-8597 canonical-core catch-up): the
  // wind-down half of the loop lifecycle — discovery can miss them, so a seeded worker
  // must be able to inspect/stop its own loop without depending on tools:find.
  'work_items:checkpoint', 'loop:arm', 'loop:checkpoint', 'loop:status', 'loop:end',
  // Event-wait lifecycle (fleet-member-dx-improvements-2026-07-10 P-008): keep the
  // seeded OMP spine aligned with the canonical event sleep/emit/catalog verbs.
  // (events:emit cut 2026-07-19 in lockstep — 29 calls/14d seeded, no reach demand;
  // members await, leaders/the system emit; reachable via tools:find/invoke.)
  'events:await', 'events:catalog',
  // EI-6770: without this, an agent nearing its compaction limit self-halts instead of
  // compacting cleanly ("no compaction tool available"), losing in-flight work.
  'session:request-compaction',
  // fleet:launch-on-plan mirrors the canonical CORE: every su routing gate offers the
  // fleet route, so every trimmed client needs the verb that executes it. This used to
  // be an OMP-only exception; that stranded Codex/Claude behind the same required gate.
  'fleet:launch-on-plan',
  // search:fulltext joins the canonical CORE (EI-18745029375690371, 2026-07-27): it was
  // seeded asymmetrically vs docs:search (docs:search in the spine, fulltext not) despite
  // root CLAUDE.md recommending both for prose recall — 22 tools:invoke fallback
  // reaches/11 distinct callers in 14d vs docs:search's 9. Mirror the canonical CORE order
  // (right before the discovery pair). search:semantic stays OUT here too — lower
  // demand-evidence (7 reaches/7 callers/14d), reachable via tools:find/invoke.
  'search:fulltext',
  // MIRROR of the canonical orchestrator CORE_MCP_TOOL_NAMES addition (same position, same
  // order — the lockstep drift guard in psu-launcher.test.ts compares the arrays EXACTLY).
  // Admitted by P-006 (D-006) and raising NO cap: the array measured 42 against a <=43
  // ratchet, so the slot already existed. 622 fallback-reaches/65 callers @4,250 B =
  // 149.9 reaches/KB, the highest demand in the ledger, and the verb root CLAUDE.md
  // MANDATES for recording a cross-lane ruling. Full rationale lives beside the canonical
  // list in libs/papercusp/packages/orchestrator/src/invoke.ts.
  'plans:add-decision',
  // mode:set and work_items:claimable stay Claude-only in CLAUDE_SEED_EXTRA_TOOL_NAMES
  // below — the array is now EXACTLY 43 = the ratchet, so admitting either would raise a
  // cap in the change that fills it. See plan D-006.
  'tools:find', 'tools:invoke',
];

/** The core spine minus any names in PAPERCUSP_OMP_TOOLS_EXCLUDE (comma-separated).
 *  Escape hatch for a spine tool the target operator currently serves BROKEN — e.g. a
 *  schema Ollama's parser 400s on until a server fix deploys (P-030: work_items:update's
 *  unconstrained status/state on the release host). An excluded tool stays CALLABLE via
 *  tools:invoke; only its up-front advertisement is dropped. Exported for tests. */
export function ompCoreToolNames(env = process.env) {
  const excluded = String(env.PAPERCUSP_OMP_TOOLS_EXCLUDE || '')
    .split(',').map((s) => s.trim()).filter(Boolean);
  if (!excluded.length) return [...OMP_CORE_MCP_TOOL_NAMES];
  return OMP_CORE_MCP_TOOL_NAMES.filter((n) => !excluded.includes(n));
}

/** EI-9011 (fleet-retro-hardening-2026-07-10 P-002): the CLAUDE seed = the shared core
 *  spine + the manual lock verbs. locks:* stay OUT of the weak-model OMP spine (misuse
 *  evidence — see the spine comment above), but belong IN the claude seed: the CC
 *  PreToolUse lock-block hook fires ONLY in Claude sessions and its refusal names
 *  locks:acquire {wake_on_grant:true} as the sanctioned queue+sleep path, yet Claude's
 *  native ToolSearch indexes ONLY the advertised subset — an unseeded name reads as
 *  "doesn't exist" (the EI-9011 poll-degradation). Exported for tests.
 *
 *  WI-37534 (owner-reported 2026-08-09) extends the same principle from the lock hook to
 *  the rest of the CLAUDE-ONLY mandates. These live here rather than in the shared spine
 *  on purpose: a weak local OMP model has no use for a state plane or a background-job
 *  runner, and the drift guard asserts this list stays DISJOINT from OMP_CORE.
 *  Demand evidence (tool_invocations, tools:invoke fallback reaches / distinct callers,
 *  14d, papercusp-workspace) against the list's own admit precedent — search:fulltext was
 *  admitted at 22/11, coord:ask CUT at 16 and events:emit at 29:
 *    state:read              68 / 31   root CLAUDE.md mandates RE-READING any volatile
 *                                      value (gate verdict, deploy sha, queue depth)
 *                                      instead of transcribing it; unreachable, so the
 *                                      transcribe-a-stale-number bug it exists to kill
 *                                      stayed alive.
 *    capability:bash        111 / 29   the long-jobs rule routes every >1-2min job here
 *                                      (recoverable log + real child exit code).
 *    capability:bash_output 119 / 34   its INSEPARABLE pair — seeding the launcher
 *                                      without the reader strands every background job,
 *                                      which is why its reach count is the HIGHER of the
 *                                      two (agents got a bash_id they could not read).
 *  Previously filed independently and left unfixed: EI-19500729376783421 (capability:bash
 *  unreachable, so agents fall back to native backgrounding — whose completion
 *  notification root CLAUDE.md separately calls untrustworthy). */
/*  P-002 of psu-seed-prompt-mandate-alignment-2026-08-09. Same principle again, now
 *  applied against a MEASURED cost rather than demand alone (plan D-001): seed cost is
 *  the tools/list WIRE payload, and it is dominated by argSchema, not by the
 *  description/guidance that promptWeight() governs. Admission metric is therefore
 *  reach-per-KB, and every name below was measured before being admitted:
 *    dev:pipeline_position  474/88  1,919 B  252.9 reach/KB  "is my change live" is ONE
 *                                            call (root CLAUDE.md); the highest
 *                                            distinct-caller count of ANY unseeded tool.
 *    testing:run            428/57  2,455 B  178.5  bash-routing table; previously filed
 *                                            unfixed as EI-19321552629556165.
 *    dev:restart            142/39  1,328 B  109.5  two-port model — the ONLY sanctioned
 *                                            way to restart :3170 (a raw systemctl was
 *                                            firing every ~5-6min uncoordinated, WI-4221).
 *    sessions:search        129/47  2,305 B   57.3  the compaction strategy's self-recall
 *                                            path; a successor that cannot call it
 *                                            re-derives instead of retrieving.
 *    build:typecheck        174/49  3,141 B   56.7  bash-routing table; refuses the
 *                                            zero-file `tsc -p .` run that reads as clean.
 *    coord:presence         117/48  3,331 B   36.0  liveness/wake rules — sessionState is
 *                                            the verdict a wake decision depends on.
 *  Subtotal +14,479 B (~3.6K tokens), seed 190.9 -> 205.4 KB against a 256 KB ceiling.
 *  MEASURED AND DEFERRED (below the value line, listed so the next audit need not
 *  re-derive): db:migrate 43.7, plans:add-item 28.0, work_items:link 24.1,
 *  checkpoint:await 20.0, plans:list 12.9. release:checkpoint-run scored 57.5 and is a
 *  genuine near-miss, held back only to keep this tranche to the plan's stated scope. */
export const CLAUDE_SEED_EXTRA_TOOL_NAMES = [
  'locks:acquire', 'locks:release', 'locks:list',
  'state:read', 'capability:bash', 'capability:bash_output',
  'dev:pipeline_position', 'testing:run',
  // sql-escape-tool-routing-2026-08-12: the generated routing table promotes
  // these read-side tools, so Claude's native ToolSearch must see them in its
  // seed. Keep them Claude-only: the shared OMP spine is capped at 43, while
  // these are high-value operator reads (db:migrations: 153 calls/64 agents;
  // testing:runs: 288 calls/40 agents; issues:list: 686 calls/83 agents).
  'db:migrations', 'issues:list', 'testing:runs', 'routines:list',
  'dev:restart',
  'sessions:search', 'build:typecheck', 'coord:presence',
  // Cross-role verbs whose measured demand is overwhelmingly su/psu traffic. P-003 first
  // rehomed all THREE here after overshooting the shared spine's ratchet; P-006 (D-006)
  // then promoted plans:add-decision into the shared spine proper — it is therefore NOT
  // listed here any more, and OMP/codex now reach it directly too. These two remain:
  //   mode:set             124 reaches/56 callers, 1,732 B, 73.3 reach/KB — an
  //     unregistered mode is invisible session state that a compaction silently drops.
  //   work_items:claimable 135/55, 2,198 B, 62.9 — the SSOT claim floors; the documented
  //     alternative (raw status='open') overcounts ~13x, so unreachability here actively
  //     pushed callers onto a WRONG answer.
  // NARROWED GAP: OMP/codex still cannot reach these TWO directly. The shared spine is now
  // exactly at its <=43 ratchet, so admitting either means raising a cap in the change that
  // fills it — the DARK_FLAGS-watermark anti-pattern. That needs a deliberate budget
  // decision priced in WIRE BYTES per D-001, not another quiet append. Both stay reachable
  // everywhere via tools:find/invoke.
  'mode:set', 'work_items:claimable',
];
export function claudeSeedToolNames(env = process.env) {
  const seen = new Set();
  return [...ompCoreToolNames(env), ...CLAUDE_SEED_EXTRA_TOOL_NAMES]
    .filter((n) => !seen.has(n) && (seen.add(n), true));
}

// weak-model-tool-tier: a model that runs LOCALLY (ollama/local provider prefix) is small
// and weak for tool-use relative to a hosted frontier model. Mirror of the canonical
// packages/operator-core/lib/model-tier.ts modelCapabilityTier heuristic (kept simple here
// — no TS import). Unknown/empty ⇒ NOT weak (safe default: never accidentally trim a strong
// model). OMP runs weak AND strong models, so the tier comes from the MODEL, not the client.
const OMP_LOCAL_MODEL_PREFIXES = ['ollama/', 'ollama-cc/', 'local/', 'llamacpp/', 'llama.cpp/', 'lmstudio/', 'localai/'];
export function isWeakOmpModel(modelId) {
  if (!modelId) return false;
  const id = String(modelId).trim().toLowerCase();
  if (!id) return false;
  return OMP_LOCAL_MODEL_PREFIXES.some((p) => id.startsWith(p));
}

/** The registry-file form of an OMP model id: the provider prefix (`ollama-cc/…`) and any
 *  trailing reasoning-effort suffix (`:xhigh`) are launch-spec decoration — models.yml/models.json
 *  entries carry the bare id (e.g. `maxwell1500/ornith-35b:IQ3_M`), and the gateway's
 *  model→backend router matches that bare form. Exported for tests. */
export function bareOmpModelId(modelId) {
  let id = String(modelId ?? '').trim();
  if (!id) return '';
  const lower = id.toLowerCase();
  for (const p of OMP_LOCAL_MODEL_PREFIXES) {
    if (lower.startsWith(p)) {
      id = id.slice(p.length);
      break;
    }
  }
  return id.replace(/:(?:minimal|low|medium|high|xhigh)$/i, '');
}

/** Read the LIVE per-slot context window for a local model from the gateway's backend probe
 *  (deterministic-context-carry P-005): GET /maintenance/backend-context?model=<bare-id> →
 *  { nCtx } from the backend's own /props. The path is LOCKSTEP with operator-core
 *  inference-gateway/gateway.ts MAINTENANCE_BACKEND_CONTEXT_PATH (plain .mjs — no TS import;
 *  same mirror rule as OMP_LOCAL_MODEL_PREFIXES above). Fail-soft null on ANY miss (gateway
 *  down, model not backend-served, wedged /props) — the caller keeps the configured registry
 *  values, which is exactly the pre-P-005 behavior. Exported for tests. */
export async function probeOmpBackendContextWindow(modelId, env = process.env, fetchImpl = fetch) {
  try {
    const bare = bareOmpModelId(modelId);
    if (!bare) return null;
    const gwp = Number(env.PAPERCUSP_GATEWAY_PORT);
    const port = Number.isFinite(gwp) && gwp > 0 ? gwp : 8788;
    const r = await fetchImpl(
      `http://127.0.0.1:${port}/maintenance/backend-context?model=${encodeURIComponent(bare)}`,
      { signal: AbortSignal.timeout(6000) },
    );
    if (!r.ok) return null;
    const j = await r.json();
    const n = Number(j?.nCtx);
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

/** A numeric field a models.yml carries for `bareId`, or null. Scans the id's entry only
 *  (from its `- id:` line to the next `- id:`/dedent) so sibling models are never misread.
 *  Exported for tests. */
export function readModelsYmlField(ymlText, bareId, field) {
  const entry = modelsYmlEntrySpan(ymlText, bareId);
  if (!entry) return null;
  const m = entry.text.match(new RegExp(`^[ \\t]*${field}:[ \\t]*(\\d+)`, 'm'));
  return m ? Number(m[1]) : null;
}
export const readModelsYmlContextWindow = (ymlText, bareId) => readModelsYmlField(ymlText, bareId, 'contextWindow');

/** Rewrite a numeric `field` to `value` inside `bareId`'s models.yml entry (only that entry —
 *  hosted siblings in the same registry are untouched). Returns the input unchanged when the
 *  entry or the field line is absent. Exported for tests. */
export function rewriteModelsYmlField(ymlText, bareId, field, value) {
  const entry = modelsYmlEntrySpan(ymlText, bareId);
  if (!entry) return ymlText;
  const rewritten = entry.text.replace(new RegExp(`^([ \\t]*${field}:[ \\t]*)\\d+`, 'm'), `$1${value}`);
  return ymlText.slice(0, entry.start) + rewritten + ymlText.slice(entry.end);
}
export const rewriteModelsYmlContextWindow = (ymlText, bareId, newWindow) => rewriteModelsYmlField(ymlText, bareId, 'contextWindow', newWindow);

/** Per-hop context doors MIRROR (deterministic-context-carry P-006, plan D-007) — canonical
 *  TS lives in packages/operator-core/lib/context-doors.ts (plain .mjs cannot import it; same
 *  lockstep rule as OMP_LOCAL_MODEL_PREFIXES / MAINTENANCE_SUMMARIZE_PATH). Only the two
 *  pieces the launcher consumes are mirrored: maxTurn and the OUTPUT door (the max_tokens
 *  request param — enforcement leg (a); the results/injections doors are operator-core's).
 *  Exported for tests. */
export function computeMaxTurnTokens(effectiveWindow) {
  const w = Number(effectiveWindow);
  if (!Number.isFinite(w) || w <= 0) return 8000;
  return Math.min(15000, Math.max(8000, Math.floor(w / 26)));
}
export function computeOutputDoorTokens(effectiveWindow) {
  return Math.floor(computeMaxTurnTokens(effectiveWindow) * 0.5);
}
/** P-007 two-tier thresholds — MIRROR of operator-core context-doors.ts
 *  computeCompactionThresholds (same lockstep rule as computeMaxTurnTokens above).
 *  soft = w − (2×maxTurn + 4000 overhead) → nudge tier; hard = w − maxTurn → the mechanical
 *  tier (shake), holding one full doored hop of headroom by construction.
 *  Ornith 204,800 → soft 90 / hard 96; 400K → soft 91 / hard 96. */
export function computeCompactionThresholdPercents(effectiveWindow) {
  const maxTurn = computeMaxTurnTokens(effectiveWindow);
  const w = Number(effectiveWindow);
  const window = Number.isFinite(w) && w > 0 ? w : maxTurn * 4;
  const softTokens = Math.max(0, window - (2 * maxTurn + 4000));
  const hardTokens = Math.max(softTokens, window - maxTurn);
  return { softPct: Math.floor((softTokens / window) * 100), hardPct: Math.floor((hardTokens / window) * 100) };
}

/** The [start,end) span of `bareId`'s list entry in a models.yml: from its `- id:` line up to the
 *  next `- `-prefixed line at the same indent or any dedent past the entry's own indentation. */
function modelsYmlEntrySpan(ymlText, bareId) {
  const lines = String(ymlText ?? '').split('\n');
  const esc = bareId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const idRe = new RegExp(`^([ \\t]*)-[ \\t]+id:[ \\t]*"?${esc}"?[ \\t]*$`);
  let offset = 0;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(idRe);
    if (!m) {
      offset += lines[i].length + 1;
      continue;
    }
    const indent = m[1].length;
    let end = offset + lines[i].length + 1;
    for (let j = i + 1; j < lines.length; j++) {
      const l = lines[j];
      const lead = l.match(/^[ \t]*/)[0].length;
      // A new list item at the entry's indent, or any non-blank dedent, ends the entry.
      if (l.trim() && (lead < indent || (lead === indent && l.trimStart().startsWith('-')))) break;
      end += l.length + 1;
    }
    return { start: offset, end: Math.min(end, ymlText.length), text: ymlText.slice(offset, Math.min(end, ymlText.length)) };
  }
  return null;
}

/** Set numeric `fields` on every models.json record whose `id` is `bareId` (a JSON
 *  parse/stringify — models.json is machine-written; no comment/format concerns). Only fields
 *  the record already carries as numbers are touched. Returns the input unchanged on any
 *  parse failure. Exported for tests. */
export function rewriteModelsJsonFields(jsonText, bareId, fields) {
  try {
    const root = JSON.parse(jsonText);
    let touched = false;
    const walk = (node) => {
      if (Array.isArray(node)) {
        for (const v of node) walk(v);
      } else if (node && typeof node === 'object') {
        if (node.id === bareId) {
          for (const [k, v] of Object.entries(fields)) {
            if (typeof node[k] === 'number' && typeof v === 'number') {
              node[k] = v;
              touched = true;
            }
          }
        }
        for (const v of Object.values(node)) walk(v);
      }
    };
    walk(root);
    return touched ? JSON.stringify(root, null, 2) : jsonText;
  } catch {
    return jsonText;
  }
}
export const rewriteModelsJsonContextWindow = (jsonText, bareId, newWindow) => rewriteModelsJsonFields(jsonText, bareId, { contextWindow: newWindow });

/** The OMP session's DEFAULT model id (config.yml `modelRoles.default`), or null. Used to
 *  compute the model tier when the launch didn't pass an explicit --model. Exported for tests. */
export function ompDefaultModel(home = homedir()) {
  try {
    const text = readFileSync(join(home, '.omp', 'agent', 'config.yml'), 'utf8');
    const m = text.match(/modelRoles:[\s\S]*?\n[ \t]+default:[ \t]*([^\s#]+)/);
    return m?.[1]?.trim() ?? null;
  } catch {
    return null;
  }
}

/** Append `?tools=<names>` to every papercusp `/api/mcp` server URL in an OMP mcp.json that
 *  doesn't already carry one, so the superuser MCP advertises ONLY the core spine (weak-model
 *  trim). Pure string→string (uses URL/searchParams so colons/commas are encoded exactly the
 *  way the server's parseToolsAllowlist decodes them); returns the input unchanged on any parse
 *  failure. Exported for tests. */
export function applyOmpToolsAllowlist(mcpJsonText, toolNames) {
  try {
    const obj = JSON.parse(mcpJsonText);
    const servers = obj?.mcpServers;
    if (servers && typeof servers === 'object' && Array.isArray(toolNames) && toolNames.length) {
      for (const key of Object.keys(servers)) {
        const srv = servers[key];
        if (srv && typeof srv.url === 'string' && /\/api\/mcp(\?|$)/.test(srv.url) && !/[?&]tools=/.test(srv.url)) {
          const u = new URL(srv.url);
          u.searchParams.set('tools', toolNames.join(','));
          srv.url = u.toString();
        }
      }
    }
    return JSON.stringify(obj, null, 2);
  } catch {
    return mcpJsonText;
  }
}

/** Keep only the MCP servers that belong in a default trimmed OMP session.
 *
 * The per-session config copy must carry papercusp-su, and may carry the public
 * context7 server. Copying every server from the user's global mcp.json also
 * pulls heavyweight/browser and credentialed plugin servers into every worker,
 * even though the trimmed Papercusp tool spine cannot use them. Full-mode and
 * role launches deliberately skip this filter by not supplying toolsAllowlist.
 * Pure string→string; returns the input unchanged on any parse failure.
 */
function filterTrimmedOmpMcpServers(mcpJsonText) {
  try {
    const obj = JSON.parse(mcpJsonText);
    const servers = obj?.mcpServers;
    if (servers && typeof servers === 'object' && !Array.isArray(servers)) {
      obj.mcpServers = Object.fromEntries(
        Object.entries(servers).filter(([name]) => name === 'papercusp-su' || name === 'context7'),
      );
    }
    return JSON.stringify(obj, null, 2);
  } catch {
    return mcpJsonText;
  }
}

/** Rewrite the ORIGIN (scheme+host+port) of every papercusp `/api/mcp` server URL in an OMP
 *  mcp.json to the launcher's resolved operator URL, preserving path + query. The user-level
 *  `~/.omp/agent/mcp.json` pins whatever origin it was minted with (usually direct :3070) — a
 *  per-session copy that keeps that origin ignores PAPERCUSP_OPERATOR_URL and bypasses the
 *  resilient proxy (WI-1457), so the member talks to a DIFFERENT operator than the launcher
 *  that spawned it (root-caused 2026-07-02, P-030: a :3170-pinned relaunch still hit :3070).
 *  Pure string→string; returns the input unchanged on any parse failure. Exported for tests. */
export function applyOmpOperatorOrigin(mcpJsonText, operatorUrl) {
  try {
    const origin = new URL(operatorUrl).origin;
    const obj = JSON.parse(mcpJsonText);
    const servers = obj?.mcpServers;
    if (servers && typeof servers === 'object') {
      for (const key of Object.keys(servers)) {
        const srv = servers[key];
        if (srv && typeof srv.url === 'string' && /\/api\/mcp(\?|$)/.test(srv.url)) {
          const u = new URL(srv.url);
          srv.url = origin + u.pathname + u.search;
        }
      }
    }
    return JSON.stringify(obj, null, 2);
  } catch {
    return mcpJsonText;
  }
}

/** Stamp fixed query params (`agent`, `model`) onto every papercusp `/api/mcp` server URL in an
 *  OMP mcp.json, so the operator learns the CALLING agent's backend + model PER REQUEST. This is
 *  the "current calling agent" signal fleet:launch-on-plan reads to default a spawned fleet's
 *  backend/model to the caller's own (fleet-launch-agent-inheritance-2026-07-03) — an omp/ornith
 *  leader that omits `agent` then spawns omp members, not the historical claude default. Because
 *  psu REWRITES this per-session copy each launch (unlike the static user-level file), the value is
 *  the CURRENT process's backend/model, not a session-start constant (a resume re-stamps). Pure
 *  string→string; returns the input unchanged on any parse failure. Exported for tests. */
export function applyOmpMcpUrlParams(mcpJsonText, params) {
  try {
    const obj = JSON.parse(mcpJsonText);
    const servers = obj?.mcpServers;
    if (servers && typeof servers === 'object' && params && typeof params === 'object') {
      for (const key of Object.keys(servers)) {
        const srv = servers[key];
        if (srv && typeof srv.url === 'string' && /\/api\/mcp(\?|$)/.test(srv.url)) {
          const u = new URL(srv.url);
          for (const [k, v] of Object.entries(params)) {
            if (v != null && String(v).length > 0) u.searchParams.set(k, String(v));
          }
          srv.url = u.toString();
        }
      }
    }
    return JSON.stringify(obj, null, 2);
  } catch {
    return mcpJsonText;
  }
}

/**
 * Point a relocated OMP agent dir at the global OAuth SQLite store.
 *
 * Modern OMP keeps provider logins (xai-oauth, anthropic, openai-codex, …) in
 * `agent.db` (`auth_credentials`). `PI_CONFIG_DIR` relocation would otherwise
 * leave the session with a fresh empty db — credentials appear only in
 * `~/.omp/agent/agent.db` (or the legacy `auth.json` for older providers).
 *
 * Symlink (not copy) matches fleet `writeSpawnOmpHome` / `OMP_SEEDED_AGENT_ESSENTIALS`:
 * concurrent sessions share one credential store; no multi-MB duplicate; token
 * refresh from a direct `omp` login is visible to the next psu launch.
 *
 * Replaces a stale real-file `agent.db` (empty db created by a pre-fix psu
 * session, or a prior copy) so re-seeding the same session id heals. Best-effort
 * — never throws; a missing global store degrades to OMP's own auth error.
 * Exported for tests.
 */
export function linkOmpAgentDb(srcAgent, dstAgent) {
  try {
    if (!srcAgent || !dstAgent) return;
    const srcDb = join(srcAgent, 'agent.db');
    if (!existsSync(srcDb)) return;
    const dstDb = join(dstAgent, 'agent.db');
    // Healthy: already a symlink resolving to the global store.
    try {
      if (
        lstatSync(dstDb).isSymbolicLink() &&
        realpathSync(dstDb) === realpathSync(srcDb)
      ) {
        return;
      }
    } catch {
      /* missing or dangling — fall through and (re)link */
    }
    // Drop a stale real file / wrong link and any local WAL/SHM left by an empty
    // session db (those would sit next to the symlink path and confuse SQLite).
    for (const side of ['agent.db', 'agent.db-wal', 'agent.db-shm']) {
      try {
        rmSync(join(dstAgent, side), { force: true });
      } catch {
        /* best-effort */
      }
    }
    symlinkSync(srcDb, dstDb);
  } catch {
    /* a launch must NEVER fail on credential seed */
  }
}

/**
 * su-context-size-variants + weak-model-tool-tier: materialize a per-session OMP config dir
 * and return the value to export as PI_CONFIG_DIR.
 *
 * ⚠ RETURNS A HOME-RELATIVE PATH (e.g. `.papercusp/su-omp-homes/session-<id>`), NOT absolute.
 * OMP resolves PI_CONFIG_DIR as `path.join(os.homedir(), process.env.PI_CONFIG_DIR || '.omp')`,
 * so an ABSOLUTE value gets doubled onto home (`/home/u/home/u/…`) → a non-existent dir. (Root-
 * caused 2026-07-01 from the OMP bundle; the prior absolute-returning writeOmpFullConfigDir
 * silently broke full-mode — the relocated dir was never read.)
 *
 * Because PI_CONFIG_DIR fully RELOCATES OMP's config+data root (no overlay fallback; with no
 * XDG_*_HOME the data root collapses onto configRoot), the per-session dir must carry a FAITHFUL
 * copy of the model registry (config.yml + models.yml/json/db + auth) AND the mcp.json — else the
 * session loses model resolution AND the papercusp-su MCP server. We copy the small config+registry
 * files (not the multi-MB session/history dbs, which a fresh session recreates).
 *
 * OAuth credentials (xai-oauth, anthropic, openai-codex, …) live in `agent.db`
 * (`auth_credentials`), NOT the legacy `auth.json`. A byte-copy of that SQLite
 * store would race concurrent sessions and bloat every su-omp-home; instead we
 * **symlink** `agent.db` to the global `~/.omp/agent/agent.db` — same essential
 * as fleet `writeSpawnOmpHome` / `OMP_SEEDED_AGENT_ESSENTIALS`. Without the
 * link, psu→omp sessions boot with an empty credential store and Grok/xAI
 * (and any other post-login provider) silently vanish from `/model`.
 *
 *   opts.discoveryOff   → flip OMP tool-discovery OFF (contextSize:'full' — whole catalog up-front
 *                         for a capable model).
 *   opts.toolsAllowlist → advertise ONLY these MCP tools (weak-model trim; listing-only, the rest
 *                         stay callable via tools:find).
 *
 * Returns the home-relative dir, or null on any failure (caller falls back to OMP's native default
 * — no regression). Exported for tests.
 */
export function writeOmpSessionConfigDir(sessionId, opts = {}, home = homedir()) {
  const {
    discoveryOff = false,
    toolsAllowlist = null,
    operatorUrl = OPERATOR_URL,
    model = null,
    // Authoritative gateway registry bytes from bootstrap account routing.
    // When present they replace (not merge with) the user's global registry so
    // a selected auto/pin route cannot be shadowed by a direct provider entry.
    modelsYml = null,
    clientId = null,
    backendWindow = null,
    // P-019 residual sampler (D-010): the launcher is the ONLY layer that knows
    // whether this session is interactive (headless members / piped launches are
    // not) — thread the truthful bit so the gateway's sampler honors the
    // interactive-only gate instead of guessing. Default false: under-claiming
    // interactivity only skips samples (conservative), never mis-samples.
    interactive = false,
  } = opts;
  try {
    if (!sessionId) return null;
    const srcAgent = join(home, '.omp', 'agent');
    const srcCfg = join(srcAgent, 'config.yml');
    if (!existsSync(srcCfg)) return null;
    const rel = join('.papercusp', 'su-omp-homes', `session-${sessionId}`);
    const dstAgent = join(home, rel, 'agent');
    mkdirSync(dstAgent, { recursive: true });
    // config.yml — copy verbatim, optionally flipping discoveryMode off (full mode). String
    // surgery on the stable installer-managed keys (a YAML parse/emit would risk reordering).
    let cfg = readFileSync(srcCfg, 'utf8');
    if (discoveryOff) {
      cfg = cfg
        .replace(/^(\s*discoveryMode:\s*)(?:mcp-only|all|auto)\s*$/gm, '$1off')
        .replace(/^(\s*discoveryMode:\s*)true\s*$/gm, '$1false');
    }
    // Disable the `eval` builtin (py/js/rb/jl) in THIS psu agent session's config copy ONLY — never
    // the user's global ~/.omp, which keeps eval for their own DIRECT (non-psu) omp use. A weak local
    // model reflexively runs MCP calls as `eval` code and DOOM-LOOPS on it (WI-2382 iter4/5: 56–80×,
    // fatal); removing it from the surface is the fix that works (a coord-hook execution-block alone
    // doesn't stop the model REACHING for it). This replaces the former GLOBAL `omp config set
    // eval.*=false` in ensure-omp-su, which leaked the disable into the user's own non-psu omp (owner
    // scoping fix 2026-07-04 / WI-2382). Remove any inherited `eval:` block, then append a canonical
    // all-off one — deterministic whether the copied global had eval on, off, or absent.
    cfg = cfg.replace(/^eval:[ \t]*\n(?:[ \t]+\S.*\n?)*/gm, '');
    if (!cfg.endsWith('\n')) cfg += '\n';
    cfg += 'eval:\n  py: false\n  js: false\n  rb: false\n  jl: false\n';
    // Deterministic compaction for LOCAL-model sessions (deterministic-context-carry P-001,
    // ornith overflow 2026-07-13): omp's default strategy `snapcompact` archives history as
    // IMAGES (useless to a text-only local model) and falls back to LLM summarization on the
    // session's own saturated single-slot backend — 429 self-starvation, then an un-gated
    // 213K-token send into a 204K window → HTTP 400 and a dead session. `shake` is mechanical
    // (no LLM call, no images) and thresholdPercent 70 fires it well before the wall. Settings
    // live in config.yml (NOT agent/config.json — verified against the omp bundle's settings
    // loader, which migrates legacy settings.json INTO config.yml). Same remove-then-append
    // surgery as `eval` above; hosted-model sessions keep the copied config untouched.
    const effModel = model || cfg.match(/modelRoles:[\s\S]*?\n[ \t]+default:[ \t]*([^\s#]+)/)?.[1]?.trim() || null;
    const localModel = isWeakOmpModel(effModel);
    // WI-5047: OMP classifies generic provider HTTP 500 / "internal error" responses as
    // transient and retries them (10 attempts by default). A local llama-server CUDA
    // allocation failure is process-startup state, not a request-level transient: replaying
    // the same request immediately only creates a noisy retry storm and hides the original
    // actionable cudaMalloc error. Papercusp owns this relocated config, so LOCAL sessions
    // fail loud on the first provider error. Hosted OMP sessions retain the user's/native
    // retry policy. Remove both supported config spellings before appending the canonical
    // local-only block so an inherited global retry policy cannot override it.
    if (localModel) {
      cfg = cfg
        .replace(/^retry:[ \t]*\n(?:[ \t]+\S.*\n?)*/gm, '')
        .replace(/^retry\.[A-Za-z.]+:.*\n?/gm, '');
      if (!cfg.endsWith('\n')) cfg += '\n';
      cfg += 'retry:\n  enabled: false\n';
    }
    // remoteEndpoint (deterministic-context-carry P-002): route the summarizer's LLM call to
    // the gateway's reserved maintenance lane instead of the session's own backend. The path
    // is LOCKSTEP with operator-core inference-gateway/gateway.ts MAINTENANCE_SUMMARIZE_PATH
    // (plain .mjs — no TS import; same mirror rule as OMP_LOCAL_MODEL_PREFIXES above). omp
    // THROWS on a remoteEndpoint failure (no local fallback), so it is seeded ONLY where the
    // gateway is already a hard dependency (a papercusp-gateway/-routed model) or where the
    // alternative is worse (a weak local model summarizing on its own saturated slot).
    const gwp = Number(process.env.PAPERCUSP_GATEWAY_PORT);
    const gwPort = Number.isFinite(gwp) && gwp > 0 ? gwp : 8788;
    // DETERMINISTIC CARRY cutover (deterministic-context-carry P-017, WI-4845;
    // P-022/WI-4998 removed the PAPERCUSP_OMP_CARRY_COMPACTION emergency opt-out —
    // native compaction is retired, so there is nothing to opt back INTO): append
    // ?carryOwner=<coord ownerId>
    // [&carryWindow=<probed backend tokens>] so the gateway answers the compaction from the
    // deterministic carry-doc builder instead of the LLM oneshot. Requires the per-session
    // coord ownerId (opts.clientId): without it there is no owner to build a carry doc
    // for, so the session runs the mechanical `shake` strategy instead (below).
    const carryOptIn = !!clientId;
    const carryBw = Number(backendWindow);
    // &carryInteractive=1 (P-019, D-010): threads the launcher's truthful
    // interactivity knowledge to the gateway's residual sampler — headless /
    // piped sessions omit it and their boundaries are skipped (graded by the
    // P-020 drills instead). An older gateway ignores the extra param.
    const carryParams = carryOptIn
      ? `?carryOwner=${encodeURIComponent(clientId)}${Number.isFinite(carryBw) && carryBw > 0 ? `&carryWindow=${carryBw}` : ''}${interactive ? '&carryInteractive=1' : ''}`
      : '';
    const remoteEndpointLine = `  remoteEndpoint: "http://127.0.0.1:${gwPort}/maintenance/summarize${carryParams}"\n`;
    // P-022 (WI-4998, owner terminal state 2026-07-14 "remove the compact call
    // entirely"): EVERY omp session — local, gateway-routed, AND direct-API
    // hosted — gets the papercusp compaction block; omp's native strategies
    // (snapcompact et al.) are retired fleet-wide. This supersedes the P-001
    // "never force shake on a hosted model" decision. Strip any inherited
    // block, then append the canonical one:
    //   • carry-opted (clientId present): `context-full` + remoteEndpoint with
    //     carryOwner params — the summarize call is answered DETERMINISTICALLY
    //     by the gateway's carry-doc builder (P-017), never an LLM oneshot.
    //   • no clientId: mechanical `shake` (no LLM call, no endpoint line) — no
    //     gateway hard-dependency is introduced where none existed (omp THROWS
    //     on a remoteEndpoint failure with no local fallback).
    cfg = cfg
      .replace(/^compaction:[ \t]*\n(?:[ \t]+\S.*\n?)*/gm, '')
      .replace(/^compaction\.[A-Za-z.]+:.*\n?/gm, '');
    if (!cfg.endsWith('\n')) cfg += '\n';
    // Threshold (P-007): when the LIVE backend window was probed (P-005), the cut fires at the
    // DERIVED hard tier — window − maxTurn, one full doored hop of headroom by construction
    // (Ornith → 96; the P-006 doors bound what a hop can add, and omp ≥16.3.3's pre-flight
    // guard fail-louds a doomed send as the wall backstop). Derived from the SAME
    // effectiveWindow = min(configured, backend) the registry copy below clamps to — omp
    // measures its % against that clamped contextWindow, so a percent from the raw probe
    // would under-reserve when the configured limit is deliberately smaller. No probe
    // (gateway down / hosted model) → the conservative pre-P-007 constant 70, since
    // nothing then bounds the hop.
    let shakePct = 70;
    const shakeBw = Number(backendWindow);
    if (Number.isFinite(shakeBw) && shakeBw > 0) {
      let shakeWindow = shakeBw;
      try {
        const srcYml = join(srcAgent, 'models.yml');
        const configured = existsSync(srcYml)
          ? readModelsYmlContextWindow(readFileSync(srcYml, 'utf8'), bareOmpModelId(effModel || ''))
          : null;
        if (configured) shakeWindow = Math.min(configured, shakeBw);
      } catch {
        /* fail-soft: the raw probed window still yields a sane hard tier */
      }
      shakePct = computeCompactionThresholdPercents(shakeWindow).hardPct;
    }
    cfg += `compaction:\n  strategy: ${carryOptIn ? 'context-full' : 'shake'}\n  thresholdPercent: ${shakePct}\n${carryOptIn ? remoteEndpointLine : ''}`;
    writeFileSync(join(dstAgent, 'config.yml'), cfg, { mode: 0o600 });
    // Faithful model registry + auth so model resolution + provider baseUrls survive the
    // relocation (the data root collapses onto the relocated configRoot; missing registry ⇒
    // "model not found"). Skip the big session/history dbs — a fresh session recreates them.
    //
    // effectiveWindow clamp (deterministic-context-carry P-005): when the caller probed the LIVE
    // backend window (opts.backendWindow, from the gateway /maintenance/backend-context read),
    // this session's registry copies are rewritten so EVERY source agrees on
    // effectiveWindow = min(configured models.yml limit, live backend n_ctx) — eliminating the
    // three-way contextWindow conflict (models.yml 200000 vs backend 204800 vs stale models.json
    // 57344) at the one seam every psu omp session passes through. A configured limit ABOVE the
    // live backend window is the 2026-07-13 overflow class (the session believes it has room the
    // backend cannot hold) — clamped here, loudly. Only THIS model's entries are touched; hosted
    // siblings keep their registry values.
    const bwNum = Number(backendWindow);
    const clampBare = Number.isFinite(bwNum) && bwNum > 0 && effModel ? bareOmpModelId(effModel) : '';
    let effectiveWindow = null;
    let effectiveMaxTokens = null;
    for (const f of ['models.yml', 'models.json', 'models.db', 'auth.json', 'claude-bridge.json', 'config.json', 'SYSTEM.md']) {
      const s = join(srcAgent, f);
      if (f === 'models.yml' && typeof modelsYml === 'string' && modelsYml.trim()) {
        writeFileSync(join(dstAgent, f), modelsYml, { mode: 0o600 });
        continue;
      }
      if (!existsSync(s)) continue;
      if (clampBare && f === 'models.yml') {
        let text = readFileSync(s, 'utf8');
        const configured = readModelsYmlContextWindow(text, clampBare);
        effectiveWindow = configured ? Math.min(configured, bwNum) : bwNum;
        if (configured && configured > bwNum) {
          console.error(
            `psu: CONFIG ERROR — models.yml contextWindow ${configured} for ${clampBare} EXCEEDS the live backend window ${bwNum}; ` +
              `clamping this session's registry to ${effectiveWindow}. Fix the registry: a configured limit above what the backend serves is the 2026-07-13 overflow class.`,
          );
        }
        text = rewriteModelsYmlContextWindow(text, clampBare, effectiveWindow);
        // Output door (P-006 enforcement leg (a)): maxTokens = the max_tokens request param
        // omp sends per hop. min(existing, door) — the door only ever TIGHTENS a registry
        // value, never raises one a smaller model deliberately set low.
        const outputDoor = computeOutputDoorTokens(effectiveWindow);
        const configuredMax = readModelsYmlField(text, clampBare, 'maxTokens');
        effectiveMaxTokens = configuredMax ? Math.min(configuredMax, outputDoor) : outputDoor;
        text = rewriteModelsYmlField(text, clampBare, 'maxTokens', effectiveMaxTokens);
        console.error(`psu: per-hop doors for ${clampBare}: maxTurn ${computeMaxTurnTokens(effectiveWindow)} → output door (max_tokens) ${effectiveMaxTokens} at effectiveWindow ${effectiveWindow}.`);
        writeFileSync(join(dstAgent, f), text, { mode: 0o600 });
        continue;
      }
      if (clampBare && f === 'models.json' && effectiveWindow) {
        const fields = { contextWindow: effectiveWindow };
        if (effectiveMaxTokens) fields.maxTokens = effectiveMaxTokens;
        const text = rewriteModelsJsonFields(readFileSync(s, 'utf8'), clampBare, fields);
        writeFileSync(join(dstAgent, f), text, { mode: 0o600 });
        continue;
      }
      cpSync(s, join(dstAgent, f));
    }
    // OAuth credential store — symlink, never copy (see writeOmpSessionConfigDir doc).
    linkOmpAgentDb(srcAgent, dstAgent);
    // mcp.json — carry the papercusp-su server (else the relocated session has NO MCP at all).
    // A default trimmed launch also prunes the SERVER map to papercusp-su + optional context7;
    // otherwise every future server added to the user's global config silently joins every weak
    // worker. Explicit --context-size=full and role launches omit toolsAllowlist, preserving the
    // complete user-selected server map as their opt-out.
    const srcMcp = join(srcAgent, 'mcp.json');
    if (existsSync(srcMcp)) {
      let mcpText = readFileSync(srcMcp, 'utf8');
      if (toolsAllowlist && toolsAllowlist.length) mcpText = filterTrimmedOmpMcpServers(mcpText);
      mcpText = applyOmpOperatorOrigin(mcpText, operatorUrl);
      if (toolsAllowlist && toolsAllowlist.length) mcpText = applyOmpToolsAllowlist(mcpText, toolsAllowlist);
      // Stamp the caller's backend (always omp here) + resolved model so the operator can inherit
      // them for a fleet this session launches (fleet-launch-agent-inheritance-2026-07-03).
      // WI-1866: ALSO stamp the per-session coord ownerId as `client=` — the user-level template
      // bakes a single PER-MACHINE client id, and omp (unlike claude's ${PAPERCUSP_SID} url
      // env-expansion) can't interpolate the SID at connect, so every omp session on the box
      // collapsed into ONE in-band coord identity: shared claims (fleet:assignments showed one
      // agent doing every member's work), void claim-conflict protection between members, and
      // wakes to the transcript-visible identity black-holing (sessions 9980–9982, 2026-07-03).
      // Overriding client= per-session is exactly how claude/codex thread identity (_mcp-handler
      // resolution: x-papercusp-client header || mcp-session || ?client=).
      mcpText = applyOmpMcpUrlParams(mcpText, { agent: 'omp', model: model || undefined, client: clientId || undefined });
      writeFileSync(join(dstAgent, 'mcp.json'), mcpText, { mode: 0o600 });
    }
    return rel;
  } catch (e) {
    console.error(`psu: omp per-session config setup failed (${e?.message ?? e}); falling back to OMP default.`);
    return null;
  }
}

export function ompDefaultModelAdvisory(home = homedir()) {
  try {
    const text = readFileSync(join(home, '.omp', 'agent', 'config.yml'), 'utf8');
    const m = text.match(/modelRoles:[\s\S]*?\n[ \t]+default:[ \t]*([^\s#]+)/);
    const def = m?.[1]?.trim();
    if (def && /^ollama\//i.test(def)) {
      return (
        `psu: omp's default model is ${def} (a local model with a small context) — if your first turn ` +
        `errors with "exceeds the available context size", run /model to pick a larger one ` +
        `(e.g. papercusp-gateway/claude-sonnet-4-6).`
      );
    }
  } catch {
    /* no / unreadable config.yml → no advisory */
  }
  return null;
}

/**
 * Env for a resumed session. Pure — exported for tests. Identity + scope
 * SURVIVE the resume (psu-workspace-scoping fix):
 *   - A tracked row's `coordOwnerId` is re-exported as PAPERCUSP_SID —
 *     wake-executor semantics. The old behavior (fresh random SID per
 *     resume) orphaned the original SID's locks/awaits/presence and
 *     detached the live session from its adv row mid-stream.
 *   - The row's `workspaceId` is re-exported as PAPERCUSP_WORKSPACE — the
 *     carrier claude's user-level MCP url (`${PAPERCUSP_WORKSPACE:-}`) and
 *     omp's x-papercusp-workspace header expand at connect. Without it a
 *     resumed session lost workspace scoping and every workspace-scoped
 *     tool failed "no workspace transaction".
 * Untracked sessions (no adv row) have neither → fresh SID, no workspace;
 * the operator's SID→adv-row fallback can't help those either.
 *
 * `fork: true` INVERTS the identity rule on purpose: a fork is a genuinely new
 * session, not a second body of the original, so it ALWAYS gets a fresh SID and
 * NO adv-row link — that is what lets a fork run concurrently with the still-live
 * original without colliding on its locks/presence/inbox-wake. Workspace scope
 * still carries over (the fork stays in the same workspace).
 */
export function resumeEnvFor(session, { mintSid = () => `su-${randomUUID()}`, fork = false } = {}) {
  if (fork) {
    return {
      PAPERCUSP_AGENT: session.agent,
      PAPERCUSP_SID: mintSid(),
      ...(session.workspaceId ? { PAPERCUSP_WORKSPACE: session.workspaceId } : {}),
      ...(session.harnessSlug ? { PAPERCUSP_HARNESS_SLUG: session.harnessSlug } : {}),
    };
  }
  return {
    PAPERCUSP_AGENT: session.agent,
    PAPERCUSP_SID: session.coordOwnerId || mintSid(),
    ...(session.workspaceId ? { PAPERCUSP_WORKSPACE: session.workspaceId } : {}),
    ...(session.harnessSlug ? { PAPERCUSP_HARNESS_SLUG: session.harnessSlug } : {}),
    ...(session.id != null ? { PAPERCUSP_ADV_SESSION_ID: String(session.id) } : {}),
  };
}

/**
 * Decide how the account is chosen for a RESUME launch. Pure — exported for
 * tests. The gateway account pin is spawn-env only (never persisted on the
 * session), so a resume otherwise silently falls back to the default credential
 * (verified: launchResume never re-folds gatewaySpawnEnv). Option 1 (owner,
 * 2026-06-19): re-prompt on an interactive resume, neutral default.
 *   - explicit `--account` → honored in ANY mode (no prompt)
 *   - interactive (picker)  → prompt (pickAccount; itself a no-op + no prompt
 *                             when the gateway is off / the pool is empty)
 *   - --no-picker scripting → none → default credential, byte-identical to the
 *                             pre-account resume (no surprise prompt in scripts)
 */
export function resumeAccountPlan(args) {
  if (args.account) return { source: 'flag', account: args.account, prompt: false };
  if (args.picker) return { source: 'prompt', account: null, prompt: true };
  return { source: 'none', account: null, prompt: false };
}

/**
 * The full env for a resume launch — identity + workspace scope (resumeEnvFor),
 * the psu agent-session marker, and the re-pinned account env. Pure — exported
 * for tests. With no `accountEnv`, the account routing stays byte-identical to
 * the pre-account resume; `accountEnv.env` layers the gateway pin on top.
 */
export function buildResumeEnv(session, { fork = false, brain = false, accountEnv = null } = {}) {
  return {
    ...resumeEnvFor(session, { fork }),
    // Anything launched/resumed through psu is an agent session for hook
    // purposes. Direct non-psu Claude terminals remain unmarked and keep the
    // owner-session exemption in pretooluse-bash-resource-gate.sh.
    PAPERCUSP_AGENT_SESSION: '1',
    // P-022: a resume spawns a NEW CLI process, so the native-compaction
    // retirement env must be re-stamped exactly as on a fresh launch — without
    // it a resumed Claude session silently regains native auto-compact + /compact.
    ...nativeCompactionEnv(session?.agent),
    ...(accountEnv?.env ?? {}),
  };
}

/** Restore the per-session OMP store a tracked launch created. Fresh OMP
 * launches pin BOTH variables because PI_CODING_AGENT_DIR overrides
 * PI_CONFIG_DIR; resumes must do the same or `omp -r <native-id>` searches the
 * global ~/.omp store and reports a perfectly valid tracked thread as missing.
 * The config dir remains home-relative because OMP joins it onto homedir().
 *
 * Also re-heals `agent.db` → global OAuth store (linkOmpAgentDb): pre-fix
 * sessions have an empty real-file agent.db, so a resume without this would
 * keep dropping xai-oauth / other logins even after a fresh-launch fix. */
export function ompTrackedResumeEnv(session, { home = homedir() } = {}) {
  if (session?.agent !== 'omp' || session?.id == null) return {};
  const rel = join('.papercusp', 'su-omp-homes', `session-${session.id}`);
  const root = join(home, rel);
  if (!existsSync(root)) return {};
  const agentDir = join(root, 'agent');
  linkOmpAgentDb(join(home, '.omp', 'agent'), agentDir);
  return {
    PI_CONFIG_DIR: rel,
    PI_CODING_AGENT_DIR: agentDir,
  };
}

export function ompDirectModelForRoute(model) {
  const value = String(model || '').trim();
  if (!/^papercusp-gateway\//i.test(value)) return model;
  const route = ompGatewayModelFromSpec(value);
  if (!route) {
    throw new Error(
      `OMP gateway selector '${value}' cannot be restored to a compatible direct provider; refusing model substitution`,
    );
  }
  return `${route.gatewayProvider}/${route.modelId}`;
}

/** Apply a selected OMP route to the exact per-session registry used by resume.
 * Auto/pin replace models.yml with the generated gateway provider; default
 * restores the global direct registry so switching modes is reversible. */
export function applyOmpResumeAccountRoute({ session, env, accountRoute, model, home = homedir() }) {
  if (session?.agent !== 'omp') return model;
  const mode = accountRoute?.mode ?? 'default';
  const selectedModel = String(model || '').trim();
  const modelRoute = selectedModel ? ompGatewayModelFromSpec(selectedModel) : null;
  const agentDir = env?.PI_CODING_AGENT_DIR;
  if (!agentDir) {
    if (mode !== 'default') {
      throw new Error('selected OMP gateway route cannot be applied: this resume has no isolated session registry; refusing direct/default fallback');
    }
    return ompDirectModelForRoute(model);
  }
  mkdirSync(agentDir, { recursive: true });
  const target = join(agentDir, 'models.yml');
  if (mode === 'default') {
    const source = join(home, '.omp', 'agent', 'models.yml');
    if (!existsSync(source)) {
      throw new Error('default OMP route cannot be restored: ~/.omp/agent/models.yml is missing');
    }
    copyFileSync(source, target);
    return ompDirectModelForRoute(model);
  }
  if (selectedModel && !modelRoute) {
    throw new Error(
      `OMP model '${selectedModel}' is not compatible with gateway account routing; refusing model substitution`,
    );
  }
  if (modelRoute && accountRoute?.provider && accountRoute.provider !== modelRoute.accountProvider) {
    throw new Error(
      `selected OMP model '${selectedModel}' requires ${modelRoute.accountProvider} accounts, but the resume route resolved ${accountRoute.provider}; refusing model substitution`,
    );
  }
  const config = ompGatewayModelsConfig({
    accountId: mode === 'pin' ? accountRoute.id : null,
    gatewayOn: mode === 'auto',
    provider: modelRoute?.gatewayProvider ?? 'anthropic',
    ownerId: session.coordOwnerId,
    models: modelRoute ? [modelRoute.modelId] : undefined,
  });
  if (!config) {
    throw new Error(`selected OMP ${mode} route could not be rendered; refusing direct/default fallback`);
  }
  writeFileSync(target, config.content, { mode: 0o600 });
  return config.modelSelector;
}

/** The per-account routing header the inference gateway reads + the claude CLI forwards (via
 *  ANTHROPIC_CUSTOM_HEADERS). MUST equal the server's `ACCOUNT_HEADER` (gateway.ts) — pinned in
 *  lockstep by a test. Duplicated here (not imported) so the standalone launcher stays dependency-light. */
export const GATEWAY_ACCOUNT_HEADER = 'x-papercusp-account';

/** The SESSION-IDENTITY header the inference gateway reads to resolve a LIVE, per-request dynamic
 *  pin (account-dynamic-pin-2026-06-29's `ownerPinMap`, set via `accounts:pin`/`accounts:unpin` and
 *  read BEFORE the static `x-papercusp-account` header — gateway.ts `wantAccount = dynPin?.accountId
 *  ?? wantAccountHeader`). MUST equal the server's `OWNER_HEADER` (gateway.ts) — pinned in lockstep by
 *  a test. The fresh-spawn path (spawn-env.ts `gatewaySpawnEnv`) already sends this; the RESUME path
 *  historically never did (WI-4402), which meant `accounts:pin` could set a durable, live re-pin for
 *  ANY owner id but it could never actually reach a `psu --resume`'d session's requests — the dynamic
 *  re-pin mechanism was already fully built (live, durable across gateway restarts) and simply
 *  unreachable from this one launch path. Duplicated here (not imported), same reasoning as
 *  GATEWAY_ACCOUNT_HEADER. */
export const GATEWAY_OWNER_HEADER = 'x-papercusp-owner';

/** Non-secret bearer used only to make a gateway-routed Claude CLI pass its local
 * login gate. The gateway strips it and injects the selected account's real OAuth.
 * MUST equal operator-core inference-gateway/spawn-env.ts GATEWAY_CLIENT_AUTH_TOKEN. */
export const GATEWAY_CLIENT_AUTH_TOKEN = 'papercusp-gateway';

/**
 * The inference-gateway pin env for an account, built CLIENT-SIDE. Pure — exported for tests. Mirrors
 * the server's gatewaySpawnEnv + resolveAccountPin exactly: point the agent at the localhost gateway
 * (which injects the account's OAuth) + carry the per-account routing header the claude CLI forwards.
 * The fresh-launch path gets this folded by the bootstrap-su POST; the RESUME path (no POST) builds it
 * here so it never depends on a server endpoint that may not be deployed where the launcher points.
 *
 * `ownerId` (WI-4402): when provided, ALSO carries the session-identity header (GATEWAY_OWNER_HEADER)
 * so a LIVE `accounts:pin { agent: ownerId, account }` (already durable, already live-effective
 * per-request — no new mechanism) can dynamically re-route this resumed session with no respawn.
 * Omit to keep today's exact behavior (no identity header) — used by existing callers/tests.
 */
export function gatewayPinEnv(account, provider = 'claude', ownerId = undefined) {
  if (provider === 'codex') {
    return { PAPERCUSP_ACCOUNT_ID: account };
  }
  const p = Number(process.env.PAPERCUSP_GATEWAY_PORT);
  const port = Number.isFinite(p) && p > 0 ? p : 8788;
  const headers = [`${GATEWAY_ACCOUNT_HEADER}: ${account}`];
  if (ownerId) headers.push(`${GATEWAY_OWNER_HEADER}: ${ownerId}`);
  return {
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`,
    ANTHROPIC_AUTH_TOKEN: GATEWAY_CLIENT_AUTH_TOKEN,
    ANTHROPIC_CUSTOM_HEADERS: headers.join('\n'),
    PAPERCUSP_ACCOUNT_ID: account,
    [ACCOUNT_ROUTING_MODE_ENV]: 'pin',
  };
}

/**
 * account-routing-3-options (owner, 2026-06-30): the ONE `account` value carries THREE explicit
 * routing modes (mirrors the server's resolveAccountPin keyword handling exactly — kept in lockstep
 * by a test):
 *   - 'default' — '', null, `default`, `none`, `system` → skip the gateway, use the system / CLI
 *                 login credential (THE DEFAULT).
 *   - 'auto'    — `auto`, `gateway` → route through the inference gateway with NO account pin; it
 *                 selects an available pool account and fails over.
 *   - 'pin'     — any other value → a specific pool account id, pinned via the gateway (hard, no
 *                 failover).
 * Pure — exported for tests. The keywords are reserved, so a pool account literally named
 * `auto`/`default`/`none`/`system`/`gateway` can't be pin-targeted (same tradeoff the server makes).
 */
export function accountRoutingMode(value) {
  const v = (value == null ? '' : String(value)).trim().toLowerCase();
  if (v === '' || v === 'default' || v === 'none' || v === 'system') return 'default';
  if (v === 'auto' || v === 'gateway') return 'auto';
  return 'pin';
}

/** Explicit launch-envelope marker for the direct system/CLI credential route.
 * It must be envelope state (not inherited ambient state), because runWrapper uses
 * it to clear every higher-precedence Claude credential before restoring the
 * machine's default login. */
export const ACCOUNT_ROUTING_MODE_ENV = 'PAPERCUSP_ACCOUNT_ROUTING_MODE';

/** The transparent prompt-cache proxy (papercup-cache-proxy.service, P-006). Default-account
 *  sessions point ANTHROPIC_BASE_URL here so the cache-policy body rewrite (extended ttl + the
 *  org-shared tools-span breakpoint) covers them too — they are the LARGEST sharing cohort, and
 *  they deliberately skip the inference gateway, which is the only other rewrite point.
 *  This is NOT an account change: the proxy forwards this session's own credentials verbatim. */
export const CACHE_PROXY_URL = () =>
  process.env.PAPERCUSP_CACHE_PROXY_URL || `http://127.0.0.1:${Number(process.env.PAPERCUSP_CACHE_PROXY_PORT) || 9073}`;

/** Spawn-time liveness gate for the cache proxy, memoized per launcher process.
 *  A DOWN proxy must never block or break a launch: we simply omit ANTHROPIC_BASE_URL and the
 *  session talks to Anthropic directly, exactly as it does today (degrade, never fail). The probe
 *  hits the proxy's LOCAL health route, so it costs nothing upstream. */
let _cacheProxyUp = null;
/** Test seam: force the probe result (and reset the memo) so unit tests stay deterministic
 *  regardless of whether this machine happens to be running the proxy. */
export function __setCacheProxyReachable(v) {
  _cacheProxyUp = v;
}
export function cacheProxyReachable() {
  if (_cacheProxyUp !== null) return _cacheProxyUp;
  if (process.env.PAPERCUSP_CACHE_PROXY_ROUTE === '1') return (_cacheProxyUp = true);
  if (process.env.PAPERCUSP_CACHE_PROXY_ROUTE === '0') return (_cacheProxyUp = false);
  // Under vitest the launcher's pure-function contracts are asserted directly; a live probe
  // would make them depend on this machine's running services. Opt in explicitly instead.
  if (process.env.VITEST) return (_cacheProxyUp = false);
  try {
    const out = execFileSync(
      'curl',
      ['-s', '--max-time', '2', '-o', '/dev/null', '-w', '%{http_code}', `${CACHE_PROXY_URL()}/__cache_proxy_health`],
      { encoding: 'utf8', timeout: 4000 },
    );
    _cacheProxyUp = String(out).trim() === '200';
  } catch {
    _cacheProxyUp = false;
  }
  return _cacheProxyUp;
}

/** Is this base URL our transparent cache proxy (as opposed to an inference-gateway route)?
 *  The distinction matters because the default-account enforcement below CLEARS a base URL —
 *  it exists to stop an inherited GATEWAY route from silently overriding the system login.
 *  The cache proxy is the opposite: it carries the system login through untouched, so it must
 *  survive that clearing. Compared structurally (host+port), not by string, so an equivalent
 *  spelling (localhost vs 127.0.0.1, trailing slash) still matches. */
export function isCacheProxyUrl(url) {
  if (!url) return false;
  try {
    const a = new URL(String(url));
    const b = new URL(CACHE_PROXY_URL());
    const localhost = (h) => (h === 'localhost' || h === '127.0.0.1' || h === '::1' ? '127.0.0.1' : h);
    return localhost(a.hostname) === localhost(b.hostname) && (a.port || '80') === (b.port || '80');
  } catch {
    return false;
  }
}

export function defaultAccountEnv() {
  const env = { [ACCOUNT_ROUTING_MODE_ENV]: 'default' };
  if (cacheProxyReachable()) env.ANTHROPIC_BASE_URL = CACHE_PROXY_URL();
  return env;
}

/**
 * The inference-gateway AUTO-route env, built CLIENT-SIDE. Pure — exported for tests. Mirrors the
 * server's gatewaySpawnEnv(true, {}) for the no-account case: point the agent at the localhost
 * gateway with NO `x-papercusp-account` header, so the gateway auto-selects an available pool
 * account and fails over. Claude carries this route in environment variables.
 * Codex and OMP carry the equivalent unpinned route in per-session config files,
 * so their callers use the returned route mode rather than this helper's env payload.
 *
 * `ownerId` (WI-4402): same session-identity-header treatment as gatewayPinEnv above — carries
 * GATEWAY_OWNER_HEADER when provided (no-op if omitted, unchanged for existing callers/tests) so a
 * LIVE accounts:pin can dynamically move this auto-routed resumed session between pool accounts.
 *
 * WI-39692: the `@param` types below are LOAD-BEARING, not decoration. `psu-launcher.d.mts` is
 * GENERATED from this JSDoc (`npm run gen:declarations`), and without them tsc infers each
 * parameter's type from its DEFAULT VALUE alone — so `ownerId = undefined` was published as
 * `ownerId?: undefined`, making the ownerId feature this very comment documents impossible to
 * call from any TypeScript caller. Do not delete them to "simplify".
 *
 * @param {string} [provider]
 * @param {string} [ownerId]
 */
export function gatewayAutoEnv(provider = 'claude', ownerId = undefined) {
  if (provider !== 'claude') return {};
  const p = Number(process.env.PAPERCUSP_GATEWAY_PORT);
  const port = Number.isFinite(p) && p > 0 ? p : 8788;
  const env = {
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`,
    ANTHROPIC_AUTH_TOKEN: GATEWAY_CLIENT_AUTH_TOKEN,
    [ACCOUNT_ROUTING_MODE_ENV]: 'auto',
  };
  if (ownerId) env.ANTHROPIC_CUSTOM_HEADERS = `${GATEWAY_OWNER_HEADER}: ${ownerId}`;
  return env;
}

export function stripCodexGatewayConfig(configText) {
  return String(configText || '')
    .replace(/# BEGIN PAPERCUSP_CODEX_GATEWAY_ROOT\n[\s\S]*?# END PAPERCUSP_CODEX_GATEWAY_ROOT\n?/g, '')
    .replace(/# BEGIN PAPERCUSP_CODEX_GATEWAY_PROVIDER\n[\s\S]*?# END PAPERCUSP_CODEX_GATEWAY_PROVIDER\n?/g, '')
    .replace(/^\n+/, '');
}

/**
 * Rewrite a codex `config.toml`'s papercusp gateway block for THIS launch's route.
 *
 * WI-39692: the `@param` types are LOAD-BEARING — see the note on gatewayAutoEnv above.
 * `psu-launcher.d.mts` is GENERATED from this JSDoc, and inference-from-default published
 * `ownerId?: null | undefined` (from `ownerId = null`), so passing a real owner id was a
 * type error for every TS caller even though the runtime has always accepted one.
 *
 * @param {string} configText  the existing config.toml text ('' when absent)
 * @param {string | null} [account]  the account id to PIN to, or null for the unpinned/default route
 * @param {{ gatewayOn?: boolean, ownerId?: string | null, keepExistingWhenUnrouted?: boolean }} [opts]
 * @returns {string}
 */
export function codexGatewayConfigPatch(
  configText,
  account = null,
  { gatewayOn = false, ownerId = null, keepExistingWhenUnrouted = false } = {},
) {
  const stripped = stripCodexGatewayConfig(configText).trimEnd();
  const patch = codexGatewayConfigToml(account, { gatewayOn, ownerId });
  if (!patch.root.length && !patch.tables.length) {
    // WI-38706: "no gateway route for THIS launch" must not mean "delete the
    // provider table this thread is already bound to". codex stamps the
    // provider id into every rollout's `session_meta`, then resolves it against
    // the CURRENT config at `thread/resume` — so stripping the table out from
    // under a gateway-born thread fails the resume outright ("Model provider
    // `papercusp-codex-gateway` not found", -32600). A default-route RESUME of
    // such a thread therefore keeps the config as-is; only a launch whose
    // thread never referenced the provider gets the strip.
    if (keepExistingWhenUnrouted) return configText;
    return stripped ? `${stripped}\n` : '';
  }
  return `${patch.root.join('\n')}${stripped ? `${stripped}\n\n` : ''}${patch.tables.join('\n')}`;
}

/** The provider id a codex rollout is BOUND to (`session_meta.model_provider`
 *  on its first line), or null. Read at resume so the route patch below cannot
 *  remove a provider the thread needs. Pure-ish (one file read); exported for
 *  tests. */
export function codexRolloutModelProvider(rolloutPath) {
  try {
    const fh = readFileSync(rolloutPath, 'utf8');
    const firstLine = fh.slice(0, fh.indexOf('\n') === -1 ? fh.length : fh.indexOf('\n'));
    const payload = JSON.parse(firstLine)?.payload;
    const p = payload?.model_provider;
    return typeof p === 'string' && p ? p : null;
  } catch { return null; }
}

const CODEX_CONTEXT_WINDOW_BEGIN = '# BEGIN PAPERCUSP_CODEX_CONTEXT_WINDOW';
const CODEX_CONTEXT_WINDOW_END = '# END PAPERCUSP_CODEX_CONTEXT_WINDOW';

/**
 * Upsert the extended-window keys into a codex `config.toml` (plan
 * codex-1m-context-window-2026-08-17 P-004). Pure — exported for tests.
 *
 * WHY THE FILE AND NOT JUST `-c`: `modelArgsFor` emits the overrides only when
 * a launch NAMES a model, and a bare `psu --resume` names none — so a resumed
 * session would silently drop back to codex's 272k default and start
 * native-compacting at ~258k, under the very soft limit this plan exists to
 * make reachable. The file is what a model-less resume inherits.
 *
 * ⚠ THE BLOCK IS PREPENDED, and that placement is load-bearing, not cosmetic:
 * these are ROOT keys, and in TOML a root key written after any `[table]`
 * header binds to that table instead. Emitting at the top is the only position
 * that is correct regardless of what the rest of the file already contains.
 * For the same reason this must run AFTER codexGatewayConfigPatch, which
 * re-orders the file around its own markers.
 *
 * @param {string} configText  existing config.toml text ('' when absent)
 * @param {string | null} model  the model whose window to declare
 * @returns {string}
 */
export function codexContextWindowConfigPatch(configText, model) {
  const stripped = String(configText || '').replace(
    new RegExp(`${CODEX_CONTEXT_WINDOW_BEGIN}\\n[\\s\\S]*?${CODEX_CONTEXT_WINDOW_END}\\n?`, 'g'),
    '',
  );
  // '' for a model with no extended window — the strip above still runs, so a
  // home that MOVED to such a model loses a stale block rather than keeping a
  // window its new model does not have.
  const body = model ? codexContextConfigToml(model) : '';
  if (!body) return stripped;
  return `${CODEX_CONTEXT_WINDOW_BEGIN}\n${body}${CODEX_CONTEXT_WINDOW_END}\n${stripped}`;
}

/**
 * Write the extended-window block into a session's codex home. The model comes
 * from this launch when it names one, else from the home's OWN `model = ` line
 * (per-session homes carry it) — so a bare resume still refreshes correctly.
 * Returns the model it resolved, or null when it could not act.
 */
function applyCodexContextWindow(codexHome, model = null) {
  try {
    const configPath = join(codexHome, 'config.toml');
    if (!existsSync(configPath)) return null;
    const current = readFileSync(configPath, 'utf8');
    const effective = model || current.match(/^model\s*=\s*["']([^"']+)["']/m)?.[1] || null;
    const next = codexContextWindowConfigPatch(current, effective);
    if (next !== current) writeFileSync(configPath, next, { mode: 0o600 });
    return effective;
  } catch {
    // Never fail a launch over a window optimization — the `-c` args on a
    // model-carrying launch already cover the common path.
    return null;
  }
}

function applyCodexGatewayRoute(
  codexHome,
  { mode = 'default', id = null, ownerId = null, keepExistingWhenUnrouted = false } = {},
) {
  const configPath = join(codexHome, 'config.toml');
  const current = existsSync(configPath) ? readFileSync(configPath, 'utf8') : '';
  writeFileSync(
    configPath,
    codexGatewayConfigPatch(current, mode === 'pin' ? id : null, {
      gatewayOn: mode === 'auto',
      ownerId,
      keepExistingWhenUnrouted,
    }),
    { mode: 0o600 },
  );
}

/**
 * Resolve which fields the flags PRE-SELECT vs which still need an
 * interactive prompt. Pure — exported for tests. Throws on a bad --agent.
 *
 * Any flag you pass preselects that field (the picker skips it); anything
 * you omit is marked `need*` so the interactive picker fills it in. This
 * is what lets you preselect some fields and still get prompted for the
 * rest — e.g. `psu --agent=claude --workspace=ws2` presets agent +
 * workspace and prompts for harness + plan.
 */
export function presetsFromArgs(args) {
  const agent = args.agent || null;
  if (agent && !AGENTS.includes(agent)) {
    throw new Error(`--agent must be one of ${AGENTS.join('|')} (got ${agent})`);
  }
  const harness = args.harness != null && args.harness !== '' ? args.harness : null;
  const planProvided = args.noPlan || (args.plan != null && args.plan !== '');
  return {
    agent,
    workspace: args.workspace || null,
    harness,
    plan: args.noPlan ? null : (args.plan || null),
    needAgent: !agent,
    needWorkspace: !args.workspace,
    needHarness: !harness,
    needPlan: !planProvided,
  };
}

/**
 * Strict (no-prompt) resolution for `--no-picker`. Pure; throws if the
 * required --agent is missing (can't prompt in scripting mode). Omitted
 * workspace/harness/plan fall back to the server defaults (active
 * workspace, workspace root, no plan).
 */
export function selectionsFromArgs(args) {
  const p = presetsFromArgs(args);
  if (p.needAgent) {
    throw new Error(`--agent must be one of ${AGENTS.join('|')} (got ${String(args.agent)})`);
  }
  return { agent: p.agent, workspace: p.workspace, harness: p.harness, plan: p.plan };
}

export function readToken({ home = homedir() } = {}) {
  try {
    return readFileSync(join(home, '.papercusp', 'superuser-token'), 'utf8').trim();
  } catch {
    /* no superuser-token file → fall back to the desktop operator's token below */
  }
  // The desktop operator records its bearer in operator.json (== superuser-token
  // when both exist). Falling back here keeps psu authenticated even if only the
  // operator.json discovery file is present in a fresh desktop install.
  try {
    const d = JSON.parse(readFileSync(join(home, '.papercusp', 'operator.json'), 'utf8'));
    if (d && typeof d.token === 'string' && d.token) return d.token.trim();
  } catch {
    /* none → unauthenticated (dev-box open operator) */
  }
  return '';
}

/**
 * Path to the persisted default-account Claude OAuth token (from `claude
 * setup-token`). 0600. Overridable via env for tests / non-default homes.
 *
 * WHY a stored env-token is the inheritance path (not a file/keychain copy):
 * a psu claude session runs under a per-owner isolated `CLAUDE_CONFIG_DIR`. On
 * Linux/Windows that config dir's `.credentials.json` is healed from the global
 * `~/.claude` login by the reconcile/symlink machinery — but on **macOS** the
 * OAuth token lives in the Keychain keyed by a per-`CLAUDE_CONFIG_DIR` suffix
 * (`Claude Code-credentials-<hash>`), and claude *deletes* any seeded
 * `.credentials.json` after migrating it. So the session's config dir gets a
 * fresh suffix that never matches the default `~/.claude` login → "launches
 * logged out", and no file-based reconcile can fix it (Anthropic docs:
 * file fallback + the CLAUDE_CONFIG_DIR→file relocation are Linux/Windows only).
 * `CLAUDE_CODE_OAUTH_TOKEN` (auth precedence #5, above subscription OAuth #6) is
 * the ONE mechanism that bypasses keychain + file + config-dir-suffix entirely
 * and behaves identically on every OS — exactly the "log in once, inherit in
 * every psu session" the default account wants. (psu-login-inherit / macOS.)
 */
export function claudeOAuthTokenPath({ home = homedir() } = {}) {
  return process.env.PAPERCUSP_CLAUDE_OAUTH_TOKEN_FILE || join(home, '.papercusp', 'claude-oauth-token');
}

/** Read the stored token (trimmed) or null when none/unreadable. */
export function readStoredClaudeOAuthToken({ home = homedir() } = {}) {
  try {
    const p = claudeOAuthTokenPath({ home });
    if (!existsSync(p)) return null;
    const t = readFileSync(p, 'utf8').trim();
    return t || null;
  } catch {
    return null;
  }
}

/**
 * Inject `CLAUDE_CODE_OAUTH_TOKEN` into a DEFAULT-account claude launch so it
 * inherits the single stored CLI login (see `claudeOAuthTokenPath`). Mutates +
 * returns `env`. Skipped — leaving the env byte-identical — when:
 *   - not a claude session (codex/omp authenticate by their own file creds);
 *   - an inference-gateway account is pinned (`ANTHROPIC_BASE_URL` set → the
 *     gateway authenticates; an env bearer would fight its account routing);
 *   - the user already exported a token/key (respect their explicit, and
 *     higher- or equal-precedence, choice);
 *   - no token is stored (→ unchanged: keychain/file OAuth login as before).
 * Pure but for the `env` mutation; `home` injectable for tests.
 */
export function applyDefaultClaudeOAuthToken(
  wrapperBin,
  env,
  { home = homedir(), platform = process.platform } = {},
) {
  if (!/(^|\/)claude(-su)?$/.test(String(wrapperBin || ''))) return env;
  if (env.ANTHROPIC_BASE_URL) return env;
  if (env.CLAUDE_CODE_OAUTH_TOKEN || env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN) return env;
  // Linux/Windows store the real system `/login` in this file. Prefer it over
  // the optional setup-token cache: the file is refreshed by Claude itself,
  // while the cache can be older. macOS is intentionally excluded because its
  // real login is Keychain-backed and the per-session CLAUDE_CONFIG_DIR uses a
  // different Keychain suffix (the reason this fallback exists at all).
  if (platform !== 'darwin' && existsSync(join(home, '.claude', '.credentials.json'))) return env;
  const tok = readStoredClaudeOAuthToken({ home });
  if (tok) env.CLAUDE_CODE_OAUTH_TOKEN = tok;
  return env;
}

/** Claude settings/env selectors that can redirect a launch away from the
 * machine's first-party `/login`. Keep this list aligned with
 * enforceDefaultClaudeAccount and the command-line settings override below.
 *
 * CLAUDE_CODE_OAUTH_TOKEN is deliberately NOT written as an empty
 * `settings.env` value: Claude treats that as an explicit logged-out OAuth
 * choice and will not fall back to `.credentials.json` / Keychain. The ambient
 * value is still deleted by enforceDefaultClaudeAccount; copied user settings
 * are removed by persistDefaultClaudeAuthSettings. */
export const CLAUDE_DEFAULT_AUTH_ENV_KEYS = Object.freeze([
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_CUSTOM_HEADERS',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_OAUTH_TOKEN',
  'ANTHROPIC_IDENTITY_TOKEN',
  'ANTHROPIC_IDENTITY_TOKEN_FILE',
  'ANTHROPIC_AWS_API_KEY',
  'ANTHROPIC_AWS_BASE_URL',
  'ANTHROPIC_BEDROCK_BASE_URL',
  'ANTHROPIC_BEDROCK_MANTLE_BASE_URL',
  'ANTHROPIC_FOUNDRY_API_KEY',
  'ANTHROPIC_FOUNDRY_AUTH_TOKEN',
  'ANTHROPIC_FOUNDRY_BASE_URL',
  'ANTHROPIC_FOUNDRY_RESOURCE',
  'ANTHROPIC_UNIX_SOCKET',
  'ANTHROPIC_VERTEX_BASE_URL',
  'ANTHROPIC_VERTEX_PROJECT_ID',
  'CLAUDE_CODE_API_BASE_URL',
  'CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR',
  'CLAUDE_CODE_HOST_AUTH_ENV_VAR',
  'CLAUDE_CODE_HOST_CREDS_FILE',
  'CLAUDE_CODE_OAUTH_REFRESH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR',
  'CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST',
  'CLAUDE_CODE_SDK_HAS_HOST_AUTH_REFRESH',
  'CLAUDE_CODE_SDK_HAS_OAUTH_REFRESH',
  'CLAUDE_CODE_SESSION_ACCESS_TOKEN',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
  'CLAUDE_CODE_USE_MANTLE',
  'CLAUDE_CODE_USE_ANTHROPIC_AWS',
  'CLAUDE_CODE_USE_GATEWAY',
]);

/** Highest-precedence, secret-free Claude settings overlay for an explicit
 * default-account launch. `--settings` outranks project/local/user settings, so
 * a stale apiKeyHelper, API key, gateway URL, or cloud-provider selector cannot
 * silently win over the system login selected in the UI. */
export function defaultClaudeAuthSettings(routeEnv = {}) {
  const mode = routeEnv?.[ACCOUNT_ROUTING_MODE_ENV] ?? 'default';
  const routedEnv = Object.fromEntries(CLAUDE_DEFAULT_AUTH_ENV_KEYS.map((key) => [key, '']));
  if (mode === 'auto' || mode === 'pin') {
    for (const key of ['ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_CUSTOM_HEADERS']) {
      if (routeEnv?.[key]) routedEnv[key] = routeEnv[key];
    }
  } else if (isCacheProxyUrl(routeEnv?.ANTHROPIC_BASE_URL)) {
    // P-006: the cache proxy is a same-credential passthrough, not a route override — keep it
    // so this settings overlay (which outranks project/user settings) doesn't blank it back out.
    routedEnv.ANTHROPIC_BASE_URL = routeEnv.ANTHROPIC_BASE_URL;
  }
  return {
    apiKeyHelper: '',
    env: routedEnv,
  };
}

/** Add the default-account settings override at the central wrapper seam
 * shared by fresh, resume, and fork launches. Pure; exported for regression
 * coverage. */
export function applyDefaultClaudeAuthSettingsArgs(wrapperBin, args, env) {
  const list = Array.isArray(args) ? args : [];
  if (!/(^|\/)claude(-su)?$/.test(String(wrapperBin || ''))) return list;
  if (!['default', 'auto', 'pin'].includes(env?.[ACCOUNT_ROUTING_MODE_ENV])) return list;
  // Global options must precede subcommands (`claude auth status --settings`
  // is rejected), so prepend rather than append. This is also valid for the
  // normal interactive/resume argv where every remaining token is an option or
  // the optional kickoff prompt.
  return ['--settings', JSON.stringify(defaultClaudeAuthSettings(env)), ...list];
}

/**
 * Make an EXPLICIT `default` Claude launch mean exactly what the picker says:
 * use the system / CLI login, regardless of the parent shell's prior account.
 *
 * Claude credential env vars outrank its config-dir login. Merely removing the
 * inference-gateway URL is therefore insufficient: a resumed auto/pinned session
 * (or a shell with a direct API/OAuth token) can otherwise keep using that inherited
 * credential after the user selects `default`. Clear every Claude direct/gateway
 * credential here; applyDefaultClaudeOAuthToken then restores the stored system
 * OAuth token, while launchResume's rehealResumeCredentials points the isolated
 * config dir back at the global system credential on file-based platforms.
 *
 * The marker is applied only by Papercusp's account-routing decision. A direct
 * non-psu Claude invocation, and role launches without that decision, retain their
 * explicitly exported credentials.
 */
export function enforceDefaultClaudeAccount(wrapperBin, env) {
  if (!/(^|\/)claude(-su)?$/.test(String(wrapperBin || ''))) return env;
  if (env[ACCOUNT_ROUTING_MODE_ENV] !== 'default') return env;
  // P-006: preserve a cache-proxy base URL across the credential purge below. The purge targets
  // inherited GATEWAY/API credentials that would outrank the system login; the cache proxy
  // forwards that same system login verbatim, so clearing it would only cost us the cache
  // policy. Re-applied after the loop so the key list stays the single source of truth.
  const keepCacheProxy = isCacheProxyUrl(env.ANTHROPIC_BASE_URL) ? env.ANTHROPIC_BASE_URL : null;
  for (const key of [
    ...CLAUDE_DEFAULT_AUTH_ENV_KEYS,
    'PAPERCUSP_ANTHROPIC_URL',
    'PAPERCUSP_ACCOUNT_ID',
    'PAPERCUSP_CODEX_GATEWAY',
    'CLAUDE_CODE_OAUTH_TOKEN',
  ]) {
    delete env[key];
  }
  if (keepCacheProxy) env.ANTHROPIC_BASE_URL = keepCacheProxy;
  return env;
}

/**
 * The OAuth-bundle expiry (epoch ms) recorded in a claude `.credentials.json`,
 * or -1 when absent/unreadable. Mirrors reconcileClaudeCredentials's
 * newest-expiresAt-wins key. Pure; exported for tests.
 */
export function claudeCredExpiresAt(path) {
  try {
    const j = JSON.parse(readFileSync(path, 'utf8'));
    const o = j.claudeAiOauth ?? j;
    return Number(o.expiresAt ?? o.expires_at) || 0;
  } catch {
    return -1;
  }
}

/**
 * Re-heal a resumed session's isolated `.credentials.json` (psu-resume-relogin,
 * owner-reported 2026-07-12).
 *
 * A FRESH launch runs bootstrap-su → `writeInteractiveClaudeConfig`, which
 * reconciles credentials to the newest bundle (`reconcileClaudeCredentials`) and
 * then symlinks `<configDir>/.credentials.json` → the global
 * `~/.claude/.credentials.json`. A RAW `psu --resume` (`launchResume`) never did
 * that leg — it only re-points `CLAUDE_CONFIG_DIR` at the existing isolated dir.
 * But claude REPLACES `.credentials.json` on every OAuth refresh (temp+rename),
 * so an in-session refresh swaps the symlink for a divergent real-file fork;
 * with Anthropic's single-use rotating refresh tokens that fork goes stale, and
 * the background reconciler (`claude-credential-sync`) may not have converged it
 * by resume time — so a default-account resume "launches logged out" and
 * prompts a re-login even though the system account IS logged in. (A fresh
 * launch re-heals every time, which is why only `--resume` regressed.)
 *
 * Re-establish the fresh-mirror invariant right before spawn: keep the global on
 * the newest bundle (promote the strictly-newest real-file fork — newest-
 * expiresAt wins, matching reconcileClaudeCredentials) and re-point the session
 * credential at it via symlink. Best-effort — a launch must NEVER fail on
 * credential reconciliation, and a healthy symlink is left byte-identical.
 * Linux/Windows file path; a gateway-pinned resume skips this (it authenticates
 * via `ANTHROPIC_BASE_URL`) and macOS inherits via the OAuth-token path
 * (`applyDefaultClaudeOAuthToken`). `home` injectable for tests.
 *
 * DURABILITY (WI-4727 follow-up, 2026-07-14): the promotion sweeps EVERY
 * real-file fork under the session-claude root (`promoteNewestForkToGlobal`),
 * not just this session's own — a pairwise this-session-vs-global check missed
 * a fresher token sitting in a *different* concurrently-running session's
 * fork, which the background reconciler's debounce/interval hadn't yet
 * converged. This resume path now performs the same full-fleet
 * newest-wins convergence a fresh launch gets from `reconcileClaudeCredentials`,
 * just re-implemented locally (this script has no dependency on the
 * operator-core TS package it lives in).
 */
export function rehealResumeCredentials(configDir, { home = homedir() } = {}) {
  try {
    if (!configDir) return;
    const globalPath = join(home, '.claude', '.credentials.json');
    if (!existsSync(globalPath)) return; // API-key-only / fresh box: nothing to mirror
    const sessPath = join(configDir, '.credentials.json');
    // Healthy: already a symlink resolving to the (reconciler-kept-newest)
    // global — claude will follow it to a live token. Leave byte-identical.
    try {
      if (lstatSync(sessPath).isSymbolicLink() && realpathSync(sessPath) === realpathSync(globalPath)) return;
    } catch {
      /* missing, or a dangling symlink — fall through and (re)heal */
    }
    // Sweep every OTHER real-file fork under the session-claude root for a
    // bundle strictly newer than the global — a CONCURRENT session's
    // in-session refresh the background reconciler (claude-credential-sync,
    // debounced/interval-polled) hasn't converged yet. (WI-4727 durability
    // follow-up: the original resume-time reheal only ever promoted THIS
    // session's own fork, so a fresher token sitting in a *different* live
    // session's fork was invisible to a resume landing on a merely-stale — not
    // necessarily the oldest — fork; the symlink invariant "degrades in-session"
    // faster than a narrow pairwise check can chase.)
    promoteNewestForkToGlobal(home, globalPath);
    // A real-file fork of THIS session strictly NEWER than the (possibly
    // just-updated) global: promote it too. Kept in addition to the sweep
    // above because `configDir` is not guaranteed to live under the default
    // session-claude root (a relocated/custom config dir the sweep can't
    // discover) — this direct check is location-independent.
    let sessIsSymlink = false;
    try {
      sessIsSymlink = lstatSync(sessPath).isSymbolicLink();
    } catch {
      /* missing */
    }
    if (!sessIsSymlink && existsSync(sessPath) && claudeCredExpiresAt(sessPath) > claudeCredExpiresAt(globalPath)) {
      try {
        copyFileSync(sessPath, globalPath);
      } catch {
        /* keep the global as-is on failure */
      }
    }
    // Re-point the session credential at the global CLI login, exactly as
    // writeInteractiveClaudeConfig's fresh mirror does.
    rmSync(sessPath, { force: true });
    symlinkSync(globalPath, sessPath);
  } catch {
    /* a launch must NEVER fail on credential reconciliation */
  }
}

/**
 * Scan every real-file (non-symlink) `.credentials.json` fork under the
 * session-claude root (`sessionClaudeRoot`) for a bundle strictly newer than
 * `globalPath`'s CURRENT bundle, and promote the single newest one found into
 * the global file. Mirrors `reconcileClaudeCredentials`'s (claude-credential-
 * sync.ts) newest-expiresAt-wins key — duplicated here rather than imported,
 * because `psu-launcher.mjs` runs as a plain node script outside the
 * operator-core TS package/build (see the file-top note on this module's
 * dependency surface). Best-effort: a missing session root, or a read/copy
 * failure on any one fork, degrades to skipping that fork — never throws.
 */
function promoteNewestForkToGlobal(home, globalPath) {
  const root = sessionClaudeRoot(home);
  let dirs = [];
  try {
    dirs = readdirSync(root);
  } catch {
    return; // no session-claude root yet
  }
  let bestPath = null;
  let bestExp = claudeCredExpiresAt(globalPath);
  for (const dir of dirs) {
    const p = join(root, dir, '.credentials.json');
    let isSymlink = false;
    try {
      isSymlink = lstatSync(p).isSymbolicLink();
    } catch {
      continue; // missing — nothing to consider
    }
    if (isSymlink) continue; // resolves to the global; nothing to promote
    const exp = claudeCredExpiresAt(p);
    if (exp > bestExp) {
      bestExp = exp;
      bestPath = p;
    }
  }
  if (bestPath) {
    try {
      copyFileSync(bestPath, globalPath);
    } catch {
      /* keep the global as-is on failure */
    }
  }
}

/**
 * Make the GitHub Copilot MCP plugin AUTHENTICATE instead of failing. That plugin (a Claude
 * plugin OMP also discovers via claude-plugin discovery) sends
 * `Authorization: Bearer ${GITHUB_PERSONAL_ACCESS_TOKEN}`; when the env var is unset the header is
 * a bare `Bearer ` and the server rejects it ("Authorization header is badly formatted", HTTP 400)
 * on EVERY claude/omp launch. The `gh` CLI already holds a working token (verified: it
 * authenticates the Copilot MCP → HTTP 200), so export it into the agent env when unset. Fail-soft:
 * no gh / not logged in → env untouched (the plugin then fails exactly as before, never worse).
 * Mutates + returns env. `runGh` injectable for tests.
 */
export function applyGithubTokenEnv(
  env,
  { runGh = () => spawnSync('gh', ['auth', 'token'], { encoding: 'utf8', timeout: 5000 }) } = {},
) {
  if (env.GITHUB_PERSONAL_ACCESS_TOKEN) return env;
  try {
    const out = runGh();
    const tok = (out && out.status === 0 ? String(out.stdout || '') : '').trim();
    if (tok) env.GITHUB_PERSONAL_ACCESS_TOKEN = tok;
  } catch {
    /* gh missing / not logged in → leave env unchanged (fail-soft) */
  }
  return env;
}

/** Persist the default-account Claude OAuth token (0600); creates ~/.papercusp. */
export function storeClaudeOAuthToken(token, { home = homedir() } = {}) {
  const t = String(token || '').trim();
  if (!t) throw new Error('refusing to store an empty Claude OAuth token');
  const p = claudeOAuthTokenPath({ home });
  mkdirSync(join(home, '.papercusp'), { recursive: true });
  writeFileSync(p, t + '\n', { mode: 0o600 });
  // writeFileSync's mode is ignored when the file pre-existed — force 0600.
  try { chmodSync(p, 0o600); } catch { /* best-effort on platforms w/o chmod */ }
  return p;
}

/**
 * Resilient fetch: retries CONNECTION failures (refused/reset — "fetch failed",
 * i.e. the operator is mid-recycle) on a short backoff until `connectBudgetMs`
 * elapses, so a launch rides THROUGH a memory-watchdog drain+restart window
 * instead of failing on the first dead tick. TIMEOUTs (reachable but slow —
 * wedged, not restarting) are retried only a small fixed number of times, since
 * each retry costs another full timeout. A caller-supplied `init.signal` owns
 * the request lifetime and disables retry. Returns the Response (caller reads
 * the body); throws a descriptive Error when every attempt fails.
 *
 * On repeated connection failure it additionally attempts ONE health-gated
 * FAILOVER to a different live operator (resolveFallbackOperatorTargets:
 * proxy → fresh operator.json → dev default) and adopts it session-wide
 * (adoptOperatorTarget) — the stale-shell heal for terminals whose
 * PAPERCUSP_OPERATOR_URL outlived the per-boot desktop operator port.
 *
 * Deps are injected for tests (psu-launcher.test.ts) — `fetchImpl`/`sleep`/`now`
 * make the retry timing deterministic without real timers or sockets.
 */
export async function fetchWithResilience(
  url,
  init = {},
  {
    fetchImpl = fetch,
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
    now = () => Date.now(),
    onNotice = (msg) => process.stderr.write(msg),
    timeoutMs = REQUEST_TIMEOUT_MS,
    connectBudgetMs = CONNECT_RETRY_BUDGET_MS,
    timeoutRetries = TIMEOUT_RETRIES,
    label = url,
    target = OPERATOR_TARGET,
    // Stale-shell heal (mac VM owner repro 2026-07-07): when the target keeps
    // refusing, look ONCE for a DIFFERENT live operator (proxy → fresh
    // operator.json → dev default), health-check it, and switch — instead of
    // burning the whole budget on a dead per-boot port a long-lived terminal
    // window pinned via PAPERCUSP_OPERATOR_URL.
    resolveFallback = resolveFallbackOperatorTargets,
    onFailover = adoptOperatorTarget,
    healthProbeTimeoutMs = 2_000,
  } = {},
) {
  // A caller-supplied AbortSignal owns the request lifetime — never retry it.
  const callerSignal = init.signal ?? null;
  const retryable = !callerSignal;
  // WI-3271: a desktop (operator.json-discovered) target whose record is old is
  // almost certainly a DEAD operator (app closed / supervision gave up), not a
  // mid-restart one — shrink the connection-retry budget so psu answers in
  // seconds with the "start the Papercusp app" guidance instead of sitting
  // quietly through the full ride-through window.
  const targetAgeMs = target?.source === 'discovery' && target.startedAt ? now() - target.startedAt : null;
  const targetStale = targetAgeMs != null && targetAgeMs > STALE_DISCOVERY_MS;
  const effectiveConnectBudgetMs = targetStale ? Math.min(connectBudgetMs, STALE_FAST_FAIL_BUDGET_MS) : connectBudgetMs;
  // Wall-clock deadline for retrying CONNECTION failures (host mid-recycle).
  const connectDeadline = now() + effectiveConnectBudgetMs;
  let timeoutRetriesLeft = timeoutRetries;
  let announcedConnRetry = false;
  let failoverAttempted = false;
  let lastErr;
  for (;;) {
    try {
      return await fetchImpl(url, {
        ...init,
        // Without a timeout a wedged operator hangs psu indefinitely. Fail fast.
        signal: callerSignal ?? AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      lastErr = e;
      if (!retryable) break;
      const isTimeout = e?.name === 'TimeoutError' || e?.name === 'AbortError';
      if (isTimeout) {
        // Reachable but slow (wedged, not restarting) — a retry costs another
        // full timeout, so only a small fixed number of them.
        if (timeoutRetriesLeft <= 0) break;
        timeoutRetriesLeft -= 1;
        onNotice(`psu: ${label} timed out after ${timeoutMs}ms — retrying…\n`);
        await sleep(1_500);
        continue;
      }
      // Connection refused/reset ("fetch failed") — the operator is almost
      // certainly mid-recycle or a deploy swap, unreachable for ~10-15s. Retry
      // on a short backoff until the budget elapses so the launch rides through,
      // instead of failing on the first dead window (the single 1.5s retry this
      // replaced couldn't span a recycle).
      const remaining = connectDeadline - now();
      if (remaining <= 0) break;
      if (!announcedConnRetry) {
        onNotice(
          targetStale
            ? `psu: the Papercusp app's server at ${target.url} isn't answering (${label}) and its boot record is ` +
              `${fmtAgo(targetAgeMs)} old — checking for ${Math.ceil(effectiveConnectBudgetMs / 1000)}s…\n`
            : `psu: operator at ${target?.url ?? OPERATOR_URL} unreachable (${label}) — it may be restarting; ` +
              `retrying for up to ${Math.ceil(effectiveConnectBudgetMs / 1000)}s…\n`,
        );
        announcedConnRetry = true;
      }
      // Stale-shell heal: ONE failover attempt per call. Only when this
      // request actually targets the failing session target (a caller-custom
      // operatorUrl is never rebased), and only to a candidate that answers
      // /api/health right now — a mid-restart operator's candidates all fail
      // the health probe, so the normal ride-through behavior is unchanged.
      // ('dev-default' is exempt: it's a bare-dev-box guess, not a recorded or
      // pinned address — its ride-through semantics stay exactly as before.)
      if (!failoverAttempted && target?.source !== 'dev-default') {
        failoverAttempted = true;
        const base = target?.url ?? null;
        if (base && url.startsWith(base)) {
          let switched = false;
          for (const cand of resolveFallback({ excludeUrls: [base] })) {
            try {
              const h = await fetchImpl(`${cand.url}/api/health`, {
                signal: AbortSignal.timeout(healthProbeTimeoutMs),
              });
              if (!h?.ok) continue;
            } catch {
              continue;
            }
            onNotice(
              `psu: ${base} is not answering but a live operator is at ${cand.url} (${cand.source}) — switching. ` +
                (target?.source === 'env'
                  ? `This shell's PAPERCUSP_OPERATOR_URL pins a dead address (desktop operator ports change per boot); ` +
                    `sessions launched from here now inherit the working one.\n`
                  : `Its recorded address was stale; continuing on the live one.\n`),
            );
            url = cand.url + url.slice(base.length);
            target = cand;
            onFailover(cand);
            switched = true;
            break;
          }
          if (switched) continue; // retry immediately on the healed target
        }
      }
      await sleep(Math.min(2_000, remaining));
    }
  }
  const e = lastErr;
  const shownUrl = target?.url ?? OPERATOR_URL;
  // WI-3271: guidance must match the install. A desktop (discovery) target has
  // no systemd — telling a Windows/desktop user to systemctl is a dead end; the
  // fix there is starting (or restarting) the Papercusp app itself.
  const isDesktop = target?.source === 'discovery';
  if (e?.name === 'TimeoutError' || e?.name === 'AbortError') {
    throw new Error(
      `the operator at ${shownUrl} did not respond within ${timeoutMs}ms (${label}). ` +
        (isDesktop
          ? `It may be wedged — restart the Papercusp desktop app, `
          : `It may be wedged — restart it (systemctl --user restart papercup-dev-api.service), `) +
        `or raise the cap with PAPERCUSP_PSU_TIMEOUT_MS.`,
    );
  }
  if (target?.source === 'env') {
    throw new Error(
      `the operator URL this shell pins via PAPERCUSP_OPERATOR_URL (${shownUrl}) refused connections for ` +
        `${Math.ceil(effectiveConnectBudgetMs / 1000)}s and no live fallback operator answered either. ` +
        `Desktop operator ports change per boot, so a terminal window can outlive its operator — open a fresh ` +
        `terminal from the Papercusp app, or \`unset PAPERCUSP_OPERATOR_URL\` to use discovery (~/.papercusp/operator.json).`,
    );
  }
  if (isDesktop) {
    throw new Error(
      `the Papercusp app's server isn't running (${shownUrl} refused for ${Math.ceil(effectiveConnectBudgetMs / 1000)}s` +
        (targetAgeMs != null ? `; it last reported up ${fmtAgo(targetAgeMs)} ago` : '') +
        `). Start (or restart) the Papercusp desktop app, wait for it to finish loading, then re-run psu. ` +
        `Override with PAPERCUSP_OPERATOR_URL.`,
    );
  }
  throw new Error(
    `could not reach the operator at ${shownUrl} after ${Math.ceil(effectiveConnectBudgetMs / 1000)}s (${e?.message || e}). ` +
      `Is the desktop/operator running? Override with PAPERCUSP_OPERATOR_URL.`,
  );
}

async function api(path, opts = {}) {
  const token = readToken();
  const res = await fetchWithResilience(
    OPERATOR_URL + path,
    {
      ...opts,
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(opts.headers || {}),
      },
    },
    { label: path },
  );
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { status: 'error', error: text.slice(0, 200) };
  }
  if (!res.ok || json.status === 'error') {
    // json.error may be a string OR a structured object ({code, message}) — coerce
    // to a real message so we never surface "[object Object]".
    const err = json.error;
    const msg =
      typeof err === 'string'
        ? err
        : err?.message || (err ? JSON.stringify(err) : `HTTP ${res.status} from ${path}`);
    const failure = new Error(msg);
    failure.status = res.status;
    failure.path = path;
    throw failure;
  }
  return json;
}

async function pickAgent() {
  const { select } = await import('@inquirer/prompts');
  return select({
    message: 'Agent',
    choices: [
      { name: 'claude', value: 'claude' },
      { name: 'omp', value: 'omp' },
      { name: 'codex', value: 'codex' },
    ],
  });
}

// su-context-size-variants: the per-variant ~Nk figures shown in the picker —
// parity with the operator UI's SU_CONTEXT_OPTIONS (AdvSessionsClient.tsx). STATIC
// measured estimates. Re-measured 2026-07-02 AFTER the Phase-3 cuts (fleet persona
// tier, P-020 plugin prune, P-015 zero-AGENTS.md): trimmed turn-1 boot is 60.1k on a
// sonnet fleet member / ~66k fable fleet / ~76k full-persona power launch — the old
// '~83k' (P-018, pre-Phase-3, full persona) over-stated by ~15-20k. '~70k' is the
// honest mid; the preflight guard below does the exact per-launch math anyway.
export const SU_CONTEXT_TOKEN_ESTIMATES = { full: '~180k', trimmed: '~70k' };

// su-context-size-variants: the terminal-picker choices — the twin of the UI's
// SU_CONTEXT_OPTIONS. Native maps to null (⇒ no --context-size flag ⇒ byte-identical
// to the pre-feature launch); 'full'/'trimmed' match the flag values + the UI enum.
// 'trimmed' is the picker's DEFAULT selection (core spine + native soft-trim keeps
// initial context small without giving up on-demand discovery) — Native and Full are
// still one keypress away for whoever wants the whole catalog or the pre-feature launch.
export const SU_CONTEXT_CHOICES = [
  { name: 'Native', value: null },
  { name: `Full · ${SU_CONTEXT_TOKEN_ESTIMATES.full}  (whole tool catalog up-front)`, value: 'full' },
  { name: `Trimmed · ${SU_CONTEXT_TOKEN_ESTIMATES.trimmed}  (core spine, native soft-trim) (default)`, value: 'trimmed' },
];

// su-context-size-variants: the picker's default SELECTION (highlighted row when the
// prompt opens; Enter with no arrow keys picks this). Trimmed keeps initial context
// small without giving up on-demand discovery. Native/Full remain one keypress away.
export const SU_CONTEXT_DEFAULT = 'trimmed';

// ── Launch preflight guards (context-trimming-tiers P-016 / P-018) ──────────

/** Numeric per-variant baseline estimates (tokens) for the NON-persona context
 *  (tool catalog + static prefix). The persona playbook is measured from the
 *  actual prompt file at launch, so only the remainder is estimated here.
 *  Re-derived 2026-07-02 from live turn-1 boots minus the measured persona file:
 *  60.1k sonnet-fleet − 15.6k persona ≈ 44.5k; 76.2k power − ~28k ≈ 48k; 66.1k
 *  fable-fleet − 16k ≈ 50k → 50k (top of the measured band, guard stays
 *  conservative). Assumes ToolSearch deferral is ON (the launch tail forces
 *  ENABLE_TOOL_SEARCH=true for non-full launches — without it a gateway-routed
 *  member boots ~46k heavier, P-031 gap 3). */
export const SU_BASELINE_NON_PERSONA_TOKENS = RUNTIME_OVERHEAD_TOKENS;

/**
 * P-016 persona-append assertion: with the $HOME AGENTS.md mirrors gone
 * (P-015), the --append-system-prompt file IS the session's whole behavioral
 * spine — a missing/empty/tiny prompt file means a bare agent with no
 * playbook. Fail LOUD before spawning instead of launching a spineless
 * session. Returns the file's byte size for the window guard.
 */
export function assertLaunchPersona(promptFile) {
  const MIN_PERSONA_BYTES = 2_000;
  if (!promptFile) {
    throw new Error(
      'psu: launch spec carried NO persona prompt file — refusing to launch a session with no behavioral spine (context-trimming-tiers P-016).',
    );
  }
  let size = 0;
  try {
    size = statSync(promptFile).size;
  } catch {
    throw new Error(
      `psu: persona prompt file missing/unreadable at ${promptFile} — refusing to launch (context-trimming-tiers P-016).`,
    );
  }
  if (size < MIN_PERSONA_BYTES) {
    throw new Error(
      `psu: persona prompt file at ${promptFile} is only ${size} bytes (< ${MIN_PERSONA_BYTES}) — the playbook did not render/append; refusing to launch (context-trimming-tiers P-016).`,
    );
  }
  return size;
}

/**
 * opus + fable + sonnet-5 default to the FULL 1M window (owner directive
 * 2026-07-02): inject the `[1m]` marker into their model spec so EVERY
 * downstream `[1m]` consumer — the preflight window guard, the
 * context-size/tier derivation, and the `--model` passthrough that makes
 * Claude Code / the gateway enable the 1M-context window — treats them as 1M.
 * Idempotent; a no-op for a spec already carrying `[1m]` or outside the
 * default-1M families. `[1m]` is inserted before a recognized `:effort`
 * suffix, else appended. Papercusp then caps their compaction at 400k —
 * named-fleet MEMBERS at 200k (owner directive 2026-07-19, superseding the
 * 300k of 2026-07-03; agent-config-constants
 * COMPACTION_LIMIT_DEFAULT_1M_FLEET_MEMBER_CAP / defaultCompactionLimitForSpec)
 * — to bound token spend. The same two caps now bind extended-window CODEX
 * sessions (plan codex-1m-context-window-2026-08-17 D-001), which previously
 * seeded 158k because the window resolver only recognized this `[1m]` marker.
 * sonnet-5 REQUIRES the marker too — REVERSAL of the earlier P-031 note
 * (2026-07-02), live-verified via `/context` the same day: bare `--model
 * sonnet` runs a 200k AUTO-COMPACT window in CC 2.1.198 ("76k/200k ·
 * Auto-compact window: 200k tokens" — auto-fires ~167k, which killed a whole
 * wave of sonnet fleet members at preTokens 167-170k on 2026-07-02), while
 * `--model 'sonnet[1m]'` runs "76k/967k · Auto-compact window: 967k tokens".
 * The CC binary's 967k default for sonnet-5 sits behind a staged-rollout gate
 * (statsig `tengu_amber_moleskin`, OFF here), so despite sonnet-5 being
 * natively 1M-capable the `[1m]` marker is the only reliable way to get the
 * big window. The bare `sonnet` alias (whole spec) also counts: CC resolves it
 * to the latest sonnet = sonnet-5 (live-verified 2026-07-02). Kept in lockstep
 * with agent-config-constants `isDefault1mModelSpec` via DEFAULT_1M_FAMILY_RE.
 */
export const DEFAULT_1M_FAMILY_RE = /fable|opus|sonnet-?5|^sonnet(\[1m\])?(:[a-z0-9]+)?$/i;

export function normalizeModelSpec(spec) {
  if (!spec || /\[1m\]/i.test(spec) || !DEFAULT_1M_FAMILY_RE.test(spec)) return spec;
  const c = spec.lastIndexOf(':');
  const suffix = c > 0 ? spec.slice(c + 1) : '';
  if (c > 0 && /^(low|medium|high|xhigh|max)$/i.test(suffix)) return `${spec.slice(0, c)}[1m]${spec.slice(c)}`;
  return `${spec}[1m]`;
}

/** Apply Claude Code's private window marker only at a Claude boundary.
 * OMP model ids are provider-configured/open vocabulary, and Codex has its
 * own context controls, so both must remain byte-identical. */
export function normalizeModelSpecForAgent(agent, spec) {
  if (agent === 'claude') return normalizeModelSpec(spec);
  if (agent === 'codex' && spec) return normalizeCodexCliModel(spec);
  return spec;
}

// (The COMPACTION_LIMIT_1M_* mirrors lived here for the P-014 window backstop
// until P-022 retired native auto-compact outright — agent-config-constants
// remains the canonical home of the soft limits themselves.)

/**
 * P-022 (deterministic-context-carry-2026-07-14, WI-4998; owner terminal state
 * 2026-07-14 "remove the compact call entirely") — native compaction is RETIRED
 * for every Claude launch. Returns the env fragment setting Claude Code's
 * `DISABLE_AUTO_COMPACT` (verified against the CC 2.1.x binary: the auto-compact
 * predicate short-circuits false on a truthy value before the `autoCompactEnabled`
 * setting is even read), so the native summarizer can never fire — papercusp
 * carry (builder + respawn/handoff + shake) is the only compaction path.
 *
 * The boundary ladder that replaced the old P-014 window backstop
 * (`CLAUDE_CODE_AUTO_COMPACT_WINDOW`, whose CC 2.1.x fire-point math is
 * preserved in git history should it ever need resurrecting): per-turn context
 * nudges from 85% → self carry-respawn (session:request-compaction) → the
 * compliance watchdog's soft-threshold carry-respawn → its 1.3× force-respawn →
 * the hard-wall death detector (improvements watchdog "Prompt is too long").
 * `{}` for non-claude: OMP compaction is papercusp-owned via its relocated
 * config (strategy `context-full`/`shake` + the gateway carry lane), and Codex
 * launches are audited separately (they have their own context controls).
 */
export function nativeCompactionEnv(agent) {
  // DISABLE_AUTO_COMPACT kills the automatic fire; DISABLE_COMPACT removes the
  // /compact command itself (both binary-verified CC 2.1.x envs) — the owner
  // terminal state is "no /compact", not merely "no auto-compact", and the
  // harness no longer types it either (session:request-compaction and the
  // watchdog both drive mode:'carry-respawn' now).
  return agent === 'claude' ? { DISABLE_AUTO_COMPACT: '1', DISABLE_COMPACT: '1' } : {};
}

/** The canonical BARE cloud model aliases psu recognizes. Short + lowercase. The CLI/gateway own
 *  the full OPEN set of ids, so this list is used ONLY to spot an obviously-misspelled short alias
 *  (validateModelSpec) — never to gate full/provider ids. Includes Anthropic (opus/sonnet/haiku/fable)
 *  and OpenAI GPT-5.6 (sol/terra/luna) families. */
export const KNOWN_CLOUD_ALIASES = ['opus', 'sonnet', 'haiku', 'fable', 'sol', 'terra', 'luna'];

/** Native backend hint for unambiguous cloud model families. Unknown model ids
 * stay open-set and return null; explicit OMP remains valid for either family.
 *
 * ⚠ The `@returns` is load-bearing, not decoration (EI-19384804106131566). Left to
 * inference, this union's MEMBER ORDER is not stable across tsc invocations that
 * differ only in `outDir`: `gen:declarations` (outDir `.`) emitted
 * `"codex" | "claude"` while `gen:declarations:check` (outDir a temp dir) emitted
 * `"claude" | "codex"` from byte-identical sources, so the check reported this
 * declaration permanently stale and no amount of regenerating converged. Pinning the
 * order here makes the emit invariant. Do not remove it, and prefer an explicit
 * `@returns` on any other exported function whose inferred return is a union.
 *
 * @returns {'codex' | 'claude' | null}
 */
export function cloudModelBackendHint(model) {
  if (!model) return null;
  const withoutEffort = String(model).trim().replace(/:(low|medium|high|xhigh|max)$/i, '');
  const base = withoutEffort.replace(/\[[^\]]+\]$/, '');
  if (/^ollama(-cc)?\//i.test(base) || /\bornith\b/i.test(base)) return null;
  if (
    /^(luna|terra|sol)$/i.test(base) ||
    /^gpt(?:[-_.]|\d)/i.test(base) ||
    /^o\d(?:[-_.]|$)/i.test(base) ||
    /(?:^|[-_.\/])codex(?:[-_.\/]|$)/i.test(base)
  ) return 'codex';
  if (
    /^(opus|sonnet|haiku|fable)$/i.test(base) ||
    /^claude(?:[-_.\/]|$)/i.test(base) ||
    /^anthropic[.\/]claude(?:[-_.\/]|$)/i.test(base)
  ) return 'claude';
  return null;
}

/** Reject a native cloud model paired with the other native CLI. */
export function validateAgentModelPair(agent, model) {
  const hintedBackend = cloudModelBackendHint(model);
  if (!agent || agent === 'omp' || !hintedBackend || agent === hintedBackend) return { ok: true };
  return {
    ok: false,
    message:
      `model \`${model}\` belongs to the \`${hintedBackend}\` backend, but this launch requested ` +
      `\`--agent=${agent}\`. Pass \`--agent=${hintedBackend}\`, or omit \`--agent\` and let psu infer it.`,
  };
}

/** Damerau optimal-string-alignment distance: Levenshtein PLUS adjacent transpositions as a single
 *  edit — so a swap typo (`fabel`↔`fable`) is distance 1, without widening the substitution radius
 *  (`o3`/`gpt4`/`grok` stay far from every alias). Tiny; only ever run over the ~4 known aliases. */
function damerauDistance(a, b) {
  const al = a.length;
  const bl = b.length;
  if (!al) return bl;
  if (!bl) return al;
  const d = Array.from({ length: al + 1 }, () => new Array(bl + 1).fill(0));
  for (let i = 0; i <= al; i++) d[i][0] = i;
  for (let j = 0; j <= bl; j++) d[0][j] = j;
  for (let i = 1; i <= al; i++) {
    for (let j = 1; j <= bl; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1); // adjacent transposition
      }
    }
  }
  return d[al][bl];
}

/** Nearest known cloud alias to a (letters-only) token, with its Damerau distance. */
function nearestCloudAlias(letters) {
  const t = String(letters || '').toLowerCase();
  let alias = null;
  let dist = Infinity;
  for (const a of KNOWN_CLOUD_ALIASES) {
    const d = damerauDistance(t, a);
    if (d < dist) {
      dist = d;
      alias = a;
    }
  }
  return { alias, dist };
}

/**
 * Validate a hand-typed `--model` spec, catching the malformed-alias classes that otherwise
 * reach the CLI as an unrunnable model and fail the launch with NO useful hint (WI-1979):
 *   (1) a psu-INTERNAL `[1m]` 1M-window marker typed as INPUT on a bare non-family alias
 *       (`fabel5[1m]`) — psu APPENDS `[1m]` (see normalizeModelSpec); it is never something you type;
 *   (2) a bare short cloud alias that is a CLOSE misspelling of a known one (`fabel`→fable, `sonet`,
 *       `sonnet5`, `opus4`);
 *   (3) a known alias glued or dash/dot-separated to a version — `sonnet-5`, `opus-4.8`, `haiku-4` —
 *       the marketing name typed instead of the bare alias (or a full `claude-…` id). The most common agent typo.
 * Deliberately LENIENT — cloud model ids are an OPEN set (the CLI/gateway own the canonical list).
 * It only inspects values that unambiguously look like a bare short alias (pure letters, or
 * letters+digits). A dashed/dotted/slashed/versioned id (`claude-fable-5`, `anthropic.claude-3-5-…`,
 * a future `claude-newfam-6`, and legit `[1m]` round-trips like `claude-fable-5[1m]`) is a plausible
 * full id and PASSES UNCHECKED; so does a plausible non-alias short id (`o3`, `gpt4`) that is NOT a
 * close typo of a known alias, and any local/ollama id (validated separately by fuzzyEnum). Returns
 * { ok:true } | { ok:false, message }. Pure + exported. NO leading 'psu:' in the message — the
 * top-level launch catch prepends it.
 */
export function validateModelSpec(spec) {
  if (!spec) return { ok: true };
  const s = String(spec).trim();
  if (!s) return { ok: true };
  if (/^ollama(-cc)?\//i.test(s) || /\bornith\b/i.test(s)) return { ok: true }; // local — not ours to check
  // Peel a recognized :effort tail so we inspect the model BASE (an unrecognized ':x' — bedrock's
  // '…-v2:0' — stays on the base, which then contains ':' → not alias-shaped → passes below).
  const c = s.lastIndexOf(':');
  const effort = c > 0 && /^(low|medium|high|xhigh|max)$/i.test(s.slice(c + 1)) ? s.slice(c + 1) : null;
  const base = effort ? s.slice(0, c) : s;
  // Peel a trailing [..] window marker: 'fable[1m]' → core 'fable', hadMarker true.
  const mk = base.match(/^(.*?)(\[[^\]]*\])$/);
  const core = mk ? mk[1] : base;
  const hadMarker = !!mk;
  const isPure = /^[a-z]+$/i.test(core); // opus, fabel
  const isLettersDigits = /^[a-z]+[0-9]+$/i.test(core); // fabel5, sonnet5, o3
  if (isPure && KNOWN_CLOUD_ALIASES.includes(core.toLowerCase())) return { ok: true }; // opus / fable / fable[1m]
  // (3) a known alias glued or dash/dot-separated to a version — `sonnet-5`, `opus-4.8`, `haiku-4`,
  //     `sonnet5` — the marketing name typed instead of the BARE alias (or a full id). The single most
  //     common malformed spec agents produce: psu resolves the bare alias to the latest generation and
  //     appends [1m], so `sonnet-5` reaches the CLI as an unrunnable id. A genuine full id starts with a
  //     VENDOR prefix (`claude-…`, `anthropic.…`), never a bare alias, so it is unaffected — checked HERE,
  //     BEFORE the dash/version passthrough below that would otherwise wave `sonnet-5` through as a full id.
  const aliasVer = core.toLowerCase().match(/^(opus|sonnet|haiku|fable|sol|terra|luna)(?=[-.]?[0-9])/);
  if (aliasVer) {
    const fam = aliasVer[1];
    const prefix = /^(sol|terra|luna)$/i.test(fam) ? 'gpt-5.6-' : 'claude-';
    return {
      ok: false,
      message:
        `\`${s}\` is not a recognized model spec. Did you mean \`${effort ? `${fam}:${effort}` : fam}\`? ` +
        `Type the BARE alias (${KNOWN_CLOUD_ALIASES.join('/')}) — psu resolves it to the latest generation, appending the [1m] 1M-context window — ` +
        `not a versioned shorthand; pin a specific generation only as a full id (e.g. ${prefix}${fam}-5).`,
    };
  }
  // A full/provider id (dashes/dots/slashes/version) is NOT alias-shaped → open set, pass — including
  // a legit '[1m]' round-trip on a full id (e.g. 'claude-fable-5[1m]').
  if (!isPure && !isLettersDigits) return { ok: true };
  // Bare short token that is NOT a known alias (fabel / fabel5 / o3 / grok). Reject only when it is
  // either wearing a [1m] marker (never valid on a non-family bare token) OR a CLOSE typo (Damerau
  // distance ≤ 1) of a known alias — so genuinely-unknown ids like `o3` / `gpt4` pass untouched.
  const near = nearestCloudAlias(core.replace(/[0-9]+$/, ''));
  const closeTypo = near.alias != null && near.dist <= 1;
  if (!hadMarker && !closeTypo) return { ok: true };
  const suggestion = closeTypo
    ? ` Did you mean \`${effort ? `${near.alias}:${effort}` : `${near.alias}:xhigh`}\`?`
    : '';
  const markerTip = hadMarker
    ? ' The `[1m]` 1M-context marker is appended AUTOMATICALLY by psu — do not type it.'
    : '';
  return {
    ok: false,
    message:
      `\`${s}\` is not a recognized model spec.${suggestion}${markerTip} ` +
      `Cloud models: \`<alias>[:<effort>]\` — aliases ${KNOWN_CLOUD_ALIASES.join('/')}, ` +
      `effort low|medium|high|xhigh|max (e.g. \`fable:xhigh\`) — or a full id (e.g. claude-fable-5, anthropic.claude-…).`,
  };
}

/**
 * P-018 preflight window guard: estimate the session's BASELINE context
 * (persona file + catalog/prefix estimate) against the model window.
 *   - ≥60% of the window → refuse (unless force) — the session would have
 *     almost no working headroom and dies mid-task ("Prompt is too long").
 *   - ≥35% → warn loudly, proceed.
 * Pure + exported for tests; the caller decides how to surface it.
 */
export function preflightWindowGuard({ personaBytes, contextSize, model, agent = 'claude', budget = null }) {
  const shared = budget?.version === 1
    ? budget
    : buildContextBudget({
        agent,
        model,
        contextSize,
        estimatedPromptTokens: Math.round((personaBytes ?? 0) / 3.7),
      });
  return {
    level: shared.level,
    pct: shared.pct,
    estTokens: shared.baselineTokens,
    window: shared.window,
    budget: shared,
  };
}

/** Run both preflight guards before a launch; exits/throws per policy. */
export function runLaunchPreflight({ promptFile, contextSize, model, agent = 'claude', budget = null, force }) {
  const personaBytes = assertLaunchPersona(promptFile);
  const guard = preflightWindowGuard({ personaBytes, contextSize, model, agent, budget });
  if (guard.level === 'refuse' && !force) {
    throw new Error(
      `psu: estimated baseline context ~${Math.round(guard.estTokens / 1000)}k tokens is ${Math.round(guard.pct * 100)}% of the ${Math.round(guard.window / 1000)}k model window — the session would die mid-task ("Prompt is too long"). Use --context-size=trimmed / a wider-window model, or --force to launch anyway (context-trimming-tiers P-018).`,
    );
  }
  if (guard.level !== 'ok') {
    console.error(
      `psu: WARNING — estimated baseline context ~${Math.round(guard.estTokens / 1000)}k tokens (${Math.round(guard.pct * 100)}% of the ${Math.round(guard.window / 1000)}k window)${guard.level === 'refuse' ? ' [--force override active]' : ''} — headroom is thin; prefer --context-size=trimmed or a wider-window model (P-018).`,
    );
  }
  return guard;
}

/** su-context-size-variants: choose the initial-context size for the SU session —
 *  the terminal-picker twin of the operator UI's Full/Trimmed toggle. Defaults to
 *  'trimmed' (core spine + the client's native soft-trim) — Native (null) skips the
 *  flag entirely (byte-identical to the pre-feature launch) and 'full' loads the whole
 *  tool catalog up-front; both remain explicit picker choices. Threads into
 *  args.contextSize, honored per-agent in the launch tail (claude ENABLE_TOOL_SEARCH,
 *  omp PI_CONFIG_DIR, codex/server via the bootstrap body's context_size). */
async function pickContextSize() {
  const { select } = await import('@inquirer/prompts');
  return select({ message: 'Context size', default: SU_CONTEXT_DEFAULT, choices: SU_CONTEXT_CHOICES });
}

// Subagent-launch (Task/Agent) picker toggle (owner mandate 2026-07-02). Denied by
// DEFAULT for every psu launch; this is the interactive opt-IN twin of the
// `--allow-subagents` flag. Disabled is the highlighted default (Enter = deny), so
// a launch keeps subagents ONLY when the human deliberately arrows to Enabled.
export const SU_SUBAGENTS_CHOICES = [
  { name: 'Disabled — cannot launch subagents (default)', value: false },
  { name: 'Enabled — allow the built-in subagent-launch (Task/Agent) tool', value: true },
];

/** Choose whether this session may launch subagents. Denied by default; returns a
 *  boolean threaded into args.allowSubagents (→ roleLaunchArgs/suLaunchArgs). A
 *  `--allow-subagents` / `--no-subagents` flag preselects + skips this (mirrors
 *  --context-size). claude-only — omp/codex have no deny flag and are unaffected. */
async function pickSubagents() {
  const { select } = await import('@inquirer/prompts');
  return select({ message: 'Subagents', default: false, choices: SU_SUBAGENTS_CHOICES });
}

/** Pick a workspace. Harnesses are workspace-scoped, so this comes
 *  before the harness picker. Auto-resolves (no prompt) when there's
 *  0 or 1 workspace. Returns the workspace id (or null → active). */
async function pickWorkspace() {
  const { workspaces, activeWorkspace } = await api('/api/agent-mcp/console/bootstrap-su/options');
  if (!Array.isArray(workspaces) || workspaces.length <= 1) {
    return activeWorkspace ?? (workspaces && workspaces[0] ? workspaces[0].id : null);
  }
  const { select } = await import('@inquirer/prompts');
  return select({
    message: 'Workspace',
    default: activeWorkspace ?? undefined,
    choices: workspaces.map((w) => ({
      name: w.id === activeWorkspace ? `${w.name}  (active)` : w.name,
      value: w.id,
    })),
  });
}

function filterRows(rows, term) {
  const t = (term || '').toLowerCase();
  return t ? rows.filter((r) => r.name.toLowerCase().includes(t)) : rows;
}

async function pickHarness(workspace) {
  const { search } = await import('@inquirer/prompts');
  const q = workspace ? `?workspace=${encodeURIComponent(workspace)}` : '';
  const { harnesses, workspace: ws } = await api(`/api/agent-mcp/console/bootstrap-su/options${q}`);
  const rows = [
    { name: `· workspace root — no harness  [${ws}]`, value: null },
    ...harnesses.map((h) => ({ name: h.status ? `${h.slug}  (${h.status})` : h.slug, value: h.slug })),
  ];
  return search({
    message: 'Harness',
    source: async (term) => filterRows(rows, term),
  });
}

async function pickPlan(workspace, harness) {
  const { search } = await import('@inquirer/prompts');
  let plans = [];
  if (harness) {
    try {
      const params = new URLSearchParams({ harness });
      if (workspace) params.set('workspace', workspace);
      const r = await api(`/api/agent-mcp/console/bootstrap-su/options?${params.toString()}`);
      plans = r.plans || [];
    } catch {
      plans = [];
    }
  }
  const rows = [
    { name: 'NO PLAN — ad-hoc SU session', value: NO_PLAN },
    ...plans.map((p) => ({ name: p.slug, value: p.slug })),
  ];
  return search({
    message: 'Plan',
    source: async (term) => filterRows(rows, term),
  });
}

/**
 * psu-account-chooser P-005: pick a pool account to pin this session to (gateway
 * routing), or the default credential. Returns the account id, or null for "no pin"
 * — INCLUDING when the picker is hidden: gateway off, an empty pool, or any fetch
 * error. The picker can only return default when no nondefault routes are
 * available; explicit `--account auto|<pin>` flags are validated separately and
 * fail closed. The "default" row is FIRST so hitting enter keeps today's behavior;
 * accounts blocked by the active session-override are shown disabled.
 */
/** The account-pin choices the gateway offers for a workspace (gatewayOn + pool + session-override).
 *  Live `/options` endpoint — deployed everywhere, unlike a bespoke pin endpoint (deploy-skew safe).
 *  null on any error (fail-soft → no pin). */
async function fetchAccountChoices(workspace, agent = 'claude') {
  try {
    const params = new URLSearchParams();
    if (workspace) params.set('workspace', workspace);
    if (agent) params.set('agent', agent);
    const q = params.toString() ? `?${params.toString()}` : '';
    return (await api(`/api/agent-mcp/console/bootstrap-su/options${q}`)).accounts ?? null;
  } catch {
    return null;
  }
}

/** Build the account picker rows from already-fetched choices. Pure so the
 * provider-specific routing contract is regression-testable without driving
 * Inquirer. */
export function accountPickerChoices(accounts) {
  const pool = Array.isArray(accounts?.pool) ? accounts.pool : [];
  // psu-account-chooser: ALWAYS show the picker (at least the default option) so
  // the choice is consistent across machines — a fresh install with no gateway
  // pool still gets the "default = system/CLI login" row, instead of silently
  // skipping the screen the dev box shows. (Was: hidden when pool empty.)
  const exclude = new Set(accounts?.excludeAccounts ?? []);
  const forced = new Set(accounts?.forcedAccounts ?? []);
  // account-routing-3-options: offer auto only when the provider has a usable
  // pool. Claude carries the unpinned route in env; Codex carries it in the
  // per-session CODEX_HOME provider block (WI-3645). OMP requests are resolved
  // against their model's underlying Claude/Codex provider before reaching here.
  const provider = accounts?.provider ?? 'claude';
  const showAuto = pool.length > 0 && (provider === 'claude' || provider === 'codex');
  return [
    { name: '· default — use the system / CLI login (skip the inference gateway)', value: null },
    ...(showAuto
      ? [{ name: '· auto — route via the inference gateway (it picks a pool account + fails over)', value: 'auto' }]
      : []),
    ...pool.map((id) => {
      const blocked = exclude.has(id) || (forced.size > 0 && !forced.has(id));
      const tag = exclude.has(id) ? '  (excluded)' : forced.size > 0 && !forced.has(id) ? '  (not in allow-list)' : '';
      return { name: `${id}${tag}  (pin via the gateway)`, value: id, disabled: blocked ? '(blocked by session-override)' : false };
    }),
  ];
}

/** Render the account picker from already-fetched choices. Returns the chosen id, or null for
 *  "default credential — no pin" / an empty pool (gateway off). */
async function promptAccount(accounts) {
  const { select } = await import('@inquirer/prompts');
  const choices = accountPickerChoices(accounts);
  return select({ message: 'Account routing', default: null, choices });
}

async function pickAccount(workspace, agent = 'claude') {
  // Per-account inference-gateway pinning is implemented for claude + codex only;
  // omp (and any future backend) has no per-account routing yet — the server
  // ignores a pool pin for it ("account routing is unsupported for <agent>", see
  // the resume path). So for those agents we KEEP the picker for a consistent
  // launch flow but offer ONLY the default = system/CLI-login row (no pool), so
  // the user can't pick a pin that would be silently dropped.
  if (agent !== 'claude' && agent !== 'codex') {
    return promptAccount({ pool: [] });
  }
  const accounts = await fetchAccountChoices(workspace, agent);
  // Always surface the picker (at least the default = system/CLI-login row),
  // even when the gateway is off / the pool is empty / the operator is
  // unreachable. (Was: returned null without prompting when accounts was null,
  // so a fresh install never saw the account screen the dev box shows.)
  return promptAccount(accounts ?? {});
}

/**
 * Derive a stable fleet slug from a user-entered name. MIRRORS
 * `fleetSlugFromName` in packages/operator-core/lib/agent-fleets-store.ts (kept in
 * sync) — the launcher is plain Node ESM and can't import the TS store. The server
 * RE-DERIVES authoritatively from the entered name (sent as `fleet_name`), so this
 * client copy is only the picker's display value. Pure — exported for tests.
 */
export function fleetSlugFromName(name) {
  const slug = String(name)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return slug || 'fleet';
}

/** Parse a `#rrggbb` hex into `[r,g,b]`, or null when malformed. Pure — exported
 *  for tests. */
export function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(String(hex ?? '').trim());
  return m ? [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)] : null;
}

/** A 2-cell ANSI truecolor swatch in the scheme's background (trailing space), or
 *  '' when there is no/invalid color — so a picker row degrades cleanly to plain
 *  text for a fleet with no bound color. `color` is the `{ bg, fg, cursor }` the
 *  /options endpoint resolves per fleet (fleet-color-schemes). Pure — for tests. */
export function colorSwatch(color) {
  const rgb = color && hexToRgb(color.bg);
  if (!rgb) return '';
  const [r, g, b] = rgb;
  return `\x1b[48;2;${r};${g};${b}m  \x1b[0m `;
}

/** The durable named fleets the workspace offers (agent_fleets rows — they persist
 *  even with zero live members, D-003), plus `nextScheme` (the color a NEW fleet
 *  would be allocated, for the create-row preview). Same live `/options` endpoint
 *  the account picker reads. Fail-soft → `{ fleets: [], nextScheme: null }` so the
 *  picker still shows its two default rows. */
async function fetchFleetChoices(workspace) {
  try {
    const params = new URLSearchParams();
    if (workspace) params.set('workspace', workspace);
    const q = params.toString() ? `?${params.toString()}` : '';
    const resp = await api(`/api/agent-mcp/console/bootstrap-su/options${q}`);
    return {
      fleets: Array.isArray(resp.fleets) ? resp.fleets : [],
      nextScheme: resp.nextScheme ?? null,
      schemes: Array.isArray(resp.schemes) ? resp.schemes : [],
    };
  } catch {
    return { fleets: [], nextScheme: null, schemes: [] };
  }
}

/**
 * named-su-agent-fleets P-006: pick a named fleet to run this session in, create a
 * new one, or stay unfleeted (default). Mirrors pickAccount — the FIRST row keeps
 * today's behavior (no fleet, no name). Picking an existing persisted fleet JOINS it
 * as a member; entering a NEW name makes this agent the LEADER of a freshly-created
 * fleet (D-002). Returns `{ slug, role, name }`: slug+role null for "no fleet";
 * `name` is set only for a freshly-entered new fleet (its title — threaded to the
 * server, which creates the agent_fleets row + re-derives the slug authoritatively).
 */
async function pickFleet(workspace) {
  const { fleets, nextScheme, schemes } = await fetchFleetChoices(workspace);
  const existing = Array.isArray(fleets) ? fleets : [];
  const NEW = '__new__';
  const { select, input } = await import('@inquirer/prompts');
  // fleet-color-schemes: prefix each existing fleet with a swatch in its bound
  // color, and the create-row with the color a new fleet would get (nextScheme).
  const choices = [
    { name: '· no fleet — default (no name)', value: null },
    { name: `${colorSwatch(nextScheme)}+ create a new fleet…`, value: NEW },
    ...existing.map((f) => ({ name: `${colorSwatch(f.color)}${f.title || f.slug}`, value: f.slug })),
  ];
  const chosen = await select({ message: 'Fleet', default: null, choices });
  if (chosen === null) return { slug: null, role: null, name: null, scheme: null };
  if (chosen === NEW) {
    const name = (await input({ message: 'New fleet name' })).trim();
    if (!name) return { slug: null, role: null, name: null, scheme: null }; // empty name → no fleet
    // fleet-color-schemes: pick the fleet's colour — the full catalog, each row a
    // swatch in its own colour, defaulting to the next-unused scheme. The chosen
    // NAME is threaded to the server (fleet_scheme), which forces it at create.
    const scheme = await pickFleetScheme(schemes, nextScheme);
    return { slug: fleetSlugFromName(name), role: 'leader', name, scheme };
  }
  return { slug: chosen, role: 'member', name: null, scheme: null };
}

/** Offer the curated catalog as a colour picker for a NEW fleet — each row a swatch
 *  (bg block) + the scheme name in its cursor accent, defaulting to the next-unused
 *  scheme. Returns the chosen scheme NAME; falls back to nextScheme's name (else
 *  null → server auto-allocates) when the catalog isn't available. */
async function pickFleetScheme(schemes, nextScheme) {
  const catalog = Array.isArray(schemes) ? schemes : [];
  if (!catalog.length) return nextScheme?.name ?? null;
  const { select } = await import('@inquirer/prompts');
  const choices = catalog.map((s) => ({ name: `${colorSwatch(s)}${schemeNameInAccent(s)}`, value: s.name }));
  return select({
    message: 'Fleet color',
    default: nextScheme?.name ?? catalog[0].name,
    choices,
    loop: false,
  });
}

/** A scheme's name rendered in its own cursor accent (ANSI truecolor fg), or plain
 *  when the colour is unparseable. Pure — for the fleet colour-picker rows; for tests. */
export function schemeNameInAccent(scheme) {
  const rgb = scheme && hexToRgb(scheme.cursor);
  if (!rgb) return scheme?.name ?? '';
  const [r, g, b] = rgb;
  return `\x1b[38;2;${r};${g};${b}m${scheme.name}\x1b[0m`;
}

/** True if `id` is a pinnable account given the gateway choices (pool membership + session-override
 *  allow/exclude). Pure — mirrors the server's resolveAccountPin gating. Exported for tests. */
export function accountPinnable(accounts, id) {
  if (!id || !accounts?.gatewayOn) return false;
  const pool = Array.isArray(accounts.pool) ? accounts.pool : [];
  if (!pool.includes(id)) return false;
  const exclude = accounts.excludeAccounts ?? [];
  const forced = accounts.forcedAccounts ?? [];
  if (exclude.includes(id)) return false;
  if (forced.length > 0 && !forced.includes(id)) return false;
  return true;
}

export function accountProviderFromChoices(accounts, agent = 'claude') {
  if (accounts?.provider === 'claude' || accounts?.provider === 'codex') return accounts.provider;
  if (accounts && Object.prototype.hasOwnProperty.call(accounts, 'provider')) return null;
  return agent === 'codex' ? 'codex' : 'claude';
}

/**
 * Choose (prompt) / honor (`--account`) the account for a RESUME, then build the inference-gateway
 * pin env CLIENT-SIDE (gatewayPinEnv) — the resume mints no session, so it can't ride the
 * bootstrap-su POST that folds the pin for a fresh launch, and the launcher must not depend on a
 * server endpoint that may not be deployed where it points (the 404 deploy-skew bug). Gating reuses
 * the live `/options` choices. Returns `{ id, env, notice }`: `id` for the FORK path (folded
 * server-side via the bootstrap POST), `env`/`notice` for the in-place resume (launchResume).
 * Scripting (`--no-picker`) with no account uses the default system login. A
 * user-selected `auto` or named pin is fail-closed: if the gateway/provider/pin
 * cannot be honored, this function throws instead of silently returning the
 * default-account marker.
 */
export async function chooseResumeAccount(session, args) {
  const plan = resumeAccountPlan(args);
  if (plan.source === 'none') {
    return { mode: 'default', id: null, env: defaultAccountEnv(), notice: null }; // --no-picker + no --account = system credential
  }

  // account-routing-3-options: the `default` keyword (or '' / none / system) is resolved by NAME —
  // it deliberately skips the gateway, so it needs no pool fetch. (The picker path resolves its
  // keyword AFTER fetching the choices, below.)
  if (!plan.prompt && accountRoutingMode(plan.account) === 'default') {
    return { mode: 'default', id: null, env: defaultAccountEnv(), notice: 'using the default system account (inference gateway skipped).' };
  }

  const selectedModel = String(args?.model || '').trim();
  const ompModelRoute = session.agent === 'omp' && selectedModel
    ? ompGatewayModelFromSpec(selectedModel)
    : null;
  if (session.agent === 'omp' && selectedModel && !ompModelRoute) {
    if (plan.prompt) {
      return { mode: 'default', id: null, env: defaultAccountEnv(), notice: null };
    }
    throw new Error(
      `--account ${plan.account} could not be honored: OMP model '${selectedModel}' is not compatible with gateway account routing. ` +
        'Refusing model substitution and default-system fallback.',
    );
  }
  const accountAgent = session.agent === 'omp'
    ? (ompModelRoute?.accountProvider ?? 'claude')
    : session.agent;
  const expectedProvider = ompModelRoute?.accountProvider
    ?? (session.agent === 'codex' ? 'codex' : 'claude');
  const accounts = await fetchAccountChoices(session.workspaceId, accountAgent);
  if (!accounts?.gatewayOn || !(Array.isArray(accounts.pool) && accounts.pool.length)) {
    // No explicit nondefault choice exists on the prompt path because the picker
    // hides unavailable gateway rows; omission therefore remains the product's
    // default system route. A flag-selected auto/pin is a contract and must fail.
    if (plan.prompt) return { mode: 'default', id: null, env: defaultAccountEnv(), notice: null };
    throw new Error(
      `--account ${plan.account} could not be honored: inference gateway off / no pool. ` +
        'Refusing to fall back to the default system login.',
    );
  }

  const requested = plan.prompt ? await promptAccount(accounts) : plan.account;
  const mode = accountRoutingMode(requested);
  if (mode === 'default') {
    return {
      mode: 'default',
      id: null,
      env: defaultAccountEnv(),
      notice: requested ? 'using the default system account (inference gateway skipped).' : null,
    };
  }

  const provider = accountProviderFromChoices(accounts, accountAgent);

  if (mode === 'auto') {
    if (provider !== expectedProvider) {
      throw new Error(
        `--account auto could not be honored: ${session.agent}${selectedModel ? ` model '${selectedModel}'` : ''} requires a ${expectedProvider} account pool. ` +
          'Refusing to fall back to the default system login.',
      );
    }
    // `forward: 'auto'` is the value a TRACKED fork sends to the server (resolveAccountPin) so the
    // fork re-derives the same auto-route — `id` is null here, so the fork's `id` fallback alone
    // would silently drop the choice.
    return {
      mode: 'auto',
      id: null,
      auto: true,
      forward: 'auto',
      provider,
      env: session.agent === 'claude' ? gatewayAutoEnv(provider, session.coordOwnerId) : {},
      notice: 'routing through the inference gateway (auto — it selects an available pool account and fails over).',
    };
  }

  // mode === 'pin'
  const id = requested;
  if (!accountPinnable(accounts, id)) {
    throw new Error(
      `--account ${id} could not be honored: not an allowed pool account. ` +
        'Refusing to fall back to the default system login.',
    );
  }
  if (!provider) {
    throw new Error(
      `--account ${id} could not be honored: account routing is unsupported for ${session.agent}. ` +
      'Refusing to fall back to the default system login.',
    );
  }
  if (provider !== expectedProvider) {
    throw new Error(
      `--account ${id} could not be honored: '${id}' is a ${provider} account, but ` +
        `${session.agent}${selectedModel ? ` model '${selectedModel}'` : ''} requires ${expectedProvider} accounts. ` +
        'Refusing to fall back to the default system login.',
    );
  }
  return {
    mode: 'pin',
    id,
    provider,
    env: session.agent === 'claude'
      ? gatewayPinEnv(id, provider, session.coordOwnerId)
      : { PAPERCUSP_ACCOUNT_ID: id },
    notice: `pinned to ${provider === 'codex' ? 'Codex ' : ''}account ${id} (routed through the inference gateway).`,
  };
}

/** Sentinel for the "no feature" picker row (optional-feature roles). */
const NO_FEATURE = '<no-feature>';

/** Pick the role. Interactively, 'su' (plain engineer) is the ONLY selectable
 *  choice — the pipeline roles (planner/worker/etc.) are deliberately NOT
 *  offered here (psu-su-only-interactive-picker-2026-06-30): they're meant for
 *  automated/scripted spawning (`psu --role=<role> --no-picker`, what the
 *  harness pipeline actually uses), not for a human to pick by hand. That flag
 *  path is untouched — it resolves `role` BEFORE this function is ever called
 *  (see the `args.role || null` check at the call site) and still reaches
 *  `roleFlow` exactly as before. `roles: known` is still returned (now always
 *  `[]` from the picker path) so the caller's destructuring shape is unchanged.
 *  Returns { role, roles } so the caller reuses the consumes map. */
async function pickRole() {
  const { roles } = await api('/api/agent-mcp/console/bootstrap-su/options');
  const known = Array.isArray(roles) ? roles : [];
  const { select } = await import('@inquirer/prompts');
  const role = await select({
    message: 'Role',
    choices: [{ name: 'su  — engineer collaborator (full SU catalog)', value: 'su' }],
  });
  return { role, roles: known };
}

/** Role sessions support claude, omp, and codex interactively. codex
 *  runs in a per-session CODEX_HOME (bootstrap-role mints it). */
async function pickRoleBackend() {
  const { select } = await import('@inquirer/prompts');
  return select({
    message: 'Backend',
    choices: [
      { name: 'claude', value: 'claude' },
      { name: 'omp', value: 'omp' },
      { name: 'codex', value: 'codex' },
    ],
  });
}

/** Harness picker that REQUIRES a real harness (role sessions are
 *  harness-scoped — no workspace-root option). */
async function pickHarnessRequired(workspace) {
  const { search } = await import('@inquirer/prompts');
  const q = workspace ? `?workspace=${encodeURIComponent(workspace)}` : '';
  const { harnesses } = await api(`/api/agent-mcp/console/bootstrap-su/options${q}`);
  const rows = (harnesses || []).map((h) => ({ name: h.status ? `${h.slug}  (${h.status})` : h.slug, value: h.slug }));
  if (rows.length === 0) {
    console.error('psu: no harnesses registered in this workspace — a role session needs one.');
    process.exit(1);
  }
  return search({ message: 'Harness', source: async (term) => filterRows(rows, term) });
}

/** Feature picker. `need` = 'required' (must pick) | 'optional' (offer
 *  a "no feature" row). Returns the feature id or null. */
async function pickFeature(workspace, harness, need) {
  const { search } = await import('@inquirer/prompts');
  let features = [];
  try {
    const params = new URLSearchParams({ harness, features: '1' });
    if (workspace) params.set('workspace', workspace);
    const r = await api(`/api/agent-mcp/console/bootstrap-su/options?${params.toString()}`);
    features = r.features || [];
  } catch {
    features = [];
  }
  const featureRows = features.map((f) => ({
    name: f.title ? `${f.id}  —  ${f.title}${f.status ? `  (${f.status})` : ''}` : f.id,
    value: f.id,
  }));
  const rows = need === 'optional'
    ? [{ name: 'NO FEATURE — run the role unscoped', value: NO_FEATURE }, ...featureRows]
    : featureRows;
  if (rows.length === 0) {
    console.error(`psu: role needs a feature but harness '${harness}' has none.`);
    process.exit(1);
  }
  const picked = await search({ message: 'Feature', source: async (term) => filterRows(rows, term) });
  return picked === NO_FEATURE ? null : picked;
}

/**
 * Should this interactive launch run through the managed-pty host
 * (turn-lifecycle-control Phase 3, P-012)? Pure — exported for tests.
 *
 * Rollout gate. `PAPERCUSP_PSU_NO_PTY=1` is an always-wins kill switch.
 * Otherwise the default is `PTY_DEFAULT_ON`; until the P-015 feel-check is
 * confirmed it's opt-IN via `PAPERCUSP_PSU_PTY=1` so the default launch path
 * stays byte-identical for the live fleet (psu-launcher is exec'd directly — an
 * edit hits every agent's next launch). Needs a real TTY on both ends (we bridge
 * raw mode); a non-TTY launch (the brain dock pane, --no-picker scripts) keeps
 * the plain inherit spawn, which is correct — there's no terminal to bridge.
 *
 * HEADLESS (headless-fleet-launch-and-carry-knob-2026-07-10 P-001, D-004): a
 * headless FLEET MEMBER has no terminal either, but unlike the dock pane it MUST
 * still be injectable — its whole lifecycle is warm `loop:arm` wakes delivered by
 * the wake-executor. Without a managed pty there is no control socket and no
 * `~/.papercusp/psu-pty/<ownerId>.json` discovery file, so wake-executor Channel 1b
 * can't find it, Channel 3 fires instead ("session pid alive but not an injectable
 * managed pty") and the member PARKS FOREVER after one turn. So `--headless` /
 * `PAPERCUSP_PSU_HEADLESS=1` bypasses EXACTLY ONE thing: the isTTY check. It does
 * NOT override the kill switch and does NOT override an explicit `PAPERCUSP_PSU_PTY=0`.
 *
 * This is sound because `hostThroughPty` is TTY-optional by construction: the pty
 * itself comes from node-pty (the child still sees a real pty), `bridgeTty` defaults
 * to `stdin.isTTY` → false here, and the pty is sized from `sanePtyDim(stdout.columns,
 * 80, …)` which falls back to 80x24 for a non-TTY stdout. Only the bridge to a HUMAN's
 * terminal needs a TTY, and a headless member has no human. Keep the pty, drop the
 * terminal emulator.
 */
// P-012/P-015: managed-pty IS the interactive launch path (D-006). Flipped on
// 2026-06-08 after the mechanical feel-check passed end-to-end (a real bash
// driven through the host: cooked-line editing + backspace, $COLUMNS from the
// pty size, Ctrl-C interrupts the foreground job without killing the shell,
// bracketed-paste/readline intact, clean exit). Per-launch escape hatches stay:
// `PAPERCUSP_PSU_PTY=0` opts one launch out, `PAPERCUSP_PSU_NO_PTY=1` is the
// always-wins kill switch. A non-TTY launch (brain dock pane, --no-picker
// scripts) still takes the plain inherit spawn — there's no terminal to bridge.
export const PTY_DEFAULT_ON = true;
export function usePtyHost({ env = process.env, stdin = process.stdin, stdout = process.stdout } = {}) {
  if (env.PAPERCUSP_PSU_NO_PTY === '1') return false;
  const enabled =
    env.PAPERCUSP_PSU_PTY === '1' ? true : env.PAPERCUSP_PSU_PTY === '0' ? false : PTY_DEFAULT_ON;
  if (!enabled) return false;
  // A headless launch has no TTY BY DESIGN, but still needs the injectable pty.
  if (env.PAPERCUSP_PSU_HEADLESS === '1') return true;
  return !!(stdin.isTTY && stdout.isTTY);
}

/**
 * The terminal THIS psu launch owns, as a device path — or null when there isn't one
 * (headless bee, brain dock pane, `--no-picker` script, piped stdio).
 *
 * WI-3665. Every agent CLI renders its fleet identity (👑 leader / 👤 member + fleet name
 * + colour square) into the OS title with an OSC-0 escape, written from a hook. Those hooks
 * used to open `/dev/tty` — the CONTROLLING terminal — and Claude Code never gives them one:
 * it spawns the statusLine command setsid'd, so the open raised ENXIO on every tick and the
 * title silently never appeared. Exporting the answer as PAPERCUSP_TTY fixes it for good,
 * because ENV crosses the setsid boundary that a controlling terminal does not.
 *
 * Resolved HERE, at launch, on purpose: psu is the process that attaches the agent to the
 * terminal, so it is the only one that knows — authoritatively — which terminal the session
 * owns. The tempting alternative (have the hook walk /proc ancestry to the nearest tty)
 * works but is unsafe: ancestry crosses ownership boundaries, so a headless bee whose
 * ancestor chain reaches a dev terminal would retitle a window it doesn't own. Measured on
 * the dev box while diagnosing this: a bash under one agent walks up to another agent's
 * `claude` and resolves to that agent's /dev/pts/65.
 *
 * Correct under the managed-pty host too. We export psu's OUTER tty (the real terminal),
 * not the inner pty slave: a write there lands on the terminal directly, and the inner pty
 * doesn't exist yet at env-assembly time anyway.
 *
 * @param {object} [o]
 * @param {NodeJS.ReadStream} [o.stdin]
 * @param {NodeJS.WriteStream} [o.stdout]
 * @param {string} [o.platform]  process.platform (injected for tests)
 * @param {(p: string) => string} [o.readLink]  readlinkSync (injected for tests)
 * @param {(pid: number) => string} [o.psTty]   `ps -o tty=` reader (injected for tests)
 * @param {(p: string) => boolean} [o.exists]   existsSync (injected for tests)
 * @returns {string | null} an absolute device path, or null when no terminal is owned
 */
export function resolveOwnedTtyPath({
  stdin = process.stdin,
  stdout = process.stdout,
  platform = process.platform,
  readLink = readlinkSync,
  psTty = defaultPsTty,
  exists = existsSync,
} = {}) {
  // No tty on either end ⇒ this launch owns no terminal. Say so; never guess.
  if (!stdout.isTTY && !stdin.isTTY) return null;

  // Linux: /proc/self/fd/<n> is a symlink to the device. Prefer stdout, then stdin —
  // a launch may have one redirected. (fd 2 is deliberately NOT consulted: stderr is
  // routinely redirected to a log while the session still owns a terminal.)
  if (platform === 'linux') {
    for (const fd of [1, 0]) {
      try {
        const p = readLink(`/proc/self/fd/${fd}`);
        if (p.startsWith('/dev/pts/') || p.startsWith('/dev/tty')) return p;
      } catch {
        /* fd redirected / proc unavailable — try the next */
      }
    }
  }

  // macOS/BSD have no /proc and node exposes no ttyname(3). `ps -o tty=` reports the
  // controlling terminal by NAME, and the spelling varies by platform and device:
  //   linux  'pts/24'          → /dev/pts/24
  //   darwin 's003'            → /dev/ttys003   (the short form drops the 'tty')
  //   darwin 'ttys003'         → /dev/ttys003
  //   either 'console'         → /dev/console   (NOT /dev/ttyconsole)
  // Rather than guess the prefix from the spelling, probe: the device that exists is the
  // device we own. Only ever return a path that is really there.
  try {
    const name = psTty(process.pid).trim();
    if (name && name !== '?' && name !== '??' && name !== '-') {
      const candidates = name.startsWith('/dev/') ? [name] : [`/dev/${name}`, `/dev/tty${name}`];
      for (const path of candidates) {
        if (exists(path)) return path;
      }
    }
  } catch {
    /* no ps / unexpected output — fall through */
  }
  return null;
}

/** `ps -o tty= -p <pid>` — split out so resolveOwnedTtyPath stays unit-testable. */
function defaultPsTty(pid) {
  return execFileSync('ps', ['-o', 'tty=', '-p', String(pid)], { encoding: 'utf8', timeout: 1000 });
}

/** Default claim-registry directory — one small marker file per terminal device.
 *  Override (tests only) via PAPERCUSP_TTY_CLAIMS_DIR. */
export const TTY_CLAIMS_DIR = join(homedir(), '.papercusp', 'tty-claims');

/** Turn a device path into a safe, collision-free filename for the claims dir. */
function ttyClaimFilename(ttyPath) {
  return ttyPath.replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+/, '');
}

/**
 * Claim `ttyPath` as owned by `sid`, overwriting whatever session claimed it before.
 *
 * EI-10377 (2026-07-12/13, caught on camera during a demo shoot). A Linux pty's minor
 * number is NOT a stable identity: devpts allocates each `/dev/pts/N`'s inode
 * deterministically from N itself (measured on this box: ino == minor + 3), so once a
 * pty is closed, its number is handed to the very next terminal that opens one — the
 * new terminal is indistinguishable from the old at the path level. PAPERCUSP_TTY
 * (WI-3665) is resolved ONCE at launch and then lives in a session's env for its
 * entire lifetime; a session that keeps firing hooks after the WINDOW that spawned it
 * is gone (an orphaned hook process, or a fleet loop still warm past its xterm being
 * killed) will happily `open(its stale PAPERCUSP_TTY, 'w')` and SUCCEED, because that
 * path now belongs to a completely different, unrelated session. `open()` has no way
 * to detect that from the path alone — which is exactly how su-9859e's title landed on
 * su-c70f4's (luna's) terminal on stage :110.
 *
 * The fix: every launch that owns a terminal stamps a claim file for that path with its
 * own session id, overwriting any prior claim — including a STALE one left by whichever
 * session used to own that path. A writer then checks the CURRENT claim before it opens
 * PAPERCUSP_TTY (see pc_tty.py's `tty_owned_by_us` / coord-hook.ts's `ttyOwnedByUs` — the
 * two must stay in lockstep with this, same as every other WI-3665 title mechanic); if
 * the claim now names someone else, the write is skipped exactly like a closed terminal.
 * A recycled path is ALWAYS re-stamped before it's usable again (the new xterm's own psu
 * launch runs this same code first), so the stale writer's next attempt sees the
 * mismatch and backs off instead of clobbering it.
 *
 * Fire-and-forget / best-effort, like every other title mechanic here: a claim-file
 * write must never fail a launch.
 */
export function claimTtyOwnership(ttyPath, sid, { dir } = {}) {
  if (!ttyPath || !sid) return;
  const claimsDir = dir || TTY_CLAIMS_DIR;
  try {
    mkdirSync(claimsDir, { recursive: true });
    writeFileSync(join(claimsDir, ttyClaimFilename(ttyPath)), sid, 'utf8');
  } catch {
    /* cosmetic guard — never fail a launch over a claim-file write */
  }
}

/** The settings.json a claude launch will actually read: the per-session isolated
 *  CLAUDE_CONFIG_DIR when psu pinned one (EI-155), else the shared user-level dir. */
function effectiveClaudeSettingsPath(env, home = homedir()) {
  const dir = (env.CLAUDE_CONFIG_DIR ?? '').trim();
  return join(dir || join(home, '.claude'), 'settings.json');
}

/**
 * mcp-transport-resilience P-002 (2026-07-13): derive the re-exec-durable
 * permissions this launch's composed claude argv expresses. A Claude Code
 * self-relaunch (auto-update relaunch / TUI fullscreen switch) re-execs with
 * REBUILT argv — every launch flag is dropped (the recovery-banner class):
 * `--permission-mode` fell back to the default, and the `--disallowedTools`
 * deny sets (native-scheduler lockout, no-subagents) degraded to
 * honor-the-playbook. settings.json in the per-session CLAUDE_CONFIG_DIR is
 * RE-READ by the re-exec'd process, so mirroring the flags there makes them
 * survive mechanically. Handles both `--flag=value` and `--flag value` forms;
 * `--dangerously-skip-permissions` maps to defaultMode 'bypassPermissions'
 * (claude unions repeated --disallowedTools occurrences; so do we). Null when
 * the argv expresses no permissions at all. Pure — exported for tests.
 */
export function reExecSafePermissionsFromArgs(args) {
  const deny = [];
  let defaultMode = null;
  const list = Array.isArray(args) ? args : [];
  for (let i = 0; i < list.length; i++) {
    const a = String(list[i] ?? '');
    if (a === '--dangerously-skip-permissions') defaultMode = 'bypassPermissions';
    else if (a === '--permission-mode' && list[i + 1] != null) defaultMode = String(list[++i]);
    else if (a.startsWith('--permission-mode=')) defaultMode = a.slice('--permission-mode='.length);
    else if (a.startsWith('--disallowedTools=')) deny.push(...a.slice('--disallowedTools='.length).split(','));
    else if (a === '--disallowedTools' && list[i + 1] != null) deny.push(...String(list[++i]).split(','));
  }
  const cleaned = [...new Set(deny.map((t) => t.trim()).filter(Boolean))];
  if (!defaultMode && cleaned.length === 0) return null;
  return { defaultMode, deny: cleaned };
}

/**
 * Merge the argv-derived permissions (reExecSafePermissionsFromArgs) into the
 * per-session settings.json — P-002's IO leg. ONLY writes when this launch has
 * an isolated CLAUDE_CONFIG_DIR: deny rules must never bleed into the shared
 * ~/.claude/settings.json (they'd outlive the session and constrain the owner's
 * own launches). Read-modify-write preserving every other key; ATOMIC
 * (tmp + rename) for the same partial-read reason as psu-pty-host's writeMeta.
 * deny UNIONS with any existing deny (removing an entry is a human edit, never
 * ours to undo); defaultMode is overwritten (this launch's mode is current).
 * Fail-open: a write failure warns and the launch continues on argv flags
 * alone — exactly the pre-P-002 behavior. Exported for tests.
 */
export function persistReExecSafePermissions({ env, args, log = (m) => process.stderr.write(m) }) {
  try {
    const dir = (env?.CLAUDE_CONFIG_DIR ?? '').trim();
    if (!dir) return false;
    const derived = reExecSafePermissionsFromArgs(args);
    if (!derived) return false;
    const path = join(dir, 'settings.json');
    let current = {};
    try {
      current = JSON.parse(readFileSync(path, 'utf8'));
    } catch {
      current = {}; // absent/corrupt — start clean; the merge below re-creates it
    }
    if (!current || typeof current !== 'object' || Array.isArray(current)) current = {};
    const permissions =
      current.permissions && typeof current.permissions === 'object' && !Array.isArray(current.permissions)
        ? { ...current.permissions }
        : {};
    if (derived.defaultMode) permissions.defaultMode = derived.defaultMode;
    if (derived.deny.length > 0) {
      const existing = Array.isArray(permissions.deny) ? permissions.deny : [];
      permissions.deny = [...new Set([...existing, ...derived.deny])];
    }
    const next = { ...current, permissions };
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(next, null, 2));
    renameSync(tmp, path);
    return true;
  } catch (e) {
    try {
      log(`psu: could not persist re-exec-safe permissions (${e?.message ?? e}) — launch continues on argv flags alone.\n`);
    } catch {
      /* diagnostic only */
    }
    return false;
  }
}

/**
 * Remove copied user-level auth routing from an isolated default-account
 * session's settings.json. This is the re-exec-durable half of
 * applyDefaultClaudeAuthSettingsArgs: Claude self-relaunches can drop argv, but
 * they re-read this file. We DELETE credential env keys instead of persisting
 * empty values because an empty CLAUDE_CODE_OAUTH_TOKEN suppresses the normal
 * file/Keychain login fallback.
 *
 * The command-line override still handles higher-precedence project/local
 * settings on the initial launch. Managed settings remain an administrator
 * policy and intentionally outrank every user launch choice.
 */
export function persistDefaultClaudeAuthSettings({
  wrapperBin,
  env,
  log = (m) => process.stderr.write(m),
}) {
  try {
    if (!/(^|\/)claude(-su)?$/.test(String(wrapperBin || ''))) return false;
    const mode = env?.[ACCOUNT_ROUTING_MODE_ENV];
    if (!['default', 'auto', 'pin'].includes(mode)) return false;
    const dir = (env?.CLAUDE_CONFIG_DIR ?? '').trim();
    if (!dir) return false;
    const path = join(dir, 'settings.json');
    let current = {};
    try {
      current = JSON.parse(readFileSync(path, 'utf8'));
    } catch {
      current = {};
    }
    if (!current || typeof current !== 'object' || Array.isArray(current)) current = {};
    const settingsEnv =
      current.env && typeof current.env === 'object' && !Array.isArray(current.env)
        ? { ...current.env }
        : {};
    for (const key of [
      ...CLAUDE_DEFAULT_AUTH_ENV_KEYS,
      'CLAUDE_CODE_OAUTH_TOKEN',
      'ANTHROPIC_OAUTH_TOKEN',
      'PAPERCUSP_ANTHROPIC_URL',
      'PAPERCUSP_ACCOUNT_ID',
      'PAPERCUSP_CODEX_GATEWAY',
    ]) {
      delete settingsEnv[key];
    }
    if (mode === 'auto' || mode === 'pin') {
      for (const key of ['ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_CUSTOM_HEADERS']) {
        if (env[key]) settingsEnv[key] = env[key];
      }
    } else if (isCacheProxyUrl(env.ANTHROPIC_BASE_URL)) {
      settingsEnv.ANTHROPIC_BASE_URL = env.ANTHROPIC_BASE_URL; // P-006, same rationale as above
    }
    const next = { ...current, apiKeyHelper: '', env: settingsEnv };
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(next, null, 2));
    renameSync(tmp, path);
    return true;
  } catch (e) {
    try {
      log(`psu: could not persist explicit-route Claude auth settings (${e?.message ?? e}) — launch continues on env/argv enforcement.\n`);
    } catch {
      /* diagnostic only */
    }
    return false;
  }
}

/**
 * Should THIS launch silence Claude Code's own terminal-title writer?
 *
 * WI-3665. Claude Code writes its current topic to the OS title (`✳ Claude Code`, then
 * `⠐ <topic>`) — verified by capturing its pty output: 1 OSC-0 write by default, 0 with
 * CLAUDE_CODE_DISABLE_TERMINAL_TITLE=1. Papercusp's statusline hook writes the FLEET
 * identity to that same title (👑 leader / 👤 member + fleet + colour square + objective).
 * Two writers on one title means last-writer-wins and the title flickers between them.
 *
 * The fleet identity is the one the owner asked to see, and it already carries the topic as
 * its 🔭 objective segment — so when our statusline is in charge, Claude's writer is pure
 * contention and we turn it off.
 *
 * GUARDED, because silencing the only writer would leave NO title at all:
 *   - claude backends only (codex/omp never wrote a title of their own);
 *   - only when this launch owns a terminal (headless ⇒ nobody writes; leave defaults);
 *   - only when the statusLine claude will actually load IS our hook. A user with a
 *     personal statusLine keeps Claude's title — the installer likewise refuses to clobber
 *     a foreign statusLine, and these two refusals must agree.
 * Fail-open: an unreadable/absent settings.json ⇒ don't silence.
 *
 * Pure but for the settings read; `readFile` is injected for tests.
 */
export function shouldSilenceClaudeTitle({
  agent,
  ownsTty,
  env = process.env,
  home = homedir(),
  readFile = (p) => readFileSync(p, 'utf8'),
} = {}) {
  if (agent !== 'claude' || !ownsTty) return false;
  try {
    const cfg = JSON.parse(readFile(effectiveClaudeSettingsPath(env, home)));
    return String(cfg?.statusLine?.command ?? '').includes('statusline-fleet.sh');
  } catch {
    return false; // absent/unreadable settings ⇒ never silence the only writer
  }
}

/**
 * Supervisor presence beat (agent-liveness-heartbeat-hardening-2026-06-12
 * P-004): while psu is the live PARENT of the agent child — which it is in
 * BOTH launch paths (spawnInherit waits + forwards exit; the pty host owns
 * the pty for the session's lifetime) — keep the session's coord_presence
 * row warm via the bootstrap-su heartbeat endpoint. Process-alive semantics,
 * the interactive analog of the fleet nursery beat (operator-spawn.ts
 * ensureSpawnHeartbeatLoop): an agent in an hour-long turn making NO tool
 * calls stays live; the beat dies with this process (child exit →
 * process.exit kills the timer; the timer is unref'd so it never holds psu
 * open on its own).
 *
 * Quiet + fail-soft by design: a down/wedged operator means missed beats,
 * never terminal spam or an error loop. touchHeartbeat server-side is a
 * no-op when no presence row exists (D-003) — declare-intent at session
 * start mints the row, this only keeps it warm.
 *
 * pid/host (WI-3898 P1, coord:presence liveness parity): this beat genuinely
 * runs AS this session's own parent process — "the beat dies with this
 * process" above is exactly the invariant a liveness probe needs — so it is
 * the one call site that can honestly report its own `process.pid`/
 * `hostname()`. The server stores them on the presence row (never defaults
 * them itself — see presence.ts's file-header note) so a same-machine reader
 * can later verify liveness via a local `kill(pid, 0)` probe instead of
 * trusting heartbeat_at recency alone.
 *
 * Exported with injectables for tests (scripts/__tests__).
 */
export const SUPERVISOR_BEAT_MS = 60_000;

/**
 * EI-19412221266350408 — consecutive `sessionTerminal` beats required before psu exits.
 *
 * >1 on purpose. A single reply is one sample of a distributed verdict; two consecutive
 * ones cost at most one extra beat (~60s) against a zombie that otherwise lingers for
 * HOURS (the observed one held its slot ~10h, idle 20h), and it means no single anomalous
 * response can terminate a live agent.
 */
export const TERMINAL_BEATS_TO_EXIT = 2;

/**
 * Minimum psu uptime before a terminal verdict may act. Startup is exactly when a session
 * is least established — it has declared no intent and armed no wake yet — so it is the
 * window where a spurious terminal verdict would be most damaging AND most likely. A
 * genuine zombie is hours old, so waiting costs nothing it can measure.
 */
export const MIN_UPTIME_BEFORE_SELF_EXIT_MS = 5 * 60_000;

/**
 * EI-19412221266350408 — exit when this session is authoritatively FINISHED.
 *
 * The zombie this closes: psu outlived its agent session by ~9h, holding a fleet slot, a
 * pid and a cgroup with nothing running inside it — and THIS beat is what made it look
 * healthy, by warming the presence row long after the session died (the corpse read
 * heartbeatFresh:true + sessionState:'recorded'). So the beat is the right place to ask
 * "am I beating for a corpse?": it already runs every 60s, already talks to the operator,
 * and already dies with this process.
 *
 * The server answers ONLY on positive ended-session evidence (see terminalSessionVerdict in
 * bootstrap-su.ts). The liveness oracle's `sessionState:'recorded'` means a LIVE recorded
 * session that is not wake-dispatchable (`ended_at IS NULL`), so it must never terminate
 * this launcher. This side adds two more conservative gates — consecutive confirmations
 * and a minimum uptime — and RESETS the streak on any non-terminal or failed beat. Every
 * degraded path keeps psu alive: the failure mode is a zombie that lingers, never a live
 * agent that is killed.
 */
export function startSupervisorBeat(
  ownerId,
  {
    fetchImpl = fetch,
    intervalMs = SUPERVISOR_BEAT_MS,
    operatorUrl = OPERATOR_URL,
    token = null,
    setIntervalImpl = setInterval,
    // EI-19948333346987654: the terminal device path THIS launch owns (from
    // resolveOwnedTtyPath() at spawn time — see the call site), reported on
    // every beat exactly like pid/host below. null for a headless launch.
    tty = null,
    // Injectables for tests; defaults are the real process behaviour.
    beatsToExit = TERMINAL_BEATS_TO_EXIT,
    minUptimeMs = MIN_UPTIME_BEFORE_SELF_EXIT_MS,
    uptimeMsFn = () => process.uptime() * 1000,
    onTerminalSession = () => {
      console.error(
        `psu: this session is recorded as ENDED but psu is still running — exiting so the slot, pid and ` +
          `cgroup are reclaimed (EI-19412221266350408).`,
      );
      process.exit(0);
    },
  } = {},
) {
  if (!ownerId) return null;
  let terminalStreak = 0;
  const beat = async () => {
    try {
      const tok = token ?? readToken();
      const res = await fetchImpl(operatorUrl + '/api/agent-mcp/console/bootstrap-su/heartbeat', {
        method: 'POST',
        signal: AbortSignal.timeout(5_000),
        headers: {
          'content-type': 'application/json',
          ...(tok ? { authorization: `Bearer ${tok}` } : {}),
        },
        body: JSON.stringify({ ownerId, pid: process.pid, host: hostname(), ...(tty ? { tty } : {}) }),
      });
      // Any unreadable/absent body is NOT a terminal verdict — it resets the streak, like
      // any other beat that failed to produce an explicit answer.
      let terminal = false;
      try {
        terminal = Boolean((await res?.json?.())?.sessionTerminal);
      } catch {
        terminal = false;
      }
      if (!terminal) {
        terminalStreak = 0;
        return;
      }
      terminalStreak += 1;
      if (terminalStreak >= beatsToExit && uptimeMsFn() >= minUptimeMs) onTerminalSession();
    } catch {
      /* missed beat — the next tick retries; never surface. A beat that did not complete
       * proves nothing about the session, so it must not count toward the streak. */
      terminalStreak = 0;
    }
  };
  const timer = setIntervalImpl(() => { void beat(); }, intervalMs);
  if (typeof timer?.unref === 'function') timer.unref();
  void beat(); // immediate first beat so a fresh session is warm at once
  return timer;
}

/**
 * Best-effort "my child exited" report: stamps the tracked adv row's
 * ended_at/exit_code (bootstrap-su/session-ended), so the resume picker and
 * roster stop showing dead sessions as `· active` and the session-dir GC's
 * open-row protection actually expires. psu is the live parent in BOTH launch
 * paths (the same property the supervisor beat rides), so child-exit is the
 * one reliable place to stamp it. Awaited with a short timeout because psu
 * process.exit()s right after; any failure — operator down, endpoint not yet
 * deployed (an older release 404s) — is swallowed: end-stamping is telemetry,
 * never a reason to hold the user's terminal open. Exported with injectables
 * for tests. Never rejects.
 *
 * @param {number|string|null} advSessionId  the adv_sessions PK to stamp
 * @param {number|null|undefined} exitCode   the child's exit code (null when unknown)
 * @param {{ fetchImpl?: typeof fetch, operatorUrl?: string, token?: string|null,
 *           timeoutMs?: number, killedBySignal?: string|null }} [opts]
 *   `killedBySignal` is the signal NAME that killed the child, or null for a voluntary
 *   exit. The server derives `ended_by` from it (WI-38054); omitting it makes every kill
 *   record as a clean self-reported exit.
 */
export async function reportSessionEnded(
  advSessionId,
  exitCode,
  {
    fetchImpl = fetch,
    operatorUrl = OPERATOR_URL,
    token = null,
    timeoutMs = 2_000,
    killedBySignal = null,
  } = {},
) {
  if (!advSessionId) return;
  try {
    const tok = token ?? readToken();
    await fetchImpl(operatorUrl + '/api/agent-mcp/console/bootstrap-su/session-ended', {
      method: 'POST',
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        'content-type': 'application/json',
        ...(tok ? { authorization: `Bearer ${tok}` } : {}),
      },
      // WI-38054: `killedBySignal` is what lets the server tell a VOLUNTARY exit from a
      // kill. Without it every end reports as `ended_by='self'`, and because a signal
      // death carries exitCode 0, the row then positively asserts a clean exit — which
      // is how a sidecar restart reaped two of the owner's agents unnoticed.
      body: JSON.stringify({
        advSessionId: Number(advSessionId),
        exitCode: exitCode ?? null,
        killedBySignal: killedBySignal ?? null,
      }),
    });
  } catch {
    /* best-effort — never surface */
  }
}

/**
 * Best-effort "my session RESUMED" report — the inverse of reportSessionEnded.
 * `psu --resume` revives the agent process, but launchResume takes the no-POST
 * path (it reuses the original coord identity + adv row), so the row keeps the
 * ended_at/exit_code from the prior exit and the running agent stays recorded as
 * DEAD → invisible to the roster + presence-as-a-view. This clears that stamp
 * (bootstrap-su/session-resumed) so a resumed-but-idle session shows live the
 * instant it resumes, before it ever touches coord. psu is the live parent of
 * the resumed child (same property the supervisor beat + the end-report ride).
 * Fire-and-forget, bounded, never rejects — a resume must never wait on it.
 * Exported with injectables for tests.
 */
export async function reportSessionResumed(
  advSessionId,
  { fetchImpl = fetch, operatorUrl = OPERATOR_URL, token = null, timeoutMs = 2_000 } = {},
) {
  if (!advSessionId) return;
  try {
    const tok = token ?? readToken();
    await fetchImpl(operatorUrl + '/api/agent-mcp/console/bootstrap-su/session-resumed', {
      method: 'POST',
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        'content-type': 'application/json',
        ...(tok ? { authorization: `Bearer ${tok}` } : {}),
      },
      body: JSON.stringify({ advSessionId: Number(advSessionId) }),
    });
  } catch {
    /* best-effort — never surface */
  }
}

/**
 * Best-effort "my managed host RESPAWNED the child under a fresh native id"
 * report (WI-5075) — the third lifecycle sibling next to ended/resumed. A P-018
 * carry-respawn / cold-loop RECYCLE keeps the coord identity + adv row but
 * rotates the NATIVE `--session-id`; without this report the adv_sessions row
 * keeps naming the dead predecessor, and every owner→transcript consumer (the
 * compaction watchdog's context estimate above all) stays pinned to the
 * predecessor's over-limit transcript — the successor-kill loop of 2026-07-15/16.
 * Keyed by advSessionId when the env carries one, by coordOwnerId otherwise —
 * an interactive `psu` / `psu --resume` launch has NO adv id, and gating the
 * report on one silently exempted that whole cohort from the re-anchor (the
 * 2026-07-18 su-57b6247d successor-kill loop). Fire-and-forget, bounded, never
 * rejects — a respawn must never wait on it. Exported with injectables for tests.
 */
export async function reportSessionRespawned(
  advSessionId,
  sessionId,
  {
    coordOwnerId = null,
    fetchImpl = fetch,
    operatorUrl = OPERATOR_URL,
    token = null,
    timeoutMs = 2_000,
  } = {},
) {
  if (!sessionId || (!advSessionId && !coordOwnerId)) return;
  try {
    const tok = token ?? readToken();
    await fetchImpl(operatorUrl + '/api/agent-mcp/console/bootstrap-su/session-respawned', {
      method: 'POST',
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        'content-type': 'application/json',
        ...(tok ? { authorization: `Bearer ${tok}` } : {}),
      },
      body: JSON.stringify({
        ...(advSessionId ? { advSessionId: Number(advSessionId) } : {}),
        ...(coordOwnerId ? { coordOwnerId: String(coordOwnerId) } : {}),
        sessionId: String(sessionId),
      }),
    });
  } catch {
    /* best-effort — never surface */
  }
}

/**
 * Ask the operator to RE-RENDER this session's base persona from current prompt
 * sources, and return the fresh file's path (or null).
 *
 * stale-prompt-render-in-live-sessions-2026-08-02 P-002. A respawn rebuilds argv
 * from the ORIGINAL argv, so `--system-prompt-file` used to be copied through
 * verbatim and a long-lived session ran its FIRST launch's render forever — 27 of
 * 53 live sessions were up to 14 days stale when measured. A respawn is already a
 * full relaunch, so re-rendering is nearly free; the host swaps the returned path
 * into the successor's argv via mintRecycleArgs.
 *
 * NULL ON EVERYTHING — unreachable operator, timeout, non-200, a session with no
 * stored launch spec, a refused render. The caller then keeps the inherited path
 * and respawns anyway. That fail-soft is deliberate and not negotiable: a respawn
 * that died because the operator was briefly unreachable would lose the session,
 * which is strictly worse than running a stale prompt. Bounded well under the
 * respawn's own kill timeout so a wedged operator delays a respawn rather than
 * stalling it. Exported with injectables for tests.
 */
export async function refreshPersonaRender(
  coordOwnerId,
  { fetchImpl = fetch, operatorUrl = OPERATOR_URL, token = null, timeoutMs = 8_000 } = {},
) {
  if (!coordOwnerId) return { promptFile: null, reason: 'no-owner' };
  try {
    const tok = token ?? readToken();
    const r = await fetchImpl(operatorUrl + '/api/agent-mcp/console/bootstrap-su/persona-refresh', {
      method: 'POST',
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        'content-type': 'application/json',
        ...(tok ? { authorization: `Bearer ${tok}` } : {}),
      },
      body: JSON.stringify({ coordOwnerId: String(coordOwnerId) }),
    });
    if (!r?.ok) return { promptFile: null, reason: `http-${r?.status ?? 'error'}` };
    const j = await r.json();
    if (j?.ok !== true || typeof j?.promptFile !== 'string' || !j.promptFile) {
      return { promptFile: null, reason: String(j?.reason ?? 'not-rendered') };
    }
    return { promptFile: j.promptFile, reason: null, bytes: Number(j.bytes) || null };
  } catch (e) {
    return { promptFile: null, reason: `error: ${e?.message ?? String(e)}` };
  }
}

/** Critical (not best-effort) session-port disposition. The server accepts a
 * delivery only when `proof.nativeRef` names the target backend's own persisted
 * transcript containing the exact rendered hash. If the POST response is lost,
 * reconcile through the status route before deciding whether acknowledgement
 * failed; killing a successfully-delivered target on a network ambiguity would
 * be as wrong as accepting PTY output as persistence. */
export async function reportSessionPortDelivery(
  sessionPort,
  proof,
  { fetchImpl = fetch, operatorUrl = OPERATOR_URL, token = null, timeoutMs = 10_000 } = {},
) {
  if (!sessionPort?.portId || !sessionPort?.targetAdvSessionId) {
    throw new Error('session-port disposition is missing port/target identity');
  }
  const tok = token ?? readToken();
  const status = proof?.persisted === true ? 'delivered' : 'failed';
  const headers = {
    'content-type': 'application/json',
    ...(tok ? { authorization: `Bearer ${tok}` } : {}),
  };
  let responseBody = null;
  try {
    const response = await fetchImpl(operatorUrl + '/api/adv/sessions/port/delivery', {
      method: 'POST',
      signal: AbortSignal.timeout(timeoutMs),
      headers,
      body: JSON.stringify({
        protocolVersion: sessionPort.protocolVersion,
        transformVersion: sessionPort.transformVersion,
        workspace: sessionPort.workspace,
        portId: sessionPort.portId,
        targetAdvSessionId: Number(sessionPort.targetAdvSessionId),
        status,
        ...(status === 'delivered'
          ? { proof: { persisted: true, renderedHash: proof.renderedHash, nativeRef: proof.nativeRef } }
          : { error: proof?.error ?? 'native persistence verification failed' }),
      }),
    });
    responseBody = await response.json().catch(() => null);
    if (response.ok && responseBody?.ok && responseBody.status === status) return responseBody;
  } catch {
    /* reconcile below — the server may have committed before the response was lost */
  }
  try {
    const query = new URLSearchParams({ id: sessionPort.portId });
    if (sessionPort.workspace) query.set('workspace', sessionPort.workspace);
    const response = await fetchImpl(`${operatorUrl}/api/adv/sessions/port/status?${query}`, {
      method: 'GET',
      signal: AbortSignal.timeout(timeoutMs),
      headers,
    });
    const body = await response.json().catch(() => null);
    if (
      response.ok && body?.ok && body.port?.status === status &&
      Number(body.port?.targetAdvSessionId) === Number(sessionPort.targetAdvSessionId)
    ) return body;
  } catch {
    /* the disposition remains unacknowledged */
  }
  throw new Error(
    `operator did not acknowledge session port ${sessionPort.portId} as ${status}` +
      (responseBody?.error ? `: ${responseBody.error}` : ''),
  );
}

/** EI-8868/EI-8877: strip inherited `npm run`-lifecycle env pollution before it
 *  reaches an agent child. This box's long-lived gnome-terminal-server (every
 *  terminal window is forked from ONE persistent daemon, inheriting whatever
 *  env it had at ITS OWN startup) was activated with `npm_config_local_prefix`
 *  / `INIT_CWD` / `npm_package_json` pinned to `papercup-release` and its
 *  node_modules/.bin dirs PREPENDED to PATH — so every su/agent session on
 *  this box inherits it identically. Effect: `npx <tool>` / bare `vitest`
 *  resolve the STALE release-tree copy instead of the staging tree's, making
 *  every test in a run fail identically ("Vitest failed to find the runner")
 *  and poisoning `harness_shared.test_runs`, which then feeds FALSE "red-test"
 *  watchdog EIs fleet-wide (confirmed via EI-8828/EI-8840 — both proved green
 *  when re-run through a clean env). Root cause lives upstream of this
 *  process (the terminal daemon's own frozen env) and isn't fixable here, but
 *  THIS is the one choke point every psu-launched agent session passes
 *  through — sanitizing here fixes it fleet-wide regardless of what garbage
 *  the launching shell carried in. Non-destructive: only strips the npm
 *  lifecycle vars above and PATH segments naming the release checkout, which
 *  an interactive agent session never legitimately needs.
 *
 * WI-5052: account routing is also launch-envelope state, never ambient shell
 * state. A gateway-routed Claude session can itself run `psu`; without removing
 * its inherited ANTHROPIC_BASE_URL / routing headers, a child explicitly launched
 * as `--account=default` silently remains on the gateway because the default
 * envelope is intentionally empty. Strip every inference-gateway route marker
 * here, BEFORE runWrapper overlays the explicit launch envelope. Auto/pin launches
 * re-add the complete route through gatewayAutoEnv/gatewayPinEnv or bootstrap-su.
 * Direct credentials are route selectors too: the explicit envelope re-adds
 * only the credential source selected for this child. */
export function sanitizeInheritedEnv(env) {
  const out = { ...env };
  for (const key of Object.keys(out)) {
    if (
      key === 'INIT_CWD' ||
      key.startsWith('npm_config_local_prefix') ||
      key.startsWith('npm_package_') ||
      key.startsWith('npm_lifecycle_')
    ) {
      delete out[key];
    }
  }
  if (typeof out.PATH === 'string' && out.PATH.includes('papercup-release')) {
    out.PATH = out.PATH
      .split(delimiter)
      .filter((seg) => !seg.includes('/papercup-release/'))
      .join(delimiter);
  }
  for (const key of [
    ...CLAUDE_DEFAULT_AUTH_ENV_KEYS,
    'PAPERCUSP_ANTHROPIC_URL',
    'PAPERCUSP_ACCOUNT_ID',
    'PAPERCUSP_CODEX_GATEWAY',
    ACCOUNT_ROUTING_MODE_ENV,
    'CLAUDE_CODE_OAUTH_TOKEN',
    // WI-37487: these are operator-service-only performance toggles from
    // WI-7160. A psu process may itself be launched from an operator shell,
    // but its child is an independent agent session; inheriting these flags
    // makes unrelated agent tests and tools route through the operator's
    // sidecar path. The explicit launch envelope can still opt a child in if
    // a future launch contract requires it.
    'PAPERCUSP_DEV_DEPLOY_SPAWN_SIDECAR',
    'PAPERCUSP_SYSTEM_HEALTH_SPAWN_SIDECAR',
  ]) {
    delete out[key];
  }
  // WI-5002: a psu launch is an INDEPENDENT session, but an agent-spawned launch
  // (a claude session's Bash running psu-launcher) inherits the SPAWNER's claude
  // session-identity markers. Claude Code treats a process carrying these as a
  // CHILD session and silently skips transcript persistence — the session runs
  // fine, completes work, and leaves NO projects/<slug>/<id>.jsonl (bisected
  // live 2026-07-17: stripping these flips persistence back on; flags/config-dir
  // shape/version all ruled out). Strip the whole ancestry family so the child's
  // claude context is always re-derived, never inherited; the envelope re-adds
  // CLAUDE_CONFIG_DIR when psu pins one.
  for (const key of [
    'CLAUDECODE',
    'CLAUDE_CODE_SESSION_ID',
    'CLAUDE_CODE_CHILD_SESSION',
    'CLAUDE_CODE_BRIDGE_SESSION_ID',
    'CLAUDE_CODE_ENTRYPOINT',
    'CLAUDE_CODE_EXECPATH',
    'CLAUDE_CONFIG_DIR',
  ]) {
    delete out[key];
  }
  return out;
}

/**
 * coord-delivery-residual-gaps-2026-07-11 P-002 — launch-time CC hook
 * enrollment guard, GENERALIZED (WI-4394) to any settings.json-wired CC hook,
 * not just coord-inbox.
 *
 * A Claude psu session receives several capabilities purely through hooks
 * merged into the global `~/.claude/settings.json` (coord-inbox mid-turn
 * mail; the turn-start memory delta — see memory-delivery-unification-
 * 2026-07-12 P-003a). That wiring is re-merged at every OPERATOR boot
 * (host-bootstrap → installPapercuspFiles), but it can drift BETWEEN boots —
 * a hand-edited settings.json, a fresh machine, a wiped home, OR (the
 * concrete failure this generalization fixes, WI-4394) simply a dev box whose
 * operator hasn't restarted since a NEW hook was added to the repo: on plain
 * `npm run dev` (no PAPERCUSP_DESKTOP=1) the self-install only runs at
 * operator boot, so a hook shipped after the last restart is silently absent
 * from every session's settings.json until the operator restarts or someone
 * hand-runs install-standalone-mcp.sh. The failure is SILENT either way: the
 * session launches fine and simply never gets that hook's behavior. Claude
 * reads hooks at session birth, so the moment that matters is right here,
 * before the spawn.
 *
 * PURE verdict: given the settings.json text + a hook-script existence probe,
 * report whether the named hook is wired under the named event and
 * executable-on-disk. Unknown/unparseable states report the specific miss —
 * the caller decides loudness. Exported for unit tests.
 */
export function ccHookEnrollment(settingsText, { event, hookName, scriptExists } = {}) {
  const misses = [];
  let cfg = null;
  try {
    cfg = JSON.parse(settingsText ?? '');
  } catch {
    return { enrolled: false, misses: ['settings.json missing or unparseable'] };
  }
  const entries = Array.isArray(cfg?.hooks?.[event]) ? cfg.hooks[event] : [];
  const cmds = entries.flatMap((e) => (Array.isArray(e?.hooks) ? e.hooks : []))
    .map((h) => (typeof h?.command === 'string' ? h.command : ''));
  const hookCmd = cmds.find((c) => c.includes(hookName));
  if (!hookCmd) {
    misses.push(`no ${event} entry runs ${hookName}`);
  } else if (typeof scriptExists === 'function') {
    // The command may carry env prefixes/args — extract the script path token.
    const tok = hookCmd.split(/\s+/).find((t) => t.includes(hookName)) ?? hookCmd;
    if (!scriptExists(tok)) misses.push(`hook script missing on disk: ${tok}`);
  }
  return { enrolled: misses.length === 0, misses };
}

/** Back-compat thin wrapper — same signature/behavior pre-generalization; the
 *  pinned unit tests (cc-coord-hook-enrollment.test.ts) import this name.
 *  EI-11405 (coordination-hook-rpc-fanout-collapse-2026-07-16): the standalone
 *  posttooluse-coord-inbox.sh hook this used to probe for is RETIRED — its
 *  coord:inbox mid-turn delivery is now folded into posttooluse-activity-
 *  report.sh's own round trip (delta-aware `hook_bundle`), so THAT is the
 *  script whose enrollment now gates "is this session deaf to mid-turn coord
 *  mail". */
export function ccCoordHookEnrollment(settingsText, { scriptExists } = {}) {
  return ccHookEnrollment(settingsText, {
    event: 'PostToolUse',
    hookName: 'posttooluse-activity-report.sh',
    scriptExists,
  });
}

/** Same verdict shape for the turn-start memory delta hook (WI-4394). */
export function ccTurnStartMemoryHookEnrollment(settingsText, { scriptExists } = {}) {
  return ccHookEnrollment(settingsText, {
    event: 'UserPromptSubmit',
    hookName: 'userpromptsubmit-memory.sh',
    scriptExists,
  });
}

/**
 * The I/O half: verify enrollment for a claude launch; on a miss, self-repair
 * ONCE through the operator's existing idempotent install route
 * (POST /api/desktop/install/papercusp-files — the same merge every operator
 * boot runs), re-verify, and print a LOUD banner if still unenrolled. Never
 * blocks or fails the launch (worst case ~4s on the already-broken path;
 * healthy path is one readFileSync). The session still works degraded-but-
 * launched either way — this is best-effort self-heal + loud disclosure, not
 * a launch gate.
 */
function ensureCcHookEnrollment(env, { event, hookName, label, degradedNote }) {
  if ((env.PAPERCUSP_AGENT || '') !== 'claude') return; // codex bakes per-session hooks.json; omp uses its own coord-hook
  const settingsPath = join(homedir(), '.claude', 'settings.json');
  const read = () => {
    try {
      return readFileSync(settingsPath, 'utf8');
    } catch {
      return '';
    }
  };
  const probe = (p) => existsSync(p);
  let verdict = ccHookEnrollment(read(), { event, hookName, scriptExists: probe });
  if (verdict.enrolled) return;
  // Self-repair: the operator re-runs the same idempotent hook merge its boot
  // path uses. Loopback-only route; short timeout; failure falls through to the
  // banner. curl keeps this synchronous (the spawn follows immediately).
  try {
    spawnSync('curl', ['-fsS', '-m', '4', '-X', 'POST', `${OPERATOR_URL}/api/desktop/install/papercusp-files`], {
      encoding: 'utf8',
      timeout: 6000,
    });
  } catch {
    /* unreachable operator → banner below */
  }
  verdict = ccHookEnrollment(read(), { event, hookName, scriptExists: probe });
  if (verdict.enrolled) {
    console.error(`psu: ${hookName} was missing from ~/.claude/settings.json — repaired via the operator install route.`);
    return;
  }
  console.error(
    [
      '',
      `⚠⚠ ${label} NOT ENROLLED — ${degradedNote} ⚠⚠`,
      `   ${verdict.misses.join('; ')}`,
      '   Self-repair via the operator failed or it is unreachable. Fix: restart the operator (it re-installs',
      `   hooks at boot), or: curl -X POST ${OPERATOR_URL}/api/desktop/install/papercusp-files`,
      '   Launching anyway.',
      '',
    ].join('\n'),
  );
}

function ensureCcCoordHookEnrollment(env) {
  ensureCcHookEnrollment(env, {
    event: 'PostToolUse',
    hookName: 'posttooluse-activity-report.sh',
    label: 'COORD-INBOX HOOK',
    degradedNote:
      'THIS SESSION WILL BE DEAF TO MID-TURN COORD MAIL — peer messages will only land at session start / orient / an explicit wake, and the fleet sees it flagged coordHook:missing in coord:presence',
  });
}

/** WI-4394: the turn-start memory delta (memory-delivery-unification-2026-07-12
 *  P-003a) is the same drift class as coord-inbox — verify + self-repair it too. */
function ensureCcTurnStartMemoryHookEnrollment(env) {
  ensureCcHookEnrollment(env, {
    event: 'UserPromptSubmit',
    hookName: 'userpromptsubmit-memory.sh',
    label: 'TURN-START MEMORY HOOK',
    degradedNote:
      'THIS SESSION WILL NEVER GET THE TURN-START MEMORY DELTA — a bare session with no initialize-time query gets no recall fallback at all',
  });
}

/** context-injection-audit-2026-07-28 P-015: the MID-TURN half of the same delta
 *  is the same drift class again — and the reason this verifier exists at all is
 *  EI-18891337746278593, where posttooluse-objective-title.sh sat deployed on disk
 *  but registered under no hook event, while the plan describing it claimed it
 *  "injects today". A hook that is copied but unenrolled is indistinguishable from
 *  a working one unless something checks. This checks. */
function ensureCcMidTurnContextHookEnrollment(env) {
  ensureCcHookEnrollment(env, {
    event: 'PostToolBatch',
    hookName: 'posttoolbatch-midturn-context.sh',
    label: 'MID-TURN CONTEXT HOOK',
    degradedNote:
      'THIS SESSION GETS RECALL ONLY AT TURN-START — a long tool-call turn will re-derive facts already in memory, with no injection after the opening prompt',
  });
}

/** Terminate a plain-launch process group, retaining a direct-child fallback.
 * `spawnInherit` uses `detached:true`, making the wrapper the leader of its own
 * process group on POSIX. The wrapper can leave a native backend descendant
 * behind after it exits, so cleanup must signal the group, not only the wrapper.
 * Negative process-group pids are POSIX-only; the direct child call keeps this
 * useful on Windows and when the group has already disappeared.
 */
export function killSpawnProcessTree(child, signal = 'SIGKILL', kill = process.kill) {
  const pid = Number(child?.pid);
  let killed = false;
  if (process.platform !== 'win32' && Number.isInteger(pid) && pid > 1) {
    try {
      kill(-pid, signal);
      killed = true;
    } catch {
      /* the group may already be gone; try the direct child below */
    }
  }
  try {
    child?.kill?.(signal);
    killed = true;
  } catch {
    /* already gone */
  }
  return killed;
}

/** The original plain launch: inherit the user's stdio straight into the child.
 *  The fallback when the managed-pty host is disabled, has no TTY, or fails to
 *  start. */
export function spawnInherit({
  wrapperBin,
  args = [],
  cwd,
  env,
  spawnImpl = spawn,
  processApi = process,
  signalSource = processApi,
  processKill = processApi.kill?.bind(processApi) ?? process.kill,
  processExit = processApi.exit?.bind(processApi) ?? process.exit,
  reportSessionEndedImpl = reportSessionEnded,
}) {
  // Fleet color for the no-pty fallback (the managed-pty host writes its own at
  // startup — see hostThroughPty). Recolor THIS window before the child takes the
  // terminal over; no fleet ⇒ no write (the profile default stands).
  const osc = fleetOscFromEnv(env);
  if (osc) {
    try {
      process.stdout.write(osc);
    } catch {
      /* best-effort — a recolor must never break the launch */
    }
  }
  const child = spawnImpl(wrapperBin, args, { cwd, env, stdio: 'inherit', detached: true });
  const terminalSignals = ['SIGINT', 'SIGTERM', 'SIGHUP'];
  let finished = false;
  let forwardedSignal = null;
  const signalHandlers = new Map();
  const removeSignalHandlers = () => {
    for (const [signal, handler] of signalHandlers) {
      try {
        signalSource.off?.(signal, handler);
      } catch {
        /* best-effort listener hygiene */
      }
    }
    signalHandlers.clear();
  };
  const forwardSignal = (signal) => {
    if (finished || forwardedSignal) return;
    forwardedSignal = signal;
    killSpawnProcessTree(child, signal, processKill);
  };
  if (typeof signalSource.on === 'function') {
    for (const signal of terminalSignals) {
      const handler = () => forwardSignal(signal);
      signalHandlers.set(signal, handler);
      signalSource.on(signal, handler);
    }
  }
  child.on('error', (e) => {
    if (finished) return;
    finished = true;
    removeSignalHandlers();
    killSpawnProcessTree(child, 'SIGKILL', processKill);
    console.error(`psu: failed to launch ${wrapperBin}: ${e.message}`);
    // WI-3884 follow-up: node's spawn reports ENOENT for a MISSING CWD with the
    // exact same error as a missing binary — a resume whose recorded working
    // directory was deleted looked like "codex not installed". Disambiguate.
    if (cwd && !existsSync(cwd)) {
      console.error(
        `psu: the session's recorded working directory no longer exists: ${cwd} — ` +
          `spawn fails with ENOENT even when ${wrapperBin} is installed. ` +
          `Recreate it (mkdir -p '${cwd}') and re-run, or resume a different session.`,
      );
    } else {
      console.error(`psu: is ${wrapperBin} on PATH? run apps/operator/scripts/install-standalone-mcp.sh`);
    }
    processExit(127);
  });
  child.on('exit', (code, signal) => {
    if (finished) return;
    finished = true;
    const terminalSignal = signal ?? forwardedSignal;
    // The wrapper may have exited while its native backend descendant is still
    // alive. Reap the detached group before handing terminal control back.
    killSpawnProcessTree(child, 'SIGKILL', processKill);
    removeSignalHandlers();
    // WI-38054: this path always KNEW the signal — it used it to re-kill itself — but
    // forwarded only `code`, so a killed session still recorded as a voluntary 'self'
    // exit. Report it.
    void Promise.resolve()
      .then(() => reportSessionEndedImpl(env.PAPERCUSP_ADV_SESSION_ID || null, code, {
        killedBySignal: terminalSignal,
      }))
      .catch(() => undefined)
      .finally(() => {
        // Remove handlers before re-signalling this supervisor, or the signal
        // re-enters forwardSignal and can recurse indefinitely.
        if (terminalSignal) processKill(processApi.pid, terminalSignal);
        else processExit(code ?? 0);
      });
  });
}

/**
 * EI-10938 — never hand an agent a cwd that is not a checkout.
 *
 * The console launcher used to open workspace-only (su) sessions in the
 * workspace's `.papercusp` STATE dir, which is not a git repo and holds no
 * source. Claude Code resets the shell cwd to the launch dir after every command,
 * so the agent paid a defensive `cd` on 77% of its bash calls, bare `git` failed,
 * and relative paths silently resolved into the state dir.
 *
 * That is fixed at the source (console-launcher's resolveWorkspaceHomeCwd). This
 * is the belt-and-braces guard for every OTHER way a bad cwd can arrive — a stale
 * caller, a recorded session cwd from before the fix, a hand-rolled invocation.
 * It ONLY ever redirects a cwd that is demonstrably a papercusp state dir into the
 * real checkout; a deliberate cwd (a harness dir, a user's own directory) is left
 * strictly alone.
 */
function repoCwdOrRedirect(cwd) {
  if (!cwd) return cwd;
  const isStateDir = basename(cwd) === '.papercusp';
  if (!isStateDir) return cwd; // a deliberate cwd — never second-guess it
  const markers = (d) =>
    existsSync(join(d, 'apps', 'operator', 'package.json')) &&
    existsSync(join(d, 'libs', 'papercusp', 'package.json'));
  if (markers(cwd)) return cwd; // somehow already a checkout — leave it
  const envRoot = process.env.PAPERCUSP_REPO_ROOT || process.env.PAPERCUSP_INTEGRATION_ROOT;
  if (envRoot && markers(envRoot)) {
    console.error(`psu: cwd was a state dir (${cwd}); using the checkout at ${envRoot}`);
    return envRoot;
  }
  return cwd; // no better answer — do not invent one
}

function runWrapper({
  wrapperBin,
  args = [],
  cwd,
  envelopeEnv,
  kickoff = null,
  kickoffFile = null,
  sessionPort = null,
  preserveCwd = false,
}) {
  // EI-10938's `.papercusp` state-dir → checkout redirect is correct for a FRESH
  // launch, but a RESUME/FORK MUST keep the recorded cwd: `claude --resume` /
  // `--fork` locate the transcript under the cwd-derived projects dir
  // (<CLAUDE_CONFIG_DIR>/projects/<encoded-cwd>/<id>.jsonl), and the archive
  // rematerializes it under the ORIGINAL cwd's encoding — so redirecting the cwd
  // makes claude search the checkout's projects dir instead → "No conversation
  // found", which silently made EVERY `.papercusp`-cwd session unresumable
  // (owner-reported 2026-07-13). Resume/fork pass preserveCwd:true; fresh
  // launches keep the guard.
  if (!preserveCwd) cwd = repoCwdOrRedirect(cwd);
  const env = { ...sanitizeInheritedEnv(process.env), ...envelopeEnv };
  // WI-5052 acceptance hardening: `default` is an active credential choice,
  // not merely the absence of a gateway overlay. Clear every prior Claude auth
  // source before restoring the system login below.
  enforceDefaultClaudeAccount(wrapperBin, env);
  // Export the RESOLVED operator url to every agent child so claude's user-level
  // papercusp-su MCP url (`${PAPERCUSP_OPERATOR_URL:-…}/api/mcp?…`, written by
  // desktop-install/claude-integration) resolves to the LIVE operator on each
  // launch. The desktop operator binds a dynamic localhost port per boot, so a
  // baked url would go stale; env-interpolation + this export self-heal it.
  // OPERATOR_URL already honors an explicit PAPERCUSP_OPERATOR_URL override.
  env.PAPERCUSP_OPERATOR_URL = OPERATOR_URL;
  // WI-3665: hand every descendant the terminal this launch OWNS, so the fleet-identity
  // title (👑/👤 + fleet + colour square) can be written even from a hook that has been
  // setsid'd away from its controlling terminal — which is exactly how Claude Code spawns
  // its statusLine command, and why that title silently never appeared.
  //
  // ALWAYS RE-DERIVED, NEVER INHERITED. sanitizeInheritedEnv keeps PAPERCUSP_*, so an
  // agent session that owns a terminal and then spawns a HEADLESS psu child (a bee) would
  // otherwise leak its own PAPERCUSP_TTY down — and the bee's every tool call would retitle
  // the human's window. Terminal ownership is a property of THIS launch and nothing else:
  // recompute it, and delete it outright when this launch owns no terminal.
  const ownedTty = resolveOwnedTtyPath();
  if (ownedTty) env.PAPERCUSP_TTY = ownedTty;
  else delete env.PAPERCUSP_TTY;
  // EI-10377: re-stamp this terminal's claim on EVERY launch that owns one, so a stale
  // writer left over from whoever owned this (possibly-recycled) pty path before us is
  // told, on its very next write attempt, that the claim has moved on. See
  // claimTtyOwnership for the full rationale.
  if (ownedTty && env.PAPERCUSP_SID) {
    claimTtyOwnership(ownedTty, env.PAPERCUSP_SID, { dir: env.PAPERCUSP_TTY_CLAIMS_DIR || undefined });
  }
  // ONE writer per title. Claude Code writes its own topic title and would otherwise fight
  // the statusline's fleet identity (last writer wins ⇒ flicker). Silence Claude's writer,
  // but ONLY when our statusline is the one it will actually load — see shouldSilenceClaudeTitle.
  if (shouldSilenceClaudeTitle({ agent: env.PAPERCUSP_AGENT, ownsTty: !!ownedTty, env })) {
    env.CLAUDE_CODE_DISABLE_TERMINAL_TITLE = '1';
  }
  // Default-account claude inherits the single stored CLI login via
  // CLAUDE_CODE_OAUTH_TOKEN — the only cross-platform path (macOS keeps the
  // OAuth token in the Keychain keyed per CLAUDE_CONFIG_DIR, so the per-session
  // config dir never finds the default ~/.claude login and no file reconcile can
  // heal it). No-op unless a token was stored (`psu --set-claude-token`) and the
  // session is default-account claude. See applyDefaultClaudeOAuthToken.
  applyDefaultClaudeOAuthToken(wrapperBin, env);
  // Settings can independently select a cloud provider, API key/helper, or
  // gateway even after the inherited process env is clean. Add a
  // highest-precedence override for this launch, and scrub the isolated copied
  // user settings so a Claude self-reexec (which drops argv) stays on the same
  // explicit default-account route.
  args = applyDefaultClaudeAuthSettingsArgs(wrapperBin, args, env);
  persistDefaultClaudeAuthSettings({ wrapperBin, env });
  // The GitHub Copilot MCP plugin (a Claude plugin OMP also discovers) needs
  // GITHUB_PERSONAL_ACCESS_TOKEN; unset → "Authorization header is badly formatted" (HTTP 400) on
  // every claude/omp launch. Export the gh CLI token when unset (verified it authenticates the MCP).
  applyGithubTokenEnv(env);
  // mcp-transport-resilience P-001 (2026-07-13): a mid-session Claude Code
  // AUTO-UPDATE relaunch re-execs the process, which (a) severs the papercusp-su
  // HTTP-MCP transport — tools vanish and the armed loop's events:await
  // registration dies with it (the su-39f07 5h-dark incident) — and (b) rebuilds
  // argv WITHOUT the launch flags (the recovery-banner class). Kill the trigger:
  // no mid-session self-update; version freshness is a spawn-time concern. The
  // env var is claude's; other backends ignore it. Opt back in per-box with
  // PAPERCUSP_CC_AUTOUPDATE=1.
  if (process.env.PAPERCUSP_CC_AUTOUPDATE !== '1') env.DISABLE_AUTOUPDATER = '1';
  // mcp-transport-resilience P-002 (2026-07-13): mirror this launch's argv
  // permission flags into the per-session settings.json so the SAME re-exec that
  // drops argv re-applies them MECHANICALLY from disk (see the helper's doc).
  persistReExecSafePermissions({ env, args });
  // P-002 (coord-delivery-residual-gaps): verify the claude coord-inbox hook is
  // enrolled BEFORE the spawn (Claude reads hooks at session birth) — self-repairs
  // via the operator's idempotent install route, loud-warns when it can't.
  ensureCcCoordHookEnrollment(env);
  // WI-4394: same drift class, same self-repair path, for the turn-start memory
  // delta hook — this is the concrete fix for the near-silent-live turn-start port.
  ensureCcTurnStartMemoryHookEnrollment(env);
  // P-015: and the mid-turn boundary the turn-start hook structurally cannot reach.
  ensureCcMidTurnContextHookEnrollment(env);
  // turn-lifecycle-control Phase 3: when enabled + interactive, host the agent
  // through a managed pty + owner-only control socket so the operator can inject
  // a wake (or, Phase 4, an interrupt) into the LIVE session rather than parking
  // it. The discovery key is the coord ownerId (PAPERCUSP_SID); without one the
  // operator can't find the socket, so we keep the plain launch.
  const ownerId = env.PAPERCUSP_SID || null;
  // identity-split fix (2026-07-02): durably bind this launch's native session
  // id → coord ownerId so a FUTURE untracked resume recovers the same identity
  // instead of minting a fresh SID (see recordSessionOwner). First write wins,
  // so re-recording on every launch/resume is a no-op for a known session.
  if (ownerId) {
    const advSessionId = env.PAPERCUSP_ADV_SESSION_ID || null;
    recordSessionOwner(nativeSessionIdFromLaunchArgs(args), ownerId, { advSessionId });
    // WI-1863: omp launches have NO native session UUID (nativeSessionIdFromLaunchArgs
    // returns null for them by design), so they never got an owner-index entry — a
    // desktop `session-<N>` was locally unresolvable to its coord ownerId, and a tester
    // resolving "the leader" from this index picked a nearby CLAUDE entry and misdelivered
    // directives (the 2026-07-03 ornith fleet-of-claude incident). ALSO key every launch
    // by its adv session id (`adv-<N>`) so session-number → ownerId always resolves.
    // Same first-write-wins semantics; the authoritative registry stays adv_sessions.
    if (advSessionId) recordSessionOwner(`adv-${advSessionId}`, ownerId, { advSessionId });
  }
  // liveness-hardening P-004: supervisor beat covers BOTH launch paths below.
  // EI-19948333346987654: thread the already-resolved owned-tty path (line
  // ~5395 above) into the beat so coord_presence.tty answers "which terminal
  // does this session own" without a /proc ancestry walk.
  const supervisorBeat = startSupervisorBeat(ownerId, { tty: ownedTty });
  // WI-38292: are we the SUCCESSOR of a host that exited to adopt fresh code? The
  // predecessor left this session's already-minted child argv on disk (its carry
  // included) because it could not put anything in our environment — the psu
  // shim's re-exec loop spawned us, not it. Consuming is single-shot and
  // self-validating; a null here is the ordinary cold-launch case.
  const hostHandoff = ownerId ? readHostHandoff(ownerId) : null;
  if (hostHandoff) {
    // Use the predecessor's argv VERBATIM. It was minted from an argv that had
    // already been through this launcher's whole normalization pass, so
    // re-deriving it here would re-apply flags that are already present and, far
    // worse, drop the rotated --session-id and the --append-system-prompt-file
    // that IS the carry.
    args = hostHandoff.args;
    for (const [k, v] of Object.entries(hostHandoff.childEnv ?? {})) env[k] = v;
    // The successor's first turn is the carry, delivered through the argv above.
    // A kickoff from THIS process's own command line would be the ORIGINAL
    // launch's first prompt replayed into a session that is many turns past it.
    kickoff = null;
    kickoffFile = null;
    sessionPort = null;
    if (hostHandoff.nativeId) {
      // The in-process respawn re-anchors identity through `onRespawn` AFTER
      // spawning the child; the adopting predecessor exits before it ever gets
      // there, so the successor owes both halves of that hook. Skipping the
      // second one is the P-018 successor-kill loop: adv_sessions keeps naming
      // the predecessor's native id, and the compaction watchdog then reaps a
      // session that is very much alive.
      recordSessionOwner(hostHandoff.nativeId, ownerId, {
        advSessionId: env.PAPERCUSP_ADV_SESSION_ID || null,
      });
      void reportSessionRespawned(env.PAPERCUSP_ADV_SESSION_ID || null, hostHandoff.nativeId, {
        coordOwnerId: ownerId,
      });
    }
    process.stderr.write(
      `psu: adopted updated host code for ${ownerId} (predecessor pid ${hostHandoff.fromPid ?? '?'}, ` +
        `mode ${hostHandoff.mode ?? 'unknown'})\n`,
    );
  }
  if (ownerId && usePtyHost({ env })) {
    try {
      hostThroughPty({
        command: wrapperBin,
        args,
        cwd,
        env,
        ownerId,
        // headless-fleet-launch P-001/D-004: never bridge a human TTY for a headless
        // member. It resolves false anyway when stdio is detached (stdin.isTTY undefined),
        // but pinning it makes `psu --headless` run FROM a real terminal (the debugging
        // case) deterministic — no setRawMode on the operator's own stdin, no SIGWINCH
        // coupling. The pty (and therefore the control socket + discovery file) still spawns.
        bridgeTty: env.PAPERCUSP_PSU_HEADLESS === '1' ? false : undefined,
        advSessionId: env.PAPERCUSP_ADV_SESSION_ID || null,
        // WI-1980: a cold-loop RECYCLE must respawn with a FRESH --session-id
        // (reusing the on-disk id storms the supervisor). Inject the arg-rewrite
        // + native→coord re-anchor here so the host stays launcher-agnostic.
        mintRecycleArgs,
        mintCarryRespawnArgs,
        // stale-prompt-render-in-live-sessions-2026-08-02 P-002: a respawn must
        // re-render the base persona instead of inheriting the predecessor's file,
        // or every prompt fix stops at the session's FIRST launch. Injected like the
        // mints so the host stays launcher-agnostic; returns null on any failure and
        // the host then keeps the inherited render.
        refreshPersonaFile: () => refreshPersonaRender(ownerId),
        // agent-launch-resume-primitives P-011/D-008: the first turn for a scripted
        // RESUME/FORK. A resumed CLI has no positional-prompt seam (the fresh path's
        // kickoff rides the argv), and a session that just came back from the dead is
        // unreachable by roster-gated coord:wake/coord:send — its presence rows were
        // reaped when it died. The host owns the pty, so it seeds the turn itself once
        // the child settles at its prompt.
        kickoff,
        // Session-port seeds use a separate server-owned file channel. The PTY
        // host does not acknowledge it until the exact checksum is visible in
        // the target backend's native transcript.
        kickoffFile,
        sessionPort,
        onKickoffPersisted: (proof) => reportSessionPortDelivery(sessionPort, proof),
        onRespawn: (freshId) => {
          recordSessionOwner(freshId, ownerId, { advSessionId: env.PAPERCUSP_ADV_SESSION_ID || null });
          // WI-5075: ALSO re-anchor the authoritative adv_sessions owner→native
          // mapping. recordSessionOwner only writes the file-based native→owner
          // index; resolveSessionRef / the compaction watchdog's estimate read
          // adv_sessions.session_id, which otherwise keeps naming the dead
          // predecessor — the P-018 successor-kill loop. coordOwnerId rides along
          // so an interactive/resumed launch (no adv id in env) re-anchors too.
          void reportSessionRespawned(env.PAPERCUSP_ADV_SESSION_ID || null, freshId, {
            coordOwnerId: ownerId,
          });
        },
        // WI-38292: leave so the psu shim's loop can re-run us on CURRENT host
        // code. Only wired when the shim actually advertised that loop — a
        // launcher nobody will re-run must never take this path, and this is the
        // handshake's enforcement point (the host separately re-checks the env).
        //
        // NOT reportSessionEnded: this session is continuing, in a new process. It
        // is also why the beat is stopped by hand — a heartbeat that outlives this
        // process by even one tick reports a pid that is gone, and the successor
        // is already beating for the same ownerId.
        onReexec: reexecExitCodeFrom(env)
          ? ({ code }) => {
              try {
                if (supervisorBeat) clearInterval(supervisorBeat);
              } catch {
                /* the exit below reclaims it regardless */
              }
              process.exit(code);
            }
          : null,
        // WI-38054: the managed-PTY path had no `signal` parameter at all, which is
        // where the owner's reaped agents lost the only evidence they were killed.
        onExit: (code, killedBySignal = null) => {
          void reportSessionEnded(env.PAPERCUSP_ADV_SESSION_ID || null, code, {
            killedBySignal,
          }).finally(() => process.exit(code ?? 0));
        },
      }).catch((e) => {
        // The pty was already spawned (the promise only rejects on an unforeseen
        // bridge error); don't double-spawn — surface + exit non-zero.
        process.stderr.write(`psu: managed-pty host error: ${e?.message ?? e}\n`);
        const finish = kickoffFile && sessionPort
          ? reportSessionPortDelivery(sessionPort, {
              persisted: false,
              renderedHash: sessionPort.renderedHash,
              error: `managed-pty host failed: ${e?.message ?? e}`,
            }).catch(() => undefined)
          : Promise.resolve();
        void finish.finally(() => process.exit(1));
      });
      return;
    } catch (e) {
      // Synchronous failure = the pty never started (node-pty load / spawn). Safe
      // to fall back to the plain inherit launch.
      process.stderr.write(
        `psu: managed-pty host unavailable (${e?.message ?? e}); using a plain launch. ` +
          `Set PAPERCUSP_PSU_NO_PTY=1 to silence.\n`,
      );
    }
  }
  // A kickoff can ONLY be delivered through the managed pty (it is injected as a
  // turn once the child settles at its prompt). If we got here with one pending,
  // the pty path was unavailable — say so LOUDLY rather than launching a session
  // that silently sits idle forever waiting for a first turn that never comes.
  if (kickoffFile) {
    process.stderr.write(
      `psu: session-port launch refused: a managed pty is required to deliver and verify the seed.\n`,
    );
    process.exitCode = 1;
    if (sessionPort) {
      void reportSessionPortDelivery(sessionPort, {
        persisted: false,
        renderedHash: sessionPort.renderedHash,
        error: 'managed pty unavailable before session-port seed delivery',
      }).catch(() => undefined);
    }
    return;
  }
  if (kickoff) {
    process.stderr.write(
      `psu: ⚠ a kickoff was requested but this launch has NO managed pty (no coord id, ` +
        `PAPERCUSP_PSU_NO_PTY/PAPERCUSP_PSU_PTY=0, or no TTY) — the session will open IDLE and ` +
        `its first turn was NOT delivered. Re-launch with the pty host enabled, or deliver the ` +
        `turn yourself (coord:wake once it registers presence).\n`,
    );
  }
  spawnInherit({ wrapperBin, args, cwd, env });
}

/**
 * A live discovery record can describe a process that has stopped doing useful
 * work. Process existence is still the safety gate (a second host must not
 * silently trample a running identity), but stale pty activity is valuable
 * diagnosis — especially for headless launches, where there is no real window
 * an owner can use. Two normal 15-minute wake gaps are allowed by default so a
 * loop-armed worker waiting for its next wake is not immediately called a husk.
 * Override for local recovery drills with
 * `PAPERCUSP_PSU_LIVE_HOST_IDLE_THRESHOLD_MS`.
 */
const liveHostIdleThresholdRaw = Number(process.env.PAPERCUSP_PSU_LIVE_HOST_IDLE_THRESHOLD_MS);
export const LIVE_HOST_IDLE_THRESHOLD_MS =
  Number.isFinite(liveHostIdleThresholdRaw) && liveHostIdleThresholdRaw > 0
    ? liveHostIdleThresholdRaw
    : 30 * 60_000;

/**
 * Classify the activity evidence in a discovery record. This is deliberately a
 * diagnostic helper, not an auto-release decision: a quiet interactive prompt
 * and a loop-armed headless worker can both be quiet while still owning a live
 * identity. The resume guard remains conservative and still requires
 * `PSU_FORCE_RESUME=1` to take over.
 * Pure — exported for tests.
 */
export function classifyLiveHostActivity(
  meta,
  { now = Date.now(), idleThresholdMs = LIVE_HOST_IDLE_THRESHOLD_MS } = {},
) {
  const activitySamples = [meta?.lastActivityAt, meta?.lastOutputAt, meta?.lastInputAt]
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value) && value > 0);
  const lastActivityAt = activitySamples.length > 0 ? Math.max(...activitySamples) : null;
  const idleMs = hostIdleMs(meta, now);
  const threshold = Number(idleThresholdMs);
  if (idleMs === null || !Number.isFinite(threshold) || threshold <= 0) {
    return { state: 'unknown', lastActivityAt, idleMs };
  }
  if (idleMs < threshold) return { state: 'active', lastActivityAt, idleMs };
  // Only a host that explicitly advertises no bridged human TTY can be called
  // abandoned. An interactive host may simply be waiting at its prompt; the
  // caller still gets an activity warning, but not a false abandonment verdict.
  return {
    state: meta?.bridgeTty === false ? 'abandoned' : 'idle',
    lastActivityAt,
    idleMs,
  };
}

function fmtAge(iso) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const ms = Date.now() - t;
  const m = 60_000, h = 3_600_000, d = 86_400_000;
  if (ms < 2 * m) return 'just now';
  if (ms < h) return `${Math.floor(ms / m)}m ago`;
  if (ms < d) return `${Math.floor(ms / h)}h ago`;
  return `${Math.floor(ms / d)}d ago`;
}

/** Resume a resolved session: cd to its recorded cwd + exec the RAW agent's
 *  resume command there (P-042 — no `*-su` wrapper), re-establishing the same
 *  per-session config the wrapper used to bake. `brain` marks the resumed
 *  session as the pinned brain (Queen) — an AGENT, so it re-applies the
 *  native-scheduler lockout the human resume path deliberately skips
 *  (flags don't persist into resumes; every brain dock-open re-arms it). */
// EI-12938: async because the resume must be able to re-ensure a non-launch-ready
// config dir server-side before spawning (ensureInteractiveConfigViaOperator).
// Every call site is already inside an async function and now awaits it.
async function launchResume(session, { brain = false, fork = false, passthrough = [], addDir = [], accountEnv = null, allowSubagents, model = null, kickoff = null } = {}) {
  // --fork is native for claude/codex — refuse early with a clear message rather than letting
  // resumeArgsFor throw a terse error (or, worse, appending to the original, which
  // is the clobber --fork exists to avoid).
  if (fork && session.agent !== 'claude' && session.agent !== 'codex') {
    console.error(forkUnsupportedMessage(session.agent));
    process.exit(2);
  }
  // WI-3455: refuse to double-host a LIVE session. A non-fork resume reuses the
  // original coord identity (PAPERCUSP_SID) + adv row, so resuming a session
  // that is STILL RUNNING in another window boots a SECOND psu host on the same
  // discovery key: the new boot tramples the live host's control socket, and
  // its exit deletes the key + falsely stamps the shared adv row ended —
  // stranding the original (wake / turn:interrupt / auto-/compact all report
  // no_live_pty_host on a live session; the 2026-07-08 su-a8f52 incident). A
  // FORK is the supported run-alongside path (fresh identity); PSU_FORCE_RESUME=1
  // overrides for recovery of a wedged-but-technically-alive host.
  if (!fork && session.coordOwnerId && process.env.PSU_FORCE_RESUME !== '1') {
    const live = findLiveHostFor(session.coordOwnerId);
    if (live) {
      const activity = classifyLiveHostActivity(live);
      const lastActivityIso = activity.lastActivityAt
        ? new Date(activity.lastActivityAt).toISOString()
        : null;
      const idleAge = lastActivityIso ? fmtAge(lastActivityIso) : 'an unknown time';
      if (activity.state === 'abandoned') {
        console.error(
          `psu: this session (${session.coordOwnerId}) appears ABANDONED: its headless host is still alive ` +
            `(host pid ${live.pid}) but has recorded no pty activity for ${idleAge}.\n` +
            `psu: last recorded activity: ${lastActivityIso}; there may be no usable window to resume. ` +
            `Verify its wake source, reap it if possible, or set PSU_FORCE_RESUME=1 to take over.\n` +
            `psu: if the host is intentionally loop-armed, leave it in place; otherwise do not wait on that husk.`,
        );
      } else if (activity.state === 'idle') {
        console.error(
          `psu: this session (${session.coordOwnerId}) is STILL LIVE but IDLE in another window ` +
            `(host pid ${live.pid}; no pty activity recorded for ${idleAge}, last activity ${lastActivityIso}).\n` +
            `psu: resuming it here would boot a second host on the same identity and strand the live one. ` +
            `Use that window if it is attended; if it is abandoned, reap it or set PSU_FORCE_RESUME=1 to take over.`,
        );
      } else {
        console.error(
          `psu: this session (${session.coordOwnerId}) is STILL LIVE in another window (host pid ${live.pid}).\n` +
            `psu: resuming it here would boot a second host on the same identity and strand the live one.\n` +
            `psu: use that window, run alongside it with --fork, or set PSU_FORCE_RESUME=1 to take over anyway.`,
        );
      }
      process.exit(2);
    }
  }
  if (addDir.length && session.agent === 'omp') {
    console.error('psu: omp has no --add-dir; ignoring it. Pass a backend flag verbatim with `-- <flag>` if omp supports one.');
  }
  // omp re-loads the coordination extension per invocation; claude/codex don't
  // use -e. Stable path, only added when actually installed.
  const coordExt = join(homedir(), '.papercusp', 'papercusp-coord.ts');
  const coordExtPath = session.agent === 'omp' && existsSync(coordExt) ? coordExt : undefined;
  const injectHookPath = resolveOmpInjectHookPath(session.agent);

  // Identity + workspace scope survive the resume (see resumeEnvFor) — except a
  // FORK, which deliberately takes a fresh coord identity + no adv-row link so it
  // can run alongside the still-live original it branched from. `accountEnv` re-pins
  // the inference-gateway account (spawn-env only, otherwise lost on resume); the
  // agent-session marker arms the hook-level scheduler guard (bash gate / omp
  // coord-hook) for the brain only — never the owner's own sessions (D-003).
  const env = buildResumeEnv(session, { fork, brain, accountEnv });
  // OMP's native id is scoped to its data root. A fresh tracked launch writes
  // under session-<adv id>; without restoring that root here, the exact id we
  // read from adv_sessions is looked up in ~/.omp and falsely appears missing.
  Object.assign(env, ompTrackedResumeEnv(session));
  // EI-155: a claude session launched with per-session transcript isolation wrote
  // its transcript under an isolated CLAUDE_CONFIG_DIR (keyed by coord owner id),
  // NOT the shared ~/.claude — point the resume back at it or `claude --resume
  // <uuid>` finds "No conversation found". `session.configDir` (an untracked
  // isolated session resolved by findUntrackedSession) wins; else derive from the
  // tracked row's coordOwnerId. Only when it exists — sessions launched before
  // EI-155 used the shared store and want no override.
  if (session.agent === 'claude') {
    // context-trimming parity for RESUMES (P-006 follow-on): claude silently disables tool
    // search whenever ANTHROPIC_BASE_URL is set (it can't assume a proxy forwards
    // tool_reference blocks — both of ours do, they are pass-throughs), so a routed session
    // boots with EVERY schema inline (~106k vs ~60k measured, context-trimming-tiers P-031).
    // The FRESH path forces it back on; the resume path never did, so every resumed
    // gateway-routed session has been silently paying that. Force it here too — otherwise
    // routing default-account sessions through the cache proxy would spread the same defect.
    if (session.agent === 'claude' && env.ANTHROPIC_BASE_URL && env.ENABLE_TOOL_SEARCH === undefined) {
      env.ENABLE_TOOL_SEARCH = 'true';
    }
    const dir = session.configDir
      || (session.coordOwnerId ? sessionClaudeConfigDir(session.coordOwnerId) : null);
    if (dir && existsSync(dir)) {
      env.CLAUDE_CONFIG_DIR = dir;
      // EI-12938: creds are not account state. The reheal below fixes
      // `.credentials.json`; `.claude.json` (oauthAccount / onboarding / trust /
      // the user-level MCP servers) only ever comes from the interactive mirror,
      // and a dir restored from the archive (transcript only) or built for a
      // headless bee (creds symlink only) has none — so an interactive resume
      // lands in the first-run wizard. Re-ensure it server-side (ONE mirror
      // implementation) BEFORE the reheal + the settings merge below, so those
      // read the materialized dir rather than re-creating a stub over it.
      // No-op + no round-trip when the dir is already healthy.
      await ensureInteractiveConfigViaOperator(session.coordOwnerId, dir);
      // psu-resume-relogin fix: a fresh launch re-heals this dir's
      // .credentials.json (writeInteractiveClaudeConfig's reconcile-before-
      // mirror); a raw resume did not, so an in-session OAuth refresh that
      // forked the symlink into a now-stale real file made a default-account
      // resume "launch logged out". Re-point it at the global CLI login before
      // spawn. Skipped for a gateway-pinned account (auths via ANTHROPIC_BASE_URL).
      // P-006: the CACHE PROXY also sets ANTHROPIC_BASE_URL but carries the SYSTEM login
      // through verbatim — it is precisely the "default account" case this reheal exists for,
      // so it must NOT be treated as a gateway route here (skipping it would resurrect the
      // "default-account resume launches logged out" bug for every default session).
      if (!env.ANTHROPIC_BASE_URL || isCacheProxyUrl(env.ANTHROPIC_BASE_URL)) rehealResumeCredentials(dir);
    }
  }
  // codex resumes from its per-session CODEX_HOME — derived from the session id
  // (that home still holds the session's history; only re-launching the SAME
  // session rebuilds it). The home's config.toml carries the baked superuser
  // bearer, so no PAPERCUSP_SU_TOKEN is needed. An explicit `codexHome`
  // (WI-3884: a tracked home recovered by disk scan, not row id) wins — it is
  // the home the rollout was actually FOUND in.
  if (session.agent === 'codex' && session.codexHome && existsSync(session.codexHome)) {
    env.CODEX_HOME = session.codexHome;
  } else if (session.agent === 'codex' && session.id != null) {
    env.CODEX_HOME = join(homedir(), '.papercusp', 'su-codex-homes', `session-${session.id}`);
  }
  let resumeModel = model;
  if (session.agent === 'omp') {
    resumeModel = applyOmpResumeAccountRoute({ session, env, accountRoute: accountEnv, model });
    const requestedResumeModel = resumeModel;
    resumeModel = normalizeOmpModelSpec(requestedResumeModel);
    const resumeModelNotice = ompModelCompatibilityNotice(requestedResumeModel);
    if (resumeModelNotice) console.error(resumeModelNotice);
  }
  if (session.agent === 'codex' && env.CODEX_HOME) {
    // WI-38706 — REBUILD BEFORE PATCHING. The claude branch above re-ensures its
    // config dir server-side on every resume; codex never did, so a home whose
    // config.toml had been deleted (or reduced to codex's trust-only stub) went
    // straight into the patch below, which happily wrote a gateway-less config
    // into the hole and left `codex resume` to fail on the missing provider.
    // The provider THIS thread is bound to decides both halves below: the rebuild
    // must re-emit that provider's table, and the patch must not then remove it.
    // A resume with no explicit --account resolves to mode 'default'
    // (chooseResumeAccount does not inherit the session's original pin), so an
    // unguarded patch strips the very `[model_providers.…]` table the rollout names.
    const rollout = findCodexRollout(join(env.CODEX_HOME, 'sessions'), session.sessionId ?? '');
    const boundProvider = rollout ? codexRolloutModelProvider(rollout) : null;
    await ensureCodexHomeViaOperator(session.coordOwnerId ?? null, env.CODEX_HOME, session.id ?? null, {
      requireGatewayProvider: boundProvider === CODEX_GATEWAY_PROVIDER_ID,
    });
    applyCodexGatewayRoute(env.CODEX_HOME, {
      mode: accountEnv?.mode ?? 'default',
      id: accountEnv?.id ?? null,
      ownerId: session.coordOwnerId ?? null,
      keepExistingWhenUnrouted: boundProvider === CODEX_GATEWAY_PROVIDER_ID,
    });
    // AFTER the gateway patch, which re-orders the file around its own markers —
    // see codexContextWindowConfigPatch for why these root keys must land first.
    // A resume that names no model resolves it from the home itself, which is
    // what stops a resumed session falling back to codex's 272k default (P-004).
    applyCodexContextWindow(env.CODEX_HOME, resumeModel);
  }

  const { bin, args } = resumeArgsFor(session, {
    coordExtPath,
    injectHookPath,
    fork,
    addDir,
    allowSubagents,
    model: resumeModel,
  });
  if (brain && session.agent === 'claude') args.push(NATIVE_SCHEDULER_DENY_FLAG);
  // notify-send lockout rides resumeArgsFor for claude already; nothing extra here.
  // Generic `--` passthrough, forwarded verbatim after psu's own resume flags.
  if (passthrough.length) args.push(...passthrough);

  // Surface the successfully resolved account route. Unavailable explicit
  // auto/pin choices already threw, so this can never describe a silent fallback.
  if (accountEnv?.notice) console.error(`psu: account — ${accountEnv.notice}`);
  // Re-activate the tracked adv row that the prior exit stamped `ended` (a no-POST
  // resume reuses the original identity + row, so without this the running agent
  // stays recorded-as-dead → invisible to the roster). A FORK deliberately takes a
  // fresh identity + no adv-row link, so it never reactivates the original.
  // Fire-and-forget, fail-soft — never delays the resume.
  if (!fork && session.id != null) {
    void reportSessionResumed(session.id);
  }
  // IDENTITY-LEAK FIX (su-resume-inherits-role-mcp-json, 2026-06-30): a resumed SU claude/omp session
  // PATH-DISCOVERS <cwd>/.mcp.json and the resume path adds NO --strict-mcp-config — so a role-scoped
  // .mcp.json a co-located role spawn left in the session's cwd is inherited, giving the SU resume
  // that role's principal (e.g. system:sentinel, read-only) instead of user-level papercusp-su. This
  // is exactly the mis-launch that stranded session e424229c as system:sentinel. Park it for an SU
  // (non-role) resume; a ROLE resume (coordOwnerId 'role-…') keeps its own config. parkRoleScopedMcpJson
  // only moves ROLE-scoped files (leaves the SU's own papercusp-su alone) and role launches recreate
  // .mcp.json fresh — so parking is safe + needs no restore. Mirrors the fresh-SU park above.
  if (
    (session.agent === 'claude' || session.agent === 'omp') &&
    !String(session.coordOwnerId || '').startsWith('role-')
  ) {
    const parked = parkRoleScopedMcpJson(session.cwd);
    if (parked) console.error(`psu: parked a stale role-scoped ${session.cwd}/.mcp.json (an SU resume must use user-level papercusp-su, not a co-located role server)`);
  }
  console.error(`psu: ${fork ? 'forking' : 'resuming'} ${session.agent} in ${session.cwd}  (${bin} ${args.join(' ')})`);
  // P-011/D-008: seed the first turn of a SCRIPTED resume/fork — the managed-pty
  // host injects it once the child settles at its prompt. Provenance-tagged like
  // the fresh path's kickoff so the resumed session's prompt hook classifies it as
  // machine-origin (fleet-kickoff), never as the owner typing.
  if (kickoff) {
    console.error("psu: kickoff — seeding the resumed session's first turn (suppress with --no-kickoff)");
  }
  runWrapper({
    wrapperBin: bin,
    args,
    cwd: session.cwd,
    // A resume MUST run in the recorded cwd so `claude --resume` finds the
    // transcript under its cwd-encoded projects dir (EI-10938's state-dir
    // redirect would send it to the checkout → "No conversation found").
    preserveCwd: true,
    envelopeEnv: env,
    kickoff: kickoff ? tagKickoffProvenance(kickoff, env.PAPERCUSP_SID || null) : null,
  });
}

/**
 * The bootstrap-su POST body that mints the NEW tracked row + native id for a
 * fork. Pure — exported for tests. A fork carries over the original's workspace +
 * plan and lands in the ORIGINAL's cwd (harness_slug:null so the server doesn't
 * relocate cwd — the seeded transcript is keyed by the original's cwd, and claude
 * resolves --resume by CLAUDE_CONFIG_DIR + the encoded cwd it runs in, so the fork
 * MUST run in that same cwd). agent is claude here because tracked forks need a
 * forced native id, and Codex exposes native fork but not caller-chosen fork ids.
 */
export function forkBootstrapBody(session, account = null) {
  return {
    agent: 'claude',
    workspace: session.workspaceId || null,
    harness_slug: null,
    plan_slug: session.planSlug || null,
    cwd: session.cwd,
    // A tracked fork mints a fresh session, so the gateway account pin is folded
    // server-side (resolveAccountPin) into the new launch envelope — the same path
    // a fresh psu launch takes. Omitted → no `account` key (byte-identical).
    ...(account ? { account } : {}),
  };
}

/**
 * fleet-auto-mode (WI-1356): should this launch start in AUTO mode (the persona's
 * act/don't-ask/loop-until-done standing state)? An explicit `--auto`/`--no-auto`
 * wins; otherwise a `--fleet` launch defaults AUTO ON (a fleet MEMBER has no human at
 * its keyboard). A new-fleet create via the interactive picker (fleetName → leader)
 * does NOT default on — a leader already auto-enters AUTO via the persona rule, and
 * it has a human present. Pure — exported for tests.
 */
export function effectiveAutoMode(args) {
  // drain-mode P-003: DRAIN IMPLIES AUTO — a drain launch is autonomous by definition,
  // and this is NOT overridable by --no-auto (a non-auto drain is a contradiction).
  if (args.mode === 'drain') return true;
  return args.auto ?? Boolean(args.fleet);
}

/**
 * WI-1408 (fleet-join-startup-assertion): hard client-side guard mirroring the
 * server's own invariant — when this launch explicitly requested a fleet (an
 * existing `--fleet=<slug>` join, or a fresh `--fleet-name` create), the
 * bootstrap response's `fleetSlug` must come back non-null. bootstrap-su and
 * bootstrap-role already refuse (409, surfaced by `api()` as a thrown Error) a
 * fleet join that failed server-side, so this never fires in the happy path —
 * it's the last line of defense against a FUTURE regression that silently
 * returns `status: 'ok'` with `fleetSlug: null`: exactly the "colour-only,
 * membership forgotten" bug this whole feature exists to prevent.
 *
 * Skew tolerance: this launcher always runs from the STAGING tree while the
 * operator it bootstraps against runs the GREEN release pin — which can lag by
 * hours (or, wedged, weeks). A pre-WI-1408 server registers the membership
 * correctly (env PAPERCUSP_FLEET_SLUG + the pending-fleet row) but simply does
 * not echo `fleetSlug` in the response. So the hard-fail keys on the field
 * being PRESENT-BUT-NULL (a new server that genuinely failed the join); a
 * response with the field ABSENT means an old server — warn loudly and
 * continue rather than killing a correctly-fleeted member (the 2026-07-01
 * 10-member wipeout). Pure — exported for tests.
 */
export function assertFleetJoined(requestedFleet, res) {
  if (!requestedFleet) return;
  if (res && !('fleetSlug' in res)) {
    console.error(
      `psu: ⚠ --fleet was requested (${requestedFleet}) but the operator's bootstrap response predates the fleetSlug field (an older release build) — cannot verify the join client-side. The join was still applied server-side; confirm with fleet:status once up.`,
    );
    return;
  }
  if (!res?.fleetSlug) {
    throw new Error(
      `psu: --fleet was requested (${requestedFleet}) but the launch did not register a fleetSlug — refusing to start an unfleeted member. This should never happen (bootstrap-su/-role hard-fail server-side); if you see this, it's a regression.`,
    );
  }
}

/**
 * launch-path-argv-reconstruction (WI-1343): the literal `psu …` invocation this
 * fresh-SU launch reduces to — recorded on adv_sessions.launch_argv (via the
 * bootstrap-su body) so a killed batch (e.g. a 14-agent fleet) can be reconstructed
 * after the fact. Reconstructed from the RESOLVED selections + flags (so it is
 * complete even for an interactive picker launch that passed no flags). Pure —
 * exported for tests.
 */
export function psuLaunchArgvRecord(selections, args, { brain = false } = {}) {
  const argv = args.sessionPortSourceAdvSessionId
    ? ['psu', '--no-picker', `--resume=${args.sessionPortSourceAdvSessionId}`, `--agent=${selections.agent}`]
    : ['psu', '--no-picker', `--agent=${selections.agent}`];
  // Headless is a durable launch discriminator: the live-session reaper may
  // only relax the owner-directed SU safeguard when this exact token was
  // recorded. Do not infer it from the environment or rewrite it as an
  // assignment/value form; legacy and interactive rows must stay protected.
  if (args.headless) argv.push('--headless');
  if (args.carry) argv.push(`--carry=${args.carry}`);
  if (selections.workspace) argv.push(`--workspace=${selections.workspace}`);
  if (selections.harness) argv.push(`--harness=${selections.harness}`);
  argv.push(selections.plan ? `--plan=${selections.plan}` : '--no-plan');
  if (args.profile) argv.push(`--profile=${args.profile}`);
  if (args.contextSize) argv.push(`--context-size=${args.contextSize}`);
  // P-005: MUST be re-emitted here — this record is what lands on
  // adv_sessions.launch_argv, and the compaction watchdog reads the limit back OFF
  // that argv. A parse without this re-emit would drop the flag silently.
  if (args.compactionLimit) argv.push(`--compaction-limit=${args.compactionLimit}`);
  if (args.model) argv.push(`--model=${args.model}`);
  if (args.account) argv.push(`--account=${args.account}`);
  // A joined fleet (--fleet=<slug>) or a new fleet's derived slug (picker → fleetName).
  const fleetSlug = args.fleet || (args.fleetName ? fleetSlugFromName(args.fleetName) : null);
  if (fleetSlug) argv.push(`--fleet=${fleetSlug}`);
  if (args.seat) argv.push(`--seat=${args.seat}`);
  if (args.mode) argv.push(`--mode=${args.mode}`);
  if (effectiveAutoMode(args)) argv.push('--auto');
  if (args.launchContext) argv.push(`--launch-context=${args.launchContext}`);
  if (args.launchedBy) argv.push(`--launched-by=${args.launchedBy}`);
  if (args.ownerId) argv.push(`--owner-id=${args.ownerId}`);
  for (const d of args.addDir || []) argv.push(`--add-dir=${d}`);
  // Subagent-launch deny is DEFAULT-ON; only the non-default opt-IN needs recording.
  if (args.allowSubagents) argv.push('--allow-subagents');
  if (brain) argv.push('--brain');
  if (args.passthrough?.length) argv.push('--', ...args.passthrough);
  return argv;
}

export function freshSuBootstrapBody(selections, args, { brain = false } = {}) {
  return {
    agent: selections.agent,
    workspace: selections.workspace,
    harness_slug: selections.harness,
    plan_slug: selections.plan,
    // WI-1343: the literal psu invocation → adv_sessions.launch_argv (traceability).
    launch_argv: psuLaunchArgvRecord(selections, args, { brain }),
    // WI-1356: start fleet/auto launches in AUTO mode — bootstrap-su bakes the durable
    // AUTO directive into the system prompt + prepends it to the seeded kickoff.
    ...(effectiveAutoMode(args) ? { auto: true } : {}),
    // drain-mode P-003: forward the named mode — bootstrap-su validates it (unknown → 400),
    // forces autoMode on, and bakes the DRAIN directive into system prompt + kickoff.
    ...(args.mode ? { mode: args.mode } : {}),
    ...(args.profile ? { profile: args.profile } : {}),
    // EI-996: the su-tier ROLE NAME (e.g. 'planner'). The server resolves that
    // role's addendum from prompts/su-role-<role>.addendum.md and appends it to
    // the engineer playbook; the launch keeps the superuser MCP tier. A NAME,
    // never prose — this endpoint mints a superuser-tier prompt, so it exposes no
    // free-text append surface. Omitted for a plain su launch ⇒ byte-identical.
    ...(args.suRole ? { su_role: args.suRole } : {}),
    ...(args.contextSize ? { context_size: args.contextSize } : {}),
    // context-trimming-tiers P-017: explicit persona tier; omitted ⇒ server auto-select.
    ...(args.personaTier ? { persona_tier: args.personaTier } : {}),
    // weak-model-tool-tier: forward the launch model so the server's tool-tier gate
    // (buildLaunchSpec) can hard-trim a WEAK/local model's catalog for the codex path
    // (omp trims client-side above; claude self-trims). Frontier ⇒ no trim (safe default).
    ...(args.model ? { model: args.model } : {}),
    ...(brain ? { brain: true } : {}),
    ...(args.account ? { account: args.account } : {}),
    // named-su-agent-fleets P-006: `fleet` = the slug to JOIN (member); `fleet_name`
    // = a freshly-entered name the server creates a fleet row from (this agent leads
    // it). The server folds PAPERCUSP_FLEET_SLUG/PAPERCUSP_FLEET_ROLE into the env.
    ...(args.fleet ? { fleet: args.fleet } : {}),
    ...(args.fleetRole ? { fleet_role: args.fleetRole } : {}),
    ...(args.fleetName ? { fleet_name: args.fleetName } : {}),
    ...(args.fleetScheme ? { fleet_scheme: args.fleetScheme } : {}),
    // agent-allocation P-005 (launch-from-seats): the delegated agent_slot template
    // this member consumes — bootstrap-su records it (consumeSeatAtBoot, mig 487)
    // and refuses the boot with seats_exhausted when the fleet's cap is reached.
    ...(args.seat ? { seat: args.seat } : {}),
    ...(args.launchContext ? { launch_context: args.launchContext } : {}),
    // Opaque session label → adv_sessions.label (bootstrap-su reads body.label),
    // so the launcher can later correlate the booted session to its coord owner id
    // (the tutorial docs-agent reuse path). No behavioural effect beyond the stamp.
    ...(args.label ? { label: args.label } : {}),
    // solo-launch-provenance: who launched this session — bootstrap-su bakes it
    // into the system prompt + PAPERCUSP_LAUNCHED_BY + an owner-scoped standing fact.
    ...(args.launchedBy ? { launched_by: args.launchedBy } : {}),
    // WI-5002/EI-13277: pre-pinned coord owner id — bootstrap-su validates it and
    // uses it as the session's sid instead of minting (programmatic-spawner contract).
    ...(args.ownerId ? { owner_id: args.ownerId } : {}),
    // A port's fresh target starts in the source's exact recorded cwd. This is
    // data provenance, not a harness-derived relocation, and is included in the
    // inspected source hash/contract.
    cwd: args.sessionPortSourceCwd || process.cwd(),
    ...(args.sessionPortToken ? {
      session_port_protocol: args.sessionPortProtocol,
      session_port_transform_version: args.sessionPortTransformVersion,
      session_port_token: args.sessionPortToken,
    } : {}),
  };
}

export function roleBootstrapBody({ role, agent, workspace, harness, feature, plan, account, model, fleet, fleetRole, fleetName, fleetScheme } = {}) {
  return {
    role,
    agent,
    workspace,
    harness_slug: harness,
    feature,
    plan,
    ...(account ? { account } : {}),
    ...(model ? { model } : {}),
    ...(fleet ? { fleet } : {}),
    ...(fleetRole ? { fleet_role: fleetRole } : {}),
    ...(fleetName ? { fleet_name: fleetName } : {}),
    ...(fleetScheme ? { fleet_scheme: fleetScheme } : {}),
  };
}

/**
 * src/dst for seeding a fork's fresh isolated config dir with the original's
 * transcripts. Pure — exported for tests. We copy the whole `projects/` subtree
 * (the original's per-session dir holds essentially just <origId>.jsonl) so that
 * whichever encoded-cwd dir claude looks under, the original transcript is present
 * to --resume from.
 */
export function forkSeedPaths(origConfigDir, forkConfigDir) {
  return { src: join(origConfigDir, 'projects'), dst: join(forkConfigDir, 'projects') };
}

/**
 * `psu --resume <tracked-claude> --fork` → a NEW *tracked* session. Unlike the
 * plain (untracked) fork (launchResume + fork, which lets claude mint a random id
 * with no adv row), this:
 *   1. mints a fresh adv_sessions row + native id via bootstrap-su (same envelope
 *      a fresh psu session gets: per-session CLAUDE_CONFIG_DIR, coord owner id, MCP),
 *   2. SEEDS that fresh config dir with the original's transcript (forkSeedPaths),
 *   3. launches `claude --resume <origId> --fork-session --session-id <forkId>` so
 *      claude forks the history into the psu-known id (verified: the trio is valid).
 * The fork therefore shows up in `psu --resume`'s picker like any other psu session.
 * Its coord identity (PAPERCUSP_SID) is fresh (a NEW row), so it runs concurrently
 * with the still-live original without colliding on locks/presence/inbox-wake.
 *
 * No engineer-playbook re-injection (unlike launchFreshSu): the forked history
 * already carries the original's system prompt — appending it again would double it.
 *
 * Falls back to the plain untracked fork (launchResume) when the session isn't a
 * forkable tracked claude session, including Codex native forks, or when bootstrap-su is unreachable/incomplete —
 * so `--fork` never hard-fails on the tracked path.
 */
/**
 * The env a TRACKED fork actually execs with — bootstrap-su's envelope PLUS the
 * psu agent-session marker. Pure — exported for tests. bootstrap-su (server-side)
 * never sets PAPERCUSP_AGENT_SESSION itself (it's a pure client-side launcher
 * concern, mirroring buildResumeEnv / the fresh-launch envelopeEnv), so folding
 * it in here is what arms the hook-level guards (native-scheduler lockout,
 * destructive shared-tree git guard — pretooluse-bash-resource-gate.sh gates
 * both on this exact var) for a forked su session. Missing it let `git stash`
 * run unblocked on the shared staging tree from a forked session (2026-07-05,
 * WI-3071).
 */
export function trackedForkEnvelopeEnv(bootstrapEnvelopeEnv, agent = 'claude') {
  // P-022: a fork spawns a NEW CLI process, so the native-compaction retirement
  // must be re-stamped here exactly as on fresh launches and resumes — the
  // server's bootstrap envelope never carries it. (The tracked-fork path is
  // claude-only today; the agent param keeps the stamp honest if that widens.)
  return { ...bootstrapEnvelopeEnv, PAPERCUSP_AGENT_SESSION: '1', ...nativeCompactionEnv(agent) };
}

/** Preserve the complete account-route decision when a tracked fork falls back
 * to the native fork path. Codex applies routing from `mode`/`id`, not env alone;
 * narrowing this object to `{ env, notice }` silently converted its auto/pin
 * forks to the default route. */
export function forkFallbackAccountRoute(account = null) {
  return {
    ...(account ?? {}),
    env: account?.env ?? {},
    notice: account?.notice ?? null,
  };
}

async function launchTrackedFork(session, args = {}, acct = { id: null, env: {}, notice: null }, model = null) {
  // The account re-pin: a TRACKED fork folds it server-side (forkBootstrapBody →
  // resolveAccountPin), like a fresh launch; an UNTRACKED fallback re-pins client-
  // side via accountEnv (it never hits bootstrap-su).
  const forkOpts = {
    fork: true,
    passthrough: args.passthrough,
    addDir: args.addDir,
    accountEnv: forkFallbackAccountRoute(acct),
    allowSubagents: args.allowSubagents,
    model,
    // P-011/D-008: a scripted fork gets its first turn seeded too. It matters MORE
    // here than for an in-place resume: a fork mints a FRESH coord identity, so no
    // external caller can even address it until it boots and registers presence.
    kickoff: resumeKickoffText(args),
  };
  const forkable = session.agent === 'claude' && session.sessionId && session.coordOwnerId && session.id != null;
  if (!forkable) {
    // Untracked claude (no adv row) → the plain untracked fork; non-claude →
    // launchResume refuses with a clear message. Either way defer to launchResume.
    await launchResume(session, forkOpts);
    return;
  }
  let res;
  try {
    res = await api('/api/agent-mcp/console/bootstrap-su', {
      method: 'POST',
      body: JSON.stringify(forkBootstrapBody(session, acct?.forward ?? acct?.id ?? null)),
    });
  } catch (e) {
    console.error(`psu: fork bootstrap failed (${e?.message ?? e}) — falling back to an UNTRACKED fork (resumable only by uuid).`);
    await launchResume(session, forkOpts);
    return;
  }
  const forkId = res?.nativeSessionId || null;
  const forkConfigDir = res?.envelopeEnv?.CLAUDE_CONFIG_DIR || null;
  if (!forkId || !forkConfigDir) {
    console.error('psu: fork bootstrap returned no native id / config dir — falling back to an UNTRACKED fork (resumable only by uuid).');
    await launchResume(session, forkOpts);
    return;
  }
  // Seed the fork's empty per-session config dir with the original's transcript so
  // `claude --resume <origId>` resolves there; the forked turns then write
  // <forkId>.jsonl in the fork's OWN dir (keyed by its fresh coord owner id).
  const origConfigDir = session.configDir || sessionClaudeConfigDir(session.coordOwnerId);
  const { src, dst } = forkSeedPaths(origConfigDir, forkConfigDir);
  try {
    if (existsSync(src)) { mkdirSync(dst, { recursive: true }); cpSync(src, dst, { recursive: true }); }
    else console.error(`psu: original transcript dir not found (${src}) — claude --resume may fail to find it.`);
  } catch (e) {
    console.error(`psu: could not seed the fork transcript (${e?.message ?? e}) — continuing; claude --resume may not find the original.`);
  }
  // Resume the ORIGINAL's id, fork into the FORCED fork id. No playbook re-inject.
  const { bin, args: forkArgs } = resumeArgsFor(session, { fork: true, forkSessionId: forkId, addDir: args.addDir, allowSubagents: args.allowSubagents, model });
  if (args.passthrough?.length) forkArgs.push(...args.passthrough);
  console.error(
    `psu: forking claude ${session.sessionId} → tracked session #${res.sessionId ?? '?'} (${forkId}) in ${session.cwd}  (${bin} ${forkArgs.join(' ')})`,
  );
  console.error('psu: the fork is a NEW tracked session — it appears in `psu --resume`; the original is untouched.');
  // Surface the account route the POST resolved. Explicit nondefault failures are
  // HTTP errors now, so a tracked fork never silently falls back to system login.
  if (res.accountNotice) console.error(`psu: account — ${res.accountNotice}`);
  // Run in the ORIGINAL's cwd (the seeded transcript is keyed by it); the fresh
  // bootstrap envelope (config dir / coord id / MCP) makes it a proper SU session
  // — trackedForkEnvelopeEnv folds in the agent-session marker bootstrap-su omits.
  const forkKickoff = resumeKickoffText(args);
  if (forkKickoff) console.error("psu: kickoff — seeding the fork's first turn (suppress with --no-kickoff)");
  runWrapper({
    wrapperBin: bin,
    args: forkArgs,
    cwd: session.cwd,
    // Same as resume: the seeded transcript is keyed by the original cwd, so
    // never redirect it away from a `.papercusp` state dir (EI-10938).
    preserveCwd: true,
    envelopeEnv: {
      ...trackedForkEnvelopeEnv(res.envelopeEnv),
      // A successful tracked fork resolves account routing server-side. No
      // gateway URL in the returned envelope means the result is the direct
      // system route; stamp the same fail-closed marker as an in-place resume.
      ...(res.agent === 'claude' && !res.envelopeEnv?.ANTHROPIC_BASE_URL ? defaultAccountEnv() : {}),
    },
    // Tagged with the FORK's fresh SID (not the original's) — the provenance ledger
    // is keyed by the identity that will actually submit the turn.
    kickoff: forkKickoff
      ? tagKickoffProvenance(forkKickoff, res?.envelopeEnv?.PAPERCUSP_SID || null)
      : null,
  });
}

/** A session that couldn't be matched to a tracked adv_sessions row — either a
 *  genuinely vanilla session, or a psu session that predates native-id tracking
 *  (its id was never recorded, so it can't be linked). Either way the engineer
 *  playbook won't be re-injected (and for codex, the papercusp-su tools — it ran
 *  under ~/.codex). Warn + require explicit confirmation before resuming it as
 *  if it were SU. `--yes` bypasses (scripts); non-interactive without `--yes`
 *  refuses. */
async function confirmUntrackedResume(session, args) {
  const sid = session.sessionId || session.ompThreadId || '?';
  const missing = session.agent === 'codex'
    ? 'the engineer playbook + papercusp-su tools'
    : 'the engineer playbook';
  console.error(
    `psu: ⚠ session ${sid} isn't linked to a tracked psu launch — resuming it as a raw ` +
      `${session.agent} session (${missing} won't be re-injected; ${session.cwd}). ` +
      `Sessions psu started before native-id tracking won't match here either. Resuming continues it as-is.`,
  );
  if (args.yes) { console.error('psu: --yes given; proceeding.'); return; }
  if (!args.picker) {
    console.error('psu: refusing to resume an untracked session non-interactively — re-run without --no-picker, or pass --yes.');
    process.exit(2);
  }
  const { confirm } = await import('@inquirer/prompts');
  const proceed = await confirm({ message: 'Do you want to proceed anyway?', default: false });
  if (!proceed) { console.error('psu: aborted.'); process.exit(0); }
}

/** Sentinel for the "type a different model" resume-prompt row. */
const CHOOSE_MODEL = '<choose-model>';
/** Sentinel for the "type a custom spec" escape inside the base-model menu (WI-4889). */
const CUSTOM_MODEL = '<custom-model>';

/**
 * WI-4889 (owner directive 2026-07-14): the resume "choose a different model"
 * path is a MENU, not a free-text `<model>[:<effort>]` prompt. Two selects —
 * base model, then reasoning effort — with a "type a custom spec…" escape that
 * keeps the old open-set free-text path. The menu mirrors the launcher's OWN
 * recognized aliases so it never drifts from what validateModelSpec accepts:
 * KNOWN_CLOUD_ALIASES (opus/sonnet/haiku/fable → Anthropic) + the
 * cloudModelBackendHint codex families (luna/terra/sol → OpenAI/codex).
 *
 * WI-4891 (owner directive 2026-07-14): each row carries its `backend` because a
 * `psu --resume` is HARD-BOUND to session.agent — resumeArgsFor(session,{model})
 * branches on the session's native CLI, and a claude transcript is not resumable
 * by codex (nor vice-versa). Offering a codex model on a claude resume just made
 * `claude -m sol` (a broken launch). resumeModelMenuFor(agent) below filters the
 * rows to the models the session's backend can ACTUALLY launch.
 */
export const RESUME_MODEL_MENU = [
  { name: 'opus — Anthropic Claude Opus (1M, strongest)', value: 'opus', backend: 'claude' },
  { name: 'sonnet — Anthropic Claude Sonnet (1M, balanced)', value: 'sonnet', backend: 'claude' },
  { name: 'fable — Anthropic Claude Fable (1M)', value: 'fable', backend: 'claude' },
  { name: 'haiku — Anthropic Claude Haiku (fast, cheap)', value: 'haiku', backend: 'claude' },
  { name: 'sol — OpenAI GPT-5.6 “Sol” (codex)', value: 'sol', backend: 'codex' },
  { name: 'luna — OpenAI “Luna” (codex)', value: 'luna', backend: 'codex' },
  { name: 'terra — OpenAI “Terra” (codex)', value: 'terra', backend: 'codex' },
];

/** WI-4891: the base-model rows a resume of `agent` may offer — ONLY models that
 *  backend can launch (a resume can't switch backend). claude → the claude
 *  family; codex → the codex family; omp is model-agnostic with an open,
 *  config-driven vocabulary (not the claude/codex CLI aliases) → [] so the caller
 *  falls through to the free-text spec instead of offering a guessed alias. The
 *  `backend` tag on each row is the single source of truth, so a new row can
 *  never leak across backends. Rows are stripped to the inquirer {name,value}
 *  shape. */
export function resumeModelMenuFor(agent) {
  const rows =
    agent === 'claude'
      ? RESUME_MODEL_MENU.filter((m) => m.backend === 'claude')
      : agent === 'codex'
        ? RESUME_MODEL_MENU.filter((m) => m.backend === 'codex')
        : [];
  return rows.map((m) => ({ name: m.name, value: m.value }));
}

/** Reasoning-effort choices for the resume model menu. Values ⊆ the efforts
 *  validateModelSpec / the `:<effort>` suffix accept; '' = no suffix (model default). */
export const RESUME_EFFORT_MENU = [
  { name: 'default (model default — no effort suffix)', value: '' },
  { name: 'low', value: 'low' },
  { name: 'medium', value: 'medium' },
  { name: 'high', value: 'high' },
  { name: 'xhigh', value: 'xhigh' },
  { name: 'max (strongest reasoning)', value: 'max' },
];

/** PURE (exported for tests): compose a base model + optional effort into a
 *  normalized psu model spec. Empty/blank model → null (agent default); a blank
 *  effort drops the `:<effort>` suffix. normalizeModelSpec adds `[1m]` for the
 *  default-1M families (opus/sonnet/fable) before the effort suffix. */
export function composeResumeModelSpec(model, effort) {
  const m = String(model ?? '').trim();
  if (!m) return null;
  const e = String(effort ?? '').trim();
  return normalizeModelSpec(e ? `${m}:${e}` : m);
}

/** Content-free lineage shown in the resume picker for ported target sessions. */
export function resumeSessionLineageLabel(session) {
  if (session?.portSourceAdvSessionId == null || !Number.isSafeInteger(Number(session.portSourceAdvSessionId))) return null;
  const status = typeof session?.portStatus === 'string' && session.portStatus
    ? session.portStatus
    : 'delivered';
  return `ported from #${Number(session.portSourceAdvSessionId)}${status === 'delivered' ? '' : ` (${status})`}`;
}

export const SESSION_PORT_PROTOCOL_VERSION = 1;
export const SESSION_PORT_TRANSFORM_VERSION = 1;

export function sessionPortUpgradeError(error) {
  const status = Number(error?.status ?? 0);
  const message = String(error?.message ?? error ?? '');
  if (status === 404 || status === 426 || /protocol|transform|migration 611|session_ports|upgrade/i.test(message)) {
    return new Error(
      `psu: cross-backend session port is unavailable because the launcher/operator protocol is out of sync (${message}). ` +
        `Upgrade the staging psu launcher and serving operator together, apply migration 611, then retry.`,
    );
  }
  return error instanceof Error ? error : new Error(message);
}

async function sessionPortApi(path, opts) {
  try {
    return await api(path, opts);
  } catch (error) {
    throw sessionPortUpgradeError(error);
  }
}

function providerForResumeTarget(agent) {
  if (agent === 'claude') return 'anthropic';
  if (agent === 'codex') return 'openai';
  return 'omp-configured-provider';
}

/** Resolve the backend before account selection. Same-backend selections keep
 * the byte-identical native resume/fork path; a tracked plain Claude source may
 * instead create a fresh Codex/OMP session through protocol v1. */
export function resolveResumeTarget(session, args = {}, selected = {}) {
  const sourceAgent = session?.agent;
  if (!AGENTS.includes(sourceAgent)) throw new Error(`unsupported source backend ${String(sourceAgent)}`);
  const requestedModelSpec = selected.modelSpec ?? args.model ?? null;
  const hinted = requestedModelSpec ? cloudModelBackendHint(requestedModelSpec) : null;
  const targetAgent = selected.targetAgent ?? args.agent ?? hinted ?? sourceAgent;
  if (!AGENTS.includes(targetAgent)) throw new Error(`--agent must be one of ${AGENTS.join('|')}`);
  const modelSpec = normalizeModelSpecForAgent(targetAgent, requestedModelSpec);
  const pair = validateAgentModelPair(targetAgent, modelSpec);
  if (!pair.ok) throw new Error(pair.message);
  const operation = targetAgent === sourceAgent ? 'native' : 'port';
  if (operation === 'port') {
    if (args.fork) throw new Error('--fork is a native same-backend operation and cannot be combined with a session port');
    if (sourceAgent !== 'claude' || (targetAgent !== 'codex' && targetAgent !== 'omp')) {
      throw new Error(`session-port protocol v1 supports tracked plain Claude → Codex/OMP only (got ${sourceAgent} → ${targetAgent})`);
    }
  }
  return {
    operation,
    sourceAgent,
    targetAgent,
    provider: providerForResumeTarget(targetAgent),
    modelSpec,
  };
}

export function sessionPortTargetAccount(account) {
  if (account?.forward === 'auto' || account?.auto === true) return 'auto';
  if (account?.id) return account.id;
  return 'default';
}

export function sessionPortRequestBody(source, target, account, args = {}) {
  if (!Number.isSafeInteger(Number(source?.id)) || Number(source.id) <= 0) {
    throw new Error('cross-backend resume requires a tracked source adv session id');
  }
  return {
    protocolVersion: SESSION_PORT_PROTOCOL_VERSION,
    transformVersion: SESSION_PORT_TRANSFORM_VERSION,
    workspace: source.workspaceId,
    sourceAdvSessionId: Number(source.id),
    targetBackend: target.targetAgent,
    targetModel: target.modelSpec,
    targetAccount: sessionPortTargetAccount(account),
    contextSize: args.contextSize ?? null,
    launchContext: args.launchContext ?? null,
  };
}

export function formatSessionPortInspection(result) {
  const i = result?.inspection;
  if (!i) return ['psu: session-port inspection unavailable'];
  const s = i.stats ?? {};
  return [
    `psu: cross-backend port preview — Claude session #${i.source?.advSessionId} → ${i.target?.backend}/${i.target?.model ?? 'default'}`,
    `psu: source snapshot — ${i.source?.snapshotKind}, ${i.source?.completeBytes ?? '?'} bytes, sha256 ${String(i.source?.sha256 ?? '').slice(0, 12)}…`,
    `psu: fidelity — ${i.requiresSummary ? 'summary + recent tail (target budget requires summarization)' : 'full active-path history'}; estimated ${i.fullHistoryEstimatedTokens ?? '?'} tokens / ${i.target?.availableInputTokens ?? '?'} available`,
    `psu: sanitization — ${s.redactions ?? 0} secret redaction(s), ${s.omittedAttachments ?? 0} attachment omission(s), ${s.unsupportedBlocks ?? 0} unsupported block(s), ${s.sidechainRecords ?? 0} sidechain record(s) excluded`,
    `psu: egress — target ${i.disclosure?.targetEgress ?? 'unknown'}${i.disclosure?.summarizerEgress ? `; summarizer ${i.disclosure.summarizerEgress}` : '; no summarizer egress'}`,
    'psu: boundary — creates a NEW target session; source stays untouched; fleet/loop/claims/AUTO/DRAIN authority is not carried.',
    ...(Array.isArray(i.warnings) ? i.warnings.map((w) => `psu: source warning — ${w}`) : []),
  ];
}

/**
 * WI-3758 (owner directive 2026-07-10): a resume SHOWS the session's
 * last-active model and lets you pick the one to resume with. Returns the psu
 * model spec to thread into resumeArgsFor, or null for the agent default (no
 * flag — the pre-WI-3758 behavior).
 *
 *   - `--model=<spec>` (already validated + normalized by parseArgs) wins —
 *     no prompt, like every other resume flag.
 *   - interactive (the default) → announce the last-active model + a select:
 *     keep it (an EXPLICIT flag — CLI flags don't persist into resumes, so
 *     "keep" must re-pass it) / agent default / type a different spec
 *     (validateModelSpec-checked, same guard as parseArgs' --model).
 *   - `--no-picker` scripting → no prompt, announce only (mirrors
 *     chooseResumeAccount's no-prompt gating) — agent default, exactly the old
 *     behavior.
 */
async function chooseResumeTarget(session, args) {
  let last = null;
  try {
    last = lastActiveModelFor(session);
  } catch { /* a transcript we can't read only costs the announce */ }
  if (last) console.error(`psu: last active model in this session: ${last}`);
  // Explicit CLI selections are a complete scripted target. Cloud aliases can
  // infer Claude vs Codex; OMP remains explicit (`--agent=omp`) because its
  // model vocabulary is intentionally open/config-driven.
  if (args.model || args.agent || !args.picker) return resolveResumeTarget(session, args);
  const { select, input } = await import('@inquirer/prompts');
  const picked = await select({
    message: 'Continue this session with which backend/model?',
    choices: [
      ...(last ? [{ name: `Native ${session.agent}: keep last active — ${last}`, value: { targetAgent: session.agent, modelSpec: last } }] : []),
      { name: `Native ${session.agent}: backend default (no model flag)`, value: { targetAgent: session.agent, modelSpec: null } },
      { name: 'Choose a different model…', value: CHOOSE_MODEL },
    ],
  });
  if (picked !== CHOOSE_MODEL) return resolveResumeTarget(session, args, picked);

  const allowedBackends = session.agent === 'claude' ? AGENTS : [session.agent];
  const askCustomSpec = async (targetAgent) => {
    const typed = await input({
      message: `${targetAgent} model spec (<model>[:<effort>]; empty = backend default):`,
      validate: (v) => {
        const s = String(v ?? '').trim();
        if (!s) return true;
        const r = validateModelSpec(s);
        if (!r.ok) return r.message;
        return validateAgentModelPair(targetAgent, s).ok || validateAgentModelPair(targetAgent, s).message;
      },
    });
    const spec = String(typed ?? '').trim();
    return resolveResumeTarget(session, args, {
      targetAgent,
      modelSpec: spec || null,
    });
  };

  const menu = RESUME_MODEL_MENU
    .filter((row) => allowedBackends.includes(row.backend))
    .map((row) => ({
      name: `${row.backend === session.agent ? 'Native' : 'Port to'} ${row.backend}: ${row.name}`,
      value: { targetAgent: row.backend, model: row.value },
    }));
  const baseModel = await select({
    message: 'Target backend and base model',
    choices: [
      ...menu,
      ...(allowedBackends.includes('omp') ? [{ name: `${session.agent === 'omp' ? 'Native' : 'Port to'} omp: configured/custom model…`, value: { targetAgent: 'omp', model: CUSTOM_MODEL } }] : []),
      { name: 'Type a custom model id / full spec…', value: CUSTOM_MODEL },
    ],
  });
  if (baseModel === CUSTOM_MODEL) {
    const targetAgent = allowedBackends.length === 1
      ? allowedBackends[0]
      : await select({
          message: 'Target backend',
          choices: allowedBackends.map((agent) => ({ name: agent, value: agent })),
        });
    return askCustomSpec(targetAgent);
  }
  if (baseModel.model === CUSTOM_MODEL) return askCustomSpec(baseModel.targetAgent);
  const effort = await select({
    message: 'Reasoning effort',
    default: '',
    choices: RESUME_EFFORT_MENU,
  });
  return resolveResumeTarget(session, args, {
    targetAgent: baseModel.targetAgent,
    modelSpec: composeResumeModelSpec(baseModel.model, effort),
  });
}

/** WI-3859 F4: the archive-at-death lifecycle DELETES an ended session's
 *  transcript ~15s after end (it lives on in harness_shared.session_archives).
 *  The wake-executor rematerializes on ITS resume path, but a direct
 *  `psu --resume` reads the disk — so on a transcript miss, ask the operator
 *  to restore the files from the archive, then retry the disk lookup. Returns
 *  the API result or null; never throws (a miss just falls through to the
 *  existing not-found error, incl. against an older operator without the
 *  endpoint). EI-9756 regression guard: injectable `fetchImpl`/`operatorUrl`/
 *  `token` (mirrors reportSessionResumed) so this — previously untested — is
 *  unit-testable without a live operator; a real caller always hits the real
 *  operator via the defaults. */
export async function tryRematerializeFromArchive(
  sessionId,
  sourceKind = null,
  {
    fetchImpl = fetch,
    operatorUrl = OPERATOR_URL,
    token = null,
    timeoutMs = 10_000,
    statusTimeoutMs = 2_000,
    statusAttempts = 3,
    statusDelayMs = 150,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  } = {},
) {
  if (!sessionId) return null;
  try {
    const tok = token ?? readToken();
    const res = await fetchImpl(operatorUrl + '/api/adv/sessions/rematerialize', {
      method: 'POST',
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        'content-type': 'application/json',
        ...(tok ? { authorization: `Bearer ${tok}` } : {}),
      },
      body: JSON.stringify({ sessionId, ...(sourceKind ? { sourceKind } : {}) }),
    });
    const r = await res.json().catch(() => null);
    if (!r?.ok) return null;
    console.error(
      `psu: transcript restored from the session archive (${r.sourceKind}, ${r.written} file(s) → ${r.root}).`,
    );
    return r;
  } catch (error) {
    // AbortSignal.timeout only cancels the client request. The synchronous
    // operator handler can still be decompressing/writing a large archive.
    if (!isArchiveRequestTimeout(error)) return null;
    const status = await pollArchiveRematerializeStatus(sessionId, sourceKind, {
      fetchImpl, operatorUrl, token, timeoutMs: statusTimeoutMs,
      attempts: statusAttempts, delayMs: statusDelayMs, sleep,
    });
    if (status?.ready) {
      const restored = {
        ...status,
        ok: true,
        sourceKind: status.sourceKind || sourceKind,
        written: status.written ?? 0,
        restoredAfterTimeout: true,
      };
      console.error(
        `psu: transcript restored from the session archive (${restored.sourceKind}, ${restored.written} file(s) → ${restored.root ?? 'session store'}).`,
      );
      return restored;
    }
    return {
      ok: false,
      pending: true,
      timedOut: true,
      reason: 'in_flight',
      sessionId,
      sourceKind: sourceKind || status?.sourceKind || null,
      archiveStatus: status,
    };
  }
}

function isArchiveRequestTimeout(error) {
  const name = String(error?.name || '').toLowerCase();
  const message = String(error?.message || '').toLowerCase();
  return name === 'timeouterror' || name === 'aborterror' || message.includes('timeout') || message.includes('aborted');
}

async function pollArchiveRematerializeStatus(
  sessionId,
  sourceKind,
  { fetchImpl, operatorUrl, token, timeoutMs, attempts, delayMs, sleep },
) {
  const query = new URLSearchParams({ sessionId });
  if (sourceKind) query.set('sourceKind', sourceKind);
  const url = `${operatorUrl}/api/adv/sessions/rematerialize/status?${query.toString()}`;
  let last = null;
  const count = Math.max(1, Math.min(5, Number(attempts) || 1));
  for (let attempt = 0; attempt < count; attempt++) {
    try {
      const tok = token ?? readToken();
      const res = await fetchImpl(url, {
        method: 'GET',
        signal: AbortSignal.timeout(timeoutMs),
        headers: { ...(tok ? { authorization: `Bearer ${tok}` } : {}) },
      });
      const body = await res.json().catch(() => null);
      if (body) {
        last = body;
        if (body.ready || body.state !== 'pending') return body;
      }
    } catch {
      // An unavailable/older status endpoint is still an UNKNOWN timeout
      // outcome; the caller must keep the safe pending result.
    }
    if (attempt + 1 < count) await sleep(Math.max(0, Number(delayMs) || 0));
  }
  return last;
}

/**
 * Re-verify — and if necessary RESTORE — a resume's transcript in the last
 * moment before exec. This closes the owner-hit race of 2026-08-12: `psu
 * --resume <id>` printed "resuming from its per-session CLAUDE_CONFIG_DIR" and
 * then died on `No conversation found with session ID: …`.
 *
 * Both resume paths resolve the session — and check that its transcript is on
 * disk — BEFORE prompting for backend/model and then account. Those prompts are
 * HUMAN-paced, while archive-at-death deletes an ended session's transcript on a
 * fixed 15s timer (SETTLE_DELAY_MS, session-archive-hook.ts). So resuming a
 * JUST-ENDED session — precisely what claude's own exit message tells you to do
 * ("Resume this session with: claude --resume <id>") — lands inside that window:
 * the existence check passes, the timer fires while the user is answering the
 * prompts, and psu execs an id that can no longer resolve. Measured on adv 15148:
 * archived + deleted 13:03:42.406, launched 13:03:55.438, 13s apart.
 *
 * The bytes are never lost — archive-at-death PUTS them in the DB session archive
 * before deleting — so the fix is to look again AFTER the prompts and
 * rematerialize when the file has gone. Returns true when there is something to
 * resume, false when there genuinely is not (the caller must then refuse to
 * launch rather than hand the agent an id that cannot resolve).
 *
 * Only claude/codex have an id-addressable on-disk transcript; omp resumes by
 * thread name and is passed through unchanged. Injectable `home`/`rematerialize`
 * for tests; never throws.
 */
export async function ensureResumeTranscriptPresent(
  source,
  { home = homedir(), rematerialize = tryRematerializeFromArchive } = {},
) {
  if (!source || (source.agent !== 'claude' && source.agent !== 'codex')) return true;
  if (sessionHasTranscript(source, { home })) return true;
  const restored = await rematerialize(source.sessionId || source.ompThreadId, source.agent);
  if (restored?.pending) return restored;
  return Boolean(restored) && sessionHasTranscript(source, { home });
}

/**
 * Is a claude session's isolated `CLAUDE_CONFIG_DIR` LAUNCH-READY, or merely
 * transcript-bearing? The .mjs mirror of operator-core's
 * `isInteractiveClaudeConfigReady` — duplicated for the same reason
 * `rehealResumeCredentials` duplicates the credential reconciler: this script
 * runs as plain node outside the operator-core TS package (see the file-top note
 * on this module's dependency surface). Keep the two in sync; the REPAIR itself
 * is not duplicated — that stays server-side behind /adv/sessions/
 * ensure-claude-config, so the symlink mirror has exactly one implementation.
 *
 * `.claude.json` is the tell: a symlink ⇒ the mirror linked the user's real
 * config in; a real file with `mcpServers` ⇒ a P-020 pruned fleet copy; a real
 * file WITHOUT ⇒ the stub claude minted for itself in a first-run boot (an
 * account, but no MCP + no hooks); absent ⇒ a bee/rematerialized dir. Pure —
 * exported for tests; never throws.
 */
export function isClaudeConfigDirLaunchReady(configDir) {
  try {
    if (!configDir) return false;
    const path = join(configDir, '.claude.json');
    const entry = lstatSync(path); // throws when absent
    // Read THROUGH the link: a DANGLING symlink still lstats as a symlink but
    // gives claude nothing — the same wizard by a different door.
    const cfg = JSON.parse(readFileSync(path, 'utf8'));
    if (!cfg || typeof cfg !== 'object') return false;
    return entry.isSymbolicLink() || cfg.mcpServers != null;
  } catch {
    return false;
  }
}

/**
 * EI-12938 (owner-hit 2026-07-16, "psu --resume STILL prompted me to login"):
 * ask the operator to re-materialize this session's interactive config dir when
 * it is not launch-ready.
 *
 * A fresh launch's dir is built server-side by the bootstrap-su POST; a resume
 * does no POST, so a dir that came from the ARCHIVE (transcript only) or from
 * `writeSpawnClaudeConfig` (a plan-run/bee's creds-symlink-only dir) has no
 * `.claude.json` — and that, not the credential symlink `rehealResumeCredentials`
 * fixes, is what claude reads to decide it is signed in. Result: an interactive
 * resume boots the first-run wizard (/login), mints a stub config, and the
 * SECOND attempt "works" while silently running with no MCP servers and no lock
 * hooks on a shared tree.
 *
 * Local ready-check FIRST so the normal (healthy-dir) resume pays no round-trip
 * — only a genuinely degraded dir calls out. Fail-soft: an unreachable/older
 * operator (404) leaves the launch exactly as it is today. Returns the API
 * result or null; never throws. Injectable `fetchImpl`/`operatorUrl`/`token`
 * mirror tryRematerializeFromArchive so this is unit-testable without a live
 * operator.
 */
export async function ensureInteractiveConfigViaOperator(
  owner,
  configDir,
  { fetchImpl = fetch, operatorUrl = OPERATOR_URL, token = null, timeoutMs = 10_000 } = {},
) {
  if (!owner) return null; // untracked/pre-EI-155 session — no owner keys its dir
  // The server keys the dir by OWNER, so it can only ensure the conventional
  // per-owner path. A session resumed from a relocated/foreign configDir would
  // otherwise have a DIFFERENT dir materialized behind its back while the one it
  // actually launches with stays broken. Same guard the rematerialize route uses.
  if (configDir !== sessionClaudeConfigDir(owner)) return null;
  if (isClaudeConfigDirLaunchReady(configDir)) return null; // healthy — byte-identical, no call
  try {
    const tok = token ?? readToken();
    const res = await fetchImpl(operatorUrl + '/api/adv/sessions/ensure-claude-config', {
      method: 'POST',
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        'content-type': 'application/json',
        ...(tok ? { authorization: `Bearer ${tok}` } : {}),
      },
      body: JSON.stringify({ owner }),
    });
    const r = await res.json().catch(() => null);
    if (!r?.ok) return null;
    if (r.repaired) {
      console.error(
        'psu: repaired this session\'s claude config dir (it carried a transcript but no account/MCP state — a resume would have hit the first-run login screen).',
      );
    }
    return r;
  } catch {
    return null;
  }
}

/**
 * Is this per-session CODEX_HOME launch-ready — the codex twin of
 * `isClaudeConfigDirLaunchReady`?
 *
 * `config.toml` IS the codex home: the superuser MCP server + its baked bearer,
 * the approvals/sandbox bypass, `[features] remote_compaction_v2 = false`, and
 * the `[model_providers.papercusp-codex-gateway]` table every gateway-born
 * thread resolves at resume. `[mcp_servers.papercusp-su]` is the marker because
 * it is the part codex itself will never write back: after the file goes
 * missing, codex re-creates an 87-byte trust-only stub on the next launch, which
 * LOOKS like a config and carries none of the above — the resume then either
 * dies on the missing provider or, worse, comes up quietly with no coordination
 * MCP at all. Presence of the MCP block distinguishes ours from that stub.
 */
export function isCodexHomeLaunchReady(codexHome) {
  try {
    if (!codexHome) return false;
    const text = readFileSync(join(codexHome, 'config.toml'), 'utf8'); // throws when absent
    return text.includes('[mcp_servers.papercusp-su]');
  } catch {
    return false;
  }
}

/**
 * WI-38706 — the codex twin of `ensureInteractiveConfigViaOperator`, and for the
 * same structural reason: a FRESH psu launch has its CODEX_HOME materialized
 * server-side by bootstrap-su (`writeSuCodexHome`), while a RESUME does no
 * bootstrap POST. The launcher cannot rebuild the home itself — psu-launcher.mjs
 * is plain node outside operator-core, so it can neither sign the MCP url nor
 * import the writer.
 *
 * Until now the resume leg simply ASSUMED the home was intact. It often wasn't:
 * the session archiver was unlinking the home's `config.toml` (it archived
 * directory-shared state under one thread's session id — fixed in
 * session-archive.ts), and the launcher's own gateway patch would then write a
 * gateway-less config into the hole. Owner-hit 2026-08-14: 11 homes, 89
 * rollouts, all failing `thread/resume` on the missing provider.
 *
 * Idempotent and non-destructive: a healthy home is left byte-identical and the
 * call reports `repaired: false`.
 */
export async function ensureCodexHomeViaOperator(
  owner,
  codexHome,
  advSessionId,
  { requireGatewayProvider = false, fetchImpl = fetch, operatorUrl = OPERATOR_URL, token = null, timeoutMs = 10_000 } = {},
) {
  if (!owner || !codexHome || advSessionId == null) return null;
  // The server keys the home by ADV SESSION ID, so it can only ensure the
  // conventional path. A resume pointed at a relocated/foreign home would
  // otherwise have a DIFFERENT home rebuilt behind its back while the one it
  // actually launches with stays broken (the same guard the claude twin uses).
  if (codexHome !== join(homedir(), '.papercusp', 'su-codex-homes', `session-${advSessionId}`)) return null;
  if (isCodexHomeLaunchReady(codexHome)) return null; // healthy — no call, no write
  try {
    const tok = token ?? readToken();
    const res = await fetchImpl(operatorUrl + '/api/adv/sessions/ensure-codex-home', {
      method: 'POST',
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        'content-type': 'application/json',
        ...(tok ? { authorization: `Bearer ${tok}` } : {}),
      },
      body: JSON.stringify({ owner, advSessionId, requireGatewayProvider }),
    });
    const r = await res.json().catch(() => null);
    if (!r?.ok) return null;
    if (r.repaired) {
      console.error(
        'psu: rebuilt this session\'s codex home config (it carried rollouts but no MCP/provider state — the resume would have failed on a missing model provider, or come up with no coordination MCP).',
      );
    }
    return r;
  } catch {
    return null;
  }
}

async function launchSessionPort(source, target, account, args) {
  if (source.role != null) throw new Error('session-port protocol v1 requires a plain tracked SU source');
  const request = sessionPortRequestBody(source, target, account, args);
  const inspected = await sessionPortApi('/api/adv/sessions/port/inspect', {
    method: 'POST',
    body: JSON.stringify(request),
  });
  for (const line of formatSessionPortInspection(inspected)) console.error(line);
  if (args.picker && !args.yes) {
    const { confirm } = await import('@inquirer/prompts');
    const proceed = await confirm({
      message: `Prepare this sanitized history and launch a new ${target.targetAgent} session?`,
      default: false,
    });
    if (!proceed) {
      console.error('psu: session port cancelled before egress; no artifact or target session was created.');
      return;
    }
  }
  const prepared = await sessionPortApi('/api/adv/sessions/port/prepare', {
    method: 'POST',
    body: JSON.stringify({
      ...request,
      expectedSourceHash: inspected.inspection.source.sha256,
      currentInstruction: resumeKickoffText(args),
    }),
  });
  console.error(
    `psu: prepared session port ${prepared.portId} (${prepared.fidelity}; expires ${prepared.expiresAt}) — launching fresh target.`,
  );
  const targetArgs = {
    ...args,
    picker: false,
    resume: false,
    resumeId: null,
    fork: false,
    agent: target.targetAgent,
    model: target.modelSpec,
    account: sessionPortTargetAccount(account),
    fleet: null,
    fleetRole: null,
    fleetName: null,
    fleetScheme: null,
    seat: null,
    auto: false,
    mode: null,
    profile: 'engineer',
    launchContext: args.launchContext ?? null,
    launchedBy: null,
    resumeSession: null,
    sessionPortProtocol: SESSION_PORT_PROTOCOL_VERSION,
    sessionPortTransformVersion: SESSION_PORT_TRANSFORM_VERSION,
    sessionPortToken: prepared.token,
    sessionPortSourceAdvSessionId: Number(source.id),
    sessionPortSourceCwd: source.cwd,
  };
  await launchFreshSu({
    agent: target.targetAgent,
    workspace: source.workspaceId,
    harness: null,
    plan: source.planSlug ?? null,
  }, targetArgs);
}

async function launchResolvedResume(source, args, { tracked }) {
  // Backend/model first, account second. Account choices are provider-scoped;
  // prompting before the target is known is how cross-backend resumes get
  // silently pinned to the source provider.
  const target = await chooseResumeTarget(source, args);
  if (target.operation === 'port' && !tracked) {
    throw new Error('cross-backend resume requires a psu-tracked source session; raw native sessions can only resume/fork in place');
  }
  if (target.operation === 'port' && !(await ensureBackendInstalled(target.targetAgent))) {
    process.exitCode = 1;
    return;
  }
  const account = await chooseResumeAccount(
    { ...source, agent: target.targetAgent },
    { ...args, model: target.modelSpec },
  );
  if (target.operation === 'port') {
    await launchSessionPort(source, target, account, args);
    return;
  }
  // LAST-MOMENT transcript re-verify. Everything below resumes IN PLACE against
  // the session's own on-disk transcript, and that transcript was last checked
  // BEFORE the two human-paced prompts above — long enough for the 15s
  // archive-at-death timer to have deleted it out from under us. Look again, and
  // restore from the archive if it has gone. (A cross-backend PORT returned
  // above: it rebuilds context server-side and owns no on-disk transcript.)
  const transcriptReady = await ensureResumeTranscriptPresent(source);
  if (transcriptReady?.pending) {
    console.error(
      `psu: archive restore for ${source.sessionId ?? source.ompThreadId ?? ''} is still in progress; ` +
        'the operator timed out while writing its transcript. Retry in a few seconds.',
    );
    process.exitCode = 1;
    return;
  }
  if (!transcriptReady) {
    console.error(
      `psu: session ${source.sessionId ?? source.ompThreadId ?? ''} has no transcript on disk and no copy in ` +
        `the session archive to restore — there is nothing to resume. If it ended moments ago its transcript may ` +
        `still be archiving; retry in a few seconds, or pick another session with \`psu --resume\`.`,
    );
    process.exitCode = 1;
    return;
  }
  if (args.fork && tracked) {
    await launchTrackedFork(source, args, account, target.modelSpec);
    return;
  }
  await launchResume(source, {
    fork: args.fork,
    passthrough: args.passthrough,
    addDir: args.addDir,
    accountEnv: account,
    allowSubagents: args.allowSubagents,
    model: target.modelSpec,
    kickoff: resumeKickoffText(args),
  });
}

// `psu --resume` (picker) or `psu --resume=<id>` / `psu --resume <id>`
// (direct): resume a tracked session by adv id, recorded native session id,
// linked OMP thread id, or Codex rollout UUID under a tracked CODEX_HOME. If
// none match, fall back to an unmatched session by the agent's native store id.
// Either way, cd to the recorded cwd and run the agent there.
async function resumeFlow(args = {}) {
  const data = await api('/api/adv/sessions/resumable');
  const sessions = (data.sessions || []).filter((s) => s.agent && s.cwd);

  // Direct resume by id — skip the picker.
  if (args.resumeId) {
    // 1. A psu-tracked session (adv_sessions row)? Match the integer adv id,
    //    the agent's recorded NATIVE session id (claude), linked native thread
    //    id (OMP), or discovered rollout UUID in the tracked CODEX_HOME
    //    (Codex). Resuming by any handle finds the tracked row with NO false
    //    "not started by psu" warning.
    const tracked = resolveTrackedResumeSession(sessions, args.resumeId);
    if (tracked) {
      // A tracked row alone doesn't prove resumability — a launch that died
      // (or was closed) before its first persisted message has NO transcript,
      // and the raw `--resume` would fail "No conversation found". But an
      // ENDED session's transcript may simply be archived (archive-at-death
      // deletes it from disk ~15s after end) — restore it and retry before
      // declaring it unresumable.
      if (!sessionHasTranscript(tracked)) {
        const restored = await tryRematerializeFromArchive(
          tracked.sessionId || tracked.ompThreadId,
          tracked.agent,
        );
        if (restored?.pending) {
          console.error(
            `psu: session #${tracked.id} archive restore is still in progress; the operator timed out while ` +
              `writing its transcript. Retry psu --resume=${args.resumeId} in a few seconds.`,
          );
          process.exit(1);
        }
        if (!restored || !sessionHasTranscript(tracked)) {
          console.error(
            `psu: session #${tracked.id} (${tracked.agent}${tracked.sessionId ? ` ${tracked.sessionId}` : ''}) ` +
              `has no persisted transcript — it died or was closed before its first message (and the session ` +
              `archive holds no copy), so there is no conversation to resume. Pick a different session with \`psu --resume\`.`,
          );
          process.exit(1);
        }
      }
      await launchResolvedResume(tracked, args, { tracked: true });
      return;
    }

    // 2. Not tracked → search the agents' OWN session stores for the id. On a
    //    miss, the transcript may be ARCHIVED (deleted from disk at session
    //    end) — restore it from the session archive and search again.
    let untracked = findUntrackedSession(args.resumeId);
    if (!untracked) {
      const restored = await tryRematerializeFromArchive(args.resumeId);
      if (restored?.pending) {
        console.error(
          `psu: session archive restore for ${args.resumeId} is still in progress; the operator timed out while ` +
            'writing its transcript. Retry in a few seconds.',
        );
        process.exit(1);
      }
      if (restored) untracked = findUntrackedSession(args.resumeId);
    }
    if (!untracked) {
      const ids = sessions.map((s) => s.id).filter((x) => x != null).join(', ');
      console.error(
        `psu: no session "${args.resumeId}" — not a tracked psu session (ids: ${ids || 'none'}), ` +
          `no claude/codex session file with that id under ~/.claude/projects, per-session config dirs, ` +
          `tracked CODEX_HOME dirs, or ~/.codex/sessions, and no session-archive copy to restore ` +
          `(omp threads resume by thread name).`,
      );
      process.exit(1);
    }

    // 3. Untracked ≠ identity-less: the psu-session-owners index may still hold
    //    the coord ownerId this session was BORN with (recorded at every psu
    //    launch). Recover it so resumeEnvFor re-attaches the session's real
    //    identity — fleet leadership, file locks, presence, pty-host discovery —
    //    instead of minting a fresh SID and orphaning all four (the 2026-07-02
    //    identity-split bug). A fork still mints (resumeEnvFor's fork branch).
    const bornOwnerId = recoverSessionOwner(untracked.sessionId || untracked.ompThreadId);
    if (bornOwnerId) untracked.coordOwnerId = bornOwnerId;

    // 4. Untracked = NOT launched by psu → its engineer playbook (and, for codex,
    //    the papercusp-su tools) are NOT loaded. Require an explicit confirm.
    //    EXCEPT a psuTracked hit — su-codex-homes (WI-3884) or the claude
    //    per-owner isolation dir (EI-9756): that session WAS psu-launched —
    //    only older than the resumable window — and its per-session store
    //    (CODEX_HOME / CLAUDE_CONFIG_DIR) carries the baked config, so nothing
    //    is lost on resume; no confirm, and no "not a tracked psu launch" scare.
    if (untracked.psuTracked) {
      const store = untracked.agent === 'codex' ? 'CODEX_HOME' : 'CLAUDE_CONFIG_DIR';
      console.error(
        `psu: session ${untracked.sessionId} is a psu-launched ${untracked.agent} session${untracked.id != null ? ` (tracked #${untracked.id})` : ''} — ` +
          `older than the recent-session window; resuming from its per-session ${store}.`,
      );
    } else {
      await confirmUntrackedResume(untracked, args);
    }
    // An untracked session has no adv row to seed a tracked fork from — fork it in
    // place (claude mints a random id; resumable only by uuid). launchResume handles it.
    // Account re-pin applies here too (a raw resume can be routed through the
    // gateway), but raw sessions remain same-backend: V1 ports require tracked
    // workspace/source identity and server-side authority checks.
    await launchResolvedResume(untracked, args, { tracked: false });
    return;
  }

  // Only offer sessions that are actually resumable — an on-disk transcript OR a
  // DB session-archive (server-stamped `hasArchive`). An ended session's on-disk
  // transcript is deleted ~15s after death, so a resumable session may live ONLY
  // in the archive; the on-disk-only test used to hide every such session as a
  // ghost (owner-hit 2026-07-13: "hiding N session(s) with no persisted transcript"
  // after sessions moved off disk to the DB). A row with NEITHER is a true ghost
  // (recorded at launch, never persisted a first message → "No conversation found"
  // on every attempt). Say how many were hidden so "where did my session go?" has
  // an answer. An archived pick is rematerialized to disk on selection below.
  const resumable = sessions.filter((s) => sessionIsResumable(s));
  const ghostCount = sessions.length - resumable.length;
  if (ghostCount > 0) {
    console.error(
      `psu: hiding ${ghostCount} session(s) with no persisted transcript (died or closed before the first message) — they cannot be resumed.`,
    );
  }
  if (resumable.length === 0) {
    console.error('psu: no resumable sessions — launch one with `psu`, or resume a raw session by id with `psu --resume=<session-id>`.');
    process.exit(1);
  }
  const { search } = await import('@inquirer/prompts');
  const rows = resumable.map((s) => {
    // Surface each session's last-active model in its row (WI-3758) — a cheap
    // tail read per row; unknown (omp / unreadable) rows just omit the segment.
    let lastModel = null;
    try { lastModel = lastActiveModelFor(s); } catch { /* row stays model-less */ }
    const lineage = resumeSessionLineageLabel(s);
    // The age shown is LAST-ACTIVE, not started (WI-38226). `startedAt` is bumped to now() by
    // every reactivation, so it reads as "3m ago" for a session that resumed and then sat idle,
    // while a session that has been working for hours reads as the oldest thing in the list —
    // exactly inverted from what someone scanning for "the one I was just in" needs. The server
    // orders by the same key it hands back here, so the ages now descend down the list.
    return {
      name:
        `${s.id != null ? `#${s.id}  ·  ` : ''}${s.agent}${lastModel ? ` (${lastModel})` : ''}  ·  ${s.planSlug ? `plan ${s.planSlug}` : 'no plan'}  ·  ${s.cwd}  ·  ${fmtAge(s.lastActiveAt || s.startedAt)}` +
        `${lineage ? `  · ${lineage}` : ''}${s.endedAt ? '' : '  · active'}`,
      value: s,
    };
  });
  const picked = await search({
    message: 'Resume which session?',
    source: async (term) => filterRows(rows, term),
  });
  // An archived (off-disk) pick has NO on-disk transcript — claude/codex --resume
  // would fail "No conversation found". Restore it from the DB archive first, the
  // same way the explicit `--resume=<id>` path does. Only when the on-disk copy is
  // actually absent (a live/on-disk session skips this); best-effort — launchResume
  // still surfaces a real miss.
  if (!sessionHasTranscript(picked)) {
    await tryRematerializeFromArchive(picked.sessionId, picked.agent);
  }
  await launchResolvedResume(picked, args, { tracked: true });
}

// `psu --brain` was retired 2026-06-21. Keep a hard CLI tombstone so old
// scripts fail clearly instead of accidentally launching a normal SU session.
async function brainFlow(args = {}) {
  console.error(BRAIN_TOMBSTONE_MESSAGE);
  process.exitCode = 2;
}

// `psu --role=<role>` (or picking a non-su role): an interactive,
// role-scoped session — role persona + tools + feature context, human at
// the keyboard. Goes through bootstrap-role + execs the raw backend with
// the role prompt + signed role-scoped .mcp.json (NOT a *-su wrapper).
async function roleFlow(args, role, rolesMeta) {
  const consumes = (rolesMeta || []).find((r) => r.id === role)?.consumes ?? { feature: 'none', plan: 'none' };
  let agent, workspace, harness, feature, plan, account;
  if (args.picker) {
    agent = args.agent || (await pickRoleBackend());
    workspace = args.workspace || (await pickWorkspace());
    // named-su-agent-fleets P-006: fleet selection IMMEDIATELY before the account
    // pin (same as the SU flow). A new name → leader; an existing fleet → member.
    if (!args.fleet) {
      const f = await pickFleet(workspace);
      args.fleet = f.slug;
      args.fleetRole = f.role;
      args.fleetName = f.name;
      args.fleetScheme = f.scheme;
    }
    account = args.account || (await pickAccount(workspace, agent));
    harness = args.harness || (await pickHarnessRequired(workspace));
    if (args.feature) feature = args.feature;
    else if (consumes.feature === 'none') feature = null;
    else feature = await pickFeature(workspace, harness, consumes.feature);
    // Plan context for plan-consuming roles (scoper/reviewer). --plan/--no-plan
    // preselect; otherwise offer the plan picker (it has a "NO PLAN" row).
    if (args.noPlan) plan = null;
    else if (args.plan) plan = args.plan;
    else if (consumes.plan === 'none') plan = null;
    else plan = planValue(await pickPlan(workspace, harness));
  } else {
    if (agentInvalidForRole(args.agent)) {
      throw new Error('--agent must be claude, omp, or codex for a role session');
    }
    agent = args.agent;
    workspace = args.workspace || null;
    account = args.account || null;
    // No --harness = a WORKSPACE-LEVEL role session (owner-confirmed,
    // hive-agent-tabs P-003: operator/planner launch harness-less — the SU
    // model). bootstrap-role still 400s a feature-consuming role without one.
    harness = args.harness || null;
    feature = args.feature || null;
    plan = args.noPlan ? null : (args.plan || null);
  }

  // Backend-not-installed → offer to install it before we spawn (owner req
  // 2026-07-06), same as the SU flow. Aborts if the user declines / it doesn't land.
  if (!(await ensureBackendInstalled(agent))) process.exit(1);

  const res = await api('/api/agent-mcp/console/bootstrap-role', {
    method: 'POST',
    body: JSON.stringify(roleBootstrapBody({ role, agent, workspace, harness, feature, plan, account, model: args.model, fleet: args.fleet, fleetRole: args.fleetRole, fleetName: args.fleetName, fleetScheme: args.fleetScheme })),
  });
  // WI-1408 (fleet-join-startup-assertion): a requested fleet must have actually
  // registered — see assertFleetJoined's doc comment.
  assertFleetJoined(args.fleet || args.fleetName, res);

  // omp role sessions load the coordination extension (lock enforcement + coord +
  // the activity-bridge port) via -e, the same stable module the su omp launch +
  // resume use. claude/codex role hooks are user-level / baked into the codex home.
  const roleCoordExt = join(homedir(), '.papercusp', 'papercusp-coord.ts');
  const roleCoordExtPath = res.agent === 'omp' && existsSync(roleCoordExt) ? roleCoordExt : undefined;
  const requestedRoleModel = res.agent === 'omp'
    ? (res.envelopeEnv?.PAPERCUSP_OMP_MODEL_SELECTOR || args.model)
    : args.model;
  const roleModel = res.agent === 'omp' ? normalizeOmpModelSpec(requestedRoleModel) : requestedRoleModel;
  const roleModelNotice = res.agent === 'omp' ? ompModelCompatibilityNotice(requestedRoleModel) : null;
  if (roleModelNotice) console.error(roleModelNotice);
  // Launch preflight (context-trimming-tiers P-016/P-018): persona-append
  // assertion + window guard — fail loud BEFORE spawning a doomed session.
  try {
    runLaunchPreflight({ promptFile: res.promptFile, contextSize: args.contextSize, model: args.model, agent: res.agent, budget: res.contextBudget, force: args.force });
  } catch (e) {
    console.error(e?.message ?? String(e));
    process.exit(1);
  }
  const { bin, args: launchArgs } = roleLaunchArgs(res.agent, {
    promptFile: res.promptFile,
    mcpJsonPath: res.mcpJsonPath,
    coordExtPath: roleCoordExtPath,
    injectHookPath: resolveOmpInjectHookPath(res.agent),
    // Force the native session id the spec minted (claude only) so the session's
    // conversation id is known up-front and wake-executor can `--resume <uuid>`
    // EXACTLY it — never `--continue`'s most-recent-in-cwd peer on the shared
    // tree (unify-launch-mechanics P-003 invariant d).
    nativeSessionId: res.envelopeEnv?.PAPERCUSP_NATIVE_SESSION_ID || null,
    // P-014: REPLACE_CLAUDE_BASE — bootstrap-role resolves the flag server-side and threads
    // it via envelopeEnv (same env the fleet + su paths read). Off/absent ⇒ --append (today).
    replaceClaudeBase: res.envelopeEnv?.PAPERCUSP_REPLACE_CLAUDE_BASE === '1',
    // Subagent-launch deny is DEFAULT-ON; `--allow-subagents` (or the picker) opts in.
    allowSubagents: args.allowSubagents,
    // P-019/D-007: thread --model into the role launch argv (claude branch splits
    // effort via modelArgsFor). Without this the spec was env-only (PAPERCUSP_MODEL,
    // title hooks) and the session ran the saved default model.
    model: roleModel,
  });
  if (args.addDir?.length && res.agent === 'omp') {
    console.error('psu: omp has no --add-dir; ignoring it. Pass a backend flag verbatim with `-- <flag>` if omp supports one.');
  }
  // First-class --add-dir (claude/codex) + generic `--` passthrough, followed by
  // the scripted first turn as the final positional argument. Fresh SU launches
  // already use this kickoff seam; roles must too because acceptance graders are
  // fresh headless role sessions and have no human to submit an empty prompt.
  const { args: roleArgs, kickoffSeeded: roleKickoffSeeded } = finalizeFreshRoleArgs(
    res.agent,
    launchArgs,
    res,
    args,
  );
  let roleOmpConfigDir = null;
  if (res.agent === 'omp' && res.envelopeEnv?.PAPERCUSP_OMP_MODELS_YML) {
    roleOmpConfigDir = writeOmpSessionConfigDir(res.sessionId, {
      discoveryOff: true,
      model: roleModel,
      modelsYml: res.envelopeEnv.PAPERCUSP_OMP_MODELS_YML,
      clientId: res.envelopeEnv?.PAPERCUSP_SID || null,
      interactive: !!process.stdout.isTTY,
    });
    if (!roleOmpConfigDir) {
      throw new Error('psu: could not materialize the selected OMP account route; refusing direct/default fallback');
    }
  }
  console.error(
    `psu: ${res.role} on ${res.agent}  ·  ${res.feature ? `feature ${res.feature}` : (res.planSlug ? `plan ${res.planSlug}` : 'no feature')}` +
      `  ·  ${res.harnessSlug ? `harness ${res.harnessSlug}` : 'workspace-level (no harness)'}  ·  session ${res.sessionId ?? '?'}`,
  );
  if (res.accountNotice) console.error(`psu: ${res.accountNotice}`);
  {
    const subagentRisk = subagentGatewayRiskNotice(res.agent, args.allowSubagents, res.envelopeEnv);
    if (subagentRisk) console.error(subagentRisk);
  }
  console.error(`psu: cwd ${res.cwd}  —  role-scoped MCP (${res.role}); resume from here`);
  if (roleKickoffSeeded) {
    console.error(`psu: kickoff — seeding the role session's first turn (suppress with --no-kickoff)`);
  }
  // Role sessions are AGENT sessions across all backends: the marker arms the
  // hook-level scheduler guard (bash gate / omp coord-hook / codex hooks.json)
  // (native-scheduler-lockout P-010).
  runWrapper({
    wrapperBin: bin,
    args: roleArgs,
    cwd: res.cwd,
    // PAPERCUSP_MODEL: the launch model spec, exported so the codex/omp title hook can
    // render the model in the terminal title (WI-1963 title-parity — those CLIs have no
    // live model object like Claude's statusline stdin). Omitted when no --model (default).
    envelopeEnv: {
      ...res.envelopeEnv,
      ...(roleOmpConfigDir ? {
        PI_CONFIG_DIR: roleOmpConfigDir,
        PI_CODING_AGENT_DIR: join(homedir(), roleOmpConfigDir, 'agent'),
      } : {}),
      PAPERCUSP_AGENT_SESSION: '1',
      ...(roleModel ? { PAPERCUSP_MODEL: roleModel } : {}),
      // P-022: native auto-compact is retired — every Claude launch runs with
      // DISABLE_AUTO_COMPACT; the carry-respawn ladder owns the boundary.
      ...nativeCompactionEnv(res.agent),
    },
  });
}

/** True when an --agent value can't back a role session (claude/omp/codex can). */
export function agentInvalidForRole(agent) {
  return agent !== 'claude' && agent !== 'omp' && agent !== 'codex';
}

/**
 * One-time setup: persist the default-account Claude OAuth token so every
 * default-account claude psu session inherits the single CLI login on EVERY OS
 * (the macOS keychain-per-config-dir trap can't be healed by file inheritance —
 * see claudeOAuthTokenPath). `inline` is the scripting form; otherwise we guide
 * the user through `claude setup-token` and read a pasted token.
 */
async function setClaudeTokenFlow(inline) {
  let token = (inline || '').trim() || null;
  if (!token) {
    console.error('psu: store the default-account Claude login for psu sessions (works on macOS too).');
    console.error('psu:   1) in a normal terminal run:   claude setup-token');
    console.error('psu:   2) copy the printed token (starts with sk-ant-oat01-…)');
    console.error('psu:   3) paste it below.');
    const { input } = await import('@inquirer/prompts');
    token = (await input({ message: 'Paste the `claude setup-token` output:' }) || '').trim() || null;
  }
  if (!token) {
    console.error('psu: no token provided — nothing saved.');
    process.exit(2);
  }
  if (!/^sk-ant-/.test(token)) {
    console.error(`psu: warning — that doesn't look like a setup-token (expected sk-ant-oat01-…); saving anyway.`);
  }
  const p = storeClaudeOAuthToken(token);
  console.error(`psu: saved → ${p} (0600). Default-account claude psu sessions now inherit this login.`);
}

/** Remove the stored default-account Claude OAuth token (revert to keychain/file login). */
function clearClaudeTokenFlow() {
  const p = claudeOAuthTokenPath();
  if (existsSync(p)) {
    rmSync(p, { force: true });
    console.error(`psu: removed ${p}. Default-account claude reverts to the keychain/file login.`);
  } else {
    console.error('psu: no stored Claude OAuth token to clear.');
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Backend-not-installed → offer to install it (owner req 2026-07-06). If the
// chosen agent CLI (claude / codex / omp) isn't present, psu prompts and runs the
// SAME installer the setup CLI uses (/api/desktop/setup-pty-commands →
// installFramework[agent]), then re-detects — so `psu --agent=omp` on a machine
// without omp installs it in place instead of ENOENT-ing on the bare-name spawn.
// ───────────────────────────────────────────────────────────────────────────

export const AGENT_LABELS = {
  claude: 'Claude Code',
  codex: 'Codex (OpenAI)',
  omp: 'oh-my-pi (omp)',
};

/** which/where <bin> → absolute path or null — the exact gate for psu's bare-name
 *  spawn (runWrapper execs `claude`/`codex`/`omp` off PATH). Pure-ish; exported. */
export function whichBin(bin, { platform = process.platform } = {}) {
  try {
    const cmd = platform === 'win32' ? 'where' : 'which';
    const r = spawnSync(cmd, [bin], { encoding: 'utf8', timeout: 4_000 });
    const out = String(r.stdout ?? '')
      .split(/\r?\n/)
      .map((s) => s.trim())
      .find(Boolean);
    return r.status === 0 && out ? out : null;
  } catch {
    return null;
  }
}

/**
 * Well-known install locations per backend — for a bin the setup flow just
 * installed that PATH hasn't picked up yet, or (the WI-37920 case) a bin PATH
 * will NEVER pick up because this process is a login-but-non-interactive shell
 * spawned by a desktop terminal. Abs path or null. Exported for tests.
 *
 * The LIST itself lives in `packages/operator-core/lib/backend-bin-resolve.mjs`,
 * shared with the operator-side PATH injection (console-launcher). Two copies
 * would drift in the worst direction: detection succeeds here while the operator
 * injects a different (or no) dir, so the window still cannot execute the bin —
 * and it only reproduces inside a desktop terminal. Same one-definition reasoning
 * as `su-tier-roles.mjs`.
 */
export function wellKnownBackendBin(agent, opts = {}) {
  // ⚠ FORWARD THE OPTIONS OBJECT — do NOT re-destructure and rebuild it.
  //
  // This wrapper used to read `{ home = homedir(), env = process.env }` and pass
  // `{ home, env }`, which SILENTLY DROPPED every other option. `platform` was
  // the casualty: a caller asking for win32 got process.platform instead, so the
  // %USERPROFILE% branch could never run and the Windows case returned null. It
  // reds a test that looks like it is about Windows paths while the actual defect
  // is one line of destructuring here (caught 2026-08-11 by su-1f60f82c).
  //
  // The general shape, worth recognising anywhere: a pass-through wrapper that
  // re-destructures its options is an arg-dropping footgun — the option is
  // accepted by the signature, ignored in the body, and NOTHING errors. Defaults
  // belong downstream (backendSearchDirs already applies home/env/platform), so
  // forwarding whole is both simpler and the only correct form.
  return sharedWellKnownBackendBin(agent, opts);
}

/** Detect a backend bin: PATH first, then well-known. `{ path, onPath } | null`. */
export function detectBackendBin(agent) {
  const onPath = whichBin(agent);
  if (onPath) return { path: onPath, onPath: true };
  const wk = wellKnownBackendBin(agent);
  return wk ? { path: wk, onPath: false } : null;
}

/** Prepend a bin's dir to THIS process's PATH so the bare-name launch (runWrapper
 *  inherits process.env) resolves a just-installed backend not yet on PATH.
 *
 *  WI-37920: ALSO prepend the dir of the bin's shebang INTERPRETER. `omp` ships as
 *  `#!/usr/bin/env bun`, so making `omp` resolvable is worthless if `bun` is not —
 *  the exec succeeds at the kernel layer and dies in `env`. Detection-only fixes
 *  pass their tests and still leave a dead window; this is the execution half. */
function ensureDirOnPath(binPath) {
  const dirs = [dirname(binPath)];
  try {
    const interpreter = readShebangInterpreter(binPath);
    if (interpreter) {
      const resolved = resolveOnPath(interpreter) ?? resolveInWellKnownDirs(interpreter);
      if (resolved) dirs.push(dirname(resolved));
    }
  } catch {
    /* a shebang we cannot read is not a reason to skip the bin's own dir */
  }
  for (const dir of dirs) {
    const parts = String(process.env.PATH ?? '').split(delimiter);
    if (!parts.includes(dir)) process.env.PATH = dir + delimiter + (process.env.PATH ?? '');
  }
}

/** Spawn an installer SpawnSpec inheriting this terminal (installs are interactive). */
function runInstallerInherit(spec) {
  return new Promise((resolve) => {
    const child = spawn(spec.command, spec.args, {
      cwd: spec.cwd || process.cwd(),
      env: { ...sanitizeInheritedEnv(process.env), ...(spec.env ?? {}) },
      stdio: 'inherit',
    });
    child.on('exit', (code) => resolve(code ?? 1));
    child.on('error', () => resolve(1));
  });
}

/**
 * Ensure the chosen backend CLI is installed before we launch it. Returns true when
 * it's usable (already present, or installed here + made resolvable), false when the
 * user declined or it didn't land — the caller then aborts the launch. Non-interactive
 * (scripted / non-TTY) launches never prompt; they fail with guidance instead.
 */
async function ensureBackendInstalled(agent, { interactive = Boolean(process.stdout.isTTY) } = {}) {
  const present = detectBackendBin(agent);
  if (present) {
    if (!present.onPath) ensureDirOnPath(present.path);
    return true;
  }
  const label = AGENT_LABELS[agent] ?? agent;
  console.error(`psu: the ${label} backend (\`${agent}\`) is not installed.`);
  if (!interactive) {
    console.error('psu: install it with `papercusp setup` (or run psu interactively to be prompted), then re-run.');
    return false;
  }
  const { confirm } = await import('@inquirer/prompts');
  const wants = await confirm({
    message: `The ${label} AI backend isn't installed. Install it now?`,
    default: true,
  });
  if (!wants) {
    console.error(`psu: skipped. Install ${label} yourself or run \`papercusp setup\`, then re-run psu.`);
    return false;
  }
  let cmds;
  try {
    cmds = await api('/api/desktop/setup-pty-commands');
  } catch (e) {
    console.error(`psu: couldn't fetch the installer (${e?.message ?? e}). Finish setup with \`papercusp setup\`.`);
    return false;
  }
  const spec = cmds?.installFramework?.[agent];
  if (!spec?.command) {
    console.error(
      `psu: no installer available for ${label} on this platform. Install it manually` +
        (agent === 'omp' ? ' (see https://github.com/can1357/oh-my-pi)' : '') +
        ', then re-run psu.',
    );
    return false;
  }
  console.error(`psu: installing ${label} — streaming the installer here…`);
  const code = await runInstallerInherit(spec);
  if (code !== 0) console.error(`psu: the installer exited ${code}; re-checking anyway.`);
  const after = detectBackendBin(agent);
  if (!after) {
    console.error(
      `psu: ${label} still isn't detected. Open a new terminal (so PATH refreshes) and re-run psu, or finish setup with \`papercusp setup\`.`,
    );
    return false;
  }
  if (!after.onPath) {
    ensureDirOnPath(after.path);
    console.error(
      `psu: using ${after.path} (added its dir to PATH for this launch; restart your shell to make it permanent).`,
    );
  }
  console.error(`psu: ${label} is ready. ✓`);
  return true;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  // WI-37841 — FIRST, before any flow can fail. A launch carrying a PRE-PINNED
  // owner id was started programmatically (launch-su's "+ New session"), so
  // nobody is watching its window and every diagnostic it prints from here on is
  // otherwise lost the moment it exits. Tee them to this launch's boot log so
  // the failure banner can name a cause instead of "the terminal closed".
  // Never throws and returns null on any trouble — a diagnostic side-channel
  // must not be able to fail the launch it is diagnosing.
  if (args.ownerId) installBootLogCapture(args.ownerId);
  // headless-fleet-launch P-001: publish the headless posture into the env BEFORE any
  // launch flow. runWrapper builds its child env from sanitizeInheritedEnv(process.env)
  // (which preserves PAPERCUSP_*), so this single assignment is what (a) makes
  // usePtyHost({ env }) keep the managed pty despite no TTY, and (b) hands the posture
  // down to the agent child. `--headless` is the CLI face of PAPERCUSP_PSU_HEADLESS=1;
  // setting the env var directly (a headless spawner) works identically.
  if (args.headless) process.env.PAPERCUSP_PSU_HEADLESS = '1';
  // One-time credential maintenance commands run before any launch flow.
  if (args.setClaudeToken) {
    await setClaudeTokenFlow(args.setClaudeTokenValue);
    return;
  }
  if (args.clearClaudeToken) {
    clearClaudeTokenFlow();
    return;
  }
  // --fork only has meaning when resuming an existing session — warn (don't fail)
  // so a stray `psu --fork` on a fresh launch doesn't silently look honored.
  if (args.fork && !args.resume) {
    console.error('psu: --fork only applies with --resume (it branches an existing session); ignoring it for this fresh launch.');
  }
  if (args.brain) {
    await brainFlow(args);
    return;
  }
  if (args.resume) {
    await resumeFlow(args);
    return;
  }

  // Resolve the role first: flag wins; else pick (picker mode); else 'su'.
  let role = args.role || null;
  let rolesMeta = null;
  if (!role && args.picker) {
    const picked = await pickRole();
    role = picked.role;
    rolesMeta = picked.roles;
  }
  if (!role) role = 'su';
  // Subagent-launch toggle (owner mandate 2026-07-02): DENIED BY DEFAULT; the picker
  // offers an explicit opt-IN for this interactive launch (su OR role). A
  // --allow-subagents / --no-subagents flag preselects + skips it. Runs before the
  // su/role branch so BOTH paths carry args.allowSubagents into their launch args.
  if (args.picker && args.allowSubagents == null) args.allowSubagents = await pickSubagents();
  // EI-996 (owner ask 2026-06-17: planners should "be full su agents and get the
  // full su prompt, but just a few lines added about their planner role"): a
  // SU-TIER role skips roleFlow entirely and falls through to the plain SU flow
  // below, carrying its role NAME as `su_role`. The server appends that role's
  // addendum to the engineer playbook and the session keeps the SUPERUSER MCP
  // tier — the "full su agent" half of the ask, which the role bootstrap cannot
  // give (renderSuPlaybook needs the su path's `agent`).
  //
  // ⚠ This GRANTS THE SUPERUSER TIER to the roles listed here — a deliberate,
  // owner-authorized privilege escalation, not an incidental side effect. Adding
  // a role to SU_TIER_ROLES is a security decision; make it consciously.
  if (!launchesOnSuTier(role)) {
    await roleFlow(args, role, rolesMeta);
    return;
  }
  // Reached with role === 'su' (su_role null) or a su-tier role name.
  args.suRole = suRoleFor(role);

  // ── plain SU / engineer flow (unchanged) ──
  let selections;
  if (args.picker) {
    // Honor any flags as preselections; prompt only for what was omitted.
    const p = presetsFromArgs(args);
    const agent = p.needAgent ? await pickAgent() : p.agent;
    // su-context-size-variants: prompt for the context-size variant right after the
    // agent (the terminal twin of the UI's Full/Trimmed toggle). A --context-size=
    // flag preselects + skips this, mirroring --fleet/--account. Defaults to 'trimmed';
    // Native (null) ⇒ no flag ⇒ byte-identical to the pre-feature launch, still one
    // keypress away.
    if (!args.contextSize) args.contextSize = await pickContextSize();
    const workspace = p.needWorkspace ? await pickWorkspace() : p.workspace;
    const harness = p.needHarness ? await pickHarness(workspace) : p.harness;
    const plan = p.needPlan ? planValue(await pickPlan(workspace, harness)) : p.plan;
    // named-su-agent-fleets P-006: choose a named fleet (or none) IMMEDIATELY
    // before the account pin, mirroring it. A new name → this agent leads the
    // fresh fleet; an existing fleet → member. `--fleet=<slug>` preselects + skips.
    if (!args.fleet) {
      const f = await pickFleet(workspace);
      args.fleet = f.slug;
      args.fleetRole = f.role;
      args.fleetName = f.name;
      args.fleetScheme = f.scheme;
    }
    // psu-account-chooser P-005: offer a pool-account pin when one is meaningful
    // (gateway on + a non-empty pool). pickAccount returns null — and prompts
    // nothing — otherwise, so the default launch stays byte-identical.
    if (!args.account) args.account = await pickAccount(workspace, agent);
    selections = { agent, workspace, harness, plan };
  } else {
    selections = selectionsFromArgs(args);
  }

  // Backend-not-installed → offer to install it before we spawn (owner req
  // 2026-07-06). Aborts the launch if the user declines / it doesn't land.
  if (!(await ensureBackendInstalled(selections.agent))) process.exit(1);

  await launchFreshSu(selections, args);
}

/**
 * The pre-TUI "your setup isn't finished" nudge (owner batch #5). PURE: given the
 * concierge setup STAGE name, return the reminder lines to print, or null when there
 * is nothing to nudge — setup is complete (stage 'done') or the stage is unknown
 * (null, e.g. the operator was unreachable — never nag on a failed probe). Both
 * `papercusp setup` and `papercusp tutorial` reach the same place (the unified
 * onboarding shell), so the nudge names both.
 */
export function setupReminderLines(stage) {
  if (!stage || stage === 'done') return null;
  return [
    '',
    'ⓘ  Heads up — your Papercusp setup isn’t finished yet, so some functionality stays locked.',
    '   Finish it any time:  `papercusp setup`  or  `papercusp tutorial`  (both open the same place).',
    '',
  ];
}

/**
 * Best-effort read of the concierge setup stage from the LIVE operator. Returns the
 * stage NAME (e.g. 'pick' | 'install' | 'login' | 'embeddings' | 'handoff' | 'done'),
 * or null on ANY error/timeout so a slow or unreachable operator never delays or breaks
 * the TUI launch. The operator is already known-reachable at the one call site
 * (bootstrap-su just succeeded), so this normally returns in tens of ms; the timeout is
 * only a safety net. Note the endpoint returns `stage` as an OBJECT ({ stage: 'done' }),
 * so the stage NAME is `body.stage.stage`.
 */
async function fetchSetupStageSoft({ fetchImpl = fetch, operatorUrl = OPERATOR_URL, timeoutMs = 1500 } = {}) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetchImpl(operatorUrl + '/api/desktop/onboarding-status', { signal: ac.signal });
    if (!r?.ok) return null;
    const j = await r.json();
    const name = j?.stage?.stage;
    return typeof name === 'string' ? name : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * POST bootstrap-su + exec the raw backend — the fresh-SU launch tail shared
 * by the plain `psu` flow. The retired `psu --brain` path is rejected before
 * it reaches this launcher.
 */
async function launchFreshSu(selections, args, { brain = false } = {}) {
  const res = await api('/api/agent-mcp/console/bootstrap-su', {
    method: 'POST',
    body: JSON.stringify(freshSuBootstrapBody(selections, args, { brain })),
  });
  // WI-1408 (fleet-join-startup-assertion): a requested fleet must have actually
  // registered — see assertFleetJoined's doc comment.
  assertFleetJoined(args.fleet || args.fleetName, res);

  // res.cwd is server-decided: the harness repo for a harness launch, or
  // our cwd (above) for a no-harness one. Agents scope resumable sessions
  // by cwd, so resume works from res.cwd.
  console.error(
    `psu: ${res.agent} (su${brain ? ' · BRAIN pinned' : ''})  ·  ${res.planSlug ? `plan ${res.planSlug}` : 'no plan'}  ·  session ${res.sessionId ?? '?'}`,
  );
  console.error(`psu: cwd ${res.cwd}  —  resume this session by running the agent's resume command from here`);
  // psu-account-chooser: surface whether the `--account` pin took effect (or the
  // fail-soft reason it was skipped) so the user is never silently unpinned.
  if (res.accountNotice) console.error(`psu: account — ${res.accountNotice}`);
  {
    const subagentRisk = subagentGatewayRiskNotice(res.agent, args.allowSubagents, res.envelopeEnv);
    if (subagentRisk) console.error(subagentRisk);
  }
  // named-su-agent-fleets P-006: surface the chosen fleet (leading a new one /
  // joining an existing one), or the fail-soft reason it was skipped.
  if (res.fleetNotice) console.error(`psu: fleet — ${res.fleetNotice}`);

  // P-020: exec the RAW backend (not a *-su wrapper) with the engineer
  // playbook (res.promptFile) + flags. MCP + lock hooks are user-level for
  // claude/omp (they survive a raw launch); codex runs in res.codexHome.
  // Launch preflight (context-trimming-tiers P-016/P-018): persona-append
  // assertion + window guard — fail loud BEFORE spawning a doomed session.
  try {
    runLaunchPreflight({ promptFile: res.promptFile, contextSize: args.contextSize, model: args.model, agent: res.agent, budget: res.contextBudget, force: args.force });
  } catch (e) {
    console.error(e?.message ?? String(e));
    process.exit(1);
  }
  const { bin, args: baseArgs } = suLaunchArgs(res.agent, {
    promptFile: res.promptFile,
    coordExtPath: res.coordExtPath,
    injectHookPath: resolveOmpInjectHookPath(res.agent),
    // Force the recorded native session id on a FRESH launch — but not when
    // this invocation is itself resuming one: claude rejects --session-id with
    // --resume/--continue *unless* --fork-session is also present (that exception
    // is what launchTrackedFork relies on; see resumeArgsFor).
    nativeSessionId: args.resumeSession ? null : res.nativeSessionId,
    // P-014: REPLACE_CLAUDE_BASE — bootstrap-su resolves the flag server-side and
    // threads it via envelopeEnv (same env name the fleet path reads). Off/absent ⇒
    // suLaunchArgs uses --append (byte-identical to today).
    replaceClaudeBase: res.envelopeEnv?.PAPERCUSP_REPLACE_CLAUDE_BASE === '1',
    // Subagent-launch deny is DEFAULT-ON (claude-only); `--allow-subagents` (or the
    // picker) opts THIS su launch back in. See suLaunchArgs / NO_SUBAGENTS_DENY_FLAG.
    allowSubagents: args.allowSubagents,
  });
  const requestedLaunchModel = res.agent === 'omp'
    ? (res.envelopeEnv?.PAPERCUSP_OMP_MODEL_SELECTOR || args.model)
    : args.model;
  const launchModel = res.agent === 'omp' ? normalizeOmpModelSpec(requestedLaunchModel) : requestedLaunchModel;
  const launchModelNotice = res.agent === 'omp' ? ompModelCompatibilityNotice(requestedLaunchModel) : null;
  if (launchModelNotice) console.error(launchModelNotice);
  // model/resume passthrough (raw-CLI flags: claude/omp --model/-r, codex -m/resume).
  const extra = suWrapperExtraArgs(res.agent, { model: launchModel, resumeSession: args.resumeSession });
  if (args.addDir?.length && res.agent === 'omp') {
    console.error('psu: omp has no --add-dir; ignoring it. Pass a backend flag verbatim with `-- <flag>` if omp supports one.');
  }
  if (args.allowSubagents != null && res.agent !== 'claude') {
    console.error(`psu: subagent allow/deny is claude-only; ${res.agent} sessions are unaffected (no deny flag wired up — they keep their native subagent tool).`);
  }
  // First-class --add-dir (claude/codex) then the generic `--` passthrough — both
  // forwarded verbatim to the backend CLI after psu's own flags.
  const launchArgs = [...baseArgs, ...extra, ...addDirArgs(res.agent, args.addDir || []), ...(args.passthrough || [])];
  // The brain (Queen) is an AGENT riding the su launch machinery — it gets the
  // native-scheduler lockout the human su session deliberately keeps (D-003).
  if (brain && res.agent === 'claude') launchArgs.push(NATIVE_SCHEDULER_DENY_FLAG);
  // notify-send lockout rides suLaunchArgs for claude already; nothing extra here.
  // A kickoff launch-context (server-generated) layers in as a SECOND system
  // prompt for claude/omp. Codex has no equivalent CLI flag, so bootstrap-su
  // folds the same file into CODEX_HOME/AGENTS.md before returning.
  if (args.launchContext && res.agent !== 'codex') {
    launchArgs.push(res.agent === 'claude' ? '--append-system-prompt-file' : '--append-system-prompt', args.launchContext);
  }

  // improve-fleet-launch-autokickoff (EI-5503): seed the FIRST USER TURN for a
  // SCRIPTED plan launch so a fleet/automation member immediately starts working
  // the plan instead of orienting once (reading the plan + brief as system prompt)
  // and then parking idle on its inbox-wake — the gap a leader previously closed by
  // hand with a coord:send wake. All three backends accept a TRAILING POSITIONAL
  // prompt that keeps the session INTERACTIVE while submitting it as the first turn
  // (claude `[prompt]`, omp `… "prompt"`, codex `[PROMPT]` — their -p/--print and
  // `codex exec` non-interactive modes are NOT used here), so the kickoff is one
  // positional appended AFTER every flag (incl. the launch-context flag's value).
  // Gated to --no-picker launches (an interactive human picker launch still opens at
  // an empty prompt) + an explicit --no-kickoff opt-out. Text is server-supplied
  // (res.kickoffPrompt = the canonical deriveLaunchPromptText, present iff a plan is
  // bound) so it never drifts from headless plans:launch's kickoff.
  // Free-form kickoff precedence: explicit `--kickoff=<text>` flag, else the
  // PAPERCUSP_KICKOFF_PROMPT env var. The env var is the SPAWN-SAFE channel — a
  // free-form question passed as a `--kickoff=` VALUE inside a console greetingCmd
  // gets double-single-quoted by buildConsoleOneliner and breaks the shell (the
  // gnome-terminal exit-2 the tutorial docs-agent hit); an env value is exported
  // via a correctly-escaped `export K=…` in the oneliner prelude and arrives
  // intact (multiline / quotes included). So the desktop docs-agent launcher sets
  // the env var, not the flag.
  const kickoffArgs = kickoffPositionalArgs(res, {
    ...args,
    kickoffPromptText: resolveKickoffText(args),
  });
  if (kickoffArgs.length) {
    // turn-provenance P-002: tag the scripted first turn (fleet-kickoff) so the
    // session's own prompt hook labels it machine-origin, not owner input.
    const sidForTag = res?.envelopeEnv?.PAPERCUSP_SID || process.env.PAPERCUSP_SID || null;
    launchArgs.push(...kickoffArgs.map((t) => tagKickoffProvenance(t, sidForTag)));
    console.error(`psu: kickoff — seeding first turn${res.planSlug ? ` to advance plan ${res.planSlug}` : ''} (suppress with --no-kickoff)`);
  }

  // P-002 (omp-psu-interactive-parity-hardening-2026-06-29): an SU omp session
  // path-discovers <cwd>/.mcp.json. A prior ROLE session leaves a signed role-scoped
  // one there and never cleans it up (detached, unref'd terminal, no exit hook), so a
  // later SU omp launch hangs ~30s on a dead per-role MCP host ("papercusp timed
  // out"). Park it — the SU session needs only the user-level papercusp-su, and role
  // launchers recreate .mcp.json fresh, so parking is safe + needs no restore.
  // BOTH claude AND omp path-discover <cwd>/.mcp.json (claude auto-loads a project .mcp.json;
  // omp's mcp.discoveryMode) and NEITHER SU launch uses --strict-mcp-config (claude's papercusp-su
  // is user-level ~/.claude.json; omp discovers) — so park for both. (Was omp-only on the false
  // premise "claude uses --strict-mcp-config" — that holds for ROLE claude launches, not SU: an SU
  // claude in a cwd where a role spawn left a stale role-scoped .mcp.json inherits that role's
  // principal, e.g. system:sentinel. su-resume-inherits-role-mcp-json, 2026-06-30.) codex uses
  // CODEX_HOME, exempt.
  // su-context-size-variants + weak-model-tool-tier: OMP's per-session PI_CONFIG_DIR carries
  // a faithful copy of the config+model-registry with a rewritten mcp.json (home-relative —
  // see writeOmpSessionConfigDir). Two triggers, mutually exclusive:
  //   • contextSize:'full'  → discovery OFF, whole catalog up-front (a capable model that wants
  //     no discovery dance).
  //   • WEAK/local model (or explicit contextSize:'trimmed') → advertise ONLY the ~19-tool core
  //     spine (the rest via tools:find), so a small model isn't handed ~580 tools it can't wield.
  // The tier comes from the MODEL (explicit --model, else the config.yml default), NOT the client
  // — OMP runs weak AND strong models. Fail-safe: null ⇒ OMP keeps its native default (no regression).
  let ompPiConfigDir = null;
  if (res.agent === 'omp' || res.agent === 'claude') {
    const parked = parkRoleScopedMcpJson(res.cwd);
    if (parked) console.error(`psu: parked a stale role-scoped ${res.cwd}/.mcp.json (an SU session uses user-level papercusp-su, not a co-located role server; role launches recreate it)`);
  }
  if (res.agent === 'omp') {
    const advisory = ompDefaultModelAdvisory();
    if (advisory) console.error(advisory);
    const effectiveModel = launchModel || ompDefaultModel();
    // effectiveWindow probe (deterministic-context-carry P-005): for a LOCAL model, read the
    // live per-slot n_ctx from the gateway's backend probe so the per-session registry is
    // clamped to min(configured, live) — never trusting a hand-set number the backend has
    // drifted away from. Fail-soft: a null probe keeps the configured registry (pre-P-005
    // behavior), it never blocks the launch.
    let backendWindow = null;
    if (isWeakOmpModel(effectiveModel)) {
      backendWindow = await probeOmpBackendContextWindow(effectiveModel);
      if (backendWindow) console.error(`psu: live backend context window for ${effectiveModel}: ${backendWindow} tokens/slot — per-session registry set to min(configured, live).`);
      else console.error(`psu: live backend context-window probe unavailable for ${effectiveModel} (gateway/backend miss) — keeping configured registry values.`);
    }
    if (args.contextSize === 'full') {
      // ESCAPE HATCH (dynamic-tool-surface D-010): --context-size=full opts OUT of the
      // seed — eager-load the whole catalog with discovery OFF (latency-critical broad-tool
      // task / debugging). Everything else defaults to the seed below.
      ompPiConfigDir = writeOmpSessionConfigDir(res.sessionId, { discoveryOff: true, model: effectiveModel, modelsYml: res.envelopeEnv?.PAPERCUSP_OMP_MODELS_YML || null, clientId: res.envelopeEnv?.PAPERCUSP_SID || null, backendWindow, interactive: !args.headless && !!process.stdout.isTTY });
      if (ompPiConfigDir) console.error(`psu: omp --context-size=full — tool discovery OFF (whole catalog up-front) via per-session config ${ompPiConfigDir}`);
      else console.error('psu: omp --context-size=full could not materialize a discovery-off config; using OMP default.');
    } else {
      // DEFAULT for EVERY model/tier (dynamic-tool-surface D-010, "default all to trimmed"):
      // SEED the core spine. It's a growable FLOOR, not a cap — tools:find surfaces the tail
      // on demand (→ notifications/tools/list_changed → OMP re-fetches tools/list, VERIFIED
      // live), tools:invoke (also in the spine) calls anything by name, and the compact
      // capability map (MCP initialize instructions) preserves discoverability. ~165k→~10k
      // tokens with the whole catalog still reachable. --context-size=full opts out.
      //
      // discoveryOff is REQUIRED here, not optional (live-verified 2026-07-01 on ornith):
      // with OMP discovery ON, even the seed's front doors (tools:find / tools:invoke) sit
      // behind search_tool_bm25 activation — a 0-match query strands the ENTIRE surface
      // (nothing activated ⇒ nothing callable). A ~20-tool seed needs no discovery gate;
      // exposing it directly also makes post-list_changed refreshes auto-expose surfaced
      // tools (sdk activateAll path) instead of gating them behind a second bm25 pass.
      const spine = ompCoreToolNames();
      if (spine.length !== OMP_CORE_MCP_TOOL_NAMES.length) {
        console.error(`psu: PAPERCUSP_OMP_TOOLS_EXCLUDE — dropped ${OMP_CORE_MCP_TOOL_NAMES.length - spine.length} tool(s) from the advertised spine; still callable via tools:invoke.`);
      }
      ompPiConfigDir = writeOmpSessionConfigDir(res.sessionId, { discoveryOff: true, toolsAllowlist: spine, model: effectiveModel, modelsYml: res.envelopeEnv?.PAPERCUSP_OMP_MODELS_YML || null, clientId: res.envelopeEnv?.PAPERCUSP_SID || null, backendWindow, interactive: !args.headless && !!process.stdout.isTTY });
      if (ompPiConfigDir) console.error(`psu: omp (${effectiveModel}) — MCP surface seeded to ${spine.length} core tools (default; long tail reachable on demand via tools:find/tools:invoke). Use --context-size=full for the whole catalog up-front.`);
      else console.error(`psu: omp (${effectiveModel}) — could not materialize a seeded config; using OMP default (full catalog).`);
    }
    if (res.envelopeEnv?.PAPERCUSP_OMP_MODELS_YML && !ompPiConfigDir) {
      throw new Error('psu: could not materialize the selected OMP account route; refusing direct/default fallback');
    }
  }

  // Owner batch #5: right before the TUI takes over the terminal, remind a human
  // whose setup isn't finished that some functionality stays locked — and that
  // `papercusp setup` / `papercusp tutorial` both reach the place to finish it.
  // Gated to an INTERACTIVE, non-agent, non-scripted launch: fleet/Queen (brain),
  // omp (always an agent session), a scripted plan kickoff, a layered launch-context,
  // and any piped/non-TTY stdio all skip it. Best-effort + time-boxed — a slow or
  // unreachable operator (or any probe error) prints nothing and never delays the launch.
  if (
    Boolean(process.stdout.isTTY) &&
    !brain &&
    res.agent !== 'omp' &&
    !kickoffArgs.length &&
    !args.launchContext
  ) {
    const lines = setupReminderLines(await fetchSetupStageSoft());
    if (lines) for (const line of lines) console.error(line);
  }

  // codex's superuser bearer is baked into its per-session config.toml
  // server-side (D-006); nothing for psu to export here.
  runWrapper({
    wrapperBin: bin,
    args: launchArgs,
    cwd: res.cwd,
    kickoffFile: res.sessionPortKickoffFile || null,
    sessionPort: res.sessionPort ? {
      ...res.sessionPort,
      workspace: selections.workspace,
      targetAdvSessionId: res.sessionId,
    } : null,
    // Anything launched through psu is an agent session for hook purposes:
    // native-scheduler lockout, OMP coord-hook guards, and the destructive
    // shared-tree git guard must all be armed. Direct non-psu Claude terminals
    // stay unmarked, preserving the owner-session exemption.
    envelopeEnv: {
      ...res.envelopeEnv,
      // The SU account picker defines no gateway route as "default — system/CLI
      // login". Make that an explicit envelope decision so ambient API/OAuth
      // credentials cannot silently override what the user selected.
      ...(res.agent === 'claude' && !res.envelopeEnv?.ANTHROPIC_BASE_URL ? defaultAccountEnv() : {}),
      PAPERCUSP_AGENT_SESSION: '1',
      // PAPERCUSP_MODEL: the launch model spec, exported so the codex/omp title hook can
      // render the model in the terminal title (WI-1963 title-parity — those CLIs have no
      // live model object like Claude's statusline stdin). Omitted when no --model (default).
      ...(launchModel ? { PAPERCUSP_MODEL: launchModel } : {}),
      // fleet-auto-mode (WI-1356): mark the running session as AUTO so the persona +
      // hooks read it at runtime (the durable prompt directive + turn-1 kickoff come
      // from bootstrap-su via the `auto` body field). Default on for `--fleet`.
      ...(effectiveAutoMode(args) ? { PAPERCUSP_AUTO_MODE: '1' } : {}),
      ...(args.mode === 'drain' ? { PAPERCUSP_DRAIN_MODE: '1' } : {}),
      // su-context-size-variants: 'full' forces every tool schema loaded up-front by
      // disabling ToolSearch deferral (fine on a 1M-window model; the whole point of full).
      // Everything else FORCES deferral ON: claude silently disables tool search when
      // ANTHROPIC_BASE_URL is overridden (it can't assume a proxy forwards tool_reference
      // blocks — ours does, it's a pass-through), so every gateway-routed (`--account`)
      // member was booting with ALL advertised schemas inline: 106–108k vs 60k measured
      // across the 2026-07-02 04:50 sonnet fleet (context-trimming-tiers P-031 gap 3).
      // Redundant-but-harmless on direct-API launches where deferral is already the default.
      ...(res.agent === 'claude'
        ? { ENABLE_TOOL_SEARCH: args.contextSize === 'full' ? 'false' : 'true' }
        : {}),
      // P-014 (agent-managed-compaction): the MECHANICAL compaction backstop. For a
      // P-022: native auto-compact is retired — every Claude launch runs with
      // DISABLE_AUTO_COMPACT; the carry-respawn ladder owns the boundary
      // (self-cut → watchdog soft cut → 1.3× force cut → death detector).
      ...nativeCompactionEnv(res.agent),
      // P-030 (2026-07-02): OMP's default 30s MCP connect timeout is starved by a ~35s
      // startup event-loop block (observed twice, blockedMs≈35.6k both times) — every MCP
      // server then "times out"/"unable to connect" and the session runs TOOL-LESS with no
      // retry (OMP never reconnects a failed server). Give the connect phase real headroom;
      // an explicit env override still wins.
      ...(res.agent === 'omp' && !process.env.OMP_MCP_TIMEOUT_MS
        ? { OMP_MCP_TIMEOUT_MS: '120000' } : {}),
      // dynamic-tool-surface D-010 ("default all to trimmed"): claude is seeded BY DEFAULT
      // too — native ToolSearch defers only tool SCHEMAS, leaving all ~581 tool
      // names+descriptions (~165k, MEASURED) inline (that DOA'd sonnet-window sessions with
      // "Prompt is too long"), so the up-front load is the waste. claude's user-level
      // papercusp-su MCP url env-expands ${PAPERCUSP_TOOLS} (see buildClaudeMcpEntry), so
      // exporting the CORE SPINE makes the superuser MCP advertise ONLY the spine (~9k). The
      // tail stays reachable via tools:find/tools:invoke (in the spine) + the capability map.
      // Only --context-size=full opts OUT (unset PAPERCUSP_TOOLS → full catalog + ToolSearch).
      ...(res.agent === 'claude' && args.contextSize !== 'full'
        ? { PAPERCUSP_TOOLS: claudeSeedToolNames().join(',') } : {}),
      // context-trimming-tiers D-004/P-009: the session PAYLOAD tier. The claude MCP url
      // env-expands ${PAPERCUSP_CONTEXT_TIER} (buildClaudeMcpEntry `ctx_tier=`) so the
      // server shapes tool payloads (defineTool `shape` projections) per tier.
      // TRIMMED IS THE DEFAULT FOR EVERY LAUNCH, model window irrelevant
      // [owner 2026-08-10: "make the default trimmed even for the 1m context models"].
      // P-009 originally derived this from the WINDOW (≤200k → trimmed, a [1m] spec →
      // full) on the theory that payload shaping only matters where the window is
      // small. It doesn't: a big window makes an unshaped payload AFFORDABLE, not
      // useful — the same wasted tokens are still read, just without hitting a wall.
      // This now matches the tool-surface spine (D-010), which was already trimmed for
      // everyone. Only an explicit --context-size=full opts out (unshaped payloads,
      // byte-identical to pre-tier behavior).
      PAPERCUSP_CONTEXT_TIER: args.contextSize === 'full' ? 'full' : 'trimmed',
      // su-context-size-variants + weak-model-tool-tier: OMP runs against a per-session config
      // dir (home-relative) — 'full' with discovery off, or a WEAK model with the MCP surface
      // trimmed to the core spine (materialized above; null for non-omp / frontier-model / failure).
      // PI_CODING_AGENT_DIR must be PINNED alongside it (context-trimming-tiers P-031, 2026-07-02):
      // OMP treats that var as an agent-dir OVERRIDE that BEATS PI_CONFIG_DIR, and adv-console /
      // pty spawns export it (<stateDir>/pi-sessions — spawn-config.resolveContextEnv), so a psu
      // launched from such a shell silently ignored the per-session mcp.json + config.yml: the
      // 04:53 ornith session got the FULL 592-tool catalog (inherited pi-sessions agent dir, no
      // tools= filter, no discovery flip) instead of the 20-tool spine. Pinning to the session's
      // own agent dir makes the relocation deterministic regardless of inherited env.
      ...(ompPiConfigDir
        ? {
            PI_CONFIG_DIR: ompPiConfigDir,
            PI_CODING_AGENT_DIR: join(homedir(), ompPiConfigDir, 'agent'),
          }
        : {}),
    },
  });
}

// Symlink-robust CLI-entry check (WI-1443): node realpaths the entry module's
// import.meta.url while argv[1] keeps the invoked path — through a symlinked
// checkout (papercup -> papercusp, as the on-PATH shim does) the naive === is
// false and main() silently never runs.
const isMain = (() => {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  if (import.meta.url === pathToFileURL(argv1).href) return true;
  try {
    return import.meta.url === pathToFileURL(realpathSync(argv1)).href;
  } catch {
    return false;
  }
})();
if (isMain) {
  main().catch((e) => {
    // @inquirer throws ExitPromptError on Ctrl+C — treat as a clean cancel.
    if (e && (e.name === 'ExitPromptError' || /force closed/i.test(e.message || ''))) {
      console.error('psu: cancelled');
      process.exit(130);
    }
    const msg = e?.message || (typeof e === 'string' ? e : JSON.stringify(e));
    console.error('psu: ' + msg);
    process.exit(1);
  });
}
