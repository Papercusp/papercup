#!/usr/bin/env python3
"""Swap-tier test driver (WI-10005475, plan agent-capacity-and-cost-gcp-2026-09-30).

Question (owner directives #1858 / #1864): if parked agents' memory is pushed into swap, how fast
do they wake, how responsive does the machine stay, and which swap tier makes that acceptable?
The 2 Oct runs (D-041) showed swap stores nothing unless memory is forced out, so this test forces
it: every parked agent's cgroup is drained with `memory.reclaim`, then the agent is woken.

Agents are real interactive `claude` TUIs in tmux, each in its own systemd scope under
swaptier.slice, talking to swap-tier-stub-api.py, so replies are instant and the VM holds no
credentials. Each agent first builds a history of real tool results (WARM prompts).

  swap-tier.py bench-disk --device /dev/disk/by-id/google-swapbal --label pd-balanced --out DIR
  swap-tier.py run --out DIR --agents 24 --warm 8 --single 8 \\
      --arm none --arm zram --arm pd-balanced=/dev/disk/by-id/google-swapbal ...
  swap-tier.py report --out DIR            (also runs at the end of `run`)

Per arm: swap device on -> reclaim every agent (one at a time, like parking) -> drop page cache ->
idle IDLE_SEC (does an idle TUI page itself back?) -> wake --single agents one at a time ->
wake the rest at once (storm) -> settle -> record what is still in swap -> swapoff.
A wake is: type a prompt (t0), see it echoed (agent awake and rendering), press Enter, see the
reply rendered. A probe (`probe`) times fork+exec of /bin/true and timer oversleep every 100 ms
throughout, as the "is the desktop still responsive" signal.

Every measurement is one JSON line in DIR/results.jsonl; `report` reduces them to DIR/summary.json
and a markdown table. Lines to grep: SWAPTIER <kind>.
Run as root (cgroup writes, swapon); the agents run as --user (claude refuses bypass mode as root).
"""
import argparse
import errno
import glob
import json
import os
import statistics
import subprocess
import sys
import time

SLICE = "swaptier"
CG_ROOT = "/sys/fs/cgroup/swaptier.slice"
TMUX = ["tmux", "-L", "swaptier"]
PORT = 8899
KEY = "swaptier-stub-not-a-real-credential-000000"
IDLE_SEC = int(os.environ.get("SWAPTIER_IDLE_SEC", "60"))
WAKE_TIMEOUT = float(os.environ.get("SWAPTIER_WAKE_TIMEOUT", "300"))
HERE = os.path.dirname(os.path.abspath(__file__))


# ---------------------------------------------------------------- measurement helpers

def read_int(path):
    try:
        with open(path) as f:
            return int(f.read().strip())
    except (OSError, ValueError):
        return None


def read_kv(path):
    out = {}
    try:
        with open(path) as f:
            for line in f:
                parts = line.split()
                if len(parts) >= 2:
                    try:
                        out[parts[0].rstrip(":")] = int(parts[1])
                    except ValueError:
                        pass
    except OSError:
        pass
    return out


def cg_path(name):
    return f"{CG_ROOT}/{SLICE}-{name}.scope"


def agent_stats(name):
    cg = cg_path(name)
    st = read_kv(cg + "/memory.stat")
    return {"current": read_int(cg + "/memory.current"), "swap": read_int(cg + "/memory.swap.current"),
            "anon": st.get("anon"), "file": st.get("file"), "majflt": st.get("pgmajfault")}


def host_stats():
    vm = read_kv("/proc/vmstat")
    mi = read_kv("/proc/meminfo")
    out = {"pswpin": vm.get("pswpin"), "pswpout": vm.get("pswpout"), "pgmajfault": vm.get("pgmajfault"),
           "memAvailableKb": mi.get("MemAvailable"), "swapUsedKb": (mi.get("SwapTotal", 0) - mi.get("SwapFree", 0))}
    try:
        with open("/sys/block/zram0/mm_stat") as f:
            mm = f.read().split()
        out["zram"] = {"orig": int(mm[0]), "compr": int(mm[1]), "used": int(mm[2])}
    except (OSError, IndexError, ValueError):
        pass
    return out


def sh(cmd, check=True):
    r = subprocess.run(cmd, text=True, capture_output=True)
    if check and r.returncode != 0:
        raise RuntimeError(f"{' '.join(cmd)} failed ({r.returncode}): {r.stderr.strip()}")
    return r


