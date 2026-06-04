---
title: Linux clean-room test VM + VM-based two-instance federation testing
slug: linux-test-vm-and-federation-2026-06-04
status: draft
created: 2026-06-04
updated: 2026-06-04
owner: aviynw3@gmail.com
---

# Linux clean-room test VM + VM-based two-instance federation testing

## Now

**State:** Phase 1 (VM clean-room workflow) COMPLETE + the VM caught and we fixed THREE real clean-machine bugs in the Linux .deb, each VM-verified: (1) embedded-PG/zero spawns missing bundled-node PATH → no DB (D-009, main.rs bundled_path_env); (2) frontendDist hardcoded to :3070 → blank window (D-011, tauri.conf → ../web); (3) window port-handoff race + localhost/IPv6 → bootstrap stuck (D-012, main.rs re-eval timer + 127.0.0.1). The packaged app now installs and RENDERS its onboarding UI on a pristine Ubuntu (DB OK, operator OK, window OK). Remaining (separate, app's prereq gate, not blank-window): preflight lists claude/gh not on PATH (user-installed), meridian service down, and harness "orchestrator bin not found" (likely a bundling gap) — these gate reaching the full harness UI. Phase 2 federation (P-007–P-013) DEFERRED per user.

**Next:** Human decision: whether to chase the preflight prereq gaps (esp. the harness-orchestrator bundling path) so the app reaches the full harness UI, and when to pick up the deferred Phase 2 federation testing. The 3 fixes (main.rs ×2, tauri.conf) land via git-sync; the rpm was not rebuilt with the fixes (deb-only test builds).

## Background

The packaged Linux build (`tauri build` → `.deb` ~722 MB, `.rpm`) is currently only
ever run on the dev host. Two things can't be validated there:

1. **Fresh install** — does the `.deb` install cleanly and launch on a *pristine*
   Ubuntu, pulling its WebKitGTK runtime via its own declared deps? The dev box has
   every dep already, so it can't catch a missing/incorrect dependency declaration.
2. **Cross-machine shared harnesses** — the existing two-instance federation smokes
   isolate two `.deb` instances by separate `$HOME` on **one box**. Their documented
   ceiling (see `agent-insights/packaged-two-instance-federation-merge.md`):
   - Two Hyperswarm peers on one box can't holepunch their own public IP (**NAT
     hairpinning**) → the smokes **must** use a local testnet DHT, not the real one.
   - Teardown is a fragile `pkill -f "$WORK"` (the header warns "NEVER `pkill -f
     papercusp-desktop`").
   - The OS keychain is shared (`<gh_id>:<machine-fingerprint>`).
   - The explicit **"Mode B — two real machines"** acceptance (NAT/firewall/DHT
     reachability) "cannot be faked on one host".

Federation transport (verified by reading the source): the **control/admission
plane is GitHub gists** (write-free join; admission proves `device_pubkey ↔
github_user_id` from each peer's own attestation gist + signed announce — a synthetic
repo id only seeds the swarm topic), and the **data plane is Hyperswarm P2P over a
DHT** (Hypercore replication; feature content + issues federate via the CDC-outbox,
migrations 102–104). So a "separate machine" needs **outbound internet + its own
GitHub identity + mutual P2P reachability to the other peer**.

A VM gives real OS isolation (separate kernel/FS/PID space), clean teardown
(power-off), distinct machine fingerprints, and — with a real inter-VM network — a
real network hop between the peers instead of loopback. The same identities
(`papercupai` + `aviynw`) and the same write→assert→reverse logic carry over.

Box capability (already a heavy VM host): `/dev/kvm` present (AMD-V), 128 cores,
251 GB RAM, ~683 GB free; `qemu-system-x86_64`, `cloud-localds`, `virt-install`,
`xorriso` installed; existing Mac/Win build VMs run as **raw qemu** boot scripts
(libvirt installed but inactive) — this plan matches that convention.

## Goals / Non-goals

**Goals**
- Repeatable, disposable Ubuntu 24.04 clean-room VM for fresh-install testing the `.deb`.
- A `vm` driver for the existing two-instance federation smokes: one VM (host-instance
  ↔ VM-instance) and two VMs (VM ↔ VM).
- One shared assertion/orchestration core used by both the existing `local` driver and
  the new `vm` driver — no duplicated federation logic.
- Documented alongside the Mac/Windows build VMs in `build-system/vms.md`.

**Non-goals (v1)**
- Single-instance boot PASS/FAIL CI smoke (stays host-local — D-007).
- Fedora / `.rpm` profile (Ubuntu only; harness stays parametrizable).
- A full public-DHT "true Mode B" acceptance (offered as a stretch variant, P-012).
- An `/admin` start button like the Mac/Win VMs (CLI-first).

## Design detail

### File layout
- **Versioned (in `papercusp-desktop` repo):** `scripts/linux-test-vm/` (`vmctl`,
  `boot-vm.sh`, `cloud-init/` templates, `lib/`) and `bin/` (the federation
  entrypoints + `bin/lib/federation-asserts.sh`).
- **Heavy artifacts (outside the repo, never committed):** `~/papercup-linux-test-vm/`
  — base cloud image, `golden.qcow2`, per-run overlays, seed iso, monitor sock, logs;
  SSH key `~/.ssh/papercup-vm-linux`. Mirrors the `~/macos-vm/`, `~/win10-vm/` split.

### Clean-room VM (Phase 1)
- Golden image: Ubuntu 24.04 cloud image (~40 GB), cloud-init sets hostname
  `papercusp-testvm` + user `tester` (SSH key + sudo). First boot installs
  `ubuntu-desktop-minimal` (GNOME on **Xorg**), `spice-vdagent`, `openssh-server` —
  and **deliberately NOT** `libwebkit2gtk*`/Node/cargo (so the `.deb` deps are what's
  tested). Snapshot → `golden.qcow2` (never booted directly).
- Working **overlay** backed by golden; `reset` recreates it → instant pristine VM.
- Control (single clean-room VM): raw qemu, ~16 GB / 8 vCPU, virtio, `-vga qxl` +
  SPICE `127.0.0.1:5932`, slirp net `hostfwd tcp::2224-:22` + `tcp::3072-:3070`.
  SSH `-p 2224 tester@127.0.0.1`; `remote-viewer spice://127.0.0.1:5932`. (Existing
  VMs use SSH 2222/2223, SPICE 5930/5931.)

