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
#                             [--sweep-lock-held | --accept-sweep-race]
#                             [--fake-destructive]
#                             [--i-know-this-deletes --sandbox-root <dir>]
#
# HISTORICAL MODE — prove a guard catches the version that actually preceded a
# fix, without guessing that HEAD is still pre-fix (git-sync commits the tree
# continuously):
#   scripts/mutation-probe.sh --file <tracked-path> \
#                             --against-commit <sha> \
#                             --must-be-absent <literal> \
#                             --positive-control <literal> \
#                             --calibration <command containing {}> \
#                             --test <command containing {}>
#   scripts/mutation-probe.sh --file <tracked-path> \
#                             --against-last-without <literal> \
#                             --positive-control <literal> \
#                             --calibration <command containing {}> \
#                             --test <command containing {}>
#
# Historical mode freezes both the current working-tree bytes and the selected
# commit's bytes before either command runs. `{}` is replaced with a fresh
# per-run copy of the appropriate frozen snapshot. Every positive control must
# be present in BOTH snapshots; calibration must pass against BOTH; the guard
# test must pass against current and then produce the requested historical
# verdict. `--against-commit` requires `--must-be-absent`; the content-selected
# form uses its selector as that absence control automatically.
#
# ⛔ DESTRUCTIVE SUBJECTS (EI-20566003853444873 — the 2026-08-15 incident)
#   This script's original blast-radius model protected THE FILE UNDER TEST and
#   nothing else. Executing a mutant of code that DELETES means running
#   deliberately-corrupted deletion logic against the real filesystem with your
#   full privileges: one probe of a reaper script did exactly that and destroyed
#   ~370GB (~/windows-vm, ~/Downloads, ~/backups, most of papercupai-workspace).
#   So the probe now REFUSES by default when the subject file or the --test
#   command contains destructive primitives (rm/rmdir/unlink/shred/mkfs/
#   dd of=/truncate/find -delete). Two ways forward, in order of preference:
#
#   --fake-destructive       TIER-0, use this one. Prepends shim executables
#                            (rm, rmdir, unlink, shred, truncate, mkfs, dd) to
#                            PATH for both guard runs; each shim LOGS its argv to
#                            $SCRATCH/destructive-calls.log and deletes nothing.
#                            Assert on what the code WOULD delete instead of
#                            letting it delete. Limit: PATH-level interception
#                            only — a subject calling /bin/rm by absolute path
#                            bypasses the shims (use the sandbox for those).
#
#   --i-know-this-deletes    Explicit opt-in to REAL execution, and it ALSO
#     --sandbox-root <dir>   requires --sandbox-root: both guard runs are then
#                            wrapped in bwrap with / mounted READ-ONLY and only
#                            <dir> + the probe scratch dir writable, so a mutant
#                            that widens its delete target hits a wall instead
#                            of the filesystem. Refused if bwrap cannot sandbox
#                            on this host.
#
#   Either flag may also be passed proactively for a subject the heuristic does
#   not flag — they only ever ADD protection.
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
#   --in-tree REFUSES to run until you say what you did about the sweep, because
#   the sweep race is the one hazard this script cannot close on its own:
#       --sweep-lock-held    you hold git-sync:<slug> (the incantation is in the
#                            refusal message) — git-sync's tick takes that same
#                            lock and SKIPS while you hold it
#       --accept-sweep-race  you consciously accept it (an unswept checkout, or
#                            a run short enough that you have judged the risk)
#   The choice is echoed into MUTATION_PROBE_RESULT, so an accepted race is
#   auditable after the fact rather than invisible. This gate exists because the
#   advice it replaced was a log line printed while the mutation was ALREADY
#   under way — nothing had to be decided for the probe to proceed.
#
#   --mutate is a PERL expression, so on the PATTERN side ( ) { } + ? . * are
#   REGEX METACHARACTERS. Escape them to match source code literally:
#       's|if \(x > 0\) \{|if (false) {|'   not   's|if (x > 0) {|if (false) {|'
#   The unescaped form matches NOTHING and is refused as a no-op mutation (see
#   EXIT CODE 2) — the refusal repeats this note, so you cannot silently probe
#   a guard with a mutation that never applied.
#
# EXAMPLE (the real probe this script was extracted from) — VERIFIED RUNNABLE, and
# pinned that way by doc-claims/mutation-probe-example-is-runnable.test.ts, because
# all three of the things that make it work are easy to get silently wrong (WI-39608):
#   • the --test target must READ PROBE_SCRIPT, or {} points nowhere and the probe
#     measures the UNMUTATED tracked file and reports a false "mutant SURVIVED";
#   • the --mutate pattern must still MATCH the subject — this example's original
#     pattern stopped matching when the call site became `if <fn>; then ...; fi`;
#   • the subject trips the destructive-primitive gate (it contains rm/unlink), so
#     --fake-destructive is required to run it at all.
#   scripts/mutation-probe.sh \
#     --file scripts/verify-tauri-headless.sh \
#     --fake-destructive \
#     --mutate 's/^\s*if port_lost_to_squatter; then PORT_LOST=1; break; fi$//' \
#     --test 'PROBE_SCRIPT={} npm run test:file -- apps/operator/lib/verify-tauri-headless-bind-retry.test.ts'
#
# EXIT CODES
#   0  the probe reached its expected verdict (default: the mutant was CAUGHT)
#   1  the probe reached the opposite verdict — your guard is weaker than you think
#   2  misuse / the probe could not be run soundly (e.g. a no-op or
#      whitespace-only mutation,
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
SWEEP_ACK=""
AGAINST_COMMIT=""
AGAINST_LAST_WITHOUT=""
MUST_BE_ABSENT=""
CALIBRATION_CMD=""
POSITIVE_CONTROLS=()
HISTORICAL_MODE=0
DELETES_ACK=0
FAKE_DESTRUCTIVE=0
SANDBOX_ROOT=""
FAKE_BIN=""
DESTRUCTIVE_LOG=""

