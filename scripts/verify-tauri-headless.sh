#!/usr/bin/env bash
# scripts/verify-tauri-headless.sh — EI-9005.
#
# THE PROBLEM: agents verifying Papercusp desktop UI either fight over the
# owner's live :0 Tauri window (focus-steal, disrupts real fleet work — see
# apps/operator-docs/.../testing/agent-e2e.mdx §0/§1.3), or, on finding the
# live window busy/contended, silently skip the owner-required UI-verification
# gate because hand-deriving an isolated Xvfb+VirtualGL+bridge instance every
# time (agent-e2e.mdx §1.3 + §15.4) is expensive enough on a loaded box that
# skipping looks rational. Two independent work-items hit this same gap the
# same week (EI-9005, WI-3658) — evidence it's recurring, not one-off.
#
# THE FIX: package the already-documented isolated-instance recipe as ONE
# script. Boots a `papercusp-desktop` dev instance with its own devUrl port and
# its own operator sidecar process, under an isolated Xvfb + VirtualGL X server
# (real GPU, so screenshots aren't blank — see the GL trap in agent-e2e.mdx
# §15.4) — waits for its dev-bridge to come up, execs the caller's assertion
# command against it, then tears the whole process tree + X server down. It
# NEVER touches DISPLAY :0/:1 (the owner's real desktop) and never sets
# PAPERCUSP_CLUSTER_WORKERS (the WI-3556 shadow trap documented in
# agent-e2e.mdx §1.3 — the wrapper script already pins PAPERCUSP_CLUSTER=0 for
# exactly this reason; setting CLUSTER_WORKERS ourselves would silently shadow
# that safety pin).
#
# ⚠️  WHAT IS **NOT** ISOLATED — READ THIS BEFORE YOU CLICK ANYTHING (EI-10387)
#
#   ISOLATED:      the X display, the devUrl port, the pty port, the sidecar
#                  *process*, and (EI-10364) the SPA MODULE BUNDLE — a frozen
#                  snapshot the fleet's shared `vite build --watch` can't touch,
#                  so this webview's module graph is stable for the whole run.
#   **NOT** ISOLATED: the DATABASE and the WORKSPACE. The sidecar inherits the
#                  ambient env, so it connects to the SAME `DATABASE_URL` /
#                  `PAPERCUSP_WORKSPACE` as the live system.
#
#   => **EVERY WRITE YOU MAKE IN THIS WINDOW IS A REAL WRITE TO LIVE STATE.**
#      Clicking a Mug steering control here mutates the owner's real steering
#      AND calls requestUrgentHiveWake() — waking the real Mug and burning real
#      tokens. Toggling a routine here really toggles it (git-sync included).
#
#   This header used to claim "own embedded-PG, own workspace state; NOT just a
#   second window pointed at shared backend state". That was FALSE, and it is
#   exactly the kind of claim an agent takes on trust before clicking a
#   destructive button — so it was corrected here rather than left to mislead.
#
#   EI-10387 (2026-07-18): the claim is now TRUE, OPT-IN. Pass
#   VERIFY_TAURI_ISOLATED_DB=1 and this script boots a throwaway, fully-migrated,
#   per-run embedded Postgres (own datadir, own free port — nobody else's pot),
#   scopes PAPERCUSP_HOME/PAPERCUSP_WORKSPACE to this run, and *asserts at boot*
#   (reading the real sidecar process's own /proc/<pid>/environ, not just our own
#   env construction) that the resolved DB actually differs from the live one —
#   refusing to proceed otherwise. Every write in that mode is safe: it lands in
#   the throwaway DB, which nothing else reads, and is discarded at teardown. The
#   instance boots into the normal first-run onboarding flow (an empty, freshly-
#   migrated DB — the same state every real fresh install boots into), not the
#   owner's real pots/plans.
#
#   Default (VERIFY_TAURI_ISOLATED_DB unset) is UNCHANGED: shared live DB, as
#   warned above — because many verify runs legitimately want to read/exercise
#   real existing state (the header's original "READ paths are safe as-is"
#   still holds), which an isolated empty DB cannot offer. Use isolation when you
#   need to click through WRITE paths and don't care about pre-existing data;
#   stay on the shared default to verify against real live state.
#
#   For write-path testing WITHOUT isolation (e.g. you need the isolated run's
#   speed/onboarding tradeoff to not apply), intercept the webview instead of
#   letting the write reach the backend: stub `window.fetch` for
#   POST /api/agent-mcp/run-tool, capture the request body, return a synthetic
#   `{ ok:true, result:{ content:[{ text:'{"ok":true}' }] } }`, and validate the
#   captured payloads offline against the tool's own zod schema (the method used
#   for the 2026-07-12 Mug/Kettle/Papercup button sweep).
#
# Reuses fed_pick_free_port from bin/lib/federation-asserts.sh (the same
# staggered free-port picker the two-instance federation smokes already use)
# instead of re-deriving port-picking — reuse-first.
#
# USAGE
#   scripts/verify-tauri-headless.sh -- <assertion-command...>
#     Boots the instance, runs <assertion-command...> with
#     VERIFY_TAURI_PID / VERIFY_TAURI_PORT / VERIFY_TAURI_DISPLAY exported,
#     tears down (even on a failing assertion), and exits with the assertion
#     command's own exit code. Example:
#       scripts/verify-tauri-headless.sh -- bash -c '
#         tauri-agent-tools eval --pid "$VERIFY_TAURI_PID" \
#           "window.__TSR_ROUTER__?.navigate({ to: "/settings/p2p" })"
#         "$VERIFY_TAURI_POLL" --selector body --text Peer --no-errors'
#     VERIFY_TAURI_POLL retries a data-dependent DOM assertion after navigation
#     (bounded by VERIFY_TAURI_DOM_TIMEOUT) instead of racing it with a fixed sleep.
#
#   scripts/verify-tauri-headless.sh --boot-only
#     Boots the instance, prints its env (source-able) plus a stop-script
#     path, and returns WITHOUT tearing down — for a multi-step interactive
#     verification session. Run the printed stop script when done; NEVER
#     leave it running unattended (mirrors the two-instance-*-smoke.sh
#     leaked-Xvfb lesson, WI-2115 — a display left up starves the next run).
#
# ENV OVERRIDES (all optional)
#   VERIFY_TAURI_ISOLATED_DB    1 = boot a genuinely isolated, throwaway,
#                                fully-migrated embedded Postgres for this run
#                                instead of sharing the live DATABASE_URL/
#                                workspace (EI-10387). See the header block.
#                                Default 0 (today's shared-live-DB behavior).
#   VERIFY_TAURI_ISOLATED_PG_TIMEOUT
#                               seconds to wait for the isolated Postgres to
#                                come up (default 90 — a from-scratch initdb +
#                                full migration replay is ~10-30s; a pre-built
#                                seed extract is ~1s). Only used with
#                                VERIFY_TAURI_ISOLATED_DB=1.
#   PAPERCUSP_REPO_DIR          repo root (default: derived from this script)
#   VERIFY_TAURI_DISPLAY_NUM    Xvfb display number (default: auto-picked, >=90)
#   VERIFY_TAURI_TIMEOUT        seconds to wait for the bridge (default 180 —
#                                a cold/changed src-tauri rebuild is slower)
#   VERIFY_TAURI_DOM_TIMEOUT    seconds VERIFY_TAURI_POLL waits for a DOM
#                                assertion after navigation (default 30)
#   VERIFY_TAURI_DOM_POLL_INTERVAL
#                               seconds between DOM assertion attempts (default 1)
#   VERIFY_TAURI_SKIP_GL_CHECK  1 = skip the VirtualGL real-GPU sanity check
#                                (screenshots will be blank white — DOM/eval
#                                via the bridge still work; agent-e2e.mdx §15.4)
#   VERIFY_TAURI_PORT_LOCK_DIR  advisory-lock directory for concurrent verifier
#                               launches (default: $TMPDIR/papercusp-tauri-port-locks)
#   VERIFY_TAURI_PORT_STRAGGLER_WAIT
#                               seconds teardown HOLDS the advisory port lock while
#                                waiting for THIS run's sidecar to release its
#                                display-derived port(s) before releasing the lock,
#                                so a display-reusing next run can't collide with a
#                                straggler (default 30; EI-11559). The wait exits
#                                early the instant the port is free.
#   VERIFY_TAURI_MEMORY_LIMIT_MB
#                               RSS high-water mark (MiB) the isolated verify
#                                sidecar's memory-watchdog recycles at (default
#                                12288 — the background-primary footprint; EI-11641).
#                                The role-aware default would mis-size this
#                                substrate-booting sidecar to the 3200 request-worker
#                                limit, which its own fresh boot (~3.3 GB) already
#                                exceeds → a perpetual recycle loop that wedges the
#                                agent bridge. Must be a positive MiB value (a
#                                non-positive value falls back to the role default);
#                                to disable the watchdog outright, export
#                                PAPERCUSP_MEMORY_WATCHDOG=0 in the ambient env.
#   VERIFY_TAURI_STALE_DISPLAY_MAX_AGE_SEC
#                               (EI-18738872670541790) seconds an auto-picked
#                                candidate display's Xvfb may run with NO owning
#                                papercusp-desktop/hono-host process before the
#                                picker reclaims it instead of just skipping past
#                                it forever (default 3600 — comfortably longer than
#                                any single run; a --boot-only session already
#                                promises not to sit unattended past that). Set to
#                                a huge value to disable reclaiming and only skip,
#                                as before.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="${PAPERCUSP_REPO_DIR:-$(cd "$SCRIPT_DIR/.." && pwd)}"
DESKTOP_DIR="$REPO_DIR/papercusp-desktop"
# shellcheck source=papercusp-desktop/bin/lib/federation-asserts.sh
source "$DESKTOP_DIR/bin/lib/federation-asserts.sh"   # reuse fed_pick_free_port

