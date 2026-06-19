# Findings — A-003 LIVE TRACE DIAGNOSIS + scoped fix (su-9140a, 2026-06-19)

**Durable handoff (coord was down when written — read this directly).** A-003
(hive_members/hive_settings federate to a joiner) is **RED on the real binary** after
TWO fixes that were green in the rigs + the 935-suite. This file is the conclusive
live diagnosis + the scoped fix so the receive-side owner (d2230) can act without coord.

## ⚡ UPDATE 2026-06-19 ~21:50 (su-9140a) — A-003 now OWNED + fixed; the real live-RED cause was the harness window
- **A-003 is OWNED by su-c2a63 (Brief J / ac4d3e7f)** — landed **option (c) replay-on-rebind** (boot.ts:1673-1685:
  onAnnounce BUFFERS the unresolved-home frame as `scope_unresolved`; the rekey rebind calls `retryPendingOnce()`
  to admit the hive-home log at the rebind instant). This is exactly the fix this doc scoped — converged. My own
  fix attempt was reverted, then overwritten by su-c2a63's cleaner version (no stray change of mine remains).
- **🔑 The earlier "A-003 RED" was substantially a TEST-HARNESS artifact, not the receive-side bug.** The matrix's
  discovery poll (40×3s=120s) is too SHORT under fleet load — B's hive-directory gossip hasn't arrived yet → B
  never joins → hive_settings can't cross → looks like A-003 RED. With `DISCOVERY_RETRIES=100` (300s) on a quiet
  box, **B discovered A's hive (rows=2, match=Y), joined, and hive_settings + hive_members CROSSED A→B
  (backfill + incr, remote=ok).** So owner→joiner federation WORKS with proper timing. (Smoke now honors
  `DISCOVERY_RETRIES` env — USE IT for any live A-003/re-key witness on a loaded box, or you false-RED a good fix.)
- **⚠ OPEN: B→A direction** — on my-fix .deb, `hive-settings incr-B→A NEVER crossed (outbox=1)` (joiner→owner
  write-back). Re-testing on su-c2a63's current-tree fix (longer window) to see if their replay-on-rebind covers
  B→A too, or if joiner→owner write-back is the genuine remaining A-003 gap. VERDICT PENDING that run.

