#!/usr/bin/env bash
# Render, check, and install the hosted control-plane user unit (app.papercusp.com).
#
# unified-web-portal-2026-08-29 P-028. Sibling of deploy-cloud-portal.sh, same
# discipline: validate inputs, render the checked-in template, verify the unit,
# install it with an atomic rename. This script NEVER enables or starts the
# unit — cut-over is a deliberate, separate step taken only once `--check-env`
# reports every hosted literal SET *and* every *_REF reference actually
# RESOLVING against the encrypted store (D-037/D-044: never publish a
# half-configured or local-memory profile behind app.papercusp.com).
#
# The reference half is not a formality. A `*_REF` value is the NAME of a
# secret to look up, so a non-empty test proves only that a pointer string is
# present — it was once possible for this gate to exit 0 with the WorkOS
# secrets entirely absent from the store. Nothing dereferences the refs at
# boot either (the resolver is injected per-request in bin/hosted-handler.ts),
# so the unit would have started clean and passed /api/health while failing
# every real request. --check-env therefore dereferences each reference
# through resolveHostedSecretRef — the same resolver the runtime uses at point
# of use — via bin/hosted-check-refs.ts. See WI-2141402.
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

# The seven names hosted-runtime.ts reads (readHostedRuntimeConfiguration),
# split by what each name IS — because the correct check differs.
#
# LITERAL: the value is the configuration itself, so it is tested directly
# rather than dereferenced. A non-empty test alone is NOT sufficient: the
# hosted env file ships commented fill-me templates and the documented
# remediation is "uncomment and fill", so a half-followed remediation would
# otherwise pass the gate with a placeholder. See is_unfilled_placeholder.
LITERAL_NAMES=(
  PAPERCUSP_HOSTED_PUBLIC_ORIGIN
  PAPERCUSP_HOSTED_CONTROL_PLANE_WORKSPACE_ID
  WORKOS_CLIENT_ID
)
# REFERENCE: the value NAMES a secret the runtime dereferences at point of use
# (hosted-runtime.ts / hosted-auth-runtime.ts, via resolveHostedSecretRef). A
# non-empty test here proves only that a pointer is present, so these are
# RESOLVED against the encrypted store instead.
REF_NAMES=(
  PAPERCUSP_HOSTED_SESSION_COOKIE_SECRET_REF
  WORKOS_API_KEY_REF
  WORKOS_COOKIE_PASSWORD_REF
  WORKOS_WEBHOOK_SECRET_REF
)
# LABEL: optional, and despite the _REF suffix it is NOT a secret reference —
# nothing dereferences it. createWorkOsWebhookRoute passes it straight to the
# receipt store, which records it verbatim as provenance (workos-webhook-
# intake.ts safeExternalRef -> webhook_event_receipts.signature_key_ref); the
# secret that actually verifies a webhook is WORKOS_WEBHOOK_SECRET_REF above.
# So a natural value for it (a WorkOS signing-key id) is not resolvable, and
# resolving it here would fail a CORRECTLY configured deployment — the same
# gate-vs-runtime mismatch as WI-2141402, in the false-RED direction. Reported
# for the operator, never dereferenced.
OPTIONAL_LABEL_NAMES=(
  WORKOS_WEBHOOK_SECRET_KEY_REF
)
REQUIRED_NAMES=("${LITERAL_NAMES[@]}" "${REF_NAMES[@]}")

MODE="render-only"

log() { printf 'hosted-control-plane: %s\n' "$*"; }
die() { printf 'hosted-control-plane: ERROR: %s\n' "$*" >&2; exit 1; }