[ -d "$DESKTOP_DIR" ] || { echo "FATAL: $DESKTOP_DIR not found — set PAPERCUSP_REPO_DIR" >&2; exit 1; }

TIMEOUT="${VERIFY_TAURI_TIMEOUT:-180}"
# EI-11641: pin the isolated verify sidecar's memory-watchdog high-water mark. The
# sidecar boots the full operator (substrate + the DBOS routines tick that
# dev-operator-ifneeded.sh enables), so its FRESH-boot RSS is background-primary-
# sized (~3.3 GB observed). But it launches PAPERCUSP_BACKGROUND_WORKERS=0, so
# resolveMemoryWatchdogLimitMb() (memory-watchdog.ts) mis-sizes it to the 3200 MiB
# REQUEST-worker limit — below its own boot RSS. The watchdog then recycles the
# sidecar every ~60 s in a perpetual loop; the webview's backend churns and the
# tauri-agent-tools bridge wedges (every eval times out), making live UI
# verification impossible on a loaded box. This instance is short-lived, single-
# purpose and torn down after the run, so give it the background-primary limit
# (its real footprint) — a genuine runaway still recycles, a normal boot never does.
MEMORY_LIMIT_MB="${VERIFY_TAURI_MEMORY_LIMIT_MB:-12288}"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/verify-tauri-headless.XXXXXX")"
LOG="$WORK/tauri.log"

log() { printf '\n[verify-tauri-headless] %s\n' "$*" >&2; }

# EI-18738872670541790: find a live process (by pgrep pattern) whose OWN
# /proc/<pid>/environ carries an EXACT `DISPLAY=<want>` — the same env-matching
# technique this script already uses to disambiguate BRIDGE_PID/SIDECAR_PID
# (below), generalized to a single-purpose helper for the stale-display reaper.
# Prints the first matching pid (there should be at most one live owner per
# display) and returns 1 when none is found. Never fatal — a /proc race (a pid
# exiting mid-scan) is just skipped.
find_pid_by_display_env() {
  local pattern="$1" want_display="$2" p env_p
  for p in $(pgrep -f "$pattern" 2>/dev/null); do
    env_p="$(tr '\0' '\n' < "/proc/$p/environ" 2>/dev/null)" || continue
    if grep -qxF "DISPLAY=$want_display" <<<"$env_p"; then
      echo "$p"
      return 0
    fi
  done
  return 1
}

# True (0) when a live papercusp-desktop app or bin/hono-host.ts sidecar is
# ACTUALLY attached to display number "$1" right now — i.e. genuinely in use.
# Deliberately does NOT count openbox: openbox is started unconditionally the
# instant Xvfb comes up (line ~330 below), before the app boots, so a display
# whose app crashed/never-booted but whose openbox+Xvfb are still alive would
# otherwise read as "owned" forever — exactly the leak this exists to catch.
display_has_owning_app() {
  local want=":$1"
  find_pid_by_display_env "debug/papercusp-desktop" "$want" >/dev/null 2>&1 && return 0
  find_pid_by_display_env "bin/hono-host.ts" "$want" >/dev/null 2>&1 && return 0
  return 1
}

# Reclaims display "$1" ONLY when BOTH hold: (a) a live Xvfb genuinely owns it
# (a stale leftover SOCKET with no live Xvfb is the pre-existing, already-safe
# "just skip past it" case below — nothing to reap there) and (b) it has no
# owning app (display_has_owning_app) AND its Xvfb has been up longer than
# $STALE_DISPLAY_MAX_AGE. This is a SHARED box — a wrong kill destroys a peer's
# in-flight work — so both signals must agree before anything is touched; a
# young display with no app yet (an app still mid-boot) fails the age gate and
# is correctly left alone. Kills by EXACT pid discovered via DISPLAY-matching
# (never a broad pattern-kill) and cleans the socket so the picker can reuse
# the number immediately. Best-effort: any failure just leaves the picker
# skipping past the display exactly as it always did.
# EI-18816386093046558: the header above calls a stale SOCKET with no live Xvfb
# "already-safe — nothing to reap there". Safe, yes; free, no. The picker skips
# past such a socket FOREVER, and PORT_BASE is DERIVED from the display number it
# finally lands on — so every leaked socket permanently pushes the port range
# upward. 97 sockets had accumulated here (93 of them orphaned, oldest 07-13),
# walking the picker to :173 -> base 34530; surviving X450 sockets show a past
# walk to :450 -> 37300, well inside other services' ports. So the orphan IS
# worth reclaiming — that is what keeps the port range anchored at its floor.
#
# LIVENESS PREDICATE: a bound X server always holds its socket in the kernel's
# listening set, so `ss -xl` answers "is anything actually serving this path?"
# definitively, for ALL sockets, in ONE ~14ms call. Per-socket xdpyinfo/fuser
# probes were MEASURED at >2 minutes across this many sockets (and xdpyinfo can
# hang outright on a stale path) — far too slow for a boot path. Snapshot once.
X_LISTENING_SNAPSHOT=""
x_socket_has_listener() {
  [ -n "$X_LISTENING_SNAPSHOT" ] || X_LISTENING_SNAPSHOT="$(ss -xlH 2>/dev/null | grep -o '/tmp/\.X11-unix/X[0-9]*' | sort -u)"
  grep -qxF "/tmp/.X11-unix/X$1" <<<"$X_LISTENING_SNAPSHOT"
}
# Reclaims an ORPHANED socket file: no Xvfb process, nothing listening, and older
# than the age gate — the age gate is what protects an Xvfb that has created its
# socket but not yet bound it (that one is seconds old). Verified on this box:
# all 4 live displays, including the owner's real :1, were correctly protected
# while 93 orphans were correctly identified. /tmp/.X11-unix is sticky, so this
# can only ever unlink THIS user's own files, and nothing is ever KILLED here.
reap_orphaned_x_socket() {
  local n="$1" sock="/tmp/.X11-unix/X$1"
  [ "${VERIFY_TAURI_REAP_ORPHAN_SOCKETS:-1}" = "1" ] || return 1
  [ -S "$sock" ] || return 1
  x_socket_has_listener "$n" && return 1
  find "$sock" -maxdepth 0 -mmin "+$((STALE_DISPLAY_MAX_AGE / 60))" 2>/dev/null | grep -q . || return 1
  rm -f "$sock" 2>/dev/null || return 1
  log "reclaimed orphaned X socket :$n — no Xvfb process, nothing listening (EI-18816386093046558)"
  return 0
}
reap_stale_display_if_abandoned() {
  local n="$1" xvfb_pid ob_pid age
  xvfb_pid="$(pgrep -f "Xvfb :$n " 2>/dev/null | head -1)"
  # No Xvfb at all ⇒ the orphaned-socket case, which is reclaimable on its own
  # terms (above) rather than something to walk past.
  [ -n "$xvfb_pid" ] || { reap_orphaned_x_socket "$n"; return $?; }
  display_has_owning_app "$n" && return 1
  age="$(ps -o etimes= -p "$xvfb_pid" 2>/dev/null | tr -d '[:space:]')"
  case "$age" in ''|*[!0-9]*) return 1 ;; esac
  [ "$age" -ge "$STALE_DISPLAY_MAX_AGE" ] || return 1
  log "reclaiming abandoned display :$n — Xvfb pid=$xvfb_pid up ${age}s with no owning app (EI-18738872670541790)"
  ob_pid="$(find_pid_by_display_env openbox ":$n" 2>/dev/null || true)"
  [ -n "$ob_pid" ] && kill -9 "$ob_pid" 2>/dev/null
  kill -9 "$xvfb_pid" 2>/dev/null
  rm -f "/tmp/.X11-unix/X$n" 2>/dev/null
  return 0
}

