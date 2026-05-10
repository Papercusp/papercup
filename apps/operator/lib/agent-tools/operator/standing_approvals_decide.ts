/**
 * operator:standing_approvals_decide — approve or dismiss a standing-
 * approval candidate. Approve appends a [STANDING-APPROVE] entry to
 * the operator preferences.md; both decisions refresh the candidates
 * list so the pair drops out.
 *
 * Wraps the POST half of /api/agent-mcp/operator-standing-approvals.
 * Operator-role only — this writes to the operator preferences file
 * which downstream scans treat as authoritative.
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { appendPreferenceEntry } from '@/lib/operator-preferences';
import { refreshCandidates } from '@/lib/operator-standing-candidates';

export default defineTool({
  name: 'operator:standing_approvals_decide',
  description: 'Approve or dismiss a standing-approval candidate. Approve writes a [STANDING-APPROVE] entry to operator preferences.',
  capability: 'operator:write',
  requirePrincipal: false,
  roles: ['operator'],
  rolesQuota: { operator: { perRun: 50 } },
  args: z.object({
    capability: z.string().min(1),
    targetHarness: z.string().min(1),
    decision: z.enum(['approve', 'dismiss']),
  }),
  async handler(args) {
    if (args.decision === 'approve') {
      const today = new Date().toISOString().slice(0, 10);
      const entry = `- [OPERATOR-PROPOSED-USER-CONFIRMED-${today}] [STANDING-APPROVE]\n  capability=${args.capability}, target=${args.targetHarness}\n  pattern: ≥3 silent dispatches in 24h\n  user confirmed: ${new Date().toISOString()}`;
      await appendPreferenceEntry(entry);
    }
    await refreshCandidates().catch(() => {});
    return {
      content: [{ type: 'text', text: JSON.stringify({ ok: true, decision: args.decision }) }],
    };
  },
});
