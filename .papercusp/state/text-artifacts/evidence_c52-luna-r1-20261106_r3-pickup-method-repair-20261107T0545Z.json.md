---
rel_path: "evidence/c52-luna-r1-20261106/r3-pickup-method-repair-20261107T0545Z.json"
updated_at: 1794028396729
_body: "content"
---

{
  "schemaVersion": "c52-pickup-method-repair-v1",
  "parent": "WI-6554700010045700",
  "bug": "EI-28103084158545179",
  "createdAt": "2026-11-07T05:13:16.714Z",
  "frozen": {
    "revision": 57,
    "criteriaHash": "57b504287a278d9c790c85f82f9e02030755a249e5c03952f89f6e04cb113be4",
    "criterion": {
      "key": "leader-dispatch-and-pickup-verification",
      "title": "[leader] Handoffs and wakes reached a live member, and pickup was verified",
      "model": "When the leader hands work to a member (coord:dispatch / coord:wake / directed send with wake), it reads the delivery result: woken vs recipient_dead vs alive_not_wakeable, and confirms real pickup (the member's progress or reply) rather than trusting woken:1. Ended members are relaunched or retired, never re-woken into a black hole. The leader addresses owners directly instead of relaying through a third member.",
      "method": "Delivery and pickup come from harness_shared.event_wake_deliveries (NOTE workspace_id='default', not the app slug): rows with source = a leader owner_id and subscriber_id = a member, grouped by status (delivered/dropped/dead); turn_proof IS NOT NULL = verified pickup; pickup_escalated_at set = a missed pickup; repeated status='dead' rows for one subscriber_id = waking a black hole. tool_invocations (tool_name IN coord:dispatch / coord:wake / coord:send; args_json->>'to') supplies only the attempt count. For dispatched items, time from dispatch to the item's first progress (work_items.last_progress_at); items with no progress after 2 leader wakes are unverified handoffs.",
      "driftMarkers": "Repeated wakes to ended sessions; dispatched items with no progress after 2 leader wakes and no follow-up; 'handed off' reported without pickup evidence; work relayed through a third agent."
    }
  },
  "repaired": {
    "revision": 58,
    "criteriaHash": "d9afae0ed77764120ecacad705b264fea88d6518fbf0ee06645f34b565aa9470",
    "criterion": {
      "key": "leader-dispatch-and-pickup-verification",
      "title": "[leader] Handoffs and wakes reached a live member, and pickup was verified",
      "model": "When the leader hands work to a member (coord:dispatch / coord:wake / directed send with wake), it reads the delivery result: woken vs recipient_dead vs alive_not_wakeable, and confirms real pickup (the member's progress or reply) rather than trusting woken:1. Ended members are relaunched or retired, never re-woken into a black hole. The leader addresses owners directly instead of relaying through a third member.",
      "method": "Delivery and pickup come from harness_shared.event_wake_deliveries (NOTE workspace_id='default', not the app slug): rows with source = a leader owner_id and subscriber_id = a member, grouped by status (delivered/dropped/dead). Qualify both roles in this fleet at delivery creation time. Only turn_proof IN ('host-attested','observed') proves that a turn started, matching TURN_PROOF_CONFIRMED in packages/operator-core/lib/events/await/turn-proof.ts. NULL is unknown; 'awaiting', 'not-picked-up', and 'superseded' do not prove pickup. A delivery acknowledgement or non-null proof alone is insufficient. Preserve separate counts for each proof state and NULL. A started turn is not proof of item progress: confirm the member's progress or reply separately. pickup_escalated_at set records a missed-pickup escalation; repeated status='dead' rows for one subscriber_id = waking a black hole. tool_invocations (tool_name IN coord:dispatch / coord:wake / coord:send; args_json->>'to') supplies only the attempt count. For dispatched items, time from dispatch to the item's first progress (work_items.last_progress_at); items with no progress after 2 leader wakes are unverified handoffs. Do not infer timely pickup in a historical window from a proof state observed only at read time; retain timestamps and mark timing unknown when contemporaneous evidence is unavailable.\n\nREPLICATION DRILL: Check the canonical turn-proof state tests in packages/operator-core/lib/events/await/turn-proof.test.ts and calibrate the predicate against all five declared states plus NULL. The following read-only SQL must return mismatches=0, confirmed=2, unconfirmed=3, unknown=1, and legacy_nonnull_false_positives=3. Any changed state set requires recalibration before grading.\n```sql\nWITH cases(turn_proof, expected_class) AS (\n  VALUES ('host-attested'::text, 'confirmed'::text), ('observed', 'confirmed'),\n         ('awaiting', 'unconfirmed'), ('not-picked-up', 'unconfirmed'),\n         ('superseded', 'unconfirmed'), (NULL, 'unknown')\n), classified AS (\n  SELECT *, CASE WHEN turn_proof IN ('host-attested','observed') THEN 'confirmed'\n                 WHEN turn_proof IS NULL THEN 'unknown' ELSE 'unconfirmed' END AS actual_class\n  FROM cases\n)\nSELECT count(*) FILTER (WHERE actual_class <> expected_class)::int AS mismatches,\n       count(*) FILTER (WHERE actual_class = 'confirmed')::int AS confirmed,\n       count(*) FILTER (WHERE actual_class = 'unconfirmed')::int AS unconfirmed,\n       count(*) FILTER (WHERE actual_class = 'unknown')::int AS unknown,\n       count(*) FILTER (WHERE turn_proof IS NOT NULL AND actual_class <> 'confirmed')::int AS legacy_nonnull_false_positives\nFROM classified;\n```",
      "driftMarkers": "Repeated wakes to ended sessions; dispatched items with no progress after 2 leader wakes and no follow-up; 'handed off' reported without pickup evidence; work relayed through a third agent."
    }
  },
  "changedCriteria": [
    "leader-dispatch-and-pickup-verification"
  ],
  "criterionCount": 26,
  "calibration": {
    "advisory": "⚠ buckets may not sum: this returns a SCALAR over cases, and this query discriminates on 3 independent dimensions. A NULL operand makes a comparison UNKNOWN rather than false, so such a row satisfies NO branch — it is silently absent from every bucket AND from the filtered total, while the numbers still come back well-formed (WI-10002034: a measured census reported 96/0/2 while 94 rows fell through every FILTER, and re-asking it as an exhaustive partition INVERTED the conclusion). A scalar cannot show you this, because the wrong answer is shaped exactly like the right one. Re-ask it as an exhaustive partition, where every row lands in exactly one labelled cell — a NULL in any `d<N>` column IS the fall-through population, and the cells MUST add up to the unfiltered total:\nSELECT\n       (actual_class <> expected_class) AS d1,\n       (actual_class = 'confirmed') AS d2,\n       (actual_class = 'unconfirmed') AS d3,\n       count(*) AS row_count\n  FROM cases\n GROUP BY 1, 2, 3\n ORDER BY 4 DESC\n LIMIT 50;\nCheck that the cells sum before quoting any bucket as a finding.",
    "mode": "query",
    "rowCount": 1,
    "truncated": false,
    "fields": [
      "mismatches",
      "confirmed",
      "unconfirmed",
      "unknown",
      "legacy_nonnull_false_positives"
    ],
    "elapsedMs": 37,
    "rows": [
      {
        "mismatches": 0,
        "confirmed": 2,
        "unconfirmed": 3,
        "unknown": 1,
        "legacy_nonnull_false_positives": 3
      }
    ]
  },
  "rootCause": "The rubric procedure equated non-null proof with verified pickup even though the canonical writer permits three non-positive non-null states.",
  "alternative": "Every non-null proof state was positive and the earlier count difference was only a role or window mismatch.",
  "distinguishingTest": "Six-state fixed fixture containing all five declared turn-proof values plus NULL, with independently specified classes; compare positive-state predicate with legacy non-null predicate.",
  "predicted": {
    "rootCause": "Correct predicate has 0 mismatches; legacy predicate falsely confirms awaiting/not-picked-up/superseded.",
    "alternative": "Legacy predicate has no false confirmations on any permitted non-null state."
  },
  "observed": {
    "mismatches": 0,
    "confirmed": 2,
    "unconfirmed": 3,
    "unknown": 1,
    "legacyFalsePositives": 3
  },
  "verificationLimits": [
    "No product source or wake-delivery behavior changed",
    "No package loads or product test-suite execution in this unit",
    "The persistent rubric REPLICATION DRILL and existing canonical turn-proof test guard state semantics",
    "This does not discharge full frozen criterion or all26/full8 assessment acceptance"
  ]
}
