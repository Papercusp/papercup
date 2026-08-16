#!/usr/bin/env python3
"""Round-4 Lane E — E1 signal-capture harness (host-side leg).

Emits a perf-signals-v1 JSON snapshot of the host-obtainable round-4 signals so
before/after diffs are apples-to-apples. Read-only; changes nothing. Cron-safe.

Coverage NOTE: the host-side signals (loadavg, service CPUWeight/quota, operator
worker CPU%/RSS, :3070 CLOSE_WAIT, :8788 reachability, kopia cap+healthcheck) are
captured directly here and do NOT depend on the (flaky) operator. The MCP-sourced
signals (per-tool p50/p95/call-rate, PG conn active/idle, biggest tables) are NULL
here and must be merged by an agent run of dev:telemetry / dev:pg_health — keyed by
the same `capturedAt`. Lane F (SLO budgets) consumes the perf-signals-v1 schema.

Usage:  python3 capture-signals.py [--label round4] [--out DIR]
Prints the written path on stdout. No shell=True (no injection surface).
"""
import json, os, re, socket, subprocess, sys, time
import urllib.request
from datetime import datetime, timezone

OUT_DIR = os.path.expanduser("~/.papercusp/perf-baselines")
USER_SERVICES = ["papercup-dev-api", "papercup-bg-host", "papercup-staging-api",
                 "papercup-inference-gateway", "kopia-snapshots", "papercup-vm-mac"]
OPERATOR_CHECKOUT = "papercup-release"   # the :3070 green-main checkout
GATEWAY_PORT = 8788
OPERATOR_PORT = 3070


def run(args):
    """Run argv (no shell) and return stdout; '' on any failure."""
    try:
        return subprocess.run(args, capture_output=True, text=True, timeout=10).stdout.strip()
    except Exception:
        return ""


def loadavg():
    try:
        a, b, c = open("/proc/loadavg").read().split()[:3]
        return {"l1": float(a), "l5": float(b), "l15": float(c), "cores": os.cpu_count()}
    except Exception:
        return {"l1": None, "l5": None, "l15": None, "cores": os.cpu_count()}


def svc_props(name):
    raw = run(["systemctl", "--user", "show", f"{name}.service",
               "-p", "CPUWeight", "-p", "CPUQuotaPerSecUSec", "-p", "Nice",
               "-p", "ActiveState", "-p", "SubState", "-p", "MainPID"])
    d = dict(line.split("=", 1) for line in raw.splitlines() if "=" in line)
    return {"cpuWeight": d.get("CPUWeight"), "cpuQuota": d.get("CPUQuotaPerSecUSec"),
            "nice": d.get("Nice"), "active": d.get("ActiveState"),
            "sub": d.get("SubState"), "mainPid": d.get("MainPID")}


def operator_workers():
    # WI-38449 / perf-testing-sweep P-012: the sample MUST cover the worst worker on
    # EACH budgeted axis, because perf-budgets.ts evaluates two independent budgets over
    # this one array (workerCpuPctWarn AND workerRssKbWarn). Ranking by CPU alone made
    # the RSS budget structurally blind: measured 2026-08-16T11:17Z on a 16-worker
    # SO_REUSEPORT cluster, the true worst-RSS worker (pid 3013854, 3,255,500 KB) was not
    # in the CPU top-8, so the capture reported worst RSS 2,806,996 KB — BELOW the
    # 3,000,000 KB warn threshold while the real value was 448,504 KB ABOVE it. A
    # false-OK, not merely an under-report.
    #
    # Fix: rank on both axes and union. Kept bounded (<=8 per axis, so <=16 rows) and
    # deduped by pid. `maxWorkerCpuPct` / `workersOver100Pct` are maxima/counts over this
    # array, and a superset can only make them more correct, never less.
    out = run(["ps", "-eo", "pid,pcpu,rss,etimes,args", "--sort=-pcpu"])
    rows = []
    for line in out.splitlines():
        if OPERATOR_CHECKOUT in line and ("node" in line or "hono" in line):
            m = re.match(r"\s*(\d+)\s+([\d.]+)\s+(\d+)\s+(\d+)\s+(.*)", line)
            if m:
                rows.append({"pid": int(m.group(1)), "cpuPct": float(m.group(2)),
                             "rssKb": int(m.group(3)), "etimeSec": int(m.group(4))})
    top_by_cpu = sorted(rows, key=lambda r: r["cpuPct"], reverse=True)[:8]
    top_by_rss = sorted(rows, key=lambda r: r["rssKb"], reverse=True)[:8]
    merged, seen = [], set()
    for r in top_by_cpu + top_by_rss:
        if r["pid"] not in seen:
            seen.add(r["pid"])
            merged.append(r)
    return merged


