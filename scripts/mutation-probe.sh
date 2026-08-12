#!/usr/bin/env bash
#
# mutation-probe.sh — prove a guard test is FALSIFIABLE without leaving the
# shared tree mutated.
#
# WHY THIS EXISTS (EI-19450431506682666, measured 2026-08-03)
# ----------------------------------------------------------
# The obvious hand-rolled idiom is:
#
#     cp "$F" "$B"; <mutate>; <run the suite>; cp "$B" "$F"
#
# It fails on this repo in TWO independent ways, and the second one is not
# fixable by being careful:
#
#   1. DEATH RACE — the restore is the LAST statement, so anything that kills
#      the command partway (the 2-min foreground Bash deadline, a SIGTERM, an
#      agent compaction) skips it and strands the mutant in the tree.
#      A `trap` fixes this one.
#
#   2. SWEEP RACE — git-sync commits the WHOLE working tree every few minutes.
#      A probe legitimately holds the file mutated for as long as the suite
#      runs, so a sweep landing in that window commits the mutant even though
#      nothing went wrong and the trap never fired. A trap CANNOT fix this;
#      it is a mitigation, not a fix.
#
# Both fired for real: db6d7b02b1 committed a mutant of
# scripts/verify-tauri-headless.sh in which the fix's function was DEFINED but
# never CALLED — inert, `bash -n`-clean, and shaped exactly like a finished
# change. Had green-checkpoint cut a candidate from it, the recurrence guard
# written minutes earlier would have red-pinned the whole fleet on a mutation
# nobody meant to commit.
#
# THE FIX: don't mutate the tracked file at all. COPY-OUT mode (the default)
# mutates a copy under a scratch dir and points the test at that copy, so the
# tracked file is never dirty for even an instant — no window, no lock, no
# trap needed. The script then PROVES the tree was untouched before exiting.
#
# See CLAUDE.md § "Proving a guard is falsifiable" for when each tier applies.
#
# USAGE
#   scripts/mutation-probe.sh --file <tracked-path> \
#                             --mutate <perl -pe expression> \
#                             --test <command containing {}> \
#                             [--expect caught|survived] [--in-tree]
#
#   {} in --test is replaced by the path of the MUTATED COPY (copy-out mode)
#   or by the tracked path itself (--in-tree mode), so the same --test string
#   works in both.
#
#   {} is REQUIRED in copy-out mode (without it the test would run against the
#   untouched original and every mutant would falsely "survive") and OPTIONAL
#   under --in-tree, where the tracked file itself is the mutant and the
#   substitution is a no-op.
#
#   --mutate is a PERL expression, so on the PATTERN side ( ) { } + ? . * are
#   REGEX METACHARACTERS. Escape them to match source code literally:
#       's|if \(x > 0\) \{|if (false) {|'   not   's|if (x > 0) {|if (false) {|'
#   The unescaped form matches NOTHING and is refused as a no-op mutation (see
#   EXIT CODE 2) — the refusal repeats this note, so you cannot silently probe
#   a guard with a mutation that never applied.
#
# EXAMPLE (the real probe this script was extracted from)
#   scripts/mutation-probe.sh \
#     --file scripts/verify-tauri-headless.sh \
#     --mutate 's/^\s*port_lost_to_squatter .*$//' \
#     --test 'PROBE_SCRIPT={} npm run test:file -- apps/operator/lib/verify-tauri-headless-bind-retry.test.ts'
#
# EXIT CODES
#   0  the probe reached its expected verdict (default: the mutant was CAUGHT)
#   1  the probe reached the opposite verdict — your guard is weaker than you think
#   2  misuse / the probe could not be run soundly (e.g. a no-op mutation,
#      a failing baseline, or a harness error while running the mutant)
#   3  IN-TREE RESTORE FAILED — the tree may still be dirty; act immediately
#
# The guard command runs twice: once against the original file with
# PAPERCUSP_MUTATION_PHASE=baseline, then against the mutant with
# PAPERCUSP_MUTATION_PHASE=mutant. PAPERCUSP_MUTATION_PROBE marks both child
# runs so the shared test-runs reporter can keep deliberate probe outcomes out
# of the health ledger. A baseline failure is a harness error, not a caught
# mutant. During the mutant run, exit 1 is the guard-failed/caught convention;
# every other nonzero exit is treated as a harness error because a shell/test
# crash must never be reported as falsifiability evidence.
#
set -uo pipefail