# ── pick a free display + port pair (never the owner's real :0/:1 seat) ─────
# A display counts as "taken" if EITHER a live X server answers there OR a
# unix-socket file for it still exists under /tmp/.X11-unix — the latter case
# is a STALE socket left by a Xvfb that died without cleanup (a leaked-Xvfb
# lesson, WI-2115) rather than a live server, so xdpyinfo alone reports it as
# "free" and Xvfb then fails to bind ("Cannot establish any listening
# sockets") when this picker hands out that number. Checking the socket file
# too makes the picker skip past the stale entry instead of colliding with it
# — no attempt to clean up someone else's leaked socket, just don't reuse it.
#
# EI-18738872670541790: a LIVE-but-abandoned Xvfb (the owning run died without
# reaching its teardown trap, or a --boot-only caller never ran the printed
# stop script) is a DIFFERENT case from the stale-socket one above — the
# server never dies, so it was never reclaimed, permanently narrowing this
# picker's pool. reap_stale_display_if_abandoned attempts to reclaim it
# (conservatively — see its own comment); on success we stop skipping and use
# this display number, instead of walking past it forever.
STALE_DISPLAY_MAX_AGE="${VERIFY_TAURI_STALE_DISPLAY_MAX_AGE_SEC:-3600}"
DISPLAY_NUM="${VERIFY_TAURI_DISPLAY_NUM:-}"
if [ -z "$DISPLAY_NUM" ]; then
  DISPLAY_NUM=90
  while DISPLAY=":$DISPLAY_NUM" xdpyinfo >/dev/null 2>&1 || [ -S "/tmp/.X11-unix/X$DISPLAY_NUM" ]; do
    reap_stale_display_if_abandoned "$DISPLAY_NUM" && break
    DISPLAY_NUM=$((DISPLAY_NUM + 1))
  done
fi
[ "$DISPLAY_NUM" -ge 2 ] || { echo "FATAL: refusing display :$DISPLAY_NUM — too close to a real seat" >&2; exit 1; }

# Ports are DERIVED FROM THE DISPLAY, not picked independently (WI-4342).
# fed_pick_free_port only proves a port is free RIGHT NOW, but our sidecar binds
# it minutes later (cargo/tauri boot). The advisory lock closes the same-host
# ss-probe → bind gap between concurrent verifier launchers; flock releases it
# automatically if a launcher dies. The DISPLAY-derived range still keeps
# normal concurrent runs disjoint, while the lock covers the forced-display /
# same-range case. fed_pick_free_port remains the second line of defence for a
# non-verifier process already squatting on a candidate port.
#
# EI-18816386093046558: BOUND the derived range. The display-derived offset exists
# only to SPREAD concurrent runs onto disjoint ports — actual correctness comes
# from fed_pick_free_port plus the flock walk-forward loop below, so aliasing two
# runs onto one base is already handled (the loop walks forward). Left unbounded,
# a drifting display number walked the base into other services' ports (:450 ->
# 37300). Wrapping into a fixed 60-slot window preserves the spread while capping
# the range at [33700, 34300) no matter how far the display number has drifted.
PORT_SLOT=$(( (DISPLAY_NUM - 90) % 60 ))
[ "$PORT_SLOT" -ge 0 ] || PORT_SLOT=$(( PORT_SLOT + 60 ))   # bash % keeps the sign: a forced DISPLAY_NUM < 90 must not go negative
PORT_BASE=$(( 33700 + PORT_SLOT * 10 ))
[ "$PORT_BASE" -ge 33700 ] || PORT_BASE=33700   # a caller-forced low DISPLAY_NUM must not underflow into real ports
PORT_LOCK_DIR="${VERIFY_TAURI_PORT_LOCK_DIR:-${TMPDIR:-/tmp}/papercusp-tauri-port-locks}"
PORT_LOCK_ATTEMPTS=0
while :; do
  DEV_PORT="$(fed_pick_free_port "$PORT_BASE")"
  PTY_PORT="$(fed_pick_free_port $((DEV_PORT + 4)))"
  if [ "$DEV_PORT" != "$PTY_PORT" ] \
    && fed_acquire_port_lock "$DEV_PORT" "$PORT_LOCK_DIR" \
    && fed_acquire_port_lock "$PTY_PORT" "$PORT_LOCK_DIR"; then
    break
  fi
  fed_release_port_locks
  PORT_BASE=$((DEV_PORT + 1))
  PORT_LOCK_ATTEMPTS=$((PORT_LOCK_ATTEMPTS + 1))
  [ "$PORT_LOCK_ATTEMPTS" -lt 100 ] || {
    echo "FATAL: could not reserve a verifier port pair after $PORT_LOCK_ATTEMPTS attempts" >&2
    exit 1
  }
done

log "display=:$DISPLAY_NUM devPort=$DEV_PORT ptyPort=$PTY_PORT work=$WORK"

