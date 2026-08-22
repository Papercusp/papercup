# Clustered operator memory envelope — installation (EI-20340243384897336)

`papercup-dev-api.service.d/55-memory-envelope.conf` is the versioned,
service-wide cgroup policy for the 17-process `:3070` operator. It complements
the in-process memory watchdog: the watchdog recycles one leaking worker, while
`MemoryHigh` / `MemoryMax` / `MemorySwapMax` bound the aggregate cluster.

The drop-in also unsets the old `PAPERCUSP_MEMORY_WATCHDOG_LIMIT_MB=12288`
service override. That variable is process-scoped; after clustering, it allowed
17 independent 12 GiB budgets rather than one 12 GiB service budget. Request
workers fall back to the code's role-aware process limit instead.

## Install (one-time, on the shared development host)

Do not activate this while a green-checkpoint run is in flight: restarting
`papercup-dev-api` also terminates descendants owned by the live checkpoint.
Once the checkpoint singleton has cleared:

```bash
cd "$(git rev-parse --show-toplevel)/apps/operator/scripts/systemd"
mkdir -p ~/.config/systemd/user/papercup-dev-api.service.d
ln -sfn "$(pwd)/papercup-dev-api.service.d/55-memory-envelope.conf" \
  ~/.config/systemd/user/papercup-dev-api.service.d/55-memory-envelope.conf
systemctl --user daemon-reload
```

Use the managed operator restart door after acquiring the registered
`dev-server` resource lock; never raw-restart a shared service around peers.

## Verify

```bash
systemctl --user show papercup-dev-api.service \
  -p MemoryAccounting -p MemoryHigh -p MemoryMax -p MemorySwapMax -p Environment
systemd-analyze --user verify papercup-dev-api.service
```

Expected effective limits are `MemoryHigh=48G`, `MemoryMax=64G`, and
`MemorySwapMax=16G`, with no `PAPERCUSP_MEMORY_WATCHDOG_LIMIT_MB` in the unit's
effective environment. Verify `:3070` health and the 17-process cluster after
the managed restart; a configured drop-in is not proof the running cgroup
loaded it.

---

# LLM testing nightly cron — installation

Plan §12 Phase 5.

## Install (one-time, ~3 minutes)

```bash
# 1. Symlink the unit + timer into the user systemd dir.
ln -sf "$(pwd)/llm-test-nightly.service" ~/.config/systemd/user/
ln -sf "$(pwd)/llm-test-nightly.timer"   ~/.config/systemd/user/

# 2. Expose ANTHROPIC_API_KEY to systemd-user. Either:
#    a. Edit the .service file's `# Environment=...` line, or
#    b. Drop a file at ~/.config/environment.d/anthropic.conf:
#       ANTHROPIC_API_KEY=sk-ant-...

# 3. Reload systemd-user and enable.
systemctl --user daemon-reload
systemctl --user enable --now llm-test-nightly.timer
```

## Verify

```bash
systemctl --user list-timers llm-test-nightly.timer
systemctl --user status   llm-test-nightly.service
```

## Manual run

```bash
systemctl --user start llm-test-nightly.service
journalctl --user -u llm-test-nightly.service -f
```

Or run the script directly:

```bash
./llm-test-nightly.sh
```

Logs land in `~/.papercusp/llm-test-logs/llm-test-<TS>.log`.

## What it does

Hits `papercusp-desktop`'s operator at `$PAPERCUSP_OPERATOR_URL`
(default `http://127.0.0.1:3055`). If the operator isn't reachable
the script exits 0 and you'll see "operator not reachable — skipping"
in the journal — better than firing a noisy failure when the laptop
is closed.

Otherwise it runs `pnpm llm-test --target operator --target oracle`
which exercises every registered scenario (15 today). Findings land
in `harness_shared.llm_test_findings` with `acknowledged=false`. New
errors surface in `/admin/testing?tab=llm&subtab=findings` — that's
the alert surface; no separate notification system needed.

The script also runs a small SQL summary at the end (passed / failed
/ errored counts per target, total cost) into the log.

## Cost envelope

Per the plan §9 cost math:
- 12 operator scenarios + 3 oracle scenarios = 15 scenarios
- Average matrix N=3 for judge-heavy scenarios (most are)
- Sonnet SUT + Sonnet judge: ~$1.50–2.50 per matrix
- Nightly total: ~$25–40 / run = ~$750–$1200 / month

Tighten by:
- Editing `LLM_TEST_TARGETS` in the .service to drop oracle
- Setting `LLM_TEST_SUT_MODEL=claude-haiku-4-5` to use Haiku for SUT
  (judges still Sonnet for cross-model bias mitigation)
