import { describe, expect, it } from 'vitest';
import { operatorTurnToolsRevision } from './operator-turn-tools-revision';

describe('operatorTurnToolsRevision', () => {
  it('changes when a same-length live tail receives an in-place choice-card answer', () => {
    const unanswered = [{
      seq: 42,
      tools: [{ name: 'chat:ask_choice', input: { question: 'Continue?' } }],
    }];
    const answered = [{
      seq: 42,
      tools: [{
        name: 'chat:ask_choice',
        input: { question: 'Continue?' },
        answered: { picks: [], declined: true, at: 1234 },
      }],
    }];

    expect(answered).toHaveLength(unanswered.length);
    expect(operatorTurnToolsRevision(answered)).not.toBe(operatorTurnToolsRevision(unanswered));
  });

  it('ignores unrelated immutable row fields', () => {
    const tools = [{ name: 'chat:ask_choice', answered: { picks: [{ option_id: 'yes' }] } }];
    expect(operatorTurnToolsRevision([{ seq: 7, tools, text: 'before' }])).toBe(
      operatorTurnToolsRevision([{ seq: 7, tools, text: 'after' }]),
    );
  });
});
