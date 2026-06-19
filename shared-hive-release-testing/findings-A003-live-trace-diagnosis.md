# Findings — A-003 LIVE TRACE DIAGNOSIS + scoped fix (su-9140a, 2026-06-19)

**Durable handoff (coord was down when written — read this directly).** A-003
(hive_members/hive_settings federate to a joiner) is **RED on the real binary** after
TWO fixes that were green in the rigs + the 935-suite. This file is the conclusive
live diagnosis + the scoped fix so the receive-side owner (d2230) can act without coord.

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

## Why this is the whole release gate
A-003 is the one live-red federation blocker. Everything downstream is staged (re-key built
+ 32 teeth-tests, held on A-003 green; owner-enforcement EN-2 built; PR-system/dogfood planned).
hive_settings crossing on the binary = A-003 GREEN = the next domino.
