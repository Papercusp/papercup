#!/usr/bin/env node
/**
 * check-no-raw-setinterval.mjs — fail-loud guard against NEW bare setInterval()
 * (schedule-inventory-and-ephemeral-tier-2026-06-26, P-007).
 *
 * Every recurring timer in the operator host must go through `managedSetInterval`
 * (@papercusp/scheduled-registry) so it is NAMED + LISTABLE in schedule:inventory —
 * the "see EVERYTHING running on a timer" guarantee. A bare `setInterval(...)` is
 * runtime-INVISIBLE. This guard fails the build when a NEW bare setInterval appears
 * outside the allowed sites, so the universal-visibility ratchet (the P-008 codemod)
 * can't silently erode back.
 *
 * visibility != control: registering a timer does NOT centralize its scheduling — a
 * watchdog still runs as its own out-of-band interval; it just calls
 * `managedSetInterval(name, ms, fn, { category: 'watchdog' })` so it's listed.
 *
 *   node scripts/check-no-raw-setinterval.mjs
 *
 * EXCLUDED (never scanned): vendored / build output / _retired / tests / non-source
 *   AND .tsx — browser/renderer timers run in the webview, not the host, and cannot
 *   reach the server-side registry (UI-timer visibility is a separate client concern).
 *
 * ALLOWLIST_DIRS (permanently allowed): the registry impl itself (its default timer
 *   seam IS setInterval) + libs/generic/* libraries that keep their own timers (sse,
 *   tooldef) — domain-free, must NOT depend on operator-core's registry (layering).
 *
 * BASELINE (TEMPORARY — must shrink to EMPTY): operator-host files that still call bare
 *   setInterval pending the P-008 codemod. NEW files may NOT be added here. P-008
 *   migrates each to managedSetInterval (remove from BASELINE) or, if it is genuinely a
 *   separate-process / generic site, promotes it into ALLOWLIST_DIRS / ALLOWLIST.
 *
 * The predicate (usesRawSetInterval) is exported + unit-tested
 * (packages/operator-core/lib/dbos/no-raw-setinterval-guard.test.ts) so the
 * "fails on a NEW bare setInterval" property is durably verified, not only
 * green-on-clean-tree.
 */
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const ROOT = new URL('..', import.meta.url).pathname;

/** Permanently-allowed directory prefixes (the registry impl + generic libs with own timers). */
export const ALLOWLIST_DIRS = [
  'libs/generic/scheduled-registry/', // the wrapper itself — its default seam is setInterval
  'libs/generic/sse/', // generic SSE lib: keeps its own heartbeat/reaper timers (can't import operator-core)
  'libs/generic/tooldef/', // generic tool-dispatch lib: own GC/idle timers
  'libs/generic/p2p-voice/', // generic voice lib: own per-session timers (domain-free)
  'packages/operator-core/lib/external-bench/', // bench harness — per-run samplers/heartbeats, not host timers
  'packages/operator-core/lib/deployment/p2p-perf-tier3/', // perf-test CHILD processes
  'packages/operator-core/lib/sync/hyperbee/perf/', // perf-test measurement processes
  'apps/operator/scripts/', // standalone .mjs processes (psu-launcher/pty-host, bghost-watchdog) — separate procs
];

/** Permanently-allowed individual files (rare; prefer ALLOWLIST_DIRS). */
export const ALLOWLIST = new Set([
  // This guard itself: its console messages + the detection regex literally contain
  // "setInterval(" (the thing it bans), exactly as check-no-raw-agent-spawn allowlists
  // its own definition site.
  'scripts/check-no-raw-setinterval.mjs',
  // Browser/client .ts — run in the webview, not the host; cannot reach the server-side
  // registry (verified client-side: window./document./useEffect/MediaRecorder).
  'apps/operator/app/_components/SetupWizard/useWizardStatuses.ts',
  'apps/operator/app/_components/voice/voice-leader.ts',
  'apps/operator/app/admin/plans/plans-api.ts',
  'apps/operator/app/admin/testing/_lib/vitals-recorder.ts',
  'apps/operator/lib/ui/use-ui-presence.ts',
  'apps/operator-vite/src/lib/video/camera-capture.ts',
  'packages/operator-core/lib/voice-engines/deepgram.ts', // browser STT adapter — window.setInterval + MediaRecorder, runs in the webview not the host
  // Separate processes that don't share the operator registry.
  'packages/operator-core/lib/deployment/cross-hive-frame.ts', // cross-hive e2e spike child process
  'packages/operator-core/lib/inference-gateway/gateway.ts', // runs INSIDE the :8788 inference-gateway process
  'packages/operator-core/lib/inference-gateway/launch.ts', // :8788 gateway process bootstrap
  'packages/operator-core/lib/inference-gateway/watchdog.mjs', // standalone systemd watchdog for the gateway
]);

/**
 * TEMPORARY grandfather set — operator-host files with bare setInterval awaiting the
 * P-008 codemod. SHRINK-ONLY: never add a new entry. Emptied by P-008.
 */
export const BASELINE = new Set([
  // Seeded from the tree state at P-007 (74 files). SHRINK-ONLY: P-008 migrates each to
  // managedSetInterval (remove here) or promotes a genuine separate-process/generic site
  // to ALLOWLIST_DIRS / ALLOWLIST. Do NOT add new entries.
  'packages/operator-core/lib/deployment/frame-view.ts',
  'packages/operator-core/lib/device-push-credentials.ts',
  'packages/operator-core/lib/harness-fs-watcher.ts',
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
  f.endsWith('.tsx') || // browser/renderer timers — webview, not the host; separate concern
  !/\.(ts|mjs|cjs)$/.test(f);

/** Strip block (/* *​/, incl. JSDoc) + line (//) comments so a prose mention of setInterval() isn't flagged. */
export function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

/**
 * The tell: a CALL to `setInterval(...)`. Case-sensitive lowercase `setInterval`
 * followed by optional whitespace + `(` — so it does NOT match `managedSetInterval(`
 * (capital S), `setIntervalImpl(` / `setIntervalFn(` (followed by Impl/Fn, not `(`),
 * or `typeof setInterval` (followed by `>`/`,`). Comments are stripped first. Pure
 * (text → boolean) so it's unit-testable.
 */
export function usesRawSetInterval(text) {
  return /\bsetInterval\s*\(/.test(stripComments(text));
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
    if (usesRawSetInterval(text)) offenders.push(f);
  }
  return offenders;
}

function main() {
  const offenders = findOffenders();
  if (offenders.length === 0) {
    const note = BASELINE.size > 0 ? ` (${BASELINE.size} file(s) still in the shrink-to-empty BASELINE — P-008)` : '';
    console.log(`✓ no NEW bare setInterval() — every operator-host timer goes through managedSetInterval${note}.`);
    process.exit(0);
  }
  console.error('✗ NEW bare setInterval() call(s) outside the scheduled-registry:');
  console.error('  Use managedSetInterval(name, intervalMs, fn, { category }) from @papercusp/scheduled-registry');
  console.error('  so the timer is NAMED + visible in schedule:inventory (visibility != control —');
  console.error('  a watchdog still runs out-of-band; it just registers).\n');
  for (const o of offenders) console.error('    ' + o);
  console.error(
    `\n  ${offenders.length} offender(s). See plan schedule-inventory-and-ephemeral-tier-2026-06-26 (P-007/P-008).`,
  );
  process.exit(1);
}

// Run the scan only when invoked as a CLI — importing the module (for the unit test)
// must NOT exec git / exit the process.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
