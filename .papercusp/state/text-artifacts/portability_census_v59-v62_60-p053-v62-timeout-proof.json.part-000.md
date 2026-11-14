---
rel_path: "portability/census/v59-v62/60-p053-v62-timeout-proof.json.part-000"
updated_at: 1794254873437
_body: "content"
---

{
  "outcome": "deadline-before-verdict",
  "taskId": "0mw9o8j8zukfamy8geb",
  "lastStage": {
    "stage": "collect-state-census",
    "at": "2026-11-09T19:48:20.164Z"
  },
  "censusFilePresent": false,
  "runnerProofPresent": false,
  "savedSnapshot": {
    "phase": "before-filesystem",
    "roots": 4,
    "declarations": 77748,
    "catalogEntries": 1556,
    "kinds": {
      "path": 76194,
      "database": 24,
      "unit": 1481,
      "secret": 49
    },
    "topProducers": [
      [
        "test-file-native-router-custody",
        66061
      ],
      [
        "task-reconcile-reap-tail-archive",
        9106
      ],
      [
        "unit-definition:/usr/lib/systemd/system",
        511
      ],
      [
        "unit-definition:/run/user/1000/systemd/transient",
        401
      ],
      [
        "cupboard-installed-template-store",
        202
      ],
      [
        "unit-definition:/usr/lib/systemd/user",
        178
      ]
    ]
  },
  "v60SourcePinsMatch": true,
  "actualSourcePins": {
    "packages/operator-core/lib/backup/state-census-producers.ts": "2dc696d1ffb3b7f45697321d0a9a14d9d827fc51f4930ab260b28cd75bd72370",
    "packages/operator-core/lib/backup/state-census-producers.test.ts": "2ed1eb1a8bde72dc6a31d3e365bc0ffa01ae17bc2fe59f809db25c6d9c575638",
    "scripts/state-census-roots.mts": "e0f8c4c3487269c4169b57dc43abf4abe802733003356fd41a17c917e75a36f0",
    "packages/operator-core/lib/backup/state-census-cli.test.ts": "354be1a6920a6aac3b85ae3d3a1c3c1442dded7945a2f35c5a3d8aba8ce748d9",
    "packages/operator-core/lib/admin-commands.ts": "5252c8ffa09caefb24a757281d6887998c84660002370cea8854bd660fa71544",
    "packages/operator-core/lib/admin-commands.test.ts": "9fb8fd99e2c6b5f2c49446d42d356245bb4d0a46375c7d6ebd6d12db6e90adbe"
  },
  "corePin": "738a90b7c540fbb87e5c13ac28fd3305c25beaf0ca3b618f900f7ac62e9b73cf",
  "v42ToV61ResidueDelta": null,
  "deltaReason": "No v61 census verdict was written before its task deadline; discovery snapshots are not final census inputs or results.",
  "wholeInstallVerified": false
}
