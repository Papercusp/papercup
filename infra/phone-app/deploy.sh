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
#   deploy.sh --hosted         require + persist a public wss:// browser URL
#   deploy.sh --render-only    validate + prepare config, no services or key minting
#   deploy.sh --preflight      check public DNS + trusted TLS, no writes or restarts
#   deploy.sh --rotate-secret  mint a fresh secret and restart both units
#   deploy.sh --status         report only, change nothing
#   deploy.sh --pin-artifacts  pin reviewed source and binary bytes, no restart
#   deploy.sh --verify-artifacts  check the pin without changing anything
set -euo pipefail

HERE="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
CONF_DIR="${PHONE_CONFIG_DIR:-$HOME/.config/papercusp-phone}"
ENV_FILE="$CONF_DIR/livekit.env"
UNIT_DIR="$HOME/.config/systemd/user"
LK_BIN="${PHONE_LIVEKIT_BIN:-$HOME/.local/bin/livekit-server}"
SIP_BIN="${PHONE_SIP_BIN:-$HOME/.local/bin/livekit-sip}"
HEALTH_URL="http://127.0.0.1:7890/"
UNITS=(papercusp-phone-livekit.service papercusp-phone-sip.service)

# The P-004 agent worker. Its tree is NOT in this repo — it is its own git repo
# under .papercusp-workspaces/<workspace>/.papercusp/apps/phone-app — so unlike
# the two media-plane units this one is rendered from a template with a real
# path. Overridable because the workspace segment is the one part of it that is
# genuinely machine-specific.
WORKER_UNIT="papercusp-phone-worker.service"
WORKER_DIR="${PHONE_WORKER_DIR:-$HOME/.papercusp-workspaces/papercusp-workspace/.papercusp/apps/phone-app/worker}"
NODE_BIN="${PHONE_NODE_BIN:-$(command -v node || echo /usr/bin/node)}"

# The portal-facing sidecar (WI-1409555) — same out-of-repo tree as the worker,
# so same rendered-template treatment. It is what lets the Portal at :3801 start
# a call; without it the Phone surface renders but "Call assistant" cannot mint
# a room.
SIDECAR_UNIT="papercusp-phone-sidecar.service"
SIDECAR_DIR="${PHONE_SIDECAR_DIR:-$HOME/.papercusp-workspaces/papercusp-workspace/.papercusp/apps/phone-app/apps/sidecar}"
# The portal↔sidecar shared bearer secret. Kept OUT of livekit.env on purpose:
# that file is the media credential of record and the portal must never be given
# it, but the portal DOES need this one.
PORTAL_ENV_FILE="$CONF_DIR/portal.env"
PIN_FILE="$CONF_DIR/artifacts.sha256"

# Capture caller overrides BEFORE sourcing the persisted file. `source` quite
# correctly restores the last deployment, but without this snapshot it also
# erases an explicit URL supplied for THIS convergence.
REQUESTED_LIVEKIT_URL="${PHONE_LIVEKIT_URL:-}"
REQUESTED_LIVEKIT_PUBLIC_URL="${PHONE_LIVEKIT_PUBLIC_URL:-}"
MEDIA_KEYS=(PHONE_TURN_DOMAIN PHONE_TURN_CERT_FILE PHONE_TURN_KEY_FILE PHONE_TURN_TLS_PORT)
declare -A REQUESTED_MEDIA=()
for key in "${MEDIA_KEYS[@]}"; do
  [[ ! -v "$key" ]] || REQUESTED_MEDIA[$key]="${!key}"
done

