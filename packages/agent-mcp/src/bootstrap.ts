/**
 * Tool auto-loader. Importing this module side-effect-imports every
 * `tools/<group>/<verb>.ts`, causing each to call `defineTool` and
 * register itself in the catalog.
 *
 * Add a tool by dropping a file under `tools/<group>/<verb>.ts`. The
 * registry will pick it up at startup; no manual list to maintain.
 */

// Read tools — workspace state surface
import './tools/harness/list';
import './tools/harness/get';
import './tools/harness/status';
import './tools/tasks/list';
import './tools/tasks/get';
import './tools/features/get';
import './tools/features/history';
import './tools/features/search';
import './tools/features/list_related';
import './tools/features/tag_vocabulary';
import './tools/goals/list';
import './tools/goals/get';
// issues:* redefined operator-side (apps/operator/lib/agent-tools/issues/*) —
// engineer-issues-2026-06-03 D-003. The per-harness stub here was retired.
import './tools/messages/inbox';
import './tools/messages/outbox';
import './tools/audit/list';
import './tools/intel/spawn_tree';
import './tools/intel/artifacts';
import './tools/papercusp/list_workspaces';
import './tools/pending_events/list';

import './tools/search/query';

// Artifacts — PG-canonical text store, role-gated (D1a)
import './tools/artifacts/load';
import './tools/artifacts/save';
import './tools/artifacts/append';
import './tools/artifacts/delete';

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
import './resources/harness/list';
import './resources/harness/issues';
import './resources/goals/list';
import './resources/audit/recent';

// Prompts — discoverable templates (Phase B: agent-mcp prompts)
import './prompts/agent/role';
import './prompts/operator/scanner';
import './prompts/dispatch/framing';
