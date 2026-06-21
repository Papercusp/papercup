#!/usr/bin/env bash
# P-007 ROLLBACK — remove the CPUWeight drop-ins, restore defaults. No restart.
set -euo pipefail
D="/home/marsh-office/.config/systemd/user"
rm -f "$D/papercup-dev-api.service.d/70-cpuweight.conf" \
      "$D/papercup-bg-host.service.d/70-cpuweight.conf" \
      "$D/papercup-inference-gateway.service.d/70-cpuweight.conf"
systemctl --user daemon-reload
echo "rolled back. live cpu.weight restored to prior/default."
