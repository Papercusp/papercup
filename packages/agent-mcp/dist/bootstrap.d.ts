/**
 * Tool auto-loader. Importing this module side-effect-imports every
 * `tools/<group>/<verb>.ts`, causing each to call `defineTool` and
 * register itself in the catalog.
 *
 * Add a tool by dropping a file under `tools/<group>/<verb>.ts`. The
 * registry will pick it up at startup; no manual list to maintain.
 */
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
import './tools/messages/inbox';
import './tools/messages/outbox';
import './tools/audit/list';
import './tools/intel/spawn_tree';
import './tools/intel/artifacts';
import './tools/papercusp/list_workspaces';
import './tools/pending_events/list';
import './tools/search/query';
import './tools/artifacts/load';
import './tools/artifacts/save';
import './tools/artifacts/append';
import './tools/artifacts/delete';
import './tools/dev/hello-card';
import './resources/harness/list';
import './resources/harness/issues';
import './resources/goals/list';
import './resources/audit/recent';
import './prompts/agent/role';
import './prompts/operator/scanner';
import './prompts/dispatch/framing';