# ── teardown (always runs; scoped to exactly what THIS invocation started) ──
XVFB_PID="" OPENBOX_PID="" TAURI_PID="" PORT_LOCK_KEEPER_PID="" ISOLATED_PG_PID=""
write_freshness_check_script() {
  # EI-17134: the frozen SPA snapshot (below, EI-10364) is copied ONCE at boot and
  # never re-reads the shared dist — by design, so the fleet's `vite build --watch`
  # can't yank chunks out from under a live run. But that design has NO signal for
  # the agent: if you edit apps/operator-vite source (or its shared dist) AFTER
  # booting a --boot-only instance and then reload/re-check against it, you silently
  # keep exercising the pre-edit bundle forever — no log line, no warning, nothing
  # distinguishes "my edit isn't live yet" from "my edit is broken". Cost 30+ min of
  # false-negative debugging once already (EI-13224). This script is that missing
  # signal: run it any time after boot to detect drift before trusting a re-check.
  cat > "$WORK/check-freshness.sh" <<FRESH
#!/usr/bin/env bash
# Usage: bash "\$VERIFY_TAURI_FRESHNESS_CHECK"  — run BEFORE re-verifying an edit
# against an already-booted instance. Exits 1 (and warns loudly on stderr) if the
# shared apps/operator-vite/dist has changed since this instance's SPA snapshot was
# frozen; exits 0 (silent) if nothing changed since boot.
SPA_DIST="$SPA_DIST"
SHARED_SPA_DIST="$SHARED_SPA_DIST"
if [ -z "\$SPA_DIST" ] || [ ! -f "\$SPA_DIST/.frozen-at" ]; then
  exit 0  # no snapshot was frozen this run (operator-vite wasn't built at boot) — nothing to check
fi
CHANGED="\$(find "\$SHARED_SPA_DIST" -newer "\$SPA_DIST/.frozen-at" -type f 2>/dev/null | head -5)"
if [ -n "\$CHANGED" ]; then
  {
    echo
    echo "  ┌────────────────────────────────────────────────────────────────────────┐"
    echo "  │  ⚠️  STALE FROZEN SPA SNAPSHOT (EI-17134 / EI-10364)                    │"
    echo "  │                                                                        │"
    echo "  │  \$SHARED_SPA_DIST has changed SINCE this instance's SPA snapshot was"
    echo "  │  frozen at boot. This instance is IMMUTABLE — it is still serving the"
    echo "  │  pre-edit bundle from \$SPA_DIST and will NEVER pick up the change,"
    echo "  │  no matter how many times you reload. Restart the instance to verify"
    echo "  │  a new edit (VERIFY_TAURI_STOP then re-run verify-tauri-headless.sh)."
    echo "  │                                                                        │"
    echo "  │  Changed since freeze (up to 5 shown):"
    printf '%s\n' "\$CHANGED" | sed 's/^/  │    /'
    echo "  └────────────────────────────────────────────────────────────────────────┘"
    echo
  } >&2
  exit 1
fi
exit 0
FRESH
  chmod +x "$WORK/check-freshness.sh"
}
write_stop_script() {
  cat > "$WORK/stop.sh" <<STOP
#!/usr/bin/env bash
# EI-11559: do NOT force-kill the port-lock keeper here — killing it releases the
# advisory flock IMMEDIATELY, while the sidecar (its own process group) still holds
# the display-derived port. Instead we tear down the display/app and let the keeper
# SELF-terminate once Xvfb is gone AND the port is free (it holds the lock through
# that drain), so a next run reusing this display can't collide with a straggler.
[ -n "$TAURI_PID" ] && { kill -TERM -- -$TAURI_PID 2>/dev/null; sleep 1; kill -9 -- -$TAURI_PID 2>/dev/null; }
[ -n "$OPENBOX_PID" ] && kill -9 $OPENBOX_PID 2>/dev/null
# EI-18816386093046558: SIGKILL gives Xvfb no chance to unlink /tmp/.X11-unix/X<N>,
# so EVERY run leaked its own socket (97 had accumulated, the oldest from 07-13).
# That leak is not cosmetic: the picker above treats a leaked socket as "display
# taken" (WI-2115, correctly) and walks past it, and PORT_BASE is DERIVED from the
# display number — so each leak permanently pushed the port range upward. It had
# reached :173 -> base 34530, and surviving X450 sockets show a past walk to :450
# -> 37300, well inside other services' ports. SIGTERM first so Xvfb unlinks after
# itself; SIGKILL only as the fallback; then remove OUR OWN socket unconditionally
# (we started this server, so this file is unambiguously ours to clean up).
[ -n "$XVFB_PID" ] && { kill -TERM $XVFB_PID 2>/dev/null; for _ in 1 2 3 4 5 6 7 8 9 10; do kill -0 $XVFB_PID 2>/dev/null || break; sleep 0.2; done; kill -9 $XVFB_PID 2>/dev/null; }
pkill -9 -f "Xvfb :$DISPLAY_NUM " 2>/dev/null
rm -f "/tmp/.X11-unix/X$DISPLAY_NUM" 2>/dev/null
# EI-10387: stop our throwaway isolated-DB postgres (if VERIFY_TAURI_ISOLATED_DB
# booted one) — SIGTERM lets it shut the postmaster down cleanly before we reap.
[ -n "$ISOLATED_PG_PID" ] && { kill -TERM "$ISOLATED_PG_PID" 2>/dev/null; sleep 1; kill -9 "$ISOLATED_PG_PID" 2>/dev/null; }
echo "stopped (display :$DISPLAY_NUM, port $DEV_PORT)"
STOP
  chmod +x "$WORK/stop.sh"
}
# ── EI-11559: hold the advisory port lock until our sidecar releases the port ──
# Ports are DERIVED FROM THE DISPLAY (WI-4342), so a freed-then-reused display maps
# to the SAME derived port base. Our operator sidecar (dev-operator-ifneeded.sh)
# runs in its OWN process group behind a detached reaper + a restart-on-nonzero
# supervision loop, so it can keep DEV_PORT/PTY_PORT bound for seconds after we
# signal $TAURI_PID's group — "the squatter that only exists during someone's
# boot/teardown window". If we release the advisory lock the instant we signal, the
# NEXT run reusing this freed display derives the same port, sees it free at
# pick-time, acquires the now-free lock, and collides at BIND-time (~100s later,
# EADDRINUSE — the reporter's exact failure). So HOLD the lock until OUR ports are
# actually free: the still-held flock forces a concurrent run onto a disjoint port
# via the existing pick-time walk-forward loop (fed_acquire_port_lock fails → the
# loop walks PORT_BASE forward). The wait is passive — the sidecar's own reaper
# (dev-operator-ifneeded.sh's wrapper-trap + detached watchdog) does the killing —
# and bounded, so a genuinely wedged port only delays teardown, never deadlocks it.
PORT_STRAGGLER_WAIT="${VERIFY_TAURI_PORT_STRAGGLER_WAIT:-30}"
port_is_listening() { ss -tlnH "sport = :$1" 2>/dev/null | grep -q .; }
wait_owned_ports_free() {
  local port waited
  for port in "$DEV_PORT" "$PTY_PORT"; do
    [ -n "$port" ] || continue
    waited=0
    while port_is_listening "$port" && [ "$waited" -lt "$PORT_STRAGGLER_WAIT" ]; do
      sleep 1; waited=$((waited + 1))
    done
    port_is_listening "$port" && log "WARNING: :$port still held after ${PORT_STRAGGLER_WAIT}s at teardown — releasing the advisory lock anyway; a display-reusing run may collide (EI-11559)."
  done
}
teardown() {
  local ec=$?
  log "tearing down (exit=$ec)"
  write_stop_script
  "$WORK/stop.sh" >/dev/null 2>&1 || true
  wait_owned_ports_free   # EI-11559: hold the advisory lock until our sidecar releases the port
  fed_release_port_locks
  # EI-10387: the isolated-DB datadir can be sizeable (a full migrated cluster) —
  # remove it now rather than leaking it into $TMPDIR across repeated runs. Best
  # effort: stop.sh above already SIGTERM'd the postmaster.
  [ -n "$ISOLATED_PG_PID" ] && [ -n "${ISOLATED_PG_DATA_DIR:-}" ] && rm -rf "$ISOLATED_PG_DATA_DIR" 2>/dev/null
  exit "$ec"
}

# ── boot Xvfb (isolated, headless — never DISPLAY :0/:1) ────────────────────
# --boot-only returns control to its caller, so every long-lived process must
# live outside the launcher's terminal session. Without setsid, closing a PTY
# kills Xvfb; WebKit then exits with XIO and the "ready" desktop disappears
# before the caller's first tauri-agent-tools command (WI-4975).
setsid Xvfb ":$DISPLAY_NUM" -screen 0 1920x1080x24 -nolisten tcp >"$WORK/xvfb.log" 2>&1 &
XVFB_PID=$!
trap teardown EXIT INT TERM
sleep 1
DISPLAY=":$DISPLAY_NUM" xdpyinfo >/dev/null 2>&1 || { echo "FATAL: Xvfb :$DISPLAY_NUM never came up — see $WORK/xvfb.log" >&2; exit 1; }
setsid env DISPLAY=":$DISPLAY_NUM" openbox >"$WORK/openbox.log" 2>&1 &
OPENBOX_PID=$!

