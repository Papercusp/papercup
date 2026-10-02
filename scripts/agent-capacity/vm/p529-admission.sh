#!/usr/bin/env bash
# P-529 heavy-job admission A/B (plan agent-capacity-and-cost-gcp-2026-09-30). Runs ON a ramp VM
# from ~/capacity, after bootstrap-agent-vm.sh built prepared/<repo> and the P-019 real-work
# recordings were placed as the load driver's default corpus (~/.cache/agent-capacity/corpus,
# with their tasks.json as corpus/tasks.json).
#
#   bash scripts/agent-capacity/vm/p529-admission.sh <K> "<N steps>" [durationSec] [repo]
#   e.g. p529-admission.sh 3 "12 18 24 32 40 48" 600 papercusp
#
# Two ramps of the SAME replayed heavy work, each through vm/p005-ramp.sh (same saturation rule):
#   arm A (label p529-a): status quo. No shim; `npm run test:file` keeps the repo's default
#     pc-heavy, while direct `npx vitest` / `npx tsc` calls (most of P-019's heavy work) run
#     unadmitted. This is the machine D-021 measured.
#   arm B (label p529-k<K>): heavy-shim.sh installed in prepared/<repo>, and one fixed pool for
#     every agent: PC_HEAVY_SLOTS=K, a shared slot dir, the memory clamp and PSI controller off
#     (so the only admission is K), coalescing off, and a wait timeout long enough that K is
#     never bypassed. The slot dir and shim log live in /tmp because Codex's workspace-write
#     sandbox can write there and not under $HOME.
# The lever is the capacity difference (largest OK step) and the per-step memory peak; the shim
# log gives the added wait (admit - request) per heavy job. The shim is removed at the end.
# Lines to grep: P529_* (plus p005-ramp.sh's RAMP_* lines).
#
# Variants (D-023: a fixed K=3 halved capacity, because the status quo's limit at N=32 was memory,
# not CPU, and K=3 left half the cores idle while agents queued):
#   P529_ARMS=b                skip arm A (its baseline is already measured) and run arm B only.
#   P529_MEM_PER_SLOT_GIB=<n>  arm B keeps pc-heavy's memory clamp ON with <n> GiB per admitted
#     job, so K becomes a ceiling and MemAvailable decides admission. Label p529-k<K>m<n>.
set -uo pipefail
cd "$HOME/capacity" || exit 1
K=${1:?usage: p529-admission.sh <K> "<N steps>" [durationSec] [repo]}
STEPS=${2:?usage: p529-admission.sh <K> "<N steps>" [durationSec] [repo]}
DUR=${3:-600}
REPO=${4:-papercusp}
S="scripts/agent-capacity"
CACHE=${AGENT_CAPACITY_CACHE:-$HOME/.cache/agent-capacity}
PREP="$CACHE/prepared/$REPO"
TMPD=${P529_TMP:-/tmp/p529}
ARMS=${P529_ARMS:-a,b}
MEMGIB=${P529_MEM_PER_SLOT_GIB:-}
case "$ARMS" in a,b|b) ;; *) echo "P529_ERROR P529_ARMS must be a,b or b (got $ARMS)" >&2; exit 2 ;; esac
case "$MEMGIB" in ''|[1-9]|[1-9][0-9]|derived) ;; *) echo "P529_ERROR P529_MEM_PER_SLOT_GIB must be 1-99 or derived (got $MEMGIB)" >&2; exit 2 ;; esac
OVERLAY=${P529_PC_HEAVY_OVERLAY:-}
[ -z "$OVERLAY" ] || [ -f "$OVERLAY" ] || { echo "P529_ERROR P529_PC_HEAVY_OVERLAY=$OVERLAY is not a file" >&2; exit 2; }
ts() { date -u +%FT%TZ; }
[ -d "$PREP/node_modules/.bin" ] || { echo "P529_ERROR no prepared checkout at $PREP" >&2; exit 2; }
mkdir -p "$TMPD" || exit 1
chmod 1777 "$TMPD" 2>/dev/null || true
for v in $(env | sed -n 's/^\(PC_HEAVY_[A-Z0-9_]*\)=.*/\1/p'); do unset "$v"; done

# The P-019 recordings were made from their own tasks.json, placed beside them in the corpus; the
# driver's default (scripts/agent-capacity/corpus/tasks.json) is the P-003 corpus, not this one.
export TASKS_FILE=${TASKS_FILE:-$CACHE/corpus/tasks.json}
[ -f "$TASKS_FILE" ] || { echo "P529_ERROR no tasks file at $TASKS_FILE" >&2; exit 2; }

