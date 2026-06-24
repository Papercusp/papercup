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
# Session MODEL override (model-override-sidebar-2026-06-23): the Sentinel sidebar
# tab writes the chosen `model[:effort]` spec to ~/.papercusp/sentinel-model
# (projected from owner-steering by hive:set-steering — the bash wrapper can't read
# PG). Present ⇒ launch the Sentinel at that spec; absent ⇒ no flag ⇒ the workspace /
# CLI default. The `model:effort` colon form is Claude Code's native --model format
# (e.g. `opus:high`), so it's passed through verbatim. Re-read every launch (the dock
# is volatile) so a change applies on the next relaunch.
model_args=()
if [ -s "$HOME/.papercusp/sentinel-model" ]; then
  spec="$(tr -d ' \t\r\n' < "$HOME/.papercusp/sentinel-model" 2>/dev/null)"
  [ -n "$spec" ] && model_args+=("--model=$spec")
fi
exec psu --no-picker --agent=claude --role=sentinel "${model_args[@]}"
