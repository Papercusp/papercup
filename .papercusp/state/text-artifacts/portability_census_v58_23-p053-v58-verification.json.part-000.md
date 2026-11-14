---
rel_path: "portability/census/v58/23-p053-v58-verification.json.part-000"
updated_at: 1794252348729
_body: "content"
---

{
  "scope": "installed EnvironmentFile metadata ownership; bounded real host and canonical unit suites only",
  "wholeInstallVerified": false,
  "sourceUnchanged": true,
  "sourcePins": {
    "packages/operator-core/lib/backup/state-census-producers.ts": "f9c1d6e70df93d3ec3c9cad30cb220705110a10b6e8eaf13ab5d50fe5a159dd0",
    "packages/operator-core/lib/backup/state-census-producers.test.ts": "cc6d60152fcbf43bd45a3675335a0b54bd08b89af999e858c4d3db36e2baf012",
    "scripts/state-census-roots.mts": "e0f8c4c3487269c4169b57dc43abf4abe802733003356fd41a17c917e75a36f0",
    "packages/operator-core/lib/backup/state-census-cli.test.ts": "354be1a6920a6aac3b85ae3d3a1c3c1442dded7945a2f35c5a3d8aba8ce748d9"
  },
  "terminal": {
    "runId": "a2877d5d-a7d2-4bab-a892-91cb5a1e4709",
    "status": "pass",
    "exitCode": 0,
    "finishedAt": 1794252255042
  },
  "ledgerRows": [
    23776113,
    23776112
  ],
  "typecheck": "v58 changed producer and test plus v57 corrected CLI exit0; roots unchanged after v56 all4file check",
  "eslint": "v58 changed producer/test exit0 with9warnings; v57 correctedCLI exit0 no warnings",
  "regression": "same-name installed links accepted; aliases, masks, loops, shadow definitions, unsupported paths and specifiers rejected; no credential bytes read",
  "hostProbe": "/tmp/p053-v58-unit-environment-probe.json",
  "rootCause": "v56 boundedSource rejects symlinks, including systemctl-linked installed services with same canonical service name; real host links witnessed in v57-installed-unit-links.json",
  "fix": "resolve installed definition with canonical source directory and exact target basename before bounded NOFOLLOW regular file read; preserve first installed identity precedence"
}
