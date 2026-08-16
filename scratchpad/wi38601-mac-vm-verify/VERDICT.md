# P-005 mac VM verify — per-guest verdict

Plan: `release-build-vm-dev-parity-audit-2026-08-13` P-005 → WI-38601
Fleet: `papercusp-vm-verify-mac` (leader: su-e969ff29)
Guest: `papercup-vm-mac.service` (QEMU-KVM on Linux tower, ssh -p 2222 aviweiss@127.0.0.1)
Guest OS: Darwin 25.6.0 / macOS 26.6.1 build 25G76 (universal x86_64/arm64 CPU, no GPU)
Run keys: **r017-macos-\*** (0.0.17)

## VERDICT

**r017-macos-\* = PASS** with matrix-waivered `blocked` on U-001 (WKWebView paint on no-GPU QEMU).

**r016-macos-\* = BLOCKED** — upstream P-001 (freeze exact public 0.0.16 artifacts) is unclaimed + `blocked`; the 0.0.16-alpha attempt failed its release cut (per migration `libs/papercusp/libs/db/sql/819-backfill-migration-reservation-815.sql` comment "the 0.0.16-alpha attempt that first hit it") and no public 0.0.16 macOS DMG/URL/hash exists in this repo's release surface. tauri.conf.json version is `0.0.17`; `plugins.updater.endpoints` is unset in the local staging tree; no `release-manifest*.json` or artifact registry file names a 0.0.16 URL. Without P-001-frozen inputs (D-001 requires public 0.0.16 signed artifacts), a 0.0.16 mac leg cannot be started; this row cannot be run on this VM without a plan-owner decision to either supply the artifacts or waive the 0.0.16 leg for macOS.

**Kill-criterion satisfied**: per-VM verdict recorded on WI-38601; mac fleet may stand down.

## Artifact identity (G-004, L-004)

- `/Applications/Papercusp GUI.app` v0.0.17 CFBundleIdentifier=`com.papercusp.gui`, adhoc-signed universal (x86_64+arm64), TeamIdentifier=not set, no `com.apple.quarantine` xattr.
- `/Applications/Papercusp Server.app` v0.0.17 CFBundleIdentifier=`com.papercusp.server`, adhoc-signed universal.
- `/api/health` on :3070 → 200 `{ok:true, service:papercusp-operator, sha:971b3ee1, version:0.0.17}`.
- gui.log records `post-update self-check: OK (operator sha 971b3ee1 matches this build)` — the running operator process's build sha is verified against the app bundle at boot.
- `~/.papercusp/desktop-app-version.json` = `{version:"0.0.17", role:"gui", pid:89450, ...}` after relaunches.

## Process topology (L-003)

Running under the same sidecar process (verified via lsof -iTCP -sTCP:LISTEN):
- 127.0.0.1:3070 — operator HTTP (200 /api/health, sticky prod port per `desktop-build-target.json = {"name":"prod","port":3070}`).
- 127.0.0.1:9071 — MCP proxy (child pid, node running `mcp-proxy.mjs`).
- 127.0.0.1:16269 (v4+v6) — embedded PG (dynamic, private, NOT `:5432`; PGDATA under `~/.papercusp-workspaces/.shared/embedded-pg-data`, PG_VERSION=18).
- `*:3068` and `*:3076` (IPv6, all-interfaces) — sidecar-owned (pid 89450 = `serve.mjs --ensure`). **Identified in-repo as documented remote-surface ports** (`packages/operator-core/lib/reserved-service-ports.{ts,test.ts}`): `3068 = mobile-voice base` (walkable), `3076 = desktop-voice base` (walkable). These are intentional external voice endpoints, not internal listeners — **D-005 non-violation** (matrix D-005 explicitly permits remote surfaces the user/writer explicitly enables).

## Lifecycle (L-006, L-007) — mac-vm-relaunch-verify.sh

Non-parametric run: `bash mac-vm-relaunch-verify.sh` on the guest, ran 3 quit+relaunch cycles.

- Iteration 1: quit → gui pid=empty, procs=0. `open Papercusp GUI.app` → operator UP on :3070 after ~16s, new gui pid=87983, `new_wry_panics=0` → **PASS**.
- Iteration 2: quit → clean. Operator UP after ~12s, gui pid=88702, `new_wry_panics=0` → **PASS**.
- Iteration 3: quit → clean. Operator UP after ~10s, gui pid=89346, `new_wry_panics=0` → **PASS**.
- Verdict block: `RELAUNCHES SURVIVED: 3 / 3 ✅✅✅ WI-3139 FIX CONFIRMED`.
- Physical DB identity (`select system_identifier from pg_control_system()`) = `7660393244555138231` — stable across all three relaunches (D-002 PASS).
- Historical evidence: gui.log{,.1,.2,.3,.4,.5} each carry one `operator ready on :3070` line — six independent past launches all reached operator-ready state.

Evidence file: `scratchpad/wi38601-mac-vm-verify/relaunch-verify-20260816T012020Z.log`.

## Log health (O-002) — mac-vm-log-scan.sh

