#!/usr/bin/env bash
# P-007 APPLY — install CPUWeight drop-ins for the 3 critical operator services.
# Live + reversible: CPUWeight applies on daemon-reload WITHOUT a restart. Run from this dir.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
D="/home/marsh-office/.config/systemd/user"
install -Dm644 "$HERE/papercup-dev-api.d-70-cpuweight.conf"           "$D/papercup-dev-api.service.d/70-cpuweight.conf"
install -Dm644 "$HERE/papercup-bg-host.d-70-cpuweight.conf"           "$D/papercup-bg-host.service.d/70-cpuweight.conf"
install -Dm644 "$HERE/papercup-inference-gateway.d-70-cpuweight.conf" "$D/papercup-inference-gateway.service.d/70-cpuweight.conf"
systemctl --user daemon-reload
echo "applied. verifying live cpu.weight (no restart performed):"
"$HERE/verify.sh"
