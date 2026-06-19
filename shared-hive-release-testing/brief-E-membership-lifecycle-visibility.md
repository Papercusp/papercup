# Brief E — Membership lifecycle & visibility transitions

**Priority: S1 lane.** Integration + some live (coordinate the live harness via the
`shared-hive-live-instances` lock with A and G).

## Objective
Prove every membership and visibility transition is correct AND has the right
federation/directory consequence — including the dangerous ones (going private
must actually stop exposure; removing a member must actually cut them off).

## Why it matters for release
Lifecycle bugs are silent and serious: a hive that "went private" but still
federates, or a removed member who keeps syncing, is a privacy incident.

## Scope / scenarios
1. **Join paths:** via member link, via invite link+secret, re-join after leaving,
   join a hive you used to own. Each ends with the joiner on the correct topic +
   admitted + backfilled.
2. **Leave / withdrawal:** a peer leaves → its tombstone removes its presence/rows
   on others (`leave-hive-tombstone-federation`); the leaver stops receiving new
   content. Generalize beyond presence to all member-scoped data.
3. **Member remove (by owner):** owner removes B → B is cut off (no new content,
   can't write) AND B's existing rows are handled per policy
   (`hive-membership-teardown-federation`). Verify the REMOVED peer's later
   writes are rejected by honest peers (ties to Brief C revocation).
4. **Visibility transitions — the critical ones:**
   - `private → public`: now discoverable + lists in the directory.
   - `public → private`: **withdraws** from the directory AND stops federating to
     non-members (verify with a probing non-member; ties to Brief C privacy).
   - `public ↔ invite`: invite never leaks on the global topic; only secret-holders
     list it. (`hive-set-listing`, `unlist-hive-rows`, `discovery/set_hive`,
     `hive-directory-live-two-peer`.)
   - Re-publish after going private → re-keys / re-exposes correctly.
5. **Dissolve:** owner dissolves the hive (`hive_dissolve`) → all peers tear down,
   no orphaned federation, no resurrecting rows.
6. **Re-join after long offline:** a member offline for a long time re-joins and
   catches up (ties to Brief F backfill) without duplicating or losing data.

## Method
- Integration for the federation/directory consequences; a live pass (with Brief
  A's harness) for the end-to-end private-flip and member-remove (the highest-risk
  ones), confirming the cut-off peer truly sees nothing new.

## Deliverables
- `findings-E.md`: a transition table (transition × {federation effect, directory
  effect, member-access effect} × tested/verdict) + any leak/cut-off failure (S0).

## Done / verdict
GREEN only when every transition has the correct + tested consequence, and
specifically a `public→private` flip and a member-remove are PROVEN (live) to cut
off the affected peer with zero further exposure.
