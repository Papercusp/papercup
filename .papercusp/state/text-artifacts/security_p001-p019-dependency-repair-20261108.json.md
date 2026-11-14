---
rel_path: "security/p001-p019-dependency-repair-20261108.json"
updated_at: 1794160942749
_body: "content"
---

{
  "schema": "security-plan-dependency-repair-v1",
  "measuredAt": "2026-11-08T18:02:05.304Z",
  "workItem": "EI-28242927763591344",
  "plan": "app-security-runtime-boundaries-and-defense-in-depth-2026-10-31",
  "rootCause": {
    "origin": "Recovery revision38 restored the P019 line without the P001 edge introduced in revision36.",
    "evidence": [
      "plans:revision-diff revisionId83997 seq36",
      "plans:revision-diff revisionId84024 seq38"
    ],
    "alternativeRejected": "Display-only omission: canonical source line and parsed current-build blockedBy both lacked the edge."
  },
  "mutations": [
    "revision51: restore only P001 on P019 retaining nine existing prerequisites",
    "revision52: reconcile source-backed Discovery F02/F03/F04/F05",
    "revision53: reconcile F01 with restored P019 prerequisite"
  ],
  "verification": {
    "verified": true,
    "planVersion": 46,
    "contentHash": "1a56fef1dca6305d5c3d3de3bd4f4cb42614a5b735eaf7fd1d764dfc6794efaf",
    "sectionsByteIdentical": {
      "Requirements": "19860f1adbb7a661a86a35fc037cf5849f61d4e6fe3460967b6ddfe0ccdf24a9",
      "Design": "d2e1200c87f0182d6d898ad8b8d7e7d4ad2041dc66e5e437acf71e6d610400d3",
      "Decisions": "b7ea9d55a4aacf8a7d5b0fe7086010e617a83cbc0ad20282cda66bb12dfd624b",
      "Threat model and coverage": "64c0f54eb778f4b2f5be0c0ecb6750815b7af066d24b70899b8bcbfe1d11fead",
      "Sequencing and implementation lanes": "2ffeafa825fcf10d89a7dead34e1af063f10825d84b69efcd80539ab893b32d8",
      "Verification and rollout": "c8397d4c5e92334febe641514967233b6d07689aaea663a477968f5fb1e378ec"
    },
    "all20ItemTextsStatesAndDependencies": "PASS: only expected P001 edge added on P019",
    "p019BlockedBy": [
      "P-001",
      "P-006",
      "P-008",
      "P-009",
      "P-012",
      "P-015",
      "P-013",
      "P-014",
      "P-017",
      "P-018"
    ],
    "population": [
      "P-001",
      "P-002",
      "P-006",
      "P-003",
      "P-004",
      "P-005",
      "P-007",
      "P-008",
      "P-009",
      "P-010",
      "P-011",
      "P-012",
      "P-015",
      "P-013",
      "P-014",
      "P-016",
      "P-017",
      "P-018",
      "P-019",
      "P-020"
    ],
    "allAcceptedSECUnchanged": "activation-audit specSetHash ca3c0bf2d117ea6b44a686d74d7475d1dfab714c1b0c0e1f7005c06633258169 unchanged before/after",
    "decisionViewExtraKeys": [
      "provenance"
    ]
  },
  "sourceAudit": {
    "sourceSession": "codex:01a19352-65c2-76f0-bcfd-a7a7475f1bdb",
    "readTurns": "1-27 including full24",
    "discoveryAudit": 22,
    "activationAudit": 23,
    "auditedRevision": {
      "id": 86600,
      "seq": 53,
      "contentHash": "1a56fef1dca6305d5c3d3de3bd4f4cb42614a5b735eaf7fd1d764dfc6794efaf"
    },
    "resolvedOwnerRefs": 6,
    "sourceRanges": 2,
    "mappings": 6,
    "specSetHash": "ca3c0bf2d117ea6b44a686d74d7475d1dfab714c1b0c0e1f7005c06633258169",
    "canonicalStart": "ok:true promoted0 skipped20 existing P002/P006 lanes admitted; no extra implementer"
  },
  "limits": [
    "Plan data/configuration repair only; no application source changed or tests rerun.",
    "P002 module-state unit already completed: 99 focused PASS as retained packet; no fresh SEC claim.",
    "Source census admission, independent pre-execution applicability review and signed installed P020 remain open.",
    "Do not poll publisher or LIVE_GATE_OPS."
  ]
}
