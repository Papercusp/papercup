---
rel_path: "evidence/context-injection/r1-compact-faults-r97.json"
updated_at: 1794225690221
_body: "content"
---

{
  "schemaVersion": "context-reliability-bounded-evidence-v1",
  "workItem": "WI-6554700010046059",
  "scope": "R97 Codex+Claude compact fault joins and validator mapping; all12 mission retained",
  "baseline": {
    "run": "/tmp/ctx-r95-pg-full.json",
    "sources": "/tmp/ctx-r95-pg-full-sources.json",
    "passed": 279,
    "failed": 0,
    "skipped": 0,
    "workerSourceCount": 2172,
    "workerHashMismatches": [],
    "nativeTerminal": {
      "terminalHook": "onTestRunEnd",
      "reason": "passed",
      "unhandledErrorCount": 0,
      "modulePopulationMatched": true,
      "gaps": []
    },
    "commandExit": "/home/marsh-office/.papercusp/test-artifacts/testing-run/native-router-DEMyEc/group-0.command-exit.json",
    "custodySha256": "e28d61aab156e653c4842c13754eaae8c201826d893961d604ac2706a594ffba",
    "custodyBytes": 12361028,
    "evidenceLimit": "structural fixture with explicit receipt replay, native host consumption and independent acceptance and shipment unmeasured"
  },
  "compact": {
    "tests": [
      {
        "title": "cross-port session-epoch dedup (real PG — P-004a) context reliability R-1: production compact memory complete endpoint hook PostgreSQL join",
        "client": "claude",
        "source": "memory",
        "output": "complete"
      },
      {
        "title": "cross-port session-epoch dedup (real PG — P-004a) context reliability R-1: production compact memory closed endpoint hook PostgreSQL join",
        "client": "claude",
        "source": "memory",
        "output": "closed"
      },
      {
        "title": "cross-port session-epoch dedup (real PG — P-004a) context reliability R-1: production compact memory partial endpoint hook PostgreSQL join",
        "client": "claude",
        "source": "memory",
        "output": "partial"
      },
      {
        "title": "cross-port session-epoch dedup (real PG — P-004a) context reliability R-1: production compact memory lost-response endpoint hook PostgreSQL join",
        "client": "claude",
        "source": "memory",
        "output": "lost-response"
      },
      {
        "title": "cross-port session-epoch dedup (real PG — P-004a) context reliability R-1: production compact memory deadline endpoint hook PostgreSQL join",
        "client": "claude",
        "source": "memory",
        "output": "deadline"
      },
      {
        "title": "cross-port session-epoch dedup (real PG — P-004a) context reliability R-1: production compact memory retry endpoint hook PostgreSQL join",
        "client": "claude",
        "source": "memory",
        "output": "retry"
      },
      {
        "title": "cross-port session-epoch dedup (real PG — P-004a) context reliability R-1: production compact memory abandon-expiry endpoint hook PostgreSQL join",
        "client": "claude",
        "source": "memory",
        "output": "abandon-expiry"
      },
      {
        "title": "cross-port session-epoch dedup (real PG — P-004a) context reliability R-1: production compact memory overlapping-ports endpoint hook PostgreSQL join",
        "client": "claude",
        "source": "memory",
        "output": "overlapping-ports"
      },
      {
        "title": "cross-port session-epoch dedup (real PG — P-004a) context reliability R-1: production compact corpus complete endpoint hook PostgreSQL join",
        "client": "claude",
        "source": "corpus",
        "output": "complete"
      },
      {
        "title": "cross-port session-epoch dedup (real PG — P-004a) context reliability R-1: production compact corpus closed endpoint hook PostgreSQL join",
        "client": "claude",
        "source": "corpus",
        "output": "closed"
      },
      {
        "title": "cross-port session-epoch dedup (real PG — P-004a) context reliability R-1: production compact corpus partial endpoint hook PostgreSQL join",
        "client": "claude",
        "source": "corpus",
        "output": "partial"
      },
      {
        "title": "cross-port session-epoch dedup (real PG — P-004a) context reliability R-1: production compact corpus lost-response endpoint hook PostgreSQL join",
        "client": "claude",
        "source": "corpus",
        "output": "lost-response"
      },
      {
        "title": "cross-port session-epoch dedup (real PG — P-004a) context reliability R-1: production compact corpus deadline endpoint hook PostgreSQL join",
        "client": "claude",
        "source": "corpus",
        "output": "deadline"
      },
      {
        "title": "cross-port session-epoch dedup (real PG — P-004a) context reliability R-1: production compact corpus retry endpoint hook PostgreSQL join",
        "client": "claude",
        "source": "corpus",
        "output": "retry"
      },
      {
        "title": "cross-port session-epoch dedup (real PG — P-004a) context reliability R-1: production compact corpus abandon-expiry endpoint hook PostgreSQL join",
        "client": "claude",
        "source": "corpus",
        "output": "abandon-expiry"
      },
      {
        "title": "cross-port session-epoch dedup (real PG — P-004a) context reliability R-1: production compact corpus overlapping-ports endpoint hook PostgreSQL join",
        "client": "claude",
        "source": "corpus",
        "output": "overlapping-ports"
      },
      {
        "title": "cross-port session-epoch dedup (real PG — P-004a) context reliability R-1: production Codex compact memory complete endpoint hook PostgreSQL join",
        "client": "codex",
        "source": "memory",
        "output": "complete"
      },
      {
        "title": "cross-port session-epoch dedup (real PG — P-004a) context reliability R-1: production Codex compact memory closed endpoint hook PostgreSQL join",
        "client": "codex",
        "source": "memory",
        "output": "closed"
      },
      {
        "title": "cross-port session-epoch dedup (real PG — P-004a) context reliability R-1: production Codex compact memory partial endpoint hook PostgreSQL join",
        "client": "codex",
        "source": "memory",
        "output": "partial"
      },
      {
        "title": "cross-port session-epoch dedup (real PG — P-004a) context reliability R-1: production Codex compact memory lost-response endpoint hook PostgreSQL join",
        "client": "codex",
        "source": "memory",
        "output": "lost-response"
      },
      {
        "title": "cross-port session-epoch dedup (real PG — P-004a) context reliability R-1: production Codex compact memory deadline endpoint hook PostgreSQL join",
        "client": "codex",
        "source": "memory",
        "output": "deadline"
      },
      {
        "title": "cross-port session-epoch dedup (real PG — P-004a) context reliability R-1: production Codex compact memory retry endpoint hook PostgreSQL join",
        "client": "codex",
        "source": "memory",
        "output": "retry"
      },
      {
        "title": "cross-port session-epoch dedup (real PG — P-004a) context reliability R-1: production Codex compact memory abandon-expiry endpoint hook PostgreSQL join",
        "client": "codex",
        "source": "memory",
        "output": "abandon-expiry"
      },
      {
        "title": "cross-port session-epoch dedup (real PG — P-004a) context reliability R-1: production Codex compact memory overlapping-ports endpoint hook PostgreSQL join",
        "client": "codex",
        "source": "memory",
        "output": "overlapping-ports"
      },
      {
        "title": "cross-port session-epoch dedup (real PG — P-004a) context reliability R-1: production Codex compact corpus complete endpoint hook PostgreSQL join",
        "client": "codex",
        "source": "corpus",
        "output": "complete"
      },
      {
        "title": "cross-port session-epoch dedup (real PG — P-004a) context reliability R-1: production Codex compact corpus closed endpoint hook PostgreSQL join",
        "client": "codex",
        "source": "corpus",
        "output": "closed"
      },
      {
        "title": "cross-port session-epoch dedup (real PG — P-004a) context reliability R-1: production Codex compact corpus partial endpoint hook PostgreSQL join",
        "client": "codex",
        "source": "corpus",
        "output": "partial"
      },
      {
        "title": "cross-port session-epoch dedup (real PG — P-004a) context reliability R-1: production Codex compact corpus lost-response endpoint hook PostgreSQL join",
        "client": "codex",
        "source": "corpus",
        "output": "lost-response"
      },
      {
        "title": "cross-port session-epoch dedup (real PG — P-004a) context reliability R-1: production Codex compact corpus deadline endpoint hook PostgreSQL join",
        "client": "codex",
        "source": "corpus",
        "output": "deadline"
      },
      {
        "title": "cross-port session-epoch dedup (real PG — P-004a) context reliability R-1: production Codex compact corpus retry endpoint hook PostgreSQL join",
        "client": "codex",
        "source": "corpus",
        "output": "retry"
      },
      {
        "title": "cross-port session-epoch dedup (real PG — P-004a) context reliability R-1: production Codex compact corpus abandon-expiry endpoint hook PostgreSQL join",
        "client": "codex",
        "source": "corpus",
        "output": "abandon-expiry"
      },
      {
        "title": "cross-port session-epoch dedup (real PG — P-004a) context reliability R-1: production Codex compact corpus overlapping-ports endpoint hook PostgreSQL join",
        "client": "codex",
        "source": "corpus",
        "output": "overlapping-ports"
      }
    ],
    "cells": [
      {
        "client": "claude",
        "sink": "compact-reprime",
        "source": "memory",
        "fault": "prepare",
        "selector": "context reliability R-1: production compact memory complete endpoint hook PostgreSQL join",
        "evidenceRefs": [
          "vitest:context reliability R-1: production compact memory complete endpoint hook PostgreSQL join#compactPreparation"
        ],
        "terminalOracle": "complete-stdout",
        "state": "prepared",
        "verdict": "passed",
        "suppressionWrites": 0,
        "attempt": {
          "id": "su-compact-7053398f-04e5-45dd-8504-4794c073d013",
          "recipient": "su-compact-7053398f-04e5-45dd-8504-4794c073d013",
          "workspace": "isolated-org-fixture",
          "epoch": 1,
          "token": "43f38420-ef87-4a85-b4d6-89990bc75b61",
          "fragment": {
            "kind": "memory",
            "id": "d2b56b92-96da-4b88-b7f6-b081da5b72d3",
            "epoch": 1,
            "port": "compact",
            "bodySha256": "088dd672aa89f70b1f8740759f73d15b8689295328aefce8d25c028285ad0c57",
            "bodyBytes": 141
          }
        }
      },
      {
        "client": "claude",
        "sink": "compact-reprime",
        "source": "memory",
        "fault": "duplicate-commit",
        "selector": "context reliability R-1: production compact memory complete endpoint hook PostgreSQL join",
        "evidenceRefs": [
          "vitest:context reliability R-1: production compact memory complete endpoint hook PostgreSQL join#compactEndpointJoin"
        ],
        "terminalOracle": "complete-stdout",
        "state": "emitted",
        "verdict": "passed",
        "suppressionWrites": 1,
        "attempt": {
          "id": "su-compact-7053398f-04e5-45dd-8504-4794c073d013",
          "recipient": "su-compact-7053398f-04e5-45dd-8504-4794c073d013",
          "workspace": "isolated-org-fixture",
          "epoch": 1,
          "token": "43f38420-ef87-4a85-b4d6-89990bc75b61",
          "fragment": {
            "kind": "memory",
            "id": "d2b56b92-96da-4b88-b7f6-b081da5b72d3",
            "epoch": 1,
            "port": "compact",
            "bodySha256": "088dd672aa89f70b1f8740759f73d15b8689295328aefce8d25c028285ad0c57",
            "bodyBytes": 141
          }
        },
        "proof": {
          "event": "complete-stdout",
          "adapter": "claude-session-start",
          "receiptRef": "vitest:context reliability R-1: production compact memory complete endpoint hook PostgreSQL join#compactImmutableReceipt",
          "attemptId": "su-compact-7053398f-04e5-45dd-8504-4794c073d013",
          "recipient": "su-compact-7053398f-04e5-45dd-8504-4794c073d013",
          "workspace": "isolated-org-fixture",
          "epoch": 1,
          "token": "43f38420-ef87-4a85-b4d6-89990bc75b61",
          "client": "claude",
          "sink": "compact-reprime",
          "payloadSha256": "48fa1b2bfd1d277fab3a54582db5be8e669468b3fa05d9a705644dd400ca43f2",
          "payloadBytes": 2591,
          "fragment": {
            "kind": "memory",
            "id": "d2b56b92-96da-4b88-b7f6-b081da5b72d3",
            "epoch": 1,
            "port": "compact",
            "bodySha256": "088dd672aa89f70b1f8740759f73d15b8689295328aefce8d25c028285ad0c57",
            "bodyBytes": 141
          }
        }
      },
      {
        "client": "claude",
        "sink": "compact-reprime",
        "source": "memory",
        "fault": "partial-stdout",
        "selector": "context reliability R-1: production compact memory partial endpoint hook PostgreSQL join",
        "evidenceRefs": [
          "vitest:context reliability R-1: production compact memory partial endpoint hook PostgreSQL join#compactEndpointJoin"
        ],
        "terminalOracle": "complete-stdout",
        "state": "partial",
        "verdict": "passed",
        "suppressionWrites": 0,
        "attempt": {
          "id": "su-compact-2d013522-c950-4cbe-b10a-8f73fd58047f",
          "recipient": "su-compact-2d013522-c950-4cbe-b10a-8f73fd58047f",
          "workspace": "isolated-org-fixture",
          "epoch": 1,
          "token": "c5fffb23-5ae4-4dc1-8edc-0b9835bd8233",
          "fragment": {
            "kind": "memory",
            "id": "ef9802e9-c419-48ba-9d4f-31b3e2bdf5ff",
            "epoch": 1,
            "port": "compact",
            "bodySha256": "6aa5d4b426d71f2ed1770071a037e4e03b538679e7c17b17b55d8f89f9a0853f",
            "bodyBytes": 141
          }
        }
      },
      {
        "client": "claude",
        "sink": "compact-reprime",
        "source": "memory",
        "fault": "lost-response",
        "selector": "context reliability R-1: production compact memory lost-response endpoint hook PostgreSQL join",
        "evidenceRefs": [
          "vitest:context reliability R-1: production compact memory lost-response endpoint hook PostgreSQL join#compactEndpointJoin"
        ],
        "terminalOracle": "complete-stdout",
        "state": "prepared",
        "verdict": "passed",
        "suppressionWrites": 0,
        "attempt": {
          "id": "su-compact-7bd8f9f4-046b-451e-862e-d35d9a0d0c25",
          "recipient": "su-compact-7bd8f9f4-046b-451e-862e-d35d9a0d0c25",
          "workspace": "isolated-org-fixture",
          "epoch": 1,
          "token": "2e18fa2b-3420-4f94-a82e-2a69f9ee04b9",
          "fragment": {
            "kind": "memory",
            "id": "34af9321-c393-4088-b4dd-b6912ba89943",
            "epoch": 1,
            "port": "compact",
            "bodySha256": "a251fd935c0ec735e9e661f6cec7dd8dd4096e05b058e9b036dbd0e8dcdb6ba2",
            "bodyBytes": 141
          }
        }
      },
      {
        "client": "claude",
        "sink": "compact-reprime",
        "source": "memory",
        "fault": "deadline",
        "selector": "context reliability R-1: production compact memory deadline endpoint hook PostgreSQL join",
        "evidenceRefs": [
          "vitest:context reliability R-1: production compact memory deadline endpoint hook PostgreSQL join#compactEndpointJoin"
        ],
        "terminalOracle": "complete-stdout",
        "state": "prepared",
        "verdict": "passed",
        "suppressionWrites": 0,
        "attempt": {
          "id": "su-compact-993aa63d-8009-4225-b8a1-ced77ce2011e",
          "recipient": "su-compact-993aa63d-8009-4225-b8a1-ced77ce2011e",
          "workspace": "isolated-org-fixture",
          "epoch": 1,
          "token": "3ef1a2d2-c5e6-43b0-929e-45c3c5f26a1b",
          "fragment": {
            "kind": "memory",
            "id": "06b5d3c7-db49-4f95-82a7-d18c478d5d8f",
            "epoch": 1,
            "port": "compact",
            "bodySha256": "000cd8eeb86655f103dc4adf25821bc8ebd44a44c9d4528222dc5022034164ff",
            "bodyBytes": 141
          }
        }
      },
      {
        "client": "claude",
        "sink": "compact-reprime",
        "source": "memory",
        "fault": "retry",
        "selector": "context reliability R-1: production compact memory retry endpoint hook PostgreSQL join",
        "evidenceRefs": [
          "vitest:context reliability R-1: production compact memory retry endpoint hook PostgreSQL join#compactEndpointJoin"
        ],
        "terminalOracle": "complete-stdout",
        "state": "emitted",
        "verdict": "passed",
        "suppressionWrites": 1,
        "attempt": {
          "id": "su-compact-58634895-f63b-4ad0-81dd-64df81910979",
          "recipient": "su-compact-58634895-f63b-4ad0-81dd-64df81910979",
          "workspace": "isolated-org-fixture",
          "epoch": 2,
          "token": "dbca9b12-5e29-4e11-9e74-0c0cf6784977",
          "fragment": {
            "kind": "memory",
            "id": "eb4335c8-9d66-4e87-a4ad-afe00f449f36",
            "epoch": 2,
            "port": "compact",
            "bodySha256": "34130ff49c019ce949027cfec500df89ddaeea9d55cd595f7ab7db9a8e67ac0a",
            "bodyBytes": 141
          }
        },
        "proof": {
          "event": "complete-stdout",
          "adapter": "claude-session-start",
          "receiptRef": "vitest:context reliability R-1: production compact memory retry endpoint hook PostgreSQL join#compactImmutableReceipt",
          "attemptId": "su-compact-58634895-f63b-4ad0-81dd-64df81910979",
          "recipient": "su-compact-58634895-f63b-4ad0-81dd-64df81910979",
          "workspace": "isolated-org-fixture",
          "epoch": 2,
          "token": "dbca9b12-5e29-4e11-9e74-0c0cf6784977",
          "client": "claude",
          "sink": "compact-reprime",
          "payloadSha256": "b9fb577e8edc7a492b1c630bd8e17db63c3e8cbd2414cd9ba69a6bede2b4399e",
          "payloadBytes": 2591,
          "fragment": {
            "kind": "memory",
            "id": "eb4335c8-9d66-4e87-a4ad-afe00f449f36",
            "epoch": 2,
            "port": "compact",
            "bodySha256": "34130ff49c019ce949027cfec500df89ddaeea9d55cd595f7ab7db9a8e67ac0a",
            "bodyBytes": 141
          }
        }
      },
      {
        "client": "claude",
        "sink": "compact-reprime",
        "source": "memory",
        "fault": "abandon-expiry",
        "selector": "context reliability R-1: production compact memory abandon-expiry endpoint hook PostgreSQL join",
        "evidenceRefs": [
          "vitest:context reliability R-1: production compact memory abandon-expiry endpoint hook PostgreSQL join#compactEndpointJoin"
        ],
        "terminalOracle": "complete-stdout",
        "state": "abandoned",
        "verdict": "passed",
        "suppressionWrites": 0,
        "attempt": {
          "id": "su-compact-0e62d28c-7639-45a6-8263-3060b8a99bf3",
          "recipient": "su-compact-0e62d28c-7639-45a6-8263-3060b8a99bf3",
          "workspace": "isolated-org-fixture",
          "epoch": 1,
          "token": "be58ec3b-4dcd-4bc3-b54b-81807e9cfa3b",
          "fragment": {
            "kind": "memory",
            "id": "1aea8429-9dbe-4124-9cce-1e057ee0ad66",
            "epoch": 1,
            "port": "compact",
            "bodySha256": "8dbf73300f4f376c910d7a7d8ba2a5cfc96cb2d3fd84fe4df3c51c7fe18f6ec6",
            "bodyBytes": 141
          }
        }
      },
      {
        "client": "claude",
        "sink": "compact-reprime",
        "source": "memory",
        "fault": "overlapping-ports",
        "selector": "context reliability R-1: production compact memory overlapping-ports endpoint hook PostgreSQL join",
        "evidenceRefs": [
          "vitest:context reliability R-1: production compact memory overlapping-ports endpoint hook PostgreSQL join#compactEndpointJoin"
        ],
        "terminalOracle": "complete-stdout",
        "state": "emitted",
        "verdict": "passed",
        "suppressionWrites": 1,
        "attempt": {
          "id": "su-compact-2bc79058-e996-483f-8daa-62e83e5513fd",
          "recipient": "su-compact-2bc79058-e996-483f-8daa-62e83e5513fd",
          "workspace": "isolated-org-fixture",
          "epoch": 1,
          "token": "fe5025fd-76ab-4a0a-9d0e-9efb0d530ca8",
          "fragment": {
            "kind": "memory",
            "id": "326d9c87-b7a3-45dc-bb19-69d4bf625f3f",
            "epoch": 1,
            "port": "compact",
            "bodySha256": "94ff99c00bc6597fda0daffd70d1a7edf98014d04448aaaa9a240403f30197d9",
            "bodyBytes": 141
          }
        },
        "proof": {
          "event": "complete-stdout",
          "adapter": "claude-session-start",
          "receiptRef": "vitest:context reliability R-1: production compact memory overlapping-ports endpoint hook PostgreSQL join#compactImmutableReceipt",
          "attemptId": "su-compact-2bc79058-e996-483f-8daa-62e83e5513fd",
          "recipient": "su-compact-2bc79058-e996-483f-8daa-62e83e5513fd",
          "workspace": "isolated-org-fixture",
          "epoch": 1,
          "token": "fe5025fd-76ab-4a0a-9d0e-9efb0d530ca8",
          "client": "claude",
          "sink": "compact-reprime",
          "payloadSha256": "f56caa23e0ef5284595dd538806eb0f72371f0c846cec8bd9f77bb0c7c5ffbf6",
          "payloadBytes": 2591,
          "fragment": {
            "kind": "memory",
            "id": "326d9c87-b7a3-45dc-bb19-69d4bf625f3f",
            "epoch": 1,
            "port": "compact",
            "bodySha256": "94ff99c00bc6597fda0daffd70d1a7edf98014d04448aaaa9a240403f30197d9",
            "bodyBytes": 141
          }
        }
      },
      {
        "client": "claude",
        "sink": "compact-reprime",
        "source": "corpus",
        "fault": "prepare",
        "selector": "context reliability R-1: production compact corpus complete endpoint hook PostgreSQL join",
        "evidenceRefs": [
          "vitest:context reliability R-1: production compact corpus complete endpoint hook PostgreSQL join#compactPreparation"
        ],
        "terminalOracle": "complete-stdout",
        "state": "prepared",
        "verdict": "passed",
        "suppressionWrites": 0,
        "attempt": {
          "id": "su-compact-b2fedd92-678e-4478-ac7e-accd6d10ae55",
          "recipient": "su-compact-b2fedd92-678e-4478-ac7e-accd6d10ae55",
          "workspace": "isolated-org-fixture",
          "epoch": 1,
          "token": "7c5f04aa-9b13-4c93-a1eb-eb7663b6eea6",
          "fragment": {
            "kind": "corpus",
            "id": "plan:compact:su-compact-b2fedd92-678e-4478-ac7e-accd6d10ae55",
            "epoch": 1,
            "port": "compact",
            "bodySha256": "e6202a06a6e6ac4302163be3dbb6072ac1f214d2d3d6b1e49829690fe02e2109",
            "bodyBytes": 250
          }
        }
      },
      {
        "client": "claude",
        "sink": "compact-reprime",
        "source": "corpus",
        "fault": "duplicate-commit",
        "selector": "context reliability R-1: production compact corpus complete endpoint hook PostgreSQL join",
        "evidenceRefs": [
          "vitest:context reliability R-1: production compact corpus complete endpoint hook PostgreSQL join#compactEndpointJoin"
        ],
        "terminalOracle": "complete-stdout",
        "state": "emitted",
        "verdict": "passed",
        "suppressionWrites": 1,
        "attempt": {
          "id": "su-compact-b2fedd92-678e-4478-ac7e-accd6d10ae55",
          "recipient": "su-compact-b2fedd92-678e-4478-ac7e-accd6d10ae55",
          "workspace": "isolated-org-fixture",
          "epoch": 1,
          "token": "7c5f04aa-9b13-4c93-a1eb-eb7663b6eea6",
          "fragment": {
            "kind": "corpus",
            "id": "plan:compact:su-compact-b2fedd92-678e-4478-ac7e-accd6d10ae55",
            "epoch": 1,
            "port": "compact",
            "bodySha256": "e6202a06a6e6ac4302163be3dbb6072ac1f214d2d3d6b1e49829690fe02e2109",
            "bodyBytes": 250
          }
        },
        "proof": {
          "event": "complete-stdout",
          "adapter": "claude-session-start",
          "receiptRef": "vitest:context reliability R-1: production compact corpus complete endpoint hook PostgreSQL join#compactImmutableReceipt",
          "attemptId": "su-compact-b2fedd92-678e-4478-ac7e-accd6d10ae55",
          "recipient": "su-compact-b2fedd92-678e-4478-ac7e-accd6d10ae55",
          "workspace": "isolated-org-fixture",
          "epoch": 1,
          "token": "7c5f04aa-9b13-4c93-a1eb-eb7663b6eea6",
          "client": "claude",
          "sink": "compact-reprime",
          "payloadSha256": "63d17925f4519082fb60d3a735825663372004fe1672c27065b7b15bb48779e3",
          "payloadBytes": 3329,
          "fragment": {
            "kind": "corpus",
            "id": "plan:compact:su-compact-b2fedd92-678e-4478-ac7e-accd6d10ae55",
            "epoch": 1,
            "port": "compact",
            "bodySha256": "e6202a06a6e6ac4302163be3dbb6072ac1f214d2d3d6b1e49829690fe02e2109",
            "bodyBytes": 250
          }
        }
      },
      {
        "client": "claude",
        "sink": "compact-reprime",
        "source": "corpus",
        "fault": "partial-stdout",
        "selector": "context reliability R-1: production compact corpus partial endpoint hook PostgreSQL join",
        "evidenceRefs": [
          "vitest:context reliability R-1: production compact corpus partial endpoint hook PostgreSQL join#compactEndpointJoin"
        ],
        "terminalOracle": "complete-stdout",
        "state": "partial",
        "verdict": "passed",
        "suppressionWrites": 0,
        "attempt": {
          "id": "su-compact-dbf07419-9783-4933-994a-2cc08067a849",
          "recipient": "su-compact-dbf07419-9783-4933-994a-2cc08067a849",
          "workspace": "isolated-org-fixture",
          "epoch": 1,
          "token": "fa4a437a-0d9f-40e9-acee-d08e5ecf9241",
          "fragment": {
            "kind": "corpus",
            "id": "plan:compact:su-compact-dbf07419-9783-4933-994a-2cc08067a849",
            "epoch": 1,
            "port": "compact",
            "bodySha256": "e5d0d98e7e40980aa3b9c96d7ccd21dcec814a7fe65221dcff9ebf1629411afc",
            "bodyBytes": 250
          }
        }
      },
      {
        "client": "claude",
        "sink": "compact-reprime",
        "source": "corpus",
        "fault": "lost-response",
        "selector": "context reliability R-1: production compact corpus lost-response endpoint hook PostgreSQL join",
        "evidenceRefs": [
          "vitest:context reliability R-1: production compact corpus lost-response endpoint hook PostgreSQL join#compactEndpointJoin"
        ],
        "terminalOracle": "complete-stdout",
        "state": "prepared",
        "verdict": "passed",
        "suppressionWrites": 0,
        "attempt": {
          "id": "su-compact-f650e4e6-1e46-41e7-b862-2d1317d7999c",
          "recipient": "su-compact-f650e4e6-1e46-41e7-b862-2d1317d7999c",
          "workspace": "isolated-org-fixture",
          "epoch": 1,
          "token": "82932ab0-981d-4491-bd1a-7b86f5c6ba50",
          "fragment": {
            "kind": "corpus",
            "id": "plan:compact:su-compact-f650e4e6-1e46-41e7-b862-2d1317d7999c",
            "epoch": 1,
            "port": "compact",
            "bodySha256": "b146ba6d9d11454bc3e407ec2af0e4b323611df62ea84359cbf4661a203262cc",
            "bodyBytes": 250
          }
        }
      },
      {
        "client": "claude",
        "sink": "compact-reprime",
        "source": "corpus",
        "fault": "deadline",
        "selector": "context reliability R-1: production compact corpus deadline endpoint hook PostgreSQL join",
        "evidenceRefs": [
          "vitest:context reliability R-1: production compact corpus deadline endpoint hook PostgreSQL join#compactEndpointJoin"
        ],
        "terminalOracle": "complete-stdout",
        "state": "prepared",
        "verdict": "passed",
        "suppressionWrites": 0,
        "attempt": {
          "id": "su-compact-5c3b860a-5588-4b2c-8fcb-2ce999e9c0f3",
          "recipient": "su-compact-5c3b860a-5588-4b2c-8fcb-2ce999e9c0f3",
          "workspace": "isolated-org-fixture",
          "epoch": 1,
          "token": "968ce987-c399-49ff-9b0a-e40dfded5c3b",
          "fragment": {
            "kind": "corpus",
            "id": "plan:compact:su-compact-5c3b860a-5588-4b2c-8fcb-2ce999e9c0f3",
            "epoch": 1,
            "port": "compact",
            "bodySha256": "cc2363a674a2a4a63c3fb84023b03ccae61d6040d335b86278eaf8f2478498b6",
            "bodyBytes": 250
          }
        }
      },
      {
        "client": "claude",
        "sink": "compact-reprime",
        "source": "corpus",
        "fault": "retry",
        "selector": "context reliability R-1: production compact corpus retry endpoint hook PostgreSQL join",
        "evidenceRefs": [
          "vitest:context reliability R-1: production compact corpus retry endpoint hook PostgreSQL join#compactEndpointJoin"
        ],
        "terminalOracle": "complete-stdout",
        "state": "emitted",
        "verdict": "passed",
        "suppressionWrites": 1,
        "attempt": {
          "id": "su-compact-da619142-ddc4-4cd5-9a3b-db896809409c",
          "recipient": "su-compact-da619142-ddc4-4cd5-9a3b-db896809409c",
          "workspace": "isolated-org-fixture",
          "epoch": 2,
          "token": "40280833-b4ff-431b-b4b5-c1f251c8c612",
          "fragment": {
            "kind": "corpus",
            "id": "plan:compact:su-compact-da619142-ddc4-4cd5-9a3b-db896809409c",
            "epoch": 2,
            "port": "compact",
            "bodySha256": "176752d40171be795265a78c3ccf482c0c8b3ec13d34a68a7d166f19a89aa9d7",
            "bodyBytes": 250
          }
        },
        "proof": {
          "event": "complete-stdout",
          "adapter": "claude-session-start",
          "receiptRef": "vitest:context reliability R-1: production compact corpus retry endpoint hook PostgreSQL join#compactImmutableReceipt",
          "attemptId": "su-compact-da619142-ddc4-4cd5-9a3b-db896809409c",
          "recipient": "su-compact-da619142-ddc4-4cd5-9a3b-db896809409c",
          "workspace": "isolated-org-fixture",
          "epoch": 2,
          "token": "40280833-b4ff-431b-b4b5-c1f251c8c612",
          "client": "claude",
          "sink": "compact-reprime",
          "payloadSha256": "212ac0b82fa3fb5ff0a63a5b12b3ee60e9233f6bb6719cb4277c66444bc2241f",
          "payloadBytes": 3329,
          "fragment": {
            "kind": "corpus",
            "id": "plan:compact:su-compact-da619142-ddc4-4cd5-9a3b-db896809409c",
            "epoch": 2,
            "port": "compact",
            "bodySha256": "176752d40171be795265a78c3ccf482c0c8b3ec13d34a68a7d166f19a89aa9d7",
            "bodyBytes": 250
          }
        }
      },
      {
        "client": "claude",
        "sink": "compact-reprime",
        "source": "corpus",
        "fault": "abandon-expiry",
        "selector": "context reliability R-1: production compact corpus abandon-expiry endpoint hook PostgreSQL join",
        "evidenceRefs": [
          "vitest:context reliability R-1: production compact corpus abandon-expiry endpoint hook PostgreSQL join#compactEndpointJoin"
        ],
        "terminalOracle": "complete-stdout",
        "state": "abandoned",
        "verdict": "passed",
        "suppressionWrites": 0,
        "attempt": {
          "id": "su-compact-571f1749-5ae5-4c2d-917e-64c63f7c6ac9",
          "recipient": "su-compact-571f1749-5ae5-4c2d-917e-64c63f7c6ac9",
          "workspace": "isolated-org-fixture",
          "epoch": 1,
          "token": "4a78cf0e-a038-4744-b2ab-86a8c676b450",
          "fragment": {
            "kind": "corpus",
            "id": "plan:compact:su-compact-571f1749-5ae5-4c2d-917e-64c63f7c6ac9",
            "epoch": 1,
            "port": "compact",
            "bodySha256": "99860b85373c4f4bd4bcae6ff36839743cae340256486fecfe9976cdf76dfc51",
            "bodyBytes": 250
          }
        }
      },
      {
        "client": "claude",
        "sink": "compact-reprime",
        "source": "corpus",
        "fault": "overlapping-ports",
        "selector": "context reliability R-1: production compact corpus overlapping-ports endpoint hook PostgreSQL join",
        "evidenceRefs": [
          "vitest:context reliability R-1: production compact corpus overlapping-ports endpoint hook PostgreSQL join#compactEndpointJoin"
        ],
        "terminalOracle": "complete-stdout",
        "state": "emitted",
        "verdict": "passed",
        "suppressionWrites": 1,
        "attempt": {
          "id": "su-compact-4123ccc7-a68b-4953-8b25-e1bbffa0c440",
          "recipient": "su-compact-4123ccc7-a68b-4953-8b25-e1bbffa0c440",
          "workspace": "isolated-org-fixture",
          "epoch": 1,
          "token": "7d943dfc-3ac8-4702-8018-b00e4c87aac8",
          "fragment": {
            "kind": "corpus",
            "id": "plan:compact:su-compact-4123ccc7-a68b-4953-8b25-e1bbffa0c440",
            "epoch": 1,
            "port": "compact",
            "bodySha256": "2b465230e250f93cf43299e0958f35e6f999b47211061ce919bc1c4f56b15421",
            "bodyBytes": 250
          }
        },
        "proof": {
          "event": "complete-stdout",
          "adapter": "claude-session-start",
          "receiptRef": "vitest:context reliability R-1: production compact corpus overlapping-ports endpoint hook PostgreSQL join#compactImmutableReceipt",
          "attemptId": "su-compact-4123ccc7-a68b-4953-8b25-e1bbffa0c440",
          "recipient": "su-compact-4123ccc7-a68b-4953-8b25-e1bbffa0c440",
          "workspace": "isolated-org-fixture",
          "epoch": 1,
          "token": "7d943dfc-3ac8-4702-8018-b00e4c87aac8",
          "client": "claude",
          "sink": "compact-reprime",
          "payloadSha256": "39fc2875032073fabfb9abbbcf25be8d767cf6d69c71e89e3b18b2b370ee5a04",
          "payloadBytes": 3329,
          "fragment": {
            "kind": "corpus",
            "id": "plan:compact:su-compact-4123ccc7-a68b-4953-8b25-e1bbffa0c440",
            "epoch": 1,
            "port": "compact",
            "bodySha256": "2b465230e250f93cf43299e0958f35e6f999b47211061ce919bc1c4f56b15421",
            "bodyBytes": 250
          }
        }
      },
      {
        "client": "codex",
        "sink": "compact-reprime",
        "source": "memory",
        "fault": "prepare",
        "selector": "context reliability R-1: production Codex compact memory complete endpoint hook PostgreSQL join",
        "evidenceRefs": [
          "vitest:context reliability R-1: production Codex compact memory complete endpoint hook PostgreSQL join#compactPreparation"
        ],
        "terminalOracle": "complete-stdout",
        "state": "prepared",
        "verdict": "passed",
        "suppressionWrites": 0,
        "attempt": {
          "id": "su-compact-987083b4-b766-4489-9746-6df9cc836cf0",
          "recipient": "su-compact-987083b4-b766-4489-9746-6df9cc836cf0",
          "workspace": "isolated-org-fixture",
          "epoch": 1,
          "token": "5f1fe468-02d4-49b7-a1df-d5c20c538a58",
          "fragment": {
            "kind": "memory",
            "id": "c214a744-0e91-487e-bef8-33419bc400d8",
            "epoch": 1,
            "port": "compact",
            "bodySha256": "8c213f1eac5101c2438a4e6a5e19de1a5c6c25d98a0ef001b83485b594235c8d",
            "bodyBytes": 141
          }
        }
      },
      {
        "client": "codex",
        "sink": "compact-reprime",
        "source": "memory",
        "fault": "duplicate-commit",
        "selector": "context reliability R-1: production Codex compact memory complete endpoint hook PostgreSQL join",
        "evidenceRefs": [
          "vitest:context reliability R-1: production Codex compact memory complete endpoint hook PostgreSQL join#compactEndpointJoin"
        ],
        "terminalOracle": "complete-stdout",
        "state": "emitted",
        "verdict": "passed",
        "suppressionWrites": 1,
        "attempt": {
          "id": "su-compact-987083b4-b766-4489-9746-6df9cc836cf0",
          "recipient": "su-compact-987083b4-b766-4489-9746-6df9cc836cf0",
          "workspace": "isolated-org-fixture",
          "epoch": 1,
          "token": "5f1fe468-02d4-49b7-a1df-d5c20c538a58",
          "fragment": {
            "kind": "memory",
            "id": "c214a744-0e91-487e-bef8-33419bc400d8",
            "epoch": 1,
            "port": "compact",
            "bodySha256": "8c213f1eac5101c2438a4e6a5e19de1a5c6c25d98a0ef001b83485b594235c8d",
            "bodyBytes": 141
          }
        },
        "proof": {
          "event": "complete-stdout",
          "adapter": "codex-session-start",
          "receiptRef": "vitest:context reliability R-1: production Codex compact memory complete endpoint hook PostgreSQL join#compactImmutableReceipt",
          "attemptId": "su-compact-987083b4-b766-4489-9746-6df9cc836cf0",
          "recipient": "su-compact-987083b4-b766-4489-9746-6df9cc836cf0",
          "workspace": "isolated-org-fixture",
          "epoch": 1,
          "token": "5f1fe468-02d4-49b7-a1df-d5c20c538a58",
          "client": "codex",
          "sink": "compact-reprime",
          "payloadSha256": "62d03d8f89041af9bd413b0e7d35f307df3e79aa5cfefa9cfae561fc5b2dab43",
          "payloadBytes": 301,
          "fragment": {
            "kind": "memory",
            "id": "c214a744-0e91-487e-bef8-33419bc400d8",
            "epoch": 1,
            "port": "compact",
            "bodySha256": "8c213f1eac5101c2438a4e6a5e19de1a5c6c25d98a0ef001b83485b594235c8d",
            "bodyBytes": 141
          }
        }
      },
      {
        "client": "codex",
        "sink": "compact-reprime",
        "source": "memory",
        "fault": "partial-stdout",
        "selector": "context reliability R-1: production Codex compact memory partial endpoint hook PostgreSQL join",
        "evidenceRefs": [
          "vitest:context reliability R-1: production Codex compact memory partial endpoint hook PostgreSQL join#compactEndpointJoin"
        ],
        "terminalOracle": "complete-stdout",
        "state": "partial",
        "verdict": "passed",
        "suppressionWrites": 0,
        "attempt": {
          "id": "su-compact-04ac3170-ddf9-4ea7-9370-6c499063c76f",
          "recipient": "su-compact-04ac3170-ddf9-4ea7-9370-6c499063c76f",
          "workspace": "isolated-org-fixture",
          "epoch": 1,
          "token": "4ba0dc10-f633-41d8-b4d7-8eb27059ba75",
          "fragment": {
            "kind": "memory",
            "id": "e7f3947c-8277-4a8b-b522-efa39b0c3fad",
            "epoch": 1,
            "port": "compact",
            "bodySha256": "f0a0707adc62f861d638a296857ab439225beac45a81f88b16403200e4f2580d",
            "bodyBytes": 141
          }
        }
      },
      {
        "client": "codex",
        "sink": "compact-reprime",
        "source": "memory",
        "fault": "lost-response",
        "selector": "context reliability R-1: production Codex compact memory lost-response endpoint hook PostgreSQL join",
        "evidenceRefs": [
          "vitest:context reliability R-1: production Codex compact memory lost-response endpoint hook PostgreSQL join#compactEndpointJoin"
        ],
        "terminalOracle": "complete-stdout",
        "state": "prepared",
        "verdict": "passed",
        "suppressionWrites": 0,
        "attempt": {
          "id": "su-compact-59b71be2-f557-4845-96f6-d53ff4ac7df3",
          "recipient": "su-compact-59b71be2-f557-4845-96f6-d53ff4ac7df3",
          "workspace": "isolated-org-fixture",
          "epoch": 1,
          "token": "7fdaf92d-ace7-4d39-99f3-0f875705af77",
          "fragment": {
            "kind": "memory",
            "id": "94a2ba7e-71f0-48f1-a725-e18e5098a6ec",
            "epoch": 1,
            "port": "compact",
            "bodySha256": "b065880fcd27d1a0145e8f6b12dc3436640b1e0b861994dcedf26625567fa18a",
            "bodyBytes": 141
          }
        }
      },
      {
        "client": "codex",
        "sink": "compact-reprime",
        "source": "memory",
        "fault": "deadline",
        "selector": "context reliability R-1: production Codex compact memory deadline endpoint hook PostgreSQL join",
        "evidenceRefs": [
          "vitest:context reliability R-1: production Codex compact memory deadline endpoint hook PostgreSQL join#compactEndpointJoin"
        ],
        "terminalOracle": "complete-stdout",
        "state": "prepared",
        "verdict": "passed",
        "suppressionWrites": 0,
        "attempt": {
          "id": "su-compact-29e5b20a-9908-4b49-b55e-28d1a71bb291",
          "recipient": "su-compact-29e5b20a-9908-4b49-b55e-28d1a71bb291",
          "workspace": "isolated-org-fixture",
          "epoch": 1,
          "token": "d08d69da-fa68-4b13-8ff9-9b35c28387b7",
          "fragment": {
            "kind": "memory",
            "id": "4e96212a-5d00-420f-8eb8-a9e04e0f45b8",
            "epoch": 1,
            "port": "compact",
            "bodySha256": "f101dee8e7a4ed0f321b12ddd69e1d369daffe0a22804fd20cdbc48a329f8099",
            "bodyBytes": 141
          }
        }
      },
      {
        "client": "codex",
        "sink": "compact-reprime",
        "source": "memory",
        "fault": "retry",
        "selector": "context reliability R-1: production Codex compact memory retry endpoint hook PostgreSQL join",
        "evidenceRefs": [
          "vitest:context reliability R-1: production Codex compact memory retry endpoint hook PostgreSQL join#compactEndpointJoin"
        ],
        "terminalOracle": "complete-stdout",
        "state": "emitted",
        "verdict": "passed",
        "suppressionWrites": 1,
        "attempt": {
          "id": "su-compact-c77aa7e4-f12b-4403-b8ab-4ab21b7d82a1",
          "recipient": "su-compact-c77aa7e4-f12b-4403-b8ab-4ab21b7d82a1",
          "workspace": "isolated-org-fixture",
          "epoch": 2,
          "token": "0f57e66b-00c4-4924-9457-2ee3d4e919b6",
          "fragment": {
            "kind": "memory",
            "id": "f7e036d6-51f1-44ef-b118-e39fd842679d",
            "epoch": 2,
            "port": "compact",
            "bodySha256": "ffa628d80a579547f1fe49469288cfec876475c5e8f3ebd50b6c780174d2d703",
            "bodyBytes": 141
          }
        },
        "proof": {
          "event": "complete-stdout",
          "adapter": "codex-session-start",
          "receiptRef": "vitest:context reliability R-1: production Codex compact memory retry endpoint hook PostgreSQL join#compactImmutableReceipt",
          "attemptId": "su-compact-c77aa7e4-f12b-4403-b8ab-4ab21b7d82a1",
          "recipient": "su-compact-c77aa7e4-f12b-4403-b8ab-4ab21b7d82a1",
          "workspace": "isolated-org-fixture",
          "epoch": 2,
          "token": "0f57e66b-00c4-4924-9457-2ee3d4e919b6",
          "client": "codex",
          "sink": "compact-reprime",
          "payloadSha256": "08902dccca8b9afda7befc69b2390d4420d103c50eaab0dfdd17ed245b6430e1",
          "payloadBytes": 301,
          "fragment": {
            "kind": "memory",
            "id": "f7e036d6-51f1-44ef-b118-e39fd842679d",
            "epoch": 2,
            "port": "compact",
            "bodySha256": "ffa628d80a579547f1fe49469288cfec876475c5e8f3ebd50b6c780174d2d703",
            "bodyBytes": 141
          }
        }
      },
      {
        "client": "codex",
        "sink": "compact-reprime",
        "source": "memory",
        "fault": "abandon-expiry",
        "selector": "context reliability R-1: production Codex compact memory abandon-expiry endpoint hook PostgreSQL join",
        "evidenceRefs": [
          "vitest:context reliability R-1: production Codex compact memory abandon-expiry endpoint hook PostgreSQL join#compactEndpointJoin"
        ],
        "terminalOracle": "complete-stdout",
        "state": "abandoned",
        "verdict": "passed",
        "suppressionWrites": 0,
        "attempt": {
          "id": "su-compact-c0abe626-c3cb-4242-b59c-021ee438d661",
          "recipient": "su-compact-c0abe626-c3cb-4242-b59c-021ee438d661",
          "workspace": "isolated-org-fixture",
          "epoch": 1,
          "token": "cfd6e1da-74b4-41cc-b1e1-5380dfd07810",
          "fragment": {
            "kind": "memory",
            "id": "80469c53-f2e7-477f-9f55-8df6c7fe951b",
            "epoch": 1,
            "port": "compact",
            "bodySha256": "4672070e4a68e427214a7fb9feac0fed0cd47e6a415c468ac86d56ae2c93fd11",
            "bodyBytes": 141
          }
        }
      },
      {
        "client": "codex",
        "sink": "compact-reprime",
        "source": "memory",
        "fault": "overlapping-ports",
        "selector": "context reliability R-1: production Codex compact memory overlapping-ports endpoint hook PostgreSQL join",
        "evidenceRefs": [
          "vitest:context reliability R-1: production Codex compact memory overlapping-ports endpoint hook PostgreSQL join#compactEndpointJoin"
        ],
        "terminalOracle": "complete-stdout",
        "state": "emitted",
        "verdict": "passed",
        "suppressionWrites": 1,
        "attempt": {
          "id": "su-compact-78d13ba7-b2c5-40f3-a6b0-ce6abe26225e",
          "recipient": "su-compact-78d13ba7-b2c5-40f3-a6b0-ce6abe26225e",
          "workspace": "isolated-org-fixture",
          "epoch": 1,
          "token": "78172a3b-64a1-477d-bc6e-03d102707e85",
          "fragment": {
            "kind": "memory",
            "id": "a6ff7e1e-d21d-4569-b673-310cf2bcf622",
            "epoch": 1,
            "port": "compact",
            "bodySha256": "439cc3e67fc82ecee93a449566df4a6a005054e73cfea5c63a6d97402ae85340",
            "bodyBytes": 141
          }
        },
        "proof": {
          "event": "complete-stdout",
          "adapter": "codex-session-start",
          "receiptRef": "vitest:context reliability R-1: production Codex compact memory overlapping-ports endpoint hook PostgreSQL join#compactImmutableReceipt",
          "attemptId": "su-compact-78d13ba7-b2c5-40f3-a6b0-ce6abe26225e",
          "recipient": "su-compact-78d13ba7-b2c5-40f3-a6b0-ce6abe26225e",
          "workspace": "isolated-org-fixture",
          "epoch": 1,
          "token": "78172a3b-64a1-477d-bc6e-03d102707e85",
          "client": "codex",
          "sink": "compact-reprime",
          "payloadSha256": "97cc3a68b69c9747a977bf8f6a580706908d5280e68e4ccfda92a50ef80f17cb",
          "payloadBytes": 301,
          "fragment": {
            "kind": "memory",
            "id": "a6ff7e1e-d21d-4569-b673-310cf2bcf622",
            "epoch": 1,
            "port": "compact",
            "bodySha256": "439cc3e67fc82ecee93a449566df4a6a005054e73cfea5c63a6d97402ae85340",
            "bodyBytes": 141
          }
        }
      },
      {
        "client": "codex",
        "sink": "compact-reprime",
        "source": "corpus",
        "fault": "prepare",
        "selector": "context reliability R-1: production Codex compact corpus complete endpoint hook PostgreSQL join",
        "evidenceRefs": [
          "vitest:context reliability R-1: production Codex compact corpus complete endpoint hook PostgreSQL join#compactPreparation"
        ],
        "terminalOracle": "complete-stdout",
        "state": "prepared",
        "verdict": "passed",
        "suppressionWrites": 0,
        "attempt": {
          "id": "su-compact-df8f9946-ae37-46d7-90b1-fa7e5a14a744",
          "recipient": "su-compact-df8f9946-ae37-46d7-90b1-fa7e5a14a744",
          "workspace": "isolated-org-fixture",
          "epoch": 1,
          "token": "840309a4-c3e7-4089-83a1-cb977ec5b852",
          "fragment": {
            "kind": "corpus",
            "id": "plan:compact:su-compact-df8f9946-ae37-46d7-90b1-fa7e5a14a744",
            "epoch": 1,
            "port": "compact",
            "bodySha256": "5a85ef1e41435ecd818cf0c3c3fe334f300f100ce1e5fbf4a4cbbd8770ea04c5",
            "bodyBytes": 250
          }
        }
      },
      {
        "client": "codex",
        "sink": "compact-reprime",
        "source": "corpus",
        "fault": "duplicate-commit",
        "selector": "context reliability R-1: production Codex compact corpus complete endpoint hook PostgreSQL join",
        "evidenceRefs": [
          "vitest:context reliability R-1: production Codex compact corpus complete endpoint hook PostgreSQL join#compactEndpointJoin"
        ],
        "terminalOracle": "complete-stdout",
        "state": "emitted",
        "verdict": "passed",
        "suppressionWrites": 1,
        "attempt": {
          "id": "su-compact-df8f9946-ae37-46d7-90b1-fa7e5a14a744",
          "recipient": "su-compact-df8f9946-ae37-46d7-90b1-fa7e5a14a744",
          "workspace": "isolated-org-fixture",
          "epoch": 1,
          "token": "840309a4-c3e7-4089-83a1-cb977ec5b852",
          "fragment": {
            "kind": "corpus",
            "id": "plan:compact:su-compact-df8f9946-ae37-46d7-90b1-fa7e5a14a744",
            "epoch": 1,
            "port": "compact",
            "bodySha256": "5a85ef1e41435ecd818cf0c3c3fe334f300f100ce1e5fbf4a4cbbd8770ea04c5",
            "bodyBytes": 250
          }
        },
        "proof": {
          "event": "complete-stdout",
          "adapter": "codex-session-start",
          "receiptRef": "vitest:context reliability R-1: production Codex compact corpus complete endpoint hook PostgreSQL join#compactImmutableReceipt",
          "attemptId": "su-compact-df8f9946-ae37-46d7-90b1-fa7e5a14a744",
          "recipient": "su-compact-df8f9946-ae37-46d7-90b1-fa7e5a14a744",
          "workspace": "isolated-org-fixture",
          "epoch": 1,
          "token": "840309a4-c3e7-4089-83a1-cb977ec5b852",
          "client": "codex",
          "sink": "compact-reprime",
          "payloadSha256": "b54b274d6fbd831de30bc17153372a12ef0f6a0f4097250445a6d92831dd3438",
          "payloadBytes": 1039,
          "fragment": {
            "kind": "corpus",
            "id": "plan:compact:su-compact-df8f9946-ae37-46d7-90b1-fa7e5a14a744",
            "epoch": 1,
            "port": "compact",
            "bodySha256": "5a85ef1e41435ecd818cf0c3c3fe334f300f100ce1e5fbf4a4cbbd8770ea04c5",
            "bodyBytes": 250
          }
        }
      },
      {
        "client": "codex",
        "sink": "compact-reprime",
        "source": "corpus",
        "fault": "partial-stdout",
        "selector": "context reliability R-1: production Codex compact corpus partial endpoint hook PostgreSQL join",
        "evidenceRefs": [
          "vitest:context reliability R-1: production Codex compact corpus partial endpoint hook PostgreSQL join#compactEndpointJoin"
        ],
        "terminalOracle": "complete-stdout",
        "state": "partial",
        "verdict": "passed",
        "suppressionWrites": 0,
        "attempt": {
          "id": "su-compact-8d064fdb-0edd-4294-a224-95e653d15dc3",
          "recipient": "su-compact-8d064fdb-0edd-4294-a224-95e653d15dc3",
          "workspace": "isolated-org-fixture",
          "epoch": 1,
          "token": "6357ed13-e1dc-4eec-be79-ba08d8767c46",
          "fragment": {
            "kind": "corpus",
            "id": "plan:compact:su-compact-8d064fdb-0edd-4294-a224-95e653d15dc3",
            "epoch": 1,
            "port": "compact",
            "bodySha256": "e5c8ecae91a4adef63d8e255a9d87139cf83806e7717e1185a5b3d435bbb1956",
            "bodyBytes": 250
          }
        }
      },
      {
        "client": "codex",
        "sink": "compact-reprime",
        "source": "corpus",
        "fault": "lost-response",
        "selector": "context reliability R-1: production Codex compact corpus lost-response endpoint hook PostgreSQL join",
        "evidenceRefs": [
          "vitest:context reliability R-1: production Codex compact corpus lost-response endpoint hook PostgreSQL join#compactEndpointJoin"
        ],
        "terminalOracle": "complete-stdout",
        "state": "prepared",
        "verdict": "passed",
        "suppressionWrites": 0,
        "attempt": {
          "id": "su-compact-a7712910-8e57-42f2-a38e-4efa3481acc7",
          "recipient": "su-compact-a7712910-8e57-42f2-a38e-4efa3481acc7",
          "workspace": "isolated-org-fixture",
          "epoch": 1,
          "token": "f00c4b76-5308-4727-97a5-d87f0a2f3ce8",
          "fragment": {
            "kind": "corpus",
            "id": "plan:compact:su-compact-a7712910-8e57-42f2-a38e-4efa3481acc7",
            "epoch": 1,
            "port": "compact",
            "bodySha256": "972c85d725c1799af1a02c4312923571010552b545058a8529c813d4aaf86257",
            "bodyBytes": 250
          }
        }
      },
      {
        "client": "codex",
        "sink": "compact-reprime",
        "source": "corpus",
        "fault": "deadline",
        "selector": "context reliability R-1: production Codex compact corpus deadline endpoint hook PostgreSQL join",
        "evidenceRefs": [
          "vitest:context reliability R-1: production Codex compact corpus deadline endpoint hook PostgreSQL join#compactEndpointJoin"
        ],
        "terminalOracle": "complete-stdout",
        "state": "prepared",
        "verdict": "passed",
        "suppressionWrites": 0,
        "attempt": {
          "id": "su-compact-fa7f8c9e-98e9-4f3b-9d66-64c6e02db8f9",
          "recipient": "su-compact-fa7f8c9e-98e9-4f3b-9d66-64c6e02db8f9",
          "workspace": "isolated-org-fixture",
          "epoch": 1,
          "token": "01d79b21-f522-41bb-b3ab-be884a3cbfc8",
          "fragment": {
            "kind": "corpus",
            "id": "plan:compact:su-compact-fa7f8c9e-98e9-4f3b-9d66-64c6e02db8f9",
            "epoch": 1,
            "port": "compact",
            "bodySha256": "5b0aa73d427d8c4c2d460c5ecbf221dfde7fb09db542f6182d91b35746fe86db",
            "bodyBytes": 250
          }
        }
      },
      {
        "client": "codex",
        "sink": "compact-reprime",
        "source": "corpus",
        "fault": "retry",
        "selector": "context reliability R-1: production Codex compact corpus retry endpoint hook PostgreSQL join",
        "evidenceRefs": [
          "vitest:context reliability R-1: production Codex compact corpus retry endpoint hook PostgreSQL join#compactEndpointJoin"
        ],
        "terminalOracle": "complete-stdout",
        "state": "emitted",
        "verdict": "passed",
        "suppressionWrites": 1,
        "attempt": {
          "id": "su-compact-85af7b77-afb4-4764-a7d3-2e544800688e",
          "recipient": "su-compact-85af7b77-afb4-4764-a7d3-2e544800688e",
          "workspace": "isolated-org-fixture",
          "epoch": 2,
          "token": "bc80cd09-0f46-4e98-ba7f-7d007cfe7404",
          "fragment": {
            "kind": "corpus",
            "id": "plan:compact:su-compact-85af7b77-afb4-4764-a7d3-2e544800688e",
            "epoch": 2,
            "port": "compact",
            "bodySha256": "e001a43806e03b6459786c7fe2087ac4ebc43f1c8934a60a550257f0cbcca86f",
            "bodyBytes": 250
          }
        },
        "proof": {
          "event": "complete-stdout",
          "adapter": "codex-session-start",
          "receiptRef": "vitest:context reliability R-1: production Codex compact corpus retry endpoint hook PostgreSQL join#compactImmutableReceipt",
          "attemptId": "su-compact-85af7b77-afb4-4764-a7d3-2e544800688e",
          "recipient": "su-compact-85af7b77-afb4-4764-a7d3-2e544800688e",
          "workspace": "isolated-org-fixture",
          "epoch": 2,
          "token": "bc80cd09-0f46-4e98-ba7f-7d007cfe7404",
          "client": "codex",
          "sink": "compact-reprime",
          "payloadSha256": "6a84f08b2eab7ec820aaf4d5fb1db5335dfda2366b45175a871fedcea0b255c9",
          "payloadBytes": 1039,
          "fragment": {
            "kind": "corpus",
            "id": "plan:compact:su-compact-85af7b77-afb4-4764-a7d3-2e544800688e",
            "epoch": 2,
            "port": "compact",
            "bodySha256": "e001a43806e03b6459786c7fe2087ac4ebc43f1c8934a60a550257f0cbcca86f",
            "bodyBytes": 250
          }
        }
      },
      {
        "client": "codex",
        "sink": "compact-reprime",
        "source": "corpus",
        "fault": "abandon-expiry",
        "selector": "context reliability R-1: production Codex compact corpus abandon-expiry endpoint hook PostgreSQL join",
        "evidenceRefs": [
          "vitest:context reliability R-1: production Codex compact corpus abandon-expiry endpoint hook PostgreSQL join#compactEndpointJoin"
        ],
        "terminalOracle": "complete-stdout",
        "state": "abandoned",
        "verdict": "passed",
        "suppressionWrites": 0,
        "attempt": {
          "id": "su-compact-a07ed1d9-61e3-4b1c-8f3b-52c4c30371c6",
          "recipient": "su-compact-a07ed1d9-61e3-4b1c-8f3b-52c4c30371c6",
          "workspace": "isolated-org-fixture",
          "epoch": 1,
          "token": "2a43b48d-2d0a-4a33-99ed-733e1a65a8af",
          "fragment": {
            "kind": "corpus",
            "id": "plan:compact:su-compact-a07ed1d9-61e3-4b1c-8f3b-52c4c30371c6",
            "epoch": 1,
            "port": "compact",
            "bodySha256": "a50dee0e9d5349f01c363561a0742d8eda398d6157c0d8af8168fdfba2a23125",
            "bodyBytes": 250
          }
        }
      },
      {
        "client": "codex",
        "sink": "compact-reprime",
        "source": "corpus",
        "fault": "overlapping-ports",
        "selector": "context reliability R-1: production Codex compact corpus overlapping-ports endpoint hook PostgreSQL join",
        "evidenceRefs": [
          "vitest:context reliability R-1: production Codex compact corpus overlapping-ports endpoint hook PostgreSQL join#compactEndpointJoin"
        ],
        "terminalOracle": "complete-stdout",
        "state": "emitted",
        "verdict": "passed",
        "suppressionWrites": 1,
        "attempt": {
          "id": "su-compact-bb68b6f1-d04b-44c0-b089-90387deeda67",
          "recipient": "su-compact-bb68b6f1-d04b-44c0-b089-90387deeda67",
          "workspace": "isolated-org-fixture",
          "epoch": 1,
          "token": "4a264a73-dc4e-420f-adf9-72c388e33ca2",
          "fragment": {
            "kind": "corpus",
            "id": "plan:compact:su-compact-bb68b6f1-d04b-44c0-b089-90387deeda67",
            "epoch": 1,
            "port": "compact",
            "bodySha256": "82be86bcea58c678df10c3a4675709602da2cba77ddf821a1a5fcb7ca49a95e5",
            "bodyBytes": 250
          }
        },
        "proof": {
          "event": "complete-stdout",
          "adapter": "codex-session-start",
          "receiptRef": "vitest:context reliability R-1: production Codex compact corpus overlapping-ports endpoint hook PostgreSQL join#compactImmutableReceipt",
          "attemptId": "su-compact-bb68b6f1-d04b-44c0-b089-90387deeda67",
          "recipient": "su-compact-bb68b6f1-d04b-44c0-b089-90387deeda67",
          "workspace": "isolated-org-fixture",
          "epoch": 1,
          "token": "4a264a73-dc4e-420f-adf9-72c388e33ca2",
          "client": "codex",
          "sink": "compact-reprime",
          "payloadSha256": "a3f34b52f7daaa94f9f296dc95a2277b6735b408e45d193cc267ae9b3831ffb4",
          "payloadBytes": 1039,
          "fragment": {
            "kind": "corpus",
            "id": "plan:compact:su-compact-bb68b6f1-d04b-44c0-b089-90387deeda67",
            "epoch": 1,
            "port": "compact",
            "bodySha256": "82be86bcea58c678df10c3a4675709602da2cba77ddf821a1a5fcb7ca49a95e5",
            "bodyBytes": 250
          }
        }
      }
    ],
    "workerSourceCount": 2172,
    "hashMismatches": [],
    "custody": {
      "manifest": {
        "ref": "68a3e55148d59176871d069930a38abe54533df277fb64212ae86b3aee139612.native-proof.json",
        "sha256": "68a3e55148d59176871d069930a38abe54533df277fb64212ae86b3aee139612",
        "byteLength": 9322408
      },
      "identity": {
        "workspace": "papercusp-workspace",
        "harness": "papercusp",
        "runId": "1199a67f-05b2-4b93-99cc-6ef187dfe3d5"
      },
      "expectedHash": "3d51c9574da5a8db2c1bbae5f217b215d3af78a16c3116cef2c3f71508eb82ad",
      "inventoryHash": "0ed470e99d57bd7c9cb36f8adfdd619400948033ff96da8110b5a9f2228ed46f"
    },
    "receipt": {
      "command": [
        "/home/marsh-office/.local/node25/bin/node",
        "/home/marsh-office/papercupai-workspace/papercusp/node_modules/vitest/vitest.mjs",
        "run",
        "--config",
        "vitest.integration.config.ts",
        "--configLoader",
        "native",
        "lib/memory/session-epoch-cross-port.integration.test.ts",
        "--testNamePattern=production (Codex )?compact",
        "--reporter=default",
        "--reporter=json",
        "--outputFile=/tmp/ctx-r97-compact-faults.json",
        "--reporter=/home/marsh-office/papercupai-workspace/papercusp/libs/test-config/src/admin-test-runs-reporter.ts",
        "--reporter=/home/marsh-office/papercupai-workspace/papercusp/libs/test-config/src/executed-source-map-reporter.ts",
        "--reporter=/home/marsh-office/papercupai-workspace/papercusp/scripts/lib/test-progress-heartbeat-reporter.mjs"
      ],
      "cwd": "/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core",
      "status": 0,
      "signal": null,
      "timedOut": false,
      "error": null,
      "captureComplete": true,
      "writer": "router-owned-child-close"
    },
    "limits": "deterministic retrieval and explicit stdout receipt replay; host consumption, acceptance and shipment UNKNOWN"
  },
  "validator": {
    "red2": {
      "success": false,
      "numPassedTests": 0,
      "numFailedTests": 2,
      "numPendingTests": 66
    },
    "counterexamples": [
      "AssertionError: expected 'NONE' to be 'complete-stdout' // Object.is equality",
      "AssertionError: expected 'NONE' to be 'complete-stdout' // Object.is equality"
    ],
    "green": {
      "success": true,
      "numPassedTests": 68,
      "numFailedTests": 0,
      "numPendingTests": 0
    },
    "native": {
      "terminalHook": "onTestRunEnd",
      "reason": "passed",
      "unhandledErrorCount": 0,
      "modulePopulationMatched": true,
      "gaps": []
    },
    "commandExit": {
      "command": [
        "/home/marsh-office/.local/node25/bin/node",
        "/home/marsh-office/papercupai-workspace/papercusp/node_modules/vitest/vitest.mjs",
        "run",
        "--config",
        "vitest.config.ts",
        "--configLoader",
        "native",
        "lib/memory/injection-delivery-coverage.test.ts",
        "--reporter=default",
        "--reporter=json",
        "--outputFile=/tmp/ctx-r97-validator-green.json",
        "--reporter=/home/marsh-office/papercupai-workspace/papercusp/libs/test-config/src/admin-test-runs-reporter.ts",
        "--reporter=/home/marsh-office/papercupai-workspace/papercusp/libs/test-config/src/executed-source-map-reporter.ts",
        "--reporter=/home/marsh-office/papercupai-workspace/papercusp/scripts/lib/test-progress-heartbeat-reporter.mjs"
      ],
      "cwd": "/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core",
      "status": 0,
      "signal": null,
      "timedOut": false,
      "error": null,
      "captureComplete": true,
      "writer": "router-owned-child-close"
    },
    "custody": {
      "manifest": {
        "ref": "c54ba9d57bcd0cf68b3e46ea53972f6c0b2787a348c58e4ef036ff1ef1d89298.native-proof.json",
        "sha256": "c54ba9d57bcd0cf68b3e46ea53972f6c0b2787a348c58e4ef036ff1ef1d89298",
        "byteLength": 822964
      },
      "identity": {
        "workspace": "papercusp-workspace",
        "harness": "papercusp",
        "runId": "5e2aeadc-3c6d-4bbf-b71f-fc2bddd85f09"
      },
      "expectedHash": "0f3e343c263d35c5aed57ed8a1056f3bbfa1ee12b48c62d5a6c8b5d25d0136f8",
      "inventoryHash": "6f655f95df71dc7ea26f2a62576c83f7caaf459c82cc998b1879df22f5fa531c"
    }
  },
  "pending": {
    "full295": "/tmp/ctx-r97-pg-full.log",
    "typecheck": "/tmp/ctx-r97-types.log",
    "expectedCensus": "304 proven /128 UNKNOWN only after final full report",
    "hostConsumption": "UNKNOWN",
    "independentAcceptance": "UNKNOWN",
    "shipment": "UNKNOWN"
  }
}
