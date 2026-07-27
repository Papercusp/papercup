/**
 * converse-wire-messages.test.ts — WI-6508.
 *
 * The owner's chat died with ~200 lines of `messages.N: Unrecognized keys:
 * "id", "seq", "report"`. Cause: `ChatMessage` is the UI's RENDER model and has
 * accreted presentation/persistence fields (`id`, `seq`, `report`, `tools`,
 * `agent`, `declined`), while the converse tool's `messages` arg accepts exactly
 * `{ role, content }` and is strict by design (EI-10883 — an undeclared arg is
 * rejected, never silently ignored). The provider passed the render model
 * through verbatim, so every field ever added to it was a live grenade.
 *
 * These pin the projection AND, more importantly, the property that actually
 * matters: whatever `ChatMessage` grows next, the wire object must carry ONLY
 * role and content. A test that merely checked the three keys named in the
 * owner's error would pass again the day someone adds a fourth.
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { toConverseWireMessages } from './OperatorConversationProvider';
import type { ChatMessage } from './chat/chat-types';

/** The converse tool's real `messages` element schema (operator/converse.ts). */
const WireMessage = z
  .object({
    role: z.union([z.literal('user'), z.literal('assistant'), z.literal('system')]),
    content: z.string(),
  })
  .strict();

/** A message carrying every extra field the render model currently defines. */
const fullyLoaded: ChatMessage = {
  role: 'assistant',
  content: 'hello',
  agent: 'papercup',
  id: 'opt-assistant-abc',
  seq: 42,
  // Shape-irrelevant on purpose: these two only need to EXIST as extra keys so
  // the projection can be shown to drop them. Cast through `unknown` rather than
  // hand-building a valid ReportBlock/ChatToolCall — pinning their real shapes
  // here would couple this test to schemas it is not about, and it would rot
  // every time one of them changes.
  report: { kind: 'status', title: 't' } as unknown as ChatMessage['report'],
  tools: [{ name: 'chat:ask_choice' }] as unknown as ChatMessage['tools'],
};

describe('toConverseWireMessages', () => {
  it('keeps only role and content', () => {
    expect(toConverseWireMessages([fullyLoaded])).toEqual([{ role: 'assistant', content: 'hello' }]);
  });

  it('produces objects the tool schema ACCEPTS — the owner-reported failure', () => {
    // Guards against the real regression: the raw render model is rejected...
    expect(WireMessage.safeParse(fullyLoaded).success).toBe(false);
    // ...and the projected one is accepted.
    for (const m of toConverseWireMessages([fullyLoaded])) {
      expect(WireMessage.safeParse(m).success).toBe(true);
    }
  });

  it('survives a FUTURE field added to ChatMessage', () => {
    // The property that matters. `id`/`seq`/`report` are just the three that
    // happened to exist when this broke; an omit-list fix would rot here.
    const withUnknownFuture = { ...fullyLoaded, somethingAddedNextQuarter: { deep: true } } as ChatMessage;
    expect(Object.keys(toConverseWireMessages([withUnknownFuture])[0]!).sort()).toEqual(['content', 'role']);
  });

  it('preserves order and every role across a long history', () => {
    const history: ChatMessage[] = Array.from({ length: 200 }, (_, i) => ({
      role: i % 3 === 0 ? 'user' : i % 3 === 1 ? 'assistant' : 'system',
      content: `m${i}`,
      id: `id-${i}`,
      seq: i,
    }));
    const wire = toConverseWireMessages(history);
    expect(wire).toHaveLength(200);
    expect(wire[0]).toEqual({ role: 'user', content: 'm0' });
    expect(wire[199]).toEqual({ role: 'assistant', content: 'm199' });
    for (const m of wire) expect(WireMessage.safeParse(m).success).toBe(true);
  });

  it('coerces a streaming message with no content yet to an empty string', () => {
    // content is typed string but is empty mid-stream; an undefined would fail
    // the strict schema on the very turn the user is watching.
    const streaming = { role: 'assistant' } as unknown as ChatMessage;
    expect(toConverseWireMessages([streaming])).toEqual([{ role: 'assistant', content: '' }]);
  });

  it('maps an empty history to an empty array', () => {
    expect(toConverseWireMessages([])).toEqual([]);
  });
});