# ── real-GPU GL check (agent-e2e.mdx §15.4: bare Xvfb has no GL → WebKitGTK
# never paints → every screenshot is blank white regardless of DOM content).
# Non-fatal: DOM/eval assertions via the bridge work fine GL-less; only pixel
# checks (screenshot/OCR) need this. ──────────────────────────────────────
LAUNCH_PREFIX=()
if [ "${VERIFY_TAURI_SKIP_GL_CHECK:-0}" != "1" ] && command -v vglrun >/dev/null 2>&1; then
  GL_RENDERER="$(DISPLAY=":$DISPLAY_NUM" vglrun -d egl0 glxinfo 2>/dev/null | grep -i 'OpenGL renderer' || true)"
  case "$GL_RENDERER" in
    *llvmpipe*|*swrast*|"")
      log "WARNING: no real GPU GL detected ($GL_RENDERER) — screenshots will be blank white (agent-e2e.mdx §15.4). DOM/eval via the bridge still work." ;;
    *) log "GPU GL confirmed: $GL_RENDERER"; LAUNCH_PREFIX=(vglrun -d egl0) ;;
  esac
else
  log "WARNING: vglrun unavailable or skipped — screenshots will be blank white (agent-e2e.mdx §15.4). DOM/eval via the bridge still work."
fi

# ── freeze the SPA bundle into a PRIVATE dir so this instance owns its module
#    server too (EI-10364) ────────────────────────────────────────────────────
# The isolated sidecar (below) serves the SPA from PAPERCUSP_SPA_DIST if it is
# set (apps/operator/bin/host-spa.ts resolveSpaDistRoot). WITHOUT it the sidecar
# falls through to the SHARED apps/operator-vite/dist/ — the SAME bundle the
# fleet's `vite build --watch` continuously rewrites AND empties. That makes the
# "isolated" claim FALSE at the SPA layer: the shared watcher yanks this webview's
# lazy chunks out from under it mid-run ("Importing a module script failed",
# EI-10360) and flip-flops it between stale and fresh modules, so a verification
# run is a coin-flip and can even report a broken thing as fixed. Freezing a
# snapshot the shared watcher can't touch makes THIS instance's module graph
# stable AND genuinely isolated for the whole run.
SHARED_SPA_DIST="$REPO_DIR/apps/operator-vite/dist"
SPA_DIST=""
if [ -f "$SHARED_SPA_DIST/index.html" ]; then
  SPA_DIST="$WORK/spa"
  mkdir -p "$SPA_DIST"
  # Copy the whole tree, then re-copy index.html LAST so the frozen index matches
  # the chunks we captured. The shared build retains old hashed chunks
  # (emptyOutDir:false — operator-vite/vite.config.ts), so a rebuild racing this
  # copy still leaves our index's chunks present in the snapshot.
  cp -a "$SHARED_SPA_DIST/." "$SPA_DIST/" 2>/dev/null || true
  cp -a "$SHARED_SPA_DIST/index.html" "$SPA_DIST/index.html" 2>/dev/null || true
  # EI-17134: stamp the freeze moment AFTER the copy completes, so any later edit
  # to $SHARED_SPA_DIST (a source change, or a rebuild) has a strictly newer mtime.
  # write_freshness_check_script's generated helper diffs against this marker —
  # it is the ONLY signal that an already-booted instance is now serving a stale
  # bundle (this script never re-reads $SHARED_SPA_DIST after this point).
  date +%s > "$SPA_DIST/.frozen-at" 2>/dev/null || true
  # Best-effort freshness read from the vite-watch heartbeat (EI-5202) so the
  # caller can see WHICH build this snapshot froze — a snapshot is immutable, so
  # picking up a newer edit means restarting the instance, not reloading.
  SPA_HB="${VITE_WATCH_HEARTBEAT:-${VITE_WATCH_LOCK:-/tmp/papercup-operator-vite-watch.lock}.heartbeat}"
  SPA_SHA=""
  [ -f "$SPA_HB" ] && SPA_SHA="$(sed -n 's/.*"gitSha": *"\([0-9a-f]*\)".*/\1/p' "$SPA_HB" 2>/dev/null | head -1)"
  log "SPA snapshot frozen at $SPA_DIST${SPA_SHA:+ (shared build ${SPA_SHA:0:12})} — IMMUTABLE for this run; restart to pick up a newer build."
  log "  → edited source AFTER this boot? run: bash \"$WORK/check-freshness.sh\" (\$VERIFY_TAURI_FRESHNESS_CHECK) BEFORE trusting a re-check — it warns loudly if the shared bundle drifted (EI-17134)."
else
  log "WARNING: no built SPA at $SHARED_SPA_DIST (operator-vite not built yet) — NOT freezing a"
  log "         snapshot; the sidecar falls through to the shared dist as before. Build"
  log "         operator-vite first for a genuinely isolated (watcher-proof) module server."
fi
# EI-17134: write the freshness-check helper unconditionally (a no-op when no
# snapshot was frozen — SPA_DIST is empty) so $VERIFY_TAURI_FRESHNESS_CHECK is
# always a valid, runnable path for the caller, in both branches above.
write_freshness_check_script

# ── EI-10387: boot a genuinely isolated, throwaway embedded Postgres ────────
# Opt-in (VERIFY_TAURI_ISOLATED_DB=1). Reuses the SAME primitive
# scripts/with-test-pg.mjs uses for hermetic test runs
# (startEmbeddedPostgresServer from @papercusp/embedded-postgres-server): a
# fresh datadir, a free port nobody else picked, fully migrated. We then point
# the sidecar at it via HARNESS_ADMIN_DATABASE_URL / HARNESS_DATABASE_URL —
# these beat DATABASE_URL in both resolvers (libs/db/src/connection.ts adminUrl/
# appUrl AND @papercusp/embedded-pg-discovery's getHarnessAdminUrl chain), so
# they win over apps/operator/.env.local's unconditional
# `DATABASE_URL=...5432/papercusp` (the live DB) even though DEFAULT_DEV_CMD
# sources that file — .env.local never sets HARNESS_ADMIN_DATABASE_URL /
# HARNESS_DATABASE_URL, so sourcing it can't clobber ours. PAPERCUSP_HOME is
# also scoped here so the sidecar's own operator.json/embedded-pg.json/
# superuser-token/lock files land under $WORK, never the real ~/.papercusp
# (the box-canonical-discovery-hijack class of incident documented in
# apps/operator/bin/serve.ts's EI-13917 note).
ISOLATED_DB="${VERIFY_TAURI_ISOLATED_DB:-0}"
ISOLATED_ENV_LINE=""
ISOLATED_HOME=""
if [ "$ISOLATED_DB" = "1" ]; then
  ISOLATED_PG_TIMEOUT="${VERIFY_TAURI_ISOLATED_PG_TIMEOUT:-90}"
  ISOLATED_PG_DATA_DIR="$WORK/isolated-pgdata"
  ISOLATED_PG_LOG="$WORK/isolated-pg.log"
  ISOLATED_HOME="$WORK/papercusp-home"
  ISOLATED_WORKSPACE="verify-tauri-isolated-$DISPLAY_NUM"
  mkdir -p "$ISOLATED_HOME"

  # Migrations dir: monorepo path, else a packaged sidecar's own copy — same
  # resolution with-test-pg.mjs uses.
  ISOLATED_PG_SQL_DIR=""
  for cand in "$REPO_DIR/libs/papercusp/libs/db/sql" "$REPO_DIR/sidecar/db-sql"; do
    [ -d "$cand" ] && { ISOLATED_PG_SQL_DIR="$cand"; break; }
  done
  [ -n "$ISOLATED_PG_SQL_DIR" ] || { echo "FATAL: VERIFY_TAURI_ISOLATED_DB=1 but no migrations dir found (looked under $REPO_DIR)" >&2; exit 1; }

  ISOLATED_PG_BOOT_SCRIPT="$WORK/boot-isolated-pg.mjs"
  # Quoted heredoc (no bash expansion inside) — every input crosses via env,
  # never string-interpolated into the JS.
  cat > "$ISOLATED_PG_BOOT_SCRIPT" <<'PGBOOT'
