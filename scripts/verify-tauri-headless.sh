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
# EI-20200818150345989: a bridge PID discovered by `tauri-agent-tools probe` is
# not proof that it belongs to an agent. The owner's live desktop can expose a
# healthy bridge on the same box, and driving it is destructive. Every verifier
# launched from a tracked su session therefore carries both the existing
# PAPERCUSP_SID and a dedicated launch-provenance marker. The bridge handoff
# below matches both markers from the target process's own /proc environ before
# exporting VERIFY_TAURI_PID; an unowned or owner-launched bridge is never handed
# to the assertion command.
#
# ⚠️  WHAT IS **NOT** ISOLATED — READ THIS BEFORE YOU CLICK ANYTHING (EI-10387)
#
#   ISOLATED:      the X display, the devUrl port, the pty port, the sidecar
#                  *process*, and (EI-10364) the SPA MODULE BUNDLE — a frozen
#                  snapshot the fleet's shared `vite build --watch` can't touch,
#                  so this webview's module graph is stable for the whole run.
#   **NOT** ISOLATED: the DATABASE, the WORKSPACE, and the WebView profile. The
#                  sidecar inherits the ambient env, so it connects to the SAME
#                  `DATABASE_URL` / `PAPERCUSP_WORKSPACE` as the live system, and
#                  WebKit localStorage belongs to the desktop's normal profile.
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
#   scopes PAPERCUSP_HOME/PAPERCUSP_WORKSPACE and the Tauri WebView data/cache
#   profile to this run, and *asserts at boot*
#   (reading the real sidecar process's own /proc/<pid>/environ, not just our own
#   env construction) that the resolved DB actually differs from the live one —
#   refusing to proceed otherwise. Every write in that mode is safe: it lands in
#   the throwaway DB, which nothing else reads, and is discarded at teardown. The
#   instance boots into the normal first-run onboarding flow (an empty, freshly-
#   migrated DB — the same state every real fresh install boots into), not the
#   owner's real pots/plans. A WebView localStorage sentinel is also required to
#   start absent, round-trip, and clear inside that disposable profile.
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
#     VERIFY_TAURI_PID / VERIFY_TAURI_PORT / VERIFY_TAURI_DEV_URL /
#     VERIFY_TAURI_DISPLAY exported (VERIFY_TAURI_DEV_URL is the plain
#     http://127.0.0.1:$VERIFY_TAURI_PORT origin — use it instead of
#     reconstructing the URL or parsing `tauri-agent-tools eval
#     "location.origin"`, which can return an empty string against a live,
#     healthy bridge; EI-21918804482820617),
#     tears down (even on a failing assertion), and exits with the assertion
#     command's own exit code. Example:
#       scripts/verify-tauri-headless.sh -- bash -c "
#         tauri-agent-tools eval --pid \"\$VERIFY_TAURI_PID\" \
#           'window.__TSR_ROUTER__?.navigate({ to: \"/settings/p2p\" })'
#         \"\$VERIFY_TAURI_POLL\" --selector body --text Peer --no-errors
#       "
#     The outer double-quoted script deliberately escapes its variables and
#     keeps the JS expression in single quotes. A nested bash -c with an
#     unescaped double-quoted JS argument strips the route/selector quotes
#     before tauri-agent-tools sees them, producing an invalid assertion.
#     VERIFY_TAURI_POLL retries a data-dependent DOM assertion after navigation
#     (bounded by VERIFY_TAURI_DOM_TIMEOUT) instead of racing it with a fixed sleep.
#     GUARD EVERY NEGATIVE ASSERTION (EI-18781011720418569). "the old copy is
#     gone" / "no undefined leaked" / "no error banner" are all trivially TRUE of
#     an empty document, so they pass before the sync-backed rows have arrived —
#     a green exit that verified nothing. Name the subject that must be present:
#       \"\$VERIFY_TAURI_POLL\" --require '[data-testid=\"schedule-row\"]' \
#         --eval '!document.body.innerHTML.includes(\"paused from its own subsystem\")'
#     The guard is fused into the SAME evaluation (add --require-min N when one
#     node is not enough), so nothing can slip between "rows present" and
#     "string absent". An unguarded negative --eval is REFUSED, not run; the
#     escape hatch --allow-unguarded-negative is only for a subject an EARLIER
#     assertion in the same run already proved renders.
#     `tauri-agent-tools eval` pretty-prints object results, even when the JS
#     expression returns JSON.stringify(...). If a shell probe must inspect an
#     eval result, allow the formatting whitespace:
#       R="$(tauri-agent-tools eval --pid \"$VERIFY_TAURI_PID\" \
#         'JSON.stringify({ok: !!document.querySelector(\"...\")})')"
#       grep -qE '"ok"[[:space:]]*:[[:space:]]*true' <<<"$R"
#     Prefer VERIFY_TAURI_POLL (or `tauri-agent-tools check --json`) for DOM
#     assertions; a literal `grep '"ok":true'` never matches pretty-printed
#     output because the property/value separator includes a space.
#     WAIT BEFORE YOU MEASURE (EI-19385008818210514). VERIFY_TAURI_POLL retries
#     an ASSERTION until it succeeds; it does nothing for a MEASUREMENT whose
#     value you then read as data:
#       zoneCaps: 2, zoneCapLabels: ["Controls", "Fleet"]
#     Three were expected. That reads as unfinished work — and it was a race.
#     Most components here are guarded on async data (`entry && <Thing/>`,
#     `if (!x) return null`), so before the data lands they are legitimately
#     absent, and the wrong conclusion ("the feature was never implemented")
#     is confident, plausible and only ever fires against finished work.
#     Settle first, then measure:
#       bash \"\$VERIFY_TAURI_SETTLE\"
#       tauri-agent-tools eval --pid \"\$VERIFY_TAURI_PID\" '<your measurement>'
#     VERIFY_TAURI_SETTLE blocks until the sync transport is idle AND the DOM has
#     stopped mutating. It is THREE-state: exit 0 settled, 1 still busy at
#     timeout, 3 UNKNOWN (window.__sync_metrics__ absent, or the gate reported
#     null — which means "no gate registered", never "zero in flight"). An
#     UNKNOWN is not permission to conclude anything from an absence.
#     You do not have to remember any of this: the same probe runs in
#     --note-only form on every VERIFY_TAURI_POLL timeout, and prints the
#     loading context (and nothing at all when the page really was settled).
#
#   scripts/verify-tauri-headless.sh --boot-only
#     Boots the instance, prints one source command for a private mode-600
#     per-run env file plus a stop-script path, and returns WITHOUT tearing
#     down — for a multi-step interactive verification session. The source
#     file re-checks caller PAPERCUSP_SID and target-process provenance before
#     exporting its variables. Run the printed stop script when done; NEVER
#     leave it running unattended (mirrors the two-instance-*-smoke.sh
#     leaked-Xvfb lesson, WI-2115 — a display left up starves the next run).
#     A capability:bash launch refuses this form before booting because that
#     managed task tears down its whole cgroup when the call returns. If the
#     rig is intentionally needed only inside that task, use the explicit
#     `--boot-only-i-accept-task-lifetime` escape instead.
#
#   scripts/verify-tauri-headless.sh --boot-only-i-accept-task-lifetime
#     Explicitly opts into the capability:bash task lifetime above. The rig
#     will be gone when that managed task reaches a terminal state; do not
#     source the printed environment from a later agent tool call.
#
# ENV OVERRIDES (all optional)
#   VERIFY_TAURI_ISOLATED_DB    1 = boot a genuinely isolated, throwaway,
#                                fully-migrated embedded Postgres and WebView
#                                profile for this run instead of sharing the live
#                                DATABASE_URL/workspace/profile (EI-10387).
#                                See the header block.
#                                Default 0 (today's shared-live-DB behavior).
#   VERIFY_TAURI_ISOLATED_PG_TIMEOUT
#                               seconds to wait for the isolated Postgres to
#                                come up (default 90 — a from-scratch initdb +
#                                full migration replay is ~10-30s; a pre-built
#                                seed extract is ~1s). Only used with
#                                VERIFY_TAURI_ISOLATED_DB=1.
#   VERIFY_TAURI_ISOLATED_SEED  which app STATE the isolated run starts from
#                                (EI-20191599988350937). Default `fresh` — a
#                                genuinely first-run install, unchanged.
#                                `ready` additionally marks onboarding COMPLETE
#                                so post-onboarding routes render.
#
#                                WHY: an isolated boot is correctly a FRESH
#                                install, and the root route sends a fresh
#                                install to first-run — `finished_at` unset on
#                                `setup_wizard_state` redirects `/` to
#                                /onboarding (or /setup when
#                                ONBOARDING_AGENT_FIRST is off). So every
#                                post-onboarding route assertion under
#                                VERIFY_TAURI_ISOLATED_DB=1 landed on the
#                                tutorial instead of the route under test, and
#                                proving such a route needed either a
#                                second read-only run against the SHARED live DB
#                                (giving up isolation, and write-unsafe) or
#                                hand-driving the whole onboarding flow.
#
#                                `ready` seeds ONLY the onboarding gate, through
#                                the app's own idempotent
#                                PATCH /api/desktop/setup-wizard-state (the same
#                                merge-write the wizard and the tutor use), then
#                                re-reads it and REFUSES to hand back the shell
#                                if the gate did not actually flip. No harness,
#                                plan, work-item, credential or any other
#                                production-shaped data is created; the account
#                                and workspace are the throwaway ones this run
#                                already booted.
#
#                                REQUIRES VERIFY_TAURI_ISOLATED_DB=1 and is
#                                refused without it: the seed is a WRITE, and
#                                in the default (shared) mode it would land on
#                                the owner's real live database.
#   VERIFY_TAURI_NATIVE_TERMINAL
#                               1 = preserve the caller's native-terminal
#                                strategy/command overrides and boot the dock for
#                                live platform verification. Default 0 keeps the
#                                dock disabled so ordinary UI verifiers remain
#                                isolated from terminal processes/windows.
#   PAPERCUSP_REPO_DIR          repo root (default: derived from this script)
#   VERIFY_TAURI_DISPLAY_NUM    Xvfb display number (default: auto-picked, >=90)
#   VERIFY_TAURI_WINDOW         window size the desktop BOOTS at, <width>x<height>
#                                (e.g. 1800x1000). Default unset = the real
#                                config's 1280x800, unchanged. Use this for
#                                responsive/viewport assertions and run ONE BOOT
#                                PER VIEWPORT: resizing the live window does not
#                                stick on this rig (innerWidth stayed 1280 for
#                                both a wide and a narrow xdotool request, and
#                                window.__TAURI__ is unavailable), so a resize
#                                mid-run silently measures the original width.
#                                Lowers minWidth/minHeight to match a narrow
#                                request, and grows the Xvfb screen past its
#                                1920x1080 default for a larger one.
#   VERIFY_TAURI_TIMEOUT        seconds to wait for the bridge AFTER the desktop
#                                binary starts (default 180)
#   VERIFY_TAURI_BUILD_TIMEOUT  seconds to wait for cargo to start the desktop
#                                binary (default 300 — cold/changed src-tauri
#                                builds are intentionally outside the bridge
#                                readiness budget)
#   VERIFY_TAURI_HEALTH_TIMEOUT seconds to wait for the owned Hono+SPA origin
#                                (/api/health and /) to answer 200 from inside
#                                the webview AFTER the bridge is up (default
#                                120 — EI-21894787139229424: the verify sidecar
#                                boots the FULL operator substrate, ~3.3GB
#                                fresh RSS per EI-11641, which can take well
#                                over the old 15s default under fleet load
#                                (loadavg ~100/128 cores measured live); a
#                                healthy rig was FATALed and torn down after a
#                                ~4-minute build+boot investment because this
#                                clock alone was too tight, same rationale as
#                                VERIFY_TAURI_BUILD_TIMEOUT above)
#   VERIFY_TAURI_DOM_TIMEOUT    seconds VERIFY_TAURI_POLL waits for a DOM
#                                assertion after navigation (default 30)
#   VERIFY_TAURI_DOM_POLL_INTERVAL
#                               seconds between DOM assertion attempts (default 1)
#   VERIFY_TAURI_SETTLE_TIMEOUT seconds VERIFY_TAURI_SETTLE waits for the page to
#                               go idle before giving up (default: the guarded
#                               VERIFY_TAURI_DOM_TIMEOUT, otherwise 20; an
#                               explicit settle timeout still wins)
#   VERIFY_TAURI_SETTLE_QUIET_MS
#                               ms the DOM must stay unchanged, with the sync gate
#                               idle, before the page counts as settled (default 400)
#   VERIFY_TAURI_SETTLE_INTERVAL_MS
#                               ms between settle samples (default 250)
#   VERIFY_TAURI_AGENT_TOOLS_BIN
#                               absolute tauri-agent-tools executable override.
#                               Default: resolve it from PATH, then fall back to
#                               the managed ~/.local/node*/bin installs. Resolution
#                               happens before any X/display/build resources start.
#   VERIFY_TAURI_CARGO_BIN
#                              absolute cargo executable override. Default:
#                              resolve cargo from PATH, then fall back to
#                              ~/.cargo/bin/cargo. Resolution happens before any
#                              X/display/build resources start, and the resolved
#                              cargo directory is prepended to PATH.
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
#   VERIFY_TAURI_MAX_BOOT_ATTEMPTS
#                               how many times to (re-)pick a port pair and boot
#                                the sidecar before surfacing a bind-time EADDRINUSE
#                                as fatal (default 2 — one fresh-port retry). The
#                                advisory port lock above only protects against a
#                                CONCURRENT verifier launch; a squatter that never
#                                took the lock (a leaked prior sidecar, an unrelated
#                                process) still needs this retry (EI-18734124566158657).
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
#   VERIFY_TAURI_DISPLAY_LOCK_DIR
#                               directory for per-display advisory locks that
#                                serialize candidate selection across concurrent
#                                verifier launchers (default:
#                                $TMPDIR/papercusp-tauri-display-locks; EI-21617008171422271).
#   PAPERCUSP_SID                required tracked agent/session identity. The
#                                verifier refuses to hand back an unattributed
#                                bridge when this is unset; this is the provenance
#                                anchor that distinguishes an agent rig from the
#                                owner's live desktop.
set -uo pipefail

# EI-21590235587564636: this wrapper can run for several minutes while a peer
# edits the shared checkout. Bash reads a script lazily, so an in-place save of
# this file after boot can splice half of a line into the still-running source
# and turn a healthy rig into a syntax-error false negative. Freeze the wrapper
# itself before any argument/resource work and re-exec the frozen copy; the
# long-lived process then never reads the mutable checkout again.
VERIFY_TAURI_SOURCE_SNAPSHOT_PATH="${VERIFY_TAURI_SOURCE_SNAPSHOT_PATH:-}"
cleanup_verifier_source_snapshot() {
  if [ -n "${VERIFY_TAURI_SOURCE_SNAPSHOT_PATH:-}" ]; then
    rm -f -- "$VERIFY_TAURI_SOURCE_SNAPSHOT_PATH" 2>/dev/null || true
    VERIFY_TAURI_SOURCE_SNAPSHOT_PATH=""
  fi
}

if [ -n "$VERIFY_TAURI_SOURCE_SNAPSHOT_PATH" ]; then
  # The re-exec'd copy owns this small file until normal teardown (or an early
  # preflight failure). The SPA snapshot has its own lifecycle and is cleaned
  # separately below.
  trap cleanup_verifier_source_snapshot EXIT
else
  VERIFY_TAURI_SOURCE_PATH="${BASH_SOURCE[0]}"
  VERIFY_TAURI_SOURCE_DIR="$(cd "$(dirname -- "$VERIFY_TAURI_SOURCE_PATH")" 2>/dev/null && pwd -P)" || {
    echo "FATAL: could not resolve verifier source directory" >&2
    exit 1
  }
  VERIFY_TAURI_ORIGINAL_REPO_DIR="${PAPERCUSP_REPO_DIR:-$(cd "$VERIFY_TAURI_SOURCE_DIR/.." 2>/dev/null && pwd -P)}" || {
    echo "FATAL: could not resolve verifier repository directory" >&2
    exit 1
  }
  VERIFY_TAURI_SOURCE_SNAPSHOT_PATH="$(mktemp "${TMPDIR:-/tmp}/verify-tauri-headless-source.XXXXXX")" || {
    echo "FATAL: could not allocate an immutable verifier source snapshot" >&2
    exit 1
  }
  trap cleanup_verifier_source_snapshot EXIT
  if ! cp -- "$VERIFY_TAURI_SOURCE_PATH" "$VERIFY_TAURI_SOURCE_SNAPSHOT_PATH"; then
    echo "FATAL: could not freeze verifier source before boot" >&2
    exit 1
  fi
  # A concurrent in-place save can also tear the tiny initial copy. Reject that
  # copy before it gets a chance to allocate a rig; a later invocation can
  # retry once the source writer has completed its atomic step.
  if ! bash -n -- "$VERIFY_TAURI_SOURCE_SNAPSHOT_PATH"; then
    echo "FATAL: verifier source changed while its startup snapshot was being captured" >&2
    echo "       Re-run after the shared scripts/verify-tauri-headless.sh save is complete." >&2
    exit 1
  fi
  export VERIFY_TAURI_SOURCE_SNAPSHOT_PATH VERIFY_TAURI_ORIGINAL_REPO_DIR
  exec bash "$VERIFY_TAURI_SOURCE_SNAPSHOT_PATH" "$@"
fi

if [ "${1:-}" = "--help" ] || [ "${1:-}" = "-h" ]; then
  cat <<EOF
Usage:
  $0 -- <assertion-command...>
  $0 --boot-only
  $0 --boot-only-i-accept-task-lifetime

Boot an isolated headless Tauri verifier, run an assertion command, and tear
the verifier down. The --boot-only form prints a sourceable environment and
keeps the verifier alive until its stop script is run.
When launched by capability:bash, use assertion mode for a later tool call;
the explicit boot-only escape accepts that the managed task will kill the rig.
EOF
  exit 0
fi

# Validate and remember the assertion argv BEFORE any long-lived verifier
# resources are created. The command bytes in argv are immutable, but a
# file-backed argument (for example `bash scripts/verify-count-surfaces-tauri.sh`)
# is read only when the final command starts. Capture those files now and
# re-check them immediately before execution so a peer edit during the boot
# cannot turn this run into a verdict about different assertion code
# (EI-21166620509752037).
ASSERTION_MODE=0
ASSERTION_ARGS=()
ASSERTION_CWD="$PWD"
BOOT_ONLY_ACCEPT_TASK_LIFETIME=0
CAPABILITY_BASH_BACKGROUND_TASK_ID="${PAPERCUSP_CAPABILITY_BASH_BACKGROUND_TASK_ID:-}"
case "${1:-}" in
  --)
    [ "$#" -ge 2 ] || {
      echo "FATAL: no assertion command given. Usage: $0 -- <command...> (or --boot-only)" >&2
      exit 2
    }
    ASSERTION_MODE=1
    ASSERTION_ARGS=("${@:2}")
    ;;
  --boot-only)
    if [ -n "$CAPABILITY_BASH_BACKGROUND_TASK_ID" ]; then
      echo "FATAL: --boot-only cannot outlive capability:bash task $CAPABILITY_BASH_BACKGROUND_TASK_ID; refusing before verifier boot." >&2
      echo "       Use $0 -- <assertion-command...> for a managed task, or explicitly opt in with $0 --boot-only-i-accept-task-lifetime when the rig is only needed inside this task." >&2
      exit 2
    fi
    ;;
  --boot-only-i-accept-task-lifetime)
    [ "$#" -eq 1 ] || {
      echo "FATAL: --boot-only-i-accept-task-lifetime does not accept extra arguments." >&2
      exit 2
    }
    BOOT_ONLY_ACCEPT_TASK_LIFETIME=1
    # Keep the established --boot-only branch (and all of its teardown and
    # handoff invariants) as the single implementation path for the explicit
    # escape. The normalization also keeps downstream argument checks honest.
    set -- --boot-only
    ;;
  *)
    echo "FATAL: expected -- <assertion-command...>, --boot-only, or --boot-only-i-accept-task-lifetime" >&2
    exit 2
    ;;
