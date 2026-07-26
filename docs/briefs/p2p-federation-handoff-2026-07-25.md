# P2P federation / coordination — handoff brief

**Written** 2026-07-25 ~15:05 EDT by `su-2c11a3b9` (outgoing).
**Scope directive** [owner 2026-07-25, verbatim]: *"no, you should only be working on the p2p coordination work. write a brief for another agent to continue with that work"* — p2p is **the** lane, not a deferred one.

> ⚠ **This is a stale snapshot of a live, heavily-parallel system.** Before acting on any
> claim/liveness/gate statement below, re-verify: `coord:orient { afterCompaction: true, harness: 'papercusp' }`,
> then `work_items:get { ids: [...] }` for the items you intend to touch. Numbers here were true at the
> timestamps given and nowhere else.

---

## 1. What "the p2p coordination work" is

Papercusp ships as a **shared Hive**: peers federate work-items, plans, coord messages and content
over hyperswarm/hyperbee (corestore), discovered via DHT. The release signal for that layer is the
**live-federation gate** — an hourly job that builds a real `.deb`, installs it on **two containerized
frames** (`rig-a` = hive owner, `rig-b` = member) on a private bridge with a 3-node testnet DHT, then
runs ~14 federation scenarios end-to-end against the real binary.

Two legs matter:
- **content-matrix** (docker, CDC types A↔B) — currently **PASS**.
- **local-matrix** (the 2-frame BYO rig, `bin/local-matrix.sh` → `bin/deb-hetzner-matrix.sh`) — the
  one that still reds.

The gate is the *only* surface that catches the "green-rig / red-binary" class. Hermetic unit tests
do not exercise this.

---

## 2. Current state (verify before trusting)

**Gate cadence**: hourly, artifacts in `/tmp/live-fed-gate-<YYYYMMDD-HHMMSS>/`
(`local-matrix.out`, `content-matrix.out`, `build.log`, the `.deb` used).
Per-run frame logs are banked to `~/.papercusp/live-fed-gate/triage/{serve-a,serve-b,scn.<scenario>,load}-<HHMMSS>.log`.

**Run `20260725-143908`** (in flight when this was written — *re-check it, it will have finished*):

| order | scenario | result |
|---|---|---|
| 10–58 | content_bidir, planpart_bidir, coord_bidir, concurrent_lww, coord_controlplane, fleet_directory, seat_offer, spawn_request, work_item | ✅ **9/9 PASS** |
| 80 | restart_durability | ❌ **FAIL** |
| 82 | restart_settle_barrier | ✅ PASS |
| 85/87/90 | reconnect_catchup, replication_soak, revocation_kcut | *pending at write time* |

Previous run `20260725-134023`: **8 passed / 6 failed**, OVERALL FAIL.

**Notable delta**: `content_bidir` / `planpart_bidir` / `coord_bidir` / `concurrent_lww` — the
four that co-failed ~9 consecutive runs (WI-5672) — **all passed** in the 143908 run. Either
something improved, or WI-5672's load-correlation theory is right and this run got a quiet host.
**Do not close WI-5672 on one green run**; check several.

---

## 3. Already fixed — do NOT re-grind these

| What | Where | Evidence |
|---|---|---|
| **WI-5631** rig frames federated the REAL `papercusp` backlog → id-collision storm (8068 ops) + event-loop starvation | `papercusp-desktop/bin/lib/deb-hetzner-rig.sh`, `bin/local-matrix.sh` | id-collisions **8068 → 58 → 0** over two live runs. DONE. |
| ↳ cause (a): env-var **name drift** — rig exported `PAPERCUSP_HIVE_HOME_SLUG`, operator reads `PAPERCUSP_POT_HOME_SLUG`; and `RIG_HOME_HARNESS_SLUG` defaulted empty | `deb-hetzner-rig.sh:671,787` (now correct); `local-matrix.sh:93` sets `${NET}-home` | verified in tree |
| ↳ cause (b): the **dogfood hive** creates a local `papercusp` project *independent of* the env var | `deb-hetzner-rig.sh:673,789` → `PAPERCUSP_DISABLE_DOGFOOD_HIVE=1` | log line `[papercusp-hive] not created this boot` |
| **WI-5634** collision storm is **NOT** the cause of replication_soak cycle-fails | — | 3 independent confirmations; run with *zero* collisions had *more* cycle-fails |
| **EI-13317** shared dead sockets deadlocked forced rejoin | `swarm.ts` `forceRejoinNow` evicts shared dead sockets | commit `8e8d6629f2`; gate 20260720-031826 saw force-evict fire 3×, restart_durability/reconnect_catchup/revocation_kcut FAIL→PASS |
| **D-003** frame CPU/memory isolation (cgroup-v2 **exclusive** cpuset partition + `memory.low`) | `local-matrix.sh` (`rig_enable_exclusive`, `rig_frame_exclusive`) | frames genuinely evict host fleet off their cores — so a soak failure is **not** simple oversubscription of the frame's own cores |
| **Replication grace override for the rig** | `deb-hetzner-rig.sh:160` `RIG_REPLICATION_GRACE_MS=15000` → `PAPERCUSP_REPLICATION_STALL_GRACE_MS` (`:672,788`) | cuts the 180s default stall-grace to 15s so recovery can fit inside the soak's 90s SLA |

