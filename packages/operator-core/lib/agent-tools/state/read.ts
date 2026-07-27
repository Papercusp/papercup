/**
 * `state:read` — read one registered cell's VALUE at the moment of acting
 * (unified-agent-state-plane-2026-07-27 P-004, per D-058).
 *
 * WIRING, NOT A BUILD. Everything here already existed:
 *   • `getCell(cell, reader)` decides IF you may read (P-019);
 *   • `dispatchReadOnlyTool` (extracted from the predicate poller, D-058) invokes the
 *     resolver under YOUR role;
 *   • `valueAtPath` projects the cell's declared dot-path.
 * `cell-read.ts` composes the three; this file is the tool projection of it and holds
 * no logic of its own — deliberately, because a second place that assembles a cell read
 * is a second place that can drift on the audience check (D-042 / P-028).
 *
 * WHY A CELL READ RATHER THAN CALLING THE RESOLVER TOOL YOURSELF: the point is not
 * formatting, it is RE-DERIVABILITY (D-032). A value you copied into a message forty
 * minutes ago has rotted silently; a cell you read now has not. That is the same defect
 * P-017 (c)'s transcription detector flags from the other side.
 */

import { z } from 'zod';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import { resolveAgentIdentity } from '../coordination/identity';
import { readCell } from '../../cell-read';
import { listCells } from '../../cell-registry';
import { formatCellUnknown } from '../../cell-contract';

export default defineTool({
  name: 'state:read',
  description:
    'Read a registered state CELL by name, right now, instead of trusting a value someone transcribed earlier. Returns {status:"value"|"unknown"|"absent"}. "unknown" is IN-BAND and branchable (code: not-applicable | resolver-failed | not-measured | insufficient-data) — never treat it as false or as zero. "absent" means the cell does not exist FOR YOU: unregistered and out-of-audience are deliberately indistinguishable. Omit `cell` to list the cells you may read. A cell relative to a subject (an agent, a path) needs `as`.',
  guidance: {
    when: 'At the moment you ACT on a value that can change under you — a deploy position, a holder\'s goal, a queue depth. Also whenever you are about to quote such a value into a message or a plan: read it, do not copy it.',
    notWhen: 'A value you just computed this turn. A one-off analytic slice — that is dev:pg_query. Waiting for it to CHANGE — that is state:subscribe, not a poll loop.',
    chaining:
      'state:read { cell } → act. status:"unknown" → branch on unknown.code: not-measured means ask for access/enablement (retrying is pointless), resolver-failed means retry-or-escalate, insufficient-data means supply more input (often `as`). status:"absent" → the cell is not yours to read; do not reconstruct it from another surface.',
  },
  capability: 'coord:read',
  requirePrincipal: false,
  agentRoles: [...SU_ROLES],
  args: z.object({
    cell: z
      .string()
      .max(120)
      .optional()
      .describe('Dotted cell id, e.g. "git.pipelinePosition". Omit to LIST the cells you may read.'),
    as: z
      .string()
      .max(200)
      .optional()
      .describe(
        'The SUBJECT for a caller-relative cell — WHAT you are asking about (an ownerId for an agent-scoped cell, a repo path for a per-path one). NOT an identity override: your own audience is always what is checked, so naming a subject can never widen what you may see. Required only when the cell declares callerRelativity.kind="parameter"; the read tells you the parameter name if it is missing.',
      ),
  }),
  async handler(args, ctx) {
    const identity = resolveAgentIdentity(ctx);
    const reader = {
      ownerId: identity.ownerId,
      roles: ctx.role ? [ctx.role] : [],
      harnessSlug: ctx.harnessSlug ?? undefined,
    };

    // No cell named ⇒ the DIRECTORY, filtered to this reader. `listCells(reader)` omits
    // narrow cells rather than marking them, for the same non-oracle reason `absent`
    // exists: a directory that showed "3 cells you may not see" would enumerate them.
    if (!args.cell) {
      const cells = listCells(reader).map((s) => ({
        cell: s.cell,
        headline: s.headline,
        shape: s.shape,
        nullable: s.nullable,
        callerRelativity: s.callerRelativity,
        readable: s.changeSignal.kind === 'poll',
      }));
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              ok: true,
              cells,
              count: cells.length,
              note: 'Cells you may read. `readable:false` is event-signalled only — use state:subscribe. This list is audience-filtered; cells outside your audience are omitted, not marked.',
            }),
          },
        ],
      };
    }

    const out = await readCell(
      args.cell,
      reader,
      {
        workspaceId: identity.workspaceId ?? ctx.workspaceId ?? 'default',
        harnessSlug: ctx.harnessSlug ?? null,
        // FAIL CLOSED on an absent role. `''` matches no tool's role allowlist, so the
        // dispatch is refused with `role_not_allowed` and renders as a `not-measured`
        // unknown — honest and safe. Substituting a real role here (a 'su' default,
        // say) would WIDEN the second gate for a caller who never presented one, which
        // is the same failure D-042 names: an access default that fails OPEN.
        role: ctx.role ?? '',
      },
      args.as,
    );

    // `summary` renders the unknown in prose so a human-facing surface never shows a
    // bare `undefined` — but `unknown.code` stays on the payload, because prose cannot
    // be branched on and that is the exact defect cell-contract.ts exists to prevent.
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(
            out.status === 'unknown'
              ? { ok: true, ...out, summary: formatCellUnknown(out.unknown) }
              : out.status === 'absent'
                ? {
                    ok: true,
                    ...out,
                    summary: `No cell "${out.cell}" is readable by you. It may not exist, or it may be outside your audience — these are deliberately indistinguishable. Do NOT reconstruct the value from another surface.`,
                  }
                : { ok: true, ...out },
          ),
        },
      ],
    };
  },
});