- Switching the timer to `OnCalendar=Mon` (weekly instead of nightly)

## Tighten the cron cadence

Edit the `.timer` file's `OnCalendar=` line:
- `OnCalendar=*-*-* 03:30:00` — nightly at 03:30 (default)
- `OnCalendar=Mon *-*-* 03:30:00` — weekly Mondays
- `OnCalendar=*-*-* 09,21:00:00` — twice a day at 09:00 + 21:00

After editing: `systemctl --user daemon-reload && systemctl --user restart llm-test-nightly.timer`.

---

# perf-signals capture — installation

The host-side producer for the perf-signals-v1 SLO/CLOSE_WAIT guard
(`packages/operator-core/lib/system-health/perf-budgets.ts`, consumed by the infra
health panel AND the green-checkpoint perf-gate). Runs the read-only host probe
`../perf/capture-signals.py` on a 2-min cadence so the latest capture never goes
stale (`staleMs` = 10 min) and the budgets keep evaluating live. Without it the
guard silently degrades to `unknown` — the WI-324 finding (the capture had gone 62h
stale because nothing scheduled it). Deliberately a systemd timer, NOT a DBOS
scheduled workflow / in-process tick (dev-box host signals = infra monitoring, and a
per-tick DBOS workflow_status row is the high-freq bloat that froze the engine —
EI-1622 / dbos-scheduler-consolidation D-004).

## Install (one-time)

```bash
ln -sf "$(pwd)/papercup-perf-signals-capture.service" ~/.config/systemd/user/
ln -sf "$(pwd)/papercup-perf-signals-capture.timer"   ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now papercup-perf-signals-capture.timer
```

## Verify

```bash
systemctl --user list-timers papercup-perf-signals-capture.timer
# newest capture should be < 2 min old:
ls -t ~/.papercusp/perf-baselines/*-scheduled.json | head -1
```

The wrapper (`../perf/capture-perf-signals.sh`) prunes to the newest 15
`*-scheduled.json` files (~30 min of history); ad-hoc/manual captures (other labels)
are never touched. If the timer dies, a capture older than `blindMs` (30 min) surfaces
on the infra panel as `warn` ("host SLO monitor blind") instead of silent `unknown`.

---

# Resilient MCP proxy — installation (OPT-IN)

`papercup-mcp-proxy.service` runs an always-up local proxy on `:9071` that forwards to
`:3070/api/mcp` and RETRIES across a `:3070` deploy restart (mcp-host-availability-resilience-2026-06-22
P-005). Point an MCP client (Claude Code) at the proxy and a `:3070` restart becomes
invisible — the client→proxy connection stays up, and a `tools/call` issued mid-restart
just waits a beat instead of erroring + stranding the session toolless. Code: `../../bin/mcp-proxy.ts`
+ `../../lib/mcp-proxy/proxy.ts` (tested: `proxy.test.ts`).

SAFETY: the proxy RETRIES only a *refused* upstream (the request provably never reached
`:3070`), never a post-connect error — so a non-idempotent `tools/call` is never double-applied.

## Install + run the proxy (harmless on its own — nothing connects until you repoint a client)

```bash
ln -sf "$(pwd)/papercup-mcp-proxy.service" ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now papercup-mcp-proxy.service
# verify passthrough:
curl -s http://127.0.0.1:9071/api/health   # → the real :3070 health JSON
```

## Repoint a client at the proxy (the actual opt-in — ATTENDED cutover)

In `~/.claude.json`, change the `papercusp-su` server URL host:port from `localhost:3070`
to `localhost:9071` (keep the `?superuser=1&...` query + the bearer). Or set the psu
launcher's MCP URL env. Then VERIFY restart-survival before trusting it: force a `:3070`
deploy/restart (`PAPERCUSP_ALLOW_DEV_RESTART=1 npx tsx apps/operator/lib/release/deploy-cli.ts --execute`)
and confirm an in-flight agent's native MCP tools keep working (no toolless session, no
relaunch). Leave the default config on `:3070` until that e2e passes — this is a fleet-wide
cutover, so the owner should green-light + attend it.

---

# Leaked-webview reaper — installation (WI-345 F12)

`papercup-webkit-reaper.{service,timer}` reaps runaway `WebKitWebProcess`
instances and stale `papercusp-desktop` processes left behind by agents
that spawned Tauri desktop sessions for UI verification and didn't clean up.

