# Federation "0 rows" with healthy connections — check the WRITE's workspace_id before blaming the drain
URL: /internal/docs/agent-insights/federation-zero-rows-check-write-side-workspace-first

WI-5399 (gate 171529/184041): restart_durability + reconnect_catchup + soak + revocation all red with owner→member content never landing, swarm peer_connected healthy, and ZERO [outbox-drain] log lines. Three sessions chased pairing, zombie connections, and hung drain promises. The real cause: scenario write helpers resolved workspace_id via an unordered `(SELECT workspace_id FROM harness_shared.pot_members LIMIT 1)`; when the new federation legs (orders 55-57) federated IN foreign pot_members cards (origin=remote, papercusp-workspace), the LIMIT 1 became a lottery and flipped — every subsequent scenario write was stamped with a workspace no drain scope selects (drain filters WHERE workspace_id = handle boot workspace). Rows sit drained_at=NULL forever with NO error anywhere: the drain is healthy, the rows are invisible to it. Fix: resolve the frame''s OWN workspace deterministically — WHERE coalesce(origin,''local'')=''local'' ORDER BY joined_at LIMIT 1 (17 call sites).

## The trap

A federation leg fails with **owner→member content probes returning "0 rows"**
while everything that is easy to check looks healthy: swarm `peer_connected`
re-established on all topics, topic-gossip self-healing, repair-ladder /
forceRejoin firing normally, `content_bidir` green earlier in the SAME run.
The reflex diagnosis chain — DHT re-pairing → zombie connection → stalled
replication → hung outbox-drain promise — burned three sessions on WI-5399
(and this leg had been red on EVERY gate run, previously unowned as EI-13317).

**The decisive, cheap check nobody ran first:** look at the stuck rows
themselves.

```sql
SELECT key, workspace_id, drained_at
  FROM harness_shared.substrate_outbox
 WHERE harness_slug='<slug>' ORDER BY ts;
```

On gate run 184041 this showed a perfect split: every drained row
`ws=workspace-rig17e1fcff`, every stuck row `ws=papercusp-workspace`.
The drain pass selects `WHERE workspace_id = <handle boot workspace>`
(outbox-drain.ts) — a row stamped with any other workspace matches **no
drain's scope, ever**. No error fires because nothing is failing: the drain
truthfully sees zero rows for its scope. Restarts don't help (catch-up-on-start
scans the same scope). It looks exactly like a permanent, silent,
restart-surviving replication stall.

## Why the workspace flipped mid-run

The rig scenario write helpers resolved the workspace with an **unordered**
`COALESCE((SELECT workspace_id FROM harness_shared.pot_members LIMIT 1),'default')`
(D-050). That was fine while `pot_members` had only the frame's own rows. The
new federation legs (orders 55–57: fleet\_directory / seat\_offer /
spawn\_request) **federate IN foreign pot\_members cards** (`origin='remote'`,
`papercusp-workspace`, old fed\_ts) — after which the unordered `LIMIT 1` is a
4-row planner lottery. On 184041 it flipped between two writes 2 seconds apart
(WI-1 drained 23:03:39Z; F-RD-INIT stuck 23:03:41Z), right at the order-58→80
boundary — which is also why the failure correlated so convincingly (and so
misleadingly) with the member-offline step. Planner non-determinism also
explains the historical flakiness and run 171529's soak asymmetry (B→A
recovering in cycles 4–5 while A→B never did).

## The fix (applied 2026-07-18, 17 call sites, 7 files)

Resolve the frame's OWN membership, deterministically:

```sql
COALESCE((SELECT workspace_id FROM harness_shared.pot_members
           WHERE coalesce(origin,'local')='local'
           ORDER BY joined_at LIMIT 1),'default')
```

`origin='local'` excludes federated-in cards; `ORDER BY joined_at` makes the
pick stable if a frame ever legitimately joins multiple pots. Validated live
against the polluted 4-row table: returns the correct workspace 3/3.

## The generalized lessons

1. **"0 rows federated" is a WRITE-side symptom until proven otherwise.**
   Before touching swarm/pairing/drain layers, SELECT the stuck outbox rows and
   compare their `workspace_id` (and `harness_slug`) against the drain scope
   the boot log prints (`[wire-presence] wired <ws>::<slug>`).
2. **Silence is evidence.** outbox-drain.ts logs loudly on every guarded
   failure (pass timeout WI-2009, quarantine WI-3896, SESSION\_CLOSED WI-3684,
   CONNECTION\_ENDED EI-13917). Zero `[outbox-drain]` lines during a
   multi-minute "stall" means the drain is NOT failing — stop investigating it.
3. **Never resolve a scope with an unordered `LIMIT 1`** on a table that
   federation (or any concurrent writer) can grow — it is deterministic right
   up until the day it isn't, and the failure lands somewhere else entirely.