# The resource git-sync's own tick holds for this checkout. Resolved from the
# repo root rather than hardcoded, so a submodule (which git-sync sweeps under
# its OWN slug) names its own lock instead of the superproject's.
sweep_lock_resource() {
  printf 'git-sync:%s' "$(basename "$(git rev-parse --show-toplevel 2>/dev/null || echo papercusp)")"
}

while [ $# -gt 0 ]; do
  case "$1" in
    --file)    FILE="${2:-}";     shift 2 || die "--file needs a value" ;;
    --mutate)  MUTATE="${2:-}";   shift 2 || die "--mutate needs a value" ;;
    --test)    TEST_CMD="${2:-}"; shift 2 || die "--test needs a value" ;;
    --expect)  EXPECT="${2:-}";   shift 2 || die "--expect needs a value" ;;
    --in-tree) IN_TREE=1; shift ;;
    --sweep-lock-held)   SWEEP_ACK="lock-held";      shift ;;
    --accept-sweep-race) SWEEP_ACK="race-accepted";  shift ;;
    --against-commit)     AGAINST_COMMIT="${2:-}"; shift 2 || die "--against-commit needs a value" ;;
    --against-last-without) AGAINST_LAST_WITHOUT="${2:-}"; shift 2 || die "--against-last-without needs a value" ;;
    --must-be-absent)     MUST_BE_ABSENT="${2:-}"; shift 2 || die "--must-be-absent needs a value" ;;
    --positive-control)   POSITIVE_CONTROLS+=("${2:-}"); shift 2 || die "--positive-control needs a value" ;;
    --calibration)        CALIBRATION_CMD="${2:-}"; shift 2 || die "--calibration needs a value" ;;
    --fake-destructive)    FAKE_DESTRUCTIVE=1; shift ;;
    --i-know-this-deletes) DELETES_ACK=1;      shift ;;
    --sandbox-root) SANDBOX_ROOT="${2:-}"; shift 2 || die "--sandbox-root needs a value" ;;
    # Print the whole header block, bounded by where it actually ends rather
    # than by a hardcoded line number — the previous '2,70p' silently truncated
    # mid-section every time the header grew, which is how --help ends up
    # describing a flag set the script no longer has.
    -h|--help) awk 'NR>1 { if (/^#/) print; else exit }' "$0"; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done

