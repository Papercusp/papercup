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
import { existsSync, readFileSync, readdirSync, cpSync, mkdirSync, writeFileSync, chmodSync, rmSync, renameSync, realpathSync, statSync, readlinkSync, openSync, readSync, closeSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join, dirname, delimiter } from 'node:path';
import { pathToFileURL } from 'node:url';
import { hostThroughPty, fleetOscFromEnv, findLiveHostFor } from './psu-pty-host.mjs';

export const AGENTS = ['claude', 'omp', 'codex'];
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
export function resolveOperatorTarget({
  env = process.env,
  home = homedir(),
  probe = defaultMcpProxyProbe,
  warn = (m) => console.warn(m),
} = {}) {
  const proxyOptedOut = env.PAPERCUSP_MCP_PROXY === '0';
  const proxyPort = Number(env.PAPERCUSP_MCP_PROXY_PORT) > 0 ? Number(env.PAPERCUSP_MCP_PROXY_PORT) : 9071;
  if (env.PAPERCUSP_OPERATOR_URL) {
    // WI-1457: an explicit :3070 pin while the proxy is alive is exactly the
    // active-but-unrouted regression — honor the override, but say so loudly.
    if (!proxyOptedOut && /:3070\b/.test(env.PAPERCUSP_OPERATOR_URL) && probe(proxyPort)) {
      warn(
        `psu: PAPERCUSP_OPERATOR_URL pins ${env.PAPERCUSP_OPERATOR_URL} but the resilient MCP proxy is ACTIVE on :${proxyPort} — ` +
          `this session bypasses deploy-restart resilience (WI-1457). Unset the override (or point it at :${proxyPort}) to ride the proxy.`,
      );
    }
    return { url: env.PAPERCUSP_OPERATOR_URL, source: 'env', startedAt: null };
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
// Per-request timeout. Raised 15s→45s (2026-06-07): a busy operator can take
// 10-30s on a hop-heavy bootstrap route under fleet load, and a 15s cap turned
// every transient slow window into a hard `psu` failure. 45s rides through the
// blip; a truly wedged host still fails (just later) with the same guidance.
const REQUEST_TIMEOUT_MS = Number(process.env.PAPERCUSP_PSU_TIMEOUT_MS) || 45_000;
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

/** Parse the scripting-escape flags. Pure — exported for tests. */
export function parseArgs(argv) {
  const out = { picker: true, resume: false, resumeId: null, fork: false, agent: null, role: null, feature: null, workspace: null, harness: null, plan: null, noPlan: false, model: null, resumeSession: null, launchContext: null, launchedBy: null, profile: null, contextSize: null, personaTier: null, force: false, yes: false, brain: false, account: null, fleet: null, fleetRole: null, fleetName: null, fleetScheme: null, auto: null, mode: null, seat: null, addDir: [], passthrough: [], setClaudeToken: false, setClaudeTokenValue: null, clearClaudeToken: false, allowSubagents: null, kickoffPromptText: null, label: null, headless: false };
  // Everything after a literal `--` is forwarded VERBATIM to the underlying agent
  // CLI (claude/omp/codex) — a generic escape hatch so a new backend flag needs no
  // psu change. Appended at the END of the launch/resume argv (launchFreshSu /
  // launchResume); ordering past that is the caller's responsibility.
  let rest = false;
  let pendingAddDir = false;
  let pendingAccount = false;
  let pendingFleet = false;
  for (const a of argv) {
    if (rest) { out.passthrough.push(a); continue; }
    // `--add-dir <dir>` (space form) — the previous token armed this; take the
    // value verbatim (even if it looks like a flag, it's the dir the user meant).
    if (pendingAddDir) { pendingAddDir = false; out.addDir.push(a); continue; }
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
    else if (a.startsWith('--agent=')) out.agent = a.slice('--agent='.length);
    else if (a.startsWith('--role=')) out.role = a.slice('--role='.length);
    else if (a.startsWith('--feature=')) out.feature = a.slice('--feature='.length);
    else if (a.startsWith('--workspace=')) out.workspace = a.slice('--workspace='.length);
    else if (a.startsWith('--harness=')) out.harness = a.slice('--harness='.length);
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
      out.model = normalizeModelSpec(rawModel);
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
    // su-context-size-variants: 'full' | 'trimmed' — the initial-context size variant
    // (orthogonal to --agent). Forwarded to bootstrap-su; applied per-client at launch.
    else if (a.startsWith('--context-size=')) out.contextSize = a.slice('--context-size='.length);
    // context-trimming-tiers P-017: persona tier — full | fleet. Omitted ⇒ the
    // server auto-selects from the model window (≤200k known model → fleet).
    else if (a.startsWith('--persona-tier=')) out.personaTier = a.slice('--persona-tier='.length);
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
    // client-side (chooseResumeAccount) for an in-place resume. Fail-soft to the default credential
    // when the gateway is off or the id is unknown/disallowed.
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
  }
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
 *     (`-c model_reasoning_effort="high"`, `max` clamped to codex's `xhigh` —
 *     mirrors applyRoleModel in harness-invoke-once.ts). A verbatim suffixed
 *     spec would set an unknown MODEL and silently drop the effort — the same
 *     effort-drop class the claude branch fixed (2026-07-01), found for codex
 *     launching the backlog-clearance fleet (2026-07-03).
 *   - omp: understands the `<model>[:<effort>]` spec natively → verbatim.
 */
export function modelArgsFor(agent, model) {
  if (!model) return [];
  const m = /^(.+):(low|medium|high|xhigh|max)$/.exec(model);
  if (agent === 'codex') {
    if (m) {
      const codexEffort = m[2] === 'max' ? 'xhigh' : m[2];
      return ['-m', m[1], '-c', `model_reasoning_effort="${codexEffort}"`];
    }
    return ['-m', model];
  }
  if (agent === 'claude' && m) return ['--model', m[1], '--effort', m[2]];
  return ['--model', model];
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
export function roleLaunchArgs(backend, { promptFile, mcpJsonPath, coordExtPath, nativeSessionId, replaceClaudeBase, allowSubagents } = {}) {
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
        // Subagent-launch (Task/Agent) is DENIED BY DEFAULT (owner mandate
        // 2026-07-02) — a role/bee never fans out via its own subagent tool
        // unless the launch explicitly opts in (`--allow-subagents`). See
        // NO_SUBAGENTS_DENY_FLAG's doc comment.
        ...(allowSubagents ? [] : [NO_SUBAGENTS_DENY_FLAG]),
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
    ];
    if (coordExtPath) args.push('-e', coordExtPath);
    return { bin: 'omp', args };
  }
  if (backend === 'codex') {
    // CODEX_HOME (with AGENTS.md + role-scoped config.toml + lock-hook
    // settings.json) is supplied via envelopeEnv.
    // --dangerously-bypass-hook-trust runs the home's SU-locks hooks (P-030;
    // the only hooks there are ours). The approvals/sandbox bypass remains the
    // managed-launch default until the current Codex MCP-under-sandbox path has
    // a live Papercusp smoke; the orchestrator fleet path wraps Codex externally.
    return { bin: 'codex', args: ['--dangerously-bypass-hook-trust', '--dangerously-bypass-approvals-and-sandbox'] };
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
export function suLaunchArgs(backend, { promptFile, coordExtPath, nativeSessionId, replaceClaudeBase, allowSubagents } = {}) {
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
export function resumeArgsFor(session, { coordExtPath, fork = false, forkSessionId = null, addDir = [], allowSubagents, model = null } = {}) {
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
    return { bin: 'claude', args: [...resume, '--dangerously-skip-permissions', '--permission-mode', 'bypassPermissions', ...(allowSubagents ? [] : [NO_SUBAGENTS_DENY_FLAG]), ...forkFlag, ...addDirArgs('claude', addDir), ...modelArgsFor('claude', model)] };
  }
  if (session.agent === 'omp') {
    const args = session.ompThreadId ? ['-r', session.ompThreadId] : ['-c'];
    args.push('--approval-mode', 'yolo');
    if (coordExtPath) args.push('-e', coordExtPath);
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

function trackedCodexSessionsRoot(session, home = homedir()) {
  if (session.id == null) return null;
  return join(home, '.papercusp', 'su-codex-homes', `session-${session.id}`, 'sessions');
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
    const isoRoot = sessionClaudeRoot(home);
    for (const owner of safeReaddir(isoRoot)) {
      if (!owner.isDirectory()) continue;
      const configDir = join(isoRoot, owner.name);
      const projects = join(configDir, 'projects');
      for (const d of safeReaddir(projects)) {
        if (!d.isDirectory()) continue;
        const f = join(projects, d.name, `${id}.jsonl`);
        if (existsSync(f)) return { agent: 'claude', sessionId: id, cwd: cwdFromSessionFile(f) || cwd, untracked: true, configDir };
      }
    }
    const codexRollout = findCodexRollout(join(home, '.codex', 'sessions'), id);
    if (codexRollout) return { agent: 'codex', sessionId: id, cwd: cwdFromSessionFile(codexRollout) || cwd, untracked: true };
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
export function mintRecycleArgs(args = [], { mintId = () => randomUUID() } = {}) {
  const src = args.map((a) => String(a ?? ''));
  const hasSessionId = src.some((a) => a === '--session-id' || a.startsWith('--session-id='));
  if (!hasSessionId) return { args, nativeId: null };
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
    out.push(a);
  }
  return { args: out, nativeId: freshId };
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
 *   - codex + known sessionId + adv row id → the per-session CODEX_HOME must
 *     hold the rollout file; without a row id there is no home to check — keep.
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
    if (!session.sessionId || session.id == null) return true;
    const sessionsRoot = trackedCodexSessionsRoot(session, home);
    return Boolean(findCodexRollout(sessionsRoot, session.sessionId));
  }
  return true;
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
  const marker = session.agent === 'codex' ? '"turn_context"' : '"assistant"';
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line.includes(marker) || !line.includes('"model"')) continue; // cheap prefilter
    try {
      const o = JSON.parse(line);
      const m =
        session.agent === 'codex'
          ? (o?.type === 'turn_context' ? o?.payload?.model : null)
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
 * `mcp.discoveryMode`). A ROLE session (console-launch `doSpawn` / a fleet role)
 * writes a SIGNED role-scoped `.mcp.json` there and never removes it — it spawns a
 * DETACHED, unref'd terminal with no exit hook — so a later SU omp launch in the
 * same cwd inherits the stale role server (a per-role MCP host URL, e.g. :9071) and
 * hangs ~30s on "papercusp timed out". An SU session needs only the USER-LEVEL
 * papercusp-su, never a role `.mcp.json`, so PARK a role-scoped one before launch.
 * No restore: role launchers recreate `.mcp.json` fresh on their next launch (they
 * back up any existing one first), so parking is safe. Role-scoped is detected by a
 * signed-role URL (`role=` query param); the SU's own papercusp-su carries
 * `superuser=1`, never `role=`. Returns the parked path, or null when nothing was
 * parked. Side-effects fs only; exported for tests.
 */
export function parkRoleScopedMcpJson(cwd) {
  if (!cwd) return null;
  const p = join(cwd, '.mcp.json');
  if (!existsSync(p)) return null;
  let roleScoped = false;
  try {
    const data = JSON.parse(readFileSync(p, 'utf8'));
    const servers =
      data && data.mcpServers && typeof data.mcpServers === 'object' ? Object.values(data.mcpServers) : [];
    roleScoped = servers.some(
      (s) => s && typeof s.url === 'string' && /[?&]role=/.test(s.url) && !/[?&]superuser=1(?:&|$)/.test(s.url),
    );
  } catch {
    // Unparseable .mcp.json — leave it untouched (don't park what we can't classify).
    return null;
  }
  if (!roleScoped) return null;
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
  // canonical list — 47 calls/7d; a coord:send reply covers it.)
  'coord:orient', 'coord:inbox', 'coord:send', 'coord:glance', 'coord:ask',
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
  // (work_items:update cut 2026-07-05 — 104 calls/7d; set_state + comment cover it.)
  'work_items:claim_next', 'work_items:get', 'work_items:complete',
  'work_items:release', 'work_items:set_state',
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
  'facts:assert', 'facts:list',
  // loop:arm joins loop:checkpoint (2026-07-05): checkpoint was in the spine while the
  // verb that CREATES the loop was not (253 fallback reaches/7d).
  // loop:status + loop:end join (2026-07-07, EI-8597 canonical-core catch-up): the
  // wind-down half of the loop lifecycle — discovery can miss them, so a seeded worker
  // must be able to inspect/stop its own loop without depending on tools:find.
  'work_items:checkpoint', 'loop:arm', 'loop:checkpoint', 'loop:status', 'loop:end',
  // Event-wait lifecycle (fleet-member-dx-improvements-2026-07-10 P-008): keep the
  // seeded OMP spine aligned with the canonical event sleep/emit/catalog verbs.
  'events:await', 'events:emit', 'events:catalog',
  // EI-6770: without this, an agent nearing its compaction limit self-halts instead of
  // compacting cleanly ("no compaction tool available"), losing in-flight work.
  'session:request-compaction',
  // fleet:launch-on-plan IS in the omp spine (it is NOT in the generic orchestrator
  // CORE): the AUTO-off routing gate offers a weak model "(C) launch a fleet", but the
  // whole fleet:* group is otherwise hidden, so option C was UN-EXECUTABLE — the model
  // narrated "I'm launching now" then silently fell back to work_items:* and did the
  // work itself (session 9870). A weak model does NOT bridge to a hidden tool via
  // tools:find, so the one verb that makes option C real must be advertised up-front.
  'fleet:launch-on-plan',
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
 *  "doesn't exist" (the EI-9011 poll-degradation). Exported for tests. */
export const CLAUDE_SEED_EXTRA_TOOL_NAMES = ['locks:acquire', 'locks:release', 'locks:list'];
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
const OMP_LOCAL_MODEL_PREFIXES = ['ollama/', 'local/', 'llamacpp/', 'llama.cpp/', 'lmstudio/', 'localai/'];
export function isWeakOmpModel(modelId) {
  if (!modelId) return false;
  const id = String(modelId).trim().toLowerCase();
  if (!id) return false;
  return OMP_LOCAL_MODEL_PREFIXES.some((p) => id.startsWith(p));
}

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
 *   opts.discoveryOff   → flip OMP tool-discovery OFF (contextSize:'full' — whole catalog up-front
 *                         for a capable model).
 *   opts.toolsAllowlist → advertise ONLY these MCP tools (weak-model trim; listing-only, the rest
 *                         stay callable via tools:find).
 *
 * Returns the home-relative dir, or null on any failure (caller falls back to OMP's native default
 * — no regression). Exported for tests.
 */
export function writeOmpSessionConfigDir(sessionId, opts = {}, home = homedir()) {
  const { discoveryOff = false, toolsAllowlist = null, operatorUrl = OPERATOR_URL, model = null, clientId = null } = opts;
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
    writeFileSync(join(dstAgent, 'config.yml'), cfg, { mode: 0o600 });
    // Faithful model registry + auth so model resolution + provider baseUrls survive the
    // relocation (the data root collapses onto the relocated configRoot; missing registry ⇒
    // "model not found"). Skip the big session/history dbs — a fresh session recreates them.
    for (const f of ['models.yml', 'models.json', 'models.db', 'auth.json', 'claude-bridge.json', 'config.json', 'SYSTEM.md']) {
      const s = join(srcAgent, f);
      if (existsSync(s)) cpSync(s, join(dstAgent, f));
    }
    // mcp.json — carry the papercusp-su server (else the relocated session has NO MCP at all),
    // optionally trimming its advertised surface to the core spine for a weak model.
    const srcMcp = join(srcAgent, 'mcp.json');
    if (existsSync(srcMcp)) {
      let mcpText = readFileSync(srcMcp, 'utf8');
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
    };
  }
  return {
    PAPERCUSP_AGENT: session.agent,
    PAPERCUSP_SID: session.coordOwnerId || mintSid(),
    ...(session.workspaceId ? { PAPERCUSP_WORKSPACE: session.workspaceId } : {}),
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
    ...(accountEnv?.env ?? {}),
  };
}

/** The per-account routing header the inference gateway reads + the claude CLI forwards (via
 *  ANTHROPIC_CUSTOM_HEADERS). MUST equal the server's `ACCOUNT_HEADER` (gateway.ts) — pinned in
 *  lockstep by a test. Duplicated here (not imported) so the standalone launcher stays dependency-light. */
export const GATEWAY_ACCOUNT_HEADER = 'x-papercusp-account';

/**
 * The inference-gateway pin env for an account, built CLIENT-SIDE. Pure — exported for tests. Mirrors
 * the server's gatewaySpawnEnv + resolveAccountPin exactly: point the agent at the localhost gateway
 * (which injects the account's OAuth) + carry the per-account routing header the claude CLI forwards.
 * The fresh-launch path gets this folded by the bootstrap-su POST; the RESUME path (no POST) builds it
 * here so it never depends on a server endpoint that may not be deployed where the launcher points.
 */
export function gatewayPinEnv(account, provider = 'claude') {
  if (provider === 'codex') {
    return { PAPERCUSP_ACCOUNT_ID: account };
  }
  const p = Number(process.env.PAPERCUSP_GATEWAY_PORT);
  const port = Number.isFinite(p) && p > 0 ? p : 8788;
  return {
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`,
    ANTHROPIC_CUSTOM_HEADERS: `${GATEWAY_ACCOUNT_HEADER}: ${account}`,
    PAPERCUSP_ACCOUNT_ID: account,
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

/**
 * The inference-gateway AUTO-route env, built CLIENT-SIDE. Pure — exported for tests. Mirrors the
 * server's gatewaySpawnEnv(true, {}) for the no-account case: point the agent at the localhost
 * gateway with NO `x-papercusp-account` header, so the gateway auto-selects an available pool
 * account and fails over. Auto-routing is wired for claude only today (codex/omp route per-session
 * config keyed off an EXPLICIT account id, so there is no "let the gateway pick" form for them) —
 * returns `{}` for any other provider, matching resolveAccountPin's `auto gateway routing isn't
 * wired for <agent> yet` guard.
 */
export function gatewayAutoEnv(provider = 'claude') {
  if (provider !== 'claude') return {};
  const p = Number(process.env.PAPERCUSP_GATEWAY_PORT);
  const port = Number.isFinite(p) && p > 0 ? p : 8788;
  return { ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}` };
}

function tomlEscape(s) {
  return String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

export function codexGatewayConfigPatch(configText, account) {
  const providerId = 'papercusp-codex-gateway';
  const p = Number(process.env.PAPERCUSP_GATEWAY_PORT);
  const port = Number.isFinite(p) && p > 0 ? p : 8788;
  const strip = (text) =>
    text
      .replace(/# BEGIN PAPERCUSP_CODEX_GATEWAY_ROOT\n[\s\S]*?# END PAPERCUSP_CODEX_GATEWAY_ROOT\n?/g, '')
      .replace(/# BEGIN PAPERCUSP_CODEX_GATEWAY_PROVIDER\n[\s\S]*?# END PAPERCUSP_CODEX_GATEWAY_PROVIDER\n?/g, '')
      .replace(/^\n+/, '');
  const root = [
    '# BEGIN PAPERCUSP_CODEX_GATEWAY_ROOT',
    '# Route Codex model traffic through the Papercusp inference gateway account pin.',
    `model_provider = "${providerId}"`,
    '# END PAPERCUSP_CODEX_GATEWAY_ROOT',
    '',
  ].join('\n');
  const table = [
    '# BEGIN PAPERCUSP_CODEX_GATEWAY_PROVIDER',
    `[model_providers.${providerId}]`,
    'name = "Papercusp Codex Gateway"',
    `base_url = "http://127.0.0.1:${port}/v1"`,
    'wire_api = "responses"',
    'experimental_bearer_token = "papercusp-gateway"',
    `http_headers = { "x-papercusp-account" = "${tomlEscape(account)}" }`,
    '# END PAPERCUSP_CODEX_GATEWAY_PROVIDER',
    '',
  ].join('\n');
  const stripped = strip(configText || '');
  return `${root}${stripped.trimEnd()}\n\n${table}`;
}

function applyCodexGatewayPin(codexHome, account) {
  const configPath = join(codexHome, 'config.toml');
  const current = existsSync(configPath) ? readFileSync(configPath, 'utf8') : '';
  writeFileSync(configPath, codexGatewayConfigPatch(current, account), { mode: 0o600 });
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
export function applyDefaultClaudeOAuthToken(wrapperBin, env, { home = homedir() } = {}) {
  if (!/(^|\/)claude(-su)?$/.test(String(wrapperBin || ''))) return env;
  if (env.ANTHROPIC_BASE_URL) return env;
  if (env.CLAUDE_CODE_OAUTH_TOKEN || env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN) return env;
  const tok = readStoredClaudeOAuthToken({ home });
  if (tok) env.CLAUDE_CODE_OAUTH_TOKEN = tok;
  return env;
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
    throw new Error(msg);
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
export const SU_BASELINE_NON_PERSONA_TOKENS = { full: 152_000, trimmed: 50_000 };

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
 * named-fleet MEMBERS at 300k (owner directive 2026-07-03; agent-config-constants
 * defaultCompactionLimitForSpec) — to bound token spend.
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

/**
 * The `[1m]` SOFT compaction limits — LOCKSTEP with agent-config-constants
 * `COMPACTION_LIMIT_DEFAULT_1M_CAP` (leader/solo) + `COMPACTION_LIMIT_DEFAULT_1M_FLEET_MEMBER_CAP`
 * (named-fleet member), duplicated here because this standalone .mjs cannot import the .ts
 * (same reason DEFAULT_1M_FAMILY_RE mirrors `isDefault1mModelSpec`). Keep the two in sync.
 */
export const COMPACTION_LIMIT_1M_LEADER = 400_000;
export const COMPACTION_LIMIT_1M_FLEET_MEMBER = 300_000;

/**
 * P-014 (agent-managed-compaction-2026-07-01) — the L2.5 MECHANICAL compaction backstop.
 * Returns the env fragment setting Claude Code's native `CLAUDE_CODE_AUTO_COMPACT_WINDOW`
 * so CC ITSELF force-compacts a fully-unresponsive `[1m]` session at ~120% of its papercusp
 * SOFT limit, instead of drifting toward the 967k–1M model window (the 2026-07-04 incident:
 * sonnet[1m] fleet members ran to 836k because CC's own auto-compact on a 1M window sits near
 * ~758k — far above their 300k soft limit — so nothing mechanical ever caught the ones that
 * ignored every reminder + the watchdog). `{}` for non-claude, and for any spec WITHOUT `[1m]`:
 * a ≤200k session already has a natural CC backstop (~144–167k) just below its ~158k soft
 * limit, and forcing a smaller window there would only fire EARLIER than papercusp's own clean
 * cut. A null/absent spec (no --model → CLI default) also gets nothing — we set it ONLY when we
 * KNOW the session runs the 1M window.
 *
 * WINDOW MATH — verified against the CC 2.1.x binary, NOT the naive "window == fire point":
 * CC auto-compacts when usedTokens ≥ round((window − 20000) × (1 − f)) — output reserve 20000
 * (`a5l`), default precompute-buffer fraction f = 0.20 (`w3o`; the statsig table
 * `tengu_amber_moleskin` that could vary f is OFF here). So nominal fire ≈ 0.8 × (window − 20000).
 * To land that fire point on the sanctioned overshoot envelope softLimit × 1.2
 * (COMPACTION_OVERSHOOT_FACTOR) we INVERT: 0.8 × (W − 20000) = 1.2 × softLimit ⟹
 * W = 1.5 × softLimit + 20000. Worst case (f→0, e.g. a future statsig flip) fires at
 * W − 20000 = 1.5 × softLimit — still a real backstop far below the 1M window: it fails SAFE
 * (a touch late, never never-fires). CC clamps the value to [1e5, 1e6]; we clamp too so the
 * intent is explicit. A per-session config:set-compaction-limit override taken LATER is not
 * reflected here (launch-time default only) — the watchdog (P-012/P-017) covers live-config.
 */
export function autoCompactWindowEnv(agent, spec, { fleetMember = false } = {}) {
  if (agent !== 'claude') return {};
  if (!/\[1m\]/i.test(String(spec ?? ''))) return {};
  const softLimit = fleetMember ? COMPACTION_LIMIT_1M_FLEET_MEMBER : COMPACTION_LIMIT_1M_LEADER;
  const window = Math.min(1_000_000, Math.max(100_000, Math.round(softLimit * 1.5 + 20_000)));
  return { CLAUDE_CODE_AUTO_COMPACT_WINDOW: String(window) };
}

/** True for a named-fleet MEMBER launch (fleet present, role not leader) — shapes the [1m]
 *  soft-limit leg exactly like agent-config-constants `defaultCompactionLimitForSpec` opts.fleetMember. */
export function isFleetMemberLaunch(args) {
  return !!args?.fleet && args?.fleetRole !== 'leader';
}

/** The canonical BARE cloud model aliases psu recognizes. Short + lowercase. The CLI/gateway own
 *  the full OPEN set of ids, so this list is used ONLY to spot an obviously-misspelled short alias
 *  (validateModelSpec) — never to gate full/provider ids. */
export const KNOWN_CLOUD_ALIASES = ['opus', 'sonnet', 'haiku', 'fable'];

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
  const aliasVer = core.toLowerCase().match(/^(opus|sonnet|haiku|fable)(?=[-.]?[0-9])/);
  if (aliasVer) {
    const fam = aliasVer[1];
    return {
      ok: false,
      message:
        `\`${s}\` is not a recognized model spec. Did you mean \`${effort ? `${fam}:${effort}` : fam}\`? ` +
        `Type the BARE alias (${KNOWN_CLOUD_ALIASES.join('/')}) — psu resolves it to the latest generation, appending the [1m] 1M-context window — ` +
        `not a versioned shorthand; pin a specific generation only as a full id (e.g. claude-${fam}-5).`,
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
export function preflightWindowGuard({ personaBytes, contextSize, model }) {
  const spec = String(model ?? '');
  const window = /\[1m\]/i.test(spec) || DEFAULT_1M_FAMILY_RE.test(spec) ? 1_000_000 : 200_000;
  const personaTokens = Math.round((personaBytes ?? 0) / 3.7);
  const variant = contextSize === 'full' ? 'full' : 'trimmed';
  const estTokens = personaTokens + SU_BASELINE_NON_PERSONA_TOKENS[variant];
  const pct = estTokens / window;
  const level = pct >= 0.6 ? 'refuse' : pct >= 0.35 ? 'warn' : 'ok';
  return { level, pct, estTokens, window };
}

/** Run both preflight guards before a launch; exits/throws per policy. */
export function runLaunchPreflight({ promptFile, contextSize, model, force }) {
  const personaBytes = assertLaunchPersona(promptFile);
  const guard = preflightWindowGuard({ personaBytes, contextSize, model });
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
 * error (fail-soft — the account step never blocks a launch). The "default" row is
 * FIRST so hitting enter keeps today's behavior; accounts blocked by the active
 * session-override are shown disabled (the server would reject them anyway).
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

/** Render the account picker from already-fetched choices. Returns the chosen id, or null for
 *  "default credential — no pin" / an empty pool (gateway off). */
async function promptAccount(accounts) {
  const pool = Array.isArray(accounts?.pool) ? accounts.pool : [];
  // psu-account-chooser: ALWAYS show the picker (at least the default option) so
  // the choice is consistent across machines — a fresh install with no gateway
  // pool still gets the "default = system/CLI login" row, instead of silently
  // skipping the screen the dev box shows. (Was: hidden when pool empty.)
  const exclude = new Set(accounts?.excludeAccounts ?? []);
  const forced = new Set(accounts?.forcedAccounts ?? []);
  // account-routing-3-options: the 'auto' (gateway auto-route + failover) row is offered only when
  // the gateway pool is usable AND the provider supports it (claude — gatewayAutoEnv / resolveAccountPin
  // don't wire auto for codex/omp yet). Its value `'auto'` flows through accountRoutingMode → 'auto'.
  const provider = accounts?.provider ?? 'claude';
  const showAuto = pool.length > 0 && provider === 'claude';
  const { select } = await import('@inquirer/prompts');
  const choices = [
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
 * No prompt + no env when the gateway is off / pool empty / scripting (`--no-picker`).
 */
async function chooseResumeAccount(session, args) {
  const plan = resumeAccountPlan(args);
  if (plan.source === 'none') return { id: null, env: {}, notice: null }; // --no-picker + no --account

  // account-routing-3-options: the `default` keyword (or '' / none / system) is resolved by NAME —
  // it deliberately skips the gateway, so it needs no pool fetch. (The picker path resolves its
  // keyword AFTER fetching the choices, below.)
  if (!plan.prompt && accountRoutingMode(plan.account) === 'default') {
    return { id: null, env: {}, notice: 'using the default system account (inference gateway skipped).' };
  }

  const accounts = await fetchAccountChoices(session.workspaceId, session.agent);
  if (!accounts?.gatewayOn || !(Array.isArray(accounts.pool) && accounts.pool.length)) {
    // Gateway off / empty pool → both `auto` and a pool pin collapse to the default-credential resume.
    return {
      id: null,
      env: {},
      notice: plan.account ? `--account ${plan.account} ignored: inference gateway off / no pool — using the default credential.` : null,
    };
  }

  const requested = plan.prompt ? await promptAccount(accounts) : plan.account;
  const mode = accountRoutingMode(requested);
  if (mode === 'default') return { id: null, env: {}, notice: requested ? 'using the default system account (inference gateway skipped).' : null };

  const provider = accountProviderFromChoices(accounts, session.agent);

  if (mode === 'auto') {
    // Route through the gateway with NO pin — it selects an available account + fails over.
    // Wired for claude only (gatewayAutoEnv returns {} otherwise); codex/omp have no "let the
    // gateway pick" form, so fall back to the default credential with a clear notice.
    if (provider !== 'claude') {
      return { id: null, env: {}, notice: `--account auto ignored: gateway auto-routing isn't wired for ${session.agent} yet — using the default credential.` };
    }
    // `forward: 'auto'` is the value a TRACKED fork sends to the server (resolveAccountPin) so the
    // fork re-derives the same auto-route — `id` is null here, so the fork's `id` fallback alone
    // would silently drop the choice.
    return { id: null, auto: true, forward: 'auto', provider, env: gatewayAutoEnv(provider), notice: 'routing through the inference gateway (auto — it selects an available pool account and fails over).' };
  }

  // mode === 'pin'
  const id = requested;
  if (!accountPinnable(accounts, id)) {
    return { id: null, env: {}, notice: `--account ${id} ignored: not an allowed pool account — using the default credential.` };
  }
  if (!provider) {
    return { id: null, env: {}, notice: `--account ${id} ignored: account routing is unsupported for ${session.agent} — using the default credential.` };
  }
  return { id, provider, env: gatewayPinEnv(id, provider), notice: `pinned to ${provider === 'codex' ? 'Codex ' : ''}account ${id} (routed through the inference gateway).` };
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

/** The settings.json a claude launch will actually read: the per-session isolated
 *  CLAUDE_CONFIG_DIR when psu pinned one (EI-155), else the shared user-level dir. */
function effectiveClaudeSettingsPath(env, home = homedir()) {
  const dir = (env.CLAUDE_CONFIG_DIR ?? '').trim();
  return join(dir || join(home, '.claude'), 'settings.json');
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
 * Exported with injectables for tests (scripts/__tests__).
 */
export const SUPERVISOR_BEAT_MS = 60_000;
export function startSupervisorBeat(
  ownerId,
  { fetchImpl = fetch, intervalMs = SUPERVISOR_BEAT_MS, operatorUrl = OPERATOR_URL, token = null, setIntervalImpl = setInterval } = {},
) {
  if (!ownerId) return null;
  const beat = async () => {
    try {
      const tok = token ?? readToken();
      await fetchImpl(operatorUrl + '/api/agent-mcp/console/bootstrap-su/heartbeat', {
        method: 'POST',
        signal: AbortSignal.timeout(5_000),
        headers: {
          'content-type': 'application/json',
          ...(tok ? { authorization: `Bearer ${tok}` } : {}),
        },
        body: JSON.stringify({ ownerId }),
      });
    } catch {
      /* missed beat — the next tick retries; never surface */
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
 */
export async function reportSessionEnded(
  advSessionId,
  exitCode,
  { fetchImpl = fetch, operatorUrl = OPERATOR_URL, token = null, timeoutMs = 2_000 } = {},
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
      body: JSON.stringify({ advSessionId: Number(advSessionId), exitCode: exitCode ?? null }),
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
 *  lifecycle vars above (never touches any PAPERCUSP_ variable, nor a PATH
 *  entry the caller explicitly sets after this runs) and PATH segments
 *  naming the release checkout, which an interactive agent session never
 *  legitimately needs. */
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
  return out;
}

/** The original plain launch: inherit the user's stdio straight into the child.
 *  The fallback when the managed-pty host is disabled, has no TTY, or fails to
 *  start. */
function spawnInherit({ wrapperBin, args = [], cwd, env }) {
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
  const child = spawn(wrapperBin, args, { cwd, env, stdio: 'inherit' });
  child.on('error', (e) => {
    console.error(`psu: failed to launch ${wrapperBin}: ${e.message}`);
    console.error(`psu: is ${wrapperBin} on PATH? run apps/operator/scripts/install-standalone-mcp.sh`);
    process.exit(127);
  });
  child.on('exit', (code, signal) => {
    void reportSessionEnded(env.PAPERCUSP_ADV_SESSION_ID || null, code).finally(() => {
      if (signal) process.kill(process.pid, signal);
      else process.exit(code ?? 0);
    });
  });
}

function runWrapper({ wrapperBin, args = [], cwd, envelopeEnv }) {
  const env = { ...sanitizeInheritedEnv(process.env), ...envelopeEnv };
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
  // The GitHub Copilot MCP plugin (a Claude plugin OMP also discovers) needs
  // GITHUB_PERSONAL_ACCESS_TOKEN; unset → "Authorization header is badly formatted" (HTTP 400) on
  // every claude/omp launch. Export the gh CLI token when unset (verified it authenticates the MCP).
  applyGithubTokenEnv(env);
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
  startSupervisorBeat(ownerId);
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
        onRespawn: (freshId) =>
          recordSessionOwner(freshId, ownerId, { advSessionId: env.PAPERCUSP_ADV_SESSION_ID || null }),
        onExit: (code) => {
          void reportSessionEnded(env.PAPERCUSP_ADV_SESSION_ID || null, code).finally(() =>
            process.exit(code ?? 0),
          );
        },
      }).catch((e) => {
        // The pty was already spawned (the promise only rejects on an unforeseen
        // bridge error); don't double-spawn — surface + exit non-zero.
        process.stderr.write(`psu: managed-pty host error: ${e?.message ?? e}\n`);
        process.exit(1);
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
  spawnInherit({ wrapperBin, args, cwd, env });
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
function launchResume(session, { brain = false, fork = false, passthrough = [], addDir = [], accountEnv = null, allowSubagents, model = null } = {}) {
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
      console.error(
        `psu: this session (${session.coordOwnerId}) is STILL LIVE in another window (host pid ${live.pid}).\n` +
          `psu: resuming it here would boot a second host on the same identity and strand the live one.\n` +
          `psu: use that window, run alongside it with --fork, or set PSU_FORCE_RESUME=1 to take over anyway.`,
      );
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
  const { bin, args } = resumeArgsFor(session, { coordExtPath, fork, addDir, allowSubagents, model });
  if (brain && session.agent === 'claude') args.push(NATIVE_SCHEDULER_DENY_FLAG);
  // Generic `--` passthrough, forwarded verbatim after psu's own resume flags.
  if (passthrough.length) args.push(...passthrough);

  // Identity + workspace scope survive the resume (see resumeEnvFor) — except a
  // FORK, which deliberately takes a fresh coord identity + no adv-row link so it
  // can run alongside the still-live original it branched from. `accountEnv` re-pins
  // the inference-gateway account (spawn-env only, otherwise lost on resume); the
  // agent-session marker arms the hook-level scheduler guard (bash gate / omp
  // coord-hook) for the brain only — never the owner's own sessions (D-003).
  const env = buildResumeEnv(session, { fork, brain, accountEnv });
  // EI-155: a claude session launched with per-session transcript isolation wrote
  // its transcript under an isolated CLAUDE_CONFIG_DIR (keyed by coord owner id),
  // NOT the shared ~/.claude — point the resume back at it or `claude --resume
  // <uuid>` finds "No conversation found". `session.configDir` (an untracked
  // isolated session resolved by findUntrackedSession) wins; else derive from the
  // tracked row's coordOwnerId. Only when it exists — sessions launched before
  // EI-155 used the shared store and want no override.
  if (session.agent === 'claude') {
    const dir = session.configDir
      || (session.coordOwnerId ? sessionClaudeConfigDir(session.coordOwnerId) : null);
    if (dir && existsSync(dir)) env.CLAUDE_CONFIG_DIR = dir;
  }
  // codex resumes from its per-session CODEX_HOME — derived from the session id
  // (that home still holds the session's history; only re-launching the SAME
  // session rebuilds it). The home's config.toml carries the baked superuser
  // bearer, so no PAPERCUSP_SU_TOKEN is needed.
  if (session.agent === 'codex' && session.id != null) {
    env.CODEX_HOME = join(homedir(), '.papercusp', 'su-codex-homes', `session-${session.id}`);
  }
  if (session.agent === 'codex' && accountEnv?.provider === 'codex' && accountEnv?.id && env.CODEX_HOME) {
    applyCodexGatewayPin(env.CODEX_HOME, accountEnv.id);
  }

  // Surface whether the account re-pin took effect (or the fail-soft reason it
  // was skipped) so a resume is never silently unpinned — mirrors launchFreshSu.
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
  runWrapper({ wrapperBin: bin, args, cwd: session.cwd, envelopeEnv: env });
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
  const argv = ['psu', '--no-picker', `--agent=${selections.agent}`];
  if (selections.workspace) argv.push(`--workspace=${selections.workspace}`);
  if (selections.harness) argv.push(`--harness=${selections.harness}`);
  argv.push(selections.plan ? `--plan=${selections.plan}` : '--no-plan');
  if (args.profile) argv.push(`--profile=${args.profile}`);
  if (args.contextSize) argv.push(`--context-size=${args.contextSize}`);
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
    cwd: process.cwd(),
  };
}

export function roleBootstrapBody({ role, agent, workspace, harness, feature, plan, account, fleet, fleetRole, fleetName, fleetScheme } = {}) {
  return {
    role,
    agent,
    workspace,
    harness_slug: harness,
    feature,
    plan,
    ...(account ? { account } : {}),
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
export function trackedForkEnvelopeEnv(bootstrapEnvelopeEnv) {
  return { ...bootstrapEnvelopeEnv, PAPERCUSP_AGENT_SESSION: '1' };
}

async function launchTrackedFork(session, args = {}, acct = { id: null, env: {}, notice: null }, model = null) {
  // The account re-pin: a TRACKED fork folds it server-side (forkBootstrapBody →
  // resolveAccountPin), like a fresh launch; an UNTRACKED fallback re-pins client-
  // side via accountEnv (it never hits bootstrap-su).
  const forkOpts = {
    fork: true,
    passthrough: args.passthrough,
    addDir: args.addDir,
    accountEnv: { env: acct?.env ?? {}, notice: acct?.notice ?? null },
    allowSubagents: args.allowSubagents,
    model,
  };
  const forkable = session.agent === 'claude' && session.sessionId && session.coordOwnerId && session.id != null;
  if (!forkable) {
    // Untracked claude (no adv row) → the plain untracked fork; non-claude →
    // launchResume refuses with a clear message. Either way defer to launchResume.
    launchResume(session, forkOpts);
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
    launchResume(session, forkOpts);
    return;
  }
  const forkId = res?.nativeSessionId || null;
  const forkConfigDir = res?.envelopeEnv?.CLAUDE_CONFIG_DIR || null;
  if (!forkId || !forkConfigDir) {
    console.error('psu: fork bootstrap returned no native id / config dir — falling back to an UNTRACKED fork (resumable only by uuid).');
    launchResume(session, forkOpts);
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
  // Surface the account pin outcome the POST resolved (fold or fail-soft reason).
  if (res.accountNotice) console.error(`psu: account — ${res.accountNotice}`);
  // Run in the ORIGINAL's cwd (the seeded transcript is keyed by it); the fresh
  // bootstrap envelope (config dir / coord id / MCP) makes it a proper SU session
  // — trackedForkEnvelopeEnv folds in the agent-session marker bootstrap-su omits.
  runWrapper({ wrapperBin: bin, args: forkArgs, cwd: session.cwd, envelopeEnv: trackedForkEnvelopeEnv(res.envelopeEnv) });
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
async function chooseResumeModel(session, args) {
  let last = null;
  try {
    last = lastActiveModelFor(session);
  } catch { /* a transcript we can't read only costs the announce */ }
  if (last) console.error(`psu: last active model in this session: ${last}`);
  if (args.model) return args.model;
  if (!args.picker) return null;
  const { select, input } = await import('@inquirer/prompts');
  // "Keep" passes the recorded id back through normalizeModelSpec so a
  // default-1M family (fable/opus/sonnet-5) keeps its 1M window on the resume
  // — the raw id alone would silently drop to the 200k auto-compact window.
  const picked = await select({
    message: 'Model for the resumed session?',
    choices: [
      ...(last ? [{ name: `Keep last active — ${last}`, value: normalizeModelSpec(last) }] : []),
      { name: 'Agent default (no model flag)', value: null },
      { name: 'Choose a different model…', value: CHOOSE_MODEL },
    ],
  });
  if (picked !== CHOOSE_MODEL) return picked;
  const typed = await input({
    message: 'Model spec (<model>[:<effort>], e.g. fable:high):',
    validate: (v) => {
      if (!String(v ?? '').trim()) return true; // empty → agent default
      const r = validateModelSpec(String(v).trim());
      return r.ok ? true : r.message;
    },
  });
  const spec = String(typed ?? '').trim();
  return spec ? normalizeModelSpec(spec) : null;
}

/** WI-3859 F4: the archive-at-death lifecycle DELETES an ended session's
 *  transcript ~15s after end (it lives on in harness_shared.session_archives).
 *  The wake-executor rematerializes on ITS resume path, but a direct
 *  `psu --resume` reads the disk — so on a transcript miss, ask the operator
 *  to restore the files from the archive, then retry the disk lookup. Returns
 *  the API result or null; never throws (a miss just falls through to the
 *  existing not-found error, incl. against an older operator without the
 *  endpoint). */
async function tryRematerializeFromArchive(sessionId, sourceKind = null) {
  if (!sessionId) return null;
  try {
    const r = await api('/api/adv/sessions/rematerialize', {
      method: 'POST',
      body: JSON.stringify({ sessionId, ...(sourceKind ? { sourceKind } : {}) }),
    });
    if (!r?.ok) return null;
    console.error(
      `psu: transcript restored from the session archive (${r.sourceKind}, ${r.written} file(s) → ${r.root}).`,
    );
    return r;
  } catch {
    return null;
  }
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
        if (!restored || !sessionHasTranscript(tracked)) {
          console.error(
            `psu: session #${tracked.id} (${tracked.agent}${tracked.sessionId ? ` ${tracked.sessionId}` : ''}) ` +
              `has no persisted transcript — it died or was closed before its first message (and the session ` +
              `archive holds no copy), so there is no conversation to resume. Pick a different session with \`psu --resume\`.`,
          );
          process.exit(1);
        }
      }
      // Re-pin the gateway account (prompt when interactive / honor --account) —
      // the pin is spawn-env only, so a resume otherwise drops it (option 1).
      const acct = await chooseResumeAccount(tracked, args);
      // Show the last-active model + honor/prompt the one to resume with (WI-3758).
      const model = await chooseResumeModel(tracked, args);
      if (args.fork) { await launchTrackedFork(tracked, args, acct, model); return; }
      launchResume(tracked, { passthrough: args.passthrough, addDir: args.addDir, accountEnv: acct, allowSubagents: args.allowSubagents, model });
      return;
    }

    // 2. Not tracked → search the agents' OWN session stores for the id. On a
    //    miss, the transcript may be ARCHIVED (deleted from disk at session
    //    end) — restore it from the session archive and search again.
    let untracked = findUntrackedSession(args.resumeId);
    if (!untracked && (await tryRematerializeFromArchive(args.resumeId))) {
      untracked = findUntrackedSession(args.resumeId);
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
    await confirmUntrackedResume(untracked, args);
    // An untracked session has no adv row to seed a tracked fork from — fork it in
    // place (claude mints a random id; resumable only by uuid). launchResume handles it.
    // Account re-pin applies here too (a raw resume can be routed through the gateway).
    const acct = await chooseResumeAccount(untracked, args);
    const model = await chooseResumeModel(untracked, args);
    launchResume(untracked, { fork: args.fork, passthrough: args.passthrough, addDir: args.addDir, accountEnv: acct, allowSubagents: args.allowSubagents, model });
    return;
  }

  // Only offer sessions whose agent store actually holds a transcript — a row
  // recorded at launch whose session never persisted a first message is a
  // permanent ghost ("No conversation found" on every attempt). Say how many
  // were hidden so a "where did my session go?" has an answer.
  const resumable = sessions.filter((s) => sessionHasTranscript(s));
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
    return {
      name:
        `${s.id != null ? `#${s.id}  ·  ` : ''}${s.agent}${lastModel ? ` (${lastModel})` : ''}  ·  ${s.planSlug ? `plan ${s.planSlug}` : 'no plan'}  ·  ${s.cwd}  ·  ${fmtAge(s.startedAt)}` +
        `${s.endedAt ? '' : '  · active'}`,
      value: s,
    };
  });
  const picked = await search({
    message: 'Resume which session?',
    source: async (term) => filterRows(rows, term),
  });
  // Re-pin the gateway account (prompt when interactive / honor --account) before
  // resuming — the pin is spawn-env only, otherwise lost on resume (option 1).
  const acct = await chooseResumeAccount(picked, args);
  const model = await chooseResumeModel(picked, args);
  if (args.fork) { await launchTrackedFork(picked, args, acct, model); return; }
  launchResume(picked, { passthrough: args.passthrough, addDir: args.addDir, accountEnv: acct, allowSubagents: args.allowSubagents, model });
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
    body: JSON.stringify(roleBootstrapBody({ role, agent, workspace, harness, feature, plan, account, fleet: args.fleet, fleetRole: args.fleetRole, fleetName: args.fleetName, fleetScheme: args.fleetScheme })),
  });
  // WI-1408 (fleet-join-startup-assertion): a requested fleet must have actually
  // registered — see assertFleetJoined's doc comment.
  assertFleetJoined(args.fleet || args.fleetName, res);

  // omp role sessions load the coordination extension (lock enforcement + coord +
  // the activity-bridge port) via -e, the same stable module the su omp launch +
  // resume use. claude/codex role hooks are user-level / baked into the codex home.
  const roleCoordExt = join(homedir(), '.papercusp', 'papercusp-coord.ts');
  const roleCoordExtPath = res.agent === 'omp' && existsSync(roleCoordExt) ? roleCoordExt : undefined;
  // Launch preflight (context-trimming-tiers P-016/P-018): persona-append
  // assertion + window guard — fail loud BEFORE spawning a doomed session.
  try {
    runLaunchPreflight({ promptFile: res.promptFile, contextSize: args.contextSize, model: args.model, force: args.force });
  } catch (e) {
    console.error(e?.message ?? String(e));
    process.exit(1);
  }
  const { bin, args: launchArgs } = roleLaunchArgs(res.agent, {
    promptFile: res.promptFile,
    mcpJsonPath: res.mcpJsonPath,
    coordExtPath: roleCoordExtPath,
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
  });
  if (args.addDir?.length && res.agent === 'omp') {
    console.error('psu: omp has no --add-dir; ignoring it. Pass a backend flag verbatim with `-- <flag>` if omp supports one.');
  }
  // First-class --add-dir (claude/codex) + generic `--` passthrough, forwarded to the
  // backend CLI after psu's role flags — parity with the su (launchFreshSu) + resume paths.
  const roleArgs = [...launchArgs, ...addDirArgs(res.agent, args.addDir || []), ...(args.passthrough || [])];
  console.error(
    `psu: ${res.role} on ${res.agent}  ·  ${res.feature ? `feature ${res.feature}` : (res.planSlug ? `plan ${res.planSlug}` : 'no feature')}` +
      `  ·  ${res.harnessSlug ? `harness ${res.harnessSlug}` : 'workspace-level (no harness)'}  ·  session ${res.sessionId ?? '?'}`,
  );
  if (res.accountNotice) console.error(`psu: ${res.accountNotice}`);
  console.error(`psu: cwd ${res.cwd}  —  role-scoped MCP (${res.role}); resume from here`);
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
      PAPERCUSP_AGENT_SESSION: '1',
      ...(args.model ? { PAPERCUSP_MODEL: args.model } : {}),
      // P-014 (agent-managed-compaction): mechanical compaction backstop for a [1m]
      // role session — CC's CLAUDE_CODE_AUTO_COMPACT_WINDOW at ~120% of its soft limit.
      // No-op for non-claude / non-[1m] (see autoCompactWindowEnv).
      ...autoCompactWindowEnv(res.agent, args.model, { fleetMember: isFleetMemberLaunch(args) }),
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

/** Well-known install locations per backend (mirrors preflight-binaries) — for a
 *  bin the setup flow just installed that PATH hasn't picked up yet. Abs path or
 *  null. Exported for tests. */
export function wellKnownBackendBin(agent, { home = homedir(), env = process.env } = {}) {
  const winHome = env.USERPROFILE || home;
  const lists = {
    claude: [
      join(home, '.local/bin/claude'),
      join(home, '.papercusp/runtime/node_modules/.bin/claude'),
      join(home, '.claude/bin/claude'),
    ],
    codex: [
      join(home, '.papercusp/runtime/node_modules/.bin/codex'),
      join(home, '.local/bin/codex'),
      join(home, '.npm-global/bin/codex'),
    ],
    omp: [
      join(home, '.local/bin/omp'),
      join(home, '.papercusp/bin/omp'),
      join(winHome, '.papercusp', 'bin', 'omp.exe'),
    ],
  };
  for (const p of lists[agent] ?? []) {
    try {
      if (existsSync(p)) return p;
    } catch {
      /* ignore */
    }
  }
  return null;
}

/** Detect a backend bin: PATH first, then well-known. `{ path, onPath } | null`. */
export function detectBackendBin(agent) {
  const onPath = whichBin(agent);
  if (onPath) return { path: onPath, onPath: true };
  const wk = wellKnownBackendBin(agent);
  return wk ? { path: wk, onPath: false } : null;
}

/** Prepend a bin's dir to THIS process's PATH so the bare-name launch (runWrapper
 *  inherits process.env) resolves a just-installed backend not yet on PATH. */
function ensureDirOnPath(binPath) {
  const dir = dirname(binPath);
  const parts = String(process.env.PATH ?? '').split(delimiter);
  if (!parts.includes(dir)) process.env.PATH = dir + delimiter + (process.env.PATH ?? '');
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
  if (role !== 'su') {
    await roleFlow(args, role, rolesMeta);
    return;
  }

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
  // named-su-agent-fleets P-006: surface the chosen fleet (leading a new one /
  // joining an existing one), or the fail-soft reason it was skipped.
  if (res.fleetNotice) console.error(`psu: fleet — ${res.fleetNotice}`);

  // P-020: exec the RAW backend (not a *-su wrapper) with the engineer
  // playbook (res.promptFile) + flags. MCP + lock hooks are user-level for
  // claude/omp (they survive a raw launch); codex runs in res.codexHome.
  // Launch preflight (context-trimming-tiers P-016/P-018): persona-append
  // assertion + window guard — fail loud BEFORE spawning a doomed session.
  try {
    runLaunchPreflight({ promptFile: res.promptFile, contextSize: args.contextSize, model: args.model, force: args.force });
  } catch (e) {
    console.error(e?.message ?? String(e));
    process.exit(1);
  }
  const { bin, args: baseArgs } = suLaunchArgs(res.agent, {
    promptFile: res.promptFile,
    coordExtPath: res.coordExtPath,
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
  // model/resume passthrough (raw-CLI flags: claude/omp --model/-r, codex -m/resume).
  const extra = suWrapperExtraArgs(res.agent, { model: args.model, resumeSession: args.resumeSession });
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
    launchArgs.push(...kickoffArgs);
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
    const effectiveModel = args.model || ompDefaultModel();
    if (args.contextSize === 'full') {
      // ESCAPE HATCH (dynamic-tool-surface D-010): --context-size=full opts OUT of the
      // seed — eager-load the whole catalog with discovery OFF (latency-critical broad-tool
      // task / debugging). Everything else defaults to the seed below.
      ompPiConfigDir = writeOmpSessionConfigDir(res.sessionId, { discoveryOff: true, model: effectiveModel, clientId: res.envelopeEnv?.PAPERCUSP_SID || null });
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
      ompPiConfigDir = writeOmpSessionConfigDir(res.sessionId, { discoveryOff: true, toolsAllowlist: spine, model: effectiveModel, clientId: res.envelopeEnv?.PAPERCUSP_SID || null });
      if (ompPiConfigDir) console.error(`psu: omp (${effectiveModel}) — MCP surface seeded to ${spine.length} core tools (default; long tail reachable on demand via tools:find/tools:invoke). Use --context-size=full for the whole catalog up-front.`);
      else console.error(`psu: omp (${effectiveModel}) — could not materialize a seeded config; using OMP default (full catalog).`);
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
    // Anything launched through psu is an agent session for hook purposes:
    // native-scheduler lockout, OMP coord-hook guards, and the destructive
    // shared-tree git guard must all be armed. Direct non-psu Claude terminals
    // stay unmarked, preserving the owner-session exemption.
    envelopeEnv: {
      ...res.envelopeEnv,
      PAPERCUSP_AGENT_SESSION: '1',
      // PAPERCUSP_MODEL: the launch model spec, exported so the codex/omp title hook can
      // render the model in the terminal title (WI-1963 title-parity — those CLIs have no
      // live model object like Claude's statusline stdin). Omitted when no --model (default).
      ...(args.model ? { PAPERCUSP_MODEL: args.model } : {}),
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
      // [1m] claude launch, set CC's native CLAUDE_CODE_AUTO_COMPACT_WINDOW so CC itself
      // force-compacts at ~120% of the papercusp soft limit (300k member / 400k leader)
      // instead of drifting toward the 1M model window (the 2026-07-04 836k incident).
      // No-op for non-claude / non-[1m] (see autoCompactWindowEnv).
      ...autoCompactWindowEnv(res.agent, args.model, { fleetMember: isFleetMemberLaunch(args) }),
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
      // --context-size=full opts out (unshaped payloads, byte-identical to pre-tier
      // behavior); an explicit trimmed pick shapes; UNSET derives from the model
      // WINDOW (P-009: ≤200k → trimmed, a [1m] spec → full) — payload shaping only
      // matters where the window is small, unlike the tool-surface spine (D-010)
      // which stays trimmed for everyone.
      PAPERCUSP_CONTEXT_TIER:
        args.contextSize === 'full' ? 'full'
        : args.contextSize ? 'trimmed'
        : /\[1m\]/i.test(String(args.model ?? '')) ? 'full' : 'trimmed',
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
