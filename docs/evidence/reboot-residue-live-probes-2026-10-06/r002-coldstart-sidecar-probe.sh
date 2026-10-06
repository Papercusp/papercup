#!/usr/bin/env bash
# r002-coldstart-sidecar-probe.sh — EI-25222670171204378 / plan
# reboot-residue-service-repairs-2026-10-03 R-002 clause 3(d).
#
# Cold-starts the on-demand ornith llama-server through the inference gateway
# (no manual lever beyond stopping it first, which is the clause's
# precondition) while sampling the shared embed sidecar every 2s with a
# cache-bypassing /embed request. Answers two questions:
#   (a) does the embed sidecar keep running across the cold start
#       (ExecMainStartTimestamp / MainPID / NRestarts unchanged)?
#   (b) does ornith's load slow /embed past the watchdog's 15s probe deadline
#       (the inferred cause of the first failed probe on 2026-10-06 09:36Z)?
set -u
OUT_DIR="${1:-/tmp/r002-coldstart}"
mkdir -p "$OUT_DIR" || exit 1
SAMPLES="$OUT_DIR/embed-samples.tsv"
: > "$SAMPLES"
TAIL_SEC="${R002_TAIL_SEC:-240}"

sidecar_state() {
  systemctl --user show papercup-embed-sidecar.service \
    -p ActiveState -p SubState -p MainPID -p NRestarts -p ExecMainStartTimestamp --value | paste -sd'|'
}

T0=$(date -u +%Y-%m-%dT%H:%M:%SZ)
echo "START $T0"
echo "PRE sidecar=$(sidecar_state)"
echo "PRE kokoro_start=$(systemctl --user show voicemode-kokoro.service -p ExecMainStartTimestamp --value)"
echo "PRE embed_device=$(sudo -n -u postgres psql -d papercusp -Atc 'select row_to_json(t) from harness_shared.operator_embed_device t' 2>&1 | head -1)"
echo "PRE gpu=$(nvidia-smi --query-gpu=memory.used,memory.free --format=csv,noheader)"
nvidia-smi --query-compute-apps=pid,process_name,used_memory --format=csv,noheader | sed 's/^/PRE_GPU_APP /'

systemctl --user stop llama-ornith.service
echo "PRE ornith_after_stop=$(systemctl --user is-active llama-ornith.service)"

# Sampler: one cache-bypassing /embed every 2s until the stop file appears.
STOP="$OUT_DIR/stop"
rm -f "$STOP"
(
  body='{"model":"gemma","kind":"query","texts":["r002-coldstart-sampler"],"bypassCache":true}'
  while [ ! -e "$STOP" ]; do
    ts=$(date -u +%H:%M:%S)
    res=$(curl -s -o "$OUT_DIR/last-embed.json" -w '%{http_code} %{time_total}' -m 30 \
      -H 'Content-Type: application/json' --data-binary "$body" http://127.0.0.1:3384/embed)
    ok=$(jq -e '(.vectors|arrays|length==1) and (.cache.inferred==1)' "$OUT_DIR/last-embed.json" >/dev/null 2>&1 && echo ok || echo bad)
    printf '%s\t%s\t%s\n' "$ts" "$res" "$ok" >> "$SAMPLES"
    sleep 2
  done
) &
SAMPLER=$!

sleep 10
S=$(date +%s)
CODE=$(curl -s -o "$OUT_DIR/completion.json" -w '%{http_code}' -m 900 http://127.0.0.1:8788/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"maxwell1500/ornith-35b:IQ3_M","max_tokens":16,"messages":[{"role":"user","content":"Reply with the single word: pong"}]}')
echo "COMPLETION_HTTP=$CODE after $(( $(date +%s) - S ))s at $(date -u +%H:%M:%SZ)"
echo "COMPLETION_MODEL=$(grep -o '"model":"[^"]*"' "$OUT_DIR/completion.json" | head -1)"

# Keep sampling through several watchdog fires after the load settles.
sleep "$TAIL_SEC"
touch "$STOP"
wait "$SAMPLER"

echo "POST sidecar=$(sidecar_state)"
echo "POST kokoro_start=$(systemctl --user show voicemode-kokoro.service -p ExecMainStartTimestamp --value)"
echo "POST ornith=$(systemctl --user is-active llama-ornith.service)"
echo "POST gpu=$(nvidia-smi --query-gpu=memory.used,memory.free --format=csv,noheader)"
nvidia-smi --query-compute-apps=pid,process_name,used_memory --format=csv,noheader | sed 's/^/POST_GPU_APP /'
echo "SAMPLES_TOTAL=$(wc -l < "$SAMPLES")"
echo "SAMPLES_NON200=$(awk -F'\t' '{split($2,a," "); if (a[1]!="200") n++} END{print n+0}' "$SAMPLES")"
echo "SAMPLES_BAD_ACCOUNTING=$(awk -F'\t' '$3!="ok"{n++} END{print n+0}' "$SAMPLES")"
echo "SAMPLES_OVER_15S=$(awk -F'\t' '{split($2,a," "); if (a[2]+0>15) n++} END{print n+0}' "$SAMPLES")"
echo "SAMPLES_MAX_LATENCY_S=$(awk -F'\t' '{split($2,a," "); if (a[2]+0>m) m=a[2]+0} END{print m+0}' "$SAMPLES")"
echo "SAMPLES_P50_LATENCY_S=$(awk -F'\t' '{split($2,a," "); print a[2]+0}' "$SAMPLES" | sort -n | awk '{v[NR]=$1} END{print v[int((NR+1)/2)]}')"
echo "--- slowest 8 samples"
sort -t$'\t' -k2,2 "$SAMPLES" | awk -F'\t' '{split($2,a," "); print a[2]"\t"$0}' | sort -rn | head -8 | cut -f2-
echo "--- watchdog journal since $T0"
journalctl --user -u papercup-embed-sidecar-watchdog.service --since "$T0" --no-pager -o short-iso 2>/dev/null \
  | grep -vE 'Starting|Finished' | cut -c1-200 | head -20
echo "--- gateway journal since $T0 (ornith/audit/fail)"
journalctl --user -u papercup-inference-gateway.service --since "$T0" --no-pager -o short-iso 2>/dev/null \
  | grep -iE 'ornith|unit audit|on-demand|oom|out of memory|fail' | cut -c1-220 | head -12
echo "END $(date -u +%Y-%m-%dT%H:%M:%SZ)"
