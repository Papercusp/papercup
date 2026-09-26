import { describe, expect, it } from 'vitest';
// @ts-ignore — operational JS verifier; behavior is exercised below without generated declarations.
import { assertAppliedActivation, requireHookContext } from '../../../scripts/verify-identities-r3.mjs';

const revision = { specificationRevision: 'spec', stateRevision: 'state' };
const snapshot = () => ({ generation: 8, delivered: 8, activation: { status: 'applied', desired: revision, applied: revision } });
const receipts = () => ['desired', 'prepared', 'applied'].map((phase, index) => ({
  id: 21 + index, phase, control_generation: 8, actor_id: 'owner', owner_id: 'owner',
  principal_id: 'principal', adv_session_id: 4, specification_revision: 'spec', state_revision: 'state',
  stack_refs: ['autonomy:su.mode-auto', 'ideation:su.mode-ideate'],
}));

describe('R3 confirmed-delivery acceptance', () => {
  it('accepts ordered matching receipts only after the delivery watermark advances', () => {
    expect(assertAppliedActivation(snapshot(), receipts(), 20, true)).toBe(8);
    expect(() => assertAppliedActivation({ ...snapshot(), delivered: 7 }, receipts(), 20, true)).toThrow(/confirmed applied/);
  });
  it.each(['desired', 'prepared', 'failed'])('rejects %s even when the transport exited successfully', (status) => {
    const state = snapshot();
    state.activation.status = status;
    expect(() => assertAppliedActivation(state, receipts(), 20, true)).toThrow(/confirmed applied/);
  });
  it('rejects stale revision and a missing or unordered receipt', () => {
    const state = snapshot();
    state.activation.applied = { ...revision, stateRevision: 'old' };
    expect(() => assertAppliedActivation(state, receipts(), 20, true)).toThrow();
    expect(() => assertAppliedActivation(snapshot(), receipts().filter((r) => r.phase !== 'prepared'), 20, true)).toThrow(/prepared/);
    const reordered = receipts();
    reordered[1].id = 19;
    expect(() => assertAppliedActivation(snapshot(), reordered, 20, true)).toThrow(/prepared/);
  });
  it('rejects another actor, missing launch attribution, and the wrong overlay', () => {
    for (const change of [{ actor_id: 'other' }, { adv_session_id: 0 }, { stack_refs: [] }]) {
      const rows = receipts();
      Object.assign(rows[2], change);
      expect(() => assertAppliedActivation(snapshot(), rows, 20, true)).toThrow(/applied/);
    }
    expect(() => assertAppliedActivation(snapshot(), receipts(), 20, false)).toThrow();
  });
  it('rejects silent hook exit and accepts only the actual turn-start envelope', () => {
    for (const output of ['', '{}', '{"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":"text"}}']) {
      expect(() => requireHookContext(output)).toThrow(/emitted no/);
    }
    expect(requireHookContext(JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: 'context' } }))).toBe('context');
  });
  it('allows a silent confirmation response without accepting unconfirmed activation', () => {
    expect(requireHookContext('', true)).toBeNull();
    expect(() => requireHookContext('{}', true)).toThrow();
    expect(() => assertAppliedActivation({ ...snapshot(), delivered: 7 }, receipts(), 20, true)).toThrow();
  });
});
