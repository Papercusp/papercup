/**
 * EI-2905 durable guard: appendTurn used to pass an undefined `conversationId` straight into its
 * INSERT `$1`, surfacing as postgres-js's cryptic `UNDEFINED_VALUE: Undefined values are not
 * allowed` (naming neither the tool nor the field). A named guard now fails fast + clear BEFORE any
 * DB call, so the next caller passing a bad id gets an obvious error. The guard runs before
 * getOrgPg(), so this is a pure unit test (no DB).
 */
import { describe, it, expect } from 'vitest';
import { appendTurn } from './operator-conversations';

describe('appendTurn conversationId guard (EI-2905)', () => {
  it('throws a NAMED error (not postgres UNDEFINED_VALUE) when conversationId is undefined', async () => {
    await expect(
      appendTurn({ conversationId: undefined as unknown as string, role: 'user', text: 'hi' }),
    ).rejects.toThrow(/appendTurn: conversationId is required/);
  });

  it('throws on an empty-string conversationId too', async () => {
    await expect(
      appendTurn({ conversationId: '', role: 'user', text: 'hi' }),
    ).rejects.toThrow(/conversationId is required/);
  });
});