**Root cause:** When a Tauri desktop is killed (SIGKILL from an agent
finishing a task, a crash, or `tauri dev` watcher rebuilding), its
WebKitWebProcess children (managed by WebKitGTK) become orphans reparented
to PID 1. They continue spinning at 99% CPU on dead connections. Five of
these plus zombies caused visible CPU saturation on the shared dev box.

**Safety:** The reaper protects the NEWEST papercusp-desktop process (the
active user session). All older instances running > 30 min are stale test
instances. Orphaned WebKitWebProcess (ppid=1) older than 5 min are always
safe — their parent is definitively dead.

## Install (one-time)

```bash
cd /home/dev/papercupai-workspace/papercusp/apps/operator/scripts/systemd
ln -sf "$(pwd)/papercup-webkit-reaper.service" ~/.config/systemd/user/
ln -sf "$(pwd)/papercup-webkit-reaper.timer"   ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now papercup-webkit-reaper.timer
```

## Verify

```bash
systemctl --user list-timers papercup-webkit-reaper.timer
systemctl --user status papercup-webkit-reaper.service
```

## Manual run / dry-run

```bash
# Dry run (logs what it would kill without touching anything):
WEBKIT_REAPER_DRY_RUN=1 /home/dev/papercupai-workspace/papercusp/bin/reap-leaked-webviews.sh

# Live run:
systemctl --user start papercup-webkit-reaper.service
journalctl --user -u papercup-webkit-reaper.service --since "1 min ago"
```

## Tune thresholds

```bash
# Reap orphans older than 2 min (default 5 min):
WEBKIT_REAPER_ORPHAN_THRESHOLD=120 ./bin/reap-leaked-webviews.sh

# Protect stale desktops longer (default 30 min):
WEBKIT_REAPER_DESKTOP_STALE=3600 systemctl --user start papercup-webkit-reaper.service
```

---

# Orphaned-vitest-worker reaper — installation (EI-18686031108193522)

`papercup-vitest-orphan-reaper.{service,timer}` reaps orphaned vitest fork-pool
worker processes (`node_modules/vitest/dist/workers/{forks,vmForks}.js`) left
behind when the vitest CLI process that owns them is SIGKILLed — a
harness/heavy-command timeout, an admission-guard abort, a `run_in_background`
task reaped, or an agent session ending mid-suite. SIGKILL can't be trapped, so
the parent gets no chance to tear its worker pool down; the workers are
reparented to this host's subreaper (`systemd --user`, confirmed via /proc —
not always PID 1) and simply sit there, forever. Measured 2026-07-26: 8 such
workers alive 24h+, up to 6.7 days, ~600MB combined RSS, each reading 0.0% CPU
— a pure memory/process-table leak, NOT a load contributor (see the filed
issue for why that distinction matters).

**Safety:** a worker is a reap candidate only if its cmdline names a
`forks.js`/`vmForks.js` entrypoint. Its real PPID is read from `/proc`, and if
that parent is alive AND its own cmdline mentions `vitest` (a legitimately
still-running suite), the worker is left alone regardless of age — this is
mirrored from `reap-leaked-webviews.sh`'s live-parent check, not a bare
`ppid==1` test. Only orphans older than the age threshold (default 5 min) are
reaped, TERM first then KILL after a grace period.

**Detection + reaping only** — this does not (and cannot) patch vitest's own
worker entrypoints to self-exit on parent death (`PR_SET_PDEATHSIG`): those
files live in `node_modules` and are overwritten by every `npm install`, so
any patch would be silently lost. A sweeper is the durable side of this fix,
mirroring the webkit reaper's own precedent of reaping rather than patching a
vendored dependency's internals.

## Install (one-time)

```bash
cd /home/dev/papercupai-workspace/papercusp/apps/operator/scripts/systemd
ln -sf "$(pwd)/papercup-vitest-orphan-reaper.service" ~/.config/systemd/user/
ln -sf "$(pwd)/papercup-vitest-orphan-reaper.timer"   ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now papercup-vitest-orphan-reaper.timer
```

## Verify

```bash
systemctl --user list-timers papercup-vitest-orphan-reaper.timer
systemctl --user status papercup-vitest-orphan-reaper.service
```

## Manual run / dry-run

```bash
# Dry run (logs what it would kill without touching anything):
VITEST_REAPER_DRY_RUN=1 /home/dev/papercupai-workspace/papercusp/bin/reap-orphaned-vitest-workers.sh

# Live run:
systemctl --user start papercup-vitest-orphan-reaper.service
journalctl --user -u papercup-vitest-orphan-reaper.service --since "1 min ago"
```

