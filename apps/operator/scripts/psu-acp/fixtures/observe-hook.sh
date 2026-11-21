#!/bin/sh
set -eu
cat >/dev/null
case "$1" in
  Bash|Agent) ;;
  *) exit 2 ;;
esac
if [ "${PSU_ACP_FIXTURE_TRACE:-}" = 1 ]; then
  printf '%s\n' "$1" >> /work/managed-hook-events
fi
printf '{}\n'
