#!/usr/bin/env bash
# psu-sentinel — dock 🛡 Sentinel pane launcher (sentinel-as-claude-tui-2026-06-22).
#
# Registers THIS zellij pane's id + session so /api/operator/sentinel-input can
# write voice transcripts straight to the Sentinel pane (via `write-chars
# --pane-id`), instead of whatever pane happens to be focused. Then launches the
# Sentinel Claude TUI exactly as before. Re-runs on every dock relaunch (the
# dock is volatile), so the registration always reflects the current pane.
#
# Source of truth lives in the repo at apps/operator/scripts/psu-sentinel.sh;
# this is the PATH-resolvable shim the dock layout invokes by name.
mkdir -p "$HOME/.papercusp" 2>/dev/null || true
if [ -n "$ZELLIJ_PANE_ID" ] && [ -n "$ZELLIJ_SESSION_NAME" ]; then
  printf '%s %s' "$ZELLIJ_SESSION_NAME" "$ZELLIJ_PANE_ID" \
    > "$HOME/.papercusp/sentinel-pane" 2>/dev/null || true
fi
exec psu --no-picker --agent=claude --role=sentinel
