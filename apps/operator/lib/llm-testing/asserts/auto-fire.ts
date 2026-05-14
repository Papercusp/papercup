import { registerEvaluator } from './index';
import type { Violation } from '../types';

/**
 * Auto-fire detection: a turn whose trigger is 'continue' or
 * 'user_says_ready' AND that was sent by the runner (not the sim-user)
 * is an auto-fire. The runner tracks this via continue-chain rows.
 */

registerEvaluator('auto_fire_happened', (a, run) => {
  const matches = run.continueChainRows.filter((r) =>
    a.trigger === 'continue' ? r.trigger === 'continue' : r.trigger === 'auto_fire_terminal',
  );
  if (matches.length === 0) {
    return [{
      assertKind: 'auto_fire_happened',
      severity: 'error',
      claim: `Expected auto-fire trigger='${a.trigger}' to occur — none seen.`,
    }];
  }
  return [];
});

registerEvaluator('auto_fire_did_not_happen', (_a, run) => {
  if (run.continueChainRows.length > 0) {
    return [{
      assertKind: 'auto_fire_did_not_happen',
      severity: 'error',
      claim: `Auto-fire happened ${run.continueChainRows.length}× but scenario forbids it.`,
    }];
  }
  return [];
});