esac

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="${PAPERCUSP_REPO_DIR:-${VERIFY_TAURI_ORIGINAL_REPO_DIR:-$(cd "$SCRIPT_DIR/.." && pwd)}}"
DESKTOP_DIR="$REPO_DIR/papercusp-desktop"
# shellcheck source=papercusp-desktop/bin/lib/federation-asserts.sh
source "$DESKTOP_DIR/bin/lib/federation-asserts.sh"   # reuse fed_pick_free_port

[ -d "$DESKTOP_DIR" ] || { echo "FATAL: $DESKTOP_DIR not found — set PAPERCUSP_REPO_DIR" >&2; exit 1; }

# Do not create a rig that cannot be attributed to the caller. PAPERCUSP_SID is
# already the session's durable coordination identity; reusing it avoids a
# second identity source and lets the target process prove which agent launched
# it.
TAURI_OWNER_SID="${PAPERCUSP_SID:-}"
[ -n "$TAURI_OWNER_SID" ] || {
  echo "FATAL: PAPERCUSP_SID is unset — refusing to launch an unattributed Tauri verifier." >&2
  echo "       Run this from a tracked agent session so the returned bridge cannot be confused with the owner's desktop." >&2
  exit 1
}
TAURI_LAUNCH_PROVENANCE="agent:$TAURI_OWNER_SID"

# EI-21107555111779921: `npm run install:safe` rewrites the shared root
# node_modules while holding this repo's fs mutex. Starting a verifier in that
# window races the rewrite and turns a missing `tsx`/package link into a much
# later, misleading boot failure. Reuse the install wrapper's canonical,
# non-blocking peek so the verifier reports the real condition before resolving
# its own dependency or allocating WORK/Xvfb resources. The peek is diagnostic
# only: it never reclaims a stale lock and a failed diagnostic must not prevent a
# verifier launch.
install_in_flight_preflight() {
  PAPERCUSP_PREFLIGHT_REPO_DIR="$REPO_DIR" node --input-type=module <<'NODE'
import { pathToFileURL } from 'node:url';

const repoRoot = process.env.PAPERCUSP_PREFLIGHT_REPO_DIR;
try {
  const mutex = await import(pathToFileURL(`${repoRoot}/scripts/lib/fs-mutex.mjs`).href);
  const installSafe = await import(pathToFileURL(`${repoRoot}/scripts/npm-install-safe.mjs`).href);
  const peek = mutex.peekFsMutexSync(installSafe.repoLockName(repoRoot));
  if (!peek.held) process.exit(0);

  const owner = peek.owner ?? {};
  const details = [
    owner.pid ? `pid ${owner.pid}${owner.host ? `@${owner.host}` : ''}` : '',
    owner.startedAt ? `since ${owner.startedAt}` : '',
  ].filter(Boolean).join(', ');
  console.error(
    'VERIFY_TAURI_INSTALL_IN_PROGRESS an npm install:safe is rewriting shared node_modules' +
      (details ? ` (${details})` : '') +
      ' — refusing verifier launch; retry after install:safe releases the repo mutex.',
  );
  process.exit(75);
} catch {
  // This is a best-effort diagnostic. If the helper cannot be loaded, preserve
  // the verifier's existing dependency/resource path instead of masking it.
  process.exit(0);
}
NODE
  local status=$?
  [ "$status" -eq 75 ] && return 75
  if [ "$status" -ne 0 ]; then
    echo "WARNING: install-safe mutex preflight was inconclusive; continuing verifier launch." >&2
  fi
  return 0
}

install_in_flight_preflight || exit $?

# EI-20742798527438103 / EI-20961560846717550: the Codex launcher PATH carries
# the Node runtime but not the managed npm bin directory. The verifier used to
# spend minutes booting Xvfb + Tauri, then execute a bare `tauri-agent-tools` in
# its post-boot origin guard. Exit 127 was consequently reported as the wholly
# different failure "owned origin unreachable". Resolve the dependency before
# WORK is even created, preserve an explicit override for nonstandard installs,
# and prepend its directory to PATH so caller assertions and --boot-only shells
# inherit the same working command surface as this script.
resolve_tauri_agent_tools() {
  local candidate resolved

  if [ -n "${VERIFY_TAURI_AGENT_TOOLS_BIN:-}" ]; then
    if [ ! -x "$VERIFY_TAURI_AGENT_TOOLS_BIN" ]; then
      echo "FATAL: VERIFY_TAURI_AGENT_TOOLS_BIN is not executable: $VERIFY_TAURI_AGENT_TOOLS_BIN" >&2
      return 127
    fi
    printf '%s\n' "$VERIFY_TAURI_AGENT_TOOLS_BIN"
    return 0
  fi

  if resolved="$(command -v tauri-agent-tools 2>/dev/null)" && [ -x "$resolved" ]; then
    printf '%s\n' "$resolved"
    return 0
  fi

  # The managed install is version-scoped (currently ~/.local/node25/bin), so
  # match the stable layout instead of baking today's Node major into the fix.
  for candidate in "${HOME:-}"/.local/node*/bin/tauri-agent-tools; do
    [ -x "$candidate" ] || continue
    printf '%s\n' "$candidate"
    return 0
  done

  echo "FATAL: tauri-agent-tools not found before verifier boot." >&2
  echo "       Checked PATH and ${HOME:-<unset>}/.local/node*/bin/tauri-agent-tools." >&2
  echo "       Install it there or set VERIFY_TAURI_AGENT_TOOLS_BIN to its executable path." >&2
  return 127
}

VERIFY_TAURI_AGENT_TOOLS_BIN="$(resolve_tauri_agent_tools)" || exit $?
VERIFY_TAURI_AGENT_TOOLS_BIN_DIR="$(cd "$(dirname "$VERIFY_TAURI_AGENT_TOOLS_BIN")" && pwd)"
case ":${PATH:-}:" in
  *":$VERIFY_TAURI_AGENT_TOOLS_BIN_DIR:"*) ;;
  *) PATH="$VERIFY_TAURI_AGENT_TOOLS_BIN_DIR:${PATH:-/usr/local/bin:/usr/bin:/bin}" ;;
esac
export PATH VERIFY_TAURI_AGENT_TOOLS_BIN VERIFY_TAURI_AGENT_TOOLS_BIN_DIR

# EI-21281971092880743: capability:bash sessions do not always inherit
# ~/.cargo/bin. Warm target slots hide that omission because they reuse a built
# desktop binary, while a cold slot invokes cargo metadata and dies much later
# with ENOENT. Resolve cargo before WORK/Xvfb/Tauri resources exist, preserve an
# explicit override for nonstandard Rust installs, and make the resolved
# directory part of the command surface inherited by assertions and boot-only
# shells.
resolve_cargo() {
  local candidate resolved

  if [ -n "${VERIFY_TAURI_CARGO_BIN:-}" ]; then
    if [ ! -x "$VERIFY_TAURI_CARGO_BIN" ]; then
      echo "FATAL: VERIFY_TAURI_CARGO_BIN is not executable: $VERIFY_TAURI_CARGO_BIN" >&2
      echo "       Install Rust/cargo or set VERIFY_TAURI_CARGO_BIN to an executable cargo path." >&2
      return 127
    fi
    printf '%s\n' "$VERIFY_TAURI_CARGO_BIN"
    return 0
  fi

  if resolved="$(command -v cargo 2>/dev/null)" && [ -x "$resolved" ]; then
    printf '%s\n' "$resolved"
    return 0
  fi

  candidate="${HOME:-}/.cargo/bin/cargo"
  if [ -x "$candidate" ]; then
    printf '%s\n' "$candidate"
    return 0
  fi

  echo "FATAL: cargo not found before verifier boot." >&2
  echo "       Install Rust with rustup so ~/.cargo/bin/cargo exists, or set VERIFY_TAURI_CARGO_BIN to an executable cargo path." >&2
  return 127
}

VERIFY_TAURI_CARGO_BIN="$(resolve_cargo)" || exit $?
VERIFY_TAURI_CARGO_BIN_DIR="$(cd "$(dirname "$VERIFY_TAURI_CARGO_BIN")" && pwd)"
case ":${PATH:-}:" in
  *":$VERIFY_TAURI_CARGO_BIN_DIR:"*) ;;
  *) PATH="$VERIFY_TAURI_CARGO_BIN_DIR:${PATH:-/usr/local/bin:/usr/bin:/bin}" ;;
esac
export PATH VERIFY_TAURI_CARGO_BIN VERIFY_TAURI_CARGO_BIN_DIR

# EI-21974634479405756: assertion commands are authored before this script
# spends minutes building and booting a verifier. Preflight shell syntax and
# tauri-agent-tools option ordering while the command is still cheap to reject.
# The CLI's --pid/--port options belong to a subcommand, not the root command.
validate_assertion_command_preflight() {
  [ "${ASSERTION_MODE}" -eq 1 ] || return 0

  local command_path="${ASSERTION_ARGS[0]:-}"
  local command_name="$(basename -- "$command_path")"
  local source_path="" source_text="" source_label="" syntax_output=""
  local shebang="" is_shell_script=0 normalized invalid

  case "$command_name" in
    bash|sh|dash)
      if [ "${ASSERTION_ARGS[1]:-}" = "-c" ]; then
        source_text="${ASSERTION_ARGS[2]:-}"
        source_label="$command_name -c"
        if ! syntax_output="$(bash -n -c "$source_text" 2>&1)"; then
          echo "VERIFY_TAURI_ASSERTION_INVALID $source_label: invalid shell syntax" >&2
          [ -n "$syntax_output" ] && printf '%s\n' "$syntax_output" >&2
          return 2
        fi
      else
        source_path="${ASSERTION_ARGS[1]:-}"
      fi
      ;;
    *)
      source_path="$command_path"
      ;;
  esac

  if [ -n "$source_path" ]; then
    source_path="$(readlink -f -- "$source_path" 2>/dev/null || true)"
    [ -f "$source_path" ] || return 0
    shebang="$(head -n 1 -- "$source_path" 2>/dev/null || true)"
    case "$command_name" in
      bash|sh|dash) is_shell_script=1 ;;
    esac
    case "$shebang" in
      '#!'*sh*) is_shell_script=1 ;;
    esac
    case "$source_path" in
      *.sh) is_shell_script=1 ;;
    esac
    [ "$is_shell_script" -eq 1 ] || return 0
    source_label="$source_path"
    source_text="$(cat -- "$source_path")" || {
      echo "VERIFY_TAURI_ASSERTION_INVALID $source_label: could not read assertion source" >&2
      return 2
    }
    if ! syntax_output="$(bash -n -- "$source_path" 2>&1)"; then
      echo "VERIFY_TAURI_ASSERTION_INVALID $source_label: invalid shell syntax" >&2
      [ -n "$syntax_output" ] && printf '%s\n' "$syntax_output" >&2
      return 2
    fi
  fi

  [ -n "$source_text" ] || return 0
  # Join shell continuations so an option split across lines is still checked.
  normalized="$(printf '%s\n' "$source_text" | awk '
    /\\$/ { sub(/\\$/, " "); pending = pending $0; next }
    { print pending $0; pending = "" }
    END { if (pending != "") print pending }
  ')" || return 2
  invalid="$(printf '%s\n' "$normalized" | awk '
    {
      line = $0
      sub(/^[[:space:]]*#.*$/, "", line)
      has_bad_option = line ~ /tauri-agent-tools[[:space:]]+--(pid|port)([=[:space:]]|$)/
      has_subcommand = line ~ /[[:space:]](screenshot|info|dom|eval|wait|ipc-monitor|list-windows|page-state|storage|console-monitor|mutations|snapshot|diff|click|type|scroll|select|navigate|invoke|store-inspect|check|probe|app-paths|config|help)([[:space:]]|$)/
      if (has_bad_option && has_subcommand) {
        print line
        exit
      }
    }
  ')" || return 2
  if [ -n "$invalid" ]; then
    echo "VERIFY_TAURI_ASSERTION_INVALID $source_label: tauri-agent-tools --pid/--port must follow its subcommand (for example, eval --pid ...)" >&2
    echo "       offending command: $invalid" >&2
    return 2
  fi
}

validate_assertion_command_preflight || exit $?

TIMEOUT="${VERIFY_TAURI_TIMEOUT:-180}"
# EI-20229366113827667: cargo compilation and bridge readiness are separate
# phases. A cold Rust build can consume most of the bridge budget before the
# desktop process even exists, so give the build its own bounded clock and
# start TIMEOUT only after Cargo emits its Running ... papercusp-desktop marker.
BUILD_TIMEOUT="${VERIFY_TAURI_BUILD_TIMEOUT:-300}"
NATIVE_TERMINAL="${VERIFY_TAURI_NATIVE_TERMINAL:-0}"
case "$NATIVE_TERMINAL" in
  0|1) ;;
  *)
    echo "FATAL: VERIFY_TAURI_NATIVE_TERMINAL must be 0 or 1 (got '$NATIVE_TERMINAL')" >&2
    exit 2
    ;;
esac
# VIEWPORT GEOMETRY IS A BOOT-TIME PROPERTY HERE, NOT A RUNTIME ONE.
# Measured 2026-09-02 on this rig: resizing the LIVE window from inside an
# assertion does not stick. `xdotool windowsize` against the mapped toplevel
# (win=24117251) left window.innerWidth at 1280 for BOTH a 1800x1000 and a
# 900x1000 request, and the Tauri window API path is unreachable besides, because
# withGlobalTauri is off so the webview has no window.__TAURI__. Note this is NOT
# "no window manager": openbox runs on the display (start_display_server below),
# so a ConfigureRequest has someone to honour it — the cause is upstream of the
# WM and was not worth chasing, because the size a window BOOTS at needs no WM
# cooperation at all. GTK applies it at map time and nothing re-asserts over it.
#
# Why this matters more than it sounds: an assertion that resizes and then reads
# matchMedia measures the ORIGINAL width, so every narrow-viewport expectation
# fails at once and reads as a broken responsive layout. That is six red
# assertions which all in fact mean "the window never resized". Boot one instance
# per viewport instead:
#   VERIFY_TAURI_WINDOW=1800x1000 scripts/verify-tauri-headless.sh -- <assertions>
#   VERIFY_TAURI_WINDOW=900x1000  scripts/verify-tauri-headless.sh -- <assertions>
# Unset (the default) changes the launch config in no way whatsoever, so every
# existing caller keeps precisely the window it has today.
WINDOW_GEOMETRY="${VERIFY_TAURI_WINDOW:-}"
WINDOW_W=""
WINDOW_H=""
WINDOW_MIN_W=""
WINDOW_MIN_H=""
XVFB_SCREEN_W=1920
XVFB_SCREEN_H=1080
if [ -n "$WINDOW_GEOMETRY" ]; then
  if ! printf '%s' "$WINDOW_GEOMETRY" | grep -Eq '^[0-9]+x[0-9]+$'; then
    echo "FATAL: VERIFY_TAURI_WINDOW must be <width>x<height> in pixels, e.g. 1800x1000 (got '$WINDOW_GEOMETRY')" >&2
    exit 2
  fi
  WINDOW_W="${WINDOW_GEOMETRY%x*}"
  WINDOW_H="${WINDOW_GEOMETRY#*x}"
  if [ "$WINDOW_W" -lt 200 ] || [ "$WINDOW_H" -lt 200 ] || [ "$WINDOW_W" -gt 7680 ] || [ "$WINDOW_H" -gt 4320 ]; then
    echo "FATAL: VERIFY_TAURI_WINDOW out of range — each dimension must be 200..7680/4320 (got '$WINDOW_GEOMETRY')" >&2
    exit 2
  fi
  # src-tauri/tauri.conf.json pins minWidth 800 / minHeight 600. GTK clamps the
  # window UP to those floors, so a deliberately-narrow request (a 900x1000
  # responsive check, say) would silently boot wider than asked unless the floor
  # moves with it. Lower the floor only as far as the request needs.
  WINDOW_MIN_W=800
  WINDOW_MIN_H=600
  if [ "$WINDOW_W" -lt "$WINDOW_MIN_W" ]; then WINDOW_MIN_W="$WINDOW_W"; fi
  if [ "$WINDOW_H" -lt "$WINDOW_MIN_H" ]; then WINDOW_MIN_H="$WINDOW_H"; fi
  # Xvfb has no panning and openbox frames the window, so a window as large as
  # the screen is clamped to fit it — which would hand the assertions a narrower
  # window than they asked for while every log line still claimed the request.
  # Grow the virtual screen instead. The margins cover openbox's frame and are
  # deliberately generous — erring large costs only Xvfb memory, while erring
  # small reproduces the very failure this block exists to remove.
  if [ "$((WINDOW_W + 64))" -gt "$XVFB_SCREEN_W" ]; then XVFB_SCREEN_W="$((WINDOW_W + 64))"; fi
  if [ "$((WINDOW_H + 96))" -gt "$XVFB_SCREEN_H" ]; then XVFB_SCREEN_H="$((WINDOW_H + 96))"; fi
fi
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

# EI-20191599988350937: which app STATE this run starts from. Validated HERE,
# before Xvfb/cargo/Postgres, so a misuse costs a syntax error rather than a
# multi-minute boot the caller then has to throw away.
#
# The `ready` + shared-DB combination is REFUSED rather than silently honored:
# the seed is a WRITE, and in the default mode the target is the owner's real
# live database. That is the exact class of incident VERIFY_TAURI_ISOLATED_DB
# exists to prevent (EI-10387), so it must not be reachable through this knob.
ISOLATED_SEED="${VERIFY_TAURI_ISOLATED_SEED:-fresh}"
case "$ISOLATED_SEED" in
  fresh|ready) ;;
  *)
    echo "FATAL: VERIFY_TAURI_ISOLATED_SEED must be 'fresh' or 'ready' (got: '$ISOLATED_SEED')." >&2
    exit 2
    ;;
esac
if [ "$ISOLATED_SEED" = "ready" ] && [ "${VERIFY_TAURI_ISOLATED_DB:-0}" != "1" ]; then
  echo "FATAL: VERIFY_TAURI_ISOLATED_SEED=ready requires VERIFY_TAURI_ISOLATED_DB=1." >&2
  echo "       The ready seed WRITES the onboarding-complete marker. Without DB isolation that" >&2
  echo "       write lands on the SHARED live database — the owner's real state (EI-10387)." >&2
  # Deliberately the canonical repo path, NOT "$0": this script re-execs itself
  # from a /tmp source snapshot, so "$0" here is a temp path that is useless to
  # copy-paste and reads as if the caller invoked something they did not.
  echo "       Re-run with: VERIFY_TAURI_ISOLATED_DB=1 VERIFY_TAURI_ISOLATED_SEED=ready scripts/verify-tauri-headless.sh ..." >&2
  exit 2
fi

WORK="$(mktemp -d "${TMPDIR:-/tmp}/verify-tauri-headless.XXXXXX")"
LOG="$WORK/tauri.log"
# Set before the first EXIT trap so the generated stop script can safely expand
# the value even when boot fails before the isolated branch runs.
ISOLATED_WEBVIEW_ROOT=""
ISOLATED_WEBVIEW_DATA=""
ISOLATED_WEBVIEW_CACHE=""
ISOLATED_WEBVIEW_CONFIG=""

log() { printf '\n[verify-tauri-headless] %s\n' "$*" >&2; }

# EI-21150371868241728: leave an accountable owner marker in the otherwise
# disposable workdir. The admission-path reaper validates both PID liveness and
# Linux start ticks, so a reused PID cannot protect an abandoned directory. The
# --boot-only path replaces this marker with its persistent port-lock keeper
# below; the parent shell exits after handing the environment to its caller.
write_run_marker() {
  local pid="${1:-$$}" start_ticks marker_tmp
  start_ticks="$(awk '{print $22}' "/proc/$pid/stat" 2>/dev/null || true)"
  marker_tmp="$WORK/.papercusp-run.tmp.$$"
  umask 077
  {
    printf 'pid=%s\n' "$pid"
    [ -n "$start_ticks" ] && printf 'start_ticks=%s\n' "$start_ticks"
  } >"$marker_tmp" 2>/dev/null || return 1
  mv -f "$marker_tmp" "$WORK/.papercusp-run" 2>/dev/null || {
    rm -f "$marker_tmp" 2>/dev/null || true
    return 1
  }
}

write_run_marker "$$" || {
  echo "FATAL: could not write verifier ownership marker under $WORK" >&2
  exit 1
}

