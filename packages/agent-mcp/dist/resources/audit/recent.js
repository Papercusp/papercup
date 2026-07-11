/**
 * `papercusp://workspace/audit/recent` — last 100 audit log entries.
 *
 * High-tier capability gate (audit:read) — same trust boundary as the
 * `audit:list` tool. Read-only snapshot of `harness_shared.audit_log`.
 */
import { defineResource } from '@papercusp/tooldef';
export default defineResource({
    name: 'audit:recent',
    uri: 'papercusp://workspace/audit/recent',
    capability: 'audit:read',
    mimeType: 'application/json',
    description: 'Most-recent 100 audit log entries (id, ts, actor, action, subject, details).',
    async read(uri, ctx) {
        const rows = await ctx.tx `
      SELECT id, ts, actor, action, subject, details
        FROM harness_shared.audit_log
       ORDER BY ts DESC
       LIMIT 100
    `;
        return {
            uri,
            mimeType: 'application/json',
            text: JSON.stringify({ entries: rows }, null, 2),
        };
    },
});
