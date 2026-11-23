#!/bin/sh
set -eu
root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
out=$(realpath -m "${1:-$PWD}")
mkdir -p "$out"
build_dir=$(mktemp -d)
trap 'rm -rf "$build_dir"' EXIT
cd "$root"
cp package.json package-lock.json psu-acp adapter.mjs session.mjs operator.mjs members.mjs hooks.mjs supervise.c client.json config.example.json "$build_dir/"
if test -f README.md; then cp README.md "$build_dir/"; fi
cd "$build_dir"
cc -static -O2 -Wall -Wextra -Werror -o supervise supervise.c
chmod +x psu-acp
npm ci --workspaces=false --ignore-scripts --include=optional --no-audit --no-fund --prefer-offline
npm pack --workspaces=false --ignore-scripts --pack-destination "$out" --silent