### VM-based federation (Phase 2)
- **Networking (recommended):** host bridge `papercusp-fedbr0` (`10.77.0.0/24`, host
  `10.77.0.1`, dnsmasq DHCP + NAT to internet). Each VM taps the bridge
  (`10.77.0.2/.3`) → reaches the other VM directly, the internet (gists), and the
  host. Host runs `hyperdht/testnet` on `10.77.0.1:<port>`; both VMs set
  `PAPERCUSP_DHT_BOOTSTRAP=10.77.0.1:<port>` → discovery + replication cross a real
  network hop. SSH over the bridge IPs; SPICE `127.0.0.1:59xx` per VM. Needs root
  (bridge/tap/iptables). **Rootless fallback** (`--net=socket`): dual-NIC — slirp for
  internet/SSH/SPICE + a qemu `-netdev socket` L2 link between the two VMs (static
  `10.99.0.1/2`), bootstrap inside VM-A; supports exactly two VMs.
- Identities `papercupai` / `aviynw` (per-VM `gh`/`GH_TOKEN`); app runs **headless
  under a per-VM Xvfb** (GNOME desktop is for the Phase-1 interactive use only).
- Pass criteria (reused from the local merge proof): both boot
  (`bindingPublished:true`, `swarm.state:"booted"`); `[swarm] peer_connected` in both
  logs (no `[swarm] join FAILED`); a feature created on A lands in B's
  `harness_features_consolidated` with `origin='remote'` within ~30 s **and** the
  reverse (bidirectional hard gate); teardown by power-off.

