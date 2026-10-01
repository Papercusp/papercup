#!/usr/bin/env bash
# Papercusp-run public blind relay (plan public-blind-relay-2026-10-01, P-002).
#
#   up      create (idempotent) the firewall rules + e2-micro VM, install node + the
#           daemon bundle + seed, enable papercusp-blind-relay.service, then verify
#   verify  probe the relay key on the PUBLIC DHT from this machine (live/not-found/unknown)
#   status  instance state + the service's last log lines
#   down    delete the VM and its firewall rules (the seed stays in $SEED_DIR)
#
# The VM is labelled papercusp-role=blind-relay and NOT papercusp-managed, so the
# hosted-workspace controller (workspace-host/gcp-safety.ts) never adopts or reaps it.
# The seed never enters the repo: it is read from $SEED_DIR/seed.hex (0600) and copied
# to the VM over IAP SSH.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PROJECT="${RELAY_PROJECT:-papercusp-hosted-workspaces}"
ZONE="${RELAY_ZONE:-us-central1-c}"
NAME="${RELAY_VM:-pc-blind-relay-1}"
PORT="${RELAY_PORT:-49737}"
SEED_DIR="${RELAY_SEED_DIR:-$HOME/.papercusp/relay}"
NODE_MAJOR="${RELAY_NODE_MAJOR:-22}"
TAG="blind-relay"
FW_UDP="pc-blind-relay-udp"
FW_IAP="pc-blind-relay-iap-ssh"
BUILD_DIR="$ROOT/.papercusp/scratch/relay-build"
GC=(gcloud --project="$PROJECT" --quiet)

log() { printf '[relay-vm] %s\n' "$*" >&2; }
die() { log "ERROR: $*"; exit 1; }

seed_file() {
  local f="$SEED_DIR/seed.hex"
  [[ -s "$f" ]] || die "no seed at $f (generate 32 random bytes as hex, mode 0600)"
  [[ "$(stat -c %a "$f")" == 600 ]] || die "$f must be mode 0600"
  grep -Eq '^[0-9a-f]{64}$' "$f" || die "$f must be 64 lowercase hex characters"
  printf '%s' "$f"
}

vm_ssh() { "${GC[@]}" compute ssh "$NAME" --zone="$ZONE" --tunnel-through-iap --command="$1"; }
vm_scp() { "${GC[@]}" compute scp --zone="$ZONE" --tunnel-through-iap "$@"; }

ensure_firewall() {
  if ! "${GC[@]}" compute firewall-rules describe "$FW_UDP" >/dev/null 2>&1; then
    log "creating firewall rule $FW_UDP (udp:$PORT from anywhere → tag $TAG)"
    "${GC[@]}" compute firewall-rules create "$FW_UDP" --network=default --direction=INGRESS \
      --action=ALLOW --rules="udp:$PORT" --source-ranges=0.0.0.0/0 --target-tags="$TAG"
  fi
  if ! "${GC[@]}" compute firewall-rules describe "$FW_IAP" >/dev/null 2>&1; then
    log "creating firewall rule $FW_IAP (tcp:22 from IAP → tag $TAG)"
    "${GC[@]}" compute firewall-rules create "$FW_IAP" --network=default --direction=INGRESS \
      --action=ALLOW --rules=tcp:22 --source-ranges=35.235.240.0/20 --target-tags="$TAG"
  fi
}

ensure_vm() {
  if "${GC[@]}" compute instances describe "$NAME" --zone="$ZONE" >/dev/null 2>&1; then
    log "instance $NAME exists"
    return
  fi
  log "creating $NAME (e2-micro, debian-12, $ZONE)"
  "${GC[@]}" compute instances create "$NAME" --zone="$ZONE" --machine-type=e2-micro \
    --image-family=debian-12 --image-project=debian-cloud --boot-disk-size=10GB \
    --tags="$TAG" --labels="papercusp-role=blind-relay" --metadata=enable-oslogin=FALSE
}

wait_ssh() {
  for i in $(seq 1 30); do
    if vm_ssh 'true' >/dev/null 2>&1; then return 0; fi
    log "waiting for ssh ($i/30)"; sleep 10
  done
  die "ssh to $NAME never came up"
}

