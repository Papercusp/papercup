/**
 * gate-artifact-verdict-tail.ts — the EI-19940993365684927 invariant, as code.
 *
 *   A gate artifact's LAST line must BE its verdict, or must be MORE alarming
 *   than its verdict — never less. Readers (human and agent) read the tail.
 *
 * Lifted out of its test file so the checker can be (a) replayed over git
 * HISTORY as a falsifiability proof against the REAL pre-fix artifact rather
 * than only against synthetic controls, and (b) reused for this class's other
 * confirmed instances (the from-repo smoke's `OVERALL: PASS` tail on a run whose
 * witness recorded a C-001 breach — WI-37222; green-checkpoint's hardcoded
 * "type regressions" banner printed above an OOM crash — WI-37503).
 *
 * ⚠ Replaying a COPY of the logic over history proves nothing about the guard
 * that actually runs. That is why this is a module both callers import, rather
 * than a rule re-expressed in a script.
 */

/**
 * Returns the payload of the LAST `echo "…"` emitted on the replication soak's
 * FAILURE path — i.e. the line a reader's `tail` actually lands on.
 *
 * Anchored to `^\s*echo "` so quoted strings inside the drv_exec/grep heredocs in
 * this region are not mistaken for emitted output.
 */
export function lastEmittedLineOnFailPath(src: string): string | null {
  const start = src.indexOf('replication-liveness soak FAIL');
  if (start < 0) return null;
  // Anchor the end on the `return "$rc"` STATEMENT (line-start), not on the first
  // textual occurrence: the script's own comments quote `return "$rc"` in prose, and
  // an indexOf() would end the region there — silently excluding the very lines this
  // guard exists to inspect. (Not hypothetical: it is exactly how this guard failed
  // on its first run, reporting the ✗ branch as the final emitted line while the
  // unconditional verdict sat just past the truncation point.)
  const rest = src.slice(start);
  const endMatch = /^[ \t]*return "\$rc"/m.exec(rest);
  if (!endMatch) return null;
  const region = rest.slice(0, endMatch.index);
  const echoes = [...region.matchAll(/^[ \t]*echo "([^"]*)"/gm)].map((m) => m[1]);
  return echoes.length > 0 ? echoes[echoes.length - 1]! : null;
}

/**
 * The invariant as a predicate, so controls, the real file, and a history replay
 * all exercise the SAME rule.
 *
 * Note what this is really asserting. In the pre-fix shape the textually-last echo
 * is the `✗` branch, not the `✓` — the emitted tail is decided by WHICH BRANCH
 * FIRES, so on a run where the detector pin passed, the tail was the reassuring ✓.
 * The property that holds on EVERY path is therefore: an UNCONDITIONAL verdict must
 * follow the ✓/✗ branch.
 */
export function tailIsVerdictNotReassurance(src: string): boolean {
  const last = lastEmittedLineOnFailPath(src);
  if (last === null) return false;
  if (/^\s*✓/.test(last)) return false; // a reassuring tail on a failure path
  return /^OVERALL:/.test(last);
}