### Fidelity ladder (what each level proves)
| Level | Isolation | Network path | DHT | Proves |
|---|---|---|---|---|
| Current (one box) | `$HOME` env | loopback | testnet | federation **logic** |
| **VM + testnet (primary)** | real OS × N | real bridge hop | testnet | logic over **real OS + real network**, deterministic |
| VM + public DHT (stretch) | real OS × N | bridge → public DHT | public | approaches true **Mode B** (NAT/firewall/DHT reachability) |

### Build/version dependency
The VM federation harness needs a `.deb` built from a tree with the `swarm.ts`
`PAPERCUSP_DHT_BOOTSTRAP` support + `boot.ts` `[swarm]` logs (landed 2026-06-02;
today's `.deb` qualifies). It must assert this up front and fail fast on an older
`.deb` (P-011), as the existing merge smoke does. Fresh `.deb` builds go through
`bin/release-local.sh` under the `desktop-sidecar` exclusive lock (clean-build clobber
gotcha: `build-desktop-sidecar.sh` → `cargo clean -p papercusp-desktop` → `tauri
build`, copy the `.deb` out immediately).

## Phase 1 — Clean-room VM infrastructure

- **P-001** `done` Design sign-off before implementation — review this plan; approve scope (Phases 1 & 2, the deferred list, the networking approach); mark done to unblock the build. importance: high (signed off by user "start phase 1" 2026-06-04)
- **P-002** `done` cloud-init templates + `vmctl provision` → build golden Ubuntu 24.04 image (GNOME/Xorg + spice-vdagent + openssh; NO webkit/Node/build tools); snapshot golden.qcow2. blocked-by: P-001 (golden built + cloud-init done + powered off clean; golden.qcow2 6.1G)
- **P-003** `done` `vmctl` lifecycle: `up`/`down` (idempotent nohup qemu), `reset` (overlay from golden), `ssh`, `status`. blocked-by: P-002 (up/down/reset/ssh/status verified live on a pristine overlay)
- **P-004** `done` `vmctl install` (scp newest `.deb` + `apt install`) + `launch`/`gui` (SPICE). blocked-by: P-003 (install/launch/gui verified; install pulls webkit from scratch, launch renders app on openbox :0)
- **P-005** `done` Fresh-install verification: assert dep resolution, embedded-PG boot, operator `:3070`, wizard render; capture install log + app log + screenshot. blocked-by: P-004 (verify works end-to-end: 7/7 green on a working app; correctly red on the real artifact caught the embedded-PG spawn bug)
- **P-006** `done` Add a "Linux test VM" row + runbook to `build-system/vms.md`. blocked-by: P-004 (Linux test VM section added to build-system/vms.mdx + docs mirror rebuilt 671 files copied)

## Phase 2 — VM-based two-instance federation testing

- **P-007** `todo` Refactor: extract orchestration/asserts into `bin/lib/federation-asserts.sh`; make the two existing smokes thin `local`-driver wrappers (behavior unchanged). blocked-by: P-001
- **P-008** `todo` Host bridge `papercusp-fedbr0` + dnsmasq DHCP/NAT + host `hyperdht/testnet` bootstrap helper; `--net=socket` rootless fallback. blocked-by: P-003
- **P-009** `todo` `vm` driver + `bin/vm-federation.sh --vms=2 --dht=testnet` (primary): install `.deb` per VM, set per-VM identity, run asserts over SSH. blocked-by: P-004, P-007, P-008
- **P-010** `todo` `--vms=1` mode (host-instance ↔ VM-instance). blocked-by: P-009
- **P-011** `todo` Assert the `.deb` honors `PAPERCUSP_DHT_BOOTSTRAP` / emits `[swarm]` logs; fail fast on an older `.deb`. blocked-by: P-009
- **P-012** `todo` Stretch: `--dht=public` variant toward true Mode B. blocked-by: P-009 importance: low
- **P-013** `todo` Docs: federation subsection in `vms.md` + (post-pass) an agent-insight page. blocked-by: P-009

## Deferred follow-ups (tracked, not dropped)

- Single-instance boot PASS/FAIL CI smoke — host-local (D-007).
- Fedora / `.rpm` profile — Ubuntu only for v1; harness stays parametrizable.
- True public-DHT two-machine Mode-B acceptance beyond the P-012 stretch variant.
- `/admin` start button (like the Mac/Win VMs) — CLI-first for v1.
- `.deb`-transfer caching / 9p shared mount (the ~722 MB copy per run).

## Decisions

### D-001 — GNOME for fresh-install faithfulness; Xvfb for the harness
Date: 2026-06-04
The golden image installs `ubuntu-desktop-minimal` (GNOME on Xorg) so fresh-install
testing mirrors a real Ubuntu desktop user; the box has ample resources. Swapping to a
lighter XFCE is a one-line cloud-init change and does not affect Phase 2, which runs the
app headless under a per-VM Xvfb regardless.

### D-002 — Host-bridge networking, with a rootless socket fallback
Date: 2026-06-04
Two VMs federate over a host bridge (`papercusp-fedbr0`, NAT to internet) so they reach
each other, the internet (gists), and the host — and the host can run the shared testnet
DHT bootstrap. Needs root, acceptable on this dev box. A rootless dual-NIC
(slirp + qemu `socket` L2 link) fallback exists behind `--net=socket` for exactly-two-VM
runs.

### D-003 — Single shared assertion core; existing smokes become local-driver wrappers
Date: 2026-06-04
The (subtle) orchestration + assertion logic moves to `bin/lib/federation-asserts.sh`;
the existing one-box smokes and the new VM harness both call it. This keeps one source of
truth so the VM driver can't drift from the proven local logic. Pre-alpha: refactoring the
existing scripts is preferred over copy-paste.

### D-004 — Primary federation target is testnet-DHT-over-bridge; public DHT is a stretch
Date: 2026-06-04
The deterministic, primary VM federation run uses a host-run `hyperdht/testnet` bootstrap
reached over the bridge — a real OS + real network hop, far stronger isolation than the
current loopback run, while staying reproducible. `--dht=public` (P-012) chases true Mode B
but same-host VMs sharing the host's public IP may still hairpin, so it is best-effort.

### D-005 — Scripts in-repo, images out-of-repo
Date: 2026-06-04
VM control scripts live in the `papercusp-desktop` repo (versioned, git-synced); heavy
disk images live in `~/papercup-linux-test-vm/` and are never committed. Mirrors the
existing `~/macos-vm/` / `~/win10-vm/` convention.

### D-006 — A "separate machine" = outbound internet + own GitHub identity + mutual P2P
Date: 2026-06-04
Federation's control plane is GitHub gists (write-free admission from a per-identity
attestation gist) and its data plane is Hyperswarm P2P. So an isolated peer needs outbound
internet + its own `gh` identity + network reachability to the other peer — which is exactly
what the bridge (D-002) provides. No shared-repo write and no host↔guest TCP beyond the DHT
path are required.

