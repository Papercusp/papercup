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
PRODUCTION_RELEASE=""

log() { printf 'hosted-control-plane: %s\n' "$*"; }
die() { printf 'hosted-control-plane: ERROR: %s\n' "$*" >&2; exit 1; }

usage() {
  cat <<'EOF'
Usage: deploy-hosted-control-plane.sh [--render-only|--check-env|--install-only|--check-release]
                                    [--production-release <full-green-main-sha>]

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
  --production-release <sha>
                 require a detached, clean checkout at the exact green main pin
                 and a prebuilt bundle with a valid bundle-host freshness proof.
                 Render a production boot that sources only the injected hosted
                 env file and checks the proof again before every start. Build
                 with PAPERCUSP_BUNDLE_REUSE_FRESH=1 before installing.
  --check-release validate that production release without writing or starting
                 anything; requires --production-release.

Environment overrides:
  PAPERCUSP_HOSTED_CP_REPO_ROOT, PAPERCUSP_HOSTED_CP_PORT (default 3880),
  PAPERCUSP_HOSTED_CP_ENV_FILE (default ~/.config/papercusp/hosted-control-plane.env),
  PAPERCUSP_HOSTED_CP_NODE, PAPERCUSP_HOSTED_CP_UNIT_DIR, PAPERCUSP_HOSTED_CP_UNIT,
  PAPERCUSP_HOSTED_CP_SYSTEMCTL, PAPERCUSP_HOSTED_CP_SYSTEMD_ANALYZE
EOF
}

while (($#)); do
  case "$1" in
    --render-only) MODE="render-only" ;;
    --check-env) MODE="check-env" ;;
    --install-only) MODE="install-only" ;;
    --check-release) MODE="check-release" ;;
    --production-release)
      [[ $# -ge 2 && "$2" =~ ^[0-9a-f]{40}$ ]] || die "production release requires a full commit SHA"
      PRODUCTION_RELEASE="$2"; shift ;;
    -h | --help) usage; exit 0 ;;
    *) usage >&2; exit 2 ;;
  esac
  shift
done

if [[ "${PAPERCUSP_DEPLOYMENT_ENVIRONMENT:-}" == production || "$MODE" == check-release ]]; then
  [[ -n "$PRODUCTION_RELEASE" ]] || die "production requires --production-release <full-green-main-sha>"
fi

[[ -f "$TEMPLATE" ]] || die "template not found: $TEMPLATE"
[[ -d "$OPERATOR_ROOT" && -f "$OPERATOR_ROOT/bin/serve.ts" ]] || die "operator checkout not found at $OPERATOR_ROOT"
[[ "$PORT" =~ ^[0-9]{2,5}$ ]] || die "port must be numeric: $PORT"
[[ -n "$NODE_BIN" && -x "$NODE_BIN" ]] || die "node binary not found (set PAPERCUSP_HOSTED_CP_NODE)"
NODE_DIR="$(dirname -- "$(readlink -f -- "$NODE_BIN")")"

check_production_release() {
  local main_sha head_sha value
  # Same trust anchor as release/deploy.ts gatherPlan: main is written only by
  # the green-checkpoint. Never accept an arbitrary configurable branch here.
  main_sha="$(git -C "$REPO_ROOT" rev-parse --verify 'refs/heads/main^{commit}')" || die "green main pin is unavailable"
  [[ "$main_sha" == "$PRODUCTION_RELEASE" ]] || die "requested production release is not the green main pin"
  head_sha="$(git -C "$REPO_ROOT" rev-parse --verify 'HEAD^{commit}')" || die "release HEAD is unavailable"
  [[ "$head_sha" == "$PRODUCTION_RELEASE" ]] || die "release checkout does not match requested SHA"
  if git -C "$REPO_ROOT" symbolic-ref -q HEAD >/dev/null; then
    die "production requires a detached release checkout"
  fi
  # These paths become both shell and systemd syntax. Refuse unsafe bytes
  # before rendering instead of letting a path change the generated command.
  for value in "$REPO_ROOT" "$HOSTED_ENV_FILE" "$NODE_BIN"; do
    [[ "$value" =~ ^/[a-zA-Z0-9_./:@+-]+$ ]] || die "production paths must be absolute and contain no shell/systemd metacharacters"
  done
  [[ ! -e "$OPERATOR_ROOT/dist-hosted-control-plane/.bundle-stale.json" ]] || die "production bundle is marked stale"
  "$NODE_BIN" "$OPERATOR_ROOT/bin/bundle-host-freshness.mjs" check \
    --repo-root "$REPO_ROOT" --entry "$OPERATOR_ROOT/bin/serve.ts" \
    --outfile "$OPERATOR_ROOT/dist-hosted-control-plane/serve.mjs" \
    --manifest "$OPERATOR_ROOT/dist-hosted-control-plane/.bundle-fresh.json" >/dev/null \
    || die "production bundle freshness proof failed"
}

