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
#                  *process*.
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
#   destructive button — so it is corrected here rather than left to mislead.
#   Making it TRUE (per-run temp PG + scrubbed PAPERCUSP_HOME/WORKSPACE + a
#   boot-assert that the resolved DB is not the live one) is tracked as EI-10387.
#
#   Until then: to exercise WRITE paths safely, intercept them in the webview
#   instead of letting them reach the backend — stub `window.fetch` for
#   POST /api/agent-mcp/run-tool, capture the request body, return a synthetic
#   `{ ok:true, result:{ content:[{ text:'{"ok":true}' }] } }`, and validate the
#   captured payloads offline against the tool's own zod schema. That proves the
#   full UI→wire contract with zero live mutations (the method used for the
#   2026-07-12 Mug/Kettle/Papercup button sweep). READ paths are safe as-is.
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
#         tauri-agent-tools check --pid "$VERIFY_TAURI_PID" \
#           --selector body --text Papercusp --no-errors'
#
#   scripts/verify-tauri-headless.sh --boot-only
#     Boots the instance, prints its env (source-able) plus a stop-script
#     path, and returns WITHOUT tearing down — for a multi-step interactive
#     verification session. Run the printed stop script when done; NEVER
#     leave it running unattended (mirrors the two-instance-*-smoke.sh
#     leaked-Xvfb lesson, WI-2115 — a display left up starves the next run).
#
# ENV OVERRIDES (all optional)
#   PAPERCUSP_REPO_DIR          repo root (default: derived from this script)
#   VERIFY_TAURI_DISPLAY_NUM    Xvfb display number (default: auto-picked, >=90)
#   VERIFY_TAURI_TIMEOUT        seconds to wait for the bridge (default 180 —
#                                a cold/changed src-tauri rebuild is slower)
#   VERIFY_TAURI_SKIP_GL_CHECK  1 = skip the VirtualGL real-GPU sanity check
#                                (screenshots will be blank white — DOM/eval
#                                via the bridge still work; agent-e2e.mdx §15.4)
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="${PAPERCUSP_REPO_DIR:-$(cd "$SCRIPT_DIR/.." && pwd)}"
DESKTOP_DIR="$REPO_DIR/papercusp-desktop"
# shellcheck source=papercusp-desktop/bin/lib/federation-asserts.sh
source "$DESKTOP_DIR/bin/lib/federation-asserts.sh"   # reuse fed_pick_free_port

[ -d "$DESKTOP_DIR" ] || { echo "FATAL: $DESKTOP_DIR not found — set PAPERCUSP_REPO_DIR" >&2; exit 1; }

TIMEOUT="${VERIFY_TAURI_TIMEOUT:-180}"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/verify-tauri-headless.XXXXXX")"
LOG="$WORK/tauri.log"

log() { printf '\n[verify-tauri-headless] %s\n' "$*" >&2; }

# ── pick a free display + port pair (never the owner's real :0/:1 seat) ─────
DISPLAY_NUM="${VERIFY_TAURI_DISPLAY_NUM:-}"
if [ -z "$DISPLAY_NUM" ]; then
  DISPLAY_NUM=90
  while DISPLAY=":$DISPLAY_NUM" xdpyinfo >/dev/null 2>&1; do DISPLAY_NUM=$((DISPLAY_NUM + 1)); done
fi
[ "$DISPLAY_NUM" -ge 2 ] || { echo "FATAL: refusing display :$DISPLAY_NUM — too close to a real seat" >&2; exit 1; }

# Ports are DERIVED FROM THE DISPLAY, not picked independently (WI-4342).
# fed_pick_free_port only proves a port is free RIGHT NOW, but our sidecar binds
# it minutes later (cargo/tauri boot) — so two concurrent runs both saw 33700
# free, both picked it, and the loser's hono-host died with EADDRINUSE and its
# webview silently loaded the PEER's operator on 33700. The DISPLAY, by
# contrast, is a real OS-level reservation taken within ~1s of the pick (Xvfb
# binds :N immediately below), so keying the port range off DISPLAY_NUM makes
# concurrent runs disjoint BY CONSTRUCTION. fed_pick_free_port still runs from
# that base as a second line of defence (e.g. a stale process squatting).
PORT_BASE=$(( 33700 + (DISPLAY_NUM - 90) * 10 ))
[ "$PORT_BASE" -ge 33700 ] || PORT_BASE=33700   # a caller-forced low DISPLAY_NUM must not underflow into real ports
DEV_PORT="$(fed_pick_free_port "$PORT_BASE")"
PTY_PORT="$(fed_pick_free_port $((DEV_PORT + 4)))"

