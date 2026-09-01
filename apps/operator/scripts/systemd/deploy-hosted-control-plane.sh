#!/usr/bin/env bash
# Render, check, and install the hosted control-plane user unit (app.papercusp.com).
#
# unified-web-portal-2026-08-29 P-028. Sibling of deploy-cloud-portal.sh, same
# discipline: validate inputs, render the checked-in template, verify the unit,
# install it with an atomic rename. This script NEVER enables or starts the
# unit — cut-over is a deliberate, separate step taken only once `--check-env`
# reports every hosted reference present (D-037/D-044: never publish a
# half-configured or local-memory profile behind app.papercusp.com).
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
TEMPLATE="${PAPERCUSP_HOSTED_CP_TEMPLATE:-$SCRIPT_DIR/papercusp-hosted-control-plane.service.in}"

: "${HOME:?HOME must be set for the user-service deployment}"

REPO_ROOT="${PAPERCUSP_HOSTED_CP_REPO_ROOT:-$(cd -- "$SCRIPT_DIR/../../../.." && pwd)}"
OPERATOR_ROOT="$REPO_ROOT/apps/operator"
PORT="${PAPERCUSP_HOSTED_CP_PORT:-3880}"
HOSTED_ENV_FILE="${PAPERCUSP_HOSTED_CP_ENV_FILE:-${XDG_CONFIG_HOME:-$HOME/.config}/papercusp/hosted-control-plane.env}"
NODE_BIN="${PAPERCUSP_HOSTED_CP_NODE:-$(command -v node || true)}"
UNIT_NAME="${PAPERCUSP_HOSTED_CP_UNIT:-papercusp-hosted-control-plane.service}"
UNIT_DIR="${PAPERCUSP_HOSTED_CP_UNIT_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user}"
SYSTEMCTL_BIN="${PAPERCUSP_HOSTED_CP_SYSTEMCTL:-systemctl}"
SYSTEMD_ANALYZE_BIN="${PAPERCUSP_HOSTED_CP_SYSTEMD_ANALYZE:-systemd-analyze}"

# The seven names hosted-runtime.ts reads (readHostedRuntimeConfiguration).
REQUIRED_NAMES=(
  PAPERCUSP_HOSTED_PUBLIC_ORIGIN
  PAPERCUSP_HOSTED_CONTROL_PLANE_WORKSPACE_ID
  PAPERCUSP_HOSTED_SESSION_COOKIE_SECRET_REF
  WORKOS_CLIENT_ID
  WORKOS_API_KEY_REF
  WORKOS_COOKIE_PASSWORD_REF
  WORKOS_WEBHOOK_SECRET_REF
)

MODE="render-only"

log() { printf 'hosted-control-plane: %s\n' "$*"; }
die() { printf 'hosted-control-plane: ERROR: %s\n' "$*" >&2; exit 1; }

usage() {
  cat <<'EOF'
Usage: deploy-hosted-control-plane.sh [--render-only|--check-env|--install-only]

  --render-only  (default) validate inputs and print the rendered unit; do not
                 write or call systemd
  --check-env    report which of the seven hosted configuration names are SET
                 in the environment the unit would assemble (operator .env.local
                 then the hosted env file). Exit 1 while any is unset. Prints
                 names only — never values.
  --install-only atomically install + verify + daemon-reload the unit. Does NOT
                 enable or start it.

Environment overrides:
  PAPERCUSP_HOSTED_CP_REPO_ROOT, PAPERCUSP_HOSTED_CP_PORT (default 3880),
  PAPERCUSP_HOSTED_CP_ENV_FILE (default ~/.config/papercusp/hosted-control-plane.env),
  PAPERCUSP_HOSTED_CP_NODE, PAPERCUSP_HOSTED_CP_UNIT_DIR, PAPERCUSP_HOSTED_CP_UNIT,
  PAPERCUSP_HOSTED_CP_SYSTEMCTL, PAPERCUSP_HOSTED_CP_SYSTEMD_ANALYZE
EOF
}

case "${1:-}" in
  "" | --render-only) MODE="render-only" ;;
  --check-env) MODE="check-env" ;;
  --install-only) MODE="install-only" ;;
  -h | --help) usage; exit 0 ;;
  *) usage >&2; exit 2 ;;
esac

[[ -f "$TEMPLATE" ]] || die "template not found: $TEMPLATE"
[[ -d "$OPERATOR_ROOT" && -f "$OPERATOR_ROOT/bin/serve.ts" ]] || die "operator checkout not found at $OPERATOR_ROOT"
[[ "$PORT" =~ ^[0-9]{2,5}$ ]] || die "port must be numeric: $PORT"
[[ -n "$NODE_BIN" && -x "$NODE_BIN" ]] || die "node binary not found (set PAPERCUSP_HOSTED_CP_NODE)"
NODE_DIR="$(dirname -- "$(readlink -f -- "$NODE_BIN")")"

render() {
  sed \
    -e "s|@PORT@|$PORT|g" \
    -e "s|@OPERATOR_ROOT@|$OPERATOR_ROOT|g" \
    -e "s|@REPO_ROOT@|$REPO_ROOT|g" \
    -e "s|@HOSTED_ENV_FILE@|$HOSTED_ENV_FILE|g" \
    -e "s|@NODE_DIR@|$NODE_DIR|g" \
    "$TEMPLATE"
}

check_env() {
  # Assemble exactly what the unit's ExecStart assembles, in a subshell, and
  # report presence only. Values are never printed.
  local missing=0 name
  local report
  report="$(
    set +u
    set -a
    [[ -f "$OPERATOR_ROOT/.env.local" ]] && . "$OPERATOR_ROOT/.env.local"
    [[ -f "$HOSTED_ENV_FILE" ]] && . "$HOSTED_ENV_FILE"
    set +a
    for name in "${REQUIRED_NAMES[@]}"; do
      if [[ -n "${!name:-}" ]]; then printf '%s\tset\n' "$name"; else printf '%s\tUNSET\n' "$name"; fi
    done
  )"
  printf '%s\n' "$report"
  if grep -q $'\tUNSET$' <<<"$report"; then missing=1; fi
  [[ -f "$HOSTED_ENV_FILE" ]] || log "hosted env file absent: $HOSTED_ENV_FILE"
  return "$missing"
}

case "$MODE" in
  render-only)
    render
    ;;
  check-env)
    if check_env; then log "all hosted configuration names are set"; else die "hosted configuration incomplete (see UNSET rows above)"; fi
    ;;
  install-only)
    mkdir -p "$UNIT_DIR"
    # systemd-analyze verify refuses a file whose name is not a unit name, so the
    # staging copy keeps the real unit name inside a private temp directory.
    tmpdir="$(mktemp -d "$UNIT_DIR/.stage-hosted-cp.XXXXXX")"
    tmp="$tmpdir/$UNIT_NAME"
    trap 'rm -rf "$tmpdir"' EXIT
    render >"$tmp"
    if command -v "$SYSTEMD_ANALYZE_BIN" >/dev/null 2>&1; then
      "$SYSTEMD_ANALYZE_BIN" --user verify "$tmp" || die "rendered unit failed systemd-analyze verify"
    fi
    chmod 0644 "$tmp"
    mv -f "$tmp" "$UNIT_DIR/$UNIT_NAME"
    rm -rf "$tmpdir"
    trap - EXIT
    "$SYSTEMCTL_BIN" --user daemon-reload
    log "installed $UNIT_DIR/$UNIT_NAME (not enabled, not started)"
    log "next: $0 --check-env, then: systemctl --user start $UNIT_NAME"
    ;;
esac
