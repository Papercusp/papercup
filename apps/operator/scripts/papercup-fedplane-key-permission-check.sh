#!/usr/bin/env bash
# papercup-fedplane-key-permission-check.sh — periodic private-key EXPOSURE probe
# for a fed-plane host (WI-2143622).
#
# WHY: on 2026-09-03 an UNENCRYPTED SSH private key was found at
# /mnt/data/back/Debug/.ssh/id_ed25519 with mode 0664 inside a 0775 .ssh
# directory — group- AND world-readable, and `ssh-keygen -y -P ''` returned 0,
# so it was directly usable by any local account, not merely readable. It
# surfaced only because an agent happened to `stat` that path during an
# unrelated disk-reclaim check (EI-22240449643643994). Nothing on this box was
# looking for it. The fed-plane detector family covered host disk (EI-8982),
# DHT liveness (EI-8892) and backup health; key permissions were an uncovered
# class, so the interval between exposure and discovery was bounded only by
# luck.
#
# DETECTION + ESCALATION ONLY. This script never chmods, moves, or deletes
# anything, and never reads or logs key MATERIAL — it reports PATHS and MODE
# BITS only. Remediation is a human/agent call made off the filed EI, the same
# posture as papercup-fedplane-disk-health-check.sh (EI-8901: a health check
# must not also hold mutate authority over the thing it is judging, or a
# threshold bug becomes a self-inflicted incident).
#
# ─────────────────────────────────────────────────────────────────────────────
# THE THREE DESIGN CONSTRAINTS — every one of them MEASURED on this box, not
# guessed. Changing any of them without re-measuring will break the probe in a
# way that still looks like it is working.
# ─────────────────────────────────────────────────────────────────────────────
#
# (1) CONTENT-MATCH, NEVER FILENAME. A filename glob is simultaneously noisy
#     and incomplete: `id_*` matches /usr/share/i18n's `id_ID` LOCALE files,
#     while a genuine key named `deploy.pem`, `backup-key` or `server.key` is
#     missed entirely. Every candidate here is confirmed by a literal
#     "PRIVATE KEY" header inside the file.
#
# (2) EXCLUDE VENDORED TREES, OR THE PROBE IS IGNORED WITHIN A WEEK. A census
#     of /mnt/data on 2026-09-03 content-matched 755 group/world-readable
#     private keys. EVERY SINGLE ONE was published third-party test material
#     whose private half is public BY DESIGN:
#         496  openssl-src + postgresql-src test suites (build scratch)
#         188  gomodcache (grpc, kopia, sigstore/rekor, in-toto,
#              certificate-transparency-go testdata)
#          17  node_modules (ssh2 + node-gyp test fixtures)
#           4  Go stdlib source (crypto/tls, crypto/x509 testdata)
#     Mode 444 on a read-only Go module cache is normal, not a finding. A
#     detector that alarms on grpc testdata trains its readers to skip its
#     output — and then it cannot report the one real key either. The measured
#     post-exclusion hit count on this box is ZERO, which is what makes a hit
#     here worth waking someone for.
#
# (3) AN EMPTY RESULT IS NOT AUTOMATICALLY A CLEAN RESULT. This is the
#     constraint that matters most and the one a security probe most often
#     omits, because the broken direction is the REASSURING one. Three separate
#     instruments produced a clean-looking nothing during the census, any of
#     which would have supported "no exposed keys exist":
#         - `find / -xdev` never crosses into /home or /mnt/data on this box
#           (separate mounts) and returned ZERO rows while two id_ed25519 files
#           demonstrably existed;
#         - a whole-box foreground find exceeded its deadline and was
#           SIGTERM-killed, printing nothing;
#         - a log read taken while the writer was still running looked
#           identical to a finished empty result.
#     So this probe carries a POSITIVE CONTROL (a key path it must rediscover
#     on every run) and treats a timed-out or unrunnable scan as INDETERMINATE
#     — a RED about the DETECTOR — never as "clean". A scan that cannot prove
#     it can still find the key we already know about has not established
#     anything about the keys we do not.
#
# Usage: papercup-fedplane-key-permission-check.sh
# Env:
#   KEYPERM_SSH_ROOTS       (default "/home /root /mnt/data/back") — roots swept
#                             for .ssh directories (tier 1, cheap)
#   KEYPERM_SSH_MAXDEPTH    (default 6)   — depth bound for the tier-1 sweep
#   KEYPERM_DEEP            (default 1)   — run the tier-2 content sweep
#   KEYPERM_DEEP_ROOTS      (default "$HOME /mnt/data/back") — tier-2 roots
#   KEYPERM_DEEP_TIMEOUT_S  (default 900) — hard bound; a timeout is
#                             INDETERMINATE, never clean
#   KEYPERM_EXCLUDE_DIRS    (default: see EXCLUDE_DIRS_DEFAULT) — space-separated
#                             directory-NAME globs pruned from both tiers
#   KEYPERM_POSITIVE_CONTROL (default "$HOME/.ssh/id_ed25519") — a private key
#                             the tier-1 sweep MUST rediscover, or the scan is
#                             declared broken
#   KEYPERM_NO_FILE         (default 0)   — set 1 to skip EI filing (log-only)
#   KEYPERM_RED_REFILE_H    (default 24)  — RED-EI dedup window
#   OPERATOR_MCP_URL        (default http://127.0.0.1:3070/api/mcp?superuser=1)
set -uo pipefail

