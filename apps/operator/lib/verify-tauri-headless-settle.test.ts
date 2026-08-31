/**
 * verify-tauri-headless-settle.test.ts — the RECURRENCE GUARD for
 * EI-19385008818210514.
 *
 * The bug: a headless assertion routinely runs BEFORE the sync-backed data it
 * depends on has landed, so a component GUARDED on that data (`entry &&
 * <Thing entry={entry}/>`, `if (!x) return null`) is legitimately absent from the
 * DOM. That is not read as a race. It is read as `the feature was never
 * implemented` — a confident, plausible, wrong conclusion that only ever fires
 * against someone's finished work, because a race that HIDES an element looks
 * like a finding while a race that SHOWS one just looks like success.
 *
 * The fix has two halves, and the SECOND is the load-bearing one:
 *   1. `VERIFY_TAURI_SETTLE` — a blocking "wait until the page is idle" an author
 *      can put before a measurement.
 *   2. the SAME probe attached, in `--note-only` form, to every
 *      VERIFY_TAURI_POLL failure — so a 0-match result cannot render without its
 *      loading context. Half 1 only helps someone who already knew to ask; half 2
 *      reaches the agent who did not.
 *
 * A `readFileSync` text guard is the right shape here (same rationale as the
 * sibling verify-tauri-headless-*.test.ts): the script boots a real
 * Tauri/Xvfb/sidecar stack, so this wiring can only be asserted at the wiring
 * site. The VERDICT LOGIC it wires up is unit-tested separately, against the pure
 * functions, in packages/operator-core/lib/__tests__/settle-probe.test.ts.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// PROBE_SCRIPT lets scripts/mutation-probe.sh point this suite at a MUTATED COPY
// outside the tree, so falsifiability can be proven without ever mutating the
// shared checkout (where git-sync would happily commit the mutant mid-probe).
const SCRIPT =
  process.env.PROBE_SCRIPT ??
  resolve(__dirname, "../../../scripts/verify-tauri-headless.sh");
const src = readFileSync(SCRIPT, "utf8");

/** The POLL helper is written into the run's work dir as a quoted heredoc. */
function pollScriptBody(): string {
  const start = src.indexOf("cat > \"$POLL\" <<'POLL_SCRIPT'");
  expect(start).toBeGreaterThan(-1);
  const end = src.indexOf("\nPOLL_SCRIPT\n", start);
  expect(end).toBeGreaterThan(start);
  return src.slice(start, end);
}

describe("verify-tauri-headless: the settle primitive is exported", () => {
  it("writes a settle wrapper and exports VERIFY_TAURI_SETTLE", () => {
    expect(src).toContain('SETTLE="$WORK/settle.sh"');
    expect(src).toContain('cat > "$SETTLE" <<SETTLE_SCRIPT');
    expect(src).toContain('export VERIFY_TAURI_SETTLE="$SETTLE"');
    expect(src).toContain('chmod +x "$SETTLE"');
  });

  it("points the wrapper at the real probe, pinned to this run’s bridge pid", () => {
    expect(src).toContain(
      'SETTLE_PROBE_MJS="$REPO_DIR/scripts/settle-probe.mjs"',
    );
    expect(src).toMatch(
      /exec node "\\\$SETTLE_PROBE_MJS" --pid "\\\$\{VERIFY_TAURI_PID/,
    );
  });

  it("SELF-REPORTS when the probe is missing instead of silently skipping", () => {
    // Silence here would hand the caller exactly the false confidence the probe
    // exists to remove: no note, and therefore no reason to doubt an absence.
    const wrapperStart = src.indexOf('cat > "$SETTLE" <<SETTLE_SCRIPT');
    const wrapper = src.slice(
      wrapperStart,
      src.indexOf("\nSETTLE_SCRIPT\n", wrapperStart),
    );
    expect(wrapper).toContain('if [ ! -f "\\$SETTLE_PROBE_MJS" ]; then');
    expect(wrapper).toMatch(/SETTLE: UNKNOWN/);
    expect(wrapper).toMatch(/NOT evidence that loading finished/);
    // ...and --note-only must still exit 0, so a missing probe can never turn
    // another command's diagnostic into a failure.
    expect(wrapper).toContain('--note-only "*) exit 0 ;;');
  });

  it("hands VERIFY_TAURI_SETTLE to --boot-only callers as well as assertion mode", () => {
    expect(src).toContain(
      "printf 'VERIFY_TAURI_SETTLE=%q\\n' \"$VERIFY_TAURI_SETTLE\"",
    );
    expect(src).toMatch(/^export VERIFY_TAURI_POLL VERIFY_TAURI_SETTLE /m);
  });
});

describe("verify-tauri-headless: a POLL failure reports whether the page had loaded", () => {
  it("attaches the settle note to the timeout diagnostic", () => {
    const poll = pollScriptBody();
    expect(poll).toContain("VERIFY_TAURI_SETTLE");
    expect(poll).toContain("--note-only");
    expect(poll).toMatch(
      /settle_note="\$\(bash "\$VERIFY_TAURI_SETTLE" --note-only/,
    );
    expect(poll).toMatch(/printf '%s\\n' "\$settle_note" >&2/);
  });

  it("attaches it to BOTH failure classes, not just the generic timeout", () => {
    const poll = pollScriptBody();
    const guardBranch = poll.indexOf("presence guard never matched");
    const genericBranch = poll.indexOf("DOM assertion did not pass within");
    const note = poll.indexOf("settle_note=");
    expect(guardBranch).toBeGreaterThan(-1);
    expect(genericBranch).toBeGreaterThan(-1);
    // The note sits AFTER the if/else that splits those two branches, so it
    // decorates whichever one fired.
    expect(note).toBeGreaterThan(guardBranch);
    expect(note).toBeGreaterThan(genericBranch);
  });

  it("stays silent under --quiet and can never change the poll’s own outcome", () => {
    const poll = pollScriptBody();
    const quietGuard = poll.lastIndexOf('if [ "$quiet_failure" -eq 0 ]; then');
    const note = poll.indexOf("settle_note=");
    const exit = poll.indexOf("exit 1", note);
    // Inside the quiet-failure guard: a caller deliberately probing for an
    // optional element asked for silence and must get it.
    expect(quietGuard).toBeGreaterThan(-1);
    expect(note).toBeGreaterThan(quietGuard);
    expect(exit).toBeGreaterThan(note);
    // `|| true` — a failing or missing probe must not replace the real diagnostic.
    expect(poll).toMatch(/--note-only 2>\/dev\/null \|\| true\)"/);
  });

  it("documents the trap, the three-state rule, and the settle-then-measure order", () => {
    // The header is where an agent writing an assertion actually looks.
    expect(src).toContain("EI-19385008818210514");
    expect(src).toMatch(/WAIT BEFORE YOU MEASURE/);
    expect(src).toMatch(/never "zero in flight"/);
    expect(src).toContain("VERIFY_TAURI_SETTLE_TIMEOUT");
    expect(src).toContain("VERIFY_TAURI_SETTLE_QUIET_MS");
  });
});
