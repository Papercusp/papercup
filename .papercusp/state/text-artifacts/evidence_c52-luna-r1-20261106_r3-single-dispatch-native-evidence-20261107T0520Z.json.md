---
rel_path: "evidence/c52-luna-r1-20261106/r3-single-dispatch-native-evidence-20261107T0520Z.json"
updated_at: 1794028094401
_body: "content"
---

{
  "schemaVersion": "c52-dispatch-native-receipt-v1",
  "parent": "WI-6554700010045700",
  "invocationId": 46114374,
  "sql": "WITH calls AS MATERIALIZED (SELECT source_kind,session_id,part_idx FROM harness_shared.session_turn_parts WHERE workspace_id='default' AND owner='su-c90e0cc0-2484-422b-a44b-807c89e0ecde' AND part_kind='tool_use' AND ts>='2026-11-01T10:20:45Z'::timestamptz AND ts<'2026-11-01T10:21:05Z'::timestamptz) SELECT p.source_kind,p.session_id,p.part_idx,p.ts,p.owner,p.part_kind,p.tool_name,p.text FROM calls c JOIN harness_shared.session_turn_parts p ON p.workspace_id='default' AND p.source_kind=c.source_kind AND p.session_id=c.session_id AND p.part_idx BETWEEN c.part_idx AND c.part_idx+1 ORDER BY p.session_id,p.part_idx",
  "data": {
    "mode": "query",
    "rowCount": 2,
    "truncated": false,
    "fields": [
      "source_kind",
      "session_id",
      "part_idx",
      "ts",
      "owner",
      "part_kind",
      "tool_name",
      "text"
    ],
    "elapsedMs": 41,
    "rows": [
      {
        "source_kind": "codex",
        "session_id": "01a19678-ce31-79d3-8434-b683c9fa6765",
        "part_idx": 154,
        "ts": "2026-11-01 10:20:48.176+00",
        "owner": "su-c90e0cc0-2484-422b-a44b-807c89e0ecde",
        "part_kind": "tool_use",
        "tool_name": "exec",
        "text": "const r=await tools.mcp__papercusp_su__tools_invoke({name:\"coord:dispatch\",args:{\n to:\"su-e94e8cd2-206f-4334-baff-cf3fdfe94916\",\n note:\"Leader disposition: re-review requested for existing EI-27014700586023530 admission hold. Keep source edits read-only until the durable promoter returns a matching receipt, then continue on the same claim.\",\n workItemIds:[\"EI-27014700586023530\"],\n harness:\"papercusp\",\n resumeAdmission:true\n},build:\"staging\"});\ntext(r.content?.find(x=>x.type===\"text\")?.text??JSON.stringify(r));\n"
      },
      {
        "source_kind": "codex",
        "session_id": "01a19678-ce31-79d3-8434-b683c9fa6765",
        "part_idx": 155,
        "ts": "2026-11-01 10:20:48.815+00",
        "owner": "su-c90e0cc0-2484-422b-a44b-807c89e0ecde",
        "part_kind": "tool_result",
        "tool_name": null,
        "text": "Script completed\nWall time 0.6 seconds\nOutput:\n\n{\"ok\":true,\"workItemId\":\"EI-27014700586023530\",\"request\":{\"version\":3,\"requestId\":\"8f9efb93-00f4-475d-a544-2fa691606939\",\"caller\":\"su-c90e0cc0-2484-422b-a44b-807c89e0ecde\",\"target\":\"su-e94e8cd2-206f-4334-baff-cf3fdfe94916\",\"routineId\":\"rt_papercusp_work_item_admission_promoter\",\"signature\":\"38e4f57ced8f0583924272eaeeb058f055cdd6a59f586c4be3b73934654bc55d\",\"state\":\"queued\",\"requestedAt\":\"2026-11-01T10:20:48.573Z\",\"updatedAt\":\"2026-11-01T10:20:48.573Z\",\"stage\":\"queued\",\"pickupConfirmed\":false,\"note\":\"Leader disposition: re-review requested for existing EI-27014700586023530 admission hold. Keep source edits read-only until the durable promoter returns a matching receipt, then continue on the same claim.\",\"authority\":{\"kind\":\"superuser\",\"credentialSha256\":\"617161bfe56568790b72c2c7b33c0e98d2a43a1a08c3cc82f079fc14c72c9bb1\",\"role\":\"operator\",\"context\":{\"workspaceId\":\"papercusp-workspace\",\"harnessSlug\":\"papercusp\",\"profile\":\"engineer\",\"runId\":\"2e47afeb-8f4f-4ec0-b67c-9f9fa71c4d84\",\"spawnId\":\"ephemeral-6f228e49da907ddb\",\"parentSpawnId\":null,\"chunkId\":null,\"featureId\":null,\"planRunSessionId\":null,\"transport\":\"mcp\",\"advSessionId\":54398}}},\"inProgress\":false}"
      }
    ]
  }
}