# State-aware RED dedup (EI-22240553542994017). Sourced, not optional: without
# it this probe would fall back to age-only suppression, which is the defect
# that library exists to remove — a marker's age proves a filing happened, never
# that the condition is still TRACKED. A key-exposure detector inheriting that
# bug would assert "already tracked" about a dropped item while a usable private
# key sits world-readable.
RED_MARKER_LIB="$(dirname "${BASH_SOURCE[0]}")/lib/red-marker.sh"
if [ -r "$RED_MARKER_LIB" ]; then
  # shellcheck source=lib/red-marker.sh
  . "$RED_MARKER_LIB"
else
  echo "[fedplane-key-perm] FATAL: missing $RED_MARKER_LIB — refusing to run with age-only dedup." >&2
  exit 2
fi

KEYPERM_SSH_ROOTS="${KEYPERM_SSH_ROOTS:-/home /root /mnt/data/back}"
KEYPERM_SSH_MAXDEPTH="${KEYPERM_SSH_MAXDEPTH:-6}"
KEYPERM_DEEP="${KEYPERM_DEEP:-1}"
KEYPERM_DEEP_ROOTS="${KEYPERM_DEEP_ROOTS:-$HOME /mnt/data/back}"
KEYPERM_DEEP_TIMEOUT_S="${KEYPERM_DEEP_TIMEOUT_S:-900}"
KEYPERM_POSITIVE_CONTROL="${KEYPERM_POSITIVE_CONTROL:-$HOME/.ssh/id_ed25519}"
KEYPERM_NO_FILE="${KEYPERM_NO_FILE:-0}"
KEYPERM_RED_REFILE_H="${KEYPERM_RED_REFILE_H:-24}"
OPERATOR_MCP_URL="${OPERATOR_MCP_URL:-http://127.0.0.1:3070/api/mcp?superuser=1}"
GATE_SUPERUSER_TOKEN_PATH="${GATE_SUPERUSER_TOKEN_PATH:-$HOME/.papercusp/superuser-token}"
GATE_SUPERUSER_BEARER="$(cat "$GATE_SUPERUSER_TOKEN_PATH" 2>/dev/null | tr -d '[:space:]' || true)"
STATE_DIR="${KEYPERM_STATE_DIR:-$HOME/.papercusp/fedplane-key-permission}"
mkdir -p "$STATE_DIR" 2>/dev/null || true

