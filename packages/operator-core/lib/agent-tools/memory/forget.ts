/**
 * memory:forget — delete one OR many memories by id.
 *
 * Brain calls when user says "forget X" or contradicts a stored fact.
 * Always informs the user out loud ("Removing that from memory").
 * Storage rides the neutral `MemoryBackend` seam.
 *
 * Bulk by default (the house keyed-array contract,
 * bulk-endpoint-standardization-2026-06-21): pass `id` for one or `ids` for
 * several → { ok, results:[{ ok, id, error? }], counts }. The backend
 * availability probe is a single top-level gate (a wedged store can't serve ANY
 * delete → { ok:false, reason }); per-id deletes then run sequentially, each
 * self-describing its id — correlate by id (not position), and one not-found /
 * timed-out id never fails the rest.
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { getMemoryBackend } from '../../memory/backend';
import { MemoryTimeoutError, withMemoryToolTimeout } from '../../memory/op-deadline';
import { mergeIds, runBulk, bulkContent } from '../_bulk';

export default defineTool({
  name: 'memory:forget',
  capability: 'memory:write',
  description:
    'Delete one OR many memory entries by id — pass `id` for one or `ids` for several. Returns { ok, results:[{ ok, id, error? }], counts } — correlate each result by its id, not by position; a not-found / timed-out id comes back as that item\'s { ok:false } without failing the rest.',
  guidance: {
    when:
      'When the user explicitly says "forget X" / "don\'t remember that anymore" / "that\'s wrong, drop it". Pass every id to drop at once via `ids`. Always inform the user out loud ("Removed that from memory").',
    notWhen:
      'To CORRECT a memory (replace its content), use memory:update — preserves history. Only use forget for outright removal.',
    chaining:
      'memory:search / memory:list → memory:forget { ids:[…] } to drop several found memories in one call. Bulk: single | ids[] → { ok, results, counts }; correlate by id not position; one failure never fails the rest.',
  },
  // Principal-gated is defineTool's DEFAULT (unauthed HTTP → 401); the former
  // `requirePrincipal: true` marker was not a declared input property and made
  // every overload fail (memory-taxonomy-and-debt-followups P-004).
  // The memory store is cross-workspace by design (shared tables scoped by
  // user-id / harness-slug, not by workspace; the handler reads getMemoryBackend,
  // never ctx.tx). crossWorkspace:true hands an UNSCOPED superuser session ('*')
  // the admin handle + a synthesized principal, so this works from a psu / fleet
  // session instead of failing `workspace_required` (EI-177/178/210 — the
  // workspace-tx gate was wrongly applied to memory:forget; search + remember
  // already carry this).
  crossWorkspace: true,
  // NOTE: agentRoles/rolesQuota are not accepted on principal-gated tools —
  // definePrincipalGatedTool drops them (never copied to the def, never
  // enforced); the all-roles lists + quotas formerly here were dead inputs
  // (memory-taxonomy-and-debt-followups P-004).
  args: z
    .object({
      id: z.string().min(1).optional().describe('a single memory id (n=1 shorthand for ids:[id])'),
      ids: z.array(z.string().min(1)).min(1).max(200).optional().describe('memory ids to delete (1–200)'),
    })
    .refine((a) => Boolean(a.id) || (a.ids?.length ?? 0) > 0, {
      message: 'pass `id` (one) or `ids` (many)',
    }),
  async handler(args) {
    const ids = mergeIds(args.id, args.ids);
    const backend = getMemoryBackend();
    // B1: bound the availability probe so a wedged store yields memory_timeout
    // instead of hanging the handler forever (the 2026-06-19 outage class). This
    // is a TOP-LEVEL gate — a store that can't answer `available()` can't serve
    // ANY delete, so the whole batch short-circuits with a single envelope rather
    // than N identical per-item timeouts.
    try {
      const avail = await withMemoryToolTimeout(backend.available(), 'memory:forget available');
      if (!avail.ok) {
        return bulkContent({ ok: false, reason: avail.reason });
      }
    } catch (err) {
      if (err instanceof MemoryTimeoutError) {
        return bulkContent({ ok: false, reason: 'memory_timeout' });
      }
      throw err;
    }
    const env = await runBulk(
      ids,
      async (id) => {
        try {
          await withMemoryToolTimeout(backend.forget(id), 'memory:forget forget');
        } catch (err) {
          if (err instanceof MemoryTimeoutError) {
            return { ok: false as const, id, reason: 'memory_timeout' as const };
          }
          throw err;
        }
        // Learning signal (learning-system-audit P-050): an agent-driven forget is
        // the contradiction/staleness signal the extraction-adaptation loop reads
        // (memory_feedback → rebuildCustomInstructions). Fire-and-forget.
        void import('../../memory/feedback')
          .then(({ recordFeedback }) =>
            recordFeedback({ memId: id, userId: 'agent-tool', action: 'delete' }),
          )
          .catch(() => { /* best-effort */ });
        return { ok: true as const, id };
      },
      { keyOf: (id) => ({ id }) },
    );
    // Live-refresh the settings memory page (userMemory.list sync query) —
    // fire-and-forget, never load-bearing (memory-settings-page-refresh P-008).
    // One invalidate covers the whole batch.
    if (env.counts.ok > 0) {
      void import('../../sync-sse')
        .then(({ notifySyncInvalidate }) => notifySyncInvalidate('userMemory.list'))
        .catch(() => { /* best-effort */ });
    }
    return bulkContent(env);
  },
});
