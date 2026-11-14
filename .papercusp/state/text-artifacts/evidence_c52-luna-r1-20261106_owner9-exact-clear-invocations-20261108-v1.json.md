---
rel_path: "evidence/c52-luna-r1-20261106/owner9-exact-clear-invocations-20261108-v1.json"
updated_at: 1794178502744
_body: "content"
---

{
  "schemaVersion": "luna-r1-owner9-clear-invocations-v1",
  "workItem": "WI-6554700010045700",
  "source": {
    "slug": "papercusp",
    "rel_path": "evidence/c52-luna-r1-20261106/owner54-saved-backing-qualification-20261108-v1.json",
    "updated_at": 1794171097155,
    "contentChars": 612939
  },
  "scope": "Exact nine non-system45 strata in saved owner54, ten recorded human clears. Historical bounded owner/time/item MCP instrument only.",
  "targets": [
    {
      "item_id": "EI-25398054129696034",
      "entry_index": 0,
      "ref": "conv-mv6ifdq6-0000-b827b04e02234c6ebb380e4e6f9d38c8",
      "clearer": "su-82592767-2742-45b8-b053-4b096877bacc",
      "cleared_at": "2026-10-13T17:10:36.045Z"
    },
    {
      "item_id": "EI-25938663476959671",
      "entry_index": 0,
      "ref": "coord-send-405d2e3114435f67b8f527871c59c51b0cdb2320c17d08a3822449b99bcb3f3f",
      "clearer": "su-54ccf487-3fe5-472a-acc6-bb5a2b7f891b",
      "cleared_at": "2026-10-15T21:37:23.200Z"
    },
    {
      "item_id": "EI-25996144041259055",
      "entry_index": 0,
      "ref": "@fleet-leader:nonp2p-bug-drain-luna-max-0930",
      "clearer": "su-0b720d29-b37b-4f10-a2cc-12f979360c85",
      "cleared_at": "2026-10-27T07:50:06.205Z"
    },
    {
      "item_id": "EI-26050120829344230",
      "entry_index": 0,
      "ref": "historical-mcp-proxy-traces",
      "clearer": "su-11763d34-9b61-452f-b6c5-c924800a95ea",
      "cleared_at": "2026-10-16T13:28:35.516Z"
    },
    {
      "item_id": "EI-26217185985299604",
      "entry_index": 1,
      "ref": "coord-send-f3eb8aa7a3530b84d3966af0e6e438366de618a5e84f29877600568b24a96707",
      "clearer": "su-55595f20-e777-401b-92a3-3f06394a9541",
      "cleared_at": "2026-10-27T16:29:30.536Z"
    },
    {
      "item_id": "EI-26703088044163715",
      "entry_index": 0,
      "ref": "fleet:nonp2p-bug-drain-luna-max-0930 / leader su-ccd9e910-dfb2-471c-bf1c-7623b01f221e",
      "clearer": "su-4cbae037-ba0b-40f0-b1a7-f0de0d684f6d",
      "cleared_at": "2026-10-29T03:49:31.747Z"
    },
    {
      "item_id": "EI-26758127048383986",
      "entry_index": 0,
      "ref": "fleet:nonp2p-bug-drain-luna-max-0930 / leader su-ccd9e910-dfb2-471c-bf1c-7623b01f221e",
      "clearer": "su-4cbae037-ba0b-40f0-b1a7-f0de0d684f6d",
      "cleared_at": "2026-10-29T03:49:34.066Z"
    },
    {
      "item_id": "EI-27548849688842649",
      "entry_index": 0,
      "ref": "consult:conv-request-0eb1a4b875fe2fa8100ff605adf71da7dbbb0510d0fd9e1de2e9cbe83d25e46d",
      "clearer": "su-ad6b428d-f738-4b3e-98be-bb51bc2762cd",
      "cleared_at": "2026-11-02T23:26:33.727Z"
    },
    {
      "item_id": "EI-27548849688842649",
      "entry_index": 1,
      "ref": "fleet-leader-route-decision:nonp2p-bug-drain-luna-max-0930 / EI-27548849688842649",
      "clearer": "su-00ea7689-7fd3-426c-8f50-a59ba31770cd",
      "cleared_at": "2026-11-03T03:51:44.173Z"
    },
    {
      "item_id": "EI-27707885265505216",
      "entry_index": 0,
      "ref": "node-to-bun-staged-migration-2026-10-22#D-018",
      "clearer": "su-6d787f0e-d99b-4e1b-b571-d6cfc0b2870a",
      "cleared_at": "2026-11-06T03:22:43.141Z"
    }
  ],
  "sql": "WITH targets AS (SELECT * FROM jsonb_to_recordset($1::jsonb) AS e(item_id text,entry_index int,ref text,clearer text,cleared_at timestamptz)) SELECT e.*,t.id AS invocation_id,t.tool_name,t.coord_owner_id,t.invoked_at,t.duration_ms,t.status,t.output_ref,t.error_code,t.args_json,t.principal_kind,t.principal_auth_method,t.principal_trust,t.serving_host,t.serving_process_id,t.serving_build_sha FROM targets e LEFT JOIN LATERAL (SELECT id,tool_name,coord_owner_id,invoked_at,duration_ms,status,output_ref,error_code,args_json,principal_kind,principal_auth_method,principal_trust,serving_host,serving_process_id,serving_build_sha FROM harness_shared.tool_invocations WHERE workspace_id='papercusp-workspace' AND harness_slug='papercusp' AND coord_owner_id=e.clearer AND invoked_at>=e.cleared_at-interval '2 minutes' AND invoked_at<e.cleared_at+interval '2 minutes' AND tool_name IN ('work_items:set_blocker','work_items_set_blocker') AND args_json->>'id'=e.item_id ORDER BY invoked_at,id LIMIT 8) t ON true ORDER BY e.item_id,e.entry_index,t.invoked_at,t.id LIMIT 81",
  "parameters": [
    "[{\"item_id\":\"EI-25398054129696034\",\"entry_index\":0,\"ref\":\"conv-mv6ifdq6-0000-b827b04e02234c6ebb380e4e6f9d38c8\",\"clearer\":\"su-82592767-2742-45b8-b053-4b096877bacc\",\"cleared_at\":\"2026-10-13T17:10:36.045Z\"},{\"item_id\":\"EI-25938663476959671\",\"entry_index\":0,\"ref\":\"coord-send-405d2e3114435f67b8f527871c59c51b0cdb2320c17d08a3822449b99bcb3f3f\",\"clearer\":\"su-54ccf487-3fe5-472a-acc6-bb5a2b7f891b\",\"cleared_at\":\"2026-10-15T21:37:23.200Z\"},{\"item_id\":\"EI-25996144041259055\",\"entry_index\":0,\"ref\":\"@fleet-leader:nonp2p-bug-drain-luna-max-0930\",\"clearer\":\"su-0b720d29-b37b-4f10-a2cc-12f979360c85\",\"cleared_at\":\"2026-10-27T07:50:06.205Z\"},{\"item_id\":\"EI-26050120829344230\",\"entry_index\":0,\"ref\":\"historical-mcp-proxy-traces\",\"clearer\":\"su-11763d34-9b61-452f-b6c5-c924800a95ea\",\"cleared_at\":\"2026-10-16T13:28:35.516Z\"},{\"item_id\":\"EI-26217185985299604\",\"entry_index\":1,\"ref\":\"coord-send-f3eb8aa7a3530b84d3966af0e6e438366de618a5e84f29877600568b24a96707\",\"clearer\":\"su-55595f20-e777-401b-92a3-3f06394a9541\",\"cleared_at\":\"2026-10-27T16:29:30.536Z\"},{\"item_id\":\"EI-26703088044163715\",\"entry_index\":0,\"ref\":\"fleet:nonp2p-bug-drain-luna-max-0930 / leader su-ccd9e910-dfb2-471c-bf1c-7623b01f221e\",\"clearer\":\"su-4cbae037-ba0b-40f0-b1a7-f0de0d684f6d\",\"cleared_at\":\"2026-10-29T03:49:31.747Z\"},{\"item_id\":\"EI-26758127048383986\",\"entry_index\":0,\"ref\":\"fleet:nonp2p-bug-drain-luna-max-0930 / leader su-ccd9e910-dfb2-471c-bf1c-7623b01f221e\",\"clearer\":\"su-4cbae037-ba0b-40f0-b1a7-f0de0d684f6d\",\"cleared_at\":\"2026-10-29T03:49:34.066Z\"},{\"item_id\":\"EI-27548849688842649\",\"entry_index\":0,\"ref\":\"consult:conv-request-0eb1a4b875fe2fa8100ff605adf71da7dbbb0510d0fd9e1de2e9cbe83d25e46d\",\"clearer\":\"su-ad6b428d-f738-4b3e-98be-bb51bc2762cd\",\"cleared_at\":\"2026-11-02T23:26:33.727Z\"},{\"item_id\":\"EI-27548849688842649\",\"entry_index\":1,\"ref\":\"fleet-leader-route-decision:nonp2p-bug-drain-luna-max-0930 / EI-27548849688842649\",\"clearer\":\"su-00ea7689-7fd3-426c-8f50-a59ba31770cd\",\"cleared_at\":\"2026-11-03T03:51:44.173Z\"},{\"item_id\":\"EI-27707885265505216\",\"entry_index\":0,\"ref\":\"node-to-bun-staged-migration-2026-10-22#D-018\",\"clearer\":\"su-6d787f0e-d99b-4e1b-b571-d6cfc0b2870a\",\"cleared_at\":\"2026-11-06T03:22:43.141Z\"}]"
  ],
  "positiveControlSql": "SELECT id FROM harness_shared.tool_invocations WHERE workspace_id='papercusp-workspace' AND harness_slug='papercusp' AND id=47432105",
  "result": {
    "advisory": "⚠ population-narrowing query shape: this SQL uses LIMIT; zero rows from the bounded query do not establish that the underlying population is empty. Re-run without the narrowing clause before making an absence claim, or report the result as a bounded subset rather than a census. (EI-22433765987075358). ⚠ single-agent activity read: harness_shared.tool_invocations records MCP calls ONLY, so this window is NOT \"everything this agent did\" — native Claude Code Bash/Read/Grep/Edit produce no row at all, and this box's bypass-permissions preamble actively steers agents to native Bash for reads. Measured over ingested transcript parts (24h): native 54,009 calls across 183 agents vs MCP 35,479 across 128, so ~60% of recorded tool use is invisible here. The error is DIRECTIONAL — missing rows can only make an agent look LESS active, so a sparse or empty window reads as \"idle\" and escalates into waking, accusing or reassigning a peer who was working (EI-21847759967934033: this ledger showed one agent making only coord:glance / activity:report while it was in fact running Bash the whole time). THE RULE: positive rows prove activity; absence here proves nothing. To look for the missing half, start with `activity:tool-log { owner: '<the coord ownerId>' }` — it reads harness_shared.agent_activity, which DOES record native calls, and renders the command text. But do not invert the error onto it: that store is empty for ~45% of agents (24h: 182 of 333 tool_invocations owners had any rows), so an empty tool-log is equally not evidence of idleness. Corroborate with the transcript store, which is corpus-namespaced — workspace_id = 'default', NOT your tenant id: SELECT ts, tool_name, text FROM harness_shared.session_turn_parts WHERE workspace_id = 'default' AND owner = '<the coord ownerId>' AND ts > now() - interval '30 minutes' ORDER BY ts DESC LIMIT 50. `owner` is the coord ownerId and `text` is the faithful-render payload column, so both take the same id you scoped this query with.",
    "mode": "query",
    "rowCount": 23,
    "truncated": false,
    "fields": [
      "item_id",
      "entry_index",
      "ref",
      "clearer",
      "cleared_at",
      "invocation_id",
      "tool_name",
      "coord_owner_id",
      "invoked_at",
      "duration_ms",
      "status",
      "output_ref",
      "error_code",
      "args_json",
      "principal_kind",
      "principal_auth_method",
      "principal_trust",
      "serving_host",
      "serving_process_id",
      "serving_build_sha"
    ],
    "elapsedMs": 111,
    "rows": [
      {
        "item_id": "EI-25398054129696034",
        "entry_index": 0,
        "ref": "conv-mv6ifdq6-0000-b827b04e02234c6ebb380e4e6f9d38c8",
        "clearer": "su-82592767-2742-45b8-b053-4b096877bacc",
        "cleared_at": "2026-10-13 17:10:36.045+00",
        "invocation_id": null,
        "tool_name": null,
        "coord_owner_id": null,
        "invoked_at": null,
        "duration_ms": null,
        "status": null,
        "output_ref": null,
        "error_code": null,
        "args_json": null,
        "principal_kind": null,
        "principal_auth_method": null,
        "principal_trust": null,
        "serving_host": null,
        "serving_process_id": null,
        "serving_build_sha": null
      },
      {
        "item_id": "EI-25938663476959671",
        "entry_index": 0,
        "ref": "coord-send-405d2e3114435f67b8f527871c59c51b0cdb2320c17d08a3822449b99bcb3f3f",
        "clearer": "su-54ccf487-3fe5-472a-acc6-bb5a2b7f891b",
        "cleared_at": "2026-10-15 21:37:23.2+00",
        "invocation_id": "39230312",
        "tool_name": "work_items:set_blocker",
        "coord_owner_id": "su-54ccf487-3fe5-472a-acc6-bb5a2b7f891b",
        "invoked_at": "2026-10-15 21:36:36.089+00",
        "duration_ms": 1024,
        "status": "ok",
        "output_ref": null,
        "error_code": null,
        "args_json": {
          "id": "EI-25938663476959671",
          "ref": "coord-send-405d2e3114435f67b8f527871c59c51b0cdb2320c17d08a3822449b99bcb3f3f",
          "kind": "product-decision",
          "harness": "papercusp",
          "summary": "Await fleet-leader scope ruling on whether this lane may make a wording-only source correction; the existing item-thread ruling is diagnostics-only and prohibits implementation.",
          "evidence": "The current incident measures ack+readback at 30,604ms of a 31,433ms cycle (sendMessage 29,542ms; lock phases 151ms). attributeBreach at coord-invariant-actions.ts:284 says those measured end-to-end steps do not show full-cycle dominance. This proves phase dominance but not the low-level sendMessage cause. Item comment 1183000 bars implementation/schema changes.",
          "nextVerb": "Apply the fleet leader's scope ruling; if a wording correction is admitted, update attributeBreach and its focused test; otherwise keep this report diagnostic-only.",
          "capability": "product-decision"
        },
        "principal_kind": "system",
        "principal_auth_method": "bearer-token",
        "principal_trust": "trusted",
        "serving_host": "port-3070",
        "serving_process_id": "linux:b8c61f1d-f67c-43a8-ac9d-2286713e224f:88833211",
        "serving_build_sha": "d740fc3802"
      },
      {
        "item_id": "EI-25938663476959671",
        "entry_index": 0,
        "ref": "coord-send-405d2e3114435f67b8f527871c59c51b0cdb2320c17d08a3822449b99bcb3f3f",
        "clearer": "su-54ccf487-3fe5-472a-acc6-bb5a2b7f891b",
        "cleared_at": "2026-10-15 21:37:23.2+00",
        "invocation_id": "39230964",
        "tool_name": "work_items:set_blocker",
        "coord_owner_id": "su-54ccf487-3fe5-472a-acc6-bb5a2b7f891b",
        "invoked_at": "2026-10-15 21:37:24.047+00",
        "duration_ms": 1125,
        "status": "ok",
        "output_ref": null,
        "error_code": null,
        "args_json": {
          "id": "EI-25938663476959671",
          "clear": true,
          "harness": "papercusp"
        },
        "principal_kind": "system",
        "principal_auth_method": "bearer-token",
        "principal_trust": "trusted",
        "serving_host": "port-3070",
        "serving_process_id": "linux:b8c61f1d-f67c-43a8-ac9d-2286713e224f:88681923",
        "serving_build_sha": "d740fc3802"
      },
      {
        "item_id": "EI-25938663476959671",
        "entry_index": 0,
        "ref": "coord-send-405d2e3114435f67b8f527871c59c51b0cdb2320c17d08a3822449b99bcb3f3f",
        "clearer": "su-54ccf487-3fe5-472a-acc6-bb5a2b7f891b",
        "cleared_at": "2026-10-15 21:37:23.2+00",
        "invocation_id": "39231115",
        "tool_name": "work_items:set_blocker",
        "coord_owner_id": "su-54ccf487-3fe5-472a-acc6-bb5a2b7f891b",
        "invoked_at": "2026-10-15 21:37:35.657+00",
        "duration_ms": 276,
        "status": "ok",
        "output_ref": null,
        "error_code": null,
        "args_json": {
          "id": "EI-25938663476959671",
          "ref": "coord-send-405d2e3114435f67b8f527871c59c51b0cdb2320c17d08a3822449b99bcb3f3f",
          "kind": "event",
          "harness": "papercusp",
          "summary": "Waiting for the current fleet leader's reply to the scope question about a wording-only correction; the existing diagnostics-only ruling remains in force until clarified.",
          "evidence": "The current report measures ack+readback as 30,604ms of 31,433ms, but attributeBreach says these measured end-to-end steps do not show cycle dominance. This supports a reporting correction, not a lower-level sendMessage cause. The leader was sent a direct question with wakeOnReply=true.",
          "nextVerb": "Read the fleet leader's reply; if it changes the scope ruling, update the item and proceed, otherwise keep diagnostic-only.",
          "capability": "live-dependency"
        },
        "principal_kind": "system",
        "principal_auth_method": "bearer-token",
        "principal_trust": "trusted",
        "serving_host": "port-3070",
        "serving_process_id": "linux:b8c61f1d-f67c-43a8-ac9d-2286713e224f:88768994",
        "serving_build_sha": "d740fc3802"
      },
      {
        "item_id": "EI-25996144041259055",
        "entry_index": 0,
        "ref": "@fleet-leader:nonp2p-bug-drain-luna-max-0930",
        "clearer": "su-0b720d29-b37b-4f10-a2cc-12f979360c85",
        "cleared_at": "2026-10-27 07:50:06.205+00",
        "invocation_id": "45144416",
        "tool_name": "work_items:set_blocker",
        "coord_owner_id": "su-0b720d29-b37b-4f10-a2cc-12f979360c85",
        "invoked_at": "2026-10-27 07:49:12.31+00",
        "duration_ms": 190,
        "status": "ok",
        "output_ref": null,
        "error_code": null,
        "args_json": {
          "id": "EI-25996144041259055",
          "ref": "@fleet-leader:nonp2p-bug-drain-luna-max-0930",
          "kind": "product-decision",
          "harness": "papercusp",
          "summary": "Await the fleet leader's exact-ID disposition or supported verification route for the historical git-evidence timeout.",
          "evidence": "The stored checkpoint requires an authorized judge-role result or exact call/receipt correlation. Current staging source has a bounded Git command gate and concurrency regression test (commit 62994650, 2026-10-16), but this does not establish the cause of the Oct 14 invocation or a current passing result. Plan nonp2p-bug-drain-2026-08-08#D-001 requires current check evidence for already-fixed closure and says decision walls escalate to the leader.",
          "nextVerb": "coord:inbox",
          "capability": "product-decision"
        },
        "principal_kind": "system",
        "principal_auth_method": "bearer-token",
        "principal_trust": "trusted",
        "serving_host": "port-3070",
        "serving_process_id": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:23657513",
        "serving_build_sha": "d740fc3802"
      },
      {
        "item_id": "EI-25996144041259055",
        "entry_index": 0,
        "ref": "@fleet-leader:nonp2p-bug-drain-luna-max-0930",
        "clearer": "su-0b720d29-b37b-4f10-a2cc-12f979360c85",
        "cleared_at": "2026-10-27 07:50:06.205+00",
        "invocation_id": "45144713",
        "tool_name": "work_items:set_blocker",
        "coord_owner_id": "su-0b720d29-b37b-4f10-a2cc-12f979360c85",
        "invoked_at": "2026-10-27 07:50:06.245+00",
        "duration_ms": 51,
        "status": "ok",
        "output_ref": null,
        "error_code": null,
        "args_json": {
          "id": "EI-25996144041259055",
          "ref": "@fleet-leader:nonp2p-bug-drain-luna-max-0930",
          "clear": true,
          "harness": "papercusp"
        },
        "principal_kind": "system",
        "principal_auth_method": "bearer-token",
        "principal_trust": "trusted",
        "serving_host": "port-3070",
        "serving_process_id": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:23687651",
        "serving_build_sha": "d740fc3802"
      },
      {
        "item_id": "EI-25996144041259055",
        "entry_index": 0,
        "ref": "@fleet-leader:nonp2p-bug-drain-luna-max-0930",
        "clearer": "su-0b720d29-b37b-4f10-a2cc-12f979360c85",
        "cleared_at": "2026-10-27 07:50:06.205+00",
        "invocation_id": "45144934",
        "tool_name": "work_items:set_blocker",
        "coord_owner_id": "su-0b720d29-b37b-4f10-a2cc-12f979360c85",
        "invoked_at": "2026-10-27 07:50:41.721+00",
        "duration_ms": 71,
        "status": "ok",
        "output_ref": null,
        "error_code": null,
        "args_json": {
          "id": "EI-25996144041259055",
          "ref": "coord:inbox-wake:su-0b720d29-b37b-4f10-a2cc-12f979360c85",
          "kind": "event",
          "harness": "papercusp",
          "summary": "Await fleet leader's response to the exact-ID disposition request.",
          "evidence": "The leader is live and received coord message coord-send-7eb365376499b003775561bd73b7602e23e9f836ed8f? The exact ask message id is coord-send-7eb365376499b003775561bd73b7602e23e9f836ed8f? Verify from the sent receipt: askMsgId coord-send-7eb365376499b003775561bd73b7602e23e9f836edf38ed01044290f12bc5060. The saved checkpoint has no exact historical tool receipt/call-to-trace join. Current source guard and concurrency regression exist, but no current run result or exact original cause is established.",
          "nextVerb": "events:await",
          "capability": "live-dependency"
        },
        "principal_kind": "system",
        "principal_auth_method": "bearer-token",
        "principal_trust": "trusted",
        "serving_host": "port-3070",
        "serving_process_id": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:23384954",
        "serving_build_sha": "d740fc3802"
      },
      {
        "item_id": "EI-25996144041259055",
        "entry_index": 0,
        "ref": "@fleet-leader:nonp2p-bug-drain-luna-max-0930",
        "clearer": "su-0b720d29-b37b-4f10-a2cc-12f979360c85",
        "cleared_at": "2026-10-27 07:50:06.205+00",
        "invocation_id": "45145221",
        "tool_name": "work_items:set_blocker",
        "coord_owner_id": "su-0b720d29-b37b-4f10-a2cc-12f979360c85",
        "invoked_at": "2026-10-27 07:51:35.603+00",
        "duration_ms": 56,
        "status": "ok",
        "output_ref": null,
        "error_code": null,
        "args_json": {
          "id": "EI-25996144041259055",
          "ref": "coord:inbox-wake:su-0b720d29-b37b-4f10-a2cc-12f979360c85",
          "kind": "event",
          "harness": "papercusp",
          "summary": "Await the fleet leader's response to the exact-ID disposition request.",
          "evidence": "The stored checkpoint requires an authorized judge-role result or exact call/receipt correlation. Current staging source has a bounded Git command gate and concurrency regression test (commit 62994650, 2026-10-16), but this does not establish the cause of the Oct 14 invocation or a current passing result. Plan nonp2p-bug-drain-2026-08-08#D-001 requires current check evidence for already-fixed closure and says decision walls escalate to the leader. Request message: coord-send-7eb365376499b003775561bd73b7602e23e9f836edf38ed01044290f12bc5060.",
          "nextVerb": "events:await",
          "capability": "live-dependency"
        },
        "principal_kind": "system",
        "principal_auth_method": "bearer-token",
        "principal_trust": "trusted",
        "serving_host": "port-3070",
        "serving_process_id": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:23657513",
        "serving_build_sha": "d740fc3802"
      },
      {
        "item_id": "EI-26050120829344230",
        "entry_index": 0,
        "ref": "historical-mcp-proxy-traces",
        "clearer": "su-11763d34-9b61-452f-b6c5-c924800a95ea",
        "cleared_at": "2026-10-16 13:28:35.516+00",
        "invocation_id": "39614280",
        "tool_name": "work_items:set_blocker",
        "coord_owner_id": "su-11763d34-9b61-452f-b6c5-c924800a95ea",
        "invoked_at": "2026-10-16 13:27:39.204+00",
        "duration_ms": 32438,
        "status": "ok",
        "output_ref": null,
        "error_code": null,
        "args_json": {
          "id": "EI-26050120829344230",
          "ref": "historical-proxy-trace-source",
          "kind": "runtime",
          "harness": "papercusp",
          "summary": "The historical MCP proxy trace source has no retained matching proxy JSONL record or correlated failure-time row, so the exact cause of the two checkpoint write closes cannot currently be determined.",
          "evidence": "The original reporter's session ended; coord-send-b34c2379934af64068c2cbeda3b3e499e4a183e1f557567b6e7c807d6e02ef5e received a required-wake miss. Its durable session text confirms the failed writes but gives no trace IDs or exact call times. The prior item checkpoint records one success invocation row and no matching proxy JSONL.",
          "nextVerb": "Supply a retained trace record or correlated failure-time proxy/session record for the original checkpoint writes.",
          "capability": "live-dependency"
        },
        "principal_kind": "system",
        "principal_auth_method": "bearer-token",
        "principal_trust": "trusted",
        "serving_host": "port-3070",
        "serving_process_id": "linux:b8c61f1d-f67c-43a8-ac9d-2286713e224f:94571147",
        "serving_build_sha": "d740fc3802"
      },
      {
        "item_id": "EI-26050120829344230",
        "entry_index": 0,
        "ref": "historical-mcp-proxy-traces",
        "clearer": "su-11763d34-9b61-452f-b6c5-c924800a95ea",
        "cleared_at": "2026-10-16 13:28:35.516+00",
        "invocation_id": "39614464",
        "tool_name": "work_items:set_blocker",
        "coord_owner_id": "su-11763d34-9b61-452f-b6c5-c924800a95ea",
        "invoked_at": "2026-10-16 13:28:35.694+00",
        "duration_ms": 248,
        "status": "ok",
        "output_ref": null,
        "error_code": null,
        "args_json": {
          "id": "EI-26050120829344230",
          "ref": "historical-mcp-proxy-traces",
          "kind": "human",
          "clear": true,
          "harness": "papercusp",
          "capability": "external-service-action"
        },
        "principal_kind": "system",
        "principal_auth_method": "bearer-token",
        "principal_trust": "trusted",
        "serving_host": "port-3070",
        "serving_process_id": "linux:b8c61f1d-f67c-43a8-ac9d-2286713e224f:94618938",
        "serving_build_sha": "d740fc3802"
      },
      {
        "item_id": "EI-26217185985299604",
        "entry_index": 1,
        "ref": "coord-send-f3eb8aa7a3530b84d3966af0e6e438366de618a5e84f29877600568b24a96707",
        "clearer": "su-55595f20-e777-401b-92a3-3f06394a9541",
        "cleared_at": "2026-10-27 16:29:30.536+00",
        "invocation_id": "45273495",
        "tool_name": "work_items:set_blocker",
        "coord_owner_id": "su-55595f20-e777-401b-92a3-3f06394a9541",
        "invoked_at": "2026-10-27 16:28:18.053+00",
        "duration_ms": 205,
        "status": "ok",
        "output_ref": null,
        "error_code": null,
        "args_json": {
          "id": "EI-26217185985299604",
          "ref": "coord-send-f3eb8aa7a3530b84d3966af0e6e438366de618a5e84f29877600568b24a96707",
          "kind": "product-decision",
          "harness": "papercusp",
          "summary": "Approved one-file scope contains only a wrapper; fixing the authentication failure requires a scope decision about the imported implementation/config.",
          "evidence": "scripts/restricted-hold-tree-gate.mjs imports runTreeRestrictedHoldPreflight from ./lib/restricted-hold-preflight.mjs, passes roots, formats the verdict, and exits. No ledger/auth handling is present in the approved file. The actual auth root cause remains unknown.",
          "nextVerb": "Await the fleet leader's scope disposition; proceed only on the authorized file set.",
          "capability": "product-decision"
        },
        "principal_kind": "system",
        "principal_auth_method": "bearer-token",
        "principal_trust": "trusted",
        "serving_host": "port-3070",
        "serving_process_id": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:26709560",
        "serving_build_sha": "d740fc3802"
      },
      {
        "item_id": "EI-26217185985299604",
        "entry_index": 1,
        "ref": "coord-send-f3eb8aa7a3530b84d3966af0e6e438366de618a5e84f29877600568b24a96707",
        "clearer": "su-55595f20-e777-401b-92a3-3f06394a9541",
        "cleared_at": "2026-10-27 16:29:30.536+00",
        "invocation_id": "45273794",
        "tool_name": "work_items:set_blocker",
        "coord_owner_id": "su-55595f20-e777-401b-92a3-3f06394a9541",
        "invoked_at": "2026-10-27 16:29:30.565+00",
        "duration_ms": 85,
        "status": "ok",
        "output_ref": null,
        "error_code": null,
        "args_json": {
          "id": "EI-26217185985299604",
          "clear": true,
          "harness": "papercusp"
        },
        "principal_kind": "system",
        "principal_auth_method": "bearer-token",
        "principal_trust": "trusted",
        "serving_host": "port-3070",
        "serving_process_id": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:26718492",
        "serving_build_sha": "d740fc3802"
      },
      {
        "item_id": "EI-26217185985299604",
        "entry_index": 1,
        "ref": "coord-send-f3eb8aa7a3530b84d3966af0e6e438366de618a5e84f29877600568b24a96707",
        "clearer": "su-55595f20-e777-401b-92a3-3f06394a9541",
        "cleared_at": "2026-10-27 16:29:30.536+00",
        "invocation_id": "45273798",
        "tool_name": "work_items:set_blocker",
        "coord_owner_id": "su-55595f20-e777-401b-92a3-3f06394a9541",
        "invoked_at": "2026-10-27 16:29:31.313+00",
        "duration_ms": 154,
        "status": "ok",
        "output_ref": null,
        "error_code": null,
        "args_json": {
          "id": "EI-26217185985299604",
          "ref": "coord-send-f3eb8aa7a3530b84d3966af0e6e438366de618a5e84f29877600568b24a96707",
          "kind": "runtime",
          "harness": "papercusp",
          "summary": "Awaiting the fleet leader's scope disposition after the approved wrapper-only file proved unable to address the authentication failure.",
          "evidence": "The leader ruled scripts/restricted-hold-tree-gate.mjs only. This file delegates to ./lib/restricted-hold-preflight.mjs and contains no ledger/auth handling. Exact root cause remains unknown.",
          "nextVerb": "Read the leader's reply to the exact coord request, then proceed only on the resulting authorized scope.",
          "capability": "live-dependency"
        },
        "principal_kind": "system",
        "principal_auth_method": "bearer-token",
        "principal_trust": "trusted",
        "serving_host": "port-3070",
        "serving_process_id": "linux:80a97db5-1b86-4b37-b3a1-50bc5df46287:26759471",
        "serving_build_sha": "d740fc3802"
      },
      {
        "item_id": "EI-26703088044163715",
        "entry_index": 0,
        "ref": "fleet:nonp2p-bug-drain-luna-max-0930 / leader su-ccd9e910-dfb2-471c-bf1c-7623b01f221e",
        "clearer": "su-4cbae037-ba0b-40f0-b1a7-f0de0d684f6d",
        "cleared_at": "2026-10-29 03:49:31.747+00",
        "invocation_id": "45854603",
        "tool_name": "work_items:set_blocker",
        "coord_owner_id": "su-4cbae037-ba0b-40f0-b1a7-f0de0d684f6d",
        "invoked_at": "2026-10-29 03:48:52.213+00",
        "duration_ms": 610,
        "status": "ok",
        "output_ref": null,
        "error_code": null,
        "args_json": {
          "id": "EI-26703088044163715",
          "ref": "coord:inbox-wake:su-4cbae037-ba0b-40f0-b1a7-f0de0d684f6d",
          "kind": "event",
          "harness": "papercusp",
          "summary": "Await a live DRAIN leader decision on dedupe versus independent investigation; no decision arrived in the previous inbox-wake window.",
          "evidence": "The inbox read from the current live leader contained no item disposition. events:status shows await 386917 timed out and no active await remains. Leader presence is live, lastActiveSecAgo=15. Do not run another dedupe census before a ruling.",
          "nextVerb": "On coord:inbox-wake, read the live leader's reply and follow the disposition; on timeout, verify leader progress before re-arming.",
          "capability": "live-dependency"
        },
        "principal_kind": "system",
        "principal_auth_method": "bearer-token",
        "principal_trust": "trusted",
        "serving_host": "port-3070",
        "serving_process_id": "linux:294ff036-9724-4e55-a576-c94249eca929:9217182",
        "serving_build_sha": "d740fc3802"
      },
      {
        "item_id": "EI-26703088044163715",
        "entry_index": 0,
        "ref": "fleet:nonp2p-bug-drain-luna-max-0930 / leader su-ccd9e910-dfb2-471c-bf1c-7623b01f221e",
        "clearer": "su-4cbae037-ba0b-40f0-b1a7-f0de0d684f6d",
        "cleared_at": "2026-10-29 03:49:31.747+00",
        "invocation_id": "45854845",
        "tool_name": "work_items:set_blocker",
        "coord_owner_id": "su-4cbae037-ba0b-40f0-b1a7-f0de0d684f6d",
        "invoked_at": "2026-10-29 03:49:31.858+00",
        "duration_ms": 130,
        "status": "ok",
        "output_ref": null,
        "error_code": null,
        "args_json": {
          "id": "EI-26703088044163715",
          "ref": "fleet:nonp2p-bug-drain-luna-max-0930 / leader su-ccd9e910-dfb2-471c-bf1c-7623b01f221e",
          "kind": "human",
          "clear": true,
          "harness": "papercusp"
        },
        "principal_kind": "system",
        "principal_auth_method": "bearer-token",
        "principal_trust": "trusted",
        "serving_host": "port-3070",
        "serving_process_id": "linux:294ff036-9724-4e55-a576-c94249eca929:9090910",
        "serving_build_sha": "d740fc3802"
      },
      {
        "item_id": "EI-26758127048383986",
        "entry_index": 0,
        "ref": "fleet:nonp2p-bug-drain-luna-max-0930 / leader su-ccd9e910-dfb2-471c-bf1c-7623b01f221e",
        "clearer": "su-4cbae037-ba0b-40f0-b1a7-f0de0d684f6d",
        "cleared_at": "2026-10-29 03:49:34.066+00",
        "invocation_id": "45854634",
        "tool_name": "work_items:set_blocker",
        "coord_owner_id": "su-4cbae037-ba0b-40f0-b1a7-f0de0d684f6d",
        "invoked_at": "2026-10-29 03:48:54.355+00",
        "duration_ms": 216,
        "status": "ok",
        "output_ref": null,
        "error_code": null,
        "args_json": {
          "id": "EI-26758127048383986",
          "ref": "coord:inbox-wake:su-4cbae037-ba0b-40f0-b1a7-f0de0d684f6d",
          "kind": "event",
          "harness": "papercusp",
          "summary": "Await live DRAIN leader authority routing for the failed efb944… usage slot; no routing arrived in the previous inbox-wake window.",
          "evidence": "Existing checkpoint records 48/49, exit 1 after a candidate checkout path disappeared, and no adoption. The inbox read from the current live leader had no authority routing. events:status shows await 386917 timed out and no active await remains. Leader presence is live, lastActiveSecAgo=15. Do not inspect or start another census before a ruling.",
          "nextVerb": "On coord:inbox-wake, read the live leader's authority routing; on timeout, verify leader progress before re-arming.",
          "capability": "live-dependency"
        },
        "principal_kind": "system",
        "principal_auth_method": "bearer-token",
        "principal_trust": "trusted",
        "serving_host": "port-3070",
        "serving_process_id": "linux:294ff036-9724-4e55-a576-c94249eca929:8772584",
        "serving_build_sha": "d740fc3802"
      },
      {
        "item_id": "EI-26758127048383986",
        "entry_index": 0,
        "ref": "fleet:nonp2p-bug-drain-luna-max-0930 / leader su-ccd9e910-dfb2-471c-bf1c-7623b01f221e",
        "clearer": "su-4cbae037-ba0b-40f0-b1a7-f0de0d684f6d",
        "cleared_at": "2026-10-29 03:49:34.066+00",
        "invocation_id": "45854858",
        "tool_name": "work_items:set_blocker",
        "coord_owner_id": "su-4cbae037-ba0b-40f0-b1a7-f0de0d684f6d",
        "invoked_at": "2026-10-29 03:49:34.195+00",
        "duration_ms": 149,
        "status": "ok",
        "output_ref": null,
        "error_code": null,
        "args_json": {
          "id": "EI-26758127048383986",
          "ref": "fleet:nonp2p-bug-drain-luna-max-0930 / leader su-ccd9e910-dfb2-471c-bf1c-7623b01f221e",
          "kind": "human",
          "clear": true,
          "harness": "papercusp"
        },
        "principal_kind": "system",
        "principal_auth_method": "bearer-token",
        "principal_trust": "trusted",
        "serving_host": "port-3070",
        "serving_process_id": "linux:294ff036-9724-4e55-a576-c94249eca929:9478048",
        "serving_build_sha": "d740fc3802"
      },
      {
        "item_id": "EI-27548849688842649",
        "entry_index": 0,
        "ref": "consult:conv-request-0eb1a4b875fe2fa8100ff605adf71da7dbbb0510d0fd9e1de2e9cbe83d25e46d",
        "clearer": "su-ad6b428d-f738-4b3e-98be-bb51bc2762cd",
        "cleared_at": "2026-11-02 23:26:33.727+00",
        "invocation_id": "46673406",
        "tool_name": "work_items:set_blocker",
        "coord_owner_id": "su-ad6b428d-f738-4b3e-98be-bb51bc2762cd",
        "invoked_at": "2026-11-02 23:26:34.384+00",
        "duration_ms": 1144,
        "status": "ok",
        "output_ref": "papercusp://scratch/papercusp-workspace/work_items:set_blocker/20a39262-c8e8-4099-90fb-f13de1dc7457/result-door-1793661994387.md",
        "error_code": null,
        "args_json": {
          "id": "EI-27548849688842649",
          "ref": "consult:conv-request-0eb1a4b875fe2fa8100ff605adf71da7dbbb0510d0fd9e1de2e9cbe83d25e46d",
          "clear": true,
          "harness": "papercusp"
        },
        "principal_kind": "system",
        "principal_auth_method": "bearer-token",
        "principal_trust": "trusted",
        "serving_host": "port-3170",
        "serving_process_id": "linux:c58f787e-e441-4c5c-a0f5-40e3b362e124:7914833",
        "serving_build_sha": "86b9b6fbd4"
      },
      {
        "item_id": "EI-27548849688842649",
        "entry_index": 1,
        "ref": "fleet-leader-route-decision:nonp2p-bug-drain-luna-max-0930 / EI-27548849688842649",
        "clearer": "su-00ea7689-7fd3-426c-8f50-a59ba31770cd",
        "cleared_at": "2026-11-03 03:51:44.173+00",
        "invocation_id": "46781622",
        "tool_name": "work_items:set_blocker",
        "coord_owner_id": "su-00ea7689-7fd3-426c-8f50-a59ba31770cd",
        "invoked_at": "2026-11-03 03:50:20.842+00",
        "duration_ms": 214,
        "status": "ok",
        "output_ref": null,
        "error_code": null,
        "args_json": {
          "id": "EI-27548849688842649",
          "ref": "EI-27548849688842649",
          "kind": "product-decision",
          "harness": "papercusp",
          "summary": "Awaiting the fleet leader's recorded route decision before resuming this work-item.",
          "evidence": "Fresh work_items:get still says to read the leader's decision on the next reply/wake; the targeted leader inbox read returned only two messages about EI-276554 and no route decision for EI-275488.",
          "nextVerb": "coord:inbox",
          "capability": "product-decision"
        },
        "principal_kind": "system",
        "principal_auth_method": "bearer-token",
        "principal_trust": "trusted",
        "serving_host": "port-3070",
        "serving_process_id": "linux:c58f787e-e441-4c5c-a0f5-40e3b362e124:9673081",
        "serving_build_sha": "d740fc3802"
      },
      {
        "item_id": "EI-27548849688842649",
        "entry_index": 1,
        "ref": "fleet-leader-route-decision:nonp2p-bug-drain-luna-max-0930 / EI-27548849688842649",
        "clearer": "su-00ea7689-7fd3-426c-8f50-a59ba31770cd",
        "cleared_at": "2026-11-03 03:51:44.173+00",
        "invocation_id": "46781827",
        "tool_name": "work_items:set_blocker",
        "coord_owner_id": "su-00ea7689-7fd3-426c-8f50-a59ba31770cd",
        "invoked_at": "2026-11-03 03:50:47.577+00",
        "duration_ms": 1661,
        "status": "ok",
        "output_ref": null,
        "error_code": null,
        "args_json": {
          "id": "EI-27548849688842649",
          "ref": "fleet-leader-route-decision:nonp2p-bug-drain-luna-max-0930 / EI-27548849688842649",
          "kind": "product-decision",
          "harness": "papercusp",
          "summary": "Await the fleet leader's recorded route decision before resuming this work-item.",
          "evidence": "Fresh work_items:get still says to read the leader's decision on the next reply/wake; the targeted leader inbox read returned only two messages about EI-276554 and no route decision for EI-275488.",
          "nextVerb": "coord:inbox",
          "capability": "product-decision"
        },
        "principal_kind": "system",
        "principal_auth_method": "bearer-token",
        "principal_trust": "trusted",
        "serving_host": "port-3070",
        "serving_process_id": "linux:c58f787e-e441-4c5c-a0f5-40e3b362e124:9636662",
        "serving_build_sha": "d740fc3802"
      },
      {
        "item_id": "EI-27548849688842649",
        "entry_index": 1,
        "ref": "fleet-leader-route-decision:nonp2p-bug-drain-luna-max-0930 / EI-27548849688842649",
        "clearer": "su-00ea7689-7fd3-426c-8f50-a59ba31770cd",
        "cleared_at": "2026-11-03 03:51:44.173+00",
        "invocation_id": "46782179",
        "tool_name": "work_items:set_blocker",
        "coord_owner_id": "su-00ea7689-7fd3-426c-8f50-a59ba31770cd",
        "invoked_at": "2026-11-03 03:51:44.339+00",
        "duration_ms": 1154,
        "status": "ok",
        "output_ref": null,
        "error_code": null,
        "args_json": {
          "id": "EI-27548849688842649",
          "ref": "fleet-leader-route-decision:nonp2p-bug-drain-luna-max-0930 / EI-27548849688842649",
          "clear": true,
          "harness": "papercusp"
        },
        "principal_kind": "system",
        "principal_auth_method": "bearer-token",
        "principal_trust": "trusted",
        "serving_host": "port-3070",
        "serving_process_id": "linux:c58f787e-e441-4c5c-a0f5-40e3b362e124:9418302",
        "serving_build_sha": "d740fc3802"
      },
      {
        "item_id": "EI-27707885265505216",
        "entry_index": 0,
        "ref": "node-to-bun-staged-migration-2026-10-22#D-018",
        "clearer": "su-6d787f0e-d99b-4e1b-b571-d6cfc0b2870a",
        "cleared_at": "2026-11-06 03:22:43.141+00",
        "invocation_id": "47181390",
        "tool_name": "work_items:set_blocker",
        "coord_owner_id": "su-6d787f0e-d99b-4e1b-b571-d6cfc0b2870a",
        "invoked_at": "2026-11-06 03:21:39.137+00",
        "duration_ms": 300,
        "status": "ok",
        "output_ref": null,
        "error_code": null,
        "args_json": {
          "id": "EI-27707885265505216",
          "ref": "node-to-bun-staged-migration-2026-10-22#D-018",
          "kind": "product-decision",
          "harness": "papercusp",
          "summary": "P-006's held Windows diagnostic must remain paused under D-018 until the post-safety helper-pin/command review and current activation audit are recorded.",
          "evidence": "plans:get D-018 at version 53 says no named-input diagnostic until the maintained safety fix, a distinct exact helper-pin/command review, and current activation audit. EI-27998982037137151 is done, but WI-6554700010022072 remains open; its latest checkpoint says settlement/authority then the separate review/audit are still next. P-006 is actively held by su-0dcd3.",
          "nextVerb": "Re-read D-018 and WI-6554700010022072; resume only after the separate review and current activation audit are recorded or D-018 is superseded.",
          "capability": "product-decision"
        },
        "principal_kind": "system",
        "principal_auth_method": "bearer-token",
        "principal_trust": "trusted",
        "serving_host": "port-3070",
        "serving_process_id": "linux:c58f787e-e441-4c5c-a0f5-40e3b362e124:35126254",
        "serving_build_sha": "d740fc3802"
      },
      {
        "item_id": "EI-27707885265505216",
        "entry_index": 0,
        "ref": "node-to-bun-staged-migration-2026-10-22#D-018",
        "clearer": "su-6d787f0e-d99b-4e1b-b571-d6cfc0b2870a",
        "cleared_at": "2026-11-06 03:22:43.141+00",
        "invocation_id": "47181893",
        "tool_name": "work_items:set_blocker",
        "coord_owner_id": "su-6d787f0e-d99b-4e1b-b571-d6cfc0b2870a",
        "invoked_at": "2026-11-06 03:22:43.21+00",
        "duration_ms": 142,
        "status": "ok",
        "output_ref": null,
        "error_code": null,
        "args_json": {
          "id": "EI-27707885265505216",
          "clear": true,
          "harness": "papercusp"
        },
        "principal_kind": "system",
        "principal_auth_method": "bearer-token",
        "principal_trust": "trusted",
        "serving_host": "port-3070",
        "serving_process_id": "linux:c58f787e-e441-4c5c-a0f5-40e3b362e124:34826597",
        "serving_build_sha": "d740fc3802"
      }
    ],
    "positiveControl": {
      "rows": [
        {
          "id": "47432105"
        }
      ],
      "rowCount": 1,
      "truncated": false,
      "fields": [
        "id"
      ],
      "status": "passed"
    },
    "_meta": {
      "explicitFullRequest": true,
      "format": "json",
      "_seeAlso": [
        {
          "tool": "work_items:claimable"
        },
        {
          "tool": "plans:list"
        },
        {
          "tool": "db:migrations"
        },
        {
          "tool": "testing:runs"
        },
        {
          "tool": "issues:list / work_items:get"
        },
        {
          "tool": "dev:pg_active_queries"
        },
        {
          "tool": "dev:pg_table_sizes"
        },
        {
          "tool": "dev:pg_health"
        }
      ]
    }
  },
  "assessments": [
    {
      "item_id": "EI-25398054129696034",
      "entry_index": 0,
      "ref": "conv-mv6ifdq6-0000-b827b04e02234c6ebb380e4e6f9d38c8",
      "clearer": "su-82592767-2742-45b8-b053-4b096877bacc",
      "cleared_at": "2026-10-13T17:10:36.045Z",
      "boundedCandidateCount": 0,
      "exactClearInvocationIds": [],
      "successfulExactClearInvocationIds": [],
      "interpretation": "No exact clear invocation in this bounded instrument; not absence of historical action."
    },
    {
      "item_id": "EI-25938663476959671",
      "entry_index": 0,
      "ref": "coord-send-405d2e3114435f67b8f527871c59c51b0cdb2320c17d08a3822449b99bcb3f3f",
      "clearer": "su-54ccf487-3fe5-472a-acc6-bb5a2b7f891b",
      "cleared_at": "2026-10-15T21:37:23.200Z",
      "boundedCandidateCount": 3,
      "exactClearInvocationIds": [],
      "successfulExactClearInvocationIds": [],
      "interpretation": "No exact clear invocation in this bounded instrument; not absence of historical action."
    },
    {
      "item_id": "EI-25996144041259055",
      "entry_index": 0,
      "ref": "@fleet-leader:nonp2p-bug-drain-luna-max-0930",
      "clearer": "su-0b720d29-b37b-4f10-a2cc-12f979360c85",
      "cleared_at": "2026-10-27T07:50:06.205Z",
      "boundedCandidateCount": 4,
      "exactClearInvocationIds": [
        "45144713"
      ],
      "successfulExactClearInvocationIds": [
        "45144713"
      ],
      "interpretation": "Exact recorded clear invocation found; caller trust is separate from subject-condition satisfaction and substantive execution."
    },
    {
      "item_id": "EI-26050120829344230",
      "entry_index": 0,
      "ref": "historical-mcp-proxy-traces",
      "clearer": "su-11763d34-9b61-452f-b6c5-c924800a95ea",
      "cleared_at": "2026-10-16T13:28:35.516Z",
      "boundedCandidateCount": 2,
      "exactClearInvocationIds": [
        "39614464"
      ],
      "successfulExactClearInvocationIds": [
        "39614464"
      ],
      "interpretation": "Exact recorded clear invocation found; caller trust is separate from subject-condition satisfaction and substantive execution."
    },
    {
      "item_id": "EI-26217185985299604",
      "entry_index": 1,
      "ref": "coord-send-f3eb8aa7a3530b84d3966af0e6e438366de618a5e84f29877600568b24a96707",
      "clearer": "su-55595f20-e777-401b-92a3-3f06394a9541",
      "cleared_at": "2026-10-27T16:29:30.536Z",
      "boundedCandidateCount": 3,
      "exactClearInvocationIds": [],
      "successfulExactClearInvocationIds": [],
      "interpretation": "No exact clear invocation in this bounded instrument; not absence of historical action."
    },
    {
      "item_id": "EI-26703088044163715",
      "entry_index": 0,
      "ref": "fleet:nonp2p-bug-drain-luna-max-0930 / leader su-ccd9e910-dfb2-471c-bf1c-7623b01f221e",
      "clearer": "su-4cbae037-ba0b-40f0-b1a7-f0de0d684f6d",
      "cleared_at": "2026-10-29T03:49:31.747Z",
      "boundedCandidateCount": 2,
      "exactClearInvocationIds": [
        "45854845"
      ],
      "successfulExactClearInvocationIds": [
        "45854845"
      ],
      "interpretation": "Exact recorded clear invocation found; caller trust is separate from subject-condition satisfaction and substantive execution."
    },
    {
      "item_id": "EI-26758127048383986",
      "entry_index": 0,
      "ref": "fleet:nonp2p-bug-drain-luna-max-0930 / leader su-ccd9e910-dfb2-471c-bf1c-7623b01f221e",
      "clearer": "su-4cbae037-ba0b-40f0-b1a7-f0de0d684f6d",
      "cleared_at": "2026-10-29T03:49:34.066Z",
      "boundedCandidateCount": 2,
      "exactClearInvocationIds": [
        "45854858"
      ],
      "successfulExactClearInvocationIds": [
        "45854858"
      ],
      "interpretation": "Exact recorded clear invocation found; caller trust is separate from subject-condition satisfaction and substantive execution."
    },
    {
      "item_id": "EI-27548849688842649",
      "entry_index": 0,
      "ref": "consult:conv-request-0eb1a4b875fe2fa8100ff605adf71da7dbbb0510d0fd9e1de2e9cbe83d25e46d",
      "clearer": "su-ad6b428d-f738-4b3e-98be-bb51bc2762cd",
      "cleared_at": "2026-11-02T23:26:33.727Z",
      "boundedCandidateCount": 1,
      "exactClearInvocationIds": [
        "46673406"
      ],
      "successfulExactClearInvocationIds": [
        "46673406"
      ],
      "interpretation": "Exact recorded clear invocation found; caller trust is separate from subject-condition satisfaction and substantive execution."
    },
    {
      "item_id": "EI-27548849688842649",
      "entry_index": 1,
      "ref": "fleet-leader-route-decision:nonp2p-bug-drain-luna-max-0930 / EI-27548849688842649",
      "clearer": "su-00ea7689-7fd3-426c-8f50-a59ba31770cd",
      "cleared_at": "2026-11-03T03:51:44.173Z",
      "boundedCandidateCount": 3,
      "exactClearInvocationIds": [
        "46782179"
      ],
      "successfulExactClearInvocationIds": [
        "46782179"
      ],
      "interpretation": "Exact recorded clear invocation found; caller trust is separate from subject-condition satisfaction and substantive execution."
    },
    {
      "item_id": "EI-27707885265505216",
      "entry_index": 0,
      "ref": "node-to-bun-staged-migration-2026-10-22#D-018",
      "clearer": "su-6d787f0e-d99b-4e1b-b571-d6cfc0b2870a",
      "cleared_at": "2026-11-06T03:22:43.141Z",
      "boundedCandidateCount": 2,
      "exactClearInvocationIds": [],
      "successfulExactClearInvocationIds": [],
      "interpretation": "No exact clear invocation in this bounded instrument; not absence of historical action."
    }
  ],
  "limits": [
    "Current or historical capability truth is not established by a recorded clear.",
    "System/bearer trust does not prove an owner decision or authority to override a restrictive ruling.",
    "Eight original subjects retain separate nonhuman conditions; all independent floors stay intact.",
    "Missing MCP rows do not prove absence of native actions.",
    "No source edit, test rerun, subject claim, blocker clear, replay, live-gate operation or peer monitoring.",
    "Full original R1 and full eight-requirement task remain open."
  ]
}
