---
rel_path: "runtime-migration/p006-d022-admission66-source-running-0dcd3-20261106.json"
updated_at: 1793965128927
_body: "content"
---

{
  "schemaVersion": "bun-p006-d022-admission-and-running-proof-v1",
  "recordedAt": "2026-11-06T11:37:13.702Z",
  "ownerId": "su-0dcd3a3c-a45f-482b-a8cd-e957407353f9",
  "workItem": "WI-6554700010022072",
  "decision": "node-to-bun-staged-migration-2026-10-22#D-022",
  "proposal": {
    "relPath": "runtime-migration/p006-distinct-e1ff5523-source-only-proposal-0dcd3-20261106.json",
    "chars": 12501,
    "sha256": "376613b5aca5c84219a735da49d1ebf28eb613bcaf60e6026c13a8a5b3e9e800",
    "exactCommandChars": 2339,
    "exactCommandSha256": "30388636c75d0010b52af5568d6048d889e6e625abf64475fd245a6961cb2954"
  },
  "discovery": {
    "auditSeq": 19,
    "auditedPlanRevision": {
      "id": 85218,
      "seq": 65,
      "contentHash": "f45985d5cda9d1835dc8899aaec0762a406393522af4187859657037097639e0"
    },
    "readiness": {
      "ready": true,
      "state": "ready",
      "blockers": [],
      "evidenceRefs": [
        "source:apps/operator/bin/release/dependency-generation.sh",
        "source:apps/operator/bin/release/setup-release-checkout.sh",
        "source:apps/operator/lib/release/bun-source-only-post-read-guards.test.ts",
        "source:apps/operator/lib/release/fixtures/bun-source-only-2929ed-proposal.json",
        "source:packages/operator-core/lib/application-runtime-acceptance.ts",
        "source:packages/operator-core/lib/vm-release-runtime-policy.ts",
        "source:papercusp-desktop/bin/build-desktop-sidecar.sh",
        "source:scripts/lib/committed-source-loader.mjs",
        "source:scripts/lib/runtime-compatibility.mjs",
        "source:scripts/lib/targeted-task-reuse.mjs"
      ],
      "supportedTargets": [
        "D-020",
        "D-021",
        "D-022",
        "P-001",
        "P-002",
        "P-003",
        "P-004",
        "P-005",
        "P-006",
        "P-007",
        "P-008"
      ],
      "reopenedQuestions": [],
      "nextAction": "Finalize discovery with plans:audit phase=discovery before implementation review."
    },
    "workflowStage": "implementation-review"
  },
  "canonicalAuthority": {
    "measuredAt": "2026-11-06T11:37:13.702Z",
    "executionStart": {
      "schema": "plan-execution-start-v1",
      "scope": {
        "workspaceId": "papercusp-workspace",
        "harnessSlug": "papercusp",
        "planSlug": "node-to-bun-staged-migration-2026-10-22"
      },
      "sequence": 66,
      "revisionId": "85220",
      "currentPlanHash": "f45985d5cda9d1835dc8899aaec0762a406393522af4187859657037097639e0",
      "revisionHash": "f45985d5cda9d1835dc8899aaec0762a406393522af4187859657037097639e0",
      "snapshotChars": 118320,
      "snapshotSha256": "8a121d2ad1040fcf980830d011caaac7074cb37f929b7a26c435b630220b4406",
      "bodyEqualsCurrent": true
    },
    "activationAudit": {
      "audit_seq": 20,
      "audited_plan_revision_id": "85218",
      "audited_plan_revision_seq": 65,
      "audited_plan_content_hash": "f45985d5cda9d1835dc8899aaec0762a406393522af4187859657037097639e0",
      "summary": "Fresh semantic re-audit for D022 distinct source-only scope on planv61. Carry forward the previously verified complete owner conversation source ranges, mappings and item provenance under documented re-audit semantics; no new owner-turn claims. Independent D022 current-byte review binds exact12501 proposal/2339 command and maintained44c5 PASS0. Discovery19 finalized with current source fingerprints and D022 support. Fresh ordinary canonical start and actual native route/confinement qualification are still required before the single source preparation. D011-D021 terminal, D021 NO_START; original tuple held. Dependency/native/installed/P004/fullmatrix/canary/rollback/shipment acceptance remains open; Node selected/Bun UNSHIPPED; no extra implementation agents or LIVE_GATE_OPS."
    }
  },
  "executionReadiness": {
    "status": "ready",
    "ready": true,
    "blockers": [],
    "route": "http://127.0.0.1:3170"
  },
  "runtimeQualification": [
    {
      "path": "packages/operator-core/lib/agent-tools/capability/bash.ts",
      "sourceSha256": "0dbe169ad128599640d08ee65230e79bb1c2b3feaf1fcdf7066f0bc88cc7ff46",
      "currentBuildTestRoute": {
        "id": "operator-api",
        "source": "Committed local integration branch (staging by default), loaded by maintained staging sync",
        "runtime": "staging-operator",
        "route": "http://127.0.0.1:3170 after dev:pipeline_position containment check",
        "routeFile": "apps/operator/scripts/systemd/papercup-staging-api.service.d/50-staging-checkout.conf",
        "isolation": "Separate port, process and checkout; database and workspace are not isolated.",
        "prerequisites": [
          "Containing staging commit loaded",
          "private test identity/data for writes"
        ],
        "verification": "Measured :3170 build identity plus request/response on that build.",
        "readiness": "ready"
      },
      "acceptedSource": {
        "expectedSha256": "0dbe169ad128599640d08ee65230e79bb1c2b3feaf1fcdf7066f0bc88cc7ff46",
        "observedSha256": "0dbe169ad128599640d08ee65230e79bb1c2b3feaf1fcdf7066f0bc88cc7ff46",
        "matches": true,
        "deployedContains": false,
        "runtimeContainment": {
          "release-operator": false,
          "staging-operator": true,
          "bg-host": null,
          "gateway": false
        }
      },
      "selectedRuntime": {
        "runtime": "staging-operator",
        "label": ":3170 staging operator (maintained committed staging generation)",
        "role": "owner",
        "releasePipelineApplies": false,
        "codeSource": "staging-checkout",
        "pid": 2412550,
        "startedAtMs": 1793961687835.313,
        "buildSha": "b96618c020",
        "buildShaSource": "health",
        "instances": null,
        "activation": "papercup-staging-sync.service selects the locally committed staging HEAD and publishes the immutable :3170 generation; dev:restart only reloads that published generation ({ target: \"staging\", confirm: true, authorize: true, reason: \"<why>\" }); verify the intended commit with dev:pipeline_position { path: \"<changed path>\" } → servingRuntimes",
        "containsChange": true,
        "method": "blob",
        "unknownReason": null
      },
      "observingRuntime": {
        "host": "port-3170",
        "processId": "linux:c58f787e-e441-4c5c-a0f5-40e3b362e124:38072446",
        "buildSha": "b96618c020",
        "artifact": {
          "status": "measured",
          "sourceSha": "b96618c020221abdd1fda47b28df03c861c3d242",
          "bundleSha256": "6da9197c6ab4d0ffd52bd1d681dc96ee08fc2b57c42fc6bb03cdaed84292ebf1",
          "manifestSha256": "e0277e79ca3f24a42595c5d779c30c35e41adbf1705b8205afcaa7ddabd7a025",
          "sourceBlobs": {
            "packages/operator-core/lib/agent-tools/capability/bash.ts": "240e31d515392cad6136a6efc9c516836548f6bf"
          },
          "evidenceRef": "/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-b96618c02022.FD2NzL/checkout/apps/operator/dist-host/hono-host.mjs.artifact-6da9197c6ab4d0ffd52bd1d681dc96ee08fc2b57c42fc6bb03cdaed84292ebf1.json"
        }
      }
    },
    {
      "path": "packages/operator-core/lib/agent-tools/capability/bash-jobs.ts",
      "sourceSha256": "14b917749db4b2938f175367b98b4f0168e660308530cd04d247d77d821be956",
      "currentBuildTestRoute": {
        "id": "operator-api",
        "source": "Committed local integration branch (staging by default), loaded by maintained staging sync",
        "runtime": "staging-operator",
        "route": "http://127.0.0.1:3170 after dev:pipeline_position containment check",
        "routeFile": "apps/operator/scripts/systemd/papercup-staging-api.service.d/50-staging-checkout.conf",
        "isolation": "Separate port, process and checkout; database and workspace are not isolated.",
        "prerequisites": [
          "Containing staging commit loaded",
          "private test identity/data for writes"
        ],
        "verification": "Measured :3170 build identity plus request/response on that build.",
        "readiness": "ready"
      },
      "acceptedSource": {
        "expectedSha256": "14b917749db4b2938f175367b98b4f0168e660308530cd04d247d77d821be956",
        "observedSha256": "14b917749db4b2938f175367b98b4f0168e660308530cd04d247d77d821be956",
        "matches": true,
        "deployedContains": false,
        "runtimeContainment": {
          "release-operator": false,
          "staging-operator": true,
          "bg-host": null,
          "gateway": true
        }
      },
      "selectedRuntime": {
        "runtime": "staging-operator",
        "label": ":3170 staging operator (maintained committed staging generation)",
        "role": "owner",
        "releasePipelineApplies": false,
        "codeSource": "staging-checkout",
        "pid": 2412550,
        "startedAtMs": 1793961687835.313,
        "buildSha": "b96618c020",
        "buildShaSource": "health",
        "instances": null,
        "activation": "papercup-staging-sync.service selects the locally committed staging HEAD and publishes the immutable :3170 generation; dev:restart only reloads that published generation ({ target: \"staging\", confirm: true, authorize: true, reason: \"<why>\" }); verify the intended commit with dev:pipeline_position { path: \"<changed path>\" } → servingRuntimes",
        "containsChange": true,
        "method": "blob",
        "unknownReason": null
      },
      "observingRuntime": {
        "host": "port-3170",
        "processId": "linux:c58f787e-e441-4c5c-a0f5-40e3b362e124:38072446",
        "buildSha": "b96618c020",
        "artifact": {
          "status": "measured",
          "sourceSha": "b96618c020221abdd1fda47b28df03c861c3d242",
          "bundleSha256": "6da9197c6ab4d0ffd52bd1d681dc96ee08fc2b57c42fc6bb03cdaed84292ebf1",
          "manifestSha256": "e0277e79ca3f24a42595c5d779c30c35e41adbf1705b8205afcaa7ddabd7a025",
          "sourceBlobs": {
            "packages/operator-core/lib/agent-tools/capability/bash-jobs.ts": "488ba8661a16f72f6e2f5ee85e6288d6e7caf74c"
          },
          "evidenceRef": "/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-b96618c02022.FD2NzL/checkout/apps/operator/dist-host/hono-host.mjs.artifact-6da9197c6ab4d0ffd52bd1d681dc96ee08fc2b57c42fc6bb03cdaed84292ebf1.json"
        }
      }
    }
  ],
  "publishedConfinementContract": {
    "registry": {
      "source": "projected-tool-registry",
      "revision": "projected-tool-registry-v1:e0495a98829877fe"
    },
    "hits": [
      {
        "tool": "capability:bash",
        "argSchema": "command?:string(≥1) The bash command to run (passed to `bash -c`). Required, unless `cmd` is given. For inline Python `-c`, do not encode source line breaks as literal `\\n` inside a shell-quoted program: the shell preserves the backslash and Python raises a l…; description?:string; timeout?:integer(1000-43200000) Wall-clock timeout in ms (minimum 1000; values below one second are rejected to catch seconds-vs-milliseconds mistakes — 20 seconds = 20000ms). This is the EXECUTION deadline, not the response window. Ordinary calls default to 120000; if s…; yield_after_ms?:integer(10-45000); run_in_background?:boolean Return the durable job immediately instead of waiting for fast completion. Ordinary calls already yield the same job automatically at yield_after_ms. Read later output via capability:bash_output.; require_task_confinement?:boolean Require managed task enrollment and cgroup confinement before fork. Refuse without starting the command if unavailable; timeout still bounds the whole task.; allow_duplicate?:boolean Allow a duplicate launch when a live task already has the exact same command and cwd. Use only when the duplicate is intentional.; cwd?:string Working dir (absolute, or relative to the project dir). Defaults to the project dir.; work_item_id?:string Held work-item this job is for. Required when you hold multiple work-items or held-item attribution cannot be measured; pass the exact full id returned by scheduler:get_next or work_items:get. Shortened or inferred ids are refused with the…; parent_task_id?:string~/^[0-9a-z]{4,64}$/ Durable task that owns this nested launch. Pass PAPERCUSP_CAPABILITY_BASH_BACKGROUND_TASK_ID from a managed caller. Must be live and owned by the same caller, workspace, harness and work-item; subtree cancellation then includes this child.; integration_env?:object Operator-authority only. Map child environment variable names to encrypted setup:save_integration_key names, e.g. {\"DEEPGRAM_API_KEY\":\"SIDESTAGE_DEEPGRAM_API_KEY\"}. Raw values stay server-side, exist only in this child process, and are exa…"
      }
    ]
  },
  "launch": {
    "ok": true,
    "bash_id": "ae9fcbef-d26",
    "task_id": "0mw4wdbsezuyv8c179u",
    "status": "running",
    "cwd": "/home/marsh-office/papercupai-workspace/papercusp",
    "log_path": "/home/marsh-office/papercupai-workspace/papercusp/.papercusp/scratch/bash-ae9fcbef-d26.log",
    "timeout_ms": 390000,
    "deadline": "2026-11-06T11:41:09.086Z",
    "advice": "Background shell started. Preserve durable task_id \"0mw4wdbsezuyv8c179u\" across carry. Read output: capability:bash_output { task_id: \"0mw4wdbsezuyv8c179u\" } (or { bash_id: \"ae9fcbef-d26\" } in this launching context). Stop: processes:kill { taskId: \"0mw4wdbsezuyv8c179u\" }. It is terminated at 2026-11-06T11:41:09.086Z — re-launch with a larger `timeout` (max 43200000ms) if the shell job needs longer. All descendants in this task's confined service share that deadline; use a dedicated service launcher when a descendant needs a separate lifetime."
  },
  "enrollment": {
    "taskId": "0mw4wdbsezuyv8c179u",
    "class": "bash-job",
    "title": "set -euo pipefail\ncd /home/marsh-office/papercupai-workspace/papercusp\ntest \"$(pwd -P)\" = '/home/marsh-office/papercupai-workspace/papercusp'\ntest \"$(git cat-file -t e1ff55230c4bfc416a7c1e1fa7382968db8c3f39)\" = commit\nsha256sum -c <<'BUN_SOURCE_INPUTS'\nd4ae670ce90bcd18217e8dc47d3e9d43b215c4d9469f702",
    "state": "running",
    "launchedBy": "su-0dcd3a3c-a45f-482b-a8cd-e957407353f9",
    "workItemId": "WI-6554700010022072",
    "planSlug": null,
    "parentTaskId": null,
    "rootTaskId": "0mw4wdbsezuyv8c179u",
    "ageSec": 197,
    "rssMb": null,
    "rssSampledAt": null,
    "rssSampleAgeSec": null,
    "rssSampleFreshness": "unknown",
    "peakRssMb": null,
    "cpuSec": null,
    "cpuSampledAt": null,
    "cpuSampleAgeSec": null,
    "cpuSampleFreshness": "unknown",
    "cpuBusyPercent": null,
    "pids": null,
    "livePids": null,
    "confined": true,
    "scopeUnit": "pc-0mw4wdbsezuyv8c179u.service",
    "confinement": {
      "confined": true,
      "cgroupPath": "/user.slice/user-1000.slice/user@1000.service/papercusp.slice/papercusp-bash.slice/papercusp-bash-job.slice/pc-0mw4wdbsezuyv8c179u.service",
      "scopeUnit": "pc-0mw4wdbsezuyv8c179u.service",
      "source": "derived-from-scope-unit",
      "insideOperatorCgroup": false
    },
    "memoryMaxMb": null,
    "deadlineAt": "2026-11-06 06:41:09.192-05",
    "exitCode": null,
    "exitReason": null,
    "termination": null,
    "logPath": "/home/marsh-office/papercupai-workspace/papercusp/.papercusp/scratch/bash-ae9fcbef-d26.log"
  },
  "originalTaskObservation": {
    "ok": true,
    "bash_id": "ae9fcbef-d26",
    "task_id": "0mw4wdbsezuyv8c179u",
    "status": "running",
    "exit_code": null,
    "running": true,
    "total_bytes": 658,
    "log_path": "/home/marsh-office/papercupai-workspace/papercusp/.papercusp/scratch/bash-ae9fcbef-d26.log",
    "cpu_cores": 0.76,
    "cpu_basis": "cores burned by this job's OWN cgroup over the 67s since your last bash_output read (1.0 = one core saturated). CPU use is NOT payload progress: wrapper/queue work can burn multiple cores before the payload starts, so neither a nonzero value nor growing wrapper output distinguishes working from pc-heavy:waiting-for-slot. ~0 while status=running also does NOT mean finished. Confirm progress from a payload-emitted phase/test marker, not this number.",
    "output": ""
  },
  "phaseObservation": {
    "measuredAt": 1793965092.6371686,
    "taskCgroupExists": true,
    "taskProcesses": [
      {
        "pid": 1456841,
        "command": "/home/marsh-office/.local/node25/bin/node /home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-b96618c02022.FD2NzL/checkout/apps/operator/dist-host/systemd-scope-env-runner.mjs --credential papercusp-env -- /usr/bin/bash -o pipefail -c script=$(cat; printf x); script=${script%x}; eval \"$script\" ",
        "waitChannel": "ep_poll"
      },
      {
        "pid": 1457067,
        "command": "/usr/bin/bash -o pipefail -c script=$(cat; printf x); script=${script%x}; eval \"$script\" ",
        "waitChannel": "do_wait"
      },
      {
        "pid": 1457115,
        "command": "timeout --signal=TERM --kill-after=30s 300s /bin/bash apps/operator/bin/release/setup-release-checkout.sh --ref e1ff55230c4bfc416a7c1e1fa7382968db8c3f39 --integration /home/marsh-office/papercupai-workspace/papercusp --release /mnt/data/tmp/bun-p006-source-e1ff5523-0dcd3-20261106 --source-only --source-root-mode clone --source-integrity object-sourced --node-modules skip ",
        "waitChannel": "sigsuspend"
      },
      {
        "pid": 1457116,
        "command": "/bin/bash apps/operator/bin/release/setup-release-checkout.sh --ref e1ff55230c4bfc416a7c1e1fa7382968db8c3f39 --integration /home/marsh-office/papercupai-workspace/papercusp --release /mnt/data/tmp/bun-p006-source-e1ff5523-0dcd3-20261106 --source-only --source-root-mode clone --source-integrity object-sourced --node-modules skip ",
        "waitChannel": "do_wait"
      },
      {
        "pid": 1659991,
        "command": "git clone --quiet --local --no-checkout --no-hardlinks /home/marsh-office/papercupai-workspace/papercusp/libs/papercusp /mnt/data/tmp/bun-p006-source-e1ff5523-0dcd3-20261106/libs/papercusp ",
        "waitChannel": "folio_wait_bit_common"
      },
      {
        "pid": 1659995,
        "command": "/bin/sh -c git-upload-pack '/home/marsh-office/papercupai-workspace/papercusp/.git/modules/libs/papercusp' git-upload-pack '/home/marsh-office/papercupai-workspace/papercusp/.git/modules/libs/papercusp' ",
        "waitChannel": "do_wait"
      },
      {
        "pid": 1659996,
        "command": "git-upload-pack /home/marsh-office/papercupai-workspace/papercusp/.git/modules/libs/papercusp ",
        "waitChannel": "anon_pipe_read"
      }
    ],
    "cgroupEvents": "populated 1\nfrozen 0\n"
  },
  "limits": "RUNNING ONLY. No source-native0 or cleanup claim. D022 exactly one command launched; no retry, retarget, fallback, newpin or deadline extension. D011-D021 terminal. Node selected/Bun UNSHIPPED; dependencies/build/install/native matrix/P004/canary/rollback/shipment OPEN."
}
