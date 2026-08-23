# Federation public-release: known limitations + release-criteria gate
URL: /internal/docs/agent-insights/federation-public-release-known-limitations

The honest release calibration for cross-machine p2p shared-pot federation — what is proven LIVE vs proven IN-PROCESS ONLY, the standing known limitations (multi-device identity, coord control-plane local-only, revocation read-cut, LWW divergence, NAT, bg-host leak, 2-server cap), the forceReFold mechanism + its cost, and the explicit public-release checklist (which hardening briefs must be green to ship).

This is the **honest release calibration** for cross-machine peer-to-peer
shared-pot federation: what is proven **live** (over real, separate machines on
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

| Capability                                                                                          | Status                                                          | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| --------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Base federation (content/features + per-part plans + coord **data**), A→B **and** B→A               | ✅ **Proven LIVE — no-restart blocker RESOLVED**                 | run33/34/35 + Briefs 4/3/7 (2026-07-01/02). The no-restart roster-empty class (blocker #9 / WI-1378) is fixed by THREE stacked fixes: the fresh home-resolve (3030bfd13), the directory self-echo guard (WI-1422), and the **deterministic join-time owner-device binding** (verified coords extracted from the member links + stamped on the registry view — no directory-timing dependence; Brief 7's baseline federated FIRST-poll). Fresh-join first-poll latency can still occur; the adaptive re-fold restart in the rig scenarios covers it.                                                                                                                                                                                                                                                                                                                      |
| `forceReFold` A→B owner-admit race fix                                                              | ✅ In + adversarially reviewed **SAFE-TO-SHIP**                  | `boot.ts`; repro test `owner-roster-rebind-race.repro`; review record memory `4d1db206`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Extended matrix: revocation/K-cut, multi-member, reconnect, restart, concurrent/LWW, security-drops | ✅ **Live-proven per-scenario** (multi-member per D-006)         | In-process 28-test matrix green AND live: restart (Brief 5), concurrent/LWW (Brief 6), reconnect/catch-up (Brief 4), revocation/K-cut (Brief 3), coord boundary (Brief 7). Multi-member 3+: in-process + 2-node live per owner decision D-006. One-command live runner: `bin/deb-hetzner-matrix.sh` — **8/8 green 2026-07-02, run m1783013203** (2-node containerized rig: separate frames + PGs + substrate processes over a dedicated DHT bootstrap; Hetzner creates are owner-walled since 2026-07-02, so this rerun is container-grade, not VM-grade — the earlier per-brief Hetzner runs remain the VM-grade proof)                                                                                                                                                                                                                                                 |
| Coordination **control plane** cross-machine (wake / push / presence)                               | ✅ **Boundary LIVE-PROVEN (Brief 7 matrix, 2026-07-02)**         | Harness-scoped coord messages + escalations FEDERATE; raw presence/watermarks/await-subscriptions stay LOCAL by design (cross-machine visibility rides `shared_presence`). The "handoffs don't federate" gap (WI-1510) is **CLOSED — by design, not a wire bug**: handoffs DO federate but the receiver-side P-013 comms-tier gate quarantines any handoff whose author is below `steer` (`coord_quarantine`, reason `handoff-below-steer`; no owner special-case — steer is a local per-user grant that never federates). Live-proven both legs 2026-07-02 (m1783013203): ungranted → quarantined; steer-granted → applies                                                                                                                                                                                                                                              |
| True 3-machine multi-member fanout, **live**                                                        | ⛔ **Not coverable** under the current 2-server quota            | Brief 2 — permanent cap; 2-VM proxy + in-process only until quota lifts                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| NAT / firewall / cross-region diversity                                                             | ✅ **LIVE-PROVEN (Brief 8, 2026-07-02) — with one filed caveat** | 2-frame ash↔hil, stateful restricted-cone NAT on the member frame, public DHT: holepunch PASS both ways, member→owner content PASS, owner→member content converges **late-not-never** — ops appended during the joiner's owner-binding-null window stall until the next owner-side append kicks a full backlog fold (WI-1534). Symmetric-NAT rung out of scope (needs a real symmetric-NAT middlebox)                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Long-running node stability (bg-host listener/handle leak)                                          | ✅ **RESOLVED + live-re-verified (2026-07-02)**                  | The re-observed 30GB climb (WI-1417) was the claude-sessions fs-sweep, not the swarm listeners: negative-resolution + roots TTL caches in `claude-sessions.ts` landed and were re-verified live 2026-07-02 — bg-host holds a healthy 5.7–5.8GB sawtooth plateau over a multi-hour soak (RSS *decreased* across a 12-min recheck), no reaper false-reap storm; 3 recurrence-guard tests (`claude-sessions-cache.test.ts`). WI-1089 + WI-1415 + WI-1416 also resolved                                                                                                                                                                                                                                                                                                                                                                                                      |
| LWW convergence under clock skew                                                                    | ✅ **All known ordering + PRESENCE gaps FIXED (2026-07-09)**     | (1) capture-boundary two-clock bug → **mig 446**; (2) HLC-fold vs fed\_ts-guard order split → **mig 458** (`fed_order_key` across all 20 mutable projection writers, EI-1698); (3) exact `(ms,count)` fed\_hlc TIES swap winners under counter-lockstep (WI-1672) → **mig 459** node-id total order (3-segment HLC) + locks-core `hlc.ts`; (4) one absurd-future stamp pins every recv-ratcheted clock forever (the WI-1672 amplifier) → **mig 460** + `HlcClock.maxDriftMs` ε recv clamp (600s = 2× the D-007 announce window); (5) local-del resurrection under skipOwnOps (WI-1684, row-PRESENCE split-brain) → `skipOwnOps` narrowed to PUTS ONLY in `projection.ts`'s `applyOpVia`, see § 4a. Evidence: production-topology convergence-fuzz sweep (TEETH + 120-seed FIXED, monotone AND skew, WI-1684 presence sweep) + forced-tie two-device PG integration test. |
| Revocation **read** cut-off                                                                         | ✅ **LIVE-PROVEN (Brief 3, 2026-07-02)**                         | Post-ban owner content never reached the banned member over real VMs (\~90s negative assert); pre-ban content stayed readable (epoch-0 semantics, matches the in-process repro). WI-1329                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |

***

## What is proven LIVE (the core path)

Over **2 separate Hetzner cpx31 VMs**, production config (trace flags OFF), real
public DHT, three consecutive green runs (run33/34/35):

* **Content** — features (`origin=remote` both ways), per-part plans (P-001 both
  ways), and **coord data** (threads/posts/events) all federate **A→B and B→A**.
* It is a **controlled** result: run32 (production, *no* fix) A→B = FAIL; run33
  (production, *with* fix) A→B = PASS — the only difference was the fix.
* The working stack: `connection.ts` PG-port crash fix + boot-enum (D-040/D-057)
  * D-007 link-seed + reader-merge + join-pot rekey (the rig joins via
    `POST /api/discovery/join-pot`, **not** `/api/harness/join-link`) +
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
`projections/pot-members.ts` (`row.hive_home_slug !== member slug`) and the merge
cursor marks the op done. When the rekey rebinds the projections to the
**pot-home** slug, `retryPendingOnce` only re-*admits* still-pending peers — it
does **not** re-apply an already-admitted-and-folded op. Result: empty roster →
A's content defers forever.

**The fix** (`packages/operator-core/lib/sync/hyperbee/boot.ts`):

1. A one-shot `let forceReFold = false` flag.
2. Set `forceReFold = true` in `rekey()`'s rebind block, *after* the
   `hive_members`/`hive_settings` projections rebind from the member slug to the
   pot-home slug.
3. Consumed at the top of the merge pass, under the merge gate: it resets the
   merge cursor (`mergeCursor = createMergeCursor()`) and clears the flag, so the
   next pass **re-folds every admitted log** through the now-pot-home-bound
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

### 0. LIVE STATUS (rewritten 2026-07-16, su-4d3eb — supersedes the 2026-07-10 "EI-8895 ACTIVE" framing)

The 2026-07-10 version of this section carried two claims that were DISPROVEN
the same day, and two new events have happened since — treat THIS as the
current status row (successor execution structure: the owner's 2026-07-16
3-lane split — git → `p2p-git-live-activation-2026-07-09`, coordination →
su-18f2f, everything else → `p2p-public-release-remaining-lanes-2026-07-16`):

* **EI-8895 ("admit-after-connect never attaches") — CLOSED resolved-no-fix-needed
  (2026-07-10 \~20:00 EDT).** Two independent re-runs of
  `wi183-attach-on-late-admit.integration.test.ts` came back GREEN — the
  attach seam already works, and the WI-3684 repair-on-detect auto-heal was
  already shipped. The 07-10 freeze's REAL root cause was a live
  admission/drain problem: **WI-3891** (VM hive/pot registry backfill —
  pre-backfill sends were refused `harness_not_federated`) + the WI-3896/
  WI-3937 drain fixes. **GATE CLEARED 2026-07-10 22:53 EDT** (two paired
  VM-authored `origin=remote` rows, 5-way corroborated — see
  RELEASE-READINESS.md).
* **WI-4070 (tower↔VM federation dead again since \~2026-07-13) — ACTIVE,
  root-caused, fix in flight (git lane su-71c69).** A NEW wedge, distinct from
  the 07-10 one: the VM operator ran a **stale Jul-9 dev-source tree**
  (post-mig-557 DB vs pre-557 code); VM rebooted with the fix 2026-07-16.
  Tower-side reads during the wedge: `origin=remote` newest 2026-07-13 09:14
  EDT; the 4 VM-side merge cursors frozen 2026-07-15 15:48; tower's own log
  advancing normally throughout.
* **Retired-route class in the live gate + smokes — FIXED 2026-07-16.** The
  mig-557 lexicon sweep renamed `GET /api/discovery/hives` →
  `/api/discovery/pots` (and `join-hive` → `join-pot`), but the two-instance
  smokes + `federation-asserts.sh` still curled the retired route → 404
  `{"error":"not_found"}` → the whole discovery leg (and the hourly
  live-federation gate's content-matrix run) red-failed with a misleading
  "announce never crossed" signature. Fixed across the smoke family
  (`fed_hive_dir_row`, from-repo/directory/content-matrix smokes, rows key
  `hiveId`→`potId`) and guarded in `federation-asserts.selftest.sh` so the
  class self-announces.
* **GO/NO-GO gate 1b (WI-2009 + WI-2102) — BOTH halves now independently
  verified (2026-07-16).** The ledger's "WI-2009 half not independently
  re-verified" flag is cleared: the leg-3 backlog-stall detector + poll
  re-attempt + epoch-gate defer semantics re-verified at HEAD
  (`outbox-drain-stall.test.ts` 14/14 + drain family 29/29).
* **WI-3646 (hive\_slug federation regression) — FIXED + live-rig verified 2026-07-09/10.**
  `pot:create` (then named `hive:create`) from an existing harness never wrote `hive_slug` onto the
  owner's source-harness registry row, so `potHomeSlugForHarness` /
  `resolveHiveSwarmBinding` returned null and the harness never swarm-bound —
  silent zero federation of the owner's own content. Root cause was three
  stacked instances of the same "missing-slug field silently dropped" bug
  class (`packages/operator-core/lib/agent-tools/pot/_create.ts`,
  `_create_from_repo.ts`, `harness/create.ts`). Fixed + regression-tested (53 +
  98 + 3 tests) and live-rig re-verified (content/plan/coord/concurrent-LWW/
  coord-controlplane scenarios all converge end-to-end).
* **WI-3869 (`coord_event_log` unbounded surface scan) — FIXED 2026-07-10.** A
  per-surface read with no `LIMIT`/cursor full-scanned the entire event log on
  every call, degrading `coord:presence`/`fleet:status`/`coord:orient` as the
  log grows (one query observed running 130s, causing 55s presence timeouts
  and a live fleet rendering as empty/"looks paused" in the UI even though
  members were alive). Fixed in
  `packages/operator-core/lib/agent-tools/coordination/feed.ts` with a bounded
  `LIMIT` + id-cursor window; regression-pinned in `feed.test.ts` (18/18,
  asserts every raw per-surface read carries a bounded numeric limit).

Both WI-3646 and WI-3869 tests are wired into the affected-test gate via the
existing `hive/**/*.test.ts`, `harness/**/*.test.ts`, and
`coordination/**/*.test.ts` domain globs in
`packages/operator-core/lib/testing-domains-registry.ts` — no additional
registration was needed.

### 1. Coordination control plane — BRIDGED for pot-scoped sends (updated 2026-07-01)

The original Brief-7 finding ("a wake fired on A does not wake a live agent on
B") is **no longer the architecture** — it was the send-side gates, and
`cross-machine-coord-parity-and-trust-2026-07-01` closed them (Phases 0–2):
pot-scoped `coord:send` federates with the persisted wake intent and the
receiving projection fires the wake fan on arrival (EI-279 + P-001 scope
stamping); wake-on-reply bridges back (P-002); `events:emit {scope:'pot'}`
re-fires keys into every machine's await store (P-009); directed required-wakes
get delivery receipts (`coord:receipt:<msg_id>`, P-008); remote agents are
addressable via the federated session roster (P-005/P-007). Residual caveats:
UN-scoped (operator-local) sends still never leave the machine — the send
result's `federated:` field is the truth; cross-machine wakes are budget-capped
per author device (P-003); presence still rides the log until the
`papercusp-presence-gossip` cutover flag flips; and the whole bridge's LIVE
2-machine proof is still owed (the in-process suites are green — in-process ≠
live, this page's own rule).

**Handoffs are trust-gated, not broken (WI-1510 disposition, 2026-07-02).** The
handoffs surface federates on the wire like messages/escalations, but the
receiver-side P-013 comms-tier gate
(`sync/hyperbee/projections/coord-message.ts` + `comms-tier-gate.ts`) requires
the *author* to resolve to tier `steer` — via a **local** `comms_trust_list`
grant or the owner-signed pot-policy default — before a remote handoff
applies; below that it lands in `harness_shared.coord_quarantine`
(reason `handoff-below-steer`): visible and grantable, never silently applied
or dropped. There is deliberately **no owner special-case** (steer grants are
per-user, per-machine, and never federate). Messages/escalations need only the
`message` fallback tier, which is why they pass ungranted. Both legs
live-proven in the matrix (`deb-hetzner-coord-controlplane.sh`: ungranted →
QUARANTINE, steer-granted → FEDERATED). Tier lookups are TTL-cached \~30s
(`PAPERCUSP_COMMS_TIER_CACHE_MS`) — a fresh grant takes up to that long to
take effect.

### 2. Multi-device, same identity

Federation identity is **per-device keypair**, not per-GitHub-account. The
substrate is "Model B" — per-device single-writer logs + read-merge
(`sync/hyperbee/peer-log.ts`), *not* Autobase — so sharing one pot keypair
across a user's devices is *safe* (no writer conflict), but **discovery and merge
are separate gates**: the shared keypair grants topic discovery, while the actual
merge is gated by membership (`classifySameHiveMember` admits a remote log only
if its `device_pubkey` is in `hive_members`). So one human on two devices = two
distinct device pubkeys, each needing its own membership admission.

The dogfood per-owner pot solves the same-owner case (Solution C,
`harness/papercusp-pot-share.ts`: a per-owner private identity gist + an
owner-signed allowlist policy auto-admits the owner's login).

**UPDATE 2026-07-10 (WI-3546 / p2p-rest-lanes-2026-07-09 P-009): the two-device
data-merge is now WITNESSED LIVE, BOTH directions, with a real second device** —
superseding the prior "only single-box-smoke-verified, never witnessed live"
gap. Rig: Linux tower (`dev-box-linux`) ↔ mac VM
(`aviweiss@172.31.44.2`), one owner identity, both device pubkeys admitted (the
VM's registry row was backfilled to `harness_kind:'hive'` / `remote_hive:true`
per **WI-3891** so `isRegisteredHive` flips true). A genuine coord write on each
side federated and merged on the other, attributed by author pubkey + machine,
verified by direct `psql` on BOTH boxes (not a peer report), sustained (paired
markers \~3.5 min apart, no re-freeze):

* **VM→tower:** tower `harness_shared.coord_event_log` rows **463624** (22:47:13Z)
  * **463662** (22:50:45Z), `origin='remote'`, `author_pubkey ef7a8160…` (the VM's
    writer log), payload = the VM-authored `VMREAL20260710-2246` markers — landing
    **8h15m past the prior freeze** (id 458509, 10:32:45 EDT).
* **tower→VM:** the VM's OWN `coord_event_log` rows **415** (22:47:19Z) + **419**
  (22:50:51Z), `origin='remote'`, `author_pubkey 5b00878b…` (the tower's writer
  log), payload = `coord:receipt` fed\_events self-identifying
  `machine:dev-box-linux`, `delivered:true`.

> **`probe:emit` / `probe:get` prove local capture only — never use an `acked`
> receipt as the live-federation discriminant (WI-3962).** The former post-capture
> hop fields and `probe:record-hop` surface were removed: they had no real
> pipeline writers and made every probe an unconditional false-NO-GO. `acked`
> now means exactly “the correctly stamped declaration was captured locally”;
> `refused` records why capture could not start. Read live federation health from
> fresh `origin='remote'` `coord_event_log` rows + `substrate_merge_cursor`
> advancement, as above.

The stricter "private key never leaves the
creating device" remote-JOIN variant (share only the pubkey) is deliberately not
built. The historical phase1b multi-device collision (contributor-file login-key
overwrite) is *obsolete* — admission is now keyed by the stable numeric
`github_user_id` + a device-signed announce/attestation
([phase1b-federation-limitations](/internal/docs/agent-insights/phase1b-federation-limitations)).

### 3. Revocation is WRITE + DISCOVERY-plane only (hard read cut-off rides the re-key)

A revoked/banned member stops being *aggregated* and stops *discovering* new
content, but `swarm.ts`'s `store.replicate(socket)` serves cores to any topic
peer, so a removed member (or anyone who got the link while the pot was public)
keeps **reading** future content until the pot **re-keys** (C-001) or is
**dissolved**. The in-place re-key epoch **K-cut** that closes the read plane is
now **enabled by default in production** (`papercusp-pot-rekey` — no longer dark;
built in `pot-epoch-boot-deps.ts` / `buildHiveRekeyBootDeps`, consumed on the
in-place `rekey()` rebind, never a reboot). But its **cross-machine LIVE proof is
still pending (Brief 3)** — today only the in-process
`federation-revocation-kcut-sidecar` + `pot-late-join-epoch-decrypt-federation`
tests cover the K-cut. This is a conscious product decision, not a silent hole.
([substrate-revocation-model](/internal/docs/agent-insights/substrate-revocation-model).)

### 4. LWW convergence under clock skew — the four ordering sources are FIXED (2026-07-02); one presence gap remains (§ 4a)

The S0 class ("two honest peers silently materialize different rows for the same
key") had **four** distinct sources, all now fixed:

1. **Capture-boundary two-clock bug (mig 446):** two clock reads in the *same
   transaction* stamped the same op — the mig-314 BEFORE trigger stamps the
   row's `fed_ts` with `clock_timestamp()` while the AFTER capture triggers
   stamped the outbox wire `ts` with `now()` (txn start), so author ≠ every
   receiver forever. Mig 446 threads the ROW's `fed_ts` as the put-op wire ts in
   **both** capture functions. Live-verified (concurrent\_lww PASS, m1783013203).
2. **HLC-fold vs fed\_ts-guard order split (mig 458, EI-1698):** the merge
   winners-fold ordered by HLC while the PG guards ordered by wall-clock
   `fed_ts` (and later, non-transitively, by a mixed rule). Mig 458 introduces
   `harness_shared.fed_order_key(hlc, ts)` — an immutable SQL mirror of
   `lwwPick`'s derivation — and applies it to all 40 guard clauses (put+delete)
   across the 20 mutable projection writers: one ordering key of record
   end-to-end. ([hlc-merge-vs-fed-ts-guard-divergence](/internal/docs/agent-insights/hlc-merge-vs-fed-ts-guard-divergence).)
3. **Exact fed\_hlc ties swap winners (WI-1672, mig 459):** after any
   recv-ratchet episode, peers advance clocks by counter only in near-lockstep
   and routinely mint IDENTICAL `(ms, count)` stamps; every tie-accepting `>=`
   guard then accepts the incoming op on BOTH peers and two honest peers stably
   SWAP winners (observed live on the wi1544 3-frame rig). Fixed by a node-id
   total order: 3-segment HLC `<15-digit ms>:<5-digit count>:<16-hex node>`
   (locks-core `hlc.ts` + mig 459's `hlc_clock.node_id` / 3-segment
   `hlc_now()`/`hlc_recv()`); a genuine full tie can now only be the same stamp
   replayed, where tie-accept is correct (idempotent). Legacy 2-segment stamps
   lose ties deterministically on every peer.
4. **The recv-ratchet amplifier (mig 460):** `hlc_recv`/`HlcClock.recv` blindly
   adopted any remote `ms`, so ONE absurd-future stamp pinned the clock — and,
   re-propagated, the whole pot — years ahead, permanently (self-demonstrated
   live on the dev DB during WI-1672 verification). Both now refuse to ratchet
   past `now + 600s` (2× the D-007 announce-admission window, so every
   legitimately-admitted peer still ratchets); the op's DATA still applies,
   only the clock advance is skipped.

Evidence for 3+4: the convergence-fuzz rig now models the REAL production
topology (`localAuthorApply` = skipOwnOps + the unguarded trigger write path;
`lockstep` = the ratcheted counter-lockstep) — node-LESS stamps split-brain
across a 120-seed sweep (teeth), node-carrying stamps converge on all 120
seeds, monotone AND skew; plus the forced-tie two-device swarm + migrated-PG
integration test (`federation-concurrent-writes-sidecar.repro.integration.test.ts`).

### 4a. Local-del resurrection under skipOwnOps — row-PRESENCE split-brain (WI-1684, FIXED 2026-07-09)

Found by the production-topology fuzz rig while verifying the WI-1672 fix, and
**not** fixed by node ids: an author DELETES a row locally (trigger path — row
gone, **no tombstone**) and its own del is skipOwnOps-excluded from its own
fold; a CONCURRENT foreign put with a LOWER fed\_hlc then wins the author's fold
among foreign ops alone and hits the projection's no-row insert path, which has
nothing to arbitrate against → the row is RESURRECTED on the author peer only,
while every other peer folds del + put together and keeps it deleted. Classic
LWW-set missing-tombstone gap, specific to the local-write path bypassing the
merge's winners map. Needs genuinely concurrent cross-peer writes straddling a
delete, so lower frequency than WI-1672 — but silent, permanent divergence when
it hits.

**FIX SHIPPED**: `skipOwnOps` narrowed to PUTS ONLY in `projection.ts`'s
`applyOpVia` — a winning own DEL is now always re-applied (a fed\_hlc-guarded
delete that removes the resurrected row), which is echo-safe (a 0-row delete
never fires the capture trigger's `FOR EACH ROW`; a resurrected row is
`origin='remote'` so capture's echo-guard skips it) and orthogonal to WI-1672
(own PUTs stay skipped, so its teeth stay green). Regression pinned as a HARD
test (not a characterisation) in `convergence-fuzz.test.ts`'s `WI-1684` describe
block: `TEETH` proves the bug reproduces with `applyOwnDels:false`, `FIXED`
asserts `expect(failures).toEqual([])` across the full 120-seed sweep with the
shipped fix — both green as of 2026-07-09.

### 5. NAT / firewall / geo assumptions — LIVE-PROVEN with one caveat (Brief 8, 2026-07-02)

Brief 8 lifted this from the easy topology: 2 Hetzner frames **cross-region**
(ash↔hil) with a **stateful restricted-cone NAT** (nftables masquerade +
established/related-only inbound) in front of the member frame, real public
DHT. Verdict: **holepunch PASS both directions; member→owner content PASS;
owner→member content is LATE, not never** — ops the owner appends while the
joiner is still in its owner-binding-null admit-refusal window stall
indefinitely (80+ min observed, survives a cold restart of the member) until
the **next owner-side append** kicks the replication/fold, after which the
entire backlog folds within minutes. No data loss; the log is intact. Filed as
**WI-1534** (unbounded staleness on quiescent pots).

**MITIGATION SHIPPED (2026-07-09):** root-caused to the WI-752/FED-2 self-heal
re-peer loop (`joinHarnessSwarm`'s `discovery.refresh()` cadence) settling into
its 60s SLOW keepalive once the post-join/post-peer-loss FAST window lapses —
on a QUIESCENT pot (no connection churn to naturally re-arm the fast window)
that is the only thing that ever retries a stalled/zombie/never-attached
admitted remote's reconnect, so the peer sits at 0 live replicator peers for as
long as it takes an UNRELATED event (the next owner append) to coincidentally
land alongside a working DHT/holepunch retry. The merge pass itself was already
correct (`core.update({wait:true})` + `changed` re-fold run unconditionally
every 1s poll for every admitted remote — never the gap; corestore's
`streamTracker.attachAll()` also already late-admit-attaches a newly-opened
remote core to every live muxer, so late-admit-mesh is not the gap either). Fix:
a new `hasStalledLogs()` predicate (boot.ts, fed from the `admitted` map's
`peersCount()===0` check) wired into `joinHarnessSwarm`'s self-heal loop
(`swarm.ts`) keeps it on the FAST cadence for as long as ANY admitted remote log
shows zero live replicator peers, instead of dropping to the 60s slow keepalive
regardless. Unit-pinned in `swarm-self-heal.test.ts` (fake-timer cadence
assertions: stays fast while stalled, falls back to the dead-zone/slow-keepalive
once the stall clears, a throwing predicate never breaks the loop). **Known
gap (found 2026-07-25, EI-18665254552552477):** the mitigation only covers a
stalled *admitted* remote — `hasStalledLogs()` iterates the `admitted` map and
falls through to `false` when it is empty, so a peer that has never admitted
*any* remote (its announce channel never pairs at all) reads as "not stalled"
and stays on the 60s slow cadence — backwards, since zero admitted remotes is
the worst case this mitigation exists to catch, not the healthiest. Reproduced
live in gate run `20260725-183831`: 20.5 minutes, 188 established connections,
zero inbound frames, zero admitted remotes for the whole window, on the
slowest retry cadence throughout. Complementary to (not covered by) the
separate rung-(c) swarm fix. **Still
open:** live verification on the 2-node containerized rig
(`bin/local-matrix.sh`, P-006) and/or the tower+VM NAT rig (Brief 8's setup) —
this is a real-network timing fix that a real restricted-cone-NAT rig run is
needed to confirm actually shortens the 80+min stall; coordinate with whoever
next runs that rig. Remaining out-of-scope rung: **symmetric
NAT** (needs a real symmetric-NAT middlebox; port-dependent mapping defeats
the restricted-cone emulation). Earlier rig work also proved that two VMs
sharing one NAT egress IP **hairpin** and fail a public-DHT holepunch — a
class of failure single-NAT topologies never surface.

### 6. Long-running node stability (bg-host leak) — RESOLVED (2026-07-02)

The original listener-leak class (25+ substrate boots adding `swarm.on('connection')`
to the shared swarm without removal, WI-1088/1089, Brief 10) was fixed; the
re-observed 30GB RSS climb (WI-1417) turned out to be a **different** driver — the
claude-sessions full owner-dir fs sweep
([operator-memory-bloat-claude-sessions-fs-sweep](/internal/docs/agent-insights/operator-memory-bloat-claude-sessions-fs-sweep)),
fixed with negative-resolution + roots TTL caches in `claude-sessions.ts`.
Live-re-verified 2026-07-02: bg-host sits at a 5.7–5.8GB sawtooth plateau (GC keeping
pace, not a monotonic climb), no dbos-reaper false-reap storm; recurrence-guarded by
3 tests in `claude-sessions-cache.test.ts`. WI-1415/WI-1416 (the git-sync symptom
chain) independently resolved. No longer a release risk row.

### 7. Data-completeness is table-grain-guarded AND column-grain-guarded (RESOLVED 2026-07-09)

26 federated (CDC-captured) tables are structurally guarded at table grain
(every peer-log table has a producer + a projection, two green CI tests) AND at
**column grain** via `federated-column-completeness.integration.test.ts`
(introspects the REAL migrated `information_schema.columns` per table — not a
hand-rolled subset — and asserts every real column is either carried by the
mapper, PROVENANCE, PG-generated, or an explicitly-reasoned `NOT_FEDERATED`
entry). The `harness_features_consolidated` gap this section used to name
(`design_spec_id`/`source_plan_slug`/etc silently dropped) was fixed **2026-06-20**
(WI-251, findings-B B-002, consensus su-328af/su-860d3): those 10 content/lineage
columns are now carried by `toFeatureValue` (`feature-issue-op-keys.ts`) and the
`harness-features.ts` projection INSERT/UPSERT, and the completeness test asserts
they cross A→B. Re-verified 2026-07-09 (p2p-rest-lanes-2026-07-09 P-004): both
guards green, 27/27 + 9/9 tests passing, all 26 tables covered, zero unresolved
`NOT_FEDERATED` gaps on `harness_features_consolidated`. One small tracked
residual elsewhere: `gym_qd_archive.source` (sender-local seed-origin tag) has no
receive-side column yet (WI-2233, `REVIEW(findings-B)`-tagged, out of scope — a
real but minor future gap, not silent data loss since it's explicitly documented).
`trusted_authors` is local-only **by design** (federating the auto-run grant
would be a security regression).

**2026-07-16 drift catch + fix (the guard doing its job):** the column-grain
guard went RED on three tables after recent feature migrations —
`agent_facts.audience_scope`/`source_provenance` (mig 574) and
`memory_canonical.valid_at`/`invalid_at`/`superseded_by` (mig 578, the
temporal-lite validity semantics) were silently dropped on the wire, and
`engineer_issues.feature_order` (mig 588) was undocumented. All five content
columns are now CARRIED end-to-end (mapper + wire-row guard + projection
INSERT/UPSERT, optional-tolerant for pre-migration history ops), and
`feature_order` is documented local (per-machine dispatch rank; whether backlog
priority federates is a work-distribution-activation posture question —
remaining-lanes P-201). Guard re-run green 28/28. Lesson unchanged since
WI-251: every new column on a federated table MUST route through this guard's
three-way decision (carry / provenance / reasoned-local) at migration time.

### 8. The 2-server quota cap → no true 3-machine multi-member LIVE

*(historical)* The Hetzner quota was \~2 concurrent servers, so true 3-machine
member↔member fanout (owner + 2 members, Brief 2) was **not live-coverable**;
it was proven only via a 2-VM proxy + the in-process matrix, and the owner
ratified that min-bar (D-006). **UPDATE 2026-07-03 (D-001,
`shared-pot-p2p-release-readiness-2026-07-03`): Hetzner is gone entirely, and
the un-gating path is now LOCAL** — extend the containerized rig to 3 frames
(`bin/local-matrix.sh` provisions docker frames; the rig lib is already
N-frame) and run the matrix + membership churn there (that plan's P-010).
"Gated on a >2-server quota" is obsolete; the residual gap is simply that the
3-frame local run has not been executed yet.

### 9. Owner→joiner federation can stay broken in the pure NO-RESTART join path (RESOLVED — both mechanisms fixed + live-verified 2026-07-02)

A live run (Brief 6 attempt-1, su-e7698: 2-frame, shared forceReFold `.deb`, real
DHT) surfaced **owner(a)→joiner(b) content federation FAILING** in the plain
join→write path with **no restart**: b's `hive_members` roster stayed EMPTY for
270s+, so `decideMemberContentOp` dropped every owner op (b→a was fine). Code
root-cause (su-0f0a4): `forceReFold` (`boot.ts`) fires **exactly once**, on the
`rekey()`→pot-home rebind, then resets. If the owner's `hive_members` op arrives
at the joiner **after** that single re-fold (during drain), it is never
re-applied — it stays dropped-in-the-home-window until a **restart or a later
rekey**. This is consistent with Brief 5 (restart) PASSING (the restart re-folds)
and means the earlier "proven live" runs (run33/34/35) may have included a
restart/rekey rather than exercising the pure no-restart path.

**Root cause (confirmed, su-2c799):** cross-process `opStateCache` staleness under
`SUBSTRATE_SIDECAR`. `join-pot.ts` (MAIN process) commits the registry
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
committed write (join-pot awaits the `mutateRegistry` commit before the rekey
RPC). **Second mechanism (WI-1544, the race bifurcation):** when the deterministic
join-time binding resolved BEFORE the owner's announce, the joiner's pot-home
projection conclusively rejected the owner core on the slug filter
(origin=member-slug), membership chicken-and-egged, and A→B blacked out
*permanently* (the rekey rescue was structurally unreachable — no binding
transition). Fixed in `boot.ts`: `inJoinBootstrapWindow()` reclassifies a
join-window `binding_invalid` as retryable/buffered instead of
conclusive-reject, and the `scope_unresolved` buffer holds out-of-scope
slug-filter frames while the pot-home projection slug is unresolved
(WI-1544, resolved 2026-07-02; 41 dedicated tests in `boot.test.ts` +
`announce-channel-multihive.test.ts`).

**Live verification:** matrix run m1783013203 (2026-07-02) federated A→B on the
FIRST poll across all 8 scenarios — no restart, no adaptive re-fold rescue
needed. This limitation is closed.

### 10. Membership-lifecycle + residual trackers (P-011 verdicts, 2026-07-03)

The post-min-bar backlog was given explicit verdicts under
`shared-pot-p2p-release-readiness-2026-07-03` P-011 (full table:
`shared-pot-release-testing/RELEASE-READINESS.md`). The standing
ship-with-limitation rows, each with an accountable tracker:

* **No un-revoke path (G8, WI-1855) — SHIP-WITH-LIMITATION, ratified.** Revocation
  is one-way; un-banning a member has no sanctioned flow. WI-1855's acceptance
  criteria (a built un-revoke flow OR this owner-ratified permanent-limitation row)
  is satisfied by this row, hence its `resolved` tracker state — no code shipped for
  un-revoke itself, this is a documented-and-accepted gap, not a fix.
  ⚠️ **CORRECTED + RATIFIED (2026-07-09, WI-3566, closing the P-003 rest-lanes audit
  finding):** this row previously stated the sanctioned workaround (re-invite as a
  fresh device/epoch) "must NOT retro-grant cut epochs" — **verified FALSE against
  the actual implementation, and that old caveat is now removed as simply wrong.**
  `grantEpochKeysToMembers` (`pot-epoch-boundary-wiring.ts`) is a ratified v1
  correctness call (D-009, 2026-06-19/2026-07-04): ANY newly-admitted member —
  including a re-invited fresh device for a previously-revoked identity — is granted
  wrapped keys for **every** epoch `[0..current]`, by design (pinned by
  `seed-past-epoch-key-guarantee.test.ts`; a current-epoch-only policy is explicitly
  a *deferred future forward-secrecy policy*, not implemented, and not currently
  planned work). **Ratified (WI-3566, superseding the earlier "owner design
  decision needed" framing): un-revoke-via-reinvite IS, and is meant to be, a full
  history restore** — the returning member gets every epoch key minted during their
  ban, including the K-cut boundary epoch that revoked them, identically to any
  brand-new member. There is no guard distinguishing "returning previously-revoked
  identity" from "genuinely new member" at grant time, and none is planned — this
  is the accepted v1 behavior, not a gap awaiting a fix. Treat un-revoke-via-reinvite
  as **equivalent to inviting a brand-new member with full history access** — NOT as
  a partial/forward-only restore.
* **Membership teardown doesn't federate (G24/G27, WI-1857) — SHIP-WITH-LIMITATION, ratified.**
  Dissolve publishes no membership tombstone (peers' rows orphan out by TTL) and a
  leaver's `hive_members` row persists on peers. Pinned by
  `lifecycle-membership-teardown.gap.integration.test.ts`; the read-plane mitigation
  (epoch K-cut) is live-proven, so this is a hygiene gap, not a security hole. Same
  as WI-1855: `resolved` reflects this ratified doc row, not a built fix.
* **revoke() Hypercore session leak (G9, WI-1856) — FIXED 2026-07-05.** `openRemoteLog`'s
  `RemoteLog` now implements `close()` (`core.close?.()`), and `boot.ts`'s `revoke()`
  captures the `AdmittedLog` before deleting it from `admitted` and fire-and-forget
  closes it (deliberately not awaited — awaiting added multi-second live-replicator
  teardown latency that timed out an unrelated pinned test). Verified: `boot.test.ts`
  43/43, `revocation-prior-row-semantics.test.ts` 1/1, `peer-log.test.ts` 4/4, a new
  pinning test added, `tsc --noEmit` clean on the 5 changed files
  (`peer-log.ts`/`read-merge.ts`/`boot.ts` + the two test files).
* **Usage-events metering is machine-local (G2, WI-1858)** — the
  `contributor_usage_events` capture trigger is deliberately deferred to the GA
  migration (completeness-guard exemption until then).
* **From-repo joiner incremental federation (WI-971) — RE-VERIFIED 2026-07-09
  (p2p-rest-lanes-2026-07-09 P-005, WI-3542).** The outbox drain is never wired for
  joined/created pot harnesses (WI-259 was closed as its duplicate); the fix
  (join-pot.ts step "2c/2c′" — re-key the home-VIEW and every joined member onto
  the Pot-pubkey topic right after the registry view/identity materialize,
  instead of waiting for a process restart) was already unit-tested with mocked
  deps (`join-pot.test.ts`'s "2c′ home-view boot/rekey" block), but the earlier
  `resolved` state-flip carried no recorded completion evidence. New evidence:
  `packages/operator-core/lib/harness/join-hive-from-repo-incremental-federation.integration.test.ts`
  drives `joinHiveAsView` against a REAL, migrated Postgres (env-routed `getOrgPg`,
  the `owner-content-to-joiner-faithful.repro.integration.test.ts` pattern) with
  `mutateHarnessRegistry`/`loadHarnessRegistry` UNMOCKED, and a `rekeyHarness` stub
  that itself performs a real registry read at call time — proving (1) the
  home-view + member registry rows genuinely commit to Postgres, not an in-memory
  fake, and (2) the 2c′/2c rekey calls fire, in order (home view first, then every
  member), strictly AFTER that commit is visible — the exact ordering bug WI-971
  closed. Green: `npx vitest run --config vitest.integration.config.ts
  packages/operator-core/lib/harness/join-hive-from-repo-incremental-federation.integration.test.ts`
  → 1 passed (1), 1292ms.
  **Scope note (fallback path, deliberate):** this proof is registry+ordering
  only — it stubs the from-repo `joinLink` (GitHub clone/attestation, unrelated
  to WI-971) and does not boot two REAL substrate peers through
  `joinHiveAsView` end-to-end to show a post-join content write federates
  incrementally with zero process restart. That remaining live-two-peer
  content-roundtrip proof is tracked separately — see the follow-up work item
  filed alongside this test (search `work_items` for "WI-971 live two-peer
  from-repo content roundtrip").

  **CLOSED — live two-peer proof landed 2026-07-25 (WI-5775/WI-5628).** Two live
  `two-instance-hive-from-repo-smoke.sh` runs (plain, and with the gate's exact
  `WITNESS_PROBE=1 PAPERCUSP_FLAG_PAPERCUSP_HIVE_REKEY=1` flags) against a real
  built `.deb` in sidecar-bundle fallback mode both report `OVERALL: PASS`:
  create/announce/discover/join/join-clone all PASS, and — the WI-971-specific
  proof — `federate-A→B`, `federate-B→A`, and `federate-A→B #2` (continuous,
  post-join) all PASS. `live-federation-gate.sh`'s `SKIP_FROMREPO` default stays
  `1` (a separate, standing decision — WI-5629 — not reopened by this fix), but
  its stale "expected WI-971 red" framing has been corrected: a from-repo RED is
  now a genuine regression. (The gate-flags run's WITNESS sub-probe separately
  surfaced an unrelated AK-ban enforcement gap — tracked as WI-5783, not a
  WI-971 regression.)

### 11. Boot-window / silent-re-federation data-loss class for CDC-captured tables (WI-5441) — CONSCIOUSLY WAIVED for public release (2026-07-25, WI-5764)

**Symptom (demonstrated live, 5+ independent repros across 2026-07-18/19):** a row
written on the origin peer occasionally federates with **zero** corresponding
`harness_shared.substrate_outbox` entry, ever — the write is silently and
**permanently** non-federating, with no error, no stall-detect signal, and no
reconciliation pass to catch it. First reproduced on `plan_item_assignments`
(the generic `capture_substrate_outbox()` capture path, migs 359/446); the
mechanism is not table-specific, so any table riding that generic capture
function is exposed in principle — most consequentially
`harness_shared.work_items` (features/issues), which rides the sibling
`capture_work_items_outbox()` function (mig 375/423) and was flagged at filing
time as the path where this class would be most damaging (the shared-pot
editing surface). No work-items-family repro has been observed; this is a
structural risk, not a demonstrated second instance.

**What is CONFIRMED, after an exhaustive multi-session investigation (WI-5441
posts, 2026-07-18 22:03 → 2026-07-19 17:10, 5+ agents):**

* The federation-capture trigger (`capture_substrate_outbox_trg`) is always
  attached and enabled well before the losing write in every repro — a
  "trigger not yet attached at boot" race was directly falsified by OID/timing
  forensics on 3 separate runs.
* No online-guard, no `session_replication_role` override, no ON CONFLICT
  short-circuit, no swallowed exception, and no GC-deletion timing explains a
  bare local-origin INSERT losing its capture entry.
* The clearest live-caught instance (real production content, plan
  `health-tab-v2-2026-07-12` items P-013–015, not the synthetic seed probe):
  a row's `origin` flips `remote→local` with **byte-identical** federated
  content (no assignee/assigned\_ts/strategy/note change) and produces **no**
  outbox row — i.e. something **re-applies an already-materialized op through
  the projection's `writeToPg`** with a provenance context that resolves
  `origin` to `'local'` on a write that is not actually a fresh local edit.
  The leading (unconfirmed) hypothesis is a periodic reconciliation/re-fold
  pass constructing `OpEnvelope`s directly from DB rows rather than from a
  peer-log op, without threading `provenance` — see WI-5441 post 52971 for the
  exact code seam to instrument (`writeToPg`'s `provenance?.origin ?? 'local'`
  fallback, `packages/operator-core/lib/sync/hyperbee/projections/
  plan-item-assignments.ts`).
* **Root-cause identification requires live rig instrumentation** (a debug
  capture trigger armed from before boot) — static code reading across every
  receive-side call site (own-log snapshot compaction, backfill-local-state,
  the epoch decrypt gate, `withHiveHomeApplyGuard`, `resolveOpProvenance`'s
  fallback) has been exhausted without a positive catch of the exact writer;
  see WI-5441 posts 52968/52971/52980 for what has been ruled out and why.

**What WAS fixed 2026-07-25 (WI-5764, defensive hardening — NOT proven to be
this class's root cause):** a genuinely real, separate boot-ordering race was
found and fixed in the **native `:5432` operator host** path
(`apps/operator/bin/hono-host.ts` + `host-bootstrap.ts`): `startRequestServers()`
previously ran unconditionally immediately after the fire-and-forget
`runBootstrap()` call, with no ordering guarantee against the still-running
migration apply — so an HTTP write could in principle reach a table before a
still-applying migration set had created its capture trigger. Fixed by gating
`startRequestServers()` on a new boot-gate flag
(`markMigrationsAppliedForRequestGate`/`awaitMigrationsAppliedForRequestGate`,
`packages/operator-core/lib/sync/hyperbee/boot-gate.ts`) that flips the instant
`applyPendingMigrationsAtBoot()` returns; a request-only host
(`PAPERCUSP_BACKGROUND_WORKERS=0`) or a timeout degrades open (log + serve
anyway) so this can never wedge boot. **Caveat found while implementing this
fix, worth recording explicitly:** the live-fed-gate / local-matrix rig that
produced every WI-5441 repro above boots the **desktop/embedded-pg entrypoint**
(`apps/operator/bin/serve.ts` → `startEmbeddedPostgresServer`), which
`await`s its own migration-apply step to completion **before** `runBootstrap()`
or `serve()` ever run — so that specific race does **not** explain the observed
reds (consistent with WI-5441 post 52911's own finding that the capture
trigger already existed \~4 minutes before the losing write in that repro). The
hono-host.ts fix is real, low-risk, and worth having (it protects the native
`:3070`/`:3170` dev-box hosts, a different boot path with the same class of
race), but it is **not** the fix for this section's demonstrated defect —
treat the two as separate, both real.

**The waiver.** Given (a) the mechanism is narrowed but not pinned without a
dedicated live-instrumentation session, (b) every prior attempt at that
session was resource-constrained by the shared single-tenant rig, and (c) no
second instance has been observed on the work-items family despite it being
structurally exposed — **this class ships as a known, documented limitation
for the public release**, not a release blocker, on the following basis:

1. It requires a specific, uncommon interleaving (a re-apply of already-correct
   content racing the capture path) — not a routine write path failure.
2. The loss is confined to metadata/assignment-shaped federated tables observed
   so far (`plan_item_assignments`); no core content (features/issues/plans/coord
   threads) loss has been demonstrated.
3. **The durable fix direction is known** (WI-5441 post 52911): a reconciliation
   pass that compares TABLE STATE across peers for CDC-captured tables (rows
   present on the publisher, absent/stale on the joiner) rather than trusting
   outbox history alone — this is a bigger, higher-risk change (a new periodic
   cross-peer state-diff mechanism) appropriately scoped as its own follow-up,
   not something to rush unattended against the release-critical gate rig.

**Tracking.** WI-5441 stays **open, `blocked`, claim-held** with this waiver
recorded — do not silently re-close it as resolved. Any future session with a
free rig slot should pick up the live-instrumentation step exactly where post
52980 left off (a fresh rig with BOTH an INSERT and UPDATE debug trigger armed
from before boot, per the first WI-5441 checkpoint). WI-5764 (this waiver +
the defensive hono-host.ts fix) is the P-410 disposition for public release.

***

## Public-release checklist

**Minimum bar to call cross-machine federation "public-release-ready":**

| Brief  | Gate                                                     | Current status                                                                                                                                                                                                                                                                                                                               |
| ------ | -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **1**  | Rig foundation (reusable lib, 3-frame, scenario drivers) | ✅ DONE + live-validated (run35)                                                                                                                                                                                                                                                                                                              |
| **2**  | LIVE multi-member (3+) fanout                            | ✅ **OWNER-RATIFIED option B (2026-07-01, D-006 @ federation-release-hardening-relaunch-2026-07-01)** — min-bar = in-process multimember repro (green) + 2-node live briefs; true 3-machine fanout stays a documented known limitation gated on cap >2 servers + a 3rd distinct gh identity (scenario `deb-hetzner-brief2.sh` stays runnable) |
| **3**  | LIVE revocation + epoch K-cut                            | ✅ **DONE — LIVE PASS 2026-07-02** (su-f5d28, 2 Hetzner VMs, public DHT): baseline federated → owner ban accepted (revokedPubkeys) → post-ban content CUT OFF (\~90s negative assert) → pre-ban content stayed readable (not retroactive). WI-1329                                                                                            |
| **5**  | LIVE restart durability                                  | ✅ **DONE** — LIVE PASS over 2 Hetzner VMs (su-8f1ad, WI-1331): member + owner cold-restart both prove no content/roster loss, exactly-1-row, no re-emit; exit 0, servers=0                                                                                                                                                                   |
| **6**  | LIVE concurrent writes / LWW convergence                 | ✅ **DONE** (P-006 of the relaunch plan; WI-1378 resolved + live-verified 2026-07-01)                                                                                                                                                                                                                                                         |
| **7**  | LIVE coordination control-plane                          | ✅ **DONE — LIVE matrix 2026-07-02** (su-f5d28): 6/7 rows match the architecture — harness-scoped coord **messages + escalations FEDERATE**; raw presence/watermarks/await stay LOCAL by design. One genuine gap filed: the harness-scoped **handoffs surface does not federate** (WI-1510, cross-machine-parity lane).                       |
| **11** | `forceReFold` release-grade + CI                         | ✅ **DONE** — `peer_cap_near` in `BootHistoryKind` + CI-wiring + commit + the snapshot+re-fold integration test all landed (su-43e13, WI-1337)                                                                                                                                                                                                |

**Strongly recommended (durability):** Brief **4** (LIVE reconnect/catch-up),
Brief **8** (NAT/geo), Brief **9** (scale + `forceReFold` cost), Brief **10**
(bg-host leak fix + guard).

**For repeatability:** Brief **13** — ✅ **DONE (2026-07-02, su-f5d28)**: the
one-command runner `bin/deb-hetzner-matrix.sh` executes all 8 registered
scenarios end-to-end (publish → join → per-scenario → K-cut) and went
**8/8 green** on run m1783013203, after fixing the two failures the first full
run surfaced (concurrent\_lww → mig 446; coord\_controlplane → stale pre-P-013
expectation, scenario rewritten to assert the trust boundary). Note the rerun
executed on the 2-node **containerized** rig (Hetzner creates owner-walled,
below) — container-grade, with the per-brief Hetzner runs as the VM-grade
proof. Brief **12** (this doc).

> **Honest read of the minimum bar:** with the 2-server cap permanent, the
> Brief-2 "multi-member fanout proven LIVE" gate cannot be met as originally
> written. Ship-readiness must either (a) accept multi-member proven via 2-VM
> proxy + in-process and explicitly document the >2-server gap as a known
> limitation, or (b) obtain a quota bump first. Do not silently treat the 2-VM
> proxy as equivalent to true 3-machine live coverage.
>
> **RESOLVED 2026-07-01: the owner ratified (a)** — verbatim "accept in-process
> multimember + 2-node live as the min-bar" (D-006 @
> federation-release-hardening-relaunch-2026-07-01). The 3-node live gap is a
> standing known limitation with explicit un-gating conditions (Hetzner cap ≥3
> **and** a 3rd distinct verified gh identity); it is no longer a release
> blocker.

**Also gating, outside the federation product code:** Brief **14** — operator-core
`lint:tsc` — ✅ **DONE** (su-337c2, committed `f42d55681`): the gate is GREEN again
(310→244 errors, all type-only test-typing fixes, ratcheted, `npm run lint:tsc`
exits 0). CI is no longer red on this.

> **✅ No open release-critical blocker (as of 2026-07-02).** Blocker #9 is
> RESOLVED — both mechanisms (WI-1378 stale cross-process cache resolve;
> WI-1544 join-time binding race) are fixed and the full 8-scenario matrix went
> green first-poll with no restart (m1783013203).
>
> **⚠️ STALE as of 2026-07-10 — see § 0 above.** The gate went RED again this
> week: EI-8895 (admit-after-connect never attaches a replicator) is an ACTIVE
> release-critical blocker, plus a second live blocker (iMac hive membership
> absent). WI-3646 (hive\_slug regression) and WI-3869 (coord\_event\_log scan)
> are separate regressions found and fixed the same week. Do not treat this
> callout as current status — track `p2p-live-federation-crack-2026-07-10` /
> `shared-pot-release-testing/RELEASE-READINESS.md` for the live GO/NO-GO
> state.
>
> **Hetzner is GONE — the owner-wall callout is OBSOLETE (2026-07-03, D-001 of
> `shared-pot-p2p-release-readiness-2026-07-03`).** Access to the Hetzner
> machines is permanently lost (owner directive); the former "billing lock the
> owner can clear" framing no longer applies. **The LOCAL rig set is now the
> proof of record:** (i) the containerized 2-node matrix rig —
> `bin/local-matrix.sh`, the one-command wrapper over the same BYO-frames seam
> (`RIG_FRAME_IPS`) that produced m1783013203; (ii) the tower↔VM rig
> (`bin/vm-rig/` — a REAL kernel + network boundary, i.e. VM-grade, not just
> container-grade); (iii) the mac VM cross-platform witness; (iv) the
> single-box `two-instance-*-smoke.sh` suite. The `deb-hetzner-*` cloud
> provision paths are retired-not-deleted. Historical per-brief Hetzner runs
> remain valid evidence for the rows above.

***

## References

* Memories: `a02714f1` (the original "release-ready" decision — *overstated*),
  `f64a176d` (the calibration correction — the honest gaps list), `4d1db206`
  (the `forceReFold` adversarial review record).
* [shared-pot-federation-diagnosis-toolkit](/internal/docs/agent-insights/shared-pot-federation-diagnosis-toolkit) — the "rosters but no content" runbook.
* [live-2machine-kcut-witness-and-federation-gaps](/internal/docs/agent-insights/live-2machine-kcut-witness-and-federation-gaps) — the live re-key K-CUT witness recipe.
* [pot-rekey-flip-readiness](/internal/docs/agent-insights/pot-rekey-flip-readiness) — the `papercusp-pot-rekey` flip gate.
* [federation-rig-restart-runbook](/internal/docs/agent-insights/federation-rig-restart-runbook) — recovering the live VM rig.
* The live rig: `papercusp-desktop/bin/lib/deb-hetzner-rig.sh` (reusable, N-frame) + `papercusp-desktop/bin/lib/federation-asserts.sh` (assertions, incl. negative asserts).
