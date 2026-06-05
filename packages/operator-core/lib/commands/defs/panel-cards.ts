/**
 * panel.cards / panel.dispatch-card / panel.dismiss-card.
 *
 * Voice + Oracle visibility into the operator panel feed. Reads come
 * from sharedState.cards (the panel publishes its visibleSuggestions
 * snapshot on every render). Writes dispatch window events the panel
 * listens for — same pattern as operator.scan / operator.approve.
 */
import { z } from 'zod';
import { register } from '../registry';
import { CommandError, type CommandDef, type QueryDef } from '../types';

const Empty = z.object({}).strict();

const PanelCardsArgs = z.object({
  status: z.enum(['pending', 'all']).optional().default('pending').describe('Default returns only pending cards.'),
  tier: z.enum(['low', 'medium', 'high', 'any']).optional().default('any'),
});
type PanelCardsArgsT = z.infer<typeof PanelCardsArgs>;

const panelCards: QueryDef<PanelCardsArgsT, { count: number; cards: any[] }> = {
  id: 'panel.cards',
  kind: 'query',
  description: 'List the suggestion cards currently visible in the operator panel.',
  promptDescription:
    'Returns { count, cards: [{id, title, action, tier, status, targetHarness, reason, autoDispatch}] }. ' +
    "Use to answer 'what's on my panel' or to find a card id to dispatch / dismiss. " +
    'Defaults to pending; pass status:"all" to include dispatched/dismissed.',
  schema: PanelCardsArgs,
  agents: ['oracle', 'operator', 'palette'],
  audit: 'sample',
  tier: 'reflexive',
  handler: async (args) => {
    if (typeof window === 'undefined') {
      // Server-side: panel state lives in the browser tab. Caller
      // should round-trip via the leader-bridge HTTP path. Returning
      // empty here is honest, not a silent fail.
      return { count: 0, cards: [] };
    }
    const { sharedState } = await import('../../operator-shared-state');
    let cards = sharedState.cards ?? [];
    if (args.status === 'pending') cards = cards.filter((c) => c.status === 'pending');
    if (args.tier !== 'any') cards = cards.filter((c) => c.tier === args.tier);
    return { count: cards.length, cards };
  },
};

const CardArgs = z.object({
  id: z.string().min(1).describe('Card id from panel.cards.'),
});
type CardArgsT = z.infer<typeof CardArgs>;

const dispatchCard: CommandDef<CardArgsT, { ok: true }> = {
  id: 'panel.dispatch-card',
  kind: 'command',
  description: 'Dispatch (run) a suggestion card by id.',
  promptDescription: 'Acts on the card the same way clicking its primary button does.',
  schema: CardArgs,
  agents: ['oracle', 'operator', 'palette'],
  browser: 'required',
  concurrent: 'queue',
  tier: 'reflexive',
  handler: async ({ id }) => {
    if (typeof window === 'undefined') {
      throw new CommandError({ code: 'wrong-process', message: 'must run in browser', retryable: false });
    }
    window.dispatchEvent(new CustomEvent('operator:dispatch-card', { detail: { id } }));
    return { ok: true };
  },
};

const dismissCard: CommandDef<CardArgsT, { ok: true }> = {
  id: 'panel.dismiss-card',
  kind: 'command',
  description: 'Dismiss a suggestion card by id.',
  schema: CardArgs,
  agents: ['oracle', 'operator', 'palette'],
  browser: 'required',
  concurrent: 'queue',
  tier: 'reflexive',
  handler: async ({ id }) => {
    if (typeof window === 'undefined') {
      throw new CommandError({ code: 'wrong-process', message: 'must run in browser', retryable: false });
    }
    window.dispatchEvent(new CustomEvent('operator:dismiss-card', { detail: { id } }));
    return { ok: true };
  },
};

register(panelCards);
register(dispatchCard);
register(dismissCard);

void Empty; // satisfy unused-import lint when schema lookups change