**Also settled**: `origin='remote'` on a joiner's own `pot_members` row is **by design**, not a bug
(`fed_hive_merge_probe`'s own comment). Ruled out already — don't re-chase it.

---

## 4. Open work, ranked

### ① WI-5639 — replication_soak misses the 90s SLA (WI-183 zombie-connection class) — **the main event**
State: **`open`** (I cleared the stale `owner-skip-p2p-2026-07-20` blocker on 2026-07-25 per the owner
directive above; a prior `claim_hold` by su-772cf615 was awaiting "the next natural run").

Symptom: after a kill/restart, the swarm re-peers but replication silently never resumes on ~1–2 of
10 directional legs; the repair path usually recovers in 15–20s but occasionally exceeds 90s.
Signature in `serve-*.log`: `replication_stalled (connected_never_replicated)` / `(no_replicator)` /
`replication_frozen ... no progress for 31s` → `repair-exhausted: forcing topic rejoin` →
`repair-on-detect: re-attached replica session ... after Ns swarm-connected-but-dead`.

**Ruled out**: collision storm (WI-5631/5634), build staleness (EI-18160721229588594 — a run silently
picked a *stale pre-fix* `.deb`; **always confirm the artifact**), detector blindness (WI-1840
fire-path pin confirmed firing), frame-core oversubscription (D-003 active).

**Live hypotheses** — pick these up:
- **(b) is the most interesting and least explored**: a bounded-retry/backoff ceiling in the repair
  path that can exceed 90s even on a healthy host. `boot.ts:1990` already documents a related
  interaction — the confirmation is judged after `REPLICATION_STALL_GRACE_MS`, giving ~540s, "far past
  the 90s". **Read that comment and the surrounding ladder first.** Note the rig now forces the grace
  to 15s, so re-derive whether the ladder still overruns.
- (a) genuine host contention: failures correlate with loadavg ~86 vs 55–81 on passes (128-core box) —
  plausible, unproven. The box also had 5 days of recurring **PSI memory-full** alarms (WI-5471 class,
  frames get exclusive *cores* but **not** isolated memory). Last cleared 2026-07-25T18:42Z.
- (c) run-to-run variance in a racy detect→repair→reattach cycle.

**Suggested first experiment** (from WI-5634): instrument repair-attempt timestamps relative to the
restart, then run several soak passes and correlate failure against loadavg/PSI.

Key files: `packages/operator-core/lib/sync/hyperbee/boot.ts` (grace + repair ladder, ~1248, 1954,
1990, 2028), `boot-all.ts:673-792` (env override plumbing), `replication-liveness.ts:230`,
`papercusp-desktop/bin/lib/scenarios/b8-replication-soak.sh` (the scenario + its detector fire-path pin).

### ② WI-5672 — `wip`, **severity critical**
Joiner B's epoch key for the hive may never be distributed (`no epoch key for epoch 1`, fail-closed
outbox drain on serve-b) — candidate root cause for the 4-scenario co-fail. **Not confirmed; needs a
live DB dump during a failing run.** Blocker already cleared 07-21. Given ① and this both point at
"member never converges", check whether they share a cause.

### ③ WI-5481 — parent replication_soak item, `blocked`, held open by `su-bce40c51`
Its checkpoint (su-6ffd5, 07-21) carries a *scope-extension* thread: an `it.skip`'d test
`federation-restart-durability-sidecar.repro.integration.test.ts` (describe `MEMBER→OWNER content
guard`). Findings: two existing seams (`loadHiveMembersOverride`, `potHomeSlugForHarnessOverride`)
get the owner to admit the member's log both directions; a real CDC-capture gap was found+fixed
(member content needs a `harness_shared.projects` row in the shared orgDb or `drainOutboxOnce`
silently returns 0). **Still red**: content doesn't land on owner within 25s with *no* guard trace
firing → suspected **merge-stage** gap (owner's poll cursor not reading the member's log), not a
guard-decision gap. Not root-caused. The skipped test is a real starting point.

