# Testing shared-hive/substrate federation via direct PG? Set fed_ts, not just ts
URL: /internal/docs/agent-insights/testing-federation-set-fed-ts

The federated last-writer-wins merge is guarded by the fed_ts column, not ts/updated_ts. writeToPg upserts with ON CONFLICT DO UPDATE WHERE EXCLUDED.fed_ts >= table.fed_ts, so a raw PG INSERT/UPDATE that sets ts and updated_ts but leaves fed_ts stale gives the merge inconsistent ordering keys. The visible symptom is a FALSE convergence bug — two peers concurrently updating the same federated row appear to diverge permanently, and rows can look internally inconsistent (vanished row, author/title mismatch). It is the test write that is wrong, not the merge. Set fed_ts to the intended LWW timestamp on every direct write to a federated consolidated table (harness_features_consolidated, harness_issues_consolidated) and concurrent conflicts converge in seconds, as the real app does (its projection writeToPg sets fed_ts for you).

When you exercise shared-hive federation by writing directly to the consolidated
PG tables (a fast way to drive two live instances without the UI), the merge can
look badly broken: two peers that update the **same row** at the **same time**
diverge and never reconcile, and the row state can go internally inconsistent.
That is almost always a **test artifact**, not a merge bug.

## Why

Federated LWW is keyed on the **`fed_ts`** column, not `ts`/`updated_ts`. The
projection's `writeToPg` upserts with:

```sql
ON CONFLICT (...) DO UPDATE SET ... WHERE EXCLUDED.fed_ts >= <table>.fed_ts
```

So an op only lands if its `fed_ts` is at least the row's current `fed_ts`. The
op's wire `ts` becomes `fed_ts` on the receiving side. A raw `UPDATE ... SET
title=..., ts=..., updated_ts=...` that **omits `fed_ts`** leaves the local row's
`fed_ts` stale, so each peer's guard rejects the other's incoming op — they
diverge, and downstream you can see a vanished row or a row whose `author_pubkey`
and content disagree.

## The fix (for your test)

Set `fed_ts` to the LWW timestamp you intend, on every direct write:

```sql
UPDATE harness_shared.harness_features_consolidated
  SET title=$1, ts=$2, updated_ts=$2, fed_ts=$2   -- fed_ts is the one that matters
  WHERE feature_id=$3;
```

With `fed_ts` set, a concurrent same-field conflict converges to a single value
on both peers in a few seconds (verified live, two `.deb` instances). The real
app never hits this — its write path goes through the projection, which stamps
`fed_ts`. Only direct-PG test harnesses need to remember it.

## Also worth knowing

* Exactly two record types federate (carry `capture_substrate_outbox_trg`):
  `harness_features_consolidated` and `harness_issues_consolidated`. The other
  `*_consolidated` tables (messages, agent\_chats, supervisor\_notes, …) are
  local-only by design — don't expect them to cross.
* `author_pubkey` is empty on the author's own local row and stamped with the
  author's device pubkey on the receiver (provenance, P-002) — that asymmetry is
  correct, not a mismatch.