def close_wait(port):
    out = run(["ss", "-tan"])
    n = 0
    for ln in out.splitlines():
        parts = ln.split()
        if len(parts) >= 4 and parts[0] == "CLOSE-WAIT" and parts[3].endswith(f":{port}"):
            n += 1
    return n


def tcp_reachable(port, host="127.0.0.1", timeout=2.0):
    try:
        with socket.create_connection((host, port), timeout=timeout):
            return True
    except Exception:
        return False


def event_loop_lag(port=OPERATOR_PORT, host="127.0.0.1", timeout=3.0):
    """Event-loop lag p95/p99/max (ms) + pressure band, from the operator's own
    deep-health probe.

    THE per-thread saturation signal. perf-budgets.ts warns at p95 >= 250ms and
    raises a deploy-BLOCKING `operator-defect` at >= 1000ms — but it reads this key,
    which was hardcoded None, so BOTH branches were unreachable and every snapshot
    reported the metric as simply absent (P-010, perf-testing-sweep-2026-07-27).

    Host-local unauthenticated GET against 127.0.0.1 — the endpoint needs no token
    and this is the same blast radius as tcp_reachable() above.

    Returns None on ANY failure. That is deliberate: an unreadable signal must stay
    UNMEASURED rather than collapse to a 0 that a budget evaluator would score as a
    perfect pass.
    """
    try:
        with urllib.request.urlopen(f"http://{host}:{port}/api/health/deep", timeout=timeout) as resp:
            if resp.status != 200:
                return None
            lag = json.loads(resp.read().decode("utf-8")).get("loopLag")
    except Exception:
        return None
    if not isinstance(lag, dict) or not isinstance(lag.get("p95Ms"), (int, float)):
        return None
    return {
        "lag_p95_ms": lag.get("p95Ms"),
        "lag_p99_ms": lag.get("p99Ms"),
        "lag_max_ms": lag.get("maxMs"),
        "pressure": lag.get("pressure"),
        "source": f"http://{host}:{port}/api/health/deep",
    }


def kopia():
    q = svc_props("kopia-snapshots")
    hc = run(["systemctl", "--user", "is-failed", "kopia-healthcheck.service"]) or "unknown"
    return {"snapshotCpuQuota": q.get("cpuQuota"), "snapshotCpuWeight": q.get("cpuWeight"),
            "snapshotNice": q.get("nice"), "healthcheckState": hc}


def psi():
    """/proc/pressure/* — kernel Pressure Stall Information. THE host-saturation
    signal on a many-core box: loadavg-absolute lies at 128 cores (see perf-budgets
    header), but psi cpu `some avg60` = %time at least one task STARVED for CPU —
    ratio-free. The 2026-07-10 fs-watch meltdown ran cpu some avg10=96 while every
    naive metric needed interpretation. `full` (all tasks stalled) matters for io/mem."""
    out = {}
    for res in ("cpu", "io", "memory"):
        try:
            d = {}
            for ln in open(f"/proc/pressure/{res}"):
                parts = ln.split()
                kind = parts[0]  # some | full
                vals = dict(p.split("=") for p in parts[1:] if "=" in p)
                d[kind] = {"avg10": float(vals.get("avg10", "nan")),
                           "avg60": float(vals.get("avg60", "nan")),
                           "avg300": float(vals.get("avg300", "nan"))}
            out[res] = d
        except Exception:
            out[res] = None
    return out


