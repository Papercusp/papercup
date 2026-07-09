# Brief H — A-002: an instance hosting 2 pots stalls federation

**Priority: S1 lane.** Live + substrate. Coordinate via the
`shared-pot-live-instances` lock (shares `swarm.ts` with Brief K).

## Objective
Reproduce **A-002 live**, build a teeth-verified unit demonstrator, implement the
fix (per-pot announce-channel discrimination on the shared muxer), and gate it on
a **2-pot live pass** while the single-pot pass stays GREEN.

## Why it matters for release
Real deployments host more than one pot per box. Today, standing up a 2nd pot on
an instance **stalls the 1st pot's federation entirely, both directions** — a
silent, total break. The fresh-boot content-matrix only passes because it runs
`SKIP_INVITE=1` (single pot) to dodge this. That dodge is not a release posture.

## Root cause (already pinned — EI-1590 post 46429, su-963ee)
`swarm.ts` runs **one announce channel per socket/muxer** (single
`ANNOUNCE_PROTOCOL`; `createAnnounceChannel` does
`mux.createChannel({protocol: ANNOUNCE_PROTOCOL})` and on a duplicate returns
`null` → sends nothing, `swarm.ts:146-150`; `announcePairedMuxers` /
`announceOptsByMuxer` key by muxer alone, "last-writer-wins", `:112-115`). With 2
local pots sharing the singleton swarm, a peer's fresh connection fires both
pots' handlers on one muxer → the first to `createChannel` wins the lone announce
channel; the 2nd pot's admission exchange is silently dropped → that pot's log is
never admitted → zero apply both directions (while `peer_connected` + topic-equal
still pass, which is why it looks healthy). `add-pot-2-AFTER` works because the
muxer already holds pot-1's channel — that asymmetry is the tell.

## Scope / scenarios
1. **Live repro:** on a fresh pair, A creates+publishes a PUBLIC pot **and** an
   INVITE pot (i.e. run the content-matrix WITHOUT `SKIP_INVITE`, or add a 2nd
   pot to the running pair). Assert the 1st pot's incremental federation that
   passed single-pot now **stalls** (no `origin=remote` within the bounded poll).
2. **Unit demonstrator (teeth-verified):** `createAnnounceChannel` called twice on
   one muxer → the 2nd returns `null` / drops its announce. Needs a small
   test-export seam in `swarm.ts`. RED before the fix, GREEN after.
3. **Fix:** discriminate the announce channel **per pot** on the shared muxer —
   per-pot Protomux channel id (e.g. keyed by pot topic hex); key the
   WeakSet/WeakMap by `muxer × topic`, not `muxer` alone.
4. **Regression gate:** 2-pot live pass GREEN **and** the single-pot content
   matrix still GREEN; full hyperbee suite (862) no-regression.

## Method
- Live: reuse the smoke harness without `SKIP_INVITE`; verify via each peer's
  embedded-PG `origin` column. Unit: `cd packages/operator-core && npx vitest run`.
- This is a load-bearing substrate change — same bar as D-001. Land behind the
  demonstrator + the live 2-pot pass, not a drive-by.

## Deliverables
- `findings-H.md`: live repro evidence, the demonstrator, the fix, the gate results.
- The per-pot announce-channel fix + a permanent regression test (the demonstrator).

## Done / verdict
GREEN only when 2 pots on one instance both federate (both directions), the
single-pot matrix is unchanged, and the demonstrator + suite are green.
