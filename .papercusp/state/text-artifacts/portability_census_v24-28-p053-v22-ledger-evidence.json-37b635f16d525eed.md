---
rel_path: "portability/census/v24-28-p053-v22-ledger-evidence.json-37b635f16d525eed"
updated_at: 1794230641786
_body: "content"
---

{
  "ledger": {
    "count": 2,
    "total": 2,
    "truncatedByLimit": false,
    "latestPerFile": false,
    "effectiveSourceFilter": "none (exact testRunIds receipt lookup)",
    "omittedBySourceFilter": 0,
    "runs": [
      {
        "id": 23743003,
        "workspaceId": "papercusp-workspace",
        "harnessSlug": "papercusp",
        "root": null,
        "filePath": "packages/operator-core/lib/backup/state-census-cli.test.ts",
        "status": "pass",
        "framework": "vitest",
        "startedAt": "2026-11-09T12:53:21.085Z",
        "finishedAt": "2026-11-09T12:53:28.655Z",
        "durationMs": 7570,
        "commitSha": "54e01eef4c7cd779f6a569ca2871a4306ecc231c",
        "runGroupId": "5edb5d4e-1c23-4069-9b55-e21e60b47bc8",
        "source": "local",
        "branch": "staging",
        "outputTail": null,
        "loopLagP95Ms": null,
        "rssMb": 451.7,
        "saturationSuspect": null,
        "worktreeDirty": true,
        "isScratchConfig": false
      },
      {
        "id": 23742987,
        "workspaceId": "papercusp-workspace",
        "harnessSlug": "papercusp",
        "root": null,
        "filePath": "packages/operator-core/lib/backup/state-census-producers.test.ts",
        "status": "pass",
        "framework": "vitest",
        "startedAt": "2026-11-09T12:52:20.547Z",
        "finishedAt": "2026-11-09T12:52:23.023Z",
        "durationMs": 2476,
        "commitSha": "54e01eef4c7cd779f6a569ca2871a4306ecc231c",
        "runGroupId": "5570a7ef-fe75-4455-9f31-94fbf682d9ac",
        "source": "local",
        "branch": "staging",
        "outputTail": null,
        "loopLagP95Ms": null,
        "rssMb": 461.8,
        "saturationSuspect": null,
        "worktreeDirty": true,
        "isScratchConfig": false
      }
    ]
  },
  "evidence": {
    "ok": true,
    "slug": "portable-papercusp-container-and-native-2026-10-06",
    "harnessSlug": "papercusp",
    "bounded": {
      "limit": 2,
      "truncatedByLimit": false
    },
    "detail": "full",
    "evidence": [
      {
        "id": 79570,
        "workItemId": "WI-10007347",
        "planSlug": "portable-papercusp-container-and-native-2026-10-06",
        "specId": "PPC-P-053-1",
        "sourceValId": null,
        "specRevision": 2,
        "currentRevision": 2,
        "specFingerprint": "2298d99cf7d09f99ca0b0212c2f3f176624ca7a8d70c40bb695ac8560d4b4026",
        "evidenceKind": "test",
        "evidenceRef": "test-run-group:5edb5d4e-1c23-4069-9b55-e21e60b47bc8:0",
        "fingerprints": {
          "sourceFingerprint": "sha256-file-set-v1:a59aacf6b8f0db17b83ec65715848db45fa2784ab5c02c3e95c043e54e892176",
          "testFingerprint": "sha256-file-set-v1:e139e9b3b61237af5cd9399a3e5faa32907e1b01fb5eaec4a0338310e3ab2dfa",
          "fixtureFingerprint": null,
          "rubricFingerprint": null,
          "environmentFingerprint": null
        },
        "coverageEvidenceRef": null,
        "testRunId": 23743003,
        "testRunProvenance": {
          "filePath": "packages/operator-core/lib/backup/state-census-cli.test.ts",
          "commitSha": "54e01eef4c7cd779f6a569ca2871a4306ecc231c",
          "worktreeDirty": true
        },
        "details": {
          "adequacy": {
            "outcome": "pass",
            "skipped": false,
            "executed": true,
            "collected": true,
            "testLayer": "unit"
          },
          "testExecution": {
            "phase": "settled",
            "runId": "5edb5d4e-1c23-4069-9b55-e21e60b47bc8",
            "binding": {
              "specId": "PPC-P-053-1",
              "testPath": "packages/operator-core/lib/backup/state-census-cli.test.ts",
              "testLayer": "unit",
              "sourcePaths": [
                "scripts/state-census-roots.mts",
                "packages/operator-core/lib/backup/state-census-producers.ts"
              ],
              "specRevision": 2
            },
            "originRunId": "5edb5d4e-1c23-4069-9b55-e21e60b47bc8",
            "ledgerStatus": "pass",
            "sourceStable": true,
            "ledgerMatches": 1,
            "schemaVersion": 1,
            "measuredOutcome": "pass",
            "ledgerRunGroupId": "5edb5d4e-1c23-4069-9b55-e21e60b47bc8",
            "ledgerAttribution": "attributed",
            "observedTestLayer": "unit"
          },
          "measurementPin": {
            "files": [
              {
                "path": "packages/operator-core/lib/backup/state-census-producers.ts",
                "repo": ".",
                "clean": true,
                "sha256": "cda4cbad98aef196a6f148994e718aaf9430759dcd52ad6eeb187c8fba257861",
                "headBlob": "d77d0c6dacc65c03aea948dcd265d439d2d55f17",
                "dimension": "source"
              },
              {
                "path": "scripts/state-census-roots.mts",
                "repo": ".",
                "clean": false,
                "sha256": "ba7b5dba89b3e353ac2eb20bdf820c6946dd0c015053aee8f5bed29e0fc1e075",
                "headBlob": "a7ab4b916089c6a7b2a5b5380cb7038e643bc1c8",
                "dimension": "source"
              },
              {
                "path": "packages/operator-core/lib/backup/state-census-cli.test.ts",
                "repo": ".",
                "clean": false,
                "sha256": "1ab454a209070731c53f6c28dbdb1332b787f92c465b3a5a50d3be602225f0a1",
                "headBlob": "2e43d8e027ca90beaf5cf68d2602948112fea616",
                "dimension": "test"
              }
            ],
            "repos": [
              {
                "head": "54e01eef4c7cd779f6a569ca2871a4306ecc231c",
                "repo": ".",
                "gitlink": null
              }
            ],
            "schemaVersion": 1
          },
          "currentMeasurement": {
            "kind": "repo-files",
            "testPaths": [
              "packages/operator-core/lib/backup/state-census-cli.test.ts"
            ],
            "sourcePaths": [
              "scripts/state-census-roots.mts",
              "packages/operator-core/lib/backup/state-census-producers.ts"
            ],
            "schemaVersion": 1
          }
        },
        "observedAt": "2026-11-09T12:53:29.864Z",
        "bindingFingerprint": "e37e74e1b460fb43325f948015b6c10b4c0f289d8b0dd57c7724c5c7394b2933",
        "createdBy": "su-9c6a99bd-29c5-400e-9695-bb508269b6c9",
        "createdAt": "2026-11-09T12:53:29.855Z",
        "serverMeasurement": {
          "status": "measured",
          "measuredDimensions": [
            "source",
            "test"
          ],
          "current": {
            "planSlug": "portable-papercusp-container-and-native-2026-10-06",
            "specId": "PPC-P-053-1",
            "specRevision": 2,
            "specFingerprint": "2298d99cf7d09f99ca0b0212c2f3f176624ca7a8d70c40bb695ac8560d4b4026",
            "evidenceKind": "test",
            "evidenceRef": "test-run-group:5edb5d4e-1c23-4069-9b55-e21e60b47bc8:0",
            "sourceFingerprint": "sha256-file-set-v1:a59aacf6b8f0db17b83ec65715848db45fa2784ab5c02c3e95c043e54e892176",
            "testFingerprint": "sha256-file-set-v1:e139e9b3b61237af5cd9399a3e5faa32907e1b01fb5eaec4a0338310e3ab2dfa"
          }
        },
        "currentness": {
          "overall": "current",
          "dimensions": {
            "spec": "current",
            "source": "current",
            "test": "current",
            "fixture": "not-applicable",
            "rubric": "not-applicable",
            "environment": "not-applicable",
            "coverageEvidence": "not-applicable",
            "testRun": "current"
          },
          "staleReasons": [],
          "unknownReasons": [],
          "comparisonSupplied": true,
          "provenance": "server-measured"
        }
      },
      {
        "id": 79568,
        "workItemId": "WI-10007347",
        "planSlug": "portable-papercusp-container-and-native-2026-10-06",
        "specId": "AUTO-BAR-R-2-P-053",
        "sourceValId": null,
        "specRevision": 4,
        "currentRevision": 4,
        "specFingerprint": "b542ea4562cacfb86ae7c55fbecd3c23018c699e9a15087b070d1a1a2886bbea",
        "evidenceKind": "test",
        "evidenceRef": "test-run-group:5570a7ef-fe75-4455-9f31-94fbf682d9ac:1",
        "fingerprints": {
          "sourceFingerprint": "sha256-file-set-v1:a59aacf6b8f0db17b83ec65715848db45fa2784ab5c02c3e95c043e54e892176",
          "testFingerprint": "sha256-file-set-v1:902a6fb68c2b21edec5444cf7a6d560f50f154fcfd05f284dd7f7dd0b5f0b884",
          "fixtureFingerprint": null,
          "rubricFingerprint": null,
          "environmentFingerprint": null
        },
        "coverageEvidenceRef": null,
        "testRunId": 23742987,
        "testRunProvenance": {
          "filePath": "packages/operator-core/lib/backup/state-census-producers.test.ts",
          "commitSha": "54e01eef4c7cd779f6a569ca2871a4306ecc231c",
          "worktreeDirty": true
        },
        "details": {
          "adequacy": {
            "outcome": "pass",
            "skipped": false,
            "executed": true,
            "collected": true,
            "testLayer": "unit"
          },
          "testExecution": {
            "phase": "settled",
            "runId": "5570a7ef-fe75-4455-9f31-94fbf682d9ac",
            "binding": {
              "specId": "AUTO-BAR-R-2-P-053",
              "testPath": "packages/operator-core/lib/backup/state-census-producers.test.ts",
              "testLayer": "unit",
              "sourcePaths": [
                "packages/operator-core/lib/backup/state-census-producers.ts",
                "scripts/state-census-roots.mts"
              ],
              "specRevision": 4
            },
            "originRunId": "5570a7ef-fe75-4455-9f31-94fbf682d9ac",
            "ledgerStatus": "pass",
            "sourceStable": true,
            "ledgerMatches": 1,
            "schemaVersion": 1,
            "measuredOutcome": "pass",
            "ledgerRunGroupId": "5570a7ef-fe75-4455-9f31-94fbf682d9ac",
            "ledgerAttribution": "attributed",
            "observedTestLayer": "unit"
          },
          "measurementPin": {
            "files": [
              {
                "path": "packages/operator-core/lib/backup/state-census-producers.ts",
                "repo": ".",
                "clean": true,
                "sha256": "cda4cbad98aef196a6f148994e718aaf9430759dcd52ad6eeb187c8fba257861",
                "headBlob": "d77d0c6dacc65c03aea948dcd265d439d2d55f17",
                "dimension": "source"
              },
              {
                "path": "scripts/state-census-roots.mts",
                "repo": ".",
                "clean": false,
                "sha256": "ba7b5dba89b3e353ac2eb20bdf820c6946dd0c015053aee8f5bed29e0fc1e075",
                "headBlob": "a7ab4b916089c6a7b2a5b5380cb7038e643bc1c8",
                "dimension": "source"
              },
              {
                "path": "packages/operator-core/lib/backup/state-census-producers.test.ts",
                "repo": ".",
                "clean": true,
                "sha256": "13d4ca404fc290f260d8940851db22a77da65f6c58dd8773fbfca69906c358ba",
                "headBlob": "044fd970da28b9315e47a5c08c7d6106242efd00",
                "dimension": "test"
              }
            ],
            "repos": [
              {
                "head": "54e01eef4c7cd779f6a569ca2871a4306ecc231c",
                "repo": ".",
                "gitlink": null
              }
            ],
            "schemaVersion": 1
          },
          "currentMeasurement": {
            "kind": "repo-files",
            "testPaths": [
              "packages/operator-core/lib/backup/state-census-producers.test.ts"
            ],
            "sourcePaths": [
              "packages/operator-core/lib/backup/state-census-producers.ts",
              "scripts/state-census-roots.mts"
            ],
            "schemaVersion": 1
          }
        },
        "observedAt": "2026-11-09T12:52:32.655Z",
        "bindingFingerprint": "b6a3b7565ca6c2a0f615004ceac909d6f6f48ff4b10b843eeb7bd26c019cbf31",
        "createdBy": "su-9c6a99bd-29c5-400e-9695-bb508269b6c9",
        "createdAt": "2026-11-09T12:52:32.648Z",
        "serverMeasurement": {
          "status": "measured",
          "measuredDimensions": [
            "source",
            "test"
          ],
          "current": {
            "planSlug": "portable-papercusp-container-and-native-2026-10-06",
            "specId": "AUTO-BAR-R-2-P-053",
            "specRevision": 4,
            "specFingerprint": "b542ea4562cacfb86ae7c55fbecd3c23018c699e9a15087b070d1a1a2886bbea",
            "evidenceKind": "test",
            "evidenceRef": "test-run-group:5570a7ef-fe75-4455-9f31-94fbf682d9ac:1",
            "sourceFingerprint": "sha256-file-set-v1:a59aacf6b8f0db17b83ec65715848db45fa2784ab5c02c3e95c043e54e892176",
            "testFingerprint": "sha256-file-set-v1:902a6fb68c2b21edec5444cf7a6d560f50f154fcfd05f284dd7f7dd0b5f0b884"
          }
        },
        "currentness": {
          "overall": "current",
          "dimensions": {
            "spec": "current",
            "source": "current",
            "test": "current",
            "fixture": "not-applicable",
            "rubric": "not-applicable",
            "environment": "not-applicable",
            "coverageEvidence": "not-applicable",
            "testRun": "current"
          },
          "staleReasons": [],
          "unknownReasons": [],
          "comparisonSupplied": true,
          "provenance": "server-measured"
        }
      }
    ],
    "count": 2,
    "currentness": {
      "current": 2,
      "stale": 0,
      "unknown": 0
    }
  }
}
