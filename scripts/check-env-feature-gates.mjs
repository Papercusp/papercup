#!/usr/bin/env node
/**
 * check-env-feature-gates.mjs — guard the "feature toggles go through FLAGS" rule
 * AND the "a finished capability behind an env gate can't linger dark" rule.
 *
 * The repo rule (CLAUDE.md "Feature flags + PostHog"): a user-facing FEATURE toggle
 * belongs in the typed FLAGS registry (libs/flags/src/types.ts) — where
 * production-defaults.test.ts mechanically enforces the alpha DEFAULT-ON policy and
 * /admin/features can flip it — NOT behind an ad-hoc `process.env.PAPERCUSP_*`
 * boolean. An env gate ships dark by default, is invisible to the default-on guard,
 * and can't be flipped at runtime. That env-var path is exactly how a finished
 * feature "ships dark" without anyone noticing — e.g. PAPERCUSP_PGBOUNCER: the
 * transaction-pooling cure was built + proven, then sat OFF for weeks because an env
 * gate has no expiry guard (backend-connection-scaling-2026-06-17 / EI-2390).
 *
 * Every boolean `process.env.PAPERCUSP_<NAME>` gate must be CLASSIFIED into one of:
 *   • ALLOW — legitimate RUNTIME / TEST / DEV / BUILD / OPS config (env IS the right
 *     home; no /admin/features flip wanted, no "should this be on?" question).
 *   • KNOWN_ENV_CAPABILITY_GATES — a real default-OFF CAPABILITY deliberately kept on
 *     env (infra routing / process-mode read before FLAGS exist). Mirrors FLAGS'
 *     KNOWN_DARK_FLAGS: each carries a `reason` + a `reviewBy` date. A PAST reviewBy
 *     FAILS this lint (even non-strict) — forcing a re-decision: turn it ON, migrate
 *     it to a FLAG, or push the date with a fresh reason. This is the durable guard
 *     that stops "built + proven + left off" capabilities from lingering forever.
 * A boolean env gate in NEITHER set trips the lint (advisory unless --strict) so the
 * author classifies it: FLAG (a feature) vs ALLOW (config) vs registry (a capability).
 *
 *   node scripts/check-env-feature-gates.mjs           # report; FAILS on an expired capability gate
 *   node scripts/check-env-feature-gates.mjs --strict  # ALSO exit 1 on any unclassified gate
 *
 * Detection: scans the superproject AND submodules (--recurse-submodules — the
 * libs/papercusp submodule is where much of the gating lives; the old lint was blind
 * to it, which is precisely why PAPERCUSP_PGBOUNCER was never flagged). Boolean
 * literals matched: 1|0|true|false|on|off|yes|no. (A bare-value read — a port, path,
 * id, threshold — is config and is deliberately NOT matched.)
 */
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const STRICT = process.argv.includes('--strict');

