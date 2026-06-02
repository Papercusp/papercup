"use strict";
/**
 * `papercusp://hindsight/banks` — list Hindsight memory banks the
 * workspace's company has access to.
 *
 * Bank IDs follow `paperclip::<companyId>` per the workspace registry.
 * If the workspace has no `companyId`, returns degraded with no banks.
 * Same auth model as the `hindsight:recall` tool.
 */
Object.defineProperty(exports, "__esModule", { value: true });
const node_path_1 = require("node:path");
const host_platform_1 = require("@papercusp/host-platform");
const tooldef_1 = require("@papercusp/tooldef");
function resolveCompanyId(workspaceId) {
    const platform = (0, host_platform_1.getHostPlatform)();
    const path = (0, node_path_1.join)(platform.homedir(), '.papercusp-workspaces', 'registry.json');
    const raw = platform.readTextFileSync(path);
    if (raw === null)
        return null;
    try {
        const reg = JSON.parse(raw);
        return reg.workspaces.find((w) => w.id === workspaceId)?.companyId ?? null;
    }
    catch {
        return null;
    }
}
exports.default = (0, tooldef_1.defineResource)({
    name: 'hindsight:banks',
    uri: 'papercusp://hindsight/banks',
    capability: 'hindsight:read',
    mimeType: 'application/json',
    description: 'Hindsight memory banks the current workspace can recall from. Bank IDs are auth-derived.',
    async read(uri, ctx) {
        const companyId = resolveCompanyId(ctx.principal.workspaceId);
        if (!companyId) {
            return {
                uri,
                mimeType: 'application/json',
                text: JSON.stringify({
                    banks: [],
                    degraded: true,
                    degradedReason: 'Workspace has no companyId in registry.json — Hindsight access not configured.',
                }, null, 2),
            };
        }
        return {
            uri,
            mimeType: 'application/json',
            text: JSON.stringify({
                banks: [
                    {
                        id: `paperclip::${companyId}`,
                        kind: 'paperclip',
                        companyId,
                    },
                ],
            }, null, 2),
        };
    },
});
