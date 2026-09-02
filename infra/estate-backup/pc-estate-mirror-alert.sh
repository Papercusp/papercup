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
#
# TWO MODES — because an alarm that cannot stand down is a bug in the alarm.
#   (default)    raise: assert the fault on all four channels.
#   --resolved   STAND DOWN: tell the same audiences the fault is over.
#
# The stand-down exists because channel 4 is the one channel that CANNOT retract
# itself. The marker is a file, so recovery deletes it; stderr and notify-send
# are transient by nature. But coord:send delivers a durable, fleet-wide message
# with expects:"action" that sits in every inbox until someone acts on it — and
# nothing ever took it back. Measured cost (WI-2140790): the mirror failed once
# on 2026-09-01T05:18Z, recovered unattended at 15:50Z, and cleared its own
# marker at 15:52Z — yet at 20:05Z an agent still reading the standing
# escalations filed a MAJOR backup-integrity bug against an already-healthy
# mirror, correctly noting no owner existed, because from the inbox a resolved
# alarm and a live one are byte-identical. That is the same failure WI-1038273
# hit through the write-only marker, one channel over: the fix there taught the
# marker to retract, and left the loudest channel unable to.
# ---------------------------------------------------------------------------
set -uo pipefail

ROOT="${PC_ESTATE_MIRROR_ROOT:-/mnt/data/papercusp-estate-mirror}"
MARKER="$ROOT/ALERT-MIRROR-FAILING"

MODE=raise
if [ "${1:-}" = "--resolved" ]; then MODE=resolved; shift; fi
REASON="${1:-pc-estate-mirror failed}"
# Derive the repo root from this script's own location (infra/estate-backup/)
# rather than hardcoding a home path — this file ships, and a literal home
# directory is both a privacy leak and wrong on every machine but one.
SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="${PC_REPO:-$(cd "$SELF_DIR/../.." && pwd)}"

mkdir -p "$ROOT" 2>/dev/null || true

# Channels 1-3. In --resolved mode the caller has ALREADY deleted the marker
# (that deletion is what proves recovery), so re-writing it here would re-assert
# the exact fault we are standing down from.
if [ "$MODE" = resolved ]; then
  echo "MIRROR RECOVERED: $REASON" >&2
  command -v notify-send >/dev/null 2>&1 && \
    notify-send -u normal "Estate off-GCP mirror recovered" "$REASON" 2>/dev/null || true
else

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

fi

# Channel 4. The summary carries the whole verdict on purpose: coord:send caps
# the BODY at 600 chars, so the summary is the part guaranteed to survive into
# an inbox — a stand-down whose "this is over" clause got truncated would be
# indistinguishable from the alarm it retracts.
if [ -f "$REPO/scripts/mcp-call.mjs" ]; then
  BODY=$(python3 - "$MODE" "$REASON" "$MARKER" <<'PY' 2>/dev/null
import json, sys
mode, reason, marker = sys.argv[1], sys.argv[2], sys.argv[3]
if mode == "resolved":
    msg = {
      "to": ["*"],
      "expects": "none",
      "summary": "RESOLVED — off-GCP estate mirror is healthy again; no action needed. Supersedes any standing 'OFF-GCP ESTATE MIRROR FAILING' alert: %s" % reason[:120],
      "body": [{
        "text": ("The off-GCP mirror completed successfully and its freshness probe passed, so the "
                 "single-provider exposure WI-645563 exists to close is shut again. The %s marker "
                 "has been removed. Any earlier OFF-GCP ESTATE MIRROR FAILING escalation from this "
                 "sender is STALE — do not open a work-item for it; confirm with "
                 "'cat %s/MIRROR-STATE.json' (ok:true) before acting on an older alert." % (marker, marker.rsplit('/', 1)[0])),
      }],
    }
else:
    msg = {
      "to": ["*"],
      "expects": "action",
      "summary": "OFF-GCP ESTATE MIRROR FAILING: %s" % reason[:160],
      "body": [{
        "text": ("The off-GCP copy of the estate backups is not being maintained, so the only "
                 "surviving copy is the GCS bucket in the same GCP project as the VMs it protects "
                 "(WI-645563). Marker: %s. Triage: systemctl --user status pc-estate-mirror.service" % marker),
        "couldNotDetermine": [{"what": "whether the GCS source is also affected"}],
      }],
    }
print(json.dumps(msg))
PY
)
  [ -n "${BODY:-}" ] && (cd "$REPO" && timeout 30 node scripts/mcp-call.mjs coord:send "$BODY" \
      --client estate-mirror-alert --harness papercusp --workspace papercusp-workspace \
      >/dev/null 2>&1) || true
fi

exit 0
