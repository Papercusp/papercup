---
rel_path: "evidence/c52-luna-r1-20261106/original-portal-terminal-qualification-20261108T0435Z.json"
updated_at: 1794112497578
_body: "content"
---

{
  "schemaVersion": "luna-r1-saved-portal-terminal-qualification-v1",
  "observedAt": "2026-11-08T04:34:45.455393+00:00",
  "parent": "WI-6554700010045700",
  "claim": {
    "id": "EI-25395058495286552",
    "auditId": 45805,
    "at": "2026-11-02T18:22:47.461507+00:00",
    "claimer": "su-c847bbc9-fc81-4c4c-8fe7-770ef0dbe660",
    "outcome": "won",
    "detail": {
      "source": "fleet",
      "specId": "fleet-launch-nonp2p-bug-drain-luna-max-0930-kinds",
      "revision": 23,
      "fleetSlug": "nonp2p-bug-drain-luna-max-0930",
      "tier": "issue-tier3",
      "lockAwarePlacement": {
        "peerHeldPathCount": 6,
        "selectedConflict": false
      }
    },
    "parseError": null,
    "endAt": "2026-11-03 18:22:47.461507+00",
    "paths": [
      "packages/operator-core/lib/host-bundle-runtime-externals.test.ts",
      "packages/operator-core/lib/llm-testing/__tests__/papercup-public-manual.e2e.test.ts"
    ]
  },
  "sources": [
    {
      "path": "/tmp/c52-r1-native-evidence-20261108.json",
      "sha256": "bea09b60529277671c4172e8f42bf9e9ef42b2329e5bb35d7d33900dc9725bad"
    },
    {
      "path": "/tmp/c52-loaded-original-native-cap-extension-20261108T0405Z.json",
      "sha256": "7f1665dd9d8f3b2dc4d31c02395671ec1fe54dc14b600b56148e57c998955e7a"
    },
    {
      "path": "/tmp/c52-loaded-original-late-native-path-extension-20261108T0415Z.json",
      "sha256": "c68a934edd62d0a0737332660b0dba71e58800136941823b11b17b9555620d5c"
    }
  ],
  "method": "Read exact saved candidate union by identity; retain immediate results of historical capability:bash_output reads. No historical query or test rerun. No live peer/runtime status read.",
  "witnesses": [
    {
      "key": [
        "45805",
        "codex",
        "01a19f75-1600-79f0-ae26-11bf9a90d388",
        135
      ],
      "commandAndImmediateResult": {
        "ts": "2026-11-03T04:04:36.786+00:00",
        "text": "const r=await Promise.allSettled([\n tools.mcp__papercusp_su__tools_invoke({name:\"work_items:get\",args:{id:\"EI-25395058495286552\",harness:\"papercusp\",operationalBrief:true}}),\n tools.mcp__papercusp_su__tools_invoke({name:\"capability:bash_output\",args:{task_id:\"0mw04lc3o7kb11hgxhs\",peek:true,tail:5}}),\n tools.mcp__papercusp_su__tools_invoke({name:\"loop:status\",args:{}})\n]);\nfunction firstJson(v){for(const c of (v?.content||[])){if(c.type===\"text\"){try{return JSON.parse(c.text)}catch{}}}return null}\nconst wi=firstJson(r[0].status===\"fulfilled\"?r[0].value:null);\nconst task=firstJson(r[1].status===\"fulfilled\"?r[1].value:null);\nconst loop=firstJson(r[2].status===\"fulfilled\"?r[2].value:null);\nconst w=wi?.results?.[0]?.workItem;\ntext(JSON.stringify({\n workItem:{id:w?.id,state:w?.state,assignee:w?.assignee,lastProgressAt:w?.lastProgressAt,checkpointAgeMs:wi?.results?.[0]?.checkpointAgeMs,brief:wi?.results?.[0]?.operationalBrief?.nextAction},\n task:{status:task?.status,exit_code:task?.exit_code,running:task?.running,task_id:task?.task_id},\n loop:{active:loop?.loop?.active,fireCount:loop?.loop?.fireCount,carryNote:loop?.carryNote?.note?.slice(0,1800),lastTurnAt:loop?.loop?.lastTurnAt,rewakeGuaranteed:loop?.rewake?.rewakeGuaranteed}\n}));\n",
        "part_idx": 135,
        "tool_name": "exec",
        "session_id": "01a19f75-1600-79f0-ae26-11bf9a90d388",
        "source_kind": "codex",
        "followingResult": {
          "ts": "2026-11-03T04:04:54.179+00:00",
          "text": "Script completed\nWall time 17.3 seconds\nOutput:\n\n{\"workItem\":{\"id\":\"EI-25395058495286552\",\"state\":\"open\",\"assignee\":\"su-c847bbc9-fc81-4c4c-8fe7-770ef0dbe660\",\"lastProgressAt\":\"2026-11-03T03:29:24.590Z\",\"checkpointAgeMs\":2120122,\"brief\":{\"status\":\"known\",\"value\":\"On the next wake, read capability:bash_output for task 0mw01qnna14h1ul01vr. If build and both freshness checks pass, use its returned BUNDLE_DIR and run the exa…[TRUNCATED +127]\",\"source\":\"checkpoi…[TRUNCATED +28]\"}},\"task\":{\"status\":\"failed\",\"exit_code\":1,\"running\":false,\"task_id\":\"0mw04lc3o7kb11hgxhs\"},\"loop\":{\"active\":true,\"fireCount\":31,\"carryNote\":\"## Did\\nFresh source root and bundle prepared; official freshness proof passed under C and en_US.UTF-8. Removed abandoned temp PG/runtime from the caller-aborted launch after port 40197 was closed. Exact shell syntax passed bash -n.\\n\\n## Left\\nPortal acceptance task 0mw04lc3o7kb11hgxhs is running in background; preserve it and do not relaunch.\\n\\n## Key insight\\nLong with-test-pg migrations exceed the nested 60s response limit; capability:bash run_in_background:true returns the durable task safely.\\n\\n## Next action\\nRead capability:bash_output for task 0mw04lc3o7kb11hgxhs. Verify TEST_FILE_RESULT, Portal assertions, and cleanup; then update EI-25395058495286552 and complete it only with evidence.\\n\\n## Checks\\n_✓ = VERIFIED (evidence attached) · ⚠ = CONTESTED (evidence contradicts verification; re-check now) · ? = PREDICTED (observed context may be attached) — run the re-check before relying on it · [scope: …] = ALL the probe observed; a claim quantified beyond it is NOT verified by it_\\n- ✓ [#setup-env-regression] The shared setup resets inherited production NODE_ENV to test before test modules run. — re-check: capability:inspect {check:'test',package:'libs/test-config',path:'src/setup-hermetic-env.test.ts'} — falsifier: The live worker reports a value other than test, or runSetupOn({NODE_ENV:'production'}) does not return test. — evidence: 41/41 setup tes… [truncated 502 chars]",
          "part_idx": 136,
          "tool_name": null
        }
      }
    },
    {
      "key": [
        "45805",
        "codex",
        "01a19f75-1600-79f0-ae26-11bf9a90d388",
        194
      ],
      "commandAndImmediateResult": {
        "ts": "2026-11-03T04:23:03.883+00:00",
        "text": "const r=await Promise.allSettled([\n tools.mcp__papercusp_su__tools_invoke({\n  name:\"capability:bash_output\",\n  args:{task_id:\"0mw06gffuxjt7ez1gr4\",filter:\"TEST_FILE_RESULT|vitest|FAIL|Error|Assertion|timeout|Portal|Test Files|cleanup|JOB END\",peek:true,tail:100}\n }),\n tools.mcp__papercusp_su__tools_invoke({\n  name:\"work_items:get\",\n  args:{id:\"EI-25395058495286552\",harness:\"papercusp\",operationalBrief:true}\n }),\n tools.mcp__papercusp_su__tools_invoke({name:\"loop:status\",args:{}})\n]);\nfor(let i=0;i<r.length;i++) text(JSON.stringify({index:i,result:r[i].status===\"fulfilled\"?r[i].value:r[i].reason}).slice(0,12000));\n",
        "part_idx": 194,
        "tool_name": "exec",
        "session_id": "01a19f75-1600-79f0-ae26-11bf9a90d388",
        "source_kind": "codex",
        "followingResult": {
          "ts": "2026-11-03T04:23:28.446+00:00",
          "text": "Script completed\nWall time 24.5 seconds\nOutput:\n\n{\"index\":0,\"result\":{\"content\":[{\"type\":\"text\",\"text\":\"{\\\"ok\\\":true,\\\"status\\\":\\\"failed\\\",\\\"bash_id\\\":\\\"46036b35-7c4\\\",\\\"task_id\\\":\\\"0mw06gffuxjt7ez1gr4\\\",\\\"exit_code\\\":1,\\\"running\\\":false,\\\"total_bytes\\\":915044,\\\"log_path\\\":\\\"/home/marsh-office/papercupai-workspace/papercusp/.papercusp/scratch/bash-46036b35-7c4.log\\\",\\\"cpu_unavailable\\\":\\\"job-not-running\\\",\\\"output\\\":\\\"TEST_FILE_CASE_TRACE {\\\\\\\"event\\\\\\\":\\\\\\\"started\\\\\\\",\\\\\\\"file\\\\\\\":\\\\\\\"/tmp/pcv/papercusp-lint-as-committed-ad29636727-tlUH9F/packages/operator-core/lib/llm-testing/__tests__/papercup-public-manual.e2e.test.ts\\\\\\\",\\\\\\\"name\\\\\\\":\\\\\\\"actual Portal manual fixture admission > refuses a paid canary question without its verified bundle\\\\\\\"}\\\\nTEST_FILE_CASE_TRACE {\\\\\\\"event\\\\\\\":\\\\\\\"started\\\\\\\",\\\\\\\"file\\\\\\\":\\\\\\\"/tmp/pcv/papercusp-lint-as-committed-ad29636727-tlUH9F/packages/operator-core/lib/llm-testing/__tests__/papercup-public-manual.e2e.test.ts\\\\\\\",\\\\\\\"name\\\\\\\":\\\\\\\"actual Portal manual fixture admission > admits a paid canary question with its bundle\\\\\\\"}\\\\nTEST_FILE_CASE_TRACE {\\\\\\\"event\\\\\\\":\\\\\\\"started\\\\\\\",\\\\\\\"file\\\\\\\":\\\\\\\"/tmp/pcv/papercusp-lint-as-committed-ad29636727-tlUH9F/packages/operator-core/lib/llm-testing/__tests__/papercup-public-manual.e2e.test.ts\\\\\\\",\\\\\\\"name\\\\\\\":\\\\\\\"actual Portal manual …[TRUNCATED +29058 chars — see _projection.cursor]\\\",\\\"_projection\\\":{\\\"kind\\\":\\\"bounded-payload\\\",\\\"truncated\\\":true,\\\"tier\\\":\\\"trimmed\\\",\\\"forced\\\":true,\\\"originalChars\\\":31799,\\\"returnedChars\\\":2476,\\\"omittedCount\\\":1,\\\"omitted\\\":[{\\\"path\\\":\\\"$.output\\\",\\\"reason\\\":\\\"29058 string characters omitted\\\"}],\\\"cursor\\\":{\\\"kind\\\":\\\"scratch-page\\\",\\\"tool\\\":\\\"capability:read\\\",\\\"args\\\":{\\\"file_path\\\":\\\"/home/marsh-office/.papercusp/scratch/papercusp-workspace/tools:invoke/93d46992-bbf0-43a9-b1bd-30b43ac82792/result-door-1793679788784.md\\\",\\\"byte_offset\\\":0,\\\"byte_limit\\\":3072},\\\"maxByteLimit\\\":4096,\\\"uri\\\":\\\"papercusp://scratch/papercusp-workspace/tools:invoke/93d4699… [truncated 16781 chars]",
          "part_idx": 195,
          "tool_name": null
        }
      }
    },
    {
      "key": [
        "45805",
        "codex",
        "01a19ff0-2cea-7741-8b8a-a763b40cdece",
        17
      ],
      "commandAndImmediateResult": {
        "ts": "2026-11-03T05:47:02.271+00:00",
        "text": "const rs = await Promise.all([\n  tools.mcp__papercusp_su__capability_bash_output({task_id:\"0mw06gffuxjt7ez1gr4\",peek:true,tail:100}),\n  tools.mcp__papercusp_su__work_items_get({id:\"EI-25395058495286552\",harness:\"papercusp\",checkpointOnly:true,limit:512,offset:0}),\n  tools.mcp__papercusp_su__loop_status({}),\n  tools.mcp__papercusp_su__fleet_status({fleet:\"nonp2p-bug-drain-luna-max-0930\"})\n]);\nfor (let i=0;i<rs.length;i++) text(JSON.stringify({i,result:rs[i]}));\n",
        "part_idx": 17,
        "tool_name": "exec",
        "session_id": "01a19ff0-2cea-7741-8b8a-a763b40cdece",
        "source_kind": "codex",
        "followingResult": {
          "ts": "2026-11-03T05:47:15.578+00:00",
          "text": "Script completed\nWall time 13.2 seconds\nOutput:\n\nWarning: truncated output (original token count: 10650)\nTotal output lines: 4\n\n{\"i\":0,\"result\":{\"content\":[{\"type\":\"text\",\"text\":\"{\\\"ok\\\":true,\\\"status\\\":\\\"failed\\\",\\\"bash_id\\\":\\\"46036b35-7c4\\\",\\\"task_id\\\":\\\"0mw06gffuxjt7ez1gr4\\\",\\\"exit_code\\\":1,\\\"running\\\":false,\\\"total_bytes\\\":916230,\\\"log_path\\\":\\\"/home/marsh-office/papercupai-workspace/papercusp/.papercusp/scratch/bash-46036b35-7c4.log\\\",\\\"recovered_from_ledger\\\":true,\\\"output_tail\\\":\\\"lated-runtime-cleanup\\\\\\\",\\\\\\\"stage\\\\\\\":\\\\\\\"start\\\\\\\",\\\\\\\"elapsedMs\\\\\\\":2,\\\\\\\"supervisorPid\\\\\\\":3471802,\\\\\\\"workspace\\\\\\\":\\\\\\\"test-runtime-0b428ce2-0ce\\\\\\\",\\\\\\\"runtimeRoot\\\\\\\":\\\\\\\"/tmp/pcv/papercusp-test-runtime-0JxFvr\\\\\\\",\\\\\\\"dataDir\\\\\\\":\\\\\\\"/tmp/pcv/papercusp-test-pg-h21Kxf\\\\\\\",\\\\\\\"pgPort\\\\\\\":38711}\\\\n[with-test-pg] cleanup {\\\\\\\"kind\\\\\\\":\\\\\\\"isolated-runtime-cleanup\\\\\\\",\\\\\\\"stage\\\\\\\":\\\\\\\"child-group-stop\\\\\\\",\\\\\\\"elapsedMs\\\\\\\":2,\\\\\\\"supervisorPid\\\\\\\":3471802,\\\\\\\"workspace\\\\\\\":\\\\\\\"test-runtime-0b428ce2-0ce\\\\\\\",\\\\\\\"runtimeRoot\\\\\\\":\\\\\\\"/tmp/pcv/papercusp-test-runtime-0JxFvr\\\\\\\",\\\\\\\"dataDir\\\\\\\":\\\\\\\"/tmp/pcv/papercusp-test-pg-h21Kxf\\\\\\\",\\\\\\\"pgPort\\\\\\\":38711,\\\\\\\"pid\\\\\\\":3485085}\\\\n[with-test-pg] cleanup {\\\\\\\"kind\\\\\\\":\\\\\\\"isolated-runtime-cleanup\\\\\\\",\\\\\\\"stage\\\\\\\":\\\\\\\"child-group-stopped\\\\\\\",\\\\\\\"elapsedMs\\\\\\\":5,\\\\\\\"supervisorPid\\\\\\\":3471802,\\\\\\\"workspace\\\\\\\":\\\\\\\"test-runtime-0b428ce2-0ce\\\\\\\",\\\\\\\"runtimeRoot\\\\\\\":\\\\\\\"/tmp/pcv/papercusp-test-runtime-0JxFvr\\\\\\\",\\\\\\\"dataDir\\\\\\\":\\\\\\\"/tmp/pcv/papercusp-test-pg-h21Kxf\\\\\\\",\\\\\\\"pgPo…[TRUNCATED +7200 chars — see _projection.cursor]\\\",\\\"output\\\":\\\"lated-runtime-cleanup\\\\\\\",\\\\\\\"stage\\\\\\\":\\\\\\\"start\\\\\\\",\\\\\\\"elapsedMs\\\\\\\":2,\\\\\\\"supervisorPid\\\\\\\":3471802,\\\\\\\"workspace\\\\\\\":\\\\\\\"test-runtime-0b428ce2-0ce\\\\\\\",\\\\\\\"runtimeRoot\\\\\\\":\\\\\\\"/tmp/pcv/papercusp-test-runtime-0JxFvr\\\\\\\",\\\\\\\"dataDir\\\\\\\":\\\\\\\"/tmp/pcv/papercusp-test-pg-h21Kxf\\\\\\\",\\\\\\\"pgPort\\\\\\\":38711}\\\\n[with-test-pg] cleanup {\\\\\\\"kind\\\\\\\":\\\\\\\"isolated-runtime-cleanup\\\\\\\",\\\\\\\"stage\\\\\\\":\\\\\\\"child-group-stop\\… [truncated 38013 chars]",
          "part_idx": 18,
          "tool_name": null
        }
      }
    },
    {
      "key": [
        "45805",
        "codex",
        "01a19ff0-2cea-7741-8b8a-a763b40cdece",
        19
      ],
      "commandAndImmediateResult": {
        "ts": "2026-11-03T05:47:32.71+00:00",
        "text": "const [marker, timeout, cp] = await Promise.all([\n  tools.mcp__papercusp_su__capability_bash_output({task_id:\"0mw06gffuxjt7ez1gr4\",filter:\"TEST_FILE_RESULT\",peek:true}),\n  tools.mcp__papercusp_su__capability_bash_output({task_id:\"0mw06gffuxjt7ez1gr4\",filter:\"beforeAll|timed out|Timeout|FAIL .*papercup-public-manual\",peek:true}),\n  tools.mcp__papercusp_su__work_items_get({id:\"EI-25395058495286552\",harness:\"papercusp\",checkpointOnly:true,limit:4096,offset:0})\n]);\nfor (const [label,r] of [[\"marker\",marker],[\"timeout\",timeout],[\"checkpoint\",cp]]) {\n  const s = r?.content?.find(x=>x.type===\"text\")?.text ?? \"\";\n  let o; try { o = JSON.parse(s); } catch { o = s; }\n  if (label===\"checkpoint\" && o?.results?.[0]?.checkpointPage) {\n    const p=o.results[0].checkpointPage;\n    text(JSON.stringify({label,hash:o.results[0].checkpointContentHash,page:p}));\n  } else if (label!==\"checkpoint\" && typeof o===\"object\") {\n    text(JSON.stringify({label,ok:o.ok,status:o.status,exit_code:o.exit_code,output:o.output,output_tail:o.output_tail,tracking_lost:o.tracking_lost,failure_class:o.failure_class,test_verdict:o.test_verdict,error:o.error}));\n  } else text(JSON.stringify({label,result:o}));\n}\n",
        "part_idx": 19,
        "tool_name": "exec",
        "session_id": "01a19ff0-2cea-7741-8b8a-a763b40cdece",
        "source_kind": "codex",
        "followingResult": {
          "ts": "2026-11-03T05:47:40.209+00:00",
          "text": "Script completed\nWall time 7.4 seconds\nOutput:\n\n{\"label\":\"marker\",\"ok\":true,\"status\":\"failed\",\"exit_code\":1,\"output\":\"TEST_FILE_RESULT requested=1 executed=1 matched=1 status=failed head=ad29636727 uncommittedPaths=0/1 provenance=stamped startedAt=2026-11-03T04:18:42.232Z childSubstituted=0 childNoticeOffsetBytes=0 skippedTests=119\",\"output_tail\":\"TEST_FILE_RESULT requested=1 executed=1 matched=1 status=failed head=ad29636727 uncommittedPaths=0/1 provenance=stamped startedAt=2026-11-03T04:18:42.232Z childSubstituted=0 childNoticeOffsetBytes=0 skippedTests=119\"}\n{\"label\":\"timeout\",\"ok\":true,\"status\":\"failed\",\"exit_code\":1,\"output\":\"\\u001b[41m\\u001b[1m FAIL \\u001b[22m\\u001b[49m lib/llm-testing/__tests__/papercup-public-manual.e2e.test.ts\\u001b[2m > \\u001b[22mreal public Papercup manual behavior\\n\\u001b[31m\\u001b[1mError\\u001b[22m: Hook timed out in 60000ms.\\nIf this is a long-running hook, pass a timeout value as the last argument or configure it globally with \\\"hookTimeout\\\".\\u001b[39m\\n    \\u001b[90m2472|\\u001b[39m   beforeAll(async () => {\",\"output_tail\":\"\\u001b[41m\\u001b[1m FAIL \\u001b[22m\\u001b[49m lib/llm-testing/__tests__/papercup-public-manual.e2e.test.ts\\u001b[2m > \\u001b[22mreal public Papercup manual behavior\\n\\u001b[31m\\u001b[1mError\\u001b[22m: Hook timed out in 60000ms.\\nIf this is a long-running hook, pass a timeout value as the last argument or configure it globally with \\\"hookTimeout\\\".\\u001b[39m\\n    \\u001b[90m2472|\\u001b[39m   beforeAll(async () => {\"}\n{\"label\":\"checkpoint\",\"hash\":\"8f8f9e552403\",\"page\":{\"offset\":0,\"limit\":768,\"totalChars\":6244,\"returnedChars\":768,\"nextOffset\":768,\"text\":\"## Did\\nTask 0mw06gffuxjt7ez1gr4 ran the stamped committed source ad29636727 but stopped in the real-public-manual suite before the Portal assertion: `beforeAll` timed out at 60000ms (suite line 2472; explicit timeout line 2490). The attempt is inconclusive for composer visibility. Work-item comment 1213516 records the run marker and cleanup. The isolated child group… [truncated 457 chars]",
          "part_idx": 20,
          "tool_name": null
        }
      }
    }
  ],
  "qualified": [
    {
      "task": "0mw04lc3o7kb11hgxhs",
      "receipt": "01a19f75-1600-79f0-ae26-11bf9a90d388:135->136",
      "status": "failed",
      "exit_code": 1,
      "running": false,
      "limit": "Terminal task status only; assertion details not qualified."
    },
    {
      "task": "0mw06gffuxjt7ez1gr4",
      "receipt": "01a19ff0-2cea-7741-8b8a-a763b40cdece:19->20",
      "status": "failed",
      "exit_code": 1,
      "fileMarker": "TEST_FILE_RESULT requested=1 executed=1 matched=1 status=failed head=ad29636727 uncommittedPaths=0/1 provenance=stamped startedAt=2026-11-03T04:18:42.232Z childSubstituted=0 childNoticeOffsetBytes=0 skippedTests=119",
      "failureObserved": "beforeAll Hook timed out in 60000ms at source line2472. Mechanism causing hook timeout remains unqualified."
    }
  ],
  "limits": [
    "Positive terminal failed execution evidence, not no-action; neither task proves a successful fix or acceptance.",
    "requested/executed/matched are file fields, not assertion counts; retain119skippedTests.",
    "Claim owner c847, fleet revision23. Task start Nov3 is in this saved24h claim window; relationship to original frozen cutoff must be read from retained frozen metadata, not inferred.",
    "No source authorship, unique test_runs binding, origin owner approval, deployment, final legitimacy, complete claim outcome or full grading inferred.",
    "Two receipts are tasks in one claim-window, not two independently completed items.",
    "Native transcript glob returned similar prefixes with different full UUIDs; none is used as corroboration.",
    "All568legitimacy/full8R26/fixed6221/10192/D025OFF/loaded165consumer/config/BOTHwriters remainopen."
  ]
}
