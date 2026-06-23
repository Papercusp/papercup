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
# Render FLAT TEXT in this pane (no decorative logo / borders / animations).
# The dock 🛡 Sentinel pane is narrow + voice-first, so Claude Code's fancy
# startup splash (the ▐▛███▜▌ logo → garbled orange blocks) and animated
# spinners render badly and word-wrap catastrophically at this width — and the
# volatile dock relaunches the session every few minutes, so the user sees that
# broken splash constantly. `--ax-screen-reader` is Claude Code's screen-reader
# mode: flat text, no decorative borders or animations — exactly what an
# embedded narrow pane wants. Forwarded to the `claude` CLI via psu's generic
# `--` passthrough, so the fleet-wide psu-launcher is untouched (dock Sentinel
# pane ONLY). Output rendering only — voice-IN write-chars + Enter is unaffected.
exec psu --no-picker --agent=claude --role=sentinel -- --ax-screen-reader
