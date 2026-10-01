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
ts() { date -u +%FT%TZ; }
[ -d "$PREP/node_modules/.bin" ] || { echo "P529_ERROR no prepared checkout at $PREP" >&2; exit 2; }
mkdir -p "$TMPD" || exit 1
chmod 1777 "$TMPD" 2>/dev/null || true
for v in $(env | sed -n 's/^\(PC_HEAVY_[A-Z0-9_]*\)=.*/\1/p'); do unset "$v"; done

echo "P529_START k=$K steps=\"$STEPS\" dur=$DUR repo=$REPO $(ts)"

bash "$S/vm/install-heavy-shim.sh" "$PREP" --uninstall
echo "P529_ARM_START arm=a $(ts)"
bash "$S/vm/p005-ramp.sh" p529-a all "$STEPS" "$DUR"
echo "P529_ARM_END arm=a rc=$? $(ts)"

bash "$S/vm/install-heavy-shim.sh" "$PREP" || { echo "P529_ERROR shim install failed" >&2; exit 3; }
rm -rf "$TMPD/slots-k$K"
export PC_HEAVY_SLOTS="$K" PC_HEAVY_DIR="$TMPD/slots-k$K" PC_HEAVY_MEM_CLAMP=0 PC_HEAVY_PSI_ADMISSION=0 \
  PC_HEAVY_COALESCE=0 PC_HEAVY_TIMEOUT_SEC=7200 PC_HEAVY_SHIM_LOG="$TMPD/shim-k$K.jsonl"
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
echo "P529_ARM_START arm=k$K $(ts)"
bash "$S/vm/p005-ramp.sh" "p529-k$K" all "$STEPS" "$DUR"
echo "P529_ARM_END arm=k$K rc=$? $(ts)"
for v in $(env | sed -n 's/^\(PC_HEAVY_[A-Z0-9_]*\)=.*/\1/p'); do unset "$v"; done
bash "$S/vm/install-heavy-shim.sh" "$PREP" --uninstall

python3 - "$TMPD/shim-k$K.jsonl" <<'PY'
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
cp "$TMPD/shim-k$K.jsonl" "$HOME/capacity/fp/p529-shim-k$K.jsonl" 2>/dev/null || true
echo "P529_DONE $(ts)"