// Legit RUNTIME / TEST / DEV / BUILD / OPS config toggles — env is the CORRECT home
// for these (set by a launcher/CI at process start, or a default-ON ops kill-switch;
// not a user-facing feature; no /admin/features flip wanted; no "is this finished and
// should be on?" question — they are config, not capabilities).
const ALLOW = new Set([
  // ── test / CI harness ──
  'PAPERCUSP_DISABLE_TEST_RUNS_REPORTER', 'PAPERCUSP_SKIP_PG_DISCOVERY', 'PAPERCUSP_KEEP_FILES',
  'PAPERCUSP_LLM_TEST_SKIP_CLAIM', 'PAPERCUSP_ALLOW_LLM_TEST_BUDGET_BYPASS', 'PAPERCUSP_FAULT_INJECTION', 'PAPERCUSP_REPLAY_VERIFY',
  'PAPERCUSP_VALIDATE_TOOL_OUTPUT', 'PAPERCUSP_INTERNAL_DOCS_BYPASS', 'PAPERCUSP_POSTHOG_TESTING_FEATURES',
  'PAPERCUSP_INTERNAL_BUILD', 'PAPERCUSP_TESTING_FULL_ACCESS_ROLES',
  // ── runtime mode / process wiring (a launcher sets these, not a feature) ──
  'PAPERCUSP_USE_EMBEDDED_PG', 'PAPERCUSP_USE_PG_STATE', 'PAPERCUSP_DBOS_ENABLE', 'PAPERCUSP_DBOS_ORCHESTRATOR',
  'PAPERCUSP_DBOS_ROUTINES', 'PAPERCUSP_DBOS_AUTOLOOP', 'PAPERCUSP_DBOS_TIMERS',
  'PAPERCUSP_DBOS_PLAN_RENDER', 'PAPERCUSP_BACKGROUND_WORKERS', 'PAPERCUSP_USE_TS_ORCHESTRATOR',
  'PAPERCUSP_SERVE_UI', 'PAPERCUSP_IPC_ENABLE', 'PAPERCUSP_DESKTOP',
  'PAPERCUSP_PROMPT_CACHE_TTL', 'PAPERCUSP_TABS_FROM_PLUGINS',
  // ── embedded-postgres setup (launcher/infra config) ──
  'PAPERCUSP_PG_CREATE_USER', 'PAPERCUSP_PG_DEBUG',
  // ── dev-box ergonomics / operator infra / safety ──
  'PAPERCUSP_RELOAD_PROMPTS', 'PAPERCUSP_ALLOW_DEV_RESTART', 'PAPERCUSP_ALLOW_REMOTE_ADMIN',
  'PAPERCUSP_REQUIRE_SPAWN_SIG', 'PAPERCUSP_MEM0_SESSION_EXTRACTION',
  // ── baseline (existing infra/dev/safety gates, classified as config 2026-06-16) ──
  'PAPERCUSP_AGENT_SESSION', 'PAPERCUSP_ALLOW_DB_MIGRATE', 'PAPERCUSP_ALLOW_NO_SANDBOX',
  'PAPERCUSP_DISABLE_SANDBOX', 'PAPERCUSP_DBOS_INVOKE_DEBUG', 'PAPERCUSP_DEBUG_WORKSPACE',
  'PAPERCUSP_DESKTOP_SCREEN_TRACKS', 'PAPERCUSP_DEV_PLUGIN_WATCH', 'PAPERCUSP_FAKE_LLM',
  'PAPERCUSP_PROMPT_CACHE', 'PAPERCUSP_MEMORY_WATCHDOG', 'PAPERCUSP_PTY_FLOW_CONTROL',
  'PAPERCUSP_SIGTERM_DRAIN', // ops kill-switch: graceful HTTP connection-drain on SIGTERM (default-ON, opt-out to restore Node's immediate-exit). infra-fail-fast P-017.
  'PAPERCUSP_ENABLE_RUST_REWRITES', // build-mode (Rust vs JS proxies), launcher-set
  // ── system-health / DBOS / gateway OPS kill-switches + dev traces. These gate
  //    INTERNAL infrastructure (watchdogs, alarms, reapers, self-heal, dev tracing),
  //    default-ON / opt-out, NOT user-facing features — launch-time/ops runtime config. ──
  'PAPERCUSP_A003_TRACE', 'PAPERCUSP_GATEWAY_ROUTE_LOG', 'PAPERCUSP_LOOP_PROFILER',
  'PAPERCUSP_DBOS_EXECUTOR_REAPER', 'PAPERCUSP_DBOS_WORKFLOW_GC', 'PAPERCUSP_FEDERATION_DRAIN_RECONCILE',
  'PAPERCUSP_GATEWAY_SELFHEAL', 'PAPERCUSP_GREEN_STALL_WATCHDOG', 'PAPERCUSP_INFRA_LIVENESS_ALARM',
  'PAPERCUSP_LAG_SELF_RESTART', 'PAPERCUSP_SINGLE_PRIMARY_GUARD', 'PAPERCUSP_STORAGE_GROWTH_ALARM',
  'PAPERCUSP_STRUCTURAL_ERROR_VERIFIER', 'PAPERCUSP_WATCHDOG_SERVICE_HEALTH_INLINE_PROBE',
  'PAPERCUSP_DISK_SPACE_ALARM', 'PAPERCUSP_REPLICATION_SLOT_ALARM', 'PAPERCUSP_TEST_DESKTOP_REAPER',
  'PAPERCUSP_MEMORY_ANCHOR_AUDIT', // nightly Layer-1 memory-anchor audit (P-019); default-ON ops kill-switch
]);

