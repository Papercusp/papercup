---
rel_path: "portability/census/codex-hoisted-v14-p053-v15-source-proof-6cecd2db692b8070.json"
updated_at: 1794224597655
_body: "content"
---

{
  "runGroup": "14337dac-b179-4285-95ad-40b7f04f7b33",
  "ledgerId": 23736199,
  "sourcePins": [
    {
      "path": "packages/operator-core/lib/backup/state-census-producers.ts",
      "sha256": "4115e89d70ec3bae3c5adda73feac63d73592a2d90b1a5f9b0c09b0a7ba1aa74"
    },
    {
      "path": "packages/operator-core/lib/backup/state-census-producers.test.ts",
      "sha256": "3936568d459925278e1210f9b254b13b33ee92e9517c2424769be73b449bfc28"
    }
  ],
  "newRegression": [
    {
      "caseKey": "secret census producer adapters > proves hoisted optional Codex helpers through their owning CLI package",
      "occurrence": 1,
      "status": "pass",
      "durationMs": 13,
      "errorTail": null
    }
  ],
  "childState": "closed",
  "result": {
    "ok": true,
    "runId": "14337dac-b179-4285-95ad-40b7f04f7b33",
    "root": "/home/marsh-office/papercupai-workspace/papercusp",
    "passed": 82,
    "failed": 0,
    "skipped": 0,
    "files": 1,
    "failures": [],
    "failuresTruncated": false,
    "durationMs": 3697,
    "byFile": {
      "packages/operator-core/lib/backup/state-census-producers.test.ts": {
        "passed": 82,
        "failed": 0,
        "skipped": 0,
        "collectionFailed": false
      }
    }
  },
  "nativeCustody": {
    "directory": "/home/marsh-office/.papercusp/test-artifacts/testing-run/run-ncF69r/native-proof",
    "locator": {
      "manifest": {
        "ref": "9010eedabc2ca93d544753c563c83b312d9c935157bbe920ebd669478f6e9b55.native-proof.json",
        "sha256": "9010eedabc2ca93d544753c563c83b312d9c935157bbe920ebd669478f6e9b55",
        "byteLength": 16560
      },
      "identity": {
        "workspace": "papercusp-workspace",
        "harness": "papercusp",
        "runId": "14337dac-b179-4285-95ad-40b7f04f7b33"
      },
      "expectedHash": "2d0ad658e39ef4c8147032f2d886690a900d46d2f76040933ece188eecba54cb",
      "inventoryHash": "d21a67bd42ffb7b852b4804d6e9aa5800554b8ec4327f67a2661b0c16d324c68"
    },
    "byteCustody": "complete",
    "writerState": "settled",
    "routerCustody": [
      "complete"
    ],
    "nativeProof": "unqualified",
    "acceptance": "unmeasured",
    "producerRetirement": "not-performed"
  },
  "limit": "Unit suite only; import closure unmeasured; native proof unqualified; no migration or shipment acceptance."
}
