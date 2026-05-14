/**
 * Adversarial unit tests for asserts/operator-format helpers.
 * Plan: operator-behavior-tests-2026-05-14.md §4.1 + §7 P1 gate (b).
 */

import { describe, it, expect } from 'vitest';

import {
  continueAlwaysPairedWithSay,
  sleepNeverWithSay,
  oneQuestionMarkPerTurn,
  spawnWorkerHasChunk,
  noContinueWithAskChoice,
  noBareWhatCanIHelp,
  formatLength220,
  noMarkdownInSay,
  optionsCountWithinBounds,
} from '../asserts/operator-format';
import type { RunSummary, TurnResult } from '../types';

function turn(text: string, overrides: Partial<TurnResult> = {}): TurnResult {
  return {
    assistantText: text,
    toolCalls: [],
    cards: [],
    controlTags: [],
    costUsd: 0,
    latencyMs: 0,
    finishReason: 'done',
    rawSseTape: [],
    ...overrides,
  };
}

function summary(turns: TurnResult[]): RunSummary {
  return {
    runId: 't',
    scenarioId: 't',
    scenarioVersion: 1,
    identityHash: '0'.repeat(64),
    sutModel: 's', judgeModel: 'j',
    personaId: 'p', personaTraits: {} as RunSummary['personaTraits'],
    workspaceMode: 'isolated', transportMode: 'http-sse',
    turns,
    toolInvocations: [], continueChainRows: [],
    totalCostUsd: 0,
    startedAt: new Date(), finishedAt: new Date(),
    finishReason: 'completed',
    capBreaches: [],
  };
}

describe('continueAlwaysPairedWithSay', () => {
  it('passes when continue is paired with non-empty say', () => {
    const v = continueAlwaysPairedWithSay(summary([turn('<say>doing X</say><continue/>')]));
    expect(v).toHaveLength(0);
  });
  it('fails when continue is emitted alone', () => {
    const v = continueAlwaysPairedWithSay(summary([turn('<continue/>')]));
    expect(v).toHaveLength(1);
  });
  it('fails when paired with empty say', () => {
    const v = continueAlwaysPairedWithSay(summary([turn('<say></say><continue/>')]));
    expect(v).toHaveLength(1);
  });
  it('fails when paired with whitespace-only say', () => {
    const v = continueAlwaysPairedWithSay(summary([turn('<say>   \n  </say><continue/>')]));
    expect(v).toHaveLength(1);
  });
  it('passes turns without continue (no-op)', () => {
    const v = continueAlwaysPairedWithSay(summary([turn('<say>just talking</say>')]));
    expect(v).toHaveLength(0);
  });
});

describe('sleepNeverWithSay', () => {
  it('passes when sleep is alone', () => {
    const v = sleepNeverWithSay(summary([turn('<sleep duration_minutes="30"/>')]));
    expect(v).toHaveLength(0);
  });
  it('passes when sleep paired with empty say', () => {
    const v = sleepNeverWithSay(summary([turn('<say></say><sleep duration_minutes="30"/>')]));
    expect(v).toHaveLength(0);
  });
  it('fails when sleep paired with non-empty say', () => {
    const v = sleepNeverWithSay(summary([turn('<say>okay</say><sleep duration_minutes="30"/>')]));
    expect(v).toHaveLength(1);
  });
  it('passes turns without sleep (no-op)', () => {
    const v = sleepNeverWithSay(summary([turn('<say>just talking</say>')]));
    expect(v).toHaveLength(0);
  });
});

describe('oneQuestionMarkPerTurn', () => {
  it('passes with 0 questions', () => {
    expect(oneQuestionMarkPerTurn(summary([turn('<say>statement.</say>')]))).toHaveLength(0);
  });
  it('passes with exactly 1 question', () => {
    expect(oneQuestionMarkPerTurn(summary([turn('<say>which one?</say>')]))).toHaveLength(0);
  });
  it('fails with 2 stacked questions', () => {
    expect(oneQuestionMarkPerTurn(summary([turn('<say>which one? or the other?</say>')]))).toHaveLength(1);
  });
  it('ignores ? inside backtick code block', () => {
    expect(oneQuestionMarkPerTurn(summary([turn('<say>one ? here. `b?` should not count.</say>')]))).toHaveLength(0);
  });
  it('ignores ? inside quoted JSON string', () => {
    expect(oneQuestionMarkPerTurn(summary([turn('<say>here: "a?b?c" — that\'s one ?</say>')]))).toHaveLength(0);
  });
  it('ignores URL-encoded %3F', () => {
    expect(oneQuestionMarkPerTurn(summary([turn('<say>one ? plus %3F %3f decoded later.</say>')]))).toHaveLength(0);
  });
});

describe('spawnWorkerHasChunk', () => {
  it('fails worker without chunk', () => {
    expect(spawnWorkerHasChunk(summary([turn('<spawn role="worker"/>')]))).toHaveLength(1);
  });
  it('passes worker with chunk', () => {
    expect(spawnWorkerHasChunk(summary([turn('<spawn role="worker" chunk="C1"/>')]))).toHaveLength(0);
  });
  it('passes scoper without chunk (N/A)', () => {
    expect(spawnWorkerHasChunk(summary([turn('<spawn role="scoper"/>')]))).toHaveLength(0);
  });
  it('fails when two spawns and one missing chunk', () => {
    expect(spawnWorkerHasChunk(summary([turn(
      '<spawn role="worker" chunk="A"/><spawn role="worker"/>'
    )]))).toHaveLength(1);
  });
});

