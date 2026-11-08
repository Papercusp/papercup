---
rel_path: "evidence/context-injection/r4-operative-units-r32.json"
updated_at: 1794096951787
_body: "content"
---

{
  "schemaVersion": "operative-unit-v1",
  "identity": {
    "planRevision": 43,
    "planHash": "41e0341726193e0f390dff8b41c80ae252fb10e21dcdf8a5c29bb513b532dc87",
    "rubricRevision": 4,
    "rubricHash": "2a32ebe74e3e7f184da211a723c1f912fd5807a76832248e5640008a8dbff92f",
    "barHash": "f9d9f0b13f7131c534b70c2b55f7113f668ab085049cf8fb82c62174d8e4d256",
    "specHash": "5bc20a5d068639e75292cda0aefe5286bc06bfa07777421e29bc3405d4a57262",
    "sourceHash": "47ef7866c68961ae8a425d056260b7bea2b3f51b6d9c257be626997e8d6ea52f",
    "testHash": "b27e1b97b0b03cf11a2952342bfa92e632ac9eba54cdb63c01f91b36c3b0a7eb",
    "runtimeGeneration": "current-tree-fixture:sha256:5772c8350ba00cfd854839864158ad3dbb6796fcd708ee68ac91a986bca26a16"
  },
  "cells": [
    {
      "client": "codex",
      "condition": "late-negation",
      "boundary": "entry",
      "source": "memory",
      "mode": "fits",
      "selector": "context reliability R-4: late-negation entry",
      "evidenceRefs": [
        "vitest:context-injection-reliability.integration.test.ts#R-4/codex/late-negation/entry/memory/fits"
      ],
      "inputHash": "a4ae25a5373f2852406facee7a105aa9bfe3235ee67d18aaa3e5c318d5812c7c",
      "returnedText": "## Operator memory (relevant entries)\n\n- [unknown] (id=11111111-1111-4111-8111-111111111111) source-evidence \"Apply zephyrrepair recovery. Do not apply it to production.\"",
      "offeredHashes": [
        "92d35a67dc9060bf6802bd563c6cfa77311e2cf4e712b91c8591cf00e79e49bc"
      ],
      "committedHashes": [
        "92d35a67dc9060bf6802bd563c6cfa77311e2cf4e712b91c8591cf00e79e49bc"
      ],
      "verdict": "passed"
    },
    {
      "client": "codex",
      "condition": "late-negation",
      "boundary": "entry",
      "source": "memory",
      "mode": "limited",
      "selector": "context reliability R-4: late-negation entry",
      "evidenceRefs": [
        "vitest:context-injection-reliability.integration.test.ts#R-4/codex/late-negation/entry/memory/limited"
      ],
      "inputHash": "29f91bab9ca461a612f91e3a65106baece79e3482048afddff04f13a627aae95",
      "returnedText": "## Operator memory (relevant entries)\n\n- [unknown] (id=11111111-1111-4111-8111-111111111111) source-pointer {\"kind\":\"memory\",\"ref\":\"11111111-1111-4111-8111-111111111111\",\"revision\":\"unknown\",\"passage\":\"retrieved-unit\",\"unitHash\":\"20bf56ca539eb49ff7ac2e09fb63ab31a6770f5b5cd5c570ba661e5cd3a916d3\",\"omitted\":true}",
      "offeredHashes": [],
      "committedHashes": [],
      "verdict": "passed"
    },
    {
      "client": "codex",
      "condition": "late-negation",
      "boundary": "entry",
      "source": "corpus",
      "mode": "fits",
      "selector": "context reliability R-4: late-negation entry",
      "evidenceRefs": [
        "vitest:context-injection-reliability.integration.test.ts#R-4/codex/late-negation/entry/corpus/fits"
      ],
      "inputHash": "4357ba5bc6be94204b822547cd55e9d0025e5816288bd107d71eaf50e71b026f",
      "returnedText": "## Related context (matched excerpts)\n\n⚠ Retrieval for these pointers was DEGRADED: embedding coverage for 'session_turn' is UNKNOWN (no fresh sample) — treat these as unverified, not healthy; embedding coverage for 'work_item' is UNKNOWN (no fresh sample) — treat these as unverified, not healthy; embedding coverage for 'plan' is UNKNOWN (no fresh sample) — treat these as unverified, not healthy; embedding coverage for 'doc' is UNKNOWN (no fresh sample) — treat these as unverified, not healthy; embedding coverage for 'report' is UNKNOWN (no fresh sample) — treat these as unverified, not healthy.\n\n- [plan plan:query-fixture-harness:operative] source-evidence \"Apply zephyrrepair recovery. Do not apply it to production.\" — plans:get {\"slug\":\"operative\",\"harness\":\"query-fixture-harness\"}",
      "offeredHashes": [
        "f02d8bbf63b15f7bebaaf40f47ae66816cec2ef2f15ce87e411cd5ee7bcec2d8"
      ],
      "committedHashes": [
        "f02d8bbf63b15f7bebaaf40f47ae66816cec2ef2f15ce87e411cd5ee7bcec2d8"
      ],
      "verdict": "passed"
    },
    {
      "client": "codex",
      "condition": "late-negation",
      "boundary": "entry",
      "source": "corpus",
      "mode": "limited",
      "selector": "context reliability R-4: late-negation entry",
      "evidenceRefs": [
        "vitest:context-injection-reliability.integration.test.ts#R-4/codex/late-negation/entry/corpus/limited"
      ],
      "inputHash": "6ccd15ef89c8e62db179f2d9454491cc3c0eb8705c44afa5d177037f56bfb016",
      "returnedText": "## Related context (matched excerpts)\n\n⚠ Retrieval for these pointers was DEGRADED: embedding coverage for 'session_turn' is UNKNOWN (no fresh sample) — treat these as unverified, not healthy; embedding coverage for 'work_item' is UNKNOWN (no fresh sample) — treat these as unverified, not healthy; embedding coverage for 'plan' is UNKNOWN (no fresh sample) — treat these as unverified, not healthy; embedding coverage for 'doc' is UNKNOWN (no fresh sample) — treat these as unverified, not healthy; embedding coverage for 'report' is UNKNOWN (no fresh sample) — treat these as unverified, not healthy.\n\n- [plan plan:query-fixture-harness:operative] source-pointer {\"kind\":\"plan\",\"ref\":\"plan:query-fixture-harness:operative\",\"link\":\"plans:get {\\\"slug\\\":\\\"operative\\\",\\\"harness\\\":\\\"query-fixture-harness\\\"}\",\"revision\":\"unknown\",\"passage\":\"retrieved-unit\",\"unitHash\":\"20bf56ca539eb49ff7ac2e09fb63ab31a6770f5b5cd5c570ba661e5cd3a916d3\",\"omitted\":true} — plans:get {\"slug\":\"operative\",\"harness\":\"query-fixture-harness\"}",
      "offeredHashes": [],
      "committedHashes": [],
      "verdict": "passed"
    },
    {
      "client": "claude",
      "condition": "late-negation",
      "boundary": "entry",
      "source": "memory",
      "mode": "fits",
      "selector": "context reliability R-4: late-negation entry",
      "evidenceRefs": [
        "vitest:context-injection-reliability.integration.test.ts#R-4/claude/late-negation/entry/memory/fits"
      ],
      "inputHash": "daa2087ec7cd7c1e05a2cc5f7102e69b0a6c77cb54e465b16930c288846bf04b",
      "returnedText": "## Operator memory (relevant entries)\n\n- [unknown] (id=11111111-1111-4111-8111-111111111111) source-evidence \"Apply zephyrrepair recovery. Do not apply it to production.\"",
      "offeredHashes": [
        "92d35a67dc9060bf6802bd563c6cfa77311e2cf4e712b91c8591cf00e79e49bc"
      ],
      "committedHashes": [
        "92d35a67dc9060bf6802bd563c6cfa77311e2cf4e712b91c8591cf00e79e49bc"
      ],
      "verdict": "passed"
    },
    {
      "client": "claude",
      "condition": "late-negation",
      "boundary": "entry",
      "source": "memory",
      "mode": "limited",
      "selector": "context reliability R-4: late-negation entry",
      "evidenceRefs": [
        "vitest:context-injection-reliability.integration.test.ts#R-4/claude/late-negation/entry/memory/limited"
      ],
      "inputHash": "a7fba3c074d05e105881f3c83e0f4b3aeddfd8ca765cefa4f0e5b922357a4cd8",
      "returnedText": "## Operator memory (relevant entries)\n\n- [unknown] (id=11111111-1111-4111-8111-111111111111) source-pointer {\"kind\":\"memory\",\"ref\":\"11111111-1111-4111-8111-111111111111\",\"revision\":\"unknown\",\"passage\":\"retrieved-unit\",\"unitHash\":\"20bf56ca539eb49ff7ac2e09fb63ab31a6770f5b5cd5c570ba661e5cd3a916d3\",\"omitted\":true}",
      "offeredHashes": [],
      "committedHashes": [],
      "verdict": "passed"
    },
    {
      "client": "claude",
      "condition": "late-negation",
      "boundary": "entry",
      "source": "corpus",
      "mode": "fits",
      "selector": "context reliability R-4: late-negation entry",
      "evidenceRefs": [
        "vitest:context-injection-reliability.integration.test.ts#R-4/claude/late-negation/entry/corpus/fits"
      ],
      "inputHash": "627f74ea9cb0e1a23db3768ecb5781aa8b68a3c949e071d931bb6fb98c2cbf34",
      "returnedText": "## Related context (matched excerpts)\n\n⚠ Retrieval for these pointers was DEGRADED: embedding coverage for 'session_turn' is UNKNOWN (no fresh sample) — treat these as unverified, not healthy; embedding coverage for 'work_item' is UNKNOWN (no fresh sample) — treat these as unverified, not healthy; embedding coverage for 'plan' is UNKNOWN (no fresh sample) — treat these as unverified, not healthy; embedding coverage for 'doc' is UNKNOWN (no fresh sample) — treat these as unverified, not healthy; embedding coverage for 'report' is UNKNOWN (no fresh sample) — treat these as unverified, not healthy.\n\n- [plan plan:query-fixture-harness:operative] source-evidence \"Apply zephyrrepair recovery. Do not apply it to production.\" — plans:get {\"slug\":\"operative\",\"harness\":\"query-fixture-harness\"}",
      "offeredHashes": [
        "f02d8bbf63b15f7bebaaf40f47ae66816cec2ef2f15ce87e411cd5ee7bcec2d8"
      ],
      "committedHashes": [
        "f02d8bbf63b15f7bebaaf40f47ae66816cec2ef2f15ce87e411cd5ee7bcec2d8"
      ],
      "verdict": "passed"
    },
    {
      "client": "claude",
      "condition": "late-negation",
      "boundary": "entry",
      "source": "corpus",
      "mode": "limited",
      "selector": "context reliability R-4: late-negation entry",
      "evidenceRefs": [
        "vitest:context-injection-reliability.integration.test.ts#R-4/claude/late-negation/entry/corpus/limited"
      ],
      "inputHash": "b42cf38ee95e1ac7ccbab3bc926e4d984f8f61ff3d96b341526aee2f04a8b276",
      "returnedText": "## Related context (matched excerpts)\n\n⚠ Retrieval for these pointers was DEGRADED: embedding coverage for 'session_turn' is UNKNOWN (no fresh sample) — treat these as unverified, not healthy; embedding coverage for 'work_item' is UNKNOWN (no fresh sample) — treat these as unverified, not healthy; embedding coverage for 'plan' is UNKNOWN (no fresh sample) — treat these as unverified, not healthy; embedding coverage for 'doc' is UNKNOWN (no fresh sample) — treat these as unverified, not healthy; embedding coverage for 'report' is UNKNOWN (no fresh sample) — treat these as unverified, not healthy.\n\n- [plan plan:query-fixture-harness:operative] source-pointer {\"kind\":\"plan\",\"ref\":\"plan:query-fixture-harness:operative\",\"link\":\"plans:get {\\\"slug\\\":\\\"operative\\\",\\\"harness\\\":\\\"query-fixture-harness\\\"}\",\"revision\":\"unknown\",\"passage\":\"retrieved-unit\",\"unitHash\":\"20bf56ca539eb49ff7ac2e09fb63ab31a6770f5b5cd5c570ba661e5cd3a916d3\",\"omitted\":true} — plans:get {\"slug\":\"operative\",\"harness\":\"query-fixture-harness\"}",
      "offeredHashes": [],
      "committedHashes": [],
      "verdict": "passed"
    },
    {
      "client": "omp",
      "condition": "late-negation",
      "boundary": "entry",
      "source": "memory",
      "mode": "fits",
      "selector": "context reliability R-4: late-negation entry",
      "evidenceRefs": [
        "vitest:context-injection-reliability.integration.test.ts#R-4/omp/late-negation/entry/memory/fits"
      ],
      "inputHash": "e136d4d853449645903361e9dba617d3a01775f4839af7b8cb29dc2ff38359aa",
      "returnedText": "## Operator memory (relevant entries)\n\n- [unknown] (id=11111111-1111-4111-8111-111111111111) source-evidence \"Apply zephyrrepair recovery. Do not apply it to production.\"",
      "offeredHashes": [
        "92d35a67dc9060bf6802bd563c6cfa77311e2cf4e712b91c8591cf00e79e49bc"
      ],
      "committedHashes": [
        "92d35a67dc9060bf6802bd563c6cfa77311e2cf4e712b91c8591cf00e79e49bc"
      ],
      "verdict": "passed"
    },
    {
      "client": "omp",
      "condition": "late-negation",
      "boundary": "entry",
      "source": "memory",
      "mode": "limited",
      "selector": "context reliability R-4: late-negation entry",
      "evidenceRefs": [
        "vitest:context-injection-reliability.integration.test.ts#R-4/omp/late-negation/entry/memory/limited"
      ],
      "inputHash": "e9a658c65a5d00f40ae2d15f2ed075ed761b5ada8ddd18d0e9c77997f21c138a",
      "returnedText": "## Operator memory (relevant entries)\n\n- [unknown] (id=11111111-1111-4111-8111-111111111111) source-pointer {\"kind\":\"memory\",\"ref\":\"11111111-1111-4111-8111-111111111111\",\"revision\":\"unknown\",\"passage\":\"retrieved-unit\",\"unitHash\":\"20bf56ca539eb49ff7ac2e09fb63ab31a6770f5b5cd5c570ba661e5cd3a916d3\",\"omitted\":true}",
      "offeredHashes": [],
      "committedHashes": [],
      "verdict": "passed"
    },
    {
      "client": "omp",
      "condition": "late-negation",
      "boundary": "entry",
      "source": "corpus",
      "mode": "fits",
      "selector": "context reliability R-4: late-negation entry",
      "evidenceRefs": [
        "vitest:context-injection-reliability.integration.test.ts#R-4/omp/late-negation/entry/corpus/fits"
      ],
      "inputHash": "23ff3c1abe9c6a1b2cd90adb29f0c32e28b41782da6c242fc4f973088e14903c",
      "returnedText": "## Related context (matched excerpts)\n\n⚠ Retrieval for these pointers was DEGRADED: embedding coverage for 'session_turn' is UNKNOWN (no fresh sample) — treat these as unverified, not healthy; embedding coverage for 'work_item' is UNKNOWN (no fresh sample) — treat these as unverified, not healthy; embedding coverage for 'plan' is UNKNOWN (no fresh sample) — treat these as unverified, not healthy; embedding coverage for 'doc' is UNKNOWN (no fresh sample) — treat these as unverified, not healthy; embedding coverage for 'report' is UNKNOWN (no fresh sample) — treat these as unverified, not healthy.\n\n- [plan plan:query-fixture-harness:operative] source-evidence \"Apply zephyrrepair recovery. Do not apply it to production.\" — plans:get {\"slug\":\"operative\",\"harness\":\"query-fixture-harness\"}",
      "offeredHashes": [
        "f02d8bbf63b15f7bebaaf40f47ae66816cec2ef2f15ce87e411cd5ee7bcec2d8"
      ],
      "committedHashes": [
        "f02d8bbf63b15f7bebaaf40f47ae66816cec2ef2f15ce87e411cd5ee7bcec2d8"
      ],
      "verdict": "passed"
    },
    {
      "client": "omp",
      "condition": "late-negation",
      "boundary": "entry",
      "source": "corpus",
      "mode": "limited",
      "selector": "context reliability R-4: late-negation entry",
      "evidenceRefs": [
        "vitest:context-injection-reliability.integration.test.ts#R-4/omp/late-negation/entry/corpus/limited"
      ],
      "inputHash": "59b6bf7b1666da8302ea0c9b91efd4ec794cb7043e720270d759dd29c57158ed",
      "returnedText": "## Related context (matched excerpts)\n\n⚠ Retrieval for these pointers was DEGRADED: embedding coverage for 'session_turn' is UNKNOWN (no fresh sample) — treat these as unverified, not healthy; embedding coverage for 'work_item' is UNKNOWN (no fresh sample) — treat these as unverified, not healthy; embedding coverage for 'plan' is UNKNOWN (no fresh sample) — treat these as unverified, not healthy; embedding coverage for 'doc' is UNKNOWN (no fresh sample) — treat these as unverified, not healthy; embedding coverage for 'report' is UNKNOWN (no fresh sample) — treat these as unverified, not healthy.\n\n- [plan plan:query-fixture-harness:operative] source-pointer {\"kind\":\"plan\",\"ref\":\"plan:query-fixture-harness:operative\",\"link\":\"plans:get {\\\"slug\\\":\\\"operative\\\",\\\"harness\\\":\\\"query-fixture-harness\\\"}\",\"revision\":\"unknown\",\"passage\":\"retrieved-unit\",\"unitHash\":\"20bf56ca539eb49ff7ac2e09fb63ab31a6770f5b5cd5c570ba661e5cd3a916d3\",\"omitted\":true} — plans:get {\"slug\":\"operative\",\"harness\":\"query-fixture-harness\"}",
      "offeredHashes": [],
      "committedHashes": [],
      "verdict": "passed"
    },
    {
      "client": "codex",
      "condition": "late-negation",
      "boundary": "aggregate",
      "source": "memory",
      "mode": "fits",
      "selector": "context reliability R-4: late-negation aggregate",
      "evidenceRefs": [
        "vitest:context-injection-reliability.integration.test.ts#R-4/codex/late-negation/aggregate/memory/fits"
      ],
      "inputHash": "0f460339af76c0aeff7a051c6667b106ddf79857e63905d68d7d1196a0bae445",
      "returnedText": "## Operator memory (relevant entries)\n\n- [unknown] (id=11111111-1111-4111-8111-111111111111) source-evidence \"Apply zephyrrepair recovery. Do not apply it to production.\"",
      "offeredHashes": [
        "92d35a67dc9060bf6802bd563c6cfa77311e2cf4e712b91c8591cf00e79e49bc"
      ],
      "committedHashes": [
        "92d35a67dc9060bf6802bd563c6cfa77311e2cf4e712b91c8591cf00e79e49bc"
      ],
      "verdict": "passed"
    },
    {
      "client": "codex",
      "condition": "late-negation",
      "boundary": "aggregate",
      "source": "memory",
      "mode": "limited",
      "selector": "context reliability R-4: late-negation aggregate",
      "evidenceRefs": [
        "vitest:context-injection-reliability.integration.test.ts#R-4/codex/late-negation/aggregate/memory/limited"
      ],
      "inputHash": "33ae936a3996ca435ec91f887e8a15816fa798d7678436071f4a8f88dc43b46a",
      "returnedText": "",
      "offeredHashes": [],
      "committedHashes": [],
      "verdict": "passed"
    },
    {
      "client": "codex",
      "condition": "late-negation",
      "boundary": "aggregate",
      "source": "corpus",
      "mode": "fits",
      "selector": "context reliability R-4: late-negation aggregate",
      "evidenceRefs": [
        "vitest:context-injection-reliability.integration.test.ts#R-4/codex/late-negation/aggregate/corpus/fits"
      ],
      "inputHash": "9946583750b627c978b9ddf2f5a02018039ed6220336d77cbe4df470cc194d91",
      "returnedText": "## Related context (matched excerpts)\n\n⚠ Retrieval for these pointers was DEGRADED: embedding coverage for 'session_turn' is UNKNOWN (no fresh sample) — treat these as unverified, not healthy; embedding coverage for 'work_item' is UNKNOWN (no fresh sample) — treat these as unverified, not healthy; embedding coverage for 'plan' is UNKNOWN (no fresh sample) — treat these as unverified, not healthy; embedding coverage for 'doc' is UNKNOWN (no fresh sample) — treat these as unverified, not healthy; embedding coverage for 'report' is UNKNOWN (no fresh sample) — treat these as unverified, not healthy.\n\n- [plan plan:query-fixture-harness:operative] source-evidence \"Apply zephyrrepair recovery. Do not apply it to production.\" — plans:get {\"slug\":\"operative\",\"harness\":\"query-fixture-harness\"}",
      "offeredHashes": [
        "f02d8bbf63b15f7bebaaf40f47ae66816cec2ef2f15ce87e411cd5ee7bcec2d8"
      ],
      "committedHashes": [
        "f02d8bbf63b15f7bebaaf40f47ae66816cec2ef2f15ce87e411cd5ee7bcec2d8"
      ],
      "verdict": "passed"
    },
    {
      "client": "codex",
      "condition": "late-negation",
      "boundary": "aggregate",
      "source": "corpus",
      "mode": "limited",
      "selector": "context reliability R-4: late-negation aggregate",
      "evidenceRefs": [
        "vitest:context-injection-reliability.integration.test.ts#R-4/codex/late-negation/aggregate/corpus/limited"
      ],
      "inputHash": "13ebf44ef6edfe655009c1ac7b7d8fc31f9a52fbc9ee3889b734eb664ec2ff2b",
      "returnedText": "",
      "offeredHashes": [],
      "committedHashes": [],
      "verdict": "passed"
    },
    {
      "client": "claude",
      "condition": "late-negation",
      "boundary": "aggregate",
      "source": "memory",
      "mode": "fits",
      "selector": "context reliability R-4: late-negation aggregate",
      "evidenceRefs": [
        "vitest:context-injection-reliability.integration.test.ts#R-4/claude/late-negation/aggregate/memory/fits"
      ],
      "inputHash": "d48162481ac45c0585b393913adab103970c23bb7fda44de89fe925ca970d077",
      "returnedText": "## Operator memory (relevant entries)\n\n- [unknown] (id=11111111-1111-4111-8111-111111111111) source-evidence \"Apply zephyrrepair recovery. Do not apply it to production.\"",
      "offeredHashes": [
        "92d35a67dc9060bf6802bd563c6cfa77311e2cf4e712b91c8591cf00e79e49bc"
      ],
      "committedHashes": [
        "92d35a67dc9060bf6802bd563c6cfa77311e2cf4e712b91c8591cf00e79e49bc"
      ],
      "verdict": "passed"
    },
    {
      "client": "claude",
      "condition": "late-negation",
      "boundary": "aggregate",
      "source": "memory",
      "mode": "limited",
      "selector": "context reliability R-4: late-negation aggregate",
      "evidenceRefs": [
        "vitest:context-injection-reliability.integration.test.ts#R-4/claude/late-negation/aggregate/memory/limited"
      ],
      "inputHash": "896d1c826798dd7ea49724def8f3389e2a9d2dc076e7cbaf96bf664f856bba75",
      "returnedText": "",
      "offeredHashes": [],
      "committedHashes": [],
      "verdict": "passed"
    },
    {
      "client": "claude",
      "condition": "late-negation",
      "boundary": "aggregate",
      "source": "corpus",
      "mode": "fits",
      "selector": "context reliability R-4: late-negation aggregate",
      "evidenceRefs": [
        "vitest:context-injection-reliability.integration.test.ts#R-4/claude/late-negation/aggregate/corpus/fits"
      ],
      "inputHash": "149a946e8b877bf34b46848c3dd58031777e12ec8b026ddac98fac11b4c83595",
      "returnedText": "## Related context (matched excerpts)\n\n⚠ Retrieval for these pointers was DEGRADED: embedding coverage for 'session_turn' is UNKNOWN (no fresh sample) — treat these as unverified, not healthy; embedding coverage for 'work_item' is UNKNOWN (no fresh sample) — treat these as unverified, not healthy; embedding coverage for 'plan' is UNKNOWN (no fresh sample) — treat these as unverified, not healthy; embedding coverage for 'doc' is UNKNOWN (no fresh sample) — treat these as unverified, not healthy; embedding coverage for 'report' is UNKNOWN (no fresh sample) — treat these as unverified, not healthy.\n\n- [plan plan:query-fixture-harness:operative] source-evidence \"Apply zephyrrepair recovery. Do not apply it to production.\" — plans:get {\"slug\":\"operative\",\"harness\":\"query-fixture-harness\"}",
      "offeredHashes": [
        "f02d8bbf63b15f7bebaaf40f47ae66816cec2ef2f15ce87e411cd5ee7bcec2d8"
      ],
      "committedHashes": [
        "f02d8bbf63b15f7bebaaf40f47ae66816cec2ef2f15ce87e411cd5ee7bcec2d8"
      ],
      "verdict": "passed"
    },
    {
      "client": "claude",
      "condition": "late-negation",
      "boundary": "aggregate",
      "source": "corpus",
      "mode": "limited",
      "selector": "context reliability R-4: late-negation aggregate",
      "evidenceRefs": [
        "vitest:context-injection-reliability.integration.test.ts#R-4/claude/late-negation/aggregate/corpus/limited"
      ],
      "inputHash": "b9a36c71aaf2460ac63cce8015e87791cac6b7c85b9f7a5058837b659b5ecb81",
      "returnedText": "",
      "offeredHashes": [],
      "committedHashes": [],
      "verdict": "passed"
    },
    {
      "client": "omp",
      "condition": "late-negation",
      "boundary": "aggregate",
      "source": "memory",
      "mode": "fits",
      "selector": "context reliability R-4: late-negation aggregate",
      "evidenceRefs": [
        "vitest:context-injection-reliability.integration.test.ts#R-4/omp/late-negation/aggregate/memory/fits"
      ],
      "inputHash": "2571a6ac78a911fa5d5e034c5f9b1f52734f9b6212f5d10782544572661853a4",
      "returnedText": "## Operator memory (relevant entries)\n\n- [unknown] (id=11111111-1111-4111-8111-111111111111) source-evidence \"Apply zephyrrepair recovery. Do not apply it to production.\"",
      "offeredHashes": [
        "92d35a67dc9060bf6802bd563c6cfa77311e2cf4e712b91c8591cf00e79e49bc"
      ],
      "committedHashes": [
        "92d35a67dc9060bf6802bd563c6cfa77311e2cf4e712b91c8591cf00e79e49bc"
      ],
      "verdict": "passed"
    },
    {
      "client": "omp",
      "condition": "late-negation",
      "boundary": "aggregate",
      "source": "memory",
      "mode": "limited",
      "selector": "context reliability R-4: late-negation aggregate",
      "evidenceRefs": [
        "vitest:context-injection-reliability.integration.test.ts#R-4/omp/late-negation/aggregate/memory/limited"
      ],
      "inputHash": "d066e00aed69f10b8efa800ef312bcb0299a35a5f4e4c5c1d665c8d48117faa8",
      "returnedText": "",
      "offeredHashes": [],
      "committedHashes": [],
      "verdict": "passed"
    },
    {
      "client": "omp",
      "condition": "late-negation",
      "boundary": "aggregate",
      "source": "corpus",
      "mode": "fits",
      "selector": "context reliability R-4: late-negation aggregate",
      "evidenceRefs": [
        "vitest:context-injection-reliability.integration.test.ts#R-4/omp/late-negation/aggregate/corpus/fits"
      ],
      "inputHash": "9882d5b6c09030d953e664daab74f813360d0f66430c8fa00aac490832c37f0d",
      "returnedText": "## Related context (matched excerpts)\n\n⚠ Retrieval for these pointers was DEGRADED: embedding coverage for 'session_turn' is UNKNOWN (no fresh sample) — treat these as unverified, not healthy; embedding coverage for 'work_item' is UNKNOWN (no fresh sample) — treat these as unverified, not healthy; embedding coverage for 'plan' is UNKNOWN (no fresh sample) — treat these as unverified, not healthy; embedding coverage for 'doc' is UNKNOWN (no fresh sample) — treat these as unverified, not healthy; embedding coverage for 'report' is UNKNOWN (no fresh sample) — treat these as unverified, not healthy.\n\n- [plan plan:query-fixture-harness:operative] source-evidence \"Apply zephyrrepair recovery. Do not apply it to production.\" — plans:get {\"slug\":\"operative\",\"harness\":\"query-fixture-harness\"}",
      "offeredHashes": [
        "f02d8bbf63b15f7bebaaf40f47ae66816cec2ef2f15ce87e411cd5ee7bcec2d8"
      ],
      "committedHashes": [
        "f02d8bbf63b15f7bebaaf40f47ae66816cec2ef2f15ce87e411cd5ee7bcec2d8"
      ],
      "verdict": "passed"
    },
    {
      "client": "omp",
      "condition": "late-negation",
      "boundary": "aggregate",
      "source": "corpus",
      "mode": "limited",
      "selector": "context reliability R-4: late-negation aggregate",
      "evidenceRefs": [
        "vitest:context-injection-reliability.integration.test.ts#R-4/omp/late-negation/aggregate/corpus/limited"
      ],
      "inputHash": "b86d624efe92e411700b05829bb1bbdbc301498a754b0bf077a7d033c99e17e1",
      "returnedText": "",
      "offeredHashes": [],
      "committedHashes": [],
      "verdict": "passed"
    },
    {
      "client": "codex",
      "condition": "approval",
      "boundary": "entry",
      "source": "memory",
      "mode": "fits",
      "selector": "context reliability R-4: approval entry",
      "evidenceRefs": [
        "vitest:context-injection-reliability.integration.test.ts#R-4/codex/approval/entry/memory/fits"
      ],
      "inputHash": "5a7efe8015699d68f3cc45f1a27fa14a0f4a21ce8c73506b9b5672a26a8e7c19",
      "returnedText": "## Operator memory (relevant entries)\n\n- [unknown] (id=11111111-1111-4111-8111-111111111111) source-evidence \"Apply zephyrrepair recovery. Only after explicit approval.\"",
      "offeredHashes": [
        "4893f67fcce6a063bf2571dd0928f1ec4af26cf418589bee7bf3580b86bcca38"
      ],
      "committedHashes": [
        "4893f67fcce6a063bf2571dd0928f1ec4af26cf418589bee7bf3580b86bcca38"
      ],
      "verdict": "passed"
    },
    {
      "client": "codex",
      "condition": "approval",
      "boundary": "entry",
      "source": "memory",
      "mode": "limited",
      "selector": "context reliability R-4: approval entry",
      "evidenceRefs": [
        "vitest:context-injection-reliability.integration.test.ts#R-4/codex/approval/entry/memory/limited"
      ],
      "inputHash": "482d14c13d511a4ca5863a37c4fd408dbd1f4b4c327192e773f043415361994b",
      "returnedText": "## Operator memory (relevant entries)\n\n- [unknown] (id=11111111-1111-4111-8111-111111111111) source-pointer {\"kind\":\"memory\",\"ref\":\"11111111-1111-4111-8111-111111111111\",\"revision\":\"unknown\",\"passage\":\"retrieved-unit\",\"unitHash\":\"365179c71572aee1167c0f531aac49d4d206569e4169525ebfa3514a4d9e80ba\",\"omitted\":true}",
      "offeredHashes": [],
      "committedHashes": [],
      "verdict": "passed"
    },
    {
      "client": "codex",
      "condition": "approval",
      "boundary": "entry",
      "source": "corpus",
      "mode": "fits",
      "selector": "context reliability R-4: approval entry",
      "evidenceRefs": [
        "vitest:context-injection-reliability.integration.test.ts#R-4/codex/approval/entry/corpus/fits"
      ],
      "inputHash": "2f5642c71ec40373dac34154d49278aefe465032a509466d1c5700feac358e3e",
      "returnedText": "## Related context (matched excerpts)\n\n⚠ Retrieval for these pointers was DEGRADED: embedding coverage for 'session_turn' is UNKNOWN (no fresh sample) — treat these as unverified, not healthy; embedding coverage for 'work_item' is UNKNOWN (no fresh sample) — treat these as unverified, not healthy; embedding coverage for 'plan' is UNKNOWN (no fresh sample) — treat these as unverified, not healthy; embedding coverage for 'doc' is UNKNOWN (no fresh sample) — treat these as unverified, not healthy; embedding coverage for 'report' is UNKNOWN (no fresh sample) — treat these as unverified, not healthy.\n\n- [plan plan:query-fixture-harness:operative] source-evidence \"Apply zephyrrepair recovery. Only after explicit approval.\" — plans:get {\"slug\":\"operative\",\"harness\":\"query-fixture-harness\"}",
      "offeredHashes": [
        "042ed4708397173c6cd2bd7843b7f6fb39a1d64c7274f79d2842372c73494d27"
      ],
      "committedHashes": [
        "042ed4708397173c6cd2bd7843b7f6fb39a1d64c7274f79d2842372c73494d27"
      ],
      "verdict": "passed"
    },
    {
      "client": "codex",
      "condition": "approval",
      "boundary": "entry",
      "source": "corpus",
      "mode": "limited",
      "selector": "context reliability R-4: approval entry",
      "evidenceRefs": [
        "vitest:context-injection-reliability.integration.test.ts#R-4/codex/approval/entry/corpus/limited"
      ],
      "inputHash": "ef0f1aca46eb30205ab8b5c2574b7b9730c1d8ee4f382dbc55943fcf77d20ebf",
      "returnedText": "## Related context (matched excerpts)\n\n⚠ Retrieval for these pointers was DEGRADED: embedding coverage for 'session_turn' is UNKNOWN (no fresh sample) — treat these as unverified, not healthy; embedding coverage for 'work_item' is UNKNOWN (no fresh sample) — treat these as unverified, not healthy; embedding coverage for 'plan' is UNKNOWN (no fresh sample) — treat these as unverified, not healthy; embedding coverage for 'doc' is UNKNOWN (no fresh sample) — treat these as unverified, not healthy; embedding coverage for 'report' is UNKNOWN (no fresh sample) — treat these as unverified, not healthy.\n\n- [plan plan:query-fixture-harness:operative] source-pointer {\"kind\":\"plan\",\"ref\":\"plan:query-fixture-harness:operative\",\"link\":\"plans:get {\\\"slug\\\":\\\"operative\\\",\\\"harness\\\":\\\"query-fixture-harness\\\"}\",\"revision\":\"unknown\",\"passage\":\"retrieved-unit\",\"unitHash\":\"365179c71572aee1167c0f531aac49d4d206569e4169525ebfa3514a4d9e80ba\",\"omitted\":true} — plans:get {\"slug\":\"operative\",\"harness\":\"query-fixture-harness\"}",
      "offeredHashes": [],
      "committedHashes": [],
      "verdict": "passed"
    },
    {
      "client": "claude",
      "condition": "approval",
      "boundary": "entry",
      "source": "memory",
      "mode": "fits",
      "selector": "context reliability R-4: approval entry",
      "evidenceRefs": [
        "vitest:context-injection-reliability.integration.test.ts#R-4/claude/approval/entry/memory/fits"
      ],
      "inputHash": "1adbb89af9c819fcb16f143701c267a2a2140c0f70d4dc6b53eb973469ac5cb5",
      "returnedText": "## Operator memory (relevant entries)\n\n- [unknown] (id=11111111-1111-4111-8111-111111111111) source-evidence \"Apply zephyrrepair recovery. Only after explicit approval.\"",
      "offeredHashes": [
        "4893f67fcce6a063bf2571dd0928f1ec4af26cf418589bee7bf3580b86bcca38"
      ],
      "committedHashes": [
        "4893f67fcce6a063bf2571dd0928f1ec4af26cf418589bee7bf3580b86bcca38"
      ],
      "verdict": "passed"
    },
    {
      "client": "claude",
      "condition": "approval",
      "boundary": "entry",
      "source": "memory",
      "mode": "limited",
      "selector": "context reliability R-4: approval entry",
      "evidenceRefs": [
        "vitest:context-injection-reliability.integration.test.ts#R-4/claude/approval/entry/memory/limited"
      ],
      "inputHash": "935aeedffb1a2fdeb75fb10f0cff4be06955e6894ce03da30543953b34a821ea",
      "returnedText": "## Operator memory (relevant entries)\n\n- [unknown] (id=11111111-1111-4111-8111-111111111111) source-pointer {\"kind\":\"memory\",\"ref\":\"11111111-1111-4111-8111-111111111111\",\"revision\":\"unknown\",\"passage\":\"retrieved-unit\",\"unitHash\":\"365179c71572aee1167c0f531aac49d4d206569e4169525ebfa3514a4d9e80ba\",\"omitted\":true}",
      "offeredHashes": [],
      "committedHashes": [],
      "verdict": "passed"
    },
    {
      "client": "claude",
      "condition": "approval",
      "boundary": "entry",
      "source": "corpus",
      "mode": "fits",
      "selector": "context reliability R-4: approval entry",
      "evidenceRefs": [
        "vitest:context-injection-reliability.integration.test.ts#R-4/claude/approval/entry/corpus/fits"
      ],
      "inputHash": "c04c7e14df47b163ff9e7548223c57d1ab96e763bfa2cbeb32b1aa7ec4f3cb06",
      "returnedText": "## Related context (matched excerpts)\n\n⚠ Retrieval for these pointers was DEGRADED: embedding coverage for 'session_turn' is UNKNOWN (no fresh sample) — treat these as unverified, not healthy; embedding coverage for 'work_item' is UNKNOWN (no fresh sample) — treat these as unverified, not healthy; embedding coverage for 'plan' is UNKNOWN (no fresh sample) — treat these as unverified, not healthy; embedding coverage for 'doc' is UNKNOWN (no fresh sample) — treat these as unverified, not healthy; embedding coverage for 'report' is UNKNOWN (no fresh sample) — treat these as unverified, not healthy.\n\n- [plan plan:query-fixture-harness:operative] source-evidence \"Apply zephyrrepair recovery. Only after explicit approval.\" — plans:get {\"slug\":\"operative\",\"harness\":\"query-fixture-harness\"}",
      "offeredHashes": [
        "042ed4708397173c6cd2bd7843b7f6fb39a1d64c7274f79d2842372c73494d27"
      ],
      "committedHashes": [
        "042ed4708397173c6cd2bd7843b7f6fb39a1d64c7274f79d2842372c73494d27"
      ],
      "verdict": "passed"
    },
    {
      "client": "claude",
      "condition": "approval",
      "boundary": "entry",
      "source": "corpus",
      "mode": "limited",
      "selector": "context reliability R-4: approval entry",
      "evidenceRefs": [
        "vitest:context-injection-reliability.integration.test.ts#R-4/claude/approval/entry/corpus/limited"
      ],
      "inputHash": "7205265706d3e92bec2740315c6816a1083ed20fb5bd9a9d8840f4172717b3cc",
      "returnedText": "## Related context (matched excerpts)\n\n⚠ Retrieval for these pointers was DEGRADED: embedding coverage for 'session_turn' is UNKNOWN (no fresh sample) — treat these as unverified, not healthy; embedding coverage for 'work_item' is UNKNOWN (no fresh sample) — treat these as unverified, not healthy; embedding coverage for 'plan' is UNKNOWN (no fresh sample) — treat these as unverified, not healthy; embedding coverage for 'doc' is UNKNOWN (no fresh sample) — treat these as unverified, not healthy; embedding coverage for 'report' is UNKNOWN (no fresh sample) — treat these as unverified, not healthy.\n\n- [plan plan:query-fixture-harness:operative] source-pointer {\"kind\":\"plan\",\"ref\":\"plan:query-fixture-harness:operative\",\"link\":\"plans:get {\\\"slug\\\":\\\"operative\\\",\\\"harness\\\":\\\"query-fixture-harness\\\"}\",\"revision\":\"unknown\",\"passage\":\"retrieved-unit\",\"unitHash\":\"365179c71572aee1167c0f531aac49d4d206569e4169525ebfa3514a4d9e80ba\",\"omitted\":true} — plans:get {\"slug\":\"operative\",\"harness\":\"query-fixture-harness\"}",
      "offeredHashes": [],
      "committedHashes": [],
      "verdict": "passed"
    },
    {
      "client": "omp",
      "condition": "approval",
      "boundary": "entry",
      "source": "memory",
      "mode": "fits",
      "selector": "context reliability R-4: approval entry",
      "evidenceRefs": [
        "vitest:context-injection-reliability.integration.test.ts#R-4/omp/approval/entry/memory/fits"
      ],
      "inputHash": "7ced74d156ab0ecaa7ab339628db770e7228b7734d6c6e74f66ed422c76be712",
      "returnedText": "## Operator memory (relevant entries)\n\n- [unknown] (id=11111111-1111-4111-8111-111111111111) source-evidence \"Apply zephyrrepair recovery. Only after explicit approval.\"",
      "offeredHashes": [
        "4893f67fcce6a063bf2571dd0928f1ec4af26cf418589bee7bf3580b86bcca38"
      ],
      "committedHashes": [
        "4893f67fcce6a063bf2571dd0928f1ec4af26cf418589bee7bf3580b86bcca38"
      ],
      "verdict": "passed"
    },
    {
      "client": "omp",
      "condition": "approval",
      "boundary": "entry",
      "source": "memory",
      "mode": "limited",
      "selector": "context reliability R-4: approval entry",
      "evidenceRefs": [
        "vitest:context-injection-reliability.integration.test.ts#R-4/omp/approval/entry/memory/limited"
      ],
      "inputHash": "17291d65ddfa07bd7559ec7c9fbdbd0b9c86c4cf7f2a28a7f61483a3a844dedb",
      "returnedText": "## Operator memory (relevant entries)\n\n- [unknown] (id=11111111-1111-4111-8111-111111111111) source-pointer {\"kind\":\"memory\",\"ref\":\"11111111-1111-4111-8111-111111111111\",\"revision\":\"unknown\",\"passage\":\"retrieved-unit\",\"unitHash\":\"365179c71572aee1167c0f531aac49d4d206569e4169525ebfa3514a4d9e80ba\",\"omitted\":true}",
      "offeredHashes": [],
      "committedHashes": [],
      "verdict": "passed"
    },
    {
      "client": "omp",
      "condition": "approval",
      "boundary": "entry",
      "source": "corpus",
      "mode": "fits",
      "selector": "context reliability R-4: approval entry",
      "evidenceRefs": [
        "vitest:context-injection-reliability.integration.test.ts#R-4/omp/approval/entry/corpus/fits"
      ],
      "inputHash": "4a0ca7cb360f4d0ac922bf88d3037cb55f1c6e19b2aa4e084c499feb9aa0fab6",
      "returnedText": "## Related context (matched excerpts)\n\n⚠ Retrieval for these pointers was DEGRADED: embedding coverage for 'session_turn' is UNKNOWN (no fresh sample) — treat these as unverified, not healthy; embedding coverage for 'work_item' is UNKNOWN (no fresh sample) — treat these as unverified, not healthy; embedding coverage for 'plan' is UNKNOWN (no fresh sample) — treat these as unverified, not healthy; embedding coverage for 'doc' is UNKNOWN (no fresh sample) — treat these as unverified, not healthy; embedding coverage for 'report' is UNKNOWN (no fresh sample) — treat these as unverified, not healthy.\n\n- [plan plan:query-fixture-harness:operative] source-evidence \"Apply zephyrrepair recovery. Only after explicit approval.\" — plans:get {\"slug\":\"operative\",\"harness\":\"query-fixture-harness\"}",
      "offeredHashes": [
        "042ed4708397173c6cd2bd7843b7f6fb39a1d64c7274f79d2842372c73494d27"
      ],
      "committedHashes": [
        "042ed4708397173c6cd2bd7843b7f6fb39a1d64c7274f79d2842372c73494d27"
      ],
      "verdict": "passed"
    },
    {
      "client": "omp",
      "condition": "approval",
      "boundary": "entry",
      "source": "corpus",
      "mode": "limited",
      "selector": "context reliability R-4: approval entry",
      "evidenceRefs": [
        "vitest:context-injection-reliability.integration.test.ts#R-4/omp/approval/entry/corpus/limited"
      ],
      "inputHash": "fd0b74b2eac2955c01a20d0356ce98801ffd525f38471e120407fd1464f1c9a5",
      "returnedText": "## Related context (matched excerpts)\n\n⚠ Retrieval for these pointers was DEGRADED: embedding coverage for 'session_turn' is UNKNOWN (no fresh sample) — treat these as unverified, not healthy; embedding coverage for 'work_item' is UNKNOWN (no fresh sample) — treat these as unverified, not healthy; embedding coverage for 'plan' is UNKNOWN (no fresh sample) — treat these as unverified, not healthy; embedding coverage for 'doc' is UNKNOWN (no fresh sample) — treat these as unverified, not healthy; embedding coverage for 'report' is UNKNOWN (no fresh sample) — treat these as unverified, not healthy.\n\n- [plan plan:query-fixture-harness:operative] source-pointer {\"kind\":\"plan\",\"ref\":\"plan:query-fixture-harness:operative\",\"link\":\"plans:get {\\\"slug\\\":\\\"operative\\\",\\\"harness\\\":\\\"query-fixture-harness\\\"}\",\"revision\":\"unknown\",\"passage\":\"retrieved-unit\",\"unitHash\":\"365179c71572aee1167c0f531aac49d4d206569e4169525ebfa3514a4d9e80ba\",\"omitted\":true} — plans:get {\"slug\":\"operative\",\"harness\":\"query-fixture-harness\"}",
      "offeredHashes": [],
      "committedHashes": [],
      "verdict": "passed"
    },
    {
      "client": "codex",
      "condition": "approval",
      "boundary": "aggregate",
      "source": "memory",
      "mode": "fits",
      "selector": "context reliability R-4: approval aggregate",
      "evidenceRefs": [
        "vitest:context-injection-reliability.integration.test.ts#R-4/codex/approval/aggregate/memory/fits"
      ],
      "inputHash": "3945fdc7e28c2b6401ef90b12c074f1544fef152f0d36730fb60bbe067f7c4c9",
      "returnedText": "## Operator memory (relevant entries)\n\n- [unknown] (id=11111111-1111-4111-8111-111111111111) source-evidence \"Apply zephyrrepair recovery. Only after explicit approval.\"",
      "offeredHashes": [
        "4893f67fcce6a063bf2571dd0928f1ec4af26cf418589bee7bf3580b86bcca38"
      ],
      "committedHashes": [
        "4893f67fcce6a063bf2571dd0928f1ec4af26cf418589bee7bf3580b86bcca38"
      ],
      "verdict": "passed"
    },
    {
      "client": "codex",
      "condition": "approval",
      "boundary": "aggregate",
      "source": "memory",
      "mode": "limited",
      "selector": "context reliability R-4: approval aggregate",
      "evidenceRefs": [
        "vitest:context-injection-reliability.integration.test.ts#R-4/codex/approval/aggregate/memory/limited"
      ],
      "inputHash": "a55a75e97fecc5db379afe785eaf1d346d30ff740a871a24e2b6f8eb95b9b6d5",
      "returnedText": "",
      "offeredHashes": [],
      "committedHashes": [],
      "verdict": "passed"
    },
    {
      "client": "codex",
      "condition": "approval",
      "boundary": "aggregate",
      "source": "corpus",
      "mode": "fits",
      "selector": "context reliability R-4: approval aggregate",
      "evidenceRefs": [
        "vitest:context-injection-reliability.integration.test.ts#R-4/codex/approval/aggregate/corpus/fits"
      ],
      "inputHash": "427f272d382314f95bda01b7bda0591cdfd2ed53da20e3f6d71ba80daff0b73b",
      "returnedText": "## Related context (matched excerpts)\n\n⚠ Retrieval for these pointers was DEGRADED: embedding coverage for 'session_turn' is UNKNOWN (no fresh sample) — treat these as unverified, not healthy; embedding coverage for 'work_item' is UNKNOWN (no fresh sample) — treat these as unverified, not healthy; embedding coverage for 'plan' is UNKNOWN (no fresh sample) — treat these as unverified, not healthy; embedding coverage for 'doc' is UNKNOWN (no fresh sample) — treat these as unverified, not healthy; embedding coverage for 'report' is UNKNOWN (no fresh sample) — treat these as unverified, not healthy.\n\n- [plan plan:query-fixture-harness:operative] source-evidence \"Apply zephyrrepair recovery. Only after explicit approval.\" — plans:get {\"slug\":\"operative\",\"harness\":\"query-fixture-harness\"}",
      "offeredHashes": [
        "042ed4708397173c6cd2bd7843b7f6fb39a1d64c7274f79d2842372c73494d27"
      ],
      "committedHashes": [
        "042ed4708397173c6cd2bd7843b7f6fb39a1d64c7274f79d2842372c73494d27"
      ],
      "verdict": "passed"
    },
    {
      "client": "codex",
      "condition": "approval",
      "boundary": "aggregate",
      "source": "corpus",
      "mode": "limited",
      "selector": "context reliability R-4: approval aggregate",
      "evidenceRefs": [
        "vitest:context-injection-reliability.integration.test.ts#R-4/codex/approval/aggregate/corpus/limited"
      ],
      "inputHash": "0448b1a8146614555dd1817518f9c83e0713e81b50c6ab1868d1d568ed54eca8",
      "returnedText": "",
      "offeredHashes": [],
      "committedHashes": [],
      "verdict": "passed"
    },
    {
      "client": "claude",
      "condition": "approval",
      "boundary": "aggregate",
      "source": "memory",
      "mode": "fits",
      "selector": "context reliability R-4: approval aggregate",
      "evidenceRefs": [
        "vitest:context-injection-reliability.integration.test.ts#R-4/claude/approval/aggregate/memory/fits"
      ],
      "inputHash": "99bec84a3d69a1b62a71e6d40f24d0e10501cf590bcb3a54e5054042e4587dba",
      "returnedText": "## Operator memory (relevant entries)\n\n- [unknown] (id=11111111-1111-4111-8111-111111111111) source-evidence \"Apply zephyrrepair recovery. Only after explicit approval.\"",
      "offeredHashes": [
        "4893f67fcce6a063bf2571dd0928f1ec4af26cf418589bee7bf3580b86bcca38"
      ],
      "committedHashes": [
        "4893f67fcce6a063bf2571dd0928f1ec4af26cf418589bee7bf3580b86bcca38"
      ],
      "verdict": "passed"
    },
    {
      "client": "claude",
      "condition": "approval",
      "boundary": "aggregate",
      "source": "memory",
      "mode": "limited",
      "selector": "context reliability R-4: approval aggregate",
      "evidenceRefs": [
        "vitest:context-injection-reliability.integration.test.ts#R-4/claude/approval/aggregate/memory/limited"
      ],
      "inputHash": "f765d18f1ebcb13eecffed76a42fa4798a069843fa5894c35147af2bfa24479c",
      "returnedText": "",
      "offeredHashes": [],
      "committedHashes": [],
      "verdict": "passed"
    },
    {
      "client": "claude",
      "condition": "approval",
      "boundary": "aggregate",
      "source": "corpus",
      "mode": "fits",
      "selector": "context reliability R-4: approval aggregate",
      "evidenceRefs": [
        "vitest:context-injection-reliability.integration.test.ts#R-4/claude/approval/aggregate/corpus/fits"
      ],
      "inputHash": "62fcc763296b7cc4cce7d364c08692335c3baacec4c4d5989b6cf53f74f1764b",
      "returnedText": "## Related context (matched excerpts)\n\n⚠ Retrieval for these pointers was DEGRADED: embedding coverage for 'session_turn' is UNKNOWN (no fresh sample) — treat these as unverified, not healthy; embedding coverage for 'work_item' is UNKNOWN (no fresh sample) — treat these as unverified, not healthy; embedding coverage for 'plan' is UNKNOWN (no fresh sample) — treat these as unverified, not healthy; embedding coverage for 'doc' is UNKNOWN (no fresh sample) — treat these as unverified, not healthy; embedding coverage for 'report' is UNKNOWN (no fresh sample) — treat these as unverified, not healthy.\n\n- [plan plan:query-fixture-harness:operative] source-evidence \"Apply zephyrrepair recovery. Only after explicit approval.\" — plans:get {\"slug\":\"operative\",\"harness\":\"query-fixture-harness\"}",
      "offeredHashes": [
        "042ed4708397173c6cd2bd7843b7f6fb39a1d64c7274f79d2842372c73494d27"
      ],
      "committedHashes": [
        "042ed4708397173c6cd2bd7843b7f6fb39a1d64c7274f79d2842372c73494d27"
      ],
      "verdict": "passed"
    },
    {
      "client": "claude",
      "condition": "approval",
      "boundary": "aggregate",
      "source": "corpus",
      "mode": "limited",
      "selector": "context reliability R-4: approval aggregate",
      "evidenceRefs": [
        "vitest:context-injection-reliability.integration.test.ts#R-4/claude/approval/aggregate/corpus/limited"
      ],
      "inputHash": "591c2f5c6a181559d5e440e995f95d8532b466c465ff5e184f844de489d3b0a1",
      "returnedText": "",
      "offeredHashes": [],
      "committedHashes": [],
      "verdict": "passed"
    },
    {
      "client": "omp",
      "condition": "approval",
      "boundary": "aggregate",
      "source": "memory",
      "mode": "fits",
      "selector": "context reliability R-4: approval aggregate",
      "evidenceRefs": [
        "vitest:context-injection-reliability.integration.test.ts#R-4/omp/approval/aggregate/memory/fits"
      ],
      "inputHash": "913f201634d04d5276aabdee0f2c257542e5ce466c6b5e518a851b48d7c795b3",
      "returnedText": "## Operator memory (relevant entries)\n\n- [unknown] (id=11111111-1111-4111-8111-111111111111) source-evidence \"Apply zephyrrepair recovery. Only after explicit approval.\"",
      "offeredHashes": [
        "4893f67fcce6a063bf2571dd0928f1ec4af26cf418589bee7bf3580b86bcca38"
      ],
      "committedHashes": [
        "4893f67fcce6a063bf2571dd0928f1ec4af26cf418589bee7bf3580b86bcca38"
      ],
      "verdict": "passed"
    },
    {
      "client": "omp",
      "condition": "approval",
      "boundary": "aggregate",
      "source": "memory",
      "mode": "limited",
      "selector": "context reliability R-4: approval aggregate",
      "evidenceRefs": [
        "vitest:context-injection-reliability.integration.test.ts#R-4/omp/approval/aggregate/memory/limited"
      ],
      "inputHash": "e5f5fac41c9b0e4f593fbac9f1075ae0e56ef65276c2e1772dbe33325952bd9a",
      "returnedText": "",
      "offeredHashes": [],
      "committedHashes": [],
      "verdict": "passed"
    },
    {
      "client": "omp",
      "condition": "approval",
      "boundary": "aggregate",
      "source": "corpus",
      "mode": "fits",
      "selector": "context reliability R-4: approval aggregate",
      "evidenceRefs": [
        "vitest:context-injection-reliability.integration.test.ts#R-4/omp/approval/aggregate/corpus/fits"
      ],
      "inputHash": "e2949e1497bb582608a0f6e66c78e4a1a39f2a679a386baa0177d0f6cd0c56da",
      "returnedText": "## Related context (matched excerpts)\n\n⚠ Retrieval for these pointers was DEGRADED: embedding coverage for 'session_turn' is UNKNOWN (no fresh sample) — treat these as unverified, not healthy; embedding coverage for 'work_item' is UNKNOWN (no fresh sample) — treat these as unverified, not healthy; embedding coverage for 'plan' is UNKNOWN (no fresh sample) — treat these as unverified, not healthy; embedding coverage for 'doc' is UNKNOWN (no fresh sample) — treat these as unverified, not healthy; embedding coverage for 'report' is UNKNOWN (no fresh sample) — treat these as unverified, not healthy.\n\n- [plan plan:query-fixture-harness:operative] source-evidence \"Apply zephyrrepair recovery. Only after explicit approval.\" — plans:get {\"slug\":\"operative\",\"harness\":\"query-fixture-harness\"}",
      "offeredHashes": [
        "042ed4708397173c6cd2bd7843b7f6fb39a1d64c7274f79d2842372c73494d27"
      ],
      "committedHashes": [
        "042ed4708397173c6cd2bd7843b7f6fb39a1d64c7274f79d2842372c73494d27"
      ],
      "verdict": "passed"
    },
    {
      "client": "omp",
      "condition": "approval",
      "boundary": "aggregate",
      "source": "corpus",
      "mode": "limited",
      "selector": "context reliability R-4: approval aggregate",
      "evidenceRefs": [
        "vitest:context-injection-reliability.integration.test.ts#R-4/omp/approval/aggregate/corpus/limited"
      ],
      "inputHash": "f6c2e2d70a9f0a5ebb57b3cbc946d1cc0a20907cdd9a4507d1cc90ff78f65be8",
      "returnedText": "",
      "offeredHashes": [],
      "committedHashes": [],
      "verdict": "passed"
    },
    {
      "client": "codex",
      "condition": "exception",
      "boundary": "entry",
      "source": "memory",
      "mode": "fits",
      "selector": "context reliability R-4: exception entry",
      "evidenceRefs": [
        "vitest:context-injection-reliability.integration.test.ts#R-4/codex/exception/entry/memory/fits"
      ],
      "inputHash": "8a5512b9d3d3c2827e014eac78ca4aee791228f8d83f27bedffb5d3a34b42ac9",
      "returnedText": "## Operator memory (relevant entries)\n\n- [unknown] (id=11111111-1111-4111-8111-111111111111) source-evidence \"Apply zephyrrepair recovery. Except when the source is read-only.\"",
      "offeredHashes": [
        "2cc4b30cdbd6b88432ba665c23386406874474a667b0f781908c5230e3aeae19"
      ],
      "committedHashes": [
        "2cc4b30cdbd6b88432ba665c23386406874474a667b0f781908c5230e3aeae19"
      ],
      "verdict": "passed"
    },
    {
      "client": "codex",
      "condition": "exception",
      "boundary": "entry",
      "source": "memory",
      "mode": "limited",
      "selector": "context reliability R-4: exception entry",
      "evidenceRefs": [
        "vitest:context-injection-reliability.integration.test.ts#R-4/codex/exception/entry/memory/limited"
      ],
      "inputHash": "8ab59f5abb8ee0a263d4bc0b01f4f1fe62ea0394d060091cc20a8769029265de",
      "returnedText": "## Operator memory (relevant entries)\n\n- [unknown] (id=11111111-1111-4111-8111-111111111111) source-pointer {\"kind\":\"memory\",\"ref\":\"11111111-1111-4111-8111-111111111111\",\"revision\":\"unknown\",\"passage\":\"retrieved-unit\",\"unitHash\":\"9714766f87ac22b72607db273b731ddcc9a40913fc542ea9688d4162d8e252d7\",\"omitted\":true}",
      "offeredHashes": [],
      "committedHashes": [],
      "verdict": "passed"
    },
    {
      "client": "codex",
      "condition": "exception",
      "boundary": "entry",
      "source": "corpus",
      "mode": "fits",
      "selector": "context reliability R-4: exception entry",
      "evidenceRefs": [
        "vitest:context-injection-reliability.integration.test.ts#R-4/codex/exception/entry/corpus/fits"
      ],
      "inputHash": "9e9f4f78ac0f75f727f4fd7c92f4ecf1220780713beac3cab2704146454252cd",
      "returnedText": "## Related context (matched excerpts)\n\n⚠ Retrieval for these pointers was DEGRADED: embedding coverage for 'session_turn' is UNKNOWN (no fresh sample) — treat these as unverified, not healthy; embedding coverage for 'work_item' is UNKNOWN (no fresh sample) — treat these as unverified, not healthy; embedding coverage for 'plan' is UNKNOWN (no fresh sample) — treat these as unverified, not healthy; embedding coverage for 'doc' is UNKNOWN (no fresh sample) — treat these as unverified, not healthy; embedding coverage for 'report' is UNKNOWN (no fresh sample) — treat these as unverified, not healthy.\n\n- [plan plan:query-fixture-harness:operative] source-evidence \"Apply zephyrrepair recovery. Except when the source is read-only.\" — plans:get {\"slug\":\"operative\",\"harness\":\"query-fixture-harness\"}",
      "offeredHashes": [
        "114ecdcaaa759473c8e2e723af8a4542d71c47121e7244f33eaaad667ffb6a24"
      ],
      "committedHashes": [
        "114ecdcaaa759473c8e2e723af8a4542d71c47121e7244f33eaaad667ffb6a24"
      ],
      "verdict": "passed"
    },
    {
      "client": "codex",
      "condition": "exception",
      "boundary": "entry",
      "source": "corpus",
      "mode": "limited",
      "selector": "context reliability R-4: exception entry",
      "evidenceRefs": [
        "vitest:context-injection-reliability.integration.test.ts#R-4/codex/exception/entry/corpus/limited"
      ],
      "inputHash": "c60a88a9c6f34334e5ffd26a3244436770170771dda7697ff36edae8b973f50d",
      "returnedText": "## Related context (matched excerpts)\n\n⚠ Retrieval for these pointers was DEGRADED: embedding coverage for 'session_turn' is UNKNOWN (no fresh sample) — treat these as unverified, not healthy; embedding coverage for 'work_item' is UNKNOWN (no fresh sample) — treat these as unverified, not healthy; embedding coverage for 'plan' is UNKNOWN (no fresh sample) — treat these as unverified, not healthy; embedding coverage for 'doc' is UNKNOWN (no fresh sample) — treat these as unverified, not healthy; embedding coverage for 'report' is UNKNOWN (no fresh sample) — treat these as unverified, not healthy.\n\n- [plan plan:query-fixture-harness:operative] source-pointer {\"kind\":\"plan\",\"ref\":\"plan:query-fixture-harness:operative\",\"link\":\"plans:get {\\\"slug\\\":\\\"operative\\\",\\\"harness\\\":\\\"query-fixture-harness\\\"}\",\"revision\":\"unknown\",\"passage\":\"retrieved-unit\",\"unitHash\":\"9714766f87ac22b72607db273b731ddcc9a40913fc542ea9688d4162d8e252d7\",\"omitted\":true} — plans:get {\"slug\":\"operative\",\"harness\":\"query-fixture-harness\"}",
      "offeredHashes": [],
      "committedHashes": [],
      "verdict": "passed"
    },
    {
      "client": "claude",
      "condition": "exception",
      "boundary": "entry",
      "source": "memory",
      "mode": "fits",
      "selector": "context reliability R-4: exception entry",
      "evidenceRefs": [
        "vitest:context-injection-reliability.integration.test.ts#R-4/claude/exception/entry/memory/fits"
      ],
      "inputHash": "8adc021b6e80763c4d705832ab83a3161573387c5ce076c2d6069afd8bba22ae",
      "returnedText": "## Operator memory (relevant entries)\n\n- [unknown] (id=11111111-1111-4111-8111-111111111111) source-evidence \"Apply zephyrrepair recovery. Except when the source is read-only.\"",
      "offeredHashes": [
        "2cc4b30cdbd6b88432ba665c23386406874474a667b0f781908c5230e3aeae19"
      ],
      "committedHashes": [
        "2cc4b30cdbd6b88432ba665c23386406874474a667b0f781908c5230e3aeae19"
      ],
      "verdict": "passed"
    },
    {
      "client": "claude",
      "condition": "exception",
      "boundary": "entry",
      "source": "memory",
      "mode": "limited",
      "selector": "context reliability R-4: exception entry",
      "evidenceRefs": [
        "vitest:context-injection-reliability.integration.test.ts#R-4/claude/exception/entry/memory/limited"
      ],
      "inputHash": "e1cc9f926311919e3787dbd7045284cb45080d5a0461b505fd4ea234bde89a2d",
      "returnedText": "## Operator memory (relevant entries)\n\n- [unknown] (id=11111111-1111-4111-8111-111111111111) source-pointer {\"kind\":\"memory\",\"ref\":\"11111111-1111-4111-8111-111111111111\",\"revision\":\"unknown\",\"passage\":\"retrieved-unit\",\"unitHash\":\"9714766f87ac22b72607db273b731ddcc9a40913fc542ea9688d4162d8e252d7\",\"omitted\":true}",
      "offeredHashes": [],
      "committedHashes": [],
      "verdict": "passed"
    },
    {
      "client": "claude",
      "condition": "exception",
      "boundary": "entry",
      "source": "corpus",
      "mode": "fits",
      "selector": "context reliability R-4: exception entry",
      "evidenceRefs": [
        "vitest:context-injection-reliability.integration.test.ts#R-4/claude/exception/entry/corpus/fits"
      ],
      "inputHash": "83da44ee5f9838d57ba0e745dc9582c395543166fbb67e64c2dce488502295c8",
      "returnedText": "## Related context (matched excerpts)\n\n⚠ Retrieval for these pointers was DEGRADED: embedding coverage for 'session_turn' is UNKNOWN (no fresh sample) — treat these as unverified, not healthy; embedding coverage for 'work_item' is UNKNOWN (no fresh sample) — treat these as unverified, not healthy; embedding coverage for 'plan' is UNKNOWN (no fresh sample) — treat these as unverified, not healthy; embedding coverage for 'doc' is UNKNOWN (no fresh sample) — treat these as unverified, not healthy; embedding coverage for 'report' is UNKNOWN (no fresh sample) — treat these as unverified, not healthy.\n\n- [plan plan:query-fixture-harness:operative] source-evidence \"Apply zephyrrepair recovery. Except when the source is read-only.\" — plans:get {\"slug\":\"operative\",\"harness\":\"query-fixture-harness\"}",
      "offeredHashes": [
        "114ecdcaaa759473c8e2e723af8a4542d71c47121e7244f33eaaad667ffb6a24"
      ],
      "committedHashes": [
        "114ecdcaaa759473c8e2e723af8a4542d71c47121e7244f33eaaad667ffb6a24"
      ],
      "verdict": "passed"
    },
    {
      "client": "claude",
      "condition": "exception",
      "boundary": "entry",
      "source": "corpus",
      "mode": "limited",
      "selector": "context reliability R-4: exception entry",
      "evidenceRefs": [
        "vitest:context-injection-reliability.integration.test.ts#R-4/claude/exception/entry/corpus/limited"
      ],
      "inputHash": "faba978211221059625e611e6ea1b22f1de55d20767a30b736bc4b4809b8d851",
      "returnedText": "## Related context (matched excerpts)\n\n⚠ Retrieval for these pointers was DEGRADED: embedding coverage for 'session_turn' is UNKNOWN (no fresh sample) — treat these as unverified, not healthy; embedding coverage for 'work_item' is UNKNOWN (no fresh sample) — treat these as unverified, not healthy; embedding coverage for 'plan' is UNKNOWN (no fresh sample) — treat these as unverified, not healthy; embedding coverage for 'doc' is UNKNOWN (no fresh sample) — treat these as unverified, not healthy; embedding coverage for 'report' is UNKNOWN (no fresh sample) — treat these as unverified, not healthy.\n\n- [plan plan:query-fixture-harness:operative] source-pointer {\"kind\":\"plan\",\"ref\":\"plan:query-fixture-harness:operative\",\"link\":\"plans:get {\\\"slug\\\":\\\"operative\\\",\\\"harness\\\":\\\"query-fixture-harness\\\"}\",\"revision\":\"unknown\",\"passage\":\"retrieved-unit\",\"unitHash\":\"9714766f87ac22b72607db273b731ddcc9a40913fc542ea9688d4162d8e252d7\",\"omitted\":true} — plans:get {\"slug\":\"operative\",\"harness\":\"query-fixture-harness\"}",
      "offeredHashes": [],
      "committedHashes": [],
      "verdict": "passed"
    },
    {
      "client": "omp",
      "condition": "exception",
      "boundary": "entry",
      "source": "memory",
      "mode": "fits",
      "selector": "context reliability R-4: exception entry",
      "evidenceRefs": [
        "vitest:context-injection-reliability.integration.test.ts#R-4/omp/exception/entry/memory/fits"
      ],
      "inputHash": "14153d02b214467314412258bf430afdf134fb2b7022fea38a20d281b0299db9",
      "returnedText": "## Operator memory (relevant entries)\n\n- [unknown] (id=11111111-1111-4111-8111-111111111111) source-evidence \"Apply zephyrrepair recovery. Except when the source is read-only.\"",
      "offeredHashes": [
        "2cc4b30cdbd6b88432ba665c23386406874474a667b0f781908c5230e3aeae19"
      ],
      "committedHashes": [
        "2cc4b30cdbd6b88432ba665c23386406874474a667b0f781908c5230e3aeae19"
      ],
      "verdict": "passed"
    },
    {
      "client": "omp",
      "condition": "exception",
      "boundary": "entry",
      "source": "memory",
      "mode": "limited",
      "selector": "context reliability R-4: exception entry",
      "evidenceRefs": [
        "vitest:context-injection-reliability.integration.test.ts#R-4/omp/exception/entry/memory/limited"
      ],
      "inputHash": "dea0e6380a8d38556fb6ef9765230c856c9c4d8c21322e8bf5f9a87bacd5001d",
      "returnedText": "## Operator memory (relevant entries)\n\n- [unknown] (id=11111111-1111-4111-8111-111111111111) source-pointer {\"kind\":\"memory\",\"ref\":\"11111111-1111-4111-8111-111111111111\",\"revision\":\"unknown\",\"passage\":\"retrieved-unit\",\"unitHash\":\"9714766f87ac22b72607db273b731ddcc9a40913fc542ea9688d4162d8e252d7\",\"omitted\":true}",
      "offeredHashes": [],
      "committedHashes": [],
      "verdict": "passed"
    },
    {
      "client": "omp",
      "condition": "exception",
      "boundary": "entry",
      "source": "corpus",
      "mode": "fits",
      "selector": "context reliability R-4: exception entry",
      "evidenceRefs": [
        "vitest:context-injection-reliability.integration.test.ts#R-4/omp/exception/entry/corpus/fits"
      ],
      "inputHash": "18664182535c49a2c707d9afafc52f1fca7391289fb4b644a5844208fa36a6fe",
      "returnedText": "## Related context (matched excerpts)\n\n⚠ Retrieval for these pointers was DEGRADED: embedding coverage for 'session_turn' is UNKNOWN (no fresh sample) — treat these as unverified, not healthy; embedding coverage for 'work_item' is UNKNOWN (no fresh sample) — treat these as unverified, not healthy; embedding coverage for 'plan' is UNKNOWN (no fresh sample) — treat these as unverified, not healthy; embedding coverage for 'doc' is UNKNOWN (no fresh sample) — treat these as unverified, not healthy; embedding coverage for 'report' is UNKNOWN (no fresh sample) — treat these as unverified, not healthy.\n\n- [plan plan:query-fixture-harness:operative] source-evidence \"Apply zephyrrepair recovery. Except when the source is read-only.\" — plans:get {\"slug\":\"operative\",\"harness\":\"query-fixture-harness\"}",
      "offeredHashes": [
        "114ecdcaaa759473c8e2e723af8a4542d71c47121e7244f33eaaad667ffb6a24"
      ],
      "committedHashes": [
        "114ecdcaaa759473c8e2e723af8a4542d71c47121e7244f33eaaad667ffb6a24"
      ],
      "verdict": "passed"
    },
    {
      "client": "omp",
      "condition": "exception",
      "boundary": "entry",
      "source": "corpus",
      "mode": "limited",
      "selector": "context reliability R-4: exception entry",
      "evidenceRefs": [
        "vitest:context-injection-reliability.integration.test.ts#R-4/omp/exception/entry/corpus/limited"
      ],
      "inputHash": "73cd4b7076984edb4731a04074360b1a32f54bfa92c264fe481d0699dd72afb3",
      "returnedText": "## Related context (matched excerpts)\n\n⚠ Retrieval for these pointers was DEGRADED: embedding coverage for 'session_turn' is UNKNOWN (no fresh sample) — treat these as unverified, not healthy; embedding coverage for 'work_item' is UNKNOWN (no fresh sample) — treat these as unverified, not healthy; embedding coverage for 'plan' is UNKNOWN (no fresh sample) — treat these as unverified, not healthy; embedding coverage for 'doc' is UNKNOWN (no fresh sample) — treat these as unverified, not healthy; embedding coverage for 'report' is UNKNOWN (no fresh sample) — treat these as unverified, not healthy.\n\n- [plan plan:query-fixture-harness:operative] source-pointer {\"kind\":\"plan\",\"ref\":\"plan:query-fixture-harness:operative\",\"link\":\"plans:get {\\\"slug\\\":\\\"operative\\\",\\\"harness\\\":\\\"query-fixture-harness\\\"}\",\"revision\":\"unknown\",\"passage\":\"retrieved-unit\",\"unitHash\":\"9714766f87ac22b72607db273b731ddcc9a40913fc542ea9688d4162d8e252d7\",\"omitted\":true} — plans:get {\"slug\":\"operative\",\"harness\":\"query-fixture-harness\"}",
      "offeredHashes": [],
      "committedHashes": [],
      "verdict": "passed"
    },
    {
      "client": "codex",
      "condition": "exception",
      "boundary": "aggregate",
      "source": "memory",
      "mode": "fits",
      "selector": "context reliability R-4: exception aggregate",
      "evidenceRefs": [
        "vitest:context-injection-reliability.integration.test.ts#R-4/codex/exception/aggregate/memory/fits"
      ],
      "inputHash": "cc8fce511fed116aecad3c560a5b52b7f0acdebdc9a4141d789e1e9da9e781f2",
      "returnedText": "## Operator memory (relevant entries)\n\n- [unknown] (id=11111111-1111-4111-8111-111111111111) source-evidence \"Apply zephyrrepair recovery. Except when the source is read-only.\"",
      "offeredHashes": [
        "2cc4b30cdbd6b88432ba665c23386406874474a667b0f781908c5230e3aeae19"
      ],
      "committedHashes": [
        "2cc4b30cdbd6b88432ba665c23386406874474a667b0f781908c5230e3aeae19"
      ],
      "verdict": "passed"
    },
    {
      "client": "codex",
      "condition": "exception",
      "boundary": "aggregate",
      "source": "memory",
      "mode": "limited",
      "selector": "context reliability R-4: exception aggregate",
      "evidenceRefs": [
        "vitest:context-injection-reliability.integration.test.ts#R-4/codex/exception/aggregate/memory/limited"
      ],
      "inputHash": "cf5a064adf269c911b58d4d39a63b1d19314b27d47feb6d6da33b2db317f19b2",
      "returnedText": "",
      "offeredHashes": [],
      "committedHashes": [],
      "verdict": "passed"
    },
    {
      "client": "codex",
      "condition": "exception",
      "boundary": "aggregate",
      "source": "corpus",
      "mode": "fits",
      "selector": "context reliability R-4: exception aggregate",
      "evidenceRefs": [
        "vitest:context-injection-reliability.integration.test.ts#R-4/codex/exception/aggregate/corpus/fits"
      ],
      "inputHash": "39a3985153feea2d13cde7418094301ae7c73df710fe919f6e40b500a8ab7dc9",
      "returnedText": "## Related context (matched excerpts)\n\n⚠ Retrieval for these pointers was DEGRADED: embedding coverage for 'session_turn' is UNKNOWN (no fresh sample) — treat these as unverified, not healthy; embedding coverage for 'work_item' is UNKNOWN (no fresh sample) — treat these as unverified, not healthy; embedding coverage for 'plan' is UNKNOWN (no fresh sample) — treat these as unverified, not healthy; embedding coverage for 'doc' is UNKNOWN (no fresh sample) — treat these as unverified, not healthy; embedding coverage for 'report' is UNKNOWN (no fresh sample) — treat these as unverified, not healthy.\n\n- [plan plan:query-fixture-harness:operative] source-evidence \"Apply zephyrrepair recovery. Except when the source is read-only.\" — plans:get {\"slug\":\"operative\",\"harness\":\"query-fixture-harness\"}",
      "offeredHashes": [
        "114ecdcaaa759473c8e2e723af8a4542d71c47121e7244f33eaaad667ffb6a24"
      ],
      "committedHashes": [
        "114ecdcaaa759473c8e2e723af8a4542d71c47121e7244f33eaaad667ffb6a24"
      ],
      "verdict": "passed"
    },
    {
      "client": "codex",
      "condition": "exception",
      "boundary": "aggregate",
      "source": "corpus",
      "mode": "limited",
      "selector": "context reliability R-4: exception aggregate",
      "evidenceRefs": [
        "vitest:context-injection-reliability.integration.test.ts#R-4/codex/exception/aggregate/corpus/limited"
      ],
      "inputHash": "172f60f6a89d6a9f1cc92d0960fc8e4a07fc950574f6d01c34800a460f3add7b",
      "returnedText": "",
      "offeredHashes": [],
      "committedHashes": [],
      "verdict": "passed"
    },
    {
      "client": "claude",
      "condition": "exception",
      "boundary": "aggregate",
      "source": "memory",
      "mode": "fits",
      "selector": "context reliability R-4: exception aggregate",
      "evidenceRefs": [
        "vitest:context-injection-reliability.integration.test.ts#R-4/claude/exception/aggregate/memory/fits"
      ],
      "inputHash": "feddf083f0a9db5fc9e78b74b0b854d71793aa6734280cda6845ea92bc45df29",
      "returnedText": "## Operator memory (relevant entries)\n\n- [unknown] (id=11111111-1111-4111-8111-111111111111) source-evidence \"Apply zephyrrepair recovery. Except when the source is read-only.\"",
      "offeredHashes": [
        "2cc4b30cdbd6b88432ba665c23386406874474a667b0f781908c5230e3aeae19"
      ],
      "committedHashes": [
        "2cc4b30cdbd6b88432ba665c23386406874474a667b0f781908c5230e3aeae19"
      ],
      "verdict": "passed"
    },
    {
      "client": "claude",
      "condition": "exception",
      "boundary": "aggregate",
      "source": "memory",
      "mode": "limited",
      "selector": "context reliability R-4: exception aggregate",
      "evidenceRefs": [
        "vitest:context-injection-reliability.integration.test.ts#R-4/claude/exception/aggregate/memory/limited"
      ],
      "inputHash": "93e101250bc81950ea485d151803a9daf19039bd39a908a6ed6788fba0de1a46",
      "returnedText": "",
      "offeredHashes": [],
      "committedHashes": [],
      "verdict": "passed"
    },
    {
      "client": "claude",
      "condition": "exception",
      "boundary": "aggregate",
      "source": "corpus",
      "mode": "fits",
      "selector": "context reliability R-4: exception aggregate",
      "evidenceRefs": [
        "vitest:context-injection-reliability.integration.test.ts#R-4/claude/exception/aggregate/corpus/fits"
      ],
      "inputHash": "9adc67f3b48369bcaf87b184d8f355b540f84641e4bdbdca08335b5eea5f528c",
      "returnedText": "## Related context (matched excerpts)\n\n⚠ Retrieval for these pointers was DEGRADED: embedding coverage for 'session_turn' is UNKNOWN (no fresh sample) — treat these as unverified, not healthy; embedding coverage for 'work_item' is UNKNOWN (no fresh sample) — treat these as unverified, not healthy; embedding coverage for 'plan' is UNKNOWN (no fresh sample) — treat these as unverified, not healthy; embedding coverage for 'doc' is UNKNOWN (no fresh sample) — treat these as unverified, not healthy; embedding coverage for 'report' is UNKNOWN (no fresh sample) — treat these as unverified, not healthy.\n\n- [plan plan:query-fixture-harness:operative] source-evidence \"Apply zephyrrepair recovery. Except when the source is read-only.\" — plans:get {\"slug\":\"operative\",\"harness\":\"query-fixture-harness\"}",
      "offeredHashes": [
        "114ecdcaaa759473c8e2e723af8a4542d71c47121e7244f33eaaad667ffb6a24"
      ],
      "committedHashes": [
        "114ecdcaaa759473c8e2e723af8a4542d71c47121e7244f33eaaad667ffb6a24"
      ],
      "verdict": "passed"
    },
    {
      "client": "claude",
      "condition": "exception",
      "boundary": "aggregate",
      "source": "corpus",
      "mode": "limited",
      "selector": "context reliability R-4: exception aggregate",
      "evidenceRefs": [
        "vitest:context-injection-reliability.integration.test.ts#R-4/claude/exception/aggregate/corpus/limited"
      ],
      "inputHash": "64318fe06c8300fef68a6d04193702cfdf9c7152e1fa74bfa11a878585cf2bfd",
      "returnedText": "",
      "offeredHashes": [],
      "committedHashes": [],
      "verdict": "passed"
    },
    {
      "client": "omp",
      "condition": "exception",
      "boundary": "aggregate",
      "source": "memory",
      "mode": "fits",
      "selector": "context reliability R-4: exception aggregate",
      "evidenceRefs": [
        "vitest:context-injection-reliability.integration.test.ts#R-4/omp/exception/aggregate/memory/fits"
      ],
      "inputHash": "e8ee75475da4817127ede7b4785b47f3786dd1625d2bc8b184df2b1c1c004079",
      "returnedText": "## Operator memory (relevant entries)\n\n- [unknown] (id=11111111-1111-4111-8111-111111111111) source-evidence \"Apply zephyrrepair recovery. Except when the source is read-only.\"",
      "offeredHashes": [
        "2cc4b30cdbd6b88432ba665c23386406874474a667b0f781908c5230e3aeae19"
      ],
      "committedHashes": [
        "2cc4b30cdbd6b88432ba665c23386406874474a667b0f781908c5230e3aeae19"
      ],
      "verdict": "passed"
    },
    {
      "client": "omp",
      "condition": "exception",
      "boundary": "aggregate",
      "source": "memory",
      "mode": "limited",
      "selector": "context reliability R-4: exception aggregate",
      "evidenceRefs": [
        "vitest:context-injection-reliability.integration.test.ts#R-4/omp/exception/aggregate/memory/limited"
      ],
      "inputHash": "3e8f15549f3547bbf4825a21c0180df186a675b76adcd5141d66eea5666d3c07",
      "returnedText": "",
      "offeredHashes": [],
      "committedHashes": [],
      "verdict": "passed"
    },
    {
      "client": "omp",
      "condition": "exception",
      "boundary": "aggregate",
      "source": "corpus",
      "mode": "fits",
      "selector": "context reliability R-4: exception aggregate",
      "evidenceRefs": [
        "vitest:context-injection-reliability.integration.test.ts#R-4/omp/exception/aggregate/corpus/fits"
      ],
      "inputHash": "cb01feaf7f30d3c624d99fcaa9f83736aa7df4e3bb7a3903f974324f801c3b61",
      "returnedText": "## Related context (matched excerpts)\n\n⚠ Retrieval for these pointers was DEGRADED: embedding coverage for 'session_turn' is UNKNOWN (no fresh sample) — treat these as unverified, not healthy; embedding coverage for 'work_item' is UNKNOWN (no fresh sample) — treat these as unverified, not healthy; embedding coverage for 'plan' is UNKNOWN (no fresh sample) — treat these as unverified, not healthy; embedding coverage for 'doc' is UNKNOWN (no fresh sample) — treat these as unverified, not healthy; embedding coverage for 'report' is UNKNOWN (no fresh sample) — treat these as unverified, not healthy.\n\n- [plan plan:query-fixture-harness:operative] source-evidence \"Apply zephyrrepair recovery. Except when the source is read-only.\" — plans:get {\"slug\":\"operative\",\"harness\":\"query-fixture-harness\"}",
      "offeredHashes": [
        "114ecdcaaa759473c8e2e723af8a4542d71c47121e7244f33eaaad667ffb6a24"
      ],
      "committedHashes": [
        "114ecdcaaa759473c8e2e723af8a4542d71c47121e7244f33eaaad667ffb6a24"
      ],
      "verdict": "passed"
    },
    {
      "client": "omp",
      "condition": "exception",
      "boundary": "aggregate",
      "source": "corpus",
      "mode": "limited",
      "selector": "context reliability R-4: exception aggregate",
      "evidenceRefs": [
        "vitest:context-injection-reliability.integration.test.ts#R-4/omp/exception/aggregate/corpus/limited"
      ],
      "inputHash": "943add43b34be0a9a1136cab86a6db89c0606d78e2b8e0f54f4e12b62cff43f7",
      "returnedText": "",
      "offeredHashes": [],
      "committedHashes": [],
      "verdict": "passed"
    },
    {
      "client": "codex",
      "condition": "expiry",
      "boundary": "entry",
      "source": "memory",
      "mode": "fits",
      "selector": "context reliability R-4: expiry entry",
      "evidenceRefs": [
        "vitest:context-injection-reliability.integration.test.ts#R-4/codex/expiry/entry/memory/fits"
      ],
      "inputHash": "b574a55073ab6a64f7a2e1f9d9d92e62153a7472c91a268ccc8e215f18db5176",
      "returnedText": "## Operator memory (relevant entries)\n\n- [unknown] (id=11111111-1111-4111-8111-111111111111) source-evidence \"Apply zephyrrepair recovery. This authorization expires at 2026-01-01T00:00:00Z.\"",
      "offeredHashes": [
        "cea5e0849df4d3513894547561f3cf142aed1d6ae73f39d1536a79694ff93469"
      ],
      "committedHashes": [
        "cea5e0849df4d3513894547561f3cf142aed1d6ae73f39d1536a79694ff93469"
      ],
      "verdict": "passed"
    },
    {
      "client": "codex",
      "condition": "expiry",
      "boundary": "entry",
      "source": "memory",
      "mode": "limited",
      "selector": "context reliability R-4: expiry entry",
      "evidenceRefs": [
        "vitest:context-injection-reliability.integration.test.ts#R-4/codex/expiry/entry/memory/limited"
      ],
      "inputHash": "92ab4c8c10f4f53c9247eb51a085bca6205122a054fc82d2764f1b5b6d54c8ba",
      "returnedText": "## Operator memory (relevant entries)\n\n- [unknown] (id=11111111-1111-4111-8111-111111111111) source-pointer {\"kind\":\"memory\",\"ref\":\"11111111-1111-4111-8111-111111111111\",\"revision\":\"unknown\",\"passage\":\"retrieved-unit\",\"unitHash\":\"6e3bbb28ecdb1a0b970fadf26e4b2fc01cc06969c967a3efa335cf44d05a6d19\",\"omitted\":true}",
      "offeredHashes": [],
      "committedHashes": [],
      "verdict": "passed"
    },
    {
      "client": "codex",
      "condition": "expiry",
      "boundary": "entry",
      "source": "corpus",
      "mode": "fits",
      "selector": "context reliability R-4: expiry entry",
      "evidenceRefs": [
        "vitest:context-injection-reliability.integration.test.ts#R-4/codex/expiry/entry/corpus/fits"
      ],
      "inputHash": "0784cfee94129d31b09b363f753b2855e1e6974a0e9165ff9e89146fa5987bac",
      "returnedText": "## Related context (matched excerpts)\n\n⚠ Retrieval for these pointers was DEGRADED: embedding coverage for 'session_turn' is UNKNOWN (no fresh sample) — treat these as unverified, not healthy; embedding coverage for 'work_item' is UNKNOWN (no fresh sample) — treat these as unverified, not healthy; embedding coverage for 'plan' is UNKNOWN (no fresh sample) — treat these as unverified, not healthy; embedding coverage for 'doc' is UNKNOWN (no fresh sample) — treat these as unverified, not healthy; embedding coverage for 'report' is UNKNOWN (no fresh sample) — treat these as unverified, not healthy.\n\n- [plan plan:query-fixture-harness:operative] source-evidence \"Apply zephyrrepair recovery. This authorization expires at 2026-01-01T00:00:00Z.\" — plans:get {\"slug\":\"operative\",\"harness\":\"query-fixture-harness\"}",
      "offeredHashes": [
        "202402ec3a7617a3d8af02395a296177cb25de1614c794bf301cab355ed05254"
      ],
      "committedHashes": [
        "202402ec3a7617a3d8af02395a296177cb25de1614c794bf301cab355ed05254"
      ],
      "verdict": "passed"
    },
    {
      "client": "codex",
      "condition": "expiry",
      "boundary": "entry",
      "source": "corpus",
      "mode": "limited",
      "selector": "context reliability R-4: expiry entry",
      "evidenceRefs": [
        "vitest:context-injection-reliability.integration.test.ts#R-4/codex/expiry/entry/corpus/limited"
      ],
      "inputHash": "bc4f4ce0c320d6a461c407f2fff12572e4f3658988122ab54787f60aa0157062",
      "returnedText": "## Related context (matched excerpts)\n\n⚠ Retrieval for these pointers was DEGRADED: embedding coverage for 'session_turn' is UNKNOWN (no fresh sample) — treat these as unverified, not healthy; embedding coverage for 'work_item' is UNKNOWN (no fresh sample) — treat these as unverified, not healthy; embedding coverage for 'plan' is UNKNOWN (no fresh sample) — treat these as unverified, not healthy; embedding coverage for 'doc' is UNKNOWN (no fresh sample) — treat these as unverified, not healthy; embedding coverage for 'report' is UNKNOWN (no fresh sample) — treat these as unverified, not healthy.\n\n- [plan plan:query-fixture-harness:operative] source-pointer {\"kind\":\"plan\",\"ref\":\"plan:query-fixture-harness:operative\",\"link\":\"plans:get {\\\"slug\\\":\\\"operative\\\",\\\"harness\\\":\\\"query-fixture-harness\\\"}\",\"revision\":\"unknown\",\"passage\":\"retrieved-unit\",\"unitHash\":\"6e3bbb28ecdb1a0b970fadf26e4b2fc01cc06969c967a3efa335cf44d05a6d19\",\"omitted\":true} — plans:get {\"slug\":\"operative\",\"harness\":\"query-fixture-harness\"}",
      "offeredHashes": [],
      "committedHashes": [],
      "verdict": "passed"
    },
    {
      "client": "claude",
      "condition": "expiry",
      "boundary": "entry",
      "source": "memory",
      "mode": "fits",
      "selector": "context reliability R-4: expiry entry",
      "evidenceRefs": [
        "vitest:context-injection-reliability.integration.test.ts#R-4/claude/expiry/entry/memory/fits"
      ],
      "inputHash": "92bff4a950e8bc6e9328aadf7b394d2ea01a6db259720516addded3fb9ae8088",
      "returnedText": "## Operator memory (relevant entries)\n\n- [unknown] (id=11111111-1111-4111-8111-111111111111) source-evidence \"Apply zephyrrepair recovery. This authorization expires at 2026-01-01T00:00:00Z.\"",
      "offeredHashes": [
        "cea5e0849df4d3513894547561f3cf142aed1d6ae73f39d1536a79694ff93469"
      ],
      "committedHashes": [
        "cea5e0849df4d3513894547561f3cf142aed1d6ae73f39d1536a79694ff93469"
      ],
      "verdict": "passed"
    },
    {
      "client": "claude",
      "condition": "expiry",
      "boundary": "entry",
      "source": "memory",
      "mode": "limited",
      "selector": "context reliability R-4: expiry entry",
      "evidenceRefs": [
        "vitest:context-injection-reliability.integration.test.ts#R-4/claude/expiry/entry/memory/limited"
      ],
      "inputHash": "ef4cdb1986b6e83c96c2fd76cff9f1748cbd4f851b3274cd997522a8d64ae6d1",
      "returnedText": "## Operator memory (relevant entries)\n\n- [unknown] (id=11111111-1111-4111-8111-111111111111) source-pointer {\"kind\":\"memory\",\"ref\":\"11111111-1111-4111-8111-111111111111\",\"revision\":\"unknown\",\"passage\":\"retrieved-unit\",\"unitHash\":\"6e3bbb28ecdb1a0b970fadf26e4b2fc01cc06969c967a3efa335cf44d05a6d19\",\"omitted\":true}",
      "offeredHashes": [],
      "committedHashes": [],
      "verdict": "passed"
    },
    {
      "client": "claude",
      "condition": "expiry",
      "boundary": "entry",
      "source": "corpus",
      "mode": "fits",
      "selector": "context reliability R-4: expiry entry",
      "evidenceRefs": [
        "vitest:context-injection-reliability.integration.test.ts#R-4/claude/expiry/entry/corpus/fits"
      ],
      "inputHash": "5997c0373ebc5465574337c10ed12b4a956614460b82edecdf72542d7fca2b53",
      "returnedText": "## Related context (matched excerpts)\n\n⚠ Retrieval for these pointers was DEGRADED: embedding coverage for 'session_turn' is UNKNOWN (no fresh sample) — treat these as unverified, not healthy; embedding coverage for 'work_item' is UNKNOWN (no fresh sample) — treat these as unverified, not healthy; embedding coverage for 'plan' is UNKNOWN (no fresh sample) — treat these as unverified, not healthy; embedding coverage for 'doc' is UNKNOWN (no fresh sample) — treat these as unverified, not healthy; embedding coverage for 'report' is UNKNOWN (no fresh sample) — treat these as unverified, not healthy.\n\n- [plan plan:query-fixture-harness:operative] source-evidence \"Apply zephyrrepair recovery. This authorization expires at 2026-01-01T00:00:00Z.\" — plans:get {\"slug\":\"operative\",\"harness\":\"query-fixture-harness\"}",
      "offeredHashes": [
        "202402ec3a7617a3d8af02395a296177cb25de1614c794bf301cab355ed05254"
      ],
      "committedHashes": [
        "202402ec3a7617a3d8af02395a296177cb25de1614c794bf301cab355ed05254"
      ],
      "verdict": "passed"
    },
    {
      "client": "claude",
      "condition": "expiry",
      "boundary": "entry",
      "source": "corpus",
      "mode": "limited",
      "selector": "context reliability R-4: expiry entry",
      "evidenceRefs": [
        "vitest:context-injection-reliability.integration.test.ts#R-4/claude/expiry/entry/corpus/limited"
      ],
      "inputHash": "4a35627ba5b5dcbbcc914f94b4c2f63e154228e7eb8231d12b20b1ae80c730d0",
      "returnedText": "## Related context (matched excerpts)\n\n⚠ Retrieval for these pointers was DEGRADED: embedding coverage for 'session_turn' is UNKNOWN (no fresh sample) — treat these as unverified, not healthy; embedding coverage for 'work_item' is UNKNOWN (no fresh sample) — treat these as unverified, not healthy; embedding coverage for 'plan' is UNKNOWN (no fresh sample) — treat these as unverified, not healthy; embedding coverage for 'doc' is UNKNOWN (no fresh sample) — treat these as unverified, not healthy; embedding coverage for 'report' is UNKNOWN (no fresh sample) — treat these as unverified, not healthy.\n\n- [plan plan:query-fixture-harness:operative] source-pointer {\"kind\":\"plan\",\"ref\":\"plan:query-fixture-harness:operative\",\"link\":\"plans:get {\\\"slug\\\":\\\"operative\\\",\\\"harness\\\":\\\"query-fixture-harness\\\"}\",\"revision\":\"unknown\",\"passage\":\"retrieved-unit\",\"unitHash\":\"6e3bbb28ecdb1a0b970fadf26e4b2fc01cc06969c967a3efa335cf44d05a6d19\",\"omitted\":true} — plans:get {\"slug\":\"operative\",\"harness\":\"query-fixture-harness\"}",
      "offeredHashes": [],
      "committedHashes": [],
      "verdict": "passed"
    },
    {
      "client": "omp",
      "condition": "expiry",
      "boundary": "entry",
      "source": "memory",
      "mode": "fits",
      "selector": "context reliability R-4: expiry entry",
      "evidenceRefs": [
        "vitest:context-injection-reliability.integration.test.ts#R-4/omp/expiry/entry/memory/fits"
      ],
      "inputHash": "a0092c3288cbab3f4c22b18b609c2a607f8f0a080c9e5e2ac5bf8172b0f64ee7",
      "returnedText": "## Operator memory (relevant entries)\n\n- [unknown] (id=11111111-1111-4111-8111-111111111111) source-evidence \"Apply zephyrrepair recovery. This authorization expires at 2026-01-01T00:00:00Z.\"",
      "offeredHashes": [
        "cea5e0849df4d3513894547561f3cf142aed1d6ae73f39d1536a79694ff93469"
      ],
      "committedHashes": [
        "cea5e0849df4d3513894547561f3cf142aed1d6ae73f39d1536a79694ff93469"
      ],
      "verdict": "passed"
    },
    {
      "client": "omp",
      "condition": "expiry",
      "boundary": "entry",
      "source": "memory",
      "mode": "limited",
      "selector": "context reliability R-4: expiry entry",
      "evidenceRefs": [
        "vitest:context-injection-reliability.integration.test.ts#R-4/omp/expiry/entry/memory/limited"
      ],
      "inputHash": "1d9ab58c7466c5b6fbbb8d57a004fd6394f2d403a7851fa5dc5011089223688d",
      "returnedText": "## Operator memory (relevant entries)\n\n- [unknown] (id=11111111-1111-4111-8111-111111111111) source-pointer {\"kind\":\"memory\",\"ref\":\"11111111-1111-4111-8111-111111111111\",\"revision\":\"unknown\",\"passage\":\"retrieved-unit\",\"unitHash\":\"6e3bbb28ecdb1a0b970fadf26e4b2fc01cc06969c967a3efa335cf44d05a6d19\",\"omitted\":true}",
      "offeredHashes": [],
      "committedHashes": [],
      "verdict": "passed"
    },
    {
      "client": "omp",
      "condition": "expiry",
      "boundary": "entry",
      "source": "corpus",
      "mode": "fits",
      "selector": "context reliability R-4: expiry entry",
      "evidenceRefs": [
        "vitest:context-injection-reliability.integration.test.ts#R-4/omp/expiry/entry/corpus/fits"
      ],
      "inputHash": "fc3ed2f7fe6aadc06ae868817cef10dfd27b76c85ea7767f1bc77c957fe378ef",
      "returnedText": "## Related context (matched excerpts)\n\n⚠ Retrieval for these pointers was DEGRADED: embedding coverage for 'session_turn' is UNKNOWN (no fresh sample) — treat these as unverified, not healthy; embedding coverage for 'work_item' is UNKNOWN (no fresh sample) — treat these as unverified, not healthy; embedding coverage for 'plan' is UNKNOWN (no fresh sample) — treat these as unverified, not healthy; embedding coverage for 'doc' is UNKNOWN (no fresh sample) — treat these as unverified, not healthy; embedding coverage for 'report' is UNKNOWN (no fresh sample) — treat these as unverified, not healthy.\n\n- [plan plan:query-fixture-harness:operative] source-evidence \"Apply zephyrrepair recovery. This authorization expires at 2026-01-01T00:00:00Z.\" — plans:get {\"slug\":\"operative\",\"harness\":\"query-fixture-harness\"}",
      "offeredHashes": [
        "202402ec3a7617a3d8af02395a296177cb25de1614c794bf301cab355ed05254"
      ],
      "committedHashes": [
        "202402ec3a7617a3d8af02395a296177cb25de1614c794bf301cab355ed05254"
      ],
      "verdict": "passed"
    },
    {
      "client": "omp",
      "condition": "expiry",
      "boundary": "entry",
      "source": "corpus",
      "mode": "limited",
      "selector": "context reliability R-4: expiry entry",
      "evidenceRefs": [
        "vitest:context-injection-reliability.integration.test.ts#R-4/omp/expiry/entry/corpus/limited"
      ],
      "inputHash": "c7973acee0665df9645a5da9ff3e5ba0c14a55c99e5e8c4abbfd2ebbd9dc9149",
      "returnedText": "## Related context (matched excerpts)\n\n⚠ Retrieval for these pointers was DEGRADED: embedding coverage for 'session_turn' is UNKNOWN (no fresh sample) — treat these as unverified, not healthy; embedding coverage for 'work_item' is UNKNOWN (no fresh sample) — treat these as unverified, not healthy; embedding coverage for 'plan' is UNKNOWN (no fresh sample) — treat these as unverified, not healthy; embedding coverage for 'doc' is UNKNOWN (no fresh sample) — treat these as unverified, not healthy; embedding coverage for 'report' is UNKNOWN (no fresh sample) — treat these as unverified, not healthy.\n\n- [plan plan:query-fixture-harness:operative] source-pointer {\"kind\":\"plan\",\"ref\":\"plan:query-fixture-harness:operative\",\"link\":\"plans:get {\\\"slug\\\":\\\"operative\\\",\\\"harness\\\":\\\"query-fixture-harness\\\"}\",\"revision\":\"unknown\",\"passage\":\"retrieved-unit\",\"unitHash\":\"6e3bbb28ecdb1a0b970fadf26e4b2fc01cc06969c967a3efa335cf44d05a6d19\",\"omitted\":true} — plans:get {\"slug\":\"operative\",\"harness\":\"query-fixture-harness\"}",
      "offeredHashes": [],
      "committedHashes": [],
      "verdict": "passed"
    },
    {
      "client": "codex",
      "condition": "expiry",
      "boundary": "aggregate",
      "source": "memory",
      "mode": "fits",
      "selector": "context reliability R-4: expiry aggregate",
      "evidenceRefs": [
        "vitest:context-injection-reliability.integration.test.ts#R-4/codex/expiry/aggregate/memory/fits"
      ],
      "inputHash": "2621bf1ffcf7b462969fff40c07a1136f02ba0b8d0b6ce691e7c95c2239c106d",
      "returnedText": "## Operator memory (relevant entries)\n\n- [unknown] (id=11111111-1111-4111-8111-111111111111) source-evidence \"Apply zephyrrepair recovery. This authorization expires at 2026-01-01T00:00:00Z.\"",
      "offeredHashes": [
        "cea5e0849df4d3513894547561f3cf142aed1d6ae73f39d1536a79694ff93469"
      ],
      "committedHashes": [
        "cea5e0849df4d3513894547561f3cf142aed1d6ae73f39d1536a79694ff93469"
      ],
      "verdict": "passed"
    },
    {
      "client": "codex",
      "condition": "expiry",
      "boundary": "aggregate",
      "source": "memory",
      "mode": "limited",
      "selector": "context reliability R-4: expiry aggregate",
      "evidenceRefs": [
        "vitest:context-injection-reliability.integration.test.ts#R-4/codex/expiry/aggregate/memory/limited"
      ],
      "inputHash": "b32e8cc67982be6ab0b95c855833e7c5c99d685855f303ab09f1911a21bea83d",
      "returnedText": "",
      "offeredHashes": [],
      "committedHashes": [],
      "verdict": "passed"
    },
    {
      "client": "codex",
      "condition": "expiry",
      "boundary": "aggregate",
      "source": "corpus",
      "mode": "fits",
      "selector": "context reliability R-4: expiry aggregate",
      "evidenceRefs": [
        "vitest:context-injection-reliability.integration.test.ts#R-4/codex/expiry/aggregate/corpus/fits"
      ],
      "inputHash": "91a1cd1d7abfff09da3e3e2b3356af003d7815e5ece14f9a539c76806d7abb4c",
      "returnedText": "## Related context (matched excerpts)\n\n⚠ Retrieval for these pointers was DEGRADED: embedding coverage for 'session_turn' is UNKNOWN (no fresh sample) — treat these as unverified, not healthy; embedding coverage for 'work_item' is UNKNOWN (no fresh sample) — treat these as unverified, not healthy; embedding coverage for 'plan' is UNKNOWN (no fresh sample) — treat these as unverified, not healthy; embedding coverage for 'doc' is UNKNOWN (no fresh sample) — treat these as unverified, not healthy; embedding coverage for 'report' is UNKNOWN (no fresh sample) — treat these as unverified, not healthy.\n\n- [plan plan:query-fixture-harness:operative] source-evidence \"Apply zephyrrepair recovery. This authorization expires at 2026-01-01T00:00:00Z.\" — plans:get {\"slug\":\"operative\",\"harness\":\"query-fixture-harness\"}",
      "offeredHashes": [
        "202402ec3a7617a3d8af02395a296177cb25de1614c794bf301cab355ed05254"
      ],
      "committedHashes": [
        "202402ec3a7617a3d8af02395a296177cb25de1614c794bf301cab355ed05254"
      ],
      "verdict": "passed"
    },
    {
      "client": "codex",
      "condition": "expiry",
      "boundary": "aggregate",
      "source": "corpus",
      "mode": "limited",
      "selector": "context reliability R-4: expiry aggregate",
      "evidenceRefs": [
        "vitest:context-injection-reliability.integration.test.ts#R-4/codex/expiry/aggregate/corpus/limited"
      ],
      "inputHash": "94eb36db3a42a1875d74028bbbad12189b6622c3e21f33e4955a3250c93228ad",
      "returnedText": "",
      "offeredHashes": [],
      "committedHashes": [],
      "verdict": "passed"
    },
    {
      "client": "claude",
      "condition": "expiry",
      "boundary": "aggregate",
      "source": "memory",
      "mode": "fits",
      "selector": "context reliability R-4: expiry aggregate",
      "evidenceRefs": [
        "vitest:context-injection-reliability.integration.test.ts#R-4/claude/expiry/aggregate/memory/fits"
      ],
      "inputHash": "268ba9f73ffdd25dc58e0d41f017b6878b988b0801755648280ed38e990bec67",
      "returnedText": "## Operator memory (relevant entries)\n\n- [unknown] (id=11111111-1111-4111-8111-111111111111) source-evidence \"Apply zephyrrepair recovery. This authorization expires at 2026-01-01T00:00:00Z.\"",
      "offeredHashes": [
        "cea5e0849df4d3513894547561f3cf142aed1d6ae73f39d1536a79694ff93469"
      ],
      "committedHashes": [
        "cea5e0849df4d3513894547561f3cf142aed1d6ae73f39d1536a79694ff93469"
      ],
      "verdict": "passed"
    },
    {
      "client": "claude",
      "condition": "expiry",
      "boundary": "aggregate",
      "source": "memory",
      "mode": "limited",
      "selector": "context reliability R-4: expiry aggregate",
      "evidenceRefs": [
        "vitest:context-injection-reliability.integration.test.ts#R-4/claude/expiry/aggregate/memory/limited"
      ],
      "inputHash": "20ad7fa14c421a3a624cf38b0b62dc4314637efcb262a560e1942fe71b8ef8ee",
      "returnedText": "",
      "offeredHashes": [],
      "committedHashes": [],
      "verdict": "passed"
    },
    {
      "client": "claude",
      "condition": "expiry",
      "boundary": "aggregate",
      "source": "corpus",
      "mode": "fits",
      "selector": "context reliability R-4: expiry aggregate",
      "evidenceRefs": [
        "vitest:context-injection-reliability.integration.test.ts#R-4/claude/expiry/aggregate/corpus/fits"
      ],
      "inputHash": "b0e69f6a2dee1f4a22ca6afae75c6ef006fca7b9193343754e6d6cba99bc48cc",
      "returnedText": "## Related context (matched excerpts)\n\n⚠ Retrieval for these pointers was DEGRADED: embedding coverage for 'session_turn' is UNKNOWN (no fresh sample) — treat these as unverified, not healthy; embedding coverage for 'work_item' is UNKNOWN (no fresh sample) — treat these as unverified, not healthy; embedding coverage for 'plan' is UNKNOWN (no fresh sample) — treat these as unverified, not healthy; embedding coverage for 'doc' is UNKNOWN (no fresh sample) — treat these as unverified, not healthy; embedding coverage for 'report' is UNKNOWN (no fresh sample) — treat these as unverified, not healthy.\n\n- [plan plan:query-fixture-harness:operative] source-evidence \"Apply zephyrrepair recovery. This authorization expires at 2026-01-01T00:00:00Z.\" — plans:get {\"slug\":\"operative\",\"harness\":\"query-fixture-harness\"}",
      "offeredHashes": [
        "202402ec3a7617a3d8af02395a296177cb25de1614c794bf301cab355ed05254"
      ],
      "committedHashes": [
        "202402ec3a7617a3d8af02395a296177cb25de1614c794bf301cab355ed05254"
      ],
      "verdict": "passed"
    },
    {
      "client": "claude",
      "condition": "expiry",
      "boundary": "aggregate",
      "source": "corpus",
      "mode": "limited",
      "selector": "context reliability R-4: expiry aggregate",
      "evidenceRefs": [
        "vitest:context-injection-reliability.integration.test.ts#R-4/claude/expiry/aggregate/corpus/limited"
      ],
      "inputHash": "998c8976aa03acde411bdbab0e17149150a6d296f9a7bcae05e43083b960fed7",
      "returnedText": "",
      "offeredHashes": [],
      "committedHashes": [],
      "verdict": "passed"
    },
    {
      "client": "omp",
      "condition": "expiry",
      "boundary": "aggregate",
      "source": "memory",
      "mode": "fits",
      "selector": "context reliability R-4: expiry aggregate",
      "evidenceRefs": [
        "vitest:context-injection-reliability.integration.test.ts#R-4/omp/expiry/aggregate/memory/fits"
      ],
      "inputHash": "ea15d522c98a89b102cfb2fd81862d1699b700d488c295ce32dfe6b0f7c63a7e",
      "returnedText": "## Operator memory (relevant entries)\n\n- [unknown] (id=11111111-1111-4111-8111-111111111111) source-evidence \"Apply zephyrrepair recovery. This authorization expires at 2026-01-01T00:00:00Z.\"",
      "offeredHashes": [
        "cea5e0849df4d3513894547561f3cf142aed1d6ae73f39d1536a79694ff93469"
      ],
      "committedHashes": [
        "cea5e0849df4d3513894547561f3cf142aed1d6ae73f39d1536a79694ff93469"
      ],
      "verdict": "passed"
    },
    {
      "client": "omp",
      "condition": "expiry",
      "boundary": "aggregate",
      "source": "memory",
      "mode": "limited",
      "selector": "context reliability R-4: expiry aggregate",
      "evidenceRefs": [
        "vitest:context-injection-reliability.integration.test.ts#R-4/omp/expiry/aggregate/memory/limited"
      ],
      "inputHash": "2cf1129e9101557f6ad6e5f2dc38085f580da082ec38852e68d8e29733574d51",
      "returnedText": "",
      "offeredHashes": [],
      "committedHashes": [],
      "verdict": "passed"
    },
    {
      "client": "omp",
      "condition": "expiry",
      "boundary": "aggregate",
      "source": "corpus",
      "mode": "fits",
      "selector": "context reliability R-4: expiry aggregate",
      "evidenceRefs": [
        "vitest:context-injection-reliability.integration.test.ts#R-4/omp/expiry/aggregate/corpus/fits"
      ],
      "inputHash": "54f3ee7b27f1771c5f01a848229a254bbf04f51da3b1779f645bf7d7c6e75b74",
      "returnedText": "## Related context (matched excerpts)\n\n⚠ Retrieval for these pointers was DEGRADED: embedding coverage for 'session_turn' is UNKNOWN (no fresh sample) — treat these as unverified, not healthy; embedding coverage for 'work_item' is UNKNOWN (no fresh sample) — treat these as unverified, not healthy; embedding coverage for 'plan' is UNKNOWN (no fresh sample) — treat these as unverified, not healthy; embedding coverage for 'doc' is UNKNOWN (no fresh sample) — treat these as unverified, not healthy; embedding coverage for 'report' is UNKNOWN (no fresh sample) — treat these as unverified, not healthy.\n\n- [plan plan:query-fixture-harness:operative] source-evidence \"Apply zephyrrepair recovery. This authorization expires at 2026-01-01T00:00:00Z.\" — plans:get {\"slug\":\"operative\",\"harness\":\"query-fixture-harness\"}",
      "offeredHashes": [
        "202402ec3a7617a3d8af02395a296177cb25de1614c794bf301cab355ed05254"
      ],
      "committedHashes": [
        "202402ec3a7617a3d8af02395a296177cb25de1614c794bf301cab355ed05254"
      ],
      "verdict": "passed"
    },
    {
      "client": "omp",
      "condition": "expiry",
      "boundary": "aggregate",
      "source": "corpus",
      "mode": "limited",
      "selector": "context reliability R-4: expiry aggregate",
      "evidenceRefs": [
        "vitest:context-injection-reliability.integration.test.ts#R-4/omp/expiry/aggregate/corpus/limited"
      ],
      "inputHash": "0fbebe16e63071bda040ce817b45ba4e2609483925a7304e31aa6200119c9d59",
      "returnedText": "",
      "offeredHashes": [],
      "committedHashes": [],
      "verdict": "passed"
    },
    {
      "client": "codex",
      "condition": "supersession",
      "boundary": "entry",
      "source": "memory",
      "mode": "fits",
      "selector": "context reliability R-4: supersession entry",
      "evidenceRefs": [
        "vitest:context-injection-reliability.integration.test.ts#R-4/codex/supersession/entry/memory/fits"
      ],
      "inputHash": "e6d775ab97a30444558823cf965d616de6c4d3299dab937258e0101f5db837d8",
      "returnedText": "## Operator memory (relevant entries)\n\n- [unknown] (id=11111111-1111-4111-8111-111111111111) source-evidence \"Apply zephyrrepair recovery. Superseded by the replacement procedure; this command is obsolete.\"",
      "offeredHashes": [
        "7d58f0e11249ca264d15e67d91eaa6478a9c97419fb3a88dc04e0e22dd292bd1"
      ],
      "committedHashes": [
        "7d58f0e11249ca264d15e67d91eaa6478a9c97419fb3a88dc04e0e22dd292bd1"
      ],
      "verdict": "passed"
    },
    {
      "client": "codex",
      "condition": "supersession",
      "boundary": "entry",
      "source": "memory",
      "mode": "limited",
      "selector": "context reliability R-4: supersession entry",
      "evidenceRefs": [
        "vitest:context-injection-reliability.integration.test.ts#R-4/codex/supersession/entry/memory/limited"
      ],
      "inputHash": "f6c3a5c245b88018be65db7d8dc7cecfb9cdd624d835f146c1d1ebfd5437eb64",
      "returnedText": "## Operator memory (relevant entries)\n\n- [unknown] (id=11111111-1111-4111-8111-111111111111) source-pointer {\"kind\":\"memory\",\"ref\":\"11111111-1111-4111-8111-111111111111\",\"revision\":\"unknown\",\"passage\":\"retrieved-unit\",\"unitHash\":\"b06e3bf9e477cbb22a7257816d328f34b2f0788f4e9ccdc14df287ce7d6e51d4\",\"omitted\":true}",
      "offeredHashes": [],
      "committedHashes": [],
      "verdict": "passed"
    },
    {
      "client": "codex",
      "condition": "supersession",
      "boundary": "entry",
      "source": "corpus",
      "mode": "fits",
      "selector": "context reliability R-4: supersession entry",
      "evidenceRefs": [
        "vitest:context-injection-reliability.integration.test.ts#R-4/codex/supersession/entry/corpus/fits"
      ],
      "inputHash": "ede67ddf92488a8ae4af1be9b4705e97722dbf73913cbac452ac129acef59c08",
      "returnedText": "## Related context (matched excerpts)\n\n⚠ Retrieval for these pointers was DEGRADED: embedding coverage for 'session_turn' is UNKNOWN (no fresh sample) — treat these as unverified, not healthy; embedding coverage for 'work_item' is UNKNOWN (no fresh sample) — treat these as unverified, not healthy; embedding coverage for 'plan' is UNKNOWN (no fresh sample) — treat these as unverified, not healthy; embedding coverage for 'doc' is UNKNOWN (no fresh sample) — treat these as unverified, not healthy; embedding coverage for 'report' is UNKNOWN (no fresh sample) — treat these as unverified, not healthy.\n\n- [plan plan:query-fixture-harness:operative] source-evidence \"Apply zephyrrepair recovery. Superseded by the replacement procedure; this command is obsolete.\" — plans:get {\"slug\":\"operative\",\"harness\":\"query-fixture-harness\"}",
      "offeredHashes": [
        "4514813bd3a14d2c2350fdd2e9f41cb6fa854e83ebeff03b038e64957a256aa1"
      ],
      "committedHashes": [
        "4514813bd3a14d2c2350fdd2e9f41cb6fa854e83ebeff03b038e64957a256aa1"
      ],
      "verdict": "passed"
    },
    {
      "client": "codex",
      "condition": "supersession",
      "boundary": "entry",
      "source": "corpus",
      "mode": "limited",
      "selector": "context reliability R-4: supersession entry",
      "evidenceRefs": [
        "vitest:context-injection-reliability.integration.test.ts#R-4/codex/supersession/entry/corpus/limited"
      ],
      "inputHash": "9b349a2fb638f8601a19ee126034f7428d1ffc63cd764326ff3520844376a640",
      "returnedText": "## Related context (matched excerpts)\n\n⚠ Retrieval for these pointers was DEGRADED: embedding coverage for 'session_turn' is UNKNOWN (no fresh sample) — treat these as unverified, not healthy; embedding coverage for 'work_item' is UNKNOWN (no fresh sample) — treat these as unverified, not healthy; embedding coverage for 'plan' is UNKNOWN (no fresh sample) — treat these as unverified, not healthy; embedding coverage for 'doc' is UNKNOWN (no fresh sample) — treat these as unverified, not healthy; embedding coverage for 'report' is UNKNOWN (no fresh sample) — treat these as unverified, not healthy.\n\n- [plan plan:query-fixture-harness:operative] source-pointer {\"kind\":\"plan\",\"ref\":\"plan:query-fixture-harness:operative\",\"link\":\"plans:get {\\\"slug\\\":\\\"operative\\\",\\\"harness\\\":\\\"query-fixture-harness\\\"}\",\"revision\":\"unknown\",\"passage\":\"retrieved-unit\",\"unitHash\":\"b06e3bf9e477cbb22a7257816d328f34b2f0788f4e9ccdc14df287ce7d6e51d4\",\"omitted\":true} — plans:get {\"slug\":\"operative\",\"harness\":\"query-fixture-harness\"}",
      "offeredHashes": [],
      "committedHashes": [],
      "verdict": "passed"
    },
    {
      "client": "claude",
      "condition": "supersession",
      "boundary": "entry",
      "source": "memory",
      "mode": "fits",
      "selector": "context reliability R-4: supersession entry",
      "evidenceRefs": [
        "vitest:context-injection-reliability.integration.test.ts#R-4/claude/supersession/entry/memory/fits"
      ],
      "inputHash": "5cb805ac40a8c239e3c356afe0995306344a628044d6f3ef367bac3319bd842b",
      "returnedText": "## Operator memory (relevant entries)\n\n- [unknown] (id=11111111-1111-4111-8111-111111111111) source-evidence \"Apply zephyrrepair recovery. Superseded by the replacement procedure; this command is obsolete.\"",
      "offeredHashes": [
        "7d58f0e11249ca264d15e67d91eaa6478a9c97419fb3a88dc04e0e22dd292bd1"
      ],
      "committedHashes": [
        "7d58f0e11249ca264d15e67d91eaa6478a9c97419fb3a88dc04e0e22dd292bd1"
      ],
      "verdict": "passed"
    },
    {
      "client": "claude",
      "condition": "supersession",
      "boundary": "entry",
      "source": "memory",
      "mode": "limited",
      "selector": "context reliability R-4: supersession entry",
      "evidenceRefs": [
        "vitest:context-injection-reliability.integration.test.ts#R-4/claude/supersession/entry/memory/limited"
      ],
      "inputHash": "87e30daab05a618e843a99dc531e8c044fe907fcfd547435350eb7b70a0713d2",
      "returnedText": "## Operator memory (relevant entries)\n\n- [unknown] (id=11111111-1111-4111-8111-111111111111) source-pointer {\"kind\":\"memory\",\"ref\":\"11111111-1111-4111-8111-111111111111\",\"revision\":\"unknown\",\"passage\":\"retrieved-unit\",\"unitHash\":\"b06e3bf9e477cbb22a7257816d328f34b2f0788f4e9ccdc14df287ce7d6e51d4\",\"omitted\":true}",
      "offeredHashes": [],
      "committedHashes": [],
      "verdict": "passed"
    },
    {
      "client": "claude",
      "condition": "supersession",
      "boundary": "entry",
      "source": "corpus",
      "mode": "fits",
      "selector": "context reliability R-4: supersession entry",
      "evidenceRefs": [
        "vitest:context-injection-reliability.integration.test.ts#R-4/claude/supersession/entry/corpus/fits"
      ],
      "inputHash": "c7f4ee59ccddd2e5c8be75c9ad436c31422608fc1613d5b348fb25569dbf3d44",
      "returnedText": "## Related context (matched excerpts)\n\n⚠ Retrieval for these pointers was DEGRADED: embedding coverage for 'session_turn' is UNKNOWN (no fresh sample) — treat these as unverified, not healthy; embedding coverage for 'work_item' is UNKNOWN (no fresh sample) — treat these as unverified, not healthy; embedding coverage for 'plan' is UNKNOWN (no fresh sample) — treat these as unverified, not healthy; embedding coverage for 'doc' is UNKNOWN (no fresh sample) — treat these as unverified, not healthy; embedding coverage for 'report' is UNKNOWN (no fresh sample) — treat these as unverified, not healthy.\n\n- [plan plan:query-fixture-harness:operative] source-evidence \"Apply zephyrrepair recovery. Superseded by the replacement procedure; this command is obsolete.\" — plans:get {\"slug\":\"operative\",\"harness\":\"query-fixture-harness\"}",
      "offeredHashes": [
        "4514813bd3a14d2c2350fdd2e9f41cb6fa854e83ebeff03b038e64957a256aa1"
      ],
      "committedHashes": [
        "4514813bd3a14d2c2350fdd2e9f41cb6fa854e83ebeff03b038e64957a256aa1"
      ],
      "verdict": "passed"
    },
    {
      "client": "claude",
      "condition": "supersession",
      "boundary": "entry",
      "source": "corpus",
      "mode": "limited",
      "selector": "context reliability R-4: supersession entry",
      "evidenceRefs": [
        "vitest:context-injection-reliability.integration.test.ts#R-4/claude/supersession/entry/corpus/limited"
      ],
      "inputHash": "1c0b8163ec59ca502e8db786554f0b2b2bbe51894187e448d6cf5ce8a92c6fa1",
      "returnedText": "## Related context (matched excerpts)\n\n⚠ Retrieval for these pointers was DEGRADED: embedding coverage for 'session_turn' is UNKNOWN (no fresh sample) — treat these as unverified, not healthy; embedding coverage for 'work_item' is UNKNOWN (no fresh sample) — treat these as unverified, not healthy; embedding coverage for 'plan' is UNKNOWN (no fresh sample) — treat these as unverified, not healthy; embedding coverage for 'doc' is UNKNOWN (no fresh sample) — treat these as unverified, not healthy; embedding coverage for 'report' is UNKNOWN (no fresh sample) — treat these as unverified, not healthy.\n\n- [plan plan:query-fixture-harness:operative] source-pointer {\"kind\":\"plan\",\"ref\":\"plan:query-fixture-harness:operative\",\"link\":\"plans:get {\\\"slug\\\":\\\"operative\\\",\\\"harness\\\":\\\"query-fixture-harness\\\"}\",\"revision\":\"unknown\",\"passage\":\"retrieved-unit\",\"unitHash\":\"b06e3bf9e477cbb22a7257816d328f34b2f0788f4e9ccdc14df287ce7d6e51d4\",\"omitted\":true} — plans:get {\"slug\":\"operative\",\"harness\":\"query-fixture-harness\"}",
      "offeredHashes": [],
      "committedHashes": [],
      "verdict": "passed"
    },
    {
      "client": "omp",
      "condition": "supersession",
      "boundary": "entry",
      "source": "memory",
      "mode": "fits",
      "selector": "context reliability R-4: supersession entry",
      "evidenceRefs": [
        "vitest:context-injection-reliability.integration.test.ts#R-4/omp/supersession/entry/memory/fits"
      ],
      "inputHash": "34fddd9b03ec5662f141fa221d4aca88b5ea38849671d1fb72bba609c85449a2",
      "returnedText": "## Operator memory (relevant entries)\n\n- [unknown] (id=11111111-1111-4111-8111-111111111111) source-evidence \"Apply zephyrrepair recovery. Superseded by the replacement procedure; this command is obsolete.\"",
      "offeredHashes": [
        "7d58f0e11249ca264d15e67d91eaa6478a9c97419fb3a88dc04e0e22dd292bd1"
      ],
      "committedHashes": [
        "7d58f0e11249ca264d15e67d91eaa6478a9c97419fb3a88dc04e0e22dd292bd1"
      ],
      "verdict": "passed"
    },
    {
      "client": "omp",
      "condition": "supersession",
      "boundary": "entry",
      "source": "memory",
      "mode": "limited",
      "selector": "context reliability R-4: supersession entry",
      "evidenceRefs": [
        "vitest:context-injection-reliability.integration.test.ts#R-4/omp/supersession/entry/memory/limited"
      ],
      "inputHash": "01ccae3955876e749ec451898b98397da8b2ceddaeb1a606cad8bd0d7794fe80",
      "returnedText": "## Operator memory (relevant entries)\n\n- [unknown] (id=11111111-1111-4111-8111-111111111111) source-pointer {\"kind\":\"memory\",\"ref\":\"11111111-1111-4111-8111-111111111111\",\"revision\":\"unknown\",\"passage\":\"retrieved-unit\",\"unitHash\":\"b06e3bf9e477cbb22a7257816d328f34b2f0788f4e9ccdc14df287ce7d6e51d4\",\"omitted\":true}",
      "offeredHashes": [],
      "committedHashes": [],
      "verdict": "passed"
    },
    {
      "client": "omp",
      "condition": "supersession",
      "boundary": "entry",
      "source": "corpus",
      "mode": "fits",
      "selector": "context reliability R-4: supersession entry",
      "evidenceRefs": [
        "vitest:context-injection-reliability.integration.test.ts#R-4/omp/supersession/entry/corpus/fits"
      ],
      "inputHash": "bd0ad4d387ce3f8688f1b36f52a191746e77d60d929f34ef8f6f17e719cfe440",
      "returnedText": "## Related context (matched excerpts)\n\n⚠ Retrieval for these pointers was DEGRADED: embedding coverage for 'session_turn' is UNKNOWN (no fresh sample) — treat these as unverified, not healthy; embedding coverage for 'work_item' is UNKNOWN (no fresh sample) — treat these as unverified, not healthy; embedding coverage for 'plan' is UNKNOWN (no fresh sample) — treat these as unverified, not healthy; embedding coverage for 'doc' is UNKNOWN (no fresh sample) — treat these as unverified, not healthy; embedding coverage for 'report' is UNKNOWN (no fresh sample) — treat these as unverified, not healthy.\n\n- [plan plan:query-fixture-harness:operative] source-evidence \"Apply zephyrrepair recovery. Superseded by the replacement procedure; this command is obsolete.\" — plans:get {\"slug\":\"operative\",\"harness\":\"query-fixture-harness\"}",
      "offeredHashes": [
        "4514813bd3a14d2c2350fdd2e9f41cb6fa854e83ebeff03b038e64957a256aa1"
      ],
      "committedHashes": [
        "4514813bd3a14d2c2350fdd2e9f41cb6fa854e83ebeff03b038e64957a256aa1"
      ],
      "verdict": "passed"
    },
    {
      "client": "omp",
      "condition": "supersession",
      "boundary": "entry",
      "source": "corpus",
      "mode": "limited",
      "selector": "context reliability R-4: supersession entry",
      "evidenceRefs": [
        "vitest:context-injection-reliability.integration.test.ts#R-4/omp/supersession/entry/corpus/limited"
      ],
      "inputHash": "a4b3cb74b2cdf1a4b422e214c151601310eb16a18244314d0e642c880772483f",
      "returnedText": "## Related context (matched excerpts)\n\n⚠ Retrieval for these pointers was DEGRADED: embedding coverage for 'session_turn' is UNKNOWN (no fresh sample) — treat these as unverified, not healthy; embedding coverage for 'work_item' is UNKNOWN (no fresh sample) — treat these as unverified, not healthy; embedding coverage for 'plan' is UNKNOWN (no fresh sample) — treat these as unverified, not healthy; embedding coverage for 'doc' is UNKNOWN (no fresh sample) — treat these as unverified, not healthy; embedding coverage for 'report' is UNKNOWN (no fresh sample) — treat these as unverified, not healthy.\n\n- [plan plan:query-fixture-harness:operative] source-pointer {\"kind\":\"plan\",\"ref\":\"plan:query-fixture-harness:operative\",\"link\":\"plans:get {\\\"slug\\\":\\\"operative\\\",\\\"harness\\\":\\\"query-fixture-harness\\\"}\",\"revision\":\"unknown\",\"passage\":\"retrieved-unit\",\"unitHash\":\"b06e3bf9e477cbb22a7257816d328f34b2f0788f4e9ccdc14df287ce7d6e51d4\",\"omitted\":true} — plans:get {\"slug\":\"operative\",\"harness\":\"query-fixture-harness\"}",
      "offeredHashes": [],
      "committedHashes": [],
      "verdict": "passed"
    },
    {
      "client": "codex",
      "condition": "supersession",
      "boundary": "aggregate",
      "source": "memory",
      "mode": "fits",
      "selector": "context reliability R-4: supersession aggregate",
      "evidenceRefs": [
        "vitest:context-injection-reliability.integration.test.ts#R-4/codex/supersession/aggregate/memory/fits"
      ],
      "inputHash": "f7e9d7574a0548751f4ea4055ffe180b1c3d4d3a383fd87ed9e7a6d52a801cc2",
      "returnedText": "## Operator memory (relevant entries)\n\n- [unknown] (id=11111111-1111-4111-8111-111111111111) source-evidence \"Apply zephyrrepair recovery. Superseded by the replacement procedure; this command is obsolete.\"",
      "offeredHashes": [
        "7d58f0e11249ca264d15e67d91eaa6478a9c97419fb3a88dc04e0e22dd292bd1"
      ],
      "committedHashes": [
        "7d58f0e11249ca264d15e67d91eaa6478a9c97419fb3a88dc04e0e22dd292bd1"
      ],
      "verdict": "passed"
    },
    {
      "client": "codex",
      "condition": "supersession",
      "boundary": "aggregate",
      "source": "memory",
      "mode": "limited",
      "selector": "context reliability R-4: supersession aggregate",
      "evidenceRefs": [
        "vitest:context-injection-reliability.integration.test.ts#R-4/codex/supersession/aggregate/memory/limited"
      ],
      "inputHash": "441761274f3fce5e559c52fed29aa5c2e75f64d8749b32b732701be0b94bde04",
      "returnedText": "",
      "offeredHashes": [],
      "committedHashes": [],
      "verdict": "passed"
    },
    {
      "client": "codex",
      "condition": "supersession",
      "boundary": "aggregate",
      "source": "corpus",
      "mode": "fits",
      "selector": "context reliability R-4: supersession aggregate",
      "evidenceRefs": [
        "vitest:context-injection-reliability.integration.test.ts#R-4/codex/supersession/aggregate/corpus/fits"
      ],
      "inputHash": "3bd1fcfda85c018c0174b1ae75c6abec309603cde38426e144feeaebce557e28",
      "returnedText": "## Related context (matched excerpts)\n\n⚠ Retrieval for these pointers was DEGRADED: embedding coverage for 'session_turn' is UNKNOWN (no fresh sample) — treat these as unverified, not healthy; embedding coverage for 'work_item' is UNKNOWN (no fresh sample) — treat these as unverified, not healthy; embedding coverage for 'plan' is UNKNOWN (no fresh sample) — treat these as unverified, not healthy; embedding coverage for 'doc' is UNKNOWN (no fresh sample) — treat these as unverified, not healthy; embedding coverage for 'report' is UNKNOWN (no fresh sample) — treat these as unverified, not healthy.\n\n- [plan plan:query-fixture-harness:operative] source-evidence \"Apply zephyrrepair recovery. Superseded by the replacement procedure; this command is obsolete.\" — plans:get {\"slug\":\"operative\",\"harness\":\"query-fixture-harness\"}",
      "offeredHashes": [
        "4514813bd3a14d2c2350fdd2e9f41cb6fa854e83ebeff03b038e64957a256aa1"
      ],
      "committedHashes": [
        "4514813bd3a14d2c2350fdd2e9f41cb6fa854e83ebeff03b038e64957a256aa1"
      ],
      "verdict": "passed"
    },
    {
      "client": "codex",
      "condition": "supersession",
      "boundary": "aggregate",
      "source": "corpus",
      "mode": "limited",
      "selector": "context reliability R-4: supersession aggregate",
      "evidenceRefs": [
        "vitest:context-injection-reliability.integration.test.ts#R-4/codex/supersession/aggregate/corpus/limited"
      ],
      "inputHash": "e4f2423c074a36637e3ad9c0e3d7c3eaef8ca34798749ced5c6622e84defc7a0",
      "returnedText": "",
      "offeredHashes": [],
      "committedHashes": [],
      "verdict": "passed"
    },
    {
      "client": "claude",
      "condition": "supersession",
      "boundary": "aggregate",
      "source": "memory",
      "mode": "fits",
      "selector": "context reliability R-4: supersession aggregate",
      "evidenceRefs": [
        "vitest:context-injection-reliability.integration.test.ts#R-4/claude/supersession/aggregate/memory/fits"
      ],
      "inputHash": "43252373d37c4532fd5320a67ef4e9fb43923855c9efc3e0b29c8dc5e46cf4d1",
      "returnedText": "## Operator memory (relevant entries)\n\n- [unknown] (id=11111111-1111-4111-8111-111111111111) source-evidence \"Apply zephyrrepair recovery. Superseded by the replacement procedure; this command is obsolete.\"",
      "offeredHashes": [
        "7d58f0e11249ca264d15e67d91eaa6478a9c97419fb3a88dc04e0e22dd292bd1"
      ],
      "committedHashes": [
        "7d58f0e11249ca264d15e67d91eaa6478a9c97419fb3a88dc04e0e22dd292bd1"
      ],
      "verdict": "passed"
    },
    {
      "client": "claude",
      "condition": "supersession",
      "boundary": "aggregate",
      "source": "memory",
      "mode": "limited",
      "selector": "context reliability R-4: supersession aggregate",
      "evidenceRefs": [
        "vitest:context-injection-reliability.integration.test.ts#R-4/claude/supersession/aggregate/memory/limited"
      ],
      "inputHash": "7462d03ad4a9706d3e31f987acb60ff26990c5094840eeffc116e5b0b63aab04",
      "returnedText": "",
      "offeredHashes": [],
      "committedHashes": [],
      "verdict": "passed"
    },
    {
      "client": "claude",
      "condition": "supersession",
      "boundary": "aggregate",
      "source": "corpus",
      "mode": "fits",
      "selector": "context reliability R-4: supersession aggregate",
      "evidenceRefs": [
        "vitest:context-injection-reliability.integration.test.ts#R-4/claude/supersession/aggregate/corpus/fits"
      ],
      "inputHash": "93e7208f5fa203ca7f363bc56023db72bfcfcf319e8151fe72431b64f5db9fe5",
      "returnedText": "## Related context (matched excerpts)\n\n⚠ Retrieval for these pointers was DEGRADED: embedding coverage for 'session_turn' is UNKNOWN (no fresh sample) — treat these as unverified, not healthy; embedding coverage for 'work_item' is UNKNOWN (no fresh sample) — treat these as unverified, not healthy; embedding coverage for 'plan' is UNKNOWN (no fresh sample) — treat these as unverified, not healthy; embedding coverage for 'doc' is UNKNOWN (no fresh sample) — treat these as unverified, not healthy; embedding coverage for 'report' is UNKNOWN (no fresh sample) — treat these as unverified, not healthy.\n\n- [plan plan:query-fixture-harness:operative] source-evidence \"Apply zephyrrepair recovery. Superseded by the replacement procedure; this command is obsolete.\" — plans:get {\"slug\":\"operative\",\"harness\":\"query-fixture-harness\"}",
      "offeredHashes": [
        "4514813bd3a14d2c2350fdd2e9f41cb6fa854e83ebeff03b038e64957a256aa1"
      ],
      "committedHashes": [
        "4514813bd3a14d2c2350fdd2e9f41cb6fa854e83ebeff03b038e64957a256aa1"
      ],
      "verdict": "passed"
    },
    {
      "client": "claude",
      "condition": "supersession",
      "boundary": "aggregate",
      "source": "corpus",
      "mode": "limited",
      "selector": "context reliability R-4: supersession aggregate",
      "evidenceRefs": [
        "vitest:context-injection-reliability.integration.test.ts#R-4/claude/supersession/aggregate/corpus/limited"
      ],
      "inputHash": "8312f4a1fa9f2412302d373464a4c4f79718e150e4b68c3eea4ff558e98b55fe",
      "returnedText": "",
      "offeredHashes": [],
      "committedHashes": [],
      "verdict": "passed"
    },
    {
      "client": "omp",
      "condition": "supersession",
      "boundary": "aggregate",
      "source": "memory",
      "mode": "fits",
      "selector": "context reliability R-4: supersession aggregate",
      "evidenceRefs": [
        "vitest:context-injection-reliability.integration.test.ts#R-4/omp/supersession/aggregate/memory/fits"
      ],
      "inputHash": "b4468d1be57f92cb956f066642202e44cf70f4035493932fe8f38e2a93427c36",
      "returnedText": "## Operator memory (relevant entries)\n\n- [unknown] (id=11111111-1111-4111-8111-111111111111) source-evidence \"Apply zephyrrepair recovery. Superseded by the replacement procedure; this command is obsolete.\"",
      "offeredHashes": [
        "7d58f0e11249ca264d15e67d91eaa6478a9c97419fb3a88dc04e0e22dd292bd1"
      ],
      "committedHashes": [
        "7d58f0e11249ca264d15e67d91eaa6478a9c97419fb3a88dc04e0e22dd292bd1"
      ],
      "verdict": "passed"
    },
    {
      "client": "omp",
      "condition": "supersession",
      "boundary": "aggregate",
      "source": "memory",
      "mode": "limited",
      "selector": "context reliability R-4: supersession aggregate",
      "evidenceRefs": [
        "vitest:context-injection-reliability.integration.test.ts#R-4/omp/supersession/aggregate/memory/limited"
      ],
      "inputHash": "5ae767932235be9a9b7c6fc0a9e51dd4f2dba34d0e7c4275031a64adf8c6eb42",
      "returnedText": "",
      "offeredHashes": [],
      "committedHashes": [],
      "verdict": "passed"
    },
    {
      "client": "omp",
      "condition": "supersession",
      "boundary": "aggregate",
      "source": "corpus",
      "mode": "fits",
      "selector": "context reliability R-4: supersession aggregate",
      "evidenceRefs": [
        "vitest:context-injection-reliability.integration.test.ts#R-4/omp/supersession/aggregate/corpus/fits"
      ],
      "inputHash": "67f748f9028651fcf71db3de755c34b6910de66ce51eed9cdb75356f15ff9dde",
      "returnedText": "## Related context (matched excerpts)\n\n⚠ Retrieval for these pointers was DEGRADED: embedding coverage for 'session_turn' is UNKNOWN (no fresh sample) — treat these as unverified, not healthy; embedding coverage for 'work_item' is UNKNOWN (no fresh sample) — treat these as unverified, not healthy; embedding coverage for 'plan' is UNKNOWN (no fresh sample) — treat these as unverified, not healthy; embedding coverage for 'doc' is UNKNOWN (no fresh sample) — treat these as unverified, not healthy; embedding coverage for 'report' is UNKNOWN (no fresh sample) — treat these as unverified, not healthy.\n\n- [plan plan:query-fixture-harness:operative] source-evidence \"Apply zephyrrepair recovery. Superseded by the replacement procedure; this command is obsolete.\" — plans:get {\"slug\":\"operative\",\"harness\":\"query-fixture-harness\"}",
      "offeredHashes": [
        "4514813bd3a14d2c2350fdd2e9f41cb6fa854e83ebeff03b038e64957a256aa1"
      ],
      "committedHashes": [
        "4514813bd3a14d2c2350fdd2e9f41cb6fa854e83ebeff03b038e64957a256aa1"
      ],
      "verdict": "passed"
    },
    {
      "client": "omp",
      "condition": "supersession",
      "boundary": "aggregate",
      "source": "corpus",
      "mode": "limited",
      "selector": "context reliability R-4: supersession aggregate",
      "evidenceRefs": [
        "vitest:context-injection-reliability.integration.test.ts#R-4/omp/supersession/aggregate/corpus/limited"
      ],
      "inputHash": "67520139357ef5533db53d240698679b18649542d2ea1aa3be91f67af60d89ab",
      "returnedText": "",
      "offeredHashes": [],
      "committedHashes": [],
      "verdict": "passed"
    }
  ],
  "provenance": {
    "evidencePlane": "current-tree-builder-endpoint-receipt-fixture",
    "sourceSnapshot": [
      {
        "path": "./injection.ts",
        "sha256": "ba3ffe7541c20c34020f5a970fca379bb12b174a3702687604e3fd4ef1aa54fa"
      },
      {
        "path": "./injection-delivery-coverage.ts",
        "sha256": "4b4005d8494e9e0c090e1c7c4f97ef6706daad6ed4f1edcbf0042bc06fc24118"
      },
      {
        "path": "./context-injection-reliability.integration.test.ts",
        "sha256": "b27e1b97b0b03cf11a2952342bfa92e632ac9eba54cdb63c01f91b36c3b0a7eb"
      },
      {
        "path": "./injection-block-cache.ts",
        "sha256": "d17917e4f58064fd7d73a1b93cf22b3f0b8a4d2d98df7cedb2782cddb626b2d3"
      },
      {
        "path": "../auth.ts",
        "sha256": "83536580499636fb25e83834095a9181323bdcc5e25000287028c76e18206d62"
      },
      {
        "path": "../agent-tools/coordination/control-anchor.ts",
        "sha256": "5d6e7681c8d22ab86238ba26b4818aa86d61541e18aca6016c2bd39f07ce17c4"
      },
      {
        "path": "./temporal-render.ts",
        "sha256": "581a3588b3b4cfa9b2ecc7359671243a7bb4e505d5f4d0937f42e94c13ebb702"
      },
      {
        "path": "./corpus-recall.ts",
        "sha256": "b3e44224051577ea1177d2b83aafd3bac61a53833c1d01f20c157464fd7d90be"
      },
      {
        "path": "./session-epoch-ledger.ts",
        "sha256": "6c4afe23d0e2f454e3775af82cb5dbab7bd3db526c18829a42d8ee1ac0b51cfc"
      },
      {
        "path": "./corpus-surfaced-ledger.ts",
        "sha256": "66a01d36cc4af9fb5f498e92dda7c8cd3b2b3f76d0c8bf6f4cc06e4c8a4f852a"
      },
      {
        "path": "../endpoint-route/routes/agent-mcp/operator-converse.ts",
        "sha256": "971b1cc208afa690a7d9336a0e063fc017fe1922a8c75e58792c4e71a34793ff"
      },
      {
        "path": "../agent-tools/operator/converse-prompt.ts",
        "sha256": "95aa4fe2072400a31441b44450ceee80c2e2a1601155a0ab9ac8cf9373c34eef"
      },
      {
        "path": "../endpoint-route/routes/agent-mcp/turn-start-memory.ts",
        "sha256": "1326f1ebfcf4fddc5fee1c2bf9bd257766bf26addafa2a2804d78a6b312ad0e2"
      },
      {
        "path": "../../../../libs/generic/cache/src/cache.ts",
        "sha256": "cb89ed6fe20876f5b7990bd36d850086ce6c2a424d76871bf9da47e6be79af42"
      },
      {
        "path": "../endpoint-route/routes/agent-mcp/mid-turn-context.ts",
        "sha256": "a0e5de3327e43cb5089437b6c68141f39ee5b351b5d9845ccc930af00606375d"
      },
      {
        "path": "../../vitest.config.ts",
        "sha256": "e4a79d32a604b4aa8605f80ec95b8aadc37a109452ecb8a685dd00d146fd0c49"
      },
      {
        "path": "../../../../apps/operator/scripts/hooks/inject/core.mjs",
        "sha256": "bd4140082b2cc54ef29db6af68ce91172423b737968dd8ce34d2bd34857a14d8"
      },
      {
        "path": "../../../../apps/operator/scripts/hooks/inject/recall-query.mjs",
        "sha256": "e549a42ab432535cdb1c34b8ea96734c9928c49819eee843abedb0fbb07249cf"
      },
      {
        "path": "../../../../apps/operator/scripts/hooks/inject/ports.mjs",
        "sha256": "f61c0b9614c6846fac570592088cabbea7d3ac179d073c0e10eeb29965b6e158"
      },
      {
        "path": "../../../../apps/operator/scripts/hooks/inject/adapters/codex.mjs",
        "sha256": "a39b9729a14df31f91f7b5ee009f1a382ce618fa2bead5b1303e101421652fc0"
      },
      {
        "path": "../../../../apps/operator/scripts/hooks/inject/adapters/claude.mjs",
        "sha256": "f6dc378f871bb0a2823f593815004e94540583a0f88515027003c6ce01573fbd"
      },
      {
        "path": "../../../../apps/operator/scripts/hooks/inject/adapters/omp.mjs",
        "sha256": "37cee8009854932f951db703faf68c42c535427ea13cc17fea3f6408af111501"
      }
    ],
    "testRunId": 23587529,
    "harnessAttribution": "run originally null; canonical binding may adopt caller harness after path validation",
    "sourceHashRecipe": "sha256(JSON.stringify(sourceSnapshot excluding integration test))",
    "reportSha256": "5772c8350ba00cfd854839864158ad3dbb6796fcd708ee68ac91a986bca26a16",
    "reportPath": "/tmp/ctx-r32-r4-v6-report.json",
    "logPath": "/tmp/ctx-r32-r4-v6-test.log",
    "limitations": [
      "Deterministic external database/index/identity fixtures",
      "No native-client emission, promotion, independent acceptance, or deployed-runtime claim"
    ]
  }
}
