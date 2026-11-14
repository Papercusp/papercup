---
rel_path: "evidence/c52-luna-r1-20261106/owner444-clearance-sample-invocations-20261108T2213Z.json"
updated_at: 1794175634099
_body: "content"
---

{
  "schemaVersion": "luna-r1-owner444-clearance-sample-invocation-v1",
  "subject": "EI-27743172902314040",
  "sql": "SELECT id,tool_name,role,run_id,spawn_id,coord_owner_id,invoked_at,duration_ms,status,output_ref,error_code,error_message,args_json,principal_kind,principal_auth_method,principal_trust,serving_host,serving_process_id,serving_build_sha,count(*) OVER () AS matching_rows FROM harness_shared.tool_invocations WHERE workspace_id='papercusp-workspace' AND harness_slug='papercusp' AND coord_owner_id='su-respawn-a51c8b849fb8963797d2928c1a3a8446' AND ((invoked_at >= '2026-11-06T15:22:00Z'::timestamptz AND invoked_at < '2026-11-06T15:26:00Z'::timestamptz AND args_json->>'id'='EI-27743172902314040') OR (invoked_at >= '2026-11-06T15:49:25Z'::timestamptz AND invoked_at < '2026-11-06T15:49:40Z'::timestamptz AND tool_name IN ('code:run','capability:bash','code_run','capability_bash'))) ORDER BY invoked_at,id LIMIT 20",
  "result": {
    "advisory": "⚠ buckets may not sum: this returns a SCALAR over harness_shared.tool_invocations, and at least one discriminating predicate reads a jsonb path, which yields NULL when the key is ABSENT. A NULL operand makes a comparison UNKNOWN rather than false, so such a row satisfies NO branch — it is silently absent from every bucket AND from the filtered total, while the numbers still come back well-formed (WI-10002034: a measured census reported 96/0/2 while 94 rows fell through every FILTER, and re-asking it as an exhaustive partition INVERTED the conclusion). A scalar cannot show you this, because the wrong answer is shaped exactly like the right one. Re-ask it as an exhaustive partition, where every row lands in exactly one labelled cell — a NULL in any `d<N>` column IS the fall-through population, and the cells MUST add up to the unfiltered total:\nSELECT\n       (coord_owner_id='su-respawn-a51c8b849fb8963797d2928c1a3a8446') AS d1,\n       (((invoked_at >= '2026-11-06T15:22:00Z'::timestamptz AND invoked_at < '2026-11-06T15:26:00Z'::timestamptz AND args_json->>'id'='EI-27743172902314040') OR (invoked_at >= '2026-11-06T15:49:25Z'::timestamptz AND invoked_at < '2026-11-06T15:49:40Z'::timestamptz AND tool_name IN ('code:run','capability:bash','code_run','capability_bash')))) AS d2,\n       count(*) AS row_count\n  FROM harness_shared.tool_invocations\n WHERE workspace_id='papercusp-workspace'\n   AND harness_slug='papercusp'\n GROUP BY 1, 2\n ORDER BY 3 DESC\n LIMIT 50;\nCheck that the cells sum before quoting any bucket as a finding. ⚠ single-agent activity read: harness_shared.tool_invocations records MCP calls ONLY, so this window is NOT \"everything this agent did\" — native Claude Code Bash/Read/Grep/Edit produce no row at all, and this box's bypass-permissions preamble actively steers agents to native Bash for reads. Measured over ingested transcript parts (24h): native 54,009 calls across 183 agents vs MCP 35,479 across 128, so ~60% of recorded tool use is invisible here. The error is DIRECTIONAL — missing rows can only make an agent look LESS active, so a sparse or empty window reads as \"idle\" and escalates into waking, accusing or reassigning a peer who was working (EI-21847759967934033: this ledger showed one agent making only coord:glance / activity:report while it was in fact running Bash the whole time). THE RULE: positive rows prove activity; absence here proves nothing. To look for the missing half, start with `activity:tool-log { owner: '<the coord ownerId>' }` — it reads harness_shared.agent_activity, which DOES record native calls, and renders the command text. But do not invert the error onto it: that store is empty for ~45% of agents (24h: 182 of 333 tool_invocations owners had any rows), so an empty tool-log is equally not evidence of idleness. Corroborate with the transcript store, which is corpus-namespaced — workspace_id = 'default', NOT your tenant id: SELECT ts, tool_name, text FROM harness_shared.session_turn_parts WHERE workspace_id = 'default' AND owner = '<the coord ownerId>' AND ts > now() - interval '30 minutes' ORDER BY ts DESC LIMIT 50. `owner` is the coord ownerId and `text` is the faithful-render payload column, so both take the same id you scoped this query with.",
    "mode": "query",
    "rowCount": 5,
    "truncated": false,
    "fields": [
      "id",
      "tool_name",
      "role",
      "run_id",
      "spawn_id",
      "coord_owner_id",
      "invoked_at",
      "duration_ms",
      "status",
      "output_ref",
      "error_code",
      "error_message",
      "args_json",
      "principal_kind",
      "principal_auth_method",
      "principal_trust",
      "serving_host",
      "serving_process_id",
      "serving_build_sha",
      "matching_rows"
    ],
    "elapsedMs": 92,
    "rows": [
      {
        "id": "47431771",
        "tool_name": "work_items:set_blocker",
        "role": "operator",
        "run_id": "2a981c6b-9b5f-4641-954d-62a7554a4fda",
        "spawn_id": "ephemeral-d77202b508eb1b34",
        "coord_owner_id": "su-respawn-a51c8b849fb8963797d2928c1a3a8446",
        "invoked_at": "2026-11-06 15:23:23.337+00",
        "duration_ms": 589,
        "status": "ok",
        "output_ref": null,
        "error_code": null,
        "error_message": null,
        "args_json": {
          "id": "EI-27743172902314040",
          "ref": "conversation:answered:conv-mw53rsa5-0000-c05f784f26534d3fa3751e8cbe11efe0",
          "kind": "event",
          "harness": "papercusp",
          "summary": "Wait for the current leader's routed P024 compiler startup/delivery evidence.",
          "evidence": "The registered live leader su-fbc7cfa0-26a3-46f3-9ea6-ed08ecb12f8b routed a focused request to prior P024 contract-test worker su-4a84c. The exact conversation:answered event is declared by that conversation; await 406461 is registered. No measurement has been confirmed yet.",
          "nextVerb": "On the answer event, read the specialist evidence; keep the 3000ms assertion unchanged until startup-versus-delivery timing is measured.",
          "capability": "live-dependency"
        },
        "principal_kind": "system",
        "principal_auth_method": "bearer-token",
        "principal_trust": "trusted",
        "serving_host": "port-3070",
        "serving_process_id": "linux:c58f787e-e441-4c5c-a0f5-40e3b362e124:39693923",
        "serving_build_sha": "d740fc3802",
        "matching_rows": "5"
      },
      {
        "id": "47432105",
        "tool_name": "work_items:set_blocker",
        "role": "operator",
        "run_id": "5d5f8daf-81b9-4e5a-96d9-7da2b4a1d53f",
        "spawn_id": "ephemeral-12cbcd416aca2bab",
        "coord_owner_id": "su-respawn-a51c8b849fb8963797d2928c1a3a8446",
        "invoked_at": "2026-11-06 15:24:36.784+00",
        "duration_ms": 571,
        "status": "ok",
        "output_ref": null,
        "error_code": null,
        "error_message": null,
        "args_json": {
          "id": "EI-27743172902314040",
          "ref": "compiler/evidence-prior steward diagnosis",
          "clear": true,
          "harness": "papercusp"
        },
        "principal_kind": "system",
        "principal_auth_method": "bearer-token",
        "principal_trust": "trusted",
        "serving_host": "port-3070",
        "serving_process_id": "linux:c58f787e-e441-4c5c-a0f5-40e3b362e124:39693923",
        "serving_build_sha": "d740fc3802",
        "matching_rows": "5"
      },
      {
        "id": "47432301",
        "tool_name": "work_items:get",
        "role": "operator",
        "run_id": "a5aa32ec-c71a-45d9-b5b6-f478b0b21421",
        "spawn_id": "ephemeral-007363202615d23e",
        "coord_owner_id": "su-respawn-a51c8b849fb8963797d2928c1a3a8446",
        "invoked_at": "2026-11-06 15:25:12.84+00",
        "duration_ms": 18,
        "status": "ok",
        "output_ref": null,
        "error_code": null,
        "error_message": null,
        "args_json": {
          "id": "EI-27743172902314040",
          "resume": true,
          "harness": "papercusp"
        },
        "principal_kind": "system",
        "principal_auth_method": "bearer-token",
        "principal_trust": "trusted",
        "serving_host": "port-3070",
        "serving_process_id": "linux:c58f787e-e441-4c5c-a0f5-40e3b362e124:39563282",
        "serving_build_sha": "d740fc3802",
        "matching_rows": "5"
      },
      {
        "id": "47439177",
        "tool_name": "capability:bash",
        "role": "operator",
        "run_id": "4cfeba86-05ff-4e91-a21a-931c11f45a94",
        "spawn_id": "ephemeral-fc50b8c64f37de4e",
        "coord_owner_id": "su-respawn-a51c8b849fb8963797d2928c1a3a8446",
        "invoked_at": "2026-11-06 15:49:38.177+00",
        "duration_ms": 4641,
        "status": "ok",
        "output_ref": null,
        "error_code": null,
        "error_message": null,
        "args_json": {
          "cwd": "/home/marsh-office/papercupai-workspace/papercusp",
          "command": "node --import tsx --input-type=module <<'JS'\nimport { fork } from \"node:child_process\";\nimport { mkdtemp, writeFile, rm } from \"node:fs/promises\";\nimport { tmpdir } from \"node:os\";\nimport { join } from \"node:path\";\nimport { performance } from \"node:perf_hooks\";\nimport { LSP_VENDOR_DIR } from \"./packages/operator-core/lib/code-intelligence/lsp-adapter.ts\";\nimport { terminateSpawnTree } from \"@papercusp/backup/hook\";\n\nconst start = performance.now();\nconst elapsed = () => Math.round(performance.now() - start);\nconst root = await mkdtemp(join(tmpdir(), \"p024-worker-phase-\"));\nawait writeFile(join(root, \"existing.ts\"), 'import { helper } from \"./helper\";\\nexport function rollbackReplayBridge() { return helper(); }\\n');\nawait writeFile(join(root, \"helper.ts\"), 'export function helper() { return \"EXISTING_ROLLBACK_AND_REPLAY\"; }\\n');\nconst workerPath = join(process.cwd(), \"packages/operator-core/lib/code-intelligence/first-party-callers.worker.ts\");\nconst job = { root, repositoryId: \"review-repository\", vendorDir: LSP_VENDOR_DIR,\n  name: \"rollbackReplayBridge\", filePath: \"existing.ts\", paths: [\"existing.ts\"],\n  op: \"context\", limit: 12, authorizedReadRoots: [root] };\nlet child;\nconst progress = [];\nlet spawnEventMs = null;\nlet sendCallbackMs = null;\nlet spawnError = null;\nlet workerResult = null;\nconst forkStartMs = elapsed();\nchild = fork(workerPath, [], { execArgv: [\"--max-old-space-size=3072\", \"--import\", \"tsx\"],\n  serialization: \"advanced\", silent: true, detached: process.platform !== \"win32\" });\nconst forkReturnMs = elapsed();\nchild.once(\"spawn\", () => { spawnEventMs = elapsed(); });\nchild.once(\"error\", error => { spawnError = error.message; });\nchild.stdout?.resume();\nchild.stderr?.resume();\nconst exited = new Promise(resolve => child.once(\"exit\", (code, signal) => resolve({ code, signal, exitMs: elapsed() })));\nconst outcome = await new Promise(resolve => {\n  const timer = setTimeout(() => resolve({ timedOut: true }), 3000);\n  child.on(\"message\", message => {\n    const at = elapsed();\n    if (message && message.kind === \"first-party-callers-progress\") {\n      progress.push({ phase: message.phase, parentElapsedMs: at, workerElapsedMs: message.elapsedMs });\n      return;\n    }\n    workerResult = { error: typeof message?.error === \"string\" ? message.error : null,\n      backend: message?.backend ?? null, siteCount: Array.isArray(message?.sites) ? message.sites.length : null };\n    clearTimeout(timer);\n    resolve({ timedOut: false, answerAtMs: at });\n  });\n  child.send(job, error => {\n    sendCallbackMs = elapsed();\n    if (error) {\n      spawnError = error.message;\n      clearTimeout(timer);\n      resolve({ timedOut: false, sendError: error.message });\n    }\n  });\n});\nawait terminateSpawnTree(child, process.platform !== \"win32\");\nconst exit = await exited;\nawait rm(root, { recursive: true, force: true });\nconsole.log(JSON.stringify({ budgetMs: 3000, forkStartMs, forkReturnMs, spawnEventMs, sendCallbackMs,\n  progress, outcome, workerResult, spawnError, exit }));\nJS",
          "timeout": 15000,
          "description": "measure one P024 worker startup under the 3000ms budget",
          "work_item_id": "EI-27743172902314040"
        },
        "principal_kind": "system",
        "principal_auth_method": "bearer-token",
        "principal_trust": "trusted",
        "serving_host": "port-3070",
        "serving_process_id": "linux:c58f787e-e441-4c5c-a0f5-40e3b362e124:39693923",
        "serving_build_sha": "d740fc3802",
        "matching_rows": "5"
      },
      {
        "id": "47439178",
        "tool_name": "code:run",
        "role": "operator",
        "run_id": "4cfeba86-05ff-4e91-a21a-931c11f45a94",
        "spawn_id": "ephemeral-fc50b8c64f37de4e",
        "coord_owner_id": "su-respawn-a51c8b849fb8963797d2928c1a3a8446",
        "invoked_at": "2026-11-06 15:49:38.198+00",
        "duration_ms": 4722,
        "status": "ok",
        "output_ref": null,
        "error_code": null,
        "error_message": null,
        "args_json": {
          "script": "const r = await tools.capability.bash({\"command\":\"node --import tsx --input-type=module <<'JS'\\nimport { fork } from \\\"node:child_process\\\";\\nimport { mkdtemp, writeFile, rm } from \\\"node:fs/promises\\\";\\nimport { tmpdir } from \\\"node:os\\\";\\nimport { join } from \\\"node:path\\\";\\nimport { performance } from \\\"node:perf_hooks\\\";\\nimport { LSP_VENDOR_DIR } from \\\"./packages/operator-core/lib/code-intelligence/lsp-adapter.ts\\\";\\nimport { terminateSpawnTree } from \\\"@papercusp/backup/hook\\\";\\n\\nconst start = performance.now();\\nconst elapsed = () => Math.round(performance.now() - start);\\nconst root = await mkdtemp(join(tmpdir(), \\\"p024-worker-phase-\\\"));\\nawait writeFile(join(root, \\\"existing.ts\\\"), 'import { helper } from \\\"./helper\\\";\\\\nexport function rollbackReplayBridge() { return helper(); }\\\\n');\\nawait writeFile(join(root, \\\"helper.ts\\\"), 'export function helper() { return \\\"EXISTING_ROLLBACK_AND_REPLAY\\\"; }\\\\n');\\nconst workerPath = join(process.cwd(), \\\"packages/operator-core/lib/code-intelligence/first-party-callers.worker.ts\\\");\\nconst job = { root, repositoryId: \\\"review-repository\\\", vendorDir: LSP_VENDOR_DIR,\\n  name: \\\"rollbackReplayBridge\\\", filePath: \\\"existing.ts\\\", paths: [\\\"existing.ts\\\"],\\n  op: \\\"context\\\", limit: 12, authorizedReadRoots: [root] };\\nlet child;\\nconst progress = [];\\nlet spawnEventMs = null;\\nlet sendCallbackMs = null;\\nlet spawnError = null;\\nlet workerResult = null;\\nconst forkStartMs = elapsed();\\nchild = fork(workerPath, [], { execArgv: [\\\"--max-old-space-size=3072\\\", \\\"--import\\\", \\\"tsx\\\"],\\n  serialization: \\\"advanced\\\", silent: true, detached: process.platform !== \\\"win32\\\" });\\nconst forkReturnMs = elapsed();\\nchild.once(\\\"spawn\\\", () => { spawnEventMs = elapsed(); });\\nchild.once(\\\"error\\\", error => { spawnError = error.message; });\\nchild.stdout?.resume();\\nchild.stderr?.resume();\\nconst exited = new Promise(resolve => child.once(\\\"exit\\\", (code, signal) => resolve({ code, signal, exitMs: elapsed() })));\\nconst outcome = await new Promise(resolve => {\\n  const timer = setTimeout(() => resolve({ timedOut: true }), 3000);\\n  child.on(\\\"message\\\", message => {\\n    const at = elapsed();\\n    if (message && message.kind === \\\"first-party-callers-progress\\\") {\\n      progress.push({ phase: message.phase, parentElapsedMs: at, workerElapsedMs: message.elapsedMs });\\n      return;\\n    }\\n    workerResult = { error: typeof message?.error === \\\"string\\\" ? message.error : null,\\n      backend: message?.backend ?? null, siteCount: Array.isArray(message?.sites) ? message.sites.length : null };\\n    clearTimeout(timer);\\n    resolve({ timedOut: false, answerAtMs: at });\\n  });\\n  child.send(job, error => {\\n    sendCallbackMs = elapsed();\\n    if (error) {\\n      spawnError = error.message;\\n      clearTimeout(timer);\\n      resolve({ timedOut: false, sendError: error.message });\\n    }\\n  });\\n});\\nawait terminateSpawnTree(child, process.platform !== \\\"win32\\\");\\nconst exit = await exited;\\nawait rm(root, { recursive: true, force: true });\\nconsole.log(JSON.stringify({ budgetMs: 3000, forkStartMs, forkReturnMs, spawnEventMs, sendCallbackMs,\\n  progress, outcome, workerResult, spawnError, exit }));\\nJS\",\"cwd\":\"/home/marsh-office/papercupai-workspace/papercusp\",\"timeout\":15000,\"description\":\"measure one P024 worker startup under the 3000ms budget\",\"work_item_id\":\"EI-27743172902314040\"}); return r;",
          "timeoutSec": 25
        },
        "principal_kind": "system",
        "principal_auth_method": "bearer-token",
        "principal_trust": "trusted",
        "serving_host": "port-3070",
        "serving_process_id": "linux:c58f787e-e441-4c5c-a0f5-40e3b362e124:39693923",
        "serving_build_sha": "d740fc3802",
        "matching_rows": "5"
      }
    ],
    "positiveControl": {
      "rows": [
        {
          "id": "47451386"
        }
      ],
      "rowCount": 1,
      "truncated": false,
      "fields": [
        "id"
      ],
      "status": "passed"
    }
  }
}
