/**
 * panel.state — query whether each known panel is open or closed.
 */
import { z } from 'zod';
import { register } from '../registry';
import type { QueryDef } from '../types';

const StateArgs = z.object({});

const panelState: QueryDef<z.infer<typeof StateArgs>> = {
  id: 'panel.state',
  kind: 'query',
  description: 'Read the open/closed state of known panels (operator, oracle).',
  promptDescription:
    'Returns { operator: { open: boolean }, oracle: { open: boolean } }. ' +
    'Use to answer "is the operator panel open?"',
  schema: StateArgs,
  agents: ['oracle', 'operator'],
  audit: 'none',
  tier: 'fast-query',
  handler: async () => {
    if (typeof window === 'undefined') {
      // Server-side: we can't see browser-only panel state. Return unknown.
      return { operator: { open: null }, oracle: { open: null } };
    }
    const { sharedState } = await import('../../operator-shared-state');
    return {
      operator: { open: !!sharedState.open },
      // OracleDock state is not yet on a public shared bus; return null until PR 4.
      oracle: { open: null },
    };
  },
};

register(panelState);
