/**
 * origin.test.ts — EI-10363: the coarse memory-origin trichotomy derived from
 * the stamps write paths ALREADY leave on rows. The load-bearing case is
 * precedence: a settings-created write that drained late carries BOTH
 * `source: 'settings-page'` and `recovered_from` — authorship must win, or
 * the "added by you" count silently shrinks whenever the embedder has an
 * outage.
 *
 * Run: cd apps/operator && npx vitest run app/settings/user/memory/origin.test.ts
 */
import { describe, it, expect } from 'vitest';
import { originOf } from './origin';

describe('originOf — coarse write-origin from existing stamps (EI-10363)', () => {
  it("classifies a settings-page write as 'you'", () => {
    expect(originOf({ metadata: { source: 'settings-page' } })).toBe('you');
  });

  it("classifies a journal-drain / transcript-miner row as 'recovered'", () => {
    expect(originOf({ metadata: { recovered_from: 'write-journal' } })).toBe('recovered');
  });

  it('authorship outranks recovery: a settings write that drained late is still yours', () => {
    expect(
      originOf({ metadata: { source: 'settings-page', recovered_from: 'write-journal' } }),
    ).toBe('you');
  });

  it("infers 'agent' when no stamp is present (memory:remember leaves none)", () => {
    expect(originOf({ metadata: { scope: 'user', created_by: 'user-1' } })).toBe('agent');
    expect(originOf({ metadata: {} })).toBe('agent');
    expect(originOf({})).toBe('agent');
  });

  it("does not treat a non-string recovered_from or a foreign source as meaningful", () => {
    expect(originOf({ metadata: { recovered_from: 42 } })).toBe('agent');
    expect(originOf({ metadata: { source: 'somewhere-else' } })).toBe('agent');
  });
});