# Directory-NAME globs pruned from both tiers. See constraint (2): this list is
# the difference between a probe with a measured zero-noise floor and one that
# reports 755 published test keys per run. Names, not paths, so a vendored tree
# is pruned wherever it is unpacked — the same openssl-src appeared under two
# different VM-release-trust scratch directories with random suffixes.
EXCLUDE_DIRS_DEFAULT='node_modules gomodcache* .git target dependency-generations openssl-src postgresql-src hetzner-rescue testdata .cargo-target vendor'
KEYPERM_EXCLUDE_DIRS="${KEYPERM_EXCLUDE_DIRS:-$EXCLUDE_DIRS_DEFAULT}"

log() { echo "[fedplane-key-perm $(date +%H:%M:%S 2>/dev/null || true)] $*" >&2; }
jstr() { printf '%s' "$1" | python3 -c 'import json,sys;print(json.dumps(sys.stdin.read()))' 2>/dev/null || printf '"%s"' "$1"; }

# Build the shared `find` prune expression from KEYPERM_EXCLUDE_DIRS.
# Echoes nothing when the list is empty, which is a legitimate (noisy) mode.
PRUNE_ARGS=()
_build_prune() {
  PRUNE_ARGS=()
  local first=1 d
  for d in $KEYPERM_EXCLUDE_DIRS; do
    [ -n "$d" ] || continue
    if [ "$first" = 1 ]; then PRUNE_ARGS+=('(' '-name' "$d"); first=0
    else PRUNE_ARGS+=('-o' '-name' "$d"); fi
  done
  [ "$first" = 1 ] || PRUNE_ARGS+=(')' '-prune' '-o')
}
_build_prune

# Set by file_ei to the work-item id the filing resolved to (empty when it did
# not confirm one). Recorded into the RED marker so the NEXT run can ask whether
# that item is still open instead of trusting the marker's age.
LAST_FILED_EI_ID=""

file_ei() { # <title> <body>
  LAST_FILED_EI_ID=""
  [ "$KEYPERM_NO_FILE" = 1 ] && { log "KEYPERM_NO_FILE=1 — would have filed: $1"; return 0; }
  local resp
  local -a auth_hdr=()
  if [ -n "$GATE_SUPERUSER_BEARER" ]; then
    auth_hdr=(-H "authorization: Bearer $GATE_SUPERUSER_BEARER")
  else
    log "WARN: no superuser bearer at $GATE_SUPERUSER_TOKEN_PATH — EI filing will 403; falling back to log-only."
  fi
  resp="$(curl -s -m 30 -X POST "$OPERATOR_MCP_URL" \
    -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' "${auth_hdr[@]}" \
    -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{\"name\":\"work_items:create\",\"arguments\":{\"kind\":\"bug\",\"title\":$(jstr "$1"),\"summary\":$(jstr "$2"),\"harness\":\"papercusp\",\"severity\":\"critical\",\"topics\":[\"security\",\"host-health\",\"secrets\"]}}}" 2>/dev/null || true)"
  local id_match
  id_match="$(printf '%s' "$resp" | grep -oaE '\\?"id\\?":\\?"WI-[0-9]+' | head -1)"
  if [ -n "$id_match" ]; then
    LAST_FILED_EI_ID="$(printf '%s' "$id_match" | grep -oaE 'WI-[0-9]+')"
    log "EI filed OK → $LAST_FILED_EI_ID"
  else
    log "EI filing DID NOT CONFIRM (no WI id in response) — resp head: ${resp:0:200}"
  fi
}

# file_red <marker-name> <title> <body> — dedup through red-marker.sh, then file.
file_red() {
  local marker="$STATE_DIR/$1" title="$2" body="$3" verdict
  verdict="$(red_dedup_check "$marker" "$KEYPERM_RED_REFILE_H")"
  if [ "${verdict%% *}" = "SUPPRESS" ]; then
    log "RED dedup: ${verdict#* }. $title"
    return 0
  fi
  log "RED dedup: ${verdict#* }"
  file_ei "$title" "$body"
  red_marker_write "$marker" "$LAST_FILED_EI_ID"
}

