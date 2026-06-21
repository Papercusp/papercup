#!/usr/bin/env node
/**
 * check-env-feature-gates.mjs — guard the "feature toggles go through FLAGS" rule.
 *
 * The repo rule (CLAUDE.md "Feature flags + PostHog"): a user-facing FEATURE toggle
 * belongs in the typed FLAGS registry (libs/flags/src/types.ts) — where
 * production-defaults.test.ts mechanically enforces the alpha DEFAULT-ON policy and
 * /admin/features can flip it — NOT behind an ad-hoc `process.env.PAPERCUSP_*`
 * boolean. An env gate ships dark by default, is invisible to the default-on guard,
 * and can't be flipped at runtime. That env-var path is exactly how a finished
 * feature "ships dark" without anyone noticing — the leak the FLAG test can't see.
 *
 * This lint flags a `process.env.PAPERCUSP_<NAME> === '1' | 'true' | '0' | 'false'`
 * boolean gate whose NAME is not in ALLOW — the curated set of legitimate RUNTIME /
 * TEST / DEV / BUILD config toggles (env IS the right home for those). A NEW boolean
 * env gate trips it: either move the feature into FLAGS, or — if it's genuinely
 * launch-time config — add it to ALLOW below with a one-line note on why.
 *
 *   node scripts/check-env-feature-gates.mjs           # report (informational)
 *   node scripts/check-env-feature-gates.mjs --strict  # exit 1 on any un-allowed gate
 *
 * Advisory by default (config-vs-feature is a judgment call — a heuristic, like
 * lint:generic-first). The ALLOW set is the precision filter that keeps it quiet.
 */
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const STRICT = process.argv.includes('--strict');

// Legit RUNTIME / TEST / DEV / BUILD config toggles — env is the CORRECT home for
// these (set by a launcher/CI at process start; not a user-facing feature; no
// /admin/features flip wanted). A new boolean PAPERCUSP_ env gate NOT here trips the
// lint so the author classifies it: FLAG (a feature) vs config (add it here).
const ALLOW = new Set([
  // ── test / CI harness ──
  'PAPERCUSP_DISABLE_TEST_RUNS_REPORTER', 'PAPERCUSP_SKIP_PG_DISCOVERY', 'PAPERCUSP_KEEP_FILES',
  'PAPERCUSP_LLM_TEST_SKIP_CLAIM', 'PAPERCUSP_FAULT_INJECTION', 'PAPERCUSP_REPLAY_VERIFY',
  'PAPERCUSP_VALIDATE_TOOL_OUTPUT', 'PAPERCUSP_INTERNAL_DOCS_BYPASS', 'PAPERCUSP_POSTHOG_TESTING_FEATURES',
  'PAPERCUSP_INTERNAL_BUILD',
  // ── runtime mode / process wiring (a launcher sets these, not a feature) ──
  'PAPERCUSP_USE_EMBEDDED_PG', 'PAPERCUSP_DBOS_ENABLE', 'PAPERCUSP_DBOS_ORCHESTRATOR',
  'PAPERCUSP_DBOS_ROUTINES', 'PAPERCUSP_DBOS_AUTOLOOP', 'PAPERCUSP_DBOS_TIMERS',
  'PAPERCUSP_DBOS_PLAN_RENDER', 'PAPERCUSP_BACKGROUND_WORKERS', 'PAPERCUSP_USE_TS_ORCHESTRATOR',
  'PAPERCUSP_AGENT_GOVERNOR', 'PAPERCUSP_AGENT_GOVERNOR_PG', 'PAPERCUSP_SHARED_OPERATOR',
  'PAPERCUSP_SERVE_UI', 'PAPERCUSP_IPC_ENABLE', 'PAPERCUSP_DESKTOP', 'PAPERCUSP_GIT_EXPORT_COMMIT',
  'PAPERCUSP_PROMPT_CACHE_TTL', 'PAPERCUSP_TABS_FROM_PLUGINS',
  // ── dev-box ergonomics / operator infra ──
  'PAPERCUSP_RELOAD_PROMPTS', 'PAPERCUSP_ALLOW_DEV_RESTART', 'PAPERCUSP_ALLOW_REMOTE_ADMIN',
  'PAPERCUSP_REQUIRE_SPAWN_SIG', 'PAPERCUSP_MEM0_SESSION_EXTRACTION', 'PAPERCUSP_PERSIST_CHUNKS',
  'PAPERCUSP_WORKITEM_REDUNDANCY',
  // PAPERCUSP_WORKITEM_CLAIM_LEASE removed — migrated to the WORKITEM_CLAIM_LEASE FLAG
  // (work-queue-stuck-item-recovery-2026-06-17 P-012 / D-008).
  // PAPERCUSP_LISTEN_HUB: shared PG LISTEN/NOTIFY connection-pool infra toggle
  // (pg-listen-hub.ts) — runtime/infra config, not a user-facing feature.
  'PAPERCUSP_LISTEN_HUB',
  // ── baseline (existing infra/dev/safety gates, classified as config 2026-06-16) ──
  // All set by a launcher/CI/safety path, not user-facing features — env is correct.
  'PAPERCUSP_AGENT_SESSION', 'PAPERCUSP_ALLOW_DB_MIGRATE', 'PAPERCUSP_ALLOW_NO_SANDBOX',
  'PAPERCUSP_DISABLE_SANDBOX', 'PAPERCUSP_DBOS_INVOKE_DEBUG', 'PAPERCUSP_DEBUG_WORKSPACE',
  'PAPERCUSP_DESKTOP_SCREEN_TRACKS', 'PAPERCUSP_DEV_PLUGIN_WATCH', 'PAPERCUSP_FAKE_LLM',
  'PAPERCUSP_PROMPT_CACHE', 'PAPERCUSP_MEMORY_WATCHDOG', 'PAPERCUSP_PTY_FLOW_CONTROL',
  'PAPERCUSP_ENABLE_RUST_REWRITES', // build-mode (Rust vs JS proxies), launcher-set — config, not a user feature
  // ── system-health / DBOS / gateway OPS kill-switches + dev traces (live-configurability-audit
  //    P-023). These gate INTERNAL infrastructure (watchdogs, alarms, reapers, self-heal, dev
  //    tracing), not user-facing features — launch-time/ops runtime config, env is correct (same
  //    category as ALLOW_DEV_RESTART / MEMORY_WATCHDOG above). The FEATURE value-gates P-023 targeted
  //    (handoff TTL, redundancy switch, placement-watchdog, improvement caps) were migrated to FLAGS /
  //    the control-harness by P-007/P-011/P-014/P-015; the remaining ones (scout ceiling, auth bypass,
  //    exec-sandbox egress, PG timeouts) are NUMERIC/owned by Phase-3 items P-019/P-020/P-022 and ride
  //    those. Promoting a specific watchdog to a FLAG (for /admin/features hot-flip) stays an optional
  //    per-watchdog follow-up. ──
  'PAPERCUSP_A003_TRACE',                       // hyperbee A003 debug trace (dev)
  'PAPERCUSP_GATEWAY_ROUTE_LOG',                // inference-gateway route logging (dev)
  'PAPERCUSP_LOOP_PROFILER',                    // event-loop profiler (dev)
  'PAPERCUSP_DBOS_EXECUTOR_REAPER',             // DBOS executor-reaper ops kill-switch
  'PAPERCUSP_DBOS_WORKFLOW_GC',                 // DBOS workflow-GC ops kill-switch
  'PAPERCUSP_FEDERATION_DRAIN_RECONCILE',       // federation drain-reconcile ops toggle
  'PAPERCUSP_GATEWAY_SELFHEAL',                 // inference-gateway self-heal ops kill-switch
  'PAPERCUSP_GREEN_STALL_WATCHDOG',             // green-checkpoint stall watchdog ops kill-switch
  'PAPERCUSP_INFRA_LIVENESS_ALARM',             // infra-liveness alarm ops kill-switch
  'PAPERCUSP_LAG_SELF_RESTART',                 // event-loop-lag self-restart ops kill-switch
  'PAPERCUSP_SINGLE_PRIMARY_GUARD',             // single-primary guard ops kill-switch
  'PAPERCUSP_STORAGE_GROWTH_ALARM',             // storage-growth alarm ops kill-switch
  'PAPERCUSP_STRUCTURAL_ERROR_VERIFIER',        // structural-error verifier ops kill-switch
  'PAPERCUSP_WATCHDOG_SERVICE_HEALTH_INLINE_PROBE', // watchdog inline service-health probe ops toggle
]);