def write(path, value):
    with open(path, "w") as f:
        f.write(value)


class Recorder:
    def __init__(self, out_dir):
        os.makedirs(out_dir, exist_ok=True)
        self.f = open(os.path.join(out_dir, "results.jsonl"), "a")

    def rec(self, kind, **kw):
        row = {"t": time.time(), "kind": kind, **kw}
        self.f.write(json.dumps(row) + "\n")
        self.f.flush()
        print(f"SWAPTIER {kind} {json.dumps(kw)[:400]}", flush=True)


# ---------------------------------------------------------------- tmux / agents

def pane(name, lines=80):
    r = subprocess.run(TMUX + ["capture-pane", "-p", "-t", name, "-S", f"-{lines}"], text=True, capture_output=True)
    return r.stdout if r.returncode == 0 else ""


def type_text(name, text):
    subprocess.run(TMUX + ["send-keys", "-t", name, "-l", text], check=True)


def press_enter(name):
    subprocess.run(TMUX + ["send-keys", "-t", name, "Enter"], check=True)


def start_agents(n, user, rec):
    home = f"/home/{user}"
    claude = f"{home}/.local/bin/claude"
    cfg_path = f"{home}/.claude.json"
    cfg = {}
    if os.path.exists(cfg_path):
        with open(cfg_path) as f:
            cfg = json.load(f)
    cfg.update({"hasCompletedOnboarding": True, "theme": "dark", "numStartups": 5, "autoUpdates": False,
                "bypassPermissionsModeAccepted": True,
                "customApiKeyResponses": {"approved": [KEY[-20:]], "rejected": []}})
    projects = cfg.setdefault("projects", {})
    names = [f"a{k}" for k in range(1, n + 1)]
    for name in names:
        work = f"{home}/work/{name}"
        os.makedirs(work, exist_ok=True)
        sh(["chown", f"{user}:{user}", work])
        projects[work] = {"hasTrustDialogAccepted": True, "hasCompletedProjectOnboarding": True, "allowedTools": []}
    with open(cfg_path, "w") as f:
        json.dump(cfg, f)
    os.makedirs(f"{home}/.claude", exist_ok=True)
    with open(f"{home}/.claude/settings.json", "w") as f:
        json.dump({"skipDangerousModePermissionPrompt": True}, f)
    sh(["chown", "-R", f"{user}:{user}", cfg_path, f"{home}/.claude"])
    env = (f"env -i HOME={home} USER={user} LOGNAME={user} PATH={home}/.local/bin:/usr/bin:/bin TERM=tmux-256color "
           f"LANG=C.UTF-8 ANTHROPIC_BASE_URL=http://127.0.0.1:{PORT} ANTHROPIC_API_KEY={KEY} DISABLE_AUTOUPDATER=1 "
           "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 DISABLE_TELEMETRY=1 DISABLE_ERROR_REPORTING=1")
    for name in names:
        cmd = (f"systemd-run --scope --quiet --unit={SLICE}-{name} --slice={SLICE} -p MemoryAccounting=yes -- "
               f"setpriv --reuid={user} --regid={user} --init-groups -- {env} {claude} --dangerously-skip-permissions")
        sh(TMUX + ["new-session", "-d", "-s", name, "-x", "160", "-y", "50", "-c", f"{home}/work/{name}", cmd])
        time.sleep(1.0)
    deadline = time.time() + 180
    pending = set(names)
    while pending and time.time() < deadline:
        for name in list(pending):
            if "bypass permissions on" in pane(name):
                pending.discard(name)
        time.sleep(0.5)
    if pending:
        raise RuntimeError(f"agents never became ready: {sorted(pending)}; first pane:\n{pane(sorted(pending)[0])}")
    rec.rec("agents-started", agents=len(names))
    return names


def prompt_all(names, marker_for, prompt_for, timeout, on_done=None):
    """Type a prompt into every agent, press Enter once its echo shows, wait for DONE-<marker>.

    Returns {name: {t0, tEcho, tEnter, tDone}} (None where a step never happened)."""
    state = {}
    for name in names:
        state[name] = {"t0": time.time(), "tEcho": None, "tEnter": None, "tDone": None}
        type_text(name, prompt_for(name))
    deadline = time.time() + timeout
    while time.time() < deadline and any(s["tDone"] is None for s in state.values()):
        for name, s in state.items():
            if s["tDone"] is not None:
                continue
            text = pane(name)
            if s["tEnter"] is None:
                if marker_for(name) in text:
                    s["tEcho"] = time.time()
                    press_enter(name)
                    s["tEnter"] = time.time()
            elif "DONE-" + marker_for(name) in text:
                s["tDone"] = time.time()
                if on_done:
                    on_done(name, s)
        time.sleep(0.02)
    return state