usage() {
  cat <<'EOF'
Usage: deploy-hosted-control-plane.sh [--render-only|--check-env|--install-only]

  --render-only  (default) validate inputs and print the rendered unit; do not
                 write or call systemd
  --check-env    report the seven hosted configuration names in the environment
                 the unit would assemble (operator .env.local then the hosted
                 env file): the three literals as set/UNSET/PLACEHOLDER — the
                 last meaning an uncommented but still-unfilled template value,
                 which fails the gate rather than passing it — and the four *_REF
                 references as resolved/UNRESOLVED — each dereferenced against
                 the encrypted store through the runtime's own resolver, so a
                 present-but-dangling pointer fails. Exit 1 while any is unset
                 or unresolved, or if the reference check cannot run. Prints
                 names and failure codes only — never values.
                 WORKOS_WEBHOOK_SECRET_KEY_REF is reported but NOT dereferenced
                 and never gates: despite the suffix it is a signing-key label
                 the runtime stores verbatim, not a secret reference.
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

# An unfilled template value is WORSE than an unset one: it satisfies a
# non-empty test while guaranteeing a runtime failure, so the gate would go
# green and the cut-over would publish a broken deployment. Recognise the
# fill-me shapes this deployment actually ships (WORKOS_CLIENT_ID is
# distributed commented-out as client_XXXX…) plus the usual template idioms.
#
# Deliberately narrow, to keep a real credential from ever tripping it: the
# X-run must be 6+ (a real WorkOS/ULID identifier reaching that is ~1e-9),
# and the word list matches only whole values or a your-/your_ prefix.
is_unfilled_placeholder() {
  local value="$1"
  [[ "$value" =~ XXXXXX ]] && return 0
  [[ "$value" == '<'*'>' ]] && return 0
  case "${value,,}" in
    changeme | change-me | change_me | placeholder | todo | tbd | example | \
    replace-me | replace_me | fixme | your-* | your_*) return 0 ;;
  esac
  return 1
}

check_env() {
  # Assemble exactly what the unit's ExecStart assembles, in a subshell, and
  # report presence only. Values are never printed.
  #
  # Literals get a non-empty test; references are dereferenced through the
  # runtime's own resolver so that `set` can never stand in for `resolves`.
  # Fails CLOSED: if the reference check cannot run at all, that is a failed
  # gate, not a pass.
  local status=0
  local report
  report="$(
    set +u
    set -a
    [[ -f "$OPERATOR_ROOT/.env.local" ]] && . "$OPERATOR_ROOT/.env.local"
    [[ -f "$HOSTED_ENV_FILE" ]] && . "$HOSTED_ENV_FILE"
    set +a
    # The resolver reads the encrypted store, so give it the same database
    # handle and integration root the unit's ExecStart exports.
    export HARNESS_ADMIN_DATABASE_URL="${HARNESS_ADMIN_DATABASE_URL:-${DATABASE_URL:-}}"
    export PAPERCUSP_INTEGRATION_ROOT="${PAPERCUSP_INTEGRATION_ROOT:-$REPO_ROOT}"

    rc=0
    for name in "${LITERAL_NAMES[@]}"; do
      literal_value="${!name:-}"
      if [[ -z "$literal_value" ]]; then
        printf '%s\tUNSET\n' "$name"; rc=1
      elif is_unfilled_placeholder "$literal_value"; then
        # Distinct from UNSET on purpose: this one means the remediation was
        # started (line uncommented) but not finished (value not filled in).
        printf '%s\tPLACEHOLDER\tunfilled_template\n' "$name"; rc=1
      else
        printf '%s\tset\n' "$name"
      fi
    done

    if ! cd "$OPERATOR_ROOT" 2>/dev/null; then
      printf 'REFERENCE_CHECK\tUNAVAILABLE\toperator_root_unreadable\n'
      exit 1
    fi
    npx tsx bin/hosted-check-refs.ts --required "${REF_NAMES[@]}" || rc=1

    # Labels are reported, never dereferenced, and never gate the cut-over.
    for name in "${OPTIONAL_LABEL_NAMES[@]}"; do
      if [[ -n "${!name:-}" ]]; then printf '%s\tset\tlabel_not_dereferenced\n' "$name"
      else printf '%s\tabsent-optional\n' "$name"; fi
    done
    exit "$rc"
  )" || status=$?
  printf '%s\n' "$report"
  [[ -f "$HOSTED_ENV_FILE" ]] || log "hosted env file absent: $HOSTED_ENV_FILE"
  return "$status"
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
