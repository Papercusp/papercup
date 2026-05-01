#!/usr/bin/env bash
# papercusp provision/lib.sh
#
# Plugin scripts source this via:
#   . "$PAPERCUSP_RUNTIME_LIB"
#
# Substrate-side env vars:
#   PAPERCUSP_PLUGIN_DIR     read-only path to plugin root
#   PAPERCUSP_SCRATCH_DIR    read-write per-(harness, plugin) scratch
#   PAPERCUSP_RECORD_FIFO    named pipe the substrate reads from for record_resource
#   PAPERCUSP_PROGRESS_FD    fd to write structured progress markers (default 3)
#
# Spec: /docs/snapshots/build-scripts#helper-library

# Choose a fallback fd if the substrate didn't open one.
: "${PAPERCUSP_PROGRESS_FD:=2}"

papercusp_progress() {
  local step="$1"; shift
  local msg="$*"
  printf '::papercusp::progress\t%s\t%s\n' "$step" "$msg" >&"$PAPERCUSP_PROGRESS_FD"
}

papercusp_warn() {
  local msg="$*"
  printf '::papercusp::warn\t%s\n' "$msg" >&"$PAPERCUSP_PROGRESS_FD"
}

papercusp_error() {
  local msg="$*"
  printf '::papercusp::error\t%s\n' "$msg" >&"$PAPERCUSP_PROGRESS_FD"
}

# Append a resource record to the WAL via the named-pipe bridge. Each
# call is atomic (newline-delimited JSON), so a SIGKILL between calls
# never partial-writes.
papercusp_record_resource() {
  local kind="$1"
  local id="$2"
  local meta="${3:-}"
  local now
  now="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  if [[ -n "$meta" ]]; then
    printf '{"kind":"%s","externalId":"%s","recordedAt":"%s","metadata":%s}\n' \
      "$kind" "$id" "$now" "$meta" >> "${PAPERCUSP_RECORD_FIFO:-/dev/null}"
  else
    printf '{"kind":"%s","externalId":"%s","recordedAt":"%s"}\n' \
      "$kind" "$id" "$now" >> "${PAPERCUSP_RECORD_FIFO:-/dev/null}"
  fi
}

# Set a key in state.json's `outputs` object — same FIFO, different verb.
papercusp_state_set() {
  local key="$1"
  local val="$2"
  printf '{"$op":"state_set","key":"%s","value":%s}\n' \
    "$key" "$val" >> "${PAPERCUSP_RECORD_FIFO:-/dev/null}"
}