def warm(names, rounds, rec):
    for k in range(rounds):
        state = prompt_all(names, lambda n: f"WARM-{n}-{k}", lambda n: f"Please do step WARM-{n}-{k} now", 300)
        missing = [n for n, s in state.items() if s["tDone"] is None]
        if missing:
            raise RuntimeError(f"warm round {k} never finished for {missing}")
    rec.rec("warmed", rounds=rounds, agents={n: agent_stats(n) for n in names})


def stub_request_times(stub_log, marker):
    """Arrival time of the main request for a marker: the one carrying the most messages."""
    best = None
    try:
        with open(stub_log) as f:
            for line in f:
                try:
                    row = json.loads(line)
                except ValueError:
                    continue
                if row.get("marker") == marker and (best is None or row.get("messages", 0) >= best.get("messages", 0)):
                    best = row
    except OSError:
        return None
    return best["t"] if best else None


# ---------------------------------------------------------------- swap arms

def parse_arm(spec):
    """`none` | `zram` | `<label>=<block device>`."""
    if spec in ("none", "zram"):
        return {"name": spec, "kind": spec}
    label, sep, device = spec.partition("=")
    if not sep or not label or not device:
        raise ValueError(f"--arm expects none, zram or <label>=<device>, got '{spec}'")
    return {"name": label, "kind": "device", "device": device}


def swap_off():
    sh(["swapoff", "-a"], check=False)
    if os.path.exists("/sys/block/zram0"):
        sh(["zramctl", "--reset", "/dev/zram0"], check=False)


def swap_on(arm, ram_gb):
    if arm["kind"] == "none":
        return None
    if arm["kind"] == "zram":
        sh(["modprobe", "zram"])
        dev = sh(["zramctl", "--find", "--size", f"{ram_gb}G", "--algorithm", "zstd"]).stdout.strip()
        sh(["mkswap", dev])
        sh(["swapon", "-p", "100", dev])
        write("/proc/sys/vm/page-cluster", "0")  # zram: no swap-in readahead (the common zram setting)
        return dev
    sh(["mkswap", "-f", arm["device"]])
    sh(["swapon", "-p", "100", arm["device"]])
    write("/proc/sys/vm/page-cluster", "3")  # kernel default: 8-page swap-in clusters
    return arm["device"]


def reclaim(name):
    """Drain one agent's cgroup into swap; returns seconds spent."""
    cg = cg_path(name)
    t0 = time.time()
    for _ in range(8):
        cur = read_int(cg + "/memory.current")
        if cur is None or cur < (4 << 20):
            break
        try:
            write(cg + "/memory.reclaim", str(cur))
        except OSError as e:
            if e.errno != errno.EAGAIN:
                raise
            # EAGAIN: it reclaimed less than asked; one more pass rarely moves more.
            if read_int(cg + "/memory.current") >= cur * 0.95:
                break
    return time.time() - t0


