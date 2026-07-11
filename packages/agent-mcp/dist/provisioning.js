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
import { createHash, randomBytes } from 'node:crypto';
import { withWorkspace } from '@papercusp/db-org';
import { PRINCIPAL_INVALIDATE_CHANNEL } from './auth';
/**
 * Tell every live auth cache (auth.ts LISTEN) that this principal's
 * capabilities changed. Runs inside the write tx — PG queues the NOTIFY
 * and delivers it on commit (dropped on rollback).
 */
async function notifyPrincipalChanged(tx, workspaceId, slug) {
    const payload = JSON.stringify({ workspace_id: workspaceId, slug });
    await tx `SELECT pg_notify(${PRINCIPAL_INVALIDATE_CHANNEL}, ${payload})`;
}
/**
 * The ADDITIVE capability-reconcile decision (EI-2048), pure + exported for tests.
 * Returns the caps in `code` that `stored` lacks (`missing`) and the union to persist
 * (`merged`). NEVER removes a stored cap not in `code` — shrinking a principal's caps is
 * an attended `force` reprovision, not an automatic forceless-deploy side effect. When
 * `missing` is empty the live row is already current and the caller writes nothing.
 */
export function reconcileCapabilities(stored, code) {
    const have = new Set(stored);
    const missing = code.filter((c) => !have.has(c));
    return { missing, merged: missing.length ? [...stored, ...missing] : [...stored] };
}
export function normalizeCapabilities(raw) {
    if (Array.isArray(raw))
        return raw.filter((x) => typeof x === 'string');
    if (typeof raw !== 'string')
        return [];
    try {
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed)
            ? parsed.filter((x) => typeof x === 'string')
            : [];
    }
    catch {
        return [];
    }
}
function genBearer() {
    return randomBytes(32).toString('base64url');
}
function hash(s) {
    return createHash('sha256').update(s).digest('hex');
}
export async function provisionSystemPrincipal(args) {
    const { workspaceId, name, capabilities, papercuspRoot, force } = args;
    const configPath = `${papercuspRoot}/system/${name}/config.json`;
    return withWorkspace(workspaceId, async (tx) => {
        const existing = await tx `
      SELECT bearer_hash, capabilities
        FROM harness_shared.system_principals
       WHERE workspace_id = ${workspaceId} AND name = ${name}
       LIMIT 1
    `;
        if (existing.length > 0 && !force) {
            // EI-2048: a capability ADDED in code (e.g. operator's memory:*/locks:* grant on
            // 2026-06-20) never reached an already-provisioned row — provision-without-force
            // used to be a pure no-op, and the only way to apply it (`force`) ROTATES the
            // bearer, breaking every live connection. So reconcile capabilities IN PLACE,
            // ADDITIVELY: grant the caps the code-defined set has that the live row lacks, and
            // NEVER auto-revoke (shrinking a principal's caps stays an attended `force`
            // reprovision — auto-revoking under a live session is the dangerous direction). The
            // bearer is untouched (zero token churn / no broken connections); NOTIFY makes
            // auth.ts's cache reload. A normal (forceless) deploy now self-heals cap drift.
            const storedCaps = normalizeCapabilities(existing[0].capabilities);
            const { missing, merged } = reconcileCapabilities(storedCaps, capabilities);
            if (missing.length === 0)
                return null; // already current — a true no-op
            await tx `
        UPDATE harness_shared.system_principals
           SET capabilities = ${JSON.stringify(merged)}::jsonb
         WHERE workspace_id = ${workspaceId} AND name = ${name}
      `;
            await notifyPrincipalChanged(tx, workspaceId, `system:${name}`);
            return { workspaceId, name, configPath, rotated: false, reconciled: true };
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
        await notifyPrincipalChanged(tx, workspaceId, `system:${name}`);
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
export async function startPiSession(args) {
    const { workspaceId, sessionId } = args;
    const caps = args.capabilities.length ? args.capabilities : DEFAULT_PI_CAPABILITIES;
    return withWorkspace(workspaceId, async (tx) => {
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
        await notifyPrincipalChanged(tx, workspaceId, `pi:${sessionId}`);
        return { bearer, sessionId };
    });
}
export async function endPiSession(workspaceId, sessionId) {
    await withWorkspace(workspaceId, async (tx) => {
        await tx `
      UPDATE harness_shared.pi_sessions
         SET ended_at = now()
       WHERE workspace_id = ${workspaceId} AND session_id = ${sessionId}
    `;
        await tx `
      DELETE FROM harness_shared.token_index
       WHERE kind = 'pi' AND harness_slug = ${`pi:${sessionId}`} AND workspace_id = ${workspaceId}
    `;
        await notifyPrincipalChanged(tx, workspaceId, `pi:${sessionId}`);
    });
}
