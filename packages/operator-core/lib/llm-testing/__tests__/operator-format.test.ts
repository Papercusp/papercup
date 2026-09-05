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
  noJargonInSay,
  groundedCountBeforeTool,
  noStrayBuiltinCalls,
  disambiguationCardRequired,
  oneSayPerTurn,
} from '../asserts/operator-format';
import type { RunSummary, TurnResult } from '@papercusp/testing-shell/llm';

function turn(text: string, overrides: Partial<TurnResult> = {}): TurnResult {
  return {
    assistantText: text,
    toolCalls: [],
    toolResults: [],
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
  it('WARNS (not errors) a 221-280 char say the runtime clamp handles cleanly', () => {
    // The product contract (P-002): the runtime clamps at a sentence/word
    // boundary ≤220, so a small raw overrun reaches the user in-cap. The
    // assert flags it as drift, not failure.
    const x = `${'word '.repeat(45).trim()}.`; // 225 chars
    const v = formatLength220(summary([turn(`<say>${x}</say>`)]));
    expect(v).toHaveLength(1);
    expect(v[0].severity).toBe('warn');
  });
  it('ERRORS a say beyond the 280-char tolerance (dump shape)', () => {
    const x = 'b'.repeat(300);
    const v = formatLength220(summary([turn(`<say>${x}</say>`)]));
    expect(v).toHaveLength(1);
    expect(v[0].severity).toBe('error');
  });
  it('fails when one of multiple says is over', () => {
    const ok = 'a'.repeat(100);
    const bad = 'b'.repeat(300);
    const v = formatLength220(summary([turn(`<say>${ok}</say>\n<say>${bad}</say>`)]));
    expect(v).toHaveLength(1);
    expect(v[0].severity).toBe('error');
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

describe('noJargonInSay', () => {
  it('passes plain prose (harness is operator vocabulary, not jargon)', () => {
    expect(noJargonInSay(summary([turn(
      '<say>Three harnesses active. Sheets is busiest — look there?</say>'
    )]))).toHaveLength(0);
  });
  it('fails a raw feature ID spoken aloud (F-FMT-002)', () => {
    expect(noJargonInSay(summary([turn(
      '<say>I shipped F-FMT-002 just now.</say>'
    )]))).toHaveLength(1);
  });
  it('fails a short feature ID spoken aloud (F-001)', () => {
    expect(noJargonInSay(summary([turn(
      '<say>F-001 is ready for review.</say>'
    )]))).toHaveLength(1);
  });
  it('fails the "chunk" jargon word (rule 5: "dig the chunks")', () => {
    expect(noJargonInSay(summary([turn(
      '<say>Let me dig the chunks for that.</say>'
    )]))).toHaveLength(1);
  });
  it('fails a spoken namespaced tool name (harness_status)', () => {
    expect(noJargonInSay(summary([turn(
      '<say>Calling harness_status to check.</say>'
    )]))).toHaveLength(1);
  });
  it('fails a colon tool name spoken aloud (chat:ask_choice)', () => {
    expect(noJargonInSay(summary([turn(
      '<say>I will use chat:ask_choice for that.</say>'
    )]))).toHaveLength(1);
  });
  it('fails an inline backtick symbol', () => {
    expect(noJargonInSay(summary([turn(
      '<say>Run `npm test` first.</say>'
    )]))).toHaveLength(1);
  });
  it('fails the "dash-delimited" jargon phrase', () => {
    expect(noJargonInSay(summary([turn(
      '<say>The flags match dash-delimited parsing.</say>'
    )]))).toHaveLength(1);
  });
  it('passes when jargon appears only OUTSIDE <say> (e.g. spawn attrs)', () => {
    expect(noJargonInSay(summary([turn(
      '<say>Kicking off the auth work now.</say><spawn role="worker" chunk="auth-mod-1"/>'
    )]))).toHaveLength(0);
  });
  it('no-op on a turn with no <say>', () => {
    expect(noJargonInSay(summary([turn('<spawn role="scoper"/>')]))).toHaveLength(0);
  });
});

describe('groundedCountBeforeTool', () => {
  it('passes a count claim backed by a tool call in the same turn', () => {
    expect(groundedCountBeforeTool(summary([turn(
      '<say>3 harnesses active right now.</say>',
      { toolCalls: [{ name: 'harness:status', input: {} }] },
    )]))).toHaveLength(0);
  });
  it('fails a count claim with zero tool calls anywhere', () => {
    expect(groundedCountBeforeTool(summary([turn(
      '<say>5 harnesses all in progress.</say>'
    )]))).toHaveLength(1);
  });
  it('passes a say with no count/state claim and no tools (greeting)', () => {
    expect(groundedCountBeforeTool(summary([turn(
      '<say>Welcome back. Want to dive in?</say>'
    )]))).toHaveLength(0);
  });
  it('fails "all N features are passing" with no tools', () => {
    expect(groundedCountBeforeTool(summary([turn(
      '<say>All 5 features are passing.</say>'
    )]))).toHaveLength(1);
  });
  it('passes a later count claim when an earlier turn called a tool', () => {
    expect(groundedCountBeforeTool(summary([
      turn('<say>Hi there.</say>', { toolCalls: [{ name: 'harness:list', input: {} }] }),
      turn('<say>3 issues open.</say>'),
    ]))).toHaveLength(0);
  });
  it('fails a count claim across turns when no tool was ever called', () => {
    expect(groundedCountBeforeTool(summary([
      turn('<say>Hi there.</say>'),
      turn('<say>3 issues open.</say>'),
    ]))).toHaveLength(1);
  });
});

describe('noStrayBuiltinCalls', () => {
  it('passes a turn that only calls agentmcp catalog tools', () => {
    expect(noStrayBuiltinCalls(summary([turn(
      '<say>One harness is active.</say>',
      { toolCalls: [{ name: 'harness:status', input: {} }, { name: 'harness_list', input: {} }] },
    )]))).toHaveLength(0);
  });
  it('fails a Bash call (the P-008 no-op "comment" incident)', () => {
    const v = noStrayBuiltinCalls(summary([turn(
      '<say>Checking now.</say>',
      { toolCalls: [{ name: 'Bash', input: { command: 'echo ok' } }] },
    )]));
    expect(v).toHaveLength(1);
    expect(v[0].claim).toContain("'Bash'");
  });
  it('fails a Task call', () => {
    expect(noStrayBuiltinCalls(summary([turn(
      '<say>Delegating.</say>',
      { toolCalls: [{ name: 'Task', input: {} }] },
    )]))).toHaveLength(1);
  });
  it('fails a ToolSearch call (the deferred-surface flailing loop)', () => {
    expect(noStrayBuiltinCalls(summary([turn(
      '<say>One sec.</say>',
      { toolCalls: [{ name: 'ToolSearch', input: { query: 'harness:status' } }] },
    )]))).toHaveLength(1);
  });
  it('flags every stray call, with the right evidence turn', () => {
    const v = noStrayBuiltinCalls(summary([
      turn('<say>a</say>'),
      turn('<say>b</say>', { toolCalls: [{ name: 'Bash', input: {} }, { name: 'Read', input: {} }] }),
    ]));
    expect(v).toHaveLength(2);
    expect(v.every((x) => x.evidenceTurnIdx === 1)).toBe(true);
  });
  it('no-op on turns without tool calls', () => {
    expect(noStrayBuiltinCalls(summary([turn('<say>quiet turn</say>')]))).toHaveLength(0);
  });
});

describe('oneSayPerTurn', () => {
  it('passes a turn with exactly one say', () => {
    expect(oneSayPerTurn(summary([turn('<say>One thing.</say>')]))).toHaveLength(0);
  });
  it('passes a turn with no say (sleep turn)', () => {
    expect(oneSayPerTurn(summary([turn('<sleep duration_minutes="10"/>')]))).toHaveLength(0);
  });
  it('fails a turn with two say blocks (the observed duplicate-say shape)', () => {
    const v = oneSayPerTurn(summary([turn(
      '<say>14 decisions waiting and one critical bug. Want the list?</say>\n<say>There are 14 decisions waiting plus a critical bug — want me to go through them?</say>',
    )]));
    expect(v).toHaveLength(1);
    expect(v[0].evidenceTurnIdx).toBe(0);
    expect(v[0].claim).toContain('2 <say>');
  });
  it('flags the right turn in a multi-turn run', () => {
    const v = oneSayPerTurn(summary([
      turn('<say>fine</say>'),
      turn('<say>a</say><say>b</say><say>c</say>'),
    ]));
    expect(v).toHaveLength(1);
    expect(v[0].evidenceTurnIdx).toBe(1);
    expect(v[0].claim).toContain('3 <say>');
  });
});

describe('disambiguationCardRequired', () => {
  const askChoiceCard = { kind: 'chat:ask_choice', options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }], voiceAnswerable: true, payload: {} };
  it('passes when an ask_choice card was emitted on any turn', () => {
    expect(disambiguationCardRequired(summary([
      turn('<say>Which one?</say>', { cards: [askChoiceCard] }),
    ]))).toHaveLength(0);
  });
  it('passes a card with ≥2 options even when its kind string differs', () => {
    expect(disambiguationCardRequired(summary([
      turn('<say>Which one?</say>', { cards: [{ ...askChoiceCard, kind: 'choice' }] }),
    ]))).toHaveLength(0);
  });
  it('fails a run that disambiguated in prose only (the original S16 finding)', () => {
    const v = disambiguationCardRequired(summary([
      turn('<say>I will go with the marketplace one since it looks busiest.</say>'),
      turn('<say>Approved it.</say>', { toolCalls: [{ name: 'harness:status', input: {} }] }),
    ]));
    expect(v).toHaveLength(1);
    expect(v[0].evidenceTurnIdx).toBe(1);
  });
  it('fails an empty run', () => {
    const v = disambiguationCardRequired(summary([]));
    expect(v).toHaveLength(1);
    expect(v[0].evidenceTurnIdx).toBeUndefined();
  });
});