ROTATE=0; STATUS_ONLY=0; HOSTED=0; RENDER_ONLY=0; PREFLIGHT_ONLY=0; PIN_ONLY=0; VERIFY_PIN_ONLY=0
for a in "$@"; do
  case "$a" in
    --rotate-secret) ROTATE=1 ;;
    --status) STATUS_ONLY=1 ;;
    --hosted) HOSTED=1 ;;
    --render-only) RENDER_ONLY=1 ;;
    --preflight) PREFLIGHT_ONLY=1 ;;
    --pin-artifacts) PIN_ONLY=1 ;;
    --verify-artifacts) VERIFY_PIN_ONLY=1 ;;
    -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
    *) echo "unknown argument: $a" >&2; exit 2 ;;
  esac
done

say() { printf '  %s\n' "$*"; }
step() { printf '\n▸ %s\n' "$*"; }
die() { printf '\n✗ %s\n' "$*" >&2; exit 1; }

upsert_env_var() {
  local key="$1" value="$2" tmp
  [[ "$key" =~ ^[A-Z][A-Z0-9_]*$ ]] || die "invalid env key: $key"
  [[ "$value" != *$'\n'* && "$value" != *$'\r'* ]] || die "$key contains a newline"
  tmp="$(mktemp "$CONF_DIR/.livekit.env.XXXXXX")"
  awk -v key="$key" '$0 !~ ("^" key "=") { print }' "$ENV_FILE" > "$tmp"
  # Persist shell-safe values; cert paths may contain spaces or shell punctuation.
  printf '%s=%q\n' "$key" "$value" >> "$tmp"
  chmod 600 "$tmp"
  mv "$tmp" "$ENV_FILE"
}

report_status() {
  # A green LiveKit HTTP endpoint alone is NOT Phone readiness: SIP, the
  # worker and the portal sidecar may independently be down. This path is
  # read-only, fails closed, and deliberately does not imply public calling.
  [[ -f "$ENV_FILE" ]] && { set -a; source "$ENV_FILE"; set +a; }
  export PHONE_LIVEKIT_URL="${PHONE_LIVEKIT_URL:-ws://127.0.0.1:7890}"
  export PHONE_SIDECAR_URL="${PHONE_SIDECAR_URL:-ws://127.0.0.1:8793}"
  "$NODE_BIN" "$HERE/media-config.mjs" local-readiness
}

# Pin the maintained Phone git tree and the exact executable/config bytes that
# deploy.sh will use. Credentials and rendered configs are deliberately excluded.
# The phone tree is a separate repo; a clean commit pins its complete tracked
# source, while the sha256 lines pin host binaries and this deployment source.
phone_source_revision() {
  [[ -d "$WORKER_DIR" && -d "$SIDECAR_DIR" ]] || die "Phone worker and sidecar source are required for an artifact pin"
  local worker_root sidecar_root dirty revision
  worker_root="$(git -C "$WORKER_DIR" rev-parse --show-toplevel)" || die "Phone worker is not in a git tree"
  sidecar_root="$(git -C "$SIDECAR_DIR" rev-parse --show-toplevel)" || die "Phone sidecar is not in a git tree"
  [[ "$worker_root" == "$sidecar_root" ]] || die "Phone worker and sidecar must share one source revision"
  dirty="$(git -C "$worker_root" status --porcelain)" || die "cannot inspect Phone source changes"
  [[ -z "$dirty" ]] || die "Phone source is not clean; pin a committed candidate"
  revision="$(git -C "$worker_root" rev-parse HEAD)" || die "cannot resolve Phone source revision"
  [[ "$revision" =~ ^[0-9a-f]{40}$ ]] || die "invalid Phone source revision"
  printf '%s\n' "$revision"
}

artifact_files() {
  ARTIFACT_FILES=(
    "$HERE/deploy.sh" "$HERE/media-config.mjs" "$HERE/verify-media-plane.sh"
    "$HERE/livekit-server.yaml.tmpl" "$HERE/livekit-sip.yaml.tmpl"
    "$HERE/systemd/papercusp-phone-livekit.service"
    "$HERE/systemd/papercusp-phone-sip.service"
    "$HERE/systemd/$WORKER_UNIT.tmpl" "$HERE/systemd/$SIDECAR_UNIT.tmpl"
    "$LK_BIN" "$SIP_BIN" "$NODE_BIN"
  )
  local file
  for file in "${ARTIFACT_FILES[@]}"; do
    [[ -f "$file" ]] || die "artifact missing: $file"
  done
}