ASSERTION_INPUT_MANIFEST=""
ASSERTION_INPUT_COUNT=0
ASSERTION_SCRIPT_ORIGINAL_PATH=""
ASSERTION_SCRIPT_SNAPSHOT_PATH=""
write_assertion_input_manifest() {
  [ "$ASSERTION_MODE" -eq 1 ] || return 0
  command -v sha256sum >/dev/null 2>&1 || {
    echo "FATAL: sha256sum is required to freeze file-backed assertion inputs" >&2
    return 1
  }

  ASSERTION_INPUT_MANIFEST="$WORK/assertion-inputs.sha256"
  : > "$ASSERTION_INPUT_MANIFEST" || return 1
  local arg resolved_dir resolved
  for arg in "${ASSERTION_ARGS[@]}"; do
    [ -f "$arg" ] || continue
    resolved_dir="$(cd "$(dirname -- "$arg")" 2>/dev/null && pwd -P)" || return 1
    resolved="$resolved_dir/$(basename -- "$arg")"
    [ -f "$resolved" ] || continue
    sha256sum -- "$resolved" >> "$ASSERTION_INPUT_MANIFEST" || return 1
    ASSERTION_INPUT_COUNT=$((ASSERTION_INPUT_COUNT + 1))
  done

  if [ "$ASSERTION_INPUT_COUNT" -gt 0 ]; then
    log "assertion input snapshot captured before boot: $ASSERTION_INPUT_COUNT file-backed argument(s)"
  else
    log "assertion input snapshot: command has no file-backed argv inputs"
  fi
}

write_assertion_input_manifest || exit $?

cleanup_assertion_script_snapshot() {
  if [ -n "${ASSERTION_SCRIPT_SNAPSHOT_PATH:-}" ]; then
    rm -f -- "$ASSERTION_SCRIPT_SNAPSHOT_PATH" 2>/dev/null || true
    ASSERTION_SCRIPT_SNAPSHOT_PATH=""
  fi
}

# EI-21678223719044345: bash and sh read file-backed scripts lazily. An
# in-place edit after boot can therefore shift the interpreter's byte offset
# into the still-running assertion source and silently corrupt the verdict.
# Keep the existing input manifest as a change detector, but execute an
# immutable copy for in-repo bash/sh assertions so the run never reads the
# caller's moving checkout.
snapshot_assertion_script() {
  [ "$ASSERTION_MODE" -eq 1 ] || return 0
  [ "${#ASSERTION_ARGS[@]}" -ge 2 ] || return 0
  command -v sha256sum >/dev/null 2>&1 || {
    echo "FATAL: sha256sum is required to freeze an in-repo assertion script" >&2
    return 1
  }

  local shell_command script_arg resolved repo_dir_real
  shell_command="${ASSERTION_ARGS[0]}"
  case "$(basename -- "$shell_command")" in
    bash|sh) ;;
    *) return 0 ;;
  esac

  script_arg="${ASSERTION_ARGS[1]}"
  case "$script_arg" in
    ""|-*) return 0 ;;
  esac

  resolved="$(cd "$ASSERTION_CWD" 2>/dev/null && readlink -f -- "$script_arg" 2>/dev/null)" || return 0
  [ -f "$resolved" ] || return 0
  repo_dir_real="$(cd "$REPO_DIR" 2>/dev/null && pwd -P)" || return 1
  case "$resolved" in
    "$repo_dir_real"/*) ;;
    *) return 0 ;;
  esac

  local tmp snapshot_hash source_hash_before source_hash_after
  ASSERTION_SCRIPT_ORIGINAL_PATH="$resolved"
  ASSERTION_SCRIPT_SNAPSHOT_PATH="$WORK/assertion-script.sh"
  tmp="$WORK/.assertion-script.sh.tmp.$$"

  source_hash_before="$(sha256sum -- "$resolved" | awk '{print $1}')" || {
    echo "FATAL: could not hash in-repo assertion script $resolved" >&2
    return 1
  }
  cp -- "$resolved" "$tmp" || {
    rm -f -- "$tmp" 2>/dev/null || true
    echo "FATAL: could not freeze in-repo assertion script $resolved" >&2
    return 1
  }
  source_hash_after="$(sha256sum -- "$resolved" | awk '{print $1}')" || {
    rm -f -- "$tmp" 2>/dev/null || true
    echo "FATAL: could not re-hash in-repo assertion script $resolved" >&2
    return 1
  }
  snapshot_hash="$(sha256sum -- "$tmp" | awk '{print $1}')" || {
    rm -f -- "$tmp" 2>/dev/null || true
    echo "FATAL: could not hash frozen assertion script $tmp" >&2
    return 1
  }
  if [ "$source_hash_before" != "$source_hash_after" ] || [ "$source_hash_before" != "$snapshot_hash" ]; then
    rm -f -- "$tmp" 2>/dev/null || true
    echo "FATAL: in-repo assertion script changed while its startup snapshot was being captured" >&2
    echo "       Re-run after $resolved is stable." >&2
    return 1
  fi
  mv -f -- "$tmp" "$ASSERTION_SCRIPT_SNAPSHOT_PATH" || {
    rm -f -- "$tmp" 2>/dev/null || true
    echo "FATAL: could not publish frozen assertion script $ASSERTION_SCRIPT_SNAPSHOT_PATH" >&2
    return 1
  }

  ASSERTION_ARGS[1]="$ASSERTION_SCRIPT_SNAPSHOT_PATH"
  log "assertion script snapshot frozen at $ASSERTION_SCRIPT_SNAPSHOT_PATH (source $ASSERTION_SCRIPT_ORIGINAL_PATH) — IMMUTABLE for this run; restart to pick up a newer version."
}

snapshot_assertion_script || exit $?

# EI-18805100008031244 (correct-state ask #3, "report contention honestly at
# boot"): when the port picker retries or a bind loses a race, the caller was
# left with an opaque EADDRINUSE and no sense of scale — "is this a one-off
# collision, or is the box carrying a dozen of these?" Count live verifier
# instances (Xvfb displays this script owns — >=90, never :0/:1/:2) and
# accumulated work dirs so every contention message can say so honestly.
# Best-effort and non-fatal: a pgrep/find race just under-counts, never errors.
contention_summary() {
  local live_instances stale_dirs
  live_instances="$(pgrep -a -f 'Xvfb :' 2>/dev/null | grep -Ecv 'Xvfb :[0-2] ')"
  stale_dirs="$(find "${TMPDIR:-/tmp}" -maxdepth 1 -type d -name 'verify-tauri-headless.*' 2>/dev/null | wc -l | tr -d '[:space:]')"
  printf '%s live verifier instance(s), %s work dir(s) under %s' \
    "${live_instances:-0}" "${stale_dirs:-0}" "${TMPDIR:-/tmp}"
}

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
# ── X LOCK FILES: the third way a display number can be blocked ─────────────
# Xvfb refuses to start when /tmp/.XNN-lock exists — "Server is already active
# for display NN" — EVEN with no server running and no socket present. The
# picker below used to test only (a) a live server and (b) the socket file, so a
# lock-only display was handed out as "free" and the boot died on it instead of
# moving to the next number. Because the FATAL is at bind time, the whole verify
# aborts; the caller sees "Xvfb :90 never came up" and no reason to retry.
#
# The state is SELF-INFLICTED, which is why it recurs: a hard-killed Xvfb never
# removes its own lock, and reap_stale_display_if_abandoned below SIGKILLs Xvfb
# and unlinks the socket — so every reclaim used to leave a lock behind, and the
# next run tripped over it. That reaper now clears the lock it orphans, and this
# pair reclaims the ones already on disk.
x_lock_owner_alive() {
  local pid
  [ -f "/tmp/.X$1-lock" ] || return 1
  pid="$(tr -dc '0-9' < "/tmp/.X$1-lock" 2>/dev/null)"
  # An unreadable or empty lock names no owner to protect. Treating that as
  # "alive" is what makes a display unreclaimable forever.
  [ -n "$pid" ] || return 1
  kill -0 "$pid" 2>/dev/null
}
# Reclaims an ORPHANED lock. Every condition must hold: nothing serving the
# display, no socket file, the recorded owner gone, and past the same age gate
# the socket reaper uses (which is what protects an Xvfb that has written its
# lock but not yet bound). Nothing is ever KILLED here, and /tmp is sticky, so
# this can only unlink this user's own file.
reap_orphaned_x_lock() {
  local n="$1" lock="/tmp/.X$1-lock"
  [ "${VERIFY_TAURI_REAP_ORPHAN_SOCKETS:-1}" = "1" ] || return 1
  [ -f "$lock" ] || return 1
  x_socket_has_listener "$n" && return 1
  [ -S "/tmp/.X11-unix/X$n" ] && return 1
  x_lock_owner_alive "$n" && return 1
  find "$lock" -maxdepth 0 -mmin "+$((STALE_DISPLAY_MAX_AGE / 60))" 2>/dev/null | grep -q . || return 1
  rm -f "$lock" 2>/dev/null || return 1
  log "reclaimed orphaned X lock :$n — no server, no socket, recorded owner gone"
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
  # Clear the LOCK too. A SIGKILLed Xvfb never removes its own, and leaving it
  # behind hands the next run a display that looks free and cannot be bound —
  # the very failure this reaper exists to prevent, one run later.
  rm -f "/tmp/.X$n-lock" 2>/dev/null
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

# EI-21617008171422271: the old picker performed an ss/X11 probe, then released
# the candidate before Xvfb started. Two concurrent launchers could therefore
# both observe :90 as free, reserve different ports, and then both try to
# initialize GTK on the same display. Hold a per-display kernel flock from the
# post-selection recheck through teardown. A lock file may remain after a crash;
# flock ownership is the state, so a stale inode never blocks a later run.
DISPLAY_LOCK_DIR="${VERIFY_TAURI_DISPLAY_LOCK_DIR:-${TMPDIR:-/tmp}/papercusp-tauri-display-locks}"
DISPLAY_LOCK_FD=""
DISPLAY_LOCK_PATH=""
command -v flock >/dev/null 2>&1 || {
  echo "FATAL: flock is required for concurrent verifier display safety" >&2
  exit 1
}
mkdir -p "$DISPLAY_LOCK_DIR" || {
  echo "FATAL: cannot create verifier display lock directory $DISPLAY_LOCK_DIR" >&2
  exit 1
}

display_lock_release() {
  if [ -n "${DISPLAY_LOCK_FD:-}" ]; then
    eval "exec ${DISPLAY_LOCK_FD}>&-" || true
    DISPLAY_LOCK_FD=""
    DISPLAY_LOCK_PATH=""
  fi
}

display_lock_try_acquire() {
  local n="$1" fd path
  path="$DISPLAY_LOCK_DIR/display-$n.lock"
  exec {fd}>"$path" || {
    echo "FATAL: cannot open verifier display lock $path" >&2
    return 2
  }
  if ! flock -n "$fd"; then
    eval "exec ${fd}>&-"
    return 1
  fi
  DISPLAY_LOCK_FD="$fd"
  DISPLAY_LOCK_PATH="$path"
  return 0
}

# A display is TAKEN if a live server answers there, OR its socket file exists,
# OR its lock file exists — all three block a bind, and testing fewer than all
# three is how the picker hands out a number Xvfb will refuse.
x_display_taken() {
  DISPLAY=":$1" xdpyinfo >/dev/null 2>&1 && return 0
  [ -S "/tmp/.X11-unix/X$1" ] && return 0
  [ -f "/tmp/.X$1-lock" ] && return 0
  return 1
}

# Acquire the candidate's reservation FIRST, then repeat the X11/socket/lock
# check while nobody else can select this display. If a stale blocker is
# reclaimed, the final check still decides whether the candidate is usable.
# Returning 1 means another launcher owns the candidate or it remains occupied;
# returning 2 is an infrastructure error that must not turn into an endless
# walk through display numbers.
reserve_display() {
  local n="$1" lock_rc
  display_lock_try_acquire "$n"
  lock_rc=$?
  [ "$lock_rc" -eq 0 ] || return "$lock_rc"

  if x_display_taken "$n"; then
    reap_stale_display_if_abandoned "$n" || true
    reap_orphaned_x_lock "$n" || true
    if x_display_taken "$n"; then
      display_lock_release
      return 1
    fi
  fi
  return 0
}

DISPLAY_NUM="${VERIFY_TAURI_DISPLAY_NUM:-}"
DISPLAY_AUTO_PICK=0
if [ -z "$DISPLAY_NUM" ]; then
  DISPLAY_AUTO_PICK=1
  DISPLAY_NUM=90
fi

# pick_display — walk DISPLAY_NUM forward (when auto-picking) past anything
# taken/stale, then lock the candidate via reserve_display. Factored out of the
# initial pick (below) so EI-21903832503219853's GTK-init-panic retry (further
# down, once a boot attempt has already died on a contended/dead display) can
# call the SAME walk-forward+lock logic on a FRESH display, instead of retrying
# forever against the one display that just proved unusable. One procedure, two
# call sites — mirrors pick_and_lock_ports's role for the port-retry fix
# (EI-18734124566158657).
pick_display() {
  while :; do
    if [ "$DISPLAY_AUTO_PICK" -eq 1 ]; then
      while x_display_taken "$DISPLAY_NUM"; do
        # Attempt every reclaim, then RE-TEST rather than trusting a reaper's own
        # success. A reaper that clears one blocker while another remains (a socket
        # reaped with the lock still present) previously `break`ed straight onto a
        # display that still could not be bound.
        reap_stale_display_if_abandoned "$DISPLAY_NUM" || true
        reap_orphaned_x_lock "$DISPLAY_NUM" || true
        x_display_taken "$DISPLAY_NUM" || break
        DISPLAY_NUM=$((DISPLAY_NUM + 1))
      done
    fi

    reserve_display "$DISPLAY_NUM"
    display_rc=$?
    [ "$display_rc" -eq 0 ] && break
    if [ "$DISPLAY_AUTO_PICK" -eq 0 ] || [ "$display_rc" -gt 1 ]; then
      echo "FATAL: could not reserve verifier display :$DISPLAY_NUM (already in use or reserved by another launcher)" >&2
      exit 1
    fi
    # A peer may have won the reservation between our probe and reserve_display;
    # walk forward and repeat the same locked recheck for the next candidate.
    DISPLAY_NUM=$((DISPLAY_NUM + 1))
  done
  [ "$DISPLAY_NUM" -ge 2 ] || { echo "FATAL: refusing display :$DISPLAY_NUM — too close to a real seat" >&2; exit 1; }
}
pick_display

# EI-20227529270079601 / EI-9748 Route A: `setsid` creates a new session and
# process group, but it does NOT escape the spawning operator service's cgroup.
# A systemd KillMode=control-group restart would otherwise terminate every
# long-lived verifier process together. A managed task invocation already has a
# `pc-<taskId>.scope` root, though: creating another named scope from inside it
# makes a sibling outside that ledger row and briefly reports the verifier as
# unaccounted. Inherit that managed root when present; only untracked callers
# use the sibling-scope escape that protects them from an operator restart.
VERIFY_SCOPE_SLICE="papercusp-agent-session.slice"
VERIFY_SCOPE_BASE="papercup-tauri-verify-${DISPLAY_NUM}-$$"
VERIFY_SCOPE_ENABLED=0
VERIFY_SCOPE_MODE="process-group"
VERIFY_SCOPE_INHERITED=0

# A verifier launched from a visible terminal already has an external lifecycle
# owner: the terminal window.  Keep its children in that same cgroup so the task
# manager's existing VTE/console classification can expose the window as the
# owner, rather than creating a verifier-local sibling that looks like an escape.
# The capability:bash marker remains the stronger, ledger-backed path below; this
# fallback is only for direct visible-terminal launches where no marker exists.
verifier_caller_is_terminal_scope() {
  local caller_cgroup
  caller_cgroup="$(sed -n 's/^0:://p' "/proc/$$/cgroup" 2>/dev/null | head -1)"
  case "$caller_cgroup" in
    */vte-spawn-*.scope|*/papercup-console-*.scope) return 0 ;;
    *) return 1 ;;
  esac
}

# `capability:bash` forcibly stamps this reserved marker only after
# `beginSyncEnrolment` has minted a durable task id and placed the shell in its
# managed task service. The bash-job service is the cgroup root we must inherit;
# creating a verifier-local sibling scope would put Xvfb/openbox/Tauri outside
# that ledger row. A direct `setsid` keeps them in the inherited cgroup while
# still detaching them from the caller's terminal session.
if [ -n "$CAPABILITY_BASH_BACKGROUND_TASK_ID" ]; then
  VERIFY_SCOPE_MODE="inherit"
  VERIFY_SCOPE_INHERITED=1
  if [ "$BOOT_ONLY_ACCEPT_TASK_LIFETIME" = 1 ]; then
    log "WARNING: --boot-only explicitly accepted capability:bash task lifetime; verifier dies when task=${CAPABILITY_BASH_BACKGROUND_TASK_ID} ends"
  else
    log "verifier cgroup inheritance enabled: children stay in capability:bash managed task scope (task=${CAPABILITY_BASH_BACKGROUND_TASK_ID})"
  fi
elif verifier_caller_is_terminal_scope; then
  VERIFY_SCOPE_MODE="terminal"
  VERIFY_SCOPE_INHERITED=1
  log "verifier cgroup inheritance enabled: children stay in the visible terminal scope (terminal window owns lifecycle)"
elif [ "$(uname -s 2>/dev/null || true)" = "Linux" ] && command -v systemd-run >/dev/null 2>&1; then
  # Probe the actual user manager, rather than trusting the binary to be on PATH
  # (containers often ship systemd-run without a usable user bus). A failed probe
  # keeps the cross-platform fallback, but is named loudly and paired with the
  # boot-only provenance/liveness check below.
  if systemd-run --user --scope --quiet --collect --property=CollectMode=inactive-or-failed --unit="${VERIFY_SCOPE_BASE}-probe" --slice="$VERIFY_SCOPE_SLICE" -- true >/dev/null 2>&1; then
    VERIFY_SCOPE_ENABLED=1
    VERIFY_SCOPE_MODE="sibling"
    log "verifier cgroup isolation enabled: transient user scopes under $VERIFY_SCOPE_SLICE (base=${VERIFY_SCOPE_BASE})"
  else
    log "WARNING: systemd-run is present but the user-scope probe failed — verifier processes remain in the launcher cgroup; use VERIFY_TAURI_LIVENESS_CHECK before every drive (EI-20227529270079601)."
  fi
else
  log "WARNING: no usable Linux systemd user scope — verifier processes use the process-group fallback; use VERIFY_TAURI_LIVENESS_CHECK before every drive (EI-20227529270079601)."
fi

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

# pick_and_lock_ports — sets DEV_PORT/PTY_PORT to a fresh, advisory-locked pair,
# walking PORT_BASE forward past anything already free-but-claimed. Factored out
# of the initial pick (below) so EI-18734124566158657's bind-time retry (further
# down, after the sidecar actually attempts to bind) can call the SAME walk-
# forward+lock logic instead of re-deriving it — one procedure, two call sites.
pick_and_lock_ports() {
  local attempts=0
  while :; do
    DEV_PORT="$(fed_pick_free_port "$PORT_BASE")"
    PTY_PORT="$(fed_pick_free_port $((DEV_PORT + 4)))"
    if [ "$DEV_PORT" != "$PTY_PORT" ] \
      && fed_acquire_port_lock "$DEV_PORT" "$PORT_LOCK_DIR" \
      && fed_acquire_port_lock "$PTY_PORT" "$PORT_LOCK_DIR"; then
      return 0
    fi
    fed_release_port_locks
    PORT_BASE=$((DEV_PORT + 1))
    attempts=$((attempts + 1))
    [ "$attempts" -lt 100 ] || {
      echo "FATAL: could not reserve a verifier port pair after $attempts attempts" >&2
      exit 1
    }
  done
}
pick_and_lock_ports