describe('noContinueWithAskChoice', () => {
  it('passes neither', () => {
    expect(noContinueWithAskChoice(summary([turn('<say>hi</say>')]))).toHaveLength(0);
  });
  it('passes only continue', () => {
    expect(noContinueWithAskChoice(summary([turn('<say>doing</say><continue/>')]))).toHaveLength(0);
  });
  it('passes only ask_choice', () => {
    expect(noContinueWithAskChoice(summary([
      turn('<say>pick:</say>', { toolCalls: [{ name: 'chat:ask_choice', input: {} }] }),
    ]))).toHaveLength(0);
  });
  it('fails when BOTH in same turn', () => {
    expect(noContinueWithAskChoice(summary([
      turn('<say>doing</say><continue/>', { toolCalls: [{ name: 'chat:ask_choice', input: {} }] }),
    ]))).toHaveLength(1);
  });
});

describe('noBareWhatCanIHelp', () => {
  it('passes substantive opener', () => {
    expect(noBareWhatCanIHelp(summary([turn(
      '<say>3 harnesses active. Sheets is busiest. Look there?</say>'
    )]))).toHaveLength(0);
  });
  it('fails "what can I help with"', () => {
    expect(noBareWhatCanIHelp(summary([turn(
      '<say>Hi, what can I help with?</say>'
    )]))).toHaveLength(1);
  });
  it('fails case-insensitive "What Can I Help"', () => {
    expect(noBareWhatCanIHelp(summary([turn(
      '<say>What Can I Help you with today?</say>'
    )]))).toHaveLength(1);
  });
  it('passes "what would help you" (different phrasing)', () => {
    expect(noBareWhatCanIHelp(summary([turn(
      '<say>3 things flagged — what would help you focus first?</say>'
    )]))).toHaveLength(0);
  });
});

describe('formatLength220', () => {
  it('passes 220-char say', () => {
    const x = 'a'.repeat(220);
    expect(formatLength220(summary([turn(`<say>${x}</say>`)]))).toHaveLength(0);
  });
  it('fails 221-char say', () => {
    const x = 'a'.repeat(221);
    expect(formatLength220(summary([turn(`<say>${x}</say>`)]))).toHaveLength(1);
  });
  it('fails when one of multiple says is over', () => {
    const ok = 'a'.repeat(100);
    const bad = 'b'.repeat(300);
    expect(formatLength220(summary([turn(`<say>${ok}</say>\n<say>${bad}</say>`)]))).toHaveLength(1);
  });
});

describe('noMarkdownInSay', () => {
  it('passes plain prose', () => {
    expect(noMarkdownInSay(summary([turn('<say>three harnesses active.</say>')]))).toHaveLength(0);
  });
  it('fails **bold**', () => {
    expect(noMarkdownInSay(summary([turn('<say>this is **important**.</say>')]))).toHaveLength(1);
  });
  it('fails # heading at start of line', () => {
    expect(noMarkdownInSay(summary([turn('<say># Header\nbody</say>')]))).toHaveLength(1);
  });
  it('fails - list', () => {
    expect(noMarkdownInSay(summary([turn('<say>- item one\n- item two</say>')]))).toHaveLength(1);
  });
  it('fails ```code fence```', () => {
    expect(noMarkdownInSay(summary([turn('<say>see ```js</say>')]))).toHaveLength(1);
  });
  it('passes apostrophes and URLs (not markdown)', () => {
    expect(noMarkdownInSay(summary([turn(
      "<say>it's at https://example.com/path — fine.</say>"
    )]))).toHaveLength(0);
  });
});

describe('optionsCountWithinBounds(2,3)', () => {
  const fn = optionsCountWithinBounds(2, 3);
  it('passes card with 2 options', () => {
    expect(fn(summary([turn('', {
      cards: [{ kind: 'chat:ask_choice', options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] }],
    })]))).toHaveLength(0);
  });
  it('passes card with 3 options', () => {
    expect(fn(summary([turn('', {
      cards: [{ kind: 'ask_choice', options: [
        { id: 'a', label: 'A' }, { id: 'b', label: 'B' }, { id: 'c', label: 'C' }
      ] }],
    })]))).toHaveLength(0);
  });
  it('fails card with 1 option', () => {
    expect(fn(summary([turn('', {
      cards: [{ kind: 'chat:ask_choice', options: [{ id: 'a', label: 'A' }] }],
    })]))).toHaveLength(1);
  });
  it('fails card with 4 options', () => {
    expect(fn(summary([turn('', {
      cards: [{ kind: 'chat:ask_choice', options: [
        { id: 'a', label: 'A' }, { id: 'b', label: 'B' }, { id: 'c', label: 'C' }, { id: 'd', label: 'D' }
      ] }],
    })]))).toHaveLength(1);
  });
  it('falls back to prose-list heuristic when no card', () => {
    expect(fn(summary([turn(
      '<say>options:\n1. first\n2. second\n3. third</say>'
    )]))).toHaveLength(0);
  });
  it('fails when no card and no list either', () => {
    expect(fn(summary([turn('<say>just one obvious thing.</say>')]))).toHaveLength(1);
  });
});
