#!/usr/bin/env node
/**
 * GUARD: every sidecar-git fallback must be REPORTED (EI-20281745253229841).
 *
 * ## Why this exists
 *
 * `runGitViaSpawnerSidecar` / `runGitStdinViaSpawnerSidecar` REJECT when the
 * spawner sidecar is unreachable, and every caller is expected to catch that and
 * fall back to a local `child_process.spawn`. That is deliberate: a sidecar
 * fault should degrade performance, not break git.
 *
 * The catch is that the degradation is not small. `fork()` copies the parent's
 * page tables, so spawning from the ~5.4 GB bg-host costs ~40 ms/GB — ~165 ms of
 * SYNCHRONOUSLY blocked event loop per git call, for commands git finishes in
 * ~4 ms. That is the exact CRITICAL condition the sidecar exists to remove
 * (EI-18808838427010743). So a silent fallback does not merely lose a log line:
 * it restores the outage in full, invisibly.
 *
 * When this guard was written there were 7 such call sites across 6 subsystems,
 * and each had independently invented its own fallback observability — in three
 * mutually incompatible ways, two of which cannot report a sustained outage at
 * all:
 *
 *   - a bare `catch {}`                  → zero trace, ever
 *   - a private warn-once-per-reason Set → an hour-long outage is byte-identical
 *                                          to a single blip at boot
 *   - a `console.warn` on every call     → buries the log, still states no rate
 *
 * None of that is visible while reviewing any ONE site, because each looks
 * locally reasonable. It is only visible with all seven side by side — which is
 * precisely the kind of defect a guard exists to catch and a reviewer does not.
 *
 * ## The rule
 *
 * A `catch` that handles a sidecar-git call must call `noteSidecarFallback(...)`
 * from `lib/fleet/git-via-sidecar.ts`, which counts per subsystem and re-warns
 * on a bounded cadence carrying the cumulative count.
 *
 * BASELINE IS EMPTY AND MUST STAY EMPTY. All sites complied when this landed, so
 * a failure here is a NEW un-reported fallback, never a baseline addition.
 */
import { readFileSync, realpathSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** The sidecar entrypoints whose rejection means "fell back to a local spawn". */
export const SIDECAR_CALLS = ['runGitViaSpawnerSidecar', 'runGitStdinViaSpawnerSidecar'];

/** The reporting function every such fallback must route through. */
export const REPORTER = 'noteSidecarFallback';

/**
 * Permanently allowed: the seam that DEFINES the reporter and the tests that
 * exercise it (a test may legitimately construct a fallback without reporting).
 */
export const ALLOWLIST = new Set(['packages/operator-core/lib/fleet/git-via-sidecar.ts']);

/**
 * TEMPORARY grandfather set — MUST stay empty. Seeded empty on purpose: every
 * call site was migrated in the same change that added this guard, so there is
 * nothing to grandfather and a new entry here would be a regression, not a debt.
 */
export const BASELINE = new Set([]);

/**
 * Does `text` contain a sidecar call whose `catch` does not report?
 *
 * Deliberately a SOURCE scan rather than a full AST parse: the shape being
 * policed is small and syntactic (`try { ...sidecarCall... } catch { ... }`),
 * and a scan has no parser/toolchain dependency to drift. It errs toward FALSE
 * NEGATIVES (an exotic formatting could slip through) and never toward false
 * positives, which is the right bias for a guard that blocks the build.
 */
export function findUnreportedFallbacks(text) {
  const offenders = [];
  for (const call of SIDECAR_CALLS) {
    let idx = text.indexOf(call);
    while (idx !== -1) {
      // Skip the import/export lines and the declaration itself.
      const lineStart = text.lastIndexOf('\n', idx) + 1;
      const line = text.slice(lineStart, text.indexOf('\n', idx));
      const isDecl = /^\s*(export\s+)?(async\s+)?function\s/.test(line);
      const isImport = /^\s*(import|export)\b/.test(line) || /^\s*[\w$]+,?\s*$/.test(line);
      if (isDecl || isImport) {
        idx = text.indexOf(call, idx + 1);
        continue;
      }

      // Find the catch block governing this call: the next `catch` after it.
      const catchIdx = text.indexOf('catch', idx);
      if (catchIdx === -1) {
        idx = text.indexOf(call, idx + 1);
        continue;
      }

      // The catch body runs to its closing brace; bound the search generously
      // rather than brace-matching, then require the reporter inside it.
      const bodyStart = text.indexOf('{', catchIdx);
      const body = bodyStart === -1 ? '' : text.slice(bodyStart, bodyStart + 800);
      if (!body.includes(REPORTER)) {
        offenders.push({ call, line: text.slice(0, idx).split('\n').length });
      }
      idx = text.indexOf(call, idx + 1);
    }
  }
  return offenders;
}

/** Tracked .ts sources that mention a sidecar call at all. */
export function findOffenders() {
  const tracked = execFileSync('git', ['ls-files', '*.ts'], { cwd: ROOT, encoding: 'utf8' })
    .split('\n')
    .filter(Boolean);

  const out = [];
  for (const f of tracked) {
    if (ALLOWLIST.has(f) || BASELINE.has(f)) continue;
    if (f.includes('/dist/') || f.includes('node_modules')) continue;
    if (/\.test\.ts$/.test(f) || /\.integration\.test\.ts$/.test(f)) continue;

    let text;
    try {
      text = readFileSync(path.join(ROOT, f), 'utf8');
    } catch {
      continue;
    }
    if (!SIDECAR_CALLS.some((c) => text.includes(c))) continue;

    for (const o of findUnreportedFallbacks(text)) out.push({ file: f, ...o });
  }
  return out;
}

function main() {
  const offenders = findOffenders();
  if (offenders.length === 0) {
    console.log('✓ every sidecar-git fallback reports via noteSidecarFallback()');
    process.exit(0);
  }
  console.error('✗ sidecar-git fallback(s) that do NOT report the fallback:');
  for (const o of offenders) console.error(`   ${o.file}:${o.line}  (${o.call})`);
  console.error('');
  console.error('  Falling back to a local spawn reintroduces the ~165ms/call fork stall the');
  console.error('  sidecar exists to remove (EI-18808838427010743). An unreported fallback makes');
  console.error('  that outage invisible — a mitigation whose failure is unobservable is not a fix.');
  console.error('');
  console.error("  Fix: in the catch, call noteSidecarFallback('<subsystem>', e)");
  console.error("        from packages/operator-core/lib/fleet/git-via-sidecar.ts");
  process.exit(1);
}

// Symlink-robust self-exec guard: node realpaths import.meta.url while argv[1]
// keeps the invoked path, so compare realpaths (papercupai-workspace/papercup
// is a symlink to papercusp here).
const invoked = process.argv[1] ? realpathSync(process.argv[1]) : '';
if (invoked && invoked === realpathSync(fileURLToPath(import.meta.url))) main();