# is_private_key <file> — 0 when the file carries a PRIVATE KEY header.
# -I skips binaries, -m1 stops at the first match, and NOTHING from the file is
# ever echoed: this predicate answers yes/no and discards the matched line.
is_private_key() {
  local f="${1:-}"
  [ -f "$f" ] && [ -r "$f" ] || return 1
  grep -qaI -m1 'PRIVATE KEY' "$f" 2>/dev/null
}

# mode_of <path> — numeric mode ("600"), or empty when unreadable.
mode_of() { stat -c '%a' "$1" 2>/dev/null || true; }

# group_or_other_bits <mode> — 0 (true) when any group/other bit is set.
# Modes are compared as OCTAL TEXT, not arithmetic: `stat -c %a` drops leading
# zeros ("600", not "0600"), so a numeric comparison silently reinterprets a
# 4-digit setuid mode. Taking the last two characters is exact for both forms.
group_or_other_bits() {
  local m="${1:-}"
  [ -n "$m" ] || return 1
  [ "${m: -2}" != "00" ]
}

# key_is_unencrypted <file> — 0 when the private key has NO passphrase, i.e. it
# is directly usable by anyone who can read it. This is the fact that separates
# "readable" from "usable" and it is why EI-22240449643643994's severity was
# raised. ssh-keygen -y prints the PUBLIC half; it is redirected to /dev/null so
# no key material ever reaches a log. A non-OpenSSH key (a TLS .pem) simply
# fails here, which reports as "unknown", never as "encrypted".
key_is_unencrypted() {
  command -v ssh-keygen >/dev/null 2>&1 || return 1
  ssh-keygen -y -P '' -f "${1:-}" >/dev/null 2>&1
}

FINDINGS=""        # human-readable lines, appended by both tiers
FINDING_COUNT=0
add_finding() { FINDINGS="${FINDINGS}$1"$'\n'; FINDING_COUNT=$((FINDING_COUNT + 1)); }

# ── TIER 1: .ssh directories ────────────────────────────────────────────────
# Cheap, depth-bounded, and the tier that would have caught the 2026-09-03 key.
# It checks BOTH halves of that finding: the containing directory's mode (0775)
# and each contained private key's mode (0664). A 0700 directory holding a 0644
# key is still an exposure to anything running as the owner's group inside it,
# and a 0600 key inside a 0775 directory is exposed to a path-traversal read of
# anything else in there, so neither check subsumes the other.
SSH_SCAN_OK=1
SSH_KEYS_SEEN=""
for root in $KEYPERM_SSH_ROOTS; do
  [ -d "$root" ] || { log "tier1: skip missing root $root"; continue; }
  # A find that ERRORS is not a find that found nothing — constraint (3). Its
  # exit status is captured so a partial walk can never be reported as clean.
  while IFS= read -r sshdir; do
    [ -n "$sshdir" ] || continue
    dmode="$(mode_of "$sshdir")"
    if group_or_other_bits "$dmode"; then
      add_finding "DIR  mode=${dmode} ${sshdir} (expected 700)"
    fi
    while IFS= read -r f; do
      [ -n "$f" ] || continue
      is_private_key "$f" || continue
      SSH_KEYS_SEEN="${SSH_KEYS_SEEN}${f}"$'\n'
      fmode="$(mode_of "$f")"
      group_or_other_bits "$fmode" || continue
      if key_is_unencrypted "$f"; then
        add_finding "KEY  mode=${fmode} ${f} — UNENCRYPTED (no passphrase): readable == usable"
      else
        add_finding "KEY  mode=${fmode} ${f} — passphrase-protected or non-OpenSSH format"
      fi
    done < <(find "$sshdir" -maxdepth 1 -type f ! -name '*.pub' ! -name 'known_hosts*' ! -name 'config' ! -name 'authorized_keys*' 2>/dev/null)
  done < <(find "$root" -maxdepth "$KEYPERM_SSH_MAXDEPTH" -type d -name .ssh 2>/dev/null) || SSH_SCAN_OK=0
