/**
 * memory:forget — delete a memory by id.
 *
 * Brain calls when user says "forget X" or contradicts a stored fact.
 * Always informs the user out loud ("Removing that from memory").
 * Storage rides the neutral `MemoryBackend` seam.
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { getMemoryBackend } from '../../memory/backend';

export default defineTool({
  name: 'memory:forget',
  capability: 'memory:write',
  description: 'Delete a specific memory entry by id.',
  guidance: {
    when:
      'When the user explicitly says "forget X" / "don\'t remember that anymore" / "that\'s wrong, drop it". Always inform the user out loud ("Removed that from memory").',
    notWhen:
      'To CORRECT a memory (replace its content), use memory:update — preserves history. Only use forget for outright removal.',
  },
  // Principal-gated is defineTool's DEFAULT (unauthed HTTP → 401); the former
  // `requirePrincipal: true` marker was not a declared input property and made
  // every overload fail (memory-taxonomy-and-debt-followups P-004).
  // NOTE: agentRoles/rolesQuota are not accepted on principal-gated tools —
  // definePrincipalGatedTool drops them (never copied to the def, never
  // enforced); the all-roles lists + quotas formerly here were dead inputs
  // (memory-taxonomy-and-debt-followups P-004).
  args: z.object({
    id: z.string().min(1),
  }),
  async handler(args) {
    const backend = getMemoryBackend();
    const avail = await backend.available();
    if (!avail.ok) {
      return {
        content: [{ type: 'text', text: JSON.stringify({ ok: false, reason: avail.reason }) }],
      };
    }
    await backend.forget(args.id);
    // Learning signal (learning-system-audit P-050): an agent-driven forget is
    // the contradiction/staleness signal the extraction-adaptation loop reads
    // (memory_feedback → rebuildCustomInstructions). Fire-and-forget.
    void import('../../memory/feedback')
      .then(({ recordFeedback }) =>
        recordFeedback({ memId: args.id, userId: 'agent-tool', action: 'delete' }),
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
