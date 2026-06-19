/**
 * memory:update — edit a memory's content.
 *
 * Brain calls when the user corrects a stored fact ("actually my name
 * is Daniel, not Dan"). Preserves the memory's id + lifecycle while
 * replacing content. Always informs the user out loud.
 * Storage rides the neutral `MemoryBackend` seam.
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { getMemoryBackend } from '../../memory/backend';
import { MemoryTimeoutError, withMemoryToolTimeout } from '../../memory/op-deadline';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default defineTool({
  name: 'memory:update',
  capability: 'memory:write',
  description: 'Replace the content of a memory entry while preserving its id and metadata.',
  guidance: {
    when:
      'When the user corrects something you previously stored ("actually it\'s Daniel, not Dan"). Find the entry id via memory:search or memory:list first, then call this with the corrected content. Inform the user ("Updating my memory: …").',
    notWhen:
      'To REMOVE a memory entirely, use memory:forget. To add a NEW memory without replacing one, use memory:remember.',
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
  args: z.object({
    id: z.string().uuid('Memory ID must be a valid UUID'),
    content: z.string().min(1).max(2000),
  }),
  async handler(args) {
    // Validate args; the defineTool wrapper will have validated in production,
    // but direct handler calls (e.g. in tests) bypass it.
    const validation = z.object({
      id: z.string().uuid('Memory ID must be a valid UUID'),
      content: z.string().min(1).max(2000),
    }).safeParse(args);

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
        backend.update(validation.data.id, { text: validation.data.content }),
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
    // Learning signal (learning-system-audit P-050): an agent-driven correction
    // feeds the extraction-adaptation loop (memory_feedback). Fire-and-forget.
    void import('../../memory/feedback')
      .then(({ recordFeedback }) =>
        recordFeedback({ memId: args.id, userId: 'agent-tool', action: 'edit', newText: args.content }),
      )
      .catch(() => { /* best-effort */ });
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
