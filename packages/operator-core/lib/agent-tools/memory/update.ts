/**
 * memory:update — edit a memory's content AND/OR patch its metadata.
 *
 * Brain calls when the user corrects a stored fact ("actually my name is Daniel,
 * not Dan") → a CONTENT edit. Agents/superusers also call it for METADATA HYGIENE
 * — re-tag a memory's `kind`, fix its `workspaceId`, or move it to the right recall
 * `scope`/pool — without rewriting the text. The metadata patch is a vec-safe merge
 * on the canonical store (no re-embed); before this, metadata was unfixable through
 * any tool (mem0's update is text-only), forcing raw DB surgery (EI-2032). Preserves
 * the memory's id + lifecycle. Storage rides the neutral `MemoryBackend` seam.
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { getMemoryBackend } from '../../memory/backend';
import { MemoryTimeoutError, withMemoryToolTimeout } from '../../memory/op-deadline';

/** id + at-least-one of {content, kind, workspaceId, scope}. */
const UPDATE_ARGS = z
  .object({
    id: z.string().uuid('Memory ID must be a valid UUID'),
    content: z.string().min(1).max(2000).optional().describe('replacement fact body (a CONTENT edit)'),
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
  })
  .refine(
    (a) =>
      a.content !== undefined ||
      a.kind !== undefined ||
      a.workspaceId !== undefined ||
      a.scope !== undefined,
    { message: 'provide content and/or at least one metadata field (kind, workspaceId, scope)' },
  );

/** Build the neutral UpdatePatch from validated args. */
function toPatch(a: z.infer<typeof UPDATE_ARGS>): { text?: string; metadata?: Record<string, unknown> } {
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
    'Edit a memory entry: replace its content and/or patch its metadata (kind, workspaceId, scope/recall-pool) — preserving its id. Metadata patches are vec-safe (no re-embed).',
  guidance: {
    when:
      'CONTENT: when the user corrects something you stored ("actually it\'s Daniel, not Dan") — pass `content`. METADATA HYGIENE: to re-tag a memory\'s `kind`, fix its `workspaceId`, or move it to the right recall `scope`/pool, pass those fields (no content needed). Find the id via memory:search / memory:list first. For a content edit, tell the user ("Updating my memory: …").',
    notWhen:
      'To REMOVE a memory entirely, use memory:forget. To ADD a new memory, use memory:remember. Do not change `scope` casually — it moves which queries can recall the memory.',
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
  args: UPDATE_ARGS,
  async handler(args) {
    // Validate args; the defineTool wrapper will have validated in production,
    // but direct handler calls (e.g. in tests) bypass it.
    const validation = UPDATE_ARGS.safeParse(args);

    if (!validation.success) {
      const errors = validation.error.issues.map((e) => `${e.path.join('.')}: ${e.message}`).join('; ');
      return {
        content: [{ type: 'text', text: JSON.stringify({ ok: false, error: errors }) }],
      };
    }

    const backend = getMemoryBackend();
    // B1: bound the probe so a wedged store yields memory_timeout, not a hang.
    try {
      const avail = await withMemoryToolTimeout(backend.available(), 'memory:update available');
      if (!avail.ok) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ ok: false, reason: avail.reason }) }],
        };
      }
    } catch (err) {
      if (err instanceof MemoryTimeoutError) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ ok: false, reason: 'memory_timeout' }) }],
        };
      }
      throw err;
    }
    try {
      await withMemoryToolTimeout(
        backend.update(validation.data.id, toPatch(validation.data)),
        'memory:update update',
      );
    } catch (err) {
      // B1: a wedged store yields memory_timeout, not a hang. Mapped before the
      // not-found/message handling below so a timeout never masquerades as a
      // backend-message error.
      if (err instanceof MemoryTimeoutError) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ ok: false, reason: 'memory_timeout' }) }],
        };
      }
      // A well-formed id that names no existing memory is a clean negative
      // result, not a tool failure — the mem0 backend THROWS ("Memory with
      // ID … not found") for not-found, which escaped as a handler_error and
      // tripped the repeated-tool-error:memory:update:structural watchdog
      // (EI-486). Return a graceful {ok:false,error} instead, mirroring the
      // not-found contract of work_items:set_state. Other backend failures
      // (DB down, etc.) surface their message the same way rather than crashing.
      const message = err instanceof Error ? err.message : String(err);
      const error = /not\s*found/i.test(message)
        ? `Memory with ID ${validation.data.id} not found`
        : message;
      return {
        content: [{ type: 'text', text: JSON.stringify({ ok: false, error }) }],
      };
    }
    // Learning signal (learning-system-audit P-050): an agent-driven CONTENT
    // correction feeds the extraction-adaptation loop (memory_feedback). Skipped
    // for a metadata-only patch (no text changed to learn from). Fire-and-forget.
    if (validation.data.content !== undefined) {
      void import('../../memory/feedback')
        .then(({ recordFeedback }) =>
          recordFeedback({ memId: args.id, userId: 'agent-tool', action: 'edit', newText: validation.data.content }),
        )
        .catch(() => { /* best-effort */ });
    }
    // Live-refresh the settings memory page (userMemory.list sync query) —
    // fire-and-forget, never load-bearing (memory-settings-page-refresh P-008).
    void import('../../sync-sse')
      .then(({ notifySyncInvalidate }) => notifySyncInvalidate('userMemory.list'))
      .catch(() => { /* best-effort */ });
    return {
      content: [{ type: 'text', text: JSON.stringify({ ok: true }) }],
    };
  },
});