def run_arm(arm, names, single, ram_gb, rec, stub_log):
    swap_off()
    device = swap_on(arm, ram_gb)
    rec.rec("arm-start", arm=arm["name"], device=device, host=host_stats(), agents={n: agent_stats(n) for n in names})
    if arm["kind"] != "none":
        rec.rec("phase", arm=arm["name"], phase="reclaim", edge="start")
        for name in names:
            before = agent_stats(name)
            secs = reclaim(name)
            rec.rec("reclaimed", arm=arm["name"], agent=name, seconds=secs, before=before, after=agent_stats(name))
        write("/proc/sys/vm/drop_caches", "1")
        rec.rec("phase", arm=arm["name"], phase="reclaim", edge="end", host=host_stats())
        before_idle = {n: agent_stats(n) for n in names}
        rec.rec("phase", arm=arm["name"], phase="idle", edge="start")
        time.sleep(IDLE_SEC)
        rec.rec("idle", arm=arm["name"], seconds=IDLE_SEC, before=before_idle, after={n: agent_stats(n) for n in names},
                host=host_stats())
        rec.rec("phase", arm=arm["name"], phase="idle", edge="end")
    nonce = f"{arm['name'].replace('-', '')[:6]}{int(time.time()) % 100000}"

    def wake(group, phase):
        pre = {n: agent_stats(n) for n in group}
        host_pre = host_stats()
        rec.rec("phase", arm=arm["name"], phase=phase, edge="start")
        state = prompt_all(group, lambda n: f"WAKE-{nonce}{n}", lambda n: f"Wake up WAKE-{nonce}{n} please", WAKE_TIMEOUT)
        rec.rec("phase", arm=arm["name"], phase=phase, edge="end")
        time.sleep(2)
        for n in group:
            s = state[n]
            rec.rec("wake", arm=arm["name"], phase=phase, agent=n, **s,
                    tRequest=stub_request_times(stub_log, f"WAKE-{nonce}{n}"), pre=pre[n], post=agent_stats(n))
        rec.rec("wake-host", arm=arm["name"], phase=phase, pre=host_pre, post=host_stats())

    for n in names[:single]:
        wake([n], "single")
        time.sleep(1)
    wake(names[single:], "storm")
    time.sleep(20)
    rec.rec("arm-end", arm=arm["name"], host=host_stats(), agents={n: agent_stats(n) for n in names})
    t0 = time.time()
    swap_off()
    rec.rec("swapoff", arm=arm["name"], seconds=time.time() - t0)


# ---------------------------------------------------------------- disk benchmark

FIO_JOBS = [
    ("randread-4k-qd1", ["--rw=randread", "--bs=4k", "--iodepth=1"]),
    ("randread-4k-qd32", ["--rw=randread", "--bs=4k", "--iodepth=32"]),
    ("randread-32k-qd16", ["--rw=randread", "--bs=32k", "--iodepth=16"]),
    ("randwrite-4k-qd32", ["--rw=randwrite", "--bs=4k", "--iodepth=32"]),
    ("seqread-1m-qd8", ["--rw=read", "--bs=1m", "--iodepth=8"]),
]


def fio_summary(job, fio_json):
    j = fio_json["jobs"][0]
    side = j["read"] if j["read"]["io_bytes"] else j["write"]
    pct = side.get("clat_ns", {}).get("percentile", {})
    return {"job": job, "iops": round(side["iops"]), "mbps": round(side["bw_bytes"] / 1e6, 1),
            "clatP50us": round(pct.get("50.000000", 0) / 1000, 1), "clatP99us": round(pct.get("99.000000", 0) / 1000, 1)}


def bench_disk(device, label, out_dir, runtime):
    rec = Recorder(out_dir)
    base = ["fio", "--name=b", f"--filename={device}", "--ioengine=libaio", "--direct=1", "--size=4G", "--output-format=json"]
    # Prefill the tested region: reads of never-written PD blocks are not a real measurement.
    sh(base + ["--rw=write", "--bs=1m", "--iodepth=16"])
    for job, args in FIO_JOBS:
        r = sh(base + args + ["--time_based", f"--runtime={runtime}"])
        rec.rec("fio", device=label, **fio_summary(job, json.loads(r.stdout)))


# ---------------------------------------------------------------- report

def pctl(xs, p):
    xs = sorted(x for x in xs if x is not None)
    if not xs:
        return None
    return xs[min(len(xs) - 1, int(p / 100 * len(xs)))]


def mib(b):
    return None if b is None else round(b / 2**20, 1)


def regained(before, after):
    """Bytes of anonymous memory an agent got back in RAM between two samples.

    Measured as growth of resident anon, never as a drop in swap-used. On a disk swap device
    the kernel keeps a page's swap slot after reading it back (swap cache), so swap-used barely
    moves while the agent pages itself back in: measured 14 Oct 2026, idle agents on pd-ssd
    regained ~1.1 GiB of resident memory while swap-used fell 74 MiB. zram frees the slot on
    read, so there the two agree. Resident growth also counts memory the agent newly allocates;
    the `none` arm (nothing in swap) measures that baseline, about 3 MiB per wake.
    """
    return max(0, (after["anon"] or 0) - (before["anon"] or 0))


