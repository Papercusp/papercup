#!/usr/bin/env bash
# Show effective CPUWeight + live cgroup cpu.weight for the 3 services.
for svc in papercup-dev-api papercup-bg-host papercup-inference-gateway; do
  cg=$(systemctl --user show "$svc.service" -p ControlGroup --value 2>/dev/null)
  printf '%-34s CPUWeight=%s  live cpu.weight=%s\n' "$svc" \
    "$(systemctl --user show "$svc.service" -p CPUWeight --value 2>/dev/null)" \
    "$(cat "/sys/fs/cgroup$cg/cpu.weight" 2>/dev/null || echo n/a)"
done