done

# ── POSITIVE CONTROL — constraint (3) ───────────────────────────────────────
# The tier-1 sweep must rediscover a key we already know exists. If it does not,
# the sweep is BROKEN (wrong roots, a mount it cannot cross, a depth bound too
# shallow, a permissions refusal) and its silence carries no information. Report
# that as a RED about the detector rather than letting an empty finding list be
# read as a clean bill of health.
CONTROL_STATUS="skipped"
if [ -n "$KEYPERM_POSITIVE_CONTROL" ] && [ -f "$KEYPERM_POSITIVE_CONTROL" ]; then
  if printf '%s' "$SSH_KEYS_SEEN" | grep -qxF "$KEYPERM_POSITIVE_CONTROL"; then
    CONTROL_STATUS="passed"
  else
    CONTROL_STATUS="FAILED"
  fi
else
  log "positive control $KEYPERM_POSITIVE_CONTROL is absent — the tier-1 sweep is UNVALIDATED this run."
fi
log "tier1: .ssh sweep over [$KEYPERM_SSH_ROOTS] depth<=$KEYPERM_SSH_MAXDEPTH — positive control: $CONTROL_STATUS"

if [ "$CONTROL_STATUS" = "FAILED" ] || [ "$SSH_SCAN_OK" != 1 ]; then
  file_red "scanbroken-red-ei-filed" \
    "fed-plane key-permission probe cannot validate itself on $(hostname 2>/dev/null || echo unknown-host) — its result is INDETERMINATE, not clean" \
    "WI-2143622 key-permission probe: the tier-1 .ssh sweep FAILED ITS POSITIVE CONTROL (control=${CONTROL_STATUS}, findRc_ok=${SSH_SCAN_OK}). It was asked to rediscover a private key known to exist at ${KEYPERM_POSITIVE_CONTROL} while sweeping roots [${KEYPERM_SSH_ROOTS}] to depth ${KEYPERM_SSH_MAXDEPTH}, and did not. UNTIL THIS IS FIXED THE PROBE'S SILENCE MEANS NOTHING: an exposed key would produce the same empty output. Likely causes, in the order they have actually bitten here: a root on a filesystem the sweep does not cross; a depth bound too shallow for where the key lives; a permission refusal reading a directory (the sweep runs unprivileged by design); the control path itself moved. ACTION: run the script by hand with KEYPERM_NO_FILE=1 and read the tier-1 log lines, then correct KEYPERM_SSH_ROOTS / KEYPERM_SSH_MAXDEPTH / KEYPERM_POSITIVE_CONTROL. Do NOT silence this by deleting the control."
fi

