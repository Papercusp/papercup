---
rel_path: "runtime-migration/p006-e1ff5523-runtime-confinement-preconditions-0dcd3-20261106.json"
updated_at: 1793963568873
_body: "content"
---

{
  "schemaVersion": "bun-source-only-runtime-preconditions-v1",
  "createdAt": "2026-11-06T11:12:00Z",
  "ownerId": "su-0dcd3a3c-a45f-482b-a8cd-e957407353f9",
  "workItem": "WI-6554700010022072",
  "proposal": "runtime-migration/p006-distinct-e1ff5523-source-only-proposal-0dcd3-20261106.json",
  "actualRoute": "http://127.0.0.1:3170",
  "servingGeneration": "serving-generation-v1:67aa5cbba4d1e24b40f165cde020bfedf2b387027c44e4fe272129fa4c67a074",
  "publishedContract": {
    "tool": "capability:bash",
    "require_task_confinement": true,
    "description": "Require managed task enrollment and cgroup confinement before fork. Refuse without starting the command if unavailable; timeout still bounds the whole task."
  },
  "containment": [
    {
      "path": "packages/operator-core/lib/agent-tools/capability/bash.ts",
      "runtime": "staging-operator",
      "buildSha": "b96618c020",
      "containsChange": true,
      "method": "blob"
    },
    {
      "path": "packages/operator-core/lib/agent-tools/capability/bash-jobs.ts",
      "runtime": "staging-operator",
      "buildSha": "b96618c020",
      "containsChange": true,
      "method": "blob"
    }
  ],
  "route": {
    "id": "operator-api",
    "readiness": "ready",
    "isolation": "Separate port/process/checkout; database and workspace not isolated",
    "prerequisites": [
      "Containing staging commit loaded",
      "Private test identity/data for writes"
    ],
    "verification": "Measured :3170 build identity plus request/response on that build"
  },
  "sourceGuard": "bash.ts passes requireTaskConfinement to startBackground. bash-jobs.ts begins synchronous enrollment and throws BashTaskConfinementRequiredError before fork unless enrolled,confined,scopeUnit are positive. RuntimeMaxSec is derived from the full execution timeout.",
  "limits": "Read-only schema/pipeline/source evidence. No native candidate or source command launched. Published contract and blob containment do not prove actual task enrollment, post-deadline cleanup, candidate integrity or acceptance. Require launch receipt and terminal cleanup for the reviewed scope.",
  "liveGateOps": "none"
}

