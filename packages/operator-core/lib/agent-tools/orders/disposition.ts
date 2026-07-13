/**
 * orders:disposition — close an open owner directive (EI-11484): done (you
 * carried it out — say how) or declined (you are not doing it — say why). The
 * note is MANDATORY: a disposition without evidence is how an order gets
 * silently dropped with extra steps. Batchable via `items`.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { resolveAgentIdentity } from '../coordination/identity';
import { COORD_ROLES } from '../coordination/roles';
import { dispositionOwnerDirective, type OwnerDirectiveDisposition } from '../../owner-directives';

const entry = z.object({
  id: z.number().int().positive().describe('The directive id (from orders:record / orders:list).'),
  status: z.enum(['done', 'declined']).describe('done = carried out; declined = consciously not doing it.'),
  note: z
    .string()
    .min(4)
    .max(2000)
    .describe('MANDATORY evidence: what was done (with pointers), or why it was declined.'),
});

export default defineTool({
  name: 'orders:disposition',
  profile: 'engineer',
  description:
    'Close an open owner directive: done (carried out) or declined (consciously refused), with a MANDATORY evidence note. Closing stops it rendering above every wake/orient/anchor. Single { id, status, note } or batch via items[].',
  guidance: {
    when:
      'You finished (or consciously declined) a recorded owner directive — close it WITH evidence the moment the completion report goes to the owner. An open directive keeps rendering to you and every workspace peer; a stale-open one erodes the surface.',
    notWhen:
      'The work is merely in progress — the row rendering every wake IS the point; checkpoint progress on the work-item instead. Never disposition a directive you did not verify done.',
    chaining: 'orders:list { open: true } → work → orders:disposition. Re-record a re-issued order as a new row.',
    seeAlso: ['orders:record', 'orders:list', 'orders:get'],
  },
  capability: 'coord:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z
    .object({
      id: entry.shape.id.optional(),
      status: entry.shape.status.optional(),
      note: entry.shape.note.optional(),
      items: z.array(entry).min(1).max(50).optional().describe('Batch form — each { id, status, note }.'),
    })
    .refine((a) => (a.items?.length ?? 0) > 0 || (a.id != null && a.status != null && a.note != null), {
      message: 'pass { id, status, note } or items:[{ id, status, note }, …]',
    }),
  async handler(args, ctx) {
    const identity = resolveAgentIdentity(ctx);
    const entries =
      args.items ??
      ([{ id: args.id!, status: args.status! as OwnerDirectiveDisposition, note: args.note! }] as Array<
        z.infer<typeof entry>
      >);
    const results = [];
    for (const e of entries) {
      const r = await dispositionOwnerDirective({
        id: e.id,
        status: e.status,
        note: e.note,
        dispositionedBy: identity.ownerId,
      }).catch((err: unknown) => ({ ok: false as const, error: 'write_failed' as const, detail: String(err) }));
      results.push(
        r.ok
          ? { ok: true, id: e.id, status: e.status }
          : { ok: false, id: e.id, error: 'error' in r ? r.error : 'write_failed' },
      );
    }
    const failed = results.filter((r) => !r.ok).length;
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({ ok: failed === 0, results, counts: { ok: results.length - failed, failed } }),
        },
      ],
      ...(failed === results.length ? { isError: true } : {}),
    };
  },
});
