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
import { originOf, agentSourceDetailOf } from './origin';

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

  it("infers 'agent' when no stamp is present (a pre-EI-10358 row, or a transport that never set uiClientId/role)", () => {
    expect(originOf({ metadata: { scope: 'user', created_by: 'user-1' } })).toBe('agent');
    expect(originOf({ metadata: {} })).toBe('agent');
    expect(originOf({})).toBe('agent');
  });

  it("classifies memory:remember's own stamp (source:'agent', EI-10358) as 'agent' too", () => {
    expect(originOf({ metadata: { source: 'agent', source_role: 'worker' } })).toBe('agent');
  });

  it("does not treat a non-string recovered_from or a foreign source as meaningful", () => {
    expect(originOf({ metadata: { recovered_from: 42 } })).toBe('agent');
    expect(originOf({ metadata: { source: 'somewhere-else' } })).toBe('agent');
  });
});

describe('agentSourceDetailOf — per-session attribution (EI-10358)', () => {
  it('reads source_role + source_session when both are stamped', () => {
    expect(
      agentSourceDetailOf({ metadata: { source: 'agent', source_role: 'worker', source_session: 'su-abc' } }),
    ).toEqual({ role: 'worker', session: 'su-abc' });
  });

  it('returns nulls when neither is stamped (pre-EI-10358 row)', () => {
    expect(agentSourceDetailOf({ metadata: { source: 'agent' } })).toEqual({ role: null, session: null });
    expect(agentSourceDetailOf({})).toEqual({ role: null, session: null });
  });

  it('ignores non-string values (defensive)', () => {
    expect(agentSourceDetailOf({ metadata: { source_role: 42, source_session: null } })).toEqual({
      role: null,
      session: null,
    });
  });
});