readonly PROG="mutation-probe"

die() { printf '%s: %s\n' "$PROG" "$*" >&2; exit 2; }
log() { printf '[%s] %s\n' "$PROG" "$*" >&2; }

FILE=""
MUTATE=""
TEST_CMD=""
EXPECT="caught"
IN_TREE=0

while [ $# -gt 0 ]; do
  case "$1" in
    --file)    FILE="${2:-}";     shift 2 || die "--file needs a value" ;;
    --mutate)  MUTATE="${2:-}";   shift 2 || die "--mutate needs a value" ;;
    --test)    TEST_CMD="${2:-}"; shift 2 || die "--test needs a value" ;;
    --expect)  EXPECT="${2:-}";   shift 2 || die "--expect needs a value" ;;
    --in-tree) IN_TREE=1; shift ;;
    -h|--help) sed -n '2,70p' "$0"; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done

[ -n "$FILE" ]     || die "missing --file"
[ -n "$MUTATE" ]   || die "missing --mutate"
[ -n "$TEST_CMD" ] || die "missing --test"
[ -f "$FILE" ]     || die "no such file: $FILE"
case "$EXPECT" in caught|survived) ;; *) die "--expect must be 'caught' or 'survived'" ;; esac
# The `{}` requirement is MODE-SPECIFIC, and the asymmetry is deliberate — do not "tidy" it
# back into an unconditional check (EI-19455888914364007).
#
# COPY-OUT: load-bearing. `{}` is the ONLY thing pointing the test at the mutated copy, so a
# command without it runs against the untouched original, the mutant always "survives", and the
# probe reports your guard as weak when it is fine. Refuse rather than emit that false verdict.
#
# IN-TREE: the tracked file itself IS the mutant, so the substitution is a no-op and a command
# that never names the path is perfectly sound. That is the NORMAL shape here — in-tree mode
# exists precisely for subjects whose path is not overridable (a suite importing it by a fixed
# path), which is the same reason the test cannot accept a `{}` to begin with. Demanding the
# marker anyway forced callers to thread a dummy `PROBE_FILE={}` env var that nothing reads.
if [ "$IN_TREE" -eq 0 ]; then
  case "$TEST_CMD" in
    *"{}"*) ;;
    *) die "--test must contain {} (where the mutated COPY's path is substituted). If your test cannot take a path — e.g. it imports its subject by a fixed path — use --in-tree, where {} is optional." ;;
  esac
fi

SCRATCH="$(mktemp -d "${TMPDIR:-/tmp}/mutation-probe.XXXXXX")" || die "could not create scratch dir"
readonly SCRATCH
BASE="$SCRATCH/$(basename "$FILE").orig"
cp "$FILE" "$BASE" || die "could not snapshot $FILE"

# The ORIGINAL bytes, captured before anything is touched. Every integrity
# claim this script makes is decided against this, never against `git status`
# (on a swept tree a clean status means the sweep ran, not that the file is
# unmodified — CLAUDE.md documents this at length).
ORIG_SUM="$(git hash-object "$FILE")"
readonly BASE ORIG_SUM

# ---------------------------------------------------------------------------
# Restore + integrity verification. In copy-out mode this only has to PROVE
# the tracked file was never touched; in --in-tree mode it is also what puts
# the file back, and it runs from a trap so it survives SIGTERM/SIGINT and the
# foreground-deadline kill that stranded the original mutant.
# ---------------------------------------------------------------------------
RESTORE_STATUS="not-run"
CHILD=""