[ -n "$FILE" ]     || die "missing --file"
[ -n "$TEST_CMD" ] || die "missing --test"
[ -f "$FILE" ]     || die "no such file: $FILE"
# Resolve --file to an ABSOLUTE path before anything substitutes it. The two
# runs are not symmetric: the baseline substitutes {} with this original path
# VERBATIM, while the mutant gets an absolute scratch path. So a relative
# --file (the natural thing to type from the repo root) makes only the BASELINE
# cwd-dependent, and any --test that runs from a different directory — a vitest
# workspace, an npm script — fails there and nowhere else. The script then
# correctly refuses to score the mutant, but reports "BASELINE FAILED", which
# reads as "your guard is broken" rather than "your path was relative".
FILE="$(cd "$(dirname "$FILE")" 2>/dev/null && pwd)/$(basename "$FILE")"
[ -f "$FILE" ] || die "could not resolve --file to an absolute path: $FILE"
case "$EXPECT" in caught|survived) ;; *) die "--expect must be 'caught' or 'survived'" ;; esac

if [ -n "$AGAINST_COMMIT" ] || [ -n "$AGAINST_LAST_WITHOUT" ] || [ -n "$MUST_BE_ABSENT" ] || [ -n "$CALIBRATION_CMD" ] || [ "${#POSITIVE_CONTROLS[@]}" -gt 0 ]; then
  HISTORICAL_MODE=1
fi

if [ "$HISTORICAL_MODE" -eq 1 ]; then
  [ -z "$MUTATE" ] || die "--mutate cannot be combined with historical mode; historical mode supplies the before-fix snapshot"
  [ "$IN_TREE" -eq 0 ] || die "historical mode is always copy-out; drop --in-tree"
  [ -z "$SWEEP_ACK" ] || die "--sweep-lock-held / --accept-sweep-race only apply to --in-tree mutation mode"
  [ -n "$AGAINST_COMMIT" ] || [ -n "$AGAINST_LAST_WITHOUT" ] || die "historical mode needs exactly one of --against-commit or --against-last-without"
  [ -z "$AGAINST_COMMIT" ] || [ -z "$AGAINST_LAST_WITHOUT" ] || die "pick exactly one of --against-commit or --against-last-without"
  [ "${#POSITIVE_CONTROLS[@]}" -gt 0 ] || die "historical mode requires at least one --positive-control literal"
  [ -n "$CALIBRATION_CMD" ] || die "historical mode requires --calibration <command containing {}>"
  case "$TEST_CMD" in
    *"{}"*) ;;
    *) die "historical --test must contain {} (the frozen current/historical snapshot path)" ;;
  esac
  case "$CALIBRATION_CMD" in
    *"{}"*) ;;
    *) die "--calibration must contain {} (the frozen current/historical snapshot path)" ;;
  esac
  if [ -n "$AGAINST_COMMIT" ]; then
    [ -n "$MUST_BE_ABSENT" ] || die "--against-commit requires --must-be-absent <literal> so the selected commit is proven to be the before-fix side"
  else
    [ -z "$MUST_BE_ABSENT" ] || [ "$MUST_BE_ABSENT" = "$AGAINST_LAST_WITHOUT" ] || die "--against-last-without already supplies the absence control; do not pass a different --must-be-absent literal"
    MUST_BE_ABSENT="$AGAINST_LAST_WITHOUT"
  fi
else
  [ -n "$MUTATE" ] || die "missing --mutate"
  [ -z "$AGAINST_COMMIT" ] && [ -z "$AGAINST_LAST_WITHOUT" ] || die "historical selector requires --calibration and --positive-control; use historical mode deliberately"
fi
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

