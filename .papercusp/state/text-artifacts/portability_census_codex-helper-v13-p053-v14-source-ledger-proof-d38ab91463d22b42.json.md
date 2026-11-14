---
rel_path: "portability/census/codex-helper-v13-p053-v14-source-ledger-proof-d38ab91463d22b42.json"
updated_at: 1794223750049
_body: "content"
---

{
  "runGroup": "53b7173e-af34-48cc-ad68-301ff0823eef",
  "ledgerId": 23732944,
  "root": "/home/marsh-office/papercupai-workspace/papercusp",
  "newRegression": {
    "caseKey": "secret census producer adapters > proves helpers from another installed npm Codex without depending on PATH selection",
    "occurrence": 1,
    "status": "pass",
    "durationMs": 19,
    "errorTail": null
  },
  "beforeAndAfterSourcePins": [
    {
      "path": "packages/operator-core/lib/backup/state-census-producers.ts",
      "sha256": "5a54d6ed4e5e72553a263154cdbd4f471b8449c287945679091b66292b242d68"
    },
    {
      "path": "packages/operator-core/lib/backup/state-census-producers.test.ts",
      "sha256": "60b25e2e8a9faa173c72a781ddc4325e3688bb4c5959655caabbd7b0ebd31fcd"
    }
  ],
  "evidenceLimit": "Selected test hash and unchanged producer pins, actual new regression pass and clean child exit; native protocol unqualified and no loaded-import source closure; not acceptance or shipment evidence.",
  "nativeCustody": {
    "directory": "/home/marsh-office/.papercusp/test-artifacts/testing-run/run-3YaHr3/native-proof",
    "locator": {
      "manifest": {
        "ref": "c3099b57fadbb9be4c98a54078d254791acf0c9f98ca0129b64d68fca67d1e5b.native-proof.json",
        "sha256": "c3099b57fadbb9be4c98a54078d254791acf0c9f98ca0129b64d68fca67d1e5b",
        "byteLength": 16560
      },
      "identity": {
        "workspace": "papercusp-workspace",
        "harness": "papercusp",
        "runId": "53b7173e-af34-48cc-ad68-301ff0823eef"
      },
      "expectedHash": "8bcdeb8852078119e7db3ed91af6d6efe0ca7e44a2b048a5814ff8d91cd4a53e",
      "inventoryHash": "a2adeb2714adc749a6b601ec83fcf3ba009f7672d587436f6093247902b7087d"
    },
    "byteCustody": "complete",
    "writerState": "settled",
    "routerCustody": [
      "complete"
    ],
    "nativeProof": "unqualified",
    "acceptance": "unmeasured",
    "producerRetirement": "not-performed"
  }
}