// Real default-OFF CAPABILITIES deliberately kept on an env gate (infra routing /
// process-mode read before FLAGS/PG access exists, awkward as a runtime /admin/features
// flip). Mirror of FLAGS' KNOWN_DARK_FLAGS + DARK_FLAGS_REVIEW_BY: each MUST carry a
// `reason` + a `reviewBy` (YYYY-MM-DD). A PAST reviewBy FAILS this lint — re-decide:
// turn it ON, migrate it to a FLAG, or push the date with a fresh reason. This is the
// guard the env-gate path lacked (EI-2390 / dark-capability-enforcement-2026-06-21).
// Audit it with: node scripts/check-env-feature-gates.mjs
const KNOWN_ENV_CAPABILITY_GATES = {
  PAPERCUSP_PGBOUNCER: {
    reviewBy: '2026-07-31',
    reason: 'Transaction pooling — proven + LIVE on staging :3170 (2026-06-21); rolling out to bg-host + the :3070 cluster (backend-connection-scaling-2026-06-17). Stays env: it is a connection-URL routing switch read before any FLAGS/PG access exists.',
  },
  PAPERCUSP_LISTEN_HUB: {
    reviewBy: '2026-07-31',
    reason: 'Shared PG LISTEN connection hub (collapses 4 wake-bus conns → 1). Built + on the :3070 cluster; finish the fleet rollout. Stays env: boot-time connection infra.',
  },
  PAPERCUSP_DESIGN_GATE: {
    reviewBy: '2026-07-31',
    reason: 'Design-phase invocation gate — blocks feature runs until design accepted/ignored. Built + 11 tests, OFF everywhere. DECIDE: enable per-workspace or migrate to a FLAG.',
  },
  PAPERCUSP_PARTIAL_GREEN_GATE: {
    reviewBy: '2026-07-31',
    reason: 'Longest-green-PREFIX FF for the green-checkpoint gate (release-pipeline-resilience-2026-06-09 P-016 / D-010): when armed, a red batch TIP no longer hostages the clean prefix — `main` FFs to the longest prefix that ITSELF runs green (confirm-gated; the always-tested-green invariant holds). Built + unit-tested, OFF. Default-OFF + env-armed (the established perf/delta-gate pattern) because D-010 calls for an OWNER-ATTENDED live cutover of the fleet-critical gate. DECIDE: arm on the green-checkpoint routine after attended verify, or migrate to a FLAG.',
  },
  PAPERCUSP_AGENT_GOVERNOR: {
    reviewBy: '2026-07-31',
    reason: 'Agent-spawn rate governance (budget-based backpressure). Built, OFF. Scaling-relevant (thousands-of-agents). DECIDE: enable or migrate to a FLAG.',
  },
  PAPERCUSP_AGENT_GOVERNOR_PG: {
    reviewBy: '2026-07-31',
    reason: 'Cross-process PG-backed agent-governor budget coordination for multi-process operators. Built, OFF. Pairs with AGENT_GOVERNOR.',
  },
  PAPERCUSP_CHUNK_LOCK_PG: {
    reviewBy: '2026-07-31',
    reason: 'PG-backed file-lock coordinator for worker chunk loops (cross-feature concurrency, @papercusp/locks). Built, OFF. DECIDE: enable or migrate to a FLAG.',
  },
  PAPERCUSP_PERSIST_CHUNKS: {
    reviewBy: '2026-07-31',
    reason: 'Tool-output chunk archival to PG (harness_shared.invoker_run_chunks). Built, OFF. DECIDE: enable or migrate to a FLAG.',
  },
  PAPERCUSP_SHARED_OPERATOR: {
    reviewBy: '2026-07-31',
    reason: 'Multi-workspace orchestration mode (reads the workspace registry). Built, OFF. Stays env: process-mode switch read at boot. DECIDE: enable or migrate to a FLAG.',
  },
  PAPERCUSP_GIT_EXPORT_COMMIT: {
    reviewBy: '2026-07-31',
    reason: 'Git-export commit recording in feature metadata. Built, OFF. DECIDE: enable or migrate to a FLAG.',
  },
  PAPERCUSP_MEMORY_DEDUP: {
    reviewBy: '2026-07-31',
    reason: "Memory dedup-on-remember (top-k similarity, checked === 'on'). Built, OFF. DECIDE: enable or migrate to a FLAG.",
  },
  PAPERCUSP_MEM0_CONVERSATION_CAPTURE: {
    reviewBy: '2026-07-15',
    reason: 'mem0 conversation-capture toggle (operator converse). Surfaced by the submodule-scan fix — CLASSIFY: confirm built-state, then ALLOW (dev/experimental) or enable/migrate.',
  },
  PAPERCUSP_MEMORY_CONFLICT_CHECK: {
    reviewBy: '2026-07-15',
    reason: 'Memory conflict-check on remember. Surfaced by the submodule-scan fix — CLASSIFY: confirm built-state, then ALLOW or enable/migrate.',
  },
  PAPERCUSP_SU_MEMORY_INJECTION: {
    reviewBy: '2026-07-15',
    reason: 'su-session memory injection at the MCP handler. Surfaced by the submodule-scan fix — CLASSIFY: confirm built-state, then ALLOW or enable/migrate.',
  },
};

