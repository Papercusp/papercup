# Integrated Live Witness — A-002 + A-003 + D-001 on one fix-`.deb` (2026-06-19, su-9140a)

**What this is.** The wave-2 fixes (H/I/J/L) all landed on `staging` with deploy-gated
live witnesses. Rather than N redundant `.deb` builds, the monitor built ONE integrated
fix-`.deb` from current staging and ran the live content-matrix on the real packaged
binary. This is the durable record. (The original program's whole point: the 2-peer rigs
bypass `defaultResolveSwarmBinding`; only the real binary exercises the joiner-resolves-
own-topic path — so a live witness can surface what green rigs miss. It did — see A-003.)

## Build (no-cargo sidecar-swap, ~8 min)
`build-desktop-sidecar.sh` (fresh sidecar from staging) → swap into L's fix-`.deb`
(`/home/marsh-office/.cargo-target-L/.../Papercusp_0.0.2_amd64.deb`) → `dpkg-deb` repack.
Verified the integrated sidecar (`serve.mjs`) carries every fix:
`fed_hlc`×109 (J/D-001) · `joinerHiveHomeSlug`×4 + `hiveHomeSlug`×160 (I/A-003) ·
`federation-status`×3 (M/G-004) · `confirmInviteAnnounce`×2 (L/G-002) · luxon (A-001).
Artifact: `/tmp/integrated-witness/Papercusp_integrated.deb` (686M). 2 real peers
(A=papercupai owner, B=aviynw joiner), private testnet DHT, Xvfb :158, **no SKIP_INVITE**
(so the run also tests A-002's 2-pot case). mig-314 auto-applied on each boot.

## Content-matrix result

Pre-flight: both binaries booted (A-001 ✅) · negative-isolation **PASS** · topic-equal
**PASS** (`9d70c466…`). Owner published a PUBLIC pot (`hello-world-pot`) **and** a
separate INVITE pot (`spoon-knife-pot`) — the 2-pot A-002 scenario.

| Type | backfill | incr A→B | incr B→A |
|---|---|---|---|
| features / conversations / messages / threads / thread-posts / plans / plan-parts / item-assignments | ✅ remote | ✅ remote | ✅ remote |
| presence | ➖ outbox=0 | ➖ outbox=0 | ➖ outbox=0 |
| pot-settings | ❌ outbox=5 | ❌ outbox=6 | ❌ outbox=1 |
| pot-members | ❌ outbox=1 | ❌ outbox=1 | ❌ outbox=1 |

## Verdicts per fix

- **A-002 (multi-pot) — ✅ holds (content level).** With BOTH pots present, the 1st
  pot federated **8/8 types fully bidirectionally** (backfill + incr A→B + incr B→A).
  Pre-fix, a 2nd pot stalled the 1st's federation entirely → H's announce-channel fix
  (muxer×topic) works. REMAINING: dc9db witnesses the 2nd (invite) pot's OWN content
  crossing on the up pair (the matrix only drove the 1st pot's member).

- **A-003 (member/settings → joiner) — ⚠️ INCONCLUSIVE on this witness (NOT a clean fail).**
  `hive_members`/`hive_settings` did not cross in any phase. BUT the `.deb` carries I's fix,
  and the root-cause evidence shows the test didn't exercise it: on B, `hive_members`=0 rows
  and `hive_settings`=0 rows (zero, incl. local), and B's log has **zero** rekey /
  `bootSingleHarness` / `stepBootFederate` / `joinerHiveHomeSlug` lines on join. The
  content-matrix's **synthetic `POST /api/discovery/join-pot`** doesn't set B up as a
  `remote_hive`-view member, so I's fix condition ("joiner's member with a remote_hive view")
  never matches. The 8/11 content types DID federate (substrate booted fine) — only the
  pot-home-scoped projection didn't wire. **DEFINITIVE TEST = the FROM-REPO join**
  (`two-instance-pot-from-repo-smoke.sh`, which does `POST /api/harness/pots/from-repo`
  first) — owned by K (K-2 leg) on the integrated `.deb`, display :175. That result is I's
  verdict signal: crosses → I's fix works (rig+live), the content-matrix just can't exercise
  it; still fails → genuine A-003 gap → back to d2230.

- **D-001 (convergence) — ✅ in-core, live binary carries it.** `fed_hlc`×109 in the
  shipped sidecar; mig-314 auto-applies on boot; federation healthy under the new guard.
  The live **clock-skew convergence** leg is J's separate test on the up pair (skew the two
  PG clocks, write conflicting LWW, assert both converge). In-core already proven:
  convergence-fuzz converges, federated-column-completeness 14/14, backbone 901 pass.

- **B→A baseline — ✅ healthy (8/8).** Clears K's earlier `:154` B→A anomaly as
  **revoke-induced**, not a baseline bug (no revoke ops in this run → B→A fully green).

## Open live legs (on the up pair / fresh displays)
- **dc9db** — A-002 2nd-pot content crossing (:158 pair).
- **K** — from-repo A-003 + K-2 revocation witness (:175, integrated `.deb`).
- **J** — D-001 live clock-skew convergence (up pair).
- **M** — ✅ DONE: G-004 live-proven on the integrated `.deb` (reach=1 == B).

## Bottom line
Baseline federation + A-002 + D-001-in-binary + B→A are **live-GREEN on the real packaged
binary**. A-003's verdict hinges on the from-repo witness (K). The engineering bar is one
from-repo run + J's skew leg from being fully substantiated; then only the **C-001 product
decision** remains (owner's call). Pair ports: `/tmp/integrated-witness/matrix/instances.env`.
