---
rel_path: "security/p001-current-boot-source-binding-20261107-v1.json"
updated_at: 1794028903021
_body: "content"
---

{
  "schema": "p001-current-boot-source-binding-v1",
  "plan": "app-security-runtime-boundaries-and-defense-in-depth-2026-10-31",
  "workItem": "WI-6554700010045753",
  "producer": "su-9aa0bac1-57ab-408e-a009-fd2b58012aa0",
  "recordedAt": "2026-11-07T05:21:35.728294+00:00",
  "status": "BOOT_INPUT_CORRESPONDENCE_ONLY",
  "scope": "Authenticated staging runtime discovery and exact independently read bundle/manifest bytes. Source-input correspondence only; no dynamic plugin/dependency loaded-byte qualification or effect acceptance.",
  "refs": {
    "snapshot": "immutable/sha256/5dce235119f5636527e0012db76aa2157a9e73d0bc8c786543c6097cad66bd70.json",
    "receipt": "immutable/sha256/81d7d0f310472636e029d979aa55f639968bc06729ccaf06eea0b30d9a366c07.json",
    "retainedBootManifest": "security/p001-retained-boot-manifest-f7516b4392671fc0730eba6b46dfdea8c6aa6bc0a92a080ff05402d69898738f.json",
    "sourcePreparation": "security/p001-installed-runtime-binding-preparation-20261107-v1.json",
    "priorOccurrence": "security/p001-current-runtime-occurrence-binding-20261107-v3.json",
    "priorClassification": "security/p001-native-distribution-source-classification-20261107-installed-runtime-bindings-v26.json"
  },
  "runtimeIdentity": {
    "arch": "x64",
    "artifact": {
      "bundleSha256": "ed98367a57d8b10f6ccf872fd60b1137a1a583967c58dbbd03ed15b34e3e383e",
      "evidenceRef": "/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-df01a886c5d2.Y2z7wF/checkout/apps/operator/dist-host/hono-host.mjs.artifact-ed98367a57d8b10f6ccf872fd60b1137a1a583967c58dbbd03ed15b34e3e383e.json",
      "manifestSha256": "f7516b4392671fc0730eba6b46dfdea8c6aa6bc0a92a080ff05402d69898738f",
      "sourceSha": "df01a886c5d27fa88c0f9fd65ac8f3e207e7eb6b",
      "status": "measured"
    },
    "nodeVersion": "v25.9.0",
    "platform": "linux",
    "processId": 968654
  },
  "verification": {
    "snapshotSha256": "5dce235119f5636527e0012db76aa2157a9e73d0bc8c786543c6097cad66bd70",
    "snapshotChars": 2561555,
    "fullReadback": true,
    "hostAuthenticatedReadback": true,
    "manifestSha256": "f7516b4392671fc0730eba6b46dfdea8c6aa6bc0a92a080ff05402d69898738f",
    "manifestBytes": 786393,
    "manifestFileStableAcrossRead": true,
    "bundleSha256": "ed98367a57d8b10f6ccf872fd60b1137a1a583967c58dbbd03ed15b34e3e383e",
    "sourceSha": "df01a886c5d27fa88c0f9fd65ac8f3e207e7eb6b",
    "scope": "boot-bundle-tracked-inputs-only",
    "independentReaders": [
      "Python hashlib/json",
      "Node crypto/fs/JSON"
    ],
    "trackedInputs": 7537,
    "rowBasis": "retained sourceRows[].gitBlobSha1 compared exactly to boot manifest.sourceBlobs[path]; no inference from sourceSha alone",
    "retainedPreparationSha256": "1e634cc89f7459aa4872b52c68f55b9f3d362ac5dd6ad879317cf403e7d53630"
  },
  "sourceBindings": [
    {
      "path": "packages/operator-core/lib/projected-tool-deps.ts",
      "retainedGitBlob": "55a2df3f593690ac376d61d20a091568ae6ae189",
      "retainedSha256": "7a48683f1e58ff49d7d076dd2ef411f3ce7d51ecf1430bcc0e9023e15bc8d613",
      "bootInputGitBlob": "b33dd5caba5486a5f2b51dc0772af7cffb62e970",
      "status": "different-retained-blob"
    },
    {
      "path": "packages/operator-core/lib/plugin-invocation-policy.ts",
      "retainedGitBlob": "f6a870b598eca97b363e2ae288f663cffb3f9863",
      "retainedSha256": "5c21ada68ea6b32188a76a3a318041cc4c854236a8849ef7cac9c3d75e4c4ac3",
      "bootInputGitBlob": "e8d8869669ff78dccf248cf87fdab1eae1451209",
      "status": "different-retained-blob"
    },
    {
      "path": "packages/operator-core/lib/plugin-handler-execution.ts",
      "retainedGitBlob": "742804fe9ae215813bc250f148f8530a6c186ca7",
      "retainedSha256": "e5b3673af9b2aeaabd2b177d889417122e29ca82b31e289632589a49bacee1e3",
      "bootInputGitBlob": null,
      "status": "outside-boot-input-map"
    },
    {
      "path": "packages/operator-core/lib/plugin-host-runtime.ts",
      "retainedGitBlob": "1a39b23becaa6ff42ae5deae24cb61e4a428288e",
      "retainedSha256": "e9e2c31881536c4572a08949758bd3a01a61e7a04b2978ac038fe6f7b145ecc3",
      "bootInputGitBlob": "1a39b23becaa6ff42ae5deae24cb61e4a428288e",
      "status": "exact-retained-blob"
    },
    {
      "path": "packages/operator-core/lib/plugin-api-mount.ts",
      "retainedGitBlob": "1f0c350e91acffcce5564d495af1bc7e0a08a5dc",
      "retainedSha256": "0507c49b4566fbadf1a6c629ff5f47aa0ddabcfcf58dca4f7d1952f3daf5f9ba",
      "bootInputGitBlob": "1f0c350e91acffcce5564d495af1bc7e0a08a5dc",
      "status": "exact-retained-blob"
    },
    {
      "path": "packages/plugin-loader/src/daemon/handler-runtime-build.ts",
      "retainedGitBlob": "6fb0e36916294f167491bbb041d7d1aef6ebf2de",
      "retainedSha256": "69274fb1e05883eb66be1b23c7f3fd4a3b391970d1ffc82d3ffd3dc276734400",
      "bootInputGitBlob": "6fb0e36916294f167491bbb041d7d1aef6ebf2de",
      "status": "exact-retained-blob"
    },
    {
      "path": "packages/plugin-loader/src/daemon/handler-runtime.ts",
      "retainedGitBlob": "8de41b5606383ce3311228e0b28ae03fcad4d74b",
      "retainedSha256": "b0760858dca489e5073dfb70c75c70b7f1723456619553ec51acf2008821bcfb",
      "bootInputGitBlob": "8de41b5606383ce3311228e0b28ae03fcad4d74b",
      "status": "exact-retained-blob"
    },
    {
      "path": "packages/plugin-loader/src/daemon/handler-installation.ts",
      "retainedGitBlob": "ae70a9227acbd19f47360649fde61f796f42ff3d",
      "retainedSha256": "9c22e64a5bdcae9c218c76fb3e7fef39e1ec8e875908e6beb5f1f50f7af267cf",
      "bootInputGitBlob": "ae70a9227acbd19f47360649fde61f796f42ff3d",
      "status": "exact-retained-blob"
    },
    {
      "path": "packages/plugin-loader/src/daemon/supervisor.ts",
      "retainedGitBlob": "b55a59345b81efc942ce27950c30e1d289e01800",
      "retainedSha256": "420a6343def4132bb291c5c08f735f419866c98cd53a61225be3ac442fc40442",
      "bootInputGitBlob": "b55a59345b81efc942ce27950c30e1d289e01800",
      "status": "exact-retained-blob"
    },
    {
      "path": "packages/plugin-loader/src/daemon/bwrap-args.ts",
      "retainedGitBlob": "c39fa7a714829eb7f818abb61cc94294f6e01929",
      "retainedSha256": "78e30d56580e137469d06afed36898a76c935d71608e396c8e3be858b173d6b7",
      "bootInputGitBlob": "c39fa7a714829eb7f818abb61cc94294f6e01929",
      "status": "exact-retained-blob"
    },
    {
      "path": "papercusp-desktop/bin/lib/handler-runtime-package.mjs",
      "retainedGitBlob": "24a9a35095e905ec2f96d7f224cd8a1b717ed0d1",
      "retainedSha256": "aa5ff86d6a07ad4e9a7425e2fbe3e4f2bfeca7159dbca40040192012c0f8c770",
      "bootInputGitBlob": null,
      "status": "outside-boot-input-map"
    },
    {
      "path": "papercusp-desktop/bin/lib/host-runtime-closure.sh",
      "retainedGitBlob": "7590e9c5dc68c4fa19e2e0a7ddfe24702c803f48",
      "retainedSha256": "1c3defc21c12d2360bbaad28105cf08f440b706768ad7f160a6d75f7b7366594",
      "bootInputGitBlob": null,
      "status": "outside-boot-input-map"
    },
    {
      "path": "papercusp-desktop/bin/build-desktop-sidecar.sh",
      "retainedGitBlob": "0f3f41b995d0bd3b9fbb5032c77b7fcb590c842c",
      "retainedSha256": "77fcc86d150911969b79f2b82a39ba5049ba5ae3efb6a1be290212499c69a4bf",
      "bootInputGitBlob": null,
      "status": "outside-boot-input-map"
    },
    {
      "path": "papercusp-desktop/src-tauri/distribution-contract.json",
      "retainedGitBlob": "63049a568cd27b976e4ff869209158d917ad96d7",
      "retainedSha256": "8ed2fea966769e0115187491dce96c7266640b878471c73e879b4892b26ced73",
      "bootInputGitBlob": null,
      "status": "outside-boot-input-map"
    }
  ],
  "bindingSummary": {
    "different-retained-blob": 2,
    "outside-boot-input-map": 5,
    "exact-retained-blob": 7
  },
  "latestFixCorrespondence": [
    {
      "path": "packages/operator-core/lib/observability/runtime.ts",
      "currentSha256": "be2a9c227ae41973033d57e0e324a445c6b80b9cb3d55456549382f3c5360760",
      "currentGitBlob": "e8c488b6e3e2e28518ee909c772b19801486bb7e",
      "bootInputGitBlob": "3a436295711e6fe6131b0dac25ca2e9ec443e397",
      "currentBytesMatchBootInput": false
    },
    {
      "path": "packages/operator-core/lib/plugin-api-mount.ts",
      "currentSha256": "7a4dfe1bdc8e1fb2e7d1a50ecb9a15de1104ce4b7f9d079efa3730cbd7a0f85f",
      "currentGitBlob": "3adc5e67ae642c3221eace561be6537550409011",
      "bootInputGitBlob": "1f0c350e91acffcce5564d495af1bc7e0a08a5dc",
      "currentBytesMatchBootInput": false
    }
  ],
  "populationComplete": false,
  "closureAccepted": false,
  "executionAdmitted": false,
  "limits": [
    "All seven closure populations remain UNKNOWN.",
    "Outside boot input map does not establish code absence or non-applicability.",
    "Exact blob correspondence does not prove handler execution, confinement or normal-journey success.",
    "Dynamic plugin package/import bytes and native dependency closure remain unbound.",
    "No source rescan, unchanged test replay, activation repeat, extra implementer or LIVE_GATE_OPS.",
    "P020 signed installed artifact proof and independent acceptance remain required."
  ],
  "next": "Bind captured candidate/module occurrences to package artifacts using existing installation/loader custody; preserve current build distinctions and independent applicability commitment."
}

