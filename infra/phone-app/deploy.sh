#!/usr/bin/env bash
# Phone app — deploy the self-hosted media plane (plan phone-app-2026-08-30, P-002, D-002).
#
# Idempotent: safe to re-run. Mints the API secret on first run, renders the
# committed templates into ~/.config/papercusp-phone/ (0600, outside the repo),
# installs the systemd --user units, starts them, and waits for health.
#
# The API secret is never printed, never logged, and never written into the tree.
#
#   deploy.sh                  deploy / converge
#   deploy.sh --rotate-secret  mint a fresh secret and restart both units
#   deploy.sh --status         report only, change nothing
set -euo pipefail

HERE="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
CONF_DIR="$HOME/.config/papercusp-phone"
ENV_FILE="$CONF_DIR/livekit.env"
UNIT_DIR="$HOME/.config/systemd/user"
LK_BIN="$HOME/.local/bin/livekit-server"
SIP_BIN="$HOME/.local/bin/livekit-sip"
HEALTH_URL="http://127.0.0.1:7890/"
UNITS=(papercusp-phone-livekit.service papercusp-phone-sip.service)

ROTATE=0; STATUS_ONLY=0
for a in "$@"; do
  case "$a" in
    --rotate-secret) ROTATE=1 ;;
    --status) STATUS_ONLY=1 ;;
    -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
    *) echo "unknown argument: $a" >&2; exit 2 ;;
  esac
done

say() { printf '  %s\n' "$*"; }
step() { printf '\n▸ %s\n' "$*"; }
die() { printf '\n✗ %s\n' "$*" >&2; exit 1; }

report_status() {
  step "Status"
  for u in "${UNITS[@]}"; do
    printf '  %-38s %s\n' "$u" "$(systemctl --user is-active "$u" 2>/dev/null || echo inactive)"
  done
  if curl -fsS --max-time 3 "$HEALTH_URL" >/dev/null 2>&1; then
    say "health $HEALTH_URL → OK"
  else
    say "health $HEALTH_URL → UNREACHABLE"
  fi
  say "sip signalling :5070 → $(ss -lun 2>/dev/null | grep -c ':5070' || true) udp listener(s)"
}

if [[ $STATUS_ONLY == 1 ]]; then report_status; exit 0; fi

# ---------------------------------------------------------------- preflight
step "Preflight"
[[ -x "$LK_BIN" ]] || die "livekit-server not found at $LK_BIN"
say "livekit-server $("$LK_BIN" --version 2>&1 | head -1 | awk '{print $NF}')"

# livekit-sip ships only as a container image; we extract the binary to the host so
# the unit needs no Docker at run time. It is dynamically linked, so its libraries
# must resolve — a missing libopusfile is the one that actually bites.
if [[ ! -x "$SIP_BIN" ]]; then
  cat >&2 <<EOF
✗ livekit-sip not found at $SIP_BIN
  It is distributed as a container image. Extract the binary once:
      cid=\$(docker create livekit/sip:latest)
      docker cp "\$cid":/usr/bin/livekit-sip "$SIP_BIN"
      docker rm "\$cid" && chmod +x "$SIP_BIN"
EOF
  exit 1
fi
if missing="$(ldd "$SIP_BIN" 2>/dev/null | awk '/not found/{print $1}')" && [[ -n "$missing" ]]; then
  die "livekit-sip is missing shared libraries: ${missing//$'\n'/ }
  On Debian/Ubuntu the usual culprit is libopusfile: sudo apt-get install -y libopusfile0"
fi
say "livekit-sip present, all shared libraries resolve"

redis-cli -h 127.0.0.1 -p 6379 ping >/dev/null 2>&1 || die "redis not answering on 127.0.0.1:6379"
say "redis reachable (this deployment uses db 3)"

# Ports must be free, OR already held by our own units (a re-run).
for port in 7890 7891; do
  if ss -ltn 2>/dev/null | grep -q ":$port "; then
    if ! systemctl --user is-active --quiet papercusp-phone-livekit.service; then
      die "port $port is in use by something that is not our LiveKit unit — refusing to fight over it"
    fi
    say "port $port already held by our own unit (re-run)"
  fi
done

# The other project on this host owns 7880/7881/5060. Never touch those.
if ss -ltn 2>/dev/null | grep -qE ':(7880|7881) '; then
  say "note: another project's LiveKit is on 7880/7881 — leaving it strictly alone"
fi

LAN_IFACE="$(ip route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="dev"){print $(i+1); exit}}')"
[[ -n "$LAN_IFACE" ]] || die "could not determine the LAN interface from the default route"
say "LAN interface: $LAN_IFACE"

# ---------------------------------------------------------------- credentials
step "Credentials"
mkdir -p "$CONF_DIR"; chmod 700 "$CONF_DIR"