[[ -z "$PRODUCTION_RELEASE" ]] || check_production_release

render_boot() {
  local line
  while IFS= read -r line; do
    case "$line" in
      @BUNDLE_POLICY@)
        if [[ -n "$PRODUCTION_RELEASE" ]]; then
          printf '%s\n' 'Environment=PAPERCUSP_DEPLOYMENT_ENVIRONMENT=production'
        else
          printf '%s\n' 'Environment=PAPERCUSP_BUNDLE_ALLOW_STALE_START=1'
        fi ;;
      @BUNDLE_PRE_START@)
        if [[ -n "$PRODUCTION_RELEASE" ]]; then
          printf '%s\n' "ExecStartPre=/usr/bin/bash @OPERATOR_ROOT@/scripts/systemd/deploy-hosted-control-plane.sh --check-release --production-release $PRODUCTION_RELEASE"
        else
          printf '%s\n' 'ExecStartPre=/usr/bin/bash @OPERATOR_ROOT@/scripts/systemd/papercusp-script-snapshot.sh @OPERATOR_ROOT@/bin/bundle-host.sh bin/serve.ts dist-hosted-control-plane/serve.mjs'
        fi ;;
      @HOSTED_EXEC_START@)
        if [[ -n "$PRODUCTION_RELEASE" ]]; then
          cat <<'PRODUCTION_BOOT'
ExecStart=/usr/bin/bash -ec 'set -a; . "@HOSTED_ENV_FILE@"; set +a; export PAPERCUSP_DEPLOYMENT_ENVIRONMENT=production PAPERCUSP_DISTRIBUTION_PROFILE=hosted-control-plane PAPERCUSP_ENV_OPERATOR_ID=hosted-control-plane PAPERCUSP_USE_EMBEDDED_PG=0 PAPERCUSP_HONO_PORT=@PORT@ PAPERCUSP_BIND_HOST=127.0.0.1 PAPERCUSP_BACKGROUND_WORKERS=0; exec node dist-hosted-control-plane/serve.mjs'
PRODUCTION_BOOT
        else
          cat <<'DEVELOPMENT_BOOT'
ExecStart=/usr/bin/bash -c 'set -a; [ -f .env.local ] && . ./.env.local; [ -f "@HOSTED_ENV_FILE@" ] && . "@HOSTED_ENV_FILE@"; set +a; export HARNESS_ADMIN_DATABASE_URL="$${HARNESS_ADMIN_DATABASE_URL:-$$DATABASE_URL}" PAPERCUSP_DISTRIBUTION_PROFILE=hosted-control-plane PAPERCUSP_ENV_OPERATOR_ID=hosted-control-plane PAPERCUSP_USE_EMBEDDED_PG=0 PAPERCUSP_HONO_PORT=@PORT@ PAPERCUSP_BIND_HOST=127.0.0.1 PAPERCUSP_BACKGROUND_WORKERS=0; exec node dist-hosted-control-plane/serve.mjs'
DEVELOPMENT_BOOT
        fi ;;
      *) printf '%s\n' "$line" ;;
    esac
  done < "$TEMPLATE"
}

render() {
  render_boot |
  sed \
    -e "s|@PORT@|$PORT|g" \
    -e "s|@OPERATOR_ROOT@|$OPERATOR_ROOT|g" \
    -e "s|@REPO_ROOT@|$REPO_ROOT|g" \
    -e "s|@HOSTED_ENV_FILE@|$HOSTED_ENV_FILE|g" \
    -e "s|@NODE_DIR@|$NODE_DIR|g"
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
    if [[ -z "$PRODUCTION_RELEASE" && -f "$OPERATOR_ROOT/.env.local" ]]; then . "$OPERATOR_ROOT/.env.local"; fi
    [[ -f "$HOSTED_ENV_FILE" ]] && . "$HOSTED_ENV_FILE"
    set +a
    # The resolver reads the encrypted store, so give it the same database
    # handle and integration root the unit's ExecStart exports.
    if [[ -n "$PRODUCTION_RELEASE" ]]; then
      export PAPERCUSP_DEPLOYMENT_ENVIRONMENT=production
    else
      export HARNESS_ADMIN_DATABASE_URL="${HARNESS_ADMIN_DATABASE_URL:-${DATABASE_URL:-}}"
    fi
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
  check-release)
    log "production release proof verified: $PRODUCTION_RELEASE"
    ;;
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