def summarize(rows, probe):
    """Reduce results.jsonl rows (+ probe samples [(t, exec_ms, oversleep_ms)]) to per-arm numbers."""
    arms = {}
    phases = {}
    for r in rows:
        a = r.get("arm")
        if a is None:
            continue
        s = arms.setdefault(a, {"arm": a, "reclaimed": [], "wakes": {"single": [], "storm": []}})
        k = r["kind"]
        if k == "arm-start":
            s["device"] = r.get("device")
        elif k == "reclaimed":
            s["reclaimed"].append(r)
        elif k == "idle":
            s["idleRegainedMiB"] = mib(sum(regained(r["before"][n], r["after"][n]) for n in r["before"]))
        elif k == "wake":
            s["wakes"][r["phase"]].append(r)
        elif k == "arm-end":
            s["swapAfterMiB"] = mib(sum(v["swap"] or 0 for v in r["agents"].values()))
            s["residentAfterMiB"] = mib(sum(v["anon"] or 0 for v in r["agents"].values()))
            zr = r["host"].get("zram")
            if zr:
                s["zramEnd"] = zr
        elif k == "phase" and r.get("edge") in ("start", "end"):
            phases.setdefault((a, r["phase"]), {})[r["edge"]] = r["t"]
        elif k == "phase" and r.get("phase") == "reclaim":
            pass
        if k == "phase" and r.get("phase") == "reclaim" and r.get("edge") == "end":
            zr = r.get("host", {}).get("zram")
            if zr:
                s["zramAfterReclaim"] = {"origMiB": mib(zr["orig"]), "comprMiB": mib(zr["compr"]), "usedMiB": mib(zr["used"]),
                                         "ratio": round(zr["orig"] / zr["used"], 2) if zr["used"] else None}
    out = []
    for a, s in arms.items():
        rc = s["reclaimed"]
        res = {"arm": a, "device": s.get("device")}
        if rc:
            swapped = [r["after"]["swap"] or 0 for r in rc]
            res["reclaim"] = {
                "agents": len(rc),
                "beforeMiBPerAgent": mib(statistics.mean(r["before"]["current"] or 0 for r in rc)),
                "swappedMiBPerAgent": mib(statistics.mean(swapped)),
                "residentAfterMiBPerAgent": mib(statistics.mean(r["after"]["current"] or 0 for r in rc)),
                "seconds": round(sum(r["seconds"] for r in rc), 1),
                "swapOutMiBps": round(mib(sum(swapped)) / max(0.001, sum(r["seconds"] for r in rc)), 1),
            }
            res["idleRegainedMiB"] = s.get("idleRegainedMiB")
            res["zram"] = s.get("zramAfterReclaim")
        for ph in ("single", "storm"):
            ws = s["wakes"][ph]
            if not ws:
                continue
            total = [(w["tDone"] - w["t0"]) if w.get("tDone") else None for w in ws]
            echo = [(w["tEcho"] - w["t0"]) if w.get("tEcho") else None for w in ws]
            submit = [(w["tDone"] - w["tEnter"]) if w.get("tDone") and w.get("tEnter") else None for w in ws]
            back = [regained(w["pre"], w["post"]) for w in ws]
            majflt = [max(0, (w["post"]["majflt"] or 0) - (w["pre"]["majflt"] or 0)) for w in ws]
            block = {"agents": len(ws), "failed": sum(1 for t in total if t is None),
                     "totalSec": {"p50": _r(pctl(total, 50)), "p90": _r(pctl(total, 90)), "max": _r(pctl(total, 100))},
                     "echoSec": {"p50": _r(pctl(echo, 50)), "max": _r(pctl(echo, 100))},
                     "submitToReplySec": {"p50": _r(pctl(submit, 50)), "max": _r(pctl(submit, 100))},
                     "regainedMiBPerAgent": mib(statistics.mean(back)),
                     "majfltPerAgent": round(statistics.mean(majflt))}
            if ph == "storm":
                done = [w["tDone"] for w in ws if w.get("tDone")]
                block["allDoneSec"] = _r(max(done) - min(w["t0"] for w in ws)) if len(done) == len(ws) else None
            win = phases.get((a, ph), {})
            samples = [p for p in probe if win.get("start") is not None and win.get("end") is not None and win["start"] <= p[0] <= win["end"]]
            if samples:
                block["probeExecMs"] = {"p50": _r(pctl([p[1] for p in samples], 50)), "p99": _r(pctl([p[1] for p in samples], 99)),
                                        "max": _r(pctl([p[1] for p in samples], 100)), "samples": len(samples)}
            res[ph] = block
        res["swapAfterStormMiB"] = s.get("swapAfterMiB")
        res["residentAfterStormMiB"] = s.get("residentAfterMiB")
        out.append(res)
    return out


