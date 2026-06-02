"use strict";
/**
 * Get the rendered feature-history block for a feature.
 *
 * Same data path as the prompt-injected version (orchestrator's
 * `feature-history.ts`): notes + debugger findings + recent audit
 * transitions, read PG-only. Useful when:
 *   - The agent's prompt-injected version was capped (long history).
 *   - The agent is exploring a non-current feature.
 *
 * Returns the rendered markdown string verbatim. Caller can re-format.
 */
Object.defineProperty(exports, "__esModule", { value: true });
const zod_1 = require("zod");
const tooldef_1 = require("@papercusp/tooldef");
const SLUG_RE = /^[a-z0-9._-]+$/i;
exports.default = (0, tooldef_1.defineTool)({
    name: 'features:history',
    profile: 'engineer',
    capability: 'features:read',
    guidance: {
        when: 'User asks "what changed on feature X?", "who edited the spec?", or you need a timeline of edits.',
        notWhen: 'For the CURRENT body, use `features:get`. For cross-feature audit, use `audit:list`.',
    },
    args: zod_1.z.object({
        slug: zod_1.z.string().min(1),
        feature_id: zod_1.z.string().min(1),
        /** Per-section character caps. Defaults match the orchestrator's prompt injection. */
        notes_max_chars: zod_1.z.number().int().positive().max(20000).default(4000),
        debug_max_chars: zod_1.z.number().int().positive().max(20000).default(4000),
        /** Last N audit rows. Default 10. */
        audit_rows: zod_1.z.number().int().positive().max(100).default(10),
    }),
    async handler(args, ctx) {
        if (!SLUG_RE.test(args.slug)) {
            return { data: '', degraded: true, degradedReasons: [`invalid slug ${JSON.stringify(args.slug)}`] };
        }
        // harness_shared tables have no RLS policies, so we filter
        // explicitly by workspace_id (sourced from the principal). Other
        // tools that target per-harness schemas can rely on the tx's
        // app.workspace_id GUC + RLS.
        const ws = ctx.principal.workspaceId;
        const [notesRows, debugRows, auditList] = await Promise.all([
            ctx.tx `
        SELECT content
          FROM harness_shared.harness_feature_notes
         WHERE workspace_id = ${ws} AND harness_slug = ${args.slug} AND feature_id = ${args.feature_id}
         LIMIT 1
      `.catch(() => []),
            ctx.tx `
        SELECT content
          FROM harness_shared.harness_feature_debug_notes
         WHERE workspace_id = ${ws} AND harness_slug = ${args.slug} AND feature_id = ${args.feature_id}
         LIMIT 1
      `.catch(() => []),
            ctx.tx `
        SELECT ts, field, old_value, new_value, actor
          FROM harness_shared.feature_audit_consolidated
         WHERE workspace_id = ${ws} AND harness_slug = ${args.slug} AND feature_id = ${args.feature_id}
         ORDER BY ts DESC
         LIMIT ${args.audit_rows}
      `.catch(() => []),
        ]);
        const sections = [];
        if (notesRows.length && notesRows[0].content?.trim()) {
            sections.push('### Notes', truncate(notesRows[0].content, args.notes_max_chars));
        }
        if (debugRows.length && debugRows[0].content?.trim()) {
            sections.push('### Debugger findings', truncate(debugRows[0].content, args.debug_max_chars));
        }
        if (auditList.length) {
            sections.push('### Recent activity');
            for (const row of auditList) {
                sections.push(formatAuditRow(row));
            }
        }
        if (!sections.length) {
            return {
                data: '',
                degraded: true,
                degradedReasons: [`no history yet for ${args.feature_id} in ${args.slug}`],
            };
        }
        const rendered = [`## This feature's history (${args.feature_id})`, ...sections].join('\n');
        return { data: rendered };
    },
});
function truncate(s, maxChars) {
    if (s.length <= maxChars)
        return s;
    return s.slice(0, maxChars) + '\n\n[…truncated, exceeded ' + maxChars + ' chars]';
}
function formatAuditRow(row) {
    const iso = new Date(Number(row.ts)).toISOString().replace(/\.\d{3}Z$/, 'Z');
    const oldS = renderAuditValue(row.old_value);
    const newS = renderAuditValue(row.new_value);
    const arrow = oldS === '' ? `→ ${newS}` : `${oldS} → ${newS}`;
    return `- ${iso} \`${row.field}\` ${arrow} (${row.actor})`;
}
function renderAuditValue(v) {
    if (v === null || v === undefined)
        return '';
    if (typeof v === 'string' && v.length >= 2 && v.startsWith('"') && v.endsWith('"')) {
        return v.slice(1, -1);
    }
    return v;
}
