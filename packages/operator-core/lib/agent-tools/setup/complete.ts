import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { mergeSetupWizardState } from '../../endpoint-route/routes/desktop/setup-wizard-state';
import { readOperatorState } from '../../operator-state-pg';

/**
 * setup:complete — onboarding GRADUATION (agent-first-onboarding-2026-07-03
 * P-004/P-007): stamps `setup_wizard_state.finished_at`, after which the
 * first-run gateway routes to the normal app surface instead of onboarding.
 *
 * Idempotent: an existing finished_at is returned unchanged (a re-run of the
 * tutorial must not look like a fresh graduation); pass force to re-stamp.
 */
export default defineTool({
  name: 'setup:complete',
  profile: 'engineer',
  description:
    'Mark onboarding finished (writes setup_wizard_state.finished_at). The app then boots to its normal surface. Idempotent unless force.',
  capability: 'operator:write',
  guidance: {
    when: `ONLY at the end of the onboarding tutorial (graduation), after the required setup steps verify ok via setup:status. Tell the user what it means: the app now opens normally; the tutorial stays available via the Papercusp Tutorial icon.`,
    notWhen: `Mid-tutorial, or to "skip" onboarding on the user's behalf without asking — graduation is the user's moment, not a shortcut.`,
    seeAlso: ['setup:status (verify required steps before graduating)'],
  },
  requirePrincipal: false,
  agentRoles: ['operator', 'debugger'],
  args: z.object({
    force: z.boolean().optional().describe('Re-stamp finished_at even if already set'),
  }),
  async handler(args) {
    const current = await readOperatorState<{ finished_at?: string }>('setup_wizard_state');
    if (current?.finished_at && !args.force) {
      return {
        content: [
          { type: 'text', text: JSON.stringify({ finished_at: current.finished_at, alreadyFinished: true }) },
        ],
      };
    }
    const next = await mergeSetupWizardState({ finished_at: new Date().toISOString() });
    return {
      content: [{ type: 'text', text: JSON.stringify({ finished_at: next.finished_at, alreadyFinished: false }) }],
    };
  },
});
