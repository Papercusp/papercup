/**
 * locks:queue — read-only inspection of who's holding/waiting on what.
 *
 * Does NOT take the workspace advisory lock — read-only over MVCC.
 */

import { z } from 'zod';
import { defineTool, AGENT_ROLES } from '@papercusp/agent-mcp';
import { ensureBootstrap, getTxPool, readQueue } from './su-lock-store';
import { acquireWithContentionRetry } from './contention-retry';
import { holderContextReader, resolveHolderAdvisoryMap } from '../coordination/holder-advisory';

export default defineTool({
  name: 'locks:queue',
  description:
    'Read the active locks and pending waiters for a workspace. This is a workspace-global diagnostic: omit harness. Optionally filter by paths (overlap) or owner. Pass include_completed=true to also return terminal waiters from the last 24h (diagnostics). Accepted arguments are paths, owner, and include_completed.',
  guidance: {
    when: 'Diagnostics — "what are the other agents doing?" or "why am I blocked?". Cheap, MVCC read.',
    notWhen: 'Before every acquire — locks:acquire already returns busy context. Use queue when the user asks.',
    chaining: 'Workspace-global diagnostic — omit harness; pass only paths?, owner?, or include_completed?.',
    seeAlso: [
      'locks:list (named-resource holders, not file-lock contention)',
      'coord:roster { view:"live" } (what the other agents are doing overall)',
    ],
  },
  capability: 'locks:read',
  requirePrincipal: false,
  // EI-20229273881874423: this diagnostic owns its read pool and never reads
  // ctx.tx. Do not retain the ambient workspace transaction while the lock
  // queue is saturated; a queued org-app acquisition makes self-verification
  // fail before the diagnostic handler can run.
  skipWorkspaceTx: true,
  agentRoles: [...AGENT_ROLES],
  args: z.object({
    paths: z.array(z.string()).optional(),
    owner: z.string().optional(),
    include_completed: z.boolean().optional(),
  }),
  async handler(args, ctx) {
    await ensureBootstrap();
    const sql = getTxPool();

    // EI-7454: readQueue scopes a 1s statement_timeout to this read (plan §6.1) —
    // under fleet-load DB contention a plain indexed SELECT can transiently trip
    // it (pg 57014) even though the query itself is cheap. Retry-with-backoff
    // (same helper file-lock-guard.ts already uses for the analogous acquire-path
    // 57014/55P03) rides out the dip instead of surfacing a raw tool error to a
    // diagnostic-only read.
    const result = await acquireWithContentionRetry(() =>
      readQueue(sql, {
        // WI-5979: this is a diagnostic read, not an enforcement decision.
        // The serving operator's repo root can differ from the checkout whose
        // file lock is being inspected (:3070 vs :3170), so a caller-scoped
        // domain silently turns a held path into an empty result. The store's
        // null domain spans those namespaces and returns each row's domain for
        // attribution; acquire/release paths remain domain-scoped.
        coordinationDomain: null,
        paths: args.paths,
        owner: args.owner,
        includeCompleted: args.include_completed,
      }),
    );

    /**
     * P-027 / D-055 A4 — "you are queued behind a holder and need to know WHAT you
     * are queued behind, not merely THAT you are."
     *
     * Decorates the ACTIVE LOCKS, because those are the rows that actually block:
     * a waiter ahead of you is queued, not holding. One resolution per DISTINCT
     * holder, so a peer holding twelve paths costs one.
     *
     * ⚠ NO `subjectRef` HERE, AND THAT IS CORRECT RATHER THAN AN OMISSION. D-094's
     * subtraction removes the subject from `competing`, which is a list of ITEM
     * refs (WI-/EI-/plan-item). A lock's subject is a FILE PATH, which can never
     * appear in that list, so there is nothing to subtract — passing the path
     * would be a no-op that implies a relationship between the two namespaces
     * that does not exist. `locks:acquire`'s own busy enrichment (P-012,
     * enrich-busy.ts) omits it for the same reason.
     *
     * ⚠ ADVISORY: this is a read-only diagnostic and cannot alter a lock verdict.
     * `requirePrincipal: false` above makes an unattributable caller legitimate,
     * so the guarded reader yields null and the rows return undecorated.
     */
    const reader = holderContextReader(ctx as Parameters<typeof holderContextReader>[0]);
    const advisory = await resolveHolderAdvisoryMap(
      result.active_locks.map((l) => l.owner),
      reader,
    );

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            active_locks: result.active_locks.map((l) => {
              const holder_context = advisory.forRow(l.owner);
              return {
                ...l,
                acquired_ts: l.acquired_ts.toISOString(),
                expires_ts: l.expires_ts.toISOString(),
                ...(holder_context ? { holder_context } : {}),
              };
            }),
            waiting: result.waiting.map((w) => ({
              ...w,
              queued_ts: w.queued_ts.toISOString(),
              wait_until: w.wait_until.toISOString(),
            })),
            completed: result.completed?.map((w) => ({
              ...w,
              queued_ts: w.queued_ts.toISOString(),
              wait_until: w.wait_until.toISOString(),
            })),
          }),
        },
      ],
    };
  },
});
