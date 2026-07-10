#!/usr/bin/env bash
# papercup-dht-liveness-check.sh — periodic REAL liveness probe for the isolated
# DHT testnet's bootstrap node (EI-8892).
#
# WHY: `papercup-isolated-dht.service` can WEDGE (unit stays `active`, the
# bootstrap node stops actually routing DHT traffic) with ZERO passive signal —
# "is the unit active" cannot see this, and hyperswarm rides UDX/UDP so `ss`/
# `netstat` show nothing useful either. 2026-07-06→07-09: wedged for 3 days,
# cross-machine federation dead the whole time, caught only by a hand-rolled
# probe (su-4dc3befd's live incident response). This wrapper runs the real
# 2-swarm probe (p2p-dht-liveness-probe.mjs) on a schedule and files an EI on
# failure, so the class is caught within minutes instead of by chance.
#
# DETECTION + ESCALATION ONLY — this script NEVER restarts / touches
# papercup-isolated-dht.service. A staleness/liveness detector that reads a
# signal spanning process restarts must not also hold restart authority: mixing
# the two turns a boot-grace bug into a restart-storm (EI-8901's lesson — a
# freshly-restarted unit that hasn't had time to become live yet gets
# repeatedly killed by its own health check). Escalation is a human/agent call;
# this script's whole job is "don't let the wedge be silent again."
#
# Usage: papercup-dht-liveness-check.sh
# Env:
#   DHT_UNIT              (default papercup-isolated-dht.service)
#   DHT_PROBE_TIMEOUT_MS   (default 15000)  — probe connect-timeout
#   DHT_BOOT_GRACE_SEC     (default 120)    — skip judging a unit less than this
#                                             long into its current ActiveState
#                                             (EI-8901 boot-grace lesson)
#   OPERATOR_MCP_URL        (default http://127.0.0.1:3070/api/mcp?superuser=1)
#   DHT_NO_FILE             (default 0)     — set 1 to skip EI filing (log-only)
#   DHT_RED_REFILE_H        (default 12)    — RED-EI dedup window (mirrors
#                                             live-federation-gate.sh's
#                                             RED_REFILE_H — file once per
#                                             window per still-wedged condition,
#                                             not a fresh EI every tick)
#   DHT_STALE_H             (default 6)     — no successful probe run for this
#                                             long ⇒ file a LOUD staleness EI
#                                             (silence must never look like green)
set -uo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
PROBE="$REPO_ROOT/apps/operator/scripts/p2p-dht-liveness-probe.mjs"

DHT_UNIT="${DHT_UNIT:-papercup-isolated-dht.service}"
DHT_PROBE_TIMEOUT_MS="${DHT_PROBE_TIMEOUT_MS:-15000}"
DHT_BOOT_GRACE_SEC="${DHT_BOOT_GRACE_SEC:-120}"
OPERATOR_MCP_URL="${OPERATOR_MCP_URL:-http://127.0.0.1:3070/api/mcp?superuser=1}"
DHT_NO_FILE="${DHT_NO_FILE:-0}"
DHT_RED_REFILE_H="${DHT_RED_REFILE_H:-12}"
DHT_STALE_H="${DHT_STALE_H:-6}"
GATE_SUPERUSER_TOKEN_PATH="${GATE_SUPERUSER_TOKEN_PATH:-$HOME/.papercusp/superuser-token}"
GATE_SUPERUSER_BEARER="$(cat "$GATE_SUPERUSER_TOKEN_PATH" 2>/dev/null | tr -d '[:space:]' || true)"
STATE_DIR="${DHT_STATE_DIR:-$HOME/.papercusp/dht-liveness}"; mkdir -p "$STATE_DIR"

log() { echo "[dht-liveness $(date +%H:%M:%S 2>/dev/null || true)] $*" >&2; }
now_s() { date +%s 2>/dev/null || echo 0; }
age_h() { local f="$1"; [ -f "$f" ] || { echo 999999; return; }; echo $(( ( $(now_s) - $(cat "$f" 2>/dev/null || echo 0) ) / 3600 )); }
jstr() { printf '%s' "$1" | python3 -c 'import json,sys;print(json.dumps(sys.stdin.read()))' 2>/dev/null || printf '"%s"' "$1"; }

