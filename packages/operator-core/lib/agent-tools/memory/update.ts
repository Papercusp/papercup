/**
 * memory:update — edit one OR many memories' content AND/OR patch metadata.
 *
 * Brain calls when the user corrects a stored fact ("actually my name is Daniel,
 * not Dan") → a CONTENT edit. Agents/superusers also call it for METADATA HYGIENE
 * — re-tag a memory's `kind`, fix its `workspaceId`, or move it to the right recall
 * `scope`/pool — without rewriting the text. The metadata patch is a vec-safe merge
 * on the canonical store (no re-embed); before this, metadata was unfixable through
 * any tool (mem0's update is text-only), forcing raw DB surgery (EI-2032). Preserves
 * the memory's id + lifecycle. Storage rides the neutral `MemoryBackend` seam.
 *
 * Bulk by default (the house keyed-array contract,
 * bulk-endpoint-standardization-2026-06-21): patch ONE inline ({ id, content?,
 * kind?, … }), MANY with the SAME metadata patch (ids:[…] + kind?/scope?/…), or
 * MANY heterogeneous (items:[{ id, content?, kind?, … }]) → { ok, results:[{ ok,
 * id, error? }], counts }. The backend availability probe is a single top-level
 * gate (a wedged store can't serve ANY patch → { ok:false, reason }); per-id
 * patches then run sequentially, each self-describing its id — correlate by id
 * (not position), and one not-found / timed-out id never fails the rest.
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { getMemoryBackend } from '../../memory/backend';
import { MemoryTimeoutError, withMemoryToolTimeout } from '../../memory/op-deadline';
import { runBulk, bulkContent } from '../_bulk';

/** The per-memory patch fields, shared by the inline single, the homogeneous
 *  `ids` default, and each heterogeneous `items[]` entry. */
const PATCH_FIELDS = {
  content: z.string().min(1).max(16000).optional().describe('replacement fact body (a CONTENT edit)'),
  kind: z
    .enum(['user', 'feedback', 'project', 'reference'])
    .optional()
    .describe('re-tag the memory kind (metadata — no re-embed)'),
  workspaceId: z
    .string()
    .min(1)
    .max(200)
    .optional()
    .describe('fix the workspace_id tag (metadata — no re-embed)'),
  scope: z
    .string()
    .min(1)
    .max(200)
    .optional()
    .describe(
      'MOVE the memory to a different recall pool (its user_id/scope, e.g. a user-id or "harness:<slug>"). Changes which queries see it.',
    ),
} as const;

const itemSpec = z.object({
  id: z.string().uuid('Memory ID must be a valid UUID'),
  ...PATCH_FIELDS,
});

type PatchInput = z.infer<typeof itemSpec>;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** id + at-least-one-of {content, kind, workspaceId, scope}. */
function hasAnyField(a: { content?: unknown; kind?: unknown; workspaceId?: unknown; scope?: unknown }): boolean {
  return (
    a.content !== undefined ||
    a.kind !== undefined ||
    a.workspaceId !== undefined ||
    a.scope !== undefined
  );
}

/** Build the neutral UpdatePatch from a per-item input. */
function toPatch(a: PatchInput): { text?: string; metadata?: Record<string, unknown> } {
  const metadata: Record<string, unknown> = {};
  if (a.kind !== undefined) metadata.kind = a.kind;
  if (a.workspaceId !== undefined) metadata.workspace_id = a.workspaceId;
  if (a.scope !== undefined) metadata.user_id = a.scope; // the canonical store's recall-pool key
  const patch: { text?: string; metadata?: Record<string, unknown> } = {};
  if (a.content !== undefined) patch.text = a.content;
  if (Object.keys(metadata).length > 0) patch.metadata = metadata;
  return patch;
}