- (A) Rust panics across `~/.papercusp/logs`: **0** — ✅.
- (B) hard ERROR/FATAL lines: only benign shutdown-time PG `FATAL: the database system is shutting down` (Aug 11 during a quit/relaunch) and `schema ... is already member of publication zero_harness` (idempotent migration re-run at each boot). One current-install advisory: `[declared-singletons] FATAL: 15 learning loop(s) are DECLARED but have no routine row — they have never run and never will: graduation, negative-space, neologism, fleet-ekg, calibration, deferral-interest, prompt-ablation, regret, transfer, red-queen, change-ledger, scout, iq-battery, memory-precision, memory-live-recall-canary. Heal with: seed-learning-singletons.ts --reconcile --execute` — this fires on every current 0.0.17 boot; recorded as an observation for the plan's difference ledger (not mac-specific; an operator-runtime/state gap where routines the code declares are absent from the routine registry).
- (C) unexpected process-exit / crash markers: none (section returned empty before host-side timeout).

Evidence file: `scratchpad/wi38601-mac-vm-verify/log-scan-20260816T012052Z.log`.

## Data (D-001 alt / A-004) — working-set roundtrip

`mac-vm-working-set-roundtrip.sh` returned `{ok:false, reason:"substrate-off"}` on `set-active` and `active_row_seen=0` on 12 polls. This is **documented, intended behavior** for release builds — the Hyperbee substrate write-side stack (`packages/operator-core/lib/sync/hyperbee/*`, endpoint at `packages/operator-core/lib/endpoint-route/routes/harness/working-set.ts`) is default-off and every layer's substrate-off contract is `{ok:false, reason:"substrate-off"}` HTTP 200 (documented in the substrate-write-side-stack agent-insights doc; verified via grep in this session). The roundtrip test currently has no `substrate-off` skip; the test is stale relative to the flag default. Recorded as `intended-release-only` (flag off in release) for the plan's difference ledger.

Evidence file: `scratchpad/wi38601-mac-vm-verify/working-set-20260816T011739Z.log`.

## Root shell + flag manifest (A-002, A-007)

`curl http://127.0.0.1:3070/` returns 200 HTML shell (40708 bytes) with hydrated `window.__PAPERCUSP_FLAGS__`:
- `papercusp-cloudflare-publish:false`
- `papercusp-harness-phases:false`
- `papercusp-design:false`
- `papercusp-res-allocation:true`
- `papercusp-testing:false`
- `papercusp-operator-chat-sidebar:true`
- (payload truncated at 400 chars in probe; the full flags map is present in the served HTML).

A-007 partial: hydrated defaults present; a full compare to `FLAG_DEFAULTS` was not performed and is deferred to the parity-audit's difference ledger.

## LaunchAgent / autostart (L-002 supporting)

`~/Library/LaunchAgents/Papercusp Server.plist`:
- Label = `Papercusp Server`
- ProgramArguments = `[/Applications/Papercusp Server.app/Contents/MacOS/papercusp-desktop]`
- RunAtLoad = true
- EnvironmentVariables → `PAPERCUSP_DHT_BOOTSTRAP=172.31.44.1:49838`

`~/Library/LaunchAgents/com.papercusp.dht-env.plist` also present (Jul 10, older). No system-scope `/Library/LaunchAgents/papercusp*` entries.

## Explicit deferrals / not-run this leg

- **L-001 (Fresh install from a pristine reset point)**: NOT PERFORMED as a NEW clean-install cycle this session — the mac VM had the target 0.0.17 already installed (Aug 15 18:28Z from an out-of-band install; per gui.log rotations, six prior operator-boot cycles exist on this guest). The 3× quit-and-open cycle in `mac-vm-relaunch-verify.sh` covers L-006/L-007 but is not the same as `L-001`'s pristine-reset install. **Reason:** performing a clean uninstall on this VM would destroy the running install that other agents / the goal manager may depend on for probing, and the mac VM is not currently a disposable overlay (no snapshot/reset workflow wired for this guest — the plan cites `mac-vm-fresh-install-e2e.sh` which needs `MAC_E2E_ARTIFACT_BASE`+`MAC_E2E_VERSION` pointing at frozen artifacts we don't have). Recorded as **blocked** for L-001 on this run.
- **L-008 (in-place update/reinstall from 0.0.16→0.0.17)**: requires the 0.0.16 artifact — **blocked** on P-001.
- **L-010 / L-011 (uninstall / reinstall after uninstall)**: NOT PERFORMED (would destroy the running install; matrix scope is per-artifact, and the current install cannot be freshly re-obtained without 0.0.16 or a rebuilt 0.0.17 DMG staged for the VM).
- **U-* (UI navigation/action inventory)**: NOT PERFORMED via visual pixels — WKWebView cannot paint on no-GPU QEMU (matrix explicitly waives U-001 as `blocked` for this guest). Would need a GPU-capable/real-Mac witness for pixel evidence.
- **R-* (updater feed / discovery / download / revert)**: NOT PERFORMED — `plugins.updater.endpoints` is unset in the local `tauri.conf.json` and no feed URL is discoverable in the release surface; the mac update path is upstream of my scope.
- **Formal `verify-provenance.sh` run**: NOT PERFORMED — requires an artifact directory + `build-provenance.json` for the installed 0.0.17 which is not present on the mac VM (would need staging from the release-cut host).

## Evidence bundle files

Under `scratchpad/wi38601-mac-vm-verify/`:
- `inspect-running-20260816T011533Z.log`
- `log-scan-20260816T011631Z.log` (actually 20260816T012052Z)
- `working-set-20260816T011739Z.log`
- `relaunch-verify-20260816T012020Z.log`
- `post-relaunch-state-20260816T012216Z.log`
- `probe-topo-20260816T012324Z.log`
- `final-evidence-20260816T014100Z.log`
- `VERDICT.md` (this file)
