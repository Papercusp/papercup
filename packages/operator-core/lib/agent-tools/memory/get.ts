/**
 * memory:get — read memories BY ID (WI-10004550).
 *
 * Measured 2026-10-01 (tool_invocations, 72h): 185 `unknown_tool` calls to a `memory:get`
 * that did not exist, from 40 distinct owners. The demand is structural, not typo noise:
 * every other family has a by-id `<family>:get` (work_items:get, plans:get, docs:get), and
 * the mid-turn / orient memory injections print `(id=<uuid>) … memory:search the id above
 * for the rest` — an id an agent can only follow with a by-id read, which semantic
 * `memory:search` was never built to answer.
 *
 * Reuse-first: this is a thin wrapper over the backend seam's existing `get(id)` (the same
 * call memory:forget / memory:update use for their preflight) and the shared `toWireRow`
 * wire shape — no new storage, no new backend method.
 *
 * ISOLATION mirrors memory:list's scope construction: a row is returned only when it lives
 * in the caller's OWN user pool or a harness/hive pool (the pools memory:list serves on
 * request). A row in ANOTHER user's pool is reported exactly like an unknown id — `missing`
 * — so the tool is never an existence oracle for someone else's memory.
 *
 * RESPONSE CONTRACT: { ok, reason?, results: [{ id, memory, metadata }], missing: [id] }.
 * Degraded-never-silent: a store problem yields { ok:false, reason, results:[], missing:[] }.
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { getMemoryBackend, MemoryUnavailableError } from '../../memory/backend';
import { MemoryTimeoutError, withMemoryToolTimeout } from '../../memory/op-deadline';
import { getSessionUserOrDefault } from '../../auth';
import { toWireRow } from './search';

/** Pools memory:list serves on request besides the caller's own user pool. */
function isReadableScope(scope: string | undefined, userId: string): boolean {
  if (!scope) return false;
  return scope === userId || scope.startsWith('harness:') || scope.startsWith('hive:');
}

function mergeIds(id: string | undefined, ids: string[] | undefined): string[] {
  return [...new Set([...(id ? [id] : []), ...(ids ?? [])])];
}

export default defineTool({
  name: 'memory:get',
  capability: 'memory:read',
  description:
    'Read one or more memories by id (1–50). Returns each memory with its metadata; ids that do not exist (or are not yours) come back in `missing`.',
  guidance: {
    when:
      'You hold a memory id — from a `(id=…)` injection, memory:search/list output, or a work-item — and need its FULL text or metadata (injections truncate bodies). Superseded and soft-forgotten rows are returned too, with `metadata.validity`.',
    notWhen: 'You do not have an id — use memory:search (semantic) or memory:list (filter-only).',
    chaining:
      'memory:search → memory:get { id } for the full body → memory:update / memory:remember { supersede:<id> } / memory:forget.',
    seeAlso: [
      'memory:search (find a memory by meaning)',
      'memory:list (filter-only lookup by kind / harness)',
      'memory:update (amend the memory you read)',
    ],
  },
  // The memory store is cross-workspace by design (scoped by user-id / harness-slug, not by
  // workspace; the handler reads getMemoryBackend, never ctx.tx) — same as memory:list/search.
  crossWorkspace: true,
  args: z
    .object({
      id: z.string().min(1).optional().describe('a single memory id (n=1 shorthand for ids:[id])'),
      ids: z.array(z.string().min(1)).min(1).max(50).optional().describe('memory ids to read (1–50)'),
    })
    .refine((a) => Boolean(a.id) || (a.ids?.length ?? 0) > 0, { message: 'pass `id` (one) or `ids` (many)' }),
  async handler(args) {
    const user = await getSessionUserOrDefault();
    const backend = getMemoryBackend();
    const ids = mergeIds(args.id, args.ids);
    const reply = (body: Record<string, unknown>) => ({ content: [{ type: 'text' as const, text: JSON.stringify(body) }] });

    try {
      const avail = await withMemoryToolTimeout(backend.available(), 'memory:get available');
      if (!avail.ok) return reply({ ok: false, reason: avail.reason, results: [], missing: [] });

      const rows = await Promise.all(ids.map((id) => withMemoryToolTimeout(backend.get(id), 'memory:get get')));
      const results: ReturnType<typeof toWireRow>[] = [];
      const missing: string[] = [];
      rows.forEach((row, i) => {
        if (row && isReadableScope(row.scope, user.id)) results.push(toWireRow(row));
        else missing.push(ids[i]!);
      });
      return reply({ ok: true, results, missing });
    } catch (err) {
      // Degraded-never-silent, same contract as memory:list/search: a store problem returns
      // the { ok:false, reason } envelope, never a raw 500 and never a silent empty { ok:true }.
      if (err instanceof MemoryTimeoutError) return reply({ ok: false, reason: 'memory_timeout', results: [], missing: [] });
      if (err instanceof MemoryUnavailableError) return reply({ ok: false, reason: err.reason, results: [], missing: [] });
      throw err;
    }
  },
});
