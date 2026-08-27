/**
 * routines:revert — restore a routine from the durable audit row emitted by
 * routines:set. The audit row is the serializable replacement for the
 * in-process closure that cannot cross the MCP boundary.
 */
import { z } from 'zod';
import { defineTool, SU_ROLES, isOperatorConfigWriteRole } from '@papercusp/agent-mcp';
import { getOrgPg } from '@papercusp/db-org';
import { activeWorkspaceId } from '../../workspace-registry';
import { runControlMutation } from '../../gateway-control/control-harness';
import {
  parseRoutineSnap,
  readRoutineSnap,
  routineSnapEqual,
  writeRoutineSnap,
  type RoutineSnap,
} from './routine-snapshot';

const ROUTINES_SET_AUDIT_ACTION = 'gateway-control.routines:set';

interface AuditRow {
  action: string;
  subject: string;
  details: unknown;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function splitRoutineSubject(subject: string): { installSlug: string; name: string } | null {
  const slash = subject.indexOf('/');
  if (slash <= 0 || slash === subject.length - 1) return null;
  return { installSlug: subject.slice(0, slash), name: subject.slice(slash + 1) };
}

function json(obj: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(obj) }] };
}

export default defineTool({
  name: 'routines:revert',
  profile: 'engineer',
  description:
    'Restore a routine exactly to the prior state captured by a routines:set audit id. Pass the serializable handle returned by routines:set (or its auditId). Refuses malformed/non-routines:set audit rows and refuses to overwrite a newer routine change.',
  capability: 'operator:write',
  guidance: {
    when: 'Undo a routines:set mutation using its returned revertHandle or auditId, restoring trigger_config, payload_template, active, next_fire_at, group, and metadata together.',
    notWhen: 'To make a new routine change use routines:set. Do not use a stale audit id after another routine change; this tool refuses when the current row no longer matches the audited next snapshot.',
    chaining: 'Use the revertHandle returned by routines:set; routines:list confirms the exact routine state after the revert.',
    seeAlso: ['routines:set (make a new audited routine change)', 'routines:list (confirm the restored state)'],
  },
  requirePrincipal: false,
  agentRoles: [...SU_ROLES],
  rolesQuota: { operator: { perRun: 20 } },
  args: z.object({
    auditId: z.string().min(1).max(200).describe('Audit id or revertHandle.args.auditId returned by routines:set.'),
    dryRun: z.boolean().optional().describe('Preview the exact restore without applying it or writing a new audit row.'),
  }),
  async handler(args, ctx) {
    if (!isOperatorConfigWriteRole(ctx.role)) {
      throw new Error('routines:revert requires operator, architect, or mug role');
    }

    const { sql } = getOrgPg();
    const workspaceId = activeWorkspaceId();
    const rows = await sql<AuditRow[]>`
      SELECT action, subject, details
        FROM harness_shared.audit_log
       WHERE workspace_id = ${workspaceId} AND id = ${args.auditId}
       LIMIT 1`;
    const row = rows[0];
    if (!row) throw new Error(`routines:set audit not found: ${args.auditId}`);
    if (row.action !== ROUTINES_SET_AUDIT_ACTION) {
      throw new Error(`audit ${args.auditId} is not a routines:set mutation`);
    }

    const subject = splitRoutineSubject(row.subject);
    if (!subject) throw new Error(`routines:set audit ${args.auditId} has an invalid subject`);
    const details = asRecord(row.details);
    const restore = parseRoutineSnap(details?.prev);
    const auditedNext = parseRoutineSnap(details?.next);
    if (!restore || !auditedNext) {
      throw new Error(`routines:set audit ${args.auditId} has no valid complete routine snapshot`);
    }

    const readSnap = (): Promise<RoutineSnap> =>
      readRoutineSnap(sql, workspaceId, subject.installSlug, subject.name);
    const writeSnap = (snap: RoutineSnap): Promise<void> =>
      writeRoutineSnap(sql, workspaceId, subject.installSlug, subject.name, snap);

    const outcome = await runControlMutation<RoutineSnap>(
      {
        action: 'routines:set:revert',
        subject: row.subject,
        actor: `role:${ctx.role}`,
        revertOf: args.auditId,
        capturePrev: readSnap,
        apply: async () => {
          const current = await readSnap();
          if (!routineSnapEqual(current, auditedNext)) {
            throw new Error(
              `routine ${row.subject} changed after audit ${args.auditId}; refusing to overwrite the newer state`,
            );
          }
          await writeSnap(restore);
          return restore;
        },
        revertTo: writeSnap,
        verify: async (next) => {
          const current = await readSnap();
          const ok = routineSnapEqual(current, next);
          return { ok, detail: ok ? undefined : 'routine row did not reflect the restored snapshot' };
        },
        describe: (current) => ({ auditId: args.auditId, current, restore }),
      },
      { dryRun: args.dryRun },
    );

    return json({
      ok: true,
      routine: row.subject,
      sourceAuditId: args.auditId,
      dryRun: outcome.dryRun,
      applied: outcome.applied,
      reverted: outcome.reverted,
      preview: outcome.preview,
      verify: outcome.verify,
      auditId: outcome.auditId,
    });
  },
});
