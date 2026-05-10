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

import { z } from 'zod';
import { defineTool } from '../../define-tool';

const SLUG_RE = /^[a-z0-9._-]+$/i;

interface AuditRow {
  ts: number;
  field: string;
  old_value: string | null;
  new_value: string | null;
  actor: string;
}

export default defineTool({
  name: 'features:history',
  capability: 'features:read',
  args: z.object({
    slug: z.string().min(1),
    feature_id: z.string().min(1),
    /** Per-section character caps. Defaults match the orchestrator's prompt injection. */
    notes_max_chars: z.number().int().positive().max(20000).default(4000),
    debug_max_chars: z.number().int().positive().max(20000).default(4000),
    /** Last N audit rows. Default 10. */
    audit_rows: z.number().int().positive().max(100).default(10),
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
      ctx.tx<Array<{ content: string }>>`
        SELECT content
          FROM harness_shared.harness_feature_notes
         WHERE workspace_id = ${ws} AND harness_slug = ${args.slug} AND feature_id = ${args.feature_id}
         LIMIT 1
      `.catch(() => [] as Array<{ content: string }>),
      ctx.tx<Array<{ content: string }>>`
        SELECT content
          FROM harness_shared.harness_feature_debug_notes
         WHERE workspace_id = ${ws} AND harness_slug = ${args.slug} AND feature_id = ${args.feature_id}
         LIMIT 1
      `.catch(() => [] as Array<{ content: string }>),
      ctx.tx<AuditRow[]>`
        SELECT ts, field, old_value, new_value, actor
          FROM harness_shared.feature_audit_consolidated
         WHERE workspace_id = ${ws} AND harness_slug = ${args.slug} AND feature_id = ${args.feature_id}
         ORDER BY ts DESC
         LIMIT ${args.audit_rows}
      `.catch(() => [] as AuditRow[]),
    ]);

    const sections: string[] = [];
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

function truncate(s: string, maxChars: number): string {
  if (s.length <= maxChars) return s;
  return s.slice(0, maxChars) + '\n\n[…truncated, exceeded ' + maxChars + ' chars]';
}

function formatAuditRow(row: AuditRow): string {
  const iso = new Date(Number(row.ts)).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const oldS = renderAuditValue(row.old_value);
  const newS = renderAuditValue(row.new_value);
  const arrow = oldS === '' ? `→ ${newS}` : `${oldS} → ${newS}`;
  return `- ${iso} \`${row.field}\` ${arrow} (${row.actor})`;
}

function renderAuditValue(v: string | null): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string' && v.length >= 2 && v.startsWith('"') && v.endsWith('"')) {
    return v.slice(1, -1);
  }
  return v;
}
