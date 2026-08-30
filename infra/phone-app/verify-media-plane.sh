#!/usr/bin/env bash
# Phone app — P-002 acceptance: prove real media crosses OUR OWN server.
#
# The plan's acceptance condition for P-002 is an end-to-end call carried by the
# self-hosted plane. This drives it headlessly: a publisher and a subscriber join
# one room through our LiveKit, and we assert the subscriber actually RECEIVED
# media. A server that accepts connections but forwards nothing would pass a mere
# health check and fail here — which is the point.
#
# Exits 0 only on measured received traffic. Any other outcome is non-zero.
set -euo pipefail

CONF_DIR="$HOME/.config/papercusp-phone"
ENV_FILE="$CONF_DIR/livekit.env"
LK="$HOME/.local/bin/lk"
ROOM="p002-acceptance-$$"
DURATION="${DURATION:-15s}"

die() { printf '\n✗ %s\n' "$*" >&2; exit 1; }
say() { printf '  %s\n' "$*"; }

[[ -x "$LK" ]] || die "lk CLI not found at $LK"
[[ -f "$ENV_FILE" ]] || die "$ENV_FILE missing — run infra/phone-app/deploy.sh first"
# shellcheck disable=SC1090
set -a; source "$ENV_FILE"; set +a

export LIVEKIT_URL="${PHONE_LIVEKIT_URL:-ws://127.0.0.1:7890}"
export LIVEKIT_API_KEY="$PHONE_LIVEKIT_API_KEY"
export LIVEKIT_API_SECRET="$PHONE_LIVEKIT_API_SECRET"

printf '▸ P-002 acceptance — media through the self-hosted plane\n'
say "server : $LIVEKIT_URL"
say "room   : $ROOM"
say "window : $DURATION"

# Confirm we are talking to OUR instance and not the other project's on 7880.
case "$LIVEKIT_URL" in
  *:7890*) ;;
  *) die "refusing to run: LIVEKIT_URL is not our instance ($LIVEKIT_URL)" ;;
esac

curl -fsS --max-time 3 "http://127.0.0.1:7890/" >/dev/null 2>&1 \
  || die "our LiveKit is not answering on :7890"
say "health OK"

out="$(mktemp)"; trap 'rm -f "$out"' EXIT
printf '\n▸ Running load test (1 publisher → 1 subscriber)\n'
if ! "$LK" load-test \
      --room "$ROOM" \
      --audio-publishers 1 \
      --subscribers 1 \
      --duration "$DURATION" >"$out" 2>&1; then
  sed -n '1,40p' "$out" >&2
  die "lk load-test exited non-zero"
fi

sed -n '1,40p' "$out"

# The summary table reports per-subscriber received bytes/packets. Require a
# non-zero received figure: connection alone is not forwarding.
if grep -qiE '\| *0B? *\|.*\| *0 *\|' "$out" && ! grep -qiE '[1-9][0-9]*(\.[0-9]+)? ?(kB|MB|KB|B)\b' "$out"; then
  die "subscriber received no media — the server accepted the session but forwarded nothing"
fi

if ! grep -qiE 'received|bitrate|packets' "$out"; then
  die "load-test produced no measurement rows — cannot claim media flowed"
fi

printf '\n✓ P-002 acceptance PASSED — media carried end-to-end by our own server\n'