# ── EI: drop a STALE endpoint-ipc advertisement for the port we just reserved ──
# `endpoint-ipc.<port>.json` is written by whichever operator serves <port> and
# is read by the desktop's Rust side to dial IPC. The publisher-side sweep
# (endpoint-ipc-discovery.ts `pruneStaleSiblingDiscoveryFiles`) only runs when
# some operator PUBLISHES, so a verifier run that dies before its own operator
# publishes leaves its advertisement behind forever — and the port families this
# script uses (33xxx/34xxx) are handed out by DISPLAY slot, so the NEXT run to
# land on that slot inherits the dead pointer. That is not a soft failure: the
# desktop is launched with requireIpc (no HTTP fallback), so the dial refuses
# with "restart orphan" and the whole run aborts before the caller's script
# executes. Observed 2026-08-03 on :33700 (advertised pid 597573, long dead,
# nothing listening) — the run failed with an IPC error that reads like a
# desktop/operator bug rather than a leftover file, which is what makes it
# expensive to diagnose.
#
# Deleting is safe by construction here: pick_and_lock_ports only returns a port
# that is FREE and now advisory-locked by us, so nothing can legitimately be
# serving it. We still apply the same conservative rule the TS sweeper uses —
# remove ONLY when the advertised pid is provably not running — so a racing
# publisher is never clobbered. Best-effort: never fail the run over hygiene.
prune_stale_ipc_advert_for_port() {
  local port="$1" f pid
  f="$HOME/.papercusp/endpoint-ipc.${port}.json"
  [ -f "$f" ] || return 0
  pid="$(sed -n 's/.*"pid"[[:space:]]*:[[:space:]]*\([0-9]\+\).*/\1/p' "$f" | head -1)"
  [ -n "$pid" ] || return 0
  if ! kill -0 "$pid" 2>/dev/null; then
    rm -f "$f" 2>/dev/null \
      && log "pruned stale endpoint-ipc advertisement for :$port (advertised pid $pid is dead)"
  fi
}
prune_stale_ipc_advert_for_port "$DEV_PORT"

log "display=:$DISPLAY_NUM devPort=$DEV_PORT ptyPort=$PTY_PORT work=$WORK"
log "contention: $(contention_summary)"

# ── teardown (always runs; scoped to exactly what THIS invocation started) ──
XVFB_PID="" OPENBOX_PID="" TAURI_PID="" PORT_LOCK_KEEPER_PID="" ISOLATED_PG_PID=""
TAURI_SCOPE_UNIT=""

# Launch a long-lived verifier process. Managed callers and visible-terminal
# callers use the plain `setsid` branch so the payload remains in the caller's
# externally-owned cgroup; other callers use the sibling user scope when Route A
# is available. The caller keeps the systemd-run client PID as the process-group
# handle in that fallback, and the generated stop script also stops the named
# scopes for a cgroup-complete teardown.
start_verify_process() {
  local unit="$1" output="$2"
  shift 2
  if [ "$VERIFY_SCOPE_MODE" = "sibling" ]; then
    setsid systemd-run --user --scope --quiet --collect --property=CollectMode=inactive-or-failed --unit="$unit" --slice="$VERIFY_SCOPE_SLICE" -- "$@" >"$output" 2>&1 &
  else
    setsid "$@" >"$output" 2>&1 &
  fi
  echo "$!"
}
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
# frozen; exits 0 (silent) if nothing changed since boot. The generated docs site
# under dist/docs is excluded by default: docs/pagefind rebuilds are independent
# of the operator SPA and otherwise make every app verification look stale. Set
# VERIFY_TAURI_FRESHNESS_INCLUDE_DOCS=1 when the run is specifically verifying
# the docs surface too.
SPA_DIST="$SPA_DIST"
SHARED_SPA_DIST="$SHARED_SPA_DIST"
if [ -z "\$SPA_DIST" ] || [ ! -f "\$SPA_DIST/.frozen-at" ]; then
  exit 0  # no snapshot was frozen this run (operator-vite wasn't built at boot) — nothing to check
fi
# EI-19382195051346372: the frozen heartbeat builtAtMs is a second, independent
# signal from the plain mtime diff below — it survives a rebuild that happens
# to touch no file the \`find -newer\` walk would catch (e.g. only index.html
# regenerated) and gives a concrete "rebuilt at <time>" instead of just "some
# file changed".
SPA_HB="\${VITE_WATCH_HEARTBEAT:-\${VITE_WATCH_LOCK:-/tmp/papercup-operator-vite-watch.lock}.heartbeat}"
if [ "\${VERIFY_TAURI_FRESHNESS_INCLUDE_DOCS:-0}" = "1" ] \
  && [ -f "\$SPA_DIST/.frozen-heartbeat-built-at-ms" ] && [ -f "\$SPA_HB" ]; then
  FROZEN_HB_MS="\$(cat "\$SPA_DIST/.frozen-heartbeat-built-at-ms" 2>/dev/null)"
  CUR_HB_MS="\$(sed -n 's/.*"builtAtMs": *\([0-9]*\).*/\1/p' "\$SPA_HB" 2>/dev/null | head -1)"
  if [ -n "\$FROZEN_HB_MS" ] && [ -n "\$CUR_HB_MS" ] && [ "\$CUR_HB_MS" -gt "\$FROZEN_HB_MS" ] 2>/dev/null; then
    CUR_HB_AT="\$(sed -n 's/.*"builtAt": *"\([^"]*\)".*/\1/p' "\$SPA_HB" 2>/dev/null | head -1)"
    echo "[check-freshness] the shared watcher has rebuilt at least once since this snapshot's freeze (latest shared build: \${CUR_HB_AT:-unknown})." >&2
  fi
fi
case "\${VERIFY_TAURI_FRESHNESS_INCLUDE_DOCS:-0}" in
  1)
    # Docs verification opts into the complete frozen input tree.
    CHANGED="\$(find "\$SHARED_SPA_DIST" -newer "\$SPA_DIST/.frozen-at" -type f 2>/dev/null | head -5)"
    ;;
  0|'')
    # The operator SPA does not consume the generated docs/pagefind subtree for
    # ordinary app checks. Prune it before applying -newer so docs-only churn is
    # not reported as stale app code.
    CHANGED="\$(find "\$SHARED_SPA_DIST" \\
      -path "\$SHARED_SPA_DIST/docs" -prune -o \\
      -newer "\$SPA_DIST/.frozen-at" -type f -print 2>/dev/null | head -5)"
    ;;
  *)
    echo "[check-freshness] VERIFY_TAURI_FRESHNESS_INCLUDE_DOCS must be 0 or 1" >&2
    exit 2
    ;;
esac
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

# EI-20227529270079601: a boot-only caller otherwise discovers a dead rig only
# when tauri-agent-tools prints "No bridge found" and lists OTHER agents' bridges.
# This check is cheap, verifies PID ownership from /proc, and gives the caller an
# unambiguous stop/reboot instruction instead of inviting it to drive a peer.
write_liveness_check_script() {
  cat > "$WORK/check-live.sh" <<LIVE_CHECK
#!/usr/bin/env bash
set -uo pipefail
PID="$BRIDGE_PID"
LOG="$LOG"
EXPECTED_DISPLAY=":$DISPLAY_NUM"
EXPECTED_PORT="$DEV_PORT"
EXPECTED_SID="$TAURI_OWNER_SID"
EXPECTED_PROVENANCE="$TAURI_LAUNCH_PROVENANCE"
SCOPE_UNIT=""
if [ "$VERIFY_SCOPE_ENABLED" = 1 ]; then
  SCOPE_UNIT="${TAURI_SCOPE_UNIT:+$TAURI_SCOPE_UNIT.scope}"
fi

if ! kill -0 "\$PID" 2>/dev/null; then
  echo "FATAL: verifier bridge PID \$PID is gone at \$(date -u +%FT%TZ) — inspect \$LOG and boot a fresh rig; do not attach to another bridge." >&2
  exit 1
fi
ENV_P="\$(tr '\0' '\n' < "/proc/\$PID/environ" 2>/dev/null || true)"
if ! grep -qxF "DISPLAY=\$EXPECTED_DISPLAY" <<<"\$ENV_P" \
  || ! grep -qxF "OPERATOR_DEV_PORT=\$EXPECTED_PORT" <<<"\$ENV_P" \
  || ! grep -qxF "PAPERCUSP_SID=\$EXPECTED_SID" <<<"\$ENV_P" \
  || ! grep -qxF "PAPERCUSP_TAURI_LAUNCH_PROVENANCE=\$EXPECTED_PROVENANCE" <<<"\$ENV_P"; then
  echo "FATAL: verifier bridge PID \$PID no longer carries this rig's launch provenance — PID may have been reused; refusing to drive another bridge. Inspect \$LOG and boot a fresh rig." >&2
  exit 1
fi
if [ -n "\$SCOPE_UNIT" ] && command -v systemctl >/dev/null 2>&1; then
  SCOPE_STATE="\$(systemctl --user show "\$SCOPE_UNIT" -p ActiveState --value 2>/dev/null || true)"
  if [ -n "\$SCOPE_STATE" ] && [ "\$SCOPE_STATE" != active ]; then
    echo "FATAL: verifier scope \$SCOPE_UNIT is \$SCOPE_STATE while PID \$PID was expected alive — inspect \$LOG and boot a fresh rig." >&2
    exit 1
  fi
fi
echo "verifier bridge alive: pid=\$PID display=\$EXPECTED_DISPLAY port=\$EXPECTED_PORT"
LIVE_CHECK
  chmod +x "$WORK/check-live.sh"
}

# EI-20226754912676562: --boot-only used to print a raw export block to the
# caller's stdout. Callers commonly redirected that stream to a shared log and
# later sourced its tail; concurrent runs could therefore hand one caller a
# peer's PID, port, display, and stop script. Keep the handoff in a private file
# and verify ownership again when it is sourced, since the caller may source a
# copied/stale path long after this boot completed.
write_boot_only_env_script() {
  (
    umask 077
    {
      printf 'VERIFY_TAURI_PID=%q\n' "$VERIFY_TAURI_PID"
      printf 'VERIFY_TAURI_PORT=%q\n' "$VERIFY_TAURI_PORT"
      printf 'VERIFY_TAURI_DEV_URL=%q\n' "http://127.0.0.1:$VERIFY_TAURI_PORT"
      printf 'VERIFY_TAURI_DISPLAY=%q\n' "$VERIFY_TAURI_DISPLAY"
      printf 'VERIFY_TAURI_OWNER_SID=%q\n' "$VERIFY_TAURI_OWNER_SID"
      printf 'VERIFY_TAURI_LAUNCH_PROVENANCE=%q\n' "$VERIFY_TAURI_LAUNCH_PROVENANCE"
      printf 'VERIFY_TAURI_LOG=%q\n' "$VERIFY_TAURI_LOG"
      printf 'VERIFY_TAURI_POLL=%q\n' "$VERIFY_TAURI_POLL"
      printf 'VERIFY_TAURI_SETTLE=%q\n' "$VERIFY_TAURI_SETTLE"
      printf 'VERIFY_TAURI_STOP=%q\n' "$WORK/stop.sh"
      printf 'VERIFY_TAURI_FRESHNESS_CHECK=%q\n' "$WORK/check-freshness.sh"
      printf 'VERIFY_TAURI_SPA_DIST=%q\n' "$SPA_DIST"
      printf 'VERIFY_TAURI_LIVENESS_CHECK=%q\n' "$WORK/check-live.sh"
      printf 'VERIFY_TAURI_SCOPE_ENABLED=%q\n' "$VERIFY_SCOPE_ENABLED"
      printf 'VERIFY_TAURI_SCOPE_MODE=%q\n' "$VERIFY_SCOPE_MODE"
      printf 'VERIFY_TAURI_SCOPE_INHERITED=%q\n' "$VERIFY_SCOPE_INHERITED"
      EXPORTED_SCOPE_UNIT=""
      if [ "$VERIFY_SCOPE_ENABLED" = 1 ]; then
        EXPORTED_SCOPE_UNIT="${TAURI_SCOPE_UNIT:+$TAURI_SCOPE_UNIT.scope}"
      fi
      printf 'VERIFY_TAURI_SCOPE_UNIT=%q\n' "$EXPORTED_SCOPE_UNIT"
      printf 'VERIFY_TAURI_HEARTBEAT=%q\n' "$HEARTBEAT_FILE"
      printf 'VERIFY_TAURI_ENV_FILE=%q\n' "$BOOT_ONLY_ENV"
      printf 'VERIFY_TAURI_AGENT_TOOLS_BIN=%q\n' "$VERIFY_TAURI_AGENT_TOOLS_BIN"
      # EI-20191599988350937: which app state this rig was seeded to, so a
      # --boot-only caller can branch on it instead of re-deriving it.
      printf 'VERIFY_TAURI_SEED=%q\n' "$ISOLATED_SEED"
      printf 'VERIFY_TAURI_AGENT_TOOLS_BIN_DIR=%q\n' "$VERIFY_TAURI_AGENT_TOOLS_BIN_DIR"
      printf 'VERIFY_TAURI_CARGO_BIN=%q\n' "$VERIFY_TAURI_CARGO_BIN"
      printf 'VERIFY_TAURI_CARGO_BIN_DIR=%q\n' "$VERIFY_TAURI_CARGO_BIN_DIR"
      cat <<'BOOT_ONLY_ENV_SCRIPT'

# This file is source-only. It deliberately does not use `set -e` so sourcing
# it cannot change the caller's error-handling policy.
verify_tauri_assert_owned() {
  PAPERCUSP_SID=${PAPERCUSP_SID:-}
  if [ -z "$PAPERCUSP_SID" ] || [ "$PAPERCUSP_SID" != "$VERIFY_TAURI_OWNER_SID" ]; then
    echo "FATAL: VERIFY_TAURI_ENV_FILE points at a verifier owned by another session (PAPERCUSP_SID mismatch)." >&2
    return 1
  fi
  if [ -z "${VERIFY_TAURI_PID:-}" ] || ! kill -0 "$VERIFY_TAURI_PID" 2>/dev/null; then
    echo "FATAL: VERIFY_TAURI_ENV_FILE points at a verifier whose bridge PID is no longer alive; boot a fresh rig." >&2
    return 1
  fi
  if [ ! -x "$VERIFY_TAURI_AGENT_TOOLS_BIN" ]; then
    echo "FATAL: verifier CLI disappeared or is no longer executable: $VERIFY_TAURI_AGENT_TOOLS_BIN" >&2
    return 1
  fi
  if [ ! -x "$VERIFY_TAURI_CARGO_BIN" ]; then
    echo "FATAL: cargo disappeared or is no longer executable: $VERIFY_TAURI_CARGO_BIN" >&2
    return 1
  fi

  local target_environ
  target_environ="$(tr '\0' '\n' < "/proc/$VERIFY_TAURI_PID/environ" 2>/dev/null || true)"
  if ! grep -qxF "DISPLAY=$VERIFY_TAURI_DISPLAY" <<<"$target_environ" \
    || ! grep -qxF "OPERATOR_DEV_PORT=$VERIFY_TAURI_PORT" <<<"$target_environ" \
    || ! grep -qxF "PAPERCUSP_SID=$VERIFY_TAURI_OWNER_SID" <<<"$target_environ" \
    || ! grep -qxF "PAPERCUSP_TAURI_LAUNCH_PROVENANCE=$VERIFY_TAURI_LAUNCH_PROVENANCE" <<<"$target_environ"; then
    echo "FATAL: VERIFY_TAURI_ENV_FILE points at a verifier owned by another session or a process with changed launch provenance." >&2
    return 1
  fi
  return 0
}

if ! verify_tauri_assert_owned; then
  # `return` is valid only when this file is sourced. Keep the source-only
  # contract explicit while still failing safely if somebody executes it.
  if (return 0 2>/dev/null); then
    return 1
  fi
  exit 1
fi

case ":${PATH:-}:" in
  *":$VERIFY_TAURI_AGENT_TOOLS_BIN_DIR:"*) ;;
  *) PATH="$VERIFY_TAURI_AGENT_TOOLS_BIN_DIR:${PATH:-/usr/local/bin:/usr/bin:/bin}" ;;
esac
case ":${PATH:-}:" in
  *":$VERIFY_TAURI_CARGO_BIN_DIR:"*) ;;
  *) PATH="$VERIFY_TAURI_CARGO_BIN_DIR:${PATH:-/usr/local/bin:/usr/bin:/bin}" ;;
esac
export PATH VERIFY_TAURI_AGENT_TOOLS_BIN VERIFY_TAURI_AGENT_TOOLS_BIN_DIR
export VERIFY_TAURI_CARGO_BIN VERIFY_TAURI_CARGO_BIN_DIR
export VERIFY_TAURI_PID VERIFY_TAURI_PORT VERIFY_TAURI_DEV_URL VERIFY_TAURI_DISPLAY
export VERIFY_TAURI_OWNER_SID VERIFY_TAURI_LAUNCH_PROVENANCE VERIFY_TAURI_LOG
export VERIFY_TAURI_POLL VERIFY_TAURI_SETTLE VERIFY_TAURI_STOP VERIFY_TAURI_FRESHNESS_CHECK
export VERIFY_TAURI_SPA_DIST VERIFY_TAURI_LIVENESS_CHECK
export VERIFY_TAURI_SCOPE_ENABLED VERIFY_TAURI_SCOPE_UNIT VERIFY_TAURI_HEARTBEAT
export VERIFY_TAURI_ENV_FILE
BOOT_ONLY_ENV_SCRIPT
    } > "$BOOT_ONLY_ENV"
  ) || return 1
  chmod 600 "$BOOT_ONLY_ENV" || {
    echo "FATAL: could not secure private boot-only environment file $BOOT_ONLY_ENV" >&2
    return 1
  }
}