## Tune thresholds

```bash
# Reap orphans older than 60s (default 300s = 5 min):
VITEST_REAPER_ORPHAN_THRESHOLD=60 ./bin/reap-orphaned-vitest-workers.sh
```

---

# Stale-testvm reaper — installation (EI-18792610532592319)

`papercup-testvm-reaper.{service,timer}` reaps orphaned `papercusp-testvm-*`
QEMU VMs (the `linux-test-vm` rig's `clean`/`fed-a`/`fed-b`/`updater`/ad-hoc
instances — `scripts/linux-test-vm/boot-vm.sh`) left running past an age
threshold. Each VM is launched `-daemonize`'d, detaching from its own launcher
immediately on boot; `vm-federation.sh`/`fed.sh` already `trap cleanup EXIT`,
but a trap can't fire if the launching process is SIGKILLed (a harness
timeout, an admission-guard abort, an agent session ending mid-run), leaving
the VM orphaned and burning real CPU/RAM indefinitely. Measured 2026-07-27:
two `fed-{a,b}` frames alive 13.6h/16.6h, ~1300% combined CPU, contributing to
a sustained load1 ~85-90 that made `test:affected` auto-degrade into
flake-absorbing retry fleet-wide (EI-9103) — a correctness cost to the whole
fleet's verification, not just a speed cost.

**Safety:** a VM is a reap candidate only if its cmdline carries
`-name papercusp-testvm-<X>` — the exact marker `boot-vm.sh` stamps on every
VM it boots. This can **never** match the persistent mac (:2222) / Windows
(:2223) build-and-test VMs (`papercup-vm-mac.service` / the Windows VM
service): they're launched by a different script with no `-name` flag at all,
and are explicitly owner-sanctioned to stay running indefinitely (memory
648ac99a — do not delete their images, do not uninstall their services). The
reaper's selftest reproduces both VMs' real cmdline shapes to guard this.
Before reaping anything it also scans for a LIVE orchestrator process
(`vm-federation.sh`, `fed.sh`, `live-federation-gate.sh`,
`two-instance-federation-smoke.sh`) — if one is running, the whole sweep is
skipped that tick, erring toward never touching another agent's in-flight
infrastructure. Only a candidate older than the age threshold (default 6h —
well past the live-federation-gate's own 4h `TimeoutStartSec` bound) is
reaped, via `vmctl down <name>` (graceful in-guest poweroff, then SIGTERM,
then SIGKILL — the same escalation `vmctl down` already uses), with a hard
per-attempt timeout and a direct-kill fallback if `vmctl` itself can't run.

**Detection + reaping only** — this does not (and cannot) make a SIGKILLed
launcher's `trap cleanup EXIT` fire; a sweeper is the durable second line of
defense for exactly that case, mirroring `papercup-vitest-orphan-reaper`'s own
precedent for the same underlying class of problem (a process-spawning
workflow with no teardown guarantee against an abrupt parent death).

The first line of defense is now in `scripts/linux-test-vm/boot-vm.sh` itself:
every disposable `papercusp-testvm-*` QEMU starts inside a regular, escaped,
named transient systemd scope. The scope derives a reclaim threshold and hard ceiling from the
existing `PAPERCUSP_TESTVM_RAM_MB` guest-RAM setting (default 16 GiB → 20 GiB
`MemoryHigh`, 24 GiB `MemoryMax`, 8 GiB `MemorySwapMax`). This preserves QEMU's
pidfile/daemonized lifecycle and `vmctl down`, while preventing a young or
abandoned test VM from consuming unbounded host memory during the reaper's
deliberate six-hour safety window. Startup fails closed when the user systemd
manager cannot apply the envelope; it never silently falls back to unbounded
QEMU. The focused regression check validates both the hermetic launch argv and,
when a user manager is reachable, real transient-unit name/property acceptance:

```bash
bash papercusp-desktop/scripts/linux-test-vm/resource-control.selftest.sh
```

## Install (one-time)

```bash
cd /home/dev/papercupai-workspace/papercusp/apps/operator/scripts/systemd
ln -sf "$(pwd)/papercup-testvm-reaper.service" ~/.config/systemd/user/
ln -sf "$(pwd)/papercup-testvm-reaper.timer"   ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now papercup-testvm-reaper.timer
```

## Verify

```bash
systemctl --user list-timers papercup-testvm-reaper.timer
systemctl --user status papercup-testvm-reaper.service
```

## Manual run / dry-run

```bash
# Dry run (logs what it would reap without touching anything):
TESTVM_REAPER_DRY_RUN=1 /home/dev/papercupai-workspace/papercusp/bin/reap-stale-testvms.sh

# Live run:
systemctl --user start papercup-testvm-reaper.service
journalctl --user -u papercup-testvm-reaper.service --since "5 min ago"
```

## Tune thresholds

```bash
# Reap VMs older than 1h (default 21600s = 6h):
TESTVM_REAPER_MAX_AGE_SECS=3600 ./bin/reap-stale-testvms.sh
```

## Self-test

```bash
bash bin/reap-stale-testvms.selftest.sh
```

---

# Isolated-DHT liveness probe — installation (EI-8892)

`papercup-isolated-dht-liveness.{service,timer}` runs a REAL 2-swarm hyperswarm
announce/connect probe (`../p2p-dht-liveness-probe.mjs`, wrapped by
`../papercup-dht-liveness-check.sh`) against `papercup-isolated-dht.service`'s
bootstrap node every 5 minutes and files an EI on failure.

**Root cause this catches:** the isolated DHT testnet can WEDGE (unit stays
`ActiveState=active`, the bootstrap node stops actually routing DHT traffic)
with ZERO passive signal — `systemctl is-active` sees nothing wrong, and
hyperswarm rides UDX/UDP so `ss`/`netstat` show nothing useful either. This
class wedged silently for 3 days (2026-07-06→07-09, cross-machine federation
dead the whole time) before being caught by a hand-rolled probe. The ONLY
reliable health signal is "did a second swarm actually receive a `connection`
event within a timeout" — join()/flush() resolving is not enough (both can
succeed against a wedged bootstrap).

