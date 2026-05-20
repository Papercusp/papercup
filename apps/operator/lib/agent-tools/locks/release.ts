/**
 * locks:release — release locks and fire the grant cascade.
 *
 * Inside the same transaction, runs grant_cascade(workspaceId, now())
 * which iterates FIFO waiters and grants any whose paths are now free.
 * NOTIFY fires inside the cascade function; the app doesn't need to
 * loop the result.
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { readIdentity } from './identity';
import { inWorkspaceTxn } from './in-workspace-txn';
import { tryRelease } from './su-lock-store';

const SU_ROLES = [
  'scoper',
  'architect',
  'worker',
  'validator',
  'reviewer',
  'debugger',
  'operator',
  'documenter',
  'curator',
] as const;

export default defineTool({
  name: 'locks:release',
  description:
    'Release a held lock set. Pass lock_id (with optional paths filter) for a specific lock, or all_mine=true to release every lock owned by this agent. Fires the grant cascade for waiting agents.',
  guidance: {
    when: 'Immediately after the edit is committed. On context loss / restart, call with all_mine=true to release everything.',
    notWhen: 'Mid-edit. The lock should outlive the edit by enough that no other agent races between release and PR merge.',
    chaining: 'locks:acquire → edit → locks:release { lock_id }. Or: session-end → locks:release { all_mine: true }.',
  },
  capability: 'locks:write',
  requirePrincipal: false,
  roles: [...SU_ROLES],
  args: z.object({
    lock_id: z.string().uuid().optional(),
    paths: z.array(z.string()).optional(),
    all_mine: z.boolean().optional(),
  }),
  async handler(args, ctx) {
    const { ownerId, workspaceId } = readIdentity(ctx);

    if (!args.lock_id && !args.all_mine) {
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              ok: false,
              error: 'locks:release requires lock_id or all_mine=true',
            }),
          },
        ],
      };
    }

    const result = await inWorkspaceTxn(workspaceId, ownerId, async (tx) =>
      tryRelease(tx, {
        workspaceId,
        owner: ownerId,
        lockId: args.lock_id,
        paths: args.paths,
        allMine: args.all_mine,
      }),
    );

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({ ok: true, released: result.released }),
        },
      ],
    };
  },
});