write_stop_script() {
  cat > "$WORK/stop.sh" <<STOP
#!/usr/bin/env bash
# EI-20227529270079601 / EI-9748 Route A: stop sibling scopes first so no
# detached descendant survives the process-group teardown below.
if [ "$VERIFY_SCOPE_ENABLED" = 1 ] && command -v systemctl >/dev/null 2>&1; then
  [ -n "$TAURI_SCOPE_UNIT" ] && systemctl --user stop --no-block "${TAURI_SCOPE_UNIT}.scope" >/dev/null 2>&1 || true
  systemctl --user stop --no-block "${VERIFY_SCOPE_BASE}-openbox.scope" >/dev/null 2>&1 || true
  systemctl --user stop --no-block "${VERIFY_SCOPE_BASE}-xvfb.scope" >/dev/null 2>&1 || true
fi
# EI-11559: do NOT force-kill the port-lock keeper here — killing it releases the
# advisory flock IMMEDIATELY, while the sidecar (its own process group) still holds
# the display-derived port. Instead we tear down the display/app and let the keeper
# SELF-terminate once Xvfb is gone AND the port is free (it holds the lock through
# that drain), so a next run reusing this display can't collide with a straggler.
[ -n "$TAURI_PID" ] && { kill -TERM -- -$TAURI_PID 2>/dev/null; sleep 1; kill -9 -- -$TAURI_PID 2>/dev/null; }
# EI-18745117818375852: the group-kill above only reaches \$TAURI_PID's OWN
# process group — under load, dev-operator-ifneeded.sh's WI-3042 restart-on-
# nonzero-exit supervisor can have already spawned replacement sidecars that
# escaped that group (observed: the run's original hono-host plus five
# restart attempts, all bound to the SAME \$DEV_PORT, only one of them under
# \$TAURI_PID). Reap by PORT, not by tracked pid: every bin/hono-host.ts
# process whose real /proc/<pid>/environ carries OUR OPERATOR_DEV_PORT is
# unambiguously ours to kill (mirrors the pid-by-environ idiom this script
# already uses for isolation verification, above). Best-effort — a missing
# /proc entry or a transient pgrep race never fails teardown.
for _p in \$(pgrep -f "bin/hono-host.ts" 2>/dev/null); do
  _env_p="\$(tr '\\0' '\\n' < "/proc/\$_p/environ" 2>/dev/null)" || continue
  grep -q "^OPERATOR_DEV_PORT=$DEV_PORT\$" <<<"\$_env_p" || continue
  kill -TERM "\$_p" 2>/dev/null
done
sleep 1
for _p in \$(pgrep -f "bin/hono-host.ts" 2>/dev/null); do
  _env_p="\$(tr '\\0' '\\n' < "/proc/\$_p/environ" 2>/dev/null)" || continue
  grep -q "^OPERATOR_DEV_PORT=$DEV_PORT\$" <<<"\$_env_p" || continue
  kill -9 "\$_p" 2>/dev/null
done
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
# EI-20191224828837149: the isolated verifier owns a disposable Tauri/WebKit
# profile too. Remove it on the explicit --boot-only stop path as well as the
# normal EXIT teardown; otherwise localStorage would outlive the run.
[ -n "$ISOLATED_WEBVIEW_ROOT" ] && rm -rf "$ISOLATED_WEBVIEW_ROOT" 2>/dev/null
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

# EI-20237827969985420: a signal arriving during the boot poll used to enter
# teardown through the EXIT/INT/TERM trap with `$?` still equal to the last
# successful `sleep`/log command. That made the same killed run report either
# exit=0 or the signal code depending on which command happened to be active,
# and the signal trap's `exit` then re-entered the EXIT trap for a duplicate
# teardown. Keep signal disposition separate from ordinary command status, and
# let the one EXIT trap own cleanup.
SIGNAL_EXIT_CODE=0
signal_exit_code() {
  case "$1" in
    HUP) printf '129\n' ;;
    INT) printf '130\n' ;;
    TERM) printf '143\n' ;;
    *) printf '1\n' ;;
  esac
}
handle_signal() {
  SIGNAL_EXIT_CODE="$(signal_exit_code "$1")"
  # The EXIT trap below performs cleanup exactly once. Reset signal traps before
  # leaving this handler so an exit during teardown cannot recurse through it.
  trap - INT TERM HUP
  exit "$SIGNAL_EXIT_CODE"
}
teardown() {
  local ec=$?
  [ "$SIGNAL_EXIT_CODE" -ne 0 ] && ec="$SIGNAL_EXIT_CODE"
  # Cleanup can itself run commands which receive a signal. Disable all traps
  # before the first side effect so the EXIT path cannot run twice.
  trap - EXIT INT TERM HUP
  log "tearing down (exit=$ec)"
  write_stop_script
  "$WORK/stop.sh" >/dev/null 2>&1 || true
  # EI-211769: the dev bridge writes a per-PID authentication token in the
  # runtime temp directory (the same os.tmpdir()/std::env::temp_dir contract
  # tauri-agent-tools uses for discovery).
  # The bridge is dead after stop.sh, so retaining that credential serves no
  # consumer and turns every verifier run into a stale-secret leak.
  [ -n "${BRIDGE_PID:-}" ] && rm -f -- "${TMPDIR:-/tmp}/tauri-dev-bridge-$BRIDGE_PID.token"
  wait_owned_ports_free   # EI-11559: hold the advisory lock until our sidecar releases the port
  fed_release_port_locks
  # EI-21617008171422271: only release the per-display reservation after Xvfb,
  # the app, and both derived ports have finished teardown.
  display_lock_release
  # EI-10387: the isolated-DB datadir can be sizeable (a full migrated cluster) —
  # remove it now rather than leaking it into $TMPDIR across repeated runs. Best
  # effort: stop.sh above already SIGTERM'd the postmaster.
  [ -n "$ISOLATED_PG_PID" ] && [ -n "${ISOLATED_PG_DATA_DIR:-}" ] && rm -rf "$ISOLATED_PG_DATA_DIR" 2>/dev/null
  # WI-6684: apply that SAME argument to the frozen SPA snapshot, which nobody had.
  # It is the BULK of this work dir (~1GB of module bundle) and is worthless the
  # moment the run ends — but teardown only ever killed PROCESSES, so every run,
  # successful or not, leaked its snapshot. By 2026-08-01 that was 288 dirs / 294GiB
  # with /tmp at 80%, and the owner found it. Note this is NOT the --boot-only-only
  # leak the first report assumed: the `-- <cmd>` form tears its processes down
  # perfectly and still leaked every byte of disk.
  #
  # The small logs (tauri.log, xvfb.log, openbox.log) deliberately SURVIVE — they are
  # what a post-mortem reads and they cost kilobytes. `gc-verify-instances` removes
  # the husk after its TTL, and is also what catches runs that never reach this trap
  # at all (SIGKILL, or a --boot-only caller that never ran the printed stop script).
  rm -rf "$WORK/spa" 2>/dev/null
  cleanup_assertion_script_snapshot
  cleanup_verifier_source_snapshot
  exit "$ec"
}

verify_assertion_input_integrity() {
  [ "$ASSERTION_MODE" -eq 1 ] || return 0
  [ -s "$ASSERTION_INPUT_MANIFEST" ] || return 0

  local check_output
  if check_output="$(sha256sum -c -- "$ASSERTION_INPUT_MANIFEST" 2>&1)"; then
    log "assertion input integrity OK: $ASSERTION_INPUT_COUNT file-backed argument(s) unchanged since boot"
    return 0
  fi

  {
    echo
    echo "  ┌────────────────────────────────────────────────────────────────────────┐"
    echo "  │  ⛔ ASSERTION INPUT CHANGED DURING VERIFIER BOOT                       │"
    echo "  │                                                                        │"
    echo "  │  A file-backed assertion argument changed after its pre-boot snapshot.│"
    echo "  │  Refusing to execute different assertion bytes against this run's      │"
    echo "  │  frozen Tauri instance (EI-21166620509752037).                       │"
    echo "  │                                                                        │"
    echo "  │  Re-run the verifier after the assertion script is stable.             │"
    echo "  └────────────────────────────────────────────────────────────────────────┘"
    [ -n "$check_output" ] && printf '%s\n' "$check_output"
    echo
  } >&2
  return 3
}

# ── boot Xvfb (isolated, headless — never DISPLAY :0/:1) ────────────────────
# --boot-only returns control to its caller, so every long-lived process must
# live outside the launcher's terminal session. Without setsid, closing a PTY
# kills Xvfb; WebKit then exits with XIO and the "ready" desktop disappears
# before the caller's first tauri-agent-tools command (WI-4975).
#
# start_display_server — boot Xvfb + confirm it answers + boot openbox on the
# CURRENT $DISPLAY_NUM/$VERIFY_SCOPE_BASE. Factored out (EI-21903832503219853)
# so a GTK-init-panic retry can re-run it on a FRESHLY re-picked display after
# tearing the old one down, instead of retrying the tauri launch against the
# same display that just proved dead/contended. Sets XVFB_PID/OPENBOX_PID —
# teardown() and the SIGTERM/SIGINT handlers below already read those as
# ambient globals, so a re-run's fresh PIDs are picked up with no other wiring.
start_display_server() {
  XVFB_PID="$(start_verify_process "${VERIFY_SCOPE_BASE}-xvfb" "$WORK/xvfb.log" Xvfb ":$DISPLAY_NUM" -screen 0 "${XVFB_SCREEN_W}x${XVFB_SCREEN_H}x24" -nolisten tcp)"
  sleep 1
  DISPLAY=":$DISPLAY_NUM" xdpyinfo >/dev/null 2>&1 || { echo "FATAL: Xvfb :$DISPLAY_NUM never came up — see $WORK/xvfb.log" >&2; exit 1; }
  OPENBOX_PID="$(start_verify_process "${VERIFY_SCOPE_BASE}-openbox" "$WORK/openbox.log" env DISPLAY=":$DISPLAY_NUM" openbox)"
}
# Arm the EXIT/signal traps BEFORE the first start_display_server call (not
# after, as a naive factor-out would do) — teardown()/handle_signal() check
# each PID var before acting, so arming early is a harmless no-op while
# XVFB_PID/OPENBOX_PID are still unset, but arming LATE would mean an exit
# INSIDE start_display_server (the xdpyinfo FATAL above) leaks the Xvfb it
# just started and never releases the display lock — a regression the
# original inline ordering (trap set right after the first XVFB_PID assign)
# did not have.
trap teardown EXIT
trap 'handle_signal INT' INT
trap 'handle_signal TERM' TERM
trap 'handle_signal HUP' HUP
start_display_server

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
# PAPERCUSP_SHARED_SPA_DIST overrides WHICH build gets frozen. The default is the
# shared `apps/operator-vite/dist`, but that is a PRODUCTION bundle, and some
# checks only exist in a development one — `apps/operator-vite/src/query-health-gate.ts`
# gates @papercusp/sync's query-health warnings on `import.meta.env.MODE !==
# 'production'`, so they are statically compiled OUT of the shared dist and can
# never fire here. Build the bundle you want somewhere harmless and point at it:
#   PAPERCUSP_VITE_OUT_DIR=/tmp/spa-dev PAPERCUSP_VITE_FINAL_OUT_DIR=/tmp/spa-dev \
#     npx vite build --mode development          # (in apps/operator-vite; swaps nothing)
#   PAPERCUSP_SHARED_SPA_DIST=/tmp/spa-dev bash scripts/verify-tauri-headless.sh
# Still frozen into $WORK/spa exactly as below, so the isolation property holds
# whichever source it came from.
SHARED_SPA_DIST="${PAPERCUSP_SHARED_SPA_DIST:-$REPO_DIR/apps/operator-vite/dist}"
SPA_DIST=""
if [ -f "$SHARED_SPA_DIST/index.html" ]; then
  # EI-19382195051346372: wait for QUIESCENCE before freezing. The shared
  # `vite build --watch` rewrites $SHARED_SPA_DIST/assets every ~3min and
  # RETAINS old hashed chunks (emptyOutDir:false), so a freeze racing a
  # rebuild can copy a MIX of old+new chunks — a snapshot with no single
  # consistent build behind it. From inside the webview that is
  # indistinguishable from a live regression (a fatal error card naming an
  # identifier that exists nowhere in current source), and it cost ~25min of
  # bundle archaeology once already before the freeze was even suspected.
  # Poll the newest mtime under assets/; require it unchanged for
  # QUIESCE_STABLE_SEC before trusting it's a complete build, bounded by
  # QUIESCE_MAX_WAIT_SEC so a wedged watcher (EI-5202) can never hang the boot.
  # A missing or empty assets/ directory is NOT quiescence: Vite can leave the
  # already-written index.html in place while it empties/rebuilds the bundle,
  # and treating that empty state as stable freezes a blank SPA. Wait for a
  # non-empty bundle first; only a present bundle that keeps changing may use
  # the bounded "warn and freeze" fallback.
  QUIESCE_STABLE_SEC="${PAPERCUSP_SPA_QUIESCE_STABLE_SEC:-20}"
  QUIESCE_MAX_WAIT_SEC="${PAPERCUSP_SPA_QUIESCE_MAX_WAIT_SEC:-90}"
  QUIESCE_POLL_SEC=2
  quiesce_started=$(date +%s)
  last_newest=""
  stable_since=$(date +%s)
  while :; do
    now=$(date +%s)
    newest=""
    assets_ready=0
    if [ -d "$SHARED_SPA_DIST/assets" ]; then
      newest=$(find "$SHARED_SPA_DIST/assets" -type f -newermt "@0" -printf '%T@\n' 2>/dev/null | sort -rn | head -1)
      [ -n "$newest" ] && assets_ready=1
    fi
    if [ "$assets_ready" -eq 1 ]; then
      if [ "$newest" != "$last_newest" ]; then
        last_newest="$newest"
        stable_since=$now
      fi
      elapsed_stable=$((now - stable_since))
    else
      # Missing/empty assets can remain unchanged forever while index.html is
      # still present. Reset the stability clock instead of calling that state
      # a quiesced build.
      last_newest=""
      stable_since=$now
      elapsed_stable=0
    fi
    elapsed_total=$((now - quiesce_started))
    if [ "$assets_ready" -eq 1 ] && [ "$elapsed_stable" -ge "$QUIESCE_STABLE_SEC" ]; then
      [ "$elapsed_total" -gt "$QUIESCE_POLL_SEC" ] && log "shared SPA dist quiesced after ${elapsed_total}s (stable ${elapsed_stable}s) — freezing now."
      break
    fi
    if [ "$elapsed_total" -ge "$QUIESCE_MAX_WAIT_SEC" ]; then
      if [ "$assets_ready" -eq 1 ]; then
        log "WARNING: shared SPA dist did NOT quiesce within ${QUIESCE_MAX_WAIT_SEC}s (still changing every <${QUIESCE_STABLE_SEC}s) — freezing anyway. The watcher may be mid-rebuild-storm or genuinely wedged (EI-5202); a fatal error naming an identifier absent from current source is the tell that this snapshot straddled a rebuild — re-run check-freshness.sh or just restart the instance."
        break
      fi
      log "FATAL: shared SPA dist did NOT produce a non-empty assets/ bundle within ${QUIESCE_MAX_WAIT_SEC}s — refusing to freeze an incomplete snapshot (index.html exists but its referenced application assets are missing). Re-run after the watcher finishes."
      rm -rf "$WORK"
      exit 1
    fi
    sleep "$QUIESCE_POLL_SEC"
  done
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
  # EI-19382195051346372: record the heartbeat's builtAtMs at freeze time (not
  # just the gitSha) so check-freshness.sh can tell "the shared watcher has
  # rebuilt at least once since your freeze" apart from "the sha is unchanged
  # but the timestamp looks stale" — a strictly-newer builtAtMs on the SAME sha
  # still means at least one rebuild happened (e.g. a no-op watch retrigger).
  SPA_HB_BUILT_AT_MS=""
  [ -f "$SPA_HB" ] && SPA_HB_BUILT_AT_MS="$(sed -n 's/.*"builtAtMs": *\([0-9]*\).*/\1/p' "$SPA_HB" 2>/dev/null | head -1)"
  [ -n "$SPA_HB_BUILT_AT_MS" ] && echo "$SPA_HB_BUILT_AT_MS" > "$SPA_DIST/.frozen-heartbeat-built-at-ms" 2>/dev/null
  log "SPA snapshot frozen at $SPA_DIST${SPA_SHA:+ (shared build ${SPA_SHA:0:12})} — IMMUTABLE for this run; restart to pick up a newer build."
  log "  → edited source AFTER this boot? run: bash \"$WORK/check-freshness.sh\" (\$VERIFY_TAURI_FRESHNESS_CHECK) BEFORE trusting a re-check — it warns loudly if the shared bundle drifted (EI-17134)."
  log "  → waiting for a REBUILD (not just checking one)? do NOT stat one specific hashed asset (e.g. dist/assets/adv-D5qbAjO8.js) — a rebuild emits a NEW content-hash filename, so the file you're watching is orphaned and its mtime is frozen forever; the poll hangs indefinitely (EI-18812301452864060). Compare the newest matching file instead: \`ls -t dist/assets/adv-*.js | head -1\`, or just use check-freshness.sh above."
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
  # Tauri's relative `dataDirectory` is resolved below XDG_DATA_HOME. Keep all
  # three XDG roots under this run's work dir so WebKit localStorage, cache,
  # cookies, and any GLib config state cannot reuse the owner's desktop profile.
  ISOLATED_WEBVIEW_ROOT="$WORK/webview-profile"
  ISOLATED_WEBVIEW_DATA="$ISOLATED_WEBVIEW_ROOT/data"
  ISOLATED_WEBVIEW_CACHE="$ISOLATED_WEBVIEW_ROOT/cache"
  ISOLATED_WEBVIEW_CONFIG="$ISOLATED_WEBVIEW_ROOT/config"
  mkdir -p "$ISOLATED_HOME" "$ISOLATED_WEBVIEW_DATA" "$ISOLATED_WEBVIEW_CACHE" "$ISOLATED_WEBVIEW_CONFIG"

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
  ISOLATED_ENV_LINE="PAPERCUSP_HOME=\"$ISOLATED_HOME\" PAPERCUSP_WORKSPACE=\"$ISOLATED_WORKSPACE\" HARNESS_ADMIN_DATABASE_URL=\"$ISOLATED_ADMIN_URL\" HARNESS_DATABASE_URL=\"$ISOLATED_APP_URL\" PAPERCUSP_PG_PORT=\"$ISOLATED_PG_PORT\" PAPERCUSP_SKIP_PG_DISCOVERY=1 PAPERCUSP_VERIFY_TAURI_ISOLATED=1 XDG_DATA_HOME=\"$ISOLATED_WEBVIEW_DATA\" XDG_CACHE_HOME=\"$ISOLATED_WEBVIEW_CACHE\" XDG_CONFIG_HOME=\"$ISOLATED_WEBVIEW_CONFIG\""
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
# write_and_launch_tauri — (re)generate launch.sh for the CURRENT $DEV_PORT /
# $PTY_PORT / $LOG and exec it, setting $TAURI_PID. Factored out so the
# bind-time retry below (EI-18734124566158657) can call it again against a
# freshly-picked port pair instead of duplicating the heredoc.
#
# `--no-watch` is deliberate and load-bearing on this shared box (WI-6502).
# This tree is edited CONCURRENTLY by the whole fleet, so without it `tauri dev`
# keeps its Rust file-watcher armed for the life of the run: a PEER touching any
# src-tauri/*.rs mid-boot triggers "File src-tauri/src/<x>.rs changed. Rebuilding
# application...", and with several verifier boots live at once the resulting
# cargo processes convoy on the shared artifact lock ("Blocking waiting for file
# lock on artifact directory") until this script's 180s bridge timeout expires
# and the whole run is scrapped. Observed 2026-07-28: a measurement boot was
# killed by a peer's edit to endpoint_ipc.rs, which has nothing to do with the
# thing being measured.
#
# Freezing the binary is also the SAME contract this script already applies to
# the frontend, which snapshots dist/ and declares it "IMMUTABLE for this run" —
# a verification run must measure ONE artifact, not whatever the tree happened to
# drift to mid-run. The initial build still happens; only rebuild-on-change goes
# away. Editing Rust and re-verifying works exactly as before: the next
# invocation builds your change.
#
# EI-20210154033151684: this generated launcher is also the environment boundary
# for Tauri's beforeDevCommand. A tracked agent shell can carry the live host's
# PAPERCUSP_CLUSTER and an enabled spawner-sidecar socket into the fresh rig;
# pinning only inside dev-operator-ifneeded.sh is too late for that inherited
# launch environment. Keep the verifier single-process and sidecar-free, and
# remove the ambient socket path so a stale host socket can never be adopted.
# The shared PAPERCUSP_SPAWNER_SIDECAR=0 switch is not sufficient here: each
# git-heavy subsystem has an explicit override that gitSidecarEnabled() checks
# first. Those operator-only toggles are commonly enabled on the host's dev
# service and would otherwise cross into this verifier, whose isolated
# workspace/database must not create a process in the shared sidecar slice.
# Keep every explicit spawner/git offload gate pinned off at this boundary.
#
# EI-21467292301306028: Tauri's `generate_context!` bakes `build.devUrl` into
# the desktop binary. A bind-time retry regenerates this launcher with a fresh
# port, but Cargo can reuse the first attempt's warm target artifact unless a
# build-script input changes. Export the current URL as an explicit rerun key;
# build.rs watches it below, so a port re-pick re-embeds the second attempt's
# origin instead of launching a binary that still points at the lost port.
#
# `XDG_SESSION_TYPE=x11` (EI-19950536294124572): `-u WAYLAND_DISPLAY` already scrubs the
# leaked host-desktop compositor var, but XDG_SESSION_TYPE — a login-session property, not
# a "display env" var most launchers think to scrub — still leaks through from the host's
# Wayland session unless overridden. Measured: `tauri-agent-tools capture --pid <bridge>`
# against a live rig on this box had WAYLAND_DISPLAY correctly absent + DISPLAY=:N present
# in the target's own /proc/<pid>/environ, yet still misdetected as Wayland (demanding
# swaymsg/grim, never installed) because its display-server probe treated
# XDG_SESSION_TYPE=='wayland' as an equal-priority signal — see the companion local patch
# in tauri-agent-tools' detectDisplayServer(). Setting it explicitly here is redundant
# defense-in-depth once that patch is applied (it's a THIRD-PARTY global npm install,
# reverted on any package reinstall/upgrade — see the note where it's applied), and keeps
# this rig self-consistent even when the patch is absent/reverted.
write_and_launch_tauri() {
  local TAURI_DEV_URL="http://127.0.0.1:$DEV_PORT"
  local TAURI_CONFIG
  # ONE definition of the window shape, shared by both branches below, so they
  # cannot drift on geometry. `--config` JSON REPLACES the windows array
  # wholesale, so every field src-tauri/tauri.conf.json sets has to be restated
  # here or it silently reverts to a Tauri default. Geometry comes from
  # VERIFY_TAURI_WINDOW when set (see its block above) and is otherwise the
  # config's own 1280x800.
  local WIN_W="${WINDOW_W:-1280}"
  local WIN_H="${WINDOW_H:-800}"
  local WIN_MIN_W="${WINDOW_MIN_W:-800}"
  local WIN_MIN_H="${WINDOW_MIN_H:-600}"
  local WINDOW_JSON="\"label\":\"main\",\"title\":\"Papercusp\",\"width\":$WIN_W,\"height\":$WIN_H,\"minWidth\":$WIN_MIN_W,\"minHeight\":$WIN_MIN_H,\"resizable\":true,\"fullscreen\":false,\"center\":true,\"decorations\":true,\"dragDropEnabled\":false"
  if [ "$ISOLATED_DB" = "1" ]; then
    # The query is a client-side belt-and-braces guard: even if a future
    # profile change accidentally exposes ambient localStorage, voice-mode will
    # not restore a persisted microphone mode in a write-safe verifier.
    TAURI_DEV_URL="${TAURI_DEV_URL}?verify-tauri-isolated=1"
    # Adds the per-run relative WebView profile to the shared shape above.
    # Tauri resolves this below XDG_DATA_HOME/<label>, which is private above.
    TAURI_CONFIG="{\"build\":{\"devUrl\":\"$TAURI_DEV_URL\"},\"app\":{\"windows\":[{$WINDOW_JSON,\"dataDirectory\":\"verify-tauri-isolated-$DISPLAY_NUM\"}]}}"
  elif [ -n "$WINDOW_GEOMETRY" ]; then
    TAURI_CONFIG="{\"build\":{\"devUrl\":\"$TAURI_DEV_URL\"},\"app\":{\"windows\":[{$WINDOW_JSON}]}}"
  else
    # No geometry requested and no isolated profile to inject: emit the bare
    # devUrl override exactly as before, so the shared-DB default path keeps
    # using the real config's window array untouched.
    TAURI_CONFIG="{\"build\":{\"devUrl\":\"$TAURI_DEV_URL\"}}"
  fi
  cat > "$WORK/launch.sh" <<LAUNCH
#!/usr/bin/env bash
cd "$DESKTOP_DIR"
exec env -u WAYLAND_DISPLAY -u PAPERCUSP_SPAWNER_IPC_SOCKET \\
  XDG_SESSION_TYPE=x11 GDK_BACKEND=x11 DISPLAY=":$DISPLAY_NUM" \\
  OPERATOR_DEV_PORT="$DEV_PORT" OPERATOR_DEV_PTY_PORT="$PTY_PORT" \\
  PAPERCUSP_BIND_HOST=127.0.0.1 \\
  PAPERCUSP_DEV_API_TARGET="$DEV_PORT" PAPERCUSP_NATIVE_TERMINAL="$NATIVE_TERMINAL" \\
  PAPERCUSP_VERIFY_TAURI_DEV_URL="$TAURI_DEV_URL" \\
  PAPERCUSP_CLUSTER=0 PAPERCUSP_CLUSTER_WORKERS=0 \\
  PAPERCUSP_SPAWNER_SIDECAR=0 PAPERCUSP_SPAWNER_SIDECAR_MODE=0 \\
  PAPERCUSP_DEV_DEPLOY_SPAWN_SIDECAR=0 \\
  PAPERCUSP_SYSTEM_HEALTH_SPAWN_SIDECAR=0 \\
  PAPERCUSP_GIT_SYNC_SPAWN_SIDECAR=0 \\
  PAPERCUSP_GIT_PIPELINE_SPAWN_SIDECAR=0 \\
  PAPERCUSP_POT_GIT_SPAWN_SIDECAR=0 \\
  PAPERCUSP_HARNESS_DOCS_SPAWN_SIDECAR=0 \\
  PAPERCUSP_SID="$TAURI_OWNER_SID" PAPERCUSP_TAURI_LAUNCH_PROVENANCE="$TAURI_LAUNCH_PROVENANCE" \\
  PAPERCUSP_MEMORY_WATCHDOG_LIMIT_MB=$MEMORY_LIMIT_MB \\
  $SPA_ENV_LINE \\
  $ISOLATED_ENV_LINE \\
  ${LAUNCH_PREFIX[*]} npm run tauri -- dev --no-watch --config '$TAURI_CONFIG'
LAUNCH
  chmod +x "$WORK/launch.sh"
  TAURI_SCOPE_UNIT="${VERIFY_SCOPE_BASE}-tauri-${BOOT_ATTEMPTS}"
  TAURI_PID="$(start_verify_process "$TAURI_SCOPE_UNIT" "$LOG" "$WORK/launch.sh")"
}

