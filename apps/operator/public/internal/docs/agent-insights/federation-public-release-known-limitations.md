# Federation public-release: known limitations + release-criteria gate
URL: /internal/docs/agent-insights/federation-public-release-known-limitations

The honest release calibration for cross-machine p2p shared-hive federation — what is proven LIVE vs proven IN-PROCESS ONLY, the standing known limitations (multi-device identity, coord control-plane local-only, revocation read-cut, LWW divergence, NAT, bg-host leak, 2-server cap), the forceReFold mechanism + its cost, and the explicit public-release checklist (which hardening briefs must be green to ship).

This is the **honest release calibration** for cross-machine peer-to-peer
shared-hive federation: what is proven **live** (over real, separate machines on
the public DHT), what is proven **in-process only**, the standing **known
limitations**, the **`forceReFold` mechanism + its cost**, and the explicit
**public-release checklist** — which of the federation-release-hardening briefs
must be green before we can call federation shippable.

It deliberately supersedes the optimistic "FULLY WORKING + RELEASE-READY" claim
(memory `a02714f1`) with the calibrated view (memory `f64a176d`, the calibration
correction — **read that one**). The core path is real and reproducible; it is
**not yet at a defensible public-release bar**. Read this before telling anyone
federation is done.

> **The one rule this page exists to enforce: in-process green ≠ live green.**
> The A→B owner-admit race passed *every* in-process test and still failed live.
> So an in-process-green scenario is *necessary but not sufficient* evidence —
> every release-gating scenario must be **reproduced over real VMs**, not just
> asserted in the in-process matrix.

***

## Status snapshot

| Capability                                                                                          | Status                                                               | Evidence                                                                                                                                                                                                                                                                                                                                            |
| --------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Base federation (content/features + per-part plans + coord **data**), A→B **and** B→A               | ✅ **Proven LIVE** — with a no-restart caveat (↓ open blocker #9)     | 3 consecutive green runs (run33/34/35), 2 Hetzner cpx31 VMs, prod config, real public DHT; controlled before/after (run32 no-fix FAIL → run33 fix PASS). ⚠ A later live run (Brief 6 attempt-1) surfaced owner→joiner roster-EMPTY in the **pure no-restart** join path — the earlier green runs may have included a restart/rekey. See blocker #9. |
| `forceReFold` A→B owner-admit race fix                                                              | ✅ In + adversarially reviewed **SAFE-TO-SHIP**                       | `boot.ts`; repro test `owner-roster-rebind-race.repro`; review record memory `4d1db206`                                                                                                                                                                                                                                                             |
| Extended matrix: revocation/K-cut, multi-member, reconnect, restart, concurrent/LWW, security-drops | 🟡 **Proven IN-PROCESS only**                                        | 28-test in-process matrix green — but in-process ≠ live (see the rule above)                                                                                                                                                                                                                                                                        |
| Coordination **control plane** cross-machine (wake / push / presence)                               | 🔴 **Local-only by architecture**                                    | Brief 7 finding — data federates, real-time wakes do not                                                                                                                                                                                                                                                                                            |
| True 3-machine multi-member fanout, **live**                                                        | ⛔ **Not coverable** under the current 2-server quota                 | Brief 2 — permanent cap; 2-VM proxy + in-process only until quota lifts                                                                                                                                                                                                                                                                             |
| NAT / firewall / cross-region diversity                                                             | 🟡 **Partially exercised**                                           | Base proven on easy public-IP same-region topology only (Brief 8 in progress)                                                                                                                                                                                                                                                                       |
| Long-running node stability (bg-host listener/handle leak)                                          | 🔴 **Open**                                                          | WI-1088/1089 (Brief 10) — degrades multi-day federated nodes                                                                                                                                                                                                                                                                                        |
| LWW convergence under clock skew                                                                    | 🔴 **Known S0**                                                      | HLC-fold vs fed\_ts-guard divergence (Brief D finding)                                                                                                                                                                                                                                                                                              |
| Revocation **read** cut-off                                                                         | 🟡 **Re-key K-cut now default-ON; cross-machine LIVE proof pending** | Read-cut rides the epoch re-key (`papercusp-hive-rekey`, now default-ON, no longer dark); a removed member keeps reading only until that re-key or a dissolve (C-001). LIVE K-cut proof = Brief 3; in-process only today                                                                                                                            |

***

## What is proven LIVE (the core path)

Over **2 separate Hetzner cpx31 VMs**, production config (trace flags OFF), real
public DHT, three consecutive green runs (run33/34/35):

* **Content** — features (`origin=remote` both ways), per-part plans (P-001 both
  ways), and **coord data** (threads/posts/events) all federate **A→B and B→A**.
* It is a **controlled** result: run32 (production, *no* fix) A→B = FAIL; run33
  (production, *with* fix) A→B = PASS — the only difference was the fix.
* The working stack: `connection.ts` PG-port crash fix + boot-enum (D-040/D-057)
  * D-007 link-seed + reader-merge + join-hive rekey (the rig joins via
    `POST /api/discovery/join-hive`, **not** `/api/harness/join-link`) +
    recv-during-rekey owner-admit + the `forceReFold` re-fold.

This is the strongest evidence we have, and it is genuine. But it is a **thin
sample**: N≈3 runs, a **single easy topology** (public-IP VMs, same region, a
single joiner), no NAT/firewall/geo diversity, and the extended scenarios below
were *not* exercised in these runs.

## What is proven IN-PROCESS only

The full extended matrix is green **in-process** (single box, in-process swarm,
two separate Postgres DBs):

`federation-{content,comms,issues-assignments}-matrix`,
`federation-multimember-sidecar`, `federation-security-drops-sidecar`,
`federation-revocation-kcut-sidecar`, `federation-reconnect-catchup-sidecar`,
`federation-restart-durability-sidecar`, `federation-concurrent-writes-sidecar`
(28 tests under `packages/operator-core/lib/sync/hyperbee/__tests__/`).

These are real, teeth-proven tests — but **the whole point of the live-hardening
effort is that the A→B race passed all of them and still failed live.** Treat
in-process green as a *prerequisite*, never as the live proof. Each of these
scenarios needs a live VM reproduction before it gates a release claim (Briefs
2–7, consolidated into the live-matrix runner, Brief 13).

***

## The `forceReFold` mechanism + its cost

`forceReFold` is the deterministic fix for the live A→B owner-admit timing race.

**Root cause.** The joiner (B) bootstrap-admits the owner's (A's) log during the
`home=<none>` boot window. It folds A's `hive_members` op through the
**member-slug-bound** projection, so A's roster row is **dropped** at
`projections/hive-members.ts` (`row.hive_home_slug !== member slug`) and the merge
cursor marks the op done. When the rekey rebinds the projections to the
**hive-home** slug, `retryPendingOnce` only re-*admits* still-pending peers — it
does **not** re-apply an already-admitted-and-folded op. Result: empty roster →
A's content defers forever.

