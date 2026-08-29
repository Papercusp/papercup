#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# pc-estate-mirror-alert.sh — make an off-GCP-mirror failure LOUD (WI-645563)
#
# Modelled on ~/.config/kopia/backup-alert.sh, which exists because the
# Postgres backup rotted silently for 30 days (EI-10733). The mirror is
# vulnerable to exactly the same failure: nobody looks at a backup that is
# working, so nobody notices when it stops.
#
# Four independent channels, because each one can be down on its own:
#   1. a marker file next to the mirror   (survives everything, found by anyone
#                                          who ever looks at the mirror)
#   2. stderr -> the systemd journal      (found by triage)
#   3. notify-send                        (found by the owner, if at the desk)
#   4. coord:send to the fleet            (found by whichever agent is awake)
#
# Always exits 0: an alert path that fails must never mask the failure it was
# raised to report.
# ---------------------------------------------------------------------------
set -uo pipefail

ROOT="${PC_ESTATE_MIRROR_ROOT:-/mnt/data/papercusp-estate-mirror}"
MARKER="$ROOT/ALERT-MIRROR-FAILING"
REASON="${1:-pc-estate-mirror failed}"
# Derive the repo root from this script's own location (infra/estate-backup/)
# rather than hardcoding a home path — this file ships, and a literal home
# directory is both a privacy leak and wrong on every machine but one.
SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="${PC_REPO:-$(cd "$SELF_DIR/../.." && pwd)}"

mkdir -p "$ROOT" 2>/dev/null || true

{
  echo "OFF-GCP MIRROR ALARM — $(date -Iseconds)"
  echo "$REASON"
  echo
  echo "The off-GCP copy of the estate backups is not being maintained."
  echo "While this is broken, the ONLY copy of the estate backups is the GCS"
  echo "bucket that sits in the same GCP project as the VMs it protects —"
  echo "i.e. the exact single-provider exposure that WI-645563 exists to close."
  echo
  echo "Triage:"
  echo "  systemctl --user status pc-estate-mirror.service"
  echo "  journalctl --user -u pc-estate-mirror.service -n 60 --no-pager"
  echo "  cat $ROOT/MIRROR-STATE.json"
  echo "  tail -60 $ROOT/mirror.log"
  echo "  ls $ROOT/.quarantine/          # snapshots that FAILED verification"
  echo "  $REPO/infra/estate-backup/pc-estate-mirror.sh mirror   # run by hand, read the errors"
  echo
  echo "Note: published snapshots are chattr +i immutable."
  echo "  sudo chattr -R -i <path>   # before any deliberate deletion"
} >"$MARKER" 2>/dev/null || true

echo "MIRROR ALARM: $REASON (see $MARKER)" >&2

command -v notify-send >/dev/null 2>&1 && \
  notify-send -u critical "Estate off-GCP mirror FAILING" "$REASON" 2>/dev/null || true

if [ -f "$REPO/scripts/mcp-call.mjs" ]; then
  BODY=$(python3 - "$REASON" "$MARKER" <<'PY' 2>/dev/null
import json, sys
reason, marker = sys.argv[1], sys.argv[2]
print(json.dumps({
  "to": ["*"],
  "expects": "action",
  "summary": "OFF-GCP ESTATE MIRROR FAILING: %s" % reason[:160],
  "body": [{
    "text": ("The off-GCP copy of the estate backups is not being maintained, so the only "
             "surviving copy is the GCS bucket in the same GCP project as the VMs it protects "
             "(WI-645563). Marker: %s. Triage: systemctl --user status pc-estate-mirror.service" % marker),
    "couldNotDetermine": [{"what": "whether the GCS source is also affected"}],
  }],
}))
PY
)
  [ -n "${BODY:-}" ] && (cd "$REPO" && timeout 30 node scripts/mcp-call.mjs coord:send "$BODY" \
      --client estate-mirror-alert --harness papercusp --workspace papercusp-workspace \
      >/dev/null 2>&1) || true
fi

exit 0
