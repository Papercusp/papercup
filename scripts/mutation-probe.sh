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
# EXAMPLE (the real probe this script was extracted from)
#   scripts/mutation-probe.sh \
#     --file scripts/verify-tauri-headless.sh \
#     --mutate 's/^\s*port_lost_to_squatter .*$//' \
#     --test 'PROBE_SCRIPT={} npm run test:file -- apps/operator/lib/verify-tauri-headless-bind-retry.test.ts'
#
# EXIT CODES
#   0  the probe reached its expected verdict (default: the mutant was CAUGHT)
#   1  the probe reached the opposite verdict — your guard is weaker than you think
#   2  misuse / the probe could not be run soundly (e.g. a no-op mutation)
#   3  IN-TREE RESTORE FAILED — the tree may still be dirty; act immediately
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
case "$TEST_CMD" in *"{}"*) ;; *) die "--test must contain {} (where the probe target path is substituted)" ;; esac

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

# --- apply the mutation -----------------------------------------------------
perl -pi -e "$MUTATE" "$TARGET" || die "mutation command failed"

# A mutation that matched NOTHING is the quiet killer of this whole technique:
# the "mutant" is identical to the original, so the guard passes, and the
# probe reports "the guard did not catch it" — a FALSE weakness verdict from a
# probe that never actually mutated anything. Refuse rather than report it.
if cmp -s "$TARGET" "$BASE"; then
  die "the --mutate expression changed NOTHING (mutant is byte-identical to the original).
      A no-op mutation makes any guard look weak. Fix the expression and re-run."
fi
log "mutant applied: $(git hash-object "$BASE" | cut -c1-8) -> $(git hash-object "$TARGET" | cut -c1-8)"

# --- run the guard against the mutant --------------------------------------
CMD="${TEST_CMD//\{\}/$TARGET}"
log "running: $CMD"
# Run the guard in the BACKGROUND and `wait` on it, rather than calling it in
# the foreground. This is load-bearing, not style: bash will NOT run a trap
# handler while it is waiting on a FOREGROUND child — it defers the handler
# until that child exits. Measured 2026-08-03 with the foreground form: a
# SIGTERM to the probe during a 25s guard restored the file only after 23s,
# i.e. when the child happened to finish. The harness sends SIGTERM then
# SIGKILL, so a deferred handler is frequently never a handler at all — which
# is exactly how the original mutant survived to be committed.
# `wait` IS interruptible, so a signal runs `finish` at once.
eval "$CMD" &
CHILD=$!
wait "$CHILD"
TEST_RC=$?
CHILD=""

# A guard is falsifiable when it FAILS on the mutant. Report the verdict in
# those terms rather than leaking the raw exit code, because "the probe
# succeeded" and "the test passed" mean OPPOSITE things here and conflating
# them is its own error class.
if [ "$TEST_RC" -ne 0 ]; then
  VERDICT="caught"
  log "VERDICT: MUTANT CAUGHT (guard exited $TEST_RC) — the guard is falsifiable ✓"
else
  VERDICT="survived"
  log "VERDICT: MUTANT SURVIVED (guard exited 0) — the guard does NOT constrain this mutation ✗"
fi

printf 'MUTATION_PROBE_RESULT verdict=%s expected=%s target=%s guard_exit=%d\n' \
  "$VERDICT" "$EXPECT" "$([ "$IN_TREE" = "1" ] && echo in-tree || echo copy-out)" "$TEST_RC"

[ "$VERDICT" = "$EXPECT" ] || exit 1
exit 0
