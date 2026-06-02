"use strict";
/**
 * `papercusp://workspace/harnesses` — workspace-scoped harness inventory.
 *
 * Concrete (non-templated) resource. Same data as the `harness:list`
 * tool; exposed as a resource so agents can browse and cache without
 * a tool call.
 */
Object.defineProperty(exports, "__esModule", { value: true });
const tooldef_1 = require("@papercusp/tooldef");
exports.default = (0, tooldef_1.defineResource)({
    name: 'harness:list',
    uri: 'papercusp://workspace/harnesses',
    capability: 'harness:read',
    mimeType: 'application/json',
    description: 'List of harnesses in the current workspace: slug, name, status, last-activity timestamp.',
    async read(uri, ctx) {
        const rows = await ctx.tx `
      SELECT slug, name, status, updated_ts
        FROM harness_shared.projects
       ORDER BY updated_ts DESC
    `;
        return {
            uri,
            mimeType: 'application/json',
            text: JSON.stringify({ harnesses: rows }, null, 2),
        };
    },
});
