/**
 * locks:acquire_granular — acquire a multi-granularity intention lock (D-005).
 *
 * A NODE is a point in the harness path tree: a file, a directory/subtree, or
 * the harness root (""). A request locks its leaf in the requested mode + places
 * the matching intention lock (IS/IX) on every ancestor up to the root, so a
 * harness-level lock and a file-level lock finally SEE each other (Gray 1976).
 * All-or-nothing: you get the whole lock-set or a conflict list. This is the
 * coarse/cross-cutting complement to the file lock (locks:acquire), which
 * remains the default for a single-file edit.
 */

import { z } from 'zod';
import { defineTool, AGENT_ROLES } from '@papercusp/agent-mcp';
import { readIdentity } from './identity';
import { inWorkspaceTxn } from './in-workspace-txn';
import { tryAcquireGranular, validatePath } from './su-lock-store';
import { hardText, LIMITS } from '../limits';

import { DEFAULT_LOCK_TTL_SEC as DEFAULT_TTL_SEC, MAX_LOCK_TTL_SEC as MAX_TTL_SEC } from './lock-config';

const json = (payload: unknown) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(payload) }],
});

export default defineTool({
  name: 'locks:acquire_granular',
  description:
    'Acquire a multi-granularity intention lock on a path NODE (a file, a directory/subtree, or the harness root ""). mode "X" = own the subtree exclusively (a directory lock for a refactor, or a file write); "S" = read the whole subtree; "SIX" = read the subtree while writing one node; IS/IX are the intention modes (usually derived for you). The lock places the matching intention on every ancestor incl. the harness root, so a harness-exclusive (X on "") now conflicts with any descendant file lock. All-or-nothing — you get the whole lock-set or a conflict list. Release with locks:release_granular.',
  guidance: {
    when: 'A directory/subtree refactor (mode X on the dir), reading a whole subtree (S), or coordinating file-vs-harness-level work the per-edit lock is too fine for. Use "" as the path to take/contend the harness root.',
    notWhen: 'A single-file edit — rely on the per-edit hook when diagnostics show it is active, or use locks:acquire for that file if hooks are unavailable. Cross-resource coordination (dev-server / db-schema) — use locks:acquire_resource.',
    chaining: 'locks:acquire_granular { path, mode:"X" } → on ok do the work → locks:release_granular { lock_id }. On conflict, inspect the returned conflicts and pivot/retry.',
    seeAlso: [
      'locks:acquire (a single deliberate multi-file claim, not a subtree)',
      'locks:acquire_resource (a registered resource, not a path)',
      'locks:release_granular (drop the subtree lock)',
    ],
  },
  capability: 'locks:write',
  requirePrincipal: false,
  agentRoles: [...AGENT_ROLES],
  args: z.object({
    path: z.string().max(4096).describe('Repo-relative node: a file, a directory/subtree, or "" for the harness root.'),
    mode: z.enum(['IS', 'IX', 'S', 'SIX', 'X']),
    intent: hardText(LIMITS.SHORT_TITLE).optional(),
    ttl_sec: z.number().int().positive().max(MAX_TTL_SEC).optional(),
  }),
  async handler(args, ctx) {
    const { ownerId, ownerLabel, coordinationDomain } = readIdentity(ctx);
    // Root ("") is legal here (the harness node); validate any non-root path the
    // same way file locks do (reject absolute / traversal / over-long).
    if (args.path !== '') {
      try {
        validatePath(args.path);
      } catch (e) {
        return json({ ok: false, error: (e as Error).message });
      }
    }
    const r = await inWorkspaceTxn(coordinationDomain, ownerId, (tx) =>
      tryAcquireGranular(tx, {
        coordinationDomain,
        path: args.path,
        mode: args.mode,
        owner: ownerId,
        ownerLabel,
        intent: args.intent ?? '',
        ttlSec: args.ttl_sec ?? DEFAULT_TTL_SEC,
      }),
    );
    if (!r.ok) {
      return json({ ok: false, reason: r.reason, conflicts: r.conflicts });
    }
    return json({
      ok: true,
      lock_id: r.lock_id,
      mode: args.mode,
      locks: r.locks,
      expires_ts: r.expires_ts.toISOString(),
    });
  },
});