import { createServer } from 'node:net';
import { pathToFileURL } from 'node:url';

const repoDir = process.env.ISOLATED_PG_REPO_DIR;
const dataDir = process.env.ISOLATED_PG_DATA_DIR;
const sqlDir = process.env.ISOLATED_PG_SQL_DIR;
if (!repoDir || !dataDir || !sqlDir) {
  console.error('PG_FAILED missing ISOLATED_PG_{REPO_DIR,DATA_DIR,SQL_DIR} env');
  process.exit(2);
}

function freePort() {
  return new Promise((res, rej) => {
    const srv = createServer();
    srv.on('error', rej);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => res(port));
    });
  });
}

const modUrl = pathToFileURL(
  `${repoDir}/libs/papercusp/packages/embedded-postgres-server/src/index.js`,
).href;
const { startEmbeddedPostgresServer } = await import(modUrl);

let pg = null;
async function shutdown() {
  try {
    await pg?.stop();
  } catch {
    /* best effort */
  }
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

try {
  const port = await freePort();
  pg = await startEmbeddedPostgresServer({ dataDir, port, dbSqlDir: sqlDir, onLog: () => {} });
  // Deliberately NOT flushed through `log()` — one grep-able line for the shell.
  console.log(`PG_READY port=${port} admin=${pg.urls.admin} app=${pg.urls.app}`);
} catch (e) {
  console.error(`PG_FAILED ${e?.stack ?? e}`);
  process.exit(1);
}

// Hold the postmaster up until the shell teardown SIGTERMs us.
await new Promise(() => {});
PGBOOT

  log "VERIFY_TAURI_ISOLATED_DB=1 — booting a throwaway migrated Postgres (data=$ISOLATED_PG_DATA_DIR)"
  setsid env \
    ISOLATED_PG_REPO_DIR="$REPO_DIR" \
    ISOLATED_PG_DATA_DIR="$ISOLATED_PG_DATA_DIR" \
    ISOLATED_PG_SQL_DIR="$ISOLATED_PG_SQL_DIR" \
    node "$ISOLATED_PG_BOOT_SCRIPT" >"$ISOLATED_PG_LOG" 2>&1 &
  ISOLATED_PG_PID=$!
  # No need to re-arm the EXIT/INT/TERM trap here: it was already set at line
  # ~277 (right after Xvfb boot), and bash traps re-read every var (including
  # ISOLATED_PG_PID) at FIRE time, not at trap-registration time.

  ISOLATED_PG_ELAPSED=0
  until grep -q '^PG_READY ' "$ISOLATED_PG_LOG" 2>/dev/null; do
    kill -0 "$ISOLATED_PG_PID" 2>/dev/null || { echo "FATAL: isolated-db postgres exited before ready — tail:" >&2; tail -40 "$ISOLATED_PG_LOG" >&2; exit 1; }
    [ "$ISOLATED_PG_ELAPSED" -ge "$ISOLATED_PG_TIMEOUT" ] && { echo "FATAL: isolated-db postgres did not come up within ${ISOLATED_PG_TIMEOUT}s — tail:" >&2; tail -40 "$ISOLATED_PG_LOG" >&2; exit 1; }
    sleep 1; ISOLATED_PG_ELAPSED=$((ISOLATED_PG_ELAPSED + 1))
  done
  ISOLATED_PG_READY_LINE="$(grep '^PG_READY ' "$ISOLATED_PG_LOG" | head -1)"
  ISOLATED_PG_PORT="$(sed -n 's/^PG_READY port=\([0-9]*\).*/\1/p' <<<"$ISOLATED_PG_READY_LINE")"
  ISOLATED_ADMIN_URL="$(sed -n 's/.*admin=\(postgresql:\/\/[^ ]*\).*/\1/p' <<<"$ISOLATED_PG_READY_LINE")"
  ISOLATED_APP_URL="$(sed -n 's/.*app=\(postgresql:\/\/[^ ]*\).*/\1/p' <<<"$ISOLATED_PG_READY_LINE")"
  [ -n "$ISOLATED_PG_PORT" ] && [ -n "$ISOLATED_ADMIN_URL" ] || { echo "FATAL: could not parse isolated-db readiness line: $ISOLATED_PG_READY_LINE" >&2; exit 1; }

  # Recurrence guard (EI-10387's own point 4): the isolated port must actually
  # differ from whatever the box-canonical embedded-pg.json currently advertises
  # — belt-and-braces against a freak port collision before we ever trust it.
  LIVE_PG_JSON="$HOME/.papercusp/embedded-pg.json"
  if [ -f "$LIVE_PG_JSON" ]; then
    LIVE_PG_PORT="$(sed -n 's/.*"port":[ ]*\([0-9]*\).*/\1/p' "$LIVE_PG_JSON" | head -1)"
    [ -n "$LIVE_PG_PORT" ] && [ "$LIVE_PG_PORT" = "$ISOLATED_PG_PORT" ] && {
      echo "FATAL: isolated PG picked the SAME port ($ISOLATED_PG_PORT) as the live box-canonical embedded-pg.json — refusing to proceed (EI-10387 recurrence guard)." >&2
      exit 1
    }
  fi

  log "isolated-db postgres ready on :$ISOLATED_PG_PORT (data=$ISOLATED_PG_DATA_DIR) after ${ISOLATED_PG_ELAPSED}s"
  ISOLATED_ENV_LINE="PAPERCUSP_HOME=\"$ISOLATED_HOME\" PAPERCUSP_WORKSPACE=\"$ISOLATED_WORKSPACE\" HARNESS_ADMIN_DATABASE_URL=\"$ISOLATED_ADMIN_URL\" HARNESS_DATABASE_URL=\"$ISOLATED_APP_URL\" PAPERCUSP_PG_PORT=\"$ISOLATED_PG_PORT\" PAPERCUSP_SKIP_PG_DISCOVERY=1"
fi

# ── launch the isolated dev instance (agent-e2e.mdx §1.3 recipe, packaged) ──
# setsid makes this its own process group so teardown can `kill -- -$PID`
# the WHOLE tree (cargo, node, the built binary, webkit helper processes) —
# a bare `kill $PID` regularly leaves the actual webview process orphaned.
# Build the SPA-pin env assignment in a var so the quotes survive into the
# generated launch.sh (a plain `$VAR` heredoc expansion keeps them; a bare
# WORK dir has no spaces, but keep it correct anyway) and the whole line
# disappears when no snapshot was frozen.
SPA_ENV_LINE=""
[ -n "$SPA_DIST" ] && SPA_ENV_LINE="PAPERCUSP_SPA_DIST=\"$SPA_DIST\""
cat > "$WORK/launch.sh" <<LAUNCH
#!/usr/bin/env bash
cd "$DESKTOP_DIR"
exec env -u WAYLAND_DISPLAY GDK_BACKEND=x11 DISPLAY=":$DISPLAY_NUM" \\
  OPERATOR_DEV_PORT="$DEV_PORT" OPERATOR_DEV_PTY_PORT="$PTY_PORT" \\
  PAPERCUSP_DEV_API_TARGET="$DEV_PORT" PAPERCUSP_NATIVE_TERMINAL=0 \\
  PAPERCUSP_MEMORY_WATCHDOG_LIMIT_MB=$MEMORY_LIMIT_MB \\
  $SPA_ENV_LINE \\
  $ISOLATED_ENV_LINE \\
  ${LAUNCH_PREFIX[*]} npm run tauri -- dev --config '{"build":{"devUrl":"http://127.0.0.1:$DEV_PORT"}}'
LAUNCH
chmod +x "$WORK/launch.sh"
setsid "$WORK/launch.sh" >"$LOG" 2>&1 &
TAURI_PID=$!

log "waiting up to ${TIMEOUT}s for the dev bridge (pid=$TAURI_PID, log=$LOG)"
ELAPSED=0
until grep -q "dev bridge listening" "$LOG" 2>/dev/null; do
  kill -0 "$TAURI_PID" 2>/dev/null || { echo "FATAL: tauri dev exited before the bridge came up — tail:" >&2; tail -40 "$LOG" >&2; exit 1; }
  [ "$ELAPSED" -ge "$TIMEOUT" ] && { echo "FATAL: bridge did not come up within ${TIMEOUT}s — tail:" >&2; tail -40 "$LOG" >&2; exit 1; }
  sleep 2; ELAPSED=$((ELAPSED + 2))
done
log "bridge is up after ${ELAPSED}s"

# Our OWN sidecar must own DEV_PORT. If it lost a race for it, the webview is
# pointed at SOMEONE ELSE's operator on that port and every assertion below is
# meaningless (WI-4342) — fail loudly instead of "verifying" a peer's tree.
if grep -qE "EADDRINUSE.*:$DEV_PORT\b" "$LOG" 2>/dev/null; then
  echo "FATAL: our operator sidecar could not bind :$DEV_PORT (EADDRINUSE) — another instance owns it," >&2
  echo "       so this webview is loading a PEER's operator, not our tree. Refusing to verify. Tail:" >&2
  grep -aE "EADDRINUSE|pty-ws" "$LOG" | head -5 >&2
  exit 1
fi

# EI-10387 recurrence guard: when isolation was requested, verify GROUND TRUTH —
# the REAL running sidecar's own /proc/<pid>/environ — not just that we set the
# env var somewhere upstream. This is the check that would have caught the
# original bug (the header's isolation claim was false; the intervening chain
# — .env.local, DEFAULT_DEV_CMD's own env layer — is exactly the kind of thing
# that silently re-breaks this). Fail loudly rather than "verifying" against the
# live DB under a false isolated banner.
if [ "$ISOLATED_DB" = "1" ]; then
  SIDECAR_PID=""
  for _ in $(seq 1 10); do
    SIDECAR_PID="$(pgrep -f "bin/hono-host.ts" 2>/dev/null | while read -r p; do
      env_p="$(tr '\0' '\n' < "/proc/$p/environ" 2>/dev/null)" || continue
      grep -q "^OPERATOR_DEV_PORT=$DEV_PORT\$" <<<"$env_p" && echo "$p"
    done | head -1)"
    [ -n "$SIDECAR_PID" ] && break
    sleep 1
  done
  [ -n "$SIDECAR_PID" ] || {
    echo "FATAL: VERIFY_TAURI_ISOLATED_DB=1 but no bin/hono-host.ts process carries OPERATOR_DEV_PORT=$DEV_PORT — cannot verify isolation took effect. Refusing to proceed under a false isolated banner." >&2
    exit 1
  }
  SIDECAR_ENVIRON="$(tr '\0' '\n' < "/proc/$SIDECAR_PID/environ" 2>/dev/null)"
  SIDECAR_ADMIN_URL="$(sed -n 's/^HARNESS_ADMIN_DATABASE_URL=//p' <<<"$SIDECAR_ENVIRON")"
  if [ "$SIDECAR_ADMIN_URL" != "$ISOLATED_ADMIN_URL" ]; then
    echo "FATAL: EI-10387 isolation check failed — the running sidecar's own HARNESS_ADMIN_DATABASE_URL" >&2
    echo "       does not match the isolated PG we booted (sidecar saw: '${SIDECAR_ADMIN_URL:-<unset>}'," >&2
    echo "       expected the isolated URL on :$ISOLATED_PG_PORT). Refusing to proceed — this would silently" >&2
    echo "       hand back a webview pointed at the LIVE database under a false isolated-DB banner." >&2
    exit 1
  fi
  log "EI-10387 isolation VERIFIED: sidecar pid=$SIDECAR_PID resolved HARNESS_ADMIN_DATABASE_URL to our isolated PG on :$ISOLATED_PG_PORT"
