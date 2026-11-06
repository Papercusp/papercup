---
rel_path: "session-recovery/fire120-p005-hung-request-ebe9b-20261106.json"
updated_at: 1793987047894
_body: "content"
---

{
  "harness": "papercusp",
  "slug": "dbos-durability-right-sizing-2026-10-21",
  "spec": {
    "specId": "HUNG-TICK",
    "expectedRevision": 5,
    "sourceValId": null,
    "planItemId": "P-005",
    "behavior": "A managed tick exceeding its declared threshold has one resolvable alarm episode tied to that tick.",
    "behaviorClass": "failure",
    "requiredEvidence": [
      "libs/generic/scheduled-registry/src/index.test.ts",
      "packages/operator-core/lib/dbos/managed-tick-alarm.test.ts",
      "packages/operator-core/lib/dbos/managed-tick-alarm-recovery.test.ts",
      "packages/operator-core/lib/dbos/managed-tick-alarm.integration.test.ts"
    ],
    "requiredTestLayers": [
      "unit"
    ],
    "mutationRequired": false,
    "lifecycleStatus": "active",
    "supersedes": null,
    "exemption": null,
    "falsifier": {
      "observation": "Fail if an alarm raises below or at the held-time threshold, none raises past the held-time threshold within the watcher bound, name/held-time/episode is wrong, each interval creates another alarm, an unrelated tick or reconciler resolves a live or unproven-dead predecessor, or the ending tick fails to resolve it. Log output without actual alarm state is insufficient; DBOS unavailability must not stop raise/resolve. Also fail if a custom value postpones detection beyond the default five-interval threshold with its five-minute floor, or if only a helper test passes without the actual production registration/configuration/watcher alarm path. Also fail if a proven-dead original episode is stranded beyond its watcher bound, repeated/concurrent recovery duplicates resolution or episodes, original timer/held-time/producer-incarnation provenance changes, or a later distinct hang reuses the old episode. Quietness, elapsed time and missing liveness alone are not proof of death.",
      "probeMethod": "Use the current R-6 formula: default D=max(5*intervalMs,300000 ms); for a positive finite customThresholdMs use effective T=min(max(customThresholdMs,300000 ms),D); absent, invalid or non-finite custom values use D. Exercise the actual registered timer, production configuration path and independent watcher with DBOS unavailable. Hold one tick and inspect real alarm state below T, at T, past T and by the next watcher check, whose interval is <=min(intervalMs,60000 ms). Test intervals below and above 60000 ms, custom values below the floor and above D, and months/years values such as31536000000 ms; for interval60000 ms that value must produce T=300000 ms. Check exact raise/resolve calls, timer identity and elapsed held time, one episode across repeated checks, resolution when that same tick finishes and a new episode for a later hang. Inject an uncapped huge-custom configuration and require the control to fail.\n\nD-011/D-014 and approved final R-6 revision9: on the real existing alarm/condition state, use maintained fresh-process controls for raise-before-exit, producer-exit-before-resolve, restart/reconcile, repeated and concurrent reconciliation, a later distinct episode, and an alive predecessor that must stay open. Retain stable original episode, timer, held duration and producer/run incarnation; inspect actual condition state and the unchanged original envelope. Only authoritative proof that the producing incarnation ended and cannot still complete permits independent reconciliation on behalf of that original tick. Quietness, elapsed time, an unavailable liveness read and a live successor are not proof of death. With DBOS unavailable, require exactly one resolution within the original watcher interval, including boot time; repeat recovery as a no-op. Include the already-idle surviving watcher with a short-cadence external producer. Fail stranded orphan alarms, duplicate episodes/resolution, premature live-predecessor resolution, unknown death treated as dead or lost original provenance. Preserve ordinary same-tick settlement and every threshold/clamp/production-wiring control above. Reuse existing attention/condition and runtime-liveness surfaces; no parallel alarm store or scheduler. A retained focused pass keeps its measured source/runner/custody scope; unavailable native packet or deployed-window evidence stays unknown."
    },
    "acceptanceRef": "acceptance-dbos-durability-right-sizing-2026-10-21@9:R-6",
    "sourceBar": null
  }
}
