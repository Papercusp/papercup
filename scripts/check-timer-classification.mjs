#!/usr/bin/env node
/**
 * check-timer-classification.mjs — fail-loud guard against a NEW timer registration
 * (`managedSetInterval` / `PeriodicCheck`) landing without a declared D-004
 * push-don't-poll classification (P-011, stop-discarded-dedup-and-audit-server-
 * polling-2026-07-26).
 *
 * D-004 sorts every recurring timer into three buckets — 'must-sample' (no event
 * source exists), 'timeout-reaper' (the passage of time IS the trigger), or
 * 'violation' (recomputes derived state a store already emits change events for).
 * The C1-C4 audit lanes (P-014..P-017) hand-classified all ~104 timers that existed
 * on 2026-07-26, but that verdict lived only in plan/work-item prose — nothing
 * stopped it from going stale the moment a NEW timer was added elsewhere. This guard
 * closes that gap the same way `lint:no-raw-setinterval` (P-007/P-008) closed the
 * "is it even visible" gap: a shrink-only BASELINE grandfathers the pre-existing
 * unclassified call sites; a NEW site outside the baseline that doesn't pass
 * `classification: '<must-sample|timeout-reaper|violation>'` fails the build.
 *
 * visibility != control (same principle as no-raw-setinterval): this guard does NOT
 * forbid registering a 'violation'-classified timer — it only forbids OMITTING the
 * classification. Whether a violation should exist at all is a design review question
 * for whoever reads the code / schedule:inventory, not something a lint can decide.
 *
 *   node scripts/check-timer-classification.mjs
 *
 * DETECTION is TEXTUAL (not an AST parse), mirroring check-no-raw-setinterval.mjs:
 * find each `managedSetInterval(` call, extract its balanced-paren argument text, and
 * check whether that text contains the substring `classification:` (matches both a
 * literal `classification: 'must-sample'` and a threaded `classification:
 * check.classification` — the in-process-periodic.ts seam does the latter, since its
 * PeriodicCheck interface makes `classification` REQUIRED and this guard only needs
 * to confirm the option was PASSED, not re-validate the enum value TS already pins).
 *
 * GRANULARITY: like check-no-raw-setinterval's BASELINE, grandfathering is FILE-level,
 * not call-site-level — a baselined file with ONE unclassified call could in principle
 * grow a second unclassified call without tripping this guard. Accepted tradeoff for
 * parity with the established convention; a call-site-level baseline (keyed by
 * file:startOffset) would catch that but adds real complexity for a marginal gain the
 * shrink-to-empty discipline (this BASELINE going to zero) removes entirely anyway.
 *
 * EXCLUDED (never scanned): vendored / build output / _retired / tests / non-source /
 *   .tsx (browser timers use the client sync layer, not managedSetInterval).
 *
 * ALLOWLIST_DIRS (permanently allowed): the registry's own impl + test files (the
 *   `classification:` option they define/exercise, not a call site needing one).
 *
 * BASELINE (TEMPORARY — shrink to EMPTY as each file gets a real audited
 *   classification, same discipline as no-raw-setinterval's P-008 codemod): the 74
 *   files with a `managedSetInterval(` call as of 2026-07-26 (P-011), none of which
 *   were in scope for the C1/C2 audit lanes (those covered in-process-periodic.ts +
 *   produced the master tally, not a per-call-site classification for every one of
 *   these). NEW files may NOT be added here.
 */
import { execSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const ROOT = new URL('..', import.meta.url).pathname;

export const ALLOWLIST_DIRS = [
  'libs/generic/scheduled-registry/', // the registry impl itself + its own tests
];

export const ALLOWLIST = new Set([
  // This guard itself: its own comments/detection text mention `managedSetInterval(`
  // and `classification:` literally, exactly as check-no-raw-setinterval allowlists
  // its own definition site.
  'scripts/check-timer-classification.mjs',
  // Its sibling guard's console.error prose literally contains the string
  // "managedSetInterval(name, ms, fn, { category })" as a usage hint — a textual
  // false positive, not a real unclassified call site.
  'scripts/check-no-raw-setinterval.mjs',
]);

/**
 * BASELINE (TEMPORARY — must shrink to EMPTY): files whose `managedSetInterval(` call(s)
 * do not yet declare a `classification`. Seeded 2026-07-26 (P-011) from the tracked tree
 * at that date. Do NOT add new entries — a new call site must classify itself; an
 * existing baselined file should be REMOVED from this set as part of whatever change
 * next touches its timer (classify it then, don't leave it for a dedicated sweep).
 */
export const BASELINE = new Set([
  'apps/operator/bin/serve.ts',
  'packages/operator-core/lib/agent-tools/locks/acquire.ts',
  'packages/operator-core/lib/agent-tools/locks/file-lock-authority-wiring.ts',
  'packages/operator-core/lib/auth-config-overrides.ts',
  'packages/operator-core/lib/blueprint/launch-blueprint.ts',
  'packages/operator-core/lib/capability-envelope-overrides.ts',
  'packages/operator-core/lib/capability-tier-overrides.ts',
  'packages/operator-core/lib/claude-credential-sync.ts',
  'packages/operator-core/lib/cross-hive-swarm-transport.ts',
  'packages/operator-core/lib/dbos/bootstrap.ts',
  'packages/operator-core/lib/dbos/dbos-executor-reaper.ts',
  'packages/operator-core/lib/dbos/durable-spawn.ts',
  'packages/operator-core/lib/dbos/ephemeral-executor.ts',
  'packages/operator-core/lib/deployment/frame-view.ts',
  'packages/operator-core/lib/device-push-credentials.ts',
  'packages/operator-core/lib/device-voice-ws.ts',
  'packages/operator-core/lib/endpoint-route/routes/agent-mcp/run-command-sse.ts',
  'packages/operator-core/lib/endpoint-route/routes/harness/streams.ts',
  'packages/operator-core/lib/endpoint-route/routes/pty/index.ts',
  'packages/operator-core/lib/endpoint-route/routes/transport/_mcp-handler.ts',
  'packages/operator-core/lib/endpoint-route/routes/tui/intents-stream.ts',
  'packages/operator-core/lib/endpoint-route/routes/ui/intents-stream.ts',
  'packages/operator-core/lib/event-loop-lag-monitor.ts',
  'packages/operator-core/lib/events/await/engine.ts',
  'packages/operator-core/lib/events/await/predicate-watch.ts',
  'packages/operator-core/lib/events/await/psu-pty-discovery.ts',
  'packages/operator-core/lib/expirable-registry.ts',
  'packages/operator-core/lib/fleet/chat-spawn-tracking.ts',
  'packages/operator-core/lib/fleet/operator-spawn.ts',
  'packages/operator-core/lib/harness-fs-watcher.ts',
  'packages/operator-core/lib/harness-state/git-export/drainer.ts',
  'packages/operator-core/lib/harness-status-sweep.ts',
  'packages/operator-core/lib/harness/structural-error-verifier.ts',
  'packages/operator-core/lib/hive-directory.ts',
  'packages/operator-core/lib/inference-gateway/gateway-sidecar-spawn.ts',
  'packages/operator-core/lib/inference-gateway/gateway.ts',
  'packages/operator-core/lib/inference-gateway/stall-waker-loop.ts',
  'packages/operator-core/lib/loop-pressure-governor.ts',
  'packages/operator-core/lib/memory-watchdog.ts',
  'packages/operator-core/lib/overwatch/escalation-aging-alarm.ts',
  'packages/operator-core/lib/overwatch/loop.ts',
  'packages/operator-core/lib/provision/runner.ts',
  'packages/operator-core/lib/pty-bridge.ts',
  'packages/operator-core/lib/pty-ws.ts',
  'packages/operator-core/lib/quota-overrides.ts',
  'packages/operator-core/lib/red-queen/engine-death.ts',
  'packages/operator-core/lib/release/git-sync-stall-watchdog.ts',
  'packages/operator-core/lib/release/green-stall-watchdog.ts',
  'packages/operator-core/lib/release/origin-freshness-watchdog.ts',
  'packages/operator-core/lib/release/worktree-coverage-watchdog.ts',
  'packages/operator-core/lib/sync/hyperbee/boot.ts',
  'packages/operator-core/lib/sync/hyperbee/cluster-booted-handles-sync.ts',
  'packages/operator-core/lib/sync/hyperbee/federation-join-stall-watchdog.ts',
  'packages/operator-core/lib/sync/hyperbee/outbox-drain.ts',
  'packages/operator-core/lib/sync/hyperbee/substrate-eviction-reaper.ts',
  'packages/operator-core/lib/sync/hyperbee/swarm.ts',
  'packages/operator-core/lib/sync/hyperbee/topic-gossip.ts',
  'packages/operator-core/lib/sync/hyperbee/wire-outbox.ts',
  'packages/operator-core/lib/sync/pot-git/peer-dial-registry.ts',
  'packages/operator-core/lib/system-health/carry-drill-drop-watchdog.ts',
  'packages/operator-core/lib/system-health/cluster-lag-watchdog.ts',
  'packages/operator-core/lib/system-health/codex-rollout-persistence-watchdog.ts',
  'packages/operator-core/lib/system-health/cold-boot-drill-autorunner.ts',
  'packages/operator-core/lib/system-health/compaction-compliance-watchdog.ts',
  'packages/operator-core/lib/system-health/condition-staleness-alarm.ts',
  'packages/operator-core/lib/system-health/lag-self-restart.ts',
  'packages/operator-core/lib/system-health/liveness-alarm.ts',
  'packages/operator-core/lib/system-health/mcp-dark-watchdog.ts',
  'packages/operator-core/lib/system-health/single-primary-check.ts',
  'packages/operator-core/lib/telemetry-buffer-config.ts',
  'packages/operator-core/lib/txn-timeouts-config.ts',
  'packages/operator-core/lib/voice-engine-health.ts',
  'packages/operator-core/lib/voice-node/operator-voice-host.ts',
  'packages/operator-core/lib/voice-node/screen-track/screen-publisher.ts',
  'packages/operator-core/lib/voice-node/sentinel-says-pump.ts',
  'packages/plugin-loader/src/daemon/supervisor.ts',
]);

export const isExcluded = (f) =>
  f.startsWith('_retired/') ||
  f.includes('/_retired/') ||
  f.includes('/node_modules/') ||
  f.includes('/dist/') ||
  f.includes('/.next/') ||
  f.includes('/build/') ||
  f.includes('/storybook-static/') ||
  f.includes('/code-server/') ||
  f.includes('/spa/assets/') ||
  f.includes('/holepunch-spike/') ||
  /\.(test|spec)\.[cm]?tsx?$/.test(f) ||
  f.endsWith('.tsx') ||
  !/\.(ts|mjs|cjs)$/.test(f);

/** Strip block (incl. JSDoc) + line comments so a prose mention doesn't confuse detection. */
export function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

/**
 * Find the balanced-paren text of every `managedSetInterval(...)` CALL in `text`
 * (after comments are stripped). Returns an array of the substrings between the
 * call's opening `(` and its matching closing `)`, INCLUSIVE of nested parens —
 * good enough for a textual "does this call's arguments mention `classification:`"
 * check without a real AST parse (mirrors the simplicity of check-no-raw-setinterval).
 */
export function findManagedSetIntervalCalls(text) {
  const clean = stripComments(text);
  const calls = [];
  const re = /\bmanagedSetInterval\s*\(/g;
  let m;
  while ((m = re.exec(clean))) {
    const start = re.lastIndex; // just after the opening '('
    let depth = 1;
    let i = start;
    for (; i < clean.length && depth > 0; i++) {
      if (clean[i] === '(') depth += 1;
      else if (clean[i] === ')') depth -= 1;
    }
    calls.push(clean.slice(start, i - 1));
  }
  return calls;
}

/** True iff `text` contains at least one `managedSetInterval(...)` call missing `classification:`. */
export function hasUnclassifiedCall(text) {
  return findManagedSetIntervalCalls(text).some((argText) => !/\bclassification\s*:/.test(argText));
}

/** Scan the tracked tree for offenders (excludes vendored/tests/.tsx + ALLOWLIST + BASELINE). */
export function findOffenders() {
  const tracked = execSync('git ls-files', {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  })
    .split('\n')
    .filter(Boolean);

  const offenders = [];
  for (const f of tracked) {
    if (isExcluded(f)) continue;
    if (ALLOWLIST.has(f) || BASELINE.has(f)) continue;
    if (ALLOWLIST_DIRS.some((p) => f.startsWith(p))) continue;
    let text;
    try {
      text = readFileSync(new URL(f, `file://${ROOT}`), 'utf8');
    } catch {
      continue;
    }
    if (hasUnclassifiedCall(text)) offenders.push(f);
  }
  return offenders;
}

function main() {
  const offenders = findOffenders();
  if (offenders.length === 0) {
    const note = BASELINE.size > 0 ? ` (${BASELINE.size} file(s) still in the shrink-to-empty BASELINE — P-011)` : '';
    console.log(`✓ no NEW unclassified managedSetInterval() timer${note}.`);
    process.exit(0);
  }
  console.error('✗ NEW managedSetInterval(...) call(s) missing a D-004 classification:');
  console.error('  Pass { category, classification: \'must-sample\' | \'timeout-reaper\' | \'violation\' }');
  console.error('  from @papercusp/scheduled-registry — see D-004 (stop-discarded-dedup-and-audit-');
  console.error('  server-polling-2026-07-26) for the three-bucket test.\n');
  for (const o of offenders) console.error('    ' + o);
  console.error(
    `\n  ${offenders.length} offender(s). See plan stop-discarded-dedup-and-audit-server-polling-2026-07-26 (P-011).`,
  );
  process.exit(1);
}

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
  main();
}