def _r(x):
    return None if x is None else round(x, 3)


def load_probe(path):
    out = []
    try:
        with open(path) as f:
            for line in f:
                parts = line.strip().split(",")
                if len(parts) == 3:
                    try:
                        out.append((float(parts[0]), float(parts[1]), float(parts[2])))
                    except ValueError:
                        pass
    except OSError:
        pass
    return out


def report(out_dir):
    rows = []
    with open(os.path.join(out_dir, "results.jsonl")) as f:
        for line in f:
            try:
                rows.append(json.loads(line))
            except ValueError:
                pass
    arms = summarize(rows, load_probe(os.path.join(out_dir, "probe.csv")))
    fio = [{k: v for k, v in r.items() if k not in ("t", "kind")} for r in rows if r.get("kind") == "fio"]
    summary = {"arms": arms, "fio": fio}
    with open(os.path.join(out_dir, "summary.json"), "w") as f:
        json.dump(summary, f, indent=2)
    print("SWAPTIER_SUMMARY " + json.dumps(summary))
    return summary


# ---------------------------------------------------------------- probe

def probe(out_path):
    with open(out_path, "a") as f:
        while True:
            t = time.time()
            subprocess.run(["/bin/true"])
            e = time.time() - t
            s = time.time()
            time.sleep(0.1)
            o = time.time() - s - 0.1
            f.write(f"{t:.3f},{e * 1000:.2f},{o * 1000:.2f}\n")
            f.flush()


# ---------------------------------------------------------------- main

def run(a):
    rec = Recorder(a.out)
    arms = [parse_arm(s) for s in a.arm]
    stub_log = os.path.join(a.out, "stub.jsonl")
    warm_files = sorted(glob.glob("/usr/lib/python3*/*.py"), key=os.path.getsize, reverse=True)[:16]
    procs = [
        subprocess.Popen([sys.executable, os.path.join(HERE, "swap-tier-stub-api.py"), "--port", str(PORT), "--log", stub_log,
                          "--warm-files", *warm_files], stdout=open(os.path.join(a.out, "stub.out"), "a"), stderr=subprocess.STDOUT),
        subprocess.Popen([sys.executable, os.path.abspath(__file__), "probe", "--out", os.path.join(a.out, "probe.csv")]),
    ]
    try:
        time.sleep(1)
        swap_off()
        rec.rec("run-start", agents=a.agents, warm=a.warm, single=a.single, arms=arms, idleSec=IDLE_SEC,
                kernel=os.uname().release, host=host_stats())
        sh(TMUX + ["kill-server"], check=False)
        names = start_agents(a.agents, a.user, rec)
        warm(names, a.warm, rec)
        for arm in arms:
            run_arm(arm, names, a.single, a.ram_gb, rec, stub_log)
        rec.rec("run-end")
    finally:
        sh(TMUX + ["kill-server"], check=False)
        for p in procs:
            p.terminate()
        swap_off()
    report(a.out)


def main(argv=None):
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    r = sub.add_parser("run")
    r.add_argument("--out", required=True)
    r.add_argument("--agents", type=int, default=24)
    r.add_argument("--warm", type=int, default=8)
    r.add_argument("--single", type=int, default=8)
    r.add_argument("--ram-gb", type=int, default=16)
    r.add_argument("--user", default="agent")
    r.add_argument("--arm", action="append", required=True)
    b = sub.add_parser("bench-disk")
    b.add_argument("--device", required=True)
    b.add_argument("--label", required=True)
    b.add_argument("--out", required=True)
    b.add_argument("--runtime", type=int, default=20)
    p = sub.add_parser("report")
    p.add_argument("--out", required=True)
    q = sub.add_parser("probe")
    q.add_argument("--out", required=True)
    a = ap.parse_args(argv)
    if a.cmd == "run":
        if a.single >= a.agents:
            ap.error("--single must leave agents for the storm")
        for s in a.arm:
            parse_arm(s)
        run(a)
    elif a.cmd == "bench-disk":
        bench_disk(a.device, a.label, a.out, a.runtime)
    elif a.cmd == "report":
        report(a.out)
    elif a.cmd == "probe":
        probe(a.out)
    return 0


if __name__ == "__main__":
    sys.exit(main())
