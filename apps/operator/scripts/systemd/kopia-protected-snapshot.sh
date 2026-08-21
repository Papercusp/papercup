#!/usr/bin/env bash
# Supported manual/protected snapshot entrypoint. It waits for every scheduled
# or daily Kopia snapshot to leave the shared guard before starting.
set -uo pipefail

if [ "$#" -eq 0 ]; then
  echo "usage: $0 SOURCE [SOURCE ...]" >&2
  exit 64
fi

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
guard="${KOPIA_BACKUP_GUARD_BIN:-$script_dir/kopia-backup-guard.sh}"
[ -x "$guard" ] || { echo "Kopia backup guard is not executable: $guard" >&2; exit 69; }

renice 19 -p $$ >/dev/null 2>&1 || true
ionice -c3 -p $$ >/dev/null 2>&1 || true
exec "$guard" --mode wait --label protected-manual -- \
  sudo -n /usr/bin/kopia snapshot create "$@"