fi

# Resolve the ACTUAL webview process's pid (the setsid/tauri-dev wrapper pid is
# not always the bridge owner) by matching BOTH our unique DISPLAY and our
# OPERATOR_DEV_PORT against each candidate's real environ — agent-e2e.mdx §1.3's
# own "pass --pid to disambiguate when multiple bridges are running" made
# concrete. The DISPLAY is the load-bearing half: matching on the port ALONE
# resolved onto a PEER's older instance that happened to share it (WI-4342), so
# the script handed the caller another agent's shell to drive.
BRIDGE_PID=""
for _ in $(seq 1 10); do
  BRIDGE_PID="$(pgrep -f "debug/papercusp-desktop" 2>/dev/null | while read -r p; do
    env_p="$(tr '\0' '\n' < "/proc/$p/environ" 2>/dev/null)" || continue
    grep -q "^DISPLAY=:$DISPLAY_NUM\$" <<<"$env_p" || continue
    grep -q "^OPERATOR_DEV_PORT=$DEV_PORT\$" <<<"$env_p" && echo "$p"
  done | head -1)"
  [ -n "$BRIDGE_PID" ] && break
  sleep 1
done
# NEVER fall back to a pid we have not proven is ours: a wrong --pid drives a
# peer's shell. If our own webview can't be identified, that IS the failure.
[ -n "$BRIDGE_PID" ] || {
  echo "FATAL: no papercusp-desktop process carries our DISPLAY=:$DISPLAY_NUM + OPERATOR_DEV_PORT=$DEV_PORT." >&2
  echo "       Refusing to hand back an unverified pid (it could be a peer's instance — WI-4342). Tail:" >&2
  tail -20 "$LOG" >&2
  exit 1
}

export VERIFY_TAURI_PID="$BRIDGE_PID"
export VERIFY_TAURI_PORT="$DEV_PORT"
export VERIFY_TAURI_DISPLAY=":$DISPLAY_NUM"
export VERIFY_TAURI_LOG="$LOG"

# A route change can finish before its sync-backed data has reached the DOM.
# Fixed sleeps make those checks depend on machine/DB timing, so expose a
# bounded assertion helper for every run. Callers pass normal
# `tauri-agent-tools check` arguments; the helper pins our verified PID and
# retries until the assertion succeeds or the diagnostic timeout expires.
POLL="$WORK/poll-dom.sh"
cat > "$POLL" <<'POLL_SCRIPT'
#!/usr/bin/env bash
set -uo pipefail

timeout="${VERIFY_TAURI_DOM_TIMEOUT:-30}"
interval="${VERIFY_TAURI_DOM_POLL_INTERVAL:-1}"
case "$timeout" in
  ''|*[!0-9]*) echo "FATAL: VERIFY_TAURI_DOM_TIMEOUT must be a non-negative integer" >&2; exit 2 ;;
esac
[ "$#" -gt 0 ] || { echo "FATAL: pass tauri-agent-tools check arguments to VERIFY_TAURI_POLL" >&2; exit 2; }

deadline=$((SECONDS + timeout))
last_output=""
while :; do
  if last_output="$(tauri-agent-tools check --pid "$VERIFY_TAURI_PID" "$@" 2>&1)"; then
    [ -n "$last_output" ] && printf '%s\n' "$last_output"
    exit 0
  fi
  if [ "$SECONDS" -ge "$deadline" ]; then
    echo "FATAL: DOM assertion did not pass within ${timeout}s (pid=$VERIFY_TAURI_PID)" >&2
    [ -n "$last_output" ] && printf '%s\n' "$last_output" >&2
    exit 1
  fi
  sleep "$interval"
done
POLL_SCRIPT
chmod +x "$POLL"
export VERIFY_TAURI_POLL="$POLL"

