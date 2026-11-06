---
rel_path: "runtime-migration/p006-distinct-e1ff5523-source-only-preparation-proof-0dcd3-20261106.json"
updated_at: 1793963320615
_body: "content"
---

{
  "schemaVersion": "bun-distinct-current-byte-source-preparation-proof-v1",
  "createdAt": "2026-11-06T11:09:00Z",
  "ownerId": "su-0dcd3a3c-a45f-482b-a8cd-e957407353f9",
  "workItem": "WI-6554700010022072",
  "plan": "node-to-bun-staged-migration-2026-10-22",
  "proposal": "runtime-migration/p006-distinct-e1ff5523-source-only-proposal-0dcd3-20261106.json",
  "status": "PREPARATION_ONLY_NOT_CANDIDATE_EXECUTION",
  "validation": {
    "proposalChars": 12501,
    "proposalSha256": "376613b5aca5c84219a735da49d1ebf28eb613bcaf60e6026c13a8a5b3e9e800",
    "commandChars": 2339,
    "commandSha256": "30388636c75d0010b52af5568d6048d889e6e625abf64475fd245a6961cb2954",
    "actualNewlines": 26,
    "bashSyntaxExit": 0,
    "bashSyntaxStderr": "",
    "fixtureChars": 796,
    "fixtureSha256": "5d94b3c9b2d6eeb2702083574cc5b7941646317d52579a7bbabf64958fced22c",
    "exactPostReadEquals": true,
    "postReadChars": 563,
    "postReadSha256": "2423e1b563d07633ae37eefaf2d1c65ed4c02ed7c4e606e3c3732b641613f693",
    "fixturePinEquals": true,
    "fixtureDestinationEquals": true
  },
  "sourceBindings": {
    "workingAndPinBlobsMatch": true,
    "setupSha256": "d4ae670ce90bcd18217e8dc47d3e9d43b215c4d9469f7024908777d218fc1302",
    "dependencyHelperSha256": "d82cbd824e3447688ba664c1c9ab17307f11f1a39a60f88205d469cbc975ee5e",
    "moduleRepoRootSha256": "9acfd7a4fb5d5f7a94ec80290194055ecfff7a63b753615f1ab8ad74e071abb7",
    "destinationAbsent": true,
    "siblingStashAbsent": true,
    "readAt": "2026-11-06T11:04:26Z",
    "note": "Setup/helper/moduleRepoRoot Git blobs at fixed e1ff5523 equal measured working bytes. Shared HEAD may advance; fixed product pin does not. Destination and exact sibling scratch absent. These are preparation reads, not candidate execution."
  },
  "helperDrift": {
    "priorObservedSha256": "ea7adad673f9461e76f9d690bc95c646f354c5380a855d7ce25cf5e5059697fd",
    "priorProof": "runtime-migration/p006-d021-no-start-discovery-reconcile-0dcd3-20261106.json",
    "currentObservedSha256": "d82cbd824e3447688ba664c1c9ab17307f11f1a39a60f88205d469cbc975ee5e",
    "currentWorkingMatchesPin": true,
    "currentScopedGitStatus": "empty",
    "latestHelperCommit": "140d8bdbee6c91ecbae1c6e6089e4a3923fb9414",
    "selectorDifference": "Earlier ea7 removed the legacy fallback in dependency_generation_select_verifier_inputs: missing native selector returned74. Current committed d82 again uses [ -f native-selector ] || key=input before selecting. The earlier observed change is not present now; its intervening writer/cause is unestablished.",
    "scopeAnalysis": "--source-only plus --node-modules skip excludes early explicit generation lease and exits at setup-release-checkout.sh SOURCE_ONLY branch before all dependency selection, materialization, and verifier calls. This scope must neither call nor qualify select_verifier_inputs. No new claim about generation/native acceptance follows.",
    "correctionSent": "coord-send-6c0703369b82a4625eaa2127db9a1022e582b48e2f71f4070e3b24f23dcb3e76"
  },
  "test": {
    "originRunId": "8b4ea7a6-37d1-4e92-975a-a9d9bb85d240",
    "detachedRunId": "44c5b312-31b5-42b3-acad-6ffbcdaf8b26",
    "taskId": "0mw4vc10f1oyvhwm1fo",
    "status": "PASS",
    "exitCode": 0,
    "completedAt": "2026-11-06T11:06:27.477Z",
    "jsonReport": "/tmp/pcv/papercusp-testing-run-detached-e5439943-fb0d-4a01-926f-8de5a61a3287.json",
    "limits": "This test substitutes only test-owned scratch, fake Git reads and shortened timeout deadlines. It never executes the candidate materializer.",
    "entryTool": "testing:run",
    "files": [
      "apps/operator/lib/release/bun-source-only-post-read-guards.test.ts"
    ],
    "foregroundResult": "25s foreground cap; timeout receipt contains durable detached recovery ID; no manual rerun.",
    "detachedReadback": "testing:run-status current3170 returned snapshot.status=pass,exitCode=0,taskId=0mw4vc10f1oyvhwm1fo,finishedAt=1793963187477",
    "outputProof": "TEST_FILE_RESULT requested=1 executed=1 matched=1 status=passed head=e1ff55230c uncommittedPaths=0/1 provenance=stamped childSubstituted=0 skippedTests=0",
    "counts": "Not asserted: exact total counts were not returned by the bounded readback. Temporary JSON path in command is not available from this reader; terminal snapshot is the retained evidence.",
    "fixtureBeforeAndAfterSha256": "5d94b3c9b2d6eeb2702083574cc5b7941646317d52579a7bbabf64958fced22c",
    "testSourceSha256": "5fbcbf44858197e8c59d7e9950fe50e0c48fd0dec5cb6192afb76ca146bec42a",
    "guardCases": [
      "correct HEAD/clean status/submodule success",
      "HEAD failure after valid output",
      "HEAD timeout after valid output",
      "empty status failure",
      "empty status timeout",
      "submodule failure",
      "submodule timeout",
      "wrong HEAD",
      "dirty status",
      "exact Bash syntax"
    ],
    "scope": "Only the post-read guard fixture is executed against fake Git and scratch destination; candidate materializer is not run."
  },
  "filesChanged": [
    "apps/operator/lib/release/fixtures/bun-source-only-2929ed-proposal.json"
  ],
  "reuse": "Reused minimal maintained fixture, existing suite, held P006 work-item, artifact store and testing router. No new durable surface, helper edit, implementation worker or fleet.",
  "open": [
    "Independent current-byte disposition",
    "Discovery reconciliation for any new decision",
    "Fresh semantic activation",
    "Ordinary canonical plans:start",
    "Current serving-runtime containment and positive task confinement",
    "Actual source-only native execution/cleanup",
    "Dependency/native/installed platform/launcher/canary/rollback/final shipment"
  ],
  "limits": "D011-D021 remain terminal. D021 NO_START is not retried. Node selected; Bun UNSHIPPED. No activation/start/source materialization, dependency selection/lease/install/build, VM, runtime change or LIVE_GATE_OPS."
}

