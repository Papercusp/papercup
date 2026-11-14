---
rel_path: "portability/review/transfer-adoption-consult1220796-v1.json"
updated_at: 1794179711659
_body: "content"
---

{
  "rubricRef": "acceptance-instance-machine-transfer-2026-10-08",
  "criteria": [
    {
      "key": "r-1",
      "title": "Complete retained customer state",
      "model": "The restored destination preserves the complete retained customer-state inventory.",
      "bar": "The restored destination preserves the complete retained customer-state inventory.",
      "barKey": "R-1",
      "role": "outcome",
      "mandatory": true,
      "requiredScope": [
        "live"
      ],
      "evidencePlane": "live",
      "passRatings": [
        "healthy"
      ],
      "barProvenance": {
        "lifecycle": "pre-implementation",
        "declaredAt": "2026-10-15T05:10:42.403Z",
        "declaredBy": "su-a80c1121-6a12-46f8-8bf9-860f27325283"
      },
      "method": "MANDATORY ORIGINAL CONTRACT (every condition remains required): Enumerate and restore workspace files, repositories including uncommitted work and nested repositories, local authoritative database/plugin data, plans, memory, settings, attachments, and retained user/session history. Every discovered state location has an explicit include, rebuild, external dependency, or deliberate-omission disposition. Existing hot-backup exclusions are not automatically a migration policy.\nVerify exact primary R-2/R-3/R-4/R-6/R-21/R-25 evidence using the Design adoption map: P-001 maps, P-003 performs the complete evidence coverage census, P-009 independently drives the native Linux x86_64-to-Linux x86_64 clean-destination GUI journey and full dev-box reference proof, and P-010 verifies exact signed artifacts. Read exact registered test/fault results and source/subject/artifact bindings; unbuilt, absent or stale proof is unknown. Retain clean-offline unlock, producer cut and epoch-fenced handover contracts from primary R-20/R-21/R-22. M1 supports only the explicit Linux x86_64 native route; UI/docs label others unsupported until primary M2 proof.",
      "driftMarkers": "Any required discovered store lacks an explicit disposition or retained content readback.",
      "intent": {
        "request": "Adopt the approved canonical portable-instance implementation and independently verify this customer transfer obligation without duplicating it.",
        "sourceRefs": [
          "session_turn:claude:84d419a0-76cc-4123-b484-f05c017166f6:0",
          "session_turn:codex:01a1bcef-63b8-7292-b72b-4bae418798c9:11"
        ]
      },
      "check": {
        "kind": "instrument",
        "instrumentKey": "none"
      }
    },
    {
      "key": "r-2",
      "title": "Confidentiality and usable identity",
      "model": "A clean offline destination recovers readable encrypted customer data from the transfer archive and transfer secret.",
      "bar": "A clean offline destination recovers readable encrypted customer data from the transfer archive and transfer secret.",
      "barKey": "R-2",
      "role": "outcome",
      "mandatory": true,
      "requiredScope": [
        "live"
      ],
      "evidencePlane": "live",
      "passRatings": [
        "healthy"
      ],
      "barProvenance": {
        "lifecycle": "pre-implementation",
        "declaredAt": "2026-10-15T05:10:42.403Z",
        "declaredBy": "su-a80c1121-6a12-46f8-8bf9-860f27325283"
      },
      "method": "MANDATORY ORIGINAL CONTRACT (every condition remains required): Encrypt the archive with a user-controlled transfer secret. Preserve or securely rewrap keys needed to read imported data. Handle account/workspace identity separately from device identity, and clearly identify integrations requiring fresh authorization. No cleartext credential export or blind copying of source OS-keychain storage.\nVerify exact primary R-5/R-20/R-22/R-25 evidence using the Design adoption map: P-001 maps, P-003 performs the complete evidence coverage census, P-009 independently drives the native Linux x86_64-to-Linux x86_64 clean-destination GUI journey and full dev-box reference proof, and P-010 verifies exact signed artifacts. Read exact registered test/fault results and source/subject/artifact bindings; unbuilt, absent or stale proof is unknown. Retain clean-offline unlock, producer cut and epoch-fenced handover contracts from primary R-20/R-21/R-22. M1 supports only the explicit Linux x86_64 native route; UI/docs label others unsupported until primary M2 proof.",
      "driftMarkers": "Transfer needs source-only key material, exposes credentials or cannot read imported encrypted values.",
      "intent": {
        "request": "Adopt the approved canonical portable-instance implementation and independently verify this customer transfer obligation without duplicating it.",
        "sourceRefs": [
          "session_turn:claude:84d419a0-76cc-4123-b484-f05c017166f6:0",
          "session_turn:codex:01a1bcef-63b8-7292-b72b-4bae418798c9:11"
        ]
      },
      "check": {
        "kind": "instrument",
        "instrumentKey": "none"
      }
    },
    {
      "key": "r-3",
      "title": "Defined compatibility and portable restoration",
      "model": "Destination activation accepts only a transfer compatible with the declared supported route.",
      "bar": "Destination activation accepts only a transfer compatible with the declared supported route.",
      "barKey": "R-3",
      "role": "outcome",
      "mandatory": true,
      "requiredScope": [
        "live"
      ],
      "evidencePlane": "live",
      "passRatings": [
        "healthy"
      ],
      "barProvenance": {
        "lifecycle": "pre-implementation",
        "declaredAt": "2026-10-15T05:10:42.403Z",
        "declaredBy": "su-a80c1121-6a12-46f8-8bf9-860f27325283"
      },
      "method": "MANDATORY ORIGINAL CONTRACT (every condition remains required): Validate manifest, app/schema versions, Postgres/extensions, OS/CPU architecture, paths, storage space, and runtime prerequisites before activation. Publish an explicit supported source/destination matrix. Reinstall platform-specific dependencies instead of assuming executable bytes move across architectures.\nVerify exact primary R-3/R-5/R-24/R-25 evidence using the Design adoption map: P-001 maps, P-003 performs the complete evidence coverage census, P-009 independently drives the native Linux x86_64-to-Linux x86_64 clean-destination GUI journey and full dev-box reference proof, and P-010 verifies exact signed artifacts. Read exact registered test/fault results and source/subject/artifact bindings; unbuilt, absent or stale proof is unknown. Retain clean-offline unlock, producer cut and epoch-fenced handover contracts from primary R-20/R-21/R-22. M1 supports only the explicit Linux x86_64 native route; UI/docs label others unsupported until primary M2 proof.",
      "driftMarkers": "An unsupported version/path/storage/runtime/OS/architecture combination is activated or the support matrix overclaims.",
      "intent": {
        "request": "Adopt the approved canonical portable-instance implementation and independently verify this customer transfer obligation without duplicating it.",
        "sourceRefs": [
          "session_turn:claude:84d419a0-76cc-4123-b484-f05c017166f6:0",
          "session_turn:codex:01a1bcef-63b8-7292-b72b-4bae418798c9:11"
        ]
      },
      "check": {
        "kind": "instrument",
        "instrumentKey": "none"
      }
    },
    {
      "key": "r-4",
      "title": "Recoverable import",
      "model": "An interrupted restore preserves a recoverable isolated destination.",
      "bar": "An interrupted restore preserves a recoverable isolated destination.",
      "barKey": "R-4",
      "role": "outcome",
      "mandatory": true,
      "requiredScope": [
        "live"
      ],
      "evidencePlane": "live",
      "passRatings": [
        "healthy"
      ],
      "barProvenance": {
        "lifecycle": "pre-implementation",
        "declaredAt": "2026-10-15T05:10:42.403Z",
        "declaredBy": "su-a80c1121-6a12-46f8-8bf9-860f27325283"
      },
      "method": "MANDATORY ORIGINAL CONTRACT (every condition remains required): Restore into a separate destination, validate before activation, record progress durably, resume interruption safely, and retain a rollback option. An invalid, incomplete, incompatible, or corrupt archive never partially replaces a working instance.\nVerify exact primary R-5/R-20/R-21/R-22/R-25 evidence using the Design adoption map: P-001 maps, P-003 performs the complete evidence coverage census, P-009 independently drives the native Linux x86_64-to-Linux x86_64 clean-destination GUI journey and full dev-box reference proof, and P-010 verifies exact signed artifacts. Read exact registered test/fault results and source/subject/artifact bindings; unbuilt, absent or stale proof is unknown. Retain clean-offline unlock, producer cut and epoch-fenced handover contracts from primary R-20/R-21/R-22. M1 supports only the explicit Linux x86_64 native route; UI/docs label others unsupported until primary M2 proof.",
      "driftMarkers": "Corruption or interruption partially replaces a working destination, loses rollback or executes work before handover.",
      "intent": {
        "request": "Adopt the approved canonical portable-instance implementation and independently verify this customer transfer obligation without duplicating it.",
        "sourceRefs": [
          "session_turn:claude:84d419a0-76cc-4123-b484-f05c017166f6:0",
          "session_turn:codex:01a1bcef-63b8-7292-b72b-4bae418798c9:11"
        ]
      },
      "check": {
        "kind": "instrument",
        "instrumentKey": "none"
      }
    },
    {
      "key": "r-5",
      "title": "Single active executor after a move",
      "model": "Committed instance handover preserves one execution authority across source restart.",
      "bar": "Committed instance handover preserves one execution authority across source restart.",
      "barKey": "R-5",
      "role": "outcome",
      "mandatory": true,
      "requiredScope": [
        "live"
      ],
      "evidencePlane": "live",
      "passRatings": [
        "healthy"
      ],
      "barProvenance": {
        "lifecycle": "pre-implementation",
        "declaredAt": "2026-10-15T05:10:42.403Z",
        "declaredBy": "su-a80c1121-6a12-46f8-8bf9-860f27325283"
      },
      "method": "MANDATORY ORIGINAL CONTRACT (every condition remains required): Pause or quiesce source writers and background jobs for the final consistent export. Imported sessions, claims, timers, and process identifiers never masquerade as running processes. A handover protocol prevents duplicate agent work, scheduled actions, and outward sends when both computers are reachable, and has an explicit offline move procedure.\nVerify exact primary R-21/R-22/R-25 evidence using the Design adoption map: P-001 maps, P-003 performs the complete evidence coverage census, P-009 independently drives the native Linux x86_64-to-Linux x86_64 clean-destination GUI journey and full dev-box reference proof, and P-010 verifies exact signed artifacts. Read exact registered test/fault results and source/subject/artifact bindings; unbuilt, absent or stale proof is unknown. Retain clean-offline unlock, producer cut and epoch-fenced handover contracts from primary R-20/R-21/R-22. M1 supports only the explicit Linux x86_64 native route; UI/docs label others unsupported until primary M2 proof.",
      "driftMarkers": "A source restart or stale epoch duplicates agent work, schedules or outward sends.",
      "intent": {
        "request": "Adopt the approved canonical portable-instance implementation and independently verify this customer transfer obligation without duplicating it.",
        "sourceRefs": [
          "session_turn:claude:84d419a0-76cc-4123-b484-f05c017166f6:0",
          "session_turn:codex:01a1bcef-63b8-7292-b72b-4bae418798c9:11"
        ]
      },
      "check": {
        "kind": "instrument",
        "instrumentKey": "none"
      }
    },
    {
      "key": "r-6",
      "title": "Understandable user journey",
      "model": "A user completes the supported native instance move through the GUI without terminal commands.",
      "bar": "A user completes the supported native instance move through the GUI without terminal commands.",
      "barKey": "R-6",
      "role": "outcome",
      "mandatory": true,
      "requiredScope": [
        "live"
      ],
      "evidencePlane": "live",
      "passRatings": [
        "healthy"
      ],
      "barProvenance": {
        "lifecycle": "pre-implementation",
        "declaredAt": "2026-10-15T05:10:42.403Z",
        "declaredBy": "su-a80c1121-6a12-46f8-8bf9-860f27325283"
      },
      "method": "MANDATORY ORIGINAL CONTRACT (every condition remains required): Provide Export instance in Settings and Restore existing instance in first-run setup, with destination validation, progress, data/omission previews, credential reauthorization prompts, final verification, and a recovery path.\nVerify exact primary R-23/R-24 evidence using the Design adoption map: P-001 maps, P-003 performs the complete evidence coverage census, P-009 independently drives the native Linux x86_64-to-Linux x86_64 clean-destination GUI journey and full dev-box reference proof, and P-010 verifies exact signed artifacts. Read exact registered test/fault results and source/subject/artifact bindings; unbuilt, absent or stale proof is unknown. Retain clean-offline unlock, producer cut and epoch-fenced handover contracts from primary R-20/R-21/R-22. M1 supports only the explicit Linux x86_64 native route; UI/docs label others unsupported until primary M2 proof.",
      "driftMarkers": "A supported GUI move requires an agent/terminal or lacks actionable preview, progress, sign-in, verification or recovery.",
      "intent": {
        "request": "Adopt the approved canonical portable-instance implementation and independently verify this customer transfer obligation without duplicating it.",
        "sourceRefs": [
          "session_turn:claude:84d419a0-76cc-4123-b484-f05c017166f6:0",
          "session_turn:codex:01a1bcef-63b8-7292-b72b-4bae418798c9:11"
        ]
      },
      "check": {
        "kind": "instrument",
        "instrumentKey": "none"
      }
    },
    {
      "key": "r-7",
      "title": "Evidence-based runtime alignment",
      "model": "Published runtime guidance matches the approved primary runtime choices and measured limitations.",
      "bar": "Published runtime guidance matches the approved primary runtime choices and measured limitations.",
      "barKey": "R-7",
      "role": "outcome",
      "mandatory": true,
      "requiredScope": [
        "live"
      ],
      "evidencePlane": "live",
      "passRatings": [
        "healthy"
      ],
      "barProvenance": {
        "lifecycle": "pre-implementation",
        "declaredAt": "2026-10-15T05:10:42.403Z",
        "declaredBy": "su-a80c1121-6a12-46f8-8bf9-860f27325283"
      },
      "method": "MANDATORY ORIGINAL CONTRACT (every condition remains required): Reuse the primary plan's Phase 0 evidence and D-009 choices: rootless Podman/Docker on Linux, the common image imported as a WSL distro on Windows, and Podman machine on macOS with real Apple-silicon proof still required. Optional Incus research does not block release or reopen those choices. Record migration compatibility and external-state limits without creating a second lifecycle system.\nVerify exact primary R-1/R-7/R-9/R-10/R-11/R-19/R-24 evidence using the Design adoption map: P-001 maps, P-003 performs the complete evidence coverage census, P-009 independently drives the native Linux x86_64-to-Linux x86_64 clean-destination GUI journey and full dev-box reference proof, and P-010 verifies exact signed artifacts. Read exact registered test/fault results and source/subject/artifact bindings; unbuilt, absent or stale proof is unknown. Retain clean-offline unlock, producer cut and epoch-fenced handover contracts from primary R-20/R-21/R-22. M1 supports only the explicit Linux x86_64 native route; UI/docs label others unsupported until primary M2 proof.",
      "driftMarkers": "Guidance contradicts Phase 0/D007/D009, omits real Apple-silicon proof for a claimed Mac route, or introduces another runtime lifecycle.",
      "intent": {
        "request": "Adopt the approved canonical portable-instance implementation and independently verify this customer transfer obligation without duplicating it.",
        "sourceRefs": [
          "session_turn:claude:84d419a0-76cc-4123-b484-f05c017166f6:0",
          "session_turn:codex:01a1bcef-63b8-7292-b72b-4bae418798c9:11"
        ]
      },
      "check": {
        "kind": "instrument",
        "instrumentKey": "none"
      }
    },
    {
      "key": "r-8",
      "title": "Real round-trip proof and shipment",
      "model": "The independently accepted native migration passes on the exact signed released artifacts.",
      "bar": "The independently accepted native migration passes on the exact signed released artifacts.",
      "barKey": "R-8",
      "role": "outcome",
      "mandatory": true,
      "requiredScope": [
        "deployed"
      ],
      "evidencePlane": "deployed",
      "passRatings": [
        "healthy"
      ],
      "barProvenance": {
        "lifecycle": "pre-implementation",
        "declaredAt": "2026-10-15T05:10:42.403Z",
        "declaredBy": "su-a80c1121-6a12-46f8-8bf9-860f27325283"
      },
      "method": "MANDATORY ORIGINAL CONTRACT (every condition remains required): Ship feature tests in the existing framework and complete isolated fresh-install migration drills for the declared platform matrix, including retained content fidelity, credential usability, corruption, interruption, rollback, and duplicate-execution guards. Final shipment is verified on the exact released artifacts after independent acceptance.\nVerify exact primary R-6/R-20/R-21/R-22/R-23/R-24/R-25 evidence using the Design adoption map: P-001 maps, P-003 performs the complete evidence coverage census, P-009 independently drives the native Linux x86_64-to-Linux x86_64 clean-destination GUI journey and full dev-box reference proof, and P-010 verifies exact signed artifacts. Read exact registered test/fault results and source/subject/artifact bindings; unbuilt, absent or stale proof is unknown. Retain clean-offline unlock, producer cut and epoch-fenced handover contracts from primary R-20/R-21/R-22. M1 supports only the explicit Linux x86_64 native route; UI/docs label others unsupported until primary M2 proof.",
      "driftMarkers": "Released bytes differ from accepted bytes or any declared content/fault/route case lacks deciding proof.",
      "intent": {
        "request": "Adopt the approved canonical portable-instance implementation and independently verify this customer transfer obligation without duplicating it.",
        "sourceRefs": [
          "session_turn:claude:84d419a0-76cc-4123-b484-f05c017166f6:0",
          "session_turn:codex:01a1bcef-63b8-7292-b72b-4bae418798c9:11"
        ]
      },
      "check": {
        "kind": "instrument",
        "instrumentKey": "none"
      }
    }
  ],
  "dryRun": true,
  "requestReview": {
    "workItemId": "WI-10007647",
    "harness": "papercusp"
  },
  "expectedRubricRevision": 1,
  "expectedSubjectPlanRevision": 18,
  "idempotencyKey": "transfer-adoption-consult1220796-preview-v1",
  "reason": "Apply approved canonical evidence adoption and independent consult thread-post:1220796. Preserve every original eight-bar promise as mandatory Verification; repair blank methods, require isolated live/fault evidence for restore/decryption/compatibility/recovery, and truthful exact-artifact native Linux x86_64 M1 shipment. No duplicate implementation or release path."
}
