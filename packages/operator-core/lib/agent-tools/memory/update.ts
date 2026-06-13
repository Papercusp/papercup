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
    const avail = await backend.available();
    if (!avail.ok) {
      return {
        content: [{ type: 'text', text: JSON.stringify({ ok: false, reason: avail.reason }) }],
      };
    }
    await backend.update(validation.data.id, { text: validation.data.content });
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
