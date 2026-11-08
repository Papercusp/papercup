---
rel_path: "evidence/c52-luna-r1-20261106/duplicate-target-independent-qualification-20261108T1608Z.json"
updated_at: 1794153630377
_body: "content"
---

{
  "schema": "r1-duplicate-target-independent-qualification-v1",
  "createdAt": "2026-11-08T16:00:30.356Z",
  "workItem": "WI-6554700010045700",
  "inputs": [
    {
      "slug": "papercusp",
      "rel_path": "evidence/c52-luna-r1-20261106/duplicate-target20-capture-20261108T1555Z.json",
      "chars": 931331
    },
    {
      "slug": "papercusp",
      "rel_path": "evidence/c52-luna-r1-20261106/duplicate-target-retained-ledger-20261108T1605Z.json",
      "chars": 79776
    },
    {
      "slug": "papercusp",
      "rel_path": "evidence/c52-luna-r1-20261106/terminal92-sources-20261108T1535Z.json",
      "chars": 1462960
    }
  ],
  "coverage": {
    "requestedTargets": [
      "EI-24818010361425604",
      "EI-25235614425153042",
      "EI-25492242650368024",
      "EI-25944008357416349",
      "EI-26264292231558408",
      "EI-26674533247533429",
      "EI-26817461799335159",
      "EI-26827230042172261",
      "EI-27033376159376450",
      "EI-27691198286861651",
      "EI-27710843725808900",
      "EI-27721532818104343",
      "EI-27730562695092492",
      "EI-27734089080741819",
      "EI-28025692650838983",
      "EI-28031329526300579",
      "EI-28102536426151089",
      "WI-6554700010025846",
      "WI-6554700010042509",
      "WI-6554700010045521"
    ],
    "foundTargets": [
      "EI-24818010361425604",
      "EI-25492242650368024",
      "EI-25944008357416349",
      "EI-26264292231558408",
      "EI-26674533247533429",
      "EI-26817461799335159",
      "EI-26827230042172261",
      "EI-27033376159376450",
      "EI-27691198286861651",
      "EI-27710843725808900",
      "EI-27721532818104343",
      "EI-27730562695092492",
      "EI-27734089080741819",
      "EI-28025692650838983",
      "EI-28031329526300579",
      "EI-28102536426151089",
      "WI-6554700010025846",
      "WI-6554700010042509",
      "WI-6554700010045521"
    ],
    "missingTargets": [
      "EI-25235614425153042"
    ],
    "originalPairs": [
      "EI-25519734441837999",
      "EI-26401746478528025",
      "EI-26716727162323660",
      "EI-26818788465648618",
      "EI-27090214258511364",
      "EI-27147781040222330",
      "EI-27687625361005860",
      "EI-27702611547968789",
      "EI-27970531880500756",
      "EI-27993606831901508",
      "EI-27998545512823414",
      "EI-28004330173230754",
      "EI-28004955265251225",
      "EI-28007367683730651",
      "EI-28019632868216128",
      "EI-28047218020902505",
      "EI-28047671163799830",
      "EI-28059370207764272",
      "WI-6554700010027581",
      "WI-6554700010045623"
    ],
    "unmappedTargets": [],
    "sourceAssessmentStatus": "All92 previously completed assessments unchanged; this is independent target/scope/ledger qualification only"
  },
  "pairs": [
    {
      "originalId": "EI-25519734441837999",
      "targetId": "EI-25492242650368024",
      "classification": "same-failure-class",
      "qualification": "Both record superuser_native_session_verifier_unavailable under mcp_auth_failed on different tool names. The target aged out by hygiene; neither record establishes a fix. Repeated native-verifier friction may be consolidated, but historical root cause and recurrence guard remain unproven.",
      "original": {
        "title": "loop:status tool-call failure (mcp_auth_failed)",
        "summary": "Invocation telemetry observed loop:status at 2026-10-08T21:52:54.566Z.\n\nsuperuser_native_session_verifier_unavailable",
        "status": "dropped",
        "duplicate_of": "EI-25492242650368024",
        "payload": {
          "_ei": {
            "scope": "harness:papercusp",
            "source": "engineer",
            "severity": "major",
            "created_by": "su-e29e77de-45ec-4677-b1b4-3b662ab57a95",
            "signal_origin": "organic"
          },
          "reporter": {
            "at": "2026-10-09T16:25:13.104Z",
            "id": "su-e29e77de-45ec-4677-b1b4-3b662ab57a95",
            "kind": "agent",
            "basis": "agent-session"
          },
          "repeatCount": 1,
          "watchdogKey": "tool-failure-signature:loop:status:transient:mcp_auth_failed:field-unknown",
          "_assumptions": {
            "declared": "none",
            "resolvedAt": "2026-11-08T11:33:35.411Z"
          },
          "reproduction": {
            "filedBy": "su-aeed2f5d-9af7-4557-88e8-93ec7a01fd3b",
            "receipt": {
              "ref": "tool_invocations:34225365",
              "kind": "encounter",
              "buildSha": "37536eb0ad"
            },
            "verification": {
              "detail": "tool_invocations:34225365 failed (error) on 37536eb0ad",
              "status": "verified",
              "checkedAt": "2026-10-09T16:25:38.973Z"
            },
            "schemaVersion": "bug-reproduction-v1"
          },
          "ideaLifecycle": {
            "state": "open",
            "stateUpdatedAt": "2026-10-09T16:25:42.176Z"
          },
          "reportContext": {
            "app": "papercusp",
            "screen": null,
            "refused": [],
            "truncated": [],
            "appVersion": "0.0.0+07f398432b",
            "capturedAt": "2026-10-09T16:25:13.104Z",
            "logExcerpt": null,
            "screenshot": null,
            "autoCaptured": [
              "app",
              "appVersion",
              "recentErrors"
            ],
            "recentErrors": [
              {
                "at": "2026-10-09T16:25:13.104Z",
                "source": "loop:status",
                "message": "loop:status mcp_auth_failed: superuser_native_session_verifier_unavailable"
              }
            ],
            "schemaVersion": 1
          },
          "reporterKinds": [
            "agent"
          ],
          "toolInvocation": {
            "ownerId": "su-e29e77de-45ec-4677-b1b4-3b662ab57a95",
            "invokedAt": "2026-10-08T21:51:51.303Z",
            "harnessSlug": "*",
            "workspaceId": "papercusp-workspace"
          },
          "freshnessEnvelope": {
            "observedAt": "2026-10-09T16:25:14.897Z",
            "linkedFixRefs": [],
            "reporterSession": "su-e29e77de-45ec-4677-b1b4-3b662ab57a95",
            "observedSourceSha": "07f398432b",
            "toolSchemaVersion": null,
            "observedRuntimeSha": "07f398432b",
            "deployBuildIdentity": "07f398432b@0.0.0",
            "reporterRuntimeVersion": "0.0.0",
            "lastSuccessfulReproductionAt": null
          },
          "_completionEvidence": {
            "summary": "Closed as a stale duplicate capture linked to EI-25492242650368024. Current code and focused staging tests verify the intended fail-closed response when native-session verification throws; a current loop:status read succeeds. This does not claim the underlying October verifier outage was repaired.",
            "coverage": {
              "checked": [
                "the historical loop:status verifier-unavailable capture EI-25519734441837999"
              ],
              "residue": [],
              "notChecked": [],
              "population": [
                "the historical loop:status verifier-unavailable capture EI-25519734441837999"
              ],
              "notApplicable": []
            },
            "testsRun": "Staging testing:run for packages/operator-core/lib/endpoint-route/__tests__/mcp-handler-gating-matrix.test.ts, patterns 'native-session verifier' (run 8aab1bfe-39ad-4c2f-8c57-8de66d5a6631) and 'fails closed with a retryable verifier reason when per-call verification throws despite a matching inherited SID' (run f8b78ade-d683-4e23-9c64-3f74b29b378f).",
            "treeStamp": {
              "headSha": "90fb043771112cd9c1b351b48f802e36f7cc0b88",
              "repositoryRoot": "/home/marsh-office/papercupai-workspace/papercusp"
            },
            "testResult": "Each focused run passed 1 test, 0 failed, 437 skipped; both terminal pass with cleanup complete. Current loop:status returned ok.",
            "verifiedHow": "Read the historical item payload and prior disposition; inspected the exact _mcp-host.ts verifier catch and gating-matrix assertions; ran both focused cases on staging and observed current loop:status succeed.",
            "workOutcome": "duplicate",
            "rootCauseVerification": {
              "hypothesis": "The captured mcp_auth_failed response was emitted by the intended fail-closed catch after classifyOwnerNativeSession threw; the MCP handler was not dispatched.",
              "testResult": "The per-call regression passed 1/1 and asserted superuser_native_session_verifier_unavailable with no handler invocation. The tools/list regression also passed 1/1. Current loop:status succeeded.",
              "evidenceRefs": [
                "testing-run:8aab1bfe-39ad-4c2f-8c57-8de66d5a6631",
                "testing-run:f8b78ade-d683-4e23-9c64-3f74b29b378f",
                "EI-25519734441837999#payload.reportContext",
                "EI-25492242650368024#payload.ideaLifecycle",
                "packages/operator-core/lib/endpoint-route/routes/transport/_mcp-host.ts:1818",
                "packages/operator-core/lib/endpoint-route/__tests__/mcp-handler-gating-matrix.test.ts:6785"
              ],
              "testProcedure": "testing:run on staging for mcp-handler-gating-matrix.test.ts with the two exact name patterns recorded in testsRun; inspect _mcp-host.ts where classifyOwnerNativeSession exceptions map to the auth failure.",
              "actualObservation": "The source catch maps verifier exceptions to the recorded reason; both focused regressions passed with the expected no-dispatch behavior, and the live current loop:status call succeeded. The October item payload does not establish why its verifier was unavailable.",
              "distinguishingTest": "Run the focused per-call gating-matrix case and inspect the exact error reason, nativeSessionCalls, and handler invocation count; compare with the current loop:status call.",
              "alternativeHypothesis": "The capture was a separate transport/auth failure after successful native-session verification, so the verifier catch did not produce the response.",
              "predictedObservations": {
                "hypothesis": "Verifier exception enters the catch, returns mcp_auth_failed / superuser_native_session_verifier_unavailable, and dispatch does not reach the handler.",
                "alternativeHypothesis": "Verifier binding succeeds; the catch does not run, so that specific error reason and zero-handler assertion are not produced by this path."
              }
            },
            "checkpointProseSnapshot": "## Did\nScheduler:get_next claimed this item under the fleet claim spec. Its predecessor EI-25492242650368024 is closed by the 2026-11-08 hygiene sweep (aged out after no recurrence), not fixed. Source inspection confirms _mcp-host.ts catches classifyOwnerNativeSession failures and returns superuser_native_session_verifier_unavailable before dispatch. Focused staging runs passed both the tools/list rejection case (8aab1bfe-39ad-4c2f-8c57-8de66d5a6631: 1 pass, 0 fail) and the per-call fail-closed case (f8b78ade-d683-4e23-9c64-3f74b29b378f: 1 pass, 0 fail); both cleanup complete. A current loop:status read in this session succeeded.\n\n## Left\nClose this stale October telemetry capture as a duplicate of the historical EI-254 record, with no code change. Explicitly state that the underlying reason for the October verifier unavailability is not known and is not claimed fixed."
          },
          "toolFailureProbation": {
            "class": "transient",
            "state": "promoted",
            "direct": false,
            "report": {
              "status": "error",
              "message": "superuser_native_session_verifier_unavailable",
              "toolName": "loop:status",
              "errorCode": "mcp_auth_failed",
              "runtimeVersion": "37536eb0ad"
            },
            "classKey": "repeated-tool-error-class:loop:status:transient:mcp_auth_failed:schema-unknown~field-unknown:37536eb0ad",
            "reporters": [
              "su-e29e77de-45ec-4677-b1b4-3b662ab57a95",
              "su-aeed2f5d-9af7-4557-88e8-93ec7a01fd3b"
            ],
            "lastSeenAt": "2026-10-08T21:52:54.566Z",
            "promotedAt": "2026-10-09T16:25:42.175Z",
            "promotedBy": "su-aeed2f5d-9af7-4557-88e8-93ec7a01fd3b",
            "firstSeenAt": "2026-10-08T21:52:54.566Z",
            "watchdogKey": "tool-failure-signature:loop:status:transient:mcp_auth_failed:field-unknown",
            "intendedKind": "bug",
            "signatureKey": "tool-failure-signature:loop:status:transient:mcp_auth_failed:field-unknown",
            "knownExternal": null,
            "deployedRevision": "37536eb0ad",
            "messageFingerprint": "superuser-native-session-verifier-unavailable",
            "contractFingerprint": "schema-unknown~field-unknown",
            "correlationFingerprint": "loop:status|mcp_auth_failed|schema-unknown|field-unknown|37536eb0ad|superuser-native-session-verifier-unavailable"
          },
          "toolFailureSignature": {
            "classes": {
              "repeated-tool-error-class:loop:status:transient:mcp_auth_failed:schema-unknown~field-unknown:37536eb0ad": {
                "count": 2,
                "reporters": [
                  "su-e29e77de-45ec-4677-b1b4-3b662ab57a95",
                  "su-aeed2f5d-9af7-4557-88e8-93ec7a01fd3b"
                ],
                "lastSeenAt": "2026-10-08T21:52:54.566Z",
                "firstSeenAt": "2026-10-08T21:51:51.303Z",
                "deployedRevision": "37536eb0ad",
                "contractFingerprint": "schema-unknown~field-unknown"
              }
            },
            "signatureKey": "tool-failure-signature:loop:status:transient:mcp_auth_failed:field-unknown"
          },
          "claim_history_post_id": 9001788375295,
          "implementationReadiness": {
            "reason": "born-verified-tool-failure-promotion",
            "source": "capture-policy",
            "status": "ready",
            "updatedAt": "2026-10-09T16:25:42.175Z",
            "schemaVersion": "implementation-readiness-v1"
          }
        },
        "conditionKey": null
      },
      "target": {
        "title": "tools:invoke tool-call failure (mcp_auth_failed)",
        "summary": "Invocation telemetry observed tools:invoke at 2026-10-08T13:59:44.295Z.\n\nsuperuser_native_session_verifier_unavailable",
        "status": "closed",
        "duplicate_of": null,
        "payload": {
          "_ei": {
            "scope": "harness:papercusp",
            "source": "engineer",
            "severity": "nit",
            "created_by": "su-01864986-d27d-497b-b501-7082b6e0caab",
            "signal_origin": "organic"
          },
          "reporter": {
            "at": "2026-10-09T09:08:15.615Z",
            "id": "su-01864986-d27d-497b-b501-7082b6e0caab",
            "kind": "agent",
            "basis": "agent-session"
          },
          "lastSeenAt": "2026-10-09T09:12:02.513Z",
          "repeatCount": 72,
          "watchdogKey": "tool-failure-signature:tools:invoke:transient:mcp_auth_failed:field-unknown",
          "reproduction": {
            "filedBy": "su-a0a2e2b0-4f63-4cef-8ea9-578a3fdd222f",
            "receipt": {
              "ref": "tool_invocations:33990141",
              "kind": "encounter",
              "buildSha": "e447980feb"
            },
            "verification": {
              "detail": "tool_invocations:33990141 failed (error) on e447980feb",
              "status": "verified",
              "checkedAt": "2026-10-09T09:08:38.493Z"
            },
            "schemaVersion": "bug-reproduction-v1"
          },
          "decidedReason": "aged out by the hygiene sweep: nit severity, no recurrence pressure in 30 days — re-capture if it bites again",
          "ideaLifecycle": {
            "state": "triaged",
            "triagedAt": "2026-11-08T11:03:37.038Z",
            "triageReason": "aged out by the hygiene sweep: nit severity, no recurrence pressure in 30 days — re-capture if it bites again",
            "stateUpdatedAt": "2026-11-08T11:03:37.038Z",
            "triageDecision": "reject"
          },
          "reportContext": {
            "app": "papercusp",
            "screen": null,
            "refused": [],
            "truncated": [],
            "appVersion": "0.0.0+276b51c750",
            "capturedAt": "2026-10-09T09:08:15.615Z",
            "logExcerpt": null,
            "screenshot": null,
            "autoCaptured": [
              "app",
              "appVersion",
              "recentErrors"
            ],
            "recentErrors": [
              {
                "at": "2026-10-09T09:08:15.615Z",
                "source": "tools:invoke",
                "message": "tools:invoke mcp_auth_failed: superuser_native_session_verifier_unavailable"
              }
            ],
            "schemaVersion": 1
          },
          "reporterKinds": [
            "agent"
          ],
          "toolInvocation": {
            "ownerId": "su-01864986-d27d-497b-b501-7082b6e0caab",
            "invokedAt": "2026-10-08T13:59:17.287Z",
            "harnessSlug": "*",
            "workspaceId": "papercusp-workspace"
          },
          "freshnessEnvelope": {
            "observedAt": "2026-10-09T09:08:16.774Z",
            "linkedFixRefs": [],
            "reporterSession": "su-01864986-d27d-497b-b501-7082b6e0caab",
            "observedSourceSha": "276b51c750",
            "toolSchemaVersion": null,
            "observedRuntimeSha": "276b51c750",
            "deployBuildIdentity": "276b51c750@0.0.0",
            "reporterRuntimeVersion": "0.0.0",
            "lastSuccessfulReproductionAt": null
          },
          "claim_hold_release": {
            "owner": "human owner via the linked conversation",
            "trigger": "conversation:answered:conv-mv4i2wvb-0000-1ba850bd5e1a4306bb82e14e7a373bdc",
            "evidence": "a live resolver or producer registration can still satisfy the condition",
            "condition": "The linked owner conversation has an accepted answer. Re-read the accepted answer before taking any disposition; elapsed time alone is not approval.",
            "reachability": "reachable"
          },
          "toolFailureProbation": {
            "class": "transient",
            "state": "promoted",
            "direct": false,
            "report": {
              "status": "error",
              "message": "superuser_native_session_verifier_unavailable",
              "toolName": "tools:invoke",
              "errorCode": "mcp_auth_failed",
              "runtimeVersion": "e447980feb"
            },
            "classKey": "repeated-tool-error-class:tools:invoke:transient:mcp_auth_failed:schema-unknown~field-unknown:e447980feb",
            "reporters": [
              "su-01864986-d27d-497b-b501-7082b6e0caab",
              "su-a0a2e2b0-4f63-4cef-8ea9-578a3fdd222f"
            ],
            "lastSeenAt": "2026-10-08T13:59:44.295Z",
            "promotedAt": "2026-10-09T09:08:39.623Z",
            "promotedBy": "su-a0a2e2b0-4f63-4cef-8ea9-578a3fdd222f",
            "firstSeenAt": "2026-10-08T13:59:44.295Z",
            "watchdogKey": "tool-failure-signature:tools:invoke:transient:mcp_auth_failed:field-unknown",
            "intendedKind": "bug",
            "signatureKey": "tool-failure-signature:tools:invoke:transient:mcp_auth_failed:field-unknown",
            "knownExternal": null,
            "deployedRevision": "e447980feb",
            "messageFingerprint": "superuser-native-session-verifier-unavailable",
            "contractFingerprint": "schema-unknown~field-unknown",
            "correlationFingerprint": "tools:invoke|mcp_auth_failed|schema-unknown|field-unknown|e447980feb|superuser-native-session-verifier-unavailable"
          },
          "toolFailureSignature": {
            "classes": {
              "repeated-tool-error-class:tools:invoke:transient:mcp_auth_failed:schema-unknown~field-unknown:276b51c750": {
                "count": 7,
                "reporters": [
                  "su-881e1a72-5983-4931-a6a4-bca5f11bf376",
                  "su-14554ce7-b9db-4aa8-a47f-ade4e4a31b89"
                ],
                "lastSeenAt": "2026-10-09T09:25:46.568Z",
                "firstSeenAt": "2026-10-09T09:20:43.406Z",
                "deployedRevision": "276b51c750",
                "contractFingerprint": "schema-unknown~field-unknown"
              },
              "repeated-tool-error-class:tools:invoke:transient:mcp_auth_failed:schema-unknown~field-unknown:37536eb0ad": {
                "count": 33,
                "reporters": [
                  "su-24da4d03-d589-4033-9f9f-5e7330865005",
                  "su-7e12bafa-c45e-49c7-9c54-4fa67bdcc6de",
                  "su-59c100a0-6221-483e-8450-055226ca7e7e",
                  "su-236034c1-4d17-49f8-938f-9b88d57bb171",
                  "su-a93538d3-c252-48bd-85de-2080d64a77f3",
                  "su-ec87a60a-fb71-498f-937b-c8b74ec7866f",
                  "su-8e6d178f-2d60-419c-9788-f4aa0266176f",
                  "su-d17e571e-4d90-4a32-84e9-95ff46df38ba",
                  "su-46a58ca5-f152-40ee-9ca7-199b327b0690",
                  "su-0b091739-28bb-4434-b2c3-bf55b32f5829",
                  "su-f57d18ae-a195-4e83-a82b-458ef3338a12",
                  "su-99042929-9493-4ec9-b63b-71ba18544ec9",
                  "su-624a9b37-0af2-411b-89e4-3ffb943291ab",
                  "su-d27e43b0-a213-4e56-b58f-1c48898ce40f",
                  "su-c5083b60-682f-462e-96f4-203b56294496",
                  "su-61c6dcd8-103c-4424-817a-615d51f712d9"
                ],
                "lastSeenAt": "2026-10-09T14:35:49.136Z",
                "firstSeenAt": "2026-10-08T14:02:06.234Z",
                "deployedRevision": "37536eb0ad",
                "contractFingerprint": "schema-unknown~field-unknown"
              },
              "repeated-tool-error-class:tools:invoke:transient:mcp_auth_failed:schema-unknown~field-unknown:43a8a5f95d": {
                "count": 2,
                "reporters": [
                  "su-882e352b-3d63-404b-a8dd-3f646bcee4e2",
                  "su-24540fcf-704b-41cb-8397-48b37289a106"
                ],
                "lastSeenAt": "2026-10-18T02:57:20.195Z",
                "firstSeenAt": "2026-10-18T03:18:50.179Z",
                "deployedRevision": "43a8a5f95d",
                "contractFingerprint": "schema-unknown~field-unknown"
              },
              "repeated-tool-error-class:tools:invoke:transient:mcp_auth_failed:schema-unknown~field-unknown:abed986d36": {
                "count": 15,
                "reporters": [
                  "su-881e1a72-5983-4931-a6a4-bca5f11bf376",
                  "su-4adf5ebc-6443-4c3c-b704-162275765ff1"
                ],
                "lastSeenAt": "2026-10-09T12:18:45.652Z",
                "firstSeenAt": "2026-10-09T12:14:48.105Z",
                "deployedRevision": "abed986d36",
                "contractFingerprint": "schema-unknown~field-unknown"
              },
              "repeated-tool-error-class:tools:invoke:transient:mcp_auth_failed:schema-unknown~field-unknown:b18c177e22": {
                "count": 1,
                "reporters": [
                  "su-662947ed-a9b2-4540-83eb-e00528be95cd",
                  "su-1ccfa66a-40a8-4cfe-8274-93894aa36b2c"
                ],
                "lastSeenAt": "2026-10-17T06:53:05.555Z",
                "firstSeenAt": "2026-10-17T06:53:05.555Z",
                "deployedRevision": "b18c177e22",
                "contractFingerprint": "schema-unknown~field-unknown"
              },
              "repeated-tool-error-class:tools:invoke:transient:mcp_auth_failed:schema-unknown~field-unknown:b7937697dc": {
                "count": 9,
                "reporters": [
                  "su-881e1a72-5983-4931-a6a4-bca5f11bf376",
                  "su-16e3554c-a66e-4183-b374-2e5ae2a95e36"
                ],
                "lastSeenAt": "2026-10-09T14:24:54.126Z",
                "firstSeenAt": "2026-10-09T14:21:46.956Z",
                "deployedRevision": "b7937697dc",
                "contractFingerprint": "schema-unknown~field-unknown"
              },
              "repeated-tool-error-class:tools:invoke:transient:mcp_auth_failed:schema-unknown~field-unknown:e447980feb": {
                "count": 4,
                "reporters": [
                  "su-01864986-d27d-497b-b501-7082b6e0caab",
                  "su-a0a2e2b0-4f63-4cef-8ea9-578a3fdd222f"
                ],
                "lastSeenAt": "2026-10-09T09:12:02.513Z",
                "firstSeenAt": "2026-10-08T13:59:17.287Z",
                "deployedRevision": "e447980feb",
                "contractFingerprint": "schema-unknown~field-unknown"
              },
              "repeated-tool-error-class:tools:invoke:transient:mcp_auth_failed:schema-unknown~field-unknown:ec4366d084": {
                "count": 1,
                "reporters": [
                  "su-43e4b8b3-2e82-4155-bef7-e84be403fa2e",
                  "su-a158802d-7e66-48eb-8ea3-a79e78ea0d2e"
                ],
                "lastSeenAt": "2026-10-12T18:48:41.562Z",
                "firstSeenAt": "2026-10-12T18:48:41.562Z",
                "deployedRevision": "ec4366d084",
                "contractFingerprint": "schema-unknown~field-unknown"
              },
              "repeated-tool-error-class:tools:invoke:transient:mcp_auth_failed:schema-unknown~field-unknown:fadbd35203": {
                "count": 1,
                "reporters": [
                  "su-9ce649c2-e4f0-4437-98ce-20984bdfa72d",
                  "su-de38f55f-e1e1-45c4-a486-6a8ab84acf15"
                ],
                "lastSeenAt": "2026-10-17T00:57:55.089Z",
                "firstSeenAt": "2026-10-17T00:57:55.089Z",
                "deployedRevision": "fadbd35203",
                "contractFingerprint": "schema-unknown~field-unknown"
              },
              "repeated-tool-error-class:tools:invoke:transient:mcp_auth_failed:schema-unknown~field-unknown:fd91b033eb": {
                "count": 1,
                "reporters": [
                  "su-a65507e0-e711-4dd3-af87-5f792df5d5e6",
                  "su-cc4bc1d1-43d3-40a8-9f73-ad1670b0893f"
                ],
                "lastSeenAt": "2026-10-16T13:09:33.094Z",
                "firstSeenAt": "2026-10-16T13:09:33.094Z",
                "deployedRevision": "fd91b033eb",
                "contractFingerprint": "schema-unknown~field-unknown"
              },
              "repeated-tool-error-class:tools:invoke:transient:mcp_auth_failed:schema-unknown~field-unknown:runtime-unknown": {
                "count": 1,
                "reporters": [
                  "su-1e14c56c-d9c0-476e-a1bc-092a1c548894"
                ],
                "lastSeenAt": "2026-10-11T07:29:24.889Z",
                "firstSeenAt": "2026-10-11T07:29:24.889Z",
                "deployedRevision": "runtime-unknown",
                "contractFingerprint": "schema-unknown~field-unknown"
              }
            },
            "signatureKey": "tool-failure-signature:tools:invoke:transient:mcp_auth_failed:field-unknown"
          },
          "_claimSubjectBaseline": {
            "body": "Invocation telemetry observed tools:invoke at 2026-10-08T13:59:44.295Z.\n\nsuperuser_native_session_verifier_unavailable",
            "kind": "bug",
            "title": "tools:invoke tool-call failure (mcp_auth_failed)",
            "summary": "Invocation telemetry observed tools:invoke at 2026-10-08T13:59:44.295Z.\n\nsuperuser_native_session_verifier_unavailable",
            "watchdogKey": "tool-failure-signature:tools:invoke:transient:mcp_auth_failed:field-unknown"
          },
          "claim_history_post_id": 9001788375295,
          "implementationReadiness": {
            "reason": "born-verified-tool-failure-promotion",
            "source": "capture-policy",
            "status": "ready",
            "updatedAt": "2026-10-09T09:08:39.623Z",
            "schemaVersion": "implementation-readiness-v1"
          }
        },
        "conditionKey": null
      },
      "finalR1Disposition": "OPEN",
      "timeBoundary": "Original report retained in terminal92 raw capture, later target snapshot at 2026-11-08T15:48:45.116Z; source witnesses captured in this qualification. No inferred original-time availability or loaded runtime."
    },
    {
      "originalId": "EI-26401746478528025",
      "targetId": "EI-26264292231558408",
      "classification": "same-specific-symptom",
      "qualification": "Both describe pinned bindingIds counted as the full active-clause population; independent examples on different subjects support a shared wording defect. Target open; no execution/fix proof.",
      "original": {
        "title": "plans:evaluate-spec-test-adequacy disclosed-gap evidence says \"Checked N active binding(s) for the clause\" but counts only the pinned bindingIds cohort",
        "summary": "Observed while auditing scorecard EI-26401265226189106 (spec-test-adequacy rev12, subject dao-hr-people-2026-10-11#SPEC-P-010@1, evaluator build 2ba19fcc3a).\n\nThe disclosed-gap N/A evidence reads: \"No bound proof for ... records a structured author-disclosed gap. Checked 2 active binding(s) for the clause.\" The rubric method is \"Read adequacy.disclosedGap on every active binding for the clause\".\n\nMeasured:\n- The card's rerunRecipe pins bindingIds [58853,58854].\n- plans:get-spec-evidence {harness:'papercusp', slug:'dao-hr-people-2026-10-11', specIds:['SPEC-P-010'], detail:'full', limit:1000} with no bindingIds returns 3 ACTIVE current bindings: 58852, 58853 and 58854. 58852 is test run 21393949, which passed, on the same file and commit.\n\nSo the \"for the clause\" count describes the pinned diagnostic cohort, not the clause population. In this case the verdict is unaffected, because 58852 also has no disclosedGap. The risk: a pinned-out binding WITH a disclosure would still render as \"Checked N active binding(s) for the clause\" with an N/A verdict. An auditor reading the text would believe the whole clause population was covered. The ship gate's unscoped evaluation would still catch it (the governingNote says so), but the evidence text overstates its own coverage.\n\nSuggested fix: in pinned/replaySnapshot mode, word it as \"Checked N selected binding(s) (of M active for the clause)\". Alternatively, run the disclosure check over every active binding for the clause regardless of the evidence pin, since a disclosure anywhere on the clause is disqualifying.\n\nStatus: wording/coverage mismatch confirmed by the census above. Whether any real card has hidden a disclosure this way is not measured.",
        "status": "dropped",
        "duplicate_of": "EI-26264292231558408",
        "payload": {
          "_ei": {
            "scope": "harness:papercusp",
            "source": "engineer",
            "severity": "minor",
            "created_by": "su-d21e2aa6-7097-4ffc-9c31-9ab8b8642810",
            "found_during": "grading-integrity audit of EI-26401265226189106 (audit card EI-26401732369962729)",
            "signal_origin": "organic"
          },
          "paths": [
            "packages/operator-core/lib/spec-test-adequacy"
          ],
          "reporter": {
            "at": "2026-10-19T10:04:26.825Z",
            "id": "su-d21e2aa6-7097-4ffc-9c31-9ab8b8642810",
            "kind": "agent",
            "basis": "agent-session"
          },
          "filedByRole": "judge",
          "dedupVerdict": "likely-duplicate",
          "admissionHold": {
            "actor": "system:work-item-admission-promoter",
            "runId": "sched-.routinesTick-2026-11-06T20:02:30.000Z-31",
            "heldAt": "2026-11-06T15:15:42.89-05:00",
            "reason": "A's count matches pinned bindingIds; B's seven-count may result from collapsing three duplicate proof pairs. Selector exclusion versus deduplicated counting remains unresolved.",
            "screeningDeferred": false
          },
          "dedupCoverage": {
            "lexical": "ok",
            "degraded": true,
            "semantic": "partial"
          },
          "ideaLifecycle": {
            "state": "open",
            "stateUpdatedAt": "2026-10-19T10:04:27.517Z"
          },
          "reportContext": {
            "app": "papercusp",
            "screen": null,
            "refused": [],
            "truncated": [],
            "appVersion": "0.0.0+2ba19fcc3a",
            "capturedAt": "2026-10-19T10:04:26.825Z",
            "logExcerpt": null,
            "screenshot": null,
            "autoCaptured": [
              "app",
              "appVersion"
            ],
            "recentErrors": [],
            "schemaVersion": 1
          },
          "reporterKinds": [
            "agent"
          ],
          "admissionMerge": {
            "actor": "system:work-item-admission-promoter",
            "prior": {
              "status": "open",
              "seeAlso": [
                "EI-25314295759938757",
                "EI-25415196322731979",
                "EI-25458787314271928",
                "EI-25477838487191856",
                "EI-25675651383265338",
                "EI-25679141085310175",
                "EI-25878474235552349",
                "EI-26337652074242553",
                "EI-26536646448197500",
                "EI-26571269777584727"
              ],
              "takenBy": null,
              "admission": "pending",
              "admittedAt": null,
              "admittedBy": null,
              "closedAtMs": null,
              "conditionKey": null,
              "terminalOwner": null,
              "sourcePlanSlug": null,
              "terminalReason": null,
              "admissionReview": {
                "value": null,
                "present": false
              },
              "watchdogIdentity": {
                "watchdogKey": {
                  "value": null,
                  "present": false
                },
                "watchdogLane": {
                  "value": null,
                  "present": false
                },
                "watchdogSignalOrigin": {
                  "value": "organic",
                  "present": true
                },
                "admissionMergeSources": {
                  "value": null,
                  "present": false
                }
              },
              "sourcePlanItemIds": null
            },
            "runId": "d010540b-7568-4c74-9e06-a314ab2336e5",
            "state": "complete",
            "canonical": {
              "prior": {
                "seeAlso": [
                  "EI-25477838487191856",
                  "EI-25679141085310175"
                ],
                "takenBy": null,
                "conditionKey": null,
                "sourcePlanSlug": null,
                "watchdogIdentity": {
                  "watchdogKey": {
                    "value": "spec-test-adequacy:disclosed-gap-pinned-cohort-count-label",
                    "present": true
                  },
                  "watchdogLane": {
                    "value": null,
                    "present": false
                  },
                  "watchdogSignalOrigin": {
                    "value": "organic",
                    "present": true
                  },
                  "admissionMergeSources": {
                    "value": null,
                    "present": false
                  }
                },
                "sourcePlanItemIds": null
              },
              "applied": {
                "seeAlso": [
                  "EI-25314295759938757",
                  "EI-25415196322731979",
                  "EI-25458787314271928",
                  "EI-25477838487191856",
                  "EI-25675651383265338",
                  "EI-25679141085310175",
                  "EI-25878474235552349",
                  "EI-26337652074242553",
                  "EI-26401746478528025",
                  "EI-26536646448197500",
                  "EI-26571269777584727"
                ],
                "conditionKey": null,
                "sourcePlanSlug": null,
                "watchdogIdentity": {
                  "watchdogKey": {
                    "value": "spec-test-adequacy:disclosed-gap-pinned-cohort-count-label",
                    "present": true
                  },
                  "watchdogLane": {
                    "value": null,
                    "present": false
                  },
                  "watchdogSignalOrigin": {
                    "value": "organic",
                    "present": true
                  },
                  "admissionMergeSources": {
                    "value": [
                      {
                        "actor": "system:work-item-admission-promoter",
                        "runId": "d010540b-7568-4c74-9e06-a314ab2336e5",
                        "loserId": "EI-26401746478528025",
                        "mergedAtMs": 1794070428672,
                        "schemaVersion": 1
                      }
                    ],
                    "present": true
                  }
                },
                "sourcePlanItemIds": null
              },
              "sourceEntryAdded": true
            },
            "transfers": {
              "occurrences": [
                {
                  "occurrenceId": "712924",
                  "priorCanonicalId": "EI-26401746478528025",
                  "priorCanonicalHarness": "papercusp"
                }
              ],
              "dependencyEdges": [],
              "duplicateOccurrenceId": "833219",
              "canonicalOutgoingAdded": [
                "EI-25314295759938757",
                "EI-25415196322731979",
                "EI-25458787314271928",
                "EI-25675651383265338",
                "EI-25878474235552349",
                "EI-26337652074242553",
                "EI-26401746478528025",
                "EI-26536646448197500",
                "EI-26571269777584727"
              ],
              "incomingReferenceSources": [
                "EI-25314295759938757",
                "EI-25415196322731979",
                "EI-25458787314271928",
                "EI-25675651383265338",
                "EI-25878474235552349",
                "EI-26337652074242553",
                "EI-26536646448197500",
                "EI-26571269777584727"
              ],
              "duplicateOccurrenceCreated": true,
              "loserCanonicalReferenceAdded": true
            },
            "mergedAtMs": 1794070428672,
            "canonicalId": "EI-26264292231558408",
            "schemaVersion": 2,
            "canonicalHarness": "papercusp",
            "judgmentIdentity": {
              "loser": "42e0b650839b995df23c8eb8e6e9f8386f68a7fa0a0271712fdc7bd32113dd16",
              "canonical": "867c4a5f9be21ca133b3030b6c4e8c654700ee1c3cdff1b55c77b3322b7da067"
            },
            "reversalInstructions": {
              "order": [
                "restore-or-delete dependency after-edges from targetPrior, then reinsert each before-edge",
                "repoint transferred occurrence IDs to their prior canonical and delete the duplicate occurrence only when duplicateOccurrenceCreated=true",
                "remove canonical only from the recorded incomingReferenceSources and canonicalOutgoingAdded entries",
                "restore canonical identity, plan and reference fields only when they still equal canonical.applied",
                "restore loser lifecycle, admission, condition, plan, references and admissionReview from prior; then remove admissionMerge"
              ],
              "schemaVersion": 1,
              "transactionRequired": true,
              "compareAppliedStateBeforeRestore": true
            }
          },
          "dedupCandidates": [
            {
              "id": "EI-25477621367097629",
              "method": "semantic-hard",
              "similarity": 0.94
            },
            {
              "id": "EI-25203437570102456",
              "method": "semantic-soft",
              "similarity": 0.93
            },
            {
              "id": "EI-25679141085310175",
              "method": "semantic-hard",
              "similarity": 0.93
            },
            {
              "id": "EI-25675651383265338",
              "method": "semantic-soft",
              "similarity": 0.92
            },
            {
              "id": "EI-25824003399102701",
              "method": "semantic-soft",
              "similarity": 0.91
            }
          ],
          "admissionIdentity": {
            "titleKey": "title:active adequacy binding bindingids but checked clause cohort counts disclosed evaluate evidence for gap only pinned plans says spec test the",
            "schemaVersion": "admission-identity-v1"
          },
          "freshnessEnvelope": {
            "observedAt": "2026-10-19T10:04:27.518Z",
            "linkedFixRefs": [],
            "reporterSession": "su-d21e2aa6-7097-4ffc-9c31-9ab8b8642810",
            "observedSourceSha": "2ba19fcc3a",
            "toolSchemaVersion": null,
            "observedRuntimeSha": "2ba19fcc3a",
            "deployBuildIdentity": "2ba19fcc3a@0.0.0",
            "reporterRuntimeVersion": "0.0.0",
            "lastSuccessfulReproductionAt": null
          },
          "implementationReadiness": {
            "reason": "existing-immediate-capture-policy",
            "source": "capture-policy",
            "status": "ready",
            "updatedAt": "2026-10-19T10:04:27.518Z",
            "schemaVersion": "implementation-readiness-v1"
          }
        },
        "conditionKey": null
      },
      "target": {
        "title": "plans:evaluate-spec-test-adequacy disclosed-gap evidence says \"Checked N active binding(s) for the clause\" but N is the pinned bindingIds cohort, not the clause's active bindings",
        "summary": "Observed while grading-integrity auditing EI-26263264896033940 (spec-test-adequacy rev 12, subject cloud-connection-pairing-unification-2026-10-16#CLOUD-CONNECTION-P005@2, evaluatorBuild 876c290c9b).\n\nThe card's disclosed-gap evidence reads: \"Checked 2 active binding(s) for the clause.\" The card was evaluated with a pinned cohort, bindingIds [54726,54776]. An unpinned read, plans:get-spec-evidence {harness:'papercusp', slug:'cloud-connection-pairing-unification-2026-10-16', specIds:['CLOUD-CONNECTION-P005'], detail:'full', limit:1000} (truncatedByLimit=false), returns 6 active current bindings for the clause: 54776, 54726, 54725, 54616, 54557, 54532.\n\nSo the count is the pinned-cohort count, but the label calls it the clause's active-binding population. The evaluator's own governingNote says pinned reads are diagnostic and the ship gate evaluates every binding unscoped, so this sentence overstates the coverage of an N/A that rests on absence. In this instance the verdict did not change: none of the 6 bindings carries details.adequacy.disclosedGap. But a reader or auditor can take \"for the clause\" as whole-clause coverage when only the cohort was checked.\n\nSuggested fix: when bindingIds/evidenceRefs pin the cohort, word it \"Checked N pinned binding(s) of M active for the clause\" (or similar), or include the unscoped active count. Cause unconfirmed: I did not read the evaluator source. The finding comes only from comparing the card text with the two probe results above.",
        "status": "open",
        "duplicate_of": null,
        "payload": {
          "_ei": {
            "scope": "harness:papercusp",
            "source": "engineer",
            "severity": "minor",
            "created_by": "su-6bb966b7-26bf-4788-a884-8dccd06e69d8",
            "found_during": "grading-integrity audit of EI-26263264896033940",
            "signal_origin": "organic"
          },
          "reporter": {
            "at": "2026-10-17T21:39:29.476Z",
            "id": "su-6bb966b7-26bf-4788-a884-8dccd06e69d8",
            "kind": "agent",
            "basis": "agent-session"
          },
          "filedByRole": "judge",
          "watchdogKey": "spec-test-adequacy:disclosed-gap-pinned-cohort-count-label",
          "dedupVerdict": "likely-duplicate",
          "admissionHold": {
            "actor": "system:work-item-admission-promoter",
            "runId": "d010540b-7568-4c74-9e06-a314ab2336e5",
            "heldAt": "2026-11-07T11:53:48.672-05:00",
            "reason": "A's count matches its pinned selection. B's seven-of-ten count may reflect three duplicate proof pairs; selector omission versus deduplicated counting remains unresolved.",
            "screeningDeferred": false
          },
          "dedupCoverage": {
            "lexical": "ok",
            "degraded": false,
            "semantic": "ok"
          },
          "ideaLifecycle": {
            "state": "open",
            "stateUpdatedAt": "2026-10-17T21:39:40.921Z"
          },
          "reportContext": {
            "app": "papercusp",
            "screen": null,
            "refused": [],
            "truncated": [],
            "appVersion": "0.0.0+876c290c9b",
            "capturedAt": "2026-10-17T21:39:29.476Z",
            "logExcerpt": null,
            "screenshot": null,
            "autoCaptured": [
              "app",
              "appVersion"
            ],
            "recentErrors": [],
            "schemaVersion": 1
          },
          "reporterKinds": [
            "agent"
          ],
          "dedupCandidates": [
            {
              "id": "EI-25679141085310175",
              "method": "semantic-soft",
              "similarity": 0.91
            },
            {
              "id": "EI-25477621367097629",
              "method": "semantic-soft",
              "similarity": 0.91
            },
            {
              "id": "EI-25931332240355060",
              "method": "lexical",
              "similarity": 0.83
            },
            {
              "id": "EI-25875727546731271",
              "method": "lexical",
              "similarity": 0.63
            }
          ],
          "admissionIdentity": {
            "titleKey": "title:active adequacy binding bindingids bindings but checked clause cohort disclosed evaluate evidence for gap not pinned plans says spec test the",
            "signalKey": "spec-test-adequacy:disclosed-gap-pinned-cohort-count-label",
            "schemaVersion": "admission-identity-v1"
          },
          "freshnessEnvelope": {
            "observedAt": "2026-10-17T21:39:40.922Z",
            "linkedFixRefs": [],
            "reporterSession": "su-6bb966b7-26bf-4788-a884-8dccd06e69d8",
            "observedSourceSha": "876c290c9b",
            "toolSchemaVersion": null,
            "observedRuntimeSha": "876c290c9b",
            "deployBuildIdentity": "876c290c9b@0.0.0",
            "reporterRuntimeVersion": "0.0.0",
            "lastSuccessfulReproductionAt": null
          },
          "admissionMergeSources": [
            {
              "actor": "system:work-item-admission-promoter",
              "runId": "d010540b-7568-4c74-9e06-a314ab2336e5",
              "loserId": "EI-26401746478528025",
              "mergedAtMs": 1794070428672,
              "schemaVersion": 1
            }
          ],
          "implementationReadiness": {
            "reason": "existing-immediate-capture-policy",
            "source": "capture-policy",
            "status": "ready",
            "updatedAt": "2026-10-17T21:39:40.922Z",
            "schemaVersion": "implementation-readiness-v1"
          }
        },
        "conditionKey": null
      },
      "finalR1Disposition": "OPEN",
      "timeBoundary": "Original report retained in terminal92 raw capture, later target snapshot at 2026-11-08T15:48:45.116Z; source witnesses captured in this qualification. No inferred original-time availability or loaded runtime."
    },
    {
      "originalId": "EI-26716727162323660",
      "targetId": "EI-26674533247533429",
      "classification": "same-specific-symptom-source-supported",
      "qualification": "Both queued managed carry responses were rejected by Stop as no wake. Current source requires a bounded fallback for fresh pending carry and refusal if fallback fails. Target reports700 tests, but none of the eight retained ledger rows bind this suite; independent historical execution and actual successor proof remain unverified.",
      "original": {
        "title": "Codex Stop wake guard rejects queued managed carry-respawn as silent halt",
        "summary": "Observed 2026-10-22 in su-06896fcb-c67f-4df2-b166-8e059570280b, WI-10007213. At21:29:59 session:request-compaction returned ok:true/requested:true/respawn:queued and instructed end turn so host can respawn. The next final was refused by Stop hook stop:23 (/home/marsh-office/.papercusp/su-codex-homes/session-49831/hooks.json), claiming no wake and scheduling13min rewake despite queued carry. Context watchdog simultaneously required compaction at204%. Workaround: arm 60s work loop for genuinely unblocked Rust verification, then re-request carry with updated control. Suspected lifecycle contract mismatch; root cause unconfirmed. Proposed fix: Stop reachability guard should recognize a valid queued managed carry-respawn or request-compaction should atomically register a bounded fallback wake before instructing quiet/turn-end. Guard must still refuse if queued carry is canceled/dropped with no durable successor. Add integrated regression for compaction queued→Stop→successor invoked and failed/canceled respawn fallback.",
        "status": "dropped",
        "duplicate_of": "EI-26674533247533429",
        "payload": {
          "_ei": {
            "scope": "harness:papercusp",
            "source": "su",
            "severity": "major",
            "created_by": "su-06896fcb-c67f-4df2-b166-8e059570280b",
            "signal_origin": "organic"
          },
          "reporter": {
            "at": "2026-10-22T21:30:55.476Z",
            "id": "su-06896fcb-c67f-4df2-b166-8e059570280b",
            "kind": "agent",
            "basis": "agent-session"
          },
          "filedByRole": "su",
          "admissionHold": {
            "actor": "system:work-item-admission-promoter",
            "runId": "sched-.routinesTick-2026-11-05T11:00:00.000Z-71",
            "heldAt": "2026-11-05T06:08:39.323-05:00",
            "reason": "admission recurrence-identity guard blocked component EI-26716727162323660: conflicting stable producer identities watchdog=[codex-stop-refuses-queued-carry-respawn/organic/improvement, codex-stop-rejects-queued-carry-respawn/organic/improvement, tool-failure-signature:codex-stop-hook:structural:turn_end_refused_after_queued_carry:field-unknown/organic/improvement]",
            "screeningDeferred": false
          },
          "dedupCoverage": {
            "lexical": "ok",
            "degraded": false,
            "rescreen": {
              "at": "2026-10-28T19:16:40.609Z",
              "by": "admission-fail-open:dedup-rescreen",
              "atMs": 1793215000609,
              "prior": {
                "lexical": "ok",
                "degraded": true,
                "semantic": "partial"
              },
              "runId": "985f74af-158f-4da8-8723-e13ce8b6ef72",
              "outcome": "candidates",
              "attempts": 1
            },
            "semantic": "ok"
          },
          "ideaLifecycle": {
            "state": "triaged",
            "ideaType": "code-bug",
            "triagedAt": "2026-10-23T11:59:16.303Z",
            "triageReason": "code-bug, policy tier=auto (no protected path/keyword → AUTO-eligible (still gated by blueprint + tests + release-manager)) — auto-implement lane (D-003: one verdict chain)",
            "stateUpdatedAt": "2026-10-23T11:59:16.303Z",
            "triageDecision": "place"
          },
          "reportContext": {
            "app": "papercusp",
            "screen": null,
            "refused": [],
            "truncated": [],
            "appVersion": "0.0.0+516579404d",
            "capturedAt": "2026-10-22T21:30:55.476Z",
            "logExcerpt": null,
            "screenshot": null,
            "autoCaptured": [
              "app",
              "appVersion"
            ],
            "recentErrors": [],
            "schemaVersion": 1
          },
          "reporterKinds": [
            "agent"
          ],
          "admissionMerge": {
            "actor": "system:work-item-admission-promoter",
            "prior": {
              "status": "open",
              "seeAlso": [
                "EI-26582383069494918",
                "EI-27567712338362156"
              ],
              "takenBy": null,
              "admission": "pending",
              "admittedAt": null,
              "admittedBy": null,
              "closedAtMs": null,
              "conditionKey": null,
              "terminalOwner": null,
              "sourcePlanSlug": null,
              "terminalReason": null,
              "admissionReview": {
                "value": null,
                "present": false
              },
              "watchdogIdentity": {
                "watchdogKey": {
                  "value": null,
                  "present": false
                },
                "watchdogLane": {
                  "value": null,
                  "present": false
                },
                "watchdogSignalOrigin": {
                  "value": "organic",
                  "present": true
                },
                "admissionMergeSources": {
                  "value": null,
                  "present": false
                }
              },
              "sourcePlanItemIds": null
            },
            "runId": "sched-.routinesTick-2026-11-08T01:32:00.000Z-19",
            "state": "complete",
            "canonical": {
              "prior": {
                "seeAlso": [
                  "EI-26731140517030664",
                  "EI-26914016701436130",
                  "EI-26915232078762854",
                  "EI-26925343322898506",
                  "EI-26949109268850515",
                  "EI-26989788598633899",
                  "EI-26991091964915752",
                  "EI-26998095205519990",
                  "EI-27015256472667449",
                  "EI-27068150154238048",
                  "EI-27072885052499278"
                ],
                "takenBy": null,
                "conditionKey": null,
                "sourcePlanSlug": null,
                "watchdogIdentity": {
                  "watchdogKey": {
                    "value": "repeated-tool-error:Codex Stop hook:structural:auto_open_item_no_wake:field-unknown",
                    "present": true
                  },
                  "watchdogLane": {
                    "value": null,
                    "present": false
                  },
                  "watchdogSignalOrigin": {
                    "value": "organic",
                    "present": true
                  },
                  "admissionMergeSources": {
                    "value": [
                      {
                        "actor": "system:work-item-admission-promoter",
                        "runId": "sched-.routinesTick-2026-11-02T13:40:00.000Z-7",
                        "loserId": "EI-26925343322898506",
                        "mergedAtMs": 1793627507977,
                        "schemaVersion": 1
                      },
                      {
                        "actor": "system:work-item-admission-promoter",
                        "runId": "sched-.routinesTick-2026-11-02T13:40:00.000Z-7",
                        "loserId": "EI-26998095205519990",
                        "mergedAtMs": 1793627507977,
                        "schemaVersion": 1
                      },
                      {
                        "actor": "system:work-item-admission-promoter",
                        "runId": "sched-.routinesTick-2026-11-02T13:40:00.000Z-7",
                        "loserId": "EI-27068150154238048",
                        "mergedAtMs": 1793627507977,
                        "schemaVersion": 1
                      },
                      {
                        "actor": "system:work-item-admission-promoter",
                        "runId": "sched-.routinesTick-2026-11-02T15:49:30.000Z-3",
                        "loserId": "EI-26991091964915752",
                        "mergedAtMs": 1793635166651,
                        "schemaVersion": 1
                      }
                    ],
                    "present": true
                  }
                },
                "sourcePlanItemIds": null
              },
              "applied": {
                "seeAlso": [
                  "EI-26582383069494918",
                  "EI-26716727162323660",
                  "EI-26731140517030664",
                  "EI-26914016701436130",
                  "EI-26915232078762854",
                  "EI-26925343322898506",
                  "EI-26949109268850515",
                  "EI-26989788598633899",
                  "EI-26991091964915752",
                  "EI-26998095205519990",
                  "EI-27015256472667449",
                  "EI-27068150154238048",
                  "EI-27072885052499278",
                  "EI-27567712338362156"
                ],
                "conditionKey": null,
                "sourcePlanSlug": null,
                "watchdogIdentity": {
                  "watchdogKey": {
                    "value": "repeated-tool-error:Codex Stop hook:structural:auto_open_item_no_wake:field-unknown",
                    "present": true
                  },
                  "watchdogLane": {
                    "value": null,
                    "present": false
                  },
                  "watchdogSignalOrigin": {
                    "value": "organic",
                    "present": true
                  },
                  "admissionMergeSources": {
                    "value": [
                      {
                        "actor": "system:work-item-admission-promoter",
                        "runId": "sched-.routinesTick-2026-11-02T13:40:00.000Z-7",
                        "loserId": "EI-26925343322898506",
                        "mergedAtMs": 1793627507977,
                        "schemaVersion": 1
                      },
                      {
                        "actor": "system:work-item-admission-promoter",
                        "runId": "sched-.routinesTick-2026-11-02T13:40:00.000Z-7",
                        "loserId": "EI-26998095205519990",
                        "mergedAtMs": 1793627507977,
                        "schemaVersion": 1
                      },
                      {
                        "actor": "system:work-item-admission-promoter",
                        "runId": "sched-.routinesTick-2026-11-02T13:40:00.000Z-7",
                        "loserId": "EI-27068150154238048",
                        "mergedAtMs": 1793627507977,
                        "schemaVersion": 1
                      },
                      {
                        "actor": "system:work-item-admission-promoter",
                        "runId": "sched-.routinesTick-2026-11-02T15:49:30.000Z-3",
                        "loserId": "EI-26991091964915752",
                        "mergedAtMs": 1793635166651,
                        "schemaVersion": 1
                      },
                      {
                        "actor": "system:work-item-admission-promoter",
                        "runId": "sched-.routinesTick-2026-11-08T01:32:00.000Z-19",
                        "loserId": "EI-26716727162323660",
                        "mergedAtMs": 1794102657759,
                        "schemaVersion": 1
                      }
                    ],
                    "present": true
                  }
                },
                "sourcePlanItemIds": null
              },
              "sourceEntryAdded": true
            },
            "transfers": {
              "occurrences": [
                {
                  "occurrenceId": "745063",
                  "priorCanonicalId": "EI-26716727162323660",
                  "priorCanonicalHarness": "papercusp"
                }
              ],
              "dependencyEdges": [],
              "duplicateOccurrenceId": "835782",
              "canonicalOutgoingAdded": [
                "EI-26582383069494918",
                "EI-26716727162323660",
                "EI-27567712338362156"
              ],
              "incomingReferenceSources": [
                "EI-26582383069494918",
                "EI-27567712338362156"
              ],
              "duplicateOccurrenceCreated": true,
              "loserCanonicalReferenceAdded": true
            },
            "mergedAtMs": 1794102657759,
            "canonicalId": "EI-26674533247533429",
            "schemaVersion": 2,
            "canonicalHarness": "papercusp",
            "judgmentIdentity": {
              "loser": "addbd496d82943ca136aa6233cc0ec7c8853be01d5dd79fe43f144dcf6cea3ff",
              "canonical": "8b75c39c70a2413aa958962f509a9afc1e49358f33fd1e390869bb893c39f331"
            },
            "reversalInstructions": {
              "order": [
                "restore-or-delete dependency after-edges from targetPrior, then reinsert each before-edge",
                "repoint transferred occurrence IDs to their prior canonical and delete the duplicate occurrence only when duplicateOccurrenceCreated=true",
                "remove canonical only from the recorded incomingReferenceSources and canonicalOutgoingAdded entries",
                "restore canonical identity, plan and reference fields only when they still equal canonical.applied",
                "restore loser lifecycle, admission, condition, plan, references and admissionReview from prior; then remove admissionMerge"
              ],
              "schemaVersion": 1,
              "transactionRequired": true,
              "compareAppliedStateBeforeRestore": true
            }
          },
          "dedupCandidates": [
            {
              "id": "EI-26904511820115161",
              "method": "semantic-hard",
              "similarity": 0.942038921774594
            },
            {
              "id": "EI-26738956408275827",
              "method": "semantic-hard",
              "similarity": 0.9415569586025766
            },
            {
              "id": "EI-26918124920896759",
              "method": "semantic-hard",
              "similarity": 0.9307061073815327
            },
            {
              "id": "EI-26762108184861918",
              "method": "semantic-hard",
              "similarity": 0.929920999107391
            },
            {
              "id": "EI-26973277445571837",
              "method": "semantic-hard",
              "similarity": 0.9266340688844961
            }
          ],
          "admissionIdentity": {
            "titleKey": "title:carry codex guard halt managed queued rejects respawn silent stop wake",
            "schemaVersion": "admission-identity-v1"
          },
          "freshnessEnvelope": {
            "observedAt": "2026-10-22T21:30:56.504Z",
            "linkedFixRefs": [],
            "reporterSession": "su-06896fcb-c67f-4df2-b166-8e059570280b",
            "observedSourceSha": "516579404d",
            "toolSchemaVersion": null,
            "observedRuntimeSha": "516579404d",
            "deployBuildIdentity": "516579404d@0.0.0",
            "reporterRuntimeVersion": "0.0.0",
            "lastSuccessfulReproductionAt": null
          },
          "implementationReadiness": {
            "reason": "existing-immediate-capture-policy",
            "source": "capture-policy",
            "status": "ready",
            "updatedAt": "2026-10-22T21:30:56.504Z",
            "schemaVersion": "implementation-readiness-v1"
          }
        },
        "conditionKey": null
      },
      "target": {
        "title": "Codex stop hook refuses quiescence after a carry-respawn is queued",
        "summary": "Suspected cross-layer continuation contract gap. session:request-compaction returned ok:true,requested:true,respawn:queued,firstPromptSource:continuation-note,staleCheckpoints:[] and instructed ending at the clean boundary so the pty goes QUIET and the host respawns. The immediately following Codex Stop hook (stop:22,session-42663) refused turn end because AUTO held parentWI-6554700010010682 with no armedloop/timedawait;it claimed nothing would wake the session despite the queued continuation. The loop checkpoint guidance had also named self-compaction as an allowed continuation route. Rootcause not inspected: guard may intentionally require an independent wake because a queued carry can drop,but these tool instructions currently disagree. Restored existing parent workloop60s/cold—not a new monitoring mission—so stopping is safe. Durable fix should reconcile stopguard with a fresh bounded pending carry,or have request-compaction explicitly arrange/require the independent bounded wake before instructing quiescence. Add coverage for queuedcarry+heldAUTO item+Stop hook.",
        "status": "done",
        "duplicate_of": null,
        "payload": {
          "_ei": {
            "scope": "harness:papercusp",
            "source": "su",
            "severity": "major",
            "created_by": "su-c05233eb-d1be-4e44-b16e-51d9d3532894",
            "found_during": "WI-6554700010010682",
            "signal_origin": "organic"
          },
          "reporter": {
            "at": "2026-10-22T10:20:12.801Z",
            "id": "su-c05233eb-d1be-4e44-b16e-51d9d3532894",
            "kind": "agent",
            "basis": "agent-session"
          },
          "filedByRole": "su",
          "watchdogKey": "repeated-tool-error:Codex Stop hook:structural:auto_open_item_no_wake:field-unknown",
          "_assumptions": {
            "declared": "none",
            "resolvedAt": "2026-10-29T00:52:58.564Z"
          },
          "admissionHold": {
            "actor": "system:work-item-admission-promoter",
            "runId": "f40681a0-e45e-4234-8e25-de062f1bb37d",
            "heldAt": "2026-10-28T19:29:55.259-04:00",
            "reason": "admission recurrence-identity guard blocked component EI-26674533247533429: conflicting stable producer identities watchdog=[codex-stop-rejects-queued-carry-respawn/organic/improvement, repeated-tool-error:Codex Stop hook:structural:auto_open_item_no_wake:field-unknown/organic/improvement, tool-failure-signature:codex-stop-hook:structural:turn_end_refused_after_queued_carry:field-unknown/organic/improvement]",
            "screeningDeferred": false
          },
          "dedupCoverage": {
            "lexical": "ok",
            "degraded": false,
            "rescreen": {
              "at": "2026-10-23T00:58:40.956Z",
              "by": "admission-fail-open:dedup-rescreen",
              "atMs": 1792717120956,
              "prior": {
                "lexical": "ok",
                "degraded": true,
                "semantic": "partial"
              },
              "runId": "sched-.routinesTick-2026-10-23T00:57:30.000Z-15",
              "outcome": "candidates",
              "attempts": 7
            },
            "semantic": "ok"
          },
          "ideaLifecycle": {
            "state": "open",
            "stateUpdatedAt": "2026-10-22T10:20:16.972Z"
          },
          "reportContext": {
            "app": "papercusp",
            "screen": null,
            "refused": [],
            "truncated": [],
            "appVersion": "0.0.0+4e3d728bf7",
            "capturedAt": "2026-10-22T10:20:12.801Z",
            "logExcerpt": null,
            "screenshot": null,
            "autoCaptured": [
              "app",
              "appVersion",
              "recentErrors"
            ],
            "recentErrors": [
              {
                "at": "2026-10-22T10:20:12.801Z",
                "source": "Codex Stop hook",
                "message": "Codex Stop hook auto_open_item_no_wake: Stop hook refused the quiescent boundary required by successful queued session:request-compaction."
              }
            ],
            "schemaVersion": 1
          },
          "reporterKinds": [
            "agent"
          ],
          "admissionReview": {
            "alert": {
              "key": "work-item-admission-review-debt",
              "state": "cleared",
              "reason": "review moot: item already terminal",
              "emittedAt": "2026-10-28T21:17:06.498-04:00"
            },
            "state": "terminal",
            "enteredAt": "2026-10-28T15:36:36.595-04:00",
            "mootReason": "item was already done when its fail-open duplication review came due; a terminal item is never claimed again, so the review cannot change anything",
            "retryOwner": "system:work-item-admission-promoter",
            "reviewedAt": "2026-10-28T21:17:06.498-04:00",
            "reviewedBy": "system:work-item-admission-fail-open",
            "terminalAt": "2026-10-28T21:17:06.498-04:00",
            "lastRetryAt": "2026-10-28T19:29:55.259-04:00",
            "reviewDueAt": "2026-10-28T16:36:36.595-04:00",
            "retryAttempts": 1,
            "terminalOutcome": "review-moot"
          },
          "candidateExpiry": {
            "at": "2026-10-28T16:19:21.879Z",
            "owner": "system:stranded-tool-failure-sweep",
            "reason": "tool-source-unknown",
            "outcome": "kept",
            "checkedBuild": "2d7239f55e"
          },
          "dedupCandidates": [
            {
              "id": "EI-26716727162323660",
              "method": "semantic-soft",
              "similarity": 0.9077261686325073
            }
          ],
          "admissionFailOpen": {
            "at": "2026-10-28T15:36:36.595-04:00",
            "actor": "system:work-item-admission-fail-open",
            "runId": "sched-.routinesTick-2026-10-28T19:32:30.000Z-5",
            "scope": "workspace",
            "reason": "pending-age-exceeded-two-promoter-ticks"
          },
          "admissionIdentity": {
            "titleKey": "title:after carry codex hook queued quiescence refuses respawn stop",
            "signalKey": "repeated-tool-error:Codex Stop hook:structural:auto_open_item_no_wake:field-unknown",
            "schemaVersion": "admission-identity-v1"
          },
          "freshnessEnvelope": {
            "observedAt": "2026-10-22T10:20:16.972Z",
            "linkedFixRefs": [],
            "reporterSession": "su-c05233eb-d1be-4e44-b16e-51d9d3532894",
            "observedSourceSha": "4e3d728bf7",
            "toolSchemaVersion": null,
            "observedRuntimeSha": "4e3d728bf7",
            "deployBuildIdentity": "4e3d728bf7@0.0.0",
            "reporterRuntimeVersion": "0.0.0",
            "lastSuccessfulReproductionAt": "2026-10-22T10:20:16.972Z"
          },
          "_completionEvidence": {
            "summary": "Fixed the carry-respawn acceptance-to-Stop gap. The PTY host now persists initial production carry acceptance before its early ACK; the outcome reader treats that row as pending; Stop only permits quiescence after arming a bounded fallback wake, and continues refusing when that fallback cannot be armed.",
            "coverage": {
              "checked": [
                "apps/operator/lib/psu-pty-host.test.ts",
                "packages/operator-core/lib/carry-respawn-outcome.test.ts",
                "packages/operator-core/lib/events/await/turn-end-held-work-guard.test.ts"
              ],
              "residue": [],
              "notChecked": [],
              "population": [
                "apps/operator/lib/psu-pty-host.test.ts",
                "packages/operator-core/lib/carry-respawn-outcome.test.ts",
                "packages/operator-core/lib/events/await/turn-end-held-work-guard.test.ts"
              ],
              "notApplicable": []
            },
            "testsRun": "npm run test:file -- apps/operator/lib/psu-pty-host.test.ts packages/operator-core/lib/carry-respawn-outcome.test.ts packages/operator-core/lib/events/await/turn-end-held-work-guard.test.ts",
            "treeStamp": {
              "headSha": "7b528cd731064e788004890bcae95a59ab04417f",
              "repositoryRoot": "/home/marsh-office/papercupai-workspace/papercusp",
              "contentIdentity": [
                {
                  "path": "apps/operator/scripts/psu-pty-host.mjs",
                  "headBlobSha": "bb3b8cdc3bd1bbec2638e283f210524780d2b241",
                  "workingTreeBlobSha": "bb3b8cdc3bd1bbec2638e283f210524780d2b241"
                },
                {
                  "path": "apps/operator/lib/psu-pty-host.test.ts",
                  "headBlobSha": "508926de12d5016bbfe8dd2a7bed7632cbf3b789",
                  "workingTreeBlobSha": "508926de12d5016bbfe8dd2a7bed7632cbf3b789"
                },
                {
                  "path": "packages/operator-core/lib/carry-respawn-outcome.ts",
                  "headBlobSha": "922ef67ea48e0da4d4f71e91ed4a6884c80bc5c7",
                  "workingTreeBlobSha": "922ef67ea48e0da4d4f71e91ed4a6884c80bc5c7"
                },
                {
                  "path": "packages/operator-core/lib/carry-respawn-outcome.test.ts",
                  "headBlobSha": "5f2537e62f608266ec1cfaea3bdd243f166d803a",
                  "workingTreeBlobSha": "5f2537e62f608266ec1cfaea3bdd243f166d803a"
                },
                {
                  "path": "packages/operator-core/lib/events/await/turn-end-held-work-guard.ts",
                  "headBlobSha": "073b8be456763f5325869915af08ba06ab3a6090",
                  "workingTreeBlobSha": "073b8be456763f5325869915af08ba06ab3a6090"
                },
                {
                  "path": "packages/operator-core/lib/events/await/turn-end-held-work-guard.test.ts",
                  "headBlobSha": "4c40c7889baa2baef0e649f1764fec286470a7b2",
                  "workingTreeBlobSha": "4c40c7889baa2baef0e649f1764fec286470a7b2"
                }
              ]
            },
            "addedTests": true,
            "testResult": "Passed: 3 files, 700 tests (639 + 42 + 19).",
            "verifiedHow": "Ran the requested test:file command on HEAD c040c5412e with all three test files dirty. The acceptance regression imports the working-tree host module directly in the Vitest parent. The single child substitution was confined to psu-pty-host-starting-snapshot-worker.mjs, which calls the snapshot collector rather than the changed carry-rearm producer.",
            "filesChanged": [
              "apps/operator/scripts/psu-pty-host.mjs",
              "apps/operator/lib/psu-pty-host.test.ts",
              "packages/operator-core/lib/carry-respawn-outcome.ts",
              "packages/operator-core/lib/carry-respawn-outcome.test.ts",
              "packages/operator-core/lib/events/await/turn-end-held-work-guard.ts",
              "packages/operator-core/lib/events/await/turn-end-held-work-guard.test.ts"
            ],
            "settlementManifest": {
              "headSha": "7b528cd731064e788004890bcae95a59ab04417f",
              "version": 1,
              "generation": 1,
              "evidenceHash": "f9c3936b8b4133242ae611e18e947e45a8e8aa4eb3b335825659aaac97df7d2b",
              "repositoryRoot": "/home/marsh-office/papercupai-workspace/papercusp",
              "contentIdentity": [
                {
                  "path": "apps/operator/lib/psu-pty-host.test.ts",
                  "headBlobSha": "508926de12d5016bbfe8dd2a7bed7632cbf3b789",
                  "workingTreeBlobSha": "508926de12d5016bbfe8dd2a7bed7632cbf3b789"
                },
                {
                  "path": "apps/operator/scripts/psu-pty-host.mjs",
                  "headBlobSha": "bb3b8cdc3bd1bbec2638e283f210524780d2b241",
                  "workingTreeBlobSha": "bb3b8cdc3bd1bbec2638e283f210524780d2b241"
                },
                {
                  "path": "packages/operator-core/lib/carry-respawn-outcome.test.ts",
                  "headBlobSha": "5f2537e62f608266ec1cfaea3bdd243f166d803a",
                  "workingTreeBlobSha": "5f2537e62f608266ec1cfaea3bdd243f166d803a"
                },
                {
                  "path": "packages/operator-core/lib/carry-respawn-outcome.ts",
                  "headBlobSha": "922ef67ea48e0da4d4f71e91ed4a6884c80bc5c7",
                  "workingTreeBlobSha": "922ef67ea48e0da4d4f71e91ed4a6884c80bc5c7"
                },
                {
                  "path": "packages/operator-core/lib/events/await/turn-end-held-work-guard.test.ts",
                  "headBlobSha": "4c40c7889baa2baef0e649f1764fec286470a7b2",
                  "workingTreeBlobSha": "4c40c7889baa2baef0e649f1764fec286470a7b2"
                },
                {
                  "path": "packages/operator-core/lib/events/await/turn-end-held-work-guard.ts",
                  "headBlobSha": "073b8be456763f5325869915af08ba06ab3a6090",
                  "workingTreeBlobSha": "073b8be456763f5325869915af08ba06ab3a6090"
                }
              ],
              "normalizedPaths": [
                "apps/operator/lib/psu-pty-host.test.ts",
                "apps/operator/scripts/psu-pty-host.mjs",
                "packages/operator-core/lib/carry-respawn-outcome.test.ts",
                "packages/operator-core/lib/carry-respawn-outcome.ts",
                "packages/operator-core/lib/events/await/turn-end-held-work-guard.test.ts",
                "packages/operator-core/lib/events/await/turn-end-held-work-guard.ts"
              ]
            },
            "rootCauseVerification": {
              "hypothesis": "The host returned an early accepted ACK before writing any durable event for the first carry attempt. During the acceptance-to-rearm interval the Stop evaluator therefore saw no pending carry and had no guaranteed wake source.",
              "testResult": "PASS: the three focused files passed (700 tests).",
              "evidenceRefs": [
                "apps/operator/scripts/psu-pty-host.mjs:5852-5856, 15781",
                "apps/operator/lib/psu-pty-host.test.ts:6990-6999, 7437-7454",
                "packages/operator-core/lib/carry-respawn-outcome.ts:49-52, 160-163",
                "packages/operator-core/lib/carry-respawn-outcome.test.ts:177-190",
                "packages/operator-core/lib/events/await/turn-end-held-work-guard.ts:161-180",
                "packages/operator-core/lib/events/await/turn-end-held-work-guard.test.ts:231-266",
                "test:file result at HEAD c040c5412e"
              ],
              "testProcedure": "Run npm run test:file with the three listed paths. In the host unit suite, assert production beginFirstAttempt immediately emits respawn-carry-accepted while drills emit nothing; in the parser suite assert that row is pending; in the Stop guard suite assert an armed fallback allows quiescence and an exhausted fallback preserves refusal.",
              "contractVersion": 2,
              "actualObservation": "The host test observed the immediate production acceptance row and no drill row; the parser test returned pending for that row; Stop tests observed one fallback arm before allowing quiescence and a refusal when fallback was exhausted.",
              "distinguishingTest": "Exercise production beginFirstAttempt and drill beginFirstAttempt, feed the production acceptance row through deriveLastRespawnOutcome, then evaluate Stop with a fresh pending carry under both armed and exhausted fallback outcomes.",
              "alternativeHypothesis": "The Stop fallback arm path was independently broken; recording an earlier acceptance event would not change whether quiescence was safe.",
              "predictedObservations": {
                "hypothesis": "Production acceptance appears durably before rearm; parser reports pending; Stop arms the bounded fallback and allows quiescence only when that arm succeeds.",
                "alternativeHypothesis": "No acceptance row is observable before rearm, so Stop never reaches the pending-carry fallback branch; changing the fallback arm outcome does not distinguish the earlier acceptance window."
              }
            },
            "checkpointProseSnapshot": "## Did\n[turn:self] No source or tests changed. Read the claim and near-duplicate EI-26716727162323660. Current Codex hooks route Stop through the injected adapter. The unguarded-halt sweep reads autonomy mode, loop, and bounded awaits; session:request-compaction marks respawn-expected only after host acceptance and reports respawn:'queued'.\n\n## Left\nRoot cause is unresolved. Determine whether queued carry is a reliable wake or only accepted intent; identify the actual stop-refusal handler; compare the duplicate and existing lifecycle protections; then make the smallest safe fix with a real regression or release this claim if already covered.\n\n## Key insight\nThe session_respawn_expected marker is documented as a SessionEnd lease-release safeguard, not proof the successor launched. The request-compaction result explicitly says queued is intent, not outcome, so do not count the marker or queued status as a guaranteed wake without a durable fallback.\n\n## Next action\nTrace the Stop refusal through the configured command and carry host. Inspect the active gate implementation and existing tests before editing.\n\n---\n\n\n## Verified source trace (2026-10-28)\nThe active CODEX_HOME/hooks.json Stop entry runs the Codex injection adapter; the adapter maps Stop to `/api/agent-mcp/stop-context`, whose evaluator is `evaluateTurnEndHeldWorkStop`. `request-compaction` receives the host's early `accepted` ACK and returns `respawn:'queued'`. The host calls `carryRearm.beginFirstAttempt()` before ACK, but that only updates an in-memory set; the first durable `respawn-rearm-queued` row is emitted only after the initial busy-gate wait defers. The Stop evaluator reads `readPriorRespawnOutcome` from the host event log and only sees pending rearm/spawn rows, so an immediate Stop can miss the just-accepted request.\n\n## Safety decision\n`session_respawn_expected` is a lease-release marker, not proof of a successor wake. A host-accepted carry may still drop. If Stop allows quiescence while a fresh carry is pending, it must retain/arm a bounded turn-end rewake fallback; if that fallback cannot be armed, Stop must continue refusing.\n\n## Next\nRecord the initial accepted carry in the existing host event log before ACK, classify it as pending, and update the Stop guard to preserve a bounded fallback timer for that pending-only case. Add regression coverage for the acceptance-to-Stop gap, the outcome parser, and fallback refusal.\n\n---\n\n\n## Fix and verification state (2026-10-29)\nImplemented the immediate-acceptance signal and safe fallback contract. The PTY host now writes `respawn-carry-accepted` during `beginFirstAttempt()` before returning its early ACK; the outcome reader treats this as pending. The Stop guard no longer counts a pending carry as a wake by itself: it retains a bounded turn-end rewake timer before allowing quiescence, and continues refusing when that timer is exhausted or unavailable. The host event regression now expects the accepted row followed by the terminal host-ending row.\n\nFiles changed: `apps/operator/scripts/psu-pty-host.mjs`, `apps/operator/lib/psu-pty-host.test.ts`, `packages/operator-core/lib/carry-respawn-outcome.ts`, `packages/operator-core/lib/carry-respawn-outcome.test.ts`, `packages/operator-core/lib/events/await/turn-end-held-work-guard.ts`, `packages/operator-core/lib/events/await/turn-end-held-work-guard.test.ts`.\n\nVerification is not green yet. The first `npm run test:file` run found a guard-test spy expectation error; that assertion was corrected. The subsequent structured `testing:run` failed in `psu-pty-host.test.ts` because an existing child-exit test expected no event before rearm; that test was corrected to include the acceptance event. No clean rerun has completed. Next: rerun the three focused files and inspect every failure before completing this bug."
          },
          "toolFailureProbation": {
            "class": "structural",
            "state": "promoted",
            "report": {
              "message": "Stop hook refused the quiescent boundary required by successful queued session:request-compaction.",
              "toolName": "Codex Stop hook",
              "errorCode": "auto_open_item_no_wake",
              "directEvidence": {
                "kind": "server-contract-mismatch",
                "actual": "After that successful queue response,the Stop hook refused ending solely for missing loop/timedawait and set an emergency timedrewake.",
                "expected": "The compaction result's instructed clean-boundary turn end should permit the queued firstPromptSource continuation,or explicitly establish a required independent wake."
              }
            },
            "classKey": "repeated-tool-error-class:codex-stop-hook:structural:auto_open_item_no_wake:schema-unknown~field-unknown:runtime-unknown",
            "reporters": [
              "su-c05233eb-d1be-4e44-b16e-51d9d3532894"
            ],
            "lastSeenAt": "2026-10-22T10:20:12.799Z",
            "firstSeenAt": "2026-10-22T10:20:12.799Z",
            "watchdogKey": "repeated-tool-error:Codex Stop hook:structural:auto_open_item_no_wake:field-unknown",
            "intendedKind": "bug",
            "directEvidence": true,
            "deployedRevision": "runtime-unknown",
            "messageFingerprint": "md5-8a705b641e50811a1b4cb0b725ceb1f3",
            "contractFingerprint": "schema-unknown~field-unknown",
            "correlationFingerprint": "codex-stop-hook|auto_open_item_no_wake|schema-unknown|field-unknown|runtime-unknown|md5-8a705b641e50811a1b4cb0b725ceb1f3"
          },
          "_claimSubjectBaseline": {
            "body": "Suspected cross-layer continuation contract gap. session:request-compaction returned ok:true,requested:true,respawn:queued,firstPromptSource:continuation-note,staleCheckpoints:[] and instructed ending at the clean boundary so the pty goes QUIET and the host respawns. The immediately following Codex Stop hook (stop:22,session-42663) refused turn end because AUTO held parentWI-6554700010010682 with no armedloop/timedawait;it claimed nothing would wake the session despite the queued continuation. The loop checkpoint guidance had also named self-compaction as an allowed continuation route. Rootcause not inspected: guard may intentionally require an independent wake because a queued carry can drop,but these tool instructions currently disagree. Restored existing parent workloop60s/cold—not a new monitoring mission—so stopping is safe. Durable fix should reconcile stopguard with a fresh bounded pending carry,or have request-compaction explicitly arrange/require the independent bounded wake before instructing quiescence. Add coverage for queuedcarry+heldAUTO item+Stop hook.",
            "kind": "bug",
            "title": "Codex stop hook refuses quiescence after a carry-respawn is queued",
            "summary": "Suspected cross-layer continuation contract gap. session:request-compaction returned ok:true,requested:true,respawn:queued,firstPromptSource:continuation-note,staleCheckpoints:[] and instructed ending at the clean boundary so the pty goes QUIET and the host respawns. The immediately following Codex Stop hook (stop:22,session-42663) refused turn end because AUTO held parentWI-6554700010010682 with no armedloop/timedawait;it claimed nothing would wake the session despite the queued continuation. The loop checkpoint guidance had also named self-compaction as an allowed continuation route. Rootcause not inspected: guard may intentionally require an independent wake because a queued carry can drop,but these tool instructions currently disagree. Restored existing parent workloop60s/cold—not a new monitoring mission—so stopping is safe. Durable fix should reconcile stopguard with a fresh bounded pending carry,or have request-compaction explicitly arrange/require the independent bounded wake before instructing quiescence. Add coverage for queuedcarry+heldAUTO item+Stop hook.",
            "watchdogKey": "repeated-tool-error:Codex Stop hook:structural:auto_open_item_no_wake:field-unknown"
          },
          "admissionMergeSources": [
            {
              "actor": "system:work-item-admission-promoter",
              "runId": "sched-.routinesTick-2026-11-02T13:40:00.000Z-7",
              "loserId": "EI-26925343322898506",
              "mergedAtMs": 1793627507977,
              "schemaVersion": 1
            },
            {
              "actor": "system:work-item-admission-promoter",
              "runId": "sched-.routinesTick-2026-11-02T13:40:00.000Z-7",
              "loserId": "EI-26998095205519990",
              "mergedAtMs": 1793627507977,
              "schemaVersion": 1
            },
            {
              "actor": "system:work-item-admission-promoter",
              "runId": "sched-.routinesTick-2026-11-02T13:40:00.000Z-7",
              "loserId": "EI-27068150154238048",
              "mergedAtMs": 1793627507977,
              "schemaVersion": 1
            },
            {
              "actor": "system:work-item-admission-promoter",
              "runId": "sched-.routinesTick-2026-11-02T15:49:30.000Z-3",
              "loserId": "EI-26991091964915752",
              "mergedAtMs": 1793635166651,
              "schemaVersion": 1
            },
            {
              "actor": "system:work-item-admission-promoter",
              "runId": "sched-.routinesTick-2026-11-08T01:32:00.000Z-19",
              "loserId": "EI-26716727162323660",
              "mergedAtMs": 1794102657759,
              "schemaVersion": 1
            }
          ],
          "claim_history_post_id": 9001788375295,
          "implementationReadiness": {
            "reason": "existing-immediate-capture-policy",
            "source": "capture-policy",
            "status": "ready",
            "updatedAt": "2026-10-22T10:20:16.972Z",
            "schemaVersion": "implementation-readiness-v1"
          }
        },
        "conditionKey": null
      },
      "finalR1Disposition": "OPEN",
      "timeBoundary": "Original report retained in terminal92 raw capture, later target snapshot at 2026-11-08T15:48:45.116Z; source witnesses captured in this qualification. No inferred original-time availability or loaded runtime."
    },
    {
      "originalId": "EI-26818788465648618",
      "targetId": "EI-26817461799335159",
      "classification": "same-specific-symptom",
      "qualification": "Both retained evaluator routes at42457 disappeared mid-audit; source-read transport failures are preserved. Target open; runtime disappearance cause and recovery not proven by consolidation.",
      "original": {
        "title": "Retained evaluator MCP transport died during grading audit historical read",
        "summary": "During grading-integrity audit EI-26818285841875230, capability:git-evidence on the discovered evaluator runtime servingGeneration serving-generation-v1:e74cf83a4658a7001e04fa43ad889ee36b771da17184ef4dc7e46f93a4660eb3 succeeded for all three pages of anchor-freshness.test.ts, then two identical requests for commit 7ccec94040b8c3c4f8cbbbe33031c6a6a29c5538 path packages/operator-core/lib/plan-items/anchor-freshness.ts failed with HTTP transport send errors to 127.0.0.1:42457. The sanctioned mcp-call helper warned no listener accepted port 42457, fell back to canonical :3070, where capability:git-evidence was unavailable. Root cause is unconfirmed; exact evaluator runtime disappeared mid-audit. The failed source read was preserved as a retrieval failure and not treated as absent evidence.",
        "status": "dropped",
        "duplicate_of": "EI-26817461799335159",
        "payload": {
          "_ei": {
            "scope": "harness:papercusp",
            "source": "su",
            "severity": "major",
            "created_by": "su-673ef83e-8b10-4049-b87c-1175db9dcaa2",
            "signal_origin": "organic"
          },
          "reporter": {
            "at": "2026-10-24T00:33:05.999Z",
            "id": "su-673ef83e-8b10-4049-b87c-1175db9dcaa2",
            "kind": "agent",
            "basis": "agent-session"
          },
          "filedByRole": "judge",
          "dedupVerdict": "likely-duplicate",
          "admissionHold": {
            "actor": "system:work-item-admission-promoter",
            "runId": "sched-.routinesTick-2026-11-06T11:07:30.000Z-5",
            "heldAt": "2026-11-06T06:18:19.956-05:00",
            "reason": "The 42457 historical-read outage and later 46507/primary-MCP outage lack correlated lifecycle evidence establishing the same complete repair.",
            "screeningDeferred": false
          },
          "dedupCoverage": {
            "lexical": "unavailable",
            "degraded": true,
            "semantic": "partial"
          },
          "ideaLifecycle": {
            "state": "triaged",
            "ideaType": "code-bug",
            "triagedAt": "2026-10-24T16:04:03.945Z",
            "triageReason": "code-bug, policy tier=auto (no protected path/keyword → AUTO-eligible (still gated by blueprint + tests + release-manager)) — auto-implement lane (D-003: one verdict chain)",
            "stateUpdatedAt": "2026-10-24T16:04:03.945Z",
            "triageDecision": "place"
          },
          "reportContext": {
            "app": "papercusp",
            "screen": null,
            "refused": [],
            "truncated": [],
            "appVersion": "0.0.0+3c1f46d559",
            "capturedAt": "2026-10-24T00:33:05.999Z",
            "logExcerpt": null,
            "screenshot": null,
            "autoCaptured": [
              "app",
              "appVersion"
            ],
            "recentErrors": [],
            "schemaVersion": 1
          },
          "reporterKinds": [
            "agent"
          ],
          "admissionMerge": {
            "actor": "system:work-item-admission-promoter",
            "prior": {
              "status": "open",
              "seeAlso": [
                "EI-26576409726905968",
                "EI-26820731120801155",
                "EI-27207539724332368"
              ],
              "takenBy": null,
              "admission": "pending",
              "admittedAt": null,
              "admittedBy": null,
              "closedAtMs": null,
              "conditionKey": null,
              "terminalOwner": null,
              "sourcePlanSlug": null,
              "terminalReason": null,
              "admissionReview": {
                "value": null,
                "present": false
              },
              "watchdogIdentity": {
                "watchdogKey": {
                  "value": null,
                  "present": false
                },
                "watchdogLane": {
                  "value": null,
                  "present": false
                },
                "watchdogSignalOrigin": {
                  "value": "organic",
                  "present": true
                },
                "admissionMergeSources": {
                  "value": null,
                  "present": false
                }
              },
              "sourcePlanItemIds": null
            },
            "runId": "sched-.routinesTick-2026-11-08T02:30:30.000Z-29",
            "state": "complete",
            "canonical": {
              "prior": {
                "seeAlso": [
                  "EI-27207539724332368",
                  "EI-27718186796423908"
                ],
                "takenBy": null,
                "conditionKey": null,
                "sourcePlanSlug": null,
                "watchdogIdentity": {
                  "watchdogKey": {
                    "value": null,
                    "present": false
                  },
                  "watchdogLane": {
                    "value": null,
                    "present": false
                  },
                  "watchdogSignalOrigin": {
                    "value": "organic",
                    "present": true
                  },
                  "admissionMergeSources": {
                    "value": null,
                    "present": false
                  }
                },
                "sourcePlanItemIds": null
              },
              "applied": {
                "seeAlso": [
                  "EI-26576409726905968",
                  "EI-26818788465648618",
                  "EI-26820731120801155",
                  "EI-27207539724332368",
                  "EI-27718186796423908"
                ],
                "conditionKey": null,
                "sourcePlanSlug": null,
                "watchdogIdentity": {
                  "watchdogKey": {
                    "value": null,
                    "present": false
                  },
                  "watchdogLane": {
                    "value": null,
                    "present": false
                  },
                  "watchdogSignalOrigin": {
                    "value": "organic",
                    "present": true
                  },
                  "admissionMergeSources": {
                    "value": [
                      {
                        "actor": "system:work-item-admission-promoter",
                        "runId": "sched-.routinesTick-2026-11-08T02:30:30.000Z-29",
                        "loserId": "EI-26818788465648618",
                        "mergedAtMs": 1794106128729,
                        "schemaVersion": 1
                      }
                    ],
                    "present": true
                  }
                },
                "sourcePlanItemIds": null
              },
              "sourceEntryAdded": true
            },
            "transfers": {
              "occurrences": [
                {
                  "occurrenceId": "756914",
                  "priorCanonicalId": "EI-26818788465648618",
                  "priorCanonicalHarness": "papercusp"
                }
              ],
              "dependencyEdges": [],
              "duplicateOccurrenceId": "836066",
              "canonicalOutgoingAdded": [
                "EI-26576409726905968",
                "EI-26818788465648618",
                "EI-26820731120801155"
              ],
              "incomingReferenceSources": [
                "EI-26576409726905968",
                "EI-26820731120801155"
              ],
              "duplicateOccurrenceCreated": true,
              "loserCanonicalReferenceAdded": true
            },
            "mergedAtMs": 1794106128729,
            "canonicalId": "EI-26817461799335159",
            "schemaVersion": 2,
            "canonicalHarness": "papercusp",
            "judgmentIdentity": {
              "loser": "fa499a047559c4cc70de16134c63030dfc2fc6131395fd65e34c9c82aeeadf0e",
              "canonical": "bb6dcf44e83f75f737bb877ff9d9578d236b534a35e4fdc529231b79327ec71a"
            },
            "reversalInstructions": {
              "order": [
                "restore-or-delete dependency after-edges from targetPrior, then reinsert each before-edge",
                "repoint transferred occurrence IDs to their prior canonical and delete the duplicate occurrence only when duplicateOccurrenceCreated=true",
                "remove canonical only from the recorded incomingReferenceSources and canonicalOutgoingAdded entries",
                "restore canonical identity, plan and reference fields only when they still equal canonical.applied",
                "restore loser lifecycle, admission, condition, plan, references and admissionReview from prior; then remove admissionMerge"
              ],
              "schemaVersion": 1,
              "transactionRequired": true,
              "compareAppliedStateBeforeRestore": true
            }
          },
          "dedupCandidates": [
            {
              "id": "EI-26734171703362973",
              "method": "semantic-hard",
              "similarity": 0.93
            },
            {
              "id": "EI-26813429903490642",
              "method": "semantic-soft",
              "similarity": 0.92
            },
            {
              "id": "EI-26576409726905968",
              "method": "semantic-soft",
              "similarity": 0.91
            },
            {
              "id": "EI-26677340494295865",
              "method": "semantic-soft",
              "similarity": 0.9
            }
          ],
          "admissionIdentity": {
            "titleKey": "title:audit died during evaluator grading historical mcp read retained transport",
            "schemaVersion": "admission-identity-v1"
          },
          "freshnessEnvelope": {
            "observedAt": "2026-10-24T00:33:09.725Z",
            "linkedFixRefs": [],
            "reporterSession": "su-673ef83e-8b10-4049-b87c-1175db9dcaa2",
            "observedSourceSha": "3c1f46d559",
            "toolSchemaVersion": null,
            "observedRuntimeSha": "3c1f46d559",
            "deployBuildIdentity": "3c1f46d559@0.0.0",
            "reporterRuntimeVersion": "0.0.0",
            "lastSuccessfulReproductionAt": null
          },
          "implementationReadiness": {
            "reason": "existing-immediate-capture-policy",
            "source": "capture-policy",
            "status": "ready",
            "updatedAt": "2026-10-24T00:33:09.725Z",
            "schemaVersion": "implementation-readiness-v1"
          }
        },
        "conditionKey": null
      },
      "target": {
        "title": "Retained evaluator MCP route died mid grading-integrity audit",
        "summary": "During grading-integrity audit EI-26816727161700429, the bound evaluator route at http://127.0.0.1:42457 successfully served currentness checks, exact evaluator replay, evidence pages, and a complete capability:git-evidence read of nested blob f3807ad0c19a961eeba7d878c06d631e17705984. The next capability:git-evidence request for src/testing/conversation-context.integration.test.ts failed twice with Transport send error / HTTP request failed; tools:find on the same bound route then failed identically. The sanctioned mcp-call helper warned that no listener accepted PAPERCUSP_HONO_PORT=42457 and fell back to canonical :3070, whose catalog did not expose capability:git-evidence. Root cause unconfirmed. This caused an explicit historical-test retrieval failure; no evidence was treated as absent.",
        "status": "open",
        "duplicate_of": null,
        "payload": {
          "_ei": {
            "scope": "harness:papercusp",
            "source": "su",
            "severity": "major",
            "created_by": "su-b23f83d4-8ff2-432d-95e9-db5a275774a3",
            "signal_origin": "organic"
          },
          "filedByRole": "judge",
          "admissionHold": {
            "actor": "system:work-item-admission-promoter",
            "runId": "sched-.routinesTick-2026-11-08T02:30:30.000Z-29",
            "heldAt": "2026-11-07T21:48:48.729-05:00",
            "reason": "A loses retained listener 42457; B loses ordinary MCP transport and later listener 46507. No correlated lifecycle history establishes one complete failure mechanism and remedy.",
            "screeningDeferred": false
          },
          "dedupCoverage": {
            "lexical": "ok",
            "degraded": false,
            "rescreen": {
              "at": "2026-10-29T07:18:15.506Z",
              "by": "admission-fail-open:dedup-rescreen",
              "atMs": 1793258295506,
              "prior": {
                "lexical": "unavailable",
                "degraded": true,
                "semantic": "ok"
              },
              "runId": "sched-.routinesTick-2026-10-29T07:15:30.000Z-7",
              "outcome": "candidates",
              "attempts": 3
            },
            "semantic": "ok"
          },
          "ideaLifecycle": {
            "state": "open",
            "stateUpdatedAt": "2026-10-24T00:12:04.538Z"
          },
          "dedupCandidates": [
            {
              "id": "EI-26818788465648618",
              "method": "semantic-hard",
              "similarity": 0.9407059585627359
            },
            {
              "id": "EI-26734171703362973",
              "method": "semantic-soft",
              "similarity": 0.9196195650327481
            },
            {
              "id": "EI-26691490279352609",
              "method": "semantic-soft",
              "similarity": 0.9192634273014426
            },
            {
              "id": "EI-27084560116725914",
              "method": "semantic-soft",
              "similarity": 0.910678657571121
            },
            {
              "id": "EI-26813346728354872",
              "method": "semantic-soft",
              "similarity": 0.9070068057175411
            }
          ],
          "admissionIdentity": {
            "titleKey": "title:audit died evaluator grading integrity mcp mid retained route",
            "schemaVersion": "admission-identity-v1"
          },
          "freshnessEnvelope": {
            "observedAt": "2026-10-24T00:12:04.539Z",
            "linkedFixRefs": [],
            "reporterSession": "su-b23f83d4-8ff2-432d-95e9-db5a275774a3",
            "observedSourceSha": "d740fc3802",
            "toolSchemaVersion": null,
            "observedRuntimeSha": "d740fc3802",
            "deployBuildIdentity": "d740fc3802@0.0.0",
            "reporterRuntimeVersion": "0.0.0",
            "lastSuccessfulReproductionAt": null
          },
          "admissionMergeSources": [
            {
              "actor": "system:work-item-admission-promoter",
              "runId": "sched-.routinesTick-2026-11-08T02:30:30.000Z-29",
              "loserId": "EI-26818788465648618",
              "mergedAtMs": 1794106128729,
              "schemaVersion": 1
            }
          ],
          "implementationReadiness": {
            "reason": "existing-immediate-capture-policy",
            "source": "capture-policy",
            "status": "ready",
            "updatedAt": "2026-10-24T00:12:04.539Z",
            "schemaVersion": "implementation-readiness-v1"
          }
        },
        "conditionKey": null
      },
      "finalR1Disposition": "OPEN",
      "timeBoundary": "Original report retained in terminal92 raw capture, later target snapshot at 2026-11-08T15:48:45.116Z; source witnesses captured in this qualification. No inferred original-time availability or loaded runtime."
    },
    {
      "originalId": "EI-27090214258511364",
      "targetId": "EI-25944008357416349",
      "classification": "same-specific-symptom-source-supported",
      "qualification": "Both code:run calls reject positional work_items:claim row despite prompt. Current preflight normalizes via prepareToolArgsForSchema; real-validator regression asserts orchestration and rejects script_invalid. Target claims12 passes; eight retained rows do not include that suite, so historical execution remains unverified here. No live runtime claim.",
      "original": {
        "title": "Prompt 'Wire schemas' says work_items:claim takes a CSV `row` arg, but code:run preflight refuses `row` (accepts id/ids/harness/...)",
        "summary": "Observed 2026-10-27 ~00:36Z (su-626bfd3e). The su playbook's '## Wire schemas' section states: `work_items:claim` write <- id:id, assignee:str?, harness:str?, force:bool?, reason:text?, and 'Call these tools with a JSON object containing one `row` argument'. Following it inside code:run (`tools.workItems.claim({ row: 'EI-27085805458559726,,papercusp' })`) was refused before dispatch: argPreflight rejectedArg 'row', 'args.row is not accepted by the current tool schema', accepts [assignee, directiveRef, force, harness, id, ids, items, pilotRole, reason]. The same call with { id, harness } dispatched fine. Either the wire-schema projection is not applied on the code:run dispatch path, or the prompt section is stale. Fix options: (a) code:run's tool proxy accepts the wire `row` form for tools listed in the Wire schemas section (decode via the same column schema), or (b) the prompt section states the row form applies only to direct MCP calls and code:run takes named args. Unknown which is intended; the mismatch costs a refused batch each time an agent follows the prompt.",
        "status": "dropped",
        "duplicate_of": "EI-25944008357416349",
        "payload": {
          "_ei": {
            "scope": "harness:papercusp",
            "source": "su",
            "severity": "major",
            "created_by": "su-626bfd3e-22b0-4d58-bbe4-c306b1231761",
            "signal_origin": "organic"
          },
          "filedByRole": "su",
          "dedupVerdict": "likely-duplicate",
          "admissionHold": {
            "actor": "system:work-item-admission-promoter",
            "runId": "341c5246-1d69-432b-bfab-16f771d0b439",
            "heldAt": "2026-11-03T00:46:09.794-05:00",
            "reason": "admission recurrence-identity guard blocked component EI-27090214258511364: conflicting stable producer identities watchdog=[repeated-tool-error:work_items:claim:structural:args-row-is-not-accepted-by/organic/improvement, tool-failure-signature:code:run:structural:script_invalid:field-unknown/organic/improvement]",
            "screeningDeferred": false
          },
          "dedupCoverage": {
            "lexical": "unavailable",
            "degraded": true,
            "semantic": "ok"
          },
          "ideaLifecycle": {
            "state": "open",
            "stateUpdatedAt": "2026-10-27T00:27:21.560Z"
          },
          "admissionMerge": {
            "actor": "system:work-item-admission-promoter",
            "prior": {
              "status": "open",
              "seeAlso": [],
              "takenBy": null,
              "admission": "pending",
              "admittedAt": null,
              "admittedBy": null,
              "closedAtMs": null,
              "conditionKey": null,
              "terminalOwner": null,
              "sourcePlanSlug": null,
              "terminalReason": null,
              "admissionReview": {
                "value": null,
                "present": false
              },
              "watchdogIdentity": {
                "watchdogKey": {
                  "value": null,
                  "present": false
                },
                "watchdogLane": {
                  "value": null,
                  "present": false
                },
                "watchdogSignalOrigin": {
                  "value": "organic",
                  "present": true
                },
                "admissionMergeSources": {
                  "value": null,
                  "present": false
                }
              },
              "sourcePlanItemIds": null
            },
            "runId": "sched-.routinesTick-2026-11-07T06:24:30.000Z-9",
            "state": "complete",
            "canonical": {
              "prior": {
                "seeAlso": [],
                "takenBy": null,
                "conditionKey": null,
                "sourcePlanSlug": null,
                "watchdogIdentity": {
                  "watchdogKey": {
                    "value": "repeated-tool-error:work_items:claim:structural:args-row-is-not-accepted-by",
                    "present": true
                  },
                  "watchdogLane": {
                    "value": null,
                    "present": false
                  },
                  "watchdogSignalOrigin": {
                    "value": "organic",
                    "present": true
                  },
                  "admissionMergeSources": {
                    "value": null,
                    "present": false
                  }
                },
                "sourcePlanItemIds": null
              },
              "applied": {
                "seeAlso": [
                  "EI-27090214258511364"
                ],
                "conditionKey": null,
                "sourcePlanSlug": null,
                "watchdogIdentity": {
                  "watchdogKey": {
                    "value": "repeated-tool-error:work_items:claim:structural:args-row-is-not-accepted-by",
                    "present": true
                  },
                  "watchdogLane": {
                    "value": null,
                    "present": false
                  },
                  "watchdogSignalOrigin": {
                    "value": "organic",
                    "present": true
                  },
                  "admissionMergeSources": {
                    "value": [
                      {
                        "actor": "system:work-item-admission-promoter",
                        "runId": "sched-.routinesTick-2026-11-07T06:24:30.000Z-9",
                        "loserId": "EI-27090214258511364",
                        "mergedAtMs": 1794034779835,
                        "schemaVersion": 1
                      }
                    ],
                    "present": true
                  }
                },
                "sourcePlanItemIds": null
              },
              "sourceEntryAdded": true
            },
            "transfers": {
              "occurrences": [
                {
                  "occurrenceId": "780740",
                  "priorCanonicalId": "EI-27090214258511364",
                  "priorCanonicalHarness": "papercusp"
                }
              ],
              "dependencyEdges": [],
              "duplicateOccurrenceId": "831345",
              "canonicalOutgoingAdded": [
                "EI-27090214258511364"
              ],
              "incomingReferenceSources": [],
              "duplicateOccurrenceCreated": true,
              "loserCanonicalReferenceAdded": true
            },
            "mergedAtMs": 1794034779835,
            "canonicalId": "EI-25944008357416349",
            "schemaVersion": 2,
            "canonicalHarness": "papercusp",
            "judgmentIdentity": {
              "loser": "d2c1a8274a2bda53ef005b30c72db4e2d29317e2b686ca6c898e7749f17b11a3",
              "canonical": "9e8428e4b8b710a75b8dcfde6e4f5805c9043ad08826fb4e1eb06b9098feefce"
            },
            "reversalInstructions": {
              "order": [
                "restore-or-delete dependency after-edges from targetPrior, then reinsert each before-edge",
                "repoint transferred occurrence IDs to their prior canonical and delete the duplicate occurrence only when duplicateOccurrenceCreated=true",
                "remove canonical only from the recorded incomingReferenceSources and canonicalOutgoingAdded entries",
                "restore canonical identity, plan and reference fields only when they still equal canonical.applied",
                "restore loser lifecycle, admission, condition, plan, references and admissionReview from prior; then remove admissionMerge"
              ],
              "schemaVersion": 1,
              "transactionRequired": true,
              "compareAppliedStateBeforeRestore": true
            }
          },
          "dedupCandidates": [
            {
              "id": "EI-25834219043650557",
              "method": "semantic-hard",
              "similarity": 0.98
            },
            {
              "id": "EI-25701716387274990",
              "method": "semantic-hard",
              "similarity": 0.97
            },
            {
              "id": "EI-24129908913147629",
              "method": "semantic-soft",
              "similarity": 0.93
            },
            {
              "id": "EI-24665500939392174",
              "method": "lexical",
              "similarity": 0.77
            },
            {
              "id": "EI-24856549498226510",
              "method": "lexical",
              "similarity": 0.65
            }
          ],
          "admissionIdentity": {
            "titleKey": "title:accepts arg but claim code csv harness ids items preflight prompt refuses row run says schemas takes wire work",
            "schemaVersion": "admission-identity-v1"
          },
          "freshnessEnvelope": {
            "observedAt": "2026-10-27T00:27:21.561Z",
            "linkedFixRefs": [],
            "reporterSession": "su-626bfd3e-22b0-4d58-bbe4-c306b1231761",
            "observedSourceSha": "d740fc3802",
            "toolSchemaVersion": null,
            "observedRuntimeSha": "d740fc3802",
            "deployBuildIdentity": "d740fc3802@0.0.0",
            "reporterRuntimeVersion": "0.0.0",
            "lastSuccessfulReproductionAt": null
          },
          "implementationReadiness": {
            "reason": "existing-immediate-capture-policy",
            "source": "capture-policy",
            "status": "ready",
            "updatedAt": "2026-10-27T00:27:21.561Z",
            "schemaVersion": "implementation-readiness-v1"
          }
        },
        "conditionKey": null
      },
      "target": {
        "title": "Wire-schema prompt says work_items:claim takes { row }, but code:run arg-preflight refuses row (JSON fields only)",
        "summary": "The su prompt Wire schemas section says to call work_items:claim with a single `row` CSV argument. Inside code:run, tools.work_items.claim({ row }) is refused by argPreflight (accepts id/assignee/harness/...). The two surfaces disagree; the prompt should say the row form applies to direct MCP calls only, or code:run should accept row. Observed su-4ec10b91 2026-10-14 08:49Z.",
        "status": "done",
        "duplicate_of": null,
        "payload": {
          "_ei": {
            "scope": "harness:papercusp",
            "source": "su",
            "severity": "major",
            "created_by": "su-4ec10b91-4f1b-40f4-911c-add703b18da3",
            "signal_origin": "organic"
          },
          "filedByRole": "su",
          "watchdogKey": "repeated-tool-error:work_items:claim:structural:args-row-is-not-accepted-by",
          "_assumptions": {
            "declared": "none",
            "resolvedAt": "2026-10-15T09:11:10.728Z"
          },
          "dedupVerdict": "likely-duplicate",
          "admissionHold": {
            "actor": "system:work-item-admission-promoter",
            "runId": "sched-.routinesTick-2026-10-14T10:30:00.000Z-65",
            "heldAt": "2026-10-14T06:40:06.4-04:00",
            "reason": "admission recurrence-identity guard blocked component EI-24416586696235517: conflicting stable producer identities watchdog=[repeated-tool-error:work_items:claim:structural:args-row-is-not-accepted-by/organic/improvement, tool-failure-signature:code:run:structural:script_invalid:field-unknown/organic/improvement, tool-failure-signature:work_items:claim:structural:script_invalid:field-unknown/organic/improvement]"
          },
          "dedupCoverage": {
            "lexical": "unavailable",
            "degraded": true,
            "semantic": "ok"
          },
          "ideaLifecycle": {
            "state": "triaged",
            "ideaType": "code-bug",
            "triagedAt": "2026-10-14T22:00:23.490Z",
            "triageReason": "code-bug, policy tier=auto (no protected path/keyword → AUTO-eligible (still gated by blueprint + tests + release-manager)) — auto-implement lane (D-003: one verdict chain)",
            "stateUpdatedAt": "2026-10-14T22:00:23.490Z",
            "triageDecision": "place"
          },
          "admissionReview": {
            "alert": {
              "key": "work-item-admission-review-debt",
              "state": "cleared",
              "reason": "review moot: item already terminal",
              "emittedAt": "2026-10-15T05:15:09.103-04:00"
            },
            "state": "terminal",
            "enteredAt": "2026-10-14T06:15:17.329-04:00",
            "mootReason": "item was already done when its fail-open duplication review came due; a terminal item is never claimed again, so the review cannot change anything",
            "retryOwner": "system:work-item-admission-promoter",
            "reviewedAt": "2026-10-15T05:15:09.103-04:00",
            "reviewedBy": "system:work-item-admission-fail-open",
            "terminalAt": "2026-10-15T05:15:09.103-04:00",
            "lastRetryAt": "2026-10-14T06:40:06.4-04:00",
            "reviewDueAt": "2026-10-14T07:15:17.329-04:00",
            "retryAttempts": 1,
            "terminalOutcome": "review-moot"
          },
          "candidateExpiry": {
            "at": "2026-10-14T08:59:15.004Z",
            "owner": "system:stranded-tool-failure-sweep",
            "reason": "failure-after-last-change",
            "outcome": "kept",
            "checkedBuild": "8bf981b25b"
          },
          "dedupCandidates": [
            {
              "id": "EI-24856549498226510",
              "method": "semantic-hard",
              "similarity": 0.97
            },
            {
              "id": "EI-25834219043650557",
              "method": "semantic-hard",
              "similarity": 0.96
            },
            {
              "id": "EI-24129908913147629",
              "method": "semantic-soft",
              "similarity": 0.9
            },
            {
              "id": "EI-24665500939392174",
              "method": "lexical",
              "similarity": 0.65
            },
            {
              "id": "EI-25701716387274990",
              "method": "lexical",
              "similarity": 0.65
            }
          ],
          "admissionFailOpen": {
            "at": "2026-10-14T06:15:17.329-04:00",
            "actor": "system:work-item-admission-fail-open",
            "runId": "sched-.routinesTick-2026-10-14T10:15:00.000Z-41",
            "scope": "workspace",
            "reason": "pending-age-exceeded-two-promoter-ticks"
          },
          "admissionIdentity": {
            "titleKey": "title:arg but claim code fields items json only preflight prompt refuses row run says schema takes wire work",
            "signalKey": "repeated-tool-error:work_items:claim:structural:args-row-is-not-accepted-by",
            "schemaVersion": "admission-identity-v1"
          },
          "freshnessEnvelope": {
            "observedAt": "2026-10-14T08:48:54.431Z",
            "linkedFixRefs": [],
            "reporterSession": "su-4ec10b91-4f1b-40f4-911c-add703b18da3",
            "observedSourceSha": "d740fc3802",
            "toolSchemaVersion": null,
            "observedRuntimeSha": "d740fc3802",
            "deployBuildIdentity": "d740fc3802@0.0.0",
            "reporterRuntimeVersion": "0.0.0",
            "lastSuccessfulReproductionAt": "2026-10-14T08:48:54.431Z"
          },
          "_completionEvidence": {
            "summary": "No new code change was needed: the durable normalization fix is already present in current staging. Historical source at the reported d740fc3802 snapshot validated raw positional arguments, while current code.run preflight applies prepareToolArgsForSchema before schema checks. The current focused regression passes. This closes the source behavior; live release egress was not inspected or claimed.",
            "testsRun": "npm run test:file -- packages/operator-core/lib/agent-tools/code/run.arg-preflight.test.ts",
            "treeStamp": {
              "headSha": "bef8d2fb9f3792fb713eaffaa438663291c39a8e",
              "repositoryRoot": "/home/marsh-office/papercupai-workspace/papercusp"
            },
            "testResult": "Passed: 1 file, 12 tests, at current staging HEAD bef8d2fb9f; named path was clean.",
            "verifiedHow": "Compared historical d740fc3802 recipe-schema-validation.ts with current staging source and ran the focused code.run preflight suite. The regression case uses the real validator for tools.workItems.claim({ row: ... }), asserts the orchestrator is called, and rejects script_invalid.",
            "rootCauseVerification": {
              "hypothesis": "The historical code.run preflight failed to apply the dispatcher positional-write reconstruction before validating a {row} call against the keyed input schema, so it incorrectly treated row as an unknown key.",
              "testResult": "Historical source directly validated nestedArgs; current source normalizes with prepareToolArgsForSchema; the focused current-HEAD suite passed 12/12 and the positional-row case reached orchestration.",
              "evidenceRefs": [
                "d740fc3802:packages/operator-core/lib/agent-tools/recipes/recipe-schema-validation.ts",
                "packages/operator-core/lib/agent-tools/recipes/recipe-schema-validation.ts:302",
                "packages/operator-core/lib/agent-tools/code/run.arg-preflight.test.ts:137",
                "libs/generic/tooldef/src/define-tool.ts:907"
              ],
              "testProcedure": "git show d740fc3802:packages/operator-core/lib/agent-tools/recipes/recipe-schema-validation.ts; inspect current packages/operator-core/lib/agent-tools/recipes/recipe-schema-validation.ts; npm run test:file -- packages/operator-core/lib/agent-tools/code/run.arg-preflight.test.ts",
              "contractVersion": 2,
              "actualObservation": "The historical d740fc3802 file lacks prepareToolArgsForSchema and passes nestedArgs directly to validateValue. Current staging calls prepareToolArgsForSchema at line 302, and the focused suite passed 12/12 including its positional work_items:claim row test.",
              "distinguishingTest": "Inspect d740fc3802 and current recipe-schema-validation.ts, then run the existing current-HEAD code.run positional-row regression in run.arg-preflight.test.ts.",
              "alternativeHypothesis": "The current work_items:claim positional-write registration is absent, so rejecting {row} remains correct and the reported issue still reproduces on current staging.",
              "predictedObservations": {
                "hypothesis": "Historical source passes raw nestedArgs to validateValue and flags row as unknown; current source reconstructs it before validation, so the focused regression reaches orchestration.",
                "alternativeHypothesis": "If current registration is absent, the real validator still returns a row schema refusal and the focused regression fails before orchestration."
              }
            }
          },
          "toolFailureProbation": {
            "class": "structural",
            "state": "promoted",
            "report": {
              "message": "args.row is not accepted by the current tool schema (code:run preflight)",
              "toolName": "work_items:claim",
              "errorCode": "script_invalid",
              "reproduced": true
            },
            "classKey": "repeated-tool-error-class:work_items:claim:structural:script_invalid:schema-unknown~field-unknown:runtime-unknown",
            "reporters": [
              "su-4ec10b91-4f1b-40f4-911c-add703b18da3"
            ],
            "lastSeenAt": "2026-10-14T08:48:49.763Z",
            "firstSeenAt": "2026-10-14T08:48:49.763Z",
            "watchdogKey": "repeated-tool-error:work_items:claim:structural:args-row-is-not-accepted-by",
            "intendedKind": "bug",
            "directEvidence": true,
            "deployedRevision": "runtime-unknown",
            "messageFingerprint": "args-row-is-not-accepted-by",
            "contractFingerprint": "schema-unknown~field-unknown",
            "correlationFingerprint": "work_items:claim|script_invalid|schema-unknown|field-unknown|runtime-unknown|args-row-is-not-accepted-by"
          },
          "admissionMergeSources": [
            {
              "actor": "system:work-item-admission-promoter",
              "runId": "sched-.routinesTick-2026-11-07T06:24:30.000Z-9",
              "loserId": "EI-27090214258511364",
              "mergedAtMs": 1794034779835,
              "schemaVersion": 1
            }
          ],
          "claim_history_post_id": 9001788375295,
          "implementationReadiness": {
            "reason": "existing-immediate-capture-policy",
            "source": "capture-policy",
            "status": "ready",
            "updatedAt": "2026-10-14T08:48:54.431Z",
            "schemaVersion": "implementation-readiness-v1"
          },
          "deploymentStalenessScreen": {
            "at": "2026-10-14T22:00:23.490Z",
            "state": "current",
            "divert": false,
            "relPath": "packages/operator-core/lib/agent-tools/work_items/claim.ts",
            "treeRef": "staging",
            "screened": true,
            "toolName": "work_items:claim",
            "deployedSha": "0e2f2291d5"
          }
        },
        "conditionKey": null
      },
      "finalR1Disposition": "OPEN",
      "timeBoundary": "Original report retained in terminal92 raw capture, later target snapshot at 2026-11-08T15:48:45.116Z; source witnesses captured in this qualification. No inferred original-time availability or loaded runtime."
    },
    {
      "originalId": "EI-27147781040222330",
      "targetId": "EI-27033376159376450",
      "classification": "same-specific-symptom",
      "qualification": "Both native Edit/Write after cold wake have superuser_foreign_native_session while attributed MCP works. Target open; native binding root cause remains inferred.",
      "original": {
        "title": "Native Edit/Write PreToolUse lock hook refuses superuser_foreign_native_session after a cold-loop /clear context reset, forcing capability:edit",
        "summary": "Observed 2026-10-27 ~15:30Z, su-96b7fe62, cold loop wake fire #52 delivered after a /clear context reset. A native Edit on packages/operator-core/lib/sync-resolver/table-to-query-names.test.ts was blocked: 'PreToolUse:Edit hook error: locks: the operator refused this session identity (superuser_foreign_native_session), so this edit cannot be lock-protected and is blocked. Relaunch through psu so the native session is registered to its owner, or edit via capability:edit / capability:write.' The same session's MCP calls were attributed correctly to su-96b7fe62, and capability:edit then succeeded. Suspected cause [inferred, unprobed]: the cold reset gives the CLI a new native session id that is never re-registered to the owner, so every native Edit/Write in a cold-carry session is refused. Probe: after a cold wake, compare the native session id in the hook payload with the owner's registered native sessions. Fix direction: re-register the native session id on the cold-reset SessionStart, the same way a carry-respawn does.",
        "status": "dropped",
        "duplicate_of": "EI-27033376159376450",
        "payload": {
          "_ei": {
            "scope": "harness:papercusp",
            "source": "su",
            "severity": "major",
            "created_by": "su-96b7fe62-ee9a-4399-ad53-e30bc734d337",
            "signal_origin": "organic"
          },
          "filedByRole": "su",
          "admissionHold": {
            "actor": "system:work-item-admission-promoter",
            "runId": "sched-.routinesTick-2026-11-05T17:41:00.000Z-7",
            "heldAt": "2026-11-05T12:54:52.799-05:00",
            "reason": "deferred: twin EI-25836573308210587 is claim-held; held until it can be judged",
            "screeningDeferred": true
          },
          "dedupCoverage": {
            "lexical": "ok",
            "degraded": false,
            "rescreen": {
              "at": "2026-10-28T11:15:54.721Z",
              "by": "admission-fail-open:dedup-rescreen",
              "atMs": 1793186154721,
              "prior": {
                "lexical": "unavailable",
                "degraded": true,
                "semantic": "unavailable"
              },
              "runId": "sched-.routinesTick-2026-10-28T11:15:00.000Z-41",
              "outcome": "candidates",
              "attempts": 4
            },
            "semantic": "ok"
          },
          "ideaLifecycle": {
            "state": "triaged",
            "ideaType": "code-bug",
            "triagedAt": "2026-10-28T04:00:19.929Z",
            "triageReason": "code-bug, policy tier=auto (no protected path/keyword → AUTO-eligible (still gated by blueprint + tests + release-manager)) — auto-implement lane (D-003: one verdict chain)",
            "stateUpdatedAt": "2026-10-28T04:00:19.929Z",
            "triageDecision": "place"
          },
          "admissionMerge": {
            "actor": "system:work-item-admission-promoter",
            "prior": {
              "status": "open",
              "seeAlso": [
                "EI-24899217154949550",
                "WI-6554700010010405",
                "WI-6554700010015490"
              ],
              "takenBy": null,
              "admission": "pending",
              "admittedAt": null,
              "admittedBy": null,
              "closedAtMs": null,
              "conditionKey": null,
              "terminalOwner": null,
              "sourcePlanSlug": null,
              "terminalReason": null,
              "admissionReview": {
                "value": null,
                "present": false
              },
              "watchdogIdentity": {
                "watchdogKey": {
                  "value": null,
                  "present": false
                },
                "watchdogLane": {
                  "value": null,
                  "present": false
                },
                "watchdogSignalOrigin": {
                  "value": "organic",
                  "present": true
                },
                "admissionMergeSources": {
                  "value": null,
                  "present": false
                }
              },
              "sourcePlanItemIds": null
            },
            "runId": "sched-.routinesTick-2026-11-08T04:00:00.000Z-69",
            "state": "complete",
            "canonical": {
              "prior": {
                "seeAlso": [
                  "EI-24899217154949550",
                  "EI-25841736226035548",
                  "EI-27085472306028539",
                  "WI-6554700010010405",
                  "WI-6554700010015490",
                  "WI-6554700010018453",
                  "WI-6554700010030031"
                ],
                "takenBy": null,
                "conditionKey": null,
                "sourcePlanSlug": null,
                "watchdogIdentity": {
                  "watchdogKey": {
                    "value": null,
                    "present": false
                  },
                  "watchdogLane": {
                    "value": null,
                    "present": false
                  },
                  "watchdogSignalOrigin": {
                    "value": "organic",
                    "present": true
                  },
                  "admissionMergeSources": {
                    "value": null,
                    "present": false
                  }
                },
                "sourcePlanItemIds": null
              },
              "applied": {
                "seeAlso": [
                  "EI-24899217154949550",
                  "EI-25841736226035548",
                  "EI-27085472306028539",
                  "EI-27147781040222330",
                  "WI-6554700010010405",
                  "WI-6554700010015490",
                  "WI-6554700010018453",
                  "WI-6554700010030031"
                ],
                "conditionKey": null,
                "sourcePlanSlug": null,
                "watchdogIdentity": {
                  "watchdogKey": {
                    "value": null,
                    "present": false
                  },
                  "watchdogLane": {
                    "value": null,
                    "present": false
                  },
                  "watchdogSignalOrigin": {
                    "value": "organic",
                    "present": true
                  },
                  "admissionMergeSources": {
                    "value": [
                      {
                        "actor": "system:work-item-admission-promoter",
                        "runId": "sched-.routinesTick-2026-11-08T04:00:00.000Z-69",
                        "loserId": "EI-27147781040222330",
                        "mergedAtMs": 1794111305746,
                        "schemaVersion": 1
                      }
                    ],
                    "present": true
                  }
                },
                "sourcePlanItemIds": null
              },
              "sourceEntryAdded": true
            },
            "transfers": {
              "occurrences": [
                {
                  "occurrenceId": "785669",
                  "priorCanonicalId": "EI-27147781040222330",
                  "priorCanonicalHarness": "papercusp"
                }
              ],
              "dependencyEdges": [],
              "duplicateOccurrenceId": "836445",
              "canonicalOutgoingAdded": [
                "EI-27147781040222330"
              ],
              "incomingReferenceSources": [],
              "duplicateOccurrenceCreated": true,
              "loserCanonicalReferenceAdded": true
            },
            "mergedAtMs": 1794111305746,
            "canonicalId": "EI-27033376159376450",
            "schemaVersion": 2,
            "canonicalHarness": "papercusp",
            "judgmentIdentity": {
              "loser": "28a79b4cdf2341d15b98ba43a039c8e7266b5da6d453070cf98e9ef9ee3089a6",
              "canonical": "fe34b0eedf0ccefc148332ee64fc4ca31f7ecdc3f49641306fa5f6d2116e11e3"
            },
            "reversalInstructions": {
              "order": [
                "restore-or-delete dependency after-edges from targetPrior, then reinsert each before-edge",
                "repoint transferred occurrence IDs to their prior canonical and delete the duplicate occurrence only when duplicateOccurrenceCreated=true",
                "remove canonical only from the recorded incomingReferenceSources and canonicalOutgoingAdded entries",
                "restore canonical identity, plan and reference fields only when they still equal canonical.applied",
                "restore loser lifecycle, admission, condition, plan, references and admissionReview from prior; then remove admissionMerge"
              ],
              "schemaVersion": 1,
              "transactionRequired": true,
              "compareAppliedStateBeforeRestore": true
            }
          },
          "dedupCandidates": [
            {
              "id": "EI-27033376159376450",
              "method": "semantic-hard",
              "similarity": 0.9495389774579153
            },
            {
              "id": "EI-27085472306028539",
              "method": "semantic-hard",
              "similarity": 0.9312549551947465
            },
            {
              "id": "EI-25904676214237738",
              "method": "semantic-hard",
              "similarity": 0.9242066420378284
            }
          ],
          "admissionIdentity": {
            "titleKey": "title:after capability clear cold context edit forcing foreign hook lock loop native pretooluse refuses reset session superuser write",
            "schemaVersion": "admission-identity-v1"
          },
          "freshnessEnvelope": {
            "observedAt": "2026-10-27T15:42:21.523Z",
            "linkedFixRefs": [],
            "reporterSession": "su-96b7fe62-ee9a-4399-ad53-e30bc734d337",
            "observedSourceSha": "d740fc3802",
            "toolSchemaVersion": null,
            "observedRuntimeSha": "d740fc3802",
            "deployBuildIdentity": "d740fc3802@0.0.0",
            "reporterRuntimeVersion": "0.0.0",
            "lastSuccessfulReproductionAt": null
          },
          "implementationReadiness": {
            "reason": "existing-immediate-capture-policy",
            "source": "capture-policy",
            "status": "ready",
            "updatedAt": "2026-10-27T15:42:21.522Z",
            "schemaVersion": "implementation-readiness-v1"
          }
        },
        "conditionKey": null
      },
      "target": {
        "title": "PreToolUse lock hook refuses native Edit/Write after a cold loop wake: 'superuser_foreign_native_session' for the session's own registered owner",
        "summary": "Observed 2026-10-26 ~09:05Z, su-96b7fe62 (psu Claude session, cold loop wake fire #10 after a context reset). The first native Write of a new repo file (packages/operator-core/lib/harness/dogfood-hive-kill-switch.ts) was blocked: 'PreToolUse:Write hook error: locks: the operator refused this session identity (superuser_foreign_native_session), so this edit cannot be lock-protected and is blocked. Relaunch through psu so the native session is registered to its owner, or edit via capability:edit / capability:write.' The same owner's MCP calls (work_items:get, coord:declare-intent, capability:write/edit) succeeded throughout, so the coord identity was valid. Suspected cause [inferred]: the cold-wake respawn starts a new native Claude session id that is not yet bound to the owner in the lock hook's native-session registry. Workaround: capability:write / capability:edit via tools:invoke (lock-protected server-side). Impact: every cold-wake su loses the native Edit/Write tools and must route all edits through tools:invoke. Distinguishing check: on a fresh cold wake, compare the native session id the hook sends with the owner's registered native sessions.",
        "status": "open",
        "duplicate_of": null,
        "payload": {
          "_ei": {
            "scope": "harness:papercusp",
            "source": "su",
            "severity": "major",
            "created_by": "su-96b7fe62-ee9a-4399-ad53-e30bc734d337",
            "signal_origin": "organic"
          },
          "filedByRole": "su",
          "admissionHold": {
            "actor": "system:work-item-admission-promoter",
            "runId": "sched-.routinesTick-2026-11-05T15:00:30.000Z-67",
            "heldAt": "2026-11-05T10:11:41.151-05:00",
            "reason": "deferred: twin EI-25837068522546732 is blocked-state; held until it can be judged",
            "screeningDeferred": true
          },
          "dedupCoverage": {
            "lexical": "ok",
            "degraded": false,
            "rescreen": {
              "at": "2026-10-26T13:15:43.017Z",
              "by": "admission-fail-open:dedup-rescreen",
              "atMs": 1793020543017,
              "prior": {
                "lexical": "unavailable",
                "degraded": true,
                "semantic": "unavailable"
              },
              "runId": "sched-.routinesTick-2026-10-26T13:15:00.000Z-45",
              "outcome": "candidates",
              "attempts": 3
            },
            "semantic": "ok"
          },
          "ideaLifecycle": {
            "state": "triaged",
            "ideaType": "code-bug",
            "triagedAt": "2026-10-26T23:21:42.050Z",
            "triageReason": "code-bug, policy tier=auto (no protected path/keyword → AUTO-eligible (still gated by blueprint + tests + release-manager)) — auto-implement lane (D-003: one verdict chain)",
            "stateUpdatedAt": "2026-10-26T23:21:42.050Z",
            "triageDecision": "place"
          },
          "dedupCandidates": [
            {
              "id": "EI-25904676214237738",
              "method": "semantic-hard",
              "similarity": 0.9204250025495901
            }
          ],
          "admissionIdentity": {
            "titleKey": "title:after cold edit for foreign hook lock loop native own owner pretooluse refuses registered session superuser the wake write",
            "schemaVersion": "admission-identity-v1"
          },
          "freshnessEnvelope": {
            "observedAt": "2026-10-26T09:23:56.525Z",
            "linkedFixRefs": [],
            "reporterSession": "su-96b7fe62-ee9a-4399-ad53-e30bc734d337",
            "observedSourceSha": "d740fc3802",
            "toolSchemaVersion": null,
            "observedRuntimeSha": "d740fc3802",
            "deployBuildIdentity": "d740fc3802@0.0.0",
            "reporterRuntimeVersion": "0.0.0",
            "lastSuccessfulReproductionAt": null
          },
          "admissionMergeSources": [
            {
              "actor": "system:work-item-admission-promoter",
              "runId": "sched-.routinesTick-2026-11-08T04:00:00.000Z-69",
              "loserId": "EI-27147781040222330",
              "mergedAtMs": 1794111305746,
              "schemaVersion": 1
            }
          ],
          "implementationReadiness": {
            "reason": "existing-immediate-capture-policy",
            "source": "capture-policy",
            "status": "ready",
            "updatedAt": "2026-10-26T09:23:56.525Z",
            "schemaVersion": "implementation-readiness-v1"
          }
        },
        "conditionKey": null
      },
      "finalR1Disposition": "OPEN",
      "timeBoundary": "Original report retained in terminal92 raw capture, later target snapshot at 2026-11-08T15:48:45.116Z; source witnesses captured in this qualification. No inferred original-time availability or loaded runtime."
    },
    {
      "originalId": "EI-27687625361005860",
      "targetId": "EI-24818010361425604",
      "classification": "narrower-scope-not-established",
      "qualification": "Generic target kickoff-not-submitted:superseded is insufficient for original exact dormant resume, absent ADV terminal stamp, lost governor lease and absent keyed startup reservation. Signature fold supplies metadata only. Original cause-specific coverage/execution unresolved.",
      "original": {
        "title": "Exact dormant-source resume loses governor lease when ADV terminal evidence is absent",
        "summary": "Blocks WI-6554700010044897 recovery of su-respawn-63bfff47ddf3583f5111e499fb21db10. Current staging3170 exact resume native01a19ad5-78bc-73f2-9ab1-b6a092e7eaca fork:false failed before process opened: RG-49e0e1b0-2522-4029-9aa1-3911fab92bf4 was requeued owner-ended (generation2 leasePresent:false), then cancelled generation3. Authoritative admission metadata has targetOwnerId/launchedBy but NO resumeAdvSessionId/resumeClaimKey/resumeStartupExpiresAtMs. Source launch-agent.ts sets resumeSourceEnded only with hasAdvSessionTerminalEvidence(current), and creates startup reservation only when that is true. This source has no live host/writer but ADV50874 ended_at/by null; liveness reclaimer can still call it ended. Root mismatch: positively dormant exact resumes need the same bounded keyed startup reservation even before the ADV terminal ledger is stamped. Extend the existing reservation condition after exact live/writer recheck, retain all identity/live/fence guards, and add regression for live:false with endedAt:null. Current queue.ts already validates bounded startup metadata; reuse it. No governor bypass or manual launch.\n\nⓘ Possible STALE RUNTIME, not an open defect: `packages/operator-core/lib/agent-tools/capability/launch-agent.ts` (173 newer commits, tip `e4900767feef5670a00bbe09a7512e560d0022b7`) have commits newer than the running build (`d740fc3802`) in `staging`. If this was observed live, verify the deployed generation before triaging; the behavior may already be fixed in the tree.",
        "status": "resolved",
        "duplicate_of": null,
        "payload": {
          "_ei": {
            "scope": "harness:papercusp",
            "source": "su",
            "severity": "major",
            "created_by": "su-cb07773a-062a-4438-98cd-3536f249d4cd",
            "assigned_by": "su-cb07773a-062a-4438-98cd-3536f249d4cd",
            "found_during": "WI-6554700010044897",
            "signal_origin": "organic"
          },
          "paths": [
            "packages/operator-core/lib/agent-tools/capability/launch-agent.ts"
          ],
          "lastSeenAt": "2026-11-02T14:51:28.374Z",
          "filedByRole": "su",
          "repeatCount": 2,
          "watchdogKey": "repeated-tool-error:capability:launch-agent:structural:explicit-fork-false-produced-command-fork",
          "decidedReason": "duplicate of EI-24818010361425604 — tool-failure signature fold (review-system-rework-reduction-2026-09-23 D-010)",
          "dedupCoverage": {
            "lexical": "unavailable",
            "degraded": true,
            "semantic": "unavailable"
          },
          "ideaLifecycle": {
            "state": "open",
            "stateUpdatedAt": "2026-11-02T14:42:57.184Z"
          },
          "codeWorkingSet": {
            "epoch": 2,
            "owner": "su-cb07773a-062a-4438-98cd-3536f249d4cd",
            "paths": [
              "packages/operator-core/lib/adv-sessions.ts",
              "apps/operator/scripts/psu.mjs"
            ],
            "symbols": [],
            "derivedAt": "2026-11-02T16:27:08.561Z"
          },
          "externalBlockers": [
            {
              "ref": "harness:papercusp:event:harness:papercusp:safe-install-writer-release:WI-6554700010030253",
              "kind": "event",
              "status": "cleared",
              "summary": "Maintained regression verification cannot start during the install owner's canonical-reader pause.",
              "evidence": "announced event \"harness:papercusp:event:harness:papercusp:safe-install-writer-release:WI-6554700010030253\" settled",
              "nextVerb": "On release or explicit coordinated reader window, run saved4filemaintainedsuite and then prove current launcher runtime before exactroot63resume.",
              "clearedAt": "2026-11-07T23:18:07.527Z",
              "clearedBy": "su-96b7fe62-ee9a-4399-ad53-e30bc734d337",
              "createdAt": "2026-11-02T17:02:04.758Z",
              "createdBy": "su-cb07773a-062a-4438-98cd-3536f249d4cd",
              "updatedAt": "2026-11-07T23:18:07.527Z",
              "capability": "live-dependency",
              "capabilitySource": "explicit"
            }
          ],
          "admissionIdentity": {
            "titleKey": "title:agent capability despite during exact executes explicit false fork launch recovery served",
            "signalKey": "repeated-tool-error:capability:launch-agent:structural:explicit-fork-false-produced-command-fork",
            "schemaVersion": "admission-identity-v1"
          },
          "freshnessEnvelope": {
            "observedAt": "2026-11-02T14:42:57.185Z",
            "linkedFixRefs": [],
            "reporterSession": "su-cb07773a-062a-4438-98cd-3536f249d4cd",
            "observedSourceSha": "d740fc3802",
            "toolSchemaVersion": null,
            "observedRuntimeSha": "d740fc3802",
            "deployBuildIdentity": "d740fc3802@0.0.0",
            "reporterRuntimeVersion": "0.0.0",
            "lastSuccessfulReproductionAt": "2026-11-02T14:42:57.185Z"
          },
          "signatureFoldedInto": "EI-24818010361425604",
          "toolFailureProbation": {
            "class": "structural",
            "state": "promoted",
            "report": {
              "status": "handler_error",
              "message": "Exact dormant-source resume lost lease owner-ended before markRunning; startup reservation metadata omitted.",
              "toolName": "capability:launch-agent",
              "directEvidence": {
                "kind": "hard-internal",
                "actual": "RG-49e0e1b0 lease requeued owner-ended; metadata omits all startup reservation fields although source is non-live and source ADV ended_at null.",
                "expected": "Verified non-live exact resume retains bounded reservation until child starts"
              }
            },
            "classKey": "repeated-tool-error-class:capability:launch-agent:structural:error-code-unknown:schema-unknown~field-unknown:runtime-unknown",
            "reporters": [
              "su-cb07773a-062a-4438-98cd-3536f249d4cd"
            ],
            "lastSeenAt": "2026-11-02T14:51:28.374Z",
            "firstSeenAt": "2026-11-02T14:51:27.682Z",
            "watchdogKey": "repeated-tool-error:capability:launch-agent:structural:exact-dormant-source-resume-lost-lease",
            "intendedKind": "bug",
            "directEvidence": true,
            "deployedRevision": "runtime-unknown",
            "messageFingerprint": "exact-dormant-source-resume-lost-lease",
            "contractFingerprint": "schema-unknown~field-unknown",
            "correlationFingerprint": "capability:launch-agent|structural|schema-unknown|field-unknown|runtime-unknown|exact-dormant-source-resume-lost-lease"
          },
          "implementationReadiness": {
            "reason": "existing-immediate-capture-policy",
            "source": "capture-policy",
            "status": "ready",
            "updatedAt": "2026-11-02T14:42:57.185Z",
            "schemaVersion": "implementation-readiness-v1"
          }
        },
        "conditionKey": null
      },
      "target": {
        "title": "capability:launch-agent tool-call failure (kickoff-not-submitted:superseded)",
        "summary": "Suspected tool-call failure reported through the canonical improvements:capture toolFailure shorthand.\n\nTool: capability:launch-agent\nStatus: kickoff-not-submitted:superseded\nMessage: Headless AUTO resume for su-9af3fcd5 native01a0fd3d-2369-7631-b4f2-691ca984f44e failed502: kickoff-not-submitted:superseded;task0mur5dvvflxnpdh9kem stopped/alreadygone. Other two headlessAUTO resumes succeeded andverifiednativeUUID. Inspecting live owner before anyretry.\nReproduced: false",
        "status": "blocked",
        "duplicate_of": null,
        "payload": {
          "_ei": {
            "scope": "harness:papercusp",
            "source": "su",
            "severity": "major",
            "created_by": "su-9348d4be-fa7d-4b1e-8f25-378ede46c96f",
            "signal_origin": "organic"
          },
          "lastSeenAt": "2026-10-01T22:33:10.867Z",
          "agentReview": {
            "round": 1,
            "status": "approved",
            "submittedBy": "system:stranded-tool-failure-sweep",
            "ledgerIdeaId": "EI-24818010361425604"
          },
          "consumption": {
            "at": "2026-10-01T23:12:34.008Z",
            "cycleId": "scout-1790896271691"
          },
          "filedByRole": "su",
          "repeatCount": 11,
          "watchdogKey": "tool-failure-signature:capability:launch-agent:structural:error-code-unknown:field-unknown",
          "ideaLifecycle": {
            "state": "triaged",
            "ideaType": "code-bug",
            "triagedAt": "2026-10-03T04:00:10.226Z",
            "triageReason": "code-bug, policy tier=auto (no protected path/keyword → AUTO-eligible (still gated by blueprint + tests + release-manager)) — auto-implement lane (D-003: one verdict chain)",
            "stateUpdatedAt": "2026-10-03T04:00:10.226Z",
            "triageDecision": "place"
          },
          "externalBlockers": [
            {
              "ref": "launch-kickoff-respawn-redelivery-proof:c1d (WI-10005203)",
              "kind": "event",
              "status": "active",
              "summary": "Awaiting the one scoped c1d launch-kickoff redelivery proof owned through WI-10005203.",
              "evidence": "Canonical source and focused tests contain the one-time superseded-kickoff redelivery fix. The exact c1d event log was read through code:run: 146 rows, no launch-kickoff-respawn-redelivery event, last event host-teardown at 2026-10-03T03:07:58Z. The current WI-10005203 assignee is active in another fleet and replied that they are reading original custody and saved proof before choosing the one-shot action.",
              "nextVerb": "After the owner returns the exact announced event key or actual saved proof, verify it and complete with rootCauseVerification.",
              "createdAt": "2026-10-07T16:38:30.270Z",
              "createdBy": "su-27479421-4171-429e-be37-2e86059290b1",
              "recheckAt": "2026-11-08T16:08:21.261Z",
              "updatedAt": "2026-11-08T15:08:21.261Z",
              "capability": "live-dependency",
              "recheckedAt": "2026-11-08T15:08:21.261Z",
              "reachability": {
                "basis": "unmeasured",
                "verdict": "unknown",
                "evidence": "trigger \"launch-kickoff-respawn-redelivery-proof:c1d (WI-10005203)\" may wake a consumer but cannot establish the specific release condition; subject-bound evidence is required",
                "checkedAt": "2026-11-08T15:10:59.267Z",
                "authoritative": false,
                "uncertifiedReason": "uncatalogued"
              },
              "recheckSource": "system:unprovable-wait-backfill",
              "capabilitySource": "explicit",
              "recheckDisposition": "escalated"
            }
          ],
          "freshnessEnvelope": {
            "observedAt": "2026-10-01T22:31:39.063Z",
            "linkedFixRefs": [],
            "reporterSession": "su-9348d4be-fa7d-4b1e-8f25-378ede46c96f",
            "observedSourceSha": "f52b2457ba",
            "toolSchemaVersion": null,
            "observedRuntimeSha": "f52b2457ba",
            "deployBuildIdentity": "f52b2457ba@0.0.0",
            "reporterRuntimeVersion": "0.0.0",
            "lastSuccessfulReproductionAt": null
          },
          "toolFailureProbation": {
            "class": "structural",
            "state": "promoted",
            "report": {
              "status": "unconfirmed",
              "message": "Process opened but resumeVerified:null and roster remains recorded; no new re-vetting reply yet.",
              "toolName": "capability:launch-agent"
            },
            "classKey": "repeated-tool-error-class:capability:launch-agent:structural:error-code-unknown:schema-unknown~field-unknown:runtime-unknown",
            "reporters": [
              "su-9348d4be-fa7d-4b1e-8f25-378ede46c96f",
              "su-35cc653f-278e-4ccb-8dab-26ef6697da6d",
              "su-8c25125d-002d-4b93-9f83-6b463da9ca9b",
              "su-371afed7-3a96-49b7-83a6-7ca117fedbb2"
            ],
            "lastSeenAt": "2026-10-07T16:16:14.240Z",
            "promotedAt": "2026-10-02T16:14:56.028Z",
            "promotedBy": "su-35cc653f-278e-4ccb-8dab-26ef6697da6d",
            "firstSeenAt": "2026-10-07T16:16:14.240Z",
            "watchdogKey": "tool-failure-signature:capability:launch-agent:structural:error-code-unknown:field-unknown",
            "intendedKind": "bug",
            "signatureKey": "tool-failure-signature:capability:launch-agent:structural:error-code-unknown:field-unknown",
            "deployedRevision": "runtime-unknown",
            "messageFingerprint": "process-opened-but-resumeverified-null-and",
            "contractFingerprint": "schema-unknown~field-unknown",
            "promotionReconciledAt": "2026-10-07T16:16:15.308Z",
            "correlationFingerprint": "capability:launch-agent|structural|schema-unknown|field-unknown|runtime-unknown|process-opened-but-resumeverified-null-and",
            "promotionReconciledFrom": "EI-25223272029007582"
          },
          "toolFailureSignature": {
            "classes": {
              "repeated-tool-error-class:capability:launch-agent:structural:error-code-unknown:schema-unknown~field-unknown:runtime-unknown": {
                "count": 11,
                "reporters": [
                  "su-9348d4be-fa7d-4b1e-8f25-378ede46c96f",
                  "su-35cc653f-278e-4ccb-8dab-26ef6697da6d",
                  "su-3bf7b640-454a-408c-ae98-cce32e8fe65b",
                  "su-3daacab2-aed4-4ef4-a715-5fdd0a7fbe7d",
                  "su-2564a37a-107c-48a0-a6fe-d97929063a1f",
                  "su-4acaa6da-4e2e-4349-a77e-5887a902bf20",
                  "su-0dd61ff4-d577-4fe7-9f60-ea00a582bfea",
                  "su-447eac90-733b-4bd5-a2e0-36f5ffa4bc25",
                  "su-cb07773a-062a-4438-98cd-3536f249d4cd"
                ],
                "lastSeenAt": "2026-11-02T14:51:28.374Z",
                "firstSeenAt": "2026-10-02T16:14:55.749Z",
                "deployedRevision": "runtime-unknown",
                "contractFingerprint": "schema-unknown~field-unknown"
              }
            },
            "signatureKey": "tool-failure-signature:capability:launch-agent:structural:error-code-unknown:field-unknown"
          },
          "_claimSubjectBaseline": {
            "body": "Suspected tool-call failure reported through the canonical improvements:capture toolFailure shorthand.\n\nTool: capability:launch-agent\nStatus: kickoff-not-submitted:superseded\nMessage: Headless AUTO resume for su-9af3fcd5 native01a0fd3d-2369-7631-b4f2-691ca984f44e failed502: kickoff-not-submitted:superseded;task0mur5dvvflxnpdh9kem stopped/alreadygone. Other two headlessAUTO resumes succeeded andverifiednativeUUID. Inspecting live owner before anyretry.\nReproduced: false",
            "kind": "bug",
            "title": "capability:launch-agent tool-call failure (kickoff-not-submitted:superseded)",
            "summary": "Suspected tool-call failure reported through the canonical improvements:capture toolFailure shorthand.\n\nTool: capability:launch-agent\nStatus: kickoff-not-submitted:superseded\nMessage: Headless AUTO resume for su-9af3fcd5 native01a0fd3d-2369-7631-b4f2-691ca984f44e failed502: kickoff-not-submitted:superseded;task0mur5dvvflxnpdh9kem stopped/alreadygone. Other two headlessAUTO resumes succeeded andverifiednativeUUID. Inspecting live owner before anyretry.\nReproduced: false",
            "watchdogKey": "tool-failure-signature:capability:launch-agent:structural:error-code-unknown:field-unknown"
          },
          "claim_history_post_id": 9001788375295,
          "promotionReconciledAt": "2026-10-07T16:16:15.308Z",
          "implementationReadiness": {
            "reason": "agent-review-approved",
            "source": "agent-review",
            "status": "ready",
            "evidence": {
              "review": {
                "grade": 4,
                "round": 1,
                "reviewer": "su-34a38187-2a41-4f8a-ae61-0222666f87d3",
                "submittedBy": "system:stranded-tool-failure-sweep"
              }
            },
            "updatedAt": "2026-10-07T16:23:52.001Z",
            "schemaVersion": "implementation-readiness-v1"
          },
          "promotionReconciledFrom": "EI-25223272029007582",
          "strandedToolFailureSweep": {
            "at": "2026-10-06T02:57:04.469Z",
            "owner": "system:stranded-tool-failure-sweep",
            "reason": "failure-after-last-change",
            "outcome": "review"
          },
          "deploymentStalenessScreen": {
            "at": "2026-10-03T04:00:10.226Z",
            "state": "unknown",
            "divert": false,
            "screened": true,
            "toolName": "capability:launch-agent",
            "unknownReason": "tool-source-unknown"
          }
        },
        "conditionKey": null
      },
      "finalR1Disposition": "OPEN",
      "timeBoundary": "Original report retained in terminal92 raw capture, later target snapshot at 2026-11-08T15:48:45.116Z; source witnesses captured in this qualification. No inferred original-time availability or loaded runtime."
    },
    {
      "originalId": "EI-27702611547968789",
      "targetId": "EI-27710843725808900",
      "classification": "same-specific-symptom",
      "qualification": "Both sender-filtered limit1 inbox reads retain an older message despite a newer matching sender reply. Target open; ordering/coalescing cause and fix not proven.",
      "original": {
        "title": "coord:inbox limit1 returns oldest directed message while its contract promises most-recent kept",
        "summary": "Observed successful coord:inbox {from:su-6588e8cb-1193-40b8-9817-a0b5c2961b76,directed:true,limit:1,max_body_chars:2400} at18:39Z. summary.total4/returned1/truncated3/newest_ts_total2026-11-02T18:39:00.842Z, but returned entry is2026-11-02T16:14:36.939Z (coord-send-c23413...), a previously answered message; newest_ts_scope returned-window confirms that older row. Published argument documentation says Max entries returned (most-recent kept). Earlier limit2 returned first and a newer row while omitting an intermediate one. This can hide the fresh readiness reply an agent is trying to consume and re-inject old answered asks. Suspected limiting/coalescing/order interaction; no root cause asserted. Fix at source: apply recency selection after directed/from/coalescing filters, then sort the selected window for display if desired; integration regression with four distinct directed message times and limits1/2 requiring retention of the newest reply. This is a distinct successful-result defect, not a duplicate invocation failure.",
        "status": "dropped",
        "duplicate_of": "EI-27710843725808900",
        "payload": {
          "_ei": {
            "scope": "harness:papercusp",
            "source": "su",
            "severity": "minor",
            "created_by": "su-126cedd3-6292-4a64-9bb8-b95f804379e4",
            "found_during": "WI-6554700010044919",
            "signal_origin": "organic"
          },
          "filedByRole": "su",
          "admissionHold": {
            "actor": "system:work-item-admission-promoter",
            "runId": "sched-.routinesTick-2026-11-06T06:41:00.000Z-5",
            "heldAt": "2026-11-06T01:57:26.97-05:00",
            "reason": "The observed inbox mismatch overlaps, but A leaves recent selection versus documenting/exposing priority ordering unresolved, while B prescribes recency selection. Merge-safe remedy identity is not established.",
            "screeningDeferred": false
          },
          "dedupCoverage": {
            "lexical": "ok",
            "degraded": true,
            "rescreen": {
              "at": "2026-11-02T21:55:36.822Z",
              "by": "admission-fail-open:dedup-rescreen",
              "atMs": 1793656536822,
              "prior": {
                "lexical": "unavailable",
                "degraded": true,
                "semantic": "unavailable"
              },
              "runId": "sched-.routinesTick-2026-11-02T21:54:00.000Z-53",
              "outcome": "degraded",
              "attempts": 3
            },
            "semantic": "unavailable"
          },
          "ideaLifecycle": {
            "state": "open",
            "stateUpdatedAt": "2026-11-02T18:41:09.127Z"
          },
          "admissionMerge": {
            "actor": "system:work-item-admission-promoter",
            "prior": {
              "status": "open",
              "seeAlso": [
                "EI-23808724865930415",
                "EI-25638398164189158",
                "EI-25800052430438652",
                "EI-25869063178115934",
                "EI-26109339765764691",
                "EI-26701717843098576",
                "EI-26775773129679569",
                "EI-26793174762713144",
                "EI-26804557980917939",
                "EI-26841368785199066",
                "EI-26983621596216400",
                "EI-27068131223984168",
                "EI-27527433865945213",
                "EI-27711160314092144",
                "EI-27731923032226126",
                "EI-27739535442778991",
                "EI-27965672769211900",
                "EI-27965761004718638",
                "EI-28055056010570048"
              ],
              "takenBy": null,
              "admission": "unreviewed",
              "admittedAt": "2026-11-02T21:55:37.250Z",
              "admittedBy": "system:work-item-admission-fail-open",
              "closedAtMs": null,
              "conditionKey": null,
              "terminalOwner": null,
              "sourcePlanSlug": null,
              "terminalReason": null,
              "admissionReview": {
                "value": {
                  "alert": {
                    "key": "work-item-admission-review-debt",
                    "state": "open",
                    "reason": "pending fail-open admission requires re-review",
                    "emittedAt": "2026-11-02T16:55:23.533-05:00"
                  },
                  "state": "pending",
                  "enteredAt": "2026-11-02T16:55:23.533-05:00",
                  "retryOwner": "system:work-item-admission-promoter",
                  "reviewedAt": null,
                  "reviewedBy": null,
                  "terminalAt": null,
                  "lastRetryAt": "2026-11-06T01:57:26.97-05:00",
                  "reviewDueAt": "2026-11-02T17:55:23.533-05:00",
                  "retryAttempts": 1,
                  "terminalOutcome": null
                },
                "present": true
              },
              "watchdogIdentity": {
                "watchdogKey": {
                  "value": null,
                  "present": false
                },
                "watchdogLane": {
                  "value": null,
                  "present": false
                },
                "watchdogSignalOrigin": {
                  "value": "organic",
                  "present": true
                },
                "admissionMergeSources": {
                  "value": [
                    {
                      "actor": "system:work-item-admission-promoter",
                      "runId": "sched-.routinesTick-2026-11-04T11:00:00.000Z-71",
                      "loserId": "EI-26841368785199066",
                      "mergedAtMs": 1793790573952,
                      "schemaVersion": 1
                    },
                    {
                      "actor": "system:work-item-admission-promoter",
                      "runId": "sched-.routinesTick-2026-11-05T11:00:00.000Z-71",
                      "loserId": "EI-26701717843098576",
                      "mergedAtMs": 1793876919323,
                      "schemaVersion": 1
                    },
                    {
                      "actor": "system:work-item-admission-promoter",
                      "runId": "sched-.routinesTick-2026-11-05T11:00:00.000Z-71",
                      "loserId": "EI-26983621596216400",
                      "mergedAtMs": 1793876919323,
                      "schemaVersion": 1
                    },
                    {
                      "actor": "system:work-item-admission-promoter",
                      "runId": "sched-.routinesTick-2026-11-05T11:00:00.000Z-71",
                      "loserId": "EI-27068131223984168",
                      "mergedAtMs": 1793876919323,
                      "schemaVersion": 1
                    },
                    {
                      "actor": "system:work-item-admission-promoter",
                      "runId": "sched-.routinesTick-2026-11-05T11:00:00.000Z-71",
                      "loserId": "EI-27527433865945213",
                      "mergedAtMs": 1793876919323,
                      "schemaVersion": 1
                    },
                    {
                      "actor": "system:work-item-admission-promoter",
                      "runId": "sched-.routinesTick-2026-11-05T11:00:00.000Z-71",
                      "loserId": "EI-27711160314092144",
                      "mergedAtMs": 1793876919323,
                      "schemaVersion": 1
                    },
                    {
                      "actor": "system:work-item-admission-promoter",
                      "runId": "sched-.routinesTick-2026-11-05T16:30:00.000Z-69",
                      "loserId": "EI-27739535442778991",
                      "mergedAtMs": 1793896891074,
                      "schemaVersion": 1
                    },
                    {
                      "actor": "system:work-item-admission-promoter",
                      "runId": "sched-.routinesTick-2026-11-05T16:30:00.000Z-69",
                      "loserId": "EI-27965761004718638",
                      "mergedAtMs": 1793896891074,
                      "schemaVersion": 1
                    }
                  ],
                  "present": true
                }
              },
              "sourcePlanItemIds": null
            },
            "runId": "7ef9ca20-83bd-4551-9e42-78f0cff006a2",
            "state": "complete",
            "canonical": {
              "prior": {
                "seeAlso": [
                  "EI-27068131223984168",
                  "EI-27965672769211900"
                ],
                "takenBy": null,
                "conditionKey": null,
                "sourcePlanSlug": null,
                "watchdogIdentity": {
                  "watchdogKey": {
                    "value": "tool-failure-signature:coord:inbox:structural:message-md5-00e05f4cddcbb6bd68ede83ce3036184:field-unknown",
                    "present": true
                  },
                  "watchdogLane": {
                    "value": null,
                    "present": false
                  },
                  "watchdogSignalOrigin": {
                    "value": "organic",
                    "present": true
                  },
                  "admissionMergeSources": {
                    "value": null,
                    "present": false
                  }
                },
                "sourcePlanItemIds": null
              },
              "applied": {
                "seeAlso": [
                  "EI-23808724865930415",
                  "EI-25638398164189158",
                  "EI-25800052430438652",
                  "EI-25869063178115934",
                  "EI-26109339765764691",
                  "EI-26701717843098576",
                  "EI-26775773129679569",
                  "EI-26793174762713144",
                  "EI-26804557980917939",
                  "EI-26841368785199066",
                  "EI-26983621596216400",
                  "EI-27068131223984168",
                  "EI-27527433865945213",
                  "EI-27702611547968789",
                  "EI-27711160314092144",
                  "EI-27731923032226126",
                  "EI-27739535442778991",
                  "EI-27965672769211900",
                  "EI-27965761004718638",
                  "EI-28055056010570048"
                ],
                "conditionKey": null,
                "sourcePlanSlug": null,
                "watchdogIdentity": {
                  "watchdogKey": {
                    "value": "tool-failure-signature:coord:inbox:structural:message-md5-00e05f4cddcbb6bd68ede83ce3036184:field-unknown",
                    "present": true
                  },
                  "watchdogLane": {
                    "value": null,
                    "present": false
                  },
                  "watchdogSignalOrigin": {
                    "value": "organic",
                    "present": true
                  },
                  "admissionMergeSources": {
                    "value": [
                      {
                        "actor": "system:work-item-admission-promoter",
                        "runId": "7ef9ca20-83bd-4551-9e42-78f0cff006a2",
                        "loserId": "EI-27702611547968789",
                        "mergedAtMs": 1794003656102,
                        "schemaVersion": 1
                      }
                    ],
                    "present": true
                  }
                },
                "sourcePlanItemIds": null
              },
              "sourceEntryAdded": true
            },
            "transfers": {
              "occurrences": [
                {
                  "occurrenceId": "741249",
                  "priorCanonicalId": "EI-27702611547968789",
                  "priorCanonicalHarness": "papercusp"
                },
                {
                  "occurrenceId": "758613",
                  "priorCanonicalId": "EI-27702611547968789",
                  "priorCanonicalHarness": "papercusp"
                },
                {
                  "occurrenceId": "770451",
                  "priorCanonicalId": "EI-27702611547968789",
                  "priorCanonicalHarness": "papercusp"
                },
                {
                  "occurrenceId": "777810",
                  "priorCanonicalId": "EI-27702611547968789",
                  "priorCanonicalHarness": "papercusp"
                },
                {
                  "occurrenceId": "800925",
                  "priorCanonicalId": "EI-27702611547968789",
                  "priorCanonicalHarness": "papercusp"
                },
                {
                  "occurrenceId": "812144",
                  "priorCanonicalId": "EI-27702611547968789",
                  "priorCanonicalHarness": "papercusp"
                },
                {
                  "occurrenceId": "813043",
                  "priorCanonicalId": "EI-27702611547968789",
                  "priorCanonicalHarness": "papercusp"
                },
                {
                  "occurrenceId": "816052",
                  "priorCanonicalId": "EI-27702611547968789",
                  "priorCanonicalHarness": "papercusp"
                },
                {
                  "occurrenceId": "817614",
                  "priorCanonicalId": "EI-27702611547968789",
                  "priorCanonicalHarness": "papercusp"
                },
                {
                  "occurrenceId": "817923",
                  "priorCanonicalId": "EI-27702611547968789",
                  "priorCanonicalHarness": "papercusp"
                },
                {
                  "occurrenceId": "817925",
                  "priorCanonicalId": "EI-27702611547968789",
                  "priorCanonicalHarness": "papercusp"
                },
                {
                  "occurrenceId": "817926",
                  "priorCanonicalId": "EI-27702611547968789",
                  "priorCanonicalHarness": "papercusp"
                },
                {
                  "occurrenceId": "817927",
                  "priorCanonicalId": "EI-27702611547968789",
                  "priorCanonicalHarness": "papercusp"
                },
                {
                  "occurrenceId": "817928",
                  "priorCanonicalId": "EI-27702611547968789",
                  "priorCanonicalHarness": "papercusp"
                },
                {
                  "occurrenceId": "818203",
                  "priorCanonicalId": "EI-27702611547968789",
                  "priorCanonicalHarness": "papercusp"
                },
                {
                  "occurrenceId": "818308",
                  "priorCanonicalId": "EI-27702611547968789",
                  "priorCanonicalHarness": "papercusp"
                },
                {
                  "occurrenceId": "818309",
                  "priorCanonicalId": "EI-27702611547968789",
                  "priorCanonicalHarness": "papercusp"
                }
              ],
              "dependencyEdges": [],
              "duplicateOccurrenceId": "828647",
              "canonicalOutgoingAdded": [
                "EI-23808724865930415",
                "EI-25638398164189158",
                "EI-25800052430438652",
                "EI-25869063178115934",
                "EI-26109339765764691",
                "EI-26701717843098576",
                "EI-26775773129679569",
                "EI-26793174762713144",
                "EI-26804557980917939",
                "EI-26841368785199066",
                "EI-26983621596216400",
                "EI-27527433865945213",
                "EI-27702611547968789",
                "EI-27711160314092144",
                "EI-27731923032226126",
                "EI-27739535442778991",
                "EI-27965761004718638",
                "EI-28055056010570048"
              ],
              "incomingReferenceSources": [
                "EI-23808724865930415",
                "EI-25638398164189158",
                "EI-25800052430438652",
                "EI-25869063178115934",
                "EI-26109339765764691",
                "EI-26701717843098576",
                "EI-26775773129679569",
                "EI-26793174762713144",
                "EI-26804557980917939",
                "EI-26841368785199066",
                "EI-26983621596216400",
                "EI-27527433865945213",
                "EI-27711160314092144",
                "EI-27731923032226126",
                "EI-27739535442778991",
                "EI-27965761004718638",
                "EI-28055056010570048"
              ],
              "duplicateOccurrenceCreated": true,
              "loserCanonicalReferenceAdded": true
            },
            "mergedAtMs": 1794003656102,
            "canonicalId": "EI-27710843725808900",
            "schemaVersion": 2,
            "canonicalHarness": "papercusp",
            "judgmentIdentity": {
              "loser": "4417fbb9a9a75dfd4e91fc1e4832434424c94d895c517fd6db5825efc329da3a",
              "canonical": "14650b156e290da05bfe2d9ce2bd6d1ad83eb25df1ccd038fedd14d4f09e8252"
            },
            "reversalInstructions": {
              "order": [
                "restore-or-delete dependency after-edges from targetPrior, then reinsert each before-edge",
                "repoint transferred occurrence IDs to their prior canonical and delete the duplicate occurrence only when duplicateOccurrenceCreated=true",
                "remove canonical only from the recorded incomingReferenceSources and canonicalOutgoingAdded entries",
                "restore canonical identity, plan and reference fields only when they still equal canonical.applied",
                "restore loser lifecycle, admission, condition, plan, references and admissionReview from prior; then remove admissionMerge"
              ],
              "schemaVersion": 1,
              "transactionRequired": true,
              "compareAppliedStateBeforeRestore": true
            }
          },
          "admissionReview": {
            "alert": {
              "key": "work-item-admission-review-debt",
              "state": "cleared",
              "reason": "review completed",
              "emittedAt": "2026-11-06T17:20:56.102-05:00"
            },
            "state": "terminal",
            "enteredAt": "2026-11-02T16:55:23.533-05:00",
            "retryOwner": "system:work-item-admission-promoter",
            "reviewedAt": "2026-11-06T17:20:56.102-05:00",
            "reviewedBy": "system:work-item-admission-promoter",
            "terminalAt": "2026-11-06T17:20:56.102-05:00",
            "lastRetryAt": "2026-11-06T17:20:56.102-05:00",
            "reviewDueAt": "2026-11-02T17:55:23.533-05:00",
            "retryAttempts": 2,
            "terminalOutcome": "duplicate-merge"
          },
          "admissionFailOpen": {
            "at": "2026-11-02T16:55:23.533-05:00",
            "actor": "system:work-item-admission-fail-open",
            "runId": "sched-.routinesTick-2026-11-02T21:54:00.000Z-53",
            "scope": "workspace",
            "reason": "pending-age-exceeded-two-promoter-ticks"
          },
          "admissionIdentity": {
            "titleKey": "title:contract coord directed inbox its kept limit1 message most oldest promises recent returns while",
            "schemaVersion": "admission-identity-v1"
          },
          "freshnessEnvelope": {
            "observedAt": "2026-11-02T18:41:09.127Z",
            "linkedFixRefs": [],
            "reporterSession": "su-126cedd3-6292-4a64-9bb8-b95f804379e4",
            "observedSourceSha": "d740fc3802",
            "toolSchemaVersion": null,
            "observedRuntimeSha": "d740fc3802",
            "deployBuildIdentity": "d740fc3802@0.0.0",
            "reporterRuntimeVersion": "0.0.0",
            "lastSuccessfulReproductionAt": null
          },
          "admissionMergeSources": [
            {
              "actor": "system:work-item-admission-promoter",
              "runId": "sched-.routinesTick-2026-11-04T11:00:00.000Z-71",
              "loserId": "EI-26841368785199066",
              "mergedAtMs": 1793790573952,
              "schemaVersion": 1
            },
            {
              "actor": "system:work-item-admission-promoter",
              "runId": "sched-.routinesTick-2026-11-05T11:00:00.000Z-71",
              "loserId": "EI-26701717843098576",
              "mergedAtMs": 1793876919323,
              "schemaVersion": 1
            },
            {
              "actor": "system:work-item-admission-promoter",
              "runId": "sched-.routinesTick-2026-11-05T11:00:00.000Z-71",
              "loserId": "EI-26983621596216400",
              "mergedAtMs": 1793876919323,
              "schemaVersion": 1
            },
            {
              "actor": "system:work-item-admission-promoter",
              "runId": "sched-.routinesTick-2026-11-05T11:00:00.000Z-71",
              "loserId": "EI-27068131223984168",
              "mergedAtMs": 1793876919323,
              "schemaVersion": 1
            },
            {
              "actor": "system:work-item-admission-promoter",
              "runId": "sched-.routinesTick-2026-11-05T11:00:00.000Z-71",
              "loserId": "EI-27527433865945213",
              "mergedAtMs": 1793876919323,
              "schemaVersion": 1
            },
            {
              "actor": "system:work-item-admission-promoter",
              "runId": "sched-.routinesTick-2026-11-05T11:00:00.000Z-71",
              "loserId": "EI-27711160314092144",
              "mergedAtMs": 1793876919323,
              "schemaVersion": 1
            },
            {
              "actor": "system:work-item-admission-promoter",
              "runId": "sched-.routinesTick-2026-11-05T16:30:00.000Z-69",
              "loserId": "EI-27739535442778991",
              "mergedAtMs": 1793896891074,
              "schemaVersion": 1
            },
            {
              "actor": "system:work-item-admission-promoter",
              "runId": "sched-.routinesTick-2026-11-05T16:30:00.000Z-69",
              "loserId": "EI-27965761004718638",
              "mergedAtMs": 1793896891074,
              "schemaVersion": 1
            }
          ],
          "implementationReadiness": {
            "reason": "existing-immediate-capture-policy",
            "source": "capture-policy",
            "status": "ready",
            "updatedAt": "2026-11-02T18:41:09.127Z",
            "schemaVersion": "implementation-readiness-v1"
          }
        },
        "conditionKey": null
      },
      "target": {
        "title": "coord:inbox sender-filtered limit1 returns an older message despite newer sender messages",
        "summary": "Suspected current read-selection defect noticed during cell plan continuation. In this turn tools.mcp__papercusp_su__coord_inbox({from:'su-bd7bb60b-f269-4533-95f8-a01a37d59f27',limit:1,max_body_chars:6000}) returned coord-send-25591efa4fe617468ae17e1471cba364d40f7b0b60e07dbf1fdeb5b44952b321 at2026-11-06T06:08:53.725Z, while its own summary.newest_ts_total was2026-11-06T10:08:34.191Z with total34/returned1. The advertised contract says most-recent entries are kept. A directed reply at10:08:34 was already injected, and coord:thread on my request independently recovered coord-send-941d3fa5d22a417b07265c4628832877551e5b5616440d29ce1394e462769f77 at that newer time. The old returned row asks for now-superseded work, which can send a recovering agent backwards. Root cause not yet known; inspect sender-filter ordering/window/response shaping and add a maintained regression where a sender has several timestamps and limit1 must select the newest before rendering. Workaround is exact coord:thread/read refs, not repeated inbox polling. This is additional behavioral evidence, not a duplicate plain invocation error.",
        "status": "open",
        "duplicate_of": null,
        "payload": {
          "_ei": {
            "scope": "harness:papercusp",
            "source": "su",
            "severity": "minor",
            "created_by": "su-aacbfd3d-6159-42ab-8217-6cc8ce2076da",
            "found_during": "EI-27701106699893349",
            "signal_origin": "organic"
          },
          "paths": [
            "packages/operator-core/lib/agent-tools/coordination/tools/inbox.ts"
          ],
          "reporter": {
            "at": "2026-11-02T20:51:52.519Z",
            "id": "su-aacbfd3d-6159-42ab-8217-6cc8ce2076da",
            "kind": "agent",
            "basis": "agent-session"
          },
          "lastSeenAt": "2026-11-06T10:13:32.895Z",
          "filedByRole": "su",
          "repeatCount": 6,
          "watchdogKey": "tool-failure-signature:coord:inbox:structural:message-md5-00e05f4cddcbb6bd68ede83ce3036184:field-unknown",
          "admissionHold": {
            "actor": "system:work-item-admission-promoter",
            "runId": "7ef9ca20-83bd-4551-9e42-78f0cff006a2",
            "heldAt": "2026-11-06T17:20:56.102-05:00",
            "reason": "Both describe bounded sender-window omissions, but chunked-reply filtering or coalescing in the earlier occurrence is not linked to the later selection failure.",
            "screeningDeferred": false
          },
          "dedupCoverage": {
            "lexical": "ok",
            "degraded": true,
            "semantic": "unavailable"
          },
          "ideaLifecycle": {
            "state": "open",
            "stateUpdatedAt": "2026-11-02T20:51:59.918Z"
          },
          "reportContext": {
            "app": "papercusp",
            "screen": null,
            "refused": [],
            "truncated": [],
            "appVersion": "0.0.0+606d876460",
            "capturedAt": "2026-11-02T20:51:52.519Z",
            "logExcerpt": null,
            "screenshot": null,
            "autoCaptured": [
              "app",
              "appVersion",
              "recentErrors"
            ],
            "recentErrors": [
              {
                "at": "2026-11-02T20:51:52.519Z",
                "source": "coord:inbox",
                "message": "coord:inbox success-with-unexpected-selection: Valid sender-scoped limit1 read selected16:19 message despite newest_ts_total20:41 and a fresh directed source-gate handoff."
              }
            ],
            "schemaVersion": 1
          },
          "reporterKinds": [
            "agent"
          ],
          "dedupCandidates": [
            {
              "id": "EI-27007060386290720",
              "method": "lexical",
              "similarity": 0.64
            }
          ],
          "admissionIdentity": {
            "titleKey": "title:coord directed from inbox limit message newer older omitting reply returns while",
            "signalKey": "tool-failure-signature:coord:inbox:structural:message-md5-00e05f4cddcbb6bd68ede83ce3036184:field-unknown",
            "schemaVersion": "admission-identity-v1"
          },
          "freshnessEnvelope": {
            "observedAt": "2026-11-02T20:51:59.922Z",
            "linkedFixRefs": [],
            "reporterSession": "su-aacbfd3d-6159-42ab-8217-6cc8ce2076da",
            "observedSourceSha": "606d876460",
            "toolSchemaVersion": null,
            "observedRuntimeSha": "606d876460",
            "deployBuildIdentity": "606d876460@0.0.0",
            "reporterRuntimeVersion": "0.0.0",
            "lastSuccessfulReproductionAt": "2026-11-02T20:51:59.922Z"
          },
          "toolFailureProbation": {
            "class": "structural",
            "state": "promoted",
            "report": {
              "status": "ok",
              "message": "Advertised most-recent-kept contract disagreed with actual from-filtered limit1 selection; newer message independently recovered by coord:thread.",
              "toolName": "coord:inbox",
              "directEvidence": {
                "kind": "server-contract-mismatch",
                "actual": "Returned sender message at2026-11-06T06:08:53.725Z while summary reports newer timestamp",
                "expected": "Newest sender message at2026-11-06T10:08:34.191Z retained by limit1"
              }
            },
            "classKey": "repeated-tool-error-class:coord:inbox:structural:error-code-unknown:schema-unknown~field-unknown:runtime-unknown",
            "reporters": [
              "su-aacbfd3d-6159-42ab-8217-6cc8ce2076da",
              "su-fb65089f-6c2c-4b26-aedd-85ba438d981f",
              "su-f2d016a8-63fb-4eaf-8c29-d7c9e68500ce",
              "su-78560746-d1a0-423b-a26e-c1e9c6486454",
              "su-0cbd6655-ce61-46ec-9c3a-451f915f5b67",
              "su-d990b197-6745-4723-abd6-977d9686780c"
            ],
            "lastSeenAt": "2026-11-06T10:13:32.895Z",
            "firstSeenAt": "2026-11-06T10:13:32.110Z",
            "watchdogKey": "repeated-tool-error:coord:inbox:structural:advertised-most-recent-kept-contract-disagreed",
            "intendedKind": "bug",
            "directEvidence": true,
            "deployedRevision": "runtime-unknown",
            "messageFingerprint": "advertised-most-recent-kept-contract-disagreed",
            "contractFingerprint": "schema-unknown~field-unknown",
            "correlationFingerprint": "coord:inbox|structural|schema-unknown|field-unknown|runtime-unknown|advertised-most-recent-kept-contract-disagreed"
          },
          "admissionMergeSources": [
            {
              "actor": "system:work-item-admission-promoter",
              "runId": "7ef9ca20-83bd-4551-9e42-78f0cff006a2",
              "loserId": "EI-27702611547968789",
              "mergedAtMs": 1794003656102,
              "schemaVersion": 1
            }
          ],
          "implementationReadiness": {
            "reason": "existing-immediate-capture-policy",
            "source": "capture-policy",
            "status": "ready",
            "updatedAt": "2026-11-02T20:51:59.922Z",
            "schemaVersion": "implementation-readiness-v1"
          }
        },
        "conditionKey": null
      },
      "finalR1Disposition": "OPEN",
      "timeBoundary": "Original report retained in terminal92 raw capture, later target snapshot at 2026-11-08T15:48:45.116Z; source witnesses captured in this qualification. No inferred original-time availability or loaded runtime."
    },
    {
      "originalId": "EI-27970531880500756",
      "targetId": "WI-6554700010045521",
      "classification": "exact-original-scope-source-and-ledger-supported",
      "qualification": "Target WI45521 explicitly names original bug. Committed source derives reliability from successes+errors+refusals while parent popularity stays unchanged; committed realPG test runs success then failure, asserts1->0.5 reliability and parent runCount1. Saved row23487166 passes9 cases; same subject/test hashes in baseline23487695/copy23487721 both9passes and mutant23487723 fails2 including exact P003-RELIABILITY. This qualifies scoped source/maintained regression execution, not deployed runtime/prevalence or entire P003 certification.",
      "original": {
        "title": "Recipe promotion success score may ignore failed saved-recipe executions",
        "summary": "Source-derived suspected scoring defect noticed while explaining recipes for WI-6554700010045423 (2026-11-05). agent-tools/recipes/run.ts records every executed script in code_recipe_runs, but sets countTowardRecipe = successfulReuse && !dryRun. code-recipes-store.ts recordRecipeRun updates parent run_count/success_count only when countTowardRecipe. code-recipes-candidates.ts computes successRate from those parent counters, while capture-recipe.ts attaches only successful authored executions. Therefore actual recipes:run failures can leave the promotion reliability score unchanged instead of reducing success rate. Runtime prevalence not measured; do not interpret this filing as production incident statistics. Proposed fix: keep popularity/adoption semantics explicit, but compute the candidate reliability leg from settled non-preview execution outcomes in the run ledger (or separately maintained outcome counters with equivalent semantics). Add a maintained test: successful saved recipe followed by failed execution retains intended popularity behavior but reduces reliability; dry-runs remain excluded; schema field-miss failures count as failures. This is a follow-up, not part of the explanation deliverable.\n\nⓘ Possible STALE RUNTIME, not an open defect: `packages/operator-core/lib/agent-tools/recipes/run.ts` (32 newer commits, tip `45623b4fd66e01a2462b8ddae58cd0dc3835c2d8`), `packages/operator-core/lib/code-recipes-store.ts` (26 newer commits, tip `0ea5fda0e04936ad421d9f9a0d012b0d7014d881`), `packages/operator-core/lib/code-recipes-candidates.ts` (6 newer commits, tip `f30d051362b255d6e2b8edffd5cedee38687aac1`) have commits newer than the running build (`d740fc3802`) in `staging`. If this was observed live, verify the deployed generation before triaging; the behavior may already be fixed in the tree.",
        "status": "done",
        "duplicate_of": "WI-6554700010045521",
        "payload": {
          "_ei": {
            "scope": "harness:papercusp",
            "source": "su",
            "severity": "major",
            "created_by": "su-5c46e76e-e3d6-448c-8959-58dcdfb533f9",
            "assigned_by": "su-5c46e76e-e3d6-448c-8959-58dcdfb533f9",
            "found_during": "WI-6554700010045423",
            "signal_origin": "organic"
          },
          "paths": [
            "packages/operator-core/lib/agent-tools/recipes/run.ts",
            "packages/operator-core/lib/code-recipes-store.ts",
            "packages/operator-core/lib/code-recipes-candidates.ts"
          ],
          "filedByRole": "su",
          "_assumptions": {
            "declared": "none",
            "resolvedAt": "2026-11-07T17:13:10.796Z"
          },
          "dedupCoverage": {
            "lexical": "unavailable",
            "degraded": true,
            "semantic": "ok"
          },
          "ideaLifecycle": {
            "state": "triaged",
            "ideaType": "code-bug",
            "triagedAt": "2026-11-06T06:40:25.308Z",
            "triageReason": "code-bug, policy tier=auto (no protected path/keyword → AUTO-eligible (still gated by blueprint + tests + release-manager)) — auto-implement lane (D-003: one verdict chain)",
            "stateUpdatedAt": "2026-11-06T06:40:25.308Z",
            "triageDecision": "place"
          },
          "codeWorkingSet": {
            "epoch": 11,
            "owner": "su-5c46e76e-e3d6-448c-8959-58dcdfb533f9",
            "paths": [
              "papercusp://scratch/papercusp-workspace/plans:start/64ce7f29-0f39-4023-a7ab-4421208335b5/result-door-1793932261002-0c2d058f.spill"
            ],
            "symbols": [],
            "derivedAt": "2026-11-06T02:42:33.444Z"
          },
          "admissionIdentity": {
            "titleKey": "title:executions failed ignore may promotion recipe saved score success",
            "schemaVersion": "admission-identity-v1"
          },
          "freshnessEnvelope": {
            "observedAt": "2026-11-05T17:39:37.847Z",
            "linkedFixRefs": [],
            "reporterSession": "su-5c46e76e-e3d6-448c-8959-58dcdfb533f9",
            "observedSourceSha": "d740fc3802",
            "toolSchemaVersion": null,
            "observedRuntimeSha": "d740fc3802",
            "deployBuildIdentity": "d740fc3802@0.0.0",
            "reporterRuntimeVersion": "0.0.0",
            "lastSuccessfulReproductionAt": null
          },
          "_completionEvidence": {
            "summary": "Resolved as a duplicate of WI-6554700010045521: completed P-003 implemented reliability from eligible settled replay outcomes and added the exact success-then-failure regression.",
            "coverage": {
              "checked": [
                "Reported success-score defect in EI-27970531880500756",
                "Canonical P-003 fix and its regression evidence in WI-6554700010045521",
                "Post-completion staging changes to the scorer and maintained regression file",
                "Duplicate relationship to WI-6554700010045521"
              ],
              "residue": [],
              "notChecked": [],
              "population": [
                "Reported success-score defect in EI-27970531880500756",
                "Canonical P-003 fix and its regression evidence in WI-6554700010045521",
                "Post-completion staging changes to the scorer and maintained regression file",
                "Duplicate relationship to WI-6554700010045521"
              ],
              "notApplicable": []
            },
            "testsRun": "No tests run for this duplicate disposition. Canonical P-003 recorded: npm run test:file -- packages/operator-core/lib/code-recipes-candidates.integration.test.ts packages/operator-core/lib/code-recipes-candidates.test.ts packages/operator-core/lib/code-run-adoption.test.ts packages/operator-core/lib/code-intelligence/reuse-measurement.integration.test.ts packages/operator-core/lib/sql-tool-candidate-feedback.integration.test.ts packages/operator-core/lib/sql-tool-candidate-review.integration.test.ts packages/operator-core/lib/sql-tool-candidate-score.test.ts",
            "treeStamp": {
              "headSha": "41d07da0fc393d2824029e72f91f2b45b7d469df",
              "repositoryRoot": "/home/marsh-office/papercupai-workspace/papercusp"
            },
            "testResult": "Canonical P-003 completion records PASS. Its success-then-failure regression kept runCount=1 while reliability became 0.5; the denominator mutant was caught. This turn did not rerun tests.",
            "verifiedHow": "Read the live EI and P-003 records, confirmed P-003 explicitly diagnoses EI-27970531880500756, compared the post-completion staging diff from 90aa400 to f1b4f83, and recorded the duplicate link. Later scorer changes are source-authority filtering/substance handling; the maintained regression file has no post-completion diff.",
            "workOutcome": "duplicate",
            "rootCauseVerification": {
              "hypothesis": "This report is the same defect P-003 fixed: reliability must include eligible settled saved-recipe replay outcomes, so a failed replay lowers reliability while successful-use popularity remains separate.",
              "testResult": "The canonical P-003 completion records the distinguishing case passing with runCount=1 and reliability=0.5; baseline/copy passed and denominator mutant 23487723 was caught. No fresh test run here.",
              "evidenceRefs": [
                "work-item:WI-6554700010045521#completion",
                "work-item:EI-27970531880500756#summary",
                "git:90aa400fca186de57b85f286ea8b13e1a9e5e5bd..f1b4f8375b2048e7167eea3a85be6a8868a06716",
                "packages/operator-core/lib/code-recipes-candidates.ts",
                "packages/operator-core/lib/code-recipes-candidates.integration.test.ts"
              ],
              "testProcedure": "Use the recorded P-003 maintained suite command and inspect its completion evidence; compare current staging code-recipes-candidates.ts against the P-003 tree at 90aa400 and confirm code-recipes-candidates.integration.test.ts has no post-completion diff.",
              "contractVersion": 2,
              "actualObservation": "WI-6554700010045521 is done and its summary explicitly says it diagnoses EI-27970531880500756. Its completion records the success-then-failure result (runCount=1, reliability=0.5) and a caught denominator mutant. The post-completion diff shows only private-source authorization/substance changes in the scoring file, and the maintained regression file is unchanged.",
              "distinguishingTest": "In the maintained success-then-failure case, perform one successful eligible saved-recipe replay followed by one failed eligible replay; assert runCount remains 1, reliability becomes 0.5, and the denominator mutant fails.",
              "alternativeHypothesis": "P-003 addressed adjacent instrumentation only, leaving the current scoring path based on successful parent counters and this report still requires a source fix.",
              "predictedObservations": {
                "hypothesis": "P-003 names this EI, the recorded regression passes with runCount=1 and reliability=0.5, and later scoring-file changes do not alter that reliability calculation.",
                "alternativeHypothesis": "P-003 has no matching regression, or current staging still computes reliability from successful parent counters without failed settled replays."
              }
            },
            "checkpointProseSnapshot": "## Did\nAvi now explicitly authorizes AUTO/self implementation to shipped status under unified-recipe-sql-shell-tool-learning-2026-11-05 D-007; driving WI-6554700010045461. Read current recipe writer: recipes/run.ts records failed/preview trace rows with countTowardRecipe=false, while code-recipes-candidates.ts still calculates successRate from parent success_count/run_count. This source discrepancy supports original distinguishing-test hypothesis. No repair yet.\n\n## Left\nP003 must distinguish explicit replay/automatic matching and eligible settled outcomes from popularity and previews. Source current trace schema1 lacks top-level explicit selection/preview provenance; do not pretend reused boolean distinguishes these. Read recordRecipeRun/capture call sites before adding contract fields and backfill rules. Historical record unknowns must remain unknown. No production prevalence conclusion made from raw reused counts.\n\n## Next action\nComplete plan activation/spec review, then P001/P002 before P003; implement success-then-failure maintained regression and outcome-sourced score without changing parent popularity semantics. Baseline current tests passed in recovery851ee352-6839-423e-8490-8835f5d5b6c6; no feature tests claimed.\n\n2026-11-06T04:41Z continuation delta: SAMEowner5c46 verified; Avi2640 AUTO/self remains. Root cause reproduced in maintained real-PG P003-RELIABILITY: settled failure left successRate1 instead of.5, log /tmp/su5c46-p003-red2.log (5PASS1expectedFAIL). First attempt /tmp/su5c46-p003-red.log had fixture potSlug undefined, corrected before causal reproduction; no product claim from that run. Implemented existing code_recipe_runs execution_trace.usage extension (version1, selection authored/automatic-match/saved-replay, choice agent/hook/system/unknown, commit/preview, outcome, settled). No new table/migration/service. Three writers now label current receipts; legacy reused boolean stays unknown. Candidate query keeps parent popularity fields, computes reliability from eligible settled committing agent replay outcomes and demand/breadth from agent receipts; unknown cohort cannot promote. Choice comes from canonical identity source; event reactions/system/hook excluded. Source8files diff197+24 at lastcheck, no manualgit, all locks RELEASED. Maintained GREEN behavior: candidatesintegration7PASS incl reliability, preview/machine/legacy negative controls; storeintegration27PASS; kernel9PASS; storeunit4/candidateunit6/capture16/recipes41PASS; code-run unit111PASS15FAIL on stale documentation-string assertions, filed+ASSIGNEDself EI-28011920619272987 (full log /tmp/su5c46-p003-green.log; compatibilitylog /tmp/su5c46-p003-store-kernel.log). This is a specific independently owned follow-up, not hidden green. Scoped typecheck /tmp/su5c46-p003-typecheck.log: four crosslegs CLEAN; operatorcore service declined scope-too-wide and full compile queued/running under native89525 (fresh THIScontinuation; drain beforecut). No close yet. P003 larger contracts R2/R9/R10/R13 remain incomplete (preexecution refusals, raw costs/coverage/report integration); this repair alone is not P003done. P001/P002 audits re-dispatched current3170, repair receipt /tmp/su5c46-p001p002-audit-repair.json launches judges51f41099/115a4b91 after inferencegateway terminalrecovery; exactcards unchanged, no reemit. Need settleaudits/currentproof before canonicalP001/P002close; actualP002 source store.ts changed by this legitimate downstreamextension, so remeasurecurrentness rather than pretending original P002proof current. NoLIVE_GATE_OPS/BGrestart/newloop/activationredo.\n\n---\n04:45Z final verification delta: typecheck /tmp/su5c46-p003-typecheck.log exit0, changed8filesclean+4crosslegsclean; all nativehandlesdrained and filelocksreleased. Audits/P001/P002 nowterminalDONE. False premise RETRACTED: currentP002gate accepted existingproof afterthisstoreextension; solecompletionrefusal was testsRun lacking literaltestfilenames, corrected. New source8files stilldirtylastread, no manualgit. Current behavioral proof remains 7PGcandidates+27PGstore+9kernel+store4/candidates6/capture16/recipes41 PASS; code-run111PASS15staledocsFAIL, ownedEI28011920619272987 correctionpost1215294. Larger P003contracts incomplete. No close attempted onthisbug yet; rootverification can cite distinguishing realPG failurebefore and sevenpassingcasesafter. Do not rerun solely for recovery.\n\n2026-11-06T05:24Z P003 now canonical WI5521 owns continued implementation. See its complete checkpoint: refusal/partial/inflight recurrence controls red7then44PASS; runEvidence identity/cost extension plus exact-copy/conflict handling candidate logic and realPG controls passed fivefiles102tests, with provenanceUNKNOWN from movingHEAD. Original success-then-failure distinguishing proof remains preserved in this item. New source8files typecheck initial2testmockerrors fixed by typing mock; final typecheck2 running. No bug close until remaining canonical acceptance/current-build proof is concrete; no manualgit or livegateops.\n\n---\n⟦work-item-flight-record v1 begin⟧\ncaptured_at: 2026-11-06T12:39:18.233Z\ncause: forced-interrupt\nowner: su-5c46e76e-e3d6-448c-8959-58dcdfb533f9\nintent: Approved AUTO/self: repair committed-test preparation for WI-6554700010045521/P-003 and WI-6554700010045522/P-004, verify remaining tests and mutation evidence, then independent acceptance.\nintent_scope: session-lane — this record was stamped identically onto 17 items, so the intent line above is NOT a reading of this item\nalso_stamped_on: [\"WI-6554700010045522\",\"WI-6554700010045521\",\"EI-28031329526300579\",\"EI-28025870575627227\",\"EI-28023584486837056\",\"EI-28020114439007061\",\"EI-28017540433747385\",\"EI-27986148642202900\",\"EI-27975424843352122\",\"EI-27964921641114337\",\"EI-27961618619692116\",\"EI-28034713958785358\",\"EI-28036419143343012\",\"EI-28037983022111342\",\"WI-6554700010045461\",\"WI-6554700010045877\"]\nauthored_prose_above: PRESENT and PREDATES this capture — it was written before captured_at, not at it; date any absence claim in it against the file history before trusting it\ncurrent_files: [\"packages/operator-core/lib/agent-tools/plans/pg-tool-fixture.integration.test.ts\",\"packages/operator-core/lib/agent-tools/plans/__tests__/_pg-tool-fixture.ts\"]\ntools_newest_first (max 12):\n- at=2026-11-06 07:22:45.779-05 tool=activity:report status=ok duration_ms=461 error_code=none args_keys=[\"adv_session_id\",\"agent\",\"cwd\",\"kind\",\"owner\",\"session_id\",\"summary\"] args_key_digest=2abd6dd1f1ac\n- at=2026-11-06 07:16:02.596-05 tool=tools:invoke status=ok duration_ms=1697 error_code=none args_keys=[\"args\",\"name\"] args_key_digest=5108f8b1503a\n- at=2026-11-06 07:16:02.595-05 tool=session:request-compaction status=ok duration_ms=1693 error_code=none args_keys=[\"continueNote\",\"focus\"] args_key_digest=5d77413c5174\n- at=2026-11-06 07:16:00.461-05 tool=activity:report status=ok duration_ms=138 error_code=none args_keys=[\"agent\",\"cwd\",\"hook_bundle\",\"owner\",\"phase\",\"session_id\",\"status\",\"tool_input\",\"tool_name\",\"tool_use_id\"] args_key_digest=06baf047b35c\n- at=2026-11-06 07:16:00.126-05 tool=tools:invoke status=ok duration_ms=5311 error_code=none args_keys=[\"args\",\"name\"] args_key_digest=5108f8b1503a\n- at=2026-11-06 07:16:00.121-05 tool=loop:checkpoint status=ok duration_ms=5302 error_code=none args_keys=[\"checks\",\"did\",\"left\",\"next\"] args_key_digest=512c0fce8b7c\n- at=2026-11-06 07:15:29.583-05 tool=activity:report status=ok duration_ms=231 error_code=none args_keys=[\"agent\",\"cwd\",\"hook_bundle\",\"owner\",\"phase\",\"session_id\",\"status\",\"tool_input\",\"tool_name\",\"tool_use_id\"] args_key_digest=06baf047b35c\n- at=2026-11-06 07:15:29.119-05 tool=work_items:checkpoint status=ok duration_ms=3545 error_code=none args_keys=[\"items\"] args_key_digest=5f3c4f8580d3\n- at=2026-11-06 07:13:26.341-05 tool=tools:invoke status=ok duration_ms=8304 error_code=none args_keys=[\"args\",\"name\"] args_key_digest=5108f8b1503a\n- at=2026-11-06 07:13:26.34-05 tool=work_items:get status=ok duration_ms=8268 error_code=none args_keys=[\"checksOnly\",\"ids\"] args_key_digest=eca86d160fd6\n- at=2026-11-06 07:13:01.973-05 tool=activity:report status=ok duration_ms=356 error_code=none args_keys=[\"agent\",\"cwd\",\"hook_bundle\",\"owner\",\"phase\",\"session_id\",\"status\",\"tool_input\",\"tool_name\",\"tool_use_id\"] args_key_digest=06baf047b35c\n- at=2026-11-06 07:12:57.581-05 tool=tools:invoke status=ok duration_ms=45 error_code=none args_keys=[\"args\",\"name\"] args_key_digest=5108f8b1503a\n⟦work-item-flight-record v1 end⟧\n\n---\n⟦work-item-flight-record v1 begin⟧\ncaptured_at: 2026-11-07T10:12:56.900Z\ncause: forced-interrupt\nowner: su-5c46e76e-e3d6-448c-8959-58dcdfb533f9\nintent: Avi2640 AUTO/self: WI5525/P007 exact evidence qualification; investigate current execution authority discrepancy before edits\nintent_scope: session-lane — this record was stamped identically onto 23 items, so the intent line above is NOT a reading of this item\nalso_stamped_on: [\"WI-6554700010045524\",\"WI-6554700010045525\",\"WI-6554700010045523\",\"EI-28080747013369940\",\"EI-28071356694425817\",\"EI-28067024697279360\",\"EI-28037983022111342\",\"EI-28036419143343012\",\"EI-28034713958785358\",\"EI-28031329526300579\",\"EI-28025870575627227\",\"EI-28023584486837056\",\"EI-28020114439007061\",\"EI-28017540433747385\",\"EI-27986148642202900\",\"EI-27975424843352122\",\"EI-27964921641114337\",\"EI-27961618619692116\",\"WI-6554700010045982\",\"WI-6554700010045461\"]\nauthored_prose_above: PRESENT and PREDATES this capture — it was written before captured_at, not at it; date any absence claim in it against the file history before trusting it\ncurrent_files: [\"packages/operator-core/lib/agent-tools/recipes/source-discovery.integration.test.ts\"]\ntools_newest_first (max 12):\n- at=2026-11-07 04:50:48.27-05 tool=activity:report status=ok duration_ms=98 error_code=none args_keys=[\"agent\",\"cwd\",\"hook_bundle\",\"owner\",\"phase\",\"session_id\",\"tool_input\",\"tool_name\",\"tool_use_id\"] args_key_digest=f09395e98a7c\n- at=2026-11-07 04:50:47.85-05 tool=locks:check_command status=ok duration_ms=57 error_code=none args_keys=[\"command\",\"cwd\"] args_key_digest=2f9e475ac463\n- at=2026-11-07 04:50:37.894-05 tool=locks:check_command status=ok duration_ms=28 error_code=none args_keys=[\"command\",\"cwd\"] args_key_digest=2f9e475ac463\n- at=2026-11-07 04:50:30.896-05 tool=activity:report status=ok duration_ms=88 error_code=none args_keys=[\"agent\",\"cwd\",\"hook_bundle\",\"owner\",\"phase\",\"session_id\",\"tool_input\",\"tool_name\",\"tool_use_id\"] args_key_digest=f09395e98a7c\n- at=2026-11-07 04:50:30.721-05 tool=activity:report status=ok duration_ms=12 error_code=none args_keys=[\"agent\",\"cwd\",\"hook_bundle\",\"owner\",\"phase\",\"session_id\",\"tool_input\",\"tool_name\",\"tool_use_id\"] args_key_digest=f09395e98a7c\n- at=2026-11-07 04:50:30.084-05 tool=locks:check_command status=ok duration_ms=34 error_code=none args_keys=[\"command\",\"cwd\"] args_key_digest=2f9e475ac463\n- at=2026-11-07 04:50:30.084-05 tool=locks:check_command status=ok duration_ms=31 error_code=none args_keys=[\"command\",\"cwd\"] args_key_digest=2f9e475ac463\n- at=2026-11-07 04:50:19.96-05 tool=activity:report status=ok duration_ms=135 error_code=none args_keys=[\"agent\",\"cwd\",\"hook_bundle\",\"owner\",\"phase\",\"session_id\",\"tool_input\",\"tool_name\",\"tool_use_id\"] args_key_digest=f09395e98a7c\n- at=2026-11-07 04:50:19.272-05 tool=locks:check_command status=ok duration_ms=32 error_code=none args_keys=[\"command\",\"cwd\"] args_key_digest=2f9e475ac463\n- at=2026-11-07 04:49:18.047-05 tool=work_items:get status=ok duration_ms=651 error_code=none args_keys=[\"harness\",\"id\"] args_key_digest=7d32df47e837\n- at=2026-11-07 04:49:14.467-05 tool=activity:report status=ok duration_ms=112 error_code=none args_keys=[\"agent\",\"cwd\",\"hook_bundle\",\"owner\",\"phase\",\"session_id\",\"tool_input\",\"tool_name\",\"tool_use_id\"] args_key_digest=f09395e98a7c\n- at=2026-11-07 04:49:14.465-05 tool=activity:report status=ok duration_ms=170 error_code=none args_keys=[\"agent\",\"cwd\",\"hook_bundle\",\"owner\",\"phase\",\"session_id\",\"tool_input\",\"tool_name\",\"tool_use_id\"] args_key_digest=f09395e98a7c\n⟦work-item-flight-record v1 end⟧\n\n---\n⟦work-item-flight-record v1 begin⟧\ncaptured_at: 2026-11-07T14:27:39.949Z\ncause: lease-release\nowner: su-5c46e76e-e3d6-448c-8959-58dcdfb533f9\nintent: Avi2640 AUTO/self: WI5525/P007 exact evidence qualification; investigate current execution authority discrepancy before edits\nintent_scope: session-lane — this record was stamped identically onto 23 items, so the intent line above is NOT a reading of this item\nalso_stamped_on: [\"WI-6554700010045524\",\"WI-6554700010045525\",\"WI-6554700010045523\",\"EI-28080747013369940\",\"EI-28071356694425817\",\"EI-28067024697279360\",\"EI-28037983022111342\",\"EI-28036419143343012\",\"EI-28034713958785358\",\"EI-28031329526300579\",\"EI-28025870575627227\",\"EI-28023584486837056\",\"EI-28020114439007061\",\"EI-28017540433747385\",\"EI-27986148642202900\",\"EI-27975424843352122\",\"EI-27964921641114337\",\"EI-27961618619692116\",\"WI-6554700010045982\",\"WI-6554700010045461\"]\nauthored_prose_above: PRESENT and PREDATES this capture — it was written before captured_at, not at it; date any absence claim in it against the file history before trusting it\ncurrent_files: [\"packages/operator-core/lib/agent-tools/recipes/source-discovery.integration.test.ts\"]\ntools_newest_first (max 12):\n- at=2026-11-07 04:50:48.27-05 tool=activity:report status=ok duration_ms=98 error_code=none args_keys=[\"agent\",\"cwd\",\"hook_bundle\",\"owner\",\"phase\",\"session_id\",\"tool_input\",\"tool_name\",\"tool_use_id\"] args_key_digest=f09395e98a7c\n- at=2026-11-07 04:50:47.85-05 tool=locks:check_command status=ok duration_ms=57 error_code=none args_keys=[\"command\",\"cwd\"] args_key_digest=2f9e475ac463\n- at=2026-11-07 04:50:37.894-05 tool=locks:check_command status=ok duration_ms=28 error_code=none args_keys=[\"command\",\"cwd\"] args_key_digest=2f9e475ac463\n- at=2026-11-07 04:50:30.896-05 tool=activity:report status=ok duration_ms=88 error_code=none args_keys=[\"agent\",\"cwd\",\"hook_bundle\",\"owner\",\"phase\",\"session_id\",\"tool_input\",\"tool_name\",\"tool_use_id\"] args_key_digest=f09395e98a7c\n- at=2026-11-07 04:50:30.721-05 tool=activity:report status=ok duration_ms=12 error_code=none args_keys=[\"agent\",\"cwd\",\"hook_bundle\",\"owner\",\"phase\",\"session_id\",\"tool_input\",\"tool_name\",\"tool_use_id\"] args_key_digest=f09395e98a7c\n- at=2026-11-07 04:50:30.084-05 tool=locks:check_command status=ok duration_ms=34 error_code=none args_keys=[\"command\",\"cwd\"] args_key_digest=2f9e475ac463\n- at=2026-11-07 04:50:30.084-05 tool=locks:check_command status=ok duration_ms=31 error_code=none args_keys=[\"command\",\"cwd\"] args_key_digest=2f9e475ac463\n- at=2026-11-07 04:50:19.96-05 tool=activity:report status=ok duration_ms=135 error_code=none args_keys=[\"agent\",\"cwd\",\"hook_bundle\",\"owner\",\"phase\",\"session_id\",\"tool_input\",\"tool_name\",\"tool_use_id\"] args_key_digest=f09395e98a7c\n- at=2026-11-07 04:50:19.272-05 tool=locks:check_command status=ok duration_ms=32 error_code=none args_keys=[\"command\",\"cwd\"] args_key_digest=2f9e475ac463\n- at=2026-11-07 04:49:18.047-05 tool=work_items:get status=ok duration_ms=651 error_code=none args_keys=[\"harness\",\"id\"] args_key_digest=7d32df47e837\n- at=2026-11-07 04:49:14.467-05 tool=activity:report status=ok duration_ms=112 error_code=none args_keys=[\"agent\",\"cwd\",\"hook_bundle\",\"owner\",\"phase\",\"session_id\",\"tool_input\",\"tool_name\",\"tool_use_id\"] args_key_digest=f09395e98a7c\n- at=2026-11-07 04:49:14.465-05 tool=activity:report status=ok duration_ms=170 error_code=none args_keys=[\"agent\",\"cwd\",\"hook_bundle\",\"owner\",\"phase\",\"session_id\",\"tool_input\",\"tool_name\",\"tool_use_id\"] args_key_digest=f09395e98a7c\n⟦work-item-flight-record v1 end⟧\n\n---\n⟦auto-checkpoint mechanical @2026-11-07T08:12:12.401Z⟧ system respawn snapshot. Holder-session activity, not a completion verdict.\nsession: su-5c46e76e-e3d6-448c-8959-58dcdfb533f9\nholder: su-5c46e76e-e3d6-448c-8959-58dcdfb533f9\nwork-item: EI-27970531880500756; harness: papercusp"
          },
          "_claimSubjectBaseline": {
            "body": "Source-derived suspected scoring defect noticed while explaining recipes for WI-6554700010045423 (2026-11-05). agent-tools/recipes/run.ts records every executed script in code_recipe_runs, but sets countTowardRecipe = successfulReuse && !dryRun. code-recipes-store.ts recordRecipeRun updates parent run_count/success_count only when countTowardRecipe. code-recipes-candidates.ts computes successRate from those parent counters, while capture-recipe.ts attaches only successful authored executions. Therefore actual recipes:run failures can leave the promotion reliability score unchanged instead of reducing success rate. Runtime prevalence not measured; do not interpret this filing as production incident statistics. Proposed fix: keep popularity/adoption semantics explicit, but compute the candidate reliability leg from settled non-preview execution outcomes in the run ledger (or separately maintained outcome counters with equivalent semantics). Add a maintained test: successful saved recipe followed by failed execution retains intended popularity behavior but reduces reliability; dry-runs remain excluded; schema field-miss failures count as failures. This is a follow-up, not part of the explanation deliverable.\n\nⓘ Possible STALE RUNTIME, not an open defect: `packages/operator-core/lib/agent-tools/recipes/run.ts` (32 newer commits, tip `45623b4fd66e01a2462b8ddae58cd0dc3835c2d8`), `packages/operator-core/lib/code-recipes-store.ts` (26 newer commits, tip `0ea5fda0e04936ad421d9f9a0d012b0d7014d881`), `packages/operator-core/lib/code-recipes-candidates.ts` (6 newer commits, tip `f30d051362b255d6e2b8edffd5cedee38687aac1`) have commits newer than the running build (`d740fc3802`) in `staging`. If this was observed live, verify the deployed generation before triaging; the behavior may already be fixed in the tree.",
            "kind": "bug",
            "title": "Recipe promotion success score may ignore failed saved-recipe executions",
            "summary": "Source-derived suspected scoring defect noticed while explaining recipes for WI-6554700010045423 (2026-11-05). agent-tools/recipes/run.ts records every executed script in code_recipe_runs, but sets countTowardRecipe = successfulReuse && !dryRun. code-recipes-store.ts recordRecipeRun updates parent run_count/success_count only when countTowardRecipe. code-recipes-candidates.ts computes successRate from those parent counters, while capture-recipe.ts attaches only successful authored executions. Therefore actual recipes:run failures can leave the promotion reliability score unchanged instead of reducing success rate. Runtime prevalence not measured; do not interpret this filing as production incident statistics. Proposed fix: keep popularity/adoption semantics explicit, but compute the candidate reliability leg from settled non-preview execution outcomes in the run ledger (or separately maintained outcome counters with equivalent semantics). Add a maintained test: successful saved recipe followed by failed execution retains intended popularity behavior but reduces reliability; dry-runs remain excluded; schema field-miss failures count as failures. This is a follow-up, not part of the explanation deliverable.\n\nⓘ Possible STALE RUNTIME, not an open defect: `packages/operator-core/lib/agent-tools/recipes/run.ts` (32 newer commits, tip `45623b4fd66e01a2462b8ddae58cd0dc3835c2d8`), `packages/operator-core/lib/code-recipes-store.ts` (26 newer commits, tip `0ea5fda0e04936ad421d9f9a0d012b0d7014d881`), `packages/operator-core/lib/code-recipes-candidates.ts` (6 newer commits, tip `f30d051362b255d6e2b8edffd5cedee38687aac1`) have commits newer than the running build (`d740fc3802`) in `staging`. If this was observed live, verify the deployed generation before triaging; the behavior may already be fixed in the tree.",
            "watchdogKey": null
          },
          "claim_history_post_id": 9001788375295,
          "implementationReadiness": {
            "reason": "existing-immediate-capture-policy",
            "source": "capture-policy",
            "status": "ready",
            "updatedAt": "2026-11-05T17:39:16.833Z",
            "schemaVersion": "implementation-readiness-v1"
          }
        },
        "conditionKey": null
      },
      "target": {
        "title": "Repair and instrument truthful outcome/reuse evidence: distinguish authored creation, capture-time automatic match, explicit saved-recipe selection/replay, attempts, dry-runs, polls, refusal, settled error and unknown. Retain parent popularity semantics explicitly while deriving reliability from com",
        "summary": "Repair and instrument truthful outcome/reuse evidence: distinguish authored creation, capture-time automatic match, explicit saved-recipe selection/replay, attempts, dry-runs, polls, refusal, settled error and unknown. Retain parent popularity semantics explicitly while deriving reliability from complete eligible settled outcomes; diagnose EI-27970531880500756 with a distinguishing success-then-failure regression. Exclude hook/system work from agent demand and label raw measured units. Tests ship with the counter/writer changes.                  — note: → WI-6554700010045521",
        "status": "done",
        "duplicate_of": null,
        "payload": {
          "paths": [
            "packages/operator-core/lib/code-recipes-candidates.ts"
          ],
          "anchors": [
            {
              "id": "619",
              "line": null,
              "path": "packages/operator-core/lib/code-recipes-candidates.ts",
              "tests": [],
              "change": {
                "action": "modify",
                "reason": "Initial source scope for the existing approved item; extend canonical lifecycle and maintained tests.",
                "summary": "Derive reliability from durable outcomes and distinguish explicit reuse"
              },
              "symbolId": null,
              "consumers": [],
              "freshness": "fresh",
              "requested": "packages/operator-core/lib/code-recipes-candidates.ts",
              "signature": null,
              "anchorKind": "path",
              "resolution": "resolved",
              "symbolName": null,
              "contentHash": "417fb2beeac93e5ffc87cdf7801ebedaf309557c2e2d17d9a9b3032a5ad66939",
              "staleNoticeId": null,
              "unknownReason": null,
              "consumersTotal": 0,
              "resolvedCommit": null
            }
          ],
          "_assumptions": {
            "declared": "none",
            "resolvedAt": "2026-11-06T16:21:54.407Z"
          },
          "_specAmendments": {
            "b5b2b0989e0815dffb02403c06b07e40d7c19071bf8b649bbc0d8062bf9db447": {
              "specId": "AUTO-BAR-R-13-P-003",
              "actorId": "su-5c46e76e-e3d6-448c-8959-58dcdfb533f9",
              "planSlug": "unified-recipe-sql-shell-tool-learning-2026-11-05",
              "planItemId": "P-003",
              "harnessSlug": "papercusp",
              "newRevision": 4,
              "oldRevision": 3,
              "workspaceId": "papercusp-workspace",
              "priorPlanItemId": "P-003"
            }
          },
          "externalBlockers": [
            {
              "ref": "plan-lane:unified-recipe-sql-shell-tool-learning-2026-11-05#P-003",
              "kind": "gate",
              "status": "cleared",
              "summary": "plan lane unified-recipe-sql-shell-tool-learning-2026-11-05#P-003 is blocked — linked work-item parked until the lane clears (system:plan-item-lane-sync)",
              "nextVerb": "Await the declared event/gate or repair the stalled dependency; do not poll blindly.",
              "clearedAt": "2026-11-06T04:52:58.657Z",
              "clearedBy": "system:plan-item-lane-sync",
              "createdAt": "2026-11-05T21:04:15.275Z",
              "createdBy": "system:plan-item-lane-sync",
              "recheckAt": "2026-11-05T22:04:15.275Z",
              "updatedAt": "2026-11-06T04:52:58.657Z",
              "capability": "live-dependency",
              "capabilitySource": "explicit"
            }
          ],
          "claim_hold_recheck": {
            "source": "system:contractless-park-recheck",
            "parkedAt": "2026-11-05T19:40:35.152Z",
            "parkedBy": "migration:plan-line-work-item-nodes",
            "recheckAt": "2026-11-06T19:40:35.152Z"
          },
          "planLaneParkedFrom": null,
          "_completionEvidence": {
            "summary": "Derive recipe reliability from complete eligible settled replay receipts while preserving successful-use popularity. Distinguish authored, automatic matching, explicit saved replay, preview, polls, refusal, error and unknown; exclude hook/system choices from agent demand and keep raw units explicit. Existing rubric ledger checks produce SQL/reuse evidence. P003 implementation and current-build proof complete; final shipment remains P018.",
            "coverage": {
              "checked": [
                "SPEC-P-003@1",
                "AUTO-BAR-R-2-P-003@3",
                "AUTO-BAR-R-9-P-003@3",
                "AUTO-BAR-R-10-P-003@3",
                "AUTO-BAR-R-13-P-003@4"
              ],
              "residue": [],
              "notChecked": [],
              "population": [
                "SPEC-P-003@1",
                "AUTO-BAR-R-2-P-003@3",
                "AUTO-BAR-R-9-P-003@3",
                "AUTO-BAR-R-10-P-003@3",
                "AUTO-BAR-R-13-P-003@4"
              ],
              "notApplicable": []
            },
            "testsRun": "npm run test:file -- packages/operator-core/lib/code-recipes-candidates.integration.test.ts packages/operator-core/lib/code-recipes-candidates.test.ts packages/operator-core/lib/code-run-adoption.test.ts packages/operator-core/lib/code-intelligence/reuse-measurement.integration.test.ts packages/operator-core/lib/sql-tool-candidate-feedback.integration.test.ts packages/operator-core/lib/sql-tool-candidate-review.integration.test.ts packages/operator-core/lib/sql-tool-candidate-score.test.ts; P003 code:run live preview on :3170",
            "treeStamp": {
              "headSha": "90aa400fca186de57b85f286ea8b13e1a9e5e5bd",
              "repositoryRoot": "/home/marsh-office/papercupai-workspace/papercusp",
              "contentIdentity": [
                {
                  "path": "packages/operator-core/lib/code-recipes-candidates.ts",
                  "headBlobSha": "bb6a998e30cfcae8ce69f62f591f6d0761eddf8f",
                  "workingTreeBlobSha": "bb6a998e30cfcae8ce69f62f591f6d0761eddf8f"
                },
                {
                  "path": "packages/operator-core/lib/code-recipes-candidates.integration.test.ts",
                  "headBlobSha": "ce666ee13af907a37095b178ef71f425c564bee2",
                  "workingTreeBlobSha": "ce666ee13af907a37095b178ef71f425c564bee2"
                },
                {
                  "path": "packages/operator-core/lib/code-recipes-candidates.test.ts",
                  "headBlobSha": "83e56c2ac5fab86928d277751bb7b25e364f0ea3",
                  "workingTreeBlobSha": "83e56c2ac5fab86928d277751bb7b25e364f0ea3"
                },
                {
                  "path": "packages/operator-core/lib/code-recipes-store.ts",
                  "headBlobSha": "897b51b12a86f732b81f2e39b1acfbcd2e183bf6",
                  "workingTreeBlobSha": "897b51b12a86f732b81f2e39b1acfbcd2e183bf6"
                },
                {
                  "path": "packages/operator-core/lib/agent-tools/code/run.ts",
                  "headBlobSha": "cb2657772b1cf6f99e07f5539336b5f86e373369",
                  "workingTreeBlobSha": "cb2657772b1cf6f99e07f5539336b5f86e373369"
                },
                {
                  "path": "packages/operator-core/lib/code-run-adoption.ts",
                  "headBlobSha": "bd746180fac7bcc57520905da8e021d9708cc0b4",
                  "workingTreeBlobSha": "bd746180fac7bcc57520905da8e021d9708cc0b4"
                },
                {
                  "path": "packages/operator-core/lib/code-run-adoption.test.ts",
                  "headBlobSha": "d282ea1d74fba22d76725e018c734c75ab870222",
                  "workingTreeBlobSha": "d282ea1d74fba22d76725e018c734c75ab870222"
                },
                {
                  "path": "packages/operator-core/lib/code-intelligence/reuse-measurement.integration.test.ts",
                  "headBlobSha": "d29f2468ccc2f7ec4f7606484e499cdcb2452bd1",
                  "workingTreeBlobSha": "d29f2468ccc2f7ec4f7606484e499cdcb2452bd1"
                },
                {
                  "path": "packages/operator-core/lib/sql-tool-candidate-feedback.integration.test.ts",
                  "headBlobSha": "fbe3262f060e2e722fb2651c7099f1f461c97fef",
                  "workingTreeBlobSha": "fbe3262f060e2e722fb2651c7099f1f461c97fef"
                },
                {
                  "path": "packages/operator-core/lib/sql-tool-candidate-review.integration.test.ts",
                  "headBlobSha": "2d6d5fe950dd9d7b44eee08035fa55a5a80c26a3",
                  "workingTreeBlobSha": "2d6d5fe950dd9d7b44eee08035fa55a5a80c26a3"
                }
              ]
            },
            "addedTests": true,
            "testResult": "PASS: prior clean maintained16-file baseline283 cases/zero skips; current recipe9 cases ledger23487166 and clean b8 SQLfeedback17/review12/reuse31 ledger23490325/326/327. Success-then-failure regression keeps runCount=1 and reliability=0.5; baseline23487695/copy23487721 pass and denominator mutant23487723 caught. Current canonical certification8/8 and independent P003 audit EI-28053713472862354 on EI-28052394838934989 passed/current. Live preview returned ok=true,dryRun=true,dispatchCount=1, settled facts:list,partial=false,zero child failures; /tmp/su5c46-p003-live-preview.json.",
            "verifiedHow": "integration",
            "filesChanged": [
              "packages/operator-core/lib/code-recipes-candidates.ts",
              "packages/operator-core/lib/code-recipes-candidates.integration.test.ts",
              "packages/operator-core/lib/code-recipes-candidates.test.ts",
              "packages/operator-core/lib/code-recipes-store.ts",
              "packages/operator-core/lib/agent-tools/code/run.ts",
              "packages/operator-core/lib/code-run-adoption.ts",
              "packages/operator-core/lib/code-run-adoption.test.ts",
              "packages/operator-core/lib/code-intelligence/reuse-measurement.integration.test.ts",
              "packages/operator-core/lib/sql-tool-candidate-feedback.integration.test.ts",
              "packages/operator-core/lib/sql-tool-candidate-review.integration.test.ts"
            ],
            "contributesTo": [
              "R-2",
              "R-9",
              "R-10",
              "R-13"
            ],
            "settlementManifest": {
              "headSha": "90aa400fca186de57b85f286ea8b13e1a9e5e5bd",
              "version": 1,
              "generation": 1,
              "evidenceHash": "62d5008104f9f965e5c7962fc68b19d682b961c4b4e2607c188d25b0653b5bfc",
              "repositoryRoot": "/home/marsh-office/papercupai-workspace/papercusp",
              "contentIdentity": [
                {
                  "path": "packages/operator-core/lib/agent-tools/code/run.ts",
                  "headBlobSha": "cb2657772b1cf6f99e07f5539336b5f86e373369",
                  "workingTreeBlobSha": "cb2657772b1cf6f99e07f5539336b5f86e373369"
                },
                {
                  "path": "packages/operator-core/lib/code-intelligence/reuse-measurement.integration.test.ts",
                  "headBlobSha": "d29f2468ccc2f7ec4f7606484e499cdcb2452bd1",
                  "workingTreeBlobSha": "d29f2468ccc2f7ec4f7606484e499cdcb2452bd1"
                },
                {
                  "path": "packages/operator-core/lib/code-recipes-candidates.integration.test.ts",
                  "headBlobSha": "ce666ee13af907a37095b178ef71f425c564bee2",
                  "workingTreeBlobSha": "ce666ee13af907a37095b178ef71f425c564bee2"
                },
                {
                  "path": "packages/operator-core/lib/code-recipes-candidates.test.ts",
                  "headBlobSha": "83e56c2ac5fab86928d277751bb7b25e364f0ea3",
                  "workingTreeBlobSha": "83e56c2ac5fab86928d277751bb7b25e364f0ea3"
                },
                {
                  "path": "packages/operator-core/lib/code-recipes-candidates.ts",
                  "headBlobSha": "bb6a998e30cfcae8ce69f62f591f6d0761eddf8f",
                  "workingTreeBlobSha": "bb6a998e30cfcae8ce69f62f591f6d0761eddf8f"
                },
                {
                  "path": "packages/operator-core/lib/code-recipes-store.ts",
                  "headBlobSha": "897b51b12a86f732b81f2e39b1acfbcd2e183bf6",
                  "workingTreeBlobSha": "897b51b12a86f732b81f2e39b1acfbcd2e183bf6"
                },
                {
                  "path": "packages/operator-core/lib/code-run-adoption.test.ts",
                  "headBlobSha": "d282ea1d74fba22d76725e018c734c75ab870222",
                  "workingTreeBlobSha": "d282ea1d74fba22d76725e018c734c75ab870222"
                },
                {
                  "path": "packages/operator-core/lib/code-run-adoption.ts",
                  "headBlobSha": "bd746180fac7bcc57520905da8e021d9708cc0b4",
                  "workingTreeBlobSha": "bd746180fac7bcc57520905da8e021d9708cc0b4"
                },
                {
                  "path": "packages/operator-core/lib/sql-tool-candidate-feedback.integration.test.ts",
                  "headBlobSha": "fbe3262f060e2e722fb2651c7099f1f461c97fef",
                  "workingTreeBlobSha": "fbe3262f060e2e722fb2651c7099f1f461c97fef"
                },
                {
                  "path": "packages/operator-core/lib/sql-tool-candidate-review.integration.test.ts",
                  "headBlobSha": "2d6d5fe950dd9d7b44eee08035fa55a5a80c26a3",
                  "workingTreeBlobSha": "2d6d5fe950dd9d7b44eee08035fa55a5a80c26a3"
                }
              ],
              "normalizedPaths": [
                "packages/operator-core/lib/agent-tools/code/run.ts",
                "packages/operator-core/lib/code-intelligence/reuse-measurement.integration.test.ts",
                "packages/operator-core/lib/code-recipes-candidates.integration.test.ts",
                "packages/operator-core/lib/code-recipes-candidates.test.ts",
                "packages/operator-core/lib/code-recipes-candidates.ts",
                "packages/operator-core/lib/code-recipes-store.ts",
                "packages/operator-core/lib/code-run-adoption.test.ts",
                "packages/operator-core/lib/code-run-adoption.ts",
                "packages/operator-core/lib/sql-tool-candidate-feedback.integration.test.ts",
                "packages/operator-core/lib/sql-tool-candidate-review.integration.test.ts"
              ]
            },
            "checkpointChecksCarried": [
              {
                "claim": "Six affected integration files passed 100 tests with zero skips at clean committed f7c61972a8.",
                "recheck": "Read /tmp/su5c46-current-fixture-ledger-verified.json and /tmp/su5c46-current-fixture-test-receipts.jsonl; do not rerun for recovery.",
                "verified": "Clean prepared-root receipts and exact six-row canonical testing:runs readback all pass, worktreeDirty=false, harness papercusp. @2026-11-06T15:03:00.929Z"
              },
              {
                "claim": "All sixteen required P003/P004 maintained files passed at committed d7bd4cb281 with clean durable ledger proof.",
                "recheck": "Read /tmp/su5c46-p003p004-clean-tests.log final TEST_FILE_RESULT and16receipts /tmp/pcv/su5c46-p003p004-test-receipts-eYVa2d/receipts.jsonl; authoritativeDBreadbackdone. Do not rerunforrecovery.",
                "verified": "Native17293exit0;283PASS/0FAIL/0SKIP,16/16executed;16canonicalledgerrowsreadbackcleancommitd7bd/root4cilP8/harnesspapercusp. @2026-11-06T12:15:27.788Z"
              }
            ],
            "checkpointProseSnapshot": "## Did\nAvi directive2640/D007 AUTO/self continues; SAME coord:whoami verified initially and again14:16Z. No tracked edits/locks/fanout/gate/BG/newloop. FINAL CANONICAL8-CLAUSE ADEQUACY PASS8 FAIL0 UNKNOWN0 at14:20Z, /tmp/su5c46-p003p004-eight-adequacy-final.json (source3170b966). Both generic SPEC-P003/P004 pass all9 criteria including fixture, exact layers, L3+falsifiability, freshness; P004 all5 scenario mappings. Six BAR clauses pass. NOT yet certified/completed/shipped.\nOriginal16file283PASS d7bd baseline retained; no recoveryrerun. R13 actual terminal caught23483071 with baseline23482511/copy23482527. Complete all18 canonical mutation rows verified /tmp/su5c46-mutant-ledger-six-full.json: R2 23478724/728/732;R8 23479202/212/23480495;R9off23481001/002/004;R9on23481008/021/036;R10 23481777/779/23482502;R13above. Everybaseline/copyPASS, mutant intendedassertionFAIL,0skips, cleancommitd7bd, sameharness/root; explicitoverlay/treeintegrityverified.\nRecorded19 BARbindings77117-77135 with FIRSTinline/transitivesupport/migrationglobs; priorR2bindings77036-38 retained. R10 reviewbinding77118 source-stale after peerchange -> refreshed actualfile only, NOTall16. Old4cilP8 root+preparedreceipt observedgone14:02Z; helperdocMAX_IDLE_KEPT_TREES4 allows eviction, not testfailure. JustifiedONEnew materialization cec5d3a64e1b7adadbad35da39440826abd2e009, retained root /tmp/pcv/papercusp-lint-as-committed-cec5d3a64e-cA3QNm. Retain-for artifact /tmp/su5c46-remaining-proof-prepare-state.json MUSTKEEP untilremainingacceptance; normal exported preparedreceipt /tmp/su5c46-remaining-proof-prepared-root.json. Prep native81063 and testdriver81782 BOTHterminal0/drained; no runningprobes.\nNEW exact saved-recipe-reliability proof: /tmp/su5c46-p003-reliability-current.log actual recipeCandidates integration9PASS baseline23485085/copy23485093; semanticmutant clamp01(successes/denominator)->clamp01(successes/successes) caught23485117 (2FAIL7PASS0SKIP, named P003-RELIABILITY .5 vs1). Canonical3rowreadback verified /tmp/su5c46-reliability-final-ledger.json. FreshR10review12PASS0SKIP cleancec5d durable23485119, /tmp/su5c46-r10-review-refresh-current.log +ledger.json. These were new specificproofs, no originalbaseline rerun.\nFinalbindings: R10fresh77180; SPEC-P003 baseline77181/mutant77182/unitliteralcomponent77183. SPEC-P004 initialtests77172-74, correctedtreeplane+scenarios baseline77178/mutant77179 (target frozen-window-completion, explicit1scenario->actual R8failedcase). InitialgenericmutationtargetSPEC-P004 REFUSED (zero mutationwrite); source requires namedscenario when requiredScenarios exists. Full originalresultspilled, readvia capability:read canonicalbase64+EOF; /tmp/su5c46-p004-generic-proof-correction-result.json success2. Fullinputs saved /tmp/su5c46-{bind-five-bars-input,reliability-review-proof-input,p004-generic-proof-correction-input}.json; finalresultarrays saved.\nMETA currentrubric4 criteriaHashf0c26e4dad64631d32907c781b86995efa62ad572b20c455c9943cb7ade814de barSeted602828b98cfd6537723cc5f2be9375622a96b21a5e8b344acfa0f70c385efe. Reused actual independent critique conv-request-e0a2db2db14a244faabd9bdb4e23351bf8540b0c429948cde37450d52d783711/post1214901 (source/tmp/su5c46-existing-critique-live.json). Author-owned canonicalmetaattestation EMITTED EI-28046984726575598 /tmp/su5c46-meta-attestation-current.json. FivecriteriaPASS, prefer-structured-check WEAK because laterP005-P018 asbuilt detectors unassessed; NOallpass or acceptanceclaim, NOunansweredwaiver. Grade-the-grader stillPENDING lastread~14:10Z, so rubricunvettedreason grading-audit-unsettled, not missingcard. DoNOT duplicateemit/requestnewrubricreview; inspect currentaudit authoritative. Sourceemit author-owned externalcritique path read2920-3158. Direct9071 schema d740older rejects newerpins; allcurrentbindings/evaluation/emit use ptool --url=http://127.0.0.1:3170. Never drop pins to fitoldserver.\nHistoricalpre-turncheckpoints available /tmp/su5c46-recovery-workitems.json (all3completebody+checks), oldproof source /tmp/su5c46-p003p004-clean-tests.log and16receipts /tmp/pcv/su5c46-p003p004-test-receipts-eYVa2d/receipts.jsonl. Keep all existingcheckpointchecks; old8filepassingclaim was alreadyretiredon3WIs and remainsfalsehistoric inloop.\n\n## Left\nP003/P004 now VERIFIED ADEQUACY, but canonical certify-spec-clauses and acceptance/completion stillOPEN. Generic cards audit/independentacceptance required; reuse canonical plans:certify-spec-clauses (source args read) NOT manual scorecard reconstruction. RemainingP005-P018implementation and finalexactship unfinished. Directive2640OPEN. MetaauditPENDING; preferstructuredweak obligation deliberatelyretained until later detectorpopulation assessed. P001/P002 and specqualityEI27999470184005916 terminal; no redo/reclose. Existing critique obligations satisfied by prior2distinctreviewers, no freshmodel for samecontract. Original283baseline historicalcorrect; onlyR10 dependency neededrefreshrun, all8currentevidence nowPASS. Newretainedrootkeepaliveartifactmustsurvivecarry; do not assume old4cilP8 exists.\n\n## Next action\nAfterSAMEwhoami/readthislivecheckpoint+checks, inspect FINAL8PASS /tmp/su5c46-p003p004-eight-adequacy-final.json; DO NOT rerunbaseline/mutants/setup. Canonical certification tool source packages/operator-core/lib/agent-tools/plans/certify-spec-clauses.ts args {harness,slug,classRef:'plan-class-feature-ship',planItemIds:['P-003','P-004'],workItemIds optional,dryRun optional,acknowledgeExisting optional}; certification emits onlygenericjudgmentcards and requires auditcurrentness. Read exactlive toolargSchema beforemutation, then certify both; inspect authoritative metaEI28046984726575598 audit and owncardaudits; repair/recover canonical auditroute ifstalled (no duplicatecritique). Only whencompletiongates satisfied close ownoriginalWI5521/5522 withstructuredproof/changeKinds, resolve duplicateP004WI5877 deliberately. ThenactualP005next under sameAUTOselfroute. No shipclaim/2640close untilfullplanexactshipverified. Control/reporterreal resolveScriptPgUrl; privatePG ONLYPAPERCUSP_TEST_PG_ADMIN_URL from /tmp/su5c46-r13-private-pg-url NEVERPRINT. Descriptorreader3170; actualtestCLI standardpaths no --any. Latestloopstatus activewarm300, rewakeGuaranteedtrue. Gracefulcontextcarryneeded now~87%; old droppedcompactionmessages belong earlierrequest, notthiscurrentcompletedturn.\n\n---\n## Did\nContinuation SAME coord:whoami matched. Canonical certification executed on current3170: /tmp/su5c46-p003p004-certification.json; historical final8PASS now superseded for currentness, not revoked as historical proof. Fresh measured cohort at f7c61972a8: 3 mechanical PASS, 5 NOTPASS; zero cards filed. Exact drift isolated via per-file SHA comparison of measurementPin: libs/test-config/src/owned-test-db-cleanup.ts changed f19046->e1ae94; R13 additionally packages/operator-core/lib/rubrics.ts changed +15 lines. /tmp/su5c46-certification-drift-evidence.json retains all21 full bindings. No product regression asserted. Six affected integration files PASS current canonical tree /tmp/su5c46-p003p004-drift-refresh.log, but ledger23486608-613 worktreeDirty=true; NOT acceptance proof, do not rebind these as clean. First current-tree mutant rejected preflight because caller Perl escaping invalid; no tests/mutation occurred and tree integrity VERIFIED, /tmp/su5c46-drift-mutations.log. No tracked edits, no fanout/gate/BG/newloop.\n\n## Left\nNeed clean exact current fixture source proof, then canonical certification (use planItemIds only for governing verdict; workItemIds pins a diagnostic cohort), generic-card audits, completion. Meta EI28046984726575598 still pending on current read. RemainingP005-P018 and exactship2640 OPEN.\n\n## Next action\nPreparation running native exec37985 at /tmp/su5c46-current-fixture-prepare.log, exact f7c61972a8 using maintained lint-as-committed --materialize-only --retain-for existing /tmp/su5c46-remaining-proof-prepare-state.json (KEEP, retains priorcec5 root too). Drain handle then discover root in log, export prepared-root receipt with existing writePreparedWorkRootReceipt + lintAsCommittedChildEnv. Run six files once in clean prepared root and two targeted overlay mutants using Perl brace delimiter/no escaping. No full16 or sevenmutationrerun. Before any further attempt inspect saved logs/ledger. Preserve current declared route AUTOself/warm300.\n\n---\n## Did\nSAME owner identity verified. At current3170 certification /tmp/su5c46-p003p004-certification.json found 3PASS/5NOTPASS at f7c61972a8; old FINAL8PASS is HISTORICAL ONLY. Root cause of freshness change measured per-file: libs/test-config/src/owned-test-db-cleanup.ts f19046->e1ae94, and R13 source packages/operator-core/lib/rubrics.ts +15lines. The six-file canonical-tree run passed but durable rows23486608-613 dirty=true, NOT clean proof. Corrected to new maintained prepared root /tmp/pcv/papercusp-lint-as-committed-f7c61972a8-6H3Fnh. Prepared via scripts/lint-as-committed.mjs exactf7, normal writePreparedWorkRootReceipt and lintAsCommittedChildEnv. NEW CLEAN6FILE100PASS0FAIL0SKIP, normalreceipts /tmp/su5c46-current-fixture-test-receipts.jsonl, log /tmp/su5c46-current-fixture-proof.log. Exact canonical DB readback /tmp/su5c46-current-fixture-ledger-verified.json all6 cleanfalseDirty/currentharness/rootf7. IDs recipe23487166,cadence23487167,census23487168,SQLfeedback23487169,SQLreview23487170,reuse23487171. NEW7bindings77204-77210 accepted /tmp/su5c46-current-fixture-bind-result.json, exactinput /tmp/su5c46-current-fixture-bind-input.json. Covers 5changed BARtestbindings plus SPEC003/004baselines. No tracked edits/no locks/no full16rerun/no sevenmutants/no implementationfanout/gate/BG/newloop.\n\n## Left\nONLY TWO stale mutants being refreshed in native exec52438; DO NOT rerun their tests/setup. Driver first P003 reliability mutation already CAUGHT: baseline23487695,copy23487721,mutant23487723, terminal0; rootf7, overlaycontained,assertionfailure,0skips. Not yet bound. P004 RESUME mutation RUNNING baseline on last14:56Z read; driver will run copy+mutant sequentially and write terminal. /tmp/su5c46-current-fixture-mutations.log is authoritative. Clean driver native16884 terminal2 ONLY due descriptor preflight mistakenly targeting9071; NO failedproof from that refusal. Corrected native52438 pins PAPERCUSP_MUTATION_DESCRIPTOR_READER_HEALTH_URL=http://127.0.0.1:3170/api/health, readerb966 observed. First callerbadPerl attempt preflightrefused, now brace-delimited expressions precompile checked. Source remains unchanged. All earlier8passing claims nowhistorical; current5clauses NOTaccepted until newmutants bound/evaluatorpass/cert/audit. RemainingP005-P018+exactship/2640OPEN.\n\n## Next action\nAfter SAMEwhoami, READ latest5522 and log then drain nativeexec52438 (write_stdin). Preserve sessionhandle; if handleunavailable inspect logterminal and canonical mutation ledgers BEFORE anyretry. Keep /tmp/su5c46-remaining-proof-prepare-state.json EXISTS: retains cec5 AND newf7roots; newpreparedreceipt /tmp/su5c46-current-fixture-prepared-root.json. No newmaterialization/baseline/mutants until actualnewchange. When2mutants terminal0, read exact mutationledgerrows allphases, use existing reliability-review-proof-input item2 for SPEC003 and p004-generic-proof-correction-input item1 for SPEC004 target frozen-window-completion, plus bind-five-bars-input item10 for R8 targetclause. Update fromTestRun only and limit testCases to actualfailedtitles; R8 newmutation disables resume progress.set, so prove exactR8failedcase. Canonical certify use ONLY planItemIds P003/P004 (workItemIds makes diagnostic nongoverning). Then cards audits and original completion. MetaEI28046984726575598 canonical scorecards:repair LAUNCHED judge su-7a5f85c8-1f65-4f4e-b4db-af3425e12590 /tmp/su5c46-meta-audit-repair.json. Current cardpending/reservation; no duplicateemit/review. Targetpresence14:55 live/wakeable but emptyintent no claim,lastactive403s. Directed requiredwake coord-send-67c33747682bbfc22d47b8e48ff09ae76dac0a564df56db6cfe18e9163686368 queued/woken1 pickupConfirmedfalse; VERIFYpickup/reply later, don'tclaimhandled. Loop activewarm300, reachable. Preserve AUTO/self solo route. P005 preparation only: normalizeExecutionTrace accepts operations but code/run.ts623 omits them; capbash.ts thin durablejob wrapper; next examine shared capture seam under registeredP005 after P003 accepted.\n\n---\nContinuation exact proof/next actions are authoritative on WI-6554700010045522 newest CLEAN CARRY ~15:55Z. Current P0035/5PASS, canonical SPEC003card EI-28052394838934989 pending audit (source /tmp/su5c46-p003-card-latest.json). No completion yet. Source oldmutant77182 superseded by current77215, same-case currenttest77209. Refreshed R10/R13 cleanb8 bindings77231-33 supersede oldstale files. Correctedmeta EI-28054202381409882 supersedesfailed EI28046984726575598; failedaudit root and complete reproducible census/6mutationargv persisted on mainWI5461. Audit pending, preferstructured remainsWEAK with futuredetectors explicitUNKNOWN. No repoedits/locks/fanout/ship. Preserve retainedroots + preparedreceipts; no reruntests justforrecovery. Settleaudits then completiongates before originalclose/P005. Avi2640OPEN, AUTOself/warm300."
          },
          "_planAuthoredBlockers": {
            "itemId": "P-003",
            "planSlug": "unified-recipe-sql-shell-tool-learning-2026-11-05",
            "blockerWorkItemIds": []
          },
          "claim_history_post_id": 9001788375295
        },
        "conditionKey": null
      },
      "finalR1Disposition": "OPEN",
      "timeBoundary": "Original report retained in terminal92 raw capture, later target snapshot at 2026-11-08T15:48:45.116Z; source witnesses captured in this qualification. No inferred original-time availability or loaded runtime."
    },
    {
      "originalId": "EI-27993606831901508",
      "targetId": "EI-27721532818104343",
      "classification": "same-specific-symptom",
      "qualification": "Both shipped plans render obsolete pre-shipment BAR Now text; different plans are examples of same stale projection symptom. Target open; no source fix/ship proof.",
      "original": {
        "title": "Shipped event-wait plan still renders obsolete BAR READINESS BLOCKED / DRAFT Now text",
        "summary": "Read-only status investigation on 2026-11-05: plans:get {slug:'event-wait-settlement-2026-10-20',harness:'papercusp',heading:'Now'} returns status shipped, lifecycle agreed/implementation-complete, and eight terminal done items, but section.body still begins 'BAR READINESS BLOCKED (2026-10-27, after decision-added): bar_snapshot_rubric_unresolved' and describes DRAFT activation plus no code written. Plans:items independently enumerates P-001/002/003/004/005/006/007/009 as done; completion evidence exists for P-009 and follow-ups. This is misleading owner-facing historical prose. Plausible fix: extend the existing terminal-plan Now closure/banner projection (visible on dependency-graph-admission-and-health-2026-08-26) to dominate scope-cascade readiness text on shipped plans; preserve historical prose behind an explicit closed-plan marker. Add a regression for ship followed by a decision-added scope cascade. Root cause not yet verified; do not change the rubric based on the obsolete message.",
        "status": "dropped",
        "duplicate_of": "EI-27721532818104343",
        "payload": {
          "_ei": {
            "scope": "harness:papercusp",
            "source": "su",
            "severity": "minor",
            "created_by": "su-dc186745-1c8d-4874-bc87-cf3196c43e08",
            "signal_origin": "organic"
          },
          "filedByRole": "su",
          "dedupCoverage": {
            "lexical": "unavailable",
            "degraded": true,
            "rescreen": {
              "at": "2026-11-06T03:16:16.765Z",
              "by": "admission-fail-open:dedup-rescreen",
              "atMs": 1793934976765,
              "prior": {
                "lexical": "unavailable",
                "degraded": true,
                "semantic": "ok"
              },
              "runId": "sched-.routinesTick-2026-11-06T03:15:30.000Z-43",
              "outcome": "degraded",
              "attempts": 3
            },
            "semantic": "unavailable"
          },
          "ideaLifecycle": {
            "state": "open",
            "stateUpdatedAt": "2026-11-05T23:46:23.847Z"
          },
          "admissionMerge": {
            "actor": "system:work-item-admission-promoter",
            "prior": {
              "status": "open",
              "seeAlso": [
                "EI-26900869499864825",
                "EI-27065170375204517",
                "EI-27148056543569983",
                "EI-27223255925628655",
                "EI-27964360013594118",
                "WI-6554700010030355"
              ],
              "takenBy": null,
              "admission": "unreviewed",
              "admittedAt": "2026-11-06T03:16:18.852Z",
              "admittedBy": "system:work-item-admission-fail-open",
              "closedAtMs": null,
              "conditionKey": null,
              "terminalOwner": null,
              "sourcePlanSlug": null,
              "terminalReason": null,
              "admissionReview": {
                "value": {
                  "alert": {
                    "key": "work-item-admission-review-debt",
                    "state": "open",
                    "reason": "pending fail-open admission requires re-review",
                    "emittedAt": "2026-11-05T22:16:01.103-05:00"
                  },
                  "state": "pending",
                  "enteredAt": "2026-11-05T22:16:01.103-05:00",
                  "retryOwner": "system:work-item-admission-promoter",
                  "reviewedAt": null,
                  "reviewedBy": null,
                  "terminalAt": null,
                  "lastRetryAt": null,
                  "reviewDueAt": "2026-11-05T23:16:01.103-05:00",
                  "retryAttempts": 0,
                  "terminalOutcome": null
                },
                "present": true
              },
              "watchdogIdentity": {
                "watchdogKey": {
                  "value": null,
                  "present": false
                },
                "watchdogLane": {
                  "value": null,
                  "present": false
                },
                "watchdogSignalOrigin": {
                  "value": "organic",
                  "present": true
                },
                "admissionMergeSources": {
                  "value": null,
                  "present": false
                }
              },
              "sourcePlanItemIds": null
            },
            "runId": "sched-.routinesTick-2026-11-06T19:34:00.000Z-3",
            "state": "complete",
            "canonical": {
              "prior": {
                "seeAlso": [
                  "EI-23934925665491873",
                  "EI-25749234179776072",
                  "EI-25928886239200961",
                  "EI-26707716297578152",
                  "EI-27065170375204517",
                  "EI-27723601672709313",
                  "WI-10003187"
                ],
                "takenBy": null,
                "conditionKey": null,
                "sourcePlanSlug": null,
                "watchdogIdentity": {
                  "watchdogKey": {
                    "value": null,
                    "present": false
                  },
                  "watchdogLane": {
                    "value": null,
                    "present": false
                  },
                  "watchdogSignalOrigin": {
                    "value": "organic",
                    "present": true
                  },
                  "admissionMergeSources": {
                    "value": null,
                    "present": false
                  }
                },
                "sourcePlanItemIds": null
              },
              "applied": {
                "seeAlso": [
                  "EI-23934925665491873",
                  "EI-25749234179776072",
                  "EI-25928886239200961",
                  "EI-26707716297578152",
                  "EI-26900869499864825",
                  "EI-27065170375204517",
                  "EI-27148056543569983",
                  "EI-27223255925628655",
                  "EI-27723601672709313",
                  "EI-27964360013594118",
                  "EI-27993606831901508",
                  "WI-10003187",
                  "WI-6554700010030355"
                ],
                "conditionKey": null,
                "sourcePlanSlug": null,
                "watchdogIdentity": {
                  "watchdogKey": {
                    "value": null,
                    "present": false
                  },
                  "watchdogLane": {
                    "value": null,
                    "present": false
                  },
                  "watchdogSignalOrigin": {
                    "value": "organic",
                    "present": true
                  },
                  "admissionMergeSources": {
                    "value": [
                      {
                        "actor": "system:work-item-admission-promoter",
                        "runId": "sched-.routinesTick-2026-11-06T19:34:00.000Z-3",
                        "loserId": "EI-27993606831901508",
                        "mergedAtMs": 1793994224439,
                        "schemaVersion": 1
                      }
                    ],
                    "present": true
                  }
                },
                "sourcePlanItemIds": null
              },
              "sourceEntryAdded": true
            },
            "transfers": {
              "occurrences": [
                {
                  "occurrenceId": "820712",
                  "priorCanonicalId": "EI-27993606831901508",
                  "priorCanonicalHarness": "papercusp"
                }
              ],
              "dependencyEdges": [],
              "duplicateOccurrenceId": "827638",
              "canonicalOutgoingAdded": [
                "EI-26900869499864825",
                "EI-27148056543569983",
                "EI-27223255925628655",
                "EI-27964360013594118",
                "EI-27993606831901508",
                "WI-6554700010030355"
              ],
              "incomingReferenceSources": [
                "EI-26900869499864825",
                "EI-27148056543569983",
                "EI-27223255925628655",
                "EI-27964360013594118",
                "WI-6554700010030355"
              ],
              "duplicateOccurrenceCreated": true,
              "loserCanonicalReferenceAdded": true
            },
            "mergedAtMs": 1793994224439,
            "canonicalId": "EI-27721532818104343",
            "schemaVersion": 2,
            "canonicalHarness": "papercusp",
            "judgmentIdentity": {
              "loser": "26c0951fa8bdcd5e1a519c119ec5a4380ccfaec2156f6c7eb7a9d587cdbb3c34",
              "canonical": "5155331d8fb51196ac7e7bbcda7038a591eafed20f7af2a58faaff6f741f8d34"
            },
            "reversalInstructions": {
              "order": [
                "restore-or-delete dependency after-edges from targetPrior, then reinsert each before-edge",
                "repoint transferred occurrence IDs to their prior canonical and delete the duplicate occurrence only when duplicateOccurrenceCreated=true",
                "remove canonical only from the recorded incomingReferenceSources and canonicalOutgoingAdded entries",
                "restore canonical identity, plan and reference fields only when they still equal canonical.applied",
                "restore loser lifecycle, admission, condition, plan, references and admissionReview from prior; then remove admissionMerge"
              ],
              "schemaVersion": 1,
              "transactionRequired": true,
              "compareAppliedStateBeforeRestore": true
            }
          },
          "admissionReview": {
            "alert": {
              "key": "work-item-admission-review-debt",
              "state": "cleared",
              "reason": "review completed",
              "emittedAt": "2026-11-06T14:43:44.439-05:00"
            },
            "state": "terminal",
            "enteredAt": "2026-11-05T22:16:01.103-05:00",
            "retryOwner": "system:work-item-admission-promoter",
            "reviewedAt": "2026-11-06T14:43:44.439-05:00",
            "reviewedBy": "system:work-item-admission-promoter",
            "terminalAt": "2026-11-06T14:43:44.439-05:00",
            "lastRetryAt": "2026-11-06T14:43:44.439-05:00",
            "reviewDueAt": "2026-11-05T23:16:01.103-05:00",
            "retryAttempts": 1,
            "terminalOutcome": "duplicate-merge"
          },
          "admissionFailOpen": {
            "at": "2026-11-05T22:16:01.103-05:00",
            "actor": "system:work-item-admission-fail-open",
            "runId": "sched-.routinesTick-2026-11-06T03:15:30.000Z-43",
            "scope": "workspace",
            "reason": "pending-age-exceeded-two-promoter-ticks"
          },
          "admissionIdentity": {
            "titleKey": "title:bar blocked draft event now obsolete plan readiness renders shipped still text wait",
            "schemaVersion": "admission-identity-v1"
          },
          "freshnessEnvelope": {
            "observedAt": "2026-11-05T23:46:23.847Z",
            "linkedFixRefs": [],
            "reporterSession": "su-dc186745-1c8d-4874-bc87-cf3196c43e08",
            "observedSourceSha": "d740fc3802",
            "toolSchemaVersion": null,
            "observedRuntimeSha": "d740fc3802",
            "deployBuildIdentity": "d740fc3802@0.0.0",
            "reporterRuntimeVersion": "0.0.0",
            "lastSuccessfulReproductionAt": null
          },
          "implementationReadiness": {
            "reason": "existing-immediate-capture-policy",
            "source": "capture-policy",
            "status": "ready",
            "updatedAt": "2026-11-05T23:46:23.847Z",
            "schemaVersion": "implementation-readiness-v1"
          }
        },
        "conditionKey": null
      },
      "target": {
        "title": "Shipped epoch-carry plan still presents a pre-shipment BAR blocker as its current Now state",
        "summary": "Observed during WI-6554700010044921 terminal-lane reconciliation at2026-11-02T23:36-40Z. plans:get code-intel-epoch-carry-2026-10-20 metadata v22/contentHashad07e091fa23ec498e38f996d51c3271ed6cdb1f5a1e9d9ab7c7cc2c0dd5bded returns status shipped, all7 indexeditemsdone, but ##Now State still says BAR READINESS BLOCKED(2026-10-20 afterdecision-added), codes bar_snapshot_cohort_incomplete/bar_snapshot_rubric_missing/bar_snapshot_bar_set_empty and Next='Repair the server-owned adoption epoch/cohort seed on the subject plan'. nextDerivation reasondrained/dispositionunverifiable. P006 WI-6554700010018167 is done, with stored manualpassed bindings61814/61815 and independentverification61816/currentnessunknown, evidence code_intel_pushes id50/epoch53/:3170build2b9bd96634. This does not independently re-certify shipment or current proof; preserve lifecycle and evidence. Source set-plan-status.ts308-310 explicitly says P006 retired terminal-Now repair stamps; do not restore that old stamp or recruit a grader for idempotent terminal repair. Suspected presentation/projection defect: terminal views continue to label a historical action as the current Next instead of marking it historical/drained. Specific plausible fix: make current Now/derived Next rendering terminal-aware, preserve historical body and shipment status, and add regression covering shipped+drained+oldBARbanner without reopening/regrading. Root cause unconfirmed; no implementation begun. This stale warning already caused repeated leadership reconciliation. Source pointers plan-scope-cascade.ts BarReadiness banner writer; plans/get and set-plan-status.ts existing terminal behavior.\n\nⓘ Possible STALE RUNTIME, not an open defect: `packages/operator-core/lib/agent-tools/plans/plan-scope-cascade.ts` (7 newer commits, tip `34b13a3cfd2b324a8b36dc17393afd417aad3027`), `packages/operator-core/lib/agent-tools/plans/set-plan-status.ts` (88 newer commits, tip `3be6474c17ab65011046831805d3dad22125d67a`) have commits newer than the running build (`d740fc3802`) in `staging`. If this was observed live, verify the deployed generation before triaging; the behavior may already be fixed in the tree.",
        "status": "open",
        "duplicate_of": null,
        "payload": {
          "_ei": {
            "scope": "harness:papercusp",
            "source": "su",
            "severity": "minor",
            "created_by": "su-78560746-d1a0-423b-a26e-c1e9c6486454",
            "found_during": "WI-6554700010044921",
            "signal_origin": "organic"
          },
          "paths": [
            "packages/operator-core/lib/agent-tools/plans/plan-scope-cascade.ts",
            "packages/operator-core/lib/agent-tools/plans/set-plan-status.ts"
          ],
          "filedByRole": "su",
          "admissionHold": {
            "actor": "system:work-item-admission-promoter",
            "runId": "26f267b1-ecd1-49fd-8e65-be91258c3d04",
            "heldAt": "2026-11-06T19:14:01.882-05:00",
            "reason": "deferred: twin EI-23869451300311837 is review-gated; held until it can be judged",
            "screeningDeferred": true
          },
          "dedupCoverage": {
            "lexical": "unavailable",
            "degraded": true,
            "rescreen": {
              "at": "2026-11-03T03:24:59.133Z",
              "by": "admission-fail-open:dedup-rescreen",
              "atMs": 1793676299133,
              "prior": {
                "lexical": "unavailable",
                "degraded": true,
                "semantic": "ok"
              },
              "runId": "sched-.routinesTick-2026-11-03T03:23:30.000Z-49",
              "outcome": "degraded",
              "attempts": 3
            },
            "semantic": "unavailable"
          },
          "ideaLifecycle": {
            "state": "open",
            "stateUpdatedAt": "2026-11-02T23:41:53.855Z"
          },
          "admissionReview": {
            "alert": {
              "key": "work-item-admission-review-debt",
              "state": "open",
              "reason": "pending fail-open admission requires re-review",
              "emittedAt": "2026-11-02T22:24:43.342-05:00"
            },
            "state": "pending",
            "enteredAt": "2026-11-02T22:24:43.342-05:00",
            "retryOwner": "system:work-item-admission-promoter",
            "reviewedAt": null,
            "reviewedBy": null,
            "terminalAt": null,
            "lastRetryAt": null,
            "reviewDueAt": "2026-11-02T23:24:43.342-05:00",
            "retryAttempts": 0,
            "terminalOutcome": null
          },
          "dedupCandidates": [
            {
              "id": "EI-25880812907103155",
              "method": "semantic-soft",
              "similarity": 0.9
            }
          ],
          "admissionFailOpen": {
            "at": "2026-11-02T22:24:43.342-05:00",
            "actor": "system:work-item-admission-fail-open",
            "runId": "sched-.routinesTick-2026-11-03T03:23:30.000Z-49",
            "scope": "workspace",
            "reason": "pending-age-exceeded-two-promoter-ticks"
          },
          "admissionIdentity": {
            "titleKey": "title:bar blocker carry current epoch its now plan pre presents shipment shipped state still",
            "schemaVersion": "admission-identity-v1"
          },
          "freshnessEnvelope": {
            "observedAt": "2026-11-02T23:41:53.855Z",
            "linkedFixRefs": [],
            "reporterSession": "su-78560746-d1a0-423b-a26e-c1e9c6486454",
            "observedSourceSha": "d740fc3802",
            "toolSchemaVersion": null,
            "observedRuntimeSha": "d740fc3802",
            "deployBuildIdentity": "d740fc3802@0.0.0",
            "reporterRuntimeVersion": "0.0.0",
            "lastSuccessfulReproductionAt": null
          },
          "admissionMergeSources": [
            {
              "actor": "system:work-item-admission-promoter",
              "runId": "sched-.routinesTick-2026-11-06T19:34:00.000Z-3",
              "loserId": "EI-27993606831901508",
              "mergedAtMs": 1793994224439,
              "schemaVersion": 1
            }
          ],
          "implementationReadiness": {
            "reason": "existing-immediate-capture-policy",
            "source": "capture-policy",
            "status": "ready",
            "updatedAt": "2026-11-02T23:41:53.855Z",
            "schemaVersion": "implementation-readiness-v1"
          }
        },
        "conditionKey": null
      },
      "finalR1Disposition": "OPEN",
      "timeBoundary": "Original report retained in terminal92 raw capture, later target snapshot at 2026-11-08T15:48:45.116Z; source witnesses captured in this qualification. No inferred original-time availability or loaded runtime."
    },
    {
      "originalId": "EI-27998545512823414",
      "targetId": "EI-26827230042172261",
      "classification": "same-specific-symptom",
      "qualification": "Both batch advisories falsely label discovery-dependent sequential calls as independent. Target open; advisory correctness is not underlying tool-handler failure.",
      "original": {
        "title": "Batching hint asserts adaptive tool-discovery calls were independent",
        "summary": "During canonical-audit reconciliation, tools:find +tasks:list returned a human task-list schema, not the managed process ledger required for the live reviewer. Only after inspecting that result did this session choose +processes:list; its schema supplied the correct workItemId/taskId lifecycle read. The second result appended a batch-hint asserting those calls were independent by construction and supplied a Promise.all rewrite. This is an adaptive follow-up explicitly permitted by the hint's own final paragraph, so the assertion/directive is a false positive. Keep the batching advisory but make independence conditional unless dataflow is actually known; do not describe every adjacent call as provably independent. No functional source change attempted here. Exact evidence is this session's consecutive tools:find calls around the repair job0mw49frj91thrtyr1yz; active reviewer0mw49izlw1nlk55umjg was then found through the discovered processes:list schema. Nonblocking detector-quality bug; no claim of underlying tool failure.",
        "status": "dropped",
        "duplicate_of": "EI-26827230042172261",
        "payload": {
          "_ei": {
            "scope": "harness:papercusp",
            "source": "su",
            "severity": "major",
            "created_by": "su-6658849f-658a-4320-a483-43f2693dbcfb",
            "found_during": "WI-6554700010045499",
            "signal_origin": "organic"
          },
          "filedByRole": "su",
          "dedupCoverage": {
            "lexical": "unavailable",
            "degraded": true,
            "rescreen": {
              "at": "2026-11-06T04:51:49.900Z",
              "by": "admission-fail-open:dedup-rescreen",
              "atMs": 1793940709900,
              "prior": {
                "lexical": "unavailable",
                "degraded": true,
                "semantic": "unavailable"
              },
              "runId": "sched-.routinesTick-2026-11-06T04:51:30.000Z-17",
              "outcome": "degraded",
              "attempts": 3
            },
            "semantic": "unavailable"
          },
          "ideaLifecycle": {
            "state": "open",
            "stateUpdatedAt": "2026-11-06T01:04:53.748Z"
          },
          "admissionMerge": {
            "actor": "system:work-item-admission-promoter",
            "prior": {
              "status": "open",
              "seeAlso": [
                "EI-27200047676496660",
                "EI-27673565940327197",
                "EI-27705495092310166",
                "EI-27742591942295645"
              ],
              "takenBy": null,
              "admission": "unreviewed",
              "admittedAt": "2026-11-06T04:52:12.777Z",
              "admittedBy": "system:work-item-admission-fail-open",
              "closedAtMs": null,
              "conditionKey": null,
              "terminalOwner": null,
              "sourcePlanSlug": null,
              "terminalReason": null,
              "admissionReview": {
                "value": {
                  "alert": {
                    "key": "work-item-admission-review-debt",
                    "state": "open",
                    "reason": "pending fail-open admission requires re-review",
                    "emittedAt": "2026-11-05T23:51:34.764-05:00"
                  },
                  "state": "pending",
                  "enteredAt": "2026-11-05T23:51:34.764-05:00",
                  "retryOwner": "system:work-item-admission-promoter",
                  "reviewedAt": null,
                  "reviewedBy": null,
                  "terminalAt": null,
                  "lastRetryAt": null,
                  "reviewDueAt": "2026-11-06T00:51:34.764-05:00",
                  "retryAttempts": 0,
                  "terminalOutcome": null
                },
                "present": true
              },
              "watchdogIdentity": {
                "watchdogKey": {
                  "value": null,
                  "present": false
                },
                "watchdogLane": {
                  "value": null,
                  "present": false
                },
                "watchdogSignalOrigin": {
                  "value": "organic",
                  "present": true
                },
                "admissionMergeSources": {
                  "value": null,
                  "present": false
                }
              },
              "sourcePlanItemIds": null
            },
            "runId": "sched-.routinesTick-2026-11-06T19:34:00.000Z-3",
            "state": "complete",
            "canonical": {
              "prior": {
                "seeAlso": [
                  "EI-27069602240637403"
                ],
                "takenBy": null,
                "conditionKey": null,
                "sourcePlanSlug": null,
                "watchdogIdentity": {
                  "watchdogKey": {
                    "value": null,
                    "present": false
                  },
                  "watchdogLane": {
                    "value": null,
                    "present": false
                  },
                  "watchdogSignalOrigin": {
                    "value": "organic",
                    "present": true
                  },
                  "admissionMergeSources": {
                    "value": null,
                    "present": false
                  }
                },
                "sourcePlanItemIds": null
              },
              "applied": {
                "seeAlso": [
                  "EI-27069602240637403",
                  "EI-27200047676496660",
                  "EI-27673565940327197",
                  "EI-27705495092310166",
                  "EI-27742591942295645",
                  "EI-27998545512823414"
                ],
                "conditionKey": null,
                "sourcePlanSlug": null,
                "watchdogIdentity": {
                  "watchdogKey": {
                    "value": null,
                    "present": false
                  },
                  "watchdogLane": {
                    "value": null,
                    "present": false
                  },
                  "watchdogSignalOrigin": {
                    "value": "organic",
                    "present": true
                  },
                  "admissionMergeSources": {
                    "value": [
                      {
                        "actor": "system:work-item-admission-promoter",
                        "runId": "sched-.routinesTick-2026-11-06T19:34:00.000Z-3",
                        "loserId": "EI-27998545512823414",
                        "mergedAtMs": 1793994224439,
                        "schemaVersion": 1
                      }
                    ],
                    "present": true
                  }
                },
                "sourcePlanItemIds": null
              },
              "sourceEntryAdded": true
            },
            "transfers": {
              "occurrences": [
                {
                  "occurrenceId": "821217",
                  "priorCanonicalId": "EI-27998545512823414",
                  "priorCanonicalHarness": "papercusp"
                }
              ],
              "dependencyEdges": [],
              "duplicateOccurrenceId": "827639",
              "canonicalOutgoingAdded": [
                "EI-27200047676496660",
                "EI-27673565940327197",
                "EI-27705495092310166",
                "EI-27742591942295645",
                "EI-27998545512823414"
              ],
              "incomingReferenceSources": [
                "EI-27200047676496660",
                "EI-27673565940327197",
                "EI-27705495092310166",
                "EI-27742591942295645"
              ],
              "duplicateOccurrenceCreated": true,
              "loserCanonicalReferenceAdded": true
            },
            "mergedAtMs": 1793994224439,
            "canonicalId": "EI-26827230042172261",
            "schemaVersion": 2,
            "canonicalHarness": "papercusp",
            "judgmentIdentity": {
              "loser": "c2caa5749655ecd627c82f6bfe7ba4f5e68519e1ee38313887ea2bc53f3dd391",
              "canonical": "15b3c4548e2d735bc7927b96c101ba06f4ba2f5c9977c383f45bbb3313835b20"
            },
            "reversalInstructions": {
              "order": [
                "restore-or-delete dependency after-edges from targetPrior, then reinsert each before-edge",
                "repoint transferred occurrence IDs to their prior canonical and delete the duplicate occurrence only when duplicateOccurrenceCreated=true",
                "remove canonical only from the recorded incomingReferenceSources and canonicalOutgoingAdded entries",
                "restore canonical identity, plan and reference fields only when they still equal canonical.applied",
                "restore loser lifecycle, admission, condition, plan, references and admissionReview from prior; then remove admissionMerge"
              ],
              "schemaVersion": 1,
              "transactionRequired": true,
              "compareAppliedStateBeforeRestore": true
            }
          },
          "admissionReview": {
            "alert": {
              "key": "work-item-admission-review-debt",
              "state": "cleared",
              "reason": "review completed",
              "emittedAt": "2026-11-06T14:43:44.439-05:00"
            },
            "state": "terminal",
            "enteredAt": "2026-11-05T23:51:34.764-05:00",
            "retryOwner": "system:work-item-admission-promoter",
            "reviewedAt": "2026-11-06T14:43:44.439-05:00",
            "reviewedBy": "system:work-item-admission-promoter",
            "terminalAt": "2026-11-06T14:43:44.439-05:00",
            "lastRetryAt": "2026-11-06T14:43:44.439-05:00",
            "reviewDueAt": "2026-11-06T00:51:34.764-05:00",
            "retryAttempts": 1,
            "terminalOutcome": "duplicate-merge"
          },
          "admissionFailOpen": {
            "at": "2026-11-05T23:51:34.764-05:00",
            "actor": "system:work-item-admission-fail-open",
            "runId": "sched-.routinesTick-2026-11-06T04:51:30.000Z-17",
            "scope": "workspace",
            "reason": "pending-age-exceeded-two-promoter-ticks"
          },
          "admissionIdentity": {
            "titleKey": "title:adaptive asserts batching calls discovery hint independent tool were",
            "schemaVersion": "admission-identity-v1"
          },
          "freshnessEnvelope": {
            "observedAt": "2026-11-06T01:04:53.748Z",
            "linkedFixRefs": [],
            "reporterSession": "su-6658849f-658a-4320-a483-43f2693dbcfb",
            "observedSourceSha": "d740fc3802",
            "toolSchemaVersion": null,
            "observedRuntimeSha": "d740fc3802",
            "deployBuildIdentity": "d740fc3802@0.0.0",
            "reporterRuntimeVersion": "0.0.0",
            "lastSuccessfulReproductionAt": null
          },
          "implementationReadiness": {
            "reason": "existing-immediate-capture-policy",
            "source": "capture-policy",
            "status": "ready",
            "updatedAt": "2026-11-06T01:04:53.748Z",
            "schemaVersion": "implementation-readiness-v1"
          }
        },
        "conditionKey": null
      },
      "target": {
        "title": "Batch hint recommends Promise.all for dependent discovery, evidence read and checkpoint mutation",
        "summary": "Observed in this session's loop:checkpoint response after checkpoint hash1ce9e800d4fb: the batch-hint proposes Promise.all([tools.tools.find({query:'activity:tool-log'}), tools.activity.toolLog({owner:su-3d698393-84ec-4c0a-97a1-ab64ee949dfb,since:'2026-10-24T02:32:10Z',until:'2026-10-24T02:34:26Z'}), tools.loop.checkpoint({...})]). These were sequential for actual dependencies: discovery supplied the tool schema, the ledger result established the statement written into the checkpoint, and checkpoint expectedHash protects an ordered mutation. The recommendation infers independence from known arguments and separate tool names, which does not establish independence. Similar hints in the preceding turn grouped repeated CAS checkpoint writes with different expectedHash values. No suggested parallel replay was executed. Specific fix: avoid claiming calls are independent by construction; preserve observed order in generated recipes whenever discovery or mutations are present, and use sequential awaits by default unless independence is positively established. Add a maintained regression using find->read->CAS-checkpoint and successive expectedHash writes. This is feedback-advice correctness, not failure of the underlying successful tool handlers.",
        "status": "open",
        "duplicate_of": null,
        "payload": {
          "_ei": {
            "scope": "harness:papercusp",
            "source": "su",
            "severity": "minor",
            "created_by": "su-3d698393-84ec-4c0a-97a1-ab64ee949dfb",
            "found_during": "WI-10007833",
            "signal_origin": "organic"
          },
          "filedByRole": "su",
          "dedupCoverage": {
            "lexical": "ok",
            "degraded": false,
            "rescreen": {
              "at": "2026-10-24T07:57:56.866Z",
              "by": "admission-fail-open:dedup-rescreen",
              "atMs": 1792828676866,
              "prior": {
                "lexical": "unavailable",
                "degraded": true,
                "semantic": "ok"
              },
              "runId": "sched-.routinesTick-2026-10-24T07:45:30.000Z-37",
              "outcome": "clean",
              "attempts": 3
            },
            "semantic": "ok"
          },
          "ideaLifecycle": {
            "state": "open",
            "stateUpdatedAt": "2026-10-24T02:47:20.265Z"
          },
          "admissionReview": {
            "alert": {
              "key": "work-item-admission-review-debt",
              "state": "open",
              "reason": "pending fail-open admission requires re-review",
              "emittedAt": "2026-10-24T03:57:48.596-04:00"
            },
            "state": "pending",
            "enteredAt": "2026-10-24T03:57:48.596-04:00",
            "retryOwner": "system:work-item-admission-promoter",
            "reviewedAt": null,
            "reviewedBy": null,
            "terminalAt": null,
            "lastRetryAt": null,
            "reviewDueAt": "2026-10-24T04:57:48.596-04:00",
            "retryAttempts": 0,
            "terminalOutcome": null
          },
          "admissionFailOpen": {
            "at": "2026-10-24T03:57:48.596-04:00",
            "actor": "system:work-item-admission-fail-open",
            "runId": "sched-.routinesTick-2026-10-24T07:45:30.000Z-37",
            "scope": "workspace",
            "reason": "pending-age-exceeded-two-promoter-ticks"
          },
          "admissionIdentity": {
            "titleKey": "title:all and batch checkpoint dependent discovery evidence for hint mutation promise read recommends",
            "schemaVersion": "admission-identity-v1"
          },
          "freshnessEnvelope": {
            "observedAt": "2026-10-24T02:47:20.265Z",
            "linkedFixRefs": [],
            "reporterSession": "su-3d698393-84ec-4c0a-97a1-ab64ee949dfb",
            "observedSourceSha": "d740fc3802",
            "toolSchemaVersion": null,
            "observedRuntimeSha": "d740fc3802",
            "deployBuildIdentity": "d740fc3802@0.0.0",
            "reporterRuntimeVersion": "0.0.0",
            "lastSuccessfulReproductionAt": null
          },
          "admissionMergeSources": [
            {
              "actor": "system:work-item-admission-promoter",
              "runId": "sched-.routinesTick-2026-11-06T19:34:00.000Z-3",
              "loserId": "EI-27998545512823414",
              "mergedAtMs": 1793994224439,
              "schemaVersion": 1
            }
          ],
          "implementationReadiness": {
            "reason": "existing-immediate-capture-policy",
            "source": "capture-policy",
            "status": "ready",
            "updatedAt": "2026-10-24T02:47:20.265Z",
            "schemaVersion": "implementation-readiness-v1"
          }
        },
        "conditionKey": null
      },
      "finalR1Disposition": "OPEN",
      "timeBoundary": "Original report retained in terminal92 raw capture, later target snapshot at 2026-11-08T15:48:45.116Z; source witnesses captured in this qualification. No inferred original-time availability or loaded runtime."
    },
    {
      "originalId": "EI-28004330173230754",
      "targetId": "EI-27734089080741819",
      "classification": "different-specific-scope-own-noaction-not-independent",
      "qualification": "Target is required acceptance recovery after no_qualified_responder, while source closure claims expected conjunctive all-explicit-anchor filtering. Those propositions can coexist. Persisted consult snapshots/candidate turns were not independently recovered in this unit; focused unit test is not the unmeasured all-anchors integration. Own noaction explanation remains qualified/unverified and is not broader recovery fix.",
      "original": {
        "title": "Rubric-vetting qualification repeatedly returns evidence_unavailable for retrievable exact-topic critic refs",
        "summary": "Suspected routing/qualification degradation; root cause UNCONFIRMED. On WI-10005218, exact current rubric acceptance-gate-test-reuse-yield-2026-10-01@9/hash a45bd37ced87686aa7ff57620a25d0c9e2a7570cedd6e54fcb88e5265a4fa6fa required re-vetting. Canonical consult conv-request-593c2bea26d84517f16515e6b042ff8d327d9e62f914533c0dd03c57aa86a5d2 ended no_qualified_responder/relevance_unmeasured/reason=evidence_unavailable. Its unmeasured candidate source session_turn:claude:3d04fffe-67ba-44ed-93f0-9dc4ce24f99a:79..81 was then read successfully: critic explicitly names both subject refs and diagnoses prior BARs; rubrics:check-approver for su-b299f72e-8a2c-481d-ab60-c94aa89b38d1 with applier su-63ce5 returns eligible=true. A follow-up supplying these fresh source and lineage checks through the parent chain (conv-request-3e21c2ca81caa6967e08af391aab1b7b6611fb3da3ce191139f547fe03c01457) again ended same unmeasured outcome, zero dispatch, zero replies, with different unmeasured critic refs. This is NOT proof experts are absent or a backend quota wall. One cheap bounded dedup search found related done embed/citation records but no exact matching active result in returned sample. Diagnose per-candidate evidence read failures/budget attribution; consider a canonical qualification continuation that reuses independently readable cited spans plus the same topic/independence checks. Keep unknown unknown; do not dispatch merely from caller prose or lineage eligibility alone. Regression guard should exercise exact-topic critic qualification when bounded evidence retrieval is unavailable and verify recoverable qualification evidence/refusal details. Evidence checkpoint WI-10005218/886d0711aca2; no code fix claimed.",
        "status": "dropped",
        "duplicate_of": "EI-27734089080741819",
        "payload": {
          "_ei": {
            "scope": "harness:papercusp",
            "source": "su",
            "severity": "major",
            "created_by": "su-63ce5d5b-7c4f-41a3-962d-fdd109ff4c09",
            "signal_origin": "organic"
          },
          "reporter": {
            "at": "2026-11-06T02:36:46.905Z",
            "id": "su-63ce5d5b-7c4f-41a3-962d-fdd109ff4c09",
            "kind": "agent",
            "basis": "agent-session"
          },
          "filedByRole": "su",
          "_assumptions": {
            "declared": "none",
            "resolvedAt": "2026-11-07T14:56:26.342Z"
          },
          "dedupCoverage": {
            "lexical": "ok",
            "degraded": true,
            "semantic": "partial"
          },
          "ideaLifecycle": {
            "state": "open",
            "stateUpdatedAt": "2026-11-06T02:36:50.316Z"
          },
          "reportContext": {
            "app": "papercusp",
            "screen": null,
            "refused": [],
            "truncated": [],
            "appVersion": "0.0.0+3fec47fb7d",
            "capturedAt": "2026-11-06T02:36:46.905Z",
            "logExcerpt": null,
            "screenshot": null,
            "autoCaptured": [
              "app",
              "appVersion"
            ],
            "recentErrors": [],
            "schemaVersion": 1
          },
          "reporterKinds": [
            "agent"
          ],
          "dedupCandidates": [
            {
              "id": "EI-27734089080741819",
              "method": "semantic-soft",
              "similarity": 0.91
            },
            {
              "id": "WI-10006022",
              "method": "semantic-soft",
              "similarity": 0.9
            }
          ],
          "admissionIdentity": {
            "titleKey": "title:critic evidence exact for qualification refs repeatedly retrievable returns rubric topic unavailable vetting",
            "schemaVersion": "admission-identity-v1"
          },
          "freshnessEnvelope": {
            "observedAt": "2026-11-06T02:36:50.318Z",
            "linkedFixRefs": [],
            "reporterSession": "su-63ce5d5b-7c4f-41a3-962d-fdd109ff4c09",
            "observedSourceSha": "3fec47fb7d",
            "toolSchemaVersion": null,
            "observedRuntimeSha": "3fec47fb7d",
            "deployBuildIdentity": "3fec47fb7d@0.0.0",
            "reporterRuntimeVersion": "0.0.0",
            "lastSuccessfulReproductionAt": null
          },
          "_completionEvidence": {
            "summary": "Closed as an expected fail-closed outcome, not a reproduced router defect. Both consult requests explicitly required exact support for the plan slug and rubric slug. The persisted candidate evidence contains exact rubric-slug anchors but no exact plan-slug anchors, so the router correctly left qualification unmeasured. No code changed. A durable Papercusp guard rail now records the all-explicit-refs rule.",
            "coverage": {
              "checked": [
                "Persisted routing snapshots for the two named rubric-vetting consults",
                "Saved candidate transcript evidence turns included in the exact-boundary census",
                "Router explicit-ref qualification and exact-anchor implementation",
                "Focused router unit run 23547190"
              ],
              "residue": [],
              "notChecked": [
                "Focused all-anchors PG integration execution on this host"
              ],
              "population": [
                "Persisted routing snapshots for the two named rubric-vetting consults",
                "Saved candidate transcript evidence turns included in the exact-boundary census",
                "Router explicit-ref qualification and exact-anchor implementation",
                "Focused router unit run 23547190",
                "Focused all-anchors PG integration execution on this host"
              ],
              "notApplicable": []
            },
            "testsRun": "Passed focused unit run: packages/operator-core/lib/consult/relevance-router.test.ts, testNamePattern 'keeps measured peer evidence when another passage cannot be scored' (runId dc1fbd7e-9d8a-42af-a2ae-5a82a07ed1b8; ledger row 23547190; 1 passed, 0 failed, 57 skipped). The exact all-anchors integration case was attempted twice but not measured: first attempt stopped before Vitest because dockerd could not attach a veth to missing docker0; second hit the foreground cap, then its detached task ended_unobserved without a test verdict.",
            "treeStamp": {
              "headSha": "e5fa5276e5417c7a7910776709419b171adb2906",
              "repositoryRoot": "/home/marsh-office/papercupai-workspace/papercusp"
            },
            "testResult": "Focused unit test passed. Integration regression remains unmeasured due the host Docker bridge failure; neither attempt is counted as a test failure or pass.",
            "verifiedHow": "Read both persisted consult_state routing snapshots, the exact subjectRefs and subjectValidation scoring/failure fields, and saved candidate session_turn evidence. An exact-boundary census found zero matches for gate-test-reuse-yield-2026-10-01 in the inspected candidate turns and matches for acceptance-gate-test-reuse-yield-2026-10-01. The scorer phase recorded for the rubric ref returned; no scorer failure was recorded. Read the router's exact-anchor filter and existing every-resolved-anchor integration guard. Confirmed Docker's bridge network declares docker0 while the host interface is absent, and dockerd logged 'Failed to add veth ... to bridge via netlink: Device does not exist'.",
            "rootCauseVerification": {
              "hypothesis": "The consultations stayed unmeasured because the caller supplied two conjunctive explicit source refs, while the candidate transcript evidence supported the full rubric slug but not the separately supplied plan slug. The router correctly refused to qualify candidates without evidence for every ref.",
              "testResult": "The short plan ref had zero exact-boundary matches in the inspected saved candidate evidence; the full rubric ref had matches. The route recorded a returned scoring phase for the rubric subject with 8 passages and no scorer failure entry. The scorer's numeric outcomes for those passages are not retained here, so this does not exclude a tie for the rubric ref; the missing required plan anchor alone explains why no candidate could satisfy both explicit refs.",
              "evidenceRefs": [
                "conv-request-593c2bea26d84517f16515e6b042ff8d327d9e62f914533c0dd03c57aa86a5d2",
                "conv-request-3e21c2ca81caa6967e08af391aab1b7b6611fb3da3ce191139f547fe03c01457",
                "session_turn:claude:3d04fffe-67ba-44ed-93f0-9dc4ce24f99a:79",
                "session_turn:claude:3d04fffe-67ba-44ed-93f0-9dc4ce24f99a:81",
                "testing:runs:23547190",
                "testing:run-status:de0fa517-3348-4295-a0ae-983286167238"
              ],
              "testProcedure": "For both conversation IDs, read harness_shared.consult_state.routing.subjectRefs, subjectValidation.scoring and failures; expand the persisted candidate evidence turns by owner/session_id/turn_idx; apply the same exact boundary used by hasExactSubjectMention to each supplied ref.",
              "contractVersion": 2,
              "actualObservation": "Across the saved evidence rows for the two consults, the exact plan ref matched 0 turns and the rubric ref matched the cited critic turns. subjectValidation.scoring contains a returned rubric-scoring phase (8 passages); subjectValidation.failures is absent. This supports the required-ref explanation and does not establish the numeric reason the rubric comparison itself remained unmeasured.",
              "distinguishingTest": "Compare each consult's persisted explicit refs and subject-scoring diagnostics with exact-boundary matches in the saved candidate transcript turns.",
              "alternativeHypothesis": "A scorer or retrieval failure prevented measurement even though the candidates had transcript passages with exact anchors for both explicit refs.",
              "predictedObservations": {
                "hypothesis": "Candidate turns may match the rubric ref, but no candidate has exact transcript support for the separately supplied plan ref; qualification remains unmeasured without a scorer failure for that missing anchor.",
                "alternativeHypothesis": "Candidate turns match both explicit refs, while diagnostics show a scorer error, invalid score shape, timeout, or retrieval failure that prevents evaluation."
              }
            }
          },
          "_claimSubjectBaseline": {
            "body": "Suspected routing/qualification degradation; root cause UNCONFIRMED. On WI-10005218, exact current rubric acceptance-gate-test-reuse-yield-2026-10-01@9/hash a45bd37ced87686aa7ff57620a25d0c9e2a7570cedd6e54fcb88e5265a4fa6fa required re-vetting. Canonical consult conv-request-593c2bea26d84517f16515e6b042ff8d327d9e62f914533c0dd03c57aa86a5d2 ended no_qualified_responder/relevance_unmeasured/reason=evidence_unavailable. Its unmeasured candidate source session_turn:claude:3d04fffe-67ba-44ed-93f0-9dc4ce24f99a:79..81 was then read successfully: critic explicitly names both subject refs and diagnoses prior BARs; rubrics:check-approver for su-b299f72e-8a2c-481d-ab60-c94aa89b38d1 with applier su-63ce5 returns eligible=true. A follow-up supplying these fresh source and lineage checks through the parent chain (conv-request-3e21c2ca81caa6967e08af391aab1b7b6611fb3da3ce191139f547fe03c01457) again ended same unmeasured outcome, zero dispatch, zero replies, with different unmeasured critic refs. This is NOT proof experts are absent or a backend quota wall. One cheap bounded dedup search found related done embed/citation records but no exact matching active result in returned sample. Diagnose per-candidate evidence read failures/budget attribution; consider a canonical qualification continuation that reuses independently readable cited spans plus the same topic/independence checks. Keep unknown unknown; do not dispatch merely from caller prose or lineage eligibility alone. Regression guard should exercise exact-topic critic qualification when bounded evidence retrieval is unavailable and verify recoverable qualification evidence/refusal details. Evidence checkpoint WI-10005218/886d0711aca2; no code fix claimed.",
            "kind": "bug",
            "title": "Rubric-vetting qualification repeatedly returns evidence_unavailable for retrievable exact-topic critic refs",
            "summary": "Suspected routing/qualification degradation; root cause UNCONFIRMED. On WI-10005218, exact current rubric acceptance-gate-test-reuse-yield-2026-10-01@9/hash a45bd37ced87686aa7ff57620a25d0c9e2a7570cedd6e54fcb88e5265a4fa6fa required re-vetting. Canonical consult conv-request-593c2bea26d84517f16515e6b042ff8d327d9e62f914533c0dd03c57aa86a5d2 ended no_qualified_responder/relevance_unmeasured/reason=evidence_unavailable. Its unmeasured candidate source session_turn:claude:3d04fffe-67ba-44ed-93f0-9dc4ce24f99a:79..81 was then read successfully: critic explicitly names both subject refs and diagnoses prior BARs; rubrics:check-approver for su-b299f72e-8a2c-481d-ab60-c94aa89b38d1 with applier su-63ce5 returns eligible=true. A follow-up supplying these fresh source and lineage checks through the parent chain (conv-request-3e21c2ca81caa6967e08af391aab1b7b6611fb3da3ce191139f547fe03c01457) again ended same unmeasured outcome, zero dispatch, zero replies, with different unmeasured critic refs. This is NOT proof experts are absent or a backend quota wall. One cheap bounded dedup search found related done embed/citation records but no exact matching active result in returned sample. Diagnose per-candidate evidence read failures/budget attribution; consider a canonical qualification continuation that reuses independently readable cited spans plus the same topic/independence checks. Keep unknown unknown; do not dispatch merely from caller prose or lineage eligibility alone. Regression guard should exercise exact-topic critic qualification when bounded evidence retrieval is unavailable and verify recoverable qualification evidence/refusal details. Evidence checkpoint WI-10005218/886d0711aca2; no code fix claimed.",
            "watchdogKey": null
          },
          "claim_history_post_id": 9001788375295,
          "implementationReadiness": {
            "reason": "existing-immediate-capture-policy",
            "source": "capture-policy",
            "status": "ready",
            "updatedAt": "2026-11-06T02:36:50.318Z",
            "schemaVersion": "implementation-readiness-v1"
          }
        },
        "conditionKey": null
      },
      "target": {
        "title": "Required current acceptance critique has no recovery after no_qualified_responder",
        "summary": "Suspected capability gap observed while owning P001/WI-6554700010028547, bg-host-committed-generation-2026-10-24, after independently approved D017/current rubric13/plan23. Current BAR critique conv-request-5d70edd6544c9f2df55586b0642f98a62645548cf311bbebfcae3f91f5f80c1d returned terminal no_qualified_responder/evidence_unavailable/relevance_unmeasured with remaining_candidates:[], no answering session and no candidate evidence refs to inspect. Separate required rubric-vetting conv-request-a83c4bc005dad0e2002ce2b7fb52b9897a5b354d8fb385d26fd153b42ca3a64b returned terminal below_floor with remaining_candidates:[], no answering session. The hint says proceed on own judgment or inspect candidates, but current execution/acceptance requires independent current critique; self-assessment cannot satisfy that gate. No waiting predicate exists because both are terminal. Upstream evidence-unavailable cause remains UNKNOWN; below-floor refusal itself is not evidence that relevance screening is wrong. Concrete proposed recovery: extend/reuse the EXISTING system:acceptance-bar-amendment-review fresh outside-lineage, full-source, revision/hash-pinned review fallback for required BAR/rubric critique (or route into the existing pullable review work-item conversion). Preserve independence and the evidence floor; do not manually pick a peer, weaken eligibility, or count the author's own answer. Return actual failed evidence references on relevance_unmeasured. Existing canonical amendment fallback succeeded on this exact subject: reviewer78ff posted authenticated1213313 accepting patch+SOURCE-only packet; appliedD017 proof saved/readbackEXACT papercusp:evidence/bg-host-r1-original-source-authority-applied-20261103.json. Current failure artifacts: /tmp/luna-r13-first-critique-status-20261103.json and /tmp/luna-r13-vetting-terminal-status-20261103.json. File only; no third claim (owner cap2), no implementation workers, no live gate work.\n\nⓘ Possible STALE RUNTIME, not an open defect: `packages/operator-core/lib/consult/get-feedback-core.ts` (96 newer commits, tip `86b9b6fbd4b7a48b2804b90784ef2465d9e4abd4`), `packages/operator-core/lib/acceptance-rubric-critique.ts` (4 newer commits, tip `a851d02560eb7c133d662b5a5a4d2f07e3e43906`) have commits newer than the running build (`d740fc3802`) in `staging`. If this was observed live, verify the deployed generation before triaging; the behavior may already be fixed in the tree.",
        "status": "blocked",
        "duplicate_of": null,
        "payload": {
          "_ei": {
            "scope": "harness:papercusp",
            "source": "su",
            "severity": "major",
            "created_by": "su-1b1c4d3e-d960-4de6-935e-95e776b84f58",
            "found_during": "WI-6554700010028547",
            "signal_origin": "organic"
          },
          "paths": [
            "packages/operator-core/lib/consult/get-feedback-core.ts",
            "packages/operator-core/lib/acceptance-rubric-critique.ts",
            "packages/operator-core/lib/consult/get-feedback-core.integration.test.ts"
          ],
          "filedByRole": "su",
          "dedupCoverage": {
            "lexical": "unavailable",
            "degraded": true,
            "rescreen": {
              "at": "2026-11-03T06:50:41.939Z",
              "by": "admission-fail-open:dedup-rescreen",
              "atMs": 1793688641939,
              "prior": {
                "lexical": "unavailable",
                "degraded": true,
                "semantic": "unavailable"
              },
              "runId": "sched-.routinesTick-2026-11-03T06:49:30.000Z-11",
              "outcome": "degraded",
              "attempts": 3
            },
            "semantic": "unavailable"
          },
          "ideaLifecycle": {
            "state": "triaged",
            "ideaType": "code-bug",
            "triagedAt": "2026-11-04T17:00:18.578Z",
            "triageReason": "code-bug, policy tier=auto (no protected path/keyword → AUTO-eligible (still gated by blueprint + tests + release-manager)) — auto-implement lane (D-003: one verdict chain)",
            "stateUpdatedAt": "2026-11-04T17:00:18.578Z",
            "triageDecision": "place"
          },
          "admissionReview": {
            "alert": {
              "key": "work-item-admission-review-debt",
              "state": "cleared",
              "reason": "review completed",
              "emittedAt": "2026-11-05T22:40:51.825-05:00"
            },
            "state": "reviewed",
            "enteredAt": "2026-11-03T01:50:20.985-05:00",
            "retryOwner": "system:work-item-admission-promoter",
            "reviewedAt": "2026-11-05T22:40:51.825-05:00",
            "reviewedBy": "system:work-item-admission-promoter",
            "terminalAt": null,
            "lastRetryAt": "2026-11-05T22:40:51.825-05:00",
            "reviewDueAt": "2026-11-03T02:50:20.985-05:00",
            "retryAttempts": 1,
            "terminalOutcome": null
          },
          "externalBlockers": [
            {
              "ref": "work-item-admission-promoter:componentScreening:EI-27734089080741819",
              "kind": "gate",
              "status": "active",
              "summary": "Waiting for a completed ordinary componentScreening to select this exact target; the latest completed screen selected no items.",
              "evidence": "Promoter run sched-.routinesTick-2026-11-07T03:35:30.000Z-7 completed at 03:48:54Z with componentScreening.itemIds=[]. work_items:get shows _admissionRecovery state=held, stage=screen, pickupConfirmed=false, and its recorded outside-mutation-scope reason authorizes no component writes.",
              "nextVerb": "Read the next completed ordinary componentScreening receipt; if selected, re-read all three payload-path authorities before any test or edit.",
              "createdAt": "2026-11-07T04:04:34.855Z",
              "createdBy": "su-20ba0d4b-371b-4859-831b-e587ec2649f9",
              "recheckAt": "2026-11-08T16:23:20.670Z",
              "updatedAt": "2026-11-08T15:23:20.670Z",
              "capability": "live-dependency",
              "recheckedAt": "2026-11-08T15:23:20.670Z",
              "reachability": {
                "basis": "unmeasured",
                "verdict": "unknown",
                "evidence": "trigger \"work-item-admission-promoter:componentScreening:EI-27734089080741819\" may wake a consumer but cannot establish the specific release condition; subject-bound evidence is required",
                "checkedAt": "2026-11-08T15:27:13.768Z",
                "authoritative": false,
                "uncertifiedReason": "uncatalogued"
              },
              "recheckSource": "system:unprovable-wait-backfill",
              "capabilitySource": "explicit",
              "recheckDisposition": "escalated"
            }
          ],
          "admissionFailOpen": {
            "at": "2026-11-03T01:50:20.985-05:00",
            "actor": "system:work-item-admission-fail-open",
            "runId": "sched-.routinesTick-2026-11-03T06:49:30.000Z-11",
            "scope": "workspace",
            "reason": "pending-age-exceeded-two-promoter-ticks"
          },
          "admissionIdentity": {
            "titleKey": "title:acceptance after critique current has qualified recovery required responder",
            "schemaVersion": "admission-identity-v1"
          },
          "freshnessEnvelope": {
            "observedAt": "2026-11-03T03:01:28.386Z",
            "linkedFixRefs": [],
            "reporterSession": "su-1b1c4d3e-d960-4de6-935e-95e776b84f58",
            "observedSourceSha": "d740fc3802",
            "toolSchemaVersion": null,
            "observedRuntimeSha": "d740fc3802",
            "deployBuildIdentity": "d740fc3802@0.0.0",
            "reporterRuntimeVersion": "0.0.0",
            "lastSuccessfulReproductionAt": null
          },
          "_admissionRecovery": {
            "note": "Resume the original Luna required-review infrastructure blocker EI-27734089080741819 through canonical admission screening, then assign to this same session. Preserve cap2/self, P001 acceptance gate, independent reviewer eligibility and all duplicate safeguards. No replacement item or forced claim.",
            "stage": "screen",
            "state": "held",
            "caller": "su-1b1c4d3e-d960-4de6-935e-95e776b84f58",
            "reason": "screening left the original item pending (admission guard from run d4be2d52-6be9-4010-9b9a-7b6686f6459a:recovery:EI-27734089080741819: outside-mutation-scope: screened component requires mutations outside the exact target set; no component writes authorized); use the ordinary component screening/review route, then retry this same item within its authorized scope",
            "target": "su-1b1c4d3e-d960-4de6-935e-95e776b84f58",
            "version": 3,
            "authority": {
              "kind": "superuser",
              "role": "operator",
              "context": {
                "runId": "72ee1542-54cb-4904-9b7d-2eaae3e9fffa",
                "chunkId": null,
                "profile": "engineer",
                "spawnId": "ephemeral-a36b80c60e64039a",
                "featureId": null,
                "transport": "mcp",
                "harnessSlug": "papercusp",
                "workspaceId": "papercusp-workspace",
                "advSessionId": 51689,
                "parentSpawnId": null,
                "planRunSessionId": null
              },
              "credentialSha256": "617161bfe56568790b72c2c7b33c0e98d2a43a1a08c3cc82f079fc14c72c9bb1"
            },
            "requestId": "9375d1df-39fc-4211-89a8-5e51dc5651ef",
            "routineId": "rt_papercusp_work_item_admission_promoter",
            "signature": "75b982b442d47886f4d3ad828d7d851096d81789f63a947ca1e52675e087abb3",
            "updatedAt": "2026-11-03T04:49:39.433Z",
            "requestedAt": "2026-11-03T04:37:23.924Z",
            "pickupConfirmed": false
          },
          "_claimSubjectBaseline": {
            "body": "Suspected capability gap observed while owning P001/WI-6554700010028547, bg-host-committed-generation-2026-10-24, after independently approved D017/current rubric13/plan23. Current BAR critique conv-request-5d70edd6544c9f2df55586b0642f98a62645548cf311bbebfcae3f91f5f80c1d returned terminal no_qualified_responder/evidence_unavailable/relevance_unmeasured with remaining_candidates:[], no answering session and no candidate evidence refs to inspect. Separate required rubric-vetting conv-request-a83c4bc005dad0e2002ce2b7fb52b9897a5b354d8fb385d26fd153b42ca3a64b returned terminal below_floor with remaining_candidates:[], no answering session. The hint says proceed on own judgment or inspect candidates, but current execution/acceptance requires independent current critique; self-assessment cannot satisfy that gate. No waiting predicate exists because both are terminal. Upstream evidence-unavailable cause remains UNKNOWN; below-floor refusal itself is not evidence that relevance screening is wrong. Concrete proposed recovery: extend/reuse the EXISTING system:acceptance-bar-amendment-review fresh outside-lineage, full-source, revision/hash-pinned review fallback for required BAR/rubric critique (or route into the existing pullable review work-item conversion). Preserve independence and the evidence floor; do not manually pick a peer, weaken eligibility, or count the author's own answer. Return actual failed evidence references on relevance_unmeasured. Existing canonical amendment fallback succeeded on this exact subject: reviewer78ff posted authenticated1213313 accepting patch+SOURCE-only packet; appliedD017 proof saved/readbackEXACT papercusp:evidence/bg-host-r1-original-source-authority-applied-20261103.json. Current failure artifacts: /tmp/luna-r13-first-critique-status-20261103.json and /tmp/luna-r13-vetting-terminal-status-20261103.json. File only; no third claim (owner cap2), no implementation workers, no live gate work.\n\nⓘ Possible STALE RUNTIME, not an open defect: `packages/operator-core/lib/consult/get-feedback-core.ts` (96 newer commits, tip `86b9b6fbd4b7a48b2804b90784ef2465d9e4abd4`), `packages/operator-core/lib/acceptance-rubric-critique.ts` (4 newer commits, tip `a851d02560eb7c133d662b5a5a4d2f07e3e43906`) have commits newer than the running build (`d740fc3802`) in `staging`. If this was observed live, verify the deployed generation before triaging; the behavior may already be fixed in the tree.",
            "kind": "bug",
            "title": "Required current acceptance critique has no recovery after no_qualified_responder",
            "summary": "Suspected capability gap observed while owning P001/WI-6554700010028547, bg-host-committed-generation-2026-10-24, after independently approved D017/current rubric13/plan23. Current BAR critique conv-request-5d70edd6544c9f2df55586b0642f98a62645548cf311bbebfcae3f91f5f80c1d returned terminal no_qualified_responder/evidence_unavailable/relevance_unmeasured with remaining_candidates:[], no answering session and no candidate evidence refs to inspect. Separate required rubric-vetting conv-request-a83c4bc005dad0e2002ce2b7fb52b9897a5b354d8fb385d26fd153b42ca3a64b returned terminal below_floor with remaining_candidates:[], no answering session. The hint says proceed on own judgment or inspect candidates, but current execution/acceptance requires independent current critique; self-assessment cannot satisfy that gate. No waiting predicate exists because both are terminal. Upstream evidence-unavailable cause remains UNKNOWN; below-floor refusal itself is not evidence that relevance screening is wrong. Concrete proposed recovery: extend/reuse the EXISTING system:acceptance-bar-amendment-review fresh outside-lineage, full-source, revision/hash-pinned review fallback for required BAR/rubric critique (or route into the existing pullable review work-item conversion). Preserve independence and the evidence floor; do not manually pick a peer, weaken eligibility, or count the author's own answer. Return actual failed evidence references on relevance_unmeasured. Existing canonical amendment fallback succeeded on this exact subject: reviewer78ff posted authenticated1213313 accepting patch+SOURCE-only packet; appliedD017 proof saved/readbackEXACT papercusp:evidence/bg-host-r1-original-source-authority-applied-20261103.json. Current failure artifacts: /tmp/luna-r13-first-critique-status-20261103.json and /tmp/luna-r13-vetting-terminal-status-20261103.json. File only; no third claim (owner cap2), no implementation workers, no live gate work.\n\nⓘ Possible STALE RUNTIME, not an open defect: `packages/operator-core/lib/consult/get-feedback-core.ts` (96 newer commits, tip `86b9b6fbd4b7a48b2804b90784ef2465d9e4abd4`), `packages/operator-core/lib/acceptance-rubric-critique.ts` (4 newer commits, tip `a851d02560eb7c133d662b5a5a4d2f07e3e43906`) have commits newer than the running build (`d740fc3802`) in `staging`. If this was observed live, verify the deployed generation before triaging; the behavior may already be fixed in the tree.",
            "watchdogKey": null
          },
          "claim_history_post_id": 9001788375295,
          "implementationReadiness": {
            "reason": "existing-immediate-capture-policy",
            "source": "capture-policy",
            "status": "ready",
            "updatedAt": "2026-11-03T03:01:28.386Z",
            "schemaVersion": "implementation-readiness-v1"
          }
        },
        "conditionKey": null
      },
      "finalR1Disposition": "OPEN",
      "timeBoundary": "Original report retained in terminal92 raw capture, later target snapshot at 2026-11-08T15:48:45.116Z; source witnesses captured in this qualification. No inferred original-time availability or loaded runtime."
    },
    {
      "originalId": "EI-28004955265251225",
      "targetId": "EI-27730562695092492",
      "classification": "same-specific-symptom-source-and-ledger-supported",
      "qualification": "Both declaration/claim paths mint issue siblings for promoted features. Exact saved row23502654 has40passes0fail0skip including source_plan-only feature reuse and ambiguous mapping refusal. Read committed bd59 convert and tests; source-only fixture asserts resumed originalID/no create and ambiguous fixture refuses/no create. Ledger dirty due HEAD move; retains source-level current-build proof, no historical production/released-runtime proof or mutation control.",
      "original": {
        "title": "coord declare-intent P002 created a second held work-item beside canonical plan-line feature",
        "summary": "Observed during discovery-before-implementation-review-2026-11-05. Canonical P002 feature WI-6554700010045670 was successfully claimed byID at02:18:26Z. Then coord:declare-intent with current_plan_slug and items[P001,P002] at02:20:05Z returned claimedP002, alreadyHeldP001. At compaction flush, platform required missing checkpoint WI-6554700010045740, whose authoritative work_items:get shows task/issue held by same su-bd7bb, created02:20:05.538Z, sourcePlanSlug same plan/sourcePlanItemIds[P002], identical scope, payload.plan_item old-style stamp. Canonical WI5670 remains separately held. This suggests old-runtime claim fallback minted a duplicate instead of resolving the existing canonical plan-line node; exact root cause unverified. Both have checkpoints pointing to WI5670 current implementation. Preserve existing claims/evidence and use canonical identity rather than create on mismatch. No terminal/dedup action taken. Evidence current transcript coord declaration/get receipts and WI5740 checkpoint. Discovered solely through session:request-compaction flush-required, not a new task mission.",
        "status": "done",
        "duplicate_of": "EI-27730562695092492",
        "payload": {
          "_ei": {
            "scope": "harness:papercusp",
            "source": "su",
            "severity": "major",
            "created_by": "su-bd7bb60b-f269-4533-95f8-a01a37d59f27",
            "signal_origin": "organic"
          },
          "filedByRole": "su",
          "_assumptions": {
            "declared": "none",
            "resolvedAt": "2026-11-07T16:14:52.365Z"
          },
          "dedupVerdict": "likely-duplicate",
          "dedupCoverage": {
            "lexical": "unavailable",
            "degraded": true,
            "semantic": "ok"
          },
          "ideaLifecycle": {
            "state": "open",
            "stateUpdatedAt": "2026-11-06T02:46:46.562Z"
          },
          "dedupCandidates": [
            {
              "id": "EI-27661933222057712",
              "method": "semantic-hard",
              "similarity": 0.91
            },
            {
              "id": "EI-27730562695092492",
              "method": "semantic-soft",
              "similarity": 0.91
            }
          ],
          "admissionIdentity": {
            "titleKey": "title:beside canonical coord created declare feature held intent item line p002 plan second work",
            "schemaVersion": "admission-identity-v1"
          },
          "freshnessEnvelope": {
            "observedAt": "2026-11-06T02:46:46.563Z",
            "linkedFixRefs": [],
            "reporterSession": "su-bd7bb60b-f269-4533-95f8-a01a37d59f27",
            "observedSourceSha": "d740fc3802",
            "toolSchemaVersion": null,
            "observedRuntimeSha": "d740fc3802",
            "deployBuildIdentity": "d740fc3802@0.0.0",
            "reporterRuntimeVersion": "0.0.0",
            "lastSuccessfulReproductionAt": null
          },
          "_completionEvidence": {
            "summary": "Duplicate of EI-27730562695092492: the P-002 promoted-feature converter identity gap explains this pre-fix duplicate. The duplicate sibling is dropped and the canonical feature remains open. This is a no-code-change disposition; it does not claim shipment.",
            "coverage": {
              "checked": [
                "Original P-002 declaration and duplicate issue runtime/provenance evidence",
                "Canonical P-002 feature WI-6554700010045670 and duplicate sibling WI-6554700010045740",
                "Matching converter fix and regression record EI-27730562695092492"
              ],
              "residue": [],
              "notChecked": [],
              "population": [
                "Original P-002 declaration and duplicate issue runtime/provenance evidence",
                "Canonical P-002 feature WI-6554700010045670 and duplicate sibling WI-6554700010045740",
                "Matching converter fix and regression record EI-27730562695092492"
              ],
              "notApplicable": []
            },
            "testsRun": "No new tests run for this duplicate disposition. The linked fix record EI-27730562695092492 records packages/operator-core/lib/plan-items/convert.integration.test.ts via testing:run, runGroup c0c6942d-022c-4b58-8c0e-f8d53266402c, ledger row 23502654.",
            "treeStamp": {
              "headSha": "87b2f78c1d5d157509f7e9a1011a305c185b6c43",
              "repositoryRoot": "/home/marsh-office/papercupai-workspace/papercusp"
            },
            "testResult": "Linked fix verification PASS: 40 passed, 0 failed, 0 skipped. No test was rerun in this disposition.",
            "verifiedHow": "Read the original session timeline for the P-002 declaration and capture event; read the current canonical and duplicate work-item states; compared converter.ts from pre-fix d740fc3802877d1c8c3b1068768681ee32ef0025 to staging commit 7bb51cbef0; read the committed completion and test record for EI-27730562695092492. Published analysis report rpt_9575497d-d190-4257-bd26-317178fd62d2 and verified its complete body and workspace visibility.",
            "workOutcome": "duplicate",
            "rootCauseVerification": {
              "hypothesis": "The duplicate is the same pre-fix plan-item conversion identity gap as EI-27730562695092492: coord:declare-intent auto-conversion could not resolve the canonical promoted feature through source_plan_slug/source_plan_item_ids, then created a second issue-family work item.",
              "testResult": "Evidence supports the hypothesis: the original session declared P-002 in the 21:20 incident window; the duplicate row carries the legacy plan_item stamp while the canonical feature is linked through source-plan columns; the issue freshness envelope records runtime d740, before staging commit 7bb51 added canonical promoted-feature resolution. The existing targeted regression passes 40/40. No separate creator-result row was preserved, so no claim is made that the fix shipped.",
              "evidenceRefs": [
                "EI-28004955265251225",
                "EI-27730562695092492",
                "WI-6554700010045670",
                "WI-6554700010045740",
                "session_turn:codex:01a1aea1-9ca6-70f0-826a-3ff525765918:6",
                "sessions:timeline invocation 47157207 coord:declare-intent",
                "packages/operator-core/lib/plan-items/convert.ts at d740fc3802877d1c8c3b1068768681ee32ef0025 and 7bb51cbef0",
                "testing runGroup c0c6942d-022c-4b58-8c0e-f8d53266402c, ledger row 23502654",
                "report rpt_9575497d-d190-4257-bd26-317178fd62d2"
              ],
              "testProcedure": "Read sessions:timeline for su-bd7bb60b-f269-4533-95f8-a01a37d59f27 over 2026-11-06T02:18:00Z–02:22:00Z and the 21:46 report capture; inspect work_items:get for WI-6554700010045670, WI-6554700010045740 and EI-28004955265251225; inspect git diff d740fc3802877d1c8c3b1068768681ee32ef0025..7bb51cbef0 for packages/operator-core/lib/plan-items/convert.ts; read EI-27730562695092492 completion and its testing run record.",
              "contractVersion": 2,
              "actualObservation": "The canonical feature WI-6554700010045670 is open and linked to P-002 through source_plan_slug/source_plan_item_ids; duplicate WI-6554700010045740 is dropped and carries the old plan_item stamp. The source diff adds source-plan-based canonical linked-item resolution after the captured d740 runtime. EI-27730562695092492 already records the matching 40-pass integration regression. The exact low-level creator result is not separately retained.",
              "distinguishingTest": "Correlate the original P-002 session timeline and duplicate row provenance with the captured runtime SHA, then compare the d740 and 7bb51 converter lookup paths and the existing targeted integration result.",
              "alternativeHypothesis": "A separate compaction checkpoint fallback bypassed the converter, or the fixed resolver was already active and a different creation path minted the sibling; in that case EI-277305 would not explain this incident.",
              "predictedObservations": {
                "hypothesis": "The event uses the old converter identity search; source-plan-only canonical features are missed, a sibling with a plan_item stamp is created, and the later resolver plus focused test covers that mapping.",
                "alternativeHypothesis": "The fixed resolver is present at the event or the duplicate is created by a separate path that bypasses conversion; the source-plan lookup change would not explain or prevent the observed sibling."
              }
            },
            "checkpointProseSnapshot": "## Did\n[turn:self] Re-read current ownership and cited records. WI-6554700010045740 is dropped; canonical feature WI-6554700010045670 remains open with its original assignee. Current coord:declare-intent imports convertPlanItem; the staged resolver and regression cover a plans:start feature linked only by source_plan columns. Existing EI-27730562695092492 test record reports 40 passed. Pipeline position: target 7bb51cbef, staging true, main/deployed false. [peer:su-bd7bb60b-f269-4533-95f8-a01a37d59f27] acknowledged the request for historical route/creation-path evidence and is checking; no answer yet (request coord-send-341dd69e3638dc6aef6405877d9e9f11a254ee3652ae197202f2ce4947917d20).\n\n## Left\nRoot cause is not verified: the historical serving build and whether converter auto-convert or compaction fallback created the duplicate remain unknown. No tests ran in this continuation.\n\n## Key insight\nThe report matches EI-27730562695092492's converter identity gap, but current staging source does not prove which code served the 2026-11-06T02:20Z declaration. Current deployed SHA was d740fc3802877d1c8c3b1068768681ee32ef0025, before the staged fix.\n\n## Next action\nRead the original owner's answer to the route/build question. If the event used pre-fix code or checkpoint fallback, close this row as a duplicate without claiming shipment; if the fixed converter ran, inspect that resolver boundary and own the needed regression/fix."
          },
          "_claimSubjectBaseline": {
            "body": "Observed during discovery-before-implementation-review-2026-11-05. Canonical P002 feature WI-6554700010045670 was successfully claimed byID at02:18:26Z. Then coord:declare-intent with current_plan_slug and items[P001,P002] at02:20:05Z returned claimedP002, alreadyHeldP001. At compaction flush, platform required missing checkpoint WI-6554700010045740, whose authoritative work_items:get shows task/issue held by same su-bd7bb, created02:20:05.538Z, sourcePlanSlug same plan/sourcePlanItemIds[P002], identical scope, payload.plan_item old-style stamp. Canonical WI5670 remains separately held. This suggests old-runtime claim fallback minted a duplicate instead of resolving the existing canonical plan-line node; exact root cause unverified. Both have checkpoints pointing to WI5670 current implementation. Preserve existing claims/evidence and use canonical identity rather than create on mismatch. No terminal/dedup action taken. Evidence current transcript coord declaration/get receipts and WI5740 checkpoint. Discovered solely through session:request-compaction flush-required, not a new task mission.",
            "kind": "bug",
            "title": "coord declare-intent P002 created a second held work-item beside canonical plan-line feature",
            "summary": "Observed during discovery-before-implementation-review-2026-11-05. Canonical P002 feature WI-6554700010045670 was successfully claimed byID at02:18:26Z. Then coord:declare-intent with current_plan_slug and items[P001,P002] at02:20:05Z returned claimedP002, alreadyHeldP001. At compaction flush, platform required missing checkpoint WI-6554700010045740, whose authoritative work_items:get shows task/issue held by same su-bd7bb, created02:20:05.538Z, sourcePlanSlug same plan/sourcePlanItemIds[P002], identical scope, payload.plan_item old-style stamp. Canonical WI5670 remains separately held. This suggests old-runtime claim fallback minted a duplicate instead of resolving the existing canonical plan-line node; exact root cause unverified. Both have checkpoints pointing to WI5670 current implementation. Preserve existing claims/evidence and use canonical identity rather than create on mismatch. No terminal/dedup action taken. Evidence current transcript coord declaration/get receipts and WI5740 checkpoint. Discovered solely through session:request-compaction flush-required, not a new task mission.",
            "watchdogKey": null
          },
          "claim_history_post_id": 9001788375295,
          "implementationReadiness": {
            "reason": "existing-immediate-capture-policy",
            "source": "capture-policy",
            "status": "ready",
            "updatedAt": "2026-11-06T02:46:46.562Z",
            "schemaVersion": "implementation-readiness-v1"
          }
        },
        "conditionKey": null
      },
      "target": {
        "title": "Native coord:declare-intent creates a duplicate issue for an already promoted feature plan item",
        "summary": "Observed in WI-6554700010045015 audit continuation: native coord:declare-intent at 2026-11-03T01:56:38Z with plan rubric-grading-diagnostics-evidence-and-author-handoff-2026-11-02 and items [P-001,P-002] returned claimed P002 but created new issue-family task WI-6554700010045179 instead of reusing pre-existing canonical feature WI-6554700010045016. work_items:get read both: same sourcePlanSlug/sourcePlanItemIds, new task createdBy caller at declaration time; original canonical feature remains blocked. Prior activation /tmp/fcf0a-adoption-plan-start.json verified exactly five promoted feature rows. A list after declaration contains six, with two P002 rows. Suspected cross-generation claim materializer: native service older than current3170. Durable fix: make declaration use canonical cross-family promoted-row lookup and refuse ambiguous mappings; add regression with existing promoted feature so no new issue is created. Prevent duplicate generation on current lane before production edits. Normal call itself returned ok:true, so this distinct product defect is additional evidence rather than a repeated transport error.",
        "status": "done",
        "duplicate_of": null,
        "payload": {
          "_ei": {
            "scope": "harness:papercusp",
            "source": "su",
            "severity": "major",
            "created_by": "su-fcf0a0fd-ef70-4f80-a094-d3571e2728b3",
            "assigned_by": "su-fcf0a0fd-ef70-4f80-a094-d3571e2728b3",
            "signal_origin": "organic"
          },
          "paths": [
            "packages/operator-core/lib/agent-tools/coordination/declare-intent.ts"
          ],
          "filedByRole": "su",
          "observation": {
            "refs": [
              "WI-6554700010045016",
              "WI-6554700010045179",
              "WI-6554700010045015"
            ],
            "sourceHive": "papercusp"
          },
          "_assumptions": {
            "declared": "none",
            "resolvedAt": "2026-11-06T19:01:10.087Z"
          },
          "dedupCoverage": {
            "lexical": "unavailable",
            "degraded": true,
            "semantic": "unavailable"
          },
          "ideaLifecycle": {
            "state": "triaged",
            "ideaType": "code-bug",
            "triagedAt": "2026-11-04T17:00:41.278Z",
            "triageReason": "code-bug, policy tier=auto (no protected path/keyword → AUTO-eligible (still gated by blueprint + tests + release-manager)) — auto-implement lane (D-003: one verdict chain)",
            "stateUpdatedAt": "2026-11-04T17:00:41.278Z",
            "triageDecision": "place"
          },
          "externalBlockers": [
            {
              "ref": "work-item:done:EI-27963975224012905",
              "kind": "event",
              "status": "cleared",
              "summary": "Current-source ledger verification is blocked on the separate privatePg cleanup fix: parent cleanup retries after the wrapper has stopped its disposable Postgres.",
              "evidence": "event \"work-item:done:EI-27963975224012905\" fired",
              "nextVerb": "After the cleanup fix completes, re-read the runner ordering and run the exact focused files through testing:run privatePg:true; inspect testing:runs for a current-source ledger verdict.",
              "clearedAt": "2026-11-06T16:54:52.702Z",
              "clearedBy": "work-items",
              "createdAt": "2026-11-06T16:02:23.238Z",
              "createdBy": "su-c90e0cc0-2484-422b-a44b-807c89e0ecde",
              "updatedAt": "2026-11-06T16:54:52.702Z",
              "capability": "live-dependency",
              "capabilitySource": "explicit"
            }
          ],
          "admissionIdentity": {
            "titleKey": "title:already coord creates declare duplicate feature for intent issue item native plan promoted",
            "schemaVersion": "admission-identity-v1"
          },
          "freshnessEnvelope": {
            "observedAt": "2026-11-03T02:05:25.401Z",
            "linkedFixRefs": [],
            "reporterSession": "su-fcf0a0fd-ef70-4f80-a094-d3571e2728b3",
            "observedSourceSha": "d740fc3802",
            "toolSchemaVersion": null,
            "observedRuntimeSha": "d740fc3802",
            "deployBuildIdentity": "d740fc3802@0.0.0",
            "reporterRuntimeVersion": "0.0.0",
            "lastSuccessfulReproductionAt": null
          },
          "_completionEvidence": {
            "summary": "Fixed the duplicate issue creation path by resolving promoted features through source_plan_slug/source_plan_item_ids, resuming one canonical live match and refusing ambiguous mappings before createWorkItem.",
            "coverage": {
              "checked": [
                "run-21a6-verdict: runId 21a6b0d1-2fd2-44db-997b-3bfb5d4af9f2 is unknown_run and the exact runGroup ledger query returned no rows; no pass is established.",
                "sourceplan-only-resume-20261106: a promoted feature linked only by source_plan lineage resumes without creating an issue sibling.",
                "ambiguous-map-refusal-20261106: multiple live promoted-feature mappings are refused before a new issue work-item is created.",
                "draft-terminal-coverage-20261106: a terminal stamped work-item counts as completion evidence for a stale todo-to-done draft-plan reflection."
              ],
              "residue": [],
              "notChecked": [],
              "population": [
                "run-21a6-verdict: runId 21a6b0d1-2fd2-44db-997b-3bfb5d4af9f2 is unknown_run and the exact runGroup ledger query returned no rows; no pass is established.",
                "sourceplan-only-resume-20261106: a promoted feature linked only by source_plan lineage resumes without creating an issue sibling.",
                "ambiguous-map-refusal-20261106: multiple live promoted-feature mappings are refused before a new issue work-item is created.",
                "draft-terminal-coverage-20261106: a terminal stamped work-item counts as completion evidence for a stale todo-to-done draft-plan reflection."
              ],
              "notApplicable": []
            },
            "testsRun": "Staging testing:run background for packages/operator-core/lib/plan-items/convert.integration.test.ts, privatePg:true, work_item_id EI-27730562695092492; runGroup c0c6942d-022c-4b58-8c0e-f8d53266402c. Durable testing:runs row 23502654.",
            "treeStamp": {
              "headSha": "3d55d30aa35a2bbdb61843d7b343a35a2e97dd63",
              "repositoryRoot": "/home/marsh-office/papercupai-workspace/papercusp",
              "contentIdentity": [
                {
                  "path": "packages/operator-core/lib/plan-items/convert.ts",
                  "headBlobSha": "e23e6c7471b1f1d9a123b2cfffe0392faa40bb71",
                  "workingTreeBlobSha": "e23e6c7471b1f1d9a123b2cfffe0392faa40bb71"
                },
                {
                  "path": "packages/operator-core/lib/plan-items/convert.integration.test.ts",
                  "headBlobSha": "7e480d0cf41dd11e9db5a2fb5f18dd1b35c4227e",
                  "workingTreeBlobSha": "7e480d0cf41dd11e9db5a2fb5f18dd1b35c4227e"
                },
                {
                  "path": "packages/operator-core/test/_work-items-schema.ts",
                  "headBlobSha": "909054957eb695a5ca7a7247cacbd0ec03305f28",
                  "workingTreeBlobSha": "909054957eb695a5ca7a7247cacbd0ec03305f28"
                }
              ]
            },
            "testResult": "PASS: 40 passed, 0 failed, 0 skipped. Detached status is pass; private Postgres cleanup complete with no errors. Exact ledger row records workspace papercusp-workspace, harness papercusp, root /home/marsh-office/papercupai-workspace/papercusp, commit bd59dba0432419e2848f297ab78eed8f891902ab.",
            "verifiedHow": "Read the detached status and exact runGroup ledger row. Verified the source-only resume, ambiguous-mapping refusal, and terminal-coverage regressions are present in convert.integration.test.ts; inspected convert.ts resolver and the fixture version column. Although the run row says worktreeDirty because HEAD moved from 6d0e6c377ac8 to bd59dba04324, git diff showed no changes to convert.ts, convert.integration.test.ts, or _work-items-schema.ts across that transition or from bd59dba04324 to current HEAD 4639cff1b2a3a1282df2da7664885c1a9870dbb; those paths are clean.",
            "filesChanged": [
              "packages/operator-core/lib/plan-items/convert.ts",
              "packages/operator-core/lib/plan-items/convert.integration.test.ts",
              "packages/operator-core/test/_work-items-schema.ts"
            ],
            "settlementManifest": {
              "headSha": "3d55d30aa35a2bbdb61843d7b343a35a2e97dd63",
              "version": 1,
              "generation": 1,
              "evidenceHash": "25426cd41571e4d34955d3f8a64ec41de9dd2ed387d422d7936f746bc01b5c3e",
              "repositoryRoot": "/home/marsh-office/papercupai-workspace/papercusp",
              "contentIdentity": [
                {
                  "path": "packages/operator-core/lib/plan-items/convert.integration.test.ts",
                  "headBlobSha": "7e480d0cf41dd11e9db5a2fb5f18dd1b35c4227e",
                  "workingTreeBlobSha": "7e480d0cf41dd11e9db5a2fb5f18dd1b35c4227e"
                },
                {
                  "path": "packages/operator-core/lib/plan-items/convert.ts",
                  "headBlobSha": "e23e6c7471b1f1d9a123b2cfffe0392faa40bb71",
                  "workingTreeBlobSha": "e23e6c7471b1f1d9a123b2cfffe0392faa40bb71"
                },
                {
                  "path": "packages/operator-core/test/_work-items-schema.ts",
                  "headBlobSha": "909054957eb695a5ca7a7247cacbd0ec03305f28",
                  "workingTreeBlobSha": "909054957eb695a5ca7a7247cacbd0ec03305f28"
                }
              ],
              "normalizedPaths": [
                "packages/operator-core/lib/plan-items/convert.integration.test.ts",
                "packages/operator-core/lib/plan-items/convert.ts",
                "packages/operator-core/test/_work-items-schema.ts"
              ]
            },
            "rootCauseVerification": {
              "hypothesis": "Plan-item conversion failed to consult promoted feature rows whose only plan lineage was source_plan_slug/source_plan_item_ids, so pickup fell through and minted a duplicate issue work-item.",
              "testResult": "Both distinguishing cases pass in testing:runs row 23502654; the complete file passed 40/40.",
              "evidenceRefs": [
                "testing:runs:23502654",
                "testing:run-status:c0c6942d-022c-4b58-8c0e-f8d53266402c",
                "work_items:comment:1216492",
                "packages/operator-core/lib/plan-items/convert.ts",
                "packages/operator-core/lib/plan-items/convert.integration.test.ts",
                "packages/operator-core/test/_work-items-schema.ts",
                "git-diff:6d0e6c377ac8d22afd0b2409107e3a1176dc4853..bd59dba0432419e2848f297ab78eed8f891902ab:target-paths-unchanged",
                "git-diff:bd59dba0432419e2848f297ab78eed8f891902ab..4639cff1b2a3a1282df2da7664885c1a9870dbb:target-paths-unchanged"
              ],
              "testProcedure": "Staging testing:run with background:true, privatePg:true and work_item_id EI-27730562695092492 for packages/operator-core/lib/plan-items/convert.integration.test.ts; then read testing:run-status using detachedRunId c0c6942d-022c-4b58-8c0e-f8d53266402c and testing:runs by exact runGroupId.",
              "contractVersion": 2,
              "actualObservation": "The exact runGroup ledger row is pass with 40 passed and 0 failed; source-only resume, ambiguous refusal, and stamped terminal coverage are among the passing integration cases. Detached result reports cleanup complete=true and no errors.",
              "distinguishingTest": "In the real-Postgres convert.integration.test.ts, insert an open promoted feature with no plan-line node, no implements edge, and empty payload, linked only by source_plan_slug/source_plan_item_ids; call convert('P-033') and assert status resumed, the existing feature id is returned, and createWorkItem is not called. In the companion case insert two live promoted-feature mappings and assert refusal with ambiguous_plan_item_mapping before creation.",
              "alternativeHypothesis": "The duplicate was caused by a stale fixture or unrelated edge state, while the conversion path already found the source-plan-only promoted feature.",
              "predictedObservations": {
                "hypothesis": "The source-plan-only row is resumed with its existing id and no createWorkItem call; the two-live-row case is refused as ambiguous before creation.",
                "alternativeHypothesis": "The source-plan-only case falls through to converted/new issue creation or fails to return the existing id; the fixture-only explanation does not make the ambiguity case reliably refuse."
              }
            },
            "checkpointChecksCarried": [
              {
                "claim": "testing:run-status for runId 21a6b0d1-2fd2-44db-997b-3bfb5d4af9f2 returned unknown_run; no pass verdict is established by the reads performed.",
                "recheck": "If the exact runGroupId becomes available, query testing:runs for that runGroupId and verify terminal per-file rows.",
                "verified": "The tool returned unknown_run with an explicit note that it is not evidence the test passed; previously read testing:runs rows were older unrelated runs. @2026-11-06T16:04:51.025Z"
              },
              {
                "claim": "A promoted feature with only source_plan lineage is resumed instead of minting an issue sibling.",
                "recheck": "Read testing:runs row 23460123 and confirm the source_plan-only converter case passed.",
                "verified": "testing:runs 23460123 passed the source_plan-only feature case; the case asserts resumed WI-promoted-P-033 and no createWorkItem call. @2026-11-06T08:21:23.415Z"
              },
              {
                "claim": "Multiple live promoted-feature mappings are refused before a new issue work-item is minted.",
                "recheck": "Read testing:runs row 23460123 and confirm the ambiguous mapping case passed.",
                "verified": "testing:runs 23460123 passed the two-live-feature case; it asserts ambiguous_plan_item_mapping and no createWorkItem call. @2026-11-06T08:21:23.415Z"
              },
              {
                "claim": "A terminal stamped work-item counts as completion evidence for a stale todo-to-done draft-plan reflection.",
                "recheck": "Read testing:runs row 23460123 and confirm the terminal-coverage case passed.",
                "verified": "testing:runs 23460123 passed the terminal coverage case; the fixture exercises the resolved stamped issue path. @2026-11-06T08:21:23.415Z"
              }
            ],
            "checkpointProseSnapshot": "## Current status — 2026-11-06\n\n[turn:self] EI-27730562695092492 is blocked on the typed event `work-item:done:EI-27963975224012905`. The blocker write succeeded; the set_state receipt confirmed state `blocked` and an auto-parked claim hold. [turn:self] scheduler:get_next then claimed EI-27971622212983362 under fleet spec revision 23, and I switched the declared intent to that item. I sent the separate cleanup-fix assignee an evidence note and sent the fleet leader a blocker report.\n\n## Root cause and existing fix\n\nThe original duplicate arose because plan-item pickup inspected current plan-line nodes, implements edges, and payload stamps, but missed promoted feature rows linked only by source_plan_slug/source_plan_item_ids. Current convert.ts uses the existing cross-family linked-item resolver, resumes one live match, and refuses ambiguous mappings before minting. The tests and fixture correction already exist in the tree.\n\n## Verification evidence and limits\n\n- testing:runs row 23460123 passed at commit d7bde99dd948c3fb67df1e7dbfb9ebf5612cf033, but worktreeDirty=true; it does not verify the current source.\n- `.papercusp/scratch/bash-5c0add2f-6da.log` records 40 tests, 37 passed and 3 failures: missing `version` fixture column, undefined linked-item id, and `converted` instead of `resumed`. These preceded the later source and fixture corrections.\n- `.papercusp/scratch/bash-ad549958-d76.log` records 90s test/hook timeouts and parent SIGTERM/exit 143 at the 300s deadline; no terminal verdict was emitted.\n- The 21a6b0d1 privatePg attempt has a retained router stdout log under `~/.papercusp/test-artifacts/testing-run/run-SeHzKt/`. testing:run-status returned unknown_run. Precise statement: no terminal verdict for this attempt has been established by the reads performed; unknown_run is not pass evidence.\n- The carried ref `32be278dc332` is an older `log:` fingerprint in tool-failure item EI-27707424056411102, describing a 2026-11-02 PC_HEAVY_ADMISSION cleanup abort on EI-26937523494462067. That record exposes no file path; it is not a current test-output path. Original provenance for `56c251d5de1e` remains unresolved. A later task_id probe in this turn created separate failure record EI-24060015627527668; do not conflate it with the original ref.\n\n## Current test-route blocker\n\nCurrent staging source still performs the parent owned-database retry after wrapped-child close; with-test-pg stops its private Postgres during wrapper child-exit cleanup. Current df measured root /dev/nvme0n1p2 at 99% with 23,766,446,080 bytes free; /tmp and /mnt/data share /dev/nvme1n1 with 1,027,565,035,520 bytes free. The shared-PG route remains unsafe under the measured root headroom; the private-PG route has space but requires the separate cleanup fix.\n\n## Next\n\nAfter the cleanup dependency completes, re-read current source and run the focused files through testing:run with privatePg:true; inspect the durable testing:runs result before closing. Do not close from the dirty row 23460123.\n\n---\n## Did\nVerified this continuation is still owner su-c90e0cc0-2484-422b-a44b-807c89e0ecde, fleet member, with live session task 0mw4z5duv1153qxa18r. The cold loop is active and rewakeGuaranteed=true (fireCount 96; lastLoopTurnAt 2026-11-06T14:38:01.809Z). EI-27730562695092492 remains open and assigned here. No source edits or test rerun.\n\nThe prior proof row 23460123 passes at commit d7bde99dd948c3fb67df1e7dbfb9ebf5612cf033, but worktreeDirty=true, so it does not establish a current-source verdict. The known test-file logs show one command exited 143 after its 300000ms task timeout with progress traces but no final verdict; a later command exited 1 with converter test failures and a non-assertion failure. The testing:run foreground attempt 21a6b0d1-2fd2-44db-997b-3bfb5d4af9f2 is ended_unobserved; its scope was released, but no terminal verdict is established.\n\nAudited cleanup ordering in packages/operator-core/lib/agent-tools/testing/run.ts and scripts/with-test-pg.mjs: the parent calls cleanupOwnedTestDatabases after the wrapped child is closed; the wrapper's child-exit path runs cleanupOwnedState (including private Postgres stop) before the wrapper exits. This matches guard-rail:testing-run-private-pg-cleanup-order and separate open item EI-27963975224012905.\n\n## Left\nThe two required log refs 56c251d5de1e and 32be278dc332 are still not resolved to their backing log files. testing:run-status returned unknown_run for both; a system journal search found no matches; neither ref appeared in the three known test logs. These results do not prove the logs are absent or that tests passed.\n\n## Key insight\nDo not infer a current-source test verdict from case traces, cleanup completion, the dirty historical row, or an ended_unobserved test-run task. The privatePg cleanup ordering remains a separately tracked runner defect.\n\n## Next action\nIdentify the backing store/path for log refs 56c251d5de1e and 32be278dc332, read and summarize both, and record the distinct failure causes on this item before deciding whether a current-source ledger-backed test can run safely.\n\n---\n## Did\nPulled EI-27730562695092492. Current convert.ts already uses the cross-family linked-work-item resolver; convert.integration.test.ts already covers resuming a plans:start feature linked only by source_plan columns and refusing ambiguous live mappings. No edits made. The first npm test:file attempt stopped in baseline setup before assertions because shared test PG had 21.96 GB free of a 2.014 TB volume; df confirmed / at 99%. A direct with-test-pg rerun booted an isolated PG and applied migrations; declare-intent.test.ts emitted passing per-case traces and convert.integration.test.ts started, but the command's final verdict was not recoverable and testing:runs recorded no rows. with-test-pg cleanup completed and removed its temp datadir. The registered fleet leader confirmed the carried suspect holders are live with no reclaimable claims; they remain untouched. I answered the blocked member with the exact missing compiler steward/event evidence and asked the live leader to route it.\n\n## Left\nThe current-source regression verdict and durable test evidence remain unverified. The previous checkpoint was stale, and this test invocation did not produce a testing:runs row. The blocked compiler item remains open pending the leader's named steward route and startup/delivery measurement.\n\n## Key insight\nRoot cause recorded by the prior worker is the plan-item conversion resolver missing plans:start feature rows linked only through source_plan_slug/source_plan_item_ids. The current source contains the cross-family resolver and focused regression cases. Do not treat the shared-PG storage refusal or the truncated second command output as product-test results.\n\n## Next action\nVerify the current cleanup order for testing:run privatePg against guard-rail:testing-run-private-pg-cleanup-order, recover or rerun the exact focused tests through a route that yields an authoritative verdict, then either complete EI-27730562695092492 with root-cause evidence or carry forward the precise blocker. Verify loop:status rewakeGuaranteed before settling.\n\n---\n## Did\nMeasured root cause: the plan-item pickup path checked current plan-line nodes, implements edges, and payload.plan_item stamps, but missed plans:start feature rows linked only by source_plan_slug/source_plan_item_ids. It now uses the existing cross-family linked-item resolver, resumes one live match, and refuses ambiguous live matches before minting. Added real-Postgres regressions and repaired the shared harness_plans test fixture's version column; the draft-gate fixture now exercises its terminal completion path.\n\n## Left\nNo source or test residue remains for EI-277. Duplicate issue WI-6554700010045179 is already dropped; canonical feature WI-6554700010045016 remains open with its existing assignee and was not mutated. Separate held EI-27972124337657815 remains unresolved and EI-27117440859250302 remains blocked on its typed success.\n\n## Key insight\nplans:start features can be linked to plan items only by source_plan_slug/source_plan_item_ids; pickup must consult that existing cross-family lineage reader.\n\n## Next action\nClose EI-277 with structured root-cause verification and testing:runs row 23460123.\n\n---\n## Did\nNative older coord:declare-intent created duplicate issue5179 for canonical already-promoted feature5016 at01:56:38Z. Detailed root hypothesis/evidence in body. Bounded mitigation DONE: current3170 work_items:update id5179 plan_item:null succeeded; receipt /tmp/fcf0a-p002-duplicate-detach.err plus tool output shows sourcePlanSlug/IDs null. Canonical5016 claimedcurrent3170 service+logic; no duplicate code work. Do NOT use native declaration with items while this old/current materializer mismatch remains.\n\n## Left\nDurable cross-family canonical lookup/ambiguity guard and regression not implemented; still OPEN owned here. Duplicate5179 remains OPEN but detached and owned; retire truthfully without syncing a terminal state back onto P002. This is separate from implementationacceptance and cannot be marked fixed from mitigation.\n\n## Next action\nAfter core owner task, inspect declare-intent materializer and reuse existing canonical promotion lookup. No new plan/fleet. Preserve traceability to5015/5016/5179.\n\n---\n⟦work-item-flight-record v1 begin⟧\ncaptured_at: 2026-11-03T07:51:27.357Z\ncause: forced-interrupt\nowner: su-fcf0a0fd-ef70-4f80-a094-d3571e2728b3\nintent: Continue Avi approved AUTO/self rubric plan; close P001 clean proof, complete current-build acceptance; EI-27706056457725712 checked only as own shipment dependency\nintent_scope: session-lane — this record was stamped identically onto 15 items, so the intent line above is NOT a reading of this item\nalso_stamped_on: [\"WI-6554700010045016\",\"WI-6554700010045018\",\"WI-6554700010045017\",\"WI-6554700010045015\",\"EI-27701867866262094\",\"EI-27718362154724074\",\"EI-24787677967034419\",\"EI-27734638393039796\",\"EI-26701706001588697\",\"EI-27740011831602428\",\"EI-27706056457725712\",\"WI-6554700010045242\",\"WI-6554700010045236\",\"WI-6554700010045237\"]\nauthored_prose_above: PRESENT and PREDATES this capture — it was written before captured_at, not at it; date any absence claim in it against the file history before trusting it\ncurrent_files: []\ntools_newest_first (max 12):\n- at=2026-11-03 01:54:34.758-05 tool=activity:report status=ok duration_ms=940 error_code=none args_keys=[\"agent\",\"cwd\",\"hook_bundle\",\"owner\",\"phase\",\"session_id\",\"status\",\"tool_input\",\"tool_name\",\"tool_use_id\"] args_key_digest=06baf047b35c\n- at=2026-11-03 01:54:30.683-05 tool=work_items:checkpoint status=ok duration_ms=847 error_code=none args_keys=[\"checkpoint\",\"harness\",\"id\"] args_key_digest=2940bfd74622\n- at=2026-11-03 01:54:27.033-05 tool=activity:report status=ok duration_ms=3882 error_code=none args_keys=[\"agent\",\"cwd\",\"hook_bundle\",\"owner\",\"phase\",\"session_id\",\"status\",\"tool_input\",\"tool_name\",\"tool_use_id\"] args_key_digest=06baf047b35c\n- at=2026-11-03 01:54:18.581-05 tool=coord:send status=ok duration_ms=2969 error_code=none args_keys=[\"body\",\"expects\",\"summary\",\"to\",\"why\"] args_key_digest=1d27d3b22459\n- at=2026-11-03 01:53:45.231-05 tool=activity:report status=ok duration_ms=93 error_code=none args_keys=[\"agent\",\"cwd\",\"hook_bundle\",\"owner\",\"phase\",\"session_id\",\"status\",\"tool_input\",\"tool_name\",\"tool_use_id\"] args_key_digest=06baf047b35c\n- at=2026-11-03 01:53:42.879-05 tool=tools:invoke status=ok duration_ms=57 error_code=none args_keys=[\"args\",\"name\"] args_key_digest=5108f8b1503a\n- at=2026-11-03 01:53:42.877-05 tool=work_items:get status=ok duration_ms=42 error_code=none args_keys=[\"harness\",\"id\"] args_key_digest=7d32df47e837\n- at=2026-11-03 01:53:23.305-05 tool=activity:report status=ok duration_ms=247 error_code=none args_keys=[\"agent\",\"cwd\",\"hook_bundle\",\"owner\",\"phase\",\"session_id\",\"status\",\"tool_input\",\"tool_name\",\"tool_use_id\"] args_key_digest=06baf047b35c\n- at=2026-11-03 01:53:22.499-05 tool=work_items:get status=ok duration_ms=29 error_code=none args_keys=[\"harness\",\"ids\"] args_key_digest=ae21337b357c\n- at=2026-11-03 01:53:09.526-05 tool=plans:get-specs status=ok duration_ms=109 error_code=none args_keys=[\"harness\",\"slug\",\"specIds\"] args_key_digest=f235755e2442\n- at=2026-11-03 01:53:04.773-05 tool=code:run status=ok duration_ms=3017 error_code=none args_keys=[\"script\",\"timeoutSec\",\"title\"] args_key_digest=967d38246cba\n- at=2026-11-03 01:53:04.726-05 tool=capability:bash status=ok duration_ms=2630 error_code=none args_keys=[\"command\"] args_key_digest=5d347fd948b6\n⟦work-item-flight-record v1 end⟧\n\n---\n## Did\nFresh resume read confirms the item remains open and assigned here with changeKinds logic and test-only. No source edit or test attempt occurred in this wake. The current stored nextAction names testing:runs row 23460123, while the successor handoff says that row came from an older dirty snapshot and a current-source CLI pass did not create a durable ledger row; treat the old row as unverified for closure.\n\n## Left\nThe successor handoff says a ledger-backed rerun was refused before execution pending audit of logs 56c251d5de1e and 32be278dc332. Reconcile those exact logs and record the audit before another slow attempt; verify current source provenance and a durable run row before structured root-cause closure.\n\n## Key insight\nA current-source CLI pass without a durable testing:runs row does not satisfy the ledger-backed closure requirement; the stored nextAction and recent audit handoff conflict.\n\n## Next action\nRead the two named logs, write the required audit result on this item, then decide whether another ledger-backed attempt is permitted.\n\n---\n## Cold-wake audit update — 2026-11-06\n\nThe exact test artifacts were read and summarized; no test rerun or source edit occurred.\n\n- `.papercusp/scratch/bash-5c0add2f-6da.log`: 40 integration cases, 37 passed and 3 failed. Failures were a fixture query on missing `version`, an undefined linked-item id, and `converted` instead of `resumed`. These preceded the later fixture and resolver corrections.\n- `.papercusp/scratch/bash-ad549958-d76.log`: 90s test/hook timeouts appeared in progress traces; the Bash wrapper hit its 300s deadline and exited 143. It has no terminal suite verdict.\n- `~/.papercusp/test-artifacts/testing-run/run-SeHzKt/router-21a6b0d1-2fd2-44db-997b-3bfb5d4af9f2-1fc34895-6aea-4382-b7de-896e8327993f.stdout.log`: retained router output for the ended_unobserved attempt; no pass verdict.\n\nReference correction: `32be278dc332` is not a missing test-output path. Search and work item EI-27707424056411102 show it as a prior `log:` fingerprint in a 2026-11-02 `loop_audit_required` tool error, describing PC_HEAVY_ADMISSION `status=aborted reason=cleanup` on EI-26937523494462067; the error record exposes no backing path. The original provenance/path for `56c251d5de1e` remains unknown. My later capability:bash_output lookup with that value as `task_id` created a separate unknown_task_id failure record (EI-24060015627527668); do not conflate that new record with the original reference. The earlier `testing:run-status` unknown_run results were not test verdicts.\n\nCurrent route evidence: source still shows parent owned-database cleanup after wrapped-child close, while with-test-pg stops its private Postgres during wrapper child-exit cleanup. Current `df`: root `/dev/nvme0n1p2` has 23,766,446,080 bytes free (99% used); `/tmp` and `/mnt/data` share `/dev/nvme1n1` with 1,027,565,035,520 bytes free (88%). Therefore I did not start another shared-PG run; the private-PG path has filesystem headroom but still needs the separately owned cleanup fix before a ledger-backed run is safe.\n\nEI-277 is now blocked on `work-item:done:EI-27963975224012905` with an active typed live-dependency blocker. The blocked state auto-parked its claim hold out of scheduler selection. The cleanup fix remains assigned to its own lane; evidence was sent once to that assignee and to the fleet leader.\n\nNext for EI-277 after the dependency resolves: re-read current runner source, run the focused files via `testing:run` with `privatePg:true`, inspect the durable `testing:runs` verdict, then complete with nested root-cause verification. The dirty historical row 23460123 is insufficient for closure.\n\n---\n## Correction — run verdict wording\nThe previous addendum said the 21a6 run “has no terminal suite verdict.” That was too broad. The exact testing:run-status read returned unknown_run and explicitly said this is not evidence of a pass; the test-run rows read were older runs. Correct statement: no terminal verdict for run 21a6 has been established by the reads performed. Do not claim global absence without an exact runGroupId lookup.\n\n---\n## Provenance correction — blocker and lane transition\n\n[turn:self] The work_items:set_blocker receipt added active blocker `work-item:done:EI-27963975224012905`; work_items:set_state applied `blocked` and returned that the claim hold was auto-parked out of scheduler selection. [turn:self] I then used scheduler:get_next and received EI-27971622212983362 under claim spec revision 23. [turn:self] I sent an evidence note to the EI-279 assignee and a blocker report to the fleet leader; the send receipts succeeded. These are historical actions in this turn, not claims about current peer liveness.\n\n---\n## Attribution note\n[peer:su-fcf0a0fd-ef70-4f80-a094-d3571e2728b3] The historical cause summary for the plan-item resolver in the section above is carried from that prior worker's checkpoint and test evidence; it was not a fresh source audit in this wake. The current task's fresh evidence is the test-log and runner-order audit recorded above.\n\n---\n[turn:self] The awaited work-item:done:EI-27963975224012905 event fired. A fresh work_items:get shows EI-27730562695092492 is open and still assigned to this session, so its old blocked status is stale. Finish EI-27971622212983362 first, then resume EI-27730562695092492 from its saved next action."
          },
          "_claimSubjectBaseline": {
            "body": "Observed in WI-6554700010045015 audit continuation: native coord:declare-intent at 2026-11-03T01:56:38Z with plan rubric-grading-diagnostics-evidence-and-author-handoff-2026-11-02 and items [P-001,P-002] returned claimed P002 but created new issue-family task WI-6554700010045179 instead of reusing pre-existing canonical feature WI-6554700010045016. work_items:get read both: same sourcePlanSlug/sourcePlanItemIds, new task createdBy caller at declaration time; original canonical feature remains blocked. Prior activation /tmp/fcf0a-adoption-plan-start.json verified exactly five promoted feature rows. A list after declaration contains six, with two P002 rows. Suspected cross-generation claim materializer: native service older than current3170. Durable fix: make declaration use canonical cross-family promoted-row lookup and refuse ambiguous mappings; add regression with existing promoted feature so no new issue is created. Prevent duplicate generation on current lane before production edits. Normal call itself returned ok:true, so this distinct product defect is additional evidence rather than a repeated transport error.",
            "kind": "bug",
            "title": "Native coord:declare-intent creates a duplicate issue for an already promoted feature plan item",
            "summary": "Observed in WI-6554700010045015 audit continuation: native coord:declare-intent at 2026-11-03T01:56:38Z with plan rubric-grading-diagnostics-evidence-and-author-handoff-2026-11-02 and items [P-001,P-002] returned claimed P002 but created new issue-family task WI-6554700010045179 instead of reusing pre-existing canonical feature WI-6554700010045016. work_items:get read both: same sourcePlanSlug/sourcePlanItemIds, new task createdBy caller at declaration time; original canonical feature remains blocked. Prior activation /tmp/fcf0a-adoption-plan-start.json verified exactly five promoted feature rows. A list after declaration contains six, with two P002 rows. Suspected cross-generation claim materializer: native service older than current3170. Durable fix: make declaration use canonical cross-family promoted-row lookup and refuse ambiguous mappings; add regression with existing promoted feature so no new issue is created. Prevent duplicate generation on current lane before production edits. Normal call itself returned ok:true, so this distinct product defect is additional evidence rather than a repeated transport error.",
            "watchdogKey": null
          },
          "claim_history_post_id": 9001788375295,
          "implementationReadiness": {
            "reason": "existing-immediate-capture-policy",
            "source": "capture-policy",
            "status": "ready",
            "updatedAt": "2026-11-03T02:05:25.401Z",
            "schemaVersion": "implementation-readiness-v1"
          }
        },
        "conditionKey": null
      },
      "finalR1Disposition": "OPEN",
      "timeBoundary": "Original report retained in terminal92 raw capture, later target snapshot at 2026-11-08T15:48:45.116Z; source witnesses captured in this qualification. No inferred original-time availability or loaded runtime."
    },
    {
      "originalId": "EI-28007367683730651",
      "targetId": "EI-27691198286861651",
      "classification": "same-specific-symptom",
      "qualification": "Both client authority lookup requests time out1500ms waiting for headers before dispatch. Target open. Different commands/requests demonstrate recurring failure class; signature fold does not establish shared root cause or repair.",
      "original": {
        "title": "Codex authority lookup repeatedly times out before dispatching valid coordination and evidence writes",
        "summary": "Unrecorded client-side boundary failure observed during report-sharing WI6554700010045560. Codex PreToolUse refused two authorized canonical ledger/coordination writes BEFORE dispatch because execution-authority lookup at http://127.0.0.1:9071 received no headers within1500ms: requestfc47caa6-454a-4a4c-a308-3d87581fc640 for improvements:capture, requestf26c8e69-13ef-4740-bb29-7023bf0dc593 for coord:send. Each error was plan_execution_not_ready, stage wall-during-fetch, transportPhase waiting-for-headers, elapsed1504/1505ms; it was NOT an actual server plan-readiness verdict. Subsequent health reads9071 returned200 in20ms and133ms, and canonical direct ptool retries succeeded with no permission override. Root cause of slow authority path remains unknown; health latency does not establish that authority lookup itself is healthy or prove a resource cause. This is separate from lost-loop-turn EI28005620164166963. Investigate measured authority resolver/transport stages and add a maintained client regression for slow/no-header lookup with correct unavailable-vs-denied reporting and a bounded recovery path; keep authorization fail-closed, never treat health200 as permission, and do not cache stale allows. Capture is needed because these calls never reached server invocation ledger. No source fix attempted; existing target mutations eventually landed and their receipts remain on main checkpoint.",
        "status": "resolved",
        "duplicate_of": null,
        "payload": {
          "_ei": {
            "scope": "harness:papercusp",
            "source": "su",
            "severity": "major",
            "created_by": "su-a9dd6838-d7d1-4551-bda8-0c0973f44ae7",
            "signal_origin": "organic"
          },
          "reporter": {
            "at": "2026-11-06T03:25:04.806Z",
            "id": "su-a9dd6838-d7d1-4551-bda8-0c0973f44ae7",
            "kind": "agent",
            "basis": "agent-session"
          },
          "filedByRole": "su",
          "watchdogKey": "repeated-tool-error:Codex PreToolUse execution-authority lookup:structural:plan_execution_not_ready:field-unknown",
          "decidedReason": "duplicate of EI-27691198286861651 — tool-failure signature fold (review-system-rework-reduction-2026-09-23 D-010)",
          "ideaLifecycle": {
            "state": "open",
            "stateUpdatedAt": "2026-11-06T03:25:25.802Z"
          },
          "reportContext": {
            "app": "papercusp",
            "screen": null,
            "refused": [],
            "truncated": [],
            "appVersion": "0.0.0+3513b00acf",
            "capturedAt": "2026-11-06T03:25:04.806Z",
            "logExcerpt": null,
            "screenshot": null,
            "autoCaptured": [
              "app",
              "appVersion",
              "recentErrors"
            ],
            "recentErrors": [
              {
                "at": "2026-11-06T03:25:04.806Z",
                "source": "Codex PreToolUse execution-authority lookup",
                "message": "Codex PreToolUse execution-authority lookup plan_execution_not_ready: No server verdict before1500ms waiting-for-headers at9071; requestId591fe02c-10b2-4c56-8254-35213692a114. Same-owner authenticated3170 reads later worked; root cause unknown."
              }
            ],
            "schemaVersion": 1
          },
          "reporterKinds": [
            "agent"
          ],
          "freshnessEnvelope": {
            "observedAt": "2026-11-06T03:25:07.166Z",
            "linkedFixRefs": [],
            "reporterSession": "su-a9dd6838-d7d1-4551-bda8-0c0973f44ae7",
            "observedSourceSha": "3513b00acf",
            "toolSchemaVersion": null,
            "observedRuntimeSha": "3513b00acf",
            "deployBuildIdentity": "3513b00acf@0.0.0",
            "reporterRuntimeVersion": "0.0.0",
            "lastSuccessfulReproductionAt": null
          },
          "signatureFoldedInto": "EI-27691198286861651",
          "toolFailureProbation": {
            "class": "structural",
            "state": "promoted",
            "report": {
              "status": "blocked-before-dispatch",
              "message": "execution-authority lookup failed; no server verdict; wall-during-fetch1504/1505ms; waiting-for-headers; requestsfc47caa6 andf26c8e69. Canonical writes later succeeded after access re-check.",
              "toolName": "Codex PreToolUse execution-authority lookup",
              "errorCode": "plan_execution_not_ready",
              "reproduced": true
            },
            "classKey": "repeated-tool-error-class:codex-pretooluse-execution-authority-lookup:structural:plan_execution_not_ready:schema-unknown~field-unknown:runtime-unknown",
            "reporters": [
              "su-a9dd6838-d7d1-4551-bda8-0c0973f44ae7",
              "su-716b0da2-850e-409e-8016-18efdd3390a5"
            ],
            "lastSeenAt": "2026-11-06T03:25:23.694Z",
            "promotedAt": "2026-11-06T03:25:25.800Z",
            "promotedBy": "su-716b0da2-850e-409e-8016-18efdd3390a5",
            "firstSeenAt": "2026-11-06T03:25:23.694Z",
            "watchdogKey": "repeated-tool-error:Codex PreToolUse execution-authority lookup:structural:plan_execution_not_ready:field-unknown",
            "intendedKind": "bug",
            "directEvidence": true,
            "deployedRevision": "runtime-unknown",
            "messageFingerprint": "md5-b0ad8c3d1a6444def9e0c97490b4f77b",
            "contractFingerprint": "schema-unknown~field-unknown",
            "correlationFingerprint": "codex-pretooluse-execution-authority-lookup|plan_execution_not_ready|schema-unknown|field-unknown|runtime-unknown|md5-b0ad8c3d1a6444def9e0c97490b4f77b"
          },
          "_claimSubjectBaseline": {
            "body": "Unrecorded client-side boundary failure observed during report-sharing WI6554700010045560. Codex PreToolUse refused two authorized canonical ledger/coordination writes BEFORE dispatch because execution-authority lookup at http://127.0.0.1:9071 received no headers within1500ms: requestfc47caa6-454a-4a4c-a308-3d87581fc640 for improvements:capture, requestf26c8e69-13ef-4740-bb29-7023bf0dc593 for coord:send. Each error was plan_execution_not_ready, stage wall-during-fetch, transportPhase waiting-for-headers, elapsed1504/1505ms; it was NOT an actual server plan-readiness verdict. Subsequent health reads9071 returned200 in20ms and133ms, and canonical direct ptool retries succeeded with no permission override. Root cause of slow authority path remains unknown; health latency does not establish that authority lookup itself is healthy or prove a resource cause. This is separate from lost-loop-turn EI28005620164166963. Investigate measured authority resolver/transport stages and add a maintained client regression for slow/no-header lookup with correct unavailable-vs-denied reporting and a bounded recovery path; keep authorization fail-closed, never treat health200 as permission, and do not cache stale allows. Capture is needed because these calls never reached server invocation ledger. No source fix attempted; existing target mutations eventually landed and their receipts remain on main checkpoint.",
            "kind": "bug",
            "title": "Codex authority lookup repeatedly times out before dispatching valid coordination and evidence writes",
            "summary": "Unrecorded client-side boundary failure observed during report-sharing WI6554700010045560. Codex PreToolUse refused two authorized canonical ledger/coordination writes BEFORE dispatch because execution-authority lookup at http://127.0.0.1:9071 received no headers within1500ms: requestfc47caa6-454a-4a4c-a308-3d87581fc640 for improvements:capture, requestf26c8e69-13ef-4740-bb29-7023bf0dc593 for coord:send. Each error was plan_execution_not_ready, stage wall-during-fetch, transportPhase waiting-for-headers, elapsed1504/1505ms; it was NOT an actual server plan-readiness verdict. Subsequent health reads9071 returned200 in20ms and133ms, and canonical direct ptool retries succeeded with no permission override. Root cause of slow authority path remains unknown; health latency does not establish that authority lookup itself is healthy or prove a resource cause. This is separate from lost-loop-turn EI28005620164166963. Investigate measured authority resolver/transport stages and add a maintained client regression for slow/no-header lookup with correct unavailable-vs-denied reporting and a bounded recovery path; keep authorization fail-closed, never treat health200 as permission, and do not cache stale allows. Capture is needed because these calls never reached server invocation ledger. No source fix attempted; existing target mutations eventually landed and their receipts remain on main checkpoint.",
            "watchdogKey": "repeated-tool-error:Codex PreToolUse execution-authority lookup:structural:plan_execution_not_ready:field-unknown"
          },
          "claim_history_post_id": 9001788375295,
          "implementationReadiness": {
            "reason": "trusted-tool-failure-promotion",
            "source": "capture-policy",
            "status": "ready",
            "updatedAt": "2026-11-06T03:25:25.801Z",
            "schemaVersion": "implementation-readiness-v1"
          }
        },
        "conditionKey": null
      },
      "target": {
        "title": "Codex execution-authority lookup repeatedly times out before finite metadata completion dispatch",
        "summary": "Unrecorded client-side PreToolUse failure during finite WI-6554700010046297 close. Both completion attempts were refused BEFORE work_items:complete dispatch: requestId a89c7cc6-2d75-451b-a332-7892bea71031 and ec536b4c-32b5-4724-a13e-07db671de314, plan_execution_not_ready, stage wall-during-fetch, elapsed1506ms/timeout1500ms, waiting-for-headers, operatorOrigin http://127.0.0.1:9071. Target completion was qualified current3170 and existing owned no-code-change task; full Report packet/readback already verified. A content-bearing ptool coord:whoami against exact9071 reached HTTP200 headers/202 handshake but refused dispatch serving_generation_missing because its tools/list lacked generation. This does NOT prove that generation mismatch causes the hook timeout; root cause remains unmeasured. Expected: a supported current execution-authority read returns an explicit verdict, or a bounded actionable infrastructure error, without treating transport uncertainty as a task-specific readiness denial. Diagnose the hook authority endpoint/proxy contract and supported current-generation routing while preserving fail-closed enforcement; add a regression distinguishing unreachable/legacy relay from actual authority refusal. No timeout widening, service restart, guard bypass or completion-side-effect workaround performed. Scope forbids host operations; all delivery evidence is on6297. Tool failures before dispatch may be absent from tool_invocations, hence this explicit capture.",
        "status": "open",
        "duplicate_of": null,
        "payload": {
          "_ei": {
            "scope": "harness:papercusp",
            "source": "su",
            "severity": "major",
            "created_by": "su-4055ed75-e29e-4167-bcc0-1373d32f8c8c",
            "assigned_by": "su-4055ed75-e29e-4167-bcc0-1373d32f8c8c",
            "found_during": "WI-6554700010021538",
            "signal_origin": "organic"
          },
          "paths": [
            "apps/operator/scripts/hooks/inject/core.mjs"
          ],
          "lastSeenAt": "2026-11-07T07:02:34.558Z",
          "agentReview": {
            "round": 1,
            "status": "pending",
            "timing": {
              "round": 1,
              "enteredAt": "2026-11-05T05:00:20.309Z"
            },
            "submittedBy": "su-4055ed75-e29e-4167-bcc0-1373d32f8c8c",
            "ledgerIdeaId": "EI-27691198286861651"
          },
          "filedByRole": "su",
          "repeatCount": 5,
          "watchdogKey": "tool-failure-signature:codex-pretooluse-execution-authority-lookup:structural:plan_execution_not_ready:field-unknown",
          "dedupCoverage": {
            "lexical": "unavailable",
            "degraded": true,
            "semantic": "unavailable"
          },
          "ideaLifecycle": {
            "state": "triaged",
            "ideaType": "code-bug",
            "triagedAt": "2026-11-05T05:00:16.595Z",
            "triageReason": "code-bug, policy tier=human (mentions protected keyword \"git-sync\" → human (no paths declared, so this is the pre-paths proxy; the deploy gate is the real backstop)) — human gate per the policy verdict (D-003)",
            "stateUpdatedAt": "2026-11-05T05:00:16.595Z",
            "triageDecision": "gate"
          },
          "reporterKinds": [
            "agent"
          ],
          "codeWorkingSet": {
            "epoch": 2,
            "owner": "su-32ef73d7-119c-4839-97cf-351eb9891cf1",
            "paths": [
              "apps/operator/bin/release/sync-staging-checkout.sh",
              "libs/papercusp/packages/orchestrator/src/prompt-build.ts",
              "libs/papercusp/packages/harness/blueprints/base/prompts/su.md",
              "packages/operator-core/lib/release/harness-checkpoint-state.ts",
              "packages/operator-core/lib/release/harness-checkpoint-cell.ts"
            ],
            "symbols": [],
            "derivedAt": "2026-11-03T00:56:28.259Z"
          },
          "admissionIdentity": {
            "titleKey": "title:1500ms authoritative authority authorize auto codex execution lookup native out repeatedly server times tools while work",
            "signalKey": "repeated-tool-error:Codex PreToolUse execution-authority lookup:structural:repeated-wall-during-fetch-atms-against",
            "schemaVersion": "admission-identity-v1"
          },
          "freshnessEnvelope": {
            "observedAt": "2026-11-02T15:39:42.753Z",
            "linkedFixRefs": [],
            "reporterSession": "su-4055ed75-e29e-4167-bcc0-1373d32f8c8c",
            "observedSourceSha": "d740fc3802",
            "toolSchemaVersion": null,
            "observedRuntimeSha": "d740fc3802",
            "deployBuildIdentity": "d740fc3802@0.0.0",
            "reporterRuntimeVersion": "0.0.0",
            "lastSuccessfulReproductionAt": "2026-11-02T15:39:42.753Z"
          },
          "toolFailureProbation": {
            "class": "structural",
            "state": "promoted",
            "report": {
              "status": "pre-dispatch-refused",
              "message": "Two authority lookups to9071 exceeded1500ms with no server verdict; work_items:complete never dispatched. Exact request IDs and measured independent proxy probe are in body.",
              "toolName": "Codex PreToolUse execution-authority lookup",
              "errorCode": "plan_execution_not_ready",
              "reproduced": true
            },
            "classKey": "repeated-tool-error-class:codex-pretooluse-execution-authority-lookup:structural:plan_execution_not_ready:schema-unknown~field-unknown:runtime-unknown",
            "reporters": [
              "su-55aafca6-fd39-475f-acce-bb12ead307ac",
              "su-7b7ec71f-03e0-4acd-b001-3dc206efdcc5"
            ],
            "lastSeenAt": "2026-11-07T07:02:34.558Z",
            "firstSeenAt": "2026-11-07T07:02:33.685Z",
            "watchdogKey": "tool-failure-signature:codex-pretooluse-execution-authority-lookup:structural:plan_execution_not_ready:field-unknown",
            "intendedKind": "bug",
            "signatureKey": "tool-failure-signature:codex-pretooluse-execution-authority-lookup:structural:plan_execution_not_ready:field-unknown",
            "directEvidence": true,
            "deployedRevision": "runtime-unknown",
            "messageFingerprint": "two-authority-lookups-to-exceededms-with",
            "contractFingerprint": "schema-unknown~field-unknown",
            "correlationFingerprint": "codex-pretooluse-execution-authority-lookup|plan_execution_not_ready|schema-unknown|field-unknown|runtime-unknown|two-authority-lookups-to-exceededms-with"
          },
          "toolFailureSignature": {
            "classes": {
              "repeated-tool-error-class:codex-pretooluse-execution-authority-lookup:structural:plan_execution_not_ready:schema-unknown~field-unknown:runtime-unknown": {
                "count": 2,
                "reporters": [
                  "su-4055ed75-e29e-4167-bcc0-1373d32f8c8c",
                  "su-a9dd6838-d7d1-4551-bda8-0c0973f44ae7",
                  "su-716b0da2-850e-409e-8016-18efdd3390a5"
                ],
                "lastSeenAt": "2026-11-06T03:25:23.694Z",
                "firstSeenAt": "2026-11-02T15:39:36.798Z",
                "deployedRevision": "runtime-unknown",
                "contractFingerprint": "schema-unknown~field-unknown"
              }
            },
            "signatureKey": "tool-failure-signature:codex-pretooluse-execution-authority-lookup:structural:plan_execution_not_ready:field-unknown"
          },
          "_claimSubjectBaseline": {
            "body": "Observed2026-11-02 in owner su4055ed75. Several authorized native apply_patch/exec_command calls were denied before execution: plan_execution_not_ready, execution authority unavailable, stage=wall-during-fetch, elapsedMs1503–1505, timeoutMs1500, operatorOriginhttp://127.0.0.1:9071. Includes source edit, managed git-sync CLI and even read-only tail. mode:get confirms owner-directed AUTO; canonical capability:edit accepts the same owned file edit with its own server authority and file locks, and capability:bash runs maintained tests. No hook/guard/authority was disabled or widened. Read-only rg and dedicated server reads work. Root cause of verdict path latency not measured yet. Investigate the minimal authoritative verdict path separately from injection enrichment; keep fail-closed enforcement. The failures occurred in native PreToolUse before platform invocations, so this adds client-side evidence absent from ordinary tool_invocations.",
            "kind": "bug",
            "title": "Codex native execution-authority lookup repeatedly times out at 1500ms while authoritative server tools authorize AUTO work",
            "summary": "Observed2026-11-02 in owner su4055ed75. Several authorized native apply_patch/exec_command calls were denied before execution: plan_execution_not_ready, execution authority unavailable, stage=wall-during-fetch, elapsedMs1503–1505, timeoutMs1500, operatorOriginhttp://127.0.0.1:9071. Includes source edit, managed git-sync CLI and even read-only tail. mode:get confirms owner-directed AUTO; canonical capability:edit accepts the same owned file edit with its own server authority and file locks, and capability:bash runs maintained tests. No hook/guard/authority was disabled or widened. Read-only rg and dedicated server reads work. Root cause of verdict path latency not measured yet. Investigate the minimal authoritative verdict path separately from injection enrichment; keep fail-closed enforcement. The failures occurred in native PreToolUse before platform invocations, so this adds client-side evidence absent from ordinary tool_invocations.",
            "watchdogKey": "tool-failure-signature:codex-pretooluse-execution-authority-lookup:structural:plan_execution_not_ready:field-unknown"
          },
          "claim_history_post_id": 9001788375295,
          "promotionReconciledAt": "2026-11-07T00:04:57.185Z",
          "implementationReadiness": {
            "reason": "awaiting-agent-review",
            "source": "agent-review",
            "status": "unknown",
            "evidence": {
              "review": {
                "round": 1,
                "submittedBy": "su-4055ed75-e29e-4167-bcc0-1373d32f8c8c"
              }
            },
            "updatedAt": "2026-11-05T05:00:20.344Z",
            "schemaVersion": "implementation-readiness-v1"
          },
          "promotionReconciledFrom": "EI-28080662628220975",
          "deploymentStalenessScreen": {
            "at": "2026-11-05T05:00:16.595Z",
            "state": "unknown",
            "divert": false,
            "screened": true,
            "toolName": "Codex PreToolUse execution-authority lookup",
            "unknownReason": "tool-source-unknown"
          }
        },
        "conditionKey": null
      },
      "finalR1Disposition": "OPEN",
      "timeBoundary": "Original report retained in terminal92 raw capture, later target snapshot at 2026-11-08T15:48:45.116Z; source witnesses captured in this qualification. No inferred original-time availability or loaded runtime."
    },
    {
      "originalId": "EI-28019632868216128",
      "targetId": "EI-28102536426151089",
      "classification": "same-specific-symptom",
      "qualification": "Both client authority hook refuses read/writes at1500ms waiting for headers then later succeeds; target open. Consolidation does not prove cause or fixed execution.",
      "original": {
        "title": "Codex authority hook intermittently denies read-only reads at its 1.5s verdict lookup deadline",
        "summary": "Client-side failure absent from ordinary tool invocation outcomes: PreToolUse denied a read-only sed/rg source read, then three independent ptool reads (rubrics:amend-status, work_items:get, tools:find). Each says plan_execution_not_ready, execution-authority lookup failed/no server verdict; operatorOrigin http://127.0.0.1:9071, timeoutMs1500, stage wall-during-fetch, waiting-for-headers, elapsedMs1504. Request IDs 5418fe47-3b4b-423c-98a2-69c5c89ac2f2, ace82603-6993-4bfa-a000-16ddf4cbc915, b464d22d-ee23-4d62-bd26-3f31158dbdd9, 3be0b4bf-4170-41b4-bab8-e71118ff651d. Native tools:invoke rubrics:amend-status immediately afterward succeeded and returned current review receipt; the source reads also worked on adjacent attempts. Evidence supports a client lookup timeout, not a server outage or resource bottleneck. Proposed investigation: classify known read-only tools/file reads separately from implementation mutations and inspect the bounded authority lookup route/fallback; preserve fail-closed enforcement for actual writes. Do not weaken authenticatedPrincipal forwarding or acceptance gates. No source fix attempted in this task.",
        "status": "resolved",
        "duplicate_of": null,
        "payload": {
          "_ei": {
            "scope": "harness:papercusp",
            "source": "su",
            "severity": "minor",
            "created_by": "su-59ccf895-21f4-4cfd-b94c-7b6e3fcb7464",
            "assigned_by": "su-59ccf895-21f4-4cfd-b94c-7b6e3fcb7464",
            "found_during": "WI-6554700010045800",
            "signal_origin": "organic"
          },
          "filedByRole": "su",
          "watchdogKey": "repeated-tool-error:Codex.PreToolUse.execution-authority:structural:read-only-source-ptool-reads-denied",
          "decidedReason": "duplicate of EI-28102536426151089 — tool-failure signature fold (review-system-rework-reduction-2026-09-23 D-010)",
          "dedupCoverage": {
            "lexical": "unavailable",
            "degraded": true,
            "semantic": "ok"
          },
          "ideaLifecycle": {
            "state": "open",
            "stateUpdatedAt": "2026-11-06T06:40:04.212Z"
          },
          "dedupCandidates": [
            {
              "id": "EI-27969393146118396",
              "method": "semantic-hard",
              "similarity": 0.93
            },
            {
              "id": "EI-27967556594211322",
              "method": "semantic-soft",
              "similarity": 0.91
            },
            {
              "id": "EI-28007367683730651",
              "method": "semantic-soft",
              "similarity": 0.91
            },
            {
              "id": "EI-27999294082198284",
              "method": "semantic-soft",
              "similarity": 0.91
            },
            {
              "id": "EI-27691198286861651",
              "method": "semantic-soft",
              "similarity": 0.91
            }
          ],
          "admissionIdentity": {
            "titleKey": "title:authority codex deadline denies hook intermittently its lookup only read reads verdict",
            "signalKey": "repeated-tool-error:Codex.PreToolUse.execution-authority:structural:read-only-source-ptool-reads-denied",
            "schemaVersion": "admission-identity-v1"
          },
          "freshnessEnvelope": {
            "observedAt": "2026-11-06T06:40:04.212Z",
            "linkedFixRefs": [],
            "reporterSession": "su-59ccf895-21f4-4cfd-b94c-7b6e3fcb7464",
            "observedSourceSha": "d740fc3802",
            "toolSchemaVersion": null,
            "observedRuntimeSha": "d740fc3802",
            "deployBuildIdentity": "d740fc3802@0.0.0",
            "reporterRuntimeVersion": "0.0.0",
            "lastSuccessfulReproductionAt": "2026-11-06T06:40:04.212Z"
          },
          "signatureFoldedInto": "EI-28102536426151089",
          "toolFailureProbation": {
            "class": "structural",
            "state": "promoted",
            "report": {
              "status": "client-hook-denied",
              "message": "Read-only source/ptool reads denied because execution-authority fetch at 9071 returned no verdict within1500ms; native same-platform read succeeded immediately afterward.",
              "toolName": "Codex.PreToolUse.execution-authority",
              "errorCode": "plan_execution_not_ready",
              "reproduced": true,
              "directEvidence": {
                "kind": "valid-input-reproduction",
                "actual": "Four valid reads were denied at elapsed1504ms before dispatch; native receipt read succeeded.",
                "expected": "Read-only source and canonical receipt reads remain available while a plan is awaiting review."
              }
            },
            "classKey": "repeated-tool-error-class:codex.pretooluse.execution-authority:structural:plan_execution_not_ready:schema-unknown~field-unknown:runtime-unknown",
            "reporters": [
              "su-59ccf895-21f4-4cfd-b94c-7b6e3fcb7464"
            ],
            "lastSeenAt": "2026-11-06T06:39:57.911Z",
            "firstSeenAt": "2026-11-06T06:39:57.911Z",
            "watchdogKey": "repeated-tool-error:Codex.PreToolUse.execution-authority:structural:read-only-source-ptool-reads-denied",
            "intendedKind": "bug",
            "directEvidence": true,
            "deployedRevision": "runtime-unknown",
            "messageFingerprint": "read-only-source-ptool-reads-denied",
            "contractFingerprint": "schema-unknown~field-unknown",
            "correlationFingerprint": "codex.pretooluse.execution-authority|plan_execution_not_ready|schema-unknown|field-unknown|runtime-unknown|read-only-source-ptool-reads-denied"
          },
          "implementationReadiness": {
            "reason": "existing-immediate-capture-policy",
            "source": "capture-policy",
            "status": "ready",
            "updatedAt": "2026-11-06T06:40:04.212Z",
            "schemaVersion": "implementation-readiness-v1"
          }
        },
        "conditionKey": null
      },
      "target": {
        "title": "Codex authority hook repeatedly denies authorized work after 1500ms header wait",
        "summary": "Additional client-side evidence during WI-6554700010045700 continuation: native exec PreToolUse denied before dispatch on requestIds54cf98d9-fb24-4da0-a2d1-2a5eea64aeab,1cf453af-5224-4a80-bfa6-441fdaa8a569,993d46a0-fc88-4795-ba02-845f33a601ba. Each diagnostic:plan_execution_not_ready,stage=wall-during-fetch,timeoutMs=1500,elapsedMs1504/1505,transportPhase=waiting-for-headers,operatorOrigin=http://127.0.0.1:9071. Commands included read-only Python/sed and evidence payload preparation as well as artifacts:save. Canonical mode:get then returned same live c52 owner AUTO+GRADE; same artifact save and full-content load later succeeded normally. No permission bypass, shared restart or timeout change. This client pre-dispatch failure is absent from normal tool_invocations for the rejected commands. Root latency/authority-resolver mechanism remains unconfirmed; do not attribute to resources. Preserve existing related hook-timeout item if dedup finds it. Suggested investigation: correlate exact guard request IDs with resolver logs and distinguish a valid denial from authority transport unavailability; maintain fail-closed behavior while testing normal authorized operations under the documented lookup budget. Parent comment and PG artifact evidence/c52-luna-r1-20261106/r3-leader-decision-evidence-20261107T0435Z.json retain lane context.",
        "status": "open",
        "duplicate_of": null,
        "payload": {
          "_ei": {
            "scope": "harness:papercusp",
            "source": "su",
            "severity": "major",
            "created_by": "su-c52a1707-13f5-4080-870b-f7143c271d73",
            "found_during": "WI-6554700010045700",
            "signal_origin": "organic"
          },
          "reporter": {
            "at": "2026-11-07T04:37:41.151Z",
            "id": "su-c52a1707-13f5-4080-870b-f7143c271d73",
            "kind": "agent",
            "basis": "agent-session"
          },
          "agentReview": {
            "round": 1,
            "status": "pending",
            "timing": {
              "round": 1,
              "enteredAt": "2026-11-07T18:43:35.430Z"
            },
            "submittedBy": "su-c52a1707-13f5-4080-870b-f7143c271d73",
            "ledgerIdeaId": "EI-28102536426151089"
          },
          "filedByRole": "su",
          "repeatCount": 2,
          "watchdogKey": "tool-failure-signature:codex.pretooluse.execution-authority:structural:plan_execution_not_ready:field-unknown",
          "admissionHold": {
            "actor": "system:work-item-admission-promoter",
            "runId": "sched-.routinesTick-2026-11-07T08:07:00.000Z-17",
            "heldAt": "2026-11-07T03:19:37.756-05:00",
            "reason": "Both document 9071 authority-fetch walls, but neither correlates its requests to server phases establishing the same latency mechanism and correction.",
            "screeningDeferred": false
          },
          "dedupCoverage": {
            "lexical": "unavailable",
            "degraded": true,
            "semantic": "partial"
          },
          "ideaLifecycle": {
            "state": "triaged",
            "ideaType": "code-bug",
            "triagedAt": "2026-11-07T18:43:33.871Z",
            "triageReason": "code-bug, policy tier=auto (no protected path/keyword → AUTO-eligible (still gated by blueprint + tests + release-manager)) — auto-implement lane (D-003: one verdict chain)",
            "stateUpdatedAt": "2026-11-07T18:43:33.871Z",
            "triageDecision": "place"
          },
          "reportContext": {
            "app": "papercusp",
            "screen": null,
            "refused": [],
            "truncated": [],
            "appVersion": "0.0.0+df01a886c5",
            "capturedAt": "2026-11-07T04:37:41.151Z",
            "logExcerpt": null,
            "screenshot": null,
            "autoCaptured": [
              "app",
              "appVersion",
              "recentErrors"
            ],
            "recentErrors": [
              {
                "at": "2026-11-07T04:37:41.151Z",
                "source": "Codex.PreToolUse.execution-authority",
                "message": "Codex.PreToolUse.execution-authority plan_execution_not_ready: Three exact native-command guard requests exceeded1500ms while waiting for9071 response headers; canonical registered AUTO+GRADE and subsequent artifact save/readback verified. No handler invocation was dispatched for denied commands."
              }
            ],
            "schemaVersion": 1
          },
          "reporterKinds": [
            "agent"
          ],
          "dedupCandidates": [
            {
              "id": "EI-27746055451519742",
              "method": "semantic-hard",
              "similarity": 0.93
            },
            {
              "id": "EI-28010927099561258",
              "method": "semantic-soft",
              "similarity": 0.93
            },
            {
              "id": "EI-28000355944439258",
              "method": "semantic-soft",
              "similarity": 0.92
            },
            {
              "id": "EI-28019632868216128",
              "method": "semantic-soft",
              "similarity": 0.92
            },
            {
              "id": "EI-28026072468131204",
              "method": "semantic-soft",
              "similarity": 0.92
            }
          ],
          "admissionIdentity": {
            "titleKey": "title:1500ms after authority authorized codex denies header hook repeatedly wait work",
            "signalKey": "tool-failure-signature:codex.pretooluse.execution-authority:structural:plan_execution_not_ready:field-unknown",
            "schemaVersion": "admission-identity-v1"
          },
          "freshnessEnvelope": {
            "observedAt": "2026-11-07T04:37:47.200Z",
            "linkedFixRefs": [],
            "reporterSession": "su-c52a1707-13f5-4080-870b-f7143c271d73",
            "observedSourceSha": "df01a886c5",
            "toolSchemaVersion": null,
            "observedRuntimeSha": "df01a886c5",
            "deployBuildIdentity": "df01a886c5@0.0.0",
            "reporterRuntimeVersion": "0.0.0",
            "lastSuccessfulReproductionAt": "2026-11-07T04:37:47.200Z"
          },
          "toolFailureProbation": {
            "class": "structural",
            "state": "promoted",
            "report": {
              "status": "client-pre-dispatch-timeout",
              "message": "Three exact native-command guard requests exceeded1500ms while waiting for9071 response headers; canonical registered AUTO+GRADE and subsequent artifact save/readback verified. No handler invocation was dispatched for denied commands.",
              "toolName": "Codex.PreToolUse.execution-authority",
              "errorCode": "plan_execution_not_ready",
              "reproduced": true
            },
            "classKey": "repeated-tool-error-class:codex.pretooluse.execution-authority:structural:plan_execution_not_ready:schema-unknown~field-unknown:runtime-unknown",
            "reporters": [
              "su-c52a1707-13f5-4080-870b-f7143c271d73"
            ],
            "lastSeenAt": "2026-11-07T04:37:41.150Z",
            "firstSeenAt": "2026-11-07T04:37:41.150Z",
            "watchdogKey": "tool-failure-signature:codex.pretooluse.execution-authority:structural:plan_execution_not_ready:field-unknown",
            "intendedKind": "bug",
            "signatureKey": "tool-failure-signature:codex.pretooluse.execution-authority:structural:plan_execution_not_ready:field-unknown",
            "directEvidence": true,
            "deployedRevision": "runtime-unknown",
            "messageFingerprint": "md5-7db4d5eadaefe2acb2b51799998bc04e",
            "contractFingerprint": "schema-unknown~field-unknown",
            "correlationFingerprint": "codex.pretooluse.execution-authority|plan_execution_not_ready|schema-unknown|field-unknown|runtime-unknown|md5-7db4d5eadaefe2acb2b51799998bc04e"
          },
          "toolFailureSignature": {
            "classes": {
              "repeated-tool-error-class:codex.pretooluse.execution-authority:structural:plan_execution_not_ready:schema-unknown~field-unknown:runtime-unknown": {
                "count": 1,
                "reporters": [
                  "su-59ccf895-21f4-4cfd-b94c-7b6e3fcb7464"
                ],
                "lastSeenAt": "2026-11-06T06:39:57.911Z",
                "firstSeenAt": "2026-11-06T06:39:57.911Z",
                "deployedRevision": "runtime-unknown",
                "contractFingerprint": "schema-unknown~field-unknown"
              }
            },
            "signatureKey": "tool-failure-signature:codex.pretooluse.execution-authority:structural:plan_execution_not_ready:field-unknown"
          },
          "implementationReadiness": {
            "reason": "awaiting-agent-review",
            "source": "agent-review",
            "status": "unknown",
            "evidence": {
              "review": {
                "round": 1,
                "submittedBy": "su-c52a1707-13f5-4080-870b-f7143c271d73"
              },
              "citations": {
                "citedIds": [
                  "WI-6554700010045700"
                ],
                "staleIds": [],
                "circularIds": [],
                "unresolvedIds": [],
                "lookupFailedIds": []
              },
              "deployment": {
                "state": "unknown",
                "toolName": "Codex.PreToolUse.execution-authority",
                "unknownReason": "tool-source-unknown"
              }
            },
            "updatedAt": "2026-11-07T18:43:35.686Z",
            "schemaVersion": "implementation-readiness-v1"
          },
          "deploymentStalenessScreen": {
            "at": "2026-11-07T18:43:33.871Z",
            "state": "unknown",
            "divert": false,
            "screened": true,
            "toolName": "Codex.PreToolUse.execution-authority",
            "unknownReason": "tool-source-unknown"
          }
        },
        "conditionKey": null
      },
      "finalR1Disposition": "OPEN",
      "timeBoundary": "Original report retained in terminal92 raw capture, later target snapshot at 2026-11-08T15:48:45.116Z; source witnesses captured in this qualification. No inferred original-time availability or loaded runtime."
    },
    {
      "originalId": "EI-28047218020902505",
      "targetId": "EI-28031329526300579",
      "classification": "same-specific-symptom-target-still-open",
      "qualification": "Both source_plan-only feature links fall through to a new task and duplicate admission. Target EI280313 remains open; generic convert row23502654 supports class repair but does not certify this exact feature's blocked-state/park reconciliation or historical episode. Do not use another completed bug's evidence as this item's full acceptance.",
      "original": {
        "title": "Plan lane declaration materializes duplicate work item instead of reusing linked blocked feature",
        "summary": "Observed 2026-11-06 under WI-6554700010045419 after P002 WI-6554700010045200 completed. coord:declare-intent for plan faster-rigorous-reviews-and-acquisition-2026-11-03 P-003 created task WI-6554700010045940 despite existing feature WI-6554700010045201 linked by sourcePlanSlug/sourcePlanItemIds. Existing feature remains blocked by obsolete plan-lane externalBlocker, while task has payload.plan_item and self claim. plans:items returned no linked workItem before declaration. Suspected mismatch between legacy feature linkage and payload.plan_item resolver; root cause unverified. Reuse existing lane lookup across both linkage forms and reconcile stale dependency park; add regression ensuring single work item for an existing feature lane. Active work continues on platform-created claimed task WI5940; original immutable spec amendments remain WI5201.",
        "status": "dropped",
        "duplicate_of": "EI-28031329526300579",
        "payload": {
          "_ei": {
            "scope": "harness:papercusp",
            "source": "su",
            "severity": "major",
            "created_by": "su-39f94f0c-8262-4858-8ec2-0d4acb631e37",
            "signal_origin": "organic"
          },
          "filedByRole": "su",
          "dedupCoverage": {
            "lexical": "unavailable",
            "degraded": true,
            "rescreen": {
              "at": "2026-11-06T17:45:27.833Z",
              "by": "admission-fail-open:dedup-rescreen",
              "atMs": 1793987127833,
              "prior": {
                "lexical": "unavailable",
                "degraded": true,
                "semantic": "unavailable"
              },
              "runId": "sched-.routinesTick-2026-11-06T17:45:00.000Z-45",
              "outcome": "degraded",
              "attempts": 3
            },
            "semantic": "unavailable"
          },
          "ideaLifecycle": {
            "state": "open",
            "stateUpdatedAt": "2026-11-06T13:58:31.466Z"
          },
          "admissionMerge": {
            "actor": "system:work-item-admission-promoter",
            "prior": {
              "status": "open",
              "seeAlso": [],
              "takenBy": null,
              "admission": "unreviewed",
              "admittedAt": "2026-11-06T17:45:41.630Z",
              "admittedBy": "system:work-item-admission-fail-open",
              "closedAtMs": null,
              "conditionKey": null,
              "terminalOwner": null,
              "sourcePlanSlug": null,
              "terminalReason": null,
              "admissionReview": {
                "value": {
                  "alert": {
                    "key": "work-item-admission-review-debt",
                    "state": "open",
                    "reason": "pending fail-open admission requires re-review",
                    "emittedAt": "2026-11-06T12:45:16.619-05:00"
                  },
                  "state": "pending",
                  "enteredAt": "2026-11-06T12:45:16.619-05:00",
                  "retryOwner": "system:work-item-admission-promoter",
                  "reviewedAt": null,
                  "reviewedBy": null,
                  "terminalAt": null,
                  "lastRetryAt": null,
                  "reviewDueAt": "2026-11-06T13:45:16.619-05:00",
                  "retryAttempts": 0,
                  "terminalOutcome": null
                },
                "present": true
              },
              "watchdogIdentity": {
                "watchdogKey": {
                  "value": null,
                  "present": false
                },
                "watchdogLane": {
                  "value": null,
                  "present": false
                },
                "watchdogSignalOrigin": {
                  "value": "organic",
                  "present": true
                },
                "admissionMergeSources": {
                  "value": null,
                  "present": false
                }
              },
              "sourcePlanItemIds": null
            },
            "runId": "sched-.routinesTick-2026-11-07T10:30:00.000Z-67",
            "state": "complete",
            "canonical": {
              "prior": {
                "seeAlso": [],
                "takenBy": null,
                "conditionKey": null,
                "sourcePlanSlug": null,
                "watchdogIdentity": {
                  "watchdogKey": {
                    "value": null,
                    "present": false
                  },
                  "watchdogLane": {
                    "value": null,
                    "present": false
                  },
                  "watchdogSignalOrigin": {
                    "value": "organic",
                    "present": true
                  },
                  "admissionMergeSources": {
                    "value": null,
                    "present": false
                  }
                },
                "sourcePlanItemIds": null
              },
              "applied": {
                "seeAlso": [
                  "EI-28047218020902505"
                ],
                "conditionKey": null,
                "sourcePlanSlug": null,
                "watchdogIdentity": {
                  "watchdogKey": {
                    "value": null,
                    "present": false
                  },
                  "watchdogLane": {
                    "value": null,
                    "present": false
                  },
                  "watchdogSignalOrigin": {
                    "value": "organic",
                    "present": true
                  },
                  "admissionMergeSources": {
                    "value": [
                      {
                        "actor": "system:work-item-admission-promoter",
                        "runId": "sched-.routinesTick-2026-11-07T10:30:00.000Z-67",
                        "loserId": "EI-28047218020902505",
                        "mergedAtMs": 1794062906621,
                        "schemaVersion": 1
                      }
                    ],
                    "present": true
                  }
                },
                "sourcePlanItemIds": null
              },
              "sourceEntryAdded": true
            },
            "transfers": {
              "occurrences": [
                {
                  "occurrenceId": "826238",
                  "priorCanonicalId": "EI-28047218020902505",
                  "priorCanonicalHarness": "papercusp"
                }
              ],
              "dependencyEdges": [],
              "duplicateOccurrenceId": "832414",
              "canonicalOutgoingAdded": [
                "EI-28047218020902505"
              ],
              "incomingReferenceSources": [],
              "duplicateOccurrenceCreated": true,
              "loserCanonicalReferenceAdded": true
            },
            "mergedAtMs": 1794062906621,
            "canonicalId": "EI-28031329526300579",
            "schemaVersion": 2,
            "canonicalHarness": "papercusp",
            "judgmentIdentity": {
              "loser": "0990b4eb7afa416b21c18e9975f2cb950c9f73e6fadeb46c846904d95a8b667f",
              "canonical": "3d6abe881dbfd241e538f2326d57d43452877762a6db69d936dfddcde5118fb0"
            },
            "reversalInstructions": {
              "order": [
                "restore-or-delete dependency after-edges from targetPrior, then reinsert each before-edge",
                "repoint transferred occurrence IDs to their prior canonical and delete the duplicate occurrence only when duplicateOccurrenceCreated=true",
                "remove canonical only from the recorded incomingReferenceSources and canonicalOutgoingAdded entries",
                "restore canonical identity, plan and reference fields only when they still equal canonical.applied",
                "restore loser lifecycle, admission, condition, plan, references and admissionReview from prior; then remove admissionMerge"
              ],
              "schemaVersion": 1,
              "transactionRequired": true,
              "compareAppliedStateBeforeRestore": true
            }
          },
          "admissionReview": {
            "alert": {
              "key": "work-item-admission-review-debt",
              "state": "cleared",
              "reason": "review completed",
              "emittedAt": "2026-11-07T09:48:26.621-05:00"
            },
            "state": "terminal",
            "enteredAt": "2026-11-06T12:45:16.619-05:00",
            "retryOwner": "system:work-item-admission-promoter",
            "reviewedAt": "2026-11-07T09:48:26.621-05:00",
            "reviewedBy": "system:work-item-admission-promoter",
            "terminalAt": "2026-11-07T09:48:26.621-05:00",
            "lastRetryAt": "2026-11-07T09:48:26.621-05:00",
            "reviewDueAt": "2026-11-06T13:45:16.619-05:00",
            "retryAttempts": 1,
            "terminalOutcome": "duplicate-merge"
          },
          "admissionFailOpen": {
            "at": "2026-11-06T12:45:16.619-05:00",
            "actor": "system:work-item-admission-fail-open",
            "runId": "sched-.routinesTick-2026-11-06T17:45:00.000Z-45",
            "scope": "workspace",
            "reason": "pending-age-exceeded-two-promoter-ticks"
          },
          "admissionIdentity": {
            "titleKey": "title:blocked declaration duplicate feature instead item lane linked materializes plan reusing work",
            "schemaVersion": "admission-identity-v1"
          },
          "freshnessEnvelope": {
            "observedAt": "2026-11-06T13:58:31.467Z",
            "linkedFixRefs": [],
            "reporterSession": "su-39f94f0c-8262-4858-8ec2-0d4acb631e37",
            "observedSourceSha": "d740fc3802",
            "toolSchemaVersion": null,
            "observedRuntimeSha": "d740fc3802",
            "deployBuildIdentity": "d740fc3802@0.0.0",
            "reporterRuntimeVersion": "0.0.0",
            "lastSuccessfulReproductionAt": null
          },
          "implementationReadiness": {
            "reason": "existing-immediate-capture-policy",
            "source": "capture-policy",
            "status": "ready",
            "updatedAt": "2026-11-06T13:58:31.466Z",
            "schemaVersion": "implementation-readiness-v1"
          }
        },
        "conditionKey": null
      },
      "target": {
        "title": "Declaring P004 created an unparented duplicate task beside its existing promoted feature and blocked plan admission",
        "summary": "Observed in unified-recipe-sql-shell-tool-learning-2026-11-05 P-004: canonical feature WI-6554700010045522 already existed (created 2026-11-05). Current own task WI-6554700010045877 was created 2026-11-06 08:55:48 during declare-intent/P004 claim, carrying the same plan_item but parent:null. Its checkpoint already pointed at the original feature. Canonical plans:start at 09:36 refused admission.reason=duplicate-coverage, message Actionable plan items have duplicate promoted rows: P-004; executionReadiness stayed plan_not_started. This additional diagnosis is a coordination product defect, beyond the automatically recorded refusal. Scope-local repair: work_items:update linked WI5877 parent=WI5522; work_items:get readback verified both remain open/self and the parent linkage, and the next canonical start admission.ready=true. No feature completion was claimed. Source class fix still needed: the declare-intent/plan-item-claim task enrollment path should reuse or parent an already-promoted same-scope feature/plan-line before creating another root. Add maintained cross-family regression: an existing promoted feature then declaration/claim must leave one execution tree, canonical plan admission ready, and no duplicate root. Root implementation path remains to be confirmed; do not treat the parent repair as the source fix. Evidence: original task checkpoint ca3d5e543928; failed start scratch plans:start/713f1865-08b8-4a87-9c13-9d1ae4c1edfb; parent readback09:39; admission repair start /tmp/su5c46-start-unique.err. Existing P004 code/test work remains under WI5522.",
        "status": "open",
        "duplicate_of": null,
        "payload": {
          "_ei": {
            "scope": "harness:papercusp",
            "source": "su",
            "severity": "major",
            "created_by": "su-5c46e76e-e3d6-448c-8959-58dcdfb533f9",
            "assigned_by": "su-5c46e76e-e3d6-448c-8959-58dcdfb533f9",
            "found_during": "WI-6554700010045522",
            "signal_origin": "organic"
          },
          "paths": [
            "packages/operator-core/lib/agent-tools/coordination/tools/declare-intent.ts",
            "packages/operator-core/lib/agent-tools/plans/plan-admission-preflight.ts"
          ],
          "reporter": {
            "at": "2026-11-06T09:45:54.556Z",
            "id": "su-5c46e76e-e3d6-448c-8959-58dcdfb533f9",
            "kind": "agent",
            "basis": "agent-session"
          },
          "filedByRole": "su",
          "dedupCoverage": {
            "lexical": "ok",
            "degraded": true,
            "semantic": "unavailable"
          },
          "ideaLifecycle": {
            "state": "triaged",
            "ideaType": "code-bug",
            "triagedAt": "2026-11-06T23:34:05.102Z",
            "triageReason": "code-bug, policy tier=auto (no protected path/keyword → AUTO-eligible (still gated by blueprint + tests + release-manager)) — auto-implement lane (D-003: one verdict chain)",
            "stateUpdatedAt": "2026-11-06T23:34:05.102Z",
            "triageDecision": "place"
          },
          "reportContext": {
            "app": "papercusp",
            "screen": null,
            "refused": [],
            "truncated": [],
            "appVersion": "0.0.0+222b71287c",
            "capturedAt": "2026-11-06T09:45:54.556Z",
            "logExcerpt": null,
            "screenshot": null,
            "autoCaptured": [
              "app",
              "appVersion"
            ],
            "recentErrors": [],
            "schemaVersion": 1
          },
          "reporterKinds": [
            "agent"
          ],
          "admissionIdentity": {
            "titleKey": "title:admission and beside blocked created declaring duplicate existing feature its p004 plan promoted task unparented",
            "schemaVersion": "admission-identity-v1"
          },
          "freshnessEnvelope": {
            "observedAt": "2026-11-06T09:45:57.622Z",
            "linkedFixRefs": [],
            "reporterSession": "su-5c46e76e-e3d6-448c-8959-58dcdfb533f9",
            "observedSourceSha": "222b71287c",
            "toolSchemaVersion": null,
            "observedRuntimeSha": "222b71287c",
            "deployBuildIdentity": "222b71287c@0.0.0",
            "reporterRuntimeVersion": "0.0.0",
            "lastSuccessfulReproductionAt": null
          },
          "admissionMergeSources": [
            {
              "actor": "system:work-item-admission-promoter",
              "runId": "sched-.routinesTick-2026-11-07T10:30:00.000Z-67",
              "loserId": "EI-28047218020902505",
              "mergedAtMs": 1794062906621,
              "schemaVersion": 1
            }
          ],
          "implementationReadiness": {
            "reason": "existing-immediate-capture-policy",
            "source": "capture-policy",
            "status": "ready",
            "updatedAt": "2026-11-06T09:45:57.621Z",
            "schemaVersion": "implementation-readiness-v1"
          }
        },
        "conditionKey": null
      },
      "finalR1Disposition": "OPEN",
      "timeBoundary": "Original report retained in terminal92 raw capture, later target snapshot at 2026-11-08T15:48:45.116Z; source witnesses captured in this qualification. No inferred original-time availability or loaded runtime."
    },
    {
      "originalId": "EI-28047671163799830",
      "targetId": "EI-28025692650838983",
      "classification": "same-specific-symptom",
      "qualification": "Both sanctioned read-only node mcp-call recovery requests are classified potentially mutating and denied after lookup timeout. Target open; independent transport timeout and classification coverage remain unresolved.",
      "original": {
        "title": "Plan-execution hook falsely denied sanctioned read-only pinned MCP recovery call",
        "summary": "During grading-integrity audit EI-28047051844439931 on run 1793973422-judge, PreToolUse blocked `node scripts/mcp-call.mjs --port 44337 tools:find --json -` with plan_execution_not_ready because execution-authority lookup timed out at 1505 ms while waiting for headers. The command was the kickoff-mandated recovery path and requested read-only tools:find, but the hook classified it as potentially mutating and failed closed. A subsequent ordinary tools:find succeeded. Root cause is unverified.",
        "status": "dropped",
        "duplicate_of": "EI-28025692650838983",
        "payload": {
          "_ei": {
            "scope": "harness:papercusp",
            "source": "engineer",
            "severity": "major",
            "created_by": "su-cff96d6f-71e8-4ba1-a5b9-9fa8c108427c",
            "signal_origin": "organic"
          },
          "reporter": {
            "at": "2026-11-06T14:05:40.237Z",
            "id": "su-cff96d6f-71e8-4ba1-a5b9-9fa8c108427c",
            "kind": "agent",
            "basis": "agent-session"
          },
          "filedByRole": "judge",
          "dedupCoverage": {
            "lexical": "unavailable",
            "degraded": true,
            "rescreen": {
              "at": "2026-11-06T17:45:35.620Z",
              "by": "admission-fail-open:dedup-rescreen",
              "atMs": 1793987135620,
              "prior": {
                "lexical": "ok",
                "degraded": true,
                "semantic": "unavailable"
              },
              "runId": "sched-.routinesTick-2026-11-06T17:45:00.000Z-45",
              "outcome": "degraded",
              "attempts": 3
            },
            "semantic": "unavailable"
          },
          "ideaLifecycle": {
            "state": "open",
            "stateUpdatedAt": "2026-11-06T14:05:43.620Z"
          },
          "reportContext": {
            "app": "papercusp",
            "screen": null,
            "refused": [],
            "truncated": [],
            "appVersion": "0.0.0+b96618c020",
            "capturedAt": "2026-11-06T14:05:40.237Z",
            "logExcerpt": null,
            "screenshot": null,
            "autoCaptured": [
              "app",
              "appVersion"
            ],
            "recentErrors": [],
            "schemaVersion": 1
          },
          "reporterKinds": [
            "agent"
          ],
          "admissionMerge": {
            "actor": "system:work-item-admission-promoter",
            "prior": {
              "status": "open",
              "seeAlso": [],
              "takenBy": null,
              "admission": "unreviewed",
              "admittedAt": "2026-11-06T17:45:50.472Z",
              "admittedBy": "system:work-item-admission-fail-open",
              "closedAtMs": null,
              "conditionKey": null,
              "terminalOwner": null,
              "sourcePlanSlug": null,
              "terminalReason": null,
              "admissionReview": {
                "value": {
                  "alert": {
                    "key": "work-item-admission-review-debt",
                    "state": "open",
                    "reason": "pending fail-open admission requires re-review",
                    "emittedAt": "2026-11-06T12:45:16.619-05:00"
                  },
                  "state": "pending",
                  "enteredAt": "2026-11-06T12:45:16.619-05:00",
                  "retryOwner": "system:work-item-admission-promoter",
                  "reviewedAt": null,
                  "reviewedBy": null,
                  "terminalAt": null,
                  "lastRetryAt": null,
                  "reviewDueAt": "2026-11-06T13:45:16.619-05:00",
                  "retryAttempts": 0,
                  "terminalOutcome": null
                },
                "present": true
              },
              "watchdogIdentity": {
                "watchdogKey": {
                  "value": null,
                  "present": false
                },
                "watchdogLane": {
                  "value": null,
                  "present": false
                },
                "watchdogSignalOrigin": {
                  "value": "organic",
                  "present": true
                },
                "admissionMergeSources": {
                  "value": null,
                  "present": false
                }
              },
              "sourcePlanItemIds": null
            },
            "runId": "sched-.routinesTick-2026-11-07T04:29:00.000Z-5",
            "state": "complete",
            "canonical": {
              "prior": {
                "seeAlso": [],
                "takenBy": null,
                "conditionKey": null,
                "sourcePlanSlug": null,
                "watchdogIdentity": {
                  "watchdogKey": {
                    "value": null,
                    "present": false
                  },
                  "watchdogLane": {
                    "value": null,
                    "present": false
                  },
                  "watchdogSignalOrigin": {
                    "value": "organic",
                    "present": true
                  },
                  "admissionMergeSources": {
                    "value": null,
                    "present": false
                  }
                },
                "sourcePlanItemIds": null
              },
              "applied": {
                "seeAlso": [
                  "EI-28047671163799830"
                ],
                "conditionKey": null,
                "sourcePlanSlug": null,
                "watchdogIdentity": {
                  "watchdogKey": {
                    "value": null,
                    "present": false
                  },
                  "watchdogLane": {
                    "value": null,
                    "present": false
                  },
                  "watchdogSignalOrigin": {
                    "value": "organic",
                    "present": true
                  },
                  "admissionMergeSources": {
                    "value": [
                      {
                        "actor": "system:work-item-admission-promoter",
                        "runId": "sched-.routinesTick-2026-11-07T04:29:00.000Z-5",
                        "loserId": "EI-28047671163799830",
                        "mergedAtMs": 1794026579345,
                        "schemaVersion": 1
                      }
                    ],
                    "present": true
                  }
                },
                "sourcePlanItemIds": null
              },
              "sourceEntryAdded": true
            },
            "transfers": {
              "occurrences": [
                {
                  "occurrenceId": "826273",
                  "priorCanonicalId": "EI-28047671163799830",
                  "priorCanonicalHarness": "papercusp"
                }
              ],
              "dependencyEdges": [],
              "duplicateOccurrenceId": "830694",
              "canonicalOutgoingAdded": [
                "EI-28047671163799830"
              ],
              "incomingReferenceSources": [],
              "duplicateOccurrenceCreated": true,
              "loserCanonicalReferenceAdded": true
            },
            "mergedAtMs": 1794026579345,
            "canonicalId": "EI-28025692650838983",
            "schemaVersion": 2,
            "canonicalHarness": "papercusp",
            "judgmentIdentity": {
              "loser": "c9ce97388966c087b7b7a200ce8b81ed67eeeb1b82cbb9e45e1d186939041a14",
              "canonical": "e4d24e007a6fd06420c1ca0942f9066d57a598897fe3f021cd9a5da0b42e782b"
            },
            "reversalInstructions": {
              "order": [
                "restore-or-delete dependency after-edges from targetPrior, then reinsert each before-edge",
                "repoint transferred occurrence IDs to their prior canonical and delete the duplicate occurrence only when duplicateOccurrenceCreated=true",
                "remove canonical only from the recorded incomingReferenceSources and canonicalOutgoingAdded entries",
                "restore canonical identity, plan and reference fields only when they still equal canonical.applied",
                "restore loser lifecycle, admission, condition, plan, references and admissionReview from prior; then remove admissionMerge"
              ],
              "schemaVersion": 1,
              "transactionRequired": true,
              "compareAppliedStateBeforeRestore": true
            }
          },
          "admissionReview": {
            "alert": {
              "key": "work-item-admission-review-debt",
              "state": "cleared",
              "reason": "review completed",
              "emittedAt": "2026-11-06T23:42:59.345-05:00"
            },
            "state": "terminal",
            "enteredAt": "2026-11-06T12:45:16.619-05:00",
            "retryOwner": "system:work-item-admission-promoter",
            "reviewedAt": "2026-11-06T23:42:59.345-05:00",
            "reviewedBy": "system:work-item-admission-promoter",
            "terminalAt": "2026-11-06T23:42:59.345-05:00",
            "lastRetryAt": "2026-11-06T23:42:59.345-05:00",
            "reviewDueAt": "2026-11-06T13:45:16.619-05:00",
            "retryAttempts": 1,
            "terminalOutcome": "duplicate-merge"
          },
          "admissionFailOpen": {
            "at": "2026-11-06T12:45:16.619-05:00",
            "actor": "system:work-item-admission-fail-open",
            "runId": "sched-.routinesTick-2026-11-06T17:45:00.000Z-45",
            "scope": "workspace",
            "reason": "pending-age-exceeded-two-promoter-ticks"
          },
          "admissionIdentity": {
            "titleKey": "title:call denied execution falsely hook mcp only pinned plan read recovery sanctioned",
            "schemaVersion": "admission-identity-v1"
          },
          "freshnessEnvelope": {
            "observedAt": "2026-11-06T14:05:43.620Z",
            "linkedFixRefs": [],
            "reporterSession": "su-cff96d6f-71e8-4ba1-a5b9-9fa8c108427c",
            "observedSourceSha": "b96618c020",
            "toolSchemaVersion": null,
            "observedRuntimeSha": "b96618c020",
            "deployBuildIdentity": "b96618c020@0.0.0",
            "reporterRuntimeVersion": "0.0.0",
            "lastSuccessfulReproductionAt": null
          },
          "implementationReadiness": {
            "reason": "existing-immediate-capture-policy",
            "source": "capture-policy",
            "status": "ready",
            "updatedAt": "2026-11-06T14:05:43.620Z",
            "schemaVersion": "implementation-readiness-v1"
          }
        },
        "conditionKey": null
      },
      "target": {
        "title": "Read-only grading-evidence recovery command denied when execution-authority lookup times out",
        "summary": "During grading-integrity audit EI-28025001539585473, a read-only node invocation of the sanctioned scripts/mcp-call.mjs recovery path (capability:read against a papercusp://scratch-spool URI) was denied fail-closed by PreToolUse. Diagnostic: plan_execution_not_ready; stage=wall-during-fetch; elapsedMs=1506; timeoutMs=1500; requestId=f522265e-56ed-4ea8-806e-6c9352940a40; operatorOrigin=http://127.0.0.1:46649. The hook classified the command as potentially mutating despite the underlying operation being capability:read, interrupting exact evidence retrieval. Root cause beyond the timed-out authority lookup is unverified.",
        "status": "open",
        "duplicate_of": null,
        "payload": {
          "_ei": {
            "scope": "harness:papercusp",
            "source": "engineer",
            "severity": "major",
            "created_by": "su-a7abf78b-6ca9-41f6-a103-e74cc92c1633",
            "signal_origin": "organic"
          },
          "reporter": {
            "at": "2026-11-06T08:16:20.136Z",
            "id": "su-a7abf78b-6ca9-41f6-a103-e74cc92c1633",
            "kind": "agent",
            "basis": "agent-session"
          },
          "filedByRole": "judge",
          "dedupCoverage": {
            "lexical": "unavailable",
            "degraded": true,
            "rescreen": {
              "at": "2026-11-06T12:18:46.114Z",
              "by": "admission-fail-open:dedup-rescreen",
              "atMs": 1793967526114,
              "prior": {
                "lexical": "ok",
                "degraded": true,
                "semantic": "unavailable"
              },
              "runId": "sched-.routinesTick-2026-11-06T12:17:30.000Z-21",
              "outcome": "degraded",
              "attempts": 3
            },
            "semantic": "unavailable"
          },
          "ideaLifecycle": {
            "state": "triaged",
            "ideaType": "code-bug",
            "triagedAt": "2026-11-06T23:49:12.637Z",
            "triageReason": "code-bug, policy tier=auto (no protected path/keyword → AUTO-eligible (still gated by blueprint + tests + release-manager)) — auto-implement lane (D-003: one verdict chain)",
            "stateUpdatedAt": "2026-11-06T23:49:12.637Z",
            "triageDecision": "place"
          },
          "reportContext": {
            "app": "papercusp",
            "screen": null,
            "refused": [],
            "truncated": [],
            "appVersion": "0.0.0+15e878be0d",
            "capturedAt": "2026-11-06T08:16:20.136Z",
            "logExcerpt": null,
            "screenshot": null,
            "autoCaptured": [
              "app",
              "appVersion"
            ],
            "recentErrors": [],
            "schemaVersion": 1
          },
          "reporterKinds": [
            "agent"
          ],
          "admissionReview": {
            "alert": {
              "key": "work-item-admission-review-debt",
              "state": "open",
              "reason": "pending fail-open admission requires re-review",
              "emittedAt": "2026-11-06T07:18:40.159-05:00"
            },
            "state": "pending",
            "enteredAt": "2026-11-06T07:18:40.159-05:00",
            "retryOwner": "system:work-item-admission-promoter",
            "reviewedAt": null,
            "reviewedBy": null,
            "terminalAt": null,
            "lastRetryAt": null,
            "reviewDueAt": "2026-11-06T08:18:40.159-05:00",
            "retryAttempts": 0,
            "terminalOutcome": null
          },
          "admissionFailOpen": {
            "at": "2026-11-06T07:18:40.159-05:00",
            "actor": "system:work-item-admission-fail-open",
            "runId": "sched-.routinesTick-2026-11-06T12:17:30.000Z-21",
            "scope": "workspace",
            "reason": "pending-age-exceeded-two-promoter-ticks"
          },
          "admissionIdentity": {
            "titleKey": "title:authority command denied evidence execution grading lookup only out read recovery times when",
            "schemaVersion": "admission-identity-v1"
          },
          "freshnessEnvelope": {
            "observedAt": "2026-11-06T08:16:23.238Z",
            "linkedFixRefs": [],
            "reporterSession": "su-a7abf78b-6ca9-41f6-a103-e74cc92c1633",
            "observedSourceSha": "15e878be0d",
            "toolSchemaVersion": null,
            "observedRuntimeSha": "15e878be0d",
            "deployBuildIdentity": "15e878be0d@0.0.0",
            "reporterRuntimeVersion": "0.0.0",
            "lastSuccessfulReproductionAt": null
          },
          "admissionMergeSources": [
            {
              "actor": "system:work-item-admission-promoter",
              "runId": "sched-.routinesTick-2026-11-07T04:29:00.000Z-5",
              "loserId": "EI-28047671163799830",
              "mergedAtMs": 1794026579345,
              "schemaVersion": 1
            },
            {
              "actor": "system:work-item-admission-promoter",
              "runId": "sched-.routinesTick-2026-11-07T04:29:00.000Z-5",
              "loserId": "EI-28072028358489153",
              "mergedAtMs": 1794026579345,
              "schemaVersion": 1
            },
            {
              "actor": "system:work-item-admission-promoter",
              "runId": "sched-.routinesTick-2026-11-07T04:29:00.000Z-5",
              "loserId": "EI-28072625852805752",
              "mergedAtMs": 1794026579345,
              "schemaVersion": 1
            },
            {
              "actor": "system:work-item-admission-promoter",
              "runId": "sched-.routinesTick-2026-11-07T04:29:00.000Z-5",
              "loserId": "EI-28087626282977815",
              "mergedAtMs": 1794026579345,
              "schemaVersion": 1
            },
            {
              "actor": "system:work-item-admission-promoter",
              "runId": "sched-.routinesTick-2026-11-07T04:29:00.000Z-5",
              "loserId": "EI-28096186549173255",
              "mergedAtMs": 1794026579345,
              "schemaVersion": 1
            },
            {
              "actor": "system:work-item-admission-promoter",
              "runId": "sched-.routinesTick-2026-11-07T04:29:00.000Z-5",
              "loserId": "EI-28096194145071008",
              "mergedAtMs": 1794026579345,
              "schemaVersion": 1
            },
            {
              "actor": "system:work-item-admission-promoter",
              "runId": "sched-.routinesTick-2026-11-07T05:59:00.000Z-7",
              "loserId": "EI-28096264231746694",
              "mergedAtMs": 1794031692193,
              "schemaVersion": 1
            },
            {
              "actor": "system:work-item-admission-promoter",
              "runId": "sched-.routinesTick-2026-11-07T06:24:30.000Z-9",
              "loserId": "EI-28096183759702875",
              "mergedAtMs": 1794034779835,
              "schemaVersion": 1
            },
            {
              "actor": "system:work-item-admission-promoter",
              "runId": "sched-.routinesTick-2026-11-07T06:24:30.000Z-9",
              "loserId": "EI-28096212578911392",
              "mergedAtMs": 1794034779835,
              "schemaVersion": 1
            }
          ],
          "implementationReadiness": {
            "reason": "existing-immediate-capture-policy",
            "source": "capture-policy",
            "status": "ready",
            "updatedAt": "2026-11-06T08:16:23.236Z",
            "schemaVersion": "implementation-readiness-v1"
          }
        },
        "conditionKey": null
      },
      "finalR1Disposition": "OPEN",
      "timeBoundary": "Original report retained in terminal92 raw capture, later target snapshot at 2026-11-08T15:48:45.116Z; source witnesses captured in this qualification. No inferred original-time availability or loaded runtime."
    },
    {
      "originalId": "EI-28059370207764272",
      "targetId": "EI-25235614425153042",
      "classification": "target-not-returned",
      "qualification": "Hygiene reason cites EI252356 but exact target20 capture did not return it in specified workspace/harness/relation. Original invalid-keys error is retained. No inference of target deletion, root cause, legitimacy, or fix.",
      "original": {
        "title": "tools:invoke tool-call failure (handler_error)",
        "summary": "Invocation telemetry observed tools:invoke at 2026-11-06T17:31:12.430Z.\n\ninvalid_input: invalid_args: Unrecognized keys: \"background\", \"work_item_id\" CORRECTED CALL — send this: testing:run({ \"harness\": \"papercusp\", \"files\": <your original 2-item array>, \"timeoutMs\": 240000, \"recheckReason\": \"<your original 252-char string>\" }) (removed `background`, `work_item_id` (this tool declares no counterpart — the fix is to drop it, not to look for a synonym)). This resolves the rejected keys against the args you actually sent; it does not guarantee the call validates, since a value-level error would not have been visible to this check. — this tool accepts ONLY: recheckReason, evidence, recoverEvidence, remeasureEvidence, files, changedPaths, testNamePattern, timeoutMs, maxFailures, harness. (Dispatch-level args, handled by the transport before this tool's own schema and therefore not in the list above but also accepted: payloadTier, projection, view.) An undeclared arg is REJECTED, not silently ignored (EI-10883): passing an arg a tool does not declare used to return ok:true while quietly doing something else, which is indistinguishable from success. Re-send using only the keys above (or the dispatch-level ones just listed). This server is running build d740fc3802, started 1.0h ago. If this argument was added after that build, the running process has never seen it — restart the app/process to pick up the new code. For the current source tree, retry this call against the Papercusp staging operator at :3170 (with ptool, pass --url=http://127.0.0.1:3170 explicitly).",
        "status": "closed",
        "duplicate_of": null,
        "payload": {
          "_ei": {
            "scope": "harness:papercusp",
            "source": "engineer",
            "severity": "nit",
            "created_by": "su-07780982-12ad-454d-a1d1-c826d4cbb95d",
            "signal_origin": "organic"
          },
          "agentReview": {
            "round": 1,
            "status": "pending",
            "timing": {
              "round": 1,
              "enteredAt": "2026-11-06T17:45:12.071Z"
            },
            "submittedBy": "su-07780982-12ad-454d-a1d1-c826d4cbb95d",
            "ledgerIdeaId": "EI-28059370207764272"
          },
          "repeatCount": 2,
          "watchdogKey": "tool-failure-signature:tools:invoke:transient:handler_error:field-unknown",
          "decidedReason": "duplicate of EI-25235614425153042 (hygiene sweep) — the kept item carries this friction",
          "ideaLifecycle": {
            "state": "triaged",
            "triagedAt": "2026-11-06T23:34:59.997Z",
            "triageReason": "duplicate of EI-25235614425153042 (hygiene sweep) — the kept item carries this friction",
            "stateUpdatedAt": "2026-11-06T23:34:59.997Z",
            "triageDecision": "reject"
          },
          "toolInvocation": {
            "ownerId": "su-07780982-12ad-454d-a1d1-c826d4cbb95d",
            "invokedAt": "2026-11-06T17:11:35.153Z",
            "harnessSlug": "papercusp",
            "workspaceId": "papercusp-workspace"
          },
          "freshnessEnvelope": {
            "observedAt": "2026-11-06T17:11:40.698Z",
            "linkedFixRefs": [],
            "reporterSession": "su-07780982-12ad-454d-a1d1-c826d4cbb95d",
            "observedSourceSha": "d740fc3802",
            "toolSchemaVersion": null,
            "observedRuntimeSha": "d740fc3802",
            "deployBuildIdentity": "d740fc3802@0.0.0",
            "reporterRuntimeVersion": "0.0.0",
            "lastSuccessfulReproductionAt": null
          },
          "toolFailureProbation": {
            "class": "transient",
            "state": "promoted",
            "direct": false,
            "report": {
              "status": "error",
              "message": "invalid_input: invalid_args: Unrecognized keys: \"background\", \"work_item_id\" CORRECTED CALL — send this: testing:run({ \"harness\": \"papercusp\", \"files\": <your original 2-item array>, \"timeoutMs\": 240000, \"recheckReason\": \"<your original 252-char string>\" }) (removed `background`, `work_item_id` (this tool declares no counterpart — the fix is to drop it, not to look for a synonym)). This resolves the rejected keys against the args you actually sent; it does not guarantee the call validates, since a value-level error would not have been visible to this check. — this tool accepts ONLY: recheckReason, evidence, recoverEvidence, remeasureEvidence, files, changedPaths, testNamePattern, timeoutMs, maxFailures, harness. (Dispatch-level args, handled by the transport before this tool's own schema and therefore not in the list above but also accepted: payloadTier, projection, view.) An undeclared arg is REJECTED, not silently ignored (EI-10883): passing an arg a tool does not declare used to return ok:true while quietly doing something else, which is indistinguishable from success. Re-send using only the keys above (or the dispatch-level ones just listed). This server is running build d740fc3802, started 1.0h ago. If this argument was added after that build, the running process has never seen it — restart the app/process to pick up the new code. For the current source tree, retry this call against the Papercusp staging operator at :3170 (with ptool, pass --url=http://127.0.0.1:3170 explicitly).",
              "toolName": "tools:invoke",
              "errorCode": "handler_error",
              "runtimeVersion": "d740fc3802"
            },
            "classKey": "repeated-tool-error-class:tools:invoke:transient:handler_error:schema-unknown~field-unknown:d740fc3802",
            "reporters": [
              "su-07780982-12ad-454d-a1d1-c826d4cbb95d",
              "su-0cbd6655-ce61-46ec-9c3a-451f915f5b67"
            ],
            "lastSeenAt": "2026-11-06T17:31:12.430Z",
            "promotedAt": "2026-11-06T17:31:14.262Z",
            "promotedBy": "su-0cbd6655-ce61-46ec-9c3a-451f915f5b67",
            "firstSeenAt": "2026-11-06T17:31:12.430Z",
            "watchdogKey": "tool-failure-signature:tools:invoke:transient:handler_error:field-unknown",
            "intendedKind": "bug",
            "signatureKey": "tool-failure-signature:tools:invoke:transient:handler_error:field-unknown",
            "knownExternal": null,
            "deployedRevision": "d740fc3802",
            "messageFingerprint": "invalid-input-invalid-args-unrecognized-keys",
            "contractFingerprint": "schema-unknown~field-unknown",
            "correlationFingerprint": "tools:invoke|handler_error|schema-unknown|field-unknown|d740fc3802|invalid-input-invalid-args-unrecognized-keys"
          },
          "toolFailureSignature": {
            "classes": {
              "repeated-tool-error-class:tools:invoke:transient:handler_error:schema-unknown~field-unknown:d740fc3802": {
                "count": 2,
                "reporters": [
                  "su-07780982-12ad-454d-a1d1-c826d4cbb95d",
                  "su-78560746-d1a0-423b-a26e-c1e9c6486454",
                  "su-716b0da2-850e-409e-8016-18efdd3390a5"
                ],
                "lastSeenAt": "2026-11-06T22:10:36.836Z",
                "firstSeenAt": "2026-11-06T17:11:35.153Z",
                "deployedRevision": "d740fc3802",
                "contractFingerprint": "schema-unknown~field-unknown"
              }
            },
            "signatureKey": "tool-failure-signature:tools:invoke:transient:handler_error:field-unknown"
          },
          "implementationReadiness": {
            "reason": "awaiting-agent-review",
            "source": "agent-review",
            "status": "unknown",
            "evidence": {
              "review": {
                "round": 1,
                "submittedBy": "su-07780982-12ad-454d-a1d1-c826d4cbb95d"
              }
            },
            "updatedAt": "2026-11-06T17:45:12.156Z",
            "schemaVersion": "implementation-readiness-v1"
          },
          "strandedToolFailureSweep": {
            "at": "2026-11-06T17:45:07.949Z",
            "owner": "system:stranded-tool-failure-sweep",
            "reason": "current-build-unknown",
            "outcome": "review"
          }
        },
        "conditionKey": null
      },
      "target": null,
      "finalR1Disposition": "OPEN",
      "timeBoundary": "Original report retained in terminal92 raw capture, later target snapshot at 2026-11-08T15:48:45.116Z; source witnesses captured in this qualification. No inferred original-time availability or loaded runtime."
    },
    {
      "originalId": "WI-6554700010027581",
      "targetId": "WI-6554700010025846",
      "classification": "different-incident-shared-guard-class",
      "qualification": "Original bundle4w7ZUe differs from target bundlenE9kUH. Target no-repro is not proof for original. Own completion reports absent/untracked/ignored and maintained ignore test. Source Git enumeration and ignore guard support mechanism, but exact detached run/observed revision originalness not independently qualified in eight ledger rows. Historical cause and episode remain qualified.",
      "original": {
        "title": "sync-batch guard red: lint:no-box-identity (apps/operator-public/.wrangler/tmp/bundle-4w7ZUe/middleware-insertion-facade.js)",
        "summary": "The repo-wide guard `npm run lint:no-box-identity` has a NEW violation on the shared `staging` tree.\nThe green-checkpoint runs this guard over the whole tree, so the next frozen candidate goes red on it\nunless it is fixed first.\n\nGuard:     lint:no-box-identity\nOffender:  apps/operator-public/.wrangler/tmp/bundle-4w7ZUe/middleware-insertion-facade.js\nNew because: the guard did not name this path at its previous measurement.\nWindow:    4 commit(s) since that measurement\nBatch that touched it: none in the window (the edit may still be uncommitted).\n\nRouted to: nobody. No ledgered editor or trailer names an author. Claim it if it is yours.\n\nGuard output (excerpt):\n      apps/operator-public/.wrangler/tmp/bundle-4w7ZUe/middleware-insertion-facade.js:1  (user \"marsh-office\")\n          import worker, * as OTHER_EXPORTS from \"/home/marsh-office/papercupai-workspace/papercusp/apps/operator-public\n      apps/operator-public/.wrangler/tmp/bundle-4w7ZUe/middleware-insertion-facade.js:2  (user \"marsh-office\")\n          import * as __MIDDLEWARE_0__ from \"/home/marsh-office/papercupai-workspace/papercusp/node_modules/wrangler/tem\n\nSLA: fix or revert within 60 minutes, before the hourly green-checkpoint freezes a candidate on it.\nRepair: run `npm run lint:no-box-identity`, fix what it names, and re-run it to confirm the fix.\n\nFiled by `system:sync-batch-lint-guards` (conditionKey `sync-delta-guard:lint:no-box-identity:apps/operator-public/.wrangler/tmp/bundle-4w7ZUe/middleware-insertion-facade.js`; refreshed in place, never re-filed as a sibling).",
        "status": "done",
        "duplicate_of": "WI-6554700010025846",
        "payload": {
          "_ei": {
            "scope": "harness:papercusp",
            "source": "engineer",
            "severity": "major",
            "created_by": "system:sync-batch-lint-guards",
            "signal_origin": "organic"
          },
          "paths": [
            "apps/operator-public/.wrangler/tmp/bundle-4w7ZUe/middleware-insertion-facade.js"
          ],
          "filedBy": "system:sync-batch-lint-guards",
          "reporter": {
            "at": "2026-10-24T15:45:01.521Z",
            "id": "system:sync-batch-lint-guards",
            "kind": "watchdog",
            "basis": "system-identity"
          },
          "_assumptions": {
            "declared": "none",
            "resolvedAt": "2026-11-08T00:43:12.512Z"
          },
          "authorSource": "none",
          "dedupCoverage": {
            "lexical": "ok",
            "degraded": true,
            "semantic": "partial"
          },
          "reporterKinds": [
            "watchdog"
          ],
          "dedupCandidates": [
            {
              "id": "WI-6554700010025846",
              "method": "semantic-hard",
              "similarity": 0.9980403184890747
            },
            {
              "id": "WI-6554700010025723",
              "method": "semantic-hard",
              "similarity": 0.9973080158233643
            },
            {
              "id": "WI-6554700010025855",
              "method": "semantic-hard",
              "similarity": 0.9914268851280212
            },
            {
              "id": "WI-6554700010025724",
              "method": "semantic-hard",
              "similarity": 0.990742862776349
            },
            {
              "id": "WI-6554700010025865",
              "method": "semantic-hard",
              "similarity": 0.9884268045425415
            },
            {
              "id": "WI-6554700010025727",
              "method": "semantic-hard",
              "similarity": 0.987566262113043
            }
          ],
          "_conditionUpsert": {
            "lastSeenAt": "2026-10-24T15:45:01.517Z",
            "occurrences": 1,
            "conditionKey": "sync-delta-guard:lint:no-box-identity:apps/operator-public/.wrangler/tmp/bundle-4w7ZUe/middleware-insertion-facade.js"
          },
          "externalBlockers": [
            {
              "ref": "harness:papercusp:event:harness:papercusp:safe-install-writer-release:WI-6554700010030253",
              "kind": "event",
              "status": "cleared",
              "summary": "The safe-install writer-release event remains generation 1 / declared and has not fired; validation cannot proceed until the producer proves the reader/writer/queue gate clear.",
              "evidence": "announced event \"harness:papercusp:event:harness:papercusp:safe-install-writer-release:WI-6554700010030253\" settled",
              "nextVerb": "After the producer reports a fresh exact census and emits a newer release generation, verify the event and census before resuming validation.",
              "clearedAt": "2026-11-07T23:18:07.527Z",
              "clearedBy": "su-96b7fe62-ee9a-4399-ad53-e30bc734d337",
              "createdAt": "2026-11-02T19:17:01.171Z",
              "createdBy": "su-97f0a515-a7fc-4561-ae83-d330eea87ab9",
              "updatedAt": "2026-11-07T23:18:07.527Z",
              "capability": "live-dependency",
              "capabilitySource": "explicit"
            }
          ],
          "admissionIdentity": {
            "titleKey": "title:4w7zue apps batch box bundle facade guard identity insertion lint middleware operator public red sync tmp wrangler",
            "schemaVersion": "admission-identity-v1"
          },
          "freshnessEnvelope": {
            "observedAt": "2026-10-24T15:45:01.521Z",
            "linkedFixRefs": [],
            "reporterSession": "system:sync-batch-lint-guards",
            "observedSourceSha": "24397f513f",
            "toolSchemaVersion": null,
            "observedRuntimeSha": "24397f513f",
            "deployBuildIdentity": "24397f513f@0.0.0",
            "reporterRuntimeVersion": "0.0.0",
            "lastSuccessfulReproductionAt": null
          },
          "_completionEvidence": {
            "summary": "Resolved the stale sync-batch finding: the offender was generated Wrangler middleware under .wrangler/tmp, and current staging excludes that tree from source scanning. No source edit was needed.",
            "coverage": {
              "checked": [
                "Reported Wrangler path in canonical staging",
                "Observed revision's .wrangler/tmp ignore rule",
                "Current check-no-box-identity Git enumeration policy",
                "Generated Wrangler middleware ignore regression test"
              ],
              "residue": [
                "none"
              ],
              "notChecked": [],
              "population": [
                "Reported Wrangler path in canonical staging",
                "Observed revision's .wrangler/tmp ignore rule",
                "Current check-no-box-identity Git enumeration policy",
                "Generated Wrangler middleware ignore regression test"
              ],
              "notApplicable": []
            },
            "testsRun": "packages/operator-core/lib/doc-claims/dot-prefixed-test-scratch.test.ts — detached recovery run 11cff5d8-1385-42bb-b87e-46ff01e43c07",
            "treeStamp": {
              "headSha": "3192a3ee49a6fa4c52b19b304ae4833379a9d729",
              "repositoryRoot": "/home/marsh-office/papercupai-workspace/papercusp"
            },
            "testResult": "Passed; exitCode 0. The foreground router timed out, then the same detached recovery run completed successfully.",
            "whatLanded": [
              "The observed source revision lacked the .wrangler/tmp ignore rule; current .gitignore excludes it, the checker honors Git standard excludes, and an existing regression test covers generated Wrangler middleware bundles."
            ],
            "verifiedHow": "Confirmed the reported path is absent and untracked in canonical staging, git check-ignore maps it to .gitignore:113, check-no-box-identity.mjs enumerates with --exclude-standard, and the focused ignore regression test passed.",
            "rootCauseVerification": {
              "hypothesis": "The sync-batch report came from a transient Wrangler .wrangler/tmp bundle being treated as source because the observed revision lacked an ignore rule for that generated directory.",
              "testResult": "Current path absent and untracked; Git ignores it via .gitignore:113; the checker uses --exclude-standard; focused Vitest run passed with exitCode 0.",
              "evidenceRefs": [
                "WI-6554700010027581",
                "git:24397f513f:.gitignore",
                "scripts/check-no-box-identity.mjs",
                "apps/operator-public/.gitignore:113",
                "packages/operator-core/lib/doc-claims/dot-prefixed-test-scratch.test.ts:156",
                "testing:run-status:11cff5d8-1385-42bb-b87e-46ff01e43c07"
              ],
              "testProcedure": "Read the checker and regression test; check the reported path with stat, git ls-files --error-unmatch and git check-ignore; run the exact focused Vitest file through testing:run.",
              "contractVersion": 2,
              "actualObservation": "The observed revision had no matching .wrangler/tmp ignore rule. Current staging has the exclusion; the reported path is absent, untracked, and ignored; the source checker respects standard excludes; the focused regression passed.",
              "distinguishingTest": "Compare the observed revision's ignore rule, the checker's Git enumeration, the exact path's current tracked/on-disk/ignored state, and the existing generated-bundle ignore regression.",
              "alternativeHypothesis": "The reported path was a tracked source file or the current checker bypasses Git ignore rules, leaving a real current source violation.",
              "predictedObservations": {
                "hypothesis": "The observed revision has no .wrangler/tmp exclusion, while current staging ignores generated bundles and the focused regression passes.",
                "alternativeHypothesis": "The path remains tracked or included by the current checker despite ignore rules, or the generated-bundle regression fails."
              }
            },
            "checkpointProseSnapshot": "## Did\nCurrent status: WI-6554700010027581 is blocked by the typed external event `harness:papercusp:event:harness:papercusp:safe-install-writer-release:WI-6554700010030253`. Exact events:status shows generation 1 / declared; await 396865 fired by timeout at 19:13:08Z. The producer WI-6554700010030253 remains blocked with a stale checkpoint (last updated 17:31Z); c07 is live on EI-27565754301862872, the latest census report is 15:29Z, and the direct status/handoff request missed its reply deadline. No lint or install ran.\n\n## Left\nThe validation item remains blocked pending a newer release generation and a fresh stable 10-second identity census with zero active/unknown readers or markers, no writer, and an empty queue. The claim is being released for fleet-leader re-placement. On next pickup, re-read the exact event, this item, and the producer's current checkpoint; do not lint before the gate passes.\n\n## Next\nThe fleet leader should re-place the lane after verified producer progress. If the event remains unfired, do not re-arm without new producer progress."
          },
          "claim_history_post_id": 9001788375295,
          "implementationReadiness": {
            "reason": "no-acceptance-evidence-at-creation",
            "source": "creation-enrollment",
            "status": "unknown",
            "updatedAt": "2026-10-24T15:45:01.521Z",
            "schemaVersion": "implementation-readiness-v1"
          }
        },
        "conditionKey": "sync-delta-guard:lint:no-box-identity:apps/operator-public/.wrangler/tmp/bundle-4w7ZUe/middleware-insertion-facade.js"
      },
      "target": {
        "title": "sync-batch guard red: lint:no-box-identity (apps/operator-public/.wrangler/tmp/bundle-nE9kUH/middleware-insertion-facade.js)",
        "summary": "The repo-wide guard `npm run lint:no-box-identity` has a NEW violation on the shared `staging` tree.\nThe green-checkpoint runs this guard over the whole tree, so the next frozen candidate goes red on it\nunless it is fixed first.\n\nGuard:     lint:no-box-identity\nOffender:  apps/operator-public/.wrangler/tmp/bundle-nE9kUH/middleware-insertion-facade.js\nNew because: the guard did not name this path at its previous measurement.\nWindow:    6 commit(s) since that measurement\nBatch that touched it: none in the window (the edit may still be uncommitted).\n\nRouted to: nobody. No ledgered editor or trailer names an author. Claim it if it is yours.\n\nGuard output (excerpt):\n      apps/operator-public/.wrangler/tmp/bundle-nE9kUH/middleware-insertion-facade.js:1  (user \"marsh-office\")\n          import worker, * as OTHER_EXPORTS from \"/home/marsh-office/papercupai-workspace/papercusp/apps/operator-public\n      apps/operator-public/.wrangler/tmp/bundle-nE9kUH/middleware-insertion-facade.js:2  (user \"marsh-office\")\n          import * as __MIDDLEWARE_0__ from \"/home/marsh-office/papercupai-workspace/papercusp/node_modules/wrangler/tem\n\nSLA: fix or revert within 60 minutes, before the hourly green-checkpoint freezes a candidate on it.\nRepair: run `npm run lint:no-box-identity`, fix what it names, and re-run it to confirm the fix.\n\nFiled by `system:sync-batch-lint-guards` (conditionKey `sync-delta-guard:lint:no-box-identity:apps/operator-public/.wrangler/tmp/bundle-nE9kUH/middleware-insertion-facade.js`; refreshed in place, never re-filed as a sibling).",
        "status": "dropped",
        "duplicate_of": null,
        "payload": {
          "_ei": {
            "scope": "harness:papercusp",
            "source": "engineer",
            "severity": "major",
            "created_by": "system:sync-batch-lint-guards",
            "signal_origin": "organic"
          },
          "paths": [
            "apps/operator-public/.wrangler/tmp/bundle-nE9kUH/middleware-insertion-facade.js"
          ],
          "filedBy": "system:sync-batch-lint-guards",
          "reporter": {
            "at": "2026-10-24T04:12:08.537Z",
            "id": "system:sync-batch-lint-guards",
            "kind": "watchdog",
            "basis": "system-identity"
          },
          "_assumptions": {
            "declared": "none",
            "resolvedAt": "2026-11-02T09:19:03.333Z"
          },
          "authorSource": "none",
          "dedupCoverage": {
            "lexical": "unavailable",
            "degraded": true,
            "rescreen": {
              "at": "2026-10-24T07:58:31.937Z",
              "by": "admission-fail-open:dedup-rescreen",
              "atMs": 1792828711937,
              "prior": {
                "lexical": "unavailable",
                "degraded": true,
                "semantic": "unavailable"
              },
              "runId": "sched-.routinesTick-2026-10-24T07:45:30.000Z-37",
              "outcome": "candidates",
              "attempts": 3
            },
            "semantic": "ok"
          },
          "reporterKinds": [
            "watchdog"
          ],
          "dedupCandidates": [
            {
              "id": "WI-6554700010025723",
              "method": "semantic-hard",
              "similarity": 0.9971176385879517
            },
            {
              "id": "WI-6554700010025855",
              "method": "semantic-hard",
              "similarity": 0.9937564134597778
            },
            {
              "id": "WI-6554700010025724",
              "method": "semantic-hard",
              "similarity": 0.9904132491103876
            },
            {
              "id": "WI-6554700010025865",
              "method": "semantic-hard",
              "similarity": 0.990412712097168
            },
            {
              "id": "WI-6554700010025727",
              "method": "semantic-hard",
              "similarity": 0.987202852583017
            }
          ],
          "_conditionUpsert": {
            "lastSeenAt": "2026-10-24T04:12:05.180Z",
            "occurrences": 1,
            "conditionKey": "sync-delta-guard:lint:no-box-identity:apps/operator-public/.wrangler/tmp/bundle-nE9kUH/middleware-insertion-facade.js"
          },
          "admissionIdentity": {
            "titleKey": "title:apps batch box bundle facade guard identity insertion lint middleware ne9kuh operator public red sync tmp wrangler",
            "schemaVersion": "admission-identity-v1"
          },
          "freshnessEnvelope": {
            "observedAt": "2026-10-24T04:12:08.537Z",
            "linkedFixRefs": [],
            "reporterSession": "system:sync-batch-lint-guards",
            "observedSourceSha": "ef97913d31",
            "toolSchemaVersion": null,
            "observedRuntimeSha": "ef97913d31",
            "deployBuildIdentity": "ef97913d31@0.0.0",
            "reporterRuntimeVersion": "0.0.0",
            "lastSuccessfulReproductionAt": null
          },
          "_completionEvidence": {
            "summary": "Closed as a stale, non-reproducible alert. The cited generated path is absent from the current tree and the current whole-tree guard passes. Historical cause is unknown; no source change is claimed.",
            "testsRun": "`npm run lint:no-box-identity` from the papercusp staging root (capability:bash); completed in 10.1s with exit 0.",
            "treeStamp": {
              "headSha": "09f9f81fcd797e0c6be80555a04224ad3f3580f5",
              "repositoryRoot": "/home/marsh-office/papercupai-workspace/papercusp"
            },
            "testResult": "PASS: no box-identity paths found across 27,786 tracked and untracked-not-ignored superproject source files.",
            "verifiedHow": "A read-only existence check reports the cited .wrangler/tmp path absent. The guard source enumerates tracked and untracked-not-ignored files with git ls-files --cached --others --exclude-standard, then scans those files; submodule content is intentionally outside its scope. No edits were made.",
            "checkpointProseSnapshot": "Did: Re-pulled via fleet claim spec revision 23 and verified `npm run lint:no-box-identity` exits 0 (10.1s), scanning 27,786 tracked plus untracked-not-ignored superproject source files. Confirmed the reported `.wrangler/tmp/bundle-nE9kUH/middleware-insertion-facade.js` path is absent. Read `scripts/check-no-box-identity.mjs`; it scans `git ls-files --cached --others --exclude-standard`, intentionally excluding ignored files and submodule contents. No source change was made.\n\nDisposition: close this alert as non-reproducible/stale in the current tree. The historical cause cannot be established from current evidence; this is not a claim that a specific code fix landed.\n\nRelated drain evidence: latest loop:status now reports rewakeGuaranteed=false (last-fire-no-loop-turn), turnsStalled=true, and lastLoopTurnAt=null. Existing open item EI-26658156767336740 covers that delivery gap and is unassigned. I sent the evidence to the fleet leader and did not create a duplicate or claim outside the scheduler spec."
          },
          "_claimSubjectBaseline": {
            "body": "The repo-wide guard `npm run lint:no-box-identity` has a NEW violation on the shared `staging` tree.\nThe green-checkpoint runs this guard over the whole tree, so the next frozen candidate goes red on it\nunless it is fixed first.\n\nGuard:     lint:no-box-identity\nOffender:  apps/operator-public/.wrangler/tmp/bundle-nE9kUH/middleware-insertion-facade.js\nNew because: the guard did not name this path at its previous measurement.\nWindow:    6 commit(s) since that measurement\nBatch that touched it: none in the window (the edit may still be uncommitted).\n\nRouted to: nobody. No ledgered editor or trailer names an author. Claim it if it is yours.\n\nGuard output (excerpt):\n      apps/operator-public/.wrangler/tmp/bundle-nE9kUH/middleware-insertion-facade.js:1  (user \"marsh-office\")\n          import worker, * as OTHER_EXPORTS from \"/home/marsh-office/papercupai-workspace/papercusp/apps/operator-public\n      apps/operator-public/.wrangler/tmp/bundle-nE9kUH/middleware-insertion-facade.js:2  (user \"marsh-office\")\n          import * as __MIDDLEWARE_0__ from \"/home/marsh-office/papercupai-workspace/papercusp/node_modules/wrangler/tem\n\nSLA: fix or revert within 60 minutes, before the hourly green-checkpoint freezes a candidate on it.\nRepair: run `npm run lint:no-box-identity`, fix what it names, and re-run it to confirm the fix.\n\nFiled by `system:sync-batch-lint-guards` (conditionKey `sync-delta-guard:lint:no-box-identity:apps/operator-public/.wrangler/tmp/bundle-nE9kUH/middleware-insertion-facade.js`; refreshed in place, never re-filed as a sibling).",
            "kind": "bug",
            "title": "sync-batch guard red: lint:no-box-identity (apps/operator-public/.wrangler/tmp/bundle-nE9kUH/middleware-insertion-facade.js)",
            "summary": "The repo-wide guard `npm run lint:no-box-identity` has a NEW violation on the shared `staging` tree.\nThe green-checkpoint runs this guard over the whole tree, so the next frozen candidate goes red on it\nunless it is fixed first.\n\nGuard:     lint:no-box-identity\nOffender:  apps/operator-public/.wrangler/tmp/bundle-nE9kUH/middleware-insertion-facade.js\nNew because: the guard did not name this path at its previous measurement.\nWindow:    6 commit(s) since that measurement\nBatch that touched it: none in the window (the edit may still be uncommitted).\n\nRouted to: nobody. No ledgered editor or trailer names an author. Claim it if it is yours.\n\nGuard output (excerpt):\n      apps/operator-public/.wrangler/tmp/bundle-nE9kUH/middleware-insertion-facade.js:1  (user \"marsh-office\")\n          import worker, * as OTHER_EXPORTS from \"/home/marsh-office/papercupai-workspace/papercusp/apps/operator-public\n      apps/operator-public/.wrangler/tmp/bundle-nE9kUH/middleware-insertion-facade.js:2  (user \"marsh-office\")\n          import * as __MIDDLEWARE_0__ from \"/home/marsh-office/papercupai-workspace/papercusp/node_modules/wrangler/tem\n\nSLA: fix or revert within 60 minutes, before the hourly green-checkpoint freezes a candidate on it.\nRepair: run `npm run lint:no-box-identity`, fix what it names, and re-run it to confirm the fix.\n\nFiled by `system:sync-batch-lint-guards` (conditionKey `sync-delta-guard:lint:no-box-identity:apps/operator-public/.wrangler/tmp/bundle-nE9kUH/middleware-insertion-facade.js`; refreshed in place, never re-filed as a sibling).",
            "watchdogKey": null
          },
          "claim_history_post_id": 9001788375295,
          "implementationReadiness": {
            "reason": "no-acceptance-evidence-at-creation",
            "source": "creation-enrollment",
            "status": "unknown",
            "updatedAt": "2026-10-24T04:12:08.537Z",
            "schemaVersion": "implementation-readiness-v1"
          }
        },
        "conditionKey": "sync-delta-guard:lint:no-box-identity:apps/operator-public/.wrangler/tmp/bundle-nE9kUH/middleware-insertion-facade.js"
      },
      "finalR1Disposition": "OPEN",
      "timeBoundary": "Original report retained in terminal92 raw capture, later target snapshot at 2026-11-08T15:48:45.116Z; source witnesses captured in this qualification. No inferred original-time availability or loaded runtime."
    },
    {
      "originalId": "WI-6554700010045623",
      "targetId": "WI-6554700010042509",
      "classification": "different-incident-shared-guard-class",
      "qualification": "Original dossier/trust-test targets differ from target shared-search reconciliationJSON. Own completion says original paths stayed tracked/included and no longer emitted while fullguard remained red on other files; that is bounded noaction, not fullgreen or fix. Original retained guard execution/raw output not among eight rows; historical cause unresolved.",
      "original": {
        "title": "sync-batch guard red: lint:no-box-identity (docs/evidence/get-feedback-acceptance-dossier-2026-11-05.md)",
        "summary": "The repo-wide guard `npm run lint:no-box-identity` has a NEW violation on the shared `staging` tree.\nThe green-checkpoint runs this guard over the whole tree, so the next frozen candidate goes red on it\nunless it is fixed first.\n\nGuard:     lint:no-box-identity\nOffender:  docs/evidence/get-feedback-acceptance-dossier-2026-11-05.md\nNew because: the guard did not name this path at its previous measurement.\nWindow:    2 commit(s) since that measurement\nBatch that touched it: none in the window (the edit may still be uncommitted).\n\nRouted to: nobody. No ledgered editor or trailer names an author. Claim it if it is yours.\n\nGuard output (excerpt):\n      docs/evidence/get-feedback-acceptance-dossier-2026-11-05.md:11  (user \"marsh-office\")\n          The retained, verified source candidate used for the latest core and SID proofs is commit 22509da18a31e043ed7b\n      packages/operator-ui/src/papercup-chat/PapercupChat.trust.test.tsx:290  (user \"avi\")\n          '/reports/%2f%2fevil.example', '/reports//settings', '/home/avi/reports',\n\nSLA: fix or revert within 60 minutes, before the hourly green-checkpoint freezes a candidate on it.\nRepair: run `npm run lint:no-box-identity`, fix what it names, and re-run it to confirm the fix.\n\nFiled by `system:sync-batch-lint-guards` (conditionKey `sync-delta-guard:lint:no-box-identity:docs/evidence/get-feedback-acceptance-dossier-2026-11-05.md`; refreshed in place, never re-filed as a sibling).",
        "status": "done",
        "duplicate_of": "WI-6554700010042509",
        "payload": {
          "_ei": {
            "scope": "harness:papercusp",
            "source": "engineer",
            "severity": "major",
            "created_by": "system:sync-batch-lint-guards",
            "signal_origin": "organic"
          },
          "paths": [
            "docs/evidence/get-feedback-acceptance-dossier-2026-11-05.md"
          ],
          "filedBy": "system:sync-batch-lint-guards",
          "reporter": {
            "at": "2026-11-05T23:07:49.252Z",
            "id": "system:sync-batch-lint-guards",
            "kind": "watchdog",
            "basis": "system-identity"
          },
          "_assumptions": {
            "declared": "none",
            "resolvedAt": "2026-11-07T04:02:40.827Z"
          },
          "authorSource": "none",
          "dedupCoverage": {
            "lexical": "ok",
            "degraded": true,
            "semantic": "partial"
          },
          "reporterKinds": [
            "watchdog"
          ],
          "dedupCandidates": [
            {
              "id": "WI-6554700010042509",
              "method": "semantic-hard",
              "similarity": 0.9693383863371134
            },
            {
              "id": "WI-6554700010042859",
              "method": "semantic-hard",
              "similarity": 0.9593466496078163
            },
            {
              "id": "WI-6554700010027581",
              "method": "semantic-hard",
              "similarity": 0.9587667274107559
            },
            {
              "id": "WI-6554700010025724",
              "method": "semantic-hard",
              "similarity": 0.9535869075779086
            },
            {
              "id": "WI-6554700010025727",
              "method": "semantic-hard",
              "similarity": 0.946286615507997
            },
            {
              "id": "WI-6554700010043616",
              "method": "semantic-hard",
              "similarity": 0.9448399825346468
            }
          ],
          "_conditionUpsert": {
            "lastSeenAt": "2026-11-05T23:07:49.179Z",
            "occurrences": 1,
            "conditionKey": "sync-delta-guard:lint:no-box-identity:docs/evidence/get-feedback-acceptance-dossier-2026-11-05.md"
          },
          "admissionIdentity": {
            "titleKey": "title:2026 acceptance batch box docs dossier evidence feedback get guard identity lint red sync",
            "schemaVersion": "admission-identity-v1"
          },
          "freshnessEnvelope": {
            "observedAt": "2026-11-05T23:07:49.252Z",
            "linkedFixRefs": [],
            "reporterSession": "system:sync-batch-lint-guards",
            "observedSourceSha": null,
            "toolSchemaVersion": null,
            "observedRuntimeSha": null,
            "deployBuildIdentity": "0.0.0",
            "reporterRuntimeVersion": "0.0.0",
            "lastSuccessfulReproductionAt": null
          },
          "_completionEvidence": {
            "summary": "This sync-batch finding is stale relative to the current staging tree. The two paths in its historical report remain tracked and in scan scope, but the current source no longer produces those findings. No source files were changed. The current full guard still reports three different paths; that evidence was sent to the live gate owner.",
            "coverage": {
              "checked": [
                "docs/evidence/get-feedback-acceptance-dossier-2026-11-05.md",
                "packages/operator-ui/src/papercup-chat/PapercupChat.trust.test.tsx"
              ],
              "residue": [],
              "notChecked": [],
              "population": [
                "docs/evidence/get-feedback-acceptance-dossier-2026-11-05.md",
                "packages/operator-ui/src/papercup-chat/PapercupChat.trust.test.tsx"
              ],
              "notApplicable": []
            },
            "testsRun": "npm run lint:no-box-identity",
            "treeStamp": {
              "headSha": "df01a886c5d27fa88c0f9fd65ac8f3e207e7eb6b",
              "repositoryRoot": "/home/marsh-office/papercupai-workspace/papercusp"
            },
            "testResult": "Item-specific verification passed: neither historical target path was emitted. The full guard exited 1 on three different files: docs/evidence/workbench-p001-actual-pui-resume-20261106.json:22, docs/evidence/workbench-p005-windows-packaging-20261106.json:8, and packages/operator-core/lib/turn-provenance/turn-ref.test.ts:974.",
            "verifiedHow": "Ran the exact repo guard on the canonical staging tree; checked current contents at both reported locations, confirmed both paths are tracked, and inspected the scanner SKIP rules. coord:feed confirmed the timing and current-path evidence reached the live gate owner.",
            "workOutcome": "verified-existing",
            "rootCauseVerification": {
              "hypothesis": "The historical guard observation is stale relative to current staging: the two reported paths no longer contain a matching hardcoded home path.",
              "testResult": "The exact guard exited 1 on three other paths and emitted neither item target. Both targets are tracked, neither is skipped, and their current contents do not contain the reported match.",
              "evidenceRefs": [
                "WI-6554700010045623 stored report and its 2026-11-05 observation timestamp",
                "Local npm run lint:no-box-identity execution on 2026-11-07: exit 1, three different findings",
                "git ls-files output for both target paths",
                "scripts/lib/identity-leak-patterns.mjs lines 85-109",
                "coord:feed confirmed delivery of current findings and timing to su-716b0da2-850e-409e-8016-18efdd3390a5 via coord-send-8e6abf7780a1d6e50d5537d56f3f6f90ba25bacc7fcc0fb974dc597ab6fe1b5f"
              ],
              "testProcedure": "From the papercusp staging root, run git ls-files -- for both target paths, inspect scripts/lib/identity-leak-patterns.mjs:isSkippedPath, read the current target lines, and run npm run lint:no-box-identity.",
              "contractVersion": 2,
              "actualObservation": "git ls-files returned both target paths. The SKIP rules exclude neither. Current dossier line 11 shows a /tmp snapshot path; the current trust test line 290 uses reportId/reportHref values. The guard listed three different files only.",
              "distinguishingTest": "Run npm run lint:no-box-identity on canonical staging, verify both reported paths are tracked and not excluded by SKIP, then inspect the current reported lines.",
              "alternativeHypothesis": "The guard stopped enumerating or recognizing the two tracked paths, masking unchanged violations.",
              "predictedObservations": {
                "hypothesis": "Both paths remain in the scanner population, their current contents have no matching home path, and the guard reports no finding for either.",
                "alternativeHypothesis": "One or both paths are absent from the scanner population, or the prior offending literal remains while the guard omits it."
              }
            }
          },
          "claim_history_post_id": 9001788375295,
          "implementationReadiness": {
            "reason": "no-acceptance-evidence-at-creation",
            "source": "creation-enrollment",
            "status": "unknown",
            "updatedAt": "2026-11-05T23:07:49.252Z",
            "schemaVersion": "implementation-readiness-v1"
          }
        },
        "conditionKey": "sync-delta-guard:lint:no-box-identity:docs/evidence/get-feedback-acceptance-dossier-2026-11-05.md"
      },
      "target": {
        "title": "sync-batch guard red: lint:no-box-identity (docs/evidence/shared-search-p001-clause-reconciliation-20261027.json)",
        "summary": "The repo-wide guard `npm run lint:no-box-identity` has a NEW violation on the shared `staging` tree.\nThe green-checkpoint runs this guard over the whole tree, so the next frozen candidate goes red on it\nunless it is fixed first.\n\nGuard:     lint:no-box-identity\nOffender:  docs/evidence/shared-search-p001-clause-reconciliation-20261027.json\nNew because: the guard did not name this path at its previous measurement.\nWindow:    2 commit(s) since that measurement\nBatch that touched it: none in the window (the edit may still be uncommitted).\n\nRouted to: nobody. No ledgered editor or trailer names an author. Claim it if it is yours.\n\nGuard output (excerpt):\n      docs/evidence/shared-search-p001-clause-reconciliation-20261027.json:36  (user \"marsh-office\")\n          \"root\": \"/home/marsh-office/Restart\",\n      FIX by deriving the path, not by adding an exception:\n        node/ts   os.homedir()  ·  path relative to import.meta.url / __dirname\n\nSLA: fix or revert within 60 minutes, before the hourly green-checkpoint freezes a candidate on it.\nRepair: run `npm run lint:no-box-identity`, fix what it names, and re-run it to confirm the fix.\n\nFiled by `system:sync-batch-lint-guards` (conditionKey `sync-delta-guard:lint:no-box-identity:docs/evidence/shared-search-p001-clause-reconciliation-20261027.json`; refreshed in place, never re-filed as a sibling).",
        "status": "blocked",
        "duplicate_of": null,
        "payload": {
          "_ei": {
            "scope": "harness:papercusp",
            "source": "engineer",
            "severity": "major",
            "created_by": "system:sync-batch-lint-guards",
            "signal_origin": "organic"
          },
          "paths": [
            "docs/evidence/shared-search-p001-clause-reconciliation-20261027.json"
          ],
          "filedBy": "system:sync-batch-lint-guards",
          "reporter": {
            "at": "2026-10-28T16:52:03.138Z",
            "id": "system:sync-batch-lint-guards",
            "kind": "watchdog",
            "basis": "system-identity"
          },
          "_claimHold": true,
          "authorSource": "none",
          "claim_hold_at": "2026-11-06T03:37:56.201Z",
          "claim_hold_by": "su-468aa74e-ed33-40ab-a5f5-d275003544d9",
          "dedupCoverage": {
            "lexical": "ok",
            "degraded": true,
            "rescreen": {
              "at": "2026-10-29T07:47:52.448Z",
              "by": "admission-fail-open:dedup-rescreen",
              "atMs": 1793260072448,
              "prior": {
                "lexical": "unavailable",
                "degraded": true,
                "semantic": "unavailable"
              },
              "runId": "sched-.routinesTick-2026-10-29T07:45:00.000Z-45",
              "outcome": "candidates",
              "attempts": 3
            },
            "semantic": "unavailable"
          },
          "reporterKinds": [
            "watchdog"
          ],
          "codeWorkingSet": {
            "epoch": 169,
            "owner": "su-468aa74e-ed33-40ab-a5f5-d275003544d9",
            "paths": [
              "scripts/lib/fs-mutex.mjs",
              "papercusp-desktop/test/build-linux-distribution-profile.test.js",
              "papercusp://scratch/papercusp-workspace/code:run/c68c8dca-4371-45b7-b88e-6d5d1447b7c5/result-door-1793923262847.md",
              "papercusp-desktop/package.json",
              "papercusp-desktop/bin/lib/release-artifacts.sh"
            ],
            "symbols": [],
            "derivedAt": "2026-11-06T00:25:33.672Z"
          },
          "dedupCandidates": [
            {
              "id": "WI-6554700010042526",
              "method": "lexical-fulltext",
              "similarity": 0.81
            }
          ],
          "_conditionUpsert": {
            "lastSeenAt": "2026-10-28T16:51:56.887Z",
            "occurrences": 1,
            "conditionKey": "sync-delta-guard:lint:no-box-identity:docs/evidence/shared-search-p001-clause-reconciliation-20261027.json"
          },
          "externalBlockers": [
            {
              "ref": "harness:papercusp:execution-authority-native-restored-EI-27653346710942048",
              "kind": "event",
              "status": "active",
              "summary": "Blocked on the declared native-execution-authority restoration event; generation 1 remains unfired.",
              "evidence": "Live events:status showed current_generation=1, current_state=declared, exactFired=false, owner su-bbfd627f-1859-4ffe-aa04-8c96b24955ea live; a separate active waiter belongs to another member. The related work item is EI-27653346710942048.",
              "nextVerb": "After the exact event fires, re-read the target evidence JSON, rerun lint:no-box-identity, then edit only if the current guard still reproduces.",
              "createdAt": "2026-11-05T22:17:56.854Z",
              "createdBy": "su-468aa74e-ed33-40ab-a5f5-d275003544d9",
              "recheckAt": "2026-11-08T15:01:29.751Z",
              "updatedAt": "2026-11-08T14:01:29.751Z",
              "capability": "live-dependency",
              "recheckedAt": "2026-11-08T14:01:29.751Z",
              "reachability": {
                "basis": "live-resolver",
                "verdict": "reachable",
                "evidence": "a live resolver or producer registration can still satisfy the condition",
                "checkedAt": "2026-11-08T14:05:41.324Z",
                "authoritative": true
              },
              "capabilitySource": "inferred",
              "recheckDisposition": "escalated"
            }
          ],
          "admissionIdentity": {
            "titleKey": "title:20261027 batch box clause docs evidence guard identity json lint p001 reconciliation red search shared sync",
            "schemaVersion": "admission-identity-v1"
          },
          "claim_hold_reason": "Park both blocked items until their exact, registered harness-scoped restoration event fires.",
          "freshnessEnvelope": {
            "observedAt": "2026-10-28T16:52:03.138Z",
            "linkedFixRefs": [],
            "reporterSession": "system:sync-batch-lint-guards",
            "observedSourceSha": "2d7239f55e",
            "toolSchemaVersion": null,
            "observedRuntimeSha": "2d7239f55e",
            "deployBuildIdentity": "2d7239f55e@0.0.0",
            "reporterRuntimeVersion": "0.0.0",
            "lastSuccessfulReproductionAt": null
          },
          "claim_hold_release": {
            "owner": "su-468aa74e-ed33-40ab-a5f5-d275003544d9",
            "trigger": "harness:papercusp:execution-authority-native-restored-EI-27653346710942048",
            "evidence": "a live resolver or producer registration can still satisfy the condition",
            "condition": "Native execution authority is restored and the held items' documented verification steps can resume.",
            "reachability": "reachable"
          },
          "claim_history_post_id": 9001788375295,
          "implementationReadiness": {
            "reason": "no-acceptance-evidence-at-creation",
            "source": "creation-enrollment",
            "status": "unknown",
            "updatedAt": "2026-10-28T16:52:03.138Z",
            "schemaVersion": "implementation-readiness-v1"
          }
        },
        "conditionKey": "sync-delta-guard:lint:no-box-identity:docs/evidence/shared-search-p001-clause-reconciliation-20261027.json"
      },
      "finalR1Disposition": "OPEN",
      "timeBoundary": "Original report retained in terminal92 raw capture, later target snapshot at 2026-11-08T15:48:45.116Z; source witnesses captured in this qualification. No inferred original-time availability or loaded runtime."
    }
  ],
  "retainedLedger": [
    {
      "id": 23487166,
      "branch": null,
      "rss_mb": 779.6,
      "source": "local",
      "status": "pass",
      "suite_id": null,
      "file_path": "packages/operator-core/lib/code-recipes-candidates.integration.test.ts",
      "framework": "vitest",
      "commit_sha": "f7c61972a8dbc2ab7d591fe306e2f16e71bb2c68",
      "created_at": "2026-11-06T14:50:54.884178+00:00",
      "started_at": "2026-11-06T14:49:59.69+00:00",
      "duration_ms": 5847,
      "finished_at": "2026-11-06T14:50:05.537+00:00",
      "output_tail": null,
      "harness_slug": "papercusp",
      "run_group_id": "5739553a-4c93-44fd-a11b-132157bd41e3",
      "workspace_id": "papercusp-workspace",
      "worktree_dirty": false,
      "loop_lag_p95_ms": null,
      "execution_details": {
        "root": "/tmp/pcv/papercusp-lint-as-committed-f7c61972a8-6H3Fnh",
        "failed": 0,
        "passed": 9,
        "skipped": 0,
        "filePath": "packages/operator-core/lib/code-recipes-candidates.integration.test.ts",
        "commitSha": "f7c61972a8dbc2ab7d591fe306e2f16e71bb2c68",
        "testLayer": "integration",
        "runGroupId": "5739553a-4c93-44fd-a11b-132157bd41e3",
        "harnessSlug": "papercusp",
        "workspaceId": "papercusp-workspace",
        "runStartedAt": "2026-11-06T14:49:24.585Z",
        "mutationPhase": null,
        "schemaVersion": 1,
        "worktreeDirty": false,
        "testNamePattern": null,
        "collectionFailed": false,
        "passedCaseTitles": [
          "recipeCandidates deterministic signals (real PG) > ranks the hot multi-tool broadly-reused recipe top, excludes the 1-tool wrapper, surfaces the merge cluster",
          "recipeCandidates deterministic signals (real PG) > honors minRunCount — recipes below the floor are not considered",
          "recipeCandidates deterministic signals (real PG) > P003-RELIABILITY: a settled failed replay lowers reliability without changing successful-use popularity",
          "recipeCandidates deterministic signals (real PG) > P003-UNKNOWN: legacy popularity cannot certify measured replay reliability",
          "recipeCandidates deterministic signals (real PG) > R10 one-tool result processing can promote while a hotter primitive wrapper cannot",
          "recipeCandidates deterministic signals (real PG) > P003-RECEIPTS: exact copies count once, distinct bulk attempts remain distinct, and conflicting copies stay unknown",
          "recipeCandidates deterministic signals (real PG) > uses the global recipe corpus across hives",
          "recipeCandidates deterministic signals (real PG) > a low-success multi-tool recipe scores below a high-success one of equal usage",
          "recipeCandidates deterministic signals (real PG) > reuse FLOOR — a single-run/single-agent multi-tool recipe is SCORED but NOT a promote candidate"
        ],
        "testTimingRuntimeIdentity": "node:25.9.0 linux/x64 vitest:4.1.8",
        "runtimeEnvironmentAfterCaptureStatus": "not-configured",
        "runtimeEnvironmentBeforeCaptureStatus": "not-configured"
      },
      "is_scratch_config": false,
      "configuration_snapshot": {
        "flagEnv": {},
        "envSha256": {
          "NODE_ENV": "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
          "PAPERCUSP_SID": "76b1ae9ce1aa4aebc055ffbbd602750040e62bed4c365edf86f8fdfec2010853",
          "PAPERCUSP_TTY": "f178200353e1fd727138022163e3cc26a49bf017a80ced7ee8d0d3e8d61e6cd3",
          "PAPERCUSP_HOME": "1d878651be83bc9d393f82c332ce28505791509084c3d77ce08aa5390db23117",
          "PAPERCUSP_AGENT": "57de4cf40144bdf7d00010f2f5557a7d642c2b9705309bfade167dd313e2ca93",
          "PAPERCUSP_MODEL": "2c8210d53bc2874b17b92d660db5458dc20282de34910622eb277177f8a11474",
          "PC_HEAVY_BYPASS": "6b86b273ff34fce19d6b804eff5a3f5747ada4eaa22f1d49c01e52ddb7875b4b",
          "PAPERCUSP_BIN_DIR": "d5db3276515e4c66ff26b25662213c94d7880572b48922ffa57352d43d3d27d3",
          "PAPERCUSP_PROFILE": "7826b958b79c70626801b880405eb5111557dadceb2fee2b1ed69a18eed0c6dc",
          "PC_HEAVY_COALESCE": "5feceb66ffc86f38d952786c6d696c79c2dbc239dd4e91b46729d73a27fb57e9",
          "PAPERCUSP_API_BASE": "39d250060856a6eb74aba1db89ea404b382b1a121c179a19eb39fcd30476192f",
          "PAPERCUSP_REPO_ROOT": "64d7a60720aceb863d1d802149f1519d51517f4867365d951028cccf326c3f99",
          "PAPERCUSP_WORKSPACE": "24201c2745800b53f808f1453ded79e6bcd37ed1757e8683f6a5e888dc1a90b2",
          "PAPERCUSP_PSU_REEXEC": "bdd2d3af3a5a1213497d4f1f7bfcda898274fe9cb5401bbc0190885664708fc2",
          "PAPERCUSP_SCRIPTS_DIR": "8a1db86dc1e42c2c501949861e312d37d12f0cc1aa39e3c8dcf085b462781e44",
          "PC_HEAVY_ADMISSION_ID": "4dcfb7a160d20aed294252bbc3f3e09ac783608c4080d4a0762b6d50233bed2d",
          "PC_HEAVY_RETRY_ACTIVE": "6b86b273ff34fce19d6b804eff5a3f5747ada4eaa22f1d49c01e52ddb7875b4b",
          "PAPERCUSP_CONTEXT_TIER": "073f3c701722d652c8ff2c6f5c18499a6e03e0a81ec2cf65a1bf6596f0686033",
          "PAPERCUSP_MODEL_SOURCE": "46b2e93c2f9ac23612d7f8e87acd2fef4cdc242f7c95679cba787415362f8a2c",
          "PAPERCUSP_OPERATOR_URL": "b224a4527f06e2bb86ca2121f0bbc56e3182320cec709203d18bbc86a249e0ef",
          "PAPERCUSP_PSU_LAUNCHER": "eb51e9312c87ceb3e73af24c326183e5488f3ef64f9c4450e01a30c67e7c6580",
          "PC_HEAVY_ADMISSION_DIR": "2e3d87ddaf4cc9697f474e935e721a325b7c408e83a0225a656aa3864db46372",
          "PAPERCUSP_AGENT_SESSION": "6b86b273ff34fce19d6b804eff5a3f5747ada4eaa22f1d49c01e52ddb7875b4b",
          "PAPERCUSP_ADV_SESSION_ID": "df586ff44296690f328d2b75f4a8a9256785fb6191043e987405936ecb0aac5e",
          "PAPERCUSP_STATE_REVISION": "85ee10a2ecb12668801e2ab628cdb17d0049dcf8fca24727219591f9b5a0521d",
          "PAPERCUSP_TEST_RUN_GROUP": "535e04ea5f0230eda2f50d50e09ae9f90529908a5f24ccdd7e3dee52e8cda8f5",
          "PAPERCUSP_PSU_REEXEC_PPID": "d041db65e10a3c0a3a4246fa2ea1fa0c901fc24ae123cd041954f736c6ebb6fc",
          "PAPERCUSP_HOST_PG_DUMP_DIR": "856a75c41b7741a012b2be872bdc5f2c3c226ab2ba50cbc0c05abacc2ba91a2a",
          "PAPERCUSP_INTEGRATION_ROOT": "64d7a60720aceb863d1d802149f1519d51517f4867365d951028cccf326c3f99",
          "PAPERCUSP_NODE_RUNTIME_DIR": "75ba9ca2d9761eb737e2d018c4b1762ec2408419d3de95b40c44718361cfd590",
          "PAPERCUSP_PSU_REEXEC_COUNT": "5feceb66ffc86f38d952786c6d696c79c2dbc239dd4e91b46729d73a27fb57e9",
          "PAPERCUSP_TEST_RUNS_DB_URL": "c942ee8b9c119f1e62d4016bb52dc6cabbf6f15fa7a77bdf9da269f2ab70ece8",
          "PAPERCUSP_TEST_RUN_HARNESS": "f4df233b6a1a63ee848f046a99738cafc2b1b7d23a6cd6afb140960556c128d0",
          "PC_HEAVY_RETRY_PREEMPTIONS": "4e07408562bedb8b60ce05c1decfe3ad16b72230967de01f640b7e4729b49fce",
          "PAPERCUSP_ADMISSION_CONTEXT": "1210cfa887dd8c2a0a0187eae8e52f38d6d51418aa53802017be2f0a97fd1189",
          "PAPERCUSP_BACKEND_PATH_DIRS": "5f59411597378372e66e3d1d98b190f04b14c1348ab0c6d7e157574e6604b41f",
          "PAPERCUSP_TEST_PG_ADMIN_URL": "8a8f20790a99d9788f3743ef5c7681801c91dffffd4ffe69272b6e99824c43be",
          "PC_HEAVY_ADMISSION_PRIORITY": "1a6562590ef19d1045d06c4055742d38288e9e6dcd71ccde5cee80f1d5a774eb",
          "PAPERCUSP_INSTALL_MUTEX_HELD": "7ae278d3661e351bd98eebd8d0afc725c23ed6449c1d2bd5a359302548a0bb3c",
          "PAPERCUSP_TEST_STARTUP_TRACE": "acce452846a9f67d6404230e79b0b190f509cde980b164040ad766ed6b9993e8",
          "PC_HEAVY_PREEMPT_AFTER_READY": "6b86b273ff34fce19d6b804eff5a3f5747ada4eaa22f1d49c01e52ddb7875b4b",
          "PC_HEAVY_PREEMPT_RESULT_FILE": "564461e9f74f00a8b6f9ea31405074ae7dac479fa340489cc967ea288b4c7542",
          "PAPERCUSP_ACCOUNT_ROUTING_MODE": "929260ad9b9ea9fe0f3553dd964f4ff3deb5792efd031a2b90f573fe91f012bb",
          "PAPERCUSP_COMMITTED_SOURCE_GIT": "106aa88494971ea56c867f371d12746ef6ce5f5bd4f73b857235642caeb88363",
          "PAPERCUSP_TEST_RUN_RECEIPT_FILE": "3f216e92df830a57fb81264127ac0910bee2ab710652eea736e0a0c7e5da02e3",
          "PAPERCUSP_SPECIFICATION_REVISION": "cbddf679d29b6ad772595c44e968f816afdd48f8f09b33a05e97d47345eebd5b",
          "PAPERCUSP_LINT_AS_COMMITTED_CLONE": "6b86b273ff34fce19d6b804eff5a3f5747ada4eaa22f1d49c01e52ddb7875b4b",
          "PAPERCUSP_OPERATOR_URL_PROVENANCE": "a64c6cfe24de5ca2c850e86d56223a85756cd35f501cbc6d86daf28404b9a2a1",
          "PAPERCUSP_COMMITTED_SOURCE_NOTICES": "f77f80e146e983a633790c9f5c263915c2b8995aeaff987f3ae30ae7e9eff307",
          "PAPERCUSP_RESTRICTED_HOLD_PREFLIGHT": "749a7554eba9d6fd2ad69c3b29c083c6c9e56f360a4c3216306571aa826ba539",
          "PAPERCUSP_LINT_AS_COMMITTED_PREPARED_ROOT_RECEIPT": "c2deefc8497ac1e52c1ab975d8dde5ab1ab0b8d0d7ac0df48faa54d50ff5dc1e"
        },
        "fingerprint": "sha256-config-snapshot-v1:c58bc21ce9f26678cdce19fc7285cc9576849ebb791609f256a8056c2513d016",
        "schemaVersion": 1
      }
    },
    {
      "id": 23487695,
      "branch": null,
      "rss_mb": 802.5,
      "source": "mutation-probe",
      "status": "pass",
      "suite_id": null,
      "file_path": "packages/operator-core/lib/code-recipes-candidates.integration.test.ts",
      "framework": "vitest",
      "commit_sha": "f7c61972a8dbc2ab7d591fe306e2f16e71bb2c68",
      "created_at": "2026-11-06T14:53:23.159119+00:00",
      "started_at": "2026-11-06T14:53:16.906+00:00",
      "duration_ms": 4426,
      "finished_at": "2026-11-06T14:53:21.332+00:00",
      "output_tail": null,
      "harness_slug": "papercusp",
      "run_group_id": "34a24175-990c-4ad9-8bb4-2ab987301d2a",
      "workspace_id": "papercusp-workspace",
      "worktree_dirty": false,
      "loop_lag_p95_ms": null,
      "execution_details": {
        "root": "/tmp/pcv/papercusp-lint-as-committed-f7c61972a8-6H3Fnh",
        "failed": 0,
        "passed": 9,
        "skipped": 0,
        "filePath": "packages/operator-core/lib/code-recipes-candidates.integration.test.ts",
        "mutation": {
          "leg": "baseline",
          "mode": "copy-out",
          "mutantDiff": "--- a/packages/operator-core/lib/code-recipes-candidates.ts\n+++ b/packages/operator-core/lib/code-recipes-candidates.ts\n@@ -434,7 +434,7 @@\n     const errors = asInt(r.replay_errors);\n     const refused = asInt(r.replay_refused);\n     const denominator = successes + errors + refused;\n-    const successRate = denominator > 0 ? clamp01(successes / denominator) : 0;\n+    const successRate = denominator > 0 ? clamp01(successes / successes) : 0;\n     const usage: RecipeUsageSummary = {\n       unit: 'execution-receipts', observations: asInt(r.observations), sourceRows: asInt(r.source_rows),\n       verifiedCopiesExcluded: asInt(r.copies_excluded), conflictingReceipts: asInt(r.conflicts), authored: asInt(r.authored),\n",
          "subjectPath": "packages/operator-core/lib/code-recipes-candidates.ts",
          "testCommand": "test -f {} && npm run test:file -- packages/operator-core/lib/code-recipes-candidates.integration.test.ts",
          "againstCommit": null,
          "schemaVersion": 1,
          "testFileSha256": "a515ce980583116eb0c1d8995a3f4aefaf24c5d7d74ee05ca0f6d42f112d971c",
          "mutateExpression": "s{successes / denominator}{successes / successes}",
          "probeInvocationId": "6e813f9c-3a04-4368-b233-0c514f834310",
          "testCommandSha256": "7a861316e9d8cc489f348cce94c053e38f11a482586d0de5ca752e8c8fbe1fef",
          "subjectAfterSha256": "1109e72e53a52f8ec192461e847583e1a8818eb1f74b3a575ea796a58c9bf3bd",
          "mutantDiffTruncated": false,
          "subjectBeforeSha256": "b7d2648448cdd398b76ba147077f4fb3a921ee8ef1de6d28cd70adf3f4bceec1"
        },
        "commitSha": "f7c61972a8dbc2ab7d591fe306e2f16e71bb2c68",
        "testLayer": "integration",
        "runGroupId": "34a24175-990c-4ad9-8bb4-2ab987301d2a",
        "harnessSlug": "papercusp",
        "workspaceId": "papercusp-workspace",
        "runStartedAt": "2026-11-06T14:52:46.424Z",
        "mutationPhase": "baseline",
        "schemaVersion": 1,
        "worktreeDirty": false,
        "testNamePattern": null,
        "collectionFailed": false,
        "passedCaseTitles": [
          "recipeCandidates deterministic signals (real PG) > ranks the hot multi-tool broadly-reused recipe top, excludes the 1-tool wrapper, surfaces the merge cluster",
          "recipeCandidates deterministic signals (real PG) > honors minRunCount — recipes below the floor are not considered",
          "recipeCandidates deterministic signals (real PG) > P003-RELIABILITY: a settled failed replay lowers reliability without changing successful-use popularity",
          "recipeCandidates deterministic signals (real PG) > P003-UNKNOWN: legacy popularity cannot certify measured replay reliability",
          "recipeCandidates deterministic signals (real PG) > R10 one-tool result processing can promote while a hotter primitive wrapper cannot",
          "recipeCandidates deterministic signals (real PG) > P003-RECEIPTS: exact copies count once, distinct bulk attempts remain distinct, and conflicting copies stay unknown",
          "recipeCandidates deterministic signals (real PG) > uses the global recipe corpus across hives",
          "recipeCandidates deterministic signals (real PG) > a low-success multi-tool recipe scores below a high-success one of equal usage",
          "recipeCandidates deterministic signals (real PG) > reuse FLOOR — a single-run/single-agent multi-tool recipe is SCORED but NOT a promote candidate"
        ],
        "testTimingRuntimeIdentity": "node:25.9.0 linux/x64 vitest:4.1.8",
        "runtimeEnvironmentAfterCaptureStatus": "not-configured",
        "runtimeEnvironmentBeforeCaptureStatus": "not-configured"
      },
      "is_scratch_config": false,
      "configuration_snapshot": {
        "flagEnv": {},
        "envSha256": {
          "NODE_ENV": "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
          "PAPERCUSP_SID": "76b1ae9ce1aa4aebc055ffbbd602750040e62bed4c365edf86f8fdfec2010853",
          "PAPERCUSP_TTY": "f178200353e1fd727138022163e3cc26a49bf017a80ced7ee8d0d3e8d61e6cd3",
          "PAPERCUSP_HOME": "1d878651be83bc9d393f82c332ce28505791509084c3d77ce08aa5390db23117",
          "PAPERCUSP_AGENT": "57de4cf40144bdf7d00010f2f5557a7d642c2b9705309bfade167dd313e2ca93",
          "PAPERCUSP_MODEL": "2c8210d53bc2874b17b92d660db5458dc20282de34910622eb277177f8a11474",
          "PC_HEAVY_BYPASS": "6b86b273ff34fce19d6b804eff5a3f5747ada4eaa22f1d49c01e52ddb7875b4b",
          "PAPERCUSP_BIN_DIR": "d5db3276515e4c66ff26b25662213c94d7880572b48922ffa57352d43d3d27d3",
          "PAPERCUSP_PROFILE": "7826b958b79c70626801b880405eb5111557dadceb2fee2b1ed69a18eed0c6dc",
          "PC_HEAVY_COALESCE": "5feceb66ffc86f38d952786c6d696c79c2dbc239dd4e91b46729d73a27fb57e9",
          "PAPERCUSP_API_BASE": "39d250060856a6eb74aba1db89ea404b382b1a121c179a19eb39fcd30476192f",
          "PAPERCUSP_REPO_ROOT": "64d7a60720aceb863d1d802149f1519d51517f4867365d951028cccf326c3f99",
          "PAPERCUSP_WORKSPACE": "24201c2745800b53f808f1453ded79e6bcd37ed1757e8683f6a5e888dc1a90b2",
          "PAPERCUSP_PSU_REEXEC": "bdd2d3af3a5a1213497d4f1f7bfcda898274fe9cb5401bbc0190885664708fc2",
          "PAPERCUSP_SCRIPTS_DIR": "8a1db86dc1e42c2c501949861e312d37d12f0cc1aa39e3c8dcf085b462781e44",
          "PC_HEAVY_ADMISSION_ID": "730e19c5faa29d4ab70b731b035ede3983c8989dd1b94871bd4f391be7ba4f9c",
          "PC_HEAVY_RETRY_ACTIVE": "6b86b273ff34fce19d6b804eff5a3f5747ada4eaa22f1d49c01e52ddb7875b4b",
          "PAPERCUSP_CONTEXT_TIER": "073f3c701722d652c8ff2c6f5c18499a6e03e0a81ec2cf65a1bf6596f0686033",
          "PAPERCUSP_MODEL_SOURCE": "46b2e93c2f9ac23612d7f8e87acd2fef4cdc242f7c95679cba787415362f8a2c",
          "PAPERCUSP_OPERATOR_URL": "b224a4527f06e2bb86ca2121f0bbc56e3182320cec709203d18bbc86a249e0ef",
          "PAPERCUSP_PSU_LAUNCHER": "eb51e9312c87ceb3e73af24c326183e5488f3ef64f9c4450e01a30c67e7c6580",
          "PAPERCUSP_WORKSPACE_ID": "24201c2745800b53f808f1453ded79e6bcd37ed1757e8683f6a5e888dc1a90b2",
          "PC_HEAVY_ADMISSION_DIR": "2e3d87ddaf4cc9697f474e935e721a325b7c408e83a0225a656aa3864db46372",
          "PAPERCUSP_AGENT_SESSION": "6b86b273ff34fce19d6b804eff5a3f5747ada4eaa22f1d49c01e52ddb7875b4b",
          "PAPERCUSP_MUTATION_MODE": "5feceb66ffc86f38d952786c6d696c79c2dbc239dd4e91b46729d73a27fb57e9",
          "PAPERCUSP_ADV_SESSION_ID": "df586ff44296690f328d2b75f4a8a9256785fb6191043e987405936ecb0aac5e",
          "PAPERCUSP_MUTATION_PHASE": "8ba8496a2525ae171ffd104d632dede6ef418d9b95962a9d88e2fcdbc8d48d24",
          "PAPERCUSP_MUTATION_PROBE": "6b86b273ff34fce19d6b804eff5a3f5747ada4eaa22f1d49c01e52ddb7875b4b",
          "PAPERCUSP_STATE_REVISION": "85ee10a2ecb12668801e2ab628cdb17d0049dcf8fca24727219591f9b5a0521d",
          "PAPERCUSP_TEST_RUN_GROUP": "2a2cc2ef584af2de5a5bdfe76a5aaaec572a6fe763463c1e0914da55abf847be",
          "PAPERCUSP_PSU_REEXEC_PPID": "d041db65e10a3c0a3a4246fa2ea1fa0c901fc24ae123cd041954f736c6ebb6fc",
          "PAPERCUSP_HOST_PG_DUMP_DIR": "856a75c41b7741a012b2be872bdc5f2c3c226ab2ba50cbc0c05abacc2ba91a2a",
          "PAPERCUSP_INTEGRATION_ROOT": "64d7a60720aceb863d1d802149f1519d51517f4867365d951028cccf326c3f99",
          "PAPERCUSP_NODE_RUNTIME_DIR": "75ba9ca2d9761eb737e2d018c4b1762ec2408419d3de95b40c44718361cfd590",
          "PAPERCUSP_PSU_REEXEC_COUNT": "5feceb66ffc86f38d952786c6d696c79c2dbc239dd4e91b46729d73a27fb57e9",
          "PAPERCUSP_TEST_RUNS_DB_URL": "c942ee8b9c119f1e62d4016bb52dc6cabbf6f15fa7a77bdf9da269f2ab70ece8",
          "PAPERCUSP_TEST_RUN_HARNESS": "f4df233b6a1a63ee848f046a99738cafc2b1b7d23a6cd6afb140960556c128d0",
          "PC_HEAVY_RETRY_PREEMPTIONS": "4e07408562bedb8b60ce05c1decfe3ad16b72230967de01f640b7e4729b49fce",
          "PAPERCUSP_ADMISSION_CONTEXT": "0c5aa305a508dfdb16fde12c1231d4a4f82fd6784d90d6c15d64916227c8301d",
          "PAPERCUSP_BACKEND_PATH_DIRS": "5f59411597378372e66e3d1d98b190f04b14c1348ab0c6d7e157574e6604b41f",
          "PAPERCUSP_TEST_PG_ADMIN_URL": "8a8f20790a99d9788f3743ef5c7681801c91dffffd4ffe69272b6e99824c43be",
          "PC_HEAVY_ADMISSION_PRIORITY": "1a6562590ef19d1045d06c4055742d38288e9e6dcd71ccde5cee80f1d5a774eb",
          "PAPERCUSP_INSTALL_MUTEX_HELD": "7ae278d3661e351bd98eebd8d0afc725c23ed6449c1d2bd5a359302548a0bb3c",
          "PAPERCUSP_TEST_RUN_WORKSPACE": "24201c2745800b53f808f1453ded79e6bcd37ed1757e8683f6a5e888dc1a90b2",
          "PAPERCUSP_TEST_STARTUP_TRACE": "acce452846a9f67d6404230e79b0b190f509cde980b164040ad766ed6b9993e8",
          "PC_HEAVY_PREEMPT_AFTER_READY": "6b86b273ff34fce19d6b804eff5a3f5747ada4eaa22f1d49c01e52ddb7875b4b",
          "PC_HEAVY_PREEMPT_RESULT_FILE": "6bc05676970bbaf684a52df35b3c80a39a693bd26e5189a725d9ce551e3fe988",
          "PAPERCUSP_MUTATION_DESCRIPTOR": "fb9bccc22e18e805f34c1291f8020375543cfddb10b229cb56ab079e857e0f65",
          "PAPERCUSP_ACCOUNT_ROUTING_MODE": "929260ad9b9ea9fe0f3553dd964f4ff3deb5792efd031a2b90f573fe91f012bb",
          "PAPERCUSP_COMMITTED_SOURCE_GIT": "106aa88494971ea56c867f371d12746ef6ce5f5bd4f73b857235642caeb88363",
          "PAPERCUSP_TEST_RUN_RECEIPT_FILE": "04e9a9d35905546766d584c130f857717701af19b6f41f60e8ea98bcc90100b3",
          "PAPERCUSP_SPECIFICATION_REVISION": "cbddf679d29b6ad772595c44e968f816afdd48f8f09b33a05e97d47345eebd5b",
          "PAPERCUSP_LINT_AS_COMMITTED_CLONE": "6b86b273ff34fce19d6b804eff5a3f5747ada4eaa22f1d49c01e52ddb7875b4b",
          "PAPERCUSP_OPERATOR_URL_PROVENANCE": "a64c6cfe24de5ca2c850e86d56223a85756cd35f501cbc6d86daf28404b9a2a1",
          "PAPERCUSP_COMMITTED_SOURCE_NOTICES": "63319e8ec0ffc74d82b4cd6128a9128c77b4c9b8db0f6a49965f7ab71fc80c35",
          "PAPERCUSP_RESTRICTED_HOLD_PREFLIGHT": "749a7554eba9d6fd2ad69c3b29c083c6c9e56f360a4c3216306571aa826ba539",
          "PAPERCUSP_MUTATION_DESCRIPTOR_READER_HEALTH_URL": "aa3bce62afb6a116f1335d787128219e2eb6d4a921ec1fd273989cf13eb7980f",
          "PAPERCUSP_LINT_AS_COMMITTED_PREPARED_ROOT_RECEIPT": "c2deefc8497ac1e52c1ab975d8dde5ab1ab0b8d0d7ac0df48faa54d50ff5dc1e"
        },
        "fingerprint": "sha256-config-snapshot-v1:bda89dcaeec51407d4c2fa420e27ef0dcb2c5865503796cd4519b25b94a889cd",
        "schemaVersion": 1
      }
    },
    {
      "id": 23487721,
      "branch": null,
      "rss_mb": 694.7,
      "source": "mutation-probe",
      "status": "pass",
      "suite_id": null,
      "file_path": "packages/operator-core/lib/code-recipes-candidates.integration.test.ts",
      "framework": "vitest",
      "commit_sha": "f7c61972a8dbc2ab7d591fe306e2f16e71bb2c68",
      "created_at": "2026-11-06T14:54:20.74455+00:00",
      "started_at": "2026-11-06T14:54:15.555+00:00",
      "duration_ms": 3742,
      "finished_at": "2026-11-06T14:54:19.297+00:00",
      "output_tail": null,
      "harness_slug": "papercusp",
      "run_group_id": "a2e8a795-57ef-4072-a901-64258f706f8b",
      "workspace_id": "papercusp-workspace",
      "worktree_dirty": false,
      "loop_lag_p95_ms": null,
      "execution_details": {
        "root": "/tmp/pcv/papercusp-lint-as-committed-f7c61972a8-6H3Fnh",
        "failed": 0,
        "passed": 9,
        "skipped": 0,
        "filePath": "packages/operator-core/lib/code-recipes-candidates.integration.test.ts",
        "mutation": {
          "leg": "copy-baseline",
          "mode": "copy-out",
          "mutantDiff": "--- a/packages/operator-core/lib/code-recipes-candidates.ts\n+++ b/packages/operator-core/lib/code-recipes-candidates.ts\n@@ -434,7 +434,7 @@\n     const errors = asInt(r.replay_errors);\n     const refused = asInt(r.replay_refused);\n     const denominator = successes + errors + refused;\n-    const successRate = denominator > 0 ? clamp01(successes / denominator) : 0;\n+    const successRate = denominator > 0 ? clamp01(successes / successes) : 0;\n     const usage: RecipeUsageSummary = {\n       unit: 'execution-receipts', observations: asInt(r.observations), sourceRows: asInt(r.source_rows),\n       verifiedCopiesExcluded: asInt(r.copies_excluded), conflictingReceipts: asInt(r.conflicts), authored: asInt(r.authored),\n",
          "subjectPath": "packages/operator-core/lib/code-recipes-candidates.ts",
          "testCommand": "test -f {} && npm run test:file -- packages/operator-core/lib/code-recipes-candidates.integration.test.ts",
          "againstCommit": null,
          "schemaVersion": 1,
          "testFileSha256": "a515ce980583116eb0c1d8995a3f4aefaf24c5d7d74ee05ca0f6d42f112d971c",
          "mutateExpression": "s{successes / denominator}{successes / successes}",
          "probeInvocationId": "6e813f9c-3a04-4368-b233-0c514f834310",
          "testCommandSha256": "7a861316e9d8cc489f348cce94c053e38f11a482586d0de5ca752e8c8fbe1fef",
          "subjectAfterSha256": "1109e72e53a52f8ec192461e847583e1a8818eb1f74b3a575ea796a58c9bf3bd",
          "mutantDiffTruncated": false,
          "subjectBeforeSha256": "b7d2648448cdd398b76ba147077f4fb3a921ee8ef1de6d28cd70adf3f4bceec1"
        },
        "commitSha": "f7c61972a8dbc2ab7d591fe306e2f16e71bb2c68",
        "testLayer": "integration",
        "runGroupId": "a2e8a795-57ef-4072-a901-64258f706f8b",
        "harnessSlug": "papercusp",
        "workspaceId": "papercusp-workspace",
        "runStartedAt": "2026-11-06T14:53:44.637Z",
        "mutationPhase": "copy-baseline",
        "schemaVersion": 1,
        "worktreeDirty": false,
        "testNamePattern": null,
        "collectionFailed": false,
        "passedCaseTitles": [
          "recipeCandidates deterministic signals (real PG) > ranks the hot multi-tool broadly-reused recipe top, excludes the 1-tool wrapper, surfaces the merge cluster",
          "recipeCandidates deterministic signals (real PG) > honors minRunCount — recipes below the floor are not considered",
          "recipeCandidates deterministic signals (real PG) > P003-RELIABILITY: a settled failed replay lowers reliability without changing successful-use popularity",
          "recipeCandidates deterministic signals (real PG) > P003-UNKNOWN: legacy popularity cannot certify measured replay reliability",
          "recipeCandidates deterministic signals (real PG) > R10 one-tool result processing can promote while a hotter primitive wrapper cannot",
          "recipeCandidates deterministic signals (real PG) > P003-RECEIPTS: exact copies count once, distinct bulk attempts remain distinct, and conflicting copies stay unknown",
          "recipeCandidates deterministic signals (real PG) > uses the global recipe corpus across hives",
          "recipeCandidates deterministic signals (real PG) > a low-success multi-tool recipe scores below a high-success one of equal usage",
          "recipeCandidates deterministic signals (real PG) > reuse FLOOR — a single-run/single-agent multi-tool recipe is SCORED but NOT a promote candidate"
        ],
        "testTimingRuntimeIdentity": "node:25.9.0 linux/x64 vitest:4.1.8",
        "runtimeEnvironmentAfterCaptureStatus": "not-configured",
        "runtimeEnvironmentBeforeCaptureStatus": "not-configured"
      },
      "is_scratch_config": false,
      "configuration_snapshot": {
        "flagEnv": {},
        "envSha256": {
          "NODE_ENV": "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
          "PAPERCUSP_SID": "76b1ae9ce1aa4aebc055ffbbd602750040e62bed4c365edf86f8fdfec2010853",
          "PAPERCUSP_TTY": "f178200353e1fd727138022163e3cc26a49bf017a80ced7ee8d0d3e8d61e6cd3",
          "PAPERCUSP_HOME": "1d878651be83bc9d393f82c332ce28505791509084c3d77ce08aa5390db23117",
          "PAPERCUSP_AGENT": "57de4cf40144bdf7d00010f2f5557a7d642c2b9705309bfade167dd313e2ca93",
          "PAPERCUSP_MODEL": "2c8210d53bc2874b17b92d660db5458dc20282de34910622eb277177f8a11474",
          "PC_HEAVY_BYPASS": "6b86b273ff34fce19d6b804eff5a3f5747ada4eaa22f1d49c01e52ddb7875b4b",
          "PAPERCUSP_BIN_DIR": "d5db3276515e4c66ff26b25662213c94d7880572b48922ffa57352d43d3d27d3",
          "PAPERCUSP_PROFILE": "7826b958b79c70626801b880405eb5111557dadceb2fee2b1ed69a18eed0c6dc",
          "PC_HEAVY_COALESCE": "5feceb66ffc86f38d952786c6d696c79c2dbc239dd4e91b46729d73a27fb57e9",
          "PAPERCUSP_API_BASE": "39d250060856a6eb74aba1db89ea404b382b1a121c179a19eb39fcd30476192f",
          "PAPERCUSP_REPO_ROOT": "64d7a60720aceb863d1d802149f1519d51517f4867365d951028cccf326c3f99",
          "PAPERCUSP_WORKSPACE": "24201c2745800b53f808f1453ded79e6bcd37ed1757e8683f6a5e888dc1a90b2",
          "PAPERCUSP_PSU_REEXEC": "bdd2d3af3a5a1213497d4f1f7bfcda898274fe9cb5401bbc0190885664708fc2",
          "PAPERCUSP_SCRIPTS_DIR": "8a1db86dc1e42c2c501949861e312d37d12f0cc1aa39e3c8dcf085b462781e44",
          "PC_HEAVY_ADMISSION_ID": "b46f8fdccb52e00871aa888260b0038d1c58b49cebf737044cd2c0c3a73bcfc9",
          "PC_HEAVY_RETRY_ACTIVE": "6b86b273ff34fce19d6b804eff5a3f5747ada4eaa22f1d49c01e52ddb7875b4b",
          "PAPERCUSP_CONTEXT_TIER": "073f3c701722d652c8ff2c6f5c18499a6e03e0a81ec2cf65a1bf6596f0686033",
          "PAPERCUSP_MODEL_SOURCE": "46b2e93c2f9ac23612d7f8e87acd2fef4cdc242f7c95679cba787415362f8a2c",
          "PAPERCUSP_OPERATOR_URL": "b224a4527f06e2bb86ca2121f0bbc56e3182320cec709203d18bbc86a249e0ef",
          "PAPERCUSP_PSU_LAUNCHER": "eb51e9312c87ceb3e73af24c326183e5488f3ef64f9c4450e01a30c67e7c6580",
          "PAPERCUSP_WORKSPACE_ID": "24201c2745800b53f808f1453ded79e6bcd37ed1757e8683f6a5e888dc1a90b2",
          "PC_HEAVY_ADMISSION_DIR": "2e3d87ddaf4cc9697f474e935e721a325b7c408e83a0225a656aa3864db46372",
          "PAPERCUSP_AGENT_SESSION": "6b86b273ff34fce19d6b804eff5a3f5747ada4eaa22f1d49c01e52ddb7875b4b",
          "PAPERCUSP_MUTATION_MODE": "5feceb66ffc86f38d952786c6d696c79c2dbc239dd4e91b46729d73a27fb57e9",
          "PAPERCUSP_ADV_SESSION_ID": "df586ff44296690f328d2b75f4a8a9256785fb6191043e987405936ecb0aac5e",
          "PAPERCUSP_MUTATION_PHASE": "7e4b5fae7fa912bc1f27662578fc028dd6dc654c5e1668aac0b1f9d8e6c2c269",
          "PAPERCUSP_MUTATION_PROBE": "6b86b273ff34fce19d6b804eff5a3f5747ada4eaa22f1d49c01e52ddb7875b4b",
          "PAPERCUSP_STATE_REVISION": "85ee10a2ecb12668801e2ab628cdb17d0049dcf8fca24727219591f9b5a0521d",
          "PAPERCUSP_TEST_RUN_GROUP": "916820424dd5197b7b1d3df26bd097a8585ef5eb75e9d0ca3f5847c6299bf967",
          "PAPERCUSP_PSU_REEXEC_PPID": "d041db65e10a3c0a3a4246fa2ea1fa0c901fc24ae123cd041954f736c6ebb6fc",
          "PAPERCUSP_HOST_PG_DUMP_DIR": "856a75c41b7741a012b2be872bdc5f2c3c226ab2ba50cbc0c05abacc2ba91a2a",
          "PAPERCUSP_INTEGRATION_ROOT": "64d7a60720aceb863d1d802149f1519d51517f4867365d951028cccf326c3f99",
          "PAPERCUSP_NODE_RUNTIME_DIR": "75ba9ca2d9761eb737e2d018c4b1762ec2408419d3de95b40c44718361cfd590",
          "PAPERCUSP_PSU_REEXEC_COUNT": "5feceb66ffc86f38d952786c6d696c79c2dbc239dd4e91b46729d73a27fb57e9",
          "PAPERCUSP_TEST_RUNS_DB_URL": "c942ee8b9c119f1e62d4016bb52dc6cabbf6f15fa7a77bdf9da269f2ab70ece8",
          "PAPERCUSP_TEST_RUN_HARNESS": "f4df233b6a1a63ee848f046a99738cafc2b1b7d23a6cd6afb140960556c128d0",
          "PC_HEAVY_RETRY_PREEMPTIONS": "4e07408562bedb8b60ce05c1decfe3ad16b72230967de01f640b7e4729b49fce",
          "PAPERCUSP_ADMISSION_CONTEXT": "f1b1b1e0b4deb0e6dd7b3e29dc33bb63e9e732bc5625f0e2e763bd7f26eaee0b",
          "PAPERCUSP_BACKEND_PATH_DIRS": "5f59411597378372e66e3d1d98b190f04b14c1348ab0c6d7e157574e6604b41f",
          "PAPERCUSP_TEST_PG_ADMIN_URL": "8a8f20790a99d9788f3743ef5c7681801c91dffffd4ffe69272b6e99824c43be",
          "PC_HEAVY_ADMISSION_PRIORITY": "1a6562590ef19d1045d06c4055742d38288e9e6dcd71ccde5cee80f1d5a774eb",
          "PAPERCUSP_INSTALL_MUTEX_HELD": "7ae278d3661e351bd98eebd8d0afc725c23ed6449c1d2bd5a359302548a0bb3c",
          "PAPERCUSP_TEST_RUN_WORKSPACE": "24201c2745800b53f808f1453ded79e6bcd37ed1757e8683f6a5e888dc1a90b2",
          "PAPERCUSP_TEST_STARTUP_TRACE": "acce452846a9f67d6404230e79b0b190f509cde980b164040ad766ed6b9993e8",
          "PC_HEAVY_PREEMPT_AFTER_READY": "6b86b273ff34fce19d6b804eff5a3f5747ada4eaa22f1d49c01e52ddb7875b4b",
          "PC_HEAVY_PREEMPT_RESULT_FILE": "80bf67675861eebd701fe435775b72e89aef005d7ec5a973d85e53eea507a784",
          "PAPERCUSP_MUTATION_DESCRIPTOR": "fb9bccc22e18e805f34c1291f8020375543cfddb10b229cb56ab079e857e0f65",
          "PAPERCUSP_ACCOUNT_ROUTING_MODE": "929260ad9b9ea9fe0f3553dd964f4ff3deb5792efd031a2b90f573fe91f012bb",
          "PAPERCUSP_COMMITTED_SOURCE_GIT": "106aa88494971ea56c867f371d12746ef6ce5f5bd4f73b857235642caeb88363",
          "PAPERCUSP_TEST_RUN_RECEIPT_FILE": "997e3e7e61020b663430f69c4863234f89407b8c20fde3c45b0150f2b058cf48",
          "PAPERCUSP_MUTATION_PROBE_SUBJECT": "94718097ce73b9c2223b4d04940ec94f1a766d8e2cc472e47c13708b137aa234",
          "PAPERCUSP_SPECIFICATION_REVISION": "cbddf679d29b6ad772595c44e968f816afdd48f8f09b33a05e97d47345eebd5b",
          "PAPERCUSP_LINT_AS_COMMITTED_CLONE": "6b86b273ff34fce19d6b804eff5a3f5747ada4eaa22f1d49c01e52ddb7875b4b",
          "PAPERCUSP_OPERATOR_URL_PROVENANCE": "a64c6cfe24de5ca2c850e86d56223a85756cd35f501cbc6d86daf28404b9a2a1",
          "PAPERCUSP_COMMITTED_SOURCE_NOTICES": "11fd4c21f34aecea7813c733dec5344679094480a4db1f8fdda77eb000ed7e07",
          "PAPERCUSP_RESTRICTED_HOLD_PREFLIGHT": "749a7554eba9d6fd2ad69c3b29c083c6c9e56f360a4c3216306571aa826ba539",
          "PAPERCUSP_MUTATION_DESCRIPTOR_READER_HEALTH_URL": "aa3bce62afb6a116f1335d787128219e2eb6d4a921ec1fd273989cf13eb7980f",
          "PAPERCUSP_LINT_AS_COMMITTED_PREPARED_ROOT_RECEIPT": "c2deefc8497ac1e52c1ab975d8dde5ab1ab0b8d0d7ac0df48faa54d50ff5dc1e"
        },
        "fingerprint": "sha256-config-snapshot-v1:55a6ed90b111d7e0c3623197d069b7a32f14f3c49da4497ccb1b0c40f68394d0",
        "schemaVersion": 1
      }
    },
    {
      "id": 23487723,
      "branch": null,
      "rss_mb": 700.3,
      "source": "mutation-probe",
      "status": "fail",
      "suite_id": null,
      "file_path": "packages/operator-core/lib/code-recipes-candidates.integration.test.ts",
      "framework": "vitest",
      "commit_sha": "f7c61972a8dbc2ab7d591fe306e2f16e71bb2c68",
      "created_at": "2026-11-06T14:55:17.886671+00:00",
      "started_at": "2026-11-06T14:55:11.846+00:00",
      "duration_ms": 3952,
      "finished_at": "2026-11-06T14:55:15.798+00:00",
      "output_tail": "recipeCandidates deterministic signals (real PG) > P003-RELIABILITY: a settled failed replay lowers reliability without changing successful-use popularity: expected 1 to be 0.5 // Object.is equality\nactual: 1\nexpected: 0.5\nrecipeCandidates deterministic signals (real PG) > a low-success multi-tool recipe scores below a high-success one of equal usage: expected 0.696509284028718 to be greater than 0.696509284028718\nactual: 0.696509284028718\nexpected: 0.696509284028718",
      "harness_slug": "papercusp",
      "run_group_id": "2db24e84-caeb-41f4-b8dc-430e53374c76",
      "workspace_id": "papercusp-workspace",
      "worktree_dirty": false,
      "loop_lag_p95_ms": null,
      "execution_details": {
        "root": "/tmp/pcv/papercusp-lint-as-committed-f7c61972a8-6H3Fnh",
        "failed": 2,
        "passed": 7,
        "skipped": 0,
        "filePath": "packages/operator-core/lib/code-recipes-candidates.integration.test.ts",
        "mutation": {
          "leg": "mutant",
          "mode": "copy-out",
          "mutantDiff": "--- a/packages/operator-core/lib/code-recipes-candidates.ts\n+++ b/packages/operator-core/lib/code-recipes-candidates.ts\n@@ -434,7 +434,7 @@\n     const errors = asInt(r.replay_errors);\n     const refused = asInt(r.replay_refused);\n     const denominator = successes + errors + refused;\n-    const successRate = denominator > 0 ? clamp01(successes / denominator) : 0;\n+    const successRate = denominator > 0 ? clamp01(successes / successes) : 0;\n     const usage: RecipeUsageSummary = {\n       unit: 'execution-receipts', observations: asInt(r.observations), sourceRows: asInt(r.source_rows),\n       verifiedCopiesExcluded: asInt(r.copies_excluded), conflictingReceipts: asInt(r.conflicts), authored: asInt(r.authored),\n",
          "subjectPath": "packages/operator-core/lib/code-recipes-candidates.ts",
          "testCommand": "test -f {} && npm run test:file -- packages/operator-core/lib/code-recipes-candidates.integration.test.ts",
          "againstCommit": null,
          "schemaVersion": 1,
          "testFileSha256": "a515ce980583116eb0c1d8995a3f4aefaf24c5d7d74ee05ca0f6d42f112d971c",
          "mutateExpression": "s{successes / denominator}{successes / successes}",
          "probeInvocationId": "6e813f9c-3a04-4368-b233-0c514f834310",
          "testCommandSha256": "7a861316e9d8cc489f348cce94c053e38f11a482586d0de5ca752e8c8fbe1fef",
          "subjectAfterSha256": "1109e72e53a52f8ec192461e847583e1a8818eb1f74b3a575ea796a58c9bf3bd",
          "mutantDiffTruncated": false,
          "subjectBeforeSha256": "b7d2648448cdd398b76ba147077f4fb3a921ee8ef1de6d28cd70adf3f4bceec1"
        },
        "commitSha": "f7c61972a8dbc2ab7d591fe306e2f16e71bb2c68",
        "testLayer": "integration",
        "runGroupId": "2db24e84-caeb-41f4-b8dc-430e53374c76",
        "harnessSlug": "papercusp",
        "workspaceId": "papercusp-workspace",
        "runStartedAt": "2026-11-06T14:54:40.472Z",
        "mutationPhase": "mutant",
        "schemaVersion": 1,
        "worktreeDirty": false,
        "testNamePattern": null,
        "collectionFailed": false,
        "failedCaseTitles": [
          "recipeCandidates deterministic signals (real PG) > P003-RELIABILITY: a settled failed replay lowers reliability without changing successful-use popularity",
          "recipeCandidates deterministic signals (real PG) > a low-success multi-tool recipe scores below a high-success one of equal usage"
        ],
        "passedCaseTitles": [
          "recipeCandidates deterministic signals (real PG) > ranks the hot multi-tool broadly-reused recipe top, excludes the 1-tool wrapper, surfaces the merge cluster",
          "recipeCandidates deterministic signals (real PG) > honors minRunCount — recipes below the floor are not considered",
          "recipeCandidates deterministic signals (real PG) > P003-UNKNOWN: legacy popularity cannot certify measured replay reliability",
          "recipeCandidates deterministic signals (real PG) > R10 one-tool result processing can promote while a hotter primitive wrapper cannot",
          "recipeCandidates deterministic signals (real PG) > P003-RECEIPTS: exact copies count once, distinct bulk attempts remain distinct, and conflicting copies stay unknown",
          "recipeCandidates deterministic signals (real PG) > uses the global recipe corpus across hives",
          "recipeCandidates deterministic signals (real PG) > reuse FLOOR — a single-run/single-agent multi-tool recipe is SCORED but NOT a promote candidate"
        ],
        "testTimingRuntimeIdentity": "node:25.9.0 linux/x64 vitest:4.1.8",
        "runtimeEnvironmentAfterCaptureStatus": "not-configured",
        "runtimeEnvironmentBeforeCaptureStatus": "not-configured"
      },
      "is_scratch_config": false,
      "configuration_snapshot": {
        "flagEnv": {},
        "envSha256": {
          "NODE_ENV": "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
          "PAPERCUSP_SID": "76b1ae9ce1aa4aebc055ffbbd602750040e62bed4c365edf86f8fdfec2010853",
          "PAPERCUSP_TTY": "f178200353e1fd727138022163e3cc26a49bf017a80ced7ee8d0d3e8d61e6cd3",
          "PAPERCUSP_HOME": "1d878651be83bc9d393f82c332ce28505791509084c3d77ce08aa5390db23117",
          "PAPERCUSP_AGENT": "57de4cf40144bdf7d00010f2f5557a7d642c2b9705309bfade167dd313e2ca93",
          "PAPERCUSP_MODEL": "2c8210d53bc2874b17b92d660db5458dc20282de34910622eb277177f8a11474",
          "PC_HEAVY_BYPASS": "6b86b273ff34fce19d6b804eff5a3f5747ada4eaa22f1d49c01e52ddb7875b4b",
          "PAPERCUSP_BIN_DIR": "d5db3276515e4c66ff26b25662213c94d7880572b48922ffa57352d43d3d27d3",
          "PAPERCUSP_PROFILE": "7826b958b79c70626801b880405eb5111557dadceb2fee2b1ed69a18eed0c6dc",
          "PC_HEAVY_COALESCE": "5feceb66ffc86f38d952786c6d696c79c2dbc239dd4e91b46729d73a27fb57e9",
          "PAPERCUSP_API_BASE": "39d250060856a6eb74aba1db89ea404b382b1a121c179a19eb39fcd30476192f",
          "PAPERCUSP_REPO_ROOT": "64d7a60720aceb863d1d802149f1519d51517f4867365d951028cccf326c3f99",
          "PAPERCUSP_WORKSPACE": "24201c2745800b53f808f1453ded79e6bcd37ed1757e8683f6a5e888dc1a90b2",
          "PAPERCUSP_PSU_REEXEC": "bdd2d3af3a5a1213497d4f1f7bfcda898274fe9cb5401bbc0190885664708fc2",
          "PAPERCUSP_SCRIPTS_DIR": "8a1db86dc1e42c2c501949861e312d37d12f0cc1aa39e3c8dcf085b462781e44",
          "PC_HEAVY_ADMISSION_ID": "016aa77a9329caa5b4fa4d4a7f7a846e3f4225616be9772b042af858da52a894",
          "PC_HEAVY_RETRY_ACTIVE": "6b86b273ff34fce19d6b804eff5a3f5747ada4eaa22f1d49c01e52ddb7875b4b",
          "PAPERCUSP_CONTEXT_TIER": "073f3c701722d652c8ff2c6f5c18499a6e03e0a81ec2cf65a1bf6596f0686033",
          "PAPERCUSP_MODEL_SOURCE": "46b2e93c2f9ac23612d7f8e87acd2fef4cdc242f7c95679cba787415362f8a2c",
          "PAPERCUSP_OPERATOR_URL": "b224a4527f06e2bb86ca2121f0bbc56e3182320cec709203d18bbc86a249e0ef",
          "PAPERCUSP_PSU_LAUNCHER": "eb51e9312c87ceb3e73af24c326183e5488f3ef64f9c4450e01a30c67e7c6580",
          "PAPERCUSP_WORKSPACE_ID": "24201c2745800b53f808f1453ded79e6bcd37ed1757e8683f6a5e888dc1a90b2",
          "PC_HEAVY_ADMISSION_DIR": "2e3d87ddaf4cc9697f474e935e721a325b7c408e83a0225a656aa3864db46372",
          "PAPERCUSP_AGENT_SESSION": "6b86b273ff34fce19d6b804eff5a3f5747ada4eaa22f1d49c01e52ddb7875b4b",
          "PAPERCUSP_MUTATION_MODE": "5feceb66ffc86f38d952786c6d696c79c2dbc239dd4e91b46729d73a27fb57e9",
          "PAPERCUSP_ADV_SESSION_ID": "df586ff44296690f328d2b75f4a8a9256785fb6191043e987405936ecb0aac5e",
          "PAPERCUSP_MUTATION_PHASE": "137b58a5a3c1aa8fb7373808338a45c3ae6556a85ff00d8644e9b6f393fcb4a5",
          "PAPERCUSP_MUTATION_PROBE": "6b86b273ff34fce19d6b804eff5a3f5747ada4eaa22f1d49c01e52ddb7875b4b",
          "PAPERCUSP_STATE_REVISION": "85ee10a2ecb12668801e2ab628cdb17d0049dcf8fca24727219591f9b5a0521d",
          "PAPERCUSP_TEST_RUN_GROUP": "f239aa46a37e922760336d9f13c5d7615e8003404bd736ec4649a56614a2107c",
          "PAPERCUSP_PSU_REEXEC_PPID": "d041db65e10a3c0a3a4246fa2ea1fa0c901fc24ae123cd041954f736c6ebb6fc",
          "PAPERCUSP_HOST_PG_DUMP_DIR": "856a75c41b7741a012b2be872bdc5f2c3c226ab2ba50cbc0c05abacc2ba91a2a",
          "PAPERCUSP_INTEGRATION_ROOT": "64d7a60720aceb863d1d802149f1519d51517f4867365d951028cccf326c3f99",
          "PAPERCUSP_NODE_RUNTIME_DIR": "75ba9ca2d9761eb737e2d018c4b1762ec2408419d3de95b40c44718361cfd590",
          "PAPERCUSP_PSU_REEXEC_COUNT": "5feceb66ffc86f38d952786c6d696c79c2dbc239dd4e91b46729d73a27fb57e9",
          "PAPERCUSP_TEST_RUNS_DB_URL": "c942ee8b9c119f1e62d4016bb52dc6cabbf6f15fa7a77bdf9da269f2ab70ece8",
          "PAPERCUSP_TEST_RUN_HARNESS": "f4df233b6a1a63ee848f046a99738cafc2b1b7d23a6cd6afb140960556c128d0",
          "PC_HEAVY_RETRY_PREEMPTIONS": "4e07408562bedb8b60ce05c1decfe3ad16b72230967de01f640b7e4729b49fce",
          "PAPERCUSP_ADMISSION_CONTEXT": "398956400311e4723a6074bd00a4829727a668d849d9963f661e34cbcc7b2301",
          "PAPERCUSP_BACKEND_PATH_DIRS": "5f59411597378372e66e3d1d98b190f04b14c1348ab0c6d7e157574e6604b41f",
          "PAPERCUSP_TEST_PG_ADMIN_URL": "8a8f20790a99d9788f3743ef5c7681801c91dffffd4ffe69272b6e99824c43be",
          "PC_HEAVY_ADMISSION_PRIORITY": "1a6562590ef19d1045d06c4055742d38288e9e6dcd71ccde5cee80f1d5a774eb",
          "PAPERCUSP_INSTALL_MUTEX_HELD": "7ae278d3661e351bd98eebd8d0afc725c23ed6449c1d2bd5a359302548a0bb3c",
          "PAPERCUSP_TEST_RUN_WORKSPACE": "24201c2745800b53f808f1453ded79e6bcd37ed1757e8683f6a5e888dc1a90b2",
          "PAPERCUSP_TEST_STARTUP_TRACE": "acce452846a9f67d6404230e79b0b190f509cde980b164040ad766ed6b9993e8",
          "PC_HEAVY_PREEMPT_AFTER_READY": "6b86b273ff34fce19d6b804eff5a3f5747ada4eaa22f1d49c01e52ddb7875b4b",
          "PC_HEAVY_PREEMPT_RESULT_FILE": "a2be260f4b9dba654285be5dbe256972b4e91900b4181e44a1fd6740a2153da3",
          "PAPERCUSP_MUTATION_DESCRIPTOR": "fb9bccc22e18e805f34c1291f8020375543cfddb10b229cb56ab079e857e0f65",
          "PAPERCUSP_ACCOUNT_ROUTING_MODE": "929260ad9b9ea9fe0f3553dd964f4ff3deb5792efd031a2b90f573fe91f012bb",
          "PAPERCUSP_COMMITTED_SOURCE_GIT": "106aa88494971ea56c867f371d12746ef6ce5f5bd4f73b857235642caeb88363",
          "PAPERCUSP_TEST_RUN_RECEIPT_FILE": "87ac52cc45a3b8bc5b1711989d0e9a85a07c9d033d24ae089d07ad2d53383e3f",
          "PAPERCUSP_MUTATION_PROBE_SUBJECT": "94718097ce73b9c2223b4d04940ec94f1a766d8e2cc472e47c13708b137aa234",
          "PAPERCUSP_SPECIFICATION_REVISION": "cbddf679d29b6ad772595c44e968f816afdd48f8f09b33a05e97d47345eebd5b",
          "PAPERCUSP_LINT_AS_COMMITTED_CLONE": "6b86b273ff34fce19d6b804eff5a3f5747ada4eaa22f1d49c01e52ddb7875b4b",
          "PAPERCUSP_OPERATOR_URL_PROVENANCE": "a64c6cfe24de5ca2c850e86d56223a85756cd35f501cbc6d86daf28404b9a2a1",
          "PAPERCUSP_COMMITTED_SOURCE_NOTICES": "c11201ad332a7cd05d2f373e1c5014296437ecac3fc3b34a092d21768d805c8c",
          "PAPERCUSP_RESTRICTED_HOLD_PREFLIGHT": "749a7554eba9d6fd2ad69c3b29c083c6c9e56f360a4c3216306571aa826ba539",
          "PAPERCUSP_MUTATION_DESCRIPTOR_READER_HEALTH_URL": "aa3bce62afb6a116f1335d787128219e2eb6d4a921ec1fd273989cf13eb7980f",
          "PAPERCUSP_LINT_AS_COMMITTED_PREPARED_ROOT_RECEIPT": "c2deefc8497ac1e52c1ab975d8dde5ab1ab0b8d0d7ac0df48faa54d50ff5dc1e"
        },
        "fingerprint": "sha256-config-snapshot-v1:12a1c8e77b3faa1b98197411f6bbf3507a23ba443b1023bfd0030df027f33e35",
        "schemaVersion": 1
      }
    },
    {
      "id": 23490325,
      "branch": null,
      "rss_mb": 799.7,
      "source": "local",
      "status": "pass",
      "suite_id": null,
      "file_path": "packages/operator-core/lib/sql-tool-candidate-feedback.integration.test.ts",
      "framework": "vitest",
      "commit_sha": "b8b68b842473b535718f98158291192aca13607a",
      "created_at": "2026-11-06T15:28:04.85133+00:00",
      "started_at": "2026-11-06T15:27:26.671+00:00",
      "duration_ms": 22168,
      "finished_at": "2026-11-06T15:27:48.839+00:00",
      "output_tail": null,
      "harness_slug": "papercusp",
      "run_group_id": "35090437-4d80-4e67-a00e-a065ead02ccf",
      "workspace_id": "papercusp-workspace",
      "worktree_dirty": false,
      "loop_lag_p95_ms": null,
      "execution_details": {
        "root": "/tmp/pcv/papercusp-lint-as-committed-b8b68b8424-wt13by",
        "failed": 0,
        "passed": 17,
        "skipped": 0,
        "filePath": "packages/operator-core/lib/sql-tool-candidate-feedback.integration.test.ts",
        "commitSha": "b8b68b842473b535718f98158291192aca13607a",
        "testLayer": "integration",
        "runGroupId": "35090437-4d80-4e67-a00e-a065ead02ccf",
        "harnessSlug": "papercusp",
        "workspaceId": "papercusp-workspace",
        "runStartedAt": "2026-11-06T15:26:37.929Z",
        "mutationPhase": null,
        "schemaVersion": 1,
        "worktreeDirty": false,
        "testNamePattern": null,
        "collectionFailed": false,
        "passedCaseTitles": [
          "persists repeatable scoped checks with build baseline windows and denominators R7-CONTRACT OUTCOME-P-007",
          "records lower-activity no-fall and failed coverage dispositions R7-CONTRACT OUTCOME-P-007",
          "records exposure unknown without converting it to a passing result R7-CONTRACT OUTCOME-P-007",
          "records denominator unknown without converting it to a passing result R7-CONTRACT OUTCOME-P-007",
          "records window unknown without converting it to a passing result R7-CONTRACT OUTCOME-P-007",
          "records low-demand unknown without converting it to a passing result R7-CONTRACT OUTCOME-P-007",
          "records foreign-scope unknown without converting it to a passing result R7-CONTRACT OUTCOME-P-007",
          "records invalid-build unknown without converting it to a passing result R7-CONTRACT OUTCOME-P-007",
          "records future-window unknown without converting it to a passing result R7-CONTRACT OUTCOME-P-007",
          "rejects invalid-time before writing misleading ledger metadata R7-CONTRACT",
          "rejects future-time before writing misleading ledger metadata R7-CONTRACT",
          "rejects invalid-source-date before writing misleading ledger metadata R7-CONTRACT",
          "acceptance alone is not shipment; proposal quality reflects actual review disposition R7-CONTRACT",
          "ledger failure propagates instead of claiming feedback was saved R7-CONTRACT",
          "production census persists feedback after the actual mined review with missing exposure unknown R7-CONTRACT OUTCOME-P-007",
          "registered workspace rubric rescores the real ledger without masking another candidate and grades from ledger R7-CONTRACT OUTCOME-P-007",
          "R13 canonical SQL rubric ledger preserves failed and unknown measurements"
        ],
        "testTimingRuntimeIdentity": "node:25.9.0 linux/x64 vitest:4.1.8",
        "runtimeEnvironmentAfterCaptureStatus": "not-configured",
        "runtimeEnvironmentBeforeCaptureStatus": "not-configured"
      },
      "is_scratch_config": false,
      "configuration_snapshot": {
        "flagEnv": {},
        "envSha256": {
          "NODE_ENV": "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
          "PAPERCUSP_SID": "76b1ae9ce1aa4aebc055ffbbd602750040e62bed4c365edf86f8fdfec2010853",
          "PAPERCUSP_TTY": "f178200353e1fd727138022163e3cc26a49bf017a80ced7ee8d0d3e8d61e6cd3",
          "PAPERCUSP_HOME": "1d878651be83bc9d393f82c332ce28505791509084c3d77ce08aa5390db23117",
          "PAPERCUSP_AGENT": "57de4cf40144bdf7d00010f2f5557a7d642c2b9705309bfade167dd313e2ca93",
          "PAPERCUSP_MODEL": "2c8210d53bc2874b17b92d660db5458dc20282de34910622eb277177f8a11474",
          "PC_HEAVY_BYPASS": "6b86b273ff34fce19d6b804eff5a3f5747ada4eaa22f1d49c01e52ddb7875b4b",
          "PAPERCUSP_BIN_DIR": "d5db3276515e4c66ff26b25662213c94d7880572b48922ffa57352d43d3d27d3",
          "PAPERCUSP_PROFILE": "7826b958b79c70626801b880405eb5111557dadceb2fee2b1ed69a18eed0c6dc",
          "PC_HEAVY_COALESCE": "5feceb66ffc86f38d952786c6d696c79c2dbc239dd4e91b46729d73a27fb57e9",
          "PAPERCUSP_API_BASE": "39d250060856a6eb74aba1db89ea404b382b1a121c179a19eb39fcd30476192f",
          "PAPERCUSP_REPO_ROOT": "64d7a60720aceb863d1d802149f1519d51517f4867365d951028cccf326c3f99",
          "PAPERCUSP_WORKSPACE": "24201c2745800b53f808f1453ded79e6bcd37ed1757e8683f6a5e888dc1a90b2",
          "PAPERCUSP_PSU_REEXEC": "bdd2d3af3a5a1213497d4f1f7bfcda898274fe9cb5401bbc0190885664708fc2",
          "PAPERCUSP_SCRIPTS_DIR": "8a1db86dc1e42c2c501949861e312d37d12f0cc1aa39e3c8dcf085b462781e44",
          "PC_HEAVY_ADMISSION_ID": "6f319d77dab519e7f697f869a84b165067c34bcd9234fe6ddf98f479572caa00",
          "PC_HEAVY_RETRY_ACTIVE": "6b86b273ff34fce19d6b804eff5a3f5747ada4eaa22f1d49c01e52ddb7875b4b",
          "PAPERCUSP_CONTEXT_TIER": "073f3c701722d652c8ff2c6f5c18499a6e03e0a81ec2cf65a1bf6596f0686033",
          "PAPERCUSP_MODEL_SOURCE": "46b2e93c2f9ac23612d7f8e87acd2fef4cdc242f7c95679cba787415362f8a2c",
          "PAPERCUSP_OPERATOR_URL": "b224a4527f06e2bb86ca2121f0bbc56e3182320cec709203d18bbc86a249e0ef",
          "PAPERCUSP_PSU_LAUNCHER": "eb51e9312c87ceb3e73af24c326183e5488f3ef64f9c4450e01a30c67e7c6580",
          "PC_HEAVY_ADMISSION_DIR": "2e3d87ddaf4cc9697f474e935e721a325b7c408e83a0225a656aa3864db46372",
          "PAPERCUSP_AGENT_SESSION": "6b86b273ff34fce19d6b804eff5a3f5747ada4eaa22f1d49c01e52ddb7875b4b",
          "PAPERCUSP_ADV_SESSION_ID": "df586ff44296690f328d2b75f4a8a9256785fb6191043e987405936ecb0aac5e",
          "PAPERCUSP_STATE_REVISION": "85ee10a2ecb12668801e2ab628cdb17d0049dcf8fca24727219591f9b5a0521d",
          "PAPERCUSP_TEST_RUN_GROUP": "13f260e46bab5699027666154980cb15e89d729f9dfdd037826177750aa619f6",
          "PAPERCUSP_PSU_REEXEC_PPID": "d041db65e10a3c0a3a4246fa2ea1fa0c901fc24ae123cd041954f736c6ebb6fc",
          "PAPERCUSP_HOST_PG_DUMP_DIR": "856a75c41b7741a012b2be872bdc5f2c3c226ab2ba50cbc0c05abacc2ba91a2a",
          "PAPERCUSP_INTEGRATION_ROOT": "64d7a60720aceb863d1d802149f1519d51517f4867365d951028cccf326c3f99",
          "PAPERCUSP_NODE_RUNTIME_DIR": "75ba9ca2d9761eb737e2d018c4b1762ec2408419d3de95b40c44718361cfd590",
          "PAPERCUSP_PSU_REEXEC_COUNT": "5feceb66ffc86f38d952786c6d696c79c2dbc239dd4e91b46729d73a27fb57e9",
          "PAPERCUSP_TEST_RUNS_DB_URL": "c942ee8b9c119f1e62d4016bb52dc6cabbf6f15fa7a77bdf9da269f2ab70ece8",
          "PAPERCUSP_TEST_RUN_HARNESS": "f4df233b6a1a63ee848f046a99738cafc2b1b7d23a6cd6afb140960556c128d0",
          "PC_HEAVY_RETRY_PREEMPTIONS": "4e07408562bedb8b60ce05c1decfe3ad16b72230967de01f640b7e4729b49fce",
          "PAPERCUSP_ADMISSION_CONTEXT": "d4517dd352512cc19711fab7e68d2f4f03b50f882d90a2b88e2f3545bd3454b9",
          "PAPERCUSP_BACKEND_PATH_DIRS": "5f59411597378372e66e3d1d98b190f04b14c1348ab0c6d7e157574e6604b41f",
          "PAPERCUSP_TEST_PG_ADMIN_URL": "8a8f20790a99d9788f3743ef5c7681801c91dffffd4ffe69272b6e99824c43be",
          "PC_HEAVY_ADMISSION_PRIORITY": "1a6562590ef19d1045d06c4055742d38288e9e6dcd71ccde5cee80f1d5a774eb",
          "PAPERCUSP_INSTALL_MUTEX_HELD": "837baa19c801661d6b17b83042c51adc967268776c9a366943bdbe6c7d6285d8",
          "PAPERCUSP_TEST_STARTUP_TRACE": "acce452846a9f67d6404230e79b0b190f509cde980b164040ad766ed6b9993e8",
          "PC_HEAVY_PREEMPT_AFTER_READY": "6b86b273ff34fce19d6b804eff5a3f5747ada4eaa22f1d49c01e52ddb7875b4b",
          "PC_HEAVY_PREEMPT_RESULT_FILE": "a56a1758eb143152997c6826f09acdf682c9c421ac9409538eee8a352d6d98a4",
          "PAPERCUSP_ACCOUNT_ROUTING_MODE": "929260ad9b9ea9fe0f3553dd964f4ff3deb5792efd031a2b90f573fe91f012bb",
          "PAPERCUSP_COMMITTED_SOURCE_GIT": "106aa88494971ea56c867f371d12746ef6ce5f5bd4f73b857235642caeb88363",
          "PAPERCUSP_TEST_RUN_RECEIPT_FILE": "34b861eb8d4defda536d29a067b34f1f387fff4784e4bfc34a42c6c543b1acb6",
          "PAPERCUSP_SPECIFICATION_REVISION": "cbddf679d29b6ad772595c44e968f816afdd48f8f09b33a05e97d47345eebd5b",
          "PAPERCUSP_LINT_AS_COMMITTED_CLONE": "6b86b273ff34fce19d6b804eff5a3f5747ada4eaa22f1d49c01e52ddb7875b4b",
          "PAPERCUSP_OPERATOR_URL_PROVENANCE": "a64c6cfe24de5ca2c850e86d56223a85756cd35f501cbc6d86daf28404b9a2a1",
          "PAPERCUSP_COMMITTED_SOURCE_NOTICES": "e3f623610a6c28ac376d210bce7db6eb8d1ab90cd25e253c6316421ab3888523",
          "PAPERCUSP_RESTRICTED_HOLD_PREFLIGHT": "749a7554eba9d6fd2ad69c3b29c083c6c9e56f360a4c3216306571aa826ba539",
          "PAPERCUSP_LINT_AS_COMMITTED_PREPARED_ROOT_RECEIPT": "8f725694a82253ce2eaca313eceb731c190689696358d6f34c268ca56a314389"
        },
        "fingerprint": "sha256-config-snapshot-v1:98b0678c2148feb81b207bac9c89a3e3dec7cabd615abcfc25e66d28f6f1588f",
        "schemaVersion": 1
      }
    },
    {
      "id": 23490326,
      "branch": null,
      "rss_mb": 799.7,
      "source": "local",
      "status": "pass",
      "suite_id": null,
      "file_path": "packages/operator-core/lib/sql-tool-candidate-review.integration.test.ts",
      "framework": "vitest",
      "commit_sha": "b8b68b842473b535718f98158291192aca13607a",
      "created_at": "2026-11-06T15:28:04.85133+00:00",
      "started_at": "2026-11-06T15:27:28.435+00:00",
      "duration_ms": 22652,
      "finished_at": "2026-11-06T15:27:51.087+00:00",
      "output_tail": null,
      "harness_slug": "papercusp",
      "run_group_id": "35090437-4d80-4e67-a00e-a065ead02ccf",
      "workspace_id": "papercusp-workspace",
      "worktree_dirty": false,
      "loop_lag_p95_ms": null,
      "execution_details": {
        "root": "/tmp/pcv/papercusp-lint-as-committed-b8b68b8424-wt13by",
        "failed": 0,
        "passed": 12,
        "skipped": 0,
        "filePath": "packages/operator-core/lib/sql-tool-candidate-review.integration.test.ts",
        "commitSha": "b8b68b842473b535718f98158291192aca13607a",
        "testLayer": "integration",
        "runGroupId": "35090437-4d80-4e67-a00e-a065ead02ccf",
        "harnessSlug": "papercusp",
        "workspaceId": "papercusp-workspace",
        "runStartedAt": "2026-11-06T15:26:37.929Z",
        "mutationPhase": null,
        "schemaVersion": 1,
        "worktreeDirty": false,
        "testNamePattern": null,
        "collectionFailed": false,
        "passedCaseTitles": [
          "reuses actual canonical intake and post-review ownership on repeated cycles R5-CONTRACT OUTCOME-P-006",
          "unchanged declined editions stay declined; changed contracts reopen for review R5-CONTRACT OUTCOME-P-006",
          "accepted ownership is read from the current review item R5-CONTRACT",
          "R10 accepted candidate enters owned engineering workflow",
          "suppressed and ineligible candidates never file work R5-CONTRACT",
          "a crash after reservation resumes the same actual intake R5-CONTRACT",
          "pending enrollment retries filer release without releasing a reviewer R5-CONTRACT",
          "activity families reuse canonical intake and keep source-dependent measurements out of work-item copies",
          "activity review fails closed before reservation and after mid-intake revocation, then recovers the same pointer",
          "a timed-out activity evidence read cannot later reserve or enroll demand",
          "production cadence carries real authorized search sources into canonical review and revokes reads on output loss",
          "flushes pending fallback observations before an org fixture closes its clients"
        ],
        "testTimingRuntimeIdentity": "node:25.9.0 linux/x64 vitest:4.1.8",
        "runtimeEnvironmentAfterCaptureStatus": "not-configured",
        "runtimeEnvironmentBeforeCaptureStatus": "not-configured"
      },
      "is_scratch_config": false,
      "configuration_snapshot": {
        "flagEnv": {},
        "envSha256": {
          "NODE_ENV": "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
          "PAPERCUSP_SID": "76b1ae9ce1aa4aebc055ffbbd602750040e62bed4c365edf86f8fdfec2010853",
          "PAPERCUSP_TTY": "f178200353e1fd727138022163e3cc26a49bf017a80ced7ee8d0d3e8d61e6cd3",
          "PAPERCUSP_HOME": "1d878651be83bc9d393f82c332ce28505791509084c3d77ce08aa5390db23117",
          "PAPERCUSP_AGENT": "57de4cf40144bdf7d00010f2f5557a7d642c2b9705309bfade167dd313e2ca93",
          "PAPERCUSP_MODEL": "2c8210d53bc2874b17b92d660db5458dc20282de34910622eb277177f8a11474",
          "PC_HEAVY_BYPASS": "6b86b273ff34fce19d6b804eff5a3f5747ada4eaa22f1d49c01e52ddb7875b4b",
          "PAPERCUSP_BIN_DIR": "d5db3276515e4c66ff26b25662213c94d7880572b48922ffa57352d43d3d27d3",
          "PAPERCUSP_PROFILE": "7826b958b79c70626801b880405eb5111557dadceb2fee2b1ed69a18eed0c6dc",
          "PC_HEAVY_COALESCE": "5feceb66ffc86f38d952786c6d696c79c2dbc239dd4e91b46729d73a27fb57e9",
          "PAPERCUSP_API_BASE": "39d250060856a6eb74aba1db89ea404b382b1a121c179a19eb39fcd30476192f",
          "PAPERCUSP_REPO_ROOT": "64d7a60720aceb863d1d802149f1519d51517f4867365d951028cccf326c3f99",
          "PAPERCUSP_WORKSPACE": "24201c2745800b53f808f1453ded79e6bcd37ed1757e8683f6a5e888dc1a90b2",
          "PAPERCUSP_PSU_REEXEC": "bdd2d3af3a5a1213497d4f1f7bfcda898274fe9cb5401bbc0190885664708fc2",
          "PAPERCUSP_SCRIPTS_DIR": "8a1db86dc1e42c2c501949861e312d37d12f0cc1aa39e3c8dcf085b462781e44",
          "PC_HEAVY_ADMISSION_ID": "6f319d77dab519e7f697f869a84b165067c34bcd9234fe6ddf98f479572caa00",
          "PC_HEAVY_RETRY_ACTIVE": "6b86b273ff34fce19d6b804eff5a3f5747ada4eaa22f1d49c01e52ddb7875b4b",
          "PAPERCUSP_CONTEXT_TIER": "073f3c701722d652c8ff2c6f5c18499a6e03e0a81ec2cf65a1bf6596f0686033",
          "PAPERCUSP_MODEL_SOURCE": "46b2e93c2f9ac23612d7f8e87acd2fef4cdc242f7c95679cba787415362f8a2c",
          "PAPERCUSP_OPERATOR_URL": "b224a4527f06e2bb86ca2121f0bbc56e3182320cec709203d18bbc86a249e0ef",
          "PAPERCUSP_PSU_LAUNCHER": "eb51e9312c87ceb3e73af24c326183e5488f3ef64f9c4450e01a30c67e7c6580",
          "PC_HEAVY_ADMISSION_DIR": "2e3d87ddaf4cc9697f474e935e721a325b7c408e83a0225a656aa3864db46372",
          "PAPERCUSP_AGENT_SESSION": "6b86b273ff34fce19d6b804eff5a3f5747ada4eaa22f1d49c01e52ddb7875b4b",
          "PAPERCUSP_ADV_SESSION_ID": "df586ff44296690f328d2b75f4a8a9256785fb6191043e987405936ecb0aac5e",
          "PAPERCUSP_STATE_REVISION": "85ee10a2ecb12668801e2ab628cdb17d0049dcf8fca24727219591f9b5a0521d",
          "PAPERCUSP_TEST_RUN_GROUP": "13f260e46bab5699027666154980cb15e89d729f9dfdd037826177750aa619f6",
          "PAPERCUSP_PSU_REEXEC_PPID": "d041db65e10a3c0a3a4246fa2ea1fa0c901fc24ae123cd041954f736c6ebb6fc",
          "PAPERCUSP_HOST_PG_DUMP_DIR": "856a75c41b7741a012b2be872bdc5f2c3c226ab2ba50cbc0c05abacc2ba91a2a",
          "PAPERCUSP_INTEGRATION_ROOT": "64d7a60720aceb863d1d802149f1519d51517f4867365d951028cccf326c3f99",
          "PAPERCUSP_NODE_RUNTIME_DIR": "75ba9ca2d9761eb737e2d018c4b1762ec2408419d3de95b40c44718361cfd590",
          "PAPERCUSP_PSU_REEXEC_COUNT": "5feceb66ffc86f38d952786c6d696c79c2dbc239dd4e91b46729d73a27fb57e9",
          "PAPERCUSP_TEST_RUNS_DB_URL": "c942ee8b9c119f1e62d4016bb52dc6cabbf6f15fa7a77bdf9da269f2ab70ece8",
          "PAPERCUSP_TEST_RUN_HARNESS": "f4df233b6a1a63ee848f046a99738cafc2b1b7d23a6cd6afb140960556c128d0",
          "PC_HEAVY_RETRY_PREEMPTIONS": "4e07408562bedb8b60ce05c1decfe3ad16b72230967de01f640b7e4729b49fce",
          "PAPERCUSP_ADMISSION_CONTEXT": "d4517dd352512cc19711fab7e68d2f4f03b50f882d90a2b88e2f3545bd3454b9",
          "PAPERCUSP_BACKEND_PATH_DIRS": "5f59411597378372e66e3d1d98b190f04b14c1348ab0c6d7e157574e6604b41f",
          "PAPERCUSP_TEST_PG_ADMIN_URL": "8a8f20790a99d9788f3743ef5c7681801c91dffffd4ffe69272b6e99824c43be",
          "PC_HEAVY_ADMISSION_PRIORITY": "1a6562590ef19d1045d06c4055742d38288e9e6dcd71ccde5cee80f1d5a774eb",
          "PAPERCUSP_INSTALL_MUTEX_HELD": "837baa19c801661d6b17b83042c51adc967268776c9a366943bdbe6c7d6285d8",
          "PAPERCUSP_TEST_STARTUP_TRACE": "acce452846a9f67d6404230e79b0b190f509cde980b164040ad766ed6b9993e8",
          "PC_HEAVY_PREEMPT_AFTER_READY": "6b86b273ff34fce19d6b804eff5a3f5747ada4eaa22f1d49c01e52ddb7875b4b",
          "PC_HEAVY_PREEMPT_RESULT_FILE": "a56a1758eb143152997c6826f09acdf682c9c421ac9409538eee8a352d6d98a4",
          "PAPERCUSP_ACCOUNT_ROUTING_MODE": "929260ad9b9ea9fe0f3553dd964f4ff3deb5792efd031a2b90f573fe91f012bb",
          "PAPERCUSP_COMMITTED_SOURCE_GIT": "106aa88494971ea56c867f371d12746ef6ce5f5bd4f73b857235642caeb88363",
          "PAPERCUSP_TEST_RUN_RECEIPT_FILE": "34b861eb8d4defda536d29a067b34f1f387fff4784e4bfc34a42c6c543b1acb6",
          "PAPERCUSP_SPECIFICATION_REVISION": "cbddf679d29b6ad772595c44e968f816afdd48f8f09b33a05e97d47345eebd5b",
          "PAPERCUSP_LINT_AS_COMMITTED_CLONE": "6b86b273ff34fce19d6b804eff5a3f5747ada4eaa22f1d49c01e52ddb7875b4b",
          "PAPERCUSP_OPERATOR_URL_PROVENANCE": "a64c6cfe24de5ca2c850e86d56223a85756cd35f501cbc6d86daf28404b9a2a1",
          "PAPERCUSP_COMMITTED_SOURCE_NOTICES": "e3f623610a6c28ac376d210bce7db6eb8d1ab90cd25e253c6316421ab3888523",
          "PAPERCUSP_RESTRICTED_HOLD_PREFLIGHT": "749a7554eba9d6fd2ad69c3b29c083c6c9e56f360a4c3216306571aa826ba539",
          "PAPERCUSP_LINT_AS_COMMITTED_PREPARED_ROOT_RECEIPT": "8f725694a82253ce2eaca313eceb731c190689696358d6f34c268ca56a314389"
        },
        "fingerprint": "sha256-config-snapshot-v1:98b0678c2148feb81b207bac9c89a3e3dec7cabd615abcfc25e66d28f6f1588f",
        "schemaVersion": 1
      }
    },
    {
      "id": 23490327,
      "branch": null,
      "rss_mb": 799.7,
      "source": "local",
      "status": "pass",
      "suite_id": null,
      "file_path": "packages/operator-core/lib/code-intelligence/reuse-measurement.integration.test.ts",
      "framework": "vitest",
      "commit_sha": "b8b68b842473b535718f98158291192aca13607a",
      "created_at": "2026-11-06T15:28:04.85133+00:00",
      "started_at": "2026-11-06T15:27:26.346+00:00",
      "duration_ms": 36347,
      "finished_at": "2026-11-06T15:28:02.693+00:00",
      "output_tail": null,
      "harness_slug": "papercusp",
      "run_group_id": "35090437-4d80-4e67-a00e-a065ead02ccf",
      "workspace_id": "papercusp-workspace",
      "worktree_dirty": false,
      "loop_lag_p95_ms": null,
      "execution_details": {
        "root": "/tmp/pcv/papercusp-lint-as-committed-b8b68b8424-wt13by",
        "failed": 0,
        "passed": 31,
        "skipped": 0,
        "filePath": "packages/operator-core/lib/code-intelligence/reuse-measurement.integration.test.ts",
        "commitSha": "b8b68b842473b535718f98158291192aca13607a",
        "testLayer": "integration",
        "runGroupId": "35090437-4d80-4e67-a00e-a065ead02ccf",
        "harnessSlug": "papercusp",
        "workspaceId": "papercusp-workspace",
        "runStartedAt": "2026-11-06T15:26:37.929Z",
        "mutationPhase": null,
        "schemaVersion": 1,
        "worktreeDirty": false,
        "testNamePattern": null,
        "collectionFailed": false,
        "passedCaseTitles": [
          "R16 provider-specific recorded outcome windows > pins independently precomputed provider/work-item hash cohorts across retries",
          "R16 provider-specific recorded outcome windows > partitions acted-on, not-acted-on and unknown without counting issuance as delivery",
          "R16 provider-specific recorded outcome windows > uses the declared selector for clones grep outcomes",
          "R16 provider-specific recorded outcome windows > uses the declared selector for cochange grep outcomes",
          "R16 provider-specific recorded outcome windows > uses the declared selector for provenance grep outcomes",
          "R16 provider-specific recorded outcome windows > uses the declared selector for sql grep outcomes",
          "R16 provider-specific recorded outcome windows > uses the declared selector for coverage grep outcomes",
          "R16 provider-specific recorded outcome windows > uses the declared selector for semantic grep outcomes",
          "R16 provider-specific recorded outcome windows > uses the declared selector for grep grep outcomes",
          "R16 provider-specific recorded outcome windows > uses the declared selector for first-touch grep outcomes",
          "R16 provider-specific recorded outcome windows > bounds the window to twenty invocations before the thirty-minute limit",
          "R16 provider-specific recorded outcome windows > leaves open, missing, malformed and truncated activity unknown; preserves positives",
          "R16 provider-specific recorded outcome windows > anchors absolute paths to the activity harness and isolates unrelated owners",
          "R16 provider-specific recorded outcome windows > deduplicates evidence and refuses conflicting identities",
          "R16 provider-specific recorded outcome windows > uses numeric invocation identity to break timestamp ties before applying the cap",
          "R16 frozen measurement units and efficacy > derives exact added clone lines and a complete syntax-bound call census, including hidden locals and unresolved calls",
          "R16 frozen measurement units and efficacy > captures a complete immutable population larger than 128 MiB without truncating files",
          "R16 frozen measurement units and efficacy > captures a historical committed source window despite later working-tree changes",
          "R16 frozen measurement units and efficacy > removes source captures after a worker times out before answering",
          "R16 frozen measurement units and efficacy > measures exact units and keeps unresolved populations separate",
          "R16 frozen measurement units and efficacy > disables only a mature ineffective population and retains a mature beneficial population",
          "R16 frozen measurement units and efficacy > refuses disabling on immature, unknown, stale or foreign populations",
          "R16 repeatable existing-ledger reads > R13 canonical active-rubric checks bind scorecard ledger identities",
          "R16 repeatable existing-ledger reads > recomputes persisted call columns and rejects damaged raw sites without using a saved score",
          "R16 repeatable existing-ledger reads > records hash-pinned raw metric populations, then the registered reader recomputes and rejects corrupted evidence",
          "R16 repeatable existing-ledger reads > counts a recorded search-before-write positive only through a unique exact assignment",
          "R16 repeatable existing-ledger reads > retains call and assignment measurements when immutable Git additions include binary files",
          "R16 repeatable existing-ledger reads > persists mature disable evidence before using the flag writer, while immature evidence never writes",
          "R16 repeatable existing-ledger reads > repeats the same scoped result without changing issued rows or coercing unknowns",
          "R16 repeatable existing-ledger reads > registered instruments recompute exact-window raw populations with explicit ledger units",
          "R16 repeatable existing-ledger reads > collects actual composition, push and activity rows for both arms; recollection updates raw evidence without duplicate outcomes"
        ],
        "testTimingRuntimeIdentity": "node:25.9.0 linux/x64 vitest:4.1.8",
        "runtimeEnvironmentAfterCaptureStatus": "not-configured",
        "runtimeEnvironmentBeforeCaptureStatus": "not-configured"
      },
      "is_scratch_config": false,
      "configuration_snapshot": {
        "flagEnv": {},
        "envSha256": {
          "NODE_ENV": "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
          "PAPERCUSP_SID": "76b1ae9ce1aa4aebc055ffbbd602750040e62bed4c365edf86f8fdfec2010853",
          "PAPERCUSP_TTY": "f178200353e1fd727138022163e3cc26a49bf017a80ced7ee8d0d3e8d61e6cd3",
          "PAPERCUSP_HOME": "1d878651be83bc9d393f82c332ce28505791509084c3d77ce08aa5390db23117",
          "PAPERCUSP_AGENT": "57de4cf40144bdf7d00010f2f5557a7d642c2b9705309bfade167dd313e2ca93",
          "PAPERCUSP_MODEL": "2c8210d53bc2874b17b92d660db5458dc20282de34910622eb277177f8a11474",
          "PC_HEAVY_BYPASS": "6b86b273ff34fce19d6b804eff5a3f5747ada4eaa22f1d49c01e52ddb7875b4b",
          "PAPERCUSP_BIN_DIR": "d5db3276515e4c66ff26b25662213c94d7880572b48922ffa57352d43d3d27d3",
          "PAPERCUSP_PROFILE": "7826b958b79c70626801b880405eb5111557dadceb2fee2b1ed69a18eed0c6dc",
          "PC_HEAVY_COALESCE": "5feceb66ffc86f38d952786c6d696c79c2dbc239dd4e91b46729d73a27fb57e9",
          "PAPERCUSP_API_BASE": "39d250060856a6eb74aba1db89ea404b382b1a121c179a19eb39fcd30476192f",
          "PAPERCUSP_REPO_ROOT": "64d7a60720aceb863d1d802149f1519d51517f4867365d951028cccf326c3f99",
          "PAPERCUSP_WORKSPACE": "24201c2745800b53f808f1453ded79e6bcd37ed1757e8683f6a5e888dc1a90b2",
          "PAPERCUSP_PSU_REEXEC": "bdd2d3af3a5a1213497d4f1f7bfcda898274fe9cb5401bbc0190885664708fc2",
          "PAPERCUSP_SCRIPTS_DIR": "8a1db86dc1e42c2c501949861e312d37d12f0cc1aa39e3c8dcf085b462781e44",
          "PC_HEAVY_ADMISSION_ID": "6f319d77dab519e7f697f869a84b165067c34bcd9234fe6ddf98f479572caa00",
          "PC_HEAVY_RETRY_ACTIVE": "6b86b273ff34fce19d6b804eff5a3f5747ada4eaa22f1d49c01e52ddb7875b4b",
          "PAPERCUSP_CONTEXT_TIER": "073f3c701722d652c8ff2c6f5c18499a6e03e0a81ec2cf65a1bf6596f0686033",
          "PAPERCUSP_MODEL_SOURCE": "46b2e93c2f9ac23612d7f8e87acd2fef4cdc242f7c95679cba787415362f8a2c",
          "PAPERCUSP_OPERATOR_URL": "b224a4527f06e2bb86ca2121f0bbc56e3182320cec709203d18bbc86a249e0ef",
          "PAPERCUSP_PSU_LAUNCHER": "eb51e9312c87ceb3e73af24c326183e5488f3ef64f9c4450e01a30c67e7c6580",
          "PC_HEAVY_ADMISSION_DIR": "2e3d87ddaf4cc9697f474e935e721a325b7c408e83a0225a656aa3864db46372",
          "PAPERCUSP_AGENT_SESSION": "6b86b273ff34fce19d6b804eff5a3f5747ada4eaa22f1d49c01e52ddb7875b4b",
          "PAPERCUSP_ADV_SESSION_ID": "df586ff44296690f328d2b75f4a8a9256785fb6191043e987405936ecb0aac5e",
          "PAPERCUSP_STATE_REVISION": "85ee10a2ecb12668801e2ab628cdb17d0049dcf8fca24727219591f9b5a0521d",
          "PAPERCUSP_TEST_RUN_GROUP": "13f260e46bab5699027666154980cb15e89d729f9dfdd037826177750aa619f6",
          "PAPERCUSP_PSU_REEXEC_PPID": "d041db65e10a3c0a3a4246fa2ea1fa0c901fc24ae123cd041954f736c6ebb6fc",
          "PAPERCUSP_HOST_PG_DUMP_DIR": "856a75c41b7741a012b2be872bdc5f2c3c226ab2ba50cbc0c05abacc2ba91a2a",
          "PAPERCUSP_INTEGRATION_ROOT": "64d7a60720aceb863d1d802149f1519d51517f4867365d951028cccf326c3f99",
          "PAPERCUSP_NODE_RUNTIME_DIR": "75ba9ca2d9761eb737e2d018c4b1762ec2408419d3de95b40c44718361cfd590",
          "PAPERCUSP_PSU_REEXEC_COUNT": "5feceb66ffc86f38d952786c6d696c79c2dbc239dd4e91b46729d73a27fb57e9",
          "PAPERCUSP_TEST_RUNS_DB_URL": "c942ee8b9c119f1e62d4016bb52dc6cabbf6f15fa7a77bdf9da269f2ab70ece8",
          "PAPERCUSP_TEST_RUN_HARNESS": "f4df233b6a1a63ee848f046a99738cafc2b1b7d23a6cd6afb140960556c128d0",
          "PC_HEAVY_RETRY_PREEMPTIONS": "4e07408562bedb8b60ce05c1decfe3ad16b72230967de01f640b7e4729b49fce",
          "PAPERCUSP_ADMISSION_CONTEXT": "d4517dd352512cc19711fab7e68d2f4f03b50f882d90a2b88e2f3545bd3454b9",
          "PAPERCUSP_BACKEND_PATH_DIRS": "5f59411597378372e66e3d1d98b190f04b14c1348ab0c6d7e157574e6604b41f",
          "PAPERCUSP_TEST_PG_ADMIN_URL": "8a8f20790a99d9788f3743ef5c7681801c91dffffd4ffe69272b6e99824c43be",
          "PC_HEAVY_ADMISSION_PRIORITY": "1a6562590ef19d1045d06c4055742d38288e9e6dcd71ccde5cee80f1d5a774eb",
          "PAPERCUSP_INSTALL_MUTEX_HELD": "837baa19c801661d6b17b83042c51adc967268776c9a366943bdbe6c7d6285d8",
          "PAPERCUSP_TEST_STARTUP_TRACE": "acce452846a9f67d6404230e79b0b190f509cde980b164040ad766ed6b9993e8",
          "PC_HEAVY_PREEMPT_AFTER_READY": "6b86b273ff34fce19d6b804eff5a3f5747ada4eaa22f1d49c01e52ddb7875b4b",
          "PC_HEAVY_PREEMPT_RESULT_FILE": "a56a1758eb143152997c6826f09acdf682c9c421ac9409538eee8a352d6d98a4",
          "PAPERCUSP_ACCOUNT_ROUTING_MODE": "929260ad9b9ea9fe0f3553dd964f4ff3deb5792efd031a2b90f573fe91f012bb",
          "PAPERCUSP_COMMITTED_SOURCE_GIT": "106aa88494971ea56c867f371d12746ef6ce5f5bd4f73b857235642caeb88363",
          "PAPERCUSP_TEST_RUN_RECEIPT_FILE": "34b861eb8d4defda536d29a067b34f1f387fff4784e4bfc34a42c6c543b1acb6",
          "PAPERCUSP_SPECIFICATION_REVISION": "cbddf679d29b6ad772595c44e968f816afdd48f8f09b33a05e97d47345eebd5b",
          "PAPERCUSP_LINT_AS_COMMITTED_CLONE": "6b86b273ff34fce19d6b804eff5a3f5747ada4eaa22f1d49c01e52ddb7875b4b",
          "PAPERCUSP_OPERATOR_URL_PROVENANCE": "a64c6cfe24de5ca2c850e86d56223a85756cd35f501cbc6d86daf28404b9a2a1",
          "PAPERCUSP_COMMITTED_SOURCE_NOTICES": "e3f623610a6c28ac376d210bce7db6eb8d1ab90cd25e253c6316421ab3888523",
          "PAPERCUSP_RESTRICTED_HOLD_PREFLIGHT": "749a7554eba9d6fd2ad69c3b29c083c6c9e56f360a4c3216306571aa826ba539",
          "PAPERCUSP_LINT_AS_COMMITTED_PREPARED_ROOT_RECEIPT": "8f725694a82253ce2eaca313eceb731c190689696358d6f34c268ca56a314389"
        },
        "fingerprint": "sha256-config-snapshot-v1:98b0678c2148feb81b207bac9c89a3e3dec7cabd615abcfc25e66d28f6f1588f",
        "schemaVersion": 1
      }
    },
    {
      "id": 23502654,
      "branch": "staging",
      "rss_mb": 591.7,
      "source": "local",
      "status": "pass",
      "suite_id": null,
      "file_path": "packages/operator-core/lib/plan-items/convert.integration.test.ts",
      "framework": "vitest",
      "commit_sha": "bd59dba0432419e2848f297ab78eed8f891902ab",
      "created_at": "2026-11-06T18:47:32.492294+00:00",
      "started_at": "2026-11-06T18:47:30.143+00:00",
      "duration_ms": 1364,
      "finished_at": "2026-11-06T18:47:31.507+00:00",
      "output_tail": null,
      "harness_slug": "papercusp",
      "run_group_id": "c0c6942d-022c-4b58-8c0e-f8d53266402c",
      "workspace_id": "papercusp-workspace",
      "worktree_dirty": true,
      "loop_lag_p95_ms": null,
      "execution_details": {
        "root": "/home/marsh-office/papercupai-workspace/papercusp",
        "failed": 0,
        "passed": 40,
        "skipped": 0,
        "filePath": "packages/operator-core/lib/plan-items/convert.integration.test.ts",
        "commitSha": "bd59dba0432419e2848f297ab78eed8f891902ab",
        "testLayer": "integration",
        "runGroupId": "c0c6942d-022c-4b58-8c0e-f8d53266402c",
        "harnessSlug": "papercusp",
        "workspaceId": "papercusp-workspace",
        "runStartedAt": "2026-11-06T18:46:53.933Z",
        "mutationPhase": null,
        "schemaVersion": 1,
        "worktreeDirty": true,
        "testNamePattern": null,
        "collectionFailed": false,
        "passedCaseTitles": [
          "listConvertedPlanItemRefs (PG) > is TENANT-COMPLETE: unions both workspaces the plane is split across",
          "listConvertedPlanItemRefs (PG) > an explicit workspace list still pins the read (the test-only escape hatch)",
          "listConvertedPlanItemRefs (PG) > returns the DISTINCT set of implements→plan_item dst_refs, workspace-scoped",
          "listCoveredPlanItemRefs (PG, legacy text coverage) > reads legacy feature and issue coverage across both workspace partitions",
          "listCoveredPlanItemRefs (PG, legacy text coverage) > keeps legacy coverage within its tenant, harness and exact plan/item references",
          "findImplementingWorkItem (PG) > resolves an issue-family edge to its work item",
          "findImplementingWorkItem (PG) > parses a feature-ref `<harness>#<id>` edge into getWorkItem(id, harness)",
          "findImplementingWorkItem (PG) > prefers the NEWEST edge (ORDER BY created_at DESC)",
          "findImplementingWorkItem (PG) > EI-21213528544407590: a newer TERMINAL edge does NOT mask an older open record",
          "findImplementingWorkItem (PG) > EI-21213528544407590: falls back to the NEWEST terminal record when every candidate is terminal",
          "findImplementingWorkItem (PG) > returns null when no edge exists",
          "findImplementingWorkItem (PG) > is TENANT-COMPLETE: finds a feature-family edge under DEFAULT_COORD_WORKSPACE even when coordScopeWorkspace() differs",
          "findImplementingWorkItem (PG) > is TENANT-COMPLETE: finds an issue-family edge under the real per-workspace tenant",
          "findImplementingWorkItem (PG) > an explicit workspace list still pins the read (the test-only escape hatch)",
          "findCoverageWorkItems (PG) > resolves `relates` edges to their work items, newest-first",
          "findCoverageWorkItems (PG) > excludes `implements` edges — only `relates` counts as coverage",
          "findCoverageWorkItems (PG) > returns [] when no coverage edge exists",
          "findCoverageWorkItems (PG) > is TENANT-COMPLETE: unions both workspaces the relates-coverage plane is split across",
          "draft item-start gate recognizes stamped terminal coverage (PG) > treats an implements-only stamped terminal work-item as completion evidence",
          "findConvertedWorkItemByStamp (PG, jsonb object-only payload) > matches a feature row whose payload is a real jsonb OBJECT",
          "findConvertedWorkItemByStamp (PG, jsonb object-only payload) > REJECTS a feature row whose payload is a jsonb STRING SCALAR (postgres-js binding quirk) at INSERT time",
          "findConvertedWorkItemByStamp (PG, jsonb object-only payload) > falls back to engineer_issues when no feature row matches",
          "findConvertedWorkItemByStamp (PG, jsonb object-only payload) > scopes stamped issue matches to the requested workspace and harness",
          "findConvertedWorkItemByStamp (PG, jsonb object-only payload) > returns null when no stamp matches",
          "findConvertedWorkItemByStamp (PG, jsonb object-only payload) > EI-19443762267304247: a work_items:create{plan_item} item (relates edge + stamp, NO implements edge) is found by the stamp fallback",
          "convertPlanItem step 2: terminal records must not mask a live one (EI-21213528544407590) > RESUMES the older open record instead of minting a duplicate (the live P-028 shape)",
          "convertPlanItem step 2: terminal records must not mask a live one (EI-21213528544407590) > a still-open STAMPED record whose edge was pruned is resumed too, not masked by a terminal edge",
          "convertPlanItem step 2: terminal records must not mask a live one (EI-21213528544407590) > resumes the canonical line node without stamps instead of its legacy child",
          "convertPlanItem step 2: terminal records must not mask a live one (EI-21213528544407590) > resumes a plans:start promoted feature linked only by source_plan columns",
          "convertPlanItem step 2: terminal records must not mask a live one (EI-21213528544407590) > refuses multiple live promoted-feature mappings instead of minting an issue sibling",
          "convertPlanItem step 2: terminal records must not mask a live one (EI-21213528544407590) > does not adopt a line node from another workspace",
          "convertPlanItem step 2: terminal records must not mask a live one (EI-21213528544407590) > still MINTS when every implementing record is genuinely terminal",
          "stampPromotedWorkItemProvenance + promotion wiring (P-003 / D-005 obligation 3) > stamps goal + both first-class plan columns for a promoter RUNNING a goal",
          "stampPromotedWorkItemProvenance + promotion wiring (P-003 / D-005 obligation 3) > a goal-less promoter still lands the plan columns — goal_id stays NULL",
          "stampPromotedWorkItemProvenance + promotion wiring (P-003 / D-005 obligation 3) > a superseded GOAL holder cannot stamp goal or plan provenance",
          "stampPromotedWorkItemProvenance + promotion wiring (P-003 / D-005 obligation 3) > an unreadable holder schema leaves provenance unchanged rather than assuming authority",
          "stampPromotedWorkItemProvenance + promotion wiring (P-003 / D-005 obligation 3) > first attribution wins; item ids accumulate without duplicates",
          "stampPromotedWorkItemProvenance + promotion wiring (P-003 / D-005 obligation 3) > fail-soft: resolves null instead of throwing when the DB is unreachable",
          "stampPromotedWorkItemProvenance + promotion wiring (P-003 / D-005 obligation 3) > convertPlanItem's MINT leaves the promoted row goal-stamped and plan-addressed",
          "stampPromotedWorkItemProvenance + promotion wiring (P-003 / D-005 obligation 3) > convertPlanItem's RESUME heals a row promoted before the stamp existed"
        ],
        "worktreeDirtyReason": "HEAD moved 6d0e6c377ac8 -> bd59dba04324",
        "testTimingRuntimeIdentity": "node:25.9.0 linux/x64 vitest:4.1.8",
        "runtimeEnvironmentAfterCaptureStatus": "not-configured",
        "runtimeEnvironmentBeforeCaptureStatus": "not-configured"
      },
      "is_scratch_config": false,
      "configuration_snapshot": {
        "flagEnv": {
          "PAPERCUSP_FLAG_PAPERCUSP_VOICE_CHANNELS": "1",
          "PAPERCUSP_FLAG_PAPERCUSP_HIVE_AGENT_TABS": "1"
        },
        "envSha256": {
          "NODE_ENV": "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
          "PAPERCUSP_CLUSTER": "5feceb66ffc86f38d952786c6d696c79c2dbc239dd4e91b46729d73a27fb57e9",
          "PAPERCUSP_PG_PORT": "50264c4f10893109040eeee1e52ce3326f5af21dae02450d019660668757d290",
          "PAPERCUSP_SPA_DIST": "67bbdf4463b86bc22b702ed9ff99538159478cb2270118a83c1de83bb492637d",
          "PAPERCUSP_BIND_HOST": "12ca17b49af2289436f303e0166030a21e525d266e209267433801a8fd4071a0",
          "PAPERCUSP_BUILD_SHA": "4d006a710697aa9e9858841f4fa54dcf4790d19b2f5859fad64792a443c54835",
          "PAPERCUSP_HONO_PORT": "d7827558d408d7af184cf3ab50d6ad7886ee44b67c6a9d0d7beafe3d0c902c85",
          "PAPERCUSP_PGBOUNCER": "6b86b273ff34fce19d6b804eff5a3f5747ada4eaa22f1d49c01e52ddb7875b4b",
          "PAPERCUSP_IPC_ENABLE": "6b86b273ff34fce19d6b804eff5a3f5747ada4eaa22f1d49c01e52ddb7875b4b",
          "PAPERCUSP_AGENT_DEBUG": "6b86b273ff34fce19d6b804eff5a3f5747ada4eaa22f1d49c01e52ddb7875b4b",
          "PAPERCUSP_DBOS_ENABLE": "6b86b273ff34fce19d6b804eff5a3f5747ada4eaa22f1d49c01e52ddb7875b4b",
          "PAPERCUSP_PTY_WS_PORT": "e902f49872400fbf419954994932d166f0f0868c36c8e755c45ff7403c0726aa",
          "PAPERCUSP_CUPBOARD_URL": "0c974e3d656236b578b4cad72e675ad2954ee720598568ebd7b7011478971d05",
          "PAPERCUSP_OPERATOR_URL": "74ce59d0fa726e50644160a9b964cfaf77a5027f30fcfbc50ad6b32cddcc09de",
          "PAPERCUSP_RELEASE_ROOT": "a7fb0e65e42c745b970ed9bac5ac5fc8b2f77aeb558a3334d096c0f6fed5f70e",
          "PAPERCUSP_WORKSPACE_ID": "24201c2745800b53f808f1453ded79e6bcd37ed1757e8683f6a5e888dc1a90b2",
          "PAPERCUSP_XBENCH_MODEL": "03e2025d2c64aa979d7677f8fb8c2f139cb05926e3d2fc6843bf4af2f6e1e557",
          "PC_EXECUTED_INPUTS_DIR": "a4ff0b2f079f7d1008feed2d61dd1ed0978d31817f96fb2a4297b6722026a7f6",
          "PAPERCUSP_ANTHROPIC_URL": "efde232628f3961647f75ca72e409469abf7ca23d1ab88c486cba2401c8669e8",
          "PAPERCUSP_CODEX_GATEWAY": "6b86b273ff34fce19d6b804eff5a3f5747ada4eaa22f1d49c01e52ddb7875b4b",
          "PAPERCUSP_DBOS_CURATION": "6b86b273ff34fce19d6b804eff5a3f5747ada4eaa22f1d49c01e52ddb7875b4b",
          "PAPERCUSP_DBOS_ROUTINES": "6b86b273ff34fce19d6b804eff5a3f5747ada4eaa22f1d49c01e52ddb7875b4b",
          "PAPERCUSP_FLEET_SANDBOX": "5feceb66ffc86f38d952786c6d696c79c2dbc239dd4e91b46729d73a27fb57e9",
          "PAPERCUSP_AGENT_GOVERNOR": "6b86b273ff34fce19d6b804eff5a3f5747ada4eaa22f1d49c01e52ddb7875b4b",
          "PAPERCUSP_CANONICAL_TREE": "64d7a60720aceb863d1d802149f1519d51517f4867365d951028cccf326c3f99",
          "PAPERCUSP_HIVE_HOME_SLUG": "f4df233b6a1a63ee848f046a99738cafc2b1b7d23a6cd6afb140960556c128d0",
          "PAPERCUSP_REMOTE_ORIGINS": "1633ece95e057db453bc570676588ebce8130fc78af99a57cb65b9059aaa01ce",
          "PAPERCUSP_TEST_RUN_GROUP": "9d35b9ccb29e36b6bb2f3c5b55e29d342cc504b7284c7724c8321d1c51b1e422",
          "PAPERCUSP_CLUSTER_WORKERS": "5feceb66ffc86f38d952786c6d696c79c2dbc239dd4e91b46729d73a27fb57e9",
          "PAPERCUSP_TEST_RUN_SOURCE": "25bf8e1a2393f1108d37029b3df5593236c755742ec93465bbafa9b290bddcf6",
          "PAPERCUSP_ALLOW_DB_MIGRATE": "6b86b273ff34fce19d6b804eff5a3f5747ada4eaa22f1d49c01e52ddb7875b4b",
          "PAPERCUSP_HOST_INSTANCE_ID": "9772726acb5517762e5c1d6676e9a9c0a1fa289cae40fc79a15304eda7e1cbb2",
          "PAPERCUSP_HOST_PG_DUMP_DIR": "856a75c41b7741a012b2be872bdc5f2c3c226ab2ba50cbc0c05abacc2ba91a2a",
          "PAPERCUSP_INTEGRATION_ROOT": "dc6d1db5b816770fecebc21675d5f459bfe1334bb7f98d4d589aeb41d4e75a3f",
          "PAPERCUSP_TEST_ATTRIBUTION": "6b86b273ff34fce19d6b804eff5a3f5747ada4eaa22f1d49c01e52ddb7875b4b",
          "PAPERCUSP_TEST_RUNS_DB_URL": "c942ee8b9c119f1e62d4016bb52dc6cabbf6f15fa7a77bdf9da269f2ab70ece8",
          "PAPERCUSP_TEST_RUN_HARNESS": "f4df233b6a1a63ee848f046a99738cafc2b1b7d23a6cd6afb140960556c128d0",
          "PAPERCUSP_ADMISSION_CONTEXT": "8f2981230bef596c0ee2a7fba8b71dbc5c5916d1e94930aeecdbcceb1bd85ce9",
          "PAPERCUSP_AGENT_GOVERNOR_PG": "6b86b273ff34fce19d6b804eff5a3f5747ada4eaa22f1d49c01e52ddb7875b4b",
          "PAPERCUSP_ALLOW_DEV_RESTART": "6b86b273ff34fce19d6b804eff5a3f5747ada4eaa22f1d49c01e52ddb7875b4b",
          "PAPERCUSP_DBOS_ORCHESTRATOR": "6b86b273ff34fce19d6b804eff5a3f5747ada4eaa22f1d49c01e52ddb7875b4b",
          "PAPERCUSP_EMBED_SIDECAR_URL": "0af1c49d382046abcf7c808a3af83b93cbaa0f85759a8b6828fd2dcd9721735f",
          "PAPERCUSP_REQUIRE_SPAWN_SIG": "6b86b273ff34fce19d6b804eff5a3f5747ada4eaa22f1d49c01e52ddb7875b4b",
          "PAPERCUSP_SKIP_PG_DISCOVERY": "6b86b273ff34fce19d6b804eff5a3f5747ada4eaa22f1d49c01e52ddb7875b4b",
          "PAPERCUSP_TEST_ARTIFACT_DIR": "07b2a927ed41995130aca8d0e91dddfe80a2d822bcb863e66de4b38f78b130b7",
          "PAPERCUSP_TEST_OWNED_DB_DIR": "a734c43686c389b9405f98f71048b29ddb0ec9ecffb2b4d9afe276f9a0307b05",
          "PAPERCUSP_TEST_PG_ADMIN_URL": "e828c882a99e2211340cf8909f3df5d43a91c6a7cd5d8602f58909894b0ae163",
          "PAPERCUSP_ALLOW_REMOTE_ADMIN": "6b86b273ff34fce19d6b804eff5a3f5747ada4eaa22f1d49c01e52ddb7875b4b",
          "PAPERCUSP_BACKGROUND_WORKERS": "5feceb66ffc86f38d952786c6d696c79c2dbc239dd4e91b46729d73a27fb57e9",
          "PAPERCUSP_BUNDLE_REUSE_FRESH": "6b86b273ff34fce19d6b804eff5a3f5747ada4eaa22f1d49c01e52ddb7875b4b",
          "PAPERCUSP_INSTALL_MUTEX_HELD": "f6271a7943c7b6876cc026c136bedad2f1f5854c01d39118d8d82e325e9f1dcd",
          "PAPERCUSP_MCP_PROXY_RETRY_MS": "6ce318969619d1c360b6144be09e3d3a22674897c7cbfe995716ed8b7ff7c4cf",
          "PAPERCUSP_OAUTH_STATE_SECRET": "54ce38ac099b6c5d95d42234137a256205d7550440fcf42c8400943de39252f7",
          "PAPERCUSP_SPAWNER_IPC_SOCKET": "2fd8506112e554a33d20408026f492556e942e2d48afaed177a0c11f0d05a1a7",
          "PAPERCUSP_TEST_RUN_WORK_ITEM": "9fb627cf461f4b80c50df09ddc508560cc70509ea12ac5a487ea8bae2a506dc4",
          "PAPERCUSP_TEST_STARTUP_TRACE": "acce452846a9f67d6404230e79b0b190f509cde980b164040ad766ed6b9993e8",
          "PAPERCUSP_WORKITEM_REDUNDANCY": "6b86b273ff34fce19d6b804eff5a3f5747ada4eaa22f1d49c01e52ddb7875b4b",
          "PAPERCUSP_ACCOUNT_ROUTING_MODE": "929260ad9b9ea9fe0f3553dd964f4ff3deb5792efd031a2b90f573fe91f012bb",
          "PAPERCUSP_TEST_FILE_TIMEOUT_MS": "d76a2d6b4df12224d7667b9d46e72342140a8aabba88e130e560743cfada6599",
          "PAPERCUSP_WORKITEM_CLAIM_LEASE": "6b86b273ff34fce19d6b804eff5a3f5747ada4eaa22f1d49c01e52ddb7875b4b",
          "PAPERCUSP_XBENCH_BEE_DIRECTIVE": "d37e196e11d8560f127218559b79519d40cd09d0452efffd3130d6fef5228365",
          "PAPERCUSP_MCP_STAGING_PROXY_PORT": "f27a6c4a43c81147c1db2c4669a749ece8672c0012f4dece2da6c454a3e17753",
          "PAPERCUSP_TASK_DEADLINE_EPOCH_MS": "36988dfc8a66429a90766df37e48b14efd5605a83075d7b046337eeb8ad66d7e",
          "PAPERCUSP_DBOS_DISPATCH_HARNESSES": "140bedbf9c3f6d56a9846d2ba7088798683f4da0c248231336e6a05679e4fdfe",
          "PAPERCUSP_TEST_CHILD_CUTOFF_AT_MS": "1bdcdf1d4b09f18147214dd156142249f89fe3fbbaad2063298230618825ce85",
          "PAPERCUSP_TEST_CLEANUP_RESERVE_MS": "891937cb335016e9c7074c3781dcb1364e0c660733a8889bbeae83e6aa759be6",
          "PAPERCUSP_BUNDLE_ALLOW_STALE_START": "6b86b273ff34fce19d6b804eff5a3f5747ada4eaa22f1d49c01e52ddb7875b4b",
          "PAPERCUSP_COMMITTED_SOURCE_NOTICES": "55eb6b098650f28fcd5bee0ab3f449372dde1da1631329440eca0433159a55ef",
          "PAPERCUSP_DEV_DEPLOY_SPAWN_SIDECAR": "6b86b273ff34fce19d6b804eff5a3f5747ada4eaa22f1d49c01e52ddb7875b4b",
          "PAPERCUSP_DOGFOOD_SUBSTRATE_ENABLE": "6b86b273ff34fce19d6b804eff5a3f5747ada4eaa22f1d49c01e52ddb7875b4b",
          "PAPERCUSP_PLAN_AUDIT_SPAWN_SIDECAR": "6b86b273ff34fce19d6b804eff5a3f5747ada4eaa22f1d49c01e52ddb7875b4b",
          "PAPERCUSP_TEST_TASK_DEADLINE_AT_MS": "28d7cc5935b5b91ac3c335e09843550ed8f748ad942d5b409480a49928c6d6ba",
          "PAPERCUSP_RESTRICTED_HOLD_PREFLIGHT": "7f2b2ada46b1da6b07455fea69c8c17e9c66c44b9ee3fcdd02f3d870fbbc90b5",
          "PAPERCUSP_TEST_FAILURE_DETAILS_PATH": "2d78d1484e855357004afd171aae0a6e7da28165930f1b1969e719f3d28fb152",
          "PAPERCUSP_GIT_PIPELINE_SPAWN_SIDECAR": "6b86b273ff34fce19d6b804eff5a3f5747ada4eaa22f1d49c01e52ddb7875b4b",
          "PAPERCUSP_SYSTEM_HEALTH_SPAWN_SIDECAR": "6b86b273ff34fce19d6b804eff5a3f5747ada4eaa22f1d49c01e52ddb7875b4b",
          "PAPERCUSP_WORKSPACE_HOST_MIGRATION_ID": "74caec949706f470b24336cc3c5a6d3c592e8fe194825b340f90bffa9a3e426c",
          "PAPERCUSP_ALLOW_LLM_TEST_BUDGET_BYPASS": "6b86b273ff34fce19d6b804eff5a3f5747ada4eaa22f1d49c01e52ddb7875b4b",
          "PAPERCUSP_WORKSPACE_HOST_IDENTITY_FILE": "4a064239301835009ce52fe7c82d838c10ff3c3c972d2a0ec0e5c8eedd470e49",
          "PAPERCUSP_FLAG_PAPERCUSP_VOICE_CHANNELS": "6b86b273ff34fce19d6b804eff5a3f5747ada4eaa22f1d49c01e52ddb7875b4b",
          "PAPERCUSP_PRIVATE_TEST_PG_RELEASE_TOKEN": "378b6647af9faa181784725d7e054dd3ada963623c344256069bc350a0a995a4",
          "PAPERCUSP_FLAG_PAPERCUSP_HIVE_AGENT_TABS": "6b86b273ff34fce19d6b804eff5a3f5747ada4eaa22f1d49c01e52ddb7875b4b",
          "PAPERCUSP_GREEN_CHECKPOINT_CAPACITY_MODE": "c0d03c1239e01842d73cf046314bdc7de6e5d3280afc9776262f78be40a95bab",
          "PAPERCUSP_IMPROVEMENT_DRAIN_STOPS_CLAIMS": "6b86b273ff34fce19d6b804eff5a3f5747ada4eaa22f1d49c01e52ddb7875b4b",
          "PAPERCUSP_WORKSPACE_HOST_RELEASE_MANIFEST": "3bb3062702aa3892aaccaca191ee8cfac481ea7cdf52706cc10687f31daa6e4a",
          "PAPERCUSP_CAPABILITY_BASH_BACKGROUND_TASK_ID": "caec9016abb72dd9ad2952fdcf5a337e82960487f26efeba5d085ac2a601c0a2"
        },
        "fingerprint": "sha256-config-snapshot-v1:3ab6690019f5907413f8edf4acd484ee9dd839288ffe1eebc1abab48569f38d1",
        "schemaVersion": 1
      }
    }
  ],
  "sourceWitnesses": {
    "head": "0d22f8a4817efe0ed66f8483facc2d29a34129c2",
    "witnesses": [
      {
        "revision": "working-tree",
        "path": "packages/operator-core/lib/agent-tools/recipes/recipe-schema-validation.ts",
        "sha256": "b3b6ae5ca8db387f82185f18dfc7641437d439120494e3beda1558893ad50c73",
        "gitBlobSha": "0b65955a90bf0a70dc273810f9f4a9cc471c57be",
        "start": 285,
        "end": 310,
        "text": "285:  // resolution: literal arguments accepted when the recipe was saved but no\n286:  // longer accepted by the current tool schema.\n287:  const issues: RecipeSchemaIssue[] = [];\n288:\n289:  for (const call of analysis.calls) {\n290:    const name = call.tool.includes(':') ? call.tool : [...byName.keys()].find((candidate) => candidate?.replace(':', '.') === call.tool);\n291:    const tool = name ? byName.get(name) : undefined;\n292:    if (!name || ",
        "excerptLimitChars": 450
      },
      {
        "revision": "working-tree",
        "path": "packages/operator-core/lib/agent-tools/code/run.arg-preflight.test.ts",
        "sha256": "1af46557e0f4ef1b02551cbafb63cd3c6697731916dfc71e69f72bbd34bfa46c",
        "gitBlobSha": "3b9550b6e671a4069c652a63db4caaf76a0d39cd",
        "start": 140,
        "end": 157,
        "text": "140:    runToolOrchestrationMock.mockResolvedValue(orchestration());\n141:    validateMock.mockReset();\n142:    validateMock.mockResolvedValue({ ok: true, issues: [], staticToolNames: [] });\n143:  });\n144:\n145:  it('normalizes registered positional work_items:claim rows before code:run preflight', async () => {\n146:    const { validateRecipeScriptAgainstCatalog } = await vi.importActual<\n147:      typeof import('../recipes/recipe-schema-validation",
        "excerptLimitChars": 450
      },
      {
        "revision": "working-tree",
        "path": "packages/operator-core/lib/carry-respawn-outcome.ts",
        "sha256": "a943ab44955d0281ccc7abef1358fe133cece0de3938d1f3604142f39be43481",
        "gitBlobSha": "501230cae5677c4e5871d48c2908eda9fb088f2d",
        "start": 48,
        "end": 68,
        "text": "48:\n49:/** Host event kinds that constitute the carry-respawn lifecycle, in the order a\n50: *  successful respawn emits them. Anything else in the log (wake deferrals,\n51: *  stale-fire drops, shutdown rows) is NOT a verdict about a respawn. */\n52:const RESPAWN_TERMINAL_OK = new Set(['respawn-carry-delivered']);\n53:// `respawn-failed` without retryable is terminal. A retryable failure is one\n54:// attempt in the host's re-arm window, so the carry",
        "excerptLimitChars": 450
      },
      {
        "revision": "working-tree",
        "path": "packages/operator-core/lib/events/await/turn-end-held-work-guard.ts",
        "sha256": "61aa1b53e4ebaea4ab4394270fff3ab6400d852f018a68a53dbf762524b0195f",
        "gitBlobSha": "570ea7a44d9bc8db523c617c26c30d5e14b386be",
        "start": 230,
        "end": 256,
        "text": "230:    if (held.length === 0) return safeStop();\n231:    const loopActive = await deps.getLoopActive(ownerId);\n232:    // An unreadable loop status is unknown, and unknown never refuses (nor cancels anything).\n233:    if (loopActive === null) return '';\n234:    if (loopActive) return safeStop();\n235:    const [parked, pendingDelivery, pendingCarryRespawn] = await Promise.all([\n236:      deps.listParkedAwaits(ownerId),\n237:      deps.hasPendingDe",
        "excerptLimitChars": 450
      },
      {
        "revision": "working-tree",
        "path": "packages/operator-core/lib/events/await/turn-end-held-work-guard.test.ts",
        "sha256": "5c6037039512f335d71be73b0da97102ce8e54538db2ebdd33a0f34cc657d800",
        "gitBlobSha": "e3b3dc8b1b8af6fef0d42f39040c5b808d1c9ec8",
        "start": 280,
        "end": 328,
        "text": "280:  it('lets the turn end when a deliberate wake is already queued', async () => {\n281:    const text = await evaluateTurnEndHeldWorkStop({\n282:      ownerId: OWNER,\n283:      workspaceId: WS,\n284:      deps: deps({ hasPendingDeliberateWakeDelivery: async () => true }),\n285:    });\n286:    expect(text).toBe('');\n287:  });\n288:\n289:  it('allows a recent accepted carry only after retaining a bounded fallback wake', async () => {\n290:    const own",
        "excerptLimitChars": 450
      },
      {
        "revision": "working-tree",
        "path": "apps/operator/scripts/psu-pty-host.mjs",
        "sha256": "c7e782970f908a9b4ec01bd22eeaebb16aba734f172c6d40b0855b6937991df1",
        "gitBlobSha": "de1053a671d7d7c390a423ce1d78a3c6501aa494",
        "start": 5840,
        "end": 5870,
        "text": "5840:    if (currentMode === 'auto') return null;\n5841:    return currentMode === 'manual' ? 'wake-mode-manual' : 'wake-mode-unavailable';\n5842:  };\n5843:  const keyFor = (msg) => {\n5844:    const drillId = String(msg?.drillId || '');\n5845:    if (drillId) return drillId;\n5846:    const mode = rearmModeOf(msg);\n5847:    // A loop fire must keep its own text and provenance through the retry.\n5848:    // Sharing turn mode with inbox wakes let the n",
        "excerptLimitChars": 450
      },
      {
        "revision": "f7c61972a8dbc2ab7d591fe306e2f16e71bb2c68",
        "path": "packages/operator-core/lib/code-recipes-candidates.ts",
        "sha256": "b7d2648448cdd398b76ba147077f4fb3a921ee8ef1de6d28cd70adf3f4bceec1",
        "gitBlobSha": "bb6a998e30cfcae8ce69f62f591f6d0761eddf8f",
        "start": 350,
        "end": 450,
        "text": "350:    const total = W_FREQUENCY + W_BREADTH + W_SUCCESS + W_COHESION + W_COOCCUR;\n351:    base = (base + W_COOCCUR * clamp01(cooccurrence)) / total;\n352:  }\n353:  return signal.redundant ? 0 : clamp01(base);\n354:}\n355:\n356:/**\n357: * Compute graduation candidates for the active recipes. Deterministic\n358: * end-to-end except for the optional embedder/co-occurrence deps (which only\n359: * reorder, never gate). Returns ranked promote candidates +",
        "excerptLimitChars": 450
      },
      {
        "revision": "f7c61972a8dbc2ab7d591fe306e2f16e71bb2c68",
        "path": "packages/operator-core/lib/code-recipes-candidates.integration.test.ts",
        "sha256": "a515ce980583116eb0c1d8995a3f4aefaf24c5d7d74ee05ca0f6d42f112d971c",
        "gitBlobSha": "ce666ee13af907a37095b178ef71f425c564bee2",
        "start": 187,
        "end": 227,
        "text": "187:  it('P003-RELIABILITY: a settled failed replay lowers reliability without changing successful-use popularity', async () => {\n188:    const id = 'truthful-replay-reliability';\n189:    await upsertRecipe(db.adminSql, {\n190:      id, potSlug: null, title: 'Measure replay outcomes', description: 'Keep failed replay evidence',\n191:      script: 'return 1;', toolsUsed: ['work_items:list', 'work_items:comment'],\n192:    });\n193:    const run = asyn",
        "excerptLimitChars": 450
      },
      {
        "revision": "bd59dba0432419e2848f297ab78eed8f891902ab",
        "path": "packages/operator-core/lib/plan-items/convert.ts",
        "sha256": "bc5de3db81b0c1759d88b51bc7dc79253c3f03d4f4b81bbc3887d730341260af",
        "gitBlobSha": "e23e6c7471b1f1d9a123b2cfffe0392faa40bb71",
        "start": 790,
        "end": 850,
        "text": "790:    plan_slug: opts.planSlug,\n791:    item_id: opts.itemId,\n792:    harness_slug: opts.harnessSlug,\n793:    ...(itemTextHash ? { item_text_hash: itemTextHash } : {}),\n794:  };\n795:  const planItem = { plan: opts.planSlug, item: opts.itemId, status: item.status, text: item.text };\n796:\n797:  // ── 2. Resume an existing non-terminal execution record, if any ───────────\n798:  // Current plan-line nodes are the primary identity. Older conversions",
        "excerptLimitChars": 450
      },
      {
        "revision": "bd59dba0432419e2848f297ab78eed8f891902ab",
        "path": "packages/operator-core/lib/plan-items/convert.integration.test.ts",
        "sha256": "8ca6791af4ccfa6f343460e320d5ca986bd2abd2ee7de1ed3c5dabf331fa379e",
        "gitBlobSha": "7e480d0cf41dd11e9db5a2fb5f18dd1b35c4227e",
        "start": 570,
        "end": 612,
        "text": "570:    expect(await convert('P-031')).toMatchObject({ status: 'resumed', workItem: { id: 'WI-node' } });\n571:    expect(createWorkItemM).not.toHaveBeenCalled();\n572:  });\n573:\n574:  it('resumes a plans:start promoted feature linked only by source_plan columns', async () => {\n575:    givenPlanItem('P-033');\n576:    await rootSql`INSERT INTO harness_shared.work_items\n577:      (workspace_id, harness_slug, feature_id, item_kind, status, payload,\n57",
        "excerptLimitChars": 450
      },
      {
        "revision": "working-tree",
        "path": "scripts/check-no-box-identity.mjs",
        "sha256": "7f4f8c2c3a37713b4da83ae7e4df7feb26af8dab38a15f9a91f98f7cbcd11657",
        "gitBlobSha": "cc7eebc10c9bd6870ef1b325037f462dff61bef2",
        "start": 1,
        "end": 200,
        "text": "1:#!/usr/bin/env node\n2:/**\n3: * check-no-box-identity.mjs — fail-loud guard against a developer's own machine\n4: * leaking into tracked source (WI-4419).\n5: *\n6: * WHY THIS EXISTS\n7: * Every release bundle ships `sidecar/source.tar.zst`, a tar of the monorepo\n8: * working tree, straight to whoever we hand a build to. The 0.0.8 cut shipped the\n9: * owner's home path 53,811 times. bin/audit-release-bundle.py is the GATE that\n10: * catches that — b",
        "excerptLimitChars": 450
      },
      {
        "revision": "working-tree",
        "path": ".gitignore",
        "sha256": "70c8fc4fb7e95af7c1fd824f9d86bcf1c8b59c8521bd70a1ab0505d723c5d1bb",
        "gitBlobSha": "aa693b231f8d59edc8216d030e9ab0ce03ecc0e7",
        "start": 100,
        "end": 125,
        "text": "100:\n101:# Per-run test output (p2p-perf bench artifacts + report.md, Playwright, etc.).\n102:# Ephemeral, keyed by a timestamp/runId — NOT source. Committed baselines that\n103:# ARE source live elsewhere (e.g. perf/baselines/*.json) and are unaffected.\n104:# (2026-06-07: git-sync was sweeping p2p-perf run dirs into commits.)\n105:test-results/\n106:**/test-results/\n107:.env\n108:.env.local\n109:# Cloudflare wrangler local secrets (JWT_SECRET, CF toke",
        "excerptLimitChars": 450
      },
      {
        "revision": "working-tree",
        "path": "packages/operator-core/lib/doc-claims/dot-prefixed-test-scratch.test.ts",
        "sha256": "ea373ce6c17ee01986d5863d46745da10203d50864b76780b6cf50af0f7e6bbe",
        "gitBlobSha": "dc73745570fe727fbf8bc7865979c68e049c97e7",
        "start": 145,
        "end": 190,
        "text": "145:      .filter((p) => /(^|\\/)\\.[^/]*\\.(test|spec)\\.(ts|tsx|mts|cts)$/.test(p));\n146:\n147:    expect(\n148:      tracked,\n149:      'dot-prefixed test file(s) are TRACKED. The .gitignore pattern cannot evict what ' +\n150:        'is already committed, so these need `git rm --cached` (or deletion, if they are ' +\n151:        'the scratch they look like).',\n152:    ).toEqual([]);\n153:  });\n154:});\n155:\n156:describe('Wrangler local output is gitign",
        "excerptLimitChars": 450
      }
    ]
  },
  "support": {
    "recipe": {
      "ledgerIds": [
        23487166,
        23487695,
        23487721,
        23487723
      ],
      "subjectHashMatches": true,
      "testHashMatches": true,
      "scope": "Original success-then-failure reliability/preserved popularity; production shipment and prevalence unverified"
    },
    "conversion": {
      "ledgerIds": [
        23502654
      ],
      "scope": "Committed source_plan-only resume and ambiguous mapping refusal with realPG test; dirty HEAD-move provenance retained; actual deployed declaration episode unverified"
    },
    "adjacent": [
      {
        "id": 23490325,
        "scope": "SQL feedback/review and reuse measurement tests; retained as adjacent P003 evidence, not independent proof of original recipe denominator behavior"
      },
      {
        "id": 23490326,
        "scope": "SQL feedback/review and reuse measurement tests; retained as adjacent P003 evidence, not independent proof of original recipe denominator behavior"
      },
      {
        "id": 23490327,
        "scope": "SQL feedback/review and reuse measurement tests; retained as adjacent P003 evidence, not independent proof of original recipe denominator behavior"
      }
    ]
  },
  "boundaries": [
    "No fresh tests executed",
    "No controls, holds, claims, gate operations or peer monitoring",
    "No requery of target20/eight ledger/original92/6221",
    "Full8R26 and necessary5744 remain separate open work, not prerequisites",
    "Original zero-unexplained R1 remains OPEN; no universal legitimacy/fix claim"
  ],
  "next": "Finish independent original-scope/condition qualification outside these20pairs using existing saved evidence; original92 source assessments complete, do not repeat."
}