# EI-18734124566158657: the advisory port lock (pick_and_lock_ports, above)
# closes the race between two CONCURRENT invocations of THIS script, but not
# against a squatter that never took the lock at all — a leaked/orphaned
# sidecar from a crashed prior run, or an unrelated process that happened to
# bind the same port in the ~seconds-to-minutes between our ss-probe and our
# sidecar's actual bind. That still surfaces as the EADDRINUSE guard below
# firing (correctly — refusing to verify against a peer's operator is right;
# see the header). Rather than making the caller notice a non-zero exit and
# re-run the whole ~2min boot by hand, retry ONCE automatically: tear down
# this attempt, re-pick+re-lock a fresh port pair, and re-launch — only the
# SECOND such loss surfaces as fatal.
# EI-18869809874059460: when a boot dies before the bridge, the generic `tail -40`
# below shows only the operator's own noisy shutdown chatter — a cargo/rustc error
# that actually killed the boot sits THOUSANDS of lines earlier in the same log, so
# nothing in the FATAL says "this could not compile". The natural read is "flaky,
# retry", and the retry costs another ~2min and fails identically. On this tree the
# whole fleet edits papercusp-desktop/src-tauri concurrently, so a peer's mid-edit
# Rust is a routine cause: measured 2026-07-28, a peer's `return;` in tauri's setup
# closure (E0069) killed an unrelated agent's WI-6502 measurement boot.
#
# We freeze the SPA bundle per run (EI-10364) precisely so a peer's mid-edit JS
# cannot corrupt someone else's boot; there is no equivalent for the Rust side, so
# at least NAME it. Patterns are deliberately narrow — an earlier draft also matched
# bare `-->` lines, which fired 10x on a HEALTHY boot (cargo warnings carry them
# too); a detector that cries wolf on every good boot is worse than none. Verified:
# 2 matches on the broken boot (incl. the `-->` source locator via -A1), 0 on two
# healthy boots.
RUST_ERR_RE='error\[E[0-9]+\]:|error: could not compile|error: linking with|error: aborting due to'
boot_failure_diag() {
  echo "FATAL: $1" >&2
  local errs
  errs="$(sed 's/\x1b\[[0-9;]*[a-zA-Z]//g' "$LOG" 2>/dev/null | grep -aE -A1 "$RUST_ERR_RE" | tail -24)"
  if [ -n "$errs" ]; then
    {
      echo
      echo "  ⛔ RUST BUILD BROKEN — this boot never compiled, so RETRYING WILL NOT HELP"
      echo "     until it does. Check the '-->' paths below: if they are files you did not"
      echo "     edit, a peer is mid-edit in the shared tree — wait and re-run. If they are"
      echo "     yours, fix them first."
      echo "$errs" | sed 's/^/     /'
      echo
    } >&2
  fi
  echo "  --- tail of $LOG ---" >&2
  tail -40 "$LOG" >&2
  exit 1
}

BOOT_ATTEMPTS=0
MAX_BOOT_ATTEMPTS="${VERIFY_TAURI_MAX_BOOT_ATTEMPTS:-2}"
# EI-19446616147360269: has our sidecar GIVEN UP on DEV_PORT?
#
# Deliberately matches only the TERMINAL form — hono-host's own
# listenWithEaddrinuseRetry first emits `[listen-retry] EADDRINUSE on 0.0.0.0:<port>
# (attempt N/8) — retrying`, which is transient-straggler recovery that usually
# SUCCEEDS (8 attempts, 1s apart). Tripping the re-pick on those lines would abort a
# boot that was about to heal itself and turn an 8-second recovery into a ~2min
# re-boot. Only once it exhausts them does it call onFatal, producing
# `[hono-host] fatal uncaughtException — exiting: Error: listen EADDRINUSE ... :<port>`.
# $DEV_PORT/$LOG are read at CALL time, so this stays correct after a re-pick.
port_lost_to_squatter() {
  grep -qE "fatal uncaughtException.*EADDRINUSE.*:$DEV_PORT\b" "$LOG" 2>/dev/null
}

# EI-21903832503219853: has the desktop binary DIED because ITS DISPLAY is
# dead/contended, rather than because of a code fault? tao/winit's GTK backend
# panics with `Failed to initialize gtk backend!` (tao event_loop.rs) — the
# X server it opened at boot (Xvfb :$DISPLAY_NUM) is gone or wedged by the time
# cargo finishes a cold build minutes later, most often because a concurrent
# verifier instance's stale-display reaper raced ours. Without this classifier
# a GTK-init panic reads as a plain "tauri dev exited" — kill -0 fails,
# boot_failure_diag fires, and the run dies FATALLY even on attempt 1 of 2,
# retrying nothing, on the SAME display that just proved unusable (a bare
# process retry there would panic identically). $LOG is read at CALL time, same
# convention as port_lost_to_squatter, so this stays correct after a re-pick.
gtk_init_failed() {
  grep -qE "Failed to initialize gtk backend|gtk::rt::init" "$LOG" 2>/dev/null
}

# Cargo's markers arrive COLORIZED. tauri's DevCommand invokes
# `cargo run --no-default-features --color always --`, and `--color always`
# forces SGR escapes even when stdout is a file rather than a TTY, so the
# binary-start line lands in $LOG as:
#
#     \e[1m\e[92m     Running\e[0m `/path/to/debug/papercusp-desktop`
#
# The original predicate here was `grep -qE "Running .*papercusp-desktop"`,
# which requires a LITERAL SPACE after "Running" — but the next byte is ESC.
# It could therefore NEVER match, at any budget: every run burned the whole
# BUILD_TIMEOUT and died with "desktop binary did not start ... (cargo build
# phase)" while the desktop was up and serving. Raising the budget only made
# the same failure take longer (measured: 300s -> 1200s changed nothing but
# the wall clock).
#
# Strip SGR sequences before matching rather than loosening the regex, so this
# stays correct wherever cargo chooses to place the escapes.
strip_ansi() { sed -e 's/\x1b\[[0-9;]*[a-zA-Z]//g'; }
desktop_binary_started() {
  strip_ansi < "$LOG" 2>/dev/null | grep -qE "Running[[:space:]]+.*papercusp-desktop"
}
while :; do
  BOOT_ATTEMPTS=$((BOOT_ATTEMPTS + 1))
  write_and_launch_tauri

  # EI-20229366113827667: keep cargo/build time out of the bridge-readiness
  # budget. Cargo's Running marker is the first point at which the desktop
  # binary has started; before it, a healthy cold build can legitimately take
  # longer than the 180s bridge timeout.
  log "waiting up to ${BUILD_TIMEOUT}s for the desktop binary to start (pid=$TAURI_PID, log=$LOG, attempt=$BOOT_ATTEMPTS/$MAX_BOOT_ATTEMPTS)"
  BUILD_ELAPSED=0
  PORT_LOST=0
  DISPLAY_LOST=0
  until desktop_binary_started; do
    if port_lost_to_squatter; then PORT_LOST=1; break; fi
    # EI-21903832503219853: checked in the SAME position as port_lost_to_squatter
    # (before kill -0) so a desktop binary that died OF a dead/contended display
    # routes to the re-pick branch instead of the unconditional boot_failure_diag
    # fatal below — previously a GTK-init panic exited fatally even on attempt 1.
    if gtk_init_failed; then DISPLAY_LOST=1; break; fi
    kill -0 "$TAURI_PID" 2>/dev/null || boot_failure_diag "tauri dev exited before the desktop binary started"
    [ "$BUILD_ELAPSED" -ge "$BUILD_TIMEOUT" ] && boot_failure_diag "desktop binary did not start within ${BUILD_TIMEOUT}s (cargo build phase)"
    sleep 2; BUILD_ELAPSED=$((BUILD_ELAPSED + 2))
  done

  if [ "$PORT_LOST" = 0 ] && [ "$DISPLAY_LOST" = 0 ]; then
    # The bridge clock starts at zero only after the binary-start marker. Keep
    # the existing bridge wait loop and bind-race handling intact so a sidecar
    # squatter is still retried during either phase.
    log "waiting up to ${TIMEOUT}s for the dev bridge (pid=$TAURI_PID, log=$LOG, attempt=$BOOT_ATTEMPTS/$MAX_BOOT_ATTEMPTS; desktop binary started after ${BUILD_ELAPSED}s)"
    ELAPSED=0
    until grep -q "dev bridge listening" "$LOG" 2>/dev/null; do
      # EI-19446616147360269: detect the lost port HERE, INSIDE the wait — this check
      # used to live only AFTER this loop, which made it unreachable in the exact
      # failure it was written for. Losing the bind is precisely what PREVENTS
      # "dev bridge listening" from ever appearing, so the loop could only ever
      # leave via one of the two boot_failure_diag calls below, both of which exit 1.
      # The re-pick branch below was therefore dead code for a bind-time squatter:
      # measured 2026-08-03 (work=/tmp/verify-tauri-headless.6Pb3fG) the run burned
      # ~4min, never wrote a tauri.attempt1.log, and never tried a second port.
      # Checked BEFORE the liveness/timeout probes so a sidecar that died OF this
      # cause routes to the re-pick instead of to a fatal.
      if port_lost_to_squatter; then PORT_LOST=1; break; fi
      if gtk_init_failed; then DISPLAY_LOST=1; break; fi
      kill -0 "$TAURI_PID" 2>/dev/null || boot_failure_diag "tauri dev exited before the bridge came up"
      [ "$ELAPSED" -ge "$TIMEOUT" ] && boot_failure_diag "bridge did not come up within ${TIMEOUT}s after the desktop binary started"
      sleep 2; ELAPSED=$((ELAPSED + 2))
    done
  else
    # Preserve the bind-race retry diagnostic's elapsed value when the sidecar
    # lost its port (or its display) while cargo was still compiling.
    ELAPSED="$BUILD_ELAPSED"
  fi

  if [ "$DISPLAY_LOST" = 1 ]; then
    log "desktop binary PANICKED on gtk::rt::init after ${ELAPSED}s — display :$DISPLAY_NUM is dead/contended (environment, not a code fault; EI-21903832503219853)."
  elif [ "$PORT_LOST" = 1 ]; then
    # Surface it on OUR stdout: the caller otherwise sees only "waiting up to 180s
    # for the dev bridge" and reads a dead boot as a slow one (the EADDRINUSE is
    # buried in tauri.log). Fall through to the shared re-pick/fatal branch below.
    log "sidecar GAVE UP binding :$DEV_PORT (EADDRINUSE) after ${ELAPSED}s — a squatter owns it, so the dev bridge can never come up on this port."
  else
    log "bridge is up after ${ELAPSED}s"

    # Our OWN sidecar must own DEV_PORT. If it lost a race for it, the webview is
    # pointed at SOMEONE ELSE's operator on that port and every assertion below is
    # meaningless (WI-4342) — fail loudly instead of "verifying" a peer's tree.
    if ! grep -qE "EADDRINUSE.*:$DEV_PORT\b" "$LOG" 2>/dev/null; then
      break   # our sidecar owns the port — proceed
    fi
    PORT_LOST=1
  fi

  if [ "$BOOT_ATTEMPTS" -lt "$MAX_BOOT_ATTEMPTS" ]; then
    [ -n "$TAURI_PID" ] && { kill -TERM -- -$TAURI_PID 2>/dev/null; sleep 1; kill -9 -- -$TAURI_PID 2>/dev/null; }
    if [ "$VERIFY_SCOPE_ENABLED" = 1 ] && command -v systemctl >/dev/null 2>&1; then
      systemctl --user stop --no-block "${TAURI_SCOPE_UNIT}.scope" >/dev/null 2>&1 || true
    fi
    mv "$LOG" "$WORK/tauri.attempt${BOOT_ATTEMPTS}.log" 2>/dev/null || true

    if [ "$DISPLAY_LOST" = 1 ]; then
      # EI-21903832503219853: re-pick BOTH display and ports — a bare process
      # retry on the SAME display would panic identically, since the display
      # itself (not the tauri binary) is what died. Tear down Xvfb/openbox for
      # the dead display the same way teardown() does on final exit (TERM then
      # KILL for Xvfb so it unlinks its own socket; KILL for openbox), release
      # its lock so another launcher can reclaim it, then re-run the SAME
      # pick+boot procedure the initial display selection used.
      log "GTK-init panic (attempt $BOOT_ATTEMPTS/$MAX_BOOT_ATTEMPTS) — tearing down display :$DISPLAY_NUM and re-picking a fresh display + ports once. Box contention right now: $(contention_summary)."
      [ -n "$OPENBOX_PID" ] && kill -9 $OPENBOX_PID 2>/dev/null
      [ -n "$XVFB_PID" ] && { kill -TERM $XVFB_PID 2>/dev/null; for _ in 1 2 3 4 5 6 7 8 9 10; do kill -0 $XVFB_PID 2>/dev/null || break; sleep 0.2; done; kill -9 $XVFB_PID 2>/dev/null; }
      pkill -9 -f "Xvfb :$DISPLAY_NUM " 2>/dev/null
      rm -f "/tmp/.X11-unix/X$DISPLAY_NUM" "/tmp/.X$DISPLAY_NUM-lock" 2>/dev/null
      display_lock_release
      fed_release_port_locks
      DISPLAY_NUM=$((DISPLAY_NUM + 1))
      pick_display
      VERIFY_SCOPE_BASE="papercup-tauri-verify-${DISPLAY_NUM}-$$"
      start_display_server
      # Ports are DISPLAY-derived (WI-4342) — re-derive PORT_BASE for the new
      # display exactly as the initial pick does, then walk/lock forward.
      PORT_SLOT=$(( (DISPLAY_NUM - 90) % 60 ))
      [ "$PORT_SLOT" -ge 0 ] || PORT_SLOT=$(( PORT_SLOT + 60 ))
      PORT_BASE=$(( 33700 + PORT_SLOT * 10 ))
      [ "$PORT_BASE" -ge 33700 ] || PORT_BASE=33700
      pick_and_lock_ports
      log "re-picked display=:$DISPLAY_NUM devPort=$DEV_PORT ptyPort=$PTY_PORT"
    else
      log "EADDRINUSE racing :$DEV_PORT at bind-time (attempt $BOOT_ATTEMPTS/$MAX_BOOT_ATTEMPTS) — tearing down this attempt and re-picking a fresh port once (EI-18734124566158657). Box contention right now: $(contention_summary)."
      fed_release_port_locks
      PORT_BASE=$((DEV_PORT + 1))
      pick_and_lock_ports
      log "re-picked display=:$DISPLAY_NUM devPort=$DEV_PORT ptyPort=$PTY_PORT"
    fi
    continue
  fi

  if [ "$DISPLAY_LOST" = 1 ]; then
    echo "FATAL: desktop binary panicked on gtk::rt::init (display :$DISPLAY_NUM dead/contended) again" >&2
    echo "       after $BOOT_ATTEMPTS attempt(s) across freshly-picked displays. This is environment" >&2
    echo "       contention (EI-21903832503219853), not a code fault. Box contention right now:" >&2
    echo "       $(contention_summary)." >&2
    echo "       Tail:" >&2
    grep -aE "gtk|Failed to initialize" "$LOG" | head -5 >&2
    exit 1
  fi

  echo "FATAL: our operator sidecar could not bind :$DEV_PORT (EADDRINUSE) — another instance owns it," >&2
  echo "       so this webview is loading a PEER's operator, not our tree. Refusing to verify, after" >&2
  echo "       $BOOT_ATTEMPTS attempt(s) across freshly-picked ports. Box contention right now:" >&2
  echo "       $(contention_summary) — a large count here (not \"another instance owns it\") is" >&2
  echo "       almost certainly the real cause (EI-18805100008031244); gc-verify-instances reaps" >&2
  echo "       stale ones hourly, but a burst of concurrent live runs will still race for a while." >&2
  echo "       Tail:" >&2
  grep -aE "EADDRINUSE|pty-ws" "$LOG" | head -5 >&2
  exit 1
done

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
    grep -q "^OPERATOR_DEV_PORT=$DEV_PORT\$" <<<"$env_p" || continue
    grep -qxF "PAPERCUSP_SID=$TAURI_OWNER_SID" <<<"$env_p" || continue
    grep -qxF "PAPERCUSP_TAURI_LAUNCH_PROVENANCE=$TAURI_LAUNCH_PROVENANCE" <<<"$env_p" && echo "$p"
  done | head -1)"
  [ -n "$BRIDGE_PID" ] && break
  sleep 1
