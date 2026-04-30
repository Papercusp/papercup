#!/usr/bin/env bash
# Install / rotate the four Worker secrets required by papercusp-publish.
#
# Idempotent — safe to re-run. Generates JWT_SECRET and HASH_PEPPER from
# /dev/urandom; reads CF_MASTER_TOKEN from ~/.cloudflare-token; reads
# CF_ACCOUNT_ID from $CF_ACCOUNT_ID env var or the value baked into the
# wrangler.toml comment (you'll be prompted).
#
# Usage:
#   bash scripts/install-secrets.sh                # initial install
#   bash scripts/install-secrets.sh --rotate-jwt   # generate fresh JWT_SECRET
#   bash scripts/install-secrets.sh --rotate-pepper
#   bash scripts/install-secrets.sh --rotate-cf    # picks up new ~/.cloudflare-token

set -euo pipefail

cd "$(dirname "$0")/.."

want_jwt=1
want_pepper=1
want_cf=1
want_account=1

case "${1:-}" in
  --rotate-jwt)    want_pepper=0; want_cf=0; want_account=0 ;;
  --rotate-pepper) want_jwt=0;    want_cf=0; want_account=0 ;;
  --rotate-cf)     want_jwt=0;    want_pepper=0; want_account=0 ;;
  '' )             ;;
  *) echo "unknown arg: $1" >&2; exit 2 ;;
esac

put() {
  local name="$1"; local val="$2"
  printf '%s' "$val" | npx wrangler secret put "$name"
}

if [ $want_jwt -eq 1 ]; then
  echo "→ generating + installing JWT_SECRET"
  put JWT_SECRET "$(openssl rand -base64 32 | tr -d '\n=' | tr '/+' '_-')"
fi

if [ $want_pepper -eq 1 ]; then
  echo "→ generating + installing HASH_PEPPER"
  put HASH_PEPPER "$(openssl rand -base64 32 | tr -d '\n=' | tr '/+' '_-')"
fi

if [ $want_cf -eq 1 ]; then
  if [ ! -f "$HOME/.cloudflare-token" ]; then
    echo "ERROR: ~/.cloudflare-token not found" >&2
    exit 1
  fi
  echo "→ installing CF_MASTER_TOKEN from ~/.cloudflare-token"
  put CF_MASTER_TOKEN "$(cat "$HOME/.cloudflare-token")"
fi

if [ $want_account -eq 1 ]; then
  acc="${CF_ACCOUNT_ID:-}"
  if [ -z "$acc" ]; then
    read -rp "Cloudflare account ID: " acc
  fi
  echo "→ installing CF_ACCOUNT_ID"
  put CF_ACCOUNT_ID "$acc"
fi

echo "✔ secrets installed"
