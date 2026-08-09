/**
 * gate-artifact-verdict-is-last-line.test.ts — the RECURRENCE GUARD for
 * EI-19940993365684927 ("gate-artifact honesty").
 *
 * THE INVARIANT
 *   A gate artifact's LAST line must BE its verdict, or must be MORE alarming
 *   than its verdict — never less. Readers (human and agent) read the tail.
 *
 * THE BUG THIS GUARDS
 *   `scn_replication_soak` (papercusp-desktop/bin/lib/scenarios/b8-replication-soak.sh)
 *   emitted, on a FAILED soak: the soak's own `OVERALL: INCOMPLETE` lines, then a
 *   trailing sub-assertion about the WI-1840 detector prefixed with `✓`. That ✓ is
 *   true on its own terms — it asserts the DETECTOR saw the stall — but it was the
 *   FINAL line of the scenario log, so `tail -1` on a scenario that had just FAILED
 *   its SLA showed a check-mark. A peer read exactly that tail and reported "all 18
 *   scenarios green" while this one was INCOMPLETE.
 *
 *   This is a CLASS, not a one-off. Confirmed siblings: the from-repo smoke's
 *   `OVERALL: PASS` last line on a run whose witness had just recorded a C-001
 *   breach (WI-37222), and green-checkpoint's `=== TYPECHECK FAILED … operator-core
 *   type regressions block the release ===` banner printed above the truth that tsc
 *   had CRASHED (an OOM) and produced zero diagnostics — which sent agents hunting
 *   for type errors that did not exist (WI-37503).
 *
 * WHY A TEXT GUARD IS THE RIGHT SHAPE
 *   Same rationale as the sibling verify-tauri-headless-*.test.ts files: reaching
 *   this code for real needs a multi-frame federation rig (kill/restart cycles, SLA
 *   windows, live serve.log greps over drv_exec), so the ordering can only be
 *   asserted at the emission site, not by executing it in CI.
 *
 * FALSIFIABILITY
 *   The checker is exercised against deliberately-wrong CONTROLS held permanently
 *   in this file (see WRONG_*), so it is proven to discriminate without ever
 *   mutating the shared tree. CLAUDE.md § "Proving a guard is falsifiable", tier 1:
 *   a guard that has never failed is a guard you have not tested. The controls are
 *   paired with a calibration case (the REAL script) that must PASS — without that
 *   pairing, both controls would also pass if the property itself were broken.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const SCRIPT = resolve(
  __dirname,
  '../../../papercusp-desktop/bin/lib/scenarios/b8-replication-soak.sh',
);

/**
 * Returns the payload of the LAST `echo "…"` emitted on the scenario's FAILURE
 * path — i.e. the line a reader's `tail` actually lands on.
 *
 * Deliberately anchored to `^\s*echo "` so that quoted strings inside the
 * drv_exec/grep heredocs in this region are not mistaken for emitted output.
 */
export function lastEmittedLineOnFailPath(src: string): string | null {
  const start = src.indexOf('replication-liveness soak FAIL');
  if (start < 0) return null;
  const end = src.indexOf('return "$rc"', start);
  if (end < 0) return null;
  const region = src.slice(start, end);
  const echoes = [...region.matchAll(/^[ \t]*echo "([^"]*)"/gm)].map((m) => m[1]);
  return echoes.length > 0 ? echoes[echoes.length - 1]! : null;
}

/** The invariant itself, as a predicate, so controls and the real file share it. */
export function tailIsVerdictNotReassurance(src: string): boolean {
  const last = lastEmittedLineOnFailPath(src);
  if (last === null) return false;
  if (/^\s*✓/.test(last)) return false; // a reassuring tail on a failure path
  return /^OVERALL:/.test(last);
}

// ── Deliberately-WRONG controls. These are the pre-fix shapes; they must FAIL. ──
const WRONG_REASSURING_TAIL = `
    echo "replication-liveness soak FAIL — key lines:"
    printf '%s\\n' "$out" | grep -E '✗|OVERALL:' | sed 's/^/      /'
    if [ "$hit" = 1 ]; then
      echo "      ✓ detector fire-path pin: replication_stalled present in serve.log"
    else
      echo "      ✗ DETECTOR REGRESSION: soak failed its SLA but NO replication_stalled line"
    fi
  fi
  return "$rc"
`;

/**
 * The subtler regression: someone "fixes" it by replaying $out's own OVERALL line
 * instead of emitting one unconditionally. That prints NOTHING when the soak died
 * before emitting a verdict, silently restoring the bug — so the last EMITTED line
 * is once again the ✓.
 */
const WRONG_CONDITIONAL_VERDICT = `
    echo "replication-liveness soak FAIL — key lines:"
    if [ "$hit" = 1 ]; then
      echo "      ✓ detector fire-path pin: replication_stalled present in serve.log"
    fi
    printf '%s\\n' "$out" | grep -E 'OVERALL:' | tail -1
  fi
  return "$rc"
`;

describe('EI-19940993365684927 — a gate artifact must not tail as a pass when it failed', () => {
  it('replication_soak ends its FAILURE path with the verdict, not the ✓ detector sub-assertion', () => {
    const src = readFileSync(SCRIPT, 'utf8');
    const last = lastEmittedLineOnFailPath(src);

    expect(last).not.toBeNull();
    // The whole point: `tail -1` on a FAILED soak must not show a check-mark.
    expect(last).not.toMatch(/^\s*✓/);
    expect(last).toMatch(/^OVERALL:/);
    expect(tailIsVerdictNotReassurance(src)).toBe(true);
  });

  it('still emits the ✓/✗ detector fire-path pin — the fix reorders, it does not delete evidence', () => {
    const src = readFileSync(SCRIPT, 'utf8');
    // Regression in the opposite direction: silencing the sub-assertion would
    // "fix" the tail while destroying the WI-1840 detector signal it carries.
    expect(src).toContain('detector fire-path pin');
    expect(src).toContain('DETECTOR REGRESSION');
  });

  it('CONTROL: the checker REJECTS the pre-fix shape (reassuring ✓ as the final line)', () => {
    expect(tailIsVerdictNotReassurance(WRONG_REASSURING_TAIL)).toBe(false);
    expect(lastEmittedLineOnFailPath(WRONG_REASSURING_TAIL)).toMatch(/✓/);
  });

  it('CONTROL: the checker REJECTS a conditionally-replayed verdict that can print nothing', () => {
    expect(tailIsVerdictNotReassurance(WRONG_CONDITIONAL_VERDICT)).toBe(false);
  });
});