export default defineTool({
  name: 'memory:update',
  capability: 'memory:write',
  description:
    'Edit one OR many memory entries: replace content and/or patch metadata (kind, workspaceId, scope/recall-pool) — preserving each id. Metadata patches are vec-safe (no re-embed). Single: { id, content?, kind?, … }. Many same patch: { ids:[…], kind?/scope?/… }. Many heterogeneous: items:[{ id, content?, kind?, … }]. Returns { ok, results:[{ ok, id, error? }], counts } — correlate by id, not by position; a not-found / timed-out id never fails the rest.',
  guidance: {
    when:
      'CONTENT: when the user corrects something you stored ("actually it\'s Daniel, not Dan") — pass `content`. METADATA HYGIENE: to re-tag a memory\'s `kind`, fix its `workspaceId`, or move it to the right recall `scope`/pool, pass those fields (no content needed); re-tag MANY at once via { ids:[…], kind } or items:[…]. Find the id via memory:search / memory:list first. For a content edit, tell the user ("Updating my memory: …").',
    notWhen:
      'To REMOVE a memory entirely, use memory:forget. To ADD a new memory, use memory:remember. Do not change `scope` casually — it moves which queries can recall the memory.',
    chaining:
      'memory:search → memory:update { ids:[…], kind } (bulk metadata hygiene). Bulk: single | items[] (or ids) → { ok, results, counts }; correlate by id not position; one failure never fails the rest.',
  },
  // Principal-gated is defineTool's DEFAULT (unauthed HTTP → 401); the former
  // `requirePrincipal: true` marker was not a declared input property and made
  // every overload fail (memory-taxonomy-and-debt-followups P-004).
  // The memory store is cross-workspace by design (shared tables scoped by
  // user-id / harness-slug, not by workspace; the handler reads getMemoryBackend,
  // never ctx.tx). crossWorkspace:true hands an UNSCOPED superuser session ('*')
  // the admin handle + a synthesized principal, so this works from a psu / fleet
  // session instead of failing `workspace_required` (EI-177/178/210 — the
  // workspace-tx gate was wrongly applied to memory:update; search + remember
  // already carry this).
  crossWorkspace: true,
  // NOTE: agentRoles/rolesQuota are not accepted on principal-gated tools —
  // definePrincipalGatedTool drops them (never copied to the def, never
  // enforced); the all-roles lists + quotas formerly here were dead inputs
  // (memory-taxonomy-and-debt-followups P-004).
  args: z
    .object({
      id: z.string().uuid('Memory ID must be a valid UUID').optional().describe('single-patch shorthand: the memory id'),
      ids: z
        .array(z.string().uuid('Memory ID must be a valid UUID'))
        .min(1)
        .max(200)
        .optional()
        .describe('patch MANY memories with the SAME metadata/content patch (homogeneous)'),
      items: z.array(itemSpec).min(1).max(200).optional().describe('patch many memories at once — each { id, content?, kind?, workspaceId?, scope? }'),
      ...PATCH_FIELDS, // the patch applied to the inline `id` / every id in `ids`
    })
    .refine(
      (a) =>
        (a.items?.length ?? 0) > 0 ||
        ((Boolean(a.id) || (a.ids?.length ?? 0) > 0) && hasAnyField(a)),
      {
        message:
          'pass { id, …patch } for one, { ids:[…], …patch } for many of the same patch, or items:[{ id, …patch }] for many; each must carry content and/or at least one metadata field (kind, workspaceId, scope)',
      },
    ),
  async handler(args) {
    // Normalize to a per-item list. items[] is heterogeneous; ids[] / inline id
    // share the top-level patch fields.
    const sharedPatch = { content: args.content, kind: args.kind, workspaceId: args.workspaceId, scope: args.scope };
    const list: PatchInput[] = args.items?.length
      ? args.items
      : args.ids?.length
        ? args.ids.map((id) => ({ id, ...sharedPatch }))
        : [{ id: args.id as string, ...sharedPatch }];

    const backend = getMemoryBackend();
    // B1: bound the availability probe so a wedged store yields memory_timeout,
    // not a hang. TOP-LEVEL gate — a store that can't answer `available()` can't
    // serve ANY patch, so the whole batch short-circuits.
    try {
      const avail = await withMemoryToolTimeout(backend.available(), 'memory:update available');
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
      list,
      async (it) => {
        // Per-item validation (the wire schema validates the top-level shape, but
        // homogeneous ids[] + heterogeneous items[] entries — and direct handler
        // callers that bypass the wrapper — are validated here so a bad item is
        // that item's { ok:false }, not a whole-batch reject).
        if (!UUID_RE.test(it.id)) {
          return { ok: false as const, id: it.id, error: 'Memory ID must be a valid UUID' };
        }
        if (!hasAnyField(it)) {
          return {
            ok: false as const,
            id: it.id,
            error: 'provide content and/or at least one metadata field (kind, workspaceId, scope)',
          };
        }
        try {
          await withMemoryToolTimeout(backend.update(it.id, toPatch(it)), 'memory:update update');
        } catch (err) {
          // B1: a wedged store yields memory_timeout, not a hang.
          if (err instanceof MemoryTimeoutError) {
            return { ok: false as const, id: it.id, reason: 'memory_timeout' as const };
          }
          // A well-formed id that names no existing memory is a clean negative
          // result, not a tool failure — the mem0 backend THROWS ("Memory with
          // ID … not found") for not-found, which escaped as a handler_error and
          // tripped the repeated-tool-error:memory:update:structural watchdog
          // (EI-486). Return a graceful { ok:false, error } instead. Other backend
          // failures (DB down, etc.) surface their message the same way.
          const message = err instanceof Error ? err.message : String(err);
          const error = /not\s*found/i.test(message) ? `Memory with ID ${it.id} not found` : message;
          return { ok: false as const, id: it.id, error };
        }
        // Learning signal (learning-system-audit P-050): an agent-driven CONTENT
        // correction feeds the extraction-adaptation loop (memory_feedback).
        // Skipped for a metadata-only patch (no text changed to learn from).
        // Fire-and-forget.
        if (it.content !== undefined) {
          void import('../../memory/feedback')
            .then(({ recordFeedback }) =>
              recordFeedback({ memId: it.id, userId: 'agent-tool', action: 'edit', newText: it.content }),
            )
            .catch(() => { /* best-effort */ });
        }
        return { ok: true as const, id: it.id };
      },
      { keyOf: (it) => ({ id: it.id }) },
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