### ④ `restart_durability` FAIL in run 143908 — **freshest signal, triage it**
This passed after the EI-13317 fix. A new fail deserves a look before assuming flake — compare
against `~/.papercusp/live-fed-gate/triage/scn.restart_durability-*.log`.

### ⑤ WI-971 / WI-5628 — `from-repo` gate leg RED
Outbox drain never wired for joined/created hive harnesses. A `from-repo` RED is **EXPECTED** while
WI-971 is open. A **content-matrix, local-matrix, or build** RED is a new regression.

---

## 5. How to run things

```bash
# full gate rig (needs a built .deb; single-tenant flock, waits up to 2h for the lock)
cd papercusp-desktop && bash bin/local-matrix.sh
bash bin/local-matrix.sh --only=replication_soak      # one scenario
bash bin/local-matrix.sh --list                       # registered scenarios
bash bin/local-matrix.sh --keep-up                    # leave frames up; --reuse re-enters; --teardown destroys
```

- Runs are **long and produce huge logs** — background them and `grep` the log; do **not** stream
  into context.
- The rig is **single-tenant per bridge network** (flock). Coordinate before starting one:
  `su-c009b3b4` / `su-bce40c51` have been shepherding the release lane and protecting the rig lock.
- **Always confirm the `.deb` is fresh** — a stale artifact silently invalidated a whole run once
  (EI-18160721229588594). `local-matrix.sh` warns if the deb predates HEAD; don't ignore it.

---

## 6. Traps that have burned real time

1. **`git blame` is worthless here** — git-sync commits the whole tree under one identity. Never
   attribute a change with it (a false accusation reached the owner once, WI-5111).
2. **Don't release a work-item back to the pool to hand it over.** Every release fires
   `work-item:claimable` and wakes the whole idle drain fleet — that thrash is a filed bug
   (`EI-18151406094317010`). I caused it. To transfer: set `wip`, then
   `work_items:claim { id, assignee }` **directly**.
3. **The bug-drain-200k fleet will auto-claim any `open` papercusp bug**, including release-critical
   ones, within seconds. If you need an item held, get it out of the claimable pool (`wip`) and ask
   leader `su-791667d4` to exclude it.
4. **Never** point a browser / verdict / playwright at `:3055` or `:3070` — desktop-only surfaces.
5. Static analysis is not enough on this rig: my WI-5631 diagnosis was *correct but incomplete* — the
   second cause (dogfood hive) only surfaced under a **live run**. Verify live.

---

## 7. Provenance notes (read before quoting any "directive")

- **The p2p-skip wall is DEAD.** `owner-skip-p2p-2026-07-20` ("skip any p2p related bugs, deferred
  pre-V1") was recorded second-hand by `su-791667d4`; it was cleared on WI-5672 (su-bce40c51,
  07-21) and I cleared the last instance on WI-5639 on 2026-07-25 citing the owner's verbatim
  reversal. **Do not re-apply it.**
- WI-183 is marked `done` but was **never actually fixed** — its closing checkpoint documents an
  unconfirmed forensic thread. Treat WI-5639 as the live tracking item; WI-183 is prior art only.
- Tag anything you carry forward: `[owner:<name> <date>]` / `[self-imposed]` / `[peer:<sid>]` /
  `[inferred]`. An untagged imperative is `[inferred]` until proven otherwise.

---

## 8. First three actions for whoever picks this up

1. `coord:orient { afterCompaction: true, harness: 'papercusp', intent: '<yours>' }`, then
   `work_items:get { ids: ['WI-5639','WI-5672','WI-5481','WI-5628'] }` — reconcile everything above.
2. Read the finished verdict of gate run `20260725-143908` (`/tmp/live-fed-gate-20260725-143908/local-matrix.out`)
   plus the next hourly run. Triage the **`restart_durability` FAIL** (§4④) — it's the freshest unexplained signal.
3. Claim **WI-5639** and go at hypothesis (b): read the repair/grace ladder in `boot.ts` (~1248, 1954,
   1990, 2028) against the rig's now-15s `PAPERCUSP_REPLICATION_STALL_GRACE_MS`, and work out whether
   the worst-case repair path can still exceed 90s on a quiet host. That is the cheapest path to a
   real root cause and needs no rig time to start.