## Verdict
🔴 RED on the packaged binary. Integrated `.deb` built from staging (carries the fixes:
`announceSlugInScope=2`, the resolve-then-join reorder). Content-matrix on 2 real peers:
**28 content types PASS**; `hive_settings`/`hive_members` cross in **ZERO** directions
(backfill + incr-A→B + incr-B→A). `hive_settings` is the clean signal (write OK, src
outbox drains 6/6 per d2230's PG dig, B has zero remote). Same result across 2 re-witnesses.

## The conclusive trace (PAPERCUSP_A003_TRACE=1, B's joiner = member `hello-world`)
```
[A-003] boot hello-world:        hiveHomeProjectionSlug=<none>
[A-003] slug-filter hello-world: origin=hello-world      own=hello-world home=<none> → ADMIT   (member log ✓)
[A-003] slug-filter hello-world: origin=hello-world-hive own=hello-world home=<none> → REJECT  (HIVE-HOME LOG DROPPED)
[A-003] resolve hello-world:     joinerHiveHomeSlug=hello-world-hive          ← runs AFTER the reject
[A-003] rekey hello-world:       binding.kind=hive next=hello-world-hive rebind=true
```
**There is NO second/re-admit of `origin=hello-world-hive` anywhere in B's full log** —
the hive-home announce is delivered exactly once (at `home=<none>`), hard-rejected, and
never re-evaluated.

## Localization (splits the two owners)
- **Announce (dc9db's (a′) N-log flush) WORKS** — B genuinely RECEIVES A's hive-home log
  frame (`origin=hello-world-hive` arrives). NOT the bug.
- **Admit (receive-side ordering) is the bug** — B's slug-filter REJECTS the hive-home
  frame because `home=<none>` at admit time; the `resolve` that sets `home=hello-world-hive`
  runs AFTER; and the rejected announce is never replayed. So the hive-home log never
  starts replicating to B → hive_settings/members never cross.
- d2230's resolve-then-join reorder did NOT move the resolve before this admit on the live
  boot path: a peer (00ed5b4d) connects + announces during the `home=<none>` window, before
  resolve completes. **So fix (a) "hoist resolve earlier" alone is insufficient** (racy —
  the frame can always arrive in the gap).

## Scoped fix (receive side — d2230's call)
Needs re-evaluation/replay of the announce after `home` resolves. Two robust options:
- **(b) BUFFER:** when a frame's `origin` is a hive-home candidate (`kind=hive`) and
  `home=<none>`, DON'T hard-reject — hold it (bounded) and re-run admission after resolve.
- **(c) REPLAY-ON-REBIND:** the `rekey … rebind=true` event fires at exactly the moment
  `home` becomes known — use it as the hook to re-request/replay connected peers' announces
  (or re-run seen/buffered frames through the slug-filter) so the hive-home log is admitted
  on the 2nd pass. **(c) is cleanest** (the hook already exists at the right moment).
- **MISSING PRIMITIVE (for dc9db):** a "re-request announces for a topic" or a per-peer
  "last-announce to replay on rebind." That primitive is what (c) needs.

## Reproduction (the red rig)
dc9db's same-topic integration test (2 harnesses on 1 topic via real `bootHarnessSubstrate`)
reproduces this exactly: B's member `onAnnounce` gets `origin=<hive-home>` while `home=<none>`
→ REJECT, no replay. Fix against that red→green, then the `.deb` witness confirms on binary.

## Re-witness harness (ready)
`/tmp/a003-rewitness.sh` (sidecar build from staging → swap into L's fix-.deb → content-matrix,
display :180/:182). Add `PAPERCUSP_A003_TRACE=1` for the `[A-003]` lines. ~10min build + ~10min
matrix. su-9140a will re-witness the instant a (b)/(c) fix lands. The .deb at
`/tmp/a003-rewitness/Papercusp_integrated.deb` carries the current staging if still present.

## su-9140a fix ATTEMPT (implemented, then REVERTED — unvalidated, possible regression)
Implemented option (b) in boot.ts + suite-green (1009/1010), git-sync committed it (0d2067204),
then REVERTED after it could not be validated + a regression concern surfaced. The patch (for
d2230 to apply + validate properly — you own this lane + the D-006 interaction):
- **onAnnounce** (`if (!inScope)`): when `hiveHomeProjectionSlug == null && originSlug != null &&
  originSlug !== slug`, buffer in `pendingPeers` + `return { admit:false, reason:'pending' }`
  instead of conclusive `out_of_scope`.
- **retryPendingOnce** (on `decision.admit`): re-run `announceSlugInScope(originSlug, slug,
  hiveHomeProjectionSlug)`; admit iff in-scope; if out-of-scope && home!=null → conclusive reject;
  else leave pending.
- ⚠ **CAVEAT (why I reverted):** the retryPendingOnce change GATES the EXISTING D-006
  identity-pending admit path behind the slug-filter — a legitimately-pending peer that is
  out-of-scope-with-home=null would be left un-admitted. Needs careful review (could disrupt
  other harnesses' federation, incl. the directory). A more surgical fix should gate STRICTLY to
  the joiner-member-awaiting-rebind case, not all pending peers. Don't apply as-is without validating.

## ⚠ LIVE-WITNESS INFRA FRAGILITY (2026-06-19 PM): B's embedded PG OOM-crashes on the loaded box
TWO matrix runs (#3, #4) failed at B's join: `hiveId and memberLinks[] required` (EXIT=6) — B's
discovery returned empty. ROOT CAUSE (corrected — NOT a discovery-code regression): **B's embedded
Postgres CRASHED.** inst-b.log: `"the database system is shutting down"`, `read ECONNRESET`,
`ECONNREFUSED 127.0.0.1:<B-pg-port>`. A's announce side was fine (joined all topics). B's PG died →
B's discovery API couldn't serve → empty → join failed. = a RESOURCE/OOM issue: the embedded PGs are
configured `shared_buffers≈38GB` each, so two 2-peer pairs (4 PGs) + teardown stragglers starve the
box (it sat at memfree 3–20G under fleet load). NOT my A-003 fix (fired 0×), NOT a code blocker.
IMPLICATION: live witnessing (A-003, the re-key cut-off, any 2-peer join) is FRAGILE on a loaded box —
needs maximal free memory (one pair at a time, all stray pairs killed) OR smaller test-PG shared_buffers.
NOT a release blocker; an infra/test-harness constraint. The A-003 fix below remains unvalidated only
because the box couldn't sustain the witness, not because of any code fault.

## Discovery blocker — CHARACTERIZED (not a stale harness; it's directory-discovery timing/federation)
Ruled OUT harness shape-drift: `GET /api/discovery/hives` returns `{count, rows:[{hiveId, memberLinks,
title, visibility, …}]}` (routes/discovery/hives.ts:54) — EXACTLY what the matrix reads
(`d['rows']`, `r['hiveId']`, `memberLinks`; smoke.sh:164-166). No field/wrapper rename. So the empty
`memberLinks` → join-fail means B's `getHiveDirectory().listDiscoveredHives()` genuinely had NO row for
A's PUBLIC hive within the harness's 120s poll (40×3s). i.e. **B's hive-DIRECTORY never gossiped A's
hive in time.** Relevant: the directory is LAZY-WIRED on B's FIRST browse (hives.ts:25-31
`ensureHiveDirectoryWired`) — B only starts listening on the directory topic when it first polls, then
must receive A's announce over the directory topic/DHT. So the blocker is **directory gossip not
delivering A→B within 120s** — most likely slow DHT on the loaded box (the earlier #1/#2 witnesses, hours
ago + less loaded, got through), OR a directory-federation regression. NEXT to isolate (needs ONE clean
run on a quiet box): poll discovery with a LONGER window + check inst-b for `ensureHiveDirectoryWired` +
directory-topic peer-connect; if it eventually lists A's hive → just slow gossip (raise the harness
window), if never → a real directory-federation regression for the directory lane. NOT yet distinguished.

## Why this is the whole release gate
A-003 is the one live-red federation blocker. Everything downstream is staged (re-key built
+ 32 teeth-tests, held on A-003 green; owner-enforcement EN-2 built; PR-system/dogfood planned).
hive_settings crossing on the binary = A-003 GREEN = the next domino.

---

## RESOLUTION — RE-LAND + GUARD (su-53f39, 2026-06-19 ~17:13 EDT)

**A-003 is GREEN and pinned at HEAD.** Sequence of record:

1. **fix-b = onAnnounce BUFFER + retryPendingOnce SCOPE-RECHECK** (both halves). A hive-home
   announce racing in during the joiner-member's `home=<none>` window is BUFFERED (`pendingPeers.set`,
   reason `pending`, `announce_pending scope_unresolved`) not conclusive-rejected; `retryPendingOnce`
   re-checks `announceSlugInScope` against the resolved `hiveHomeProjectionSlug` after the rekey rebind
   and admits iff in-scope. **ee7e9's live from-repo witness on the 16:19 fix-b serve.mjs PROVED this
   correct** (hive_settings crossed owner→joiner origin=remote, backfill=2 + incremental;
   findings-A003-GREEN-witness-2026-06-19.md).

2. **REGRESSION:** a later rewrite (3bce97bf7 / 4d82a53b3) DROPPED both halves (left only the comment
   markers) → HEAD RED. This was the ~3rd silent revert; c2a63's deterministic regression test caught it.

3. **RE-LANDED (su-53f39):** both halves restored VERBATIM from the known-good 0d2067204.

4. **fix-c (latency hardening) ON TOP:** `rekey()` `await retryPendingOnce()` immediately after the
   home rebind → the buffered hive-home frame replays SYNCHRONOUSLY on rebind instead of waiting up to
   `DEFAULT_PENDING_RETRY_MS` (5s) for the periodic tick. Closes the fast-sampler window. Confirmed by
   ee7e9 as latency hardening, NOT a correctness gate. + a `joinerHiveHomeSlugOverride` boot-opt test
   seam (prod path unchanged).

5. **GUARD:** c2a63's `__tests__/a003-scope-buffer-replay.test.ts` pins the buffer→replay contract —
   RED on the revert, GREEN on the re-land. This is what stops a 4th silent revert.

**On su-9140a's revert CAVEAT** (above: "retryPendingOnce change gates the D-006 identity-pending admit
path → could disrupt other harnesses' federation incl. directory"): ADDRESSED, not ignored. The caveat
was precautionary — su-9140a reverted because the box OOM'd mid-witness and the fix "could not be
validated," NOT because a regression was confirmed (see the LIVE-WITNESS INFRA FRAGILITY note above).
It is refuted by: (a) the scope-recheck is TRANSPARENT to the D-006 path — an absent harness_slug
(legacy/the admission-pending-retry tests) → `announceSlugInScope` returns true → admitted; an
in-scope peer (`origin===own`) → admitted; only a PRESENT-FOREIGN-slug frame is held, which SHOULD be
held (it belongs to a different on-topic harness); (b) ee7e9's from-repo smoke (feature federation +
the directory join path) passed bidirectionally on this exact code; (c) two-hive-shared-swarm +
announce-channel-multihive + read-admission + admission-pending-retry all GREEN.

**Verification (HEAD):** a003-scope-buffer-replay + boot(18) + admission-pending-retry(5) +
two-hive-shared-swarm + two-peer-swarm-bidi + announce-channel-multihive + read-admission = 46 passed.
`tsc --noEmit` boot.ts CLEAN (the ~521 operator-core errors are pre-existing baseline type-debt in
voice/plugin-loader/test-mock files — zero in boot.ts).

**Remaining:** ee7e9 to re-run the A003_MEMBERSHIP_PROBE from-repo witness on a FRESH-HEAD sidecar/.deb
to lock in fix-c on the binary (correctness already proven on the 16:19 build).