### D-007 — Single-instance smoke stays host-local
Date: 2026-06-04
Per the requester: single-instance boot smoke testing is done on the host and is out of
scope here. This VM exists for fresh-install testing and cross-machine (separate-machine)
shared-harness/federation testing only.

### D-008 — Minimal X (openbox) instead of a GNOME desktop — reverses D-001
Date: 2026-06-04
Live provisioning surfaced that GNOME Shell fails to register its session on the qxl GPU under autologin (gdm: "Session never registered, failing" → "maximum number of X display failures reached"), so the app panicked with "Failed to initialize GTK" (no usable :0). Xorg itself starts fine on qxl — only the GNOME session registration fails.

Decision: drop `ubuntu-desktop-minimal`/gdm for a minimal X stack — `xserver-xorg` + `xserver-xorg-video-qxl` + `openbox`, started via getty autologin on tty1 + `startx` (no display manager). This bypasses the gdm session-registration failure entirely, is lighter/faster to provision, keeps the app on the qxl framebuffer (so host-side qemu `screendump` and interactive SPICE both still work), and gives a deterministic `XAUTHORITY` (`~/.Xauthority` from startx) so `vmctl launch` needs no session probing.

Bonus: it makes the fresh-install dep test STRONGER. Under GNOME, libwebkit2gtk was already present so `apt install ./Papercusp.deb` pulled 0 deps; on the minimal base the .deb pulls the WebKitGTK runtime from scratch — a truer fresh install. (The .deb's declared Depends — libwebkit2gtk-4.1-0, libgtk-3-0 — and clean `ldd` resolution were both already confirmed.) Supersedes D-001.
Related: P-002, P-004, P-005

### D-009 — VM caught a shipping bug — packaged Linux .deb has no database on a clean machine
Date: 2026-06-04
The fresh-install test on the clean VM found that the shipped Linux `.deb` is non-functional on a machine without `node` on PATH (i.e. every real end-user machine; the dev box hides it because node is already on PATH).

PRIMARY BUG (root-caused, fix known): `spawn_embedded_postgres_server` (src-tauri/src/main.rs:167) and `spawn_zero_cache_server` (:203) spawn via `Command::new("node")` WITHOUT wiring the bundled-node dir onto PATH. `spawn_sidecar` (:634) does set `cmd.env("PATH", "<sidecar/bin>:…")`, so its `Command::new("node")` resolves the bundled node (sidecar/bin/node) — which is why the operator/hono-host comes up but embedded-PG does not. On the clean VM: `failed to spawn embedded-postgres-server: No such file or directory (os error 2)` → no database → sidecar then crashes on `ECONNREFUSED 127.0.0.1:5432`. The .deb's own files are intact (initdb/postgres present, not the 0-byte clobber) and the binary `ldd`-resolves cleanly. Fix: spawn these via the bundled node (sidecar/bin/node) like spawn_sidecar. This is the macOS bundled_node() lesson (build-system/vms) not applied to the Linux PG/zero spawns.

Proof: symlinking the app's own bundled node onto PATH in the VM makes `vmctl verify` go 7/7 green (PG up, operator up on its dynamic port, window renders) — confirming the spawn is the sole DB blocker.

SECONDARY OBSERVATION (not fully root-caused): even on that green path, the WebView shows "Could not connect to 127.0.0.1: Connection refused" and does not navigate to the live operator — a window navigate/retry timing issue (main.rs ~1438 "navigate when ready") worth a separate look.

Both only reproduce on a clean machine — exactly what this VM exists to catch.
Related: P-005

### D-010 — Primary bug fix VM-verified; secondary bug (blank window on clean machine) confirmed
Date: 2026-06-04
PRIMARY (D-009) FIXED + PROVEN: rebuilt the .deb with all three node spawns routed through bundled_path_env (main.rs), reset the VM to a truly pristine overlay (confirmed no `node` on PATH), fresh-installed the rebuilt .deb, and `vmctl verify` went 7/7 green with NO hacks — embedded Postgres `ready on localhost:21332 db=papercusp`, operator `sidecar ready on :23428`. The DB-spawn bug is resolved on a clean machine.

SECONDARY (newly CONFIRMED, was the D-009 observation): even on the fixed build with operator fully up, the Tauri window stays on a WebKit native error page "Could not connect to 127.0.0.1: Connection refused" — so a clean-machine user still sees a blank app. Characterized: the bundled bootstrap web/index.html DOES reach /api/desktop/preflight and retries correctly, then runs `location.replace(appBase + '/harness')` where appBase = window.__papercuspAppBase (custom protocol `papercusp://localhost` when enabled) || base (`http://localhost:<port>`). That navigation lands on the WebKit connection-refused page. From inside the VM both `127.0.0.1:<port>` and `localhost:<port>` curl 200, but `localhost` resolves to `::1` there and the operator binds 127.0.0.1 (IPv4) — a likely contributor (WebKit fetch to localhost→::1 with no IPv4 fallback), alongside the possibility the custom-protocol (papercusp://) handler doesn't serve on clean Linux. Pinning it needs the WebView console. Net: the Linux .deb's DATABASE now works on a clean machine, but the UI still doesn't render — a separate fix.
Related: P-005

### D-011 — Bug #2 root cause: frontendDist hardcoded to :3070 (Phase F2 regression)
Date: 2026-06-04
The blank-window bug (D-010) is a regression from commit f5c2bbe "Phase F2 — frontendDist → http://127.0.0.1:3070", which changed tauri.conf.json `frontendDist` from `"../web"` to the fixed URL `http://127.0.0.1:3070`.

The packaged window has no per-window `url`, so it loads `frontendDist` directly = `http://127.0.0.1:3070`. But the packaged operator/hono-host runs on a DYNAMIC port (portpicker; 23428 in the VM), so nothing is on 3070 → WebKit "Could not connect to 127.0.0.1: Connection refused". It only works on the dev box because the standing operator is on :3070 there.

The original design (still fully present): frontendDist `../web` loads the bootstrap (web/index.html) → it polls `${__papercuspBase}/api/desktop/preflight` (the dynamic port main.rs evals in) with retry/"starting harness sidecar…" UX → then `location.replace(__papercuspAppBase + '/harness')` where __papercuspAppBase = `papercusp://localhost`. The custom protocol (registered main.rs:1127, custom_protocol.rs) forwards papercusp://localhost/* to the sidecar's dynamic port (SidecarState.port). All that machinery is intact; only frontendDist points the wrong way.

Fix: revert frontendDist to `"../web"`. Only affects packaged builds (dev uses devUrl :3055). Rebuilding + VM-verifying the UI renders.
Related: P-005

### D-012 — Bug #2 FIXED — window renders on a clean machine; preflight prereqs remain (separate)
Date: 2026-06-04
Bug #2 (blank "connection refused" window) is fixed with two changes, both VM-verified on rebuilt .debs:
1. tauri.conf.json frontendDist `http://127.0.0.1:3070` → `../web` (revert the Phase F2 regression D-011) — the window loads the bootstrap page instead of a fixed dead port.
2. main.rs window-handoff: setup() ran the `__papercuspBase` eval before the bootstrap page finished loading, so the port was lost and the bootstrap polled forever (preflight served 0×). Fix: re-eval the port into the window on a 300ms×30 timer (so a late page-load still receives it), and use 127.0.0.1 instead of localhost (WebKitGTK may resolve localhost→::1 while the sidecar binds IPv4).

Result on a pristine VM: the window now renders the operator's real preflight/onboarding UI with live checks — node OK, embedded-postgres OK (127.0.0.1:19319), pi/bash/git/tar/curl OK. The two showstoppers (no DB, blank window) are gone.

REMAINING (separate, not the blank-window bug; the app's designed prereq gate): the preflight does not auto-advance to the harness UI because some checks are MISSING — `claude` + `gh` not on PATH (user-installed onboarding asks), `meridian` 127.0.0.1:3456 ECONNREFUSED (a service), and notably `harness` "orchestrator bin not found at /usr/lib/Papercusp/sidecar/harness/../orchestrator/bin/run.ts" — which looks like a packaging/path gap worth a separate look (the orchestrator may not be bundled at the expected path). These gate reaching the full harness UI but are distinct from bug #2.
Related: P-005

### D-013 — Remaining preflight blockers are incomplete desktop-migration wiring, not quick bugs
Date: 2026-06-04
FIXED: vmctl status probed a fixed :3070; now parses the dynamic operator port from the app log (reports "operator: up (port N)").

The two REQUIRED preflight checks still failing on a fresh install are incomplete desktop wiring from the in-progress orchestrator/meridian migration (Phase F2 commit f5c2bbe explicitly deferred "src-tauri/src/main.rs sidecar entry"):

- meridian (preflight required): the daemon (@rynfar/meridian, bundled at sidecar/meridian-host/node_modules/.bin/meridian → dist/cli.js) is NEVER spawned by main.rs, so 127.0.0.1:3456 is dead. meridian only routes omp/claude through the user's Claude Max subscription — omp/claude work with API keys without it — so it's arguably a convenience that should be OPTIONAL in the preflight, not a hard boot blocker. Full fix = spawn the daemon on boot in main.rs (using bundled node, kill-on-exit), like the other sidecars.

- harness (preflight required): checkHarnessDir() probes `${PAPERCUSP_HARNESS_DIR}/../orchestrator/bin/run.ts` = sidecar/orchestrator/bin/run.ts — the LEGACY CLI entry (the opt-in PAPERCUSP_USE_TS_ORCHESTRATOR path). The shipping runtime is the in-process DBOS orchestrator (apps/operator/lib/dbos/orchestrator-runner.ts, spawns an `invoke-once` bin) — bundled into host.mjs, not as a sibling dir. So the check is stale for the packaged layout. Fix = update the check to verify the real packaged artifact (or mark it appropriately), after confirming the DBOS orchestrator actually runs in-package.

claude/gh are correctly optional (user-installed onboarding asks), not bugs. Both required-blockers need a product call (required vs optional) and/or non-trivial main.rs/build wiring + rebuilds + functional verification — beyond the quick clean-machine bug fixes already landed (D-009/D-011/D-012).
Related: P-005

### D-014 — Deeper finding: meridian is unbuilt+VM-unverifiable; orchestrator is genuinely unbundled
Date: 2026-06-04
Investigating "fully wire meridian + harness" revealed both are unfinished migration features, not bug fixes — and meridian can't be verified in the clean VM:

MERIDIAN: `@rynfar/meridian` dist/cli.js imports `@anthropic-ai/claude-agent-sdk`, which build-desktop-sidecar.sh deliberately strips ("deferred to first launch"). But NO first-launch-install code exists — grep across apps/operator + src-tauri found only the preflight reader (meridian-state.json) + detectMeridianInstalled + a settings page that tells the user to "Start it with `meridian` in a terminal". So fully wiring meridian = build the deferred claude-sdk install + meridian-state machine + daemon spawn/lifecycle in main.rs. AND meridian only functions with Claude Max auth (it bridges the user's Claude Code session) — a fresh VM has none, so it is FUNCTIONALLY UNVERIFIABLE here. It's a Claude-Max convenience (omp/claude work on API keys without it).

ORCHESTRATOR (harness): genuinely not bundled — no @papercusp/orchestrator under sidecar/node_modules, no invoke-once bin on disk. orchestrator-runner.ts (DBOS) builds + spawns an invoke-once command (buildInvokeOnce from @/lib/harness-invoke-once); the in-process parts ride host.mjs but the spawned invoke-once needs the orchestrator package present. This IS a real, fixable packaging gap (bundle @papercusp/orchestrator + fix checkHarnessDir to verify the real artifact). Full end-to-end (a feature actually executing) needs agent auth (claude/omp creds) to verify, which the VM lacks.

Recommendation: bundle the orchestrator + fix the harness check (real fix, partially VM-verifiable); make meridian OPTIONAL in the preflight (unbuilt + VM-unverifiable + a Claude-Max convenience), and treat the full meridian first-launch-install+daemon flow as a separate dedicated feature. Awaiting user re-decision given the new scope.
Related: P-005