**The fix** (`packages/operator-core/lib/sync/hyperbee/boot.ts`):

1. A one-shot `let forceReFold = false` flag.
2. Set `forceReFold = true` in `rekey()`'s rebind block, *after* the
   `hive_members`/`hive_settings` projections rebind from the member slug to the
   hive-home slug.
3. Consumed at the top of the merge pass, under the merge gate: it resets the
   merge cursor (`mergeCursor = createMergeCursor()`) and clears the flag, so the
   next pass **re-folds every admitted log** through the now-hive-home-bound
   projection — A's roster row re-applies and the deferred content drains.
4. Driven by a terminal `mergeNow()` at the end of `rekey()` (this is what makes
   it deterministic, rather than depending on the 5s periodic tick — the latency
   that `PAPERCUSP_A003_TRACE`'s stderr delay accidentally flipped green in run31
   vs the red run32).

Regression test:
`packages/operator-core/lib/sync/hyperbee/__tests__/owner-roster-rebind-race.repro.integration.test.ts`
(deterministic, RED-without / GREEN-with). Adversarial review verdict:
**SAFE TO SHIP** — no CRITICAL/HIGH, race-freedom sound (the terminal
`mergeNow()` always delivers the re-fold with the new binding), projections are
LWW-guarded, revocation ordering correct, `pendingMemberContent` drain fires once
(review record: memory `4d1db206`).

### The cost (and the one open follow-up)

`forceReFold` re-folds **all admitted logs** on **each home-resolving rekey
rebind**. It is **one-shot** — the flag is cleared immediately under the merge
gate, so steady-state passes are unaffected — but the re-fold itself is
`O(total ops across all admitted logs)`. At scale (many members, large logs,
repeated rekeys) this is the thing to watch for a perf cliff; Brief 9 is
characterizing it (in-process, since live many-member is blocked by the quota
cap). No cliff/leak has been attributed to it yet.

