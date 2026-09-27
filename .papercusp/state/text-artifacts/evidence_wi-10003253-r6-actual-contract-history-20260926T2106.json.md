---
rel_path: "evidence/wi-10003253-r6-actual-contract-history-20260926T2106.json"
updated_at: 1790456847267
_body: "content"
---

{
  "observedAt": "2026-09-26T21:06:38Z",
  "parent": "WI-10003253",
  "sourceFix": "EI-24358165094633721",
  "actualContracts": [
    {
      "rubricRef": "goal-mode-e2e",
      "currentRevision": 46,
      "immutableAuditSeq": 45,
      "keysAndScalePreserved": true,
      "preservedCriteria": [
        "portfolio-activity-floor",
        "task-brief-effectiveness"
      ],
      "criteriaHash": "863413415cd8cff4fa5e28d06ba600b1343b5fc9bb780b0ff6ead8dcb4602be6"
    },
    {
      "rubricRef": "work-on-everything-stewardship-health",
      "currentRevision": 26,
      "immutableAuditSeq": 25,
      "baselineAuditSeq": 22,
      "keysAndScalePreserved": true,
      "preservedCriteria": [
        "worklist-authority-and-priority",
        "end-to-end-stewardship-closure",
        "plan-fleet-materialization"
      ],
      "onlyChangedCriterion": "blender-feedback-and-disposition",
      "criteriaHash": "35a0d21f880d6d4b3f0bb940ed586d871185bbf42f43c27ff96b0ca1151b63f9"
    }
  ],
  "sampledHistoricalCards": [
    {
      "ids": [
        "EI-24025333199380204",
        "EI-23889280375118743"
      ],
      "rubricRef": "work-on-everything-stewardship-health",
      "storedRubricRevision": 21,
      "matchedImmutableAuditSeq": [
        20
      ],
      "criteriaHash": "9210e0e6b2533c151775454b1c1e2489776cbfe16b141d5440b5b768e8b0c121",
      "matchMethod": "Stored immutable enriched criteriaHash"
    },
    {
      "ids": [
        "EI-24025141569545679",
        "EI-24017310395602575"
      ],
      "rubricRef": "goal-mode-e2e",
      "storedRubricRevision": 43,
      "matchedImmutableAuditSeq": [
        41,
        42
      ],
      "criteriaHash": "a5b9c2a53f3d53907162f12b9f29d977a0c8e02cd908744e10b437bade98c2ee",
      "matchMethod": "Canonical planRowToRubric hash computed over unmodified legacy raw snapshot via current source"
    }
  ],
  "limits": [
    "Audit sequence is not a rubric version; hash matches prove instruction identity without relabelling history.",
    "This is a four-card sample. Older hashless cards were not attested.",
    "No independent acceptance grade, proof binding, rubric amendment or historical data write was performed."
  ],
  "verification": {
    "fullSuite": "88/88 pass, 0 skipped, 2/2 requested files",
    "startedAt": "2026-09-26T20:55:09.145Z",
    "head": "411d591c47",
    "sourceState": "working tree",
    "typecheck": "3 named files clean, exit 0; stamp 2026-09-26T20:57:30.688Z",
    "evidenceRefs": [
      "thread-post:1147561",
      "thread-post:1147569",
      "thread-post:1147610",
      "thread-post:1147620"
    ]
  }
}
