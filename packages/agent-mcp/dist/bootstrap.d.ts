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
import './tools/goals/list';
import './tools/goals/get';
import './tools/issues/list';
import './tools/messages/inbox';
import './tools/messages/outbox';
import './tools/audit/list';
import './tools/pending_events/list';
import './tools/hindsight/recall';
import './tools/search/query';
import './tools/messages/send';
import './tools/tasks/create';
import './tools/tasks/update';
import './tools/tasks/close';
