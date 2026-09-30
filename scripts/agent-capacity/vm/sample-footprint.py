#!/usr/bin/env python3
"""Sample the CPU and memory of every process in one systemd cgroup, as JSON lines.

Plan agent-capacity-and-cost-gcp-2026-09-30, S7 (WI-10004395): the Papercusp Server's own
footprint on a cloud VM, split by process class (supervisor, operator node, postgres, git,
...), so the capacity numbers can subtract the fixed per-VM overhead from the per-agent cost.

Runs ON the test VM (stock python3, no dependencies). Output, one JSON object per line:

  {"header": {...}}                       first line: clock tick, cores, RAM, cgroup path
  {"t": <epoch s>, "cg": {...}, "procs": [...]}   one line per sample

`cg.cpu_usec` is the cgroup's own cumulative CPU counter (exact, includes processes that
lived and died between two samples); per-process `ticks` (utime+stime) only cover processes
seen at both ends of an interval. `footprint-summary.ts` turns this into rates.
"""
import argparse
import json
import os
import socket
import sys
import time


def read(path, default=None):
    try:
        with open(path, "r") as f:
            return f.read()
    except OSError:
        return default


def cgroup_pids(root):
    pids = []
    for dirpath, _dirs, files in os.walk(root):
        if "cgroup.procs" in files:
            body = read(os.path.join(dirpath, "cgroup.procs"), "")
            pids.extend(int(p) for p in body.split() if p.strip().isdigit())
    return sorted(set(pids))


def classify(comm, argv):
    """Map a process to a stable class name for per-class totals."""
    exe = os.path.basename(argv[0]) if argv else comm
    if comm.startswith("postgres") or exe == "postgres":
        return "postgres"
    if exe == "papercusp-server" or comm.startswith("papercusp-serv"):
        return "supervisor"
    if exe == "node" or comm == "node" or comm.startswith("MainThread"):
        # The script is the first positional arg; skip the VALUE of flags that take one
        # (`node --require preload.js serve.mjs` is serve.mjs, not preload.js).
        takes_value = {"-r", "--require", "--import", "--loader", "--experimental-loader", "-e", "--eval"}
        script, skip = "", False
        for a in argv[1:]:
            if skip:
                skip = False
            elif a in takes_value:
                skip = True
            elif not a.startswith("-"):
                script = a
                break
        return "node:" + (os.path.basename(script) or "?")
    if exe == "git" or comm.startswith("git"):
        return "git"
    return comm or exe or "?"


def proc_sample(pid):
    stat = read(f"/proc/{pid}/stat")
    if stat is None:
        return None
    # comm may contain spaces or parens: everything after the LAST ')' is positional.
    rparen = stat.rfind(")")
    comm = stat[stat.find("(") + 1 : rparen]
    fields = stat[rparen + 2 :].split()
    # fields[0] is state (field 3); utime/stime are fields 14/15 -> indexes 11/12.
    ppid = int(fields[1])
    ticks = int(fields[11]) + int(fields[12])
    rss_kb = anon_kb = 0
    for line in (read(f"/proc/{pid}/status", "") or "").splitlines():
        if line.startswith("VmRSS:"):
            rss_kb = int(line.split()[1])
        elif line.startswith("RssAnon:"):
            anon_kb = int(line.split()[1])
    raw = read(f"/proc/{pid}/cmdline", "") or ""
    argv = [a for a in raw.split("\0") if a]
    return {
        "pid": pid,
        "ppid": ppid,
        "comm": comm,
        "cls": classify(comm, argv),
        "rss_kb": rss_kb,
        "anon_kb": anon_kb,
        "ticks": ticks,
    }


def cgroup_sample(root):
    out = {}
    mem = read(os.path.join(root, "memory.current"))
    if mem is not None:
        out["mem"] = int(mem.strip())
    for line in (read(os.path.join(root, "memory.stat"), "") or "").splitlines():
        key, _, val = line.partition(" ")
        if key in ("anon", "file", "kernel", "shmem"):
            out[key] = int(val)
    for line in (read(os.path.join(root, "cpu.stat"), "") or "").splitlines():
        key, _, val = line.partition(" ")
        if key == "usage_usec":
            out["cpu_usec"] = int(val)
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--cgroup", required=True, help="cgroup v2 directory, e.g. /sys/fs/cgroup/...")
    ap.add_argument("--interval", type=float, default=10.0)
    ap.add_argument("--duration", type=float, required=True, help="seconds to sample")
    ap.add_argument("--out", required=True)
    ap.add_argument("--label", default="")
    args = ap.parse_args()
    if not os.path.isdir(args.cgroup):
        print(f"cgroup {args.cgroup} does not exist", file=sys.stderr)
        return 2
    mem_total_kb = 0
    for line in (read("/proc/meminfo", "") or "").splitlines():
        if line.startswith("MemTotal:"):
            mem_total_kb = int(line.split()[1])
    header = {
        "host": socket.gethostname(),
        "label": args.label,
        "cgroup": args.cgroup,
        "clk_tck": os.sysconf("SC_CLK_TCK"),
        "nproc": os.cpu_count(),
        "mem_total_kb": mem_total_kb,
        "interval": args.interval,
        "started": time.time(),
    }
    deadline = time.monotonic() + args.duration
    with open(args.out, "a", buffering=1) as f:
        f.write(json.dumps({"header": header}) + "\n")
        while True:
            t = time.time()
            procs = [p for p in (proc_sample(pid) for pid in cgroup_pids(args.cgroup)) if p]
            f.write(json.dumps({"t": t, "cg": cgroup_sample(args.cgroup), "procs": procs}) + "\n")
            if time.monotonic() >= deadline:
                break
            time.sleep(max(0.0, args.interval - (time.time() - t)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
