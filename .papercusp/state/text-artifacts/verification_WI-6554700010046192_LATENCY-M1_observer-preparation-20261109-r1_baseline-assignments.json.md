---
rel_path: "verification/WI-6554700010046192/LATENCY-M1/observer-preparation-20261109-r1/baseline-assignments.json"
updated_at: 1794193535311
_body: "content"
---

{
  "phase": "preparation-only",
  "actualProviderTaskAttempts": 0,
  "manifestPath": "/tmp/latency-continue-manifest4.json",
  "manifestByteSha256": "778b13ab5824faabaf4b13b14fe46337ae44ce7b35de4003ae40fd958b957ce7",
  "manifestCanonicalSha256": "9d3837d43ebfddd7a18033175640b2333ae60ff35f73e861837c91d01f041dd6",
  "assignments": [
    {
      "key": {
        "task": "T01",
        "stratum": "cold",
        "repetition": 1,
        "arm": "baseline"
      },
      "nativeAssignment": {
        "taskId": "LATENCY-M1:T01",
        "armId": "cold",
        "seed": 1,
        "pairId": "LATENCY-M1:T01:cold:1"
      },
      "task": {
        "benchmark": "harness-bench",
        "instanceId": "LATENCY-M1:T01",
        "problemStatement": "page the complete criterion evidence of one scorecard\nFrozen input A: \"EI-28086267209876597\"\nFrozen input B: \"EI-28087371364505214\"\nUse the frozen source fixtures supplied in the assignment context. Return the complete requested output for both inputs with exact source identities and explicit evidence gaps. Do not edit product source or execute a saved rerun recipe.",
        "graderMeta": {
          "latencyM1": {
            "manifestSha256": "9d3837d43ebfddd7a18033175640b2333ae60ff35f73e861837c91d01f041dd6",
            "taskId": "T01",
            "pairId": "LATENCY-M1:T01:cold:1",
            "stratum": "cold",
            "repetition": 1,
            "qualityOracle": {
              "kind": "evidence-retrieval",
              "required": [
                "Return the exact requested scorecard identity, rubric/subject identity, the complete pinned criterion population (8 spec-quality keys for inputA and 6 grading-integrity keys for inputB, enumerated in fixturePreflight.historicalCards) and complete evidence through bounded continuation offsets; compare against the frozen fixture card snapshot. No missing, extra, substituted or invented criterion may pass.",
                "A bounded retrieval refusal or missing evidence is a failed task; do not call a partial payload complete.",
                "The pinned original WF1 has nine fixed spec-test-adequacy keys and is incompatible with BOTH selected card rubrics. Disclose this before measurement and complete T01 through authorized existing scorecards:get index/evidence continuations, counting every model/gateway attempt and all elapsed time. The same complete-output oracle applies to both arms. This fallback does not discharge R-11: its candidate saved-replay/second-caller/current-authority acceptance still requires an independently accepted compatible artifact from the canonical learning owner."
              ]
            }
          }
        }
      }
    },
    {
      "key": {
        "task": "T01",
        "stratum": "cold",
        "repetition": 2,
        "arm": "baseline"
      },
      "nativeAssignment": {
        "taskId": "LATENCY-M1:T01",
        "armId": "cold",
        "seed": 2,
        "pairId": "LATENCY-M1:T01:cold:2"
      },
      "task": {
        "benchmark": "harness-bench",
        "instanceId": "LATENCY-M1:T01",
        "problemStatement": "page the complete criterion evidence of one scorecard\nFrozen input A: \"EI-28086267209876597\"\nFrozen input B: \"EI-28087371364505214\"\nUse the frozen source fixtures supplied in the assignment context. Return the complete requested output for both inputs with exact source identities and explicit evidence gaps. Do not edit product source or execute a saved rerun recipe.",
        "graderMeta": {
          "latencyM1": {
            "manifestSha256": "9d3837d43ebfddd7a18033175640b2333ae60ff35f73e861837c91d01f041dd6",
            "taskId": "T01",
            "pairId": "LATENCY-M1:T01:cold:2",
            "stratum": "cold",
            "repetition": 2,
            "qualityOracle": {
              "kind": "evidence-retrieval",
              "required": [
                "Return the exact requested scorecard identity, rubric/subject identity, the complete pinned criterion population (8 spec-quality keys for inputA and 6 grading-integrity keys for inputB, enumerated in fixturePreflight.historicalCards) and complete evidence through bounded continuation offsets; compare against the frozen fixture card snapshot. No missing, extra, substituted or invented criterion may pass.",
                "A bounded retrieval refusal or missing evidence is a failed task; do not call a partial payload complete.",
                "The pinned original WF1 has nine fixed spec-test-adequacy keys and is incompatible with BOTH selected card rubrics. Disclose this before measurement and complete T01 through authorized existing scorecards:get index/evidence continuations, counting every model/gateway attempt and all elapsed time. The same complete-output oracle applies to both arms. This fallback does not discharge R-11: its candidate saved-replay/second-caller/current-authority acceptance still requires an independently accepted compatible artifact from the canonical learning owner."
              ]
            }
          }
        }
      }
    },
    {
      "key": {
        "task": "T01",
        "stratum": "cold",
        "repetition": 3,
        "arm": "baseline"
      },
      "nativeAssignment": {
        "taskId": "LATENCY-M1:T01",
        "armId": "cold",
        "seed": 3,
        "pairId": "LATENCY-M1:T01:cold:3"
      },
      "task": {
        "benchmark": "harness-bench",
        "instanceId": "LATENCY-M1:T01",
        "problemStatement": "page the complete criterion evidence of one scorecard\nFrozen input A: \"EI-28086267209876597\"\nFrozen input B: \"EI-28087371364505214\"\nUse the frozen source fixtures supplied in the assignment context. Return the complete requested output for both inputs with exact source identities and explicit evidence gaps. Do not edit product source or execute a saved rerun recipe.",
        "graderMeta": {
          "latencyM1": {
            "manifestSha256": "9d3837d43ebfddd7a18033175640b2333ae60ff35f73e861837c91d01f041dd6",
            "taskId": "T01",
            "pairId": "LATENCY-M1:T01:cold:3",
            "stratum": "cold",
            "repetition": 3,
            "qualityOracle": {
              "kind": "evidence-retrieval",
              "required": [
                "Return the exact requested scorecard identity, rubric/subject identity, the complete pinned criterion population (8 spec-quality keys for inputA and 6 grading-integrity keys for inputB, enumerated in fixturePreflight.historicalCards) and complete evidence through bounded continuation offsets; compare against the frozen fixture card snapshot. No missing, extra, substituted or invented criterion may pass.",
                "A bounded retrieval refusal or missing evidence is a failed task; do not call a partial payload complete.",
                "The pinned original WF1 has nine fixed spec-test-adequacy keys and is incompatible with BOTH selected card rubrics. Disclose this before measurement and complete T01 through authorized existing scorecards:get index/evidence continuations, counting every model/gateway attempt and all elapsed time. The same complete-output oracle applies to both arms. This fallback does not discharge R-11: its candidate saved-replay/second-caller/current-authority acceptance still requires an independently accepted compatible artifact from the canonical learning owner."
              ]
            }
          }
        }
      }
    },
    {
      "key": {
        "task": "T01",
        "stratum": "warm",
        "repetition": 1,
        "arm": "baseline"
      },
      "nativeAssignment": {
        "taskId": "LATENCY-M1:T01",
        "armId": "warm",
        "seed": 1,
        "pairId": "LATENCY-M1:T01:warm:1"
      },
      "task": {
        "benchmark": "harness-bench",
        "instanceId": "LATENCY-M1:T01",
        "problemStatement": "page the complete criterion evidence of one scorecard\nFrozen input A: \"EI-28086267209876597\"\nFrozen input B: \"EI-28087371364505214\"\nUse the frozen source fixtures supplied in the assignment context. Return the complete requested output for both inputs with exact source identities and explicit evidence gaps. Do not edit product source or execute a saved rerun recipe.",
        "graderMeta": {
          "latencyM1": {
            "manifestSha256": "9d3837d43ebfddd7a18033175640b2333ae60ff35f73e861837c91d01f041dd6",
            "taskId": "T01",
            "pairId": "LATENCY-M1:T01:warm:1",
            "stratum": "warm",
            "repetition": 1,
            "qualityOracle": {
              "kind": "evidence-retrieval",
              "required": [
                "Return the exact requested scorecard identity, rubric/subject identity, the complete pinned criterion population (8 spec-quality keys for inputA and 6 grading-integrity keys for inputB, enumerated in fixturePreflight.historicalCards) and complete evidence through bounded continuation offsets; compare against the frozen fixture card snapshot. No missing, extra, substituted or invented criterion may pass.",
                "A bounded retrieval refusal or missing evidence is a failed task; do not call a partial payload complete.",
                "The pinned original WF1 has nine fixed spec-test-adequacy keys and is incompatible with BOTH selected card rubrics. Disclose this before measurement and complete T01 through authorized existing scorecards:get index/evidence continuations, counting every model/gateway attempt and all elapsed time. The same complete-output oracle applies to both arms. This fallback does not discharge R-11: its candidate saved-replay/second-caller/current-authority acceptance still requires an independently accepted compatible artifact from the canonical learning owner."
              ]
            }
          }
        }
      }
    },
    {
      "key": {
        "task": "T01",
        "stratum": "warm",
        "repetition": 2,
        "arm": "baseline"
      },
      "nativeAssignment": {
        "taskId": "LATENCY-M1:T01",
        "armId": "warm",
        "seed": 2,
        "pairId": "LATENCY-M1:T01:warm:2"
      },
      "task": {
        "benchmark": "harness-bench",
        "instanceId": "LATENCY-M1:T01",
        "problemStatement": "page the complete criterion evidence of one scorecard\nFrozen input A: \"EI-28086267209876597\"\nFrozen input B: \"EI-28087371364505214\"\nUse the frozen source fixtures supplied in the assignment context. Return the complete requested output for both inputs with exact source identities and explicit evidence gaps. Do not edit product source or execute a saved rerun recipe.",
        "graderMeta": {
          "latencyM1": {
            "manifestSha256": "9d3837d43ebfddd7a18033175640b2333ae60ff35f73e861837c91d01f041dd6",
            "taskId": "T01",
            "pairId": "LATENCY-M1:T01:warm:2",
            "stratum": "warm",
            "repetition": 2,
            "qualityOracle": {
              "kind": "evidence-retrieval",
              "required": [
                "Return the exact requested scorecard identity, rubric/subject identity, the complete pinned criterion population (8 spec-quality keys for inputA and 6 grading-integrity keys for inputB, enumerated in fixturePreflight.historicalCards) and complete evidence through bounded continuation offsets; compare against the frozen fixture card snapshot. No missing, extra, substituted or invented criterion may pass.",
                "A bounded retrieval refusal or missing evidence is a failed task; do not call a partial payload complete.",
                "The pinned original WF1 has nine fixed spec-test-adequacy keys and is incompatible with BOTH selected card rubrics. Disclose this before measurement and complete T01 through authorized existing scorecards:get index/evidence continuations, counting every model/gateway attempt and all elapsed time. The same complete-output oracle applies to both arms. This fallback does not discharge R-11: its candidate saved-replay/second-caller/current-authority acceptance still requires an independently accepted compatible artifact from the canonical learning owner."
              ]
            }
          }
        }
      }
    },
    {
      "key": {
        "task": "T01",
        "stratum": "warm",
        "repetition": 3,
        "arm": "baseline"
      },
      "nativeAssignment": {
        "taskId": "LATENCY-M1:T01",
        "armId": "warm",
        "seed": 3,
        "pairId": "LATENCY-M1:T01:warm:3"
      },
      "task": {
        "benchmark": "harness-bench",
        "instanceId": "LATENCY-M1:T01",
        "problemStatement": "page the complete criterion evidence of one scorecard\nFrozen input A: \"EI-28086267209876597\"\nFrozen input B: \"EI-28087371364505214\"\nUse the frozen source fixtures supplied in the assignment context. Return the complete requested output for both inputs with exact source identities and explicit evidence gaps. Do not edit product source or execute a saved rerun recipe.",
        "graderMeta": {
          "latencyM1": {
            "manifestSha256": "9d3837d43ebfddd7a18033175640b2333ae60ff35f73e861837c91d01f041dd6",
            "taskId": "T01",
            "pairId": "LATENCY-M1:T01:warm:3",
            "stratum": "warm",
            "repetition": 3,
            "qualityOracle": {
              "kind": "evidence-retrieval",
              "required": [
                "Return the exact requested scorecard identity, rubric/subject identity, the complete pinned criterion population (8 spec-quality keys for inputA and 6 grading-integrity keys for inputB, enumerated in fixturePreflight.historicalCards) and complete evidence through bounded continuation offsets; compare against the frozen fixture card snapshot. No missing, extra, substituted or invented criterion may pass.",
                "A bounded retrieval refusal or missing evidence is a failed task; do not call a partial payload complete.",
                "The pinned original WF1 has nine fixed spec-test-adequacy keys and is incompatible with BOTH selected card rubrics. Disclose this before measurement and complete T01 through authorized existing scorecards:get index/evidence continuations, counting every model/gateway attempt and all elapsed time. The same complete-output oracle applies to both arms. This fallback does not discharge R-11: its candidate saved-replay/second-caller/current-authority acceptance still requires an independently accepted compatible artifact from the canonical learning owner."
              ]
            }
          }
        }
      }
    },
    {
      "key": {
        "task": "T02",
        "stratum": "cold",
        "repetition": 1,
        "arm": "baseline"
      },
      "nativeAssignment": {
        "taskId": "LATENCY-M1:T02",
        "armId": "cold",
        "seed": 1,
        "pairId": "LATENCY-M1:T02:cold:1"
      },
      "task": {
        "benchmark": "harness-bench",
        "instanceId": "LATENCY-M1:T02",
        "problemStatement": "find a scorecard rerun recipe and sibling cards for the same subject\nFrozen input A: \"EI-28086267209876597\"\nFrozen input B: \"EI-28087371364505214\"\nUse the frozen source fixtures supplied in the assignment context. Return the complete requested output for both inputs with exact source identities and explicit evidence gaps. Do not edit product source or execute a saved rerun recipe.",
        "graderMeta": {
          "latencyM1": {
            "manifestSha256": "9d3837d43ebfddd7a18033175640b2333ae60ff35f73e861837c91d01f041dd6",
            "taskId": "T02",
            "pairId": "LATENCY-M1:T02:cold:1",
            "stratum": "cold",
            "repetition": 1,
            "qualityOracle": {
              "kind": "evidence-retrieval",
              "required": [
                "Return the requested card's stored rerun recipe without executing it, and the exact ordered sibling population for its frozen rubric/subject including superseded and retracted states up to limit20.",
                "Compare every returned identity and rerun-recipe presence to the frozen card/index snapshot. If a saved recipe has fixed bindings, disclose the incompatibility and complete the same lookup through authorized existing tools; include all extra calls and time."
              ]
            }
          }
        }
      }
    },
    {
      "key": {
        "task": "T02",
        "stratum": "cold",
        "repetition": 2,
        "arm": "baseline"
      },
      "nativeAssignment": {
        "taskId": "LATENCY-M1:T02",
        "armId": "cold",
        "seed": 2,
        "pairId": "LATENCY-M1:T02:cold:2"
      },
      "task": {
        "benchmark": "harness-bench",
        "instanceId": "LATENCY-M1:T02",
        "problemStatement": "find a scorecard rerun recipe and sibling cards for the same subject\nFrozen input A: \"EI-28086267209876597\"\nFrozen input B: \"EI-28087371364505214\"\nUse the frozen source fixtures supplied in the assignment context. Return the complete requested output for both inputs with exact source identities and explicit evidence gaps. Do not edit product source or execute a saved rerun recipe.",
        "graderMeta": {
          "latencyM1": {
            "manifestSha256": "9d3837d43ebfddd7a18033175640b2333ae60ff35f73e861837c91d01f041dd6",
            "taskId": "T02",
            "pairId": "LATENCY-M1:T02:cold:2",
            "stratum": "cold",
            "repetition": 2,
            "qualityOracle": {
              "kind": "evidence-retrieval",
              "required": [
                "Return the requested card's stored rerun recipe without executing it, and the exact ordered sibling population for its frozen rubric/subject including superseded and retracted states up to limit20.",
                "Compare every returned identity and rerun-recipe presence to the frozen card/index snapshot. If a saved recipe has fixed bindings, disclose the incompatibility and complete the same lookup through authorized existing tools; include all extra calls and time."
              ]
            }
          }
        }
      }
    },
    {
      "key": {
        "task": "T02",
        "stratum": "cold",
        "repetition": 3,
        "arm": "baseline"
      },
      "nativeAssignment": {
        "taskId": "LATENCY-M1:T02",
        "armId": "cold",
        "seed": 3,
        "pairId": "LATENCY-M1:T02:cold:3"
      },
      "task": {
        "benchmark": "harness-bench",
        "instanceId": "LATENCY-M1:T02",
        "problemStatement": "find a scorecard rerun recipe and sibling cards for the same subject\nFrozen input A: \"EI-28086267209876597\"\nFrozen input B: \"EI-28087371364505214\"\nUse the frozen source fixtures supplied in the assignment context. Return the complete requested output for both inputs with exact source identities and explicit evidence gaps. Do not edit product source or execute a saved rerun recipe.",
        "graderMeta": {
          "latencyM1": {
            "manifestSha256": "9d3837d43ebfddd7a18033175640b2333ae60ff35f73e861837c91d01f041dd6",
            "taskId": "T02",
            "pairId": "LATENCY-M1:T02:cold:3",
            "stratum": "cold",
            "repetition": 3,
            "qualityOracle": {
              "kind": "evidence-retrieval",
              "required": [
                "Return the requested card's stored rerun recipe without executing it, and the exact ordered sibling population for its frozen rubric/subject including superseded and retracted states up to limit20.",
                "Compare every returned identity and rerun-recipe presence to the frozen card/index snapshot. If a saved recipe has fixed bindings, disclose the incompatibility and complete the same lookup through authorized existing tools; include all extra calls and time."
              ]
            }
          }
        }
      }
    },
    {
      "key": {
        "task": "T02",
        "stratum": "warm",
        "repetition": 1,
        "arm": "baseline"
      },
      "nativeAssignment": {
        "taskId": "LATENCY-M1:T02",
        "armId": "warm",
        "seed": 1,
        "pairId": "LATENCY-M1:T02:warm:1"
      },
      "task": {
        "benchmark": "harness-bench",
        "instanceId": "LATENCY-M1:T02",
        "problemStatement": "find a scorecard rerun recipe and sibling cards for the same subject\nFrozen input A: \"EI-28086267209876597\"\nFrozen input B: \"EI-28087371364505214\"\nUse the frozen source fixtures supplied in the assignment context. Return the complete requested output for both inputs with exact source identities and explicit evidence gaps. Do not edit product source or execute a saved rerun recipe.",
        "graderMeta": {
          "latencyM1": {
            "manifestSha256": "9d3837d43ebfddd7a18033175640b2333ae60ff35f73e861837c91d01f041dd6",
            "taskId": "T02",
            "pairId": "LATENCY-M1:T02:warm:1",
            "stratum": "warm",
            "repetition": 1,
            "qualityOracle": {
              "kind": "evidence-retrieval",
              "required": [
                "Return the requested card's stored rerun recipe without executing it, and the exact ordered sibling population for its frozen rubric/subject including superseded and retracted states up to limit20.",
                "Compare every returned identity and rerun-recipe presence to the frozen card/index snapshot. If a saved recipe has fixed bindings, disclose the incompatibility and complete the same lookup through authorized existing tools; include all extra calls and time."
              ]
            }
          }
        }
      }
    },
    {
      "key": {
        "task": "T02",
        "stratum": "warm",
        "repetition": 2,
        "arm": "baseline"
      },
      "nativeAssignment": {
        "taskId": "LATENCY-M1:T02",
        "armId": "warm",
        "seed": 2,
        "pairId": "LATENCY-M1:T02:warm:2"
      },
      "task": {
        "benchmark": "harness-bench",
        "instanceId": "LATENCY-M1:T02",
        "problemStatement": "find a scorecard rerun recipe and sibling cards for the same subject\nFrozen input A: \"EI-28086267209876597\"\nFrozen input B: \"EI-28087371364505214\"\nUse the frozen source fixtures supplied in the assignment context. Return the complete requested output for both inputs with exact source identities and explicit evidence gaps. Do not edit product source or execute a saved rerun recipe.",
        "graderMeta": {
          "latencyM1": {
            "manifestSha256": "9d3837d43ebfddd7a18033175640b2333ae60ff35f73e861837c91d01f041dd6",
            "taskId": "T02",
            "pairId": "LATENCY-M1:T02:warm:2",
            "stratum": "warm",
            "repetition": 2,
            "qualityOracle": {
              "kind": "evidence-retrieval",
              "required": [
                "Return the requested card's stored rerun recipe without executing it, and the exact ordered sibling population for its frozen rubric/subject including superseded and retracted states up to limit20.",
                "Compare every returned identity and rerun-recipe presence to the frozen card/index snapshot. If a saved recipe has fixed bindings, disclose the incompatibility and complete the same lookup through authorized existing tools; include all extra calls and time."
              ]
            }
          }
        }
      }
    },
    {
      "key": {
        "task": "T02",
        "stratum": "warm",
        "repetition": 3,
        "arm": "baseline"
      },
      "nativeAssignment": {
        "taskId": "LATENCY-M1:T02",
        "armId": "warm",
        "seed": 3,
        "pairId": "LATENCY-M1:T02:warm:3"
      },
      "task": {
        "benchmark": "harness-bench",
        "instanceId": "LATENCY-M1:T02",
        "problemStatement": "find a scorecard rerun recipe and sibling cards for the same subject\nFrozen input A: \"EI-28086267209876597\"\nFrozen input B: \"EI-28087371364505214\"\nUse the frozen source fixtures supplied in the assignment context. Return the complete requested output for both inputs with exact source identities and explicit evidence gaps. Do not edit product source or execute a saved rerun recipe.",
        "graderMeta": {
          "latencyM1": {
            "manifestSha256": "9d3837d43ebfddd7a18033175640b2333ae60ff35f73e861837c91d01f041dd6",
            "taskId": "T02",
            "pairId": "LATENCY-M1:T02:warm:3",
            "stratum": "warm",
            "repetition": 3,
            "qualityOracle": {
              "kind": "evidence-retrieval",
              "required": [
                "Return the requested card's stored rerun recipe without executing it, and the exact ordered sibling population for its frozen rubric/subject including superseded and retracted states up to limit20.",
                "Compare every returned identity and rerun-recipe presence to the frozen card/index snapshot. If a saved recipe has fixed bindings, disclose the incompatibility and complete the same lookup through authorized existing tools; include all extra calls and time."
              ]
            }
          }
        }
      }
    },
    {
      "key": {
        "task": "T03",
        "stratum": "cold",
        "repetition": 1,
        "arm": "baseline"
      },
      "nativeAssignment": {
        "taskId": "LATENCY-M1:T03",
        "armId": "cold",
        "seed": 1,
        "pairId": "LATENCY-M1:T03:cold:1"
      },
      "task": {
        "benchmark": "harness-bench",
        "instanceId": "LATENCY-M1:T03",
        "problemStatement": "read the plan requirements and exact current item clauses with one source map\nFrozen input A: \"plan@16:R-1,P-001\"\nFrozen input B: \"plan@16:R-9,P-010\"\nUse the frozen source fixtures supplied in the assignment context. Return the complete requested output for both inputs with exact source identities and explicit evidence gaps. Do not edit product source or execute a saved rerun recipe.",
        "graderMeta": {
          "latencyM1": {
            "manifestSha256": "9d3837d43ebfddd7a18033175640b2333ae60ff35f73e861837c91d01f041dd6",
            "taskId": "T03",
            "pairId": "LATENCY-M1:T03:cold:1",
            "stratum": "cold",
            "repetition": 1,
            "qualityOracle": {
              "kind": "contract-retrieval",
              "required": [
                "Return exact R-1/P-001 or R-9/P-010 requirement text, local clauses and source map from frozen plan revision16/hash981f1073583bedbf874d68250e1a759524f0b1c808c17cb98a7116d300c85203, never substitute the candidate's current plan.",
                "Compare complete normalized text and source refs against the same fixture snapshot in both arms; absent historical clauses are explicit evidence gaps, not invented clauses."
              ]
            }
          }
        }
      }
    },
    {
      "key": {
        "task": "T03",
        "stratum": "cold",
        "repetition": 2,
        "arm": "baseline"
      },
      "nativeAssignment": {
        "taskId": "LATENCY-M1:T03",
        "armId": "cold",
        "seed": 2,
        "pairId": "LATENCY-M1:T03:cold:2"
      },
      "task": {
        "benchmark": "harness-bench",
        "instanceId": "LATENCY-M1:T03",
        "problemStatement": "read the plan requirements and exact current item clauses with one source map\nFrozen input A: \"plan@16:R-1,P-001\"\nFrozen input B: \"plan@16:R-9,P-010\"\nUse the frozen source fixtures supplied in the assignment context. Return the complete requested output for both inputs with exact source identities and explicit evidence gaps. Do not edit product source or execute a saved rerun recipe.",
        "graderMeta": {
          "latencyM1": {
            "manifestSha256": "9d3837d43ebfddd7a18033175640b2333ae60ff35f73e861837c91d01f041dd6",
            "taskId": "T03",
            "pairId": "LATENCY-M1:T03:cold:2",
            "stratum": "cold",
            "repetition": 2,
            "qualityOracle": {
              "kind": "contract-retrieval",
              "required": [
                "Return exact R-1/P-001 or R-9/P-010 requirement text, local clauses and source map from frozen plan revision16/hash981f1073583bedbf874d68250e1a759524f0b1c808c17cb98a7116d300c85203, never substitute the candidate's current plan.",
                "Compare complete normalized text and source refs against the same fixture snapshot in both arms; absent historical clauses are explicit evidence gaps, not invented clauses."
              ]
            }
          }
        }
      }
    },
    {
      "key": {
        "task": "T03",
        "stratum": "cold",
        "repetition": 3,
        "arm": "baseline"
      },
      "nativeAssignment": {
        "taskId": "LATENCY-M1:T03",
        "armId": "cold",
        "seed": 3,
        "pairId": "LATENCY-M1:T03:cold:3"
      },
      "task": {
        "benchmark": "harness-bench",
        "instanceId": "LATENCY-M1:T03",
        "problemStatement": "read the plan requirements and exact current item clauses with one source map\nFrozen input A: \"plan@16:R-1,P-001\"\nFrozen input B: \"plan@16:R-9,P-010\"\nUse the frozen source fixtures supplied in the assignment context. Return the complete requested output for both inputs with exact source identities and explicit evidence gaps. Do not edit product source or execute a saved rerun recipe.",
        "graderMeta": {
          "latencyM1": {
            "manifestSha256": "9d3837d43ebfddd7a18033175640b2333ae60ff35f73e861837c91d01f041dd6",
            "taskId": "T03",
            "pairId": "LATENCY-M1:T03:cold:3",
            "stratum": "cold",
            "repetition": 3,
            "qualityOracle": {
              "kind": "contract-retrieval",
              "required": [
                "Return exact R-1/P-001 or R-9/P-010 requirement text, local clauses and source map from frozen plan revision16/hash981f1073583bedbf874d68250e1a759524f0b1c808c17cb98a7116d300c85203, never substitute the candidate's current plan.",
                "Compare complete normalized text and source refs against the same fixture snapshot in both arms; absent historical clauses are explicit evidence gaps, not invented clauses."
              ]
            }
          }
        }
      }
    },
    {
      "key": {
        "task": "T03",
        "stratum": "warm",
        "repetition": 1,
        "arm": "baseline"
      },
      "nativeAssignment": {
        "taskId": "LATENCY-M1:T03",
        "armId": "warm",
        "seed": 1,
        "pairId": "LATENCY-M1:T03:warm:1"
      },
      "task": {
        "benchmark": "harness-bench",
        "instanceId": "LATENCY-M1:T03",
        "problemStatement": "read the plan requirements and exact current item clauses with one source map\nFrozen input A: \"plan@16:R-1,P-001\"\nFrozen input B: \"plan@16:R-9,P-010\"\nUse the frozen source fixtures supplied in the assignment context. Return the complete requested output for both inputs with exact source identities and explicit evidence gaps. Do not edit product source or execute a saved rerun recipe.",
        "graderMeta": {
          "latencyM1": {
            "manifestSha256": "9d3837d43ebfddd7a18033175640b2333ae60ff35f73e861837c91d01f041dd6",
            "taskId": "T03",
            "pairId": "LATENCY-M1:T03:warm:1",
            "stratum": "warm",
            "repetition": 1,
            "qualityOracle": {
              "kind": "contract-retrieval",
              "required": [
                "Return exact R-1/P-001 or R-9/P-010 requirement text, local clauses and source map from frozen plan revision16/hash981f1073583bedbf874d68250e1a759524f0b1c808c17cb98a7116d300c85203, never substitute the candidate's current plan.",
                "Compare complete normalized text and source refs against the same fixture snapshot in both arms; absent historical clauses are explicit evidence gaps, not invented clauses."
              ]
            }
          }
        }
      }
    },
    {
      "key": {
        "task": "T03",
        "stratum": "warm",
        "repetition": 2,
        "arm": "baseline"
      },
      "nativeAssignment": {
        "taskId": "LATENCY-M1:T03",
        "armId": "warm",
        "seed": 2,
        "pairId": "LATENCY-M1:T03:warm:2"
      },
      "task": {
        "benchmark": "harness-bench",
        "instanceId": "LATENCY-M1:T03",
        "problemStatement": "read the plan requirements and exact current item clauses with one source map\nFrozen input A: \"plan@16:R-1,P-001\"\nFrozen input B: \"plan@16:R-9,P-010\"\nUse the frozen source fixtures supplied in the assignment context. Return the complete requested output for both inputs with exact source identities and explicit evidence gaps. Do not edit product source or execute a saved rerun recipe.",
        "graderMeta": {
          "latencyM1": {
            "manifestSha256": "9d3837d43ebfddd7a18033175640b2333ae60ff35f73e861837c91d01f041dd6",
            "taskId": "T03",
            "pairId": "LATENCY-M1:T03:warm:2",
            "stratum": "warm",
            "repetition": 2,
            "qualityOracle": {
              "kind": "contract-retrieval",
              "required": [
                "Return exact R-1/P-001 or R-9/P-010 requirement text, local clauses and source map from frozen plan revision16/hash981f1073583bedbf874d68250e1a759524f0b1c808c17cb98a7116d300c85203, never substitute the candidate's current plan.",
                "Compare complete normalized text and source refs against the same fixture snapshot in both arms; absent historical clauses are explicit evidence gaps, not invented clauses."
              ]
            }
          }
        }
      }
    },
    {
      "key": {
        "task": "T03",
        "stratum": "warm",
        "repetition": 3,
        "arm": "baseline"
      },
      "nativeAssignment": {
        "taskId": "LATENCY-M1:T03",
        "armId": "warm",
        "seed": 3,
        "pairId": "LATENCY-M1:T03:warm:3"
      },
      "task": {
        "benchmark": "harness-bench",
        "instanceId": "LATENCY-M1:T03",
        "problemStatement": "read the plan requirements and exact current item clauses with one source map\nFrozen input A: \"plan@16:R-1,P-001\"\nFrozen input B: \"plan@16:R-9,P-010\"\nUse the frozen source fixtures supplied in the assignment context. Return the complete requested output for both inputs with exact source identities and explicit evidence gaps. Do not edit product source or execute a saved rerun recipe.",
        "graderMeta": {
          "latencyM1": {
            "manifestSha256": "9d3837d43ebfddd7a18033175640b2333ae60ff35f73e861837c91d01f041dd6",
            "taskId": "T03",
            "pairId": "LATENCY-M1:T03:warm:3",
            "stratum": "warm",
            "repetition": 3,
            "qualityOracle": {
              "kind": "contract-retrieval",
              "required": [
                "Return exact R-1/P-001 or R-9/P-010 requirement text, local clauses and source map from frozen plan revision16/hash981f1073583bedbf874d68250e1a759524f0b1c808c17cb98a7116d300c85203, never substitute the candidate's current plan.",
                "Compare complete normalized text and source refs against the same fixture snapshot in both arms; absent historical clauses are explicit evidence gaps, not invented clauses."
              ]
            }
          }
        }
      }
    },
    {
      "key": {
        "task": "T04",
        "stratum": "cold",
        "repetition": 1,
        "arm": "baseline"
      },
      "nativeAssignment": {
        "taskId": "LATENCY-M1:T04",
        "armId": "cold",
        "seed": 1,
        "pairId": "LATENCY-M1:T04:cold:1"
      },
      "task": {
        "benchmark": "harness-bench",
        "instanceId": "LATENCY-M1:T04",
        "problemStatement": "attribute the complete initial own window with yielded lifetime\nFrozen input A: \"W1\"\nFrozen input B: \"W1-with-overlap-control\"\nUse the frozen source fixtures supplied in the assignment context. Return the complete requested output for both inputs with exact source identities and explicit evidence gaps. Do not edit product source or execute a saved rerun recipe.",
        "graderMeta": {
          "latencyM1": {
            "manifestSha256": "9d3837d43ebfddd7a18033175640b2333ae60ff35f73e861837c91d01f041dd6",
            "taskId": "T04",
            "pairId": "LATENCY-M1:T04:cold:1",
            "stratum": "cold",
            "repetition": 1,
            "qualityOracle": {
              "kind": "interval-diagnosis",
              "required": [
                "For W1 or its declared overlap control, return clipped interval identities, union/category durations, yielded terminal operation identity, overlap and residual with1ms arithmetic tolerance.",
                "An independent interval sweep over the frozen raw fixture supplies the expected partition. Distinguish observed coverage from the95% component threshold; report any shortfall accurately and never relabel gaps as idle."
              ]
            }
          }
        }
      }
    },
    {
      "key": {
        "task": "T04",
        "stratum": "cold",
        "repetition": 2,
        "arm": "baseline"
      },
      "nativeAssignment": {
        "taskId": "LATENCY-M1:T04",
        "armId": "cold",
        "seed": 2,
        "pairId": "LATENCY-M1:T04:cold:2"
      },
      "task": {
        "benchmark": "harness-bench",
        "instanceId": "LATENCY-M1:T04",
        "problemStatement": "attribute the complete initial own window with yielded lifetime\nFrozen input A: \"W1\"\nFrozen input B: \"W1-with-overlap-control\"\nUse the frozen source fixtures supplied in the assignment context. Return the complete requested output for both inputs with exact source identities and explicit evidence gaps. Do not edit product source or execute a saved rerun recipe.",
        "graderMeta": {
          "latencyM1": {
            "manifestSha256": "9d3837d43ebfddd7a18033175640b2333ae60ff35f73e861837c91d01f041dd6",
            "taskId": "T04",
            "pairId": "LATENCY-M1:T04:cold:2",
            "stratum": "cold",
            "repetition": 2,
            "qualityOracle": {
              "kind": "interval-diagnosis",
              "required": [
                "For W1 or its declared overlap control, return clipped interval identities, union/category durations, yielded terminal operation identity, overlap and residual with1ms arithmetic tolerance.",
                "An independent interval sweep over the frozen raw fixture supplies the expected partition. Distinguish observed coverage from the95% component threshold; report any shortfall accurately and never relabel gaps as idle."
              ]
            }
          }
        }
      }
    },
    {
      "key": {
        "task": "T04",
        "stratum": "cold",
        "repetition": 3,
        "arm": "baseline"
      },
      "nativeAssignment": {
        "taskId": "LATENCY-M1:T04",
        "armId": "cold",
        "seed": 3,
        "pairId": "LATENCY-M1:T04:cold:3"
      },
      "task": {
        "benchmark": "harness-bench",
        "instanceId": "LATENCY-M1:T04",
        "problemStatement": "attribute the complete initial own window with yielded lifetime\nFrozen input A: \"W1\"\nFrozen input B: \"W1-with-overlap-control\"\nUse the frozen source fixtures supplied in the assignment context. Return the complete requested output for both inputs with exact source identities and explicit evidence gaps. Do not edit product source or execute a saved rerun recipe.",
        "graderMeta": {
          "latencyM1": {
            "manifestSha256": "9d3837d43ebfddd7a18033175640b2333ae60ff35f73e861837c91d01f041dd6",
            "taskId": "T04",
            "pairId": "LATENCY-M1:T04:cold:3",
            "stratum": "cold",
            "repetition": 3,
            "qualityOracle": {
              "kind": "interval-diagnosis",
              "required": [
                "For W1 or its declared overlap control, return clipped interval identities, union/category durations, yielded terminal operation identity, overlap and residual with1ms arithmetic tolerance.",
                "An independent interval sweep over the frozen raw fixture supplies the expected partition. Distinguish observed coverage from the95% component threshold; report any shortfall accurately and never relabel gaps as idle."
              ]
            }
          }
        }
      }
    },
    {
      "key": {
        "task": "T04",
        "stratum": "warm",
        "repetition": 1,
        "arm": "baseline"
      },
      "nativeAssignment": {
        "taskId": "LATENCY-M1:T04",
        "armId": "warm",
        "seed": 1,
        "pairId": "LATENCY-M1:T04:warm:1"
      },
      "task": {
        "benchmark": "harness-bench",
        "instanceId": "LATENCY-M1:T04",
        "problemStatement": "attribute the complete initial own window with yielded lifetime\nFrozen input A: \"W1\"\nFrozen input B: \"W1-with-overlap-control\"\nUse the frozen source fixtures supplied in the assignment context. Return the complete requested output for both inputs with exact source identities and explicit evidence gaps. Do not edit product source or execute a saved rerun recipe.",
        "graderMeta": {
          "latencyM1": {
            "manifestSha256": "9d3837d43ebfddd7a18033175640b2333ae60ff35f73e861837c91d01f041dd6",
            "taskId": "T04",
            "pairId": "LATENCY-M1:T04:warm:1",
            "stratum": "warm",
            "repetition": 1,
            "qualityOracle": {
              "kind": "interval-diagnosis",
              "required": [
                "For W1 or its declared overlap control, return clipped interval identities, union/category durations, yielded terminal operation identity, overlap and residual with1ms arithmetic tolerance.",
                "An independent interval sweep over the frozen raw fixture supplies the expected partition. Distinguish observed coverage from the95% component threshold; report any shortfall accurately and never relabel gaps as idle."
              ]
            }
          }
        }
      }
    },
    {
      "key": {
        "task": "T04",
        "stratum": "warm",
        "repetition": 2,
        "arm": "baseline"
      },
      "nativeAssignment": {
        "taskId": "LATENCY-M1:T04",
        "armId": "warm",
        "seed": 2,
        "pairId": "LATENCY-M1:T04:warm:2"
      },
      "task": {
        "benchmark": "harness-bench",
        "instanceId": "LATENCY-M1:T04",
        "problemStatement": "attribute the complete initial own window with yielded lifetime\nFrozen input A: \"W1\"\nFrozen input B: \"W1-with-overlap-control\"\nUse the frozen source fixtures supplied in the assignment context. Return the complete requested output for both inputs with exact source identities and explicit evidence gaps. Do not edit product source or execute a saved rerun recipe.",
        "graderMeta": {
          "latencyM1": {
            "manifestSha256": "9d3837d43ebfddd7a18033175640b2333ae60ff35f73e861837c91d01f041dd6",
            "taskId": "T04",
            "pairId": "LATENCY-M1:T04:warm:2",
            "stratum": "warm",
            "repetition": 2,
            "qualityOracle": {
              "kind": "interval-diagnosis",
              "required": [
                "For W1 or its declared overlap control, return clipped interval identities, union/category durations, yielded terminal operation identity, overlap and residual with1ms arithmetic tolerance.",
                "An independent interval sweep over the frozen raw fixture supplies the expected partition. Distinguish observed coverage from the95% component threshold; report any shortfall accurately and never relabel gaps as idle."
              ]
            }
          }
        }
      }
    },
    {
      "key": {
        "task": "T04",
        "stratum": "warm",
        "repetition": 3,
        "arm": "baseline"
      },
      "nativeAssignment": {
        "taskId": "LATENCY-M1:T04",
        "armId": "warm",
        "seed": 3,
        "pairId": "LATENCY-M1:T04:warm:3"
      },
      "task": {
        "benchmark": "harness-bench",
        "instanceId": "LATENCY-M1:T04",
        "problemStatement": "attribute the complete initial own window with yielded lifetime\nFrozen input A: \"W1\"\nFrozen input B: \"W1-with-overlap-control\"\nUse the frozen source fixtures supplied in the assignment context. Return the complete requested output for both inputs with exact source identities and explicit evidence gaps. Do not edit product source or execute a saved rerun recipe.",
        "graderMeta": {
          "latencyM1": {
            "manifestSha256": "9d3837d43ebfddd7a18033175640b2333ae60ff35f73e861837c91d01f041dd6",
            "taskId": "T04",
            "pairId": "LATENCY-M1:T04:warm:3",
            "stratum": "warm",
            "repetition": 3,
            "qualityOracle": {
              "kind": "interval-diagnosis",
              "required": [
                "For W1 or its declared overlap control, return clipped interval identities, union/category durations, yielded terminal operation identity, overlap and residual with1ms arithmetic tolerance.",
                "An independent interval sweep over the frozen raw fixture supplies the expected partition. Distinguish observed coverage from the95% component threshold; report any shortfall accurately and never relabel gaps as idle."
              ]
            }
          }
        }
      }
    },
    {
      "key": {
        "task": "T05",
        "stratum": "cold",
        "repetition": 1,
        "arm": "baseline"
      },
      "nativeAssignment": {
        "taskId": "LATENCY-M1:T05",
        "armId": "cold",
        "seed": 1,
        "pairId": "LATENCY-M1:T05:cold:1"
      },
      "task": {
        "benchmark": "harness-bench",
        "instanceId": "LATENCY-M1:T05",
        "problemStatement": "attribute both fixed peer windows preserving evidence gaps\nFrozen input A: \"W2\"\nFrozen input B: \"W3\"\nUse the frozen source fixtures supplied in the assignment context. Return the complete requested output for both inputs with exact source identities and explicit evidence gaps. Do not edit product source or execute a saved rerun recipe.",
        "graderMeta": {
          "latencyM1": {
            "manifestSha256": "9d3837d43ebfddd7a18033175640b2333ae60ff35f73e861837c91d01f041dd6",
            "taskId": "T05",
            "pairId": "LATENCY-M1:T05:cold:1",
            "stratum": "cold",
            "repetition": 1,
            "qualityOracle": {
              "kind": "interval-diagnosis",
              "required": [
                "Return the W2/W3 interval partition, all malformed/missing evidence flags and exact source/window identities; match the independent interval sweep within1ms.",
                "Both arms must retain the same raw gaps. A complete accurate diagnosis can pass this task even when the baseline component coverage BAR fails; the candidate must independently satisfy R-1."
              ]
            }
          }
        }
      }
    },
    {
      "key": {
        "task": "T05",
        "stratum": "cold",
        "repetition": 2,
        "arm": "baseline"
      },
      "nativeAssignment": {
        "taskId": "LATENCY-M1:T05",
        "armId": "cold",
        "seed": 2,
        "pairId": "LATENCY-M1:T05:cold:2"
      },
      "task": {
        "benchmark": "harness-bench",
        "instanceId": "LATENCY-M1:T05",
        "problemStatement": "attribute both fixed peer windows preserving evidence gaps\nFrozen input A: \"W2\"\nFrozen input B: \"W3\"\nUse the frozen source fixtures supplied in the assignment context. Return the complete requested output for both inputs with exact source identities and explicit evidence gaps. Do not edit product source or execute a saved rerun recipe.",
        "graderMeta": {
          "latencyM1": {
            "manifestSha256": "9d3837d43ebfddd7a18033175640b2333ae60ff35f73e861837c91d01f041dd6",
            "taskId": "T05",
            "pairId": "LATENCY-M1:T05:cold:2",
            "stratum": "cold",
            "repetition": 2,
            "qualityOracle": {
              "kind": "interval-diagnosis",
              "required": [
                "Return the W2/W3 interval partition, all malformed/missing evidence flags and exact source/window identities; match the independent interval sweep within1ms.",
                "Both arms must retain the same raw gaps. A complete accurate diagnosis can pass this task even when the baseline component coverage BAR fails; the candidate must independently satisfy R-1."
              ]
            }
          }
        }
      }
    },
    {
      "key": {
        "task": "T05",
        "stratum": "cold",
        "repetition": 3,
        "arm": "baseline"
      },
      "nativeAssignment": {
        "taskId": "LATENCY-M1:T05",
        "armId": "cold",
        "seed": 3,
        "pairId": "LATENCY-M1:T05:cold:3"
      },
      "task": {
        "benchmark": "harness-bench",
        "instanceId": "LATENCY-M1:T05",
        "problemStatement": "attribute both fixed peer windows preserving evidence gaps\nFrozen input A: \"W2\"\nFrozen input B: \"W3\"\nUse the frozen source fixtures supplied in the assignment context. Return the complete requested output for both inputs with exact source identities and explicit evidence gaps. Do not edit product source or execute a saved rerun recipe.",
        "graderMeta": {
          "latencyM1": {
            "manifestSha256": "9d3837d43ebfddd7a18033175640b2333ae60ff35f73e861837c91d01f041dd6",
            "taskId": "T05",
            "pairId": "LATENCY-M1:T05:cold:3",
            "stratum": "cold",
            "repetition": 3,
            "qualityOracle": {
              "kind": "interval-diagnosis",
              "required": [
                "Return the W2/W3 interval partition, all malformed/missing evidence flags and exact source/window identities; match the independent interval sweep within1ms.",
                "Both arms must retain the same raw gaps. A complete accurate diagnosis can pass this task even when the baseline component coverage BAR fails; the candidate must independently satisfy R-1."
              ]
            }
          }
        }
      }
    },
    {
      "key": {
        "task": "T05",
        "stratum": "warm",
        "repetition": 1,
        "arm": "baseline"
      },
      "nativeAssignment": {
        "taskId": "LATENCY-M1:T05",
        "armId": "warm",
        "seed": 1,
        "pairId": "LATENCY-M1:T05:warm:1"
      },
      "task": {
        "benchmark": "harness-bench",
        "instanceId": "LATENCY-M1:T05",
        "problemStatement": "attribute both fixed peer windows preserving evidence gaps\nFrozen input A: \"W2\"\nFrozen input B: \"W3\"\nUse the frozen source fixtures supplied in the assignment context. Return the complete requested output for both inputs with exact source identities and explicit evidence gaps. Do not edit product source or execute a saved rerun recipe.",
        "graderMeta": {
          "latencyM1": {
            "manifestSha256": "9d3837d43ebfddd7a18033175640b2333ae60ff35f73e861837c91d01f041dd6",
            "taskId": "T05",
            "pairId": "LATENCY-M1:T05:warm:1",
            "stratum": "warm",
            "repetition": 1,
            "qualityOracle": {
              "kind": "interval-diagnosis",
              "required": [
                "Return the W2/W3 interval partition, all malformed/missing evidence flags and exact source/window identities; match the independent interval sweep within1ms.",
                "Both arms must retain the same raw gaps. A complete accurate diagnosis can pass this task even when the baseline component coverage BAR fails; the candidate must independently satisfy R-1."
              ]
            }
          }
        }
      }
    },
    {
      "key": {
        "task": "T05",
        "stratum": "warm",
        "repetition": 2,
        "arm": "baseline"
      },
      "nativeAssignment": {
        "taskId": "LATENCY-M1:T05",
        "armId": "warm",
        "seed": 2,
        "pairId": "LATENCY-M1:T05:warm:2"
      },
      "task": {
        "benchmark": "harness-bench",
        "instanceId": "LATENCY-M1:T05",
        "problemStatement": "attribute both fixed peer windows preserving evidence gaps\nFrozen input A: \"W2\"\nFrozen input B: \"W3\"\nUse the frozen source fixtures supplied in the assignment context. Return the complete requested output for both inputs with exact source identities and explicit evidence gaps. Do not edit product source or execute a saved rerun recipe.",
        "graderMeta": {
          "latencyM1": {
            "manifestSha256": "9d3837d43ebfddd7a18033175640b2333ae60ff35f73e861837c91d01f041dd6",
            "taskId": "T05",
            "pairId": "LATENCY-M1:T05:warm:2",
            "stratum": "warm",
            "repetition": 2,
            "qualityOracle": {
              "kind": "interval-diagnosis",
              "required": [
                "Return the W2/W3 interval partition, all malformed/missing evidence flags and exact source/window identities; match the independent interval sweep within1ms.",
                "Both arms must retain the same raw gaps. A complete accurate diagnosis can pass this task even when the baseline component coverage BAR fails; the candidate must independently satisfy R-1."
              ]
            }
          }
        }
      }
    },
    {
      "key": {
        "task": "T05",
        "stratum": "warm",
        "repetition": 3,
        "arm": "baseline"
      },
      "nativeAssignment": {
        "taskId": "LATENCY-M1:T05",
        "armId": "warm",
        "seed": 3,
        "pairId": "LATENCY-M1:T05:warm:3"
      },
      "task": {
        "benchmark": "harness-bench",
        "instanceId": "LATENCY-M1:T05",
        "problemStatement": "attribute both fixed peer windows preserving evidence gaps\nFrozen input A: \"W2\"\nFrozen input B: \"W3\"\nUse the frozen source fixtures supplied in the assignment context. Return the complete requested output for both inputs with exact source identities and explicit evidence gaps. Do not edit product source or execute a saved rerun recipe.",
        "graderMeta": {
          "latencyM1": {
            "manifestSha256": "9d3837d43ebfddd7a18033175640b2333ae60ff35f73e861837c91d01f041dd6",
            "taskId": "T05",
            "pairId": "LATENCY-M1:T05:warm:3",
            "stratum": "warm",
            "repetition": 3,
            "qualityOracle": {
              "kind": "interval-diagnosis",
              "required": [
                "Return the W2/W3 interval partition, all malformed/missing evidence flags and exact source/window identities; match the independent interval sweep within1ms.",
                "Both arms must retain the same raw gaps. A complete accurate diagnosis can pass this task even when the baseline component coverage BAR fails; the candidate must independently satisfy R-1."
              ]
            }
          }
        }
      }
    },
    {
      "key": {
        "task": "T06",
        "stratum": "cold",
        "repetition": 1,
        "arm": "baseline"
      },
      "nativeAssignment": {
        "taskId": "LATENCY-M1:T06",
        "armId": "cold",
        "seed": 1,
        "pairId": "LATENCY-M1:T06:cold:1"
      },
      "task": {
        "benchmark": "harness-bench",
        "instanceId": "LATENCY-M1:T06",
        "problemStatement": "read attention while irrelevant and relevant events arrive\nFrozen input A: \"unchanged-plus-unrelated\"\nFrozen input B: \"relevant-change-plus-ack\"\nUse the frozen source fixtures supplied in the assignment context. Return the complete requested output for both inputs with exact source identities and explicit evidence gaps. Do not edit product source or execute a saved rerun recipe.",
        "graderMeta": {
          "latencyM1": {
            "manifestSha256": "9d3837d43ebfddd7a18033175640b2333ae60ff35f73e861837c91d01f041dd6",
            "taskId": "T06",
            "pairId": "LATENCY-M1:T06:cold:1",
            "stratum": "cold",
            "repetition": 1,
            "qualityOracle": {
              "kind": "component-diagnosis",
              "required": [
                "For unchanged-plus-unrelated and relevant-change-plus-ack fixtures, return normalized observed attention contents, expected contents from seeded source state, per-key/generation source-build counts, invalidation reasons and measured handler durations.",
                "Compare against exact seeded generation/content/ack reference. Report freshness and unrelated-rebuild violations as violations; a known baseline defect is not relabeled correct.",
                "Task success means complete accurate evidence and verdict, not that the baseline cache passes R-3. Candidate R-3's no-unrelated-rebuild, fresh-content, coalescing and250ms controls remain separately mandatory."
              ]
            }
          }
        }
      }
    },
    {
      "key": {
        "task": "T06",
        "stratum": "cold",
        "repetition": 2,
        "arm": "baseline"
      },
      "nativeAssignment": {
        "taskId": "LATENCY-M1:T06",
        "armId": "cold",
        "seed": 2,
        "pairId": "LATENCY-M1:T06:cold:2"
      },
      "task": {
        "benchmark": "harness-bench",
        "instanceId": "LATENCY-M1:T06",
        "problemStatement": "read attention while irrelevant and relevant events arrive\nFrozen input A: \"unchanged-plus-unrelated\"\nFrozen input B: \"relevant-change-plus-ack\"\nUse the frozen source fixtures supplied in the assignment context. Return the complete requested output for both inputs with exact source identities and explicit evidence gaps. Do not edit product source or execute a saved rerun recipe.",
        "graderMeta": {
          "latencyM1": {
            "manifestSha256": "9d3837d43ebfddd7a18033175640b2333ae60ff35f73e861837c91d01f041dd6",
            "taskId": "T06",
            "pairId": "LATENCY-M1:T06:cold:2",
            "stratum": "cold",
            "repetition": 2,
            "qualityOracle": {
              "kind": "component-diagnosis",
              "required": [
                "For unchanged-plus-unrelated and relevant-change-plus-ack fixtures, return normalized observed attention contents, expected contents from seeded source state, per-key/generation source-build counts, invalidation reasons and measured handler durations.",
                "Compare against exact seeded generation/content/ack reference. Report freshness and unrelated-rebuild violations as violations; a known baseline defect is not relabeled correct.",
                "Task success means complete accurate evidence and verdict, not that the baseline cache passes R-3. Candidate R-3's no-unrelated-rebuild, fresh-content, coalescing and250ms controls remain separately mandatory."
              ]
            }
          }
        }
      }
    },
    {
      "key": {
        "task": "T06",
        "stratum": "cold",
        "repetition": 3,
        "arm": "baseline"
      },
      "nativeAssignment": {
        "taskId": "LATENCY-M1:T06",
        "armId": "cold",
        "seed": 3,
        "pairId": "LATENCY-M1:T06:cold:3"
      },
      "task": {
        "benchmark": "harness-bench",
        "instanceId": "LATENCY-M1:T06",
        "problemStatement": "read attention while irrelevant and relevant events arrive\nFrozen input A: \"unchanged-plus-unrelated\"\nFrozen input B: \"relevant-change-plus-ack\"\nUse the frozen source fixtures supplied in the assignment context. Return the complete requested output for both inputs with exact source identities and explicit evidence gaps. Do not edit product source or execute a saved rerun recipe.",
        "graderMeta": {
          "latencyM1": {
            "manifestSha256": "9d3837d43ebfddd7a18033175640b2333ae60ff35f73e861837c91d01f041dd6",
            "taskId": "T06",
            "pairId": "LATENCY-M1:T06:cold:3",
            "stratum": "cold",
            "repetition": 3,
            "qualityOracle": {
              "kind": "component-diagnosis",
              "required": [
                "For unchanged-plus-unrelated and relevant-change-plus-ack fixtures, return normalized observed attention contents, expected contents from seeded source state, per-key/generation source-build counts, invalidation reasons and measured handler durations.",
                "Compare against exact seeded generation/content/ack reference. Report freshness and unrelated-rebuild violations as violations; a known baseline defect is not relabeled correct.",
                "Task success means complete accurate evidence and verdict, not that the baseline cache passes R-3. Candidate R-3's no-unrelated-rebuild, fresh-content, coalescing and250ms controls remain separately mandatory."
              ]
            }
          }
        }
      }
    },
    {
      "key": {
        "task": "T06",
        "stratum": "warm",
        "repetition": 1,
        "arm": "baseline"
      },
      "nativeAssignment": {
        "taskId": "LATENCY-M1:T06",
        "armId": "warm",
        "seed": 1,
        "pairId": "LATENCY-M1:T06:warm:1"
      },
      "task": {
        "benchmark": "harness-bench",
        "instanceId": "LATENCY-M1:T06",
        "problemStatement": "read attention while irrelevant and relevant events arrive\nFrozen input A: \"unchanged-plus-unrelated\"\nFrozen input B: \"relevant-change-plus-ack\"\nUse the frozen source fixtures supplied in the assignment context. Return the complete requested output for both inputs with exact source identities and explicit evidence gaps. Do not edit product source or execute a saved rerun recipe.",
        "graderMeta": {
          "latencyM1": {
            "manifestSha256": "9d3837d43ebfddd7a18033175640b2333ae60ff35f73e861837c91d01f041dd6",
            "taskId": "T06",
            "pairId": "LATENCY-M1:T06:warm:1",
            "stratum": "warm",
            "repetition": 1,
            "qualityOracle": {
              "kind": "component-diagnosis",
              "required": [
                "For unchanged-plus-unrelated and relevant-change-plus-ack fixtures, return normalized observed attention contents, expected contents from seeded source state, per-key/generation source-build counts, invalidation reasons and measured handler durations.",
                "Compare against exact seeded generation/content/ack reference. Report freshness and unrelated-rebuild violations as violations; a known baseline defect is not relabeled correct.",
                "Task success means complete accurate evidence and verdict, not that the baseline cache passes R-3. Candidate R-3's no-unrelated-rebuild, fresh-content, coalescing and250ms controls remain separately mandatory."
              ]
            }
          }
        }
      }
    },
    {
      "key": {
        "task": "T06",
        "stratum": "warm",
        "repetition": 2,
        "arm": "baseline"
      },
      "nativeAssignment": {
        "taskId": "LATENCY-M1:T06",
        "armId": "warm",
        "seed": 2,
        "pairId": "LATENCY-M1:T06:warm:2"
      },
      "task": {
        "benchmark": "harness-bench",
        "instanceId": "LATENCY-M1:T06",
        "problemStatement": "read attention while irrelevant and relevant events arrive\nFrozen input A: \"unchanged-plus-unrelated\"\nFrozen input B: \"relevant-change-plus-ack\"\nUse the frozen source fixtures supplied in the assignment context. Return the complete requested output for both inputs with exact source identities and explicit evidence gaps. Do not edit product source or execute a saved rerun recipe.",
        "graderMeta": {
          "latencyM1": {
            "manifestSha256": "9d3837d43ebfddd7a18033175640b2333ae60ff35f73e861837c91d01f041dd6",
            "taskId": "T06",
            "pairId": "LATENCY-M1:T06:warm:2",
            "stratum": "warm",
            "repetition": 2,
            "qualityOracle": {
              "kind": "component-diagnosis",
              "required": [
                "For unchanged-plus-unrelated and relevant-change-plus-ack fixtures, return normalized observed attention contents, expected contents from seeded source state, per-key/generation source-build counts, invalidation reasons and measured handler durations.",
                "Compare against exact seeded generation/content/ack reference. Report freshness and unrelated-rebuild violations as violations; a known baseline defect is not relabeled correct.",
                "Task success means complete accurate evidence and verdict, not that the baseline cache passes R-3. Candidate R-3's no-unrelated-rebuild, fresh-content, coalescing and250ms controls remain separately mandatory."
              ]
            }
          }
        }
      }
    },
    {
      "key": {
        "task": "T06",
        "stratum": "warm",
        "repetition": 3,
        "arm": "baseline"
      },
      "nativeAssignment": {
        "taskId": "LATENCY-M1:T06",
        "armId": "warm",
        "seed": 3,
        "pairId": "LATENCY-M1:T06:warm:3"
      },
      "task": {
        "benchmark": "harness-bench",
        "instanceId": "LATENCY-M1:T06",
        "problemStatement": "read attention while irrelevant and relevant events arrive\nFrozen input A: \"unchanged-plus-unrelated\"\nFrozen input B: \"relevant-change-plus-ack\"\nUse the frozen source fixtures supplied in the assignment context. Return the complete requested output for both inputs with exact source identities and explicit evidence gaps. Do not edit product source or execute a saved rerun recipe.",
        "graderMeta": {
          "latencyM1": {
            "manifestSha256": "9d3837d43ebfddd7a18033175640b2333ae60ff35f73e861837c91d01f041dd6",
            "taskId": "T06",
            "pairId": "LATENCY-M1:T06:warm:3",
            "stratum": "warm",
            "repetition": 3,
            "qualityOracle": {
              "kind": "component-diagnosis",
              "required": [
                "For unchanged-plus-unrelated and relevant-change-plus-ack fixtures, return normalized observed attention contents, expected contents from seeded source state, per-key/generation source-build counts, invalidation reasons and measured handler durations.",
                "Compare against exact seeded generation/content/ack reference. Report freshness and unrelated-rebuild violations as violations; a known baseline defect is not relabeled correct.",
                "Task success means complete accurate evidence and verdict, not that the baseline cache passes R-3. Candidate R-3's no-unrelated-rebuild, fresh-content, coalescing and250ms controls remain separately mandatory."
              ]
            }
          }
        }
      }
    },
    {
      "key": {
        "task": "T07",
        "stratum": "cold",
        "repetition": 1,
        "arm": "baseline"
      },
      "nativeAssignment": {
        "taskId": "LATENCY-M1:T07",
        "armId": "cold",
        "seed": 1,
        "pairId": "LATENCY-M1:T07:cold:1"
      },
      "task": {
        "benchmark": "harness-bench",
        "instanceId": "LATENCY-M1:T07",
        "problemStatement": "look up modern typed promotion coverage idempotently\nFrozen input A: \"typed-only\"\nFrozen input B: \"mixed-typed-and-legacy\"\nUse the frozen source fixtures supplied in the assignment context. Return the complete requested output for both inputs with exact source identities and explicit evidence gaps. Do not edit product source or execute a saved rerun recipe.",
        "graderMeta": {
          "latencyM1": {
            "manifestSha256": "9d3837d43ebfddd7a18033175640b2333ae60ff35f73e861837c91d01f041dd6",
            "taskId": "T07",
            "pairId": "LATENCY-M1:T07:cold:1",
            "stratum": "cold",
            "repetition": 1,
            "qualityOracle": {
              "kind": "coverage-lookup",
              "required": [
                "Return the exact coverage edge/stamp and eligible target identity for typed-only or mixed typed/legacy fixtures; perform the repeated lookup and show no duplicate promotion side effect.",
                "Compare to the seeded target and terminal/parked eligibility reference; preserve workspace/harness scope. Diagnostic disclosure alone cannot replace a required correct lookup."
              ]
            }
          }
        }
      }
    },
    {
      "key": {
        "task": "T07",
        "stratum": "cold",
        "repetition": 2,
        "arm": "baseline"
      },
      "nativeAssignment": {
        "taskId": "LATENCY-M1:T07",
        "armId": "cold",
        "seed": 2,
        "pairId": "LATENCY-M1:T07:cold:2"
      },
      "task": {
        "benchmark": "harness-bench",
        "instanceId": "LATENCY-M1:T07",
        "problemStatement": "look up modern typed promotion coverage idempotently\nFrozen input A: \"typed-only\"\nFrozen input B: \"mixed-typed-and-legacy\"\nUse the frozen source fixtures supplied in the assignment context. Return the complete requested output for both inputs with exact source identities and explicit evidence gaps. Do not edit product source or execute a saved rerun recipe.",
        "graderMeta": {
          "latencyM1": {
            "manifestSha256": "9d3837d43ebfddd7a18033175640b2333ae60ff35f73e861837c91d01f041dd6",
            "taskId": "T07",
            "pairId": "LATENCY-M1:T07:cold:2",
            "stratum": "cold",
            "repetition": 2,
            "qualityOracle": {
              "kind": "coverage-lookup",
              "required": [
                "Return the exact coverage edge/stamp and eligible target identity for typed-only or mixed typed/legacy fixtures; perform the repeated lookup and show no duplicate promotion side effect.",
                "Compare to the seeded target and terminal/parked eligibility reference; preserve workspace/harness scope. Diagnostic disclosure alone cannot replace a required correct lookup."
              ]
            }
          }
        }
      }
    },
    {
      "key": {
        "task": "T07",
        "stratum": "cold",
        "repetition": 3,
        "arm": "baseline"
      },
      "nativeAssignment": {
        "taskId": "LATENCY-M1:T07",
        "armId": "cold",
        "seed": 3,
        "pairId": "LATENCY-M1:T07:cold:3"
      },
      "task": {
        "benchmark": "harness-bench",
        "instanceId": "LATENCY-M1:T07",
        "problemStatement": "look up modern typed promotion coverage idempotently\nFrozen input A: \"typed-only\"\nFrozen input B: \"mixed-typed-and-legacy\"\nUse the frozen source fixtures supplied in the assignment context. Return the complete requested output for both inputs with exact source identities and explicit evidence gaps. Do not edit product source or execute a saved rerun recipe.",
        "graderMeta": {
          "latencyM1": {
            "manifestSha256": "9d3837d43ebfddd7a18033175640b2333ae60ff35f73e861837c91d01f041dd6",
            "taskId": "T07",
            "pairId": "LATENCY-M1:T07:cold:3",
            "stratum": "cold",
            "repetition": 3,
            "qualityOracle": {
              "kind": "coverage-lookup",
              "required": [
                "Return the exact coverage edge/stamp and eligible target identity for typed-only or mixed typed/legacy fixtures; perform the repeated lookup and show no duplicate promotion side effect.",
                "Compare to the seeded target and terminal/parked eligibility reference; preserve workspace/harness scope. Diagnostic disclosure alone cannot replace a required correct lookup."
              ]
            }
          }
        }
      }
    },
    {
      "key": {
        "task": "T07",
        "stratum": "warm",
        "repetition": 1,
        "arm": "baseline"
      },
      "nativeAssignment": {
        "taskId": "LATENCY-M1:T07",
        "armId": "warm",
        "seed": 1,
        "pairId": "LATENCY-M1:T07:warm:1"
      },
      "task": {
        "benchmark": "harness-bench",
        "instanceId": "LATENCY-M1:T07",
        "problemStatement": "look up modern typed promotion coverage idempotently\nFrozen input A: \"typed-only\"\nFrozen input B: \"mixed-typed-and-legacy\"\nUse the frozen source fixtures supplied in the assignment context. Return the complete requested output for both inputs with exact source identities and explicit evidence gaps. Do not edit product source or execute a saved rerun recipe.",
        "graderMeta": {
          "latencyM1": {
            "manifestSha256": "9d3837d43ebfddd7a18033175640b2333ae60ff35f73e861837c91d01f041dd6",
            "taskId": "T07",
            "pairId": "LATENCY-M1:T07:warm:1",
            "stratum": "warm",
            "repetition": 1,
            "qualityOracle": {
              "kind": "coverage-lookup",
              "required": [
                "Return the exact coverage edge/stamp and eligible target identity for typed-only or mixed typed/legacy fixtures; perform the repeated lookup and show no duplicate promotion side effect.",
                "Compare to the seeded target and terminal/parked eligibility reference; preserve workspace/harness scope. Diagnostic disclosure alone cannot replace a required correct lookup."
              ]
            }
          }
        }
      }
    },
    {
      "key": {
        "task": "T07",
        "stratum": "warm",
        "repetition": 2,
        "arm": "baseline"
      },
      "nativeAssignment": {
        "taskId": "LATENCY-M1:T07",
        "armId": "warm",
        "seed": 2,
        "pairId": "LATENCY-M1:T07:warm:2"
      },
      "task": {
        "benchmark": "harness-bench",
        "instanceId": "LATENCY-M1:T07",
        "problemStatement": "look up modern typed promotion coverage idempotently\nFrozen input A: \"typed-only\"\nFrozen input B: \"mixed-typed-and-legacy\"\nUse the frozen source fixtures supplied in the assignment context. Return the complete requested output for both inputs with exact source identities and explicit evidence gaps. Do not edit product source or execute a saved rerun recipe.",
        "graderMeta": {
          "latencyM1": {
            "manifestSha256": "9d3837d43ebfddd7a18033175640b2333ae60ff35f73e861837c91d01f041dd6",
            "taskId": "T07",
            "pairId": "LATENCY-M1:T07:warm:2",
            "stratum": "warm",
            "repetition": 2,
            "qualityOracle": {
              "kind": "coverage-lookup",
              "required": [
                "Return the exact coverage edge/stamp and eligible target identity for typed-only or mixed typed/legacy fixtures; perform the repeated lookup and show no duplicate promotion side effect.",
                "Compare to the seeded target and terminal/parked eligibility reference; preserve workspace/harness scope. Diagnostic disclosure alone cannot replace a required correct lookup."
              ]
            }
          }
        }
      }
    },
    {
      "key": {
        "task": "T07",
        "stratum": "warm",
        "repetition": 3,
        "arm": "baseline"
      },
      "nativeAssignment": {
        "taskId": "LATENCY-M1:T07",
        "armId": "warm",
        "seed": 3,
        "pairId": "LATENCY-M1:T07:warm:3"
      },
      "task": {
        "benchmark": "harness-bench",
        "instanceId": "LATENCY-M1:T07",
        "problemStatement": "look up modern typed promotion coverage idempotently\nFrozen input A: \"typed-only\"\nFrozen input B: \"mixed-typed-and-legacy\"\nUse the frozen source fixtures supplied in the assignment context. Return the complete requested output for both inputs with exact source identities and explicit evidence gaps. Do not edit product source or execute a saved rerun recipe.",
        "graderMeta": {
          "latencyM1": {
            "manifestSha256": "9d3837d43ebfddd7a18033175640b2333ae60ff35f73e861837c91d01f041dd6",
            "taskId": "T07",
            "pairId": "LATENCY-M1:T07:warm:3",
            "stratum": "warm",
            "repetition": 3,
            "qualityOracle": {
              "kind": "coverage-lookup",
              "required": [
                "Return the exact coverage edge/stamp and eligible target identity for typed-only or mixed typed/legacy fixtures; perform the repeated lookup and show no duplicate promotion side effect.",
                "Compare to the seeded target and terminal/parked eligibility reference; preserve workspace/harness scope. Diagnostic disclosure alone cannot replace a required correct lookup."
              ]
            }
          }
        }
      }
    },
    {
      "key": {
        "task": "T08",
        "stratum": "cold",
        "repetition": 1,
        "arm": "baseline"
      },
      "nativeAssignment": {
        "taskId": "LATENCY-M1:T08",
        "armId": "cold",
        "seed": 1,
        "pairId": "LATENCY-M1:T08:cold:1"
      },
      "task": {
        "benchmark": "harness-bench",
        "instanceId": "LATENCY-M1:T08",
        "problemStatement": "look up exact legacy coverage with marker boundaries\nFrozen input A: \"legacy-only\"\nFrozen input B: \"boundary-and-parked\"\nUse the frozen source fixtures supplied in the assignment context. Return the complete requested output for both inputs with exact source identities and explicit evidence gaps. Do not edit product source or execute a saved rerun recipe.",
        "graderMeta": {
          "latencyM1": {
            "manifestSha256": "9d3837d43ebfddd7a18033175640b2333ae60ff35f73e861837c91d01f041dd6",
            "taskId": "T08",
            "pairId": "LATENCY-M1:T08:cold:1",
            "stratum": "cold",
            "repetition": 1,
            "qualityOracle": {
              "kind": "coverage-lookup",
              "required": [
                "Return only the exact legacy target for legacy-only or boundary/parked controls, excluding adjacent token matches and ineligible parked shadows; repeat idempotently.",
                "Compare all returned IDs/coverage receipts to the frozen fixture reference. A false positive, omitted eligible target or duplicate is a failed task."
              ]
            }
          }
        }
      }
    },
    {
      "key": {
        "task": "T08",
        "stratum": "cold",
        "repetition": 2,
        "arm": "baseline"
      },
      "nativeAssignment": {
        "taskId": "LATENCY-M1:T08",
        "armId": "cold",
        "seed": 2,
        "pairId": "LATENCY-M1:T08:cold:2"
      },
      "task": {
        "benchmark": "harness-bench",
        "instanceId": "LATENCY-M1:T08",
        "problemStatement": "look up exact legacy coverage with marker boundaries\nFrozen input A: \"legacy-only\"\nFrozen input B: \"boundary-and-parked\"\nUse the frozen source fixtures supplied in the assignment context. Return the complete requested output for both inputs with exact source identities and explicit evidence gaps. Do not edit product source or execute a saved rerun recipe.",
        "graderMeta": {
          "latencyM1": {
            "manifestSha256": "9d3837d43ebfddd7a18033175640b2333ae60ff35f73e861837c91d01f041dd6",
            "taskId": "T08",
            "pairId": "LATENCY-M1:T08:cold:2",
            "stratum": "cold",
            "repetition": 2,
            "qualityOracle": {
              "kind": "coverage-lookup",
              "required": [
                "Return only the exact legacy target for legacy-only or boundary/parked controls, excluding adjacent token matches and ineligible parked shadows; repeat idempotently.",
                "Compare all returned IDs/coverage receipts to the frozen fixture reference. A false positive, omitted eligible target or duplicate is a failed task."
              ]
            }
          }
        }
      }
    },
    {
      "key": {
        "task": "T08",
        "stratum": "cold",
        "repetition": 3,
        "arm": "baseline"
      },
      "nativeAssignment": {
        "taskId": "LATENCY-M1:T08",
        "armId": "cold",
        "seed": 3,
        "pairId": "LATENCY-M1:T08:cold:3"
      },
      "task": {
        "benchmark": "harness-bench",
        "instanceId": "LATENCY-M1:T08",
        "problemStatement": "look up exact legacy coverage with marker boundaries\nFrozen input A: \"legacy-only\"\nFrozen input B: \"boundary-and-parked\"\nUse the frozen source fixtures supplied in the assignment context. Return the complete requested output for both inputs with exact source identities and explicit evidence gaps. Do not edit product source or execute a saved rerun recipe.",
        "graderMeta": {
          "latencyM1": {
            "manifestSha256": "9d3837d43ebfddd7a18033175640b2333ae60ff35f73e861837c91d01f041dd6",
            "taskId": "T08",
            "pairId": "LATENCY-M1:T08:cold:3",
            "stratum": "cold",
            "repetition": 3,
            "qualityOracle": {
              "kind": "coverage-lookup",
              "required": [
                "Return only the exact legacy target for legacy-only or boundary/parked controls, excluding adjacent token matches and ineligible parked shadows; repeat idempotently.",
                "Compare all returned IDs/coverage receipts to the frozen fixture reference. A false positive, omitted eligible target or duplicate is a failed task."
              ]
            }
          }
        }
      }
    },
    {
      "key": {
        "task": "T08",
        "stratum": "warm",
        "repetition": 1,
        "arm": "baseline"
      },
      "nativeAssignment": {
        "taskId": "LATENCY-M1:T08",
        "armId": "warm",
        "seed": 1,
        "pairId": "LATENCY-M1:T08:warm:1"
      },
      "task": {
        "benchmark": "harness-bench",
        "instanceId": "LATENCY-M1:T08",
        "problemStatement": "look up exact legacy coverage with marker boundaries\nFrozen input A: \"legacy-only\"\nFrozen input B: \"boundary-and-parked\"\nUse the frozen source fixtures supplied in the assignment context. Return the complete requested output for both inputs with exact source identities and explicit evidence gaps. Do not edit product source or execute a saved rerun recipe.",
        "graderMeta": {
          "latencyM1": {
            "manifestSha256": "9d3837d43ebfddd7a18033175640b2333ae60ff35f73e861837c91d01f041dd6",
            "taskId": "T08",
            "pairId": "LATENCY-M1:T08:warm:1",
            "stratum": "warm",
            "repetition": 1,
            "qualityOracle": {
              "kind": "coverage-lookup",
              "required": [
                "Return only the exact legacy target for legacy-only or boundary/parked controls, excluding adjacent token matches and ineligible parked shadows; repeat idempotently.",
                "Compare all returned IDs/coverage receipts to the frozen fixture reference. A false positive, omitted eligible target or duplicate is a failed task."
              ]
            }
          }
        }
      }
    },
    {
      "key": {
        "task": "T08",
        "stratum": "warm",
        "repetition": 2,
        "arm": "baseline"
      },
      "nativeAssignment": {
        "taskId": "LATENCY-M1:T08",
        "armId": "warm",
        "seed": 2,
        "pairId": "LATENCY-M1:T08:warm:2"
      },
      "task": {
        "benchmark": "harness-bench",
        "instanceId": "LATENCY-M1:T08",
        "problemStatement": "look up exact legacy coverage with marker boundaries\nFrozen input A: \"legacy-only\"\nFrozen input B: \"boundary-and-parked\"\nUse the frozen source fixtures supplied in the assignment context. Return the complete requested output for both inputs with exact source identities and explicit evidence gaps. Do not edit product source or execute a saved rerun recipe.",
        "graderMeta": {
          "latencyM1": {
            "manifestSha256": "9d3837d43ebfddd7a18033175640b2333ae60ff35f73e861837c91d01f041dd6",
            "taskId": "T08",
            "pairId": "LATENCY-M1:T08:warm:2",
            "stratum": "warm",
            "repetition": 2,
            "qualityOracle": {
              "kind": "coverage-lookup",
              "required": [
                "Return only the exact legacy target for legacy-only or boundary/parked controls, excluding adjacent token matches and ineligible parked shadows; repeat idempotently.",
                "Compare all returned IDs/coverage receipts to the frozen fixture reference. A false positive, omitted eligible target or duplicate is a failed task."
              ]
            }
          }
        }
      }
    },
    {
      "key": {
        "task": "T08",
        "stratum": "warm",
        "repetition": 3,
        "arm": "baseline"
      },
      "nativeAssignment": {
        "taskId": "LATENCY-M1:T08",
        "armId": "warm",
        "seed": 3,
        "pairId": "LATENCY-M1:T08:warm:3"
      },
      "task": {
        "benchmark": "harness-bench",
        "instanceId": "LATENCY-M1:T08",
        "problemStatement": "look up exact legacy coverage with marker boundaries\nFrozen input A: \"legacy-only\"\nFrozen input B: \"boundary-and-parked\"\nUse the frozen source fixtures supplied in the assignment context. Return the complete requested output for both inputs with exact source identities and explicit evidence gaps. Do not edit product source or execute a saved rerun recipe.",
        "graderMeta": {
          "latencyM1": {
            "manifestSha256": "9d3837d43ebfddd7a18033175640b2333ae60ff35f73e861837c91d01f041dd6",
            "taskId": "T08",
            "pairId": "LATENCY-M1:T08:warm:3",
            "stratum": "warm",
            "repetition": 3,
            "qualityOracle": {
              "kind": "coverage-lookup",
              "required": [
                "Return only the exact legacy target for legacy-only or boundary/parked controls, excluding adjacent token matches and ineligible parked shadows; repeat idempotently.",
                "Compare all returned IDs/coverage receipts to the frozen fixture reference. A false positive, omitted eligible target or duplicate is a failed task."
              ]
            }
          }
        }
      }
    },
    {
      "key": {
        "task": "T09",
        "stratum": "cold",
        "repetition": 1,
        "arm": "baseline"
      },
      "nativeAssignment": {
        "taskId": "LATENCY-M1:T09",
        "armId": "cold",
        "seed": 1,
        "pairId": "LATENCY-M1:T09:cold:1"
      },
      "task": {
        "benchmark": "harness-bench",
        "instanceId": "LATENCY-M1:T09",
        "problemStatement": "read busy and quiet condition prefixes retaining old holds\nFrozen input A: \"busy-prefix\"\nFrozen input B: \"quiet-prefix\"\nUse the frozen source fixtures supplied in the assignment context. Return the complete requested output for both inputs with exact source identities and explicit evidence gaps. Do not edit product source or execute a saved rerun recipe.",
        "graderMeta": {
          "latencyM1": {
            "manifestSha256": "9d3837d43ebfddd7a18033175640b2333ae60ff35f73e861837c91d01f041dd6",
            "taskId": "T09",
            "pairId": "LATENCY-M1:T09:cold:1",
            "stratum": "cold",
            "repetition": 1,
            "qualityOracle": {
              "kind": "component-diagnosis",
              "required": [
                "Return normalized observed busy/quiet prefix holds and the complete independently folded causal reference set from the frozen10000-row fixture, including the20unresolved30-day-old holds.",
                "Identify every missing/extra hold and incorrect resolution with exact event/key identities; unrelated resolutions and age cannot release a hold.",
                "An accurate baseline mismatch report passes only this diagnostic task. Candidate R-5 still requires exact reference-set equality, bounded indexed access and250ms p95."
              ]
            }
          }
        }
      }
    },
    {
      "key": {
        "task": "T09",
        "stratum": "cold",
        "repetition": 2,
        "arm": "baseline"
      },
      "nativeAssignment": {
        "taskId": "LATENCY-M1:T09",
        "armId": "cold",
        "seed": 2,
        "pairId": "LATENCY-M1:T09:cold:2"
      },
      "task": {
        "benchmark": "harness-bench",
        "instanceId": "LATENCY-M1:T09",
        "problemStatement": "read busy and quiet condition prefixes retaining old holds\nFrozen input A: \"busy-prefix\"\nFrozen input B: \"quiet-prefix\"\nUse the frozen source fixtures supplied in the assignment context. Return the complete requested output for both inputs with exact source identities and explicit evidence gaps. Do not edit product source or execute a saved rerun recipe.",
        "graderMeta": {
          "latencyM1": {
            "manifestSha256": "9d3837d43ebfddd7a18033175640b2333ae60ff35f73e861837c91d01f041dd6",
            "taskId": "T09",
            "pairId": "LATENCY-M1:T09:cold:2",
            "stratum": "cold",
            "repetition": 2,
            "qualityOracle": {
              "kind": "component-diagnosis",
              "required": [
                "Return normalized observed busy/quiet prefix holds and the complete independently folded causal reference set from the frozen10000-row fixture, including the20unresolved30-day-old holds.",
                "Identify every missing/extra hold and incorrect resolution with exact event/key identities; unrelated resolutions and age cannot release a hold.",
                "An accurate baseline mismatch report passes only this diagnostic task. Candidate R-5 still requires exact reference-set equality, bounded indexed access and250ms p95."
              ]
            }
          }
        }
      }
    },
    {
      "key": {
        "task": "T09",
        "stratum": "cold",
        "repetition": 3,
        "arm": "baseline"
      },
      "nativeAssignment": {
        "taskId": "LATENCY-M1:T09",
        "armId": "cold",
        "seed": 3,
        "pairId": "LATENCY-M1:T09:cold:3"
      },
      "task": {
        "benchmark": "harness-bench",
        "instanceId": "LATENCY-M1:T09",
        "problemStatement": "read busy and quiet condition prefixes retaining old holds\nFrozen input A: \"busy-prefix\"\nFrozen input B: \"quiet-prefix\"\nUse the frozen source fixtures supplied in the assignment context. Return the complete requested output for both inputs with exact source identities and explicit evidence gaps. Do not edit product source or execute a saved rerun recipe.",
        "graderMeta": {
          "latencyM1": {
            "manifestSha256": "9d3837d43ebfddd7a18033175640b2333ae60ff35f73e861837c91d01f041dd6",
            "taskId": "T09",
            "pairId": "LATENCY-M1:T09:cold:3",
            "stratum": "cold",
            "repetition": 3,
            "qualityOracle": {
              "kind": "component-diagnosis",
              "required": [
                "Return normalized observed busy/quiet prefix holds and the complete independently folded causal reference set from the frozen10000-row fixture, including the20unresolved30-day-old holds.",
                "Identify every missing/extra hold and incorrect resolution with exact event/key identities; unrelated resolutions and age cannot release a hold.",
                "An accurate baseline mismatch report passes only this diagnostic task. Candidate R-5 still requires exact reference-set equality, bounded indexed access and250ms p95."
              ]
            }
          }
        }
      }
    },
    {
      "key": {
        "task": "T09",
        "stratum": "warm",
        "repetition": 1,
        "arm": "baseline"
      },
      "nativeAssignment": {
        "taskId": "LATENCY-M1:T09",
        "armId": "warm",
        "seed": 1,
        "pairId": "LATENCY-M1:T09:warm:1"
      },
      "task": {
        "benchmark": "harness-bench",
        "instanceId": "LATENCY-M1:T09",
        "problemStatement": "read busy and quiet condition prefixes retaining old holds\nFrozen input A: \"busy-prefix\"\nFrozen input B: \"quiet-prefix\"\nUse the frozen source fixtures supplied in the assignment context. Return the complete requested output for both inputs with exact source identities and explicit evidence gaps. Do not edit product source or execute a saved rerun recipe.",
        "graderMeta": {
          "latencyM1": {
            "manifestSha256": "9d3837d43ebfddd7a18033175640b2333ae60ff35f73e861837c91d01f041dd6",
            "taskId": "T09",
            "pairId": "LATENCY-M1:T09:warm:1",
            "stratum": "warm",
            "repetition": 1,
            "qualityOracle": {
              "kind": "component-diagnosis",
              "required": [
                "Return normalized observed busy/quiet prefix holds and the complete independently folded causal reference set from the frozen10000-row fixture, including the20unresolved30-day-old holds.",
                "Identify every missing/extra hold and incorrect resolution with exact event/key identities; unrelated resolutions and age cannot release a hold.",
                "An accurate baseline mismatch report passes only this diagnostic task. Candidate R-5 still requires exact reference-set equality, bounded indexed access and250ms p95."
              ]
            }
          }
        }
      }
    },
    {
      "key": {
        "task": "T09",
        "stratum": "warm",
        "repetition": 2,
        "arm": "baseline"
      },
      "nativeAssignment": {
        "taskId": "LATENCY-M1:T09",
        "armId": "warm",
        "seed": 2,
        "pairId": "LATENCY-M1:T09:warm:2"
      },
      "task": {
        "benchmark": "harness-bench",
        "instanceId": "LATENCY-M1:T09",
        "problemStatement": "read busy and quiet condition prefixes retaining old holds\nFrozen input A: \"busy-prefix\"\nFrozen input B: \"quiet-prefix\"\nUse the frozen source fixtures supplied in the assignment context. Return the complete requested output for both inputs with exact source identities and explicit evidence gaps. Do not edit product source or execute a saved rerun recipe.",
        "graderMeta": {
          "latencyM1": {
            "manifestSha256": "9d3837d43ebfddd7a18033175640b2333ae60ff35f73e861837c91d01f041dd6",
            "taskId": "T09",
            "pairId": "LATENCY-M1:T09:warm:2",
            "stratum": "warm",
            "repetition": 2,
            "qualityOracle": {
              "kind": "component-diagnosis",
              "required": [
                "Return normalized observed busy/quiet prefix holds and the complete independently folded causal reference set from the frozen10000-row fixture, including the20unresolved30-day-old holds.",
                "Identify every missing/extra hold and incorrect resolution with exact event/key identities; unrelated resolutions and age cannot release a hold.",
                "An accurate baseline mismatch report passes only this diagnostic task. Candidate R-5 still requires exact reference-set equality, bounded indexed access and250ms p95."
              ]
            }
          }
        }
      }
    },
    {
      "key": {
        "task": "T09",
        "stratum": "warm",
        "repetition": 3,
        "arm": "baseline"
      },
      "nativeAssignment": {
        "taskId": "LATENCY-M1:T09",
        "armId": "warm",
        "seed": 3,
        "pairId": "LATENCY-M1:T09:warm:3"
      },
      "task": {
        "benchmark": "harness-bench",
        "instanceId": "LATENCY-M1:T09",
        "problemStatement": "read busy and quiet condition prefixes retaining old holds\nFrozen input A: \"busy-prefix\"\nFrozen input B: \"quiet-prefix\"\nUse the frozen source fixtures supplied in the assignment context. Return the complete requested output for both inputs with exact source identities and explicit evidence gaps. Do not edit product source or execute a saved rerun recipe.",
        "graderMeta": {
          "latencyM1": {
            "manifestSha256": "9d3837d43ebfddd7a18033175640b2333ae60ff35f73e861837c91d01f041dd6",
            "taskId": "T09",
            "pairId": "LATENCY-M1:T09:warm:3",
            "stratum": "warm",
            "repetition": 3,
            "qualityOracle": {
              "kind": "component-diagnosis",
              "required": [
                "Return normalized observed busy/quiet prefix holds and the complete independently folded causal reference set from the frozen10000-row fixture, including the20unresolved30-day-old holds.",
                "Identify every missing/extra hold and incorrect resolution with exact event/key identities; unrelated resolutions and age cannot release a hold.",
                "An accurate baseline mismatch report passes only this diagnostic task. Candidate R-5 still requires exact reference-set equality, bounded indexed access and250ms p95."
              ]
            }
          }
        }
      }
    },
    {
      "key": {
        "task": "T10",
        "stratum": "cold",
        "repetition": 1,
        "arm": "baseline"
      },
      "nativeAssignment": {
        "taskId": "LATENCY-M1:T10",
        "armId": "cold",
        "seed": 1,
        "pairId": "LATENCY-M1:T10:cold:1"
      },
      "task": {
        "benchmark": "harness-bench",
        "instanceId": "LATENCY-M1:T10",
        "problemStatement": "retrieve under an entry deadline and preserve fallback\nFrozen input A: \"on-time\"\nFrozen input B: \"pre-entry-delay-and-late\"\nUse the frozen source fixtures supplied in the assignment context. Return the complete requested output for both inputs with exact source identities and explicit evidence gaps. Do not edit product source or execute a saved rerun recipe.",
        "graderMeta": {
          "latencyM1": {
            "manifestSha256": "9d3837d43ebfddd7a18033175640b2333ae60ff35f73e861837c91d01f041dd6",
            "taskId": "T10",
            "pairId": "LATENCY-M1:T10:cold:1",
            "stratum": "cold",
            "repetition": 1,
            "qualityOracle": {
              "kind": "component-diagnosis",
              "required": [
                "For on-time or pre-entry-delay/late fixtures, return monotonic call-entry, embedder-entry, queue/network/timer/terminal timestamps, configured budget, actual accepted/rejected result and lexical fallback identity.",
                "Compare disposition against the frozen expected deadline/fallback schedule; explicitly flag a late accepted embedding or uncancelled queued/network request.",
                "An accurate baseline defect diagnosis passes only this task. Candidate R-6 still must enforce the original call-entry deadline, cancellation and fallback; no larger budget, ignored late success or synthetic latency may satisfy it."
              ]
            }
          }
        }
      }
    },
    {
      "key": {
        "task": "T10",
        "stratum": "cold",
        "repetition": 2,
        "arm": "baseline"
      },
      "nativeAssignment": {
        "taskId": "LATENCY-M1:T10",
        "armId": "cold",
        "seed": 2,
        "pairId": "LATENCY-M1:T10:cold:2"
      },
      "task": {
        "benchmark": "harness-bench",
        "instanceId": "LATENCY-M1:T10",
        "problemStatement": "retrieve under an entry deadline and preserve fallback\nFrozen input A: \"on-time\"\nFrozen input B: \"pre-entry-delay-and-late\"\nUse the frozen source fixtures supplied in the assignment context. Return the complete requested output for both inputs with exact source identities and explicit evidence gaps. Do not edit product source or execute a saved rerun recipe.",
        "graderMeta": {
          "latencyM1": {
            "manifestSha256": "9d3837d43ebfddd7a18033175640b2333ae60ff35f73e861837c91d01f041dd6",
            "taskId": "T10",
            "pairId": "LATENCY-M1:T10:cold:2",
            "stratum": "cold",
            "repetition": 2,
            "qualityOracle": {
              "kind": "component-diagnosis",
              "required": [
                "For on-time or pre-entry-delay/late fixtures, return monotonic call-entry, embedder-entry, queue/network/timer/terminal timestamps, configured budget, actual accepted/rejected result and lexical fallback identity.",
                "Compare disposition against the frozen expected deadline/fallback schedule; explicitly flag a late accepted embedding or uncancelled queued/network request.",
                "An accurate baseline defect diagnosis passes only this task. Candidate R-6 still must enforce the original call-entry deadline, cancellation and fallback; no larger budget, ignored late success or synthetic latency may satisfy it."
              ]
            }
          }
        }
      }
    },
    {
      "key": {
        "task": "T10",
        "stratum": "cold",
        "repetition": 3,
        "arm": "baseline"
      },
      "nativeAssignment": {
        "taskId": "LATENCY-M1:T10",
        "armId": "cold",
        "seed": 3,
        "pairId": "LATENCY-M1:T10:cold:3"
      },