install_remote() {
  local seed; seed="$(seed_file)"
  node "$ROOT/scripts/relay/build-relay-daemon.mjs" --out "$BUILD_DIR" >/dev/null
  local stage="/tmp/papercusp-relay-stage"
  vm_ssh "rm -rf $stage && mkdir -p $stage && chmod 700 $stage"
  vm_scp "$BUILD_DIR/blind-relay-daemon.mjs" "$BUILD_DIR/package.json" "$seed" "$NAME:$stage/"
  vm_ssh "sudo bash -s" <<REMOTE
set -euo pipefail
if ! command -v node >/dev/null || [[ "\$(node -p 'process.versions.node.split(\".\")[0]')" != "$NODE_MAJOR" ]]; then
  apt-get update -qq && apt-get install -y -qq curl xz-utils ca-certificates >/dev/null
  base="https://nodejs.org/dist/latest-v$NODE_MAJOR.x"
  file="\$(curl -fsSL "\$base/SHASUMS256.txt" | awk '/linux-x64\.tar\.xz\$/ {print \$2}')"
  sum="\$(curl -fsSL "\$base/SHASUMS256.txt" | awk '/linux-x64\.tar\.xz\$/ {print \$1}')"
  curl -fsSL -o "/tmp/\$file" "\$base/\$file"
  echo "\$sum  /tmp/\$file" | sha256sum -c - >/dev/null
  tar -xJf "/tmp/\$file" -C /usr/local --strip-components=1
fi
id papercusp-relay >/dev/null 2>&1 || useradd --system --home /opt/papercusp-relay --shell /usr/sbin/nologin papercusp-relay
install -d -o papercusp-relay -g papercusp-relay -m 750 /opt/papercusp-relay
install -o papercusp-relay -g papercusp-relay -m 644 $stage/blind-relay-daemon.mjs $stage/package.json /opt/papercusp-relay/
install -o papercusp-relay -g papercusp-relay -m 600 $stage/seed.hex /opt/papercusp-relay/seed.hex
rm -rf $stage
cd /opt/papercusp-relay && sudo -u papercusp-relay env HOME=/opt/papercusp-relay /usr/local/bin/npm install --omit=dev --no-audit --no-fund --loglevel=error
cat >/etc/systemd/system/papercusp-blind-relay.service <<UNIT
[Unit]
Description=Papercusp public blind relay (hyperdht blind-relay)
After=network-online.target
Wants=network-online.target

[Service]
User=papercusp-relay
WorkingDirectory=/opt/papercusp-relay
ExecStart=/usr/local/bin/node /opt/papercusp-relay/blind-relay-daemon.mjs --seed-file /opt/papercusp-relay/seed.hex --port $PORT --stats-sec 300
Restart=always
RestartSec=5
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=/opt/papercusp-relay
ProtectHome=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable papercusp-blind-relay.service >/dev/null
systemctl restart papercusp-blind-relay.service
sleep 8
systemctl is-active papercusp-blind-relay.service
journalctl -u papercusp-blind-relay.service -n 3 --no-pager -o cat
REMOTE
}

verify() {
  local want; want="$(cat "$SEED_DIR/public-key.hex" 2>/dev/null || true)"
  log "probing ${want:-the shipped default keys} on the public DHT"
  (cd "$ROOT" && npx tsx scripts/relay/probe-relay-key.ts ${want:+"$want"})
}

status() {
  "${GC[@]}" compute instances describe "$NAME" --zone="$ZONE" \
    --format='value(status,networkInterfaces[0].accessConfigs[0].natIP,labels)'
  vm_ssh 'systemctl is-active papercusp-blind-relay.service; journalctl -u papercusp-blind-relay.service -n 5 --no-pager -o cat'
}

down() {
  "${GC[@]}" compute instances delete "$NAME" --zone="$ZONE" || true
  "${GC[@]}" compute firewall-rules delete "$FW_UDP" "$FW_IAP" || true
}

case "${1:-}" in
  up) seed_file >/dev/null; ensure_firewall; ensure_vm; wait_ssh; install_remote; verify ;;
  verify) verify ;;
  status) status ;;
  down) down ;;
  *) echo "usage: $0 up|verify|status|down" >&2; exit 2 ;;
esac