# --in-tree is the ONLY mode that leaves a deliberately-wrong state in the
# tracked tree, and the sweep race is the one hazard this script cannot close
# for you: git-sync commits the WHOLE working tree on a short cadence, so a
# probe whose test run outlives one tick gets its mutant committed even when
# nothing goes wrong and the trap never fires. Refuse until the caller has
# decided what to do about it. This deliberately REPLACES a warning that was
# logged while the mutation was already under way — a notice you can skim past
# is not a decision, and the whole point is that one has to be made.
if [ "$IN_TREE" -eq 1 ] && [ -z "$SWEEP_ACK" ]; then
  die "--in-tree needs you to say what you did about the git-sync SWEEP race.

      git-sync commits the whole working tree every few minutes. Your mutant is
      a deliberately-broken tracked file; if a tick lands during the test run it
      is committed to staging, and a committed RED test freezes every agent's
      deploys until someone notices. The trap in this script closes the DEATH
      race (a kill mid-run), not this one.

      PREFERRED — hold the sweep off, then pass --sweep-lock-held:

          locks:acquire_resource { resource: '$(sweep_lock_resource)',
                                   mode: 'exclusive', ttl_sec: 600,
                                   reason: 'mutation probe' }

      git-sync's own tick takes that same lock and SKIPS while you hold it, and
      the TTL auto-releases it if you die holding it.

      OR --accept-sweep-race, if this checkout is not swept (a scratch repo, a
      fork) or you have judged the exposure yourself. Either choice is recorded
      in the MUTATION_PROBE_RESULT line.

      BEST — drop --in-tree entirely. Copy-out mode mutates a copy under a
      scratch dir, so the tracked file is never dirty for an instant and there
      is no window to protect. It needs only that your --test can be pointed at
      a path via {}."
fi
if [ "$IN_TREE" -eq 0 ] && [ -n "$SWEEP_ACK" ]; then
  die "--sweep-lock-held / --accept-sweep-race only mean something with --in-tree.
      Copy-out mode never touches the tracked file, so there is no sweep window
      to hold open or accept. Drop the flag (or add --in-tree if you meant it)."
fi

# --- destructive-subject flag plumbing (EI-20566003853444873) ----------------
if [ "$DELETES_ACK" -eq 1 ] && [ "$FAKE_DESTRUCTIVE" -eq 1 ]; then
  die "pick ONE: --fake-destructive (shimmed, nothing really deletes) or
      --i-know-this-deletes --sandbox-root <dir> (real execution, sandboxed).
      Combining them would run REAL deletion logic while telling you it was shimmed."
fi
if [ "$DELETES_ACK" -eq 1 ] && [ -z "$SANDBOX_ROOT" ]; then
  die "--i-know-this-deletes ALSO requires --sandbox-root <dir>.
      Acknowledging the danger does not remove it: the 2026-08-15 incident ran a
      mutant whose delete loop had been widened to 'for d in /*' — an
      acknowledgement flag alone would not have saved a single byte. With
      --sandbox-root, both guard runs execute under bwrap with / READ-ONLY and
      only <dir> + the probe scratch dir writable, so a widened mutant hits a
      wall. If your guard cannot run sandboxed, use --fake-destructive instead."
fi
if [ -z "$SANDBOX_ROOT" ] || [ "$DELETES_ACK" -eq 1 ]; then :; else
  die "--sandbox-root only means something with --i-know-this-deletes.
      (--fake-destructive needs no sandbox: nothing real executes deletion.)"
fi
if [ -n "$SANDBOX_ROOT" ]; then
  [ -d "$SANDBOX_ROOT" ] || die "no such --sandbox-root directory: $SANDBOX_ROOT"
  SANDBOX_ROOT="$(cd "$SANDBOX_ROOT" && pwd)" || die "could not resolve --sandbox-root"
fi

SCRATCH="$(mktemp -d "${TMPDIR:-/tmp}/mutation-probe.XXXXXX")" || die "could not create scratch dir"
readonly SCRATCH
BASE="$SCRATCH/$(basename "$FILE").orig"
cp "$FILE" "$BASE" || die "could not snapshot $FILE"

# Keep a whitespace-normalized snapshot as well. A mis-escaped expression can
# change bytes without changing any non-whitespace token (for example, by
# deleting one leading space from every shell line), which would otherwise
# produce a false "MUTANT SURVIVED" verdict about a mutation that did not test
# the intended guard behavior. Refuse that conservative case below.
BASE_NON_WHITESPACE="$SCRATCH/$(basename "$FILE").orig.non-whitespace"
tr -d '[:space:]' < "$BASE" > "$BASE_NON_WHITESPACE" || die "could not normalize the probe baseline"

