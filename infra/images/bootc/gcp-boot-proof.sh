#!/usr/bin/env bash
#
# P-303 gate spike — boot-prove the converted GCE image and read the proof off
# the SERIAL console.
#
# WHY SERIAL, NOT SSH: serial output is read from the GCP control plane, not
# from the instance's network. So this needs no external IP, no firewall rule,
# no IAP target tag, and no SSH key — none of the network plumbing the packer
# bake needs. That makes the boot proof independent of the networking questions
# P-306 still owns, which is exactly what a GATE spike wants.
#
# Everything it creates is prefixed p303- and torn down by the trap, including
# on failure. Run with --keep to leave the instance up for inspection.
set -euo pipefail

PROJECT="${PROJECT:-active-alcove-504205-q3}"
ZONE="${ZONE:-us-central1-a}"
STAMP="$(date -u +%Y%m%d-%H%M%S)"
NAME="p303-bootproof-${STAMP}"
BUCKET="p303-image-staging-${PROJECT}"
KEEP=0
[[ "${1:-}" == "--keep" ]] && KEEP=1

T="$HOME/.papercusp/p303-bootc-spike"
# Default to the SINGLE-TYPE output dir. `output/` holds the failed multi-type
# run (duplicate XFS UUID vs the udisks automounter) and contains only a
# manifest, so pointing here by default is what makes the common path correct.
OUT="${OUT:-$T/output-gce}"

log() { echo "[$(date -u +%H:%M:%S)] $*"; }

# ── Locate the GCE artifact ────────────────────────────────────────────────
# bootc-image-builder's layout has moved between releases, so DISCOVER the file
# rather than hardcoding output/gce/image.tar.gz. A hardcoded path that misses
# would read as "the conversion failed" when it actually succeeded.
GCE_TAR="$(find "$OUT" -type f \( -name '*.tar.gz' -o -name '*.tar' \) 2>/dev/null | head -1)"
if [[ -z "$GCE_TAR" ]]; then
  echo "FATAL: no GCE tarball under $OUT — conversion did not produce one." >&2
  echo "Present instead:" >&2; find "$OUT" -type f -printf '  %10s  %p\n' >&2
  exit 2
fi
log "GCE artifact: $GCE_TAR ($(stat -c %s "$GCE_TAR") bytes)"

cleanup() {
  local rc=$?
  if (( KEEP )); then
    log "--keep set; leaving $NAME up. Tear down with:"
    log "  gcloud compute instances delete $NAME --zone $ZONE --quiet --project $PROJECT"
    return
  fi
  log "teardown (exit rc=$rc)"
  gcloud compute instances delete "$NAME" --zone "$ZONE" --quiet --project "$PROJECT" 2>/dev/null || true
  gcloud compute images    delete "$NAME" --quiet --project "$PROJECT" 2>/dev/null || true
  gcloud storage rm "gs://$BUCKET/${NAME}.tar.gz" 2>/dev/null || true
}
trap cleanup EXIT

# ── Stage ──────────────────────────────────────────────────────────────────
if ! gcloud storage buckets describe "gs://$BUCKET" --project "$PROJECT" >/dev/null 2>&1; then
  log "creating staging bucket gs://$BUCKET"
  gcloud storage buckets create "gs://$BUCKET" --project "$PROJECT" --location=us-central1
fi

log "uploading artifact"
gcloud storage cp "$GCE_TAR" "gs://$BUCKET/${NAME}.tar.gz" --project "$PROJECT"

log "creating image $NAME"
gcloud compute images create "$NAME" \
  --source-uri="gs://$BUCKET/${NAME}.tar.gz" \
  --project "$PROJECT"

# ── Boot ───────────────────────────────────────────────────────────────────
# --no-address: no external IP. Serial output still reaches us.
# The serial port must be enabled explicitly or get-serial-port-output is empty
# on a project whose org policy disables it by default.
log "booting $NAME"
gcloud compute instances create "$NAME" \
  --zone "$ZONE" --project "$PROJECT" \
  --image "$NAME" \
  --machine-type e2-standard-2 \
  --no-address \
  --metadata serial-port-enable=TRUE

# ── Read the proof off the serial console ──────────────────────────────────
log "polling serial console for P303-BOOT-PROOF (up to 5 min)"
DEADLINE=$(( $(date +%s) + 300 ))
SERIAL="$T/serial-${STAMP}.log"
FOUND=0
while (( $(date +%s) < DEADLINE )); do
  gcloud compute instances get-serial-port-output "$NAME" \
    --zone "$ZONE" --project "$PROJECT" > "$SERIAL" 2>/dev/null || true
  if grep -q 'P303-BOOT-PROOF: complete' "$SERIAL" 2>/dev/null; then
    FOUND=1; break
  fi
  sleep 10
done

echo
echo "================ P303 BOOT PROOF ================"
if (( FOUND )); then
  grep 'P303-BOOT-PROOF' "$SERIAL" || true
  echo "-------------------------------------------------"
  # The marker lines are the verdict. A FAIL on any of them is a real finding
  # about the RPM base, not a flake -- report it rather than retrying.
  if grep -q 'P303-BOOT-PROOF: .* FAIL' "$SERIAL"; then
    echo "VERDICT: BOOTED, but at least one assertion FAILED (see above)."
    exit 1
  fi
  echo "VERDICT: PASS — image booted and every assertion held."
else
  echo "VERDICT: NO PROOF within 5 min. Last 40 serial lines:"
  tail -40 "$SERIAL" 2>/dev/null || echo "  (serial output was empty)"
  echo "Full serial log: $SERIAL"
  exit 1
fi
echo "Full serial log: $SERIAL"
