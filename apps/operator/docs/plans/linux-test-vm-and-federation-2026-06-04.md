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

**State:** Design drafted from a codebase investigation — the existing two-instance
federation smokes (`papercusp-desktop/bin/two-instance-*-smoke.sh`), the federation
transport (gist control plane + Hyperswarm data plane), and the box's VM conventions
(`build-system/vms.md`). No code written yet. Two deliverables: (1) a disposable
Ubuntu 24.04 clean-room VM for fresh-install testing the real `.deb`, and (2) a
VM-backed driver for the existing federation smokes so the two peers run as
genuinely separate machines (closing the one-box NAT-hairpinning / "Mode B" gap).

**Next:** human reviews this plan and marks **P-001** done to unblock Phase 1.

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

- **P-001** `needs-human` Design sign-off before implementation — review this plan; approve scope (Phases 1 & 2, the deferred list, the networking approach); mark done to unblock the build. importance: high
- **P-002** `todo` cloud-init templates + `vmctl provision` → build golden Ubuntu 24.04 image (GNOME/Xorg + spice-vdagent + openssh; NO webkit/Node/build tools); snapshot golden.qcow2. blocked-by: P-001
- **P-003** `todo` `vmctl` lifecycle: `up`/`down` (idempotent nohup qemu), `reset` (overlay from golden), `ssh`, `status`. blocked-by: P-002
- **P-004** `todo` `vmctl install` (scp newest `.deb` + `apt install`) + `launch`/`gui` (SPICE). blocked-by: P-003
- **P-005** `todo` Fresh-install verification: assert dep resolution, embedded-PG boot, operator `:3070`, wizard render; capture install log + app log + screenshot. blocked-by: P-004
- **P-006** `todo` Add a "Linux test VM" row + runbook to `build-system/vms.md`. blocked-by: P-004

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