file_ei() { # <title> <body> — best-effort curl-MCP; loud echo + journald are the fallback
  [ "$DHT_NO_FILE" = 1 ] && return 0
  local resp
  local -a auth_hdr=()
  if [ -n "$GATE_SUPERUSER_BEARER" ]; then
    auth_hdr=(-H "authorization: Bearer $GATE_SUPERUSER_BEARER")
  else
    log "WARN: no superuser bearer at $GATE_SUPERUSER_TOKEN_PATH — EI filing will 403; falling back to log-only."
  fi
  resp="$(curl -s -m 30 -X POST "$OPERATOR_MCP_URL" \
    -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' "${auth_hdr[@]}" \
    -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{\"name\":\"work_items:create\",\"arguments\":{\"kind\":\"bug\",\"title\":$(jstr "$1"),\"summary\":$(jstr "$2"),\"harness\":\"papercusp\",\"severity\":\"major\",\"topics\":[\"p2p\",\"dht\",\"federation\"]}}}" 2>/dev/null || true)"
  # SSE-aware: the tool result may arrive nested in an SSE `data:` envelope with its
  # own quotes backslash-escaped — make each quote's backslash optional so this
  # matches both a plain-JSON and an SSE transport (live-federation-gate.sh gotcha).
  local id_match
  id_match="$(printf '%s' "$resp" | grep -oaE '\\?"id\\?":\\?"WI-[0-9]+' | head -1)"
  if [ -n "$id_match" ]; then
    log "EI filed OK → $(printf '%s' "$id_match" | grep -oaE 'WI-[0-9]+')"
  else
    log "EI filing DID NOT CONFIRM (no WI id in response) — resp head: ${resp:0:200}"
  fi
}

# ── resolve the LIVE unit's bootstrap host/port — never hardcode here. ──
ENV_LINE="$(systemctl --user show "$DHT_UNIT" -p Environment 2>/dev/null || true)"
DHT_HOST="$(printf '%s' "$ENV_LINE" | grep -oE 'PAPERCUSP_DHT_HOST=[^ ]+' | cut -d= -f2)"
DHT_PORT="$(printf '%s' "$ENV_LINE" | grep -oE 'PAPERCUSP_DHT_PORT=[^ ]+' | cut -d= -f2)"
if [ -z "$DHT_HOST" ] || [ -z "$DHT_PORT" ]; then
  log "SKIP: could not resolve PAPERCUSP_DHT_HOST/PORT from '$DHT_UNIT' Environment= — is the unit installed? ($ENV_LINE)"
  exit 0
fi

ACTIVE_STATE="$(systemctl --user show "$DHT_UNIT" -p ActiveState --value 2>/dev/null || true)"
if [ "$ACTIVE_STATE" != "active" ]; then
  log "SKIP: $DHT_UNIT is not active (state=$ACTIVE_STATE) — nothing to probe; that's a separate, already-visible signal."
  exit 0
fi

# ── boot-grace (EI-8901): don't judge a unit that hasn't had time to come up yet. ──
ACTIVE_MONO_US="$(systemctl --user show "$DHT_UNIT" -p ActiveEnterTimestampMonotonic --value 2>/dev/null || echo 0)"
UPTIME_S="$(cut -d' ' -f1 /proc/uptime 2>/dev/null || echo 0)"
ACTIVE_S_AGO=0
if [ -n "$ACTIVE_MONO_US" ] && [ "$ACTIVE_MONO_US" != "0" ]; then
  ACTIVE_S_AGO="$(awk -v u="$UPTIME_S" -v m="$ACTIVE_MONO_US" 'BEGIN{printf "%d", u - (m/1000000)}')"
fi
if [ "$ACTIVE_S_AGO" -lt "$DHT_BOOT_GRACE_SEC" ] 2>/dev/null; then
  log "SKIP: $DHT_UNIT entered its current active state ${ACTIVE_S_AGO}s ago (< ${DHT_BOOT_GRACE_SEC}s boot-grace) — not yet judging (EI-8901)."
  exit 0