log "display=:$DISPLAY_NUM devPort=$DEV_PORT ptyPort=$PTY_PORT work=$WORK"

# ── teardown (always runs; scoped to exactly what THIS invocation started) ──
XVFB_PID="" OPENBOX_PID="" TAURI_PID=""
write_stop_script() {
  cat > "$WORK/stop.sh" <<STOP
#!/usr/bin/env bash
[ -n "$TAURI_PID" ] && { kill -TERM -- -$TAURI_PID 2>/dev/null; sleep 1; kill -9 -- -$TAURI_PID 2>/dev/null; }
[ -n "$OPENBOX_PID" ] && kill -9 $OPENBOX_PID 2>/dev/null
[ -n "$XVFB_PID" ] && kill -9 $XVFB_PID 2>/dev/null
pkill -9 -f "Xvfb :$DISPLAY_NUM " 2>/dev/null
echo "stopped (display :$DISPLAY_NUM, port $DEV_PORT)"
STOP
  chmod +x "$WORK/stop.sh"
}
teardown() {
  local ec=$?
  log "tearing down (exit=$ec)"
  write_stop_script
  "$WORK/stop.sh" >/dev/null 2>&1 || true
  exit "$ec"
}

# ── boot Xvfb (isolated, headless — never DISPLAY :0/:1) ────────────────────
Xvfb ":$DISPLAY_NUM" -screen 0 1920x1080x24 -nolisten tcp >"$WORK/xvfb.log" 2>&1 &
XVFB_PID=$!
trap teardown EXIT INT TERM
sleep 1
DISPLAY=":$DISPLAY_NUM" xdpyinfo >/dev/null 2>&1 || { echo "FATAL: Xvfb :$DISPLAY_NUM never came up — see $WORK/xvfb.log" >&2; exit 1; }
DISPLAY=":$DISPLAY_NUM" openbox >"$WORK/openbox.log" 2>&1 &
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

# ── launch the isolated dev instance (agent-e2e.mdx §1.3 recipe, packaged) ──
# setsid makes this its own process group so teardown can `kill -- -$PID`
# the WHOLE tree (cargo, node, the built binary, webkit helper processes) —
# a bare `kill $PID` regularly leaves the actual webview process orphaned.
cat > "$WORK/launch.sh" <<LAUNCH
#!/usr/bin/env bash
cd "$DESKTOP_DIR"
exec env -u WAYLAND_DISPLAY GDK_BACKEND=x11 DISPLAY=":$DISPLAY_NUM" \\
  OPERATOR_DEV_PORT="$DEV_PORT" OPERATOR_DEV_PTY_PORT="$PTY_PORT" \\
  PAPERCUSP_DEV_API_TARGET="$DEV_PORT" PAPERCUSP_NATIVE_TERMINAL=0 \\
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

log "isolated instance ready: pid=$VERIFY_TAURI_PID port=$VERIFY_TAURI_PORT display=$VERIFY_TAURI_DISPLAY"
tauri-agent-tools probe --pid "$VERIFY_TAURI_PID" 2>&1 | sed 's/^/[probe] /' >&2 || true

if [ "${1:-}" = "--boot-only" ]; then
  trap - EXIT INT TERM   # caller owns teardown from here
  write_stop_script
  cat <<EOF
export VERIFY_TAURI_PID=$VERIFY_TAURI_PID
export VERIFY_TAURI_PORT=$VERIFY_TAURI_PORT
export VERIFY_TAURI_DISPLAY=$VERIFY_TAURI_DISPLAY
export VERIFY_TAURI_LOG=$VERIFY_TAURI_LOG
export VERIFY_TAURI_STOP=$WORK/stop.sh
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