> **Snapshot interaction — the gating follow-up (Brief 11).** The `forceReFold`
> cursor reset is placed *before* `seedCursorFromSnapshots`. With
> `FLAGS.SUBSTRATE_LOG_SNAPSHOT` ON, the re-fold must still re-apply the dropped
> `hive_members` op (a snapshot op summarizes all current rows, so it should).
> An integration test covering `forceReFold` reset → `seedCursorFromSnapshots`
> with the snapshot flag ON **must land before the log-compaction/snapshot flag
> ships.** This is the only open review item.

***

## Known limitations (standing, document-honestly)

### 1. Coordination control plane is LOCAL-ONLY by architecture

Coord **data** federates (threads, posts, events — proven live). The coord
**control plane does not**: `coord:send { wake:'required' }`, `events:emit` →
`events:await`, and inbox push all resolve the recipient's **local** session.
A wake fired on machine A does **not** wake a live agent on machine B. This is a
real v1 limitation, not a bug to fix before ship — multi-machine fleets cannot
yet *coordinate in real time* across machines, only exchange data. (Brief 7.)

### 2. Multi-device, same identity

Federation identity is **per-device keypair**, not per-GitHub-account. The
substrate is "Model B" — per-device single-writer logs + read-merge
(`sync/hyperbee/peer-log.ts`), *not* Autobase — so sharing one hive keypair
across a user's devices is *safe* (no writer conflict), but **discovery and merge
are separate gates**: the shared keypair grants topic discovery, while the actual
merge is gated by membership (`classifySameHiveMember` admits a remote log only
if its `device_pubkey` is in `hive_members`). So one human on two devices = two
distinct device pubkeys, each needing its own membership admission.

