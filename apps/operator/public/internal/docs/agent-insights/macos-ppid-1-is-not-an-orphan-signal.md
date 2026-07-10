# On macOS, PPID==1 is NOT an orphan signal — a trap for boot-time process sweeps
URL: /internal/docs/agent-insights/macos-ppid-1-is-not-an-orphan-signal

Why a "reparented to PID 1" heuristic for detecting orphaned child processes is safe on Linux/systemd but actively dangerous on macOS/launchd, with a live-verified near-miss and the corrected pattern.

## The assumption that breaks

On Linux (or any systemd-managed target), a process whose PPID is `1` (init)
is a reliable, nearly-unambiguous signal that its real parent died and the
kernel reparented it — a classic "orphan" you can safely sweep. It's tempting
to reuse that exact heuristic on macOS for a boot-time "clean up anything my
last hard-killed instance left running" sweep.

**On macOS this assumption is wrong.** `launchd` is the standard, NORMAL
supervisory parent for an entire class of process — any LaunchAgent /
LaunchDaemon / login-item-launched app — not just an orphan-reaper. A
perfectly healthy, currently-running app launched that way shows `PPID==1`
from the moment it starts, for its entire lifetime. It is never a signal that
something died.

## The near-miss (WI-3633, 2026-07-09)

Building a boot-time orphan sweep for the Papercusp desktop's operator
sidecar, the first design was: scan the process table for anything with
`PPID==1` whose command line matched the sidecar's entry point
(`serve.mjs`), and kill its process group.

Live verification against `papercup-vm-mac` (a real running instance, not a
sandbox) immediately found the trap: **multiple simultaneously-running,
completely healthy `serve.mjs` processes all had `PPID==1` at once** — the
actively-in-use operator (kept alive by the app's own `serve --ensure`
"Decision C" reuse semantics: a fresh app instance that finds a live prior
operator reuses it instead of spawning a competitor) *and* an unrelated
per-environment sidecar, both legitimately parented to launchd.

A blind `PPID==1` sweep would have killed a live, in-use, healthy operator
the moment a fresh app instance booted — turning a minor zombie-cleanup
feature into a much worse "boot always kills your work" regression.

## The corrected pattern

Never use process-table SHAPE (`PPID==1`, or any other purely structural
signal) as a kill trigger by itself. Instead, key off:

1. **An authoritative tracking record** the process itself writes — a
   discovery/lock file naming its own pid (here: `operator.json`, already
   used by the existing `find_operator_discovery` / `wait_for_operator`
   machinery).
2. **A genuine liveness/health check** — not just "does the pid exist" but
   "is it actually doing its job" (here: `operator_http_ready`, an HTTP probe
   the app already trusted elsewhere).

Only kill when the tracked pid is **alive at the OS level but NOT
responding** — that combination is what actually distinguishes a genuinely
wedged/zombie leftover from either "already dead, nothing to do" or "alive
and fine, leave it alone." See `sweep_stale_operator_orphan` +
`decide_orphan_sweep` in `papercusp-desktop/src-tauri/src/main.rs` (WI-3633)
for the shipped implementation — `decide_orphan_sweep` is a pure decision
function (`(discovery, pid_alive, http_ready) -> OrphanSweepDecision`) kept
separate from the OS-facing calls specifically so this branch logic is
unit-testable and its four outcomes (`NothingRecorded` / `AlreadyDead` /
`HealthyReuse` / `StaleKill`) are pinned by tests — `HealthyReuse` in
particular exists exactly to name and protect the case this near-miss found.

## Takeaway

If you're writing a boot-time / periodic sweep that kills processes based on
their position in the process tree, and the target platform is macOS (or any
other launchd-adjacent supervisor), **verify your detection logic against a
REAL running instance before trusting it** — a heuristic that's completely
sound on Linux can be silently, catastrophically wrong there. Prefer a
tracking-record + liveness-check design over any raw parent-child shape
signal.