def inotify(budget_sec=8.0):
    """Per-uid inotify usage: instances + watches per process, worst offenders,
    kernel limits. The 2026-07-10 meltdown was a silent watch balloon (a recursive
    fs.watch → 94.5k watches × 16 workers); nothing surfaced it before the host
    starved, so agents only saw the symptom (loadavg 1100), never the cause.
    /proc/<pid>/fd is only readable for our own uid — exactly the scope the
    per-uid kernel limits apply to. Bounded by budget_sec; partial=True if hit."""
    deadline = time.monotonic() + budget_sec
    total_inst = total_watch = scanned = 0
    per_proc = []
    partial = False
    try:
        pids = [p for p in os.listdir("/proc") if p.isdigit()]
    except Exception:
        pids = []
    for pid in pids:
        if time.monotonic() > deadline:
            partial = True
            break
        fd_dir = f"/proc/{pid}/fd"
        try:
            fds = os.listdir(fd_dir)
        except Exception:
            continue  # other-uid / vanished
        scanned += 1
        inst = watches = 0
        for fd in fds:
            try:
                if os.readlink(f"{fd_dir}/{fd}") != "anon_inode:inotify":
                    continue
                inst += 1
                with open(f"/proc/{pid}/fdinfo/{fd}") as f:
                    watches += sum(1 for ln in f if ln.startswith("inotify"))
            except Exception:
                continue  # fd vanished mid-scan
        if inst:
            total_inst += inst
            total_watch += watches
            try:
                comm = open(f"/proc/{pid}/comm").read().strip()
            except Exception:
                comm = "?"
            # WI-6538: capture the cgroup so the budget evaluator can tell OUR processes
            # apart from third-party ones. Without it the per-process watch budget warns on
            # whatever holds the most watches host-wide — which on a dev box is the editor
            # (VS Code was found holding 38,937), i.e. a permanent un-actionable amber that
            # trains everyone to ignore perf warnings. cgroup is the principled
            # discriminator here because our own services are confined to papercup-*
            # systemd units and the kernel accounts for every descendant of those roots.
            # Only read for processes that actually hold inotify instances (a few dozen),
            # so this stays cheap.
            try:
                cgroup = open(f"/proc/{pid}/cgroup").read().strip()
            except Exception:
                cgroup = ""
            per_proc.append({"pid": int(pid), "comm": comm, "instances": inst,
                             "watches": watches, "cgroup": cgroup})
    per_proc.sort(key=lambda r: -r["watches"])

    def sysctl_int(name):
        try:
            return int(open(f"/proc/sys/fs/inotify/{name}").read())
        except Exception:
            return None

    return {
        "totalInstances": total_inst,
        "totalWatches": total_watch,
        "maxPerProcess": per_proc[0] if per_proc else None,
        # WI-6538: widened 5 -> 20 so the budget evaluator can reliably find the worst
        # PAPERCUSP-OWNED holder. With only 5, a run where several third-party processes
        # out-watch ours would push ours off the list and silently read as "we hold none".
        # Only a few dozen processes hold inotify instances at all, so 20 is effectively
        # the whole population.
        "topProcs": per_proc[:20],
        "scannedProcs": scanned,
        "partial": partial,
        "limits": {"maxUserWatches": sysctl_int("max_user_watches"),
                   "maxUserInstances": sysctl_int("max_user_instances")},
    }


def session_dirs():
    """Per-session dir populations (session-db-archive-retire-dirs P-007):
    after archive-at-death lands these are capped ~ live-session count; a
    rebound means the exit-hook / hourly reconciler stopped archiving — the
    exact population the 2026-07-10 fs-watch meltdown grew on."""
    home = os.path.expanduser("~")

    def count(p):
        try:
            with os.scandir(p) as it:
                return sum(1 for e in it if e.is_dir(follow_symlinks=False))
        except Exception:
            return None

    return {
        "claudeOwnerDirs": count(os.path.join(home, ".papercusp", "session-claude")),
        "codexHomes": count(os.path.join(home, ".papercusp", "su-codex-homes")),
    }


