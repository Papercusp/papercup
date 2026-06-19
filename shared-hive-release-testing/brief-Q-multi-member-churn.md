# Brief Q — Live multi-member hives + membership churn

**Priority: S1 lane.** Live (3+ members). Beyond the 2-peer owner+joiner witness.

## Objective
Prove a hive with **3+ live members** federates correctly while members **join,
leave, and re-join under load** — content reaches all members, late joiners
backfill, departures are clean, and convergence holds throughout.

## Why it matters
Every live witness was **2 peers** (one owner + one joiner). Real hives are N-member:
multiple people join a shared hive, some leave, new ones arrive mid-stream. N (rig)
covered N-peer at the in-process level, but the LIVE packaged path with real
identities + real joins has never been exercised past 2. Membership churn is where
admission, backfill cursors, and the hive-home federation (A-003) interact in ways a
static 2-peer pair can't show. (Note the box's 2-gh-identity limit — see Method.)

## Scope / scenarios
1. **3+ member fan-out:** owner A + members B, C (D…). Each joins; assert ALL members
   receive each other's content (origin=remote) + late joiners backfill the full set.
2. **Join under load:** members join WHILE content is actively being written; assert
   no lost ops, the joiner backfills + catches up to live.
3. **Leave + re-join:** a member leaves (clean), then re-joins → re-backfills without
   duplication / cursor confusion; assert no double-apply.
4. **Concurrent joins:** two members join at the ~same time; both end up fully synced.
5. **Member-list (hive_members) consistency:** as members join/leave, every member's
   view of the membership converges (depends on A-003's hive-home federation — gate
   this lane behind A-003 landing, or assert it RED-pending if A-003 isn't fixed yet).

## Method
- The box has only **2 gh identities** for the *live packaged* path (a 3rd reusing the
  owner identity corrupts admission — findings A-NOTE). For 3+ members use either (a)
  container/VM peers with distinct identities, or (b) the `composition-rig` /
  `_cross-peer-rig` N-member integration path with a real testnet DHT — state which,
  and `log()` the coverage boundary. Live 2-member churn (join/leave/rejoin) IS doable
  on the packaged path; do that for real, rigs for 3+.

## Deliverables
- `findings-Q.md`: the N-member matrix (fan-out, join-under-load, leave/rejoin,
  concurrent), any loss/dup/cursor bug, the live-vs-rig coverage boundary.

## Done / verdict
GREEN only when 3+ members converge across all content types under join/leave/rejoin
churn, late joiners backfill fully, and member-list state converges (post-A-003).
