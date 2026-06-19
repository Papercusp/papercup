# Brief H — A-002: an instance hosting 2 hives stalls federation

**Priority: S1 lane.** Live + substrate. Coordinate via the
`shared-hive-live-instances` lock (shares `swarm.ts` with Brief K).

## Objective
Reproduce **A-002 live**, build a teeth-verified unit demonstrator, implement the
fix (per-hive announce-channel discrimination on the shared muxer), and gate it on
a **2-hive live pass** while the single-hive pass stays GREEN.

## Why it matters for release
Real deployments host more than one hive per box. Today, standing up a 2nd hive on
an instance **stalls the 1st hive's federation entirely, both directions** — a
silent, total break. The fresh-boot content-matrix only passes because it runs
`SKIP_INVITE=1` (single hive) to dodge this. That dodge is not a release posture.

## Root cause (already pinned — EI-1590 post 46429, su-963ee)
`swarm.ts` runs **one announce channel per socket/muxer** (single
`ANNOUNCE_PROTOCOL`; `createAnnounceChannel` does
`mux.createChannel({protocol: ANNOUNCE_PROTOCOL})` and on a duplicate returns
`null` → sends nothing, `swarm.ts:146-150`; `announcePairedMuxers` /
`announceOptsByMuxer` key by muxer alone, "last-writer-wins", `:112-115`). With 2
local hives sharing the singleton swarm, a peer's fresh connection fires both
hives' handlers on one muxer → the first to `createChannel` wins the lone announce
channel; the 2nd hive's admission exchange is silently dropped → that hive's log is
never admitted → zero apply both directions (while `peer_connected` + topic-equal
still pass, which is why it looks healthy). `add-hive-2-AFTER` works because the
muxer already holds hive-1's channel — that asymmetry is the tell.

## Scope / scenarios
1. **Live repro:** on a fresh pair, A creates+publishes a PUBLIC hive **and** an
   INVITE hive (i.e. run the content-matrix WITHOUT `SKIP_INVITE`, or add a 2nd
   hive to the running pair). Assert the 1st hive's incremental federation that
   passed single-hive now **stalls** (no `origin=remote` within the bounded poll).
2. **Unit demonstrator (teeth-verified):** `createAnnounceChannel` called twice on
   one muxer → the 2nd returns `null` / drops its announce. Needs a small
   test-export seam in `swarm.ts`. RED before the fix, GREEN after.
3. **Fix:** discriminate the announce channel **per hive** on the shared muxer —
   per-hive Protomux channel id (e.g. keyed by hive topic hex); key the
   WeakSet/WeakMap by `muxer × topic`, not `muxer` alone.
4. **Regression gate:** 2-hive live pass GREEN **and** the single-hive content
   matrix still GREEN; full hyperbee suite (862) no-regression.

## Method
- Live: reuse the smoke harness without `SKIP_INVITE`; verify via each peer's
  embedded-PG `origin` column. Unit: `cd packages/operator-core && npx vitest run`.
- This is a load-bearing substrate change — same bar as D-001. Land behind the
  demonstrator + the live 2-hive pass, not a drive-by.

## Deliverables
- `findings-H.md`: live repro evidence, the demonstrator, the fix, the gate results.
- The per-hive announce-channel fix + a permanent regression test (the demonstrator).

## Done / verdict
GREEN only when 2 hives on one instance both federate (both directions), the
single-hive matrix is unchanged, and the demonstrator + suite are green.
