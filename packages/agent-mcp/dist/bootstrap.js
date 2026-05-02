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
require("./tools/goals/list");
require("./tools/goals/get");
require("./tools/issues/list");
require("./tools/messages/inbox");
require("./tools/messages/outbox");
require("./tools/audit/list");
require("./tools/pending_events/list");
require("./tools/hindsight/recall");
require("./tools/search/query");
// Write tools — Operator-only by capability
require("./tools/messages/send");
require("./tools/tasks/create");
require("./tools/tasks/update");
require("./tools/tasks/close");
