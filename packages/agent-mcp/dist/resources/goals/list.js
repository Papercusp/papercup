"use strict";
/**
 * `papercusp://workspace/goals` — workspace goal inventory.
 *
 * Concrete resource mirroring the `goals:list` tool's full-detail
 * output.
 */
Object.defineProperty(exports, "__esModule", { value: true });
const tooldef_1 = require("@papercusp/tooldef");
exports.default = (0, tooldef_1.defineResource)({
    name: 'goals:list',
    uri: 'papercusp://workspace/goals',
    capability: 'goals:read',
    mimeType: 'application/json',
    description: 'Workspace goal hierarchy: id, title, body, parent_id, budget_cents, created_at.',
    async read(uri, ctx) {
        const rows = await ctx.tx `
      SELECT id, title, body, parent_id, budget_cents, created_at
        FROM harness_shared.goals
       ORDER BY created_at DESC
       LIMIT 500
    `;
        return {
            uri,
            mimeType: 'application/json',
            text: JSON.stringify({ goals: rows }, null, 2),
        };
    },
});