B="k$K${MEMGIB:+m$MEMGIB}"
echo "P529_START k=$K mem_per_slot_gib=${MEMGIB:-off} arms=$ARMS steps=\"$STEPS\" dur=$DUR repo=$REPO tasks=$TASKS_FILE $(ts)"

bash "$S/vm/install-heavy-shim.sh" "$PREP" --uninstall
if [ "$ARMS" = a,b ]; then
  echo "P529_ARM_START arm=a $(ts)"
  bash "$S/vm/p005-ramp.sh" p529-a all "$STEPS" "$DUR"
  rc=$?
  echo "P529_ARM_END arm=a rc=$rc $(ts)"
  # rc 3 = the driver could not run (preflight or an immediate crash): arm A measured nothing, so
  # arm B would have no baseline to compare against.
  [ "$rc" -ne 3 ] || { echo "P529_ERROR arm=a driver did not run, stopping before arm B" >&2; exit 5; }
fi

bash "$S/vm/install-heavy-shim.sh" "$PREP" || { echo "P529_ERROR shim install failed" >&2; exit 3; }
rm -rf "$TMPD/slots-$B"
export PC_HEAVY_SLOTS="$K" PC_HEAVY_DIR="$TMPD/slots-$B" PC_HEAVY_MEM_CLAMP=0 PC_HEAVY_PSI_ADMISSION=0 \
  PC_HEAVY_COALESCE=0 PC_HEAVY_TIMEOUT_SEC=7200 PC_HEAVY_SHIM_LOG="$TMPD/shim-$B.jsonl"
if [ -n "$MEMGIB" ]; then export PC_HEAVY_MEM_CLAMP=1 PC_HEAVY_MEM_PER_SLOT_GIB="$MEMGIB"; fi
: >"$PC_HEAVY_SHIM_LOG"
chmod 0666 "$PC_HEAVY_SHIM_LOG" 2>/dev/null || true
# Preflight: a tool run inside Codex's workspace-write sandbox (bootstrap-agent-vm.sh's own probe
# syntax) must be admitted by the prepared checkout's pc-heavy into the SAME slot dir and log the
# host sees. A private /tmp or an unwritable pool would leave Codex sessions unadmitted, or in a
# pool of their own, and arm B would look clean while measuring nothing.
pfdir=$(mktemp -d)
pf=$(cd "$pfdir" && codex sandbox -c sandbox_mode=workspace-write -- \
  bash -c "bash '$PREP/scripts/pc-heavy.sh' -- bash -c 'echo preflight >>\"\$PC_HEAVY_SHIM_LOG.preflight\"' && echo pch-ok" 2>"$TMPD/preflight.err") || true
rm -rf "$pfdir"
if [ "$pf" != pch-ok ] || ! grep -q preflight "$PC_HEAVY_SHIM_LOG.preflight" 2>/dev/null || [ ! -d "$PC_HEAVY_DIR" ]; then
  echo "P529_ERROR codex sandbox does not share the admission pool: out=\"$pf\" err=\"$(head -c 400 "$TMPD/preflight.err" 2>/dev/null)\"" >&2
  bash "$S/vm/install-heavy-shim.sh" "$PREP" --uninstall
  exit 4
fi
rm -f "$PC_HEAVY_SHIM_LOG.preflight"
echo "P529_PREFLIGHT_OK pool=$PC_HEAVY_DIR"
echo "P529_ARM_START arm=$B $(ts)"
bash "$S/vm/p005-ramp.sh" "p529-$B" all "$STEPS" "$DUR"
echo "P529_ARM_END arm=$B rc=$? $(ts)"
for v in $(env | sed -n 's/^\(PC_HEAVY_[A-Z0-9_]*\)=.*/\1/p'); do unset "$v"; done
bash "$S/vm/install-heavy-shim.sh" "$PREP" --uninstall

python3 - "$TMPD/shim-$B.jsonl" <<'PY'
import json, sys
req, adm = {}, {}
for line in open(sys.argv[1]):
    try:
        e = json.loads(line)
    except Exception:
        continue
    (req if e.get("ev") == "request" else adm)[e.get("id")] = e
w = sorted(a.get("waitSec", 0) for a in adm.values())
q = lambda p: w[min(len(w) - 1, int(p * len(w)))] if w else None
print(f"P529_SHIM requests={len(req)} admitted={len(adm)} unadmitted={len(set(req) - set(adm))} "
      f"wait_p50={q(0.5)} wait_p90={q(0.9)} wait_max={w[-1] if w else None}")
PY
cp "$TMPD/shim-$B.jsonl" "$HOME/capacity/fp/p529-shim-$B.jsonl" 2>/dev/null || true
echo "P529_DONE $(ts)"