if [[ ! -f "$ENV_FILE" || $ROTATE == 1 ]]; then
  [[ $ROTATE == 1 ]] && say "rotating API secret" || say "minting API key + secret (first run)"
  # generate-keys writes "API Key:  <k>" / "API Secret:  <s>" — capture without echoing.
  gen="$("$LK_BIN" generate-keys 2>/dev/null)"
  KEY="$(printf '%s' "$gen" | awk '/API Key:/{print $NF}')"
  SECRET="$(printf '%s' "$gen" | awk '/API Secret:/{print $NF}')"
  unset gen
  [[ -n "$KEY" && -n "$SECRET" ]] || die "could not parse a key pair out of 'livekit-server generate-keys'"
  umask 077
  printf 'PHONE_LIVEKIT_API_KEY=%s\nPHONE_LIVEKIT_API_SECRET=%s\nPHONE_LIVEKIT_URL=ws://127.0.0.1:7890\n' \
    "$KEY" "$SECRET" > "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  say "wrote $ENV_FILE (0600) — secret not printed"
else
  say "reusing existing key pair in $ENV_FILE"
fi

# shellcheck disable=SC1090
set -a; source "$ENV_FILE"; set +a
[[ -n "${PHONE_LIVEKIT_API_KEY:-}" && -n "${PHONE_LIVEKIT_API_SECRET:-}" ]] \
  || die "$ENV_FILE is missing PHONE_LIVEKIT_API_KEY / PHONE_LIVEKIT_API_SECRET"
say "api key ${PHONE_LIVEKIT_API_KEY:0:6}… (secret withheld)"

# ---------------------------------------------------------------- render
# Pure-bash substitution: no sed escaping hazards with base64 secrets.
render() {
  local tmpl="$1" out="$2" content
  content="$(cat "$tmpl")"
  content="${content//'${PHONE_LIVEKIT_API_KEY}'/$PHONE_LIVEKIT_API_KEY}"
  content="${content//'${PHONE_LIVEKIT_API_SECRET}'/$PHONE_LIVEKIT_API_SECRET}"
  content="${content//'${PHONE_LAN_IFACE}'/$LAN_IFACE}"
  # Only a real placeholder counts: ${UPPER_SNAKE}. Prose that merely mentions a
  # dollar-brace must not trip this, or the guard cries wolf on its own comments.
  local leftover
  leftover="$(printf '%s' "$content" | grep -oE '\$\{[A-Z][A-Z0-9_]*\}' | sort -u | tr '\n' ' ' || true)"
  if [[ -n "${leftover// /}" ]]; then
    die "unsubstituted placeholder(s) in $(basename "$tmpl"): $leftover — refusing to write a broken config"
  fi
  umask 077
  printf '%s\n' "$content" > "$out"
  chmod 600 "$out"
}

step "Render config"
render "$HERE/livekit-server.yaml.tmpl" "$CONF_DIR/livekit-server.yaml"
render "$HERE/livekit-sip.yaml.tmpl"    "$CONF_DIR/livekit-sip.yaml"
say "rendered livekit-server.yaml + livekit-sip.yaml into $CONF_DIR"

# ---------------------------------------------------------------- units
step "Install units"
mkdir -p "$UNIT_DIR"
for u in "${UNITS[@]}"; do install -m 644 "$HERE/systemd/$u" "$UNIT_DIR/$u"; say "installed $u"; done
systemctl --user daemon-reload

step "Start"
for u in "${UNITS[@]}"; do
  systemctl --user enable "$u" >/dev/null 2>&1 || true
  systemctl --user restart "$u"
  say "restarted $u"
done

# ---------------------------------------------------------------- health
step "Health"
ok=0
for _ in $(seq 1 30); do
  if curl -fsS --max-time 2 "$HEALTH_URL" >/dev/null 2>&1; then ok=1; break; fi
  sleep 1
done
[[ $ok == 1 ]] || {
  printf '\n--- last 20 log lines ---\n' >&2
  journalctl --user -u papercusp-phone-livekit.service -n 20 --no-pager >&2 || true
  die "LiveKit did not become healthy on $HEALTH_URL within 30s"
}
say "LiveKit healthy on $HEALTH_URL"

for _ in $(seq 1 15); do
  systemctl --user is-active --quiet papercusp-phone-sip.service && break
  sleep 1
done
if systemctl --user is-active --quiet papercusp-phone-sip.service; then
  say "SIP gateway active on :5070"
else
  printf '\n--- last 20 sip log lines ---\n' >&2
  journalctl --user -u papercusp-phone-sip.service -n 20 --no-pager >&2 || true
  die "SIP gateway failed to stay active"
fi

report_status
printf '\n✓ media plane deployed. Acceptance: infra/phone-app/verify-media-plane.sh\n'
