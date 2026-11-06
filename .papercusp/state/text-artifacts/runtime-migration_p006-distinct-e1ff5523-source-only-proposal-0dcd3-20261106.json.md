---
rel_path: "runtime-migration/p006-distinct-e1ff5523-source-only-proposal-0dcd3-20261106.json"
updated_at: 1793963320615
_body: "content"
---

{
  "schemaVersion": "bun-distinct-source-only-proposal-v1",
  "createdAt": "2026-11-06T11:06:00Z",
  "ownerId": "su-0dcd3a3c-a45f-482b-a8cd-e957407353f9",
  "workItem": "WI-6554700010022072",
  "plan": "node-to-bun-staged-migration-2026-10-22",
  "status": "PREPARED_NOT_EXECUTED_PENDING_REVIEW",
  "request": "Independent disposition of a DISTINCT successor scoped to committed current source e1ff5523 and a new absent destination after terminal D021 NO_START; not a retry or retarget of the D021 packet.",
  "priorAuthority": {
    "planVersion": 59,
    "contentHash": "b0960ad3f13768bfd0cc3b7940eb06fceffe9a9daef6ebd20bcc8ab8b061f864",
    "discoveryAudit": 18,
    "discoveryReady": true,
    "activation": 17,
    "canonicalExecutionStartSequence": 59,
    "limits": "Discovery18 repairs declaration only. Activation17/start59 are historical. D021's sole activation refused discovery_not_ready and is TERMINAL_NO_START with no plans:start or source/native launch. New exact-byte independent disposition, any required Discovery reconciliation, fresh semantic activation audit, and ordinary canonical plans:start are prerequisites; none is implied by this packet.",
    "terminalScopeProof": "runtime-migration/p006-d021-no-start-discovery-reconcile-0dcd3-20261106.json"
  },
  "distinctness": {
    "sourcePin": "e1ff55230c4bfc416a7c1e1fa7382968db8c3f39",
    "destination": "/mnt/data/tmp/bun-p006-source-e1ff5523-0dcd3-20261106",
    "original": "D011-D021 remain terminal. Do not read, select, lease, qualify, compare, retarget, rewrite or replace original 14ce/a027/b8c1 generation, privateHEAD8dfbd, helper20fee or verifier6c59. New source is not a new diagnostic of that tuple.",
    "purpose": "Prepare fresh source containing the already verified moduleRepoRoot repair before designing new dependency and producer acceptance. It neither rebuilds any prior signed package nor re-runs completed native/lifecycle checks.",
    "newScope": "New immutable product source commit and new destination/post-read fixture. This does not refresh the terminal D021 command's helper pin or reuse its failed admission. The helper is independently measured as d82 again, not silently represented as the earlier ea7."
  },
  "measuredPreparation": {
    "workingAndPinBlobsMatch": true,
    "setupSha256": "d4ae670ce90bcd18217e8dc47d3e9d43b215c4d9469f7024908777d218fc1302",
    "dependencyHelperSha256": "d82cbd824e3447688ba664c1c9ab17307f11f1a39a60f88205d469cbc975ee5e",
    "moduleRepoRootSha256": "9acfd7a4fb5d5f7a94ec80290194055ecfff7a63b753615f1ab8ad74e071abb7",
    "destinationAbsent": true,
    "siblingStashAbsent": true,
    "readAt": "2026-11-06T11:04:26Z",
    "note": "Setup/helper/moduleRepoRoot Git blobs at fixed e1ff5523 equal measured working bytes. Shared HEAD may advance; fixed product pin does not. Destination and exact sibling scratch absent. These are preparation reads, not candidate execution."
  },
  "reuse": {
    "materializer": "apps/operator/bin/release/setup-release-checkout.sh --source-only --source-root-mode clone --source-integrity object-sourced --node-modules skip",
    "sourceReadSections": "Argument and source-only guards; capacity and host-copy-lock preflight; independent root clone; local object-sourced submodule clone/fallback; recursion guard; source-only exit before dependencies.",
    "newDurableSurface": "none: existing artifact store, held P006 lane, source materializer and native task runner"
  },
  "writes": [
    "Only new destination root and its independent .git/config/index/submodule repositories/source files; immutable Git object inodes may be shared on the same filesystem.",
    "Only sibling .bun-p006-source-e1ff5523-0dcd3-20261106.submodule-node-modules scratch; the complete exact path must be absent before entry. Maintained helper can remove this own scratch and replace submodule destinations exclusively inside the newly allocated root.",
    "Existing host allocation lock at default TMPDIR/tmp papercusp-dependency-generation-copy.lock and its holder metadata. Do not override the lock to evade peers; cap wait at5s. An OS fd releases the hold on task exit; a stale own holder text may remain and is not a held lock.",
    "Managed task/log/receipt bookkeeping. No live generation publish lock, selector lease, generation cleanup/prune, dependency traversal/copy/install, package build, VM, runtime boot, release/gate or integration-tree source edit."
  ],
  "preconditions": [
    "Before any launch, qualify current :3170 serving runtime/build, source containment and published capability:bash require_task_confinement:true. Prior serving-contract observations do not prove current process cleanup.",
    "Use only ordinary plan/claim/native admission and positive task confinement. No legacy runner, raw exec fallback, field stripping or altered confinement.",
    "No current candidate runtime exists yet: dev:pipeline_position(candidate-install-upgrade) readiness gap explicitly requires owned package/platform/signing/rollback target. This source-only phase prepares a prerequisite and is not an execution of that gap.",
    "The new independent disposition must require independent disposition of these exact revised bytes, followed by a fresh semantic activation audit and ordinary canonical plans:start covering this distinct materialization. If admission refuses, record terminal receipt, no retry or scope substitution."
  ],
  "budgets": {
    "outerTaskMs": 390000,
    "sourceProcessTermAfterSec": 300,
    "sourceProcessKillAfterSec": 30,
    "sharedCopyLockWaitAndMaxSec": 5,
    "postReadDeadlinesSec": [
      10,
      20,
      20
    ],
    "note": "The5s copy-lock wait is not a hard ceiling for underlying /proc sampling. The outer confined task deadline bounds the full subtree. No native launch occurred in preparing this proposal."
  },
  "failurePolicy": "First changed hash/path guard, missing object/capacity refusal, admission/confinement refusal, nonzero, timeout or incomplete cleanup terminates this distinct e1ff5523 scope. Preserve any own partial destination and actual managed task log; no delete-and-retry, fallback, fresh pin, retarget or post-deadline probe. Do not interpret tool transport failure as no task; reconcile the original durable task/ledger before any next action.",
  "verification": "Require actual native0, source-only ready and CANDIDATE_SOURCE_INTEGRITY live_tree=0 markers, exact fixed HEAD, standalone .git, no tracked/untracked source drift, complete pinned submodule traversal, unchanged helper hashes, final READY marker and actual managed subtree cleanup. A source receipt never implies dependencies, packages, installed Bun, matrix coverage or shipment.",
  "retainedLimits": "Node remains selected; Bun UNSHIPPED. Existing final-package, installed Linux, Mac retained baseline, ARM native module-root and P004 local source evidence retain their bounded meanings. No additional implementation agent; no LIVE_GATE_OPS.",
  "nativeArgs": {
    "command": "set -euo pipefail\ncd /home/marsh-office/papercupai-workspace/papercusp\ntest \"$(pwd -P)\" = '/home/marsh-office/papercupai-workspace/papercusp'\ntest \"$(git cat-file -t e1ff55230c4bfc416a7c1e1fa7382968db8c3f39)\" = commit\nsha256sum -c <<'BUN_SOURCE_INPUTS'\nd4ae670ce90bcd18217e8dc47d3e9d43b215c4d9469f7024908777d218fc1302  apps/operator/bin/release/setup-release-checkout.sh\nd82cbd824e3447688ba664c1c9ab17307f11f1a39a60f88205d469cbc975ee5e  apps/operator/bin/release/dependency-generation.sh\nBUN_SOURCE_INPUTS\ntest \"$(realpath -m /mnt/data/tmp/bun-p006-source-e1ff5523-0dcd3-20261106)\" = '/mnt/data/tmp/bun-p006-source-e1ff5523-0dcd3-20261106'\ntest ! -e '/mnt/data/tmp/bun-p006-source-e1ff5523-0dcd3-20261106'\ntest ! -L '/mnt/data/tmp/bun-p006-source-e1ff5523-0dcd3-20261106'\ntest ! -e '/mnt/data/tmp/.bun-p006-source-e1ff5523-0dcd3-20261106.submodule-node-modules'\ntest ! -L '/mnt/data/tmp/.bun-p006-source-e1ff5523-0dcd3-20261106.submodule-node-modules'\nexport DEPENDENCY_GENERATION_COPY_LOCK_TIMEOUT_SEC=5\nexport DEPENDENCY_GENERATION_COPY_LOCK_MAX_SEC=5\ntimeout --signal=TERM --kill-after=30s 300s /bin/bash apps/operator/bin/release/setup-release-checkout.sh --ref e1ff55230c4bfc416a7c1e1fa7382968db8c3f39 --integration '/home/marsh-office/papercupai-workspace/papercusp' --release '/mnt/data/tmp/bun-p006-source-e1ff5523-0dcd3-20261106' --source-only --source-root-mode clone --source-integrity object-sourced --node-modules skip\ncandidate_head=$(timeout 10s git -C '/mnt/data/tmp/bun-p006-source-e1ff5523-0dcd3-20261106' rev-parse HEAD) || exit \"$?\"\ntest \"$candidate_head\" = 'e1ff55230c4bfc416a7c1e1fa7382968db8c3f39'\ntest -d '/mnt/data/tmp/bun-p006-source-e1ff5523-0dcd3-20261106/.git'\ncandidate_status=$(timeout 20s git -C '/mnt/data/tmp/bun-p006-source-e1ff5523-0dcd3-20261106' status --porcelain --untracked-files=all --ignore-submodules=none) || exit \"$?\"\ntest -z \"$candidate_status\"\ntimeout 20s git -C '/mnt/data/tmp/bun-p006-source-e1ff5523-0dcd3-20261106' submodule status --recursive\nsha256sum -c <<'BUN_SOURCE_INPUTS'\nd4ae670ce90bcd18217e8dc47d3e9d43b215c4d9469f7024908777d218fc1302  apps/operator/bin/release/setup-release-checkout.sh\nd82cbd824e3447688ba664c1c9ab17307f11f1a39a60f88205d469cbc975ee5e  apps/operator/bin/release/dependency-generation.sh\nBUN_SOURCE_INPUTS\nprintf '%s\\n' 'BUN_DISTINCT_E1FF5523_SOURCE_ONLY_READY'",
    "description": "Prepare one distinct committed e1ff5523 Bun candidate source after new review",
    "cwd": "/home/marsh-office/papercupai-workspace/papercusp",
    "work_item_id": "WI-6554700010022072",
    "require_task_confinement": true,
    "timeout": 390000,
    "run_in_background": true
  },
  "revision": {
    "decisionRequired": "NEW independent exact-current-byte disposition; not yet granted",
    "change": "Rebind minimal maintained post-read fixture to new immutable source pin and absent destination; preserve all explicit assignment-exit guards and task cleanup limits. No product/helper edit.",
    "maintainedFixture": "apps/operator/lib/release/fixtures/bun-source-only-2929ed-proposal.json",
    "fixtureSha256": "5d94b3c9b2d6eeb2702083574cc5b7941646317d52579a7bbabf64958fced22c",
    "regressionSuite": "apps/operator/lib/release/bun-source-only-post-read-guards.test.ts",
    "regressionSha256": "5fbcbf44858197e8c59d7e9950fe50e0c48fd0dec5cb6192afb76ca146bec42a",
    "scope": "Existing minimal fixture/test reused; legacy fixture filename does not define the new scope. Full machine execution packet remains only in canonical artifacts; syntax/static proof does not execute it."
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
  "priorTerminalPacket": "runtime-migration/p006-distinct-2929ed-source-only-guard-fixture-proposal-0dcd3-20261106.json",
  "regressionEvidence": {
    "originRunId": "8b4ea7a6-37d1-4e92-975a-a9d9bb85d240",
    "detachedRunId": "44c5b312-31b5-42b3-acad-6ffbcdaf8b26",
    "taskId": "0mw4vc10f1oyvhwm1fo",
    "status": "PASS",
    "exitCode": 0,
    "completedAt": "2026-11-06T11:06:27.477Z",
    "jsonReport": "/tmp/pcv/papercusp-testing-run-detached-e5439943-fb0d-4a01-926f-8de5a61a3287.json",
    "limits": "This test substitutes only test-owned scratch, fake Git reads and shortened timeout deadlines. It never executes the candidate materializer."
  }
}