# Kill a process and every descendant, DEPTH-FIRST by pid — never by name or
# pattern. `eval "$CMD" &` runs the guard in a subshell, so the real work
# (npm -> node -> vitest) is a GRANDchild: signalling only $CHILD leaves the
# expensive part running orphaned on a shared, already-loaded box. Walking
# --ppid is exact; `pkill -f <pattern>` is banned here because it matches the
# caller's own argv and has twice killed unrelated processes on this host.
kill_tree() {
  local pid="$1" kid
  for kid in $(ps -o pid= --ppid "$pid" 2>/dev/null); do
    kill_tree "$kid"
  done
  kill -TERM "$pid" 2>/dev/null || true
}
finish() {
  local rc=$?
  # Disarm FIRST: without this the handler runs twice (once for TERM, once for
  # the EXIT that TERM causes) and prints its verdict twice.
  trap - EXIT INT TERM
  # Kill the probe's own child before restoring. A signal arriving during
  # `wait` runs this handler immediately, but the child is still holding the
  # mutated file open — restoring underneath a live test would race it.
  if [ -n "$CHILD" ]; then
    kill_tree "$CHILD"
  fi
  if [ "$IN_TREE" = "1" ]; then
    cp "$BASE" "$FILE" 2>/dev/null || true
  fi
  local now
  now="$(git hash-object "$FILE" 2>/dev/null || echo MISSING)"
  if [ "$now" = "$ORIG_SUM" ]; then
    RESTORE_STATUS="verified-identical"
    log "tree integrity: VERIFIED — $FILE is byte-identical to its pre-probe state"
  else
    RESTORE_STATUS="DIRTY"
    log ""
    log "🚨🚨 TREE INTEGRITY FAILURE — $FILE does NOT match its pre-probe state."
    log "🚨🚨 git-sync will COMMIT this within minutes. Restore it NOW:"
    log "🚨🚨     cp '$BASE' '$FILE'"
    log "🚨🚨 (the pre-probe copy is preserved at $BASE — this scratch dir is NOT cleaned up)"
    log ""
    trap - EXIT
    exit 3
  fi
  # Only discard the scratch dir once integrity is proven; if anything went
  # wrong the pristine copy is the operator's recovery path, so it stays.
  rm -rf "$SCRATCH"
  exit $rc
}
trap finish EXIT INT TERM

# Run a guard in an interruptible child and preserve its output for the
# machine-readable verdict below. The phase marker lets a guard's own test
# fixture skip an intentionally slow baseline setup without weakening the
# production command shape; it is also useful to test that the baseline and
# mutant really went through the same invocation path.
run_guard() {
  local phase="$1" label="$2" cmd="$3" output="$4" rc
  log "running $label: $cmd"
  (
    export PAPERCUSP_MUTATION_PHASE="$phase"
    # A deliberate baseline/mutant result is falsifiability evidence, not a
    # measurement of the repository's health. Keep the marker scoped to the
    # supervised child so it reaches every test process without leaking into
    # the caller's environment.
    export PAPERCUSP_MUTATION_PROBE=1
    eval "$cmd"
  ) >"$output" 2>&1 &
  CHILD=$!
  wait "$CHILD"
  rc=$?
  CHILD=""
  cat "$output"
  return "$rc"
}

if [ "$IN_TREE" = "1" ]; then
  log ""
  log "⚠️  --in-tree: the TRACKED file will be mutated in place."
  log "⚠️  The trap below closes the DEATH race, but NOT the git-sync SWEEP race."
  log "⚠️  Hold the sweep for the duration of this probe, from your agent session:"
  log "⚠️      locks:acquire_resource { resource: 'git-sync:$(basename "$(git rev-parse --show-toplevel 2>/dev/null || echo papercusp)")',"
  log "⚠️                               mode: 'exclusive', ttl_sec: 600, reason: 'mutation probe' }"
  log "⚠️  git-sync's own tick takes that same lock and SKIPS when a peer holds it."
  log "⚠️  Prefer copy-out mode (drop --in-tree) — it has no window at all."
  log ""
  TARGET="$FILE"
else
  TARGET="$SCRATCH/$(basename "$FILE")"
  cp "$FILE" "$TARGET" || die "could not stage the probe copy"
fi