# EI-13218: "dev bridge listening" + a live PID (checked above) only prove the
# Tauri BRIDGE is reachable — they say nothing about whether the webview's
# owned Hono+SPA origin is actually serving. Confirmed live: a bridge can stay
# reachable (probe succeeds, PID alive) while in-webview fetches of /api/health
# and / both fail, with the ALREADY-RENDERED DOM staying visible — a
# stale-capable false-positive that a DOM/selector-only assertion (the
# VERIFY_TAURI_POLL / `check` helper above) cannot catch, since it never
# re-fetches the origin. Assert the origin split BEFORE declaring ready, with a
# short retry: right after the bridge log line, the SPA's first health fetch
# may not have resolved yet.
HEALTH_TIMEOUT="${VERIFY_TAURI_HEALTH_TIMEOUT:-15}"
HEALTH_DEADLINE=$((SECONDS + HEALTH_TIMEOUT))
HEALTH_JSON=""
while :; do
  HEALTH_JSON="$(tauri-agent-tools eval --pid "$BRIDGE_PID" "
    Promise.all([
      fetch('/api/health').then(r => r.status).catch(e => 'ERR:' + e.message),
      fetch('/').then(r => r.status).catch(e => 'ERR:' + e.message)
    ]).then(v => JSON.stringify({ apiHealth: v[0], rootHtml: v[1] }))
  " 2>&1)" \
    && echo "$HEALTH_JSON" | grep -Eq '"apiHealth"[[:space:]]*:[[:space:]]*200' \
    && echo "$HEALTH_JSON" | grep -Eq '"rootHtml"[[:space:]]*:[[:space:]]*200' && break
  if [ "$SECONDS" -ge "$HEALTH_DEADLINE" ]; then
    echo "FATAL: owned origin unreachable from the webview after ${HEALTH_TIMEOUT}s (pid=$BRIDGE_PID)." >&2
    echo "       The bridge/PID is alive but /api/health and/or / did not return 200 — refusing to" >&2
    echo "       hand back a shell whose DOM may be a stale false-positive (EI-13218). Last result:" >&2
    echo "       ${HEALTH_JSON}" >&2
    exit 1
  fi
  sleep 1
done
log "origin health confirmed: apiHealth=200 rootHtml=200 (pid=$BRIDGE_PID)"

log "isolated instance ready: pid=$VERIFY_TAURI_PID port=$VERIFY_TAURI_PORT display=$VERIFY_TAURI_DISPLAY"

# EI-10387: the DB/workspace warning is now CONDITIONAL — VERIFY_TAURI_ISOLATED_DB=1
# genuinely isolates them (verified above against the sidecar's own /proc/<pid>/environ,
# not just asserted here), so print an affirming line instead of the scary banner.
if [ "$ISOLATED_DB" = "1" ]; then
  cat >&2 <<WARN

  ┌────────────────────────────────────────────────────────────────────────┐
  │  ✅  THIS INSTANCE HAS A GENUINELY ISOLATED DATABASE (EI-10387)         │
  │                                                                        │
  │  Isolated: X display · devUrl port · pty port · sidecar process · SPA  │
  │            module bundle · DATABASE (throwaway, on :$ISOLATED_PG_PORT) │
  │            · PAPERCUSP_HOME · PAPERCUSP_WORKSPACE                      │
  │                                                                        │
  │  ALL writes here are safe — they land in the throwaway DB and are      │
  │  discarded at teardown. The instance boots into the normal first-run   │
  │  onboarding flow (empty, freshly-migrated DB), not real pots/plans.    │
  └────────────────────────────────────────────────────────────────────────┘

WARN
else
  # ⚠️ display/ports/process are isolated — the DATABASE AND WORKSPACE ARE NOT.
  # Say so LOUDLY at boot: an agent that skipped the header must not learn this by
  # mutating the owner's live steering (and waking the real Mug) mid-"test".
  cat >&2 <<'WARN'

  ┌────────────────────────────────────────────────────────────────────────┐
  │  ⚠️  THIS INSTANCE SHARES THE **LIVE DATABASE AND WORKSPACE**          │
  │                                                                        │
  │  Isolated: X display · devUrl port · pty port · sidecar process · SPA  │
  │            module bundle (a frozen snapshot — EI-10364)                 │
  │  NOT isolated: DATABASE_URL · PAPERCUSP_HOME · PAPERCUSP_WORKSPACE     │
  │                                                                        │
  │  READS are safe. **WRITES ARE REAL** — a Mug steering click here       │
  │  mutates real steering and wakes the real Mug (burning real tokens);   │
  │  a routine toggle here really toggles it (git-sync included).          │
  │                                                                        │
  │  To exercise write paths safely, pass VERIFY_TAURI_ISOLATED_DB=1 (a    │
  │  genuinely isolated throwaway DB — EI-10387), or intercept             │
  │  POST /api/agent-mcp/run-tool in the webview, capture the body, and    │
  │  validate it offline against the tool's zod schema.                   │
  └────────────────────────────────────────────────────────────────────────┘

WARN
fi
tauri-agent-tools probe --pid "$VERIFY_TAURI_PID" 2>&1 | sed 's/^/[probe] /' >&2 || true

if [ "${1:-}" = "--boot-only" ]; then
  # The parent exits after printing the source-able environment, so keep the
  # advisory port locks alive in a tiny child for the interactive session; the
  # keeper self-terminates when the display is gone AND our port is free (below).
  # A subshell inherits EXIT traps. Clear the launcher's teardown trap inside
  # the keeper BEFORE it waits: the `tauri dev` wrapper may exit after handing
  # off to the real desktop process, and the keeper ending must never tear down
  # that app/Xvfb/sidecar out from under the interactive caller (WI-4975).
  # EI-11559: the keeper holds the advisory port lock for the LIFETIME OF THE
  # DISPLAY (Xvfb), not the tauri-dev wrapper ($TAURI_PID, which can exit early on
  # handoff). The port collision happens precisely when THIS display is freed while
  # our sidecar still holds the derived port, so the lock must stay held until Xvfb
  # is gone AND the port is actually free — then the keeper exits, releasing the
  # flock last. The wait is PASSIVE (never kills), so it can never tear down a live
  # app (WI-4975 safe); the caller's stop.sh does the killing.
  ( trap - EXIT INT TERM
    while kill -0 "$XVFB_PID" 2>/dev/null; do sleep 2; done
    wait_owned_ports_free ) &
  PORT_LOCK_KEEPER_PID=$!
  trap - EXIT INT TERM   # caller owns teardown from here
  write_stop_script
  cat <<EOF
export VERIFY_TAURI_PID=$VERIFY_TAURI_PID
export VERIFY_TAURI_PORT=$VERIFY_TAURI_PORT
export VERIFY_TAURI_DISPLAY=$VERIFY_TAURI_DISPLAY
export VERIFY_TAURI_LOG=$VERIFY_TAURI_LOG
export VERIFY_TAURI_POLL=$VERIFY_TAURI_POLL
export VERIFY_TAURI_STOP=$WORK/stop.sh
export VERIFY_TAURI_FRESHNESS_CHECK=$WORK/check-freshness.sh
# EI-17134: edited apps/operator-vite source AFTER this boot? Run this BEFORE
# trusting a re-check/reload against THIS instance — the SPA snapshot is frozen
# (EI-10364) and will never pick up the edit; this warns loudly if it drifted:
#   bash "$WORK/check-freshness.sh"
# tear down when done — NEVER leave this running unattended (WI-2115: a
# leaked isolated instance/display starves the next run):
#   "$WORK/stop.sh"
EOF
  exit 0
fi

[ "${1:-}" = "--" ] && shift
if [ "$#" -eq 0 ]; then
  echo "FATAL: no assertion command given. Usage: $0 -- <command...> (or --boot-only)" >&2
  exit 2
fi

log "running assertion command: $*"
"$@"
