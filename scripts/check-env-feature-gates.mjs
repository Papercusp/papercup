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
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { coverageOf, describeUnscanned, listTrackedFiles } from './lib/tracked-files.mjs';

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
  'PAPERCUSP_FORBID_REAL_PG', // test-harness safety guard (libs/test-config/setup-no-real-pg.ts): forbids a unit test from opening a real PG connection
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
  // PAPERCUSP_STRUCTURAL_ERROR_VERIFIER — RETURNED to this block 2026-08-03
  // (EI-19453017656411107), and now legitimately: its polarity was INVERTED to default-ON
  // with a `=== '0'` kill-switch (bootstrap.ts), so this block's "default-ON / opt-out"
  // justification is true for it. It briefly lived in KNOWN_ENV_CAPABILITY_GATES because
  // it was opt-IN (`=== '1'`) and therefore dark on :3070 from the day it was written;
  // arming it resolved that, so a dark-capability reviewBy no longer applies.
  'PAPERCUSP_STRUCTURAL_ERROR_VERIFIER', // default-ON structural-error auto-resolve daemon (=== '0' opts out)
  'PAPERCUSP_WATCHDOG_SERVICE_HEALTH_INLINE_PROBE',
  'PAPERCUSP_DISK_SPACE_ALARM', 'PAPERCUSP_REPLICATION_SLOT_ALARM', 'PAPERCUSP_TEST_DESKTOP_REAPER',
  'PAPERCUSP_MEMORY_ANCHOR_AUDIT', // nightly Layer-1 memory-anchor audit (P-019); default-ON ops kill-switch
  // ── EI-2390 (2026-07-18 audit): 3 entries GRADUATED out of KNOWN_ENV_CAPABILITY_GATES
  //    — each is confirmed fully-shipped default-ON behavior with an opt-out kill-switch
  //    (`!== 'off'`), not a pending "should this be on?" capability decision. ──
  'PAPERCUSP_MEM0_CONVERSATION_CAPTURE', // default ON (operator converse mem0 capture); =off kill-switch
  // EI-18747066020546067 (2026-08-02): graduated out of KNOWN_ENV_CAPABILITY_GATES.
  // The D-010 "OWNER-ATTENDED live cutover" its old registry entry was waiting on has
  // happened: verified LIVE + ARMED on papercup-bg-host.service (systemd drop-in
  // 90-partial-green-gate.conf, "owner-approved 2026-07-01 via su-379eb"). No longer a
  // pending "should this be on?" question — confirmed-gated infra config, same shape as
  // the other DBOS/gateway ops kill-switches below.
  'PAPERCUSP_PARTIAL_GREEN_GATE',
  // ⚠ EI-18747066020546067 (2026-07-27): this "graduated" verdict rested on the entry
  // being "confirmed fully-shipped and working" — but EI-18746586784230719 found the
  // guard has NEVER actually executed in the live operator (createAnthropicJudge()
  // silently no-ops with no ANTHROPIC_API_KEY set). It is also arguably a genuine
  // product CAPABILITY (a memory-write contradiction guard), not ops config, per
  // CLAUDE.md's "feature toggle → FLAGS, not process.env" rule — left here rather than
  // migrated to avoid colliding with EI-18746586784230719's in-flight wiring fix;
  // re-classify (FLAGS, or confirm ALLOW) once that item lands and the guard is
  // verified to actually run.
  'PAPERCUSP_MEMORY_CONFLICT_CHECK', // default ON (memory:remember conflict-check); =off kill-switch
  'PAPERCUSP_SU_MEMORY_INJECTION', // default ON (P-050 su-session memory prelude); =off kill-switch
  // EI-19305813023320659 (2026-08-02): default-ON, fail-open, STRICTLY ADVISORY
  // work_items:create dedup guard (never blocks a create, only surfaces a
  // "this looks already filed" hint) — same shape as the two entries just
  // above, not a pending "should this be on?" capability decision.
  'PAPERCUSP_WI_FULLTEXT_DUPE', // default ON (work_items:create fulltext-lexical dupe hint); =off kill-switch
  // ── EI-2390 (2026-07-18 audit): 61 boolean PAPERCUSP_ gates newly classified — every one
  //    is an internal ops/dev/tuning toggle (watchdog kill-switch, sidecar boot-mode select,
  //    or an internal-algorithm dial), never a user-facing capability a human would flip via
  //    /admin/features. Grouped by area; each is default-ON unless noted "opt-in". ──
  // system-health watchdogs / alarms (default-ON, `=== '0'` opts out)
  'PAPERCUSP_CODEX_ROLLOUT_WATCHDOG', 'PAPERCUSP_COMPACTION_WATCHDOG', 'PAPERCUSP_CONDITION_STALENESS_ALARM',
  'PAPERCUSP_GITSYNC_STALL_WATCHDOG', 'PAPERCUSP_MCP_DARK_WATCHDOG', 'PAPERCUSP_MCP_DARK_INTERACTIVE',
  'PAPERCUSP_RECIPE_HYGIENE', 'PAPERCUSP_WORKTREE_COVERAGE_WATCHDOG', 'PAPERCUSP_SPAWN_READINESS_SHADOW',
  'PAPERCUSP_BGHOST_WATCHDOG_NO_AUTOSTART', 'PAPERCUSP_WATCHDOG_NO_AUTOSTART', 'PAPERCUSP_PARENT_DEATH_WATCH',
  'PAPERCUSP_DBOS_HANG_WATCHDOG', // default-ON DBOS-workflow hang watchdog kill-switch (=== '0' opts out)
  'PAPERCUSP_WAL_GUARD', // default-ON periodic-workflows WAL guard kill-switch (=== '0' opts out)
  // inference-gateway internal self-tuning (default-ON, `!== '0'` opts out)
  'PAPERCUSP_GATEWAY_ABSORB_STALLS', 'PAPERCUSP_GATEWAY_ABSORB_TIER_SCALE', 'PAPERCUSP_GATEWAY_RPM_SMOOTH',
  'PAPERCUSP_GATEWAY_SERVICEABLE_CLAMP', 'PAPERCUSP_GATEWAY_SUPERVISE', 'PAPERCUSP_GATEWAY_SUPPRESS_BAREBURST_ROTATE',
  'PAPERCUSP_GATEWAY_DISABLE_PROXY_EGRESS', // opt-in escape hatch, disables egress proxying
  // sidecar boot-mode selectors (launcher-set process-wiring, mirrors PAPERCUSP_DESKTOP/IPC_ENABLE above)
  'PAPERCUSP_EMBED_SIDECAR_MODE', 'PAPERCUSP_GATEWAY_SIDECAR_MODE', 'PAPERCUSP_SPAWNER_SIDECAR_MODE',
  'PAPERCUSP_SPAWNER_SIDECAR', 'PAPERCUSP_SUBSTRATE_SIDECAR_MODE', 'PAPERCUSP_SUBSTRATE_SIDECAR_SCOPE',
  'PAPERCUSP_IPC_TCP',
  // mcp-proxy / mcp-admission internal tuning
  'PAPERCUSP_MCP_ADMISSION_CONTROL', 'PAPERCUSP_MCP_PROXY_ABSORB_429', 'PAPERCUSP_MCP_PROXY_DYNAMIC_TARGET',
  'PAPERCUSP_MCP_PROXY_KEYED_RETRY',
  // memory-lib internal algorithm dials (libs/generic/memory — decay, MMR, entity-linking)
  'PAPERCUSP_MEMORY_DECAY', 'PAPERCUSP_MEMORY_MMR', 'PAPERCUSP_MEMORY_ENTITY_FILTER',
  'PAPERCUSP_MEMORY_ENTITY_NLP', 'PAPERCUSP_MEMORY_ENTITY_RELINK', 'PAPERCUSP_MEMORY_REF_EXPANSION',
  'PAPERCUSP_MEMORY_PROACTIVE_GC', 'PAPERCUSP_SILENCE_FLAG_OVERRIDE_WARN',
  // scout internal legs (digest-embed clustering, intent-rank, semantic-novelty — algorithm dials)
  'PAPERCUSP_SU_DIGEST_EMBED_CLUSTER', 'PAPERCUSP_SU_INTENT_RANK', 'PAPERCUSP_SU_SEMANTIC_NOVELTY',
  'PAPERCUSP_SCOUT_READY_AUTOSTART',
  // work-item dupe-guard tuning
  'PAPERCUSP_WI_RECENT_DUPE', 'PAPERCUSP_WI_SEMANTIC_DUPE',
  // coordination event-log read caches (perf tuning, default-ON)
  'PAPERCUSP_COORD_READEVENTS_CACHE', 'PAPERCUSP_COORD_READLINES_CACHE',
  // misc dev/debug/ops toggles
  'PAPERCUSP_AGENT_SPAWN_SCOPE', 'PAPERCUSP_ANNOUNCE_DEBUG', 'PAPERCUSP_CC_AUTOUPDATE',
  'PAPERCUSP_CHECKPOINT_SCOPE', 'PAPERCUSP_DISABLE_SEARCH_WARMUP', 'PAPERCUSP_DISABLE_TESTCONTAINERS_START_LOCK',
  'PAPERCUSP_DOORS_CONFIG_OFF', 'PAPERCUSP_FULL_HEAP_SNAPSHOT', 'PAPERCUSP_HEAP_SNAPSHOT',
  'PAPERCUSP_HEAP_SNAPSHOT_REPEAT', 'PAPERCUSP_INJECTION_DOOR_OFF', 'PAPERCUSP_OMP_RESUME_VIA_PTY',
  'PAPERCUSP_PROVISION_ENV_OPERATORS', 'PAPERCUSP_RESULT_DOOR_OFF', 'PAPERCUSP_TUTORIAL_NO_ANIM',
  // ── EI-2390: surfaced by the new "assign-then-compare" 2nd-pass scan (this same audit's
  //    detection-gap fix) — all 3 are default-OFF ops/perf/security kill-switches, not
  //    user-facing capabilities. ──
  'PAPERCUSP_FLEET_SANDBOX_DENY_ALL_EGRESS', // sandbox LOCKDOWN switch (stricter, not a feature to promote)
  'PAPERCUSP_HTTP_BACKPRESSURE', // default-OFF perf: caller-marked load shedding
  'PAPERCUSP_HTTP_HANDLER_DEADLINE', // default-OFF perf: per-handler deadline enforcement
  // ── EI-18747066020546067 (2026-07-27): 11 gates newly classified to clear the
  //    strict-lint red. Each verified by reading its call site — internal ops/perf/dev
  //    dials, none a user-facing capability a human would flip via /admin/features. ──
  // gateway/cache-proxy prompt-cache perf dials (default-ON unless noted; internal algorithm tuning)
  'PAPERCUSP_CACHE_POLICY', // default-ON perf: whether the cache-proxy/gateway apply Anthropic prompt-caching at all
  'PAPERCUSP_CACHE_SPLIT_BOUNDARY', // default-ON perf: where the cache-proxy inserts the prompt cache-control boundary
  'PAPERCUSP_CACHE_TOOLS_BREAKPOINT', // default-OFF opt-in perf: inject an extra cache breakpoint after the tools block
  'PAPERCUSP_CACHE_PROXY_ROUTE', // psu-launcher boot-mode select: route spawned CLIs through the local cache-proxy sidecar (mirrors the other *_SIDECAR_MODE selectors above)
  'PAPERCUSP_MCP_PROXY_ABSORB_BOOT', // default-ON internal mcp-proxy tuning: absorb boot-time 5xx bursts (mirrors PAPERCUSP_MCP_PROXY_ABSORB_429 above)
  // ops watchdogs / alarms (default-ON, `=== '0'` opts out) — same bucket as the
  // *_WATCHDOG / *_ALARM entries already classified above
  'PAPERCUSP_COLD_BOOT_DRILL_AUTORUNNER', // periodic self-test that simulates a cold boot; internal health drill, not user-facing
  'PAPERCUSP_ESCALATION_AGING_ALARM', // ops alarm: flags escalations aging past a threshold with no response
  'PAPERCUSP_FEDERATION_JOIN_STALL_WATCHDOG', // ops watchdog: detects a stalled VM-federation join
  'PAPERCUSP_ORIGIN_FRESHNESS_WATCHDOG', // ops watchdog: detects a stale git origin/release pipeline read
  'PAPERCUSP_REPLICATION_ORPHAN_SWEEP', // default-ON dbos periodic sweep: reap orphaned replication state
  // dev/debug
  'PAPERCUSP_DEBUG_FIXTURE_DSN', // opt-in debug: point the coord test fixture at a real DSN instead of the in-memory default
]);

