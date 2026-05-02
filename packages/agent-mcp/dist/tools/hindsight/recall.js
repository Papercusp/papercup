"use strict";
/**
 * Recall memories from the workspace's Hindsight bank.
 *
 * Bank ID is auth-derived: workspace registry's `companyId` field
 * resolves to `paperclip::<companyId>`. Body-supplied scope is rejected.
 * If the workspace has no `companyId`, returns degraded with empty
 * results — does not throw.
 */
Object.defineProperty(exports, "__esModule", { value: true });
const zod_1 = require("zod");
const node_fs_1 = require("node:fs");
const node_os_1 = require("node:os");
const node_path_1 = require("node:path");
const define_tool_1 = require("../../define-tool");
function resolveCompanyId(workspaceId) {
    const path = (0, node_path_1.join)((0, node_os_1.homedir)(), '.papercusp-workspaces', 'registry.json');
    if (!(0, node_fs_1.existsSync)(path))
        return null;
    try {
        const reg = JSON.parse((0, node_fs_1.readFileSync)(path, 'utf8'));
        const ws = reg.workspaces.find((w) => w.id === workspaceId);
        return ws?.companyId ?? null;
    }
    catch {
        return null;
    }
}
exports.default = (0, define_tool_1.defineTool)({
    capability: 'hindsight:recall',
    args: zod_1.z.object({
        query: zod_1.z.string().min(1),
        limit: zod_1.z.number().int().positive().max(50).default(10),
    }),
    async handler(args, ctx) {
        const companyId = resolveCompanyId(ctx.principal.workspaceId);
        if (!companyId) {
            return {
                data: [],
                degraded: true,
                degradedReasons: ['hindsight_not_configured_for_workspace'],
            };
        }
        const bank = `paperclip::${companyId}`;
        // Hindsight client invocation. v1 wires through an HTTP shim if the
        // hindsight MCP isn't directly callable in-process; for now we
        // return a degraded placeholder describing the resolved bank so
        // pi/Operator can at least see what would be queried.
        return {
            data: [],
            degraded: true,
            degradedReasons: [
                `hindsight client not wired in v1; would query bank=${bank} query=${JSON.stringify(args.query)}`,
            ],
        };
    },
});
