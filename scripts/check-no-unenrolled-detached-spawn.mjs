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
import { stripCommentsAndStrings, stripCommentsOnly } from './lib/strip-comments-and-strings.mjs';
import { describeUnscanned, listTrackedFiles } from './lib/tracked-files.mjs';
import { readFileSync, realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const ROOT = new URL('..', import.meta.url).pathname;

/**
 * Sites that legitimately spawn a detached process WITHOUT task-manager enrolment.
 * Every entry needs a reason. Shrinking this list is the point; growing it needs a
 * justification in review.
 */
export const ALLOWLIST = new Map([
  // ── detached ONLY for process-group kill of an AWAITED child ─────────────
  //
  // A third category the original guard did not anticipate, and its false-positive
  // class. `detached: true` has TWO distinct uses, and this guard's premise —
  // "detached means the process outlives the call" — only covers one of them:
  //
  //   (1) outlive the caller           -> must be enrolled (the guard's real target)
  //   (2) become a process-group LEADER so a timeout can `kill(-pid)` the whole
  //       tree instead of orphaning grandchildren -> the child is AWAITED and dies
  //       with the call. Nothing outlives anything; there is no subtree to keep
  //       addressable after the call returns, so a ledger row would be born and
  //       closed inside one tool invocation.
  //
  // bash-jobs.ts documents (2) explicitly (capability-bash-orphan-kill-2026-06-21)
  // and it is now the idiom for any tool that shells out with a timeout. Both
  // entries below are that shape: added after this guard landed, both awaited, both
  // group-killed on timeout. Enrolling them would add ledger churn with no
  // addressability gain.
  //
  // If a static way to separate (1) from (2) appears — an awaited `child` whose
  // promise resolves in the same function — the predicate should prefer it and
  // these two should come off the list.
  ['packages/operator-core/lib/agent-tools/testing/run.ts', 'detached ONLY to lead a process group so a timeout group-kills vitest; the child is awaited and dies with the call'],
  ['packages/operator-core/lib/agent-tools/build/typecheck.ts', 'detached ONLY to lead a process group so a timeout group-kills tsc; the child is awaited and dies with the call'],

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

  // ── sidecars ─────────────────────────────────────────────────────────────
  // substrate-sidecar-spawn.ts USED to sit here as "ledger enrolment is a P-009
  // follow-up". P-009 landed (task-manager-no-escape-2026-07-27): it now calls
  // beginSyncEnrolment/completeSyncEnrolment/finishSyncEnrolment, so the guard
  // clears it on the import and the entry is gone rather than kept as dead
  // documentation. Deliberately NOT left in place: a stale exemption whose stated
  // reason has become false would silently re-cover the file if the enrolment were
  // ever removed — the D-012 lesson (an allowlist entry is scoped to the lifetime
  // semantics it actually describes, and a reviewer should read a no-longer-true
  // reason as a smell).
  //
  // The other three sidecars need no entry: spawner-sidecar goes through
  // managedSpawn, embed-sidecar spawns with detached:false (so it dies with the
  // operator and is cgroup-inherited per D-001, and this guard's predicate never
  // fires on it), and the inference gateway is a systemd-user unit the operator
  // does not spawn at all.

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
  ['scripts/affected-tests.mjs', 'affected-test task: detached ONLY to own a process group so the per-task watchdog reaps npm->shell->vitest->workers and closes captured pipes at the bound; the bounded runner waits for and owns the group'],
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
 *
 * @param {string} relPath - Repo-relative path, as it appears in ALLOWLIST.
 * @param {string} source - The file's full source text.
 * @returns {boolean}
 */
export function isUnenrolledDetachedSpawn(relPath, source) {
  // DETECTION is on CODE. `detached: true` and the spawn call are both program text, so the
  // strings mask is unambiguously right — and it replaces a hand-rolled line filter that only
  // recognised a comment OPENING a line, so a trailing `// ... detached: true` or any block-comment
  // body not starting with `*` walked straight through it, as did a template literal quoting a
  // spawn (WI-37717).
  // Cheap RAW pre-filter before the mask: blanking is MONOTONIC (it can only remove a match,
  // never create one), so a file without both tokens in raw text cannot have them masked either
  // — and this guard scans every tracked .ts/.tsx in the repo, where an unconditional TS parse
  // per file costs minutes.
  if (!/detached:\s*true/.test(source)) return false;
  if (!/\b(spawn|childSpawn|spawnFn)\s*\(/.test(source)) return false;
  const code = stripCommentsAndStrings(source, relPath);
  if (!/detached:\s*true/.test(code)) return false;
  if (!/\b(spawn|childSpawn|spawnFn)\s*\(/.test(code)) return false;
  // The EXEMPTION needs the OTHER mask: it reads a string VALUE — the enrolment module SPECIFIER
  // — so `stripCommentsAndStrings` would blank the very evidence and score every file
  // unenrolled (mass false POSITIVES). Masking nothing is the opposite failure and the worse
  // one: a COMMENT that merely NAMES managed-spawn buys an exemption the file never earned, a
  // false NEGATIVE, the direction that silently loses real findings.
  const prose = stripCommentsOnly(source, relPath);
  if (ENROLMENT_IMPORTS.some((m) => prose.includes(m))) return false;
  return !ALLOWLIST.has(relPath);
}

/**
 * WI-6730: enumerate via the shared helper, which recurses into submodules. The
 * previous `git ls-files "*.ts" "*.tsx"` did not — it emits one gitlink entry per
 * submodule — so this guard never looked inside any of the 39, including
 * libs/papercusp (orchestrator/harness spawn paths) and papercusp-desktop. The
 * extension filter moved from a git pathspec into JS so the helper stays
 * single-purpose and pathspec semantics can't differ between the two call forms.
 */
function trackedFiles() {
  const { files, unscanned } = listTrackedFiles(ROOT);
  return {
    files: files
      .filter((p) => /\.tsx?$/.test(p))
      .filter((p) => !p.includes('/_retired/') && !p.includes('/node_modules/'))
      .filter((p) => !/\.(test|spec)\.tsx?$/.test(p)),
    unscanned,
  };
}

function main() {
  const offenders = [];
  const { files, unscanned } = trackedFiles();
  for (const rel of files) {
    let source;
    try {
      source = readFileSync(`${ROOT}${rel}`, 'utf8');
    } catch {
      continue;
    }
    if (isUnenrolledDetachedSpawn(rel, source)) offenders.push(rel);
  }

  if (offenders.length === 0) {
    console.log(
      `[no-unenrolled-detached-spawn] OK — ${ALLOWLIST.size} allowlisted site(s), no new ones.` +
        describeUnscanned(unscanned),
    );
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