def _process_identity(pid, proc_root="/proc"):
    """Bounded, privacy-conscious identity for a direct cgroup process.

    Incident scopes can disappear seconds after a capture. Preserve enough of
    the process identity in the same snapshot to diagnose that event later,
    without copying arbitrary command arguments (which may contain prompts or
    credentials). argvPreview therefore keeps argv[0], flag NAMES (never
    ``--flag=value`` values), and existing script paths; inline ``-e``/``-c``
    payloads and free-form arguments are deliberately omitted.
    """
    base = os.path.join(proc_root, str(pid))
    try:
        status = {}
        with open(os.path.join(base, "status")) as f:
            for line in f:
                key, _, value = line.partition(":")
                if key in ("State", "VmRSS", "VmSwap"):
                    status[key] = value.strip()
        with open(os.path.join(base, "comm")) as f:
            comm = f.read().strip()[:80]
        try:
            exe = os.readlink(os.path.join(base, "exe"))[:240]
        except Exception:
            exe = None
        try:
            with open(os.path.join(base, "cmdline"), "rb") as f:
                argv = [part.decode("utf-8", "replace")
                        for part in f.read(4096).split(b"\0") if part]
        except Exception:
            argv = []

        preview = []
        truncated = False
        for index, arg in enumerate(argv):
            if len(preview) >= 3:
                truncated = True
                break
            if index == 0:
                # Chromium/Electron and a few process-title setters rewrite
                # argv[0] into one space-delimited string containing all their
                # valued flags. Treat only its first token as executable
                # identity; `exe` above retains the exact executable path.
                executable_token = arg.split(None, 1)[0] if arg else ""
                preview.append(executable_token[:240])
                truncated = truncated or executable_token != arg or len(executable_token) > 240
                continue
            if arg in ("-e", "--eval", "-c", "--command"):
                preview.append(arg)
                truncated = True
                break
            if arg.startswith("-"):
                flag = arg.split("=", 1)[0]
                preview.append(flag[:120])
                truncated = truncated or "=" in arg or len(flag) > 120
                continue
            if os.path.exists(arg):
                preview.append(arg[:240])
                truncated = truncated or len(arg) > 240
                continue
            # Never persist a free-form positional argument. It may be a user
            # prompt, an inline query, or a credential passed without a flag.
            truncated = True
            break

        def kib(field):
            raw = status.get(field, "")
            match = re.match(r"(\d+)\s+kB$", raw)
            return int(match.group(1)) * 1024 if match else None

        return {
            "pid": pid,
            "comm": comm,
            "exe": exe,
            "state": status.get("State"),
            "rssBytes": kib("VmRSS"),
            "swapBytes": kib("VmSwap"),
            "argvPreview": preview,
            "argvTruncated": truncated,
        }
    except Exception:
        # The process may have exited between cgroup.procs and /proc. The
        # caller records the miss explicitly rather than fabricating identity.
        return None


def cgroup_memory(budget_sec=5.0, max_scanned=4096, top_n=40, root=None,
                  proc_root=None, max_processes_per_cgroup=8):
    """Largest cgroup-v2 memory consumers at capture time.

    PSI tells us *that* the host is thrashing, but not which workload owned the
    memory while it happened. Preserve a bounded, host-wide attribution sample
    in the same snapshot so a self-recovered incident remains diagnosable. Values
    are inclusive of child cgroups (the cgroup-v2 accounting contract), therefore
    paths are retained rather than pretending the rows are additive.

    The walk is capped by both wall time and cgroup count. A busy host must never
    make the two-minute capture timer overlap itself just to collect forensics.
    """
    root = root or os.environ.get("PAPERCUSP_PERF_CGROUP_ROOT", "/sys/fs/cgroup")
    proc_root = proc_root or os.environ.get("PAPERCUSP_PERF_PROC_ROOT", "/proc")
    deadline = time.monotonic() + budget_sec
    rows = []
    scanned = 0
    partial = False

    def read_int(path):
        try:
            return int(open(path).read().strip())
        except Exception:
            return None

    try:
        walker = os.walk(root)
        for dirpath, dirnames, _files in walker:
            # Stable traversal makes a capped/partial sample reproducible.
            dirnames.sort()
            if time.monotonic() > deadline or scanned >= max_scanned:
                partial = True
                break
            current = read_int(os.path.join(dirpath, "memory.current"))
            if current is None:
                continue  # not a cgroup-v2 memory accounting node
            scanned += 1
            if current <= 0:
                continue
            stats = {}
            try:
                with open(os.path.join(dirpath, "memory.stat")) as f:
                    for line in f:
                        key, value = line.split(None, 1)
                        if key in ("anon", "file", "shmem", "kernel", "slab", "sock"):
                            stats[key] = int(value)
            except Exception:
                pass
            try:
                with open(os.path.join(dirpath, "cgroup.procs")) as f:
                    pids = [int(line.strip()) for line in f if line.strip().isdigit()]
                direct_pids = len(pids)
            except Exception:
                pids = []
                direct_pids = None
            direct_processes = []
            unresolved_sampled_pids = 0
            for pid in pids[:max_processes_per_cgroup]:
                identity = _process_identity(pid, proc_root=proc_root)
                if identity is None:
                    unresolved_sampled_pids += 1
                else:
                    direct_processes.append(identity)
            relative = os.path.relpath(dirpath, root)
            rows.append({
                "path": "/" if relative == "." else "/" + relative,
                "memoryBytes": current,
                "swapBytes": read_int(os.path.join(dirpath, "memory.swap.current")),
                "anonBytes": stats.get("anon"),
                "fileBytes": stats.get("file"),
                "shmemBytes": stats.get("shmem"),
                "kernelBytes": stats.get("kernel"),
                "slabBytes": stats.get("slab"),
                "sockBytes": stats.get("sock"),
                "directPids": direct_pids,
                "directProcesses": direct_processes,
                "unresolvedSampledPids": unresolved_sampled_pids,
                "directProcessSampleTruncated": len(pids) > max_processes_per_cgroup,
            })
    except Exception:
        partial = True

    rows.sort(key=lambda row: (-row["memoryBytes"], row["path"]))
    return {
        "accounting": "cgroup-v2-inclusive-descendants",
        "top": rows[:top_n],
        "scannedCgroups": scanned,
        "candidateCgroups": len(rows),
        "maxScanned": max_scanned,
        "maxRows": top_n,
        "maxProcessesPerCgroup": max_processes_per_cgroup,
        "budgetSec": budget_sec,
        "partial": partial,
    }