// Real default-OFF CAPABILITIES deliberately kept on an env gate (infra routing /
// process-mode read before FLAGS/PG access exists, awkward as a runtime /admin/features
// flip). Mirror of FLAGS' KNOWN_DARK_FLAGS + DARK_FLAGS_REVIEW_BY: each MUST carry a
// `reason` + a `reviewBy` (YYYY-MM-DD). A PAST reviewBy FAILS this lint — re-decide:
// turn it ON, migrate it to a FLAG, or push the date with a fresh reason. This is the
// guard the env-gate path lacked (EI-2390 / dark-capability-enforcement-2026-06-21).
// Audit it with: node scripts/check-env-feature-gates.mjs
const KNOWN_ENV_CAPABILITY_GATES = {
  // PAPERCUSP_STRUCTURAL_ERROR_VERIFIER: RESOLVED 2026-08-03 (EI-19453017656411107) — the
  // "DECIDE" this entry demanded was taken: ARMED (default-ON, `=== '0'` kill-switch) and
  // moved back into ALLOW's ops kill-switch block. Arming alone would have been a false
  // fix: its selection SQL used `LIKE 'repeated-tool-error:%:structural'`, which anchors
  // the class token to the END of the key and so excluded every FINGERPRINTED structural
  // key (90 of 133 live rows, 67.7%) — the daemon would have run blind to most of its own
  // class while appearing healthy. Both landed together.
  PAPERCUSP_PGBOUNCER: {
    reviewBy: '2026-09-01',
    reason: 'Transaction pooling — proven + LIVE on staging :3170 (systemd drop-in since 2026-06-21) AND on :3070 dev-api (systemd drop-in since 2026-07-20, EI-18147753127456018). RE-VERIFIED 2026-08-02: still not on papercup-bg-host.service (no matching drop-in) — rollout genuinely incomplete there. Stays env: it is a connection-URL routing switch read before any FLAGS/PG access exists. DECIDE: finish the bg-host rollout, or accept the current 2-of-3-hosts state as done and graduate to ALLOW.',
  },
  PAPERCUSP_LISTEN_HUB: {
    reviewBy: '2026-09-01',
    reason: 'Shared PG LISTEN connection hub (collapses 4 wake-bus conns → 1). RE-VERIFIED 2026-08-02: live on :3070 dev-api (systemd drop-in, 50-cluster.conf) only — no matching drop-in on staging-api or bg-host, and no .env.local entry anywhere in the shared tree. Rollout incomplete; DECIDE: finish rolling out to staging + bg-host, or migrate to a FLAG.',
  },
  PAPERCUSP_DESIGN_GATE: {
    reviewBy: '2026-09-01',
    reason: 'Design-phase invocation gate — blocks feature runs until design accepted/ignored. Built + 11 tests, OFF everywhere (re-verified 2026-08-02: no systemd drop-in, no .env.local entry on any of dev-api/staging-api/bg-host). Still pending an explicit decision; DECIDE: enable per-workspace or migrate to a FLAG.',
  },
  PAPERCUSP_AGENT_GOVERNOR: {
    reviewBy: '2026-09-01',
    reason: 'Agent-spawn rate governance (budget-based backpressure). Scaling-relevant (thousands-of-agents). RE-VERIFIED 2026-08-02: PAPERCUSP_AGENT_GOVERNOR=1 in apps/operator/.env.local (the shared staging tree) is live on papercup-staging-api.service (:3170) and papercup-bg-host.service, which both run from that tree — but NOT on papercup-dev-api.service (:3070 live release), which sources a separate .env.local in papercup-release with no such entry. Mid-rollout, not yet on the live/main host. DECIDE: roll out to :3070 or migrate to a FLAG.',
  },
  PAPERCUSP_AGENT_GOVERNOR_PG: {
    reviewBy: '2026-09-01',
    reason: 'Cross-process PG-backed agent-governor budget coordination for multi-process operators. Pairs with AGENT_GOVERNOR — same re-verified 2026-08-02 status: live on staging (:3170) + bg-host via the shared .env.local, not yet on :3070 live.',
  },
  PAPERCUSP_CHUNK_LOCK_PG: {
    reviewBy: '2026-09-01',
    reason: 'PG-backed file-lock coordinator for worker chunk loops (cross-feature concurrency, @papercusp/locks). Built, OFF (re-verified 2026-08-02: no systemd drop-in, no .env.local entry anywhere). Still pending an explicit decision; DECIDE: enable or migrate to a FLAG.',
  },
  PAPERCUSP_PERSIST_CHUNKS: {
    reviewBy: '2026-09-01',
    reason: 'Tool-output chunk archival to PG (harness_shared.invoker_run_chunks). Built, OFF (re-verified 2026-08-02: no systemd drop-in, no .env.local entry anywhere). Still pending an explicit decision; DECIDE: enable or migrate to a FLAG.',
  },
  PAPERCUSP_SHARED_OPERATOR: {
    reviewBy: '2026-09-01',
    reason: 'Multi-workspace orchestration mode (reads the workspace registry). Built, OFF (re-verified 2026-08-02: no systemd drop-in, no .env.local entry anywhere). Stays env: process-mode switch read at boot. DECIDE: enable or migrate to a FLAG.',
  },
  PAPERCUSP_GIT_EXPORT_COMMIT: {
    reviewBy: '2026-09-01',
    reason: 'Git-export commit recording in feature metadata. Built, OFF (re-verified 2026-08-02: no systemd drop-in, no .env.local entry anywhere). Still pending an explicit decision; DECIDE: enable or migrate to a FLAG.',
  },
  PAPERCUSP_MEMORY_DEDUP: {
    reviewBy: '2026-09-01',
    reason: "Memory dedup-on-remember (top-k similarity, checked === 'on'). Built, OFF (re-verified 2026-08-02: no systemd drop-in, no .env.local entry anywhere). Still pending an explicit decision; DECIDE: enable or migrate to a FLAG.",
  },
  PAPERCUSP_AMBIENT_CURSOR: {
    reviewBy: '2026-08-15',
    reason: 'Ambient-semantic-push P-002: adds each active agent\'s lexical cursor (data, not directive) to coord presence + wake teasers. Built + extensively wired (topic/dead-end/collision/adjacency matchers, presence-cursor overlay, wake-executor teaser). Default-OFF, opt-in. Surfaced by the EI-2390 2026-07-18 audit (assign-then-compare detection-gap fix). DECIDE: enable or migrate to a FLAG.',
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
const scannedFiles = new Set(); // every file that referenced a PAPERCUSP_ env var (for the 2nd pass below)
for (const line of raw.split('\n')) {
  const m = line.match(/^(.+?):(\d+):(.*)$/);
  if (!m) continue;
  const [, file, lineno, content] = m;
  if (!file.endsWith('.ts') && !file.endsWith('.tsx') && !file.endsWith('.mjs')) continue;
  if (file.endsWith('.test.ts') || file.endsWith('.test.tsx')) continue; // tests legitimately poke env
  scannedFiles.add(file);
  const g = content.match(GATE_RE);
  if (!g) continue;
  const name = g[1];
  seen.add(name);
  if (ALLOW.has(name) || name in KNOWN_ENV_CAPABILITY_GATES) continue;
  if (!hits.has(name)) hits.set(name, []);
  hits.get(name).push(`${file}:${lineno}`);
}

// ── 2nd pass: the "assign-then-compare" idiom (EI-2390 blind spot) ──
// `GATE_RE` above only catches a boolean literal compared on the SAME LINE as
// `process.env.X`. Both flagship capabilities this registry exists to track
// (PAPERCUSP_PGBOUNCER, PAPERCUSP_LISTEN_HUB) evolved to a two-line idiom —
// `const flag = process.env.X; if (flag === "1") …` — which made them silently
// invisible to the single-line scan (falsely reported "no longer found in code",
// EI-2390 audit 2026-07-18). Read each already-touched file's full content and
// also match `const/let NAME = process.env.X;` followed, within a bounded
// window, by a boolean-literal compare against that SAME local variable name.
const ASSIGN_RE = /(?:const|let)\s+(\w+)\s*=\s*process\.env\.(PAPERCUSP_[A-Z_0-9]+)\s*;/g;
for (const file of scannedFiles) {
  let text;
  try {
    text = readFileSync(join(ROOT, file), 'utf8');
  } catch {
    continue; // file moved/deleted since the git grep snapshot — skip, not fatal
  }
  for (const am of text.matchAll(ASSIGN_RE)) {
    const [, varName, name] = am;
    const windowEnd = Math.min(text.length, am.index + am[0].length + 400);
    const window = text.slice(am.index + am[0].length, windowEnd);
    const cmpRe = new RegExp(`\\b${varName}\\s*[!=]==?\\s*['"](?:1|0|true|false|on|off|yes|no)['"]`);
    if (!cmpRe.test(window)) continue;
    seen.add(name);
    if (ALLOW.has(name) || name in KNOWN_ENV_CAPABILITY_GATES) continue;
    if (!hits.has(name)) hits.set(name, []);
    hits.get(name).push(`${file} (assign-then-compare)`);
  }
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
  // WI-6776: this guard's verdict is an ABSENCE claim ("no unclassified env gate exists"),
  // and `git grep --recurse-submodules` cannot descend into an archive-extracted submodule
  // (no .git) — so in a release-shaped checkout it searches the superproject only and still
  // prints clean. Coverage is derived from the same enumerator the recursion depends on.
  const cov = coverageOf(listTrackedFiles(ROOT).files, ROOT);
  console.log(
    'check-env-feature-gates: clean — every boolean PAPERCUSP_ env gate is classified config ' +
      `or a registered (in-review) capability (searched the superproject + ` +
      `${cov.scanned.length}/${cov.declared.length} submodule(s)).` +
      describeUnscanned(cov, ROOT),
  );
}
process.exit(fail ? 1 : 0);
