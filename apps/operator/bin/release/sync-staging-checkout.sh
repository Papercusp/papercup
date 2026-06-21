#!/usr/bin/env bash
# sync-staging-checkout.sh — isolated-staging-tier-2026-06-21 (su, session e24ec9b4).
#
# Auto-advances the ISOLATED staging checkout ($PAPERCUSP_STAGING_ROOT) to the
# latest COMMITTED `staging` HEAD and restarts the :3170 operator — ONLY when the
# branch actually moved. This is what makes :3170 a clean, always-current staging
# tier (vs today's second-snapshot-of-the-live-working-tree behaviour).
#
# Reuses the release system's standalone setup-release-checkout.sh (worktree +
# git-archive submodules + hardlinked node_modules + SPA build) — no parallel
# checkout machinery. Driven by papercup-staging-sync.timer (systemd --user).
#
# Fail-safe by construction:
#   - HEAD-moved gate: no move → no rebuild, no restart (cheap no-op).
#   - flock: never overlaps itself or a manual run.
#   - setup-release-checkout.sh aborts NON-ZERO (workspace-resolution gate /
#     SPA-build failure) BEFORE any restart, so a bad staging commit can never
#     cut :3170 over to a tree that would crash-loop — the previous good
#     checkout keeps serving.
#
# Reverse the whole tier: stop+disable papercup-staging-sync.timer, delete the
# 50-staging-checkout.conf drop-in, daemon-reload, restart papercup-staging-api.
set -euo pipefail

INTEGRATION_ROOT="${PAPERCUSP_INTEGRATION_ROOT:-/home/marsh-office/papercupai-workspace/papercup}"
STAGING_ROOT="${PAPERCUSP_STAGING_ROOT:-/home/marsh-office/papercupai-workspace/papercup-staging}"
UNIT="${PAPERCUSP_STAGING_UNIT:-papercup-staging-api.service}"
HEALTH_URL="${PAPERCUSP_STAGING_HEALTH_URL:-http://127.0.0.1:3170/api/health}"
BRANCH="${PAPERCUSP_INTEGRATION_BRANCH:-staging}"

log() { echo "[staging-sync] $(date -Is) $*"; }

# Single-flight: a second timer tick (or a manual run) waits/skips rather than
# racing two setups on the same checkout.
exec 9>"/tmp/papercup-staging-sync.lock"
if ! flock -n 9; then
  log "another staging-sync holds the lock — skipping this tick"
  exit 0
fi

[ -d "$INTEGRATION_ROOT/.git" ] || { log "FATAL: integration root not a git repo: $INTEGRATION_ROOT"; exit 1; }

target="$(git -C "$INTEGRATION_ROOT" rev-parse --verify "${BRANCH}^{commit}")"
current="$(git -C "$STAGING_ROOT" rev-parse --verify HEAD 2>/dev/null || echo none)"

if [ "$target" = "$current" ]; then
  log "staging checkout already at ${target:0:8} — no-op"
  exit 0
fi

log "advancing staging checkout ${current:0:8} → ${target:0:8}"
PAPERCUSP_INTEGRATION_ROOT="$INTEGRATION_ROOT" PAPERCUSP_RELEASE_ROOT="$STAGING_ROOT" \
  bash "$INTEGRATION_ROOT/apps/operator/bin/release/setup-release-checkout.sh" \
    --ref "$BRANCH" --release "$STAGING_ROOT" --node-modules auto --build-spa

log "restarting $UNIT"
systemctl --user restart "$UNIT"

for i in $(seq 1 30); do
  code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 4 "$HEALTH_URL" 2>/dev/null || echo 000)"
  if [ "$code" = "200" ]; then
    log "✅ :3170 healthy on staging ${target:0:8}"
    exit 0
  fi
  sleep 2
done
log "⚠ :3170 did not return 200 within ~60s after restart (target ${target:0:8}) — check the operator journal"
exit 1
