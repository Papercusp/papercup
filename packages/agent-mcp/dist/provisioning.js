"use strict";
/**
 * Provisioning for system:<name> principals.
 *
 * Creates a fresh bearer and writes it to two PG tables:
 *   1. harness_shared.system_principals (workspace_id, name, bearer_hash, capabilities)
 *   2. harness_shared.token_index (token, kind='system', slug='system:<name>', workspace_id)
 *
 * Was previously also duplicated to `<papercuspRoot>/system/<name>/config.json`
 * for read-access by the operator's dispatch routes — that file is gone;
 * routes now read the bearer from token_index via apps/operator/lib/system-principal.ts.
 *
 * Idempotent per (workspace, name): re-running with the same name skips
 * if a row already exists (use `force: true` to rotate the bearer).
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.provisionSystemPrincipal = provisionSystemPrincipal;
exports.startPiSession = startPiSession;
exports.endPiSession = endPiSession;
const node_crypto_1 = require("node:crypto");
const db_org_1 = require("@papercusp/db-org");
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
           AND harness_slug = ${`system:${name}`}
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
      INSERT INTO harness_shared.token_index (token, kind, harness_slug, workspace_id)
      VALUES (${bearer}, 'system', ${`system:${name}`}, ${workspaceId})
      ON CONFLICT (token) DO UPDATE
        SET kind = 'system', harness_slug = ${`system:${name}`}, workspace_id = ${workspaceId}
    `;
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
      INSERT INTO harness_shared.token_index (token, kind, harness_slug, workspace_id)
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
       WHERE kind = 'pi' AND harness_slug = ${`pi:${sessionId}`} AND workspace_id = ${workspaceId}
    `;
    });
}
