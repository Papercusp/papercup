"use strict";
/**
 * @papercusp/agent-mcp public surface.
 *
 * This package provides:
 *   - `defineTool({ ... })` for declaring MCP tools that self-register.
 *   - `dispatch({ toolName, args, bearer })` for in-process callers
 *     (Operator/Oracle) to invoke tools without an MCP transport.
 *   - `startServer()` for stdio MCP transport (out-of-process consumers
 *     like pi sessions).
 *
 * Tools live under `src/tools/<group>/<verb>.ts`. Importing `bootstrap`
 * (or running `startServer`) imports them all and populates the catalog.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.tierFor = exports.resolveBearer = exports.lookup = exports.getCatalog = exports.startServer = exports.dispatch = exports.defineTool = void 0;
var define_tool_1 = require("./define-tool");
Object.defineProperty(exports, "defineTool", { enumerable: true, get: function () { return define_tool_1.defineTool; } });
var server_1 = require("./server");
Object.defineProperty(exports, "dispatch", { enumerable: true, get: function () { return server_1.dispatch; } });
Object.defineProperty(exports, "startServer", { enumerable: true, get: function () { return server_1.startServer; } });
var registry_1 = require("./registry");
Object.defineProperty(exports, "getCatalog", { enumerable: true, get: function () { return registry_1.getCatalog; } });
Object.defineProperty(exports, "lookup", { enumerable: true, get: function () { return registry_1.lookup; } });
var auth_1 = require("./auth");
Object.defineProperty(exports, "resolveBearer", { enumerable: true, get: function () { return auth_1.resolveBearer; } });
var capability_tiers_1 = require("./capability-tiers");
Object.defineProperty(exports, "tierFor", { enumerable: true, get: function () { return capability_tiers_1.tierFor; } });
require("./bootstrap");