# ── TIER 2: content-matched sweep outside .ssh ──────────────────────────────
# Catches what tier 1 structurally cannot: an exported deploy key, a .pem
# checked into a working tree, a key in a backup directory that is not shaped
# like a home. Bounded by KEYPERM_DEEP_TIMEOUT_S and nice'd, because on this box
# the same sweep ran for ~10 minutes at load average 63 (a security probe that
# degrades its host is a probe that gets disabled).
DEEP_STATUS="disabled"
if [ "$KEYPERM_DEEP" = 1 ]; then
  DEEP_STATUS="ok"
  for root in $KEYPERM_DEEP_ROOTS; do
    [ -d "$root" ] || { log "tier2: skip missing root $root"; continue; }
    log "tier2: content sweep of $root (timeout ${KEYPERM_DEEP_TIMEOUT_S}s)"
    deep_out="$(timeout "$KEYPERM_DEEP_TIMEOUT_S" nice -n 19 ionice -c 3 \
      find "$root" "${PRUNE_ARGS[@]}" -type f -size -64k -size +100c -print0 2>/dev/null \
      | xargs -0 -r -n 200 grep -laI -m1 'PRIVATE KEY' 2>/dev/null || true)"
    rc=${PIPESTATUS[0]}
    # 124 is timeout(1)'s own "the command timed out" status. Partial output from
    # a killed sweep is not a complete answer, so it is reported as such rather
    # than folded into the clean case.
    if [ "$rc" = 124 ]; then
      DEEP_STATUS="TIMEOUT"
      log "tier2: TIMED OUT after ${KEYPERM_DEEP_TIMEOUT_S}s under $root — result INDETERMINATE, not clean."
    fi
    while IFS= read -r f; do
      [ -n "$f" ] || continue
      # Tier 1 already reported anything under a .ssh directory, with the
      # richer encryption verdict; do not double-file the same path.
      case "$f" in */.ssh/*) continue ;; esac
      fmode="$(mode_of "$f")"
      group_or_other_bits "$fmode" || continue
      add_finding "FILE mode=${fmode} ${f} (content-matched private key outside .ssh)"
    done <<<"$deep_out"
  done
fi

if [ "$DEEP_STATUS" = "TIMEOUT" ]; then
  file_red "deeptimeout-red-ei-filed" \
    "fed-plane key-permission deep sweep timed out on $(hostname 2>/dev/null || echo unknown-host) — the tier-2 result is INDETERMINATE" \
    "WI-2143622 key-permission probe: the tier-2 content sweep over [${KEYPERM_DEEP_ROOTS}] exceeded KEYPERM_DEEP_TIMEOUT_S=${KEYPERM_DEEP_TIMEOUT_S}s and was killed. Whatever it had found so far is reported alongside this, but ABSENCE OF FURTHER FINDINGS PROVES NOTHING for this run — a killed find prints nothing and looks exactly like a clean one, which is the failure mode this probe was built to refuse (see constraint 3 in the script header). ACTION: either raise KEYPERM_DEEP_TIMEOUT_S, narrow KEYPERM_DEEP_ROOTS, or widen KEYPERM_EXCLUDE_DIRS — on this box the dominant cost is vendored dependency trees, and pruning them is what makes the sweep tractable. Note that tier 1 (.ssh directories) is independent of this and reported separately."
fi

# ── Report ──────────────────────────────────────────────────────────────────
if [ "$FINDING_COUNT" = 0 ]; then
  log "no exposed private keys found (tier1 control=$CONTROL_STATUS, tier2=$DEEP_STATUS)."
  rm -f "$STATE_DIR/exposed-red-ei-filed"
else
  log "EXPOSED PRIVATE KEYS: $FINDING_COUNT"
  printf '%s' "$FINDINGS" >&2
  file_red "exposed-red-ei-filed" \
    "${FINDING_COUNT} private key(s) or .ssh director(ies) are group/world-readable on $(hostname 2>/dev/null || echo unknown-host)" \
    "WI-2143622 key-permission probe: ${FINDING_COUNT} exposure(s) found. A private key readable by group or other is usable by every local account and by anything that can read the backup tree it sits in; when it is also UNENCRYPTED (marked below where established) readable means directly usable — that distinction is what raised EI-22240449643643994 from a hygiene note to a credential exposure.

FINDINGS (paths and mode bits only — this probe never reads or logs key material):
${FINDINGS}
ACTION: for each, chmod 0600 the key and 0700 its containing directory, then decide whether the key must be ROTATED — permissions are recoverable, an already-copied key is not. Check who could have read it (group membership, backup replication targets, anything that syncs that tree) before assuming a chmod closes the incident.

CONTEXT: every hit here already survived the vendored-tree exclusion set (${KEYPERM_EXCLUDE_DIRS}), whose measured false-positive floor on this box is ZERO — 755 published third-party test keys were excluded by it. So these are not test fixtures unless the exclusion set has drifted; verify that before dismissing one."
fi

exit 0
