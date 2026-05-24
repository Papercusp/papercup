"use strict";
/**
 * Provisioning for system:<name> principals.
 *
 * Creates a fresh bearer, writes it to the three required places per
 * spec/system-and-pi-principals:
 *   1. <papercuspRoot>/system/<name>/config.json (mode 0600)
 *   2. harness_shared.system_principals (workspace_id, name, bearer_hash, capabilities)
 *   3. harness_shared.token_index (token, kind='system', slug='system:<name>', workspace_id)
 *
 * Idempotent per (workspace, name): re-running with the same name skips
 * if a row already exists (use `force: true` to rotate the bearer).
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.provisionSystemPrincipal = provisionSystemPrincipal;
exports.startPiSession = startPiSession;
exports.endPiSession = endPiSession;
const node_crypto_1 = require("node:crypto");
const node_fs_1 = require("node:fs");
const node_path_1 = require("node:path");
const db_org_1 = require("@restart/db-org");
function genBearer() {
    return (0, node_crypto_1.randomBytes)(32).toString('base64url');
}
function hash(s) {
    return (0, node_crypto_1.createHash)('sha256').update(s).digest('hex');
}
async function provisionSystemPrincipal(args) {
    const { workspaceId, name, capabilities, papercuspRoot, force } = args;
    const configPath = `${papercuspRoot}/system/${name}/config.json`;
    return (0, db_org_1.withWorkspace)(workspaceId, async (tx) => {
        const existing = await tx `
      SELECT bearer_hash
        FROM harness_shared.system_principals
       WHERE workspace_id = ${workspaceId} AND name = ${name}
       LIMIT 1
    `;
        if (existing.length > 0 && !force) {
            // Already provisioned. Caller should read the bearer from disk if
            // they need it; we don't return it.
            return null;
        }
        const bearer = genBearer();
        const bearerHash = hash(bearer);
        if (existing.length > 0) {
            // Rotate.
            await tx `
        UPDATE harness_shared.system_principals
           SET bearer_hash = ${bearerHash},
               capabilities = ${JSON.stringify(capabilities)}::jsonb
         WHERE workspace_id = ${workspaceId} AND name = ${name}
      `;
            await tx `
        DELETE FROM harness_shared.token_index
         WHERE kind = 'system'
           AND slug = ${`system:${name}`}
           AND workspace_id = ${workspaceId}
      `;
        }
        else {
            await tx `
        INSERT INTO harness_shared.system_principals (workspace_id, name, bearer_hash, capabilities)
        VALUES (${workspaceId}, ${name}, ${bearerHash}, ${JSON.stringify(capabilities)}::jsonb)
      `;
        }
        await tx `
      INSERT INTO harness_shared.token_index (token, kind, slug, workspace_id)
      VALUES (${bearer}, 'system', ${`system:${name}`}, ${workspaceId})
      ON CONFLICT (token) DO UPDATE
        SET kind = 'system', slug = ${`system:${name}`}, workspace_id = ${workspaceId}
    `;
        // Persist config file mode 0600.
        (0, node_fs_1.mkdirSync)((0, node_path_1.dirname)(configPath), { recursive: true });
        (0, node_fs_1.writeFileSync)(configPath, JSON.stringify({ bearer, name, workspaceId, capabilities }, null, 2));
        (0, node_fs_1.chmodSync)(configPath, 0o600);
        return {
            workspaceId,
            name,
            bearer,
            configPath,
            rotated: existing.length > 0,
        };
    });
}
const DEFAULT_PI_CAPABILITIES = [
    'tasks:read',
    'goals:read',
    'harness:read',
    'messages:read',
    'search:read',
];
async function startPiSession(args) {
    const { workspaceId, sessionId } = args;
    const caps = args.capabilities.length ? args.capabilities : DEFAULT_PI_CAPABILITIES;
    return (0, db_org_1.withWorkspace)(workspaceId, async (tx) => {
        const bearer = genBearer();
        const bearerHash = hash(bearer);
        await tx `
      INSERT INTO harness_shared.pi_sessions
        (workspace_id, session_id, bearer_hash, capabilities)
      VALUES (${workspaceId}, ${sessionId}, ${bearerHash}, ${JSON.stringify(caps)}::jsonb)
    `;
        await tx `
      INSERT INTO harness_shared.token_index (token, kind, slug, workspace_id)
      VALUES (${bearer}, 'pi', ${`pi:${sessionId}`}, ${workspaceId})
    `;
        return { bearer, sessionId };
    });
}
async function endPiSession(workspaceId, sessionId) {
    await (0, db_org_1.withWorkspace)(workspaceId, async (tx) => {
        await tx `
      UPDATE harness_shared.pi_sessions
         SET ended_at = now()
       WHERE workspace_id = ${workspaceId} AND session_id = ${sessionId}
    `;
        await tx `
      DELETE FROM harness_shared.token_index
       WHERE kind = 'pi' AND slug = ${`pi:${sessionId}`} AND workspace_id = ${workspaceId}
    `;
    });
}