# The ORIGINAL bytes, captured before anything is touched. Every integrity
# claim this script makes is decided against this, never against `git status`
# (on a swept tree a clean status means the sweep ran, not that the file is
# unmodified — CLAUDE.md documents this at length).
ORIG_SUM="$(git hash-object "$FILE")"
readonly BASE BASE_NON_WHITESPACE ORIG_SUM

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
  local rc="${1:-$?}"
  # Disarm FIRST: without this the handler runs twice (once for TERM, once for
  # the EXIT that TERM causes) and prints its verdict twice.
  trap - EXIT INT TERM
  # Restore FIRST. `kill_tree` walks the host process table once per descendant;
  # on the shared box that can take seconds before it signals even a tiny
  # shell->sleep tree. Putting cleanup first left the tracked mutant in place
  # for that entire walk and intermittently exceeded the harness's 5s
  # SIGTERM->restore integrity deadline. The guard child is read-only with
  # respect to FILE, and the old ordering did not wait for it to exit before
  # copying anyway, so deferring the copy bought no race protection.
  if [ "$IN_TREE" = "1" ]; then
    cp "$BASE" "$FILE" 2>/dev/null || true
  fi
  # Once the shared-tree invariant is restored, reap the probe's own child and
  # every descendant so a cancelled npm/node/vitest guard cannot run orphaned.
  if [ -n "$CHILD" ]; then
    kill_tree "$CHILD"
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
trap 'finish "$?"' EXIT
trap 'finish 130' INT
trap 'finish 143' TERM

CURRENT_SNAPSHOT=""
HISTORICAL_SNAPSHOT=""
HISTORICAL_SHA=""
GIT_ROOT=""
REL_FILE=""