verify_artifacts() {
  local manifest="${1:-$PIN_FILE}" marker revision actual pinned current
  [[ -f "$manifest" ]] || die "artifact pin missing: $manifest; prepare it with --pin-artifacts"
  read -r marker revision < "$manifest" || die "invalid artifact pin"
  [[ "$marker" == PHONE_ARTIFACT_PIN_V1 && "$revision" =~ ^[0-9a-f]{40}$ ]] || die "invalid artifact pin header"
  actual="$(phone_source_revision)" || exit 1
  [[ "$actual" == "$revision" ]] || die "Phone source revision differs from artifact pin"
  artifact_files
  pinned="$(tail -n +2 "$manifest")" || die "cannot read artifact pin"
  current="$(sha256sum -- "${ARTIFACT_FILES[@]}")" || die "cannot hash Phone artifacts"
  # Exact ordered manifest equality also refuses a truncated/duplicate manifest;
  # sha256sum -c alone would accept a file that simply omitted an artifact.
  [[ "$current" == "$pinned" ]] || die "artifact bytes differ from pin"
}

pin_artifacts() {
  local revision tmp
  revision="$(phone_source_revision)" || exit 1
  artifact_files
  mkdir -p "$CONF_DIR"; chmod 700 "$CONF_DIR"
  tmp="$(mktemp "$CONF_DIR/.artifacts.sha256.XXXXXX")"
  trap 'rm -f "$tmp"' EXIT
  if ! { printf 'PHONE_ARTIFACT_PIN_V1 %s\n' "$revision"; sha256sum -- "${ARTIFACT_FILES[@]}"; } > "$tmp"; then
    rm -f "$tmp"; die "could not hash Phone artifacts"
  fi
  chmod 600 "$tmp"
  verify_artifacts "$tmp"
  mv -f "$tmp" "$PIN_FILE"
  trap - EXIT
  say "pinned Phone source revision $revision and ${#ARTIFACT_FILES[@]} artifact files in $PIN_FILE"
}

if [[ $STATUS_ONLY == 1 ]]; then report_status; exit 0; fi
if [[ $PIN_ONLY == 1 || $VERIFY_PIN_ONLY == 1 ]]; then
  [[ $ROTATE == 0 && $RENDER_ONLY == 0 && $PREFLIGHT_ONLY == 0 && $STATUS_ONLY == 0 && $HOSTED == 0 && $PIN_ONLY != $VERIFY_PIN_ONLY ]] || die "artifact pin actions cannot be combined"
  if [[ $PIN_ONLY == 1 ]]; then pin_artifacts; else verify_artifacts; say "Phone artifacts match pin"; fi
  exit 0
fi
if [[ $PREFLIGHT_ONLY == 1 ]]; then
  [[ $ROTATE == 0 && $RENDER_ONLY == 0 ]] || die "preflight cannot render or rotate credentials"
  if [[ -f "$ENV_FILE" ]]; then
    set -a; source "$ENV_FILE"; set +a
  fi
  PHONE_LIVEKIT_PUBLIC_URL="${REQUESTED_LIVEKIT_PUBLIC_URL:-${PHONE_LIVEKIT_PUBLIC_URL:-}}"
  for key in "${MEDIA_KEYS[@]}"; do
    [[ ! -v REQUESTED_MEDIA[$key] ]] || printf -v "$key" '%s' "${REQUESTED_MEDIA[$key]}"
    export "$key"
  done
  export PHONE_LIVEKIT_PUBLIC_URL
  "$NODE_BIN" "$HERE/media-config.mjs" preflight
  exit $?