// Broad scan (git grep), precise filter in JS (easier than shell-escaping the boolean form).
let raw = '';
try {
  // execFileSync (no shell) — the pattern + pathspecs are passed as argv, so there
  // is no shell-injection surface (nothing here is user input regardless).
  raw = execFileSync(
    'git',
    ['grep', '-nE', 'process\\.env\\.PAPERCUSP_[A-Z_0-9]+', '--', 'packages/', 'apps/', 'libs/'],
    { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
} catch (e) {
  if (e.status === 1) raw = ''; // git grep exits 1 on no matches
  else throw e;
}

// A boolean gate: env compared to a boolean LITERAL. (A bare-value read — a port,
// path, id — is config and is deliberately NOT matched.)
const GATE_RE = /process\.env\.(PAPERCUSP_[A-Z_0-9]+)\s*[!=]==?\s*['"](?:1|0|true|false)['"]/;

const hits = new Map(); // name -> [file:line, …]
for (const line of raw.split('\n')) {
  const m = line.match(/^([^:]+):(\d+):(.*)$/);
  if (!m) continue;
  const [, file, lineno, content] = m;
  if (!file.endsWith('.ts') && !file.endsWith('.tsx')) continue;
  if (file.endsWith('.test.ts') || file.endsWith('.test.tsx')) continue; // tests legitimately poke env
  const g = content.match(GATE_RE);
  if (!g) continue;
  const name = g[1];
  if (ALLOW.has(name)) continue;
  if (!hits.has(name)) hits.set(name, []);
  hits.get(name).push(`${file}:${lineno}`);
}

if (hits.size === 0) {
  console.log('check-env-feature-gates: clean — every boolean PAPERCUSP_ env gate is allow-listed config.');
  process.exit(0);
}

console.log(`\ncheck-env-feature-gates: ${hits.size} boolean PAPERCUSP_ env gate(s) not in the ALLOW set:\n`);
for (const [name, locs] of [...hits].sort((a, b) => a[0].localeCompare(b[0]))) {
  console.log(`  ${name}  (${locs.length} use${locs.length === 1 ? '' : 's'})  e.g. ${locs[0]}`);
}
console.log(
  `\nIf one gates a user-facing FEATURE → move it into the FLAGS registry (libs/flags/src/types.ts)\n` +
    `so the alpha DEFAULT-ON policy + production-defaults.test apply and /admin/features can flip it.\n` +
    `If it is genuine runtime/test/dev CONFIG → add it to ALLOW in scripts/check-env-feature-gates.mjs.\n`,
);
process.exit(STRICT ? 1 : 0);