if [ "$HISTORICAL_MODE" -eq 1 ]; then
  # Historical mode never reads the working file again after this point. The
  # current bytes are a frozen snapshot too: git-sync may advance the tree
  # while a long guard suite runs, and comparing a live current file to a
  # historical blob would make the two sides observe different revisions.
  CURRENT_SNAPSHOT="$SCRATCH/current.snapshot"
  cp -p "$BASE" "$CURRENT_SNAPSHOT" || die "could not freeze the current snapshot"

  GIT_ROOT="$(git -C "$(dirname "$FILE")" rev-parse --show-toplevel 2>/dev/null)" \
    || die "--against-commit / --against-last-without requires --file to be inside a Git worktree"
  case "$FILE" in
    "$GIT_ROOT"/*) REL_FILE="${FILE#"$GIT_ROOT"/}" ;;
    *) die "--file is not inside the Git worktree root: $GIT_ROOT" ;;
  esac
  git -C "$GIT_ROOT" ls-files --error-unmatch -- "$REL_FILE" >/dev/null 2>&1 \
    || die "historical mode requires a tracked --file; Git has no path '$REL_FILE' in $GIT_ROOT"

  if [ -n "$AGAINST_COMMIT" ]; then
    HISTORICAL_SHA="$(git -C "$GIT_ROOT" rev-parse --verify "${AGAINST_COMMIT}^{commit}" 2>/dev/null)" \
      || die "could not resolve --against-commit '$AGAINST_COMMIT' to a commit"
  else
    CANDIDATE="$SCRATCH/historical-candidate"
    CANDIDATE_ERR="$SCRATCH/historical-candidate.err"
    while IFS= read -r sha; do
      # Materialize each candidate instead of piping git show to grep: grep -q
      # can close the pipe early, and pipefail would turn that SIGPIPE into a
      # false "token absent" result.
      if git -C "$GIT_ROOT" show "$sha:$REL_FILE" >"$CANDIDATE" 2>"$CANDIDATE_ERR"; then
        if ! grep -Fq -- "$AGAINST_LAST_WITHOUT" "$CANDIDATE"; then
          HISTORICAL_SHA="$sha"
          break
        fi
      fi
    done < <(git -C "$GIT_ROOT" rev-list HEAD -- "$REL_FILE")
    [ -n "$HISTORICAL_SHA" ] || die "no reachable commit on HEAD has '$REL_FILE' without the required literal '$AGAINST_LAST_WITHOUT'"
  fi

  HISTORICAL_SNAPSHOT="$SCRATCH/historical.snapshot"
  git -C "$GIT_ROOT" show "$HISTORICAL_SHA:$REL_FILE" >"$HISTORICAL_SNAPSHOT" 2>"$SCRATCH/historical-show.err" \
    || die "commit '$HISTORICAL_SHA' does not contain '$REL_FILE': $(head -3 "$SCRATCH/historical-show.err" 2>/dev/null)"
  if cmp -s "$CURRENT_SNAPSHOT" "$HISTORICAL_SNAPSHOT"; then
    die "historical snapshot is byte-identical to the frozen current snapshot (selected commit is not a before-fix source)"
  fi

  # The absence control is the guard against selecting the fixed side by
  # mistake. --against-last-without proves it while selecting; explicit
  # --against-commit needs the caller to name the construct that must be
  # absent. Check both sides again after extraction so the evidence is local,
  # deterministic, and visible in the probe output.
  grep -Fq -- "$MUST_BE_ABSENT" "$CURRENT_SNAPSHOT" \
    || die "absence control '$MUST_BE_ABSENT' is not present in the frozen current snapshot"
  if grep -Fq -- "$MUST_BE_ABSENT" "$HISTORICAL_SNAPSHOT"; then
    die "absence control '$MUST_BE_ABSENT' is present in historical commit $HISTORICAL_SHA; this is not a before-fix snapshot"
  fi

  [ "${#POSITIVE_CONTROLS[@]}" -gt 0 ] || die "historical mode requires positive controls"
  for control in "${POSITIVE_CONTROLS[@]}"; do
    [ -n "$control" ] || die "--positive-control literals must not be empty"
    grep -Fq -- "$control" "$CURRENT_SNAPSHOT" \
      || die "positive control '$control' is absent from the frozen current snapshot"
    grep -Fq -- "$control" "$HISTORICAL_SNAPSHOT" \
      || die "positive control '$control' is absent from historical commit $HISTORICAL_SHA"
  done

  log "historical source: commit=$HISTORICAL_SHA path=$REL_FILE"
  log "frozen snapshots: current=$CURRENT_SNAPSHOT historical=$HISTORICAL_SNAPSHOT"
  log "absence control: $MUST_BE_ABSENT"
  for control in "${POSITIVE_CONTROLS[@]}"; do
    log "positive control: $control"
  done
fi

# ---------------------------------------------------------------------------
# Destructive-subject gate (EI-20566003853444873, the 2026-08-15 incident).
# Everything above only READS the subject; the first EXECUTION of anything is
# the baseline guard run below, so this gate must sit before it. The scan is
# deliberately conservative — a false positive costs one flag; a false negative
# already cost ~370GB.
# ---------------------------------------------------------------------------
DESTRUCTIVE_ERE='\b(rm|rmdir|unlink|shred|truncate)\b|\bmkfs(\.[[:alnum:]]+)?\b|\bdd\b[^|;&()]*\bof=|\bfind\b[^|;&()]*-delete'
SUBJ_HITS="$(grep -Eo "$DESTRUCTIVE_ERE" "$FILE" 2>/dev/null | sort -u | head -6 | tr '\n' ' ' || true)"
HIST_SUBJ_HITS=""
if [ "$HISTORICAL_MODE" -eq 1 ]; then
  HIST_SUBJ_HITS="$(grep -Eo "$DESTRUCTIVE_ERE" "$HISTORICAL_SNAPSHOT" 2>/dev/null | sort -u | head -6 | tr '\n' ' ' || true)"
fi
CMD_HITS="$(printf '%s\n%s' "$TEST_CMD" "$CALIBRATION_CMD" | grep -Eo "$DESTRUCTIVE_ERE" 2>/dev/null | sort -u | head -6 | tr '\n' ' ' || true)"
if [ -n "$SUBJ_HITS$HIST_SUBJ_HITS$CMD_HITS" ] && [ "$DELETES_ACK" -eq 0 ] && [ "$FAKE_DESTRUCTIVE" -eq 0 ]; then
  die "REFUSING: the probe would EXECUTE destructive code, and nothing sandboxes what a mutant DOES.
      Matched destructive primitives — current subject: ${SUBJ_HITS:-none}; historical subject: ${HIST_SUBJ_HITS:-none}; --test/--calibration: ${CMD_HITS:-none}

      This script's guarantees protect the FILE UNDER TEST, never the filesystem the
      mutant runs against. Executing a mutant of deletion code means running
      deliberately-corrupted deletion logic with your full privileges: on 2026-08-15
      exactly that turned a reaper's loop into 'for d in /*' and destroyed ~370GB
      (EI-20566003853444873). Pick one:

      PREFERRED — add --fake-destructive
          Shim executables (rm, rmdir, unlink, shred, truncate, mkfs, dd) are
          prepended to PATH for both guard runs; each logs its argv to the scratch
          dir's destructive-calls.log and deletes NOTHING. Assert on what the code
          WOULD delete. (PATH-level only: an absolute /bin/rm call bypasses it.)

      OR — add --i-know-this-deletes --sandbox-root <dir>
          Real execution, but both guard runs are wrapped in bwrap with / mounted
          READ-ONLY and only <dir> + the probe scratch dir writable.

      If the match is a false positive (e.g. 'rm' inside a comment or a path),
      either flag is safe — they only ever ADD protection."
fi

if [ "$FAKE_DESTRUCTIVE" -eq 1 ]; then
  FAKE_BIN="$SCRATCH/fake-bin"
  DESTRUCTIVE_LOG="$SCRATCH/destructive-calls.log"
  mkdir -p "$FAKE_BIN" || die "could not create the fake-destructive shim dir"
  : >"$DESTRUCTIVE_LOG"
  for shim_tool in rm rmdir unlink shred truncate mkfs dd; do
    cat >"$FAKE_BIN/$shim_tool" <<'SHIM'
#!/usr/bin/env bash
printf '%s %s\n' "${0##*/}" "$*" >> "${MUTATION_PROBE_DESTRUCTIVE_LOG:?}"
exit 0
SHIM
    chmod +x "$FAKE_BIN/$shim_tool" || die "could not install shim: $shim_tool"
  done
  log "fake-destructive: shims installed ($FAKE_BIN); intercepted calls -> $DESTRUCTIVE_LOG"
