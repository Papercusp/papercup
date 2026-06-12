---
rel_path: "b13-closeout/gate-state-2026-06-12T0817Z.json"
updated_at: 1781252117680
_body: "content"
---

{
  "purpose": "B-13 gate tracker + pending checks for the supervision leg (P-013).",
  "gates": {
    "consume-edges:ledger-landed": "FIRED 08:05Z — verified (see ledger-baseline-2026-06-12T0810Z.json)",
    "consume-edges:B-05:done": "FIRED 08:14Z — verified: papercusp-orphaned-dispatch registered watchdog.ts:1279, routeExhaustedImprovementToHuman wired improvement-actions.ts:332 (every tick, flag-OFF too, fresh-final-claim excluded), 67 tests green across 5 files, EI-365 resolved by B-05",
    "consume-edges:spawn-fixed": "PENDING (await 850, expires 11:48Z) — fix LANDED per coord (su-973fd restarted :3170 with EI-334 fix ~08:08; identity default su-http-loopback + invalid_input error coding); awaiting B-02's end-to-end spawn proof emit"
  },
  "pendingChecksAtSupervision": [
    "EI-LIVE probe rows (2, open, fired 08:06Z): B-04 pinged twice (me 08:07Z, B-05 08:14Z) to drive terminal before ~10:06Z overdue. CONTINGENCY: if still open ~09:50Z, close via closeDispatchesForItem-equivalent myself and notify B-04 — else B-05's collector files a junk signal for nonexistent item EI-LIVE.",
    "su-973fd's EI-334 error-coding change broke agent-mcp artifacts.test.ts expectation (flagged by su-819db 08:10Z) — confirm B-02 synced it before counting their lane done.",
    "Exclude item_id='EI-LIVE' from first-10 dispatch count.",
    "Watch dispatch journal for '[dispatch-ledger] FAILED to record' warns (ledger-invisible dispatches).",
    "Wedge-pool re-entry ~09:21Z (backfilled assigned_at 03:21 local + 2h stale-claim) — first real dispatches likely shortly after; 'skipped: N in-flight' baseline = 49, must drain toward ~4-5.",
    "OWNER NOTIFICATION required before live supervision starts (P-013 needs-human; brief: run WITH owner watching; no done-flip without owner sign-off)."
  ],
  "eiReconciliationDelta": { "EI-365": "RESOLVED by B-05 08:14Z (was open at 07:55Z baseline)" }
}
