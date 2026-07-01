"use strict";
/**
 * Tool auto-loader. Importing this module side-effect-imports every
 * `tools/<group>/<verb>.ts`, causing each to call `defineTool` and
 * register itself in the catalog.
 *
 * Add a tool by dropping a file under `tools/<group>/<verb>.ts`. The
 * registry will pick it up at startup; no manual list to maintain.
 */
Object.defineProperty(exports, "__esModule", { value: true });
// Read tools — workspace state surface
require("./tools/harness/list");
require("./tools/harness/get");
require("./tools/harness/status");
require("./tools/tasks/list");
require("./tools/tasks/get");
require("./tools/features/get");
require("./tools/features/history");
require("./tools/features/search");
require("./tools/features/list_related");
require("./tools/features/tag_vocabulary");
require("./tools/goals/list");
require("./tools/goals/get");
// issues:* fully RETIRED onto the unified work_items:* surface (coordination-unification-
// 2026-06-23 P-015 / D-011). The engineer-issues STORE persists; work_items:* dispatches to it.
require("./tools/messages/inbox");
require("./tools/messages/outbox");
require("./tools/audit/list");
require("./tools/intel/spawn_tree");
require("./tools/intel/artifacts");
require("./tools/papercusp/list_workspaces");
require("./tools/pending_events/list");
require("./tools/search/query");
// Artifacts — PG-canonical text store, role-gated (D1a)
require("./tools/artifacts/load");
require("./tools/artifacts/save");
require("./tools/artifacts/append");
require("./tools/artifacts/delete");
// Write tools formerly here (tasks:create, messages:send, messages:dismiss)
// moved to apps/operator/lib/agent-tools/{tasks,messages}/ after the
// function-as-truth audit: they call executeAction() in-process now
// instead of HTTP-roundtripping /api/admin/execute-action, which required an
// operator-side import the package can't make. tasks:update + tasks:close were
// removed — they referenced a non-existent 'update_feature' op and never worked.
// The dev:hello-card mcp-ui fixture and the dead hindsight:recall tool
// (deprecated 2026-05-09, degraded-empty ever since, zero callers) were
// REMOVED from the catalog — audit P-047. Bring a real mcp-ui tool when
// one lands; the registration shape is one defineTool import here.
// Resources — read-only browsable URIs (Phase A: agent-mcp resources)
require("./resources/harness/list");
require("./resources/harness/issues");
require("./resources/goals/list");
require("./resources/audit/recent");
// Prompts — discoverable templates (Phase B: agent-mcp prompts)
require("./prompts/agent/role");
require("./prompts/operator/scanner");
require("./prompts/dispatch/framing");