fi
if [[ $RENDER_ONLY == 1 ]]; then
  [[ $ROTATE == 0 ]] || die "preparation/preflight cannot rotate credentials"
  [[ -f "$ENV_FILE" ]] || die "preparation/preflight requires an existing external livekit.env"
fi

# A live convergence (including secret rotation) is admitted only for the
# reviewed Phone source and exact host binaries/config source pinned above.
if [[ $RENDER_ONLY == 0 ]]; then verify_artifacts; fi

# ---------------------------------------------------------------- preflight
if [[ $RENDER_ONLY == 0 ]]; then
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

fi
LAN_IFACE="${PHONE_LAN_IFACE:-$(ip route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="dev"){print $(i+1); exit}}')}"
[[ -n "$LAN_IFACE" ]] || die "could not determine the LAN interface from the default route"
[[ "$LAN_IFACE" =~ ^[a-zA-Z0-9_.:-]+$ ]] || die "invalid LAN interface"
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
  printf 'PHONE_LIVEKIT_API_KEY=%s\nPHONE_LIVEKIT_API_SECRET=%s\n' \
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
say "API credentials present (withheld)"

# Internal control and browser signalling are two views of the same media
# plane. Local installs use loopback for both. Hosted installs keep the worker
# and RoomService client on the internal URL while returning public WSS to the
# browser; conflating them either leaks loopback to visitors or hairpins the
# sidecar through its own public edge.
PHONE_LIVEKIT_URL="${REQUESTED_LIVEKIT_URL:-${PHONE_LIVEKIT_URL:-ws://127.0.0.1:7890}}"
PHONE_LIVEKIT_PUBLIC_URL="${REQUESTED_LIVEKIT_PUBLIC_URL:-${PHONE_LIVEKIT_PUBLIC_URL:-}}"
[[ "$PHONE_LIVEKIT_URL" =~ ^wss?://[^[:space:]]+$ ]] \
  || die "PHONE_LIVEKIT_URL must be a ws:// or wss:// URL"
if [[ -n "$PHONE_LIVEKIT_PUBLIC_URL" && ! "$PHONE_LIVEKIT_PUBLIC_URL" =~ ^wss?://[^[:space:]]+$ ]]; then
  die "PHONE_LIVEKIT_PUBLIC_URL must be a ws:// or wss:// URL"
fi
for key in "${MEDIA_KEYS[@]}"; do
  [[ ! -v REQUESTED_MEDIA[$key] ]] || printf -v "$key" '%s' "${REQUESTED_MEDIA[$key]}"
  export "$key"
done
export PHONE_LIVEKIT_URL PHONE_LIVEKIT_PUBLIC_URL
MEDIA_ARGS=()
[[ $HOSTED == 0 ]] || MEDIA_ARGS+=(--hosted)
PHONE_TURN_TLS_CONFIG="$("$NODE_BIN" "$HERE/media-config.mjs" turn-config "${MEDIA_ARGS[@]}")" \
  || die "public media prerequisites failed; configuration was not changed"
if [[ $HOSTED == 1 && $RENDER_ONLY == 0 ]]; then
  "$NODE_BIN" "$HERE/media-config.mjs" public-dns \
    || die "hosted media DNS is not public; refusing runtime convergence"
fi
upsert_env_var "PHONE_LIVEKIT_URL" "$PHONE_LIVEKIT_URL"
if [[ -n "$PHONE_LIVEKIT_PUBLIC_URL" ]]; then
  upsert_env_var "PHONE_LIVEKIT_PUBLIC_URL" "$PHONE_LIVEKIT_PUBLIC_URL"
fi
for key in "${MEDIA_KEYS[@]}"; do
  [[ -z "${!key:-}" ]] || upsert_env_var "$key" "${!key}"
done
say "internal LiveKit URL: $PHONE_LIVEKIT_URL"
if [[ -n "$PHONE_LIVEKIT_PUBLIC_URL" ]]; then
  say "browser LiveKit URL: $PHONE_LIVEKIT_PUBLIC_URL"
fi

# ---------------------------------------------------------------- render
# Pure-bash substitution: no sed escaping hazards with base64 secrets.
render() {
  local tmpl="$1" out="$2" content
  content="$(cat "$tmpl")"
  content="${content//'${PHONE_LIVEKIT_API_KEY}'/$PHONE_LIVEKIT_API_KEY}"
  content="${content//'${PHONE_LIVEKIT_API_SECRET}'/$PHONE_LIVEKIT_API_SECRET}"
  content="${content//'${PHONE_LAN_IFACE}'/$LAN_IFACE}"
  content="${content//'${PHONE_TURN_TLS_CONFIG}'/$PHONE_TURN_TLS_CONFIG}"
  content="${content//'${PHONE_WORKER_DIR}'/$WORKER_DIR}"
  content="${content//'${PHONE_SIDECAR_DIR}'/$SIDECAR_DIR}"
  content="${content//'${PHONE_NODE_BIN}'/$NODE_BIN}"
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
if [[ $RENDER_ONLY == 1 ]]; then
  say "configuration prepared only; no runtime, DNS, firewall or audio acceptance claimed"
  exit 0
fi

# ---------------------------------------------------------------- units
step "Install units"
mkdir -p "$UNIT_DIR"
for u in "${UNITS[@]}"; do install -m 644 "$HERE/systemd/$u" "$UNIT_DIR/$u"; say "installed $u"; done

# The worker unit is RENDERED (machine paths), and only when the worker tree is
# actually present. Installing a unit whose WorkingDirectory does not exist buys
# nothing but a crash-loop that StartLimitBurst then freezes — a confusing
# `failed` in the Phone pane instead of an honest "not installed here".
if [[ -d "$WORKER_DIR" ]]; then
  render "$HERE/systemd/$WORKER_UNIT.tmpl" "$UNIT_DIR/$WORKER_UNIT"
  chmod 644 "$UNIT_DIR/$WORKER_UNIT"   # render() writes 0600 for secret files; a unit is not one
  UNITS+=("$WORKER_UNIT")
  say "rendered $WORKER_UNIT (worker dir: $WORKER_DIR, node: $NODE_BIN)"
else
  say "SKIP $WORKER_UNIT — no worker tree at $WORKER_DIR (set PHONE_WORKER_DIR to override)"
fi

# The sidecar, on the same present-or-skip rule as the worker.
if [[ -d "$SIDECAR_DIR" ]]; then
  # Mint the portal↔sidecar secret ONCE and never rotate it silently: both sides
  # read this file, so regenerating it on every deploy would break a running
  # portal's bearer until someone restarted it with the new value.
  if [[ ! -s "$PORTAL_ENV_FILE" ]] || ! grep -q '^PHONE_AUTH_SECRET=' "$PORTAL_ENV_FILE" 2>/dev/null; then
    mkdir -p "$CONF_DIR"
    ( umask 077; printf 'PHONE_AUTH_SECRET=%s\n' "$(openssl rand -hex 32)" > "$PORTAL_ENV_FILE" )
    chmod 600 "$PORTAL_ENV_FILE"
    say "minted PHONE_AUTH_SECRET into $PORTAL_ENV_FILE (portal must be started with it)"
  fi
  render "$HERE/systemd/$SIDECAR_UNIT.tmpl" "$UNIT_DIR/$SIDECAR_UNIT"
  chmod 644 "$UNIT_DIR/$SIDECAR_UNIT"   # render() writes 0600 for secret files; a unit is not one
  UNITS+=("$SIDECAR_UNIT")
  say "rendered $SIDECAR_UNIT (sidecar dir: $SIDECAR_DIR, node: $NODE_BIN)"
else
  say "SKIP $SIDECAR_UNIT — no sidecar tree at $SIDECAR_DIR (set PHONE_SIDECAR_DIR to override)"
fi
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
