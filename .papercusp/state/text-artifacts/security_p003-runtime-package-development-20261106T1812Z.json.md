---
rel_path: "security/p003-runtime-package-development-20261106T1812Z.json"
updated_at: 1793988803304
_body: "content"
---

{
  "schemaVersion": 1,
  "kind": "security-development-evidence",
  "unit": "P-003 trusted handler runtime packaging",
  "workItem": "WI-6554700010045702",
  "plan": "app-security-runtime-boundaries-and-defense-in-depth-2026-10-31",
  "measuredAt": "2026-11-06T18:12:00Z",
  "scope": "Local Linux development components. Not SEC acceptance, platform qualification, authenticated authorship approval or signed installed shipment.",
  "sources": {
    "apps/operator/bin/bundle-host-common.sh": "44f3e7f66b610da646170cd42fa0e20913fc9f32abef6e353e8bb768b867c23c",
    "packages/operator-core/lib/worker-scripts-bundled.test.ts": "217138486645262d275ba8c6c42abae351c541f6fa44a6fc330cc470b5a44f09",
    "papercusp-desktop/bin/build-desktop-sidecar.sh": "38d8bb2bf799e442a3e31764593f414a2f7dee91baf376025ce427b6816b2344",
    "papercusp-desktop/bin/lib/host-runtime-closure.sh": "3ba9cb7d0932b0c23f4bdc98967df780d7173409eb5d5018e0c7cf81fdbbcafe",
    "papercusp-desktop/bin/lib/handler-runtime-package.mjs": "90ba687552c71fa88e4aeec4ef84bcb8a7be8915fcfe2b47000ae22442dc7c63",
    "papercusp-desktop/test/build-desktop-sidecar-dependency-closure.test.js": "20bb6a2ce2b8509f82483f69bb5cb8d307b203a6b695a037637da98fe806de2e"
  },
  "evidence": [
    {
      "runId": "62ce9202-40da-48f2-912e-8f9182a7744d",
      "testRunId": 23499550,
      "status": "pass",
      "exitCode": 0,
      "passed": 5,
      "failed": 0,
      "skipped": 0,
      "scope": "Real relocated Node/Koffi and ELF closure negative cases; helper and desktop test hashes unchanged."
    },
    {
      "runId": "240186c9-b84d-45b0-9a8d-dba327b0453d",
      "testRunId": 23499680,
      "status": "pass",
      "exitCode": 0,
      "outputCounts": {
        "passed": 17,
        "failed": 0,
        "skipped": 0
      },
      "scope": "Full desktop dependency closure file output. Requested negative selector fidelity unconfirmed; do not infer filtering or independent non-overlapping coverage."
    },
    {
      "runId": "f467613d-f681-40e2-9a80-b014d181e19a",
      "testRunId": 23499679,
      "status": "fail",
      "exitCode": 1,
      "cause": "Fixture setup npm cache ENOSPC before worker recipe assertions",
      "scope": "Before two-file compiler-lease integration adjustment; not a measured pass on current sources."
    },
    {
      "kind": "shell-syntax",
      "command": "bash -n apps/operator/bin/bundle-host-common.sh",
      "exitCode": 0
    }
  ],
  "changes": "Reuse shared bundle_host_workers and desktop host-runtime closure; standalone guest CJS compilation; target-specific Koffi loader/addon; static DT_NEEDED/interpreter traversal via objdump/readelf without executing candidates; staged immutable-mode files with digest inventory. Two-file follow-up updates compiler lease coverage/control and adds Node --check emitted CJS test.",
  "remaining": [
    "Worker compatibility verification on current two-file source",
    "Scoped types for changed maintained TypeScript test if appropriate",
    "Current protected trust/source and complete authenticated-author producer",
    "Ordinary runtimeDispatch/P002/P004 integration",
    "Platform qualification and exact signed installed artifact acceptance at P020"
  ],
  "blocker": {
    "item": "EI-28062837400239653",
    "owner": "su-8e582458-5f13-475d-8950-77e479c89a18",
    "evidence": "npm cache/root ENOSPC in ledger23499679; /tmp is a different filesystem with capacity",
    "request": "coord-send-f9d9e61bba5a25243b5a7ecc7afe5bd0ba646057ed0362bc5bba6de724286657"
  },
  "acceptance": "All16BARs,20items,D008-D010 and independent acceptance retained."
}
