---
rel_path: "evidence/workflow-efficiency/r23-fixture-origin-supplement-20261108-be2745bc773d.json"
updated_at: 1794155050023
_body: "content"
---

{
  "schemaVersion": 1,
  "baselineCommit": "6b87054b1944667bf17fc0c78a815cde8b884f45",
  "reviewPacketSha256": "34baab35e3d84f375dbdd5cf3b5e4e9b75e1ce72cc0ceda57c79a6b4c2677a6d",
  "source": "git blame --line-porcelain exact frozen case span + canonical Papercusp trailers (writer edit-attribution.ts parsePapercuspTrailers / commit-attribution-rows.ts)",
  "caseOrigins": [
    {
      "flowId": "P-016",
      "path": "packages/operator-core/lib/agent-tools/plans/plan-admission-preflight.test.ts",
      "testName": "counts reconciled live parent and child coverage as one execution lane",
      "caseSha256": "157baf90ed8fe0718d8bbc46fed9cfe623edaf17f03947cc19593d0eeb3096e5",
      "lineStart": 154,
      "lineEnd": 165,
      "caseLineOriginCommits": [
        "40458fdab460bc5ecb81c8405c6ac27c3bfd2bf5"
      ],
      "productionCandidate": {
        "path": "packages/operator-core/lib/agent-tools/plans/plan-admission-preflight.ts",
        "lastChange": {
          "commit": "ec10e29e01440d551749a16ba09f103e935f2c11",
          "gitAuthor": "papercusp-git-sync",
          "authoredAt": "2026-11-05T15:40:03-05:00",
          "committedAt": "2026-11-05T15:40:03-05:00",
          "trailers": {},
          "agentAttribution": null,
          "agentAttributionStatus": "unknown/multiple-or-absent trailers",
          "commitMessageSha256": "511ac3eb1600cf6b3f8761adc0192d8554b007f20395f266f152fcf4ca481402"
        }
      },
      "independence": "unknown; line/commit source attribution is evidence for review, not independent oracle approval"
    },
    {
      "flowId": "P-017",
      "path": "packages/operator-core/lib/storage/retention-pins.test.ts",
      "testName": "pins evidence before accepting a binding and refuses intake after its retained root is gone",
      "caseSha256": "821f6d4bf379a86bd1cffb51fdd3e906f09f3e7d069715fa811998a0369a5503",
      "lineStart": 130,
      "lineEnd": 148,
      "caseLineOriginCommits": [
        "a15801a272aa485a13c2aab951e91fd49a3feac7"
      ],
      "productionCandidate": {
        "path": "packages/operator-core/lib/storage/retention-pins.ts",
        "lastChange": {
          "commit": "7ef025b18ce0a7e1c39249cc8346a3b774748c37",
          "gitAuthor": "papercusp-git-sync",
          "authoredAt": "2026-11-07T23:32:08-05:00",
          "committedAt": "2026-11-07T23:32:08-05:00",
          "trailers": {
            "Papercusp-Agent": [
              "su-bd7bb60b-f269-4533-95f8-a01a37d59f27",
              "su-60a9de95-dd40-4807-8e4b-107dcd49c416",
              "su-1a1d1b35-c317-44f4-a10b-51661ce46a8e",
              "su-5c46e76e-e3d6-448c-8959-58dcdfb533f9"
            ]
          },
          "agentAttribution": null,
          "agentAttributionStatus": "unknown/multiple-or-absent trailers",
          "commitMessageSha256": "52731f8a5a8b9bb0b052c842aa4cac3838612d42383df8954ca0998cf18542ae"
        }
      },
      "independence": "unknown; line/commit source attribution is evidence for review, not independent oracle approval"
    },
    {
      "flowId": "P-018",
      "path": "packages/operator-core/lib/prior-attempt-context.test.ts",
      "testName": "normalizes root cause, retraction, files, tests, and residue without inventing absent fields",
      "caseSha256": "766a12b23ee07a99704b56f0977e03b0705dc4c9efca1476780add528a281795",
      "lineStart": 53,
      "lineEnd": 76,
      "caseLineOriginCommits": [
        "dd7ac420e6e18aa99a984e9b7d86d24411c82fa8"
      ],
      "productionCandidate": {
        "path": "packages/operator-core/lib/prior-attempt-context.ts",
        "lastChange": {
          "commit": "b8f9bf5373d29378f364e36d1898b9e853e24167",
          "gitAuthor": "papercusp-git-sync",
          "authoredAt": "2026-11-07T13:17:06-05:00",
          "committedAt": "2026-11-07T13:17:06-05:00",
          "trailers": {},
          "agentAttribution": null,
          "agentAttributionStatus": "unknown/multiple-or-absent trailers",
          "commitMessageSha256": "6a22bb077b3433634778274374798459ab09dd2ac3292fa9b5d9e18d4e0750e4"
        }
      },
      "independence": "unknown; line/commit source attribution is evidence for review, not independent oracle approval"
    },
    {
      "flowId": "P-019",
      "path": "packages/operator-core/lib/memory/injection.test.ts",
      "testName": "passes fusionMode cosine-gated on the search covering EVERY pool (user, harness, hive)",
      "caseSha256": "a9b4a9e9bfa4ec03122d600b5d3cef87adffbee01b161ac7677fd9c0bc265777",
      "lineStart": 475,
      "lineEnd": 492,
      "caseLineOriginCommits": [
        "cb48d78f52e07eda06b165f261a5835ac9df6433",
        "1dd4e423710a2e199a57ca07f6e547cb5385aa23",
        "458755b56eefcfe82e76318748e6f414465d9de5",
        "5a14159ea62c55383ad48915548f4d25113a8ec9"
      ],
      "productionCandidate": {
        "path": "packages/operator-core/lib/memory/injection.ts",
        "lastChange": {
          "commit": "a3734b939d8ff4bc43e93517fca00fce81a7bdc3",
          "gitAuthor": "papercusp-git-sync",
          "authoredAt": "2026-11-07T21:41:14-05:00",
          "committedAt": "2026-11-07T21:41:14-05:00",
          "trailers": {},
          "agentAttribution": null,
          "agentAttributionStatus": "unknown/multiple-or-absent trailers",
          "commitMessageSha256": "60a6203a380393c3f0689de7640dea3ee862c84c9a06d825db1c84dafd8a9b38"
        }
      },
      "independence": "unknown; line/commit source attribution is evidence for review, not independent oracle approval"
    },
    {
      "flowId": "P-020",
      "path": "packages/operator-core/lib/mission-continuity.test.ts",
      "testName": "keeps the parent and its criteria across ordinary child progress",
      "caseSha256": "18cd02115282973e978cf31c9eee68e328b616ac24238b12088298578800af07",
      "lineStart": 49,
      "lineEnd": 57,
      "caseLineOriginCommits": [
        "0c066799bc47228ae79e4f82a10df6b8a3066dae"
      ],
      "productionCandidate": {
        "path": "packages/operator-core/lib/mission-continuity.ts",
        "lastChange": {
          "commit": "96be52b0ebaf43a98546ef1fad88e973c432800a",
          "gitAuthor": "papercusp-git-sync",
          "authoredAt": "2026-11-05T21:39:54-05:00",
          "committedAt": "2026-11-05T21:39:54-05:00",
          "trailers": {
            "Papercusp-Agent": [
              "su-a1704cc4-e6d7-41f7-92dc-9d6832adc070"
            ],
            "Papercusp-Session": [
              "su-a1704cc4-e6d7-41f7-92dc-9d6832adc070"
            ]
          },
          "agentAttribution": "su-a1704cc4-e6d7-41f7-92dc-9d6832adc070",
          "agentAttributionStatus": "single commit trailer; not a per-line edit receipt",
          "commitMessageSha256": "6b81368c745bd0f20bfebcfcca5666a143f92e2e43164f8ea7d82e2d724160c5"
        }
      },
      "independence": "unknown; line/commit source attribution is evidence for review, not independent oracle approval"
    },
    {
      "flowId": "P-021",
      "path": "packages/operator-core/lib/native-device-fixture.test.ts",
      "testName": "installs only projected credentials in disposable HOME and removes its exact files",
      "caseSha256": "6f4b3f3c4c0bf6751ebf2795943ced9fd33e2d0bda6d6675ef6d4dcf6e647c5e",
      "lineStart": 26,
      "lineEnd": 59,
      "caseLineOriginCommits": [
        "9a010889985cf21599851cac18b9b979767621ff"
      ],
      "productionCandidate": {
        "path": "packages/operator-core/lib/native-device-fixture.ts",
        "lastChange": {
          "commit": "8c75bcc8d05381c3d0508d157d8d74a1501aaf14",
          "gitAuthor": "papercusp-git-sync",
          "authoredAt": "2026-10-27T16:31:51-04:00",
          "committedAt": "2026-10-27T16:31:51-04:00",
          "trailers": {
            "Papercusp-Agent": [
              "su-f4c37369-6459-436f-a9f5-3f83e4a5007b"
            ],
            "Papercusp-Work-Item": [
              "WI-6554700010030423"
            ]
          },
          "agentAttribution": "su-f4c37369-6459-436f-a9f5-3f83e4a5007b",
          "agentAttributionStatus": "single commit trailer; not a per-line edit receipt",
          "commitMessageSha256": "8b3fba95886393a255707bf0ed42f9524b7fe78820e72107467997451ce5608c"
        }
      },
      "independence": "unknown; line/commit source attribution is evidence for review, not independent oracle approval"
    },
    {
      "flowId": "P-022",
      "path": "packages/operator-core/lib/prior-attempt-measurement.test.ts",
      "testName": "computes P95, latency, omission fidelity, pressure, and canonical price-table cost",
      "caseSha256": "e3e63d2ba167659e6189affe254e9d6addecd99c6ad4ce932282744a49a0f8e6",
      "lineStart": 40,
      "lineEnd": 50,
      "caseLineOriginCommits": [
        "44637e2610aec432304dcd205aa760681826acbc"
      ],
      "productionCandidate": {
        "path": "packages/operator-core/lib/prior-attempt-measurement.ts",
        "lastChange": {
          "commit": "44637e2610aec432304dcd205aa760681826acbc",
          "gitAuthor": "papercusp-git-sync",
          "authoredAt": "2026-08-20T17:52:24-04:00",
          "committedAt": "2026-08-20T17:52:24-04:00",
          "trailers": {
            "Papercusp-Agent": [
              "su-c5a07187-ed32-4ec0-8cb5-4bee0b1c85b8"
            ],
            "Papercusp-Work-Item": [
              "WI-40077, WI-40078"
            ],
            "Papercusp-Plan": [
              "first-class-spec-clauses-and-prior-attempt-briefs-2026-08-20"
            ]
          },
          "agentAttribution": "su-c5a07187-ed32-4ec0-8cb5-4bee0b1c85b8",
          "agentAttributionStatus": "single commit trailer; not a per-line edit receipt",
          "commitMessageSha256": "43e3ab0ece483ce65c2c6ef4a56223455a23e52538050d2c89f16a3750627fac"
        }
      },
      "independence": "unknown; line/commit source attribution is evidence for review, not independent oracle approval"
    },
    {
      "flowId": "P-023",
      "path": "packages/operator-core/lib/agent-tools/plans/derived-ship-gate.test.ts",
      "testName": "reuses a requested shipReadiness verdict instead of evaluating the gate twice",
      "caseSha256": "0895836fed6924717d52b81ad3abedff416db444856b6e63e4d9fdc91ecde3e0",
      "lineStart": 83,
      "lineEnd": 90,
      "caseLineOriginCommits": [
        "ec4366d0843c68dc1ad481a9b86ab476186b6ca8"
      ],
      "productionCandidate": {
        "path": "packages/operator-core/lib/agent-tools/plans/derived-ship-gate.ts",
        "lastChange": {
          "commit": "cb0a63cabc422c5d1633293a1b89118b1aa2b29e",
          "gitAuthor": "papercusp-git-sync",
          "authoredAt": "2026-10-12T12:10:47-04:00",
          "committedAt": "2026-10-12T12:10:47-04:00",
          "trailers": {
            "Papercusp-Agent": [
              "su-e8ac915f-5cb9-4405-a669-9e1c13c88bfb"
            ],
            "Papercusp-Plan": [
              "derived-status-not-hand-written-2026-10-12"
            ]
          },
          "agentAttribution": "su-e8ac915f-5cb9-4405-a669-9e1c13c88bfb",
          "agentAttributionStatus": "single commit trailer; not a per-line edit receipt",
          "commitMessageSha256": "56705591401c0d4b89f9a92c8390c7a845ed5cb1d0c6f299402b75aa10b75777"
        }
      },
      "independence": "unknown; line/commit source attribution is evidence for review, not independent oracle approval"
    }
  ],
  "commits": [
    {
      "commit": "40458fdab460bc5ecb81c8405c6ac27c3bfd2bf5",
      "gitAuthor": "papercusp-git-sync",
      "authoredAt": "2026-11-02T01:28:49-05:00",
      "committedAt": "2026-11-02T01:28:49-05:00",
      "trailers": {
        "Papercusp-Agent": [
          "su-respawn-63bfff47ddf3583f5111e499fb21db10",
          "su-6aaf9b6a-27e9-42af-95c6-e7e571bdc311"
        ],
        "Papercusp-Work-Item": [
          "EI-27563882027099268"
        ]
      },
      "agentAttribution": null,
      "agentAttributionStatus": "unknown/multiple-or-absent trailers",
      "commitMessageSha256": "8d87a1087f9e6bc9de52b3682f01f3d46b047e6232ef11d43403f1509aef0263"
    },
    {
      "commit": "ec10e29e01440d551749a16ba09f103e935f2c11",
      "gitAuthor": "papercusp-git-sync",
      "authoredAt": "2026-11-05T15:40:03-05:00",
      "committedAt": "2026-11-05T15:40:03-05:00",
      "trailers": {},
      "agentAttribution": null,
      "agentAttributionStatus": "unknown/multiple-or-absent trailers",
      "commitMessageSha256": "511ac3eb1600cf6b3f8761adc0192d8554b007f20395f266f152fcf4ca481402"
    },
    {
      "commit": "a15801a272aa485a13c2aab951e91fd49a3feac7",
      "gitAuthor": "papercusp-git-sync",
      "authoredAt": "2026-10-20T19:31:17-04:00",
      "committedAt": "2026-10-20T19:31:17-04:00",
      "trailers": {},
      "agentAttribution": null,
      "agentAttributionStatus": "unknown/multiple-or-absent trailers",
      "commitMessageSha256": "51829dea96678e6cdeed58a14128b13d9c3f1d38821a1f4de12b376752471a3b"
    },
    {
      "commit": "7ef025b18ce0a7e1c39249cc8346a3b774748c37",
      "gitAuthor": "papercusp-git-sync",
      "authoredAt": "2026-11-07T23:32:08-05:00",
      "committedAt": "2026-11-07T23:32:08-05:00",
      "trailers": {
        "Papercusp-Agent": [
          "su-bd7bb60b-f269-4533-95f8-a01a37d59f27",
          "su-60a9de95-dd40-4807-8e4b-107dcd49c416",
          "su-1a1d1b35-c317-44f4-a10b-51661ce46a8e",
          "su-5c46e76e-e3d6-448c-8959-58dcdfb533f9"
        ]
      },
      "agentAttribution": null,
      "agentAttributionStatus": "unknown/multiple-or-absent trailers",
      "commitMessageSha256": "52731f8a5a8b9bb0b052c842aa4cac3838612d42383df8954ca0998cf18542ae"
    },
    {
      "commit": "dd7ac420e6e18aa99a984e9b7d86d24411c82fa8",
      "gitAuthor": "papercusp-git-sync",
      "authoredAt": "2026-08-20T17:11:11-04:00",
      "committedAt": "2026-08-20T17:11:11-04:00",
      "trailers": {
        "Papercusp-Agent": [
          "su-c5a07187-ed32-4ec0-8cb5-4bee0b1c85b8"
        ],
        "Papercusp-Work-Item": [
          "WI-40078"
        ],
        "Papercusp-Plan": [
          "first-class-spec-clauses-and-prior-attempt-briefs-2026-08-20"
        ]
      },
      "agentAttribution": "su-c5a07187-ed32-4ec0-8cb5-4bee0b1c85b8",
      "agentAttributionStatus": "single commit trailer; not a per-line edit receipt",
      "commitMessageSha256": "972ba4bc2e818ab5453c7daa9e6d3c146e83accb1027528822b92a511cb2c1c7"
    },
    {
      "commit": "b8f9bf5373d29378f364e36d1898b9e853e24167",
      "gitAuthor": "papercusp-git-sync",
      "authoredAt": "2026-11-07T13:17:06-05:00",
      "committedAt": "2026-11-07T13:17:06-05:00",
      "trailers": {},
      "agentAttribution": null,
      "agentAttributionStatus": "unknown/multiple-or-absent trailers",
      "commitMessageSha256": "6a22bb077b3433634778274374798459ab09dd2ac3292fa9b5d9e18d4e0750e4"
    },
    {
      "commit": "cb48d78f52e07eda06b165f261a5835ac9df6433",
      "gitAuthor": "papercusp-git-sync",
      "authoredAt": "2026-07-28T03:36:33-04:00",
      "committedAt": "2026-07-28T03:36:33-04:00",
      "trailers": {},
      "agentAttribution": null,
      "agentAttributionStatus": "unknown/multiple-or-absent trailers",
      "commitMessageSha256": "686ad01c75e2aa0929878cf8319a559383ebff36a8299030517f69ce731e0d90"
    },
    {
      "commit": "1dd4e423710a2e199a57ca07f6e547cb5385aa23",
      "gitAuthor": "papercusp-git-sync",
      "authoredAt": "2026-07-28T03:12:39-04:00",
      "committedAt": "2026-07-28T03:12:39-04:00",
      "trailers": {},
      "agentAttribution": null,
      "agentAttributionStatus": "unknown/multiple-or-absent trailers",
      "commitMessageSha256": "39e371e1dfbe603f1a4065b5183db1ace14ae4f372f748146bc2986a178da07a"
    },
    {
      "commit": "458755b56eefcfe82e76318748e6f414465d9de5",
      "gitAuthor": "papercusp-git-sync",
      "authoredAt": "2026-09-02T15:40:47-04:00",
      "committedAt": "2026-09-02T15:40:47-04:00",
      "trailers": {},
      "agentAttribution": null,
      "agentAttributionStatus": "unknown/multiple-or-absent trailers",
      "commitMessageSha256": "d08e2464a2f11d031efae6c7ebc251aef6735c9af3189d4a08bd2044946f10b5"
    },
    {
      "commit": "5a14159ea62c55383ad48915548f4d25113a8ec9",
      "gitAuthor": "papercusp-git-sync",
      "authoredAt": "2026-08-13T14:16:02-04:00",
      "committedAt": "2026-08-13T14:16:02-04:00",
      "trailers": {
        "Papercusp-Agent": [
          "su-01d9dd9a-2783-4f75-91c4-94c0b6a25b8b"
        ]
      },
      "agentAttribution": "su-01d9dd9a-2783-4f75-91c4-94c0b6a25b8b",
      "agentAttributionStatus": "single commit trailer; not a per-line edit receipt",
      "commitMessageSha256": "4e6eeca5fcc0583af310e316674d1ddb37b5dc3d0d14222bf247d8d0d3da4c74"
    },
    {
      "commit": "a3734b939d8ff4bc43e93517fca00fce81a7bdc3",
      "gitAuthor": "papercusp-git-sync",
      "authoredAt": "2026-11-07T21:41:14-05:00",
      "committedAt": "2026-11-07T21:41:14-05:00",
      "trailers": {},
      "agentAttribution": null,
      "agentAttributionStatus": "unknown/multiple-or-absent trailers",
      "commitMessageSha256": "60a6203a380393c3f0689de7640dea3ee862c84c9a06d825db1c84dafd8a9b38"
    },
    {
      "commit": "0c066799bc47228ae79e4f82a10df6b8a3066dae",
      "gitAuthor": "papercusp-git-sync",
      "authoredAt": "2026-11-05T19:35:13-05:00",
      "committedAt": "2026-11-05T19:35:13-05:00",
      "trailers": {},
      "agentAttribution": null,
      "agentAttributionStatus": "unknown/multiple-or-absent trailers",
      "commitMessageSha256": "1d7f3d82dfbb54bf129939ae406091e5f9278c91a7faaaefb7758acd275bd01a"
    },
    {
      "commit": "96be52b0ebaf43a98546ef1fad88e973c432800a",
      "gitAuthor": "papercusp-git-sync",
      "authoredAt": "2026-11-05T21:39:54-05:00",
      "committedAt": "2026-11-05T21:39:54-05:00",
      "trailers": {
        "Papercusp-Agent": [
          "su-a1704cc4-e6d7-41f7-92dc-9d6832adc070"
        ],
        "Papercusp-Session": [
          "su-a1704cc4-e6d7-41f7-92dc-9d6832adc070"
        ]
      },
      "agentAttribution": "su-a1704cc4-e6d7-41f7-92dc-9d6832adc070",
      "agentAttributionStatus": "single commit trailer; not a per-line edit receipt",
      "commitMessageSha256": "6b81368c745bd0f20bfebcfcca5666a143f92e2e43164f8ea7d82e2d724160c5"
    },
    {
      "commit": "9a010889985cf21599851cac18b9b979767621ff",
      "gitAuthor": "papercusp-git-sync",
      "authoredAt": "2026-10-22T17:13:13-04:00",
      "committedAt": "2026-10-22T17:13:13-04:00",
      "trailers": {},
      "agentAttribution": null,
      "agentAttributionStatus": "unknown/multiple-or-absent trailers",
      "commitMessageSha256": "ecbebd968cca6f5d0530e436acb71c351659413357bbb452e005be4fec225609"
    },
    {
      "commit": "8c75bcc8d05381c3d0508d157d8d74a1501aaf14",
      "gitAuthor": "papercusp-git-sync",
      "authoredAt": "2026-10-27T16:31:51-04:00",
      "committedAt": "2026-10-27T16:31:51-04:00",
      "trailers": {
        "Papercusp-Agent": [
          "su-f4c37369-6459-436f-a9f5-3f83e4a5007b"
        ],
        "Papercusp-Work-Item": [
          "WI-6554700010030423"
        ]
      },
      "agentAttribution": "su-f4c37369-6459-436f-a9f5-3f83e4a5007b",
      "agentAttributionStatus": "single commit trailer; not a per-line edit receipt",
      "commitMessageSha256": "8b3fba95886393a255707bf0ed42f9524b7fe78820e72107467997451ce5608c"
    },
    {
      "commit": "44637e2610aec432304dcd205aa760681826acbc",
      "gitAuthor": "papercusp-git-sync",
      "authoredAt": "2026-08-20T17:52:24-04:00",
      "committedAt": "2026-08-20T17:52:24-04:00",
      "trailers": {
        "Papercusp-Agent": [
          "su-c5a07187-ed32-4ec0-8cb5-4bee0b1c85b8"
        ],
        "Papercusp-Work-Item": [
          "WI-40077, WI-40078"
        ],
        "Papercusp-Plan": [
          "first-class-spec-clauses-and-prior-attempt-briefs-2026-08-20"
        ]
      },
      "agentAttribution": "su-c5a07187-ed32-4ec0-8cb5-4bee0b1c85b8",
      "agentAttributionStatus": "single commit trailer; not a per-line edit receipt",
      "commitMessageSha256": "43e3ab0ece483ce65c2c6ef4a56223455a23e52538050d2c89f16a3750627fac"
    },
    {
      "commit": "ec4366d0843c68dc1ad481a9b86ab476186b6ca8",
      "gitAuthor": "papercusp-git-sync",
      "authoredAt": "2026-10-12T12:52:54-04:00",
      "committedAt": "2026-10-12T12:52:54-04:00",
      "trailers": {},
      "agentAttribution": null,
      "agentAttributionStatus": "unknown/multiple-or-absent trailers",
      "commitMessageSha256": "df0fadbf3e5bbcbbc6ff20525f3b163baf7946c4b85ae1ed21a96d2765c51650"
    },
    {
      "commit": "cb0a63cabc422c5d1633293a1b89118b1aa2b29e",
      "gitAuthor": "papercusp-git-sync",
      "authoredAt": "2026-10-12T12:10:47-04:00",
      "committedAt": "2026-10-12T12:10:47-04:00",
      "trailers": {
        "Papercusp-Agent": [
          "su-e8ac915f-5cb9-4405-a669-9e1c13c88bfb"
        ],
        "Papercusp-Plan": [
          "derived-status-not-hand-written-2026-10-12"
        ]
      },
      "agentAttribution": "su-e8ac915f-5cb9-4405-a669-9e1c13c88bfb",
      "agentAttributionStatus": "single commit trailer; not a per-line edit receipt",
      "commitMessageSha256": "56705591401c0d4b89f9a92c8390c7a845ed5cb1d0c6f299402b75aa10b75777"
    }
  ],
  "residue": [
    "Same-file helper source authors are not resolved per-line here.",
    "Commit trailers may be multi-author and are not an exact per-file edit receipt.",
    "Production candidates are named companions, not complete transitive implementation lineage.",
    "Independent source/fixture review is still required before corresponding implementation."
  ],
  "independentReview": null
}
