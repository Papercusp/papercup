#!/usr/bin/env bash
# install-test-runs-prune.sh — install the retention pruner as a
# systemd --user timer.
#
# Plan: admin-testing-tab-restructure-2026-05-24, P-041.
#
# Idempotent. Re-run after editing the .service/.timer files.

set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
UNIT_DIR="$HOME/.config/systemd/user"
mkdir -p "$UNIT_DIR"

install -m 0644 "$HERE/papercup-test-runs-prune.service" "$UNIT_DIR/papercup-test-runs-prune.service"
install -m 0644 "$HERE/papercup-test-runs-prune.timer"   "$UNIT_DIR/papercup-test-runs-prune.timer"

systemctl --user daemon-reload
systemctl --user enable --now papercup-test-runs-prune.timer

echo
echo "✓ installed papercup-test-runs-prune.timer"
echo "  next fire: $(systemctl --user list-timers papercup-test-runs-prune.timer --no-pager | sed -n '2p')"
echo
echo "manual run:  systemctl --user start papercup-test-runs-prune.service"
echo "tail logs:   journalctl --user -u papercup-test-runs-prune.service -n 20"
