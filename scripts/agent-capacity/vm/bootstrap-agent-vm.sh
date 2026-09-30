#!/usr/bin/env bash
# Bootstrap a GCP VM to run real and replayed agents for the agent-capacity test
# (plan agent-capacity-and-cost-gcp-2026-09-30, P-004 calibration and the P-005 ramps).
#
#   CLAUDE_VERSION=2.1.284 CODEX_VERSION=0.159.2 bootstrap-agent-vm.sh <tasks.json>
#
# Installs the same CLI versions the corpus was recorded with, then builds each repo's
# prepared checkout the way the recorder did: clone at the pinned sha and run the repo's
# own `setup` commands from tasks.json (plus its `systemPackages`). Checkouts are built on
# the VM, not copied from the recording host, because a prepared Python venv links to the
# host's interpreter by absolute path and does not survive a copy.
#
# Model traffic from real agents reaches the tower's gateway through an SSH reverse tunnel
# (`gcloud compute ssh <vm> -- -R 8788:127.0.0.1:8788`), so nothing here holds credentials.
#
# DRY_RUN=1 prints each command as `RUN <argv>` instead of running it (used by the test).
set -euo pipefail

TASKS=${1:?usage: bootstrap-agent-vm.sh <tasks.json>}
: "${CLAUDE_VERSION:?set CLAUDE_VERSION to the recorded claude version}"
: "${CODEX_VERSION:?set CODEX_VERSION to the recorded codex version}"
NODE_VERSION=${NODE_VERSION:-24.18.1}
CACHE=${AGENT_CAPACITY_CACHE:-$HOME/.cache/agent-capacity}

run() {
  if [ "${DRY_RUN:-0}" = 1 ]; then printf 'RUN %s\n' "$*"; else "$@"; fi
}

# One line per repo: name<TAB>url<TAB>sha<TAB>setup commands joined by \x1f.
repos() {
  python3 - "$TASKS" <<'PY'
import json, sys
c = json.load(open(sys.argv[1]))
for name, r in sorted(c['repos'].items()):
    print('\t'.join([name, r['url'], r['sha'], '\x1f'.join(r.get('setup', []))]))
PY
}
system_packages() {
  python3 - "$TASKS" <<'PY'
import json, sys
c = json.load(open(sys.argv[1]))
print(' '.join(sorted({p for r in c['repos'].values() for p in r.get('systemPackages', [])})))
PY
}

run sudo apt-get update -q
# shellcheck disable=SC2046 # word-splitting the package list is intended
run sudo env DEBIAN_FRONTEND=noninteractive apt-get install -yq git curl ca-certificates xz-utils zstd build-essential python3 $(system_packages)

run curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz" -o /tmp/node.tar.xz
run sudo tar -xJf /tmp/node.tar.xz -C /usr/local --strip-components=1
run sudo npm install -g --no-fund --no-audit "@anthropic-ai/claude-code@${CLAUDE_VERSION}" "@openai/codex@${CODEX_VERSION}"

run curl -LsSf https://astral.sh/uv/install.sh -o /tmp/uv-install.sh
run sudo env UV_INSTALL_DIR=/usr/local/bin UV_NO_MODIFY_PATH=1 sh /tmp/uv-install.sh

run mkdir -p "$CACHE/prepared"
while IFS=$'\t' read -r name url sha setup; do
  dir="$CACHE/prepared/$name"
  if [ "${DRY_RUN:-0}" = 1 ] || [ ! -d "$dir/.git" ]; then run git clone --quiet "$url" "$dir"; fi
  run git -C "$dir" checkout --quiet --detach "$sha"
  IFS=$'\x1f' read -r -a cmds <<<"$setup"
  for cmd in "${cmds[@]}"; do
    [ -n "$cmd" ] && run bash -c "cd '$dir' && $cmd"
  done
  if [ "${DRY_RUN:-0}" != 1 ]; then
    head=$(git -C "$dir" rev-parse HEAD)
    [ "$head" = "$sha" ] || { echo "BOOTSTRAP_FAILED $name at $head, want $sha" >&2; exit 3; }
  fi
done < <(repos)

# The installed CLIs must be the recorded ones, or replayed requests stop matching.
if [ "${DRY_RUN:-0}" != 1 ]; then
  have_claude=$(claude --version)
  have_codex=$(codex --version)
  case "$have_claude" in "$CLAUDE_VERSION"*) ;; *) echo "BOOTSTRAP_FAILED claude is $have_claude, want $CLAUDE_VERSION" >&2; exit 4 ;; esac
  case "$have_codex" in *"$CODEX_VERSION") ;; *) echo "BOOTSTRAP_FAILED codex is $have_codex, want $CODEX_VERSION" >&2; exit 4 ;; esac
fi
echo BOOTSTRAP_OK