fi

if [ "$DELETES_ACK" -eq 1 ]; then
  command -v bwrap >/dev/null 2>&1 \
    || die "--i-know-this-deletes needs bwrap (bubblewrap) for its read-only sandbox and this host has none. Use --fake-destructive instead."
  if ! bwrap --ro-bind / / --dev /dev --proc /proc --die-with-parent -- true 2>"$SCRATCH/bwrap-preflight.err"; then
    die "bwrap cannot create its sandbox on this host (user namespaces may be disabled here):
      $(head -3 "$SCRATCH/bwrap-preflight.err" 2>/dev/null)
      REFUSING to run destructive code unsandboxed. Use --fake-destructive instead."
  fi
  log "sandbox: guard runs will execute under bwrap — / read-only; writable: $SANDBOX_ROOT + $SCRATCH"
fi

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
    if [ "$FAKE_DESTRUCTIVE" -eq 1 ]; then
      # PATH-level interception, scoped to the supervised child only.
      export PATH="$FAKE_BIN:$PATH"
      export MUTATION_PROBE_DESTRUCTIVE_LOG="$DESTRUCTIVE_LOG"
    fi
    if [ "$DELETES_ACK" -eq 1 ]; then
      # Real execution, walled in: / read-only, only the caller's declared
      # sandbox root and the probe scratch dir writable. TMPDIR is pointed
      # into scratch so well-behaved tools land their temp files inside the
      # writable zone. Parent-held fds (the >"$output" redirect) pass through.
      export TMPDIR="$SCRATCH"
      printf '%s\n' "$cmd" >"$SCRATCH/guard-cmd.sh"
      exec bwrap --ro-bind / / --dev /dev --proc /proc \
        --bind "$SANDBOX_ROOT" "$SANDBOX_ROOT" --bind "$SCRATCH" "$SCRATCH" \
        --die-with-parent -- bash "$SCRATCH/guard-cmd.sh"
    fi
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
  TARGET_MODE="in-tree:$SWEEP_ACK"
  log ""
  log "⚠️  --in-tree: the TRACKED file will be mutated in place."
  if [ "$SWEEP_ACK" = "lock-held" ]; then
    log "⚠️  Sweep: you declared $(sweep_lock_resource) HELD — git-sync's tick will skip."
    log "⚠️  That lock is NOT verified from here; if you did not actually take it,"
    log "⚠️  or its ttl_sec expires mid-run, the mutant can still be swept."
  else
    log "⚠️  Sweep: race ACCEPTED — nothing is holding git-sync off. If a tick lands"
    log "⚠️  during this run, the mutant is committed to the shared tree."
  fi
  log "⚠️  The trap closes the DEATH race (a kill mid-run); it cannot undo a commit."
  log "⚠️  Prefer copy-out mode (drop --in-tree) — it has no window at all."
  log ""
  TARGET="$FILE"
