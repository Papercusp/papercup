---
rel_path: "runtime-migration/p006-distinct-2929ed-source-only-proposal-0dcd3-20261106.json"
updated_at: 1793960035534
_body: "content"
---

{
  "schemaVersion": "bun-distinct-source-only-proposal-v1",
  "createdAt": "2026-11-06T10:14:00Z",
  "ownerId": "su-0dcd3a3c-a45f-482b-a8cd-e957407353f9",
  "workItem": "WI-6554700010022072",
  "plan": "node-to-bun-staged-migration-2026-10-22",
  "status": "PREPARED_NOT_EXECUTED",
  "request": "Independent disposition of one new object-sourced source-only clone for a distinct current-source candidate; no automatic runtime/native/install grant.",
  "priorAuthority": {
    "planVersion": 55,
    "contentHash": "a986ca2d9a3a334228e8f470d879bb33296d3e4b4b138579cb901804e24eccb5",
    "activation": 17,
    "canonicalExecutionStartSequence": 59,
    "proof": "runtime-migration/p006-canonical-start-receipt59-0dcd3-20261106.json",
    "limits": "Prior authority and independently passed quality do not reopen any terminal diagnostic. Coordinator must decide this distinct scope and whether a new semantic plan decision/audit/start is required."
  },
  "distinctness": {
    "sourcePin": "2929ed6266e164613ab45201cd7b8e9f7fcecee7",
    "destination": "/mnt/data/tmp/bun-p006-source-2929ed-0dcd3-20261106",
    "original": "D011-D019 remain terminal. Do not read, select, lease, qualify, compare, retarget, rewrite or replace original 14ce/a027/b8c1 generation, privateHEAD8dfbd, helper20fee or verifier6c59. New source is not a new diagnostic of that tuple.",
    "purpose": "Prepare fresh source containing the already verified moduleRepoRoot repair before designing new dependency and producer acceptance. It neither rebuilds any prior signed package nor re-runs completed native/lifecycle checks."
  },
  "measuredPreparation": {
    "workingAndPinBlobsMatch": true,
    "setupSha256": "d4ae670ce90bcd18217e8dc47d3e9d43b215c4d9469f7024908777d218fc1302",
    "dependencyHelperSha256": "d82cbd824e3447688ba664c1c9ab17307f11f1a39a60f88205d469cbc975ee5e",
    "moduleRepoRootSha256": "9acfd7a4fb5d5f7a94ec80290194055ecfff7a63b753615f1ab8ad74e071abb7",
    "destinationAbsent": true,
    "siblingStashAbsent": true,
    "readAt": "2026-11-06T10:10Z",
    "note": "Execution guards recheck mutable inputs; shared staging HEAD may legitimately advance. Product pin remains fixed."
  },
  "reuse": {
    "materializer": "apps/operator/bin/release/setup-release-checkout.sh --source-only --source-root-mode clone --source-integrity object-sourced --node-modules skip",
    "sourceReadSections": "Argument and source-only guards; capacity and host-copy-lock preflight; independent root clone; local object-sourced submodule clone/fallback; recursion guard; source-only exit before dependencies.",
    "newDurableSurface": "none: existing artifact store, held P006 lane, source materializer and native task runner"
  },
  "writes": [
    "Only new destination root and its independent .git/config/index/submodule repositories/source files; immutable Git object inodes may be shared on the same filesystem.",
    "Only sibling .bun-p006-source-2929ed-0dcd3-20261106.submodule-node-modules scratch; the complete exact path must be absent before entry. Maintained helper can remove this own scratch and replace submodule destinations exclusively inside the newly allocated root.",
    "Existing host allocation lock at default TMPDIR/tmp papercusp-dependency-generation-copy.lock and its holder metadata. Do not override the lock to evade peers; cap wait at5s. An OS fd releases the hold on task exit; a stale own holder text may remain and is not a held lock.",
    "Managed task/log/receipt bookkeeping. No live generation publish lock, selector lease, generation cleanup/prune, dependency traversal/copy/install, package build, VM, runtime boot, release/gate or integration-tree source edit."
  ],
  "preconditions": [
    "Current published :3170 capability:bash schema supports require_task_confinement:true (read 2026-11-06T10:11:06Z, servingGeneration40e721a6). Qualify actual serving runtime/build and source containment before launch; old default-release schema is insufficient.",
    "Use only ordinary plan/claim/native admission and positive task confinement. No legacy runner, raw exec fallback, field stripping or altered confinement.",
    "No current candidate runtime exists yet: dev:pipeline_position(candidate-install-upgrade) readiness gap explicitly requires owned package/platform/signing/rollback target. This source-only phase prepares a prerequisite and is not an execution of that gap.",
    "Declared required new independent review disposition and any required fresh semantic activation/start must precede source materialization. If admission refuses, record terminal receipt, no retry or scope substitution."
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
  "failurePolicy": "First changed hash/path guard, missing object/capacity refusal, admission/confinement refusal, nonzero, timeout or incomplete cleanup terminates this scope. Preserve any own partial destination and actual managed task log; no delete-and-retry, fallback, fresh pin, retarget or post-deadline probe. Do not interpret tool transport failure as no task; reconcile the original durable task/ledger before any next action.",
  "verification": "Require actual native0, source-only ready and CANDIDATE_SOURCE_INTEGRITY live_tree=0 markers, exact fixed HEAD, standalone .git, no tracked/untracked source drift, complete pinned submodule traversal, unchanged helper hashes, final READY marker and actual managed subtree cleanup. A source receipt never implies dependencies, packages, installed Bun, matrix coverage or shipment.",
  "retainedLimits": "Node remains selected; Bun UNSHIPPED. Existing final-package, installed Linux, Mac retained baseline, ARM native module-root and P004 local source evidence retain their bounded meanings. No additional implementation agent; no LIVE_GATE_OPS.",
  "nativeArgs": {
    "command": "set -euo pipefail\ncd /home/marsh-office/papercupai-workspace/papercusp\ntest \"$(pwd -P)\" = '/home/marsh-office/papercupai-workspace/papercusp'\ntest \"$(git cat-file -t 2929ed6266e164613ab45201cd7b8e9f7fcecee7)\" = commit\nsha256sum -c <<'BUN_SOURCE_INPUTS'\nd4ae670ce90bcd18217e8dc47d3e9d43b215c4d9469f7024908777d218fc1302  apps/operator/bin/release/setup-release-checkout.sh\nd82cbd824e3447688ba664c1c9ab17307f11f1a39a60f88205d469cbc975ee5e  apps/operator/bin/release/dependency-generation.sh\nBUN_SOURCE_INPUTS\ntest \"$(realpath -m /mnt/data/tmp/bun-p006-source-2929ed-0dcd3-20261106)\" = '/mnt/data/tmp/bun-p006-source-2929ed-0dcd3-20261106'\ntest ! -e '/mnt/data/tmp/bun-p006-source-2929ed-0dcd3-20261106'\ntest ! -L '/mnt/data/tmp/bun-p006-source-2929ed-0dcd3-20261106'\ntest ! -e '/mnt/data/tmp/.bun-p006-source-2929ed-0dcd3-20261106.submodule-node-modules'\ntest ! -L '/mnt/data/tmp/.bun-p006-source-2929ed-0dcd3-20261106.submodule-node-modules'\nexport DEPENDENCY_GENERATION_COPY_LOCK_TIMEOUT_SEC=5\nexport DEPENDENCY_GENERATION_COPY_LOCK_MAX_SEC=5\ntimeout --signal=TERM --kill-after=30s 300s /bin/bash apps/operator/bin/release/setup-release-checkout.sh --ref 2929ed6266e164613ab45201cd7b8e9f7fcecee7 --integration '/home/marsh-office/papercupai-workspace/papercusp' --release '/mnt/data/tmp/bun-p006-source-2929ed-0dcd3-20261106' --source-only --source-root-mode clone --source-integrity object-sourced --node-modules skip\ntest \"$(timeout 10s git -C '/mnt/data/tmp/bun-p006-source-2929ed-0dcd3-20261106' rev-parse HEAD)\" = '2929ed6266e164613ab45201cd7b8e9f7fcecee7'\ntest -d '/mnt/data/tmp/bun-p006-source-2929ed-0dcd3-20261106/.git'\ntest -z \"$(timeout 20s git -C '/mnt/data/tmp/bun-p006-source-2929ed-0dcd3-20261106' status --porcelain --untracked-files=all --ignore-submodules=none)\"\ntimeout 20s git -C '/mnt/data/tmp/bun-p006-source-2929ed-0dcd3-20261106' submodule status --recursive\nsha256sum -c <<'BUN_SOURCE_INPUTS'\nd4ae670ce90bcd18217e8dc47d3e9d43b215c4d9469f7024908777d218fc1302  apps/operator/bin/release/setup-release-checkout.sh\nd82cbd824e3447688ba664c1c9ab17307f11f1a39a60f88205d469cbc975ee5e  apps/operator/bin/release/dependency-generation.sh\nBUN_SOURCE_INPUTS\nprintf '%s\\n' 'BUN_DISTINCT_2929ED_SOURCE_ONLY_READY'",
    "description": "Prepare one distinct pinned Bun candidate source",
    "cwd": "/home/marsh-office/papercupai-workspace/papercusp",
    "work_item_id": "WI-6554700010022072",
    "require_task_confinement": true,
    "timeout": 390000,
    "run_in_background": true
  }
}
