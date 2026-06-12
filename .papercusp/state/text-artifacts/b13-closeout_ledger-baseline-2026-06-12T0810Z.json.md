---
rel_path: "b13-closeout/ledger-baseline-2026-06-12T0810Z.json"
updated_at: 1781251629035
_body: "content"
---

{
  "purpose": "B-13 gate-2 wake: improvement_dispatches ledger baseline (B-04 landed). Diff target for the supervision leg.",
  "gateStatus": { "ledger-landed": "FIRED 08:05Z", "spawn-fixed": "pending (await 850)", "B-05:done": "pending (await 852)" },
  "migration238": {
    "appliedToLiveDb": true,
    "evidence": "db:check_drift lists 238-improvement-dispatches-ledger.sql in `extra` (= in schema_migrations; drift tool reads the RELEASE checkout's sql dir, which predates the file). missing=[] — applied via runner, EI-353 discipline followed. 239-learning-pack-candidates.sql (B-11) also applied.",
    "stateModelReviewOk": "fire-failed terminal at fire time; worker-death = open past overdue (P-011 target); in-progress = ok+NULL under threshold — disjoint buckets, P-010 acceptance criterion satisfied. closeDispatchesForItem closes ALL open rows per item (no stranded-row orphan false-positives). Write side swallows+warns (accounting never blocks dispatch) — a recordDispatchFired failure means a ledger-invisible dispatch; watch for the '[dispatch-ledger] FAILED to record' warn during supervision.",
    "overdueThreshold": "PAPERCUSP_IMPROVEMENT_DISPATCH_OVERDUE_MS, default 2h"
  },
  "tableBaseline_0810Z": {
    "rows": 2,
    "buckets": [{ "fire_result": "ok", "outcome": null, "count": 2 }],
    "detail": "both item_id='EI-LIVE' (B-04's live-write probes, fired 08:06:01Z, runner_harness='improvement-runner-harness', spawned_run_id null, open)",
    "supervisionRule": "EXCLUDE item_id='EI-LIVE' from the first-10-dispatch count; expect these 2 to be marked 'orphaned' ~10:06Z once B-05's collector is live (synthetic, not evidence of a real worker death) — unless B-04 closes them first (flagged via coord 08:11Z)."
  }
}