done
# NEVER fall back to a pid we have not proven is ours: a wrong --pid drives a
# peer's shell. If our own webview can't be identified, that IS the failure.
[ -n "$BRIDGE_PID" ] || {
  echo "FATAL: no papercusp-desktop process carries our display/port AND launch provenance." >&2
  echo "       Expected DISPLAY=:$DISPLAY_NUM, OPERATOR_DEV_PORT=$DEV_PORT, PAPERCUSP_SID=$TAURI_OWNER_SID." >&2
  echo "       Refusing to hand back an unverified pid (it could be the owner's or a peer's instance). Tail:" >&2
  tail -20 "$LOG" >&2
  exit 1
}

# Re-read the selected process after the polling loop. This is the decisive
# handoff check: the PID and its provenance must still agree at the instant we
# expose it to the caller, not merely at an earlier probe iteration.
BRIDGE_ENVIRON="$(tr '\0' '\n' < "/proc/$BRIDGE_PID/environ" 2>/dev/null || true)"
if ! grep -qxF "PAPERCUSP_SID=$TAURI_OWNER_SID" <<<"$BRIDGE_ENVIRON" \
  || ! grep -qxF "PAPERCUSP_TAURI_LAUNCH_PROVENANCE=$TAURI_LAUNCH_PROVENANCE" <<<"$BRIDGE_ENVIRON"; then
  echo "FATAL: selected bridge pid=$BRIDGE_PID lost the expected launch provenance before handoff." >&2
  echo "       Refusing to expose it to tauri-agent-tools; resolve a fresh agent-owned rig." >&2
  exit 1
fi
log "bridge provenance verified: owner=$TAURI_LAUNCH_PROVENANCE pid=$BRIDGE_PID display=:$DISPLAY_NUM port=$DEV_PORT"

export VERIFY_TAURI_PID="$BRIDGE_PID"
export VERIFY_TAURI_PORT="$DEV_PORT"
export VERIFY_TAURI_DEV_URL="http://127.0.0.1:$DEV_PORT"
export VERIFY_TAURI_DISPLAY=":$DISPLAY_NUM"
export VERIFY_TAURI_OWNER_SID="$TAURI_OWNER_SID"
export VERIFY_TAURI_LAUNCH_PROVENANCE="$TAURI_LAUNCH_PROVENANCE"
export VERIFY_TAURI_LOG="$LOG"
write_liveness_check_script
export VERIFY_TAURI_LIVENESS_CHECK="$WORK/check-live.sh"
export VERIFY_TAURI_SCOPE_ENABLED="$VERIFY_SCOPE_ENABLED"
export VERIFY_TAURI_SCOPE_UNIT="${TAURI_SCOPE_UNIT:+$TAURI_SCOPE_UNIT.scope}"
# EI-19444780917356384: these two were exported ONLY on the --boot-only path, so
# in assertion (`--`) mode the freshness guard this script documents at boot
# ("run: bash $VERIFY_TAURI_FRESHNESS_CHECK") was literally unreachable — an
# assertion command referencing it died with `VERIFY_TAURI_FRESHNESS_CHECK:
# unbound variable`. That is exactly the mode used for one-shot CI-style
# verification, i.e. the guard was missing precisely where a stale snapshot is
# most expensive. Exported here (the path BOTH modes flow through) so the
# documented recipe works in either. write_freshness_check_script() runs
# unconditionally above, so this path always exists and is always runnable.
export VERIFY_TAURI_FRESHNESS_CHECK="$WORK/check-freshness.sh"
# The FROZEN, immutable bundle this run actually serves — grep IT (never the
# shared apps/operator-vite/dist) to prove your change is in the code under
# test. Empty when operator-vite was not built at boot, so no snapshot exists.
export VERIFY_TAURI_SPA_DIST="$SPA_DIST"

# EI-19385008818210514 — the CONFIDENT FALSE DEFECT. Most non-trivial components
# here are GUARDED on async data (`entry && <Thing entry={entry}/>`, or an early
# `if (!x) return null`), so an assertion that runs before that data lands sees
# them legitimately absent. The result is not a flaky red — it is a plausible,
# confident, WRONG conclusion: "the feature was never implemented". The asymmetry
# is what makes it expensive: a race that hides an element reads as a real
# finding, while a race that shows one just reads as success, so the error only
# ever fires against someone's finished work.
#
# VERIFY_TAURI_SETTLE is the missing "wait until the page has finished loading"
# primitive. It reads window.__sync_metrics__ (installed by the PRODUCTION SSE
# transport) plus DOM quiescence and answers settled | busy | UNKNOWN — three
# states, because transport.inFlight is `number | null` and null means "no gate
# registered / the probe threw", i.e. UNKNOWN, never zero. Exit 0 settled, 1 still
# busy at timeout, 3 unknown.
#
# The second half matters more than the first: the same probe is attached to every
# VERIFY_TAURI_POLL failure below in --note-only form, so a 0-match result can
# never render without its loading context. That is what reaches the agent who did
# not know to ask for a settle wait.
SETTLE_PROBE_MJS="$REPO_DIR/scripts/settle-probe.mjs"
SETTLE="$WORK/settle.sh"
cat > "$SETTLE" <<SETTLE_SCRIPT
#!/usr/bin/env bash
# Usage: bash "\$VERIFY_TAURI_SETTLE" [--timeout SEC] [--quiet-ms MS] [--note-only] [--json]
# Blocks until the webview under test is idle. Run it BEFORE an assertion whose
# subject is rendered from sync-backed data; \`--help\` prints the full contract.
set -uo pipefail
SETTLE_PROBE_MJS=${SETTLE_PROBE_MJS@Q}
if [ ! -f "\$SETTLE_PROBE_MJS" ]; then
  # Absence must SELF-REPORT as unknown. Silently skipping would hand the caller
  # the exact false confidence this probe exists to remove.
  echo "⚠ SETTLE: UNKNOWN — settle probe not found at \$SETTLE_PROBE_MJS, so page readiness could not be observed." >&2
  echo "   That is NOT evidence that loading finished. Do NOT conclude a missing element means a missing feature." >&2
  case " \$* " in *" --note-only "*) exit 0 ;; esac
  exit 3
fi
exec node "\$SETTLE_PROBE_MJS" --pid "\${VERIFY_TAURI_PID:?VERIFY_TAURI_PID is unset}" "\$@"
SETTLE_SCRIPT
chmod +x "$SETTLE"
export VERIFY_TAURI_SETTLE="$SETTLE"

# A route change can finish before its sync-backed data has reached the DOM.
# Fixed sleeps make those checks depend on machine/DB timing, so expose a
# bounded assertion helper for every run. Callers pass normal
# `tauri-agent-tools check` arguments; the helper pins our verified PID and
# retries until the assertion succeeds or the diagnostic timeout expires. Pass
# --quiet when a caller intentionally probes for an optional element and will
# handle the nonzero result itself; this suppresses only timeout diagnostics,
# while configuration and liveness failures remain loud.
POLL="$WORK/poll-dom.sh"
cat > "$POLL" <<'POLL_SCRIPT'
#!/usr/bin/env bash
set -uo pipefail

# EI-18781011720418569 — the VACUOUS GREEN. A NEGATIVE DOM assertion ("the old
# copy is gone", "no `undefined` leaked", "no error banner") is TRIVIALLY TRUE
# of an empty document, so it passes before the sync-backed rows have ever
# reached the DOM: correct-looking script, green exit, zero coverage. Pane-level
# readiness is NOT data-level readiness — the container renders immediately and
# the rows arrive over a sync query — so polling for the container and then
# asserting an absence is a race that usually LOSES on a loaded box and reports
# a PASS when it does. A negative assertion also has nothing obvious to poll
# FOR, which is exactly why it silently never gets a guard.
#
# So this helper makes the empty-DOM case impossible to pass silently:
#   --require <css>             the subject that must be PRESENT for the
#                               assertion to mean anything. With --eval the
#                               guard is FUSED INTO THE SAME evaluation, so
#                               nothing can slip between "rows are there" and
#                               "string is absent"; with the --selector/--text
#                               forms it gates each attempt.
#   --require-min <N>           how many nodes must match (default 1).
#   --allow-unguarded-negative  escape hatch — only when an EARLIER assertion in
#                               the same run already proved the subject renders.
# An unguarded negative --eval is REFUSED (exit 2), not run.

timeout="${VERIFY_TAURI_DOM_TIMEOUT:-30}"
interval="${VERIFY_TAURI_DOM_POLL_INTERVAL:-1}"
quiet_failure=0
require_selector=""
require_min=1
require_min_explicit=0
allow_unguarded_negative=0
args=()

while [ "$#" -gt 0 ]; do
  case "$1" in
    --quiet) quiet_failure=1; shift ;;
    --require)
      [ "$#" -ge 2 ] || { echo "FATAL: --require needs a CSS selector" >&2; exit 2; }
      require_selector="$2"; shift 2 ;;
    --require=*) require_selector="${1#--require=}"; shift ;;
    --require-min)
      [ "$#" -ge 2 ] || { echo "FATAL: --require-min needs an integer" >&2; exit 2; }
      require_min="$2"; require_min_explicit=1; shift 2 ;;
    --require-min=*) require_min="${1#--require-min=}"; require_min_explicit=1; shift ;;
    --allow-unguarded-negative) allow_unguarded_negative=1; shift ;;
    *) args+=("$1"); shift ;;
  esac
done
set -- ${args[@]+"${args[@]}"}

case "$timeout" in
  ''|*[!0-9]*) echo "FATAL: VERIFY_TAURI_DOM_TIMEOUT must be a non-negative integer" >&2; exit 2 ;;
esac
case "$require_min" in
  ''|*[!0-9]*) echo "FATAL: --require-min must be a positive integer" >&2; exit 2 ;;
esac
[ "$require_min" -ge 1 ] || {
  echo "FATAL: --require-min must be >= 1 — a guard that accepts 0 nodes guards nothing" >&2
  exit 2
}
if [ "$require_min_explicit" -eq 1 ] && [ -z "$require_selector" ]; then
  echo "FATAL: --require-min needs --require <css> — there is no subject to count" >&2
  exit 2
fi
[ "$#" -gt 0 ] || { echo "FATAL: pass tauri-agent-tools check arguments to VERIFY_TAURI_POLL" >&2; exit 2; }

# Which argument carries the caller's --eval expression (separate or inline).
eval_expr=""
eval_value_index=-1
eval_inline_index=-1
arg_index=0
for arg in "$@"; do
  if [ "$eval_value_index" -eq "$arg_index" ]; then
    eval_expr="$arg"
  fi
  case "$arg" in
    --eval) eval_value_index=$((arg_index + 1)) ;;
    --eval=*) eval_inline_index=$arg_index; eval_expr="${arg#--eval=}" ;;
  esac
  arg_index=$((arg_index + 1))
done

# Does this expression assert an ABSENCE — i.e. is it trivially true of an
# empty DOM? `!!x` is a positive truthiness coercion, not an absence check.
expression_asserts_an_absence() {
  local expr="$1"
  local trimmed="$expr"
  local zero_length_re='\.length[[:space:]]*===?[[:space:]]*0'
  local short_length_re='\.length[[:space:]]*<[[:space:]]*1'
  while [ -n "$trimmed" ]; do
    case "$trimmed" in
      ' '*|'	'*|'('*) trimmed="${trimmed#?}" ;;
      *) break ;;
    esac
  done
  case "$trimmed" in
    '!!'*) ;;
    '!'*) return 0 ;;
  esac
  case "$expr" in
    *'=== false'*|*'== false'*|*'!== true'*|*'!= true'*) return 0 ;;
  esac
  [[ "$expr" =~ $zero_length_re ]] && return 0
  [[ "$expr" =~ $short_length_re ]] && return 0
  return 1
}

if [ -n "$eval_expr" ] && [ -z "$require_selector" ] && [ "$allow_unguarded_negative" -eq 0 ] \
  && expression_asserts_an_absence "$eval_expr"; then
  echo "FATAL: refusing an UNGUARDED NEGATIVE DOM assertion (EI-18781011720418569)." >&2
  echo "       This expression asserts an ABSENCE:" >&2
  echo "         $eval_expr" >&2
  cat >&2 <<'POLL_GUARD_HELP'
       An absence is trivially true of an EMPTY document, so it passes before the
       sync-backed rows ever reach the DOM and verifies nothing at all.
       Name the subject that must be present instead:
         "$VERIFY_TAURI_POLL" --require '[data-testid="your-row"]' --eval '<your expression>'
       (add --require-min N when one node is not enough). The guard is fused into the
       SAME evaluation, so nothing can slip between "rows present" and "string absent".
       Escape hatch, ONLY when an earlier assertion in this same run already proved the
       subject renders: --allow-unguarded-negative
POLL_GUARD_HELP
  exit 2
fi

guard_expr=""
if [ -n "$require_selector" ]; then
  # Single-quoted JS string literal: selectors routinely contain double quotes.
  guard_selector_literal="${require_selector//\\/\\\\}"
  guard_selector_literal="${guard_selector_literal//\'/\\\'}"
  guard_expr="document.querySelectorAll('$guard_selector_literal').length >= $require_min"
fi

check_args=("$@")
guard_fused=0
if [ -n "$guard_expr" ] && [ -n "$eval_expr" ]; then
  if [ "$eval_inline_index" -ge 0 ]; then
    check_args[$eval_inline_index]="--eval=($guard_expr) && ($eval_expr)"
    guard_fused=1
  elif [ "$eval_value_index" -ge 0 ] && [ "$eval_value_index" -lt "${#check_args[@]}" ]; then
    check_args[$eval_value_index]="($guard_expr) && ($eval_expr)"
    guard_fused=1
  fi
fi

deadline=$((SECONDS + timeout))
last_output=""
guard_seen=0
tauri_agent_tools_bin="${VERIFY_TAURI_AGENT_TOOLS_BIN:-}"
if [ -z "$tauri_agent_tools_bin" ]; then
  tauri_agent_tools_bin="$(command -v tauri-agent-tools 2>/dev/null || true)"
fi
[ -n "$tauri_agent_tools_bin" ] || {
  echo "FATAL: tauri-agent-tools is unavailable; set VERIFY_TAURI_AGENT_TOOLS_BIN or add it to PATH" >&2
  exit 127
}

guard_probe() {
  [ -n "$guard_expr" ] || return 0
  "$tauri_agent_tools_bin" check --pid "$VERIFY_TAURI_PID" --eval "$guard_expr" >/dev/null 2>&1
}

while :; do
  if [ -n "${VERIFY_TAURI_LIVENESS_CHECK:-}" ] && ! bash "$VERIFY_TAURI_LIVENESS_CHECK" >/dev/null; then
    exit 1
  fi
  guard_ok=1
  # A fused guard rides the assertion itself; an unfused one gates the attempt.
  if [ -n "$guard_expr" ] && [ "$guard_fused" -eq 0 ]; then
    if guard_probe; then guard_seen=1; else guard_ok=0; fi
  fi
  if [ "$guard_ok" -eq 1 ] \
    && last_output="$("$tauri_agent_tools_bin" check --pid "$VERIFY_TAURI_PID" ${check_args[@]+"${check_args[@]}"} 2>&1)"; then
    [ -n "$guard_expr" ] && guard_seen=1
    [ -n "$last_output" ] && printf '%s\n' "$last_output"
    exit 0
  fi
  if [ "$SECONDS" -ge "$deadline" ]; then
    # Classify the failure: "the subject never arrived" is a different — and far
    # more common — result than "the subject was there and the claim was false".
    if [ -n "$guard_expr" ] && [ "$guard_seen" -eq 0 ] && guard_probe; then
      guard_seen=1
    fi
    if [ "$quiet_failure" -eq 0 ]; then
      if [ -n "$guard_expr" ] && [ "$guard_seen" -eq 0 ]; then
        echo "FATAL: presence guard never matched within ${timeout}s (pid=$VERIFY_TAURI_PID)" >&2
        echo "       subject '$require_selector' never reached $require_min node(s)." >&2
        echo "       The assertion never saw data — an UNGUARDED negative check would have PASSED here." >&2
      else
        echo "FATAL: DOM assertion did not pass within ${timeout}s (pid=$VERIFY_TAURI_PID)" >&2
        [ -n "$last_output" ] && printf '%s\n' "$last_output" >&2
      fi
      # EI-19385008818210514: make the absence SELF-REPORTING. The reader is about
      # to CONCLUDE something from a missing element, so state whether the page had
      # actually finished loading at the moment it was measured. Prints nothing at
      # all when the page was settled — a caveat on every failure is one readers
      # learn to skip. Never allowed to change this script's own outcome.
      if [ -n "${VERIFY_TAURI_SETTLE:-}" ] && [ -x "${VERIFY_TAURI_SETTLE:-}" ]; then
        settle_note="$(bash "$VERIFY_TAURI_SETTLE" --note-only 2>/dev/null || true)"
        [ -n "$settle_note" ] && printf '%s\n' "$settle_note" >&2
      fi
    fi
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
# EI-21894787139229424: was 15s — too tight for a substrate-booting sidecar
# under fleet load; see the VERIFY_TAURI_HEALTH_TIMEOUT header doc above.
HEALTH_TIMEOUT="${VERIFY_TAURI_HEALTH_TIMEOUT:-120}"
HEALTH_DEADLINE=$((SECONDS + HEALTH_TIMEOUT))
HEALTH_JSON=""
HEALTH_PROBE_STATUS=0
while :; do
  if ! bash "$VERIFY_TAURI_LIVENESS_CHECK" >/dev/null; then
    exit 1
  fi
  HEALTH_PROBE_STATUS=0
  HEALTH_JSON="$("$VERIFY_TAURI_AGENT_TOOLS_BIN" eval --pid "$BRIDGE_PID" "
    Promise.all([
      fetch('/api/health').then(r => r.status).catch(e => 'ERR:' + e.message),
      fetch('/').then(r => r.status).catch(e => 'ERR:' + e.message)
    ]).then(v => JSON.stringify({ apiHealth: v[0], rootHtml: v[1] }))
  " 2>&1)" || HEALTH_PROBE_STATUS=$?
  if [ "$HEALTH_PROBE_STATUS" -eq 0 ] \
    && echo "$HEALTH_JSON" | grep -Eq '"apiHealth"[[:space:]]*:[[:space:]]*200' \
    && echo "$HEALTH_JSON" | grep -Eq '"rootHtml"[[:space:]]*:[[:space:]]*200'; then
    break
  fi
  if [ "$HEALTH_PROBE_STATUS" -eq 126 ] || [ "$HEALTH_PROBE_STATUS" -eq 127 ]; then
    echo "FATAL: tauri-agent-tools could not execute during the owned-origin health probe (exit=$HEALTH_PROBE_STATUS)." >&2
    echo "       Resolved executable: $VERIFY_TAURI_AGENT_TOOLS_BIN" >&2
    echo "       This is a verifier dependency/PATH failure, not evidence that the webview origin is unreachable." >&2
    echo "       Last result: $HEALTH_JSON" >&2
    exit "$HEALTH_PROBE_STATUS"
  fi
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

# EI-20191224828837149: isolating the DB, the home dir and the workspace is not
# enough for a Tauri
# verifier. WebKit localStorage is backed by the WebView profile, so prove the
# isolated profile starts without a stable sentinel, can write/read it, and can
# clear it again. The private XDG/dataDirectory roots above make `before:null`
# meaningful: an ambient desktop profile must never already contain this key.
if [ "$ISOLATED_DB" = "1" ]; then
  ISOLATED_STORAGE_SENTINEL_KEY='papercusp.verify-tauri-headless.isolated-sentinel.v1'
  ISOLATED_STORAGE_SENTINEL_JSON="$("$VERIFY_TAURI_AGENT_TOOLS_BIN" eval --pid "$BRIDGE_PID" "
    (function () {
      var key = '$ISOLATED_STORAGE_SENTINEL_KEY';
      var value = 'verify-tauri-headless-isolated-v1';
      var before = localStorage.getItem(key);
      localStorage.setItem(key, value);
      var after = localStorage.getItem(key);
      localStorage.removeItem(key);
      return JSON.stringify({ before: before, after: after, cleared: localStorage.getItem(key) === null });
    })()
  " 2>&1)" || ISOLATED_STORAGE_SENTINEL_JSON=""
  if ! grep -Eq '"before"[[:space:]]*:[[:space:]]*null' <<<"$ISOLATED_STORAGE_SENTINEL_JSON" \
    || ! grep -Eq '"after"[[:space:]]*:[[:space:]]*"verify-tauri-headless-isolated-v1"' <<<"$ISOLATED_STORAGE_SENTINEL_JSON" \
    || ! grep -Eq '"cleared"[[:space:]]*:[[:space:]]*true' <<<"$ISOLATED_STORAGE_SENTINEL_JSON"; then
    echo "FATAL: isolated WebView localStorage profile failed its absent/write/read/clear sentinel check: $ISOLATED_STORAGE_SENTINEL_JSON" >&2
    exit 1
  fi
  # A real profile file is the second half of the guard: a mock/localStorage
  # shim could pass the JS round-trip without proving WebKit used our path.
  if ! find "$ISOLATED_WEBVIEW_ROOT" -type f -print -quit 2>/dev/null | grep -q .; then
    echo "FATAL: isolated WebView localStorage round-trip passed, but no profile file appeared under $ISOLATED_WEBVIEW_ROOT — refusing to claim profile isolation." >&2
    exit 1
  fi
  log "isolated WebView profile VERIFIED: sentinel round-tripped and cleared under $ISOLATED_WEBVIEW_ROOT"