**Detection + escalation ONLY — this unit never restarts
`papercup-isolated-dht.service`.** A health check that reads a signal spanning
process restarts must not also hold restart authority over that process, or a
boot-grace bug turns into a restart-storm (EI-8901's lesson: a
freshly-restarted unit that hasn't had time to become live yet gets repeatedly
killed by its own check). The wrapper script has its own `DHT_BOOT_GRACE_SEC`
(default 120s) skip for exactly this reason. Recovery (`systemctl --user
restart papercup-isolated-dht.service`) is a human/agent call made off the
filed EI, not something this script does automatically.

## Install (one-time)

```bash
cd /home/dev/papercupai-workspace/papercusp/apps/operator/scripts/systemd
ln -sf "$(pwd)/papercup-isolated-dht-liveness.service" ~/.config/systemd/user/
ln -sf "$(pwd)/papercup-isolated-dht-liveness.timer"   ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now papercup-isolated-dht-liveness.timer
```

## Verify

```bash
systemctl --user list-timers papercup-isolated-dht-liveness.timer
systemctl --user status papercup-isolated-dht-liveness.service
# last successful probe (epoch seconds):
cat ~/.papercusp/dht-liveness/last-ok
```

## Manual run / dry-run

```bash
# Run the probe directly against a given bootstrap (bypasses unit resolution):
node apps/operator/scripts/p2p-dht-liveness-probe.mjs --host 172.31.44.1 --port 49838

# Run the full wrapper (resolves host/port from the live unit) without filing an EI:
DHT_NO_FILE=1 bash apps/operator/scripts/papercup-dht-liveness-check.sh

# Force it through systemd (files a real EI on failure):
systemctl --user start papercup-isolated-dht-liveness.service
journalctl --user -u papercup-isolated-dht-liveness.service --since "5 min ago"
```

## Tune thresholds

```bash
# Probe connect-timeout (default 15000ms):
DHT_PROBE_TIMEOUT_MS=20000 bash apps/operator/scripts/papercup-dht-liveness-check.sh

# Boot-grace before judging a freshly-(re)started unit (default 120s, EI-8901):
DHT_BOOT_GRACE_SEC=180 bash apps/operator/scripts/papercup-dht-liveness-check.sh

# RED-EI dedup window — file once per still-wedged condition, not every 5-min
# tick (default 12h; mirrors papercup-live-federation-gate.sh's RED_REFILE_H):
DHT_RED_REFILE_H=6 bash apps/operator/scripts/papercup-dht-liveness-check.sh

# Staleness — no successful probe at all for this long files a louder, separate
# EI (the signal itself may be dark, default 6h):
DHT_STALE_H=3 bash apps/operator/scripts/papercup-dht-liveness-check.sh
```

---

# Fed-plane disk-health probe — installation (EI-8982)

