---
rel_path: "verification/WI-6554700010046174/LATENCY-M1/preflight-20261107-0523/manifest.json"
updated_at: 1794028984290
_body: "content"
---

{
  "id": "LATENCY-M1",
  "status": "selection and per-task oracles frozen; baseline artifacts not yet captured; no implementation or measurement acceptance",
  "selectionRule": "No case, failed attempt, client, cache stratum, oracle, fixture byte or expected reference may be replaced after observing baseline or candidate measurements. Any semantic change requires a fresh independent review and a fresh full baseline. The version2 diagnostic oracles are declared before either arm is measured; baseline component failures remain failures in their separate component BARs.",
  "baseline": {
    "sourceCommit": "df01a886c5d27fa88c0f9fd65ac8f3e207e7eb6b",
    "gitlinks": {
      "search": "4a114841ec3b56deeed794878cc38e4563fdcf4d",
      "tooldef": "805235380e7056d23d071a94632be5c3525d4ebc",
      "papercusp": "b350c28fe56b82d9ecddf958b0daff33a6205aac"
    },
    "attributionReport": "rpt_e069c346-0f19-4e1e-8fab-712c96bd2bde",
    "reportBodySha256": "f528f2089ca7e6bf986e07748cab64c334efd51e7cc50f6cc8997e625dbef6e6",
    "fixtureSource": "This exact versioned LATENCY-M1 selection and its per-task qualityOracle fields govern. P-001 must materialize deterministic fixture bytes, pin independent expected-output/card/plan/schema snapshots and source hashes, calibrate positive/negative oracles, and capture immutable baseline traces before its first product behavior change. The baseline receipt must name every artifact and hash from fixturePreflight. Until that receipt exists, fixture bytes, calibration and baseline performance are UNKNOWN; the JSON test design is not execution evidence."
  },
  "windows": [
    {
      "session": "01a1b234-bb3d-7541-9d60-004d4b44b198",
      "path": "/home/marsh-office/.papercusp/su-codex-homes/session-56619/sessions/2026/11/06/rollout-2026-11-06T13-52-42-01a1b234-bb3d-7541-9d60-004d4b44b198.jsonl",
      "start": "2026-11-06T18:53:24.002Z",
      "end": "2026-11-06T19:04:34.276Z",
      "sourceSha256": "defc5fa9c526fbaaf922d4199283659e41afb854916fbc5e145a463a13d7090d",
      "sourceBytes": 4034252,
      "models": [
        "gpt-6.1-sol"
      ],
      "efforts": [
        "xhigh"
      ],
      "id": "W1",
      "sourceKind": "codex",
      "clock": "UTC timestamps; integer milliseconds; half-open [start,end)",
      "appendPolicy": "The full-file digest pins bytes read now; replay only the fixed window, never later appended records."
    },
    {
      "session": "01a1b245-0be4-7ce2-ac6c-acfeec53add8",
      "path": "/home/marsh-office/.papercusp/su-codex-homes/session-55308/sessions/2026/11/06/rollout-2026-11-06T14-10-32-01a1b245-0be4-7ce2-ac6c-acfeec53add8.jsonl",
      "start": "2026-11-06T19:12:00Z",
      "end": "2026-11-06T19:20:00Z",
      "sourceSha256": "5a72577f0135f4000f1920ba4d1dc4274e285f76b601bf10e56dce2a0cd92f83",
      "sourceBytes": 4350263,
      "models": [
        "gpt-6.1-sol"
      ],
      "efforts": [
        "xhigh"
      ],
      "id": "W2",
      "sourceKind": "codex",
      "clock": "UTC timestamps; integer milliseconds; half-open [start,end)",
      "appendPolicy": "The full-file digest pins bytes read now; replay only the fixed window, never later appended records."
    },
    {
      "session": "01a1b248-83fe-7dd0-9c5a-0dda6337c231",
      "path": "/home/marsh-office/.papercusp/su-codex-homes/session-55706/sessions/2026/11/06/rollout-2026-11-06T14-14-19-01a1b248-83fe-7dd0-9c5a-0dda6337c231.jsonl",
      "start": "2026-11-06T19:14:46.610Z",
      "end": "2026-11-06T19:20:00Z",
      "sourceSha256": "a5afb8767e674f7f415c139a3be282b1655aba17910189b08c4639e31acca800",
      "sourceBytes": 2143070,
      "models": [
        "gpt-6.1-sol"
      ],
      "efforts": [
        "xhigh"
      ],
      "id": "W3",
      "sourceKind": "codex",
      "clock": "UTC timestamps; integer milliseconds; half-open [start,end)",
      "appendPolicy": "The full-file digest pins bytes read now; replay only the fixed window, never later appended records."
    }
  ],
  "pairedTasks": {
    "cases": [
      {
        "id": "T01",
        "purpose": "page the complete criterion evidence of one scorecard",
        "family": "WF1",
        "inputA": "EI-28086267209876597",
        "inputB": "EI-28087371364505214",
        "qualityOracle": {
          "kind": "evidence-retrieval",
          "required": [
            "Return the exact requested scorecard identity, rubric/subject identity, all nine named criterion ratings and complete evidence through bounded continuation offsets; compare against the frozen fixture card snapshot.",
            "A bounded retrieval refusal or missing evidence is a failed task; do not call a partial payload complete."
          ]
        }
      },
      {
        "id": "T02",
        "purpose": "find a scorecard rerun recipe and sibling cards for the same subject",
        "family": "WF2",
        "inputA": "EI-28086267209876597",
        "inputB": "EI-28087371364505214",
        "qualityOracle": {
          "kind": "evidence-retrieval",
          "required": [
            "Return the requested card's stored rerun recipe without executing it, and the exact ordered sibling population for its frozen rubric/subject including superseded and retracted states up to limit20.",
            "Compare every returned identity and rerun-recipe presence to the frozen card/index snapshot. If a saved recipe has fixed bindings, disclose the incompatibility and complete the same lookup through authorized existing tools; include all extra calls and time."
          ]
        }
      },
      {
        "id": "T03",
        "purpose": "read the plan requirements and exact current item clauses with one source map",
        "family": "plan-contract",
        "inputA": "plan@16:R-1,P-001",
        "inputB": "plan@16:R-9,P-010",
        "qualityOracle": {
          "kind": "contract-retrieval",
          "required": [
            "Return exact R-1/P-001 or R-9/P-010 requirement text, local clauses and source map from frozen plan revision16/hash981f1073583bedbf874d68250e1a759524f0b1c808c17cb98a7116d300c85203, never substitute the candidate's current plan.",
            "Compare complete normalized text and source refs against the same fixture snapshot in both arms; absent historical clauses are explicit evidence gaps, not invented clauses."
          ]
        }
      },
      {
        "id": "T04",
        "purpose": "attribute the complete initial own window with yielded lifetime",
        "family": "timeline",
        "inputA": "W1",
        "inputB": "W1-with-overlap-control",
        "qualityOracle": {
          "kind": "interval-diagnosis",
          "required": [
            "For W1 or its declared overlap control, return clipped interval identities, union/category durations, yielded terminal operation identity, overlap and residual with1ms arithmetic tolerance.",
            "An independent interval sweep over the frozen raw fixture supplies the expected partition. Distinguish observed coverage from the95% component threshold; report any shortfall accurately and never relabel gaps as idle."
          ]
        }
      },
      {
        "id": "T05",
        "purpose": "attribute both fixed peer windows preserving evidence gaps",
        "family": "timeline",
        "inputA": "W2",
        "inputB": "W3",
        "qualityOracle": {
          "kind": "interval-diagnosis",
          "required": [
            "Return the W2/W3 interval partition, all malformed/missing evidence flags and exact source/window identities; match the independent interval sweep within1ms.",
            "Both arms must retain the same raw gaps. A complete accurate diagnosis can pass this task even when the baseline component coverage BAR fails; the candidate must independently satisfy R-1."
          ]
        }
      },
      {
        "id": "T06",
        "purpose": "read attention while irrelevant and relevant events arrive",
        "family": "attention",
        "inputA": "unchanged-plus-unrelated",
        "inputB": "relevant-change-plus-ack",
        "qualityOracle": {
          "kind": "component-diagnosis",
          "required": [
            "For unchanged-plus-unrelated and relevant-change-plus-ack fixtures, return normalized observed attention contents, expected contents from seeded source state, per-key/generation source-build counts, invalidation reasons and measured handler durations.",
            "Compare against exact seeded generation/content/ack reference. Report freshness and unrelated-rebuild violations as violations; a known baseline defect is not relabeled correct.",
            "Task success means complete accurate evidence and verdict, not that the baseline cache passes R-3. Candidate R-3's no-unrelated-rebuild, fresh-content, coalescing and250ms controls remain separately mandatory."
          ]
        }
      },
      {
        "id": "T07",
        "purpose": "look up modern typed promotion coverage idempotently",
        "family": "coverage",
        "inputA": "typed-only",
        "inputB": "mixed-typed-and-legacy",
        "qualityOracle": {
          "kind": "coverage-lookup",
          "required": [
            "Return the exact coverage edge/stamp and eligible target identity for typed-only or mixed typed/legacy fixtures; perform the repeated lookup and show no duplicate promotion side effect.",
            "Compare to the seeded target and terminal/parked eligibility reference; preserve workspace/harness scope. Diagnostic disclosure alone cannot replace a required correct lookup."
          ]
        }
      },
      {
        "id": "T08",
        "purpose": "look up exact legacy coverage with marker boundaries",
        "family": "coverage",
        "inputA": "legacy-only",
        "inputB": "boundary-and-parked",
        "qualityOracle": {
          "kind": "coverage-lookup",
          "required": [
            "Return only the exact legacy target for legacy-only or boundary/parked controls, excluding adjacent token matches and ineligible parked shadows; repeat idempotently.",
            "Compare all returned IDs/coverage receipts to the frozen fixture reference. A false positive, omitted eligible target or duplicate is a failed task."
          ]
        }
      },
      {
        "id": "T09",
        "purpose": "read busy and quiet condition prefixes retaining old holds",
        "family": "conditions",
        "inputA": "busy-prefix",
        "inputB": "quiet-prefix",
        "qualityOracle": {
          "kind": "component-diagnosis",
          "required": [
            "Return normalized observed busy/quiet prefix holds and the complete independently folded causal reference set from the frozen10000-row fixture, including the20unresolved30-day-old holds.",
            "Identify every missing/extra hold and incorrect resolution with exact event/key identities; unrelated resolutions and age cannot release a hold.",
            "An accurate baseline mismatch report passes only this diagnostic task. Candidate R-5 still requires exact reference-set equality, bounded indexed access and250ms p95."
          ]
        }
      },
      {
        "id": "T10",
        "purpose": "retrieve under an entry deadline and preserve fallback",
        "family": "retrieval",
        "inputA": "on-time",
        "inputB": "pre-entry-delay-and-late",
        "qualityOracle": {
          "kind": "component-diagnosis",
          "required": [
            "For on-time or pre-entry-delay/late fixtures, return monotonic call-entry, embedder-entry, queue/network/timer/terminal timestamps, configured budget, actual accepted/rejected result and lexical fallback identity.",
            "Compare disposition against the frozen expected deadline/fallback schedule; explicitly flag a late accepted embedding or uncancelled queued/network request.",
            "An accurate baseline defect diagnosis passes only this task. Candidate R-6 still must enforce the original call-entry deadline, cancellation and fallback; no larger budget, ignored late success or synthetic latency may satisfy it."
          ]
        }
      }
    ],
    "client": "codex-cli 0.167.0",
    "model": "gpt-6.1-sol",
    "effort": "xhigh",
    "implementationWorkers": 1,
    "fixtureIsolation": "Same clean deterministic fixture snapshot per arm, workspace latency-acceptance-fixture, harness papercusp; no production writes. Historical scorecard inputs are immutable read-only sources. Other cases use exact typed/legacy/condition/cache fixtures defined below.",
    "cacheStrata": [
      "cold: new scope/key and empty local/L2 entry",
      "warm: same scope/key after exactly one unmeasured setup read"
    ],
    "repetitions": 3,
    "order": "For every T01..T10 and cold/warm stratum: repetition1 baseline/candidate, repetition2 candidate/baseline, repetition3 baseline/candidate. Pair same model, effort, client, schema, fixture and quality oracle. No hidden fan-out.",
    "pairs": 60,
    "attempts": 120,
    "attemptDeadlineMs": 600000,
    "quality": "Both arms pass the SAME predeclared per-case task oracle and authority negative controls. Diagnostic tasks T04/T05/T06/T09/T10 require correct complete observed-versus-reference evidence; reporting a known baseline component defect is task success ONLY under those fixed diagnostic oracles. It does not satisfy any component BAR. Retrieval/lookup tasks must return the correct complete result. Every candidate component BAR remains mandatory independently. No after-results reclassification, oracle weakening, omitted failure, repaired-baseline substitution or case replacement is allowed. A failed/aborted/unknown task remains in the denominator and rejects the speedup claim; repair requires a newly reviewed full experiment.",
    "metrics": "Request count is actual gateway attempts incl retries; poll/wrapper copies are excluded only by immutable provider operation identity. Elapsed is monotonic task entry to terminal business result incl yield/wait/verification.",
    "formulas": "Per stratum and pooled matched cohort: median(requestsCandidate)/median(requestsBaseline)<=0.75; median(elapsedCandidate)/median(elapsedBaseline)<=0.80; p95(elapsedCandidate)/p95(elapsedBaseline)<=1.10. Median even-N averages central pair; p95 is nearest-rank sorted[ceil(.95*N)-1]. Report N and raw samples. Failure/abort elapsed is the 600000ms budget; preserve actual elapsed separately; missing measurements are UNKNOWN, never zero.",
    "fixturePreflight": {
      "requiredBeforeBaseline": [
        "Materialize deterministic fixture bytes and independent expected-output snapshots using the existing maintained integration fixture helpers.",
        "Pin canonical UTF8 fixture bytes/SHA256, seed and generator source hash, all historical card/plan/schema snapshots, exact frozen window bytes, baseline runtime closure/configuration, tool input schema hashes, client/model/effort and cache-stratum setup receipts.",
        "Run oracle calibration on positive, deliberately incorrect, incomplete and unauthorized controls before opening either measured arm; the checker must reject the incorrect/incomplete controls.",
        "Persist immutable preflight/trace/attempt receipts in existing testing/results rails. Fixture timings remain unmeasured until actual task execution."
      ],
      "seed": "LATENCY-M1-v2-20261107",
      "clockAnchor": "2026-11-06T00:00:00.000Z",
      "determinism": "No random/time-dependent fixture contents. Stable ordinal IDs and explicit event ordering; canonical JSON uses maintained @papercusp/hash-chain canonicalJson, UTF8, then SHA256. Reset the SAME fixture snapshot per arm and record any isolation/runtime gap as UNKNOWN.",
      "implementationAdmission": "P-001 preparation may construct and calibrate the maintained harness. No product behavior edit begins until the complete baseline receipt is immutable and independently accepted; missing artifacts remain UNKNOWN. Full experiment execution uses existing acceptance/measurement infrastructure, not a new runner/store/service.",
      "requiredBeforeCandidate": [
        "After implementation, pin the exact candidate source/build/runtime closure and configuration before opening the measured candidate arm. Candidate code hashes are never prerequisites to baseline capture.",
        "Reset the identical frozen fixture/reference/schema snapshots, retain the same client/model/effort, cohort, task order and cache-stratum setup; record intentional candidate source differences. Repeat the unchanged positive/negative oracle calibration before the candidate arm.",
        "Persist an immutable candidate-arm provenance receipt in the same testing/results rails before measurement. Missing candidate provenance blocks only the candidate arm and final acceptance; it cannot rewrite or repair the immutable baseline."
      ],
      "provenanceOrder": "Baseline fixture/reference/schema/config/runtime pinning and oracle calibration -> immutable independently accepted baseline task receipts -> product behavior edits -> candidate source/build/runtime pinning and unchanged calibration -> candidate measurements. No population, oracle, threshold, attempt or failure-exclusion change."
    }
  },
  "intervalFormulas": {
    "wall": "end-start",
    "known": "union(clipped model intervals, clipped full tool operation lifetimes)",
    "coverage": "100*known/wall >=95% in each W1,W2,W3; sum of four exclusive categories differs from wall by at most1ms",
    "inner": "For every complete invocation in the predeclared current-build four-tool set plans:attention, coord:send, work_items:get, docs:search, union named handler stages/duration_ms >=90%; report each tool separately, missing rows remain UNKNOWN and fail coverage. First100 invocations per tool in the fixed acceptance run after10 warmups; do not mix historical report instrumentation with current-build coverage.",
    "overlap": "Clip before union. Nested leaves are subdivisions, never added to parent envelope. Yielded command lifetime ends at terminal receipt. Malformed/non-tail records and absent spans remain explicit gaps; residual is not idle."
  },
  "populations": {
    "attention": {
      "runtime": "bg-host",
      "keys": [
        "latency-acceptance-fixture/papercusp/unchanged",
        "latency-acceptance-fixture/papercusp/relevant",
        "latency-acceptance-other/papercusp/isolation"
      ],
      "l2": "Use existing L1/L2 and single-flight with unchanged production TTL/invalidation configuration; record effective values and fingerprint in both arms.",
      "warmups": 10,
      "readsPerStratum": 100,
      "concurrentReaders": 20,
      "events": "100 unrelated coord messages, then one relevant source update and one acknowledgment; validate exact fresh contents.",
      "p95Ms": 250,
      "maxBuildsPerKeyGeneration": 1
    },
    "coverage": {
      "cases": [
        "typed-only",
        "legacy-only",
        "mixed",
        "terminal",
        "parked",
        "exact-boundary",
        "idempotent-repeat"
      ],
      "rows": 10000,
      "lookupsPerCase": 100,
      "warmups": 10,
      "fixture": "Seed10000 deterministic work-item rows, with one covered target per eligible case and explicit adjacent marker controls; identical snapshot and PostgreSQL settings in both arms.",
      "p95Ms": 1000,
      "queryPlan": "EXPLAIN(ANALYZE,BUFFERS,FORMAT JSON); modern lookup must not Seq Scan work_items payloads; legacy candidate path indexed/bounded."
    },
    "conditions": {
      "prefixes": [
        "latency-acceptance:busy:",
        "latency-acceptance:quiet:",
        "latency-acceptance:unrelated:"
      ],
      "historyRows": 10000,
      "activeHolds": 20,
      "oldHoldAgeDays": 30,
      "readsPerPrefix": 100,
      "warmups": 10,
      "resolutions": "Exact-key, multi-key and causally later; unrelated resolutions and hold age never release a hold.",
      "p95Ms": 250
    },
    "authorization": {
      "route": "The original protected CLI->9071 authorization lookup; no unguarded alternative.",
      "cases": [
        "authorized-warm",
        "authorized-after-generation-change",
        "policy-deny",
        "slow-headers",
        "slow-resolver",
        "unavailable",
        "recovery"
      ],
      "warmups": 10,
      "attemptsPerCase": 100,
      "p95Ms": 250,
      "safety": "Known authorized maintenance uses a current source generation and actual verdict within existing budget; unavailable is distinct and refuses writes. No timeout widening."
    },
    "retrieval": {
      "cases": [
        "on-time",
        "synchronous-entry-block",
        "queue-delay",
        "late-timer",
        "late-success",
        "abort-network",
        "abort-queued",
        "lexical-fallback"
      ],
      "runsPerCase": 100,
      "deadline": "Existing configured call-entry budget is unchanged; measure entry/queue/network/timer lateness and terminal outcome; non-preemptible work gets an explicit owned off-path repair if reproduced."
    },
    "recipeDelivery": {
      "points": [
        "orientation",
        "work-item-claim",
        "plan-authoring",
        "work-item-completion",
        "orchestrate-search"
      ],
      "controls": [
        "relevant",
        "irrelevant",
        "stale",
        "failed",
        "clipped",
        "unknown"
      ],
      "runsPerPointControl": 10,
      "oracle": "Count delivered only after bounded payload delivery receipt; selection and settled replay use separate operation IDs."
    },
    "nativeMatrix": {
      "clients": [
        "claude",
        "codex",
        "omp"
      ],
      "families": [
        "composition",
        "shell",
        "sql"
      ],
      "operations": [
        "authorized-complete",
        "yield-terminal",
        "failure",
        "cancel",
        "wrapper-poll-copy",
        "native-bypass-negative",
        "dependency-drift"
      ],
      "oracle": "Nine client/family cells must each carry exact version, supported/unsupported state, direct provider receipt or upstream acceptance gap. Unsupported is explicit and never accepted as coverage; no claim of all-client parity before external native artifacts exist."
    },
    "terminalJourneys": {
      "families": [
        "managed-shell",
        "testing-run",
        "durable-orchestration"
      ],
      "outcomes": [
        "success",
        "business-failure-wrapper-zero",
        "cancellation"
      ],
      "disruptions": [
        "none",
        "compaction",
        "runtime-restart"
      ],
      "oracle": "All27 cells retain original handle, owner/workspace, terminal business verdict, proof artifact and exactly one delivery receipt; failure and cancellation remain distinct."
    }
  },
  "workflows": [
    {
      "id": "WF1",
      "recipe": "read-all-criterion-evidence-of-one-scorecard",
      "revision": "1862c09a4f1a478685dc5e87e8b43a1ae8c6ad2591268d2e37b124c9cd6d57fc",
      "inputs": {
        "issueId": "required string; invocation-ephemeral"
      },
      "constants": "Existing nine criterion keys, ten-page guard, exact continuation offsets and completeness check; bounded text evidence plus ratings.",
      "caps": [
        "tools:scorecards:get",
        "tools:tools:find"
      ],
      "expected": "All nine keys with complete evidence or explicit bounded failure; never silently truncate."
    },
    {
      "id": "WF2",
      "recipe": "locate-a-scorecard-s-stored-rerunrecipe-and-sibling-cards-on-the-same-subject",
      "revision": "ed293159313e2a0ce40bf17268b8abc1139cfc1692cd9d2245d8a85ffbfc13ec",
      "inputs": {
        "issueId": "required string",
        "rubricRef": "required string",
        "subjectRef": "required string"
      },
      "constants": "Read index and siblings for that exact rubric/subject, limit20, includeSuperseded:true, includeRetracted:true; return stored rerunRecipe without executing it.",
      "caps": [
        "tools:scorecards:get",
        "tools:scorecards:list"
      ],
      "expected": "Exact requested card and up to20 scoped siblings, their identity/terminal/provisional state and rerun-recipe presence. Current fixed IDs are a known gap; typed revision must come from learning owner, not be silently invented."
    }
  ],
  "callers": {
    "author": {
      "id": "fixture:latency-author-su",
      "role": "su"
    },
    "second": {
      "id": "fixture:latency-reader-worker",
      "role": "worker"
    },
    "authority": "Both are named role-scoped integration principals authorized only to isolated fixture scorecards in this workspace/harness; instantiate through maintained capability-envelope test helpers, not a new implementation agent. Replay uses current caller authority.",
    "negativeControls": [
      "missing-input",
      "invalid-input",
      "different-valid-input",
      "stale-recipe-revision",
      "source-revocation",
      "cross-workspace",
      "caller-capability-loss"
    ],
    "existingExternalGrant": "none; no privilege grant or author credential inheritance"
  },
  "shipment": {
    "ownerItem": "P-009",
    "population": "P-001..P-016 exactly, including P-009 and the3consumer items; retain LATENCY-007-WRITE-REFUSAL as a separate clause.",
    "manifestFields": [
      "plan revision and BAR/spec hashes",
      "all source paths plus hashes and Git revisions, including gitlinks",
      "migration/config/flag state or explicit not-applicable",
      "every adopted upstream clause revision, tested artifact and receipt",
      "complete current-build tests and matched cohort attempt IDs",
      "promoted main SHA and exact built-artifact digest",
      "owning release lane deployment receipt",
      "loaded release-operator identity and relevant bg-host/client runtime identities",
      "post-deploy latency/recipe/terminal-journey probe receipts"
    ],
    "acceptance": "P-009 joins the exact16-item manifest to promoted/deployed bytes. Only the final shipment BAR uses release-operator; staging/live results remain implementation evidence. No missing item, source hash, external contract or failed probe may be called shipped.",
    "probeCases": [
      "timeline W1/W2/W3 output",
      "attention freshness and one warm read",
      "typed/legacy coverage",
      "busy/quiet conditions",
      "deadline fallback",
      "guarded authorized/refusal recovery",
      "WF1/WF2 discovery and current-authority replay",
      "receipt outcome denominators",
      "one terminal success/failure/cancel per family on the shipped contracts"
    ]
  },
  "bindingStatus": "All planned/new suites remain UNKNOWN until files exist, are registered, execute all named cases on the declared loaded runtime and emit exact-source results/provenance into existing test/results ledgers. Mocked unit tests alone never discharge live/deployed BARs.",
  "revision": 2
}