// Broad scan (git grep), precise filter in JS. --recurse-submodules so the
// libs/papercusp submodule (orchestrator, db, embedded-pg, …) is covered — the old
// superproject-only scan was blind to it (the PAPERCUSP_PGBOUNCER blind spot).
let raw = '';
try {
  raw = execFileSync(
    'git',
    ['grep', '-nE', '--recurse-submodules', 'process\\.env\\.PAPERCUSP_[A-Z_0-9]+', '--', 'packages/', 'apps/', 'libs/'],
    { cwd: ROOT, encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 },
  );
} catch (e) {
  if (e.status === 1) raw = ''; // git grep exits 1 on no matches
  else throw e;
}

// A boolean gate: env compared to a boolean LITERAL (1|0|true|false|on|off|yes|no).
const GATE_RE = /process\.env\.(PAPERCUSP_[A-Z_0-9]+)\s*[!=]==?\s*['"](?:1|0|true|false|on|off|yes|no)['"]/;

const hits = new Map(); // unclassified name -> [file:line, …]
const seen = new Set(); // every boolean gate name seen anywhere (for stale-registry detection)
for (const line of raw.split('\n')) {
  const m = line.match(/^(.+?):(\d+):(.*)$/);
  if (!m) continue;
  const [, file, lineno, content] = m;
  if (!file.endsWith('.ts') && !file.endsWith('.tsx') && !file.endsWith('.mjs')) continue;
  if (file.endsWith('.test.ts') || file.endsWith('.test.tsx')) continue; // tests legitimately poke env
  const g = content.match(GATE_RE);
  if (!g) continue;
  const name = g[1];
  seen.add(name);
  if (ALLOW.has(name) || name in KNOWN_ENV_CAPABILITY_GATES) continue;
  if (!hits.has(name)) hits.set(name, []);
  hits.get(name).push(`${file}:${lineno}`);
}

let fail = false;

// ── Durable guard #1: capability gates whose reviewBy has PASSED (the anti-linger check) ──
// Hard-fails even without --strict: an expired capability gate is an unambiguous
// "re-decide now", not a config-vs-feature judgment call.
const now = new Date();
const expired = [];
const stale = [];
for (const [name, meta] of Object.entries(KNOWN_ENV_CAPABILITY_GATES)) {
  const due = new Date(`${meta.reviewBy}T23:59:59Z`);
  if (Number.isNaN(due.getTime())) {
    console.log(`check-env-feature-gates: ⚠ ${name} has an unparseable reviewBy "${meta.reviewBy}" — fix it.`);
    fail = true;
    continue;
  }
  if (now > due) expired.push([name, meta]);
  if (!seen.has(name)) stale.push(name);
}
if (expired.length) {
  fail = true;
  console.log(`\ncheck-env-feature-gates: ${expired.length} capability env gate(s) PAST their review-by — re-decide (turn ON / migrate to FLAG / push the date with a fresh reason):\n`);
  for (const [name, meta] of expired) console.log(`  ⏰ ${name}  (review-by ${meta.reviewBy})\n     ${meta.reason}`);
}
if (stale.length) {
  // Not a failure on its own — a heads-up that a registered gate is gone from code
  // (migrated to a FLAG / removed?). Drop the registry entry.
  console.log(`\ncheck-env-feature-gates: note — ${stale.length} registered capability gate(s) no longer found in code (migrated/removed? drop the registry entry): ${stale.join(', ')}`);
}

// ── Durable guard #2: unclassified boolean env gates (advisory unless --strict) ──
if (hits.size > 0) {
  console.log(`\ncheck-env-feature-gates: ${hits.size} boolean PAPERCUSP_ env gate(s) classified as NEITHER config nor a registered capability:\n`);
  for (const [name, locs] of [...hits].sort((a, b) => a[0].localeCompare(b[0]))) {
    console.log(`  ${name}  (${locs.length} use${locs.length === 1 ? '' : 's'})  e.g. ${locs[0]}`);
  }
  console.log(
    `\nClassify each:\n` +
      `  • user-facing FEATURE → move it into the FLAGS registry (libs/flags/src/types.ts) — the alpha\n` +
      `    DEFAULT-ON policy + production-defaults.test apply and /admin/features can flip it.\n` +
      `  • default-OFF CAPABILITY that must stay on env (infra routing / boot-mode) → add it to\n` +
      `    KNOWN_ENV_CAPABILITY_GATES with a reason + reviewBy (so it can't linger dark).\n` +
      `  • genuine runtime/test/dev/ops CONFIG → add it to ALLOW.\n` +
      `  (all in scripts/check-env-feature-gates.mjs)\n`,
  );
  if (STRICT) fail = true;
}

if (!fail && hits.size === 0 && expired.length === 0) {
  console.log('check-env-feature-gates: clean — every boolean PAPERCUSP_ env gate is classified config or a registered (in-review) capability.');
}
process.exit(fail ? 1 : 0);
