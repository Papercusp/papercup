#!/usr/bin/env bash
# P-005 baseline ramp runner (plan agent-capacity-and-cost-gcp-2026-09-30; method per D-009).
# Runs ON a ramp VM from ~/capacity (scripts + node_modules), replaying the tower corpus that is
# mirrored at ~/.cache/agent-capacity (the load driver's default cache, corpus and prepared repos).
#
#   bash scripts/agent-capacity/vm/p005-ramp.sh <label> <select|all> "<N steps>" [durationSec]
#   e.g. p005-ramp.sh claude-normal cli=claude,profile=light,profile=typical "1 2 4 8 16 32 64" 600
#
# For each N it holds capdrv.slice open, samples it every 5 s with vm/sample-footprint.py, and runs
# load-driver.ts --agents N --duration-sec <durationSec>, so N agents stay busy for the whole window.
# The ramp stops after the first SATURATED step: the driver failed, a session failed or timed out,
# the kernel OOM-killed something in the slice, or the wall slowdown against the recordings passed
# SAT_SLOWDOWN (default 1.5). The step before it is the machine's capacity for this workload.
#
# Output: ~/.cache/agent-capacity/runs/p005-<label>-n<N>/ (agents.jsonl, summary.json) and
# ~/capacity/fp/p005-<label>-n<N>.{jsonl,driver.log}. Lines to grep: RAMP_*.
set -uo pipefail
cd "$HOME/capacity" || exit 1
LABEL=${1:?usage: p005-ramp.sh <label> <select|all> "<N steps>" [durationSec]}
SELECT=${2:?usage: p005-ramp.sh <label> <select|all> "<N steps>" [durationSec]}
STEPS=${3:?usage: p005-ramp.sh <label> <select|all> "<N steps>" [durationSec]}
DUR=${4:-600}
SAT_SLOWDOWN=${SAT_SLOWDOWN:-1.5}
S="scripts/agent-capacity"
uid=$(id -u)
SLICE=${CAPDRV_SLICE_DIR:-/sys/fs/cgroup/user.slice/user-$uid.slice/user@$uid.service/capdrv.slice}
CACHE=${AGENT_CAPACITY_CACHE:-$HOME/.cache/agent-capacity}
FP=$HOME/capacity/fp
mkdir -p "$FP" || exit 1
ts() { date -u +%FT%TZ; }
ooms() { awk '$1=="oom_kill"{print $2; f=1} END{if(!f) print 0}' "$SLICE/memory.events" 2>/dev/null || echo 0; }
sel=()
[ "$SELECT" = all ] || sel=(--select "$SELECT")

for n in $STEPS; do
  run="p005-$LABEL-n$n"
  systemd-run --user --slice=capdrv.slice --unit="hold-capdrv-$run" --collect sleep 86400 >/dev/null
  python3 "$S/vm/sample-footprint.py" --cgroup "$SLICE" --interval 5 --duration $((DUR + 3600)) \
    --out "$FP/$run.jsonl" --label "$run" >"$FP/$run.log" 2>&1 &
  sampler=$!
  o0=$(ooms)
  echo "RAMP_STEP_START $run n=$n $(ts)"
  npx tsx "$S/load-driver.ts" --agents "$n" --duration-sec "$DUR" --stagger-ms 1000 "${sel[@]}" \
    --run-id "$run" --isolation systemd >"$FP/$run.driver.log" 2>&1
  rc=$?
  kill "$sampler" 2>/dev/null || true
  systemctl --user stop "hold-capdrv-$run" 2>/dev/null || true
  o1=$(ooms)
  verdict=$(python3 - "$CACHE/runs/$run/summary.json" "$rc" "$((o1 - o0))" "$SAT_SLOWDOWN" <<'PY'
import json, sys
path, rc, oom, limit = sys.argv[1], int(sys.argv[2]), int(sys.argv[3]), float(sys.argv[4])
try:
    s = json.load(open(path))
except Exception:
    print(f"SATURATED reason=no-summary,driver-rc={rc}")
    sys.exit()
why = []
if rc != 0:
    why.append(f"driver-rc={rc}")
if s.get("failed"):
    why.append(f"failed={s['failed']}")
if oom > 0:
    why.append(f"oom_kill={oom}")
slow = s.get("wallSlowdown") or 0
if slow > limit:
    why.append(f"wallSlowdown={slow:.2f}")
head = "SATURATED reason=" + ",".join(why) if why else "OK"
print(f"{head} runs={s.get('runs')} wallSlowdown={slow:.2f} diverged={s.get('diverged')} toolDiverged={s.get('toolDiverged')}")
PY
)
  echo "RAMP_STEP_END $run n=$n rc=$rc $verdict $(ts)"
  case "$verdict" in SATURATED*) echo "RAMP_SATURATED $LABEL n=$n"; break ;; esac
done
echo "RAMP_DONE $LABEL $(ts)"