def host_state(la):
    """stable | loaded | wedge-suspect — pure-local loadavg proxy. An agent run
    should overwrite with the real event-loop-lag verdict when available."""
    if la["l1"] is None or not la["cores"]:
        return "unknown"
    ratio = la["l1"] / la["cores"]
    return "stable" if ratio < 0.7 else "loaded" if ratio < 1.2 else "wedge-suspect"


def main():
    label, out_dir, args = "adhoc", OUT_DIR, sys.argv[1:]
    for i, a in enumerate(args):
        if a == "--label" and i + 1 < len(args):
            label = args[i + 1]
        if a == "--out" and i + 1 < len(args):
            out_dir = args[i + 1]
    os.makedirs(out_dir, exist_ok=True)

    la = loadavg()
    ow = operator_workers()
    # Per-thread admission signal (D-010): the hot operator thread, NOT loadavg.
    # maxWorkerCpuPct + event-loop-lag are P-008's admission inputs (su-7b402 reframe).
    max_worker_cpu = max((w["cpuPct"] for w in ow), default=None)
    workers_over_100 = sum(1 for w in ow if w["cpuPct"] >= 100.0)
    snap = {
        "schemaVersion": "perf-signals-v1",
        "capturedAt": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "label": label,
        "capturedBy": "E1 capture-signals.py (host-side leg)",
        "hostState": host_state(la),
        "signals": {
            "loadavg": la,
            "services": {s: svc_props(s) for s in USER_SERVICES},
            "operatorWorkers": ow,
            "maxWorkerCpuPct": max_worker_cpu,
            "workersOver100Pct": workers_over_100,
            "closeWait_3070": close_wait(OPERATOR_PORT),
            "eventLoopLag": event_loop_lag(OPERATOR_PORT),
            "gateway_8788_reachable": tcp_reachable(GATEWAY_PORT),
            "operator_3070_reachable": tcp_reachable(OPERATOR_PORT),
            "kopia": kopia(),
            "psi": psi(),
            "cgroupMemory": cgroup_memory(),
            "inotify": inotify(),
            "sessionDirs": session_dirs(),
            "_mcp_supplemented": {
                "note": "Fill by an agent run keyed to capturedAt; not host-local.",
                "toolLatency": None, "toolCallRate": None,
                "pgConns": None, "tablesTopBytes": None, "eventLoopLag": None,
            },
        },
    }
    path = os.path.join(out_dir, f"{snap['capturedAt'].replace(':', '')}-{label}.json")
    with open(path, "w") as f:
        json.dump(snap, f, indent=2)
    print(path)


if __name__ == "__main__":
    main()
