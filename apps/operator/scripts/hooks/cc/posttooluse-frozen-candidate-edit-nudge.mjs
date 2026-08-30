#!/usr/bin/env node
// apps/operator/scripts/hooks/cc/posttooluse-frozen-candidate-edit-nudge.mjs
//
// PostToolUse (Edit|Write|MultiEdit) ADVISORY nudge: you just edited a path that the
// FROZEN gate candidate is failing on, so this fix will not reach the sha being judged.
//
// P-004/P-005 of frozen-candidate-compliance-enforcement-2026-08-30.
//
// THE TRAP
//   On the first real code red the gate opens ONE frozen repair queue and every later run
//   RESUMES that exact candidate rather than a newer tip (freeze-and-converge, D-007). An
//   agent who fixes a named failing test on `staging` therefore lands the fix ABOVE the sha
//   under judgment. Nothing fails. The gate keeps reporting the same red, the agent reports
//   "fixed N gate reds", and both are locally true while the gate cannot see any of it.
//   Measured 2026-08-30: 3 of 10 reds on candidate 4184805d were already fixed at tip.
//
//   `detectFrozenRepairSharedTreeCollision` has been able to spot this since P-009 — but it
//   is REPORT-ONLY and runs inside the gate, hours later, addressed to whoever reads a
//   diagnostic. The author is never told at the moment the information is cheap to act on.
//
// WHY A HOOK
//   D-001 (ratified on that plan) rules out documentation, prose guidance, tool-description
//   text and opt-in diagnostics for this class — all were tried and measurably did not hold.
//   What is left is a structural change or a push-time signal that fires WITHOUT the agent
//   knowing to ask. This is the latter. It runs milliseconds after the write, while it is
//   still the author's turn and the fix is one call away.
//
// CONTRACT
//   - ADVISORY ONLY. PostToolUse cannot block and must not try to. Editing a failing path is
//     often exactly right; what is wrong is doing it believing the gate will see it.
//   - COSTS ~NOTHING WHEN NOTHING IS FROZEN. The signal is inverted: no frozen repair means
//     no marker file, so the hook exits after one failed read. There is deliberately no
//     database round-trip — this fires on every edit, fleet-wide.
//   - The marker is projected by `writeFrozenCandidateRepairQueue`, the one production write
//     path for the queue, so it cannot describe a previous round.
//   - NORMALIZATION IS PINNED, NOT COPIED-AND-HOPED. `normalizeRepoPath` below must agree
//     with the gate's own; `frozen-repair-edit-hook-parity.test.ts` imports both and fails
//     the build if they ever diverge. A hook that normalized differently would go silent on
//     exactly the edits that red the gate — the failure mode this whole file exists to stop.
//   - FAILS OPEN on every internal error. A bug here must never disturb an edit that already
//     succeeded.
//   - `--self-test` runs the embedded cases (no stdin) and exits non-zero on failure.
//
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** MUST match packages/operator-core/lib/release/frozen-candidate-repair-queue.ts. */
export function normalizeRepoPath(value) {
  return String(value ?? '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/^\/+/, '');
}

export function markerPath() {
  const base = process.env.PAPERCUSP_STATE_DIR ?? join(homedir(), '.papercusp', 'state');
  return join(base, 'frozen-repair-edit-marker.json');
}

export function readMarker(path = markerPath()) {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    if (!parsed || typeof parsed !== 'object') return null;
    if (typeof parsed.candidate !== 'string' || typeof parsed.repairHead !== 'string') return null;
    if (!Array.isArray(parsed.failingPaths)) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * P-005: name the CONSEQUENCE, not the rule. "Remember freeze-and-converge" is the prose
 * that already failed — it asks the reader to recall a regime and derive what it implies.
 * Returns null when there is nothing to say.
 */
export function warningFor(marker, editedPath) {
  if (!marker) return null;
  const p = normalizeRepoPath(editedPath);
  if (!p) return null;
  const failing = marker.failingPaths.map(normalizeRepoPath);
  if (!failing.includes(p)) return null;
  return [
    '⛔ THIS FIX WILL NOT REACH THE GATE.',
    `   ${p} is in the frozen candidate's failing set, and the gate is judging ${String(
      marker.repairHead,
    ).slice(0, 12)} (frozen candidate ${String(marker.candidate).slice(0, 12)}, phase ${
      marker.phase ?? 'unknown'
    }) — NOT the staging tip your edit lands on.`,
    '   So the gate will keep failing on this exact file however correct your fix is, and a',
    '   "fixed the gate red" claim off this edit would be false.',
    '   Put it on the judged lineage with ONE call:',
    `     release:repair-queue { op:'converge', paths:['${p}'] }`,
    '   It reports whether the judged sha now carries your fix. Do NOT fire',
    '   release:checkpoint-run and do NOT retire the queue to "make the gate move".',
  ].join('\n');
}

/** Every path an Edit/Write/MultiEdit payload touched. */
export function editedPathsFrom(payload) {
  const input = payload?.tool_input ?? {};
  const paths = [];
  if (typeof input.file_path === 'string') paths.push(input.file_path);
  if (Array.isArray(input.edits)) {
    for (const e of input.edits) if (typeof e?.file_path === 'string') paths.push(e.file_path);
  }
  return paths;
}

async function main() {
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    return; // fail open
  }
  const marker = readMarker();
  if (!marker) return; // the common case: nothing frozen
  const seen = new Set();
  const messages = [];
  for (const path of editedPathsFrom(payload)) {
    const msg = warningFor(marker, path);
    if (msg && !seen.has(msg)) {
      seen.add(msg);
      messages.push(msg);
    }
  }
  if (messages.length) process.stdout.write(`${messages.join('\n\n')}\n`);
}

function selfTest() {
  const marker = {
    candidate: 'c'.repeat(40),
    repairHead: 'r'.repeat(40),
    phase: 'repair-in-progress',
    failingPaths: ['packages/x/lib/a.test.ts'],
  };
  const cases = [
    ['./packages/x/lib/a.test.ts', true],
    ['packages/x/lib/a.test.ts', true],
    ['packages\\x\\lib\\a.test.ts', true],
    ['packages/x/lib/other.test.ts', false],
    ['', false],
  ];
  let failures = 0;
  for (const [path, shouldWarn] of cases) {
    const got = warningFor(marker, path) !== null;
    if (got !== shouldWarn) {
      failures += 1;
      process.stderr.write(`self-test FAIL: ${JSON.stringify(path)} expected ${shouldWarn}\n`);
    }
  }
  if (warningFor(null, 'packages/x/lib/a.test.ts') !== null) {
    failures += 1;
    process.stderr.write('self-test FAIL: a null marker must be silent\n');
  }
  const msg = warningFor(marker, 'packages/x/lib/a.test.ts') ?? '';
  if (!msg.includes("op:'converge'")) {
    failures += 1;
    process.stderr.write('self-test FAIL: the message must name the sanctioned command\n');
  }
  process.stdout.write(failures === 0 ? 'self-test OK\n' : `self-test: ${failures} failure(s)\n`);
  process.exit(failures === 0 ? 0 : 1);
}

const invokedDirectly = process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop());
if (process.argv.includes('--self-test')) selfTest();
else if (invokedDirectly) main().catch(() => {});
