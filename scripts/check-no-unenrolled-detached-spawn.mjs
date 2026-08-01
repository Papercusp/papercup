#!/usr/bin/env node
/**
 * check-no-unenrolled-detached-spawn.mjs — the task manager's build guard
 * (task-manager-no-escape-2026-07-27, P-016).
 *
 *   node scripts/check-no-unenrolled-detached-spawn.mjs
 *
 * ── WHAT IT POLICES, AND WHY NOT MORE ───────────────────────────────────────
 *
 * There are ~813 raw `spawn`/`exec` call sites in this tree. A guard over all of
 * them would need an allowlist so large it would be meaningless, and it would be
 * policing the wrong thing anyway: cgroup membership is INHERITED, so a short-lived
 * `git rev-parse` inside an already-confined process is already accounted for. What
 * actually needs naming is the ROOT of a subtree — a process launched to OUTLIVE
 * the call that made it (plan D-001).
 *
 * The precise, statically-detectable signal for that is `detached: true` in a spawn
 * options object. That flag means exactly "this child gets its own process group
 * because it will outlive me and I intend to reap its tree later" — which is the
 * same population the task manager needs enrolled. There are ~26 such sites, which
 * is a reviewable allowlist rather than a rubber stamp.
 *
 * A file passes when it EITHER imports the task-manager enrolment surface
 * (`task-manager/managed-spawn` or `task-manager/enroll-sync`) OR carries an
 * explicit ALLOWLIST entry with a reason. New unenrolled detached spawns fail.
 *
 * The predicate is exported and unit-tested, so "fails on a new raw detached spawn"
 * is a durably verified property rather than green-on-a-clean-tree (the same
 * discipline check-no-raw-agent-spawn.mjs applies to its own bypass predicate).
 */
import { execSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const ROOT = new URL('..', import.meta.url).pathname;

/**
 * Sites that legitimately spawn a detached process WITHOUT task-manager enrolment.
 * Every entry needs a reason. Shrinking this list is the point; growing it needs a
 * justification in review.
 */
export const ALLOWLIST = new Map([
  // ── one-shot host/dev plumbing, not fleet work ───────────────────────────
  // NOTE: this file serves TWO shapes and only ONE of them is exempt. The HEADLESS
  // path (spawnHeadless) IS enrolled — it has no window, it is the largest agent
  // subtree on the box, and it is the EI-9748 population. The exemption covers only
  // spawnConsole, where a human's terminal WINDOW is the unit of control. Treating
  // the whole file as exempt was the original mistake and left 80 live fleet
  // members invisible; the import of task-manager/enroll-sync now clears the guard
  // for the file, so this entry is documentation rather than a live exemption.
  ['packages/operator-core/lib/console-spawn.ts', 'spawnConsole opens a desktop TERMINAL for a human (window is the unit of control); spawnHeadless IS enrolled'],
  ['packages/operator-core/lib/terminal-spawn.ts', 'same: a human-facing terminal window'],
  ['packages/operator-core/lib/harness-launch.ts', 'harness bring-up, supervised by the harness lifecycle rather than the task ledger'],
  ['packages/operator-core/lib/agent-tools/dev/restart.ts', 'restarts a systemd unit — already supervised by SUPERVISED_PROCESSES + unit-reconciler'],
  ['packages/operator-core/lib/harness/env-operator-launcher.ts', 'boots an operator; enrolling it in a ledger the operator itself owns would be circular'],
  ['apps/operator/bin/host-bootstrap.ts', 'runs BEFORE the operator (and therefore the ledger) exists'],

  // ── sidecars: supervised by SUPERVISED_PROCESSES, P-009 follow-up ────────
  ['packages/operator-core/lib/sync/hyperbee/substrate-sidecar-spawn.ts', 'sidecar with its own respawn/circuit-breaker supervision; ledger enrolment is a P-009 follow-up'],

  // ── gym / bench harnesses: throwaway rigs, torn down by their own runner ──
  ['packages/operator-core/lib/gym/ab-run.ts', 'gym A/B rig: bounded, torn down by its own runner at the end of the cycle, never outlives it'],
  ['packages/operator-core/lib/gym/blueprint-cycle.ts', 'gym blueprint cycle: bounded rig torn down by its own runner when the cycle ends'],
  ['packages/operator-core/lib/gym/smoke.ts', 'gym smoke rig: own process group purely so teardown can kill the npx->node tree'],
  ['packages/operator-core/lib/gym/autoloop-cycle.ts', 'gym autoloop cycle: bounded rig torn down by its own runner'],
  ['packages/operator-core/lib/gym/wake-mode.ts', 'gym wake-mode rig: bounded, torn down by its own runner'],
  ['packages/operator-core/lib/behaviour-suite/runner-node.ts', 'behaviour-suite runner: a bounded test rig whose lifetime is the suite run itself'],
  ['packages/operator-core/lib/harness/routines/p2p-perf-actions.ts', 'p2p perf bench: a bounded advisory run, reaped by the routine that started it'],
  ['packages/operator-core/lib/harness/routines/cargo-test-action.ts', 'cargo test run: bounded by the test command, reaped by the routine that started it'],
  ['packages/operator-core/lib/harness/routines/gitnexus-reindex-action.ts', 'gitnexus reindex: detached ONLY to own a process group so the timeout can kill the whole npx->node->tree-sitter tree (runGitnexusAnalyze.killTree, SIGTERM then SIGKILL) rather than the wrapper. Bounded by timeoutMs; same precedent as cargo-test-action.ts / p2p-perf-actions.ts above'],
  ['libs/papercusp/packages/orchestrator/src/scratch-env.ts', 'scratch env for a throwaway harness; the harness lifecycle owns teardown, not the ledger'],
  ['tools/perf-test/wdio/wdio.conf.ts', 'wdio perf runner: detached ONLY to get a killable process GROUP so onComplete can reap the xvfb-run -> tauri-driver -> {WebKitWebDriver, Xvfb} tree instead of the wrapper shell (EI-18886600444441200). The group never outlives the run — reaped in onComplete AND on exit/SIGINT/SIGTERM/SIGHUP. Standalone test-runner config: the operator, and therefore the ledger, is not running in this process'],

  // ── release/deploy: detached BY DESIGN so it survives the operator restart ─
  ['packages/operator-core/lib/harness/routines/release-actions.ts', 'release cut must survive the operator restart it performs — a ledger row the operator owns cannot outlive it'],
  ['packages/operator-core/lib/endpoint-route/routes/admin/run.ts', 'admin-triggered script run, owned by the admin request that started it and killed with it'],

  // ── media/device pipelines: lifetime bound to a stream, not a task ───────
  ['packages/operator-core/lib/voice-node/screen-track/screen-capture-source.ts', 'capture pipeline bound to a live stream'],
  ['packages/operator-core/lib/deployment/frame-vnc.ts', 'VNC frame server bound to a display lease'],
  ['packages/operator-core/lib/inference-gateway/codex-cli-bridge.ts', 'inference bridge bound to a gateway session'],

  // ── wake executor: fires a wake into an EXISTING agent, not a new subtree ─
  ['packages/operator-core/lib/events/await/wake-executor.ts', 'delivers a wake to an already-enrolled agent session'],
]);

const ENROLMENT_IMPORTS = [
  'task-manager/managed-spawn',
  'task-manager/enroll-sync',
  './managed-spawn',
  './enroll-sync',
];

/**
 * PURE predicate: does this file spawn a detached process without enrolling it?
 *
 * Exported for the unit test — the guard's own correctness is a property that must
 * be verified, not assumed from a green run on a tree that happens to be clean.
 */
export function isUnenrolledDetachedSpawn(relPath, source) {
  if (!/detached:\s*true/.test(source)) return false;
  // A comment mentioning `detached: true` (several files explain the flag at
  // length) is not a spawn. Require it inside an object literal alongside a real
  // spawn call in the same file.
  const hasSpawnCall = /\b(spawn|childSpawn|spawnFn)\s*\(/.test(source);
  if (!hasSpawnCall) return false;
  const codeLines = source
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join('\n');
  if (!/detached:\s*true/.test(codeLines)) return false;
  if (ENROLMENT_IMPORTS.some((m) => source.includes(m))) return false;
  return !ALLOWLIST.has(relPath);
}

function trackedFiles() {
  const out = execSync('git ls-files "*.ts" "*.tsx"', { cwd: ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  return out
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
    .filter((p) => !p.includes('/_retired/') && !p.includes('/node_modules/'))
    .filter((p) => !/\.(test|spec)\.tsx?$/.test(p));
}

function main() {
  const offenders = [];
  for (const rel of trackedFiles()) {
    let source;
    try {
      source = readFileSync(`${ROOT}${rel}`, 'utf8');
    } catch {
      continue;
    }
    if (isUnenrolledDetachedSpawn(rel, source)) offenders.push(rel);
  }

  if (offenders.length === 0) {
    console.log(`[no-unenrolled-detached-spawn] OK — ${ALLOWLIST.size} allowlisted site(s), no new ones.`);
    return;
  }

  console.error('[no-unenrolled-detached-spawn] FAIL — detached spawn(s) with no task-manager enrolment:\n');
  for (const o of offenders) console.error(`  ${o}`);
  console.error(
    '\nA `detached: true` spawn creates a process meant to OUTLIVE this call — the exact\n' +
      'population the task manager exists to keep addressable. Either:\n\n' +
      '  1. enrol it — `beginSyncEnrolment` + `completeSyncEnrolment` from\n' +
      '     packages/operator-core/lib/task-manager/enroll-sync.ts (sync seams), or\n' +
      '     `managedSpawn` from task-manager/managed-spawn.ts (async seams); or\n' +
      '  2. add it to ALLOWLIST in this file WITH A REASON, if its lifetime genuinely\n' +
      '     is not ours to own (a human terminal window, a pre-operator bootstrap, a\n' +
      '     release cut that must survive the restart it performs).\n\n' +
      'Silently un-enrolled is the one option that is not available: it becomes an\n' +
      '`unaccounted` alarm on the next reconcile anyway, just without provenance.',
  );
  process.exitCode = 1;
}

const invokedDirectly = (() => {
  try {
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1] ?? '')).href;
  } catch {
    return false;
  }
})();
if (invokedDirectly) main();
