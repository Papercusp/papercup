/**
 * Registers `chat:ask_choice` with the chat-card registry. Imported
 * for its side effect by `apps/operator/lib/chat-cards/index.ts`.
 *
 * The card itself lives at `app/_components/chat/AskChoiceCard.tsx` —
 * this module is the registry-side glue, kept separate so adding a
 * new card-tool means a new Entry module + an index import, not
 * a touch to every consumer.
 *
 * Plan ref: phase-4-endpoint-system-2026-05-12.md § T2.1.
 */

import { AskChoiceCard, type AskChoiceArgs, type AskChoiceAnswered } from '@/app/_components/chat/AskChoiceCard';
import { registerCard } from './registry';

type AskChoicePayload = { picks: Array<{ option_id: string; label: string }> };

registerCard<AskChoiceArgs>('chat:ask_choice', ({ args, answered, onAnswer }) => {
  if (!args || typeof args !== 'object') return null;
  if (!args.question || !Array.isArray(args.options) || args.options.length === 0) {
    // Bad payload — let the consumer's default chip render instead.
    return null;
  }
  return (
    <AskChoiceCard
      args={args}
      answered={answered as AskChoiceAnswered | undefined}
      onAnswer={(commit: AskChoicePayload) => onAnswer(commit)}
    />
  );
});