fi

# ── run the real probe. ──
log "probing bootstrap $DHT_HOST:$DHT_PORT (timeout ${DHT_PROBE_TIMEOUT_MS}ms) …"
PROBE_OUT="$(cd "$REPO_ROOT" && timeout $(( (DHT_PROBE_TIMEOUT_MS / 1000) + 10 )) node "$PROBE" --host "$DHT_HOST" --port "$DHT_PORT" --timeout-ms "$DHT_PROBE_TIMEOUT_MS" 2>&1)"
PROBE_EXIT=$?
log "$PROBE_OUT"

if [ "$PROBE_EXIT" -eq 0 ]; then
  echo "$(now_s)" >"$STATE_DIR/last-ok"; rm -f "$STATE_DIR/red-ei-filed"
  log "HEALTHY — bootstrap $DHT_HOST:$DHT_PORT connected within ${DHT_PROBE_TIMEOUT_MS}ms."
  exit 0
fi

# ── FAIL: dedup-file an EI (RED_REFILE_H window), never auto-restart. ──
RED_MARKER="$STATE_DIR/red-ei-filed"
red_marker_age_h="$(age_h "$RED_MARKER")"
TITLE="papercup-isolated-dht liveness probe FAILED — bootstrap $DHT_HOST:$DHT_PORT unreachable/wedged"
BODY="EI-8892 durable probe (apps/operator/scripts/p2p-dht-liveness-probe.mjs via papercup-dht-liveness-check.sh) FAILED against the live $DHT_UNIT bootstrap $DHT_HOST:$DHT_PORT — a 2-swarm hyperswarm announce/connect did not complete within ${DHT_PROBE_TIMEOUT_MS}ms. This is the SILENT-WEDGE class (2026-07-06→07-09 3-day outage): the unit reports ActiveState=active but is not actually routing DHT traffic — no passive systemd/port signal catches this. THIS SCRIPT DOES NOT RESTART THE UNIT (detection + escalation only, by design — EI-8901 boot-grace lesson: a restart-authority health check on a signal that spans process restarts risks a restart-storm). Manual recovery: systemctl --user restart $DHT_UNIT, then re-run this probe to confirm recovery: node apps/operator/scripts/p2p-dht-liveness-probe.mjs --host $DHT_HOST --port $DHT_PORT. Probe output:\n$PROBE_OUT"
if [ "$red_marker_age_h" -lt "$DHT_RED_REFILE_H" ]; then
  log "RED already tracked (EI filed ${red_marker_age_h}h ago, < DHT_RED_REFILE_H ${DHT_RED_REFILE_H}h) — skipping duplicate filing. $TITLE"
else
  file_ei "$TITLE" "$BODY"
  echo "$(now_s)" >"$RED_MARKER"
fi

# ── staleness: no successful probe in DHT_STALE_H ⇒ a LOUDER, separate signal. ──
last_ok_age_h="$(age_h "$STATE_DIR/last-ok")"
if [ "$last_ok_age_h" -ge "$DHT_STALE_H" ]; then
  stale_filed_age_h="$(age_h "$STATE_DIR/stale-ei-filed")"
  if [ "$stale_filed_age_h" -ge "$DHT_STALE_H" ]; then
    log "STALE: no successful probe for ${last_ok_age_h}h (>= ${DHT_STALE_H}h) — filing staleness EI"
    file_ei "papercup-isolated-dht STALE: no healthy probe for ${last_ok_age_h}h — the DHT liveness signal itself may be dark" \
      "The EI-8892 liveness probe has not recorded a single successful run in ${last_ok_age_h}h (threshold ${DHT_STALE_H}h). Check: systemctl --user list-timers papercup-isolated-dht-liveness.timer ; journalctl --user -u papercup-isolated-dht-liveness.service ; state in ~/.papercusp/dht-liveness/."
    echo "$(now_s)" >"$STATE_DIR/stale-ei-filed"
  fi
fi

exit 1