`papercup-fedplane-disk-health.{service,timer}` (Linux) /
`com.papercusp.fedplane-disk-health.plist` (macOS, under `../launchd/`) runs
`../papercup-fedplane-disk-health-check.sh` every 5 minutes on any fed-plane
host and files an EI when either (a) disk usage on the papercusp data volume
crosses a threshold (default 90%) or (b) `serve.log` carries an ENOSPC /
crash-loop signature.

**Root cause this catches:** a fed-plane machine's disk can fill silently
until total wedge — no disk monitor, no ENOSPC alert, no health surface
existed before this probe. 2026-07-10 (P-059 live-rig cause #9): a Mac VM's
Data volume hit 100% (43Mi free); `~/.papercusp/operator.lock` writes failed
ENOSPC, serve spawns crash-looped (~25s connect-cycles), and the ONLY visible
symptom was on the PEER machine — a mysterious connect/drop cycle with zero
local signal. Diagnosis took cross-machine correlation; the fix itself was
trivial (freed 30G of a stale cargo target dir). This probe (and the
companion note added to `replication-liveness.ts`'s `connected_never_replicated`
alert body) exists so the next occurrence is caught locally within minutes,
and a zombie-connection alert on the OTHER machine now points investigators
at peer host-health as a likely cause.

**Detection + escalation ONLY** — same posture as the DHT liveness probe
above: this script never deletes files or restarts anything. Recovery
(freeing space, restarting a wedged serve process) is a human/agent call made
off the filed EI.

## Install — Linux (systemd --user)

```bash
cd /home/dev/papercupai-workspace/papercusp/apps/operator/scripts/systemd
ln -sf "$(pwd)/papercup-fedplane-disk-health.service" ~/.config/systemd/user/
ln -sf "$(pwd)/papercup-fedplane-disk-health.timer"   ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now papercup-fedplane-disk-health.timer
```

Verify: `systemctl --user list-timers papercup-fedplane-disk-health.timer`,
`journalctl --user -u papercup-fedplane-disk-health.service --since "5 min ago"`.

## Install — macOS (launchd, e.g. the Mac VM)

```bash
mkdir -p ~/Library/LaunchAgents
cd /path/to/papercusp/apps/operator/scripts/launchd
# Edit the plist's ProgramArguments REPO_ROOT placeholder + the HOME env var
# to this machine's actual checkout/home before installing:
sed -e "s#/REPO_ROOT#$(cd ../../../.. && pwd)#" \
    -e "s#__REPLACE_WITH_HOME__#$HOME#" \
    com.papercusp.fedplane-disk-health.plist > ~/Library/LaunchAgents/com.papercusp.fedplane-disk-health.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.papercusp.fedplane-disk-health.plist
launchctl enable gui/$(id -u)/com.papercusp.fedplane-disk-health
```

Verify: `launchctl print gui/$(id -u)/com.papercusp.fedplane-disk-health`,
`tail -f /tmp/papercup-fedplane-disk-health.log`.

## Manual run / dry-run (either platform)

```bash
# Log-only, no EI filed:
DISK_NO_FILE=1 bash apps/operator/scripts/papercup-fedplane-disk-health-check.sh

# Point at a specific volume / serve.log (e.g. testing without installing):
DISK_PATH=/Volumes/Data SERVE_LOG=/path/to/serve.log DISK_NO_FILE=1 \
  bash apps/operator/scripts/papercup-fedplane-disk-health-check.sh
```

## Tune thresholds

```bash
# Disk-usage warn threshold (default 90%):
DISK_WARN_PCT=85 bash apps/operator/scripts/papercup-fedplane-disk-health-check.sh

# ENOSPC/crash-loop signature count in the log tail before alarming (default 5):
CRASH_LOOP_MIN_COUNT=3 bash apps/operator/scripts/papercup-fedplane-disk-health-check.sh

# RED-EI dedup window (default 12h, mirrors the DHT probe's DHT_RED_REFILE_H):
DISK_RED_REFILE_H=6 bash apps/operator/scripts/papercup-fedplane-disk-health-check.sh
```

---

# Postgres backup + offsite kopia — the EXECUTION units (EI-12028)

`papercusp-db-backup.{timer,service}` (hourly `pg_dump -Fd -j` per database, EI-10733),
`papercusp-db-backup-alert.service` (its `OnFailure=` handler), `kopia-snapshots.{timer,service}`
(30-min offsite ship of the dumps via kopia), and `kopia-healthcheck.{timer,service}` (15-min
dump-freshness/snapshot-recency probe, a BACKSTOP to `papercup-backup-health.{timer,service}`
above — see its own header comment for why two checks exist and how they're kept from
disagreeing).

**Why these are here:** until EI-12028, these 7 unit files existed ONLY as regular files in
`~/.config/systemd/user/` — no repo copy, unlike `papercup-backup-health.{timer,service}` (the
detection layer, already symlinked). A machine re-provision restored the health PROBE (repo,
symlinked) but silently lost backup EXECUTION entirely — broken-but-detected is still broken.
Relocated here and re-symlinked, mirroring every other unit in this directory, so the whole
backup stack re-materializes on a fresh machine.

**Snapshot scripts are canonical here now.** Plan
`serialize-and-slow-kopia-backups-2026-08-20` completed the deferred relocation for
`snapshot-all.sh`, `home-snapshot.sh`, and `healthcheck.sh`. Their installed paths remain under
`~/.config/kopia/`, but those paths are symlinks to the versioned files here. One versioned
`kopia-backup-guard.sh` owns the global flock: hot scheduled work takes it non-blocking and
defers when memory full PSI is at least 5 or I/O full PSI is at least 10; daily home/VM and
protected/manual work wait for it. The default lock is the host-global
`/run/lock/papercusp/kopia-global.lock`, intentionally outside `XDG_RUNTIME_DIR` so a
root-launched maintenance task and the user-level systemd services cannot enter separate
effective-UID namespaces. The dedicated non-sticky subdirectory avoids the host's
`fs.protected_regular` denial when root opens a user-created file in sticky `/run/lock`; the guard
creates the directory and lock with shared-write permissions for either identity.
`KOPIA_BACKUP_LOCK_PATH` remains available for isolated tests or an explicitly managed deployment.
`kopia-protected-snapshot.sh SOURCE...` is the supported manual entrypoint. The remaining
`db-backup.sh` and `backup-alert.sh` scripts are still managed under `~/.config/kopia/` and are
outside this snapshot-serialization contract.

## Install (one-time, on a fresh machine)

```bash
cd /home/dev/papercupai-workspace/papercusp/apps/operator/scripts/systemd
for f in papercusp-db-backup.timer papercusp-db-backup.service papercusp-db-backup-alert.service \
         kopia-snapshots.timer kopia-snapshots.service \
         kopia-healthcheck.timer kopia-healthcheck.service \
         kopia-home-snapshot.timer kopia-home-snapshot.service; do
  ln -sf "$(pwd)/$f" ~/.config/systemd/user/
done
mkdir -p ~/.config/kopia
ln -sf "$(pwd)/kopia-backup-guard.sh" ~/.config/kopia/kopia-backup-guard.sh
ln -sf "$(pwd)/kopia-snapshot-all.sh" ~/.config/kopia/snapshot-all.sh
ln -sf "$(pwd)/kopia-home-snapshot.sh" ~/.config/kopia/home-snapshot.sh
ln -sf "$(pwd)/kopia-healthcheck.sh" ~/.config/kopia/healthcheck.sh
ln -sf "$(pwd)/kopia-protected-snapshot.sh" ~/.config/kopia/kopia-protected-snapshot.sh
systemctl --user daemon-reload
systemctl --user enable --now papercusp-db-backup.timer kopia-snapshots.timer \
  kopia-healthcheck.timer kopia-home-snapshot.timer
```

You must still recreate `~/.config/kopia/db-backup.sh` and `backup-alert.sh` on a new machine;
those two scripts are not version-controlled. The Kopia snapshot, home/VM, healthcheck, global
guard, and supported protected/manual entrypoints are restored by the symlinks above.

## Manual/protected snapshot

Never invoke `sudo kopia snapshot create` directly. The supported command waits for the same
global lock used by both timers:

```bash
~/.config/kopia/kopia-protected-snapshot.sh /path/to/source [/another/source]
```

The hot timer intentionally runs every 30 minutes. `healthcheck.sh` uses a 60-minute snapshot
staleness bar, which allows one missed/deferred cycle plus runtime and timer jitter.

## Mandatory post-restore recovery sweep

Restoring `/home` or `/etc` restores unit files on disk, but it does not repair the systemd
manager's in-memory state. A timer can therefore remain failed/inactive with `Result=resources`
(`Unit to trigger vanished`) even after its file is back, and `Persistent=true` cannot catch up
until the timer is started again. After every restore that touched `/home`, run the versioned
sweep below before declaring the host recovered:

```bash
cd "$(git rev-parse --show-toplevel)/apps/operator/scripts/systemd"
bash ./papercusp-systemd-restore-recovery.sh --scope user
```

The sweep runs `systemctl --user daemon-reload`, `systemctl --user reset-failed`, then starts
every `enabled` or `enabled-runtime` timer that is not active. Disabled timers and already-active
timers are left alone. It exits non-zero if the manager cannot be reloaded or any enabled timer
cannot be started, so a failed recovery cannot be mistaken for a successful restore.

If `/etc` was restored, recover the system manager too (root may be required):

```bash
sudo bash ./papercusp-systemd-restore-recovery.sh --scope system
```

If both trees were restored, one invocation covers both managers:

```bash
bash ./papercusp-systemd-restore-recovery.sh --scope both
```

## Verify

```bash
systemctl --user list-timers papercusp-db-backup.timer kopia-snapshots.timer kopia-healthcheck.timer
systemctl --user cat kopia-snapshots.service kopia-home-snapshot.service
bash ~/.config/kopia/healthcheck.sh --self-test
journalctl --user -u papercusp-db-backup.service --since "2 hours ago"
cat /mnt/data/Backup/db-dumps/STATUS.json
```

---

# Shared embedding sidecar — WI-4021 (relocated here EI-19380773834961669)

`papercup-embed-sidecar.service` is the ONE supervised owner of the shared
embedding + rerank sidecar on `127.0.0.1:3384`, plus its companion
`papercup-embed-sidecar-watchdog.{service,timer}` (60s `/healthz` probe that
restarts the unit if the event loop wedges) and the drop-in
`papercup-embed-sidecar.service.d/98-embed-concurrency.conf` (bounded embed
concurrency: 2 slots x intraOp 4 threads = exactly the unit's 800% CPUQuota).

**Why these are here:** identical reasoning to the backup units above — these 4
files existed ONLY as regular files in `~/.config/systemd/user/`, with no repo
copy, so a machine re-provision would silently lose them. That is worse here
than for most units: since WI-4021 clients **REQUIRE** the sidecar (the
in-process embedder fallback was retired), losing it does not degrade memory and
search, it **stops** them. Relocated + symlinked mirroring every other unit in
this directory; the three files other than the `.service` were verified
byte-identical (`diff -q`) before symlinking, and `daemon-reload` was confirmed
not to restart the running sidecar (MainPID unchanged).

**The one behavioral change made during the relocation** was adding `rerank` to
the boot-warm set (see the unit's own header comment for the full rationale):

```
Environment=PAPERCUSP_EMBED_SIDECAR_WARM=gemma,harrier,rerank
```

The boot-warm RERANKER set is parsed from that same env and defaults to none, so
this search-serving host had been bringing the ~150M cross-encoder up cold on
every restart and paying the load inside the first `/rerank` caller's budget.

## Install (one-time, on a fresh machine)

```bash
cd "$(git rev-parse --show-toplevel)/apps/operator/scripts/systemd"
for f in papercup-embed-sidecar.service \
         papercup-embed-sidecar-watchdog.service papercup-embed-sidecar-watchdog.timer; do
  ln -sfn "$(pwd)/$f" ~/.config/systemd/user/
done
mkdir -p ~/.config/systemd/user/papercup-embed-sidecar.service.d
ln -sfn "$(pwd)/papercup-embed-sidecar.service.d/98-embed-concurrency.conf" \
        ~/.config/systemd/user/papercup-embed-sidecar.service.d/
systemctl --user daemon-reload
systemctl --user enable --now papercup-embed-sidecar.service papercup-embed-sidecar-watchdog.timer
```

The unit resolves the home directory via systemd's `%h` specifier (matching
`papercup-mcp-proxy.service`), so it is portable across users. It does still
assume the checkout lives at `~/papercupai-workspace/papercusp` and that node
comes from linuxbrew — re-point `WorkingDirectory=` / `PATH=` on a host where
either differs.

## Verify

```bash
systemctl --user show papercup-embed-sidecar.service -p MainPID -p ActiveState
systemctl --user show papercup-embed-sidecar.service -p Environment   # expect WARM=gemma,harrier,rerank
curl -s http://127.0.0.1:3384/healthz | jq '{models, capabilities, rerankExecution}'
```

`capabilities` lists every route THIS BUILD serves — it is the honest test for
"does this sidecar do reranking", NOT the presence of a warm reranker in
`models`. Note the entry is esbuild-bundled by `ExecStartPre` on **every**
start, so a restart always picks up current staging source; a long-lived sidecar
can therefore be running a build many days older than the tree (measured
2026-08-02: a 16.9-day-old process serving no `/rerank` route at all).