else
  TARGET_MODE="copy-out"
  TARGET="$SCRATCH/$(basename "$FILE")"
  cp "$FILE" "$TARGET" || die "could not stage the probe copy"
fi
readonly TARGET_MODE

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
    "$EXPECT" "$TARGET_MODE" "$BASELINE_RC"
  exit 2
fi

# --- pre-flight the mutation under perl strict -------------------------------
# On a THROWAWAY copy, deliberately BEFORE the dirty window below (this block
# may use command substitution; the dirty window must not). perl s///
# INTERPOLATES the REPLACEMENT half, and an UNDEFINED perl variable there is
# silently empty — that silent-empty is how an escaped-match-side probe's
# replacement became 'for d in ""/*' == 'for d in /*' and destroyed ~370GB on
# 2026-08-15 (EI-20566003853444873). Under -Mstrict an undeclared $name is a
# COMPILE error instead, so the trap fires loudly before anything is mutated.
cp "$BASE" "$SCRATCH/strict-check" || die "could not stage the strict-check copy"
if ! perl -Mstrict -pe "$MUTATE" "$SCRATCH/strict-check" >/dev/null 2>"$SCRATCH/strict-err"; then
  die "the --mutate expression does not compile under 'use strict' — refusing before mutating anything.
      perl said: $(head -3 "$SCRATCH/strict-err" 2>/dev/null)

      MOST COMMON CAUSE: a bare \$name in the REPLACEMENT half. perl INTERPOLATES
      the replacement, so \$name there is a PERL VARIABLE — and if it is undefined
      it becomes silently EMPTY (that exact silent-empty widened a delete loop to
      'for d in /*' on 2026-08-15). If you meant the literal text \$name — e.g. the
      subject is a SHELL script and \$name is one of ITS variables — escape it on
      the replacement side too: s/match/\\\$name/. Special vars (\$1, \$&) are fine."
fi

MUTANT_NON_WHITESPACE="$SCRATCH/$(basename "$FILE").mutant.non-whitespace"
readonly MUTANT_NON_WHITESPACE

# --- apply the mutation -----------------------------------------------------
perl -pi -e "$MUTATE" "$TARGET" || die "mutation command failed"

# Show the exact mutation before running the guard. This makes an accidental
# match in indentation/comments visible immediately instead of being inferred
# from a misleading falsifiability verdict. diff returns 1 for a real diff,
# so its nonzero status is intentionally ignored.
log "mutation diff (first 40 lines):"
diff -u -- "$BASE" "$TARGET" | sed -n '1,40p' || true

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

# A mutation that changes only whitespace is just as unsound as a byte-identical
# mutation for falsifiability: it can leave the subject's behavior unchanged
# while making a guard appear weak. Keep this check language-agnostic and
# conservative; callers must choose a mutation that changes a non-whitespace
# token before the guard is scored.
tr -d '[:space:]' < "$TARGET" > "$MUTANT_NON_WHITESPACE" || die "could not normalize the mutant"
if cmp -s "$MUTANT_NON_WHITESPACE" "$BASE_NON_WHITESPACE"; then
  die "the --mutate expression changed ONLY WHITESPACE (non-whitespace content is unchanged).
      A whitespace-only mutation can leave behavior unchanged and make any guard
      look weak. Inspect the mutation diff above, then fix the expression so it
      changes the intended non-whitespace token and re-run."
fi
# Keep the DIRTY window free of command substitutions. A SIGTERM that landed
# inside the old nested hash-object substitutions could make Bash abort trap
# parsing with an unmatched closing parenthesis; finish() then never ran and
# the tracked mutant stayed behind. ORIG_SUM is already available, and the
# exact mutant hash is diagnostic convenience rather than integrity evidence.
log "mutant applied: ${ORIG_SUM:0:8} -> changed ($TARGET_MODE)"

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
  "$VERDICT" "$EXPECT" "$TARGET_MODE" "$BASELINE_RC" "$TEST_RC"

[ "$VERDICT" = "harness-error" ] && exit 2
[ "$VERDICT" = "$EXPECT" ] || exit 1
exit 0
