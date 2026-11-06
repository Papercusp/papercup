---
rel_path: "runtime-migration/p006-guarded-quality-replay-proof-0dcd3-20261106.json"
updated_at: 1793956077455
_body: "content"
---

{
  "schemaVersion": "bun-p006-guarded-quality-replay-proof-v1",
  "plan": "node-to-bun-staged-migration-2026-10-22",
  "planVersion": 55,
  "planRevision": 58,
  "planContentHash": "a986ca2d9a3a334228e8f470d879bb33296d3e4b4b138579cb901804e24eccb5",
  "discoveryAuditSeq": 16,
  "evaluation": [
    {
      "slug": "papercusp",
      "rel_path": "runtime-migration/p006-guarded-evaluation-222b-0dcd3-20261106.json"
    },
    {
      "slug": "papercusp",
      "rel_path": "runtime-migration/p006-guarded-replay-222b-0dcd3-20261106.json"
    }
  ],
  "comparison": {
    "exact": true,
    "ratingsEqual": true,
    "draftsEqual": true
  },
  "canonicalWholeReadback": [
    {
      "path": "runtime-migration/p006-guarded-evaluation-222b-0dcd3-20261106.json",
      "pages": 3,
      "chars": 59780,
      "exact": true,
      "offsets": [
        0,
        20000,
        40000
      ]
    },
    {
      "path": "runtime-migration/p006-guarded-replay-222b-0dcd3-20261106.json",
      "pages": 3,
      "chars": 59780,
      "exact": true,
      "offsets": [
        0,
        20000,
        40000
      ]
    }
  ],
  "emitReceipt": {
    "ok": true,
    "created": true,
    "issueId": "EI-28028907482671021",
    "evidenceFingerprint": "b3f6812821c3d6e406be8d34316a82f7deb318576419a3eda7afe57c322d8274",
    "gradedGeneration": {
      "deployedSha": "222b71287c",
      "hostStartedAt": "2026-11-06T06:19:08.000Z",
      "bootHeadSha": "860cea87de25ae40b9a94b3900d8fb2f6c3f6c63",
      "scoutCodeHash": null,
      "staleHost": true
    },
    "staleHost": true,
    "deployedSha": "222b71287c",
    "gradingAuditPending": true,
    "gradingAuditNextStep": "Audit dispatch for this card was requested. The existing router automatically selects an independent auditor; declines and expiry advance its cascade, with a bounded fresh-judge fallback when no candidate is available. If no dispatch reservation is present, use scorecards:repair { targetIds:['EI-28028907482671021'] }. This card does not satisfy a gate until a NON-AUTHOR audits it. A DIFFERENT agent must emit { rubricRef:'grading-integrity', terminal:true, subject:{ kind:'scorecard', ref:'EI-28028907482671021' }, ratings:{...} }. Self-audits are refused, and re-emitting this card yourself files a duplicate pending card instead of settling this one.",
    "canonicalRatings": {
      "stable-revision-identity": {
        "rating": "pass",
        "evidence": "Source store: plans:get-specs { slug:\"node-to-bun-staged-migration-2026-10-22\", harness:\"papercusp\" }. Re-run exactly: plans:evaluate-spec-quality { slug:\"node-to-bun-staged-migration-2026-10-22\", harness:\"papercusp\", classRef:\"plan-class-migration\", expectedSpecSetHash:\"57ebd1090f32f489cd6465502c56ee339cfe45715b3ccb7e2212ab8ad7899186\" }; confirm the returned specSetHash equals \"57ebd1090f32f489cd6465502c56ee339cfe45715b3ccb7e2212ab8ad7899186\"; inspect ratings[\"stable-revision-identity\"]. 27 current clause(s) have unique identities, content hashes, and acceptance provenance. Historical replay (same rated snapshot): plans:evaluate-spec-quality {\"slug\":\"node-to-bun-staged-migration-2026-10-22\",\"harness\":\"papercusp\",\"classRef\":\"plan-class-migration\",\"expectedSpecSetHash\":\"57ebd1090f32f489cd6465502c56ee339cfe45715b3ccb7e2212ab8ad7899186\",\"replaySnapshot\":{\"planContentHash\":\"a986ca2d9a3a334228e8f470d879bb33296d3e4b4b138579cb901804e24eccb5\",\"clausesAsOf\":\"2026-10-23T19:18:53.760Z\"}}."
      },
      "item-contract-coverage": {
        "rating": "pass",
        "evidence": "Source store: plans:get-specs { slug:\"node-to-bun-staged-migration-2026-10-22\", harness:\"papercusp\" }. Re-run exactly: plans:evaluate-spec-quality { slug:\"node-to-bun-staged-migration-2026-10-22\", harness:\"papercusp\", classRef:\"plan-class-migration\", expectedSpecSetHash:\"57ebd1090f32f489cd6465502c56ee339cfe45715b3ccb7e2212ab8ad7899186\" }; confirm the returned specSetHash equals \"57ebd1090f32f489cd6465502c56ee339cfe45715b3ccb7e2212ab8ad7899186\"; inspect ratings[\"item-contract-coverage\"]. All 8 plan item(s) are covered by active item clauses or explicit exemptions. 15 sourceBar-pinned projection(s) are excluded as copies of canonical acceptance BARs; added or meaning-changed BAR projections are checked on rubric writes, while unchanged legacy BARs are not re-certified here. Historical replay (same rated snapshot): plans:evaluate-spec-quality {\"slug\":\"node-to-bun-staged-migration-2026-10-22\",\"harness\":\"papercusp\",\"classRef\":\"plan-class-migration\",\"expectedSpecSetHash\":\"57ebd1090f32f489cd6465502c56ee339cfe45715b3ccb7e2212ab8ad7899186\",\"replaySnapshot\":{\"planContentHash\":\"a986ca2d9a3a334228e8f470d879bb33296d3e4b4b138579cb901804e24eccb5\",\"clausesAsOf\":\"2026-10-23T19:18:53.760Z\"}}."
      },
      "atomic-observable-behavior": {
        "rating": "pass",
        "evidence": "Source store: plans:get-specs { slug:\"node-to-bun-staged-migration-2026-10-22\", harness:\"papercusp\" }. Re-run exactly: plans:evaluate-spec-quality { slug:\"node-to-bun-staged-migration-2026-10-22\", harness:\"papercusp\", classRef:\"plan-class-migration\", expectedSpecSetHash:\"57ebd1090f32f489cd6465502c56ee339cfe45715b3ccb7e2212ab8ad7899186\" }; confirm the returned specSetHash equals \"57ebd1090f32f489cd6465502c56ee339cfe45715b3ccb7e2212ab8ad7899186\"; inspect ratings[\"atomic-observable-behavior\"]. 12 independent item behavior clause(s) passed the supported structural atomicity checks. 15 sourceBar-pinned projection(s) are excluded as copies of canonical acceptance BARs; added or meaning-changed BAR projections are checked on rubric writes, while unchanged legacy BARs are not re-certified here. Coverage: 12 of 27 active behavioral clause(s) evaluated; 15 active sourceBar-pinned BAR projection(s) excluded (new or meaning-changed canonical BAR projections are checked on rubric writes; unchanged legacy BARs are not re-certified here); per-clause dispositions are in details.atomicityClauseDiagnostics. Detector controls: 4/4 compound counterexamples rejected; 4/4 single-outcome controls accepted; see details.atomicityDetectorControls. Coverage is structural pattern detection, not a proof of arbitrary natural-language semantics. Historical replay (same rated snapshot): plans:evaluate-spec-quality {\"slug\":\"node-to-bun-staged-migration-2026-10-22\",\"harness\":\"papercusp\",\"classRef\":\"plan-class-migration\",\"expectedSpecSetHash\":\"57ebd1090f32f489cd6465502c56ee339cfe45715b3ccb7e2212ab8ad7899186\",\"replaySnapshot\":{\"planContentHash\":\"a986ca2d9a3a334228e8f470d879bb33296d3e4b4b138579cb901804e24eccb5\",\"clausesAsOf\":\"2026-10-23T19:18:53.760Z\"}}."
      },
      "falsifiability": {
        "rating": "pass",
        "evidence": "Source store: plans:get-specs { slug:\"node-to-bun-staged-migration-2026-10-22\", harness:\"papercusp\" }. Re-run exactly: plans:evaluate-spec-quality { slug:\"node-to-bun-staged-migration-2026-10-22\", harness:\"papercusp\", classRef:\"plan-class-migration\", expectedSpecSetHash:\"57ebd1090f32f489cd6465502c56ee339cfe45715b3ccb7e2212ab8ad7899186\" }; confirm the returned specSetHash equals \"57ebd1090f32f489cd6465502c56ee339cfe45715b3ccb7e2212ab8ad7899186\"; inspect ratings[\"falsifiability\"]. 12 independent item behavior clause(s) state falsifiable outcomes. 15 sourceBar-pinned projection(s) are excluded as copies of canonical acceptance BARs; added or meaning-changed BAR projections are checked on rubric writes, while unchanged legacy BARs are not re-certified here. Historical replay (same rated snapshot): plans:evaluate-spec-quality {\"slug\":\"node-to-bun-staged-migration-2026-10-22\",\"harness\":\"papercusp\",\"classRef\":\"plan-class-migration\",\"expectedSpecSetHash\":\"57ebd1090f32f489cd6465502c56ee339cfe45715b3ccb7e2212ab8ad7899186\",\"replaySnapshot\":{\"planContentHash\":\"a986ca2d9a3a334228e8f470d879bb33296d3e4b4b138579cb901804e24eccb5\",\"clausesAsOf\":\"2026-10-23T19:18:53.760Z\"}}."
      },
      "implementation-independence": {
        "rating": "pass",
        "evidence": "Source store: plans:get-specs { slug:\"node-to-bun-staged-migration-2026-10-22\", harness:\"papercusp\" }. Re-run exactly: plans:evaluate-spec-quality { slug:\"node-to-bun-staged-migration-2026-10-22\", harness:\"papercusp\", classRef:\"plan-class-migration\", expectedSpecSetHash:\"57ebd1090f32f489cd6465502c56ee339cfe45715b3ccb7e2212ab8ad7899186\" }; confirm the returned specSetHash equals \"57ebd1090f32f489cd6465502c56ee339cfe45715b3ccb7e2212ab8ad7899186\"; inspect ratings[\"implementation-independence\"]. No active/accepted behavior clause is coupled to an implementation detail covered by the detector. Fields inspected per clause: behavior and falsifier.observation (falsifier.probeMethod is excluded because it legitimately names the test or probe). Detector coverage: implementation filenames, explicitly qualified/quoted construct symbols (including snake_case identifiers), bare lowerCamel identifiers (excluding recognized public platform/device names), repository paths, internal route literals, named operations, mandated reuse of existing surfaces (including runtimes, flows, pipelines, ledgers, mechanisms, scheduling paths and sweeps, including passive by prescriptions), imperative implementation selection, filesystem permission modes, named storage backends, encryption, and mirroring. Inspected 27 active/accepted behavior clause(s), including 15 sourceBar-pinned acceptance BAR projection(s). 0 draft/exempt clause(s) excluded; per-clause dispositions are in details.implementationIndependenceClauseDiagnostics. Detector controls: see details.implementationIndependenceDetectorControls for coupled counterexamples and independent observable outcomes. Coverage is structural pattern detection, not a proof of arbitrary natural-language semantics. Historical replay (same rated snapshot): plans:evaluate-spec-quality {\"slug\":\"node-to-bun-staged-migration-2026-10-22\",\"harness\":\"papercusp\",\"classRef\":\"plan-class-migration\",\"expectedSpecSetHash\":\"57ebd1090f32f489cd6465502c56ee339cfe45715b3ccb7e2212ab8ad7899186\",\"replaySnapshot\":{\"planContentHash\":\"a986ca2d9a3a334228e8f470d879bb33296d3e4b4b138579cb901804e24eccb5\",\"clausesAsOf\":\"2026-10-23T19:18:53.760Z\"}}."
      },
      "explicit-non-behavioral-exemptions": {
        "rating": "not-applicable",
        "evidence": "Source store: plans:get-specs { slug:\"node-to-bun-staged-migration-2026-10-22\", harness:\"papercusp\" }. Re-run exactly: plans:evaluate-spec-quality { slug:\"node-to-bun-staged-migration-2026-10-22\", harness:\"papercusp\", classRef:\"plan-class-migration\", expectedSpecSetHash:\"57ebd1090f32f489cd6465502c56ee339cfe45715b3ccb7e2212ab8ad7899186\" }; confirm the returned specSetHash equals \"57ebd1090f32f489cd6465502c56ee339cfe45715b3ccb7e2212ab8ad7899186\"; inspect ratings[\"explicit-non-behavioral-exemptions\"]. Exact clause scope 57ebd1090f32f489cd6465502c56ee339cfe45715b3ccb7e2212ab8ad7899186 contains 27 current row(s); 0 exempt ([]), 0 valid and 0 invalid; invalid ids=[]; row census SHA-256=61ec474af71f2ff1125ae7427795e056255753fd4f6e7a379852757dfa8cb59a. Replay this exact snapshot and compare details.exemptionCensus.rows. No clause claims a non-behavioral exemption. Historical replay (same rated snapshot): plans:evaluate-spec-quality {\"slug\":\"node-to-bun-staged-migration-2026-10-22\",\"harness\":\"papercusp\",\"classRef\":\"plan-class-migration\",\"expectedSpecSetHash\":\"57ebd1090f32f489cd6465502c56ee339cfe45715b3ccb7e2212ab8ad7899186\",\"replaySnapshot\":{\"planContentHash\":\"a986ca2d9a3a334228e8f470d879bb33296d3e4b4b138579cb901804e24eccb5\",\"clausesAsOf\":\"2026-10-23T19:18:53.760Z\"}}."
      },
      "plan-class-specialization": {
        "rating": "pass",
        "evidence": "Source store: plans:get-specs { slug:\"node-to-bun-staged-migration-2026-10-22\", harness:\"papercusp\" }. Re-run exactly: plans:evaluate-spec-quality { slug:\"node-to-bun-staged-migration-2026-10-22\", harness:\"papercusp\", classRef:\"plan-class-migration\", expectedSpecSetHash:\"57ebd1090f32f489cd6465502c56ee339cfe45715b3ccb7e2212ab8ad7899186\" }; confirm the returned specSetHash equals \"57ebd1090f32f489cd6465502c56ee339cfe45715b3ccb7e2212ab8ad7899186\"; inspect ratings[\"plan-class-specialization\"]. Migration plan includes an active migration-data-integrity contract. Historical replay (same rated snapshot): plans:evaluate-spec-quality {\"slug\":\"node-to-bun-staged-migration-2026-10-22\",\"harness\":\"papercusp\",\"classRef\":\"plan-class-migration\",\"expectedSpecSetHash\":\"57ebd1090f32f489cd6465502c56ee339cfe45715b3ccb7e2212ab8ad7899186\",\"replaySnapshot\":{\"planContentHash\":\"a986ca2d9a3a334228e8f470d879bb33296d3e4b4b138579cb901804e24eccb5\",\"clausesAsOf\":\"2026-10-23T19:18:53.760Z\"}}."
      },
      "spec-set-freshness": {
        "rating": "pass",
        "evidence": "Source store: plans:get-specs { slug:\"node-to-bun-staged-migration-2026-10-22\", harness:\"papercusp\" }. Re-run exactly: plans:evaluate-spec-quality { slug:\"node-to-bun-staged-migration-2026-10-22\", harness:\"papercusp\", classRef:\"plan-class-migration\", expectedSpecSetHash:\"57ebd1090f32f489cd6465502c56ee339cfe45715b3ccb7e2212ab8ad7899186\" }; confirm the returned specSetHash equals \"57ebd1090f32f489cd6465502c56ee339cfe45715b3ccb7e2212ab8ad7899186\"; inspect ratings[\"spec-set-freshness\"]. Verdict is pinned to exact current specSetHash 57ebd1090f32f489cd6465502c56ee339cfe45715b3ccb7e2212ab8ad7899186 over 27 clause(s). Historical replay (same rated snapshot): plans:evaluate-spec-quality {\"slug\":\"node-to-bun-staged-migration-2026-10-22\",\"harness\":\"papercusp\",\"classRef\":\"plan-class-migration\",\"expectedSpecSetHash\":\"57ebd1090f32f489cd6465502c56ee339cfe45715b3ccb7e2212ab8ad7899186\",\"replaySnapshot\":{\"planContentHash\":\"a986ca2d9a3a334228e8f470d879bb33296d3e4b4b138579cb901804e24eccb5\",\"clausesAsOf\":\"2026-10-23T19:18:53.760Z\"}}."
      }
    },
    "completionReceipt": {
      "status": "recorded",
      "effectRef": "EI-28028907482671021"
    }
  },
  "limits": "Spec quality only; independent grading audit pending. Bun remains unshipped, Node selected, native/full installed acceptance open. D011-D019 terminal; no D019 retry. Fresh scoped activation conversation audit and ordinary plans:start remain required after independent PASS."
}