The dogfood per-owner hive solves the same-owner case (Solution C,
`harness/papercusp-hive-share.ts`: a per-owner private identity gist + an
owner-signed allowlist policy auto-admits the owner's login), but the
**two-device data-merge has only been single-box-smoke-verified, never witnessed
live with a real second device.** The stricter "private key never leaves the
creating device" remote-JOIN variant (share only the pubkey) is deliberately not
built. The historical phase1b multi-device collision (contributor-file login-key
overwrite) is *obsolete* — admission is now keyed by the stable numeric
`github_user_id` + a device-signed announce/attestation
([phase1b-federation-limitations](/internal/docs/agent-insights/phase1b-federation-limitations)).

### 3. Revocation is WRITE + DISCOVERY-plane only (hard read cut-off rides the re-key)

A revoked/banned member stops being *aggregated* and stops *discovering* new
content, but `swarm.ts`'s `store.replicate(socket)` serves cores to any topic
peer, so a removed member (or anyone who got the link while the hive was public)
keeps **reading** future content until the hive **re-keys** (C-001) or is
**dissolved**. The in-place re-key epoch **K-cut** that closes the read plane is
now **enabled by default in production** (`papercusp-hive-rekey` — no longer dark;
built in `hive-epoch-boot-deps.ts` / `buildHiveRekeyBootDeps`, consumed on the
in-place `rekey()` rebind, never a reboot). But its **cross-machine LIVE proof is
still pending (Brief 3)** — today only the in-process
`federation-revocation-kcut-sidecar` + `hive-late-join-epoch-decrypt-federation`
tests cover the K-cut. This is a conscious product decision, not a silent hole.
([substrate-revocation-model](/internal/docs/agent-insights/substrate-revocation-model).)

### 4. LWW convergence can diverge under clock skew (S0)

Federated LWW can silently diverge: the merge winners-fold orders by **HLC**
while every mutable projection's PG guard orders by **fed\_ts** (wall clock). A
single forward clock excursion anywhere can raise the global HLC floor and
decouple the two orderings, so two honest peers materialize different rows for
the same key. A complete fix is one ordering key of record end-to-end (carry the
HLC column to the PG guard) — cross-cutting, needs a migration. ([hlc-merge-vs-fed-ts-guard-divergence](/internal/docs/agent-insights/hlc-merge-vs-fed-ts-guard-divergence).)

### 5. NAT / firewall / geo assumptions

The live proof uses the **easy** topology: public-IP VMs, same region, trivial
holepunch, a single joiner. Real users are behind NAT/firewalls and across
regions. Cross-region + true-NAT holepunch are only *partially* exercised
(Brief 8 in progress). Earlier rig work also proved that two VMs sharing one
NAT egress IP **hairpin** and fail a public-DHT holepunch — a class of failure
the easy topology never surfaces.

### 6. Long-running node stability (bg-host listener leak)

25+ substrate boots add `swarm.on('connection')` to the **shared** swarm without
removal → `MaxListenersExceeded` → a listener/handle/heap leak that degrades a
node running for days. WI-1088/1089 (Brief 10) — a real release risk for any
long-lived federated node; needs the listener-lifecycle fix + a heap/handle
regression guard landed.

### 7. Data-completeness is table-grain-guarded, column-grain is the residual risk

18 federated tables (`harness-state/table-registry.ts`) are structurally guarded
at table grain (every peer-log table has a producer + a projection, two green CI
tests). **Column-grain drift** is the residual class: value-mappers hand-pick
columns, so a federated-table column added without updating its mapper silently
drops on peers. A new guard (`federated-column-completeness.integration.test.ts`)
closes the general case; a live candidate gap remains
(`harness_features_consolidated` drops `design_spec_id`/`source_plan_slug`/etc.).
`trusted_authors` is local-only **by design** (federating the auto-run grant
would be a security regression).

### 8. The 2-server quota cap → no true 3-machine multi-member LIVE

The Hetzner quota is \~2 concurrent servers (treat as **permanent** for now).
True 3-machine member↔member fanout (owner + 2 members, Brief 2) is therefore
**not live-coverable**; it is proven only via a 2-VM proxy + the in-process
matrix. Document multi-member fanout as **gated on a >2-server quota**, not as
live-proven.

### 9. Owner→joiner federation can stay broken in the pure NO-RESTART join path (suspected live blocker, under confirmation)

A live run (Brief 6 attempt-1, su-e7698: 2-frame, shared forceReFold `.deb`, real
DHT) surfaced **owner(a)→joiner(b) content federation FAILING** in the plain
join→write path with **no restart**: b's `hive_members` roster stayed EMPTY for
270s+, so `decideMemberContentOp` dropped every owner op (b→a was fine). Code
root-cause (su-0f0a4): `forceReFold` (`boot.ts`) fires **exactly once**, on the
`rekey()`→hive-home rebind, then resets. If the owner's `hive_members` op arrives
at the joiner **after** that single re-fold (during drain), it is never
re-applied — it stays dropped-in-the-home-window until a **restart or a later
rekey**. This is consistent with Brief 5 (restart) PASSING (the restart re-folds)
and means the earlier "proven live" runs (run33/34/35) may have included a
restart/rekey rather than exercising the pure no-restart path.

**Root cause (confirmed, su-2c799):** cross-process `opStateCache` staleness under
`SUBSTRATE_SIDECAR`. `join-hive.ts` (MAIN process) commits the registry
(`remote_hive:true` + `hive_slug`) and invalidates its OWN cache; but `rekey()`
runs in the substrate SIDECAR process, whose warm `harness_registry` cache (2s
TTL, kept hot by the sidecar's constant reads) never saw that invalidation → it
serves the STALE pre-join value → `joinerHiveHomeSlug` returns null →
`resolveHiveHomeProjectionSlug` returns null → `next===prev(null)` → the rekey
rebind block (boot.ts \~2599) SKIPS → `forceReFold` never fires → the
member-slug projection binding latches → the owner's `hive_members` rows drop
forever → roster EMPTY. A restart cold-reads fresh at boot → binds correctly
(why Brief 5 restart PASSED). Neither original candidate — it was a third
mechanism (stale cross-process cache read at the resolve, not a
re-fold-coverage or rebind-timing bug).

**Status: FIX LANDED (su-2c799, WI-1378).** `resolveHiveHomeProjectionSlug` now
calls `joinerHiveHomeSlug(ws, slug, { fresh: true })`, threaded through
`loadHarnessRegistry({fresh})` → `readOperatorState({fresh})` to BYPASS the 2s
cache on this one rare resolve path (hot-path callers keep the cache, so the
seqscan perf win is preserved). A fresh PG read is guaranteed to see the
committed write (join-hive awaits the `mutateRegistry` commit before the rekey
RPC). **Still pending before the min bar is truly green:** (a) an in-process
regression test (WI-1383, su-c25e5 — seed a stale cache + out-of-band registry
write → assert the fresh resolve sees it), and (b) a LIVE owner→joiner
no-restart re-verify (e7698, Brief 6). Until (b) passes live, the base-row
"proven live" stays caveated.

***

## Public-release checklist

**Minimum bar to call cross-machine federation "public-release-ready":**

| Brief  | Gate                                                     | Current status                                                                                                                                                                 |
| ------ | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **1**  | Rig foundation (reusable lib, 3-frame, scenario drivers) | ✅ DONE + live-validated (run35)                                                                                                                                                |
| **2**  | LIVE multi-member (3+) fanout                            | ⛔ Not live-coverable under the 2-server cap → 2-VM proxy + in-process; **re-scope** to "gated on >2 servers"                                                                   |
| **3**  | LIVE revocation + epoch K-cut                            | 🟡 Driven live by su-ec09e (`deb-hetzner-revocation.sh` + `rig_ban_member`); live run queued behind the quota mutex — **gated on the WI-1378 no-restart fix** (see blocker #9) |
| **5**  | LIVE restart durability                                  | ✅ **DONE** — LIVE PASS over 2 Hetzner VMs (su-8f1ad, WI-1331): member + owner cold-restart both prove no content/roster loss, exactly-1-row, no re-emit; exit 0, servers=0     |
| **6**  | LIVE concurrent writes / LWW convergence                 | 🟡 In progress — attempt-1 (su-e7698) **surfaced blocker #9** (no-restart owner→joiner roster-empty); re-run with a roster-populated gate, **gated on WI-1378**                |
| **7**  | LIVE coordination control-plane                          | 🟡 In progress (su-358bc) — **finding: control plane is local-only by architecture** (limitation #1)                                                                           |
| **11** | `forceReFold` release-grade + CI                         | ✅ **DONE** — `peer_cap_near` in `BootHistoryKind` + CI-wiring + commit + the snapshot+re-fold integration test all landed (su-43e13, WI-1337)                                  |

**Strongly recommended (durability):** Brief **4** (LIVE reconnect/catch-up),
Brief **8** (NAT/geo), Brief **9** (scale + `forceReFold` cost), Brief **10**
(bg-host leak fix + guard).

**For repeatability:** Brief **13** (one-command live-matrix runner over the
2-server cap) and Brief **12** (this doc).

> **Honest read of the minimum bar:** with the 2-server cap permanent, the
> Brief-2 "multi-member fanout proven LIVE" gate cannot be met as originally
> written. Ship-readiness must either (a) accept multi-member proven via 2-VM
> proxy + in-process and explicitly document the >2-server gap as a known
> limitation, or (b) obtain a quota bump first. Do not silently treat the 2-VM
> proxy as equivalent to true 3-machine live coverage.

**Also gating, outside the federation product code:** Brief **14** — operator-core
`lint:tsc` — ✅ **DONE** (su-337c2, committed `f42d55681`): the gate is GREEN again
(310→244 errors, all type-only test-typing fixes, ratcheted, `npm run lint:tsc`
exits 0). CI is no longer red on this.

> **⚠ Current release-critical blocker (as of this update):** the **no-restart
> owner→joiner roster gap (blocker #9 above)** gates the remaining live min-bar
> briefs (2, 3, 6, 7) — running them before the fix lands just reproduces the
> empty-roster failure. Fix owned by su-2c799 under **WI-1378**; e7698 is
> live-confirming. The min bar cannot go green until WI-1378 lands + a live
> owner→joiner run passes in the pure no-restart path.

***

## References

* Memories: `a02714f1` (the original "release-ready" decision — *overstated*),
  `f64a176d` (the calibration correction — the honest gaps list), `4d1db206`
  (the `forceReFold` adversarial review record).
* [shared-hive-federation-diagnosis-toolkit](/internal/docs/agent-insights/shared-hive-federation-diagnosis-toolkit) — the "rosters but no content" runbook.
* [live-2machine-kcut-witness-and-federation-gaps](/internal/docs/agent-insights/live-2machine-kcut-witness-and-federation-gaps) — the live re-key K-CUT witness recipe.
* [hive-rekey-flip-readiness](/internal/docs/agent-insights/hive-rekey-flip-readiness) — the `papercusp-hive-rekey` flip gate.
* [federation-rig-restart-runbook](/internal/docs/agent-insights/federation-rig-restart-runbook) — recovering the live VM rig.
* The live rig: `papercusp-desktop/bin/lib/deb-hetzner-rig.sh` (reusable, N-frame) + `papercusp-desktop/bin/lib/federation-asserts.sh` (assertions, incl. negative asserts).