fi

# ── EI-20191599988350937: opt-in ready-app seed ─────────────────────────────
# A fresh isolated DB is correctly a FIRST-RUN install, so the root route sends
# it to the onboarding tutorial and every post-onboarding route assertion
# measured the tutorial instead of the route under test.
#
# The gate is exactly one field: `finished_at` on `setup_wizard_state`. The
# root route treats a non-empty STRING there as "finished" and anything else as
# first-run (apps/operator-vite/src/routes/index.tsx classifyGatewayResponse),
# so flipping that one field is the whole seed — there is no second condition to
# satisfy, and no reason to invent production-shaped rows to satisfy it.
#
# Written through the app's OWN endpoint rather than SQL, deliberately:
# PATCH /api/desktop/setup-wizard-state is an idempotent merge-update (the same
# write the wizard's finish step and the onboarding tutor already perform), so
# this seed cannot drift from the storage shape the way a hand-written INSERT
# against harness_shared.setup_wizard_state would. Driving it from INSIDE the
# webview reuses the origin the health gate just proved, so there is no second
# port to resolve and no auth posture to reproduce.
#
# It then RE-READS the state and refuses to hand back the shell unless the gate
# actually flipped. Without that read-back a failed seed is invisible: the
# caller gets a healthy-looking shell that still redirects to onboarding, and
# the assertion fails somewhere far from the cause — the same silent-false-green
# shape the origin-health gate above exists to prevent.
if [ "$ISOLATED_SEED" = "ready" ]; then
  SEED_JSON="$("$VERIFY_TAURI_AGENT_TOOLS_BIN" eval --pid "$BRIDGE_PID" "
    (async function () {
      var stamp = new Date().toISOString();
      var patchStatus = await fetch('/api/desktop/setup-wizard-state', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ finished_at: stamp })
      }).then(function (r) { return r.status; }).catch(function (e) { return 'ERR:' + e.message; });
      var after = await fetch('/api/desktop/setup-wizard-state', { cache: 'no-store' })
        .then(function (r) { return r.json(); })
        .catch(function () { return null; });
      return JSON.stringify({
        patchStatus: patchStatus,
        finishedAt: (after && typeof after.finished_at === 'string') ? after.finished_at : null
      });
    })()
  " 2>&1)" || SEED_JSON=""
  # Assert the READ-BACK, not the PATCH status: a 200 that did not persist is
  # still an unseeded app, and the read-back is what the root route consults.
  if ! grep -Eq '"finishedAt"[[:space:]]*:[[:space:]]*"[^"]+"' <<<"$SEED_JSON"; then
    echo "FATAL: VERIFY_TAURI_ISOLATED_SEED=ready could not mark onboarding complete." >&2
    echo "       PATCH+re-read of /api/desktop/setup-wizard-state did not yield a finished_at string." >&2
    echo "       Refusing to hand back a shell that would still redirect post-onboarding routes to" >&2
    echo "       first-run and fail the caller's assertion far from this cause. Result: $SEED_JSON" >&2
    exit 1
  fi
  log "ready-app seed VERIFIED: onboarding marked complete (setup_wizard_state.finished_at set) — $SEED_JSON"
fi
export VERIFY_TAURI_SEED="$ISOLATED_SEED"

log "isolated instance ready: pid=$VERIFY_TAURI_PID port=$VERIFY_TAURI_PORT display=$VERIFY_TAURI_DISPLAY"

# EI-19481468061988626: xdotool's `getwindowgeometry Position` is the
# window-manager frame origin, not the WebView's client origin.  On the shared
# GNOME/X11 host the frame was 22px taller than the client area, so a perfectly
# valid coordinate aimed at one control landed on the control immediately
# below it.  Resolve the verifier's window by PID and print the client origin
# from xwininfo, together with a ready-to-paste REAL X11 click recipe.  This is
# diagnostic output only; the verifier never moves the pointer or steals focus
# on its own.
print_x11_client_click_helper() {
  local wid xwininfo_output client_x client_y frame_x frame_y
  command -v xdotool >/dev/null 2>&1 || {
    log "X11 client origin unavailable: xdotool is not installed (bridge clicks remain available; Radix popovers need a real X11 click)."
    return 0
  }
  command -v xwininfo >/dev/null 2>&1 || {
    log "X11 client origin unavailable: xwininfo is not installed (bridge clicks remain available; Radix popovers need a real X11 click)."
    return 0
  }
  wid="$(DISPLAY="$VERIFY_TAURI_DISPLAY" xdotool search --pid "$VERIFY_TAURI_PID" 2>/dev/null | tail -1)"
  if [ -z "$wid" ]; then
    log "X11 client origin unavailable: no window belongs to verifier pid=$VERIFY_TAURI_PID on display=$VERIFY_TAURI_DISPLAY."
    return 0
  fi
  xwininfo_output="$(DISPLAY="$VERIFY_TAURI_DISPLAY" xwininfo -id "$wid" 2>/dev/null || true)"
  client_x="$(awk '/Absolute upper-left X/{print $4; exit}' <<<"$xwininfo_output")"
  client_y="$(awk '/Absolute upper-left Y/{print $4; exit}' <<<"$xwininfo_output")"
  frame_x="$(DISPLAY="$VERIFY_TAURI_DISPLAY" xdotool getwindowgeometry --shell "$wid" 2>/dev/null | sed -n 's/^X=//p' | head -1)"
  frame_y="$(DISPLAY="$VERIFY_TAURI_DISPLAY" xdotool getwindowgeometry --shell "$wid" 2>/dev/null | sed -n 's/^Y=//p' | head -1)"
  if ! [[ "$client_x" =~ ^-?[0-9]+$ && "$client_y" =~ ^-?[0-9]+$ ]]; then
    log "X11 client origin unavailable: xwininfo returned no numeric client origin for WID=$wid."
    return 0
  fi
  log "X11 verifier window: WID=$wid client_origin=($client_x,$client_y)${frame_x:+ frame_position=($frame_x,$frame_y)}"
  cat >&2 <<X11_HELPER
[verify-tauri-headless] Ready-to-paste REAL X11 click helper (client coordinates; do not use xdotool getwindowgeometry Position):
  WID=$wid
  CLIENT_CX=<x coordinate inside the WebView>
  CLIENT_CY=<y coordinate inside the WebView>
  read OX OY < <(DISPLAY="$VERIFY_TAURI_DISPLAY" xwininfo -id "\$WID" | awk '/Absolute upper-left X/{x=\$4} /Absolute upper-left Y/{y=\$4} END{print x, y}')
  DISPLAY="$VERIFY_TAURI_DISPLAY" xdotool mousemove --sync \$((OX + CLIENT_CX)) \$((OY + CLIENT_CY))
  DISPLAY="$VERIFY_TAURI_DISPLAY" xdotool click 1

  # For controls activated by pointerdown (including Radix Popover), a
  # tauri-agent-tools/DOM synthetic click can stay closed; use the X11 click
  # above, then assert the intended target (document.activeElement/focusin).
X11_HELPER
}
print_x11_client_click_helper

# EI-19930573774744721: every check above (bridge PID alive, origin health 200)
# is silent about WHICH harness slug this instance actually booted into — and
# it boots into whatever slug was last persisted (shared DB/workspace unless
# VERIFY_TAURI_ISOLATED_DB=1), including a peer's disposable throwaway pot with
# zero work items. A "verify at scale" run landing there looks identical to a
# real one: DOM well-formed, health checks green, node/edge counts just happen
# to be zero — only visible to an author who thought to add a floor assertion
# downstream. Print the booted slug + its work-item count here so it is always
# visible in this log instead. Best-effort diagnostic only — never fails the
# boot (every step below is guarded / `|| true`'d).
BOOTED_SLUG_JSON="$("$VERIFY_TAURI_AGENT_TOOLS_BIN" eval --pid "$BRIDGE_PID" "
  (function () {
    try {
      var u = new URL(location.href);
      return JSON.stringify({ slug: u.searchParams.get('slug') || '', ws: u.searchParams.get('ws') || '' });
    } catch (e) {
      return JSON.stringify({ slug: '', ws: '', error: String(e) });
    }
  })()
" 2>/dev/null)" || BOOTED_SLUG_JSON=""
BOOTED_SLUG="$(printf '%s' "$BOOTED_SLUG_JSON" | sed -n 's/.*"slug":"\([^"]*\)".*/\1/p')"
BOOTED_WS="$(printf '%s' "$BOOTED_SLUG_JSON" | sed -n 's/.*"ws":"\([^"]*\)".*/\1/p')"
if [ -n "$BOOTED_SLUG" ] && [[ "$BOOTED_SLUG" =~ ^[A-Za-z0-9_-]+$ ]]; then
  BOOTED_WI_COUNT="unknown"
  if [ -n "${SIDECAR_ADMIN_URL:-}" ]; then
    if [ -n "$BOOTED_WS" ] && [[ "$BOOTED_WS" =~ ^[A-Za-z0-9_-]+$ ]]; then
      BOOTED_WI_COUNT="$(psql "$SIDECAR_ADMIN_URL" -tAc \
        "SELECT count(*) FROM harness_shared.work_items WHERE harness_slug = '${BOOTED_SLUG}' AND workspace_id = '${BOOTED_WS}'" \
        2>/dev/null | tr -d '[:space:]')"
    else
      BOOTED_WI_COUNT="$(psql "$SIDECAR_ADMIN_URL" -tAc \
        "SELECT count(*) FROM harness_shared.work_items WHERE harness_slug = '${BOOTED_SLUG}'" \
        2>/dev/null | tr -d '[:space:]')"
    fi
    [ -n "$BOOTED_WI_COUNT" ] || BOOTED_WI_COUNT="unknown"
  fi
  log "booted slug=${BOOTED_SLUG}${BOOTED_WS:+ ws=$BOOTED_WS} work_items=${BOOTED_WI_COUNT} — if this is a \"verify at scale\" run, make sure your assertions have a floor (EI-19930573774744721)"
else
  log "booted slug=<undetermined from URL> — this instance may have landed on an arbitrary last-persisted pot; a \"verify at scale\" run should pin/check the slug explicitly (EI-19930573774744721)"
fi

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
  │            · PAPERCUSP_HOME · PAPERCUSP_WORKSPACE · WebView profile   │
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
  │                · WebView profile/localStorage                         │
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
"$VERIFY_TAURI_AGENT_TOOLS_BIN" probe --pid "$VERIFY_TAURI_PID" 2>&1 | sed 's/^/[probe] /' >&2 || true

# EI-18805100008031244 (correct-state ask #2, "a TTL on --boot-only itself"):
# an abandoned --boot-only session (the caller died, was compacted, or simply
# forgot) used to run forever — nothing enforced the header's own "NEVER leave
# it running unattended" warning. This TTL watchdog is a SECOND, faster line of
# defence than the external gc-verify-instances sweep (WI-6684, 6h default,
# runs hourly from OUTSIDE the instance) — it fires from INSIDE the instance
# with no dependency on any sweep ever running, and can be refreshed by a
# caller that is legitimately still using it. 0 disables it.
BOOT_ONLY_TTL_MIN="${VERIFY_TAURI_BOOT_ONLY_TTL_MIN:-240}"

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
    wait_owned_ports_free
    # The parent exits after handing this child the open display-lock fd. Keep
    # the reservation until the display and its derived ports are both free.
    display_lock_release ) &
  PORT_LOCK_KEEPER_PID=$!
  write_run_marker "$PORT_LOCK_KEEPER_PID" || {
    echo "FATAL: could not transfer verifier ownership marker to boot-only keeper under $WORK" >&2
    exit 1
  }
  trap - EXIT INT TERM   # caller owns teardown from here
  write_stop_script

  # ── TTL self-watchdog (see the BOOT_ONLY_TTL_MIN comment above) ───────────
  HEARTBEAT_FILE="$WORK/.heartbeat"
  touch "$HEARTBEAT_FILE"
  if [ "$BOOT_ONLY_TTL_MIN" -gt 0 ] 2>/dev/null; then
    ( trap - EXIT INT TERM
      while kill -0 "$XVFB_PID" 2>/dev/null; do
        sleep 60
        hb_epoch="$(stat -c %Y "$HEARTBEAT_FILE" 2>/dev/null || echo 0)"
        hb_age_min=$(( ( $(date +%s) - hb_epoch ) / 60 ))
        if [ "$hb_age_min" -ge "$BOOT_ONLY_TTL_MIN" ]; then
          {
            printf '\n[verify-tauri-headless] TTL watchdog: no heartbeat refresh in %sm (>= %sm) — ' \
              "$hb_age_min" "$BOOT_ONLY_TTL_MIN"
            printf 'self-terminating abandoned --boot-only instance (display :%s, work=%s)\n' \
              "$DISPLAY_NUM" "$WORK"
          } >>"$WORK/watchdog.log" 2>&1
          "$WORK/stop.sh" >>"$WORK/watchdog.log" 2>&1 || true
          exit 0
        fi
      done ) &
    WATCHDOG_PID=$!
  fi

  BOOT_ONLY_ENV="$WORK/env.sh"
  write_boot_only_env_script || exit 1
  # The only stdout contract is this one source command. The env file is
  # private to this run and re-checks caller/target provenance when sourced;
  # no raw export block can be reconstructed from a shared log.
  printf 'source %q\n' "$BOOT_ONLY_ENV"
  cat <<EOF
# TTL watchdog (EI-18805100008031244): this instance self-terminates ${BOOT_ONLY_TTL_MIN} min
# after the last heartbeat refresh (0 = disabled; set VERIFY_TAURI_BOOT_ONLY_TTL_MIN
# before boot to change it). A legitimately long-running session must heartbeat:
#   touch "$WORK/.heartbeat"
# EI-17134: edited apps/operator-vite source AFTER this boot? Run this BEFORE
# trusting a re-check/reload against THIS instance — the SPA snapshot is frozen
# (EI-10364) and will never pick up the edit; this warns loudly if it drifted:
#   bash "$WORK/check-freshness.sh"
# before every tauri-agent-tools eval/check/click/type/capture:
#   bash "$WORK/check-live.sh"
# tear down when done — NEVER leave this running unattended (WI-2115: a
# leaked isolated instance/display starves the next run):
#   "$WORK/stop.sh"
EOF
  cleanup_verifier_source_snapshot
  exit 0
fi

[ "${1:-}" = "--" ] && shift
if [ "$ASSERTION_MODE" -eq 1 ]; then
  set -- "${ASSERTION_ARGS[@]}"
fi

# ── EI-19444780917356384: RUN the freshness guard, don't just advertise it ──
# The frozen SPA snapshot (EI-10364) is immutable by design, so an edit that
# landed after boot is invisible to this run forever. The failure is silent and
# points the WRONG WAY: a verification against a stale snapshot produces a
# clean, well-formed, CONFIDENT "your fix does not work" — indistinguishable in
# every observable respect from a genuine failure. Measured: an edit built at
# 10:58:00 against a snapshot frozen ~10:57 cost a full ~6-minute boot+drive
# cycle and came within one manual grep of sending an agent off to "re-fix"
# already-correct code. The race is structural on this box (the shared build is
# driven by other agents' edits too), not bad luck.
#
# The whole point of this wrapper is that agents don't hand-roll recipes, so a
# guard the CALLER must remember to invoke is the same gap the wrapper exists to
# close. Two checks, deliberately different in force:
#
#   1. DRIFT — advisory. The shared dist moved since our freeze. On this box the
#      fleet rebuilds constantly, so drift alone does NOT mean YOUR change is
#      missing (a peer's unrelated edit moves it too). Hard-failing here would
#      block valid runs, so: warn loudly, and name the decisive check.
#   2. CONTAINMENT — decisive. VERIFY_TAURI_ASSERT_SNAPSHOT_CONTAINS='<a string
#      unique to your change>' greps the FROZEN bundle. Absent ⇒ this run
#      provably cannot exercise your change, so fail FAST with a diagnosis
#      (exit 3, distinct from an assertion failure) instead of letting the
#      assertion emit a confident false negative. This mechanizes the manual
#      grep every agent otherwise has to reinvent mid-debugging.
SNAPSHOT_NEEDLE="${VERIFY_TAURI_ASSERT_SNAPSHOT_CONTAINS:-}"
if [ -n "$SNAPSHOT_NEEDLE" ]; then
  if [ -z "$SPA_DIST" ] || [ ! -d "$SPA_DIST" ]; then
    echo "FATAL: VERIFY_TAURI_ASSERT_SNAPSHOT_CONTAINS was set, but this run froze NO SPA" >&2
    echo "       snapshot (operator-vite was not built at boot), so the claim cannot be" >&2
    echo "       checked. Build operator-vite first, or unset the variable." >&2
    exit 3
  fi
  if grep -rqF -- "$SNAPSHOT_NEEDLE" "$SPA_DIST" 2>/dev/null; then
    log "snapshot containment OK: found '$SNAPSHOT_NEEDLE' in the frozen bundle."
  else
    {
      echo
      echo "  ┌────────────────────────────────────────────────────────────────────────┐"
      echo "  │  ⛔ STALE SNAPSHOT — YOUR CHANGE IS NOT IN THE CODE UNDER TEST          │"
      echo "  │                                                                        │"
      echo "  │  '$SNAPSHOT_NEEDLE'"
      echo "  │  is ABSENT from this run's frozen bundle ($SPA_DIST)."
      echo "  │                                                                        │"
      echo "  │  This run CANNOT exercise your change. Any failure it reports would be"
      echo "  │  a false negative about PRE-EDIT code — refusing to run the assertion"
      echo "  │  rather than hand you a confident wrong answer (EI-19444780917356384)."
      echo "  │                                                                        │"
      echo "  │  Fix: wait for the shared build to emit your change, then re-run this"
      echo "  │  script (the snapshot is frozen at boot — reloading never picks it up)."
      echo "  │  Watch for the rebuild with: ls -t apps/operator-vite/dist/assets/*.js"
      echo "  └────────────────────────────────────────────────────────────────────────┘"
      echo
    } >&2
    exit 3
  fi
elif [ -f "$VERIFY_TAURI_FRESHNESS_CHECK" ] && ! bash "$VERIFY_TAURI_FRESHNESS_CHECK"; then
  # No needle given, so we have no decisive signal — fall back to the advisory
  # DRIFT warning. Deliberately an `elif`: when containment was asserted and
  # PASSED we have already proven the caller's change is in the bundle, and
  # printing a "STALE FROZEN SPA SNAPSHOT" banner on top of that would be both
  # contradictory and — because the fleet's `vite build --watch` rebuilds
  # constantly — near-permanent. A banner that fires on nearly every run is
  # wallpaper within a day, and then nobody reads the one that matters. Keep the
  # loud path rare so it stays legible.
  log "⚠️  DRIFT: the shared SPA dist advanced past this run's frozen snapshot (banner above)."
  log "    Drift alone does NOT prove YOUR change is missing — a peer's edit moves it too."
  log "    To settle it decisively, re-run with a string unique to your change:"
  log "      VERIFY_TAURI_ASSERT_SNAPSHOT_CONTAINS='<your string>' $0 -- <command...>"
fi

verify_assertion_input_integrity || exit $?

log "running assertion command: $*"
"$@"
