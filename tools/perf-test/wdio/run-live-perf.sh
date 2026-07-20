#!/usr/bin/env bash
# Live fresh-binary desktop-perf verification (desktop-performance-suite-2026-07-20, live gate).
# Uses the already-built 0.0.12 AppImage (04:04 today) instead of a cold cargo rebuild.
# Runs on a PRIVATE Xvfb display so it never touches the owner's session.
# NOTE: box is under heavy load — treat the LATENCY numbers as informational;
# this run's load-independent value is proving the harness boots+drives+reads end-to-end.
set -uo pipefail
cd "$(dirname "$0")"
WDIO_DIR="$(pwd)"
EXTRACT_DIR="$WDIO_DIR/.appimage-extract"
APPIMAGE="/home/marsh-office/papercupai-workspace/papercusp/papercusp-desktop/src-tauri/target/release/bundle/appimage/Papercusp_GUI_0.0.12_amd64.AppImage"
DISP=":199"
LOG="$WDIO_DIR/results/live-run-$(date -u +%Y%m%dT%H%M%SZ).log"
mkdir -p "$WDIO_DIR/results"

echo "== STEP 0: preflight ==" | tee -a "$LOG"
echo "AppImage: $APPIMAGE" | tee -a "$LOG"
[ -x "$APPIMAGE" ] || { echo "FATAL: AppImage missing/not-exec" | tee -a "$LOG"; exit 2; }
command -v tauri-driver >/dev/null || { echo "FATAL: tauri-driver not on PATH" | tee -a "$LOG"; exit 3; }
if command -v WebKitWebDriver >/dev/null; then echo "WebKitWebDriver: $(command -v WebKitWebDriver)" | tee -a "$LOG";
else echo "WARN: WebKitWebDriver not on PATH (tauri-driver needs it) — will try bundled" | tee -a "$LOG"; fi

echo "== STEP 1: extract binary from AppImage (reuse if present) ==" | tee -a "$LOG"
if [ -x "$EXTRACT_DIR/squashfs-root/usr/bin/papercusp-desktop" ]; then
  echo "Reusing existing extraction at $EXTRACT_DIR/squashfs-root" | tee -a "$LOG"
  cd "$EXTRACT_DIR"
else
  rm -rf "$EXTRACT_DIR"; mkdir -p "$EXTRACT_DIR"; cd "$EXTRACT_DIR"
  "$APPIMAGE" --appimage-extract >/dev/null 2>>"$LOG" || { echo "FATAL: appimage-extract failed" | tee -a "$LOG"; exit 4; }
fi
BIN="$(find "$EXTRACT_DIR/squashfs-root" -type f -name 'papercusp-desktop' 2>/dev/null | head -1)"
[ -z "$BIN" ] && BIN="$(find "$EXTRACT_DIR/squashfs-root/usr/bin" -type f -executable 2>/dev/null | head -1)"
echo "Resolved binary: ${BIN:-<none>}" | tee -a "$LOG"
[ -x "$BIN" ] || { echo "FATAL: no executable binary in AppImage" | tee -a "$LOG"; ls -R "$EXTRACT_DIR/squashfs-root/usr" 2>/dev/null | head -40 | tee -a "$LOG"; exit 5; }

echo "== STEP 1b: reap stale harness procs (avoid :4445 collision) ==" | tee -a "$LOG"
pkill -f "tauri-driver" 2>/dev/null; pkill -f "squashfs-root/usr/bin/papercusp-desktop" 2>/dev/null; pkill -f "wdio run wdio.conf" 2>/dev/null
sleep 2
if command -v fuser >/dev/null; then fuser -k 4445/tcp 4446/tcp 2>/dev/null; sleep 1; fi
echo "port 4445 holders after reap: $(ss -ltnp 2>/dev/null | grep ':4445' || echo none)" | tee -a "$LOG"

echo "== STEP 2: private Xvfb on $DISP ==" | tee -a "$LOG"
pkill -f "Xvfb $DISP" 2>/dev/null; sleep 1
Xvfb "$DISP" -screen 0 1600x1000x24 -ac -nolisten tcp >>"$LOG" 2>&1 &
XVFB_PID=$!
sleep 2
kill -0 "$XVFB_PID" 2>/dev/null || { echo "FATAL: Xvfb $DISP failed to start" | tee -a "$LOG"; exit 6; }
echo "Xvfb pid $XVFB_PID on $DISP" | tee -a "$LOG"

echo "== STEP 3: wdio run (TAURI_APP_PATH=$BIN, DISPLAY=$DISP) ==" | tee -a "$LOG"
cd "$WDIO_DIR"
# Bundled libs live alongside the binary; help the loader find them.
BINDIR="$(dirname "$BIN")"
export LD_LIBRARY_PATH="$BINDIR/../lib:$BINDIR:${LD_LIBRARY_PATH:-}"
DISPLAY="$DISP" TAURI_APP_PATH="$BIN" timeout 300 npx wdio run wdio.conf.ts >>"$LOG" 2>&1
RC=$?
echo "== wdio exit code: $RC ==" | tee -a "$LOG"

echo "== STEP 4: cleanup ==" | tee -a "$LOG"
kill "$XVFB_PID" 2>/dev/null
echo "LOG: $LOG"
echo "DONE rc=$RC"
exit $RC
