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
import json, os, re, socket, subprocess, sys
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
    out = run(["ps", "-eo", "pid,pcpu,rss,etimes,args", "--sort=-pcpu"])
    rows = []
    for line in out.splitlines():
        if OPERATOR_CHECKOUT in line and ("node" in line or "hono" in line):
            m = re.match(r"\s*(\d+)\s+([\d.]+)\s+(\d+)\s+(\d+)\s+(.*)", line)
            if m:
                rows.append({"pid": int(m.group(1)), "cpuPct": float(m.group(2)),
                             "rssKb": int(m.group(3)), "etimeSec": int(m.group(4))})
    return rows[:8]


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


def kopia():
    q = svc_props("kopia-snapshots")
    hc = run(["systemctl", "--user", "is-failed", "kopia-healthcheck.service"]) or "unknown"
    return {"snapshotCpuQuota": q.get("cpuQuota"), "snapshotCpuWeight": q.get("cpuWeight"),
            "snapshotNice": q.get("nice"), "healthcheckState": hc}


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
            "gateway_8788_reachable": tcp_reachable(GATEWAY_PORT),
            "operator_3070_reachable": tcp_reachable(OPERATOR_PORT),
            "kopia": kopia(),
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