# A nonzero baseline means the command did not establish a runnable, healthy
# guard before the mutation. Scoring the mutant's later nonzero exit as
# "caught" would turn a broken harness into falsifiability evidence.
BASE_CMD="${TEST_CMD//\{\}/$FILE}"
BASELINE_LOG="$SCRATCH/baseline.log"
MUTANT_LOG="$SCRATCH/mutant.log"
BASELINE_RC=0
if run_guard baseline "baseline guard" "$BASE_CMD" "$BASELINE_LOG"; then
  :
else
  BASELINE_RC=$?
  log "BASELINE FAILED (guard exited $BASELINE_RC) — refusing to score the mutant"
  printf 'MUTATION_PROBE_RESULT verdict=harness-error expected=%s target=%s baseline_exit=%d guard_exit=-1\n' \
    "$EXPECT" "$([ "$IN_TREE" = "1" ] && echo in-tree || echo copy-out)" "$BASELINE_RC"
  exit 2
fi

# --- apply the mutation -----------------------------------------------------
perl -pi -e "$MUTATE" "$TARGET" || die "mutation command failed"

# A mutation that matched NOTHING is the quiet killer of this whole technique:
# the "mutant" is identical to the original, so the guard passes, and the
# probe reports "the guard did not catch it" — a FALSE weakness verdict from a
# probe that never actually mutated anything. Refuse rather than report it.
if cmp -s "$TARGET" "$BASE"; then
  die "the --mutate expression changed NOTHING (mutant is byte-identical to the original).
      A no-op mutation makes any guard look weak. Fix the expression and re-run.

      MOST COMMON CAUSE: --mutate is a PERL expression (applied as perl -pi -e), so
      ( ) { } + ? . * are REGEX METACHARACTERS on the PATTERN side, not literal text.
      This bites hardest on the normal use of this script — mutating source code —
      because a natural-looking mutation of a conditional or a call matches nothing:

          WRONG:  's|if (x > 0) {|if (false) {|'
                        ^      ^ ^   ( ) capture a group, { starts a quantifier,
                                     so this searches for 'if x > 0 ' and misses.
          RIGHT:  's|if \(x > 0\) \{|if (false) {|'

      Only the PATTERN (left) side needs escaping — the replacement is literal."
fi
log "mutant applied: $(git hash-object "$BASE" | cut -c1-8) -> $(git hash-object "$TARGET" | cut -c1-8)"

# --- run the guard against the mutant --------------------------------------
CMD="${TEST_CMD//\{\}/$TARGET}"
run_guard mutant "mutant guard" "$CMD" "$MUTANT_LOG"
TEST_RC=$?

# A guard is falsifiable when it FAILS on the mutant. Report the verdict in
# those terms rather than leaking the raw exit code, because "the probe
# succeeded" and "the test passed" mean OPPOSITE things here and conflating
# them is its own error class. Exit 1 is the test/guard failure convention;
# exit 2 (for example, a shell syntax error) and every other nonzero status
# mean the harness did not produce a trustworthy verdict.
if [ "$TEST_RC" -eq 1 ]; then
  VERDICT="caught"
  log "VERDICT: MUTANT CAUGHT (guard exited $TEST_RC) — the guard is falsifiable ✓"
elif [ "$TEST_RC" -eq 0 ]; then
  VERDICT="survived"
  log "VERDICT: MUTANT SURVIVED (guard exited 0) — the guard does NOT constrain this mutation ✗"
else
  VERDICT="harness-error"
  log "VERDICT: HARNESS ERROR (guard exited $TEST_RC) — no falsifiability verdict is sound"
fi

printf 'MUTATION_PROBE_RESULT verdict=%s expected=%s target=%s baseline_exit=%d guard_exit=%d\n' \
  "$VERDICT" "$EXPECT" "$([ "$IN_TREE" = "1" ] && echo in-tree || echo copy-out)" "$BASELINE_RC" "$TEST_RC"

[ "$VERDICT" = "harness-error" ] && exit 2
[ "$VERDICT" = "$EXPECT" ] || exit 1
exit 0
