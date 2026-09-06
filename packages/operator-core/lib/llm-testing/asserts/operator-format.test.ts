/**
 * Unit tests for the operator output-format detectors in
 * `./operator-format.ts` — pure `RunSummary → Violation[]` functions.
 *
 * Each detector is tested at the boundary: a VIOLATING input → exactly the
 * expected violation (asserting `assertKind`/`severity` and, where the source
 * sets one, an identifying field in `claim`), AND a CLEAN input → no violation.
 *
 * The `RunSummary`/`TurnResult` builders below construct minimal, fully-valid
 * fixtures — the detectors read only `run.turns`, but every required field of
 * the real types is supplied so the fixtures are genuine, not casts.
 */

import { describe, it, expect } from 'vitest';
import type { RunSummary, TurnResult, CardEvent, ToolCallEvent } from '@papercusp/testing-shell/llm';
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
  oneSayPerTurn,
  disambiguationCardRequired,
  VOICE_JARGON_LEXICON,
} from './operator-format';

// =============================================================================
// Fixture builders
// =============================================================================

function mkTurn(partial: Partial<TurnResult> = {}): TurnResult {
  return {
    assistantText: '',
    toolCalls: [],
    toolResults: [],
    cards: [],
    controlTags: [],
    costUsd: 0,
    latencyMs: 0,
    finishReason: 'done',
    rawSseTape: [],
    ...partial,
  };
}

function mkRun(turns: TurnResult[]): RunSummary {
  return {
    runId: 'r1',
    scenarioId: 's1',
    scenarioVersion: 1,
    scenarioTarget: 'operator',
    identityHash: 'h',
    sutModel: 'sonnet',
    judgeModel: 'sonnet',
    personaId: 'p',
    personaTraits: {
      verbosity: 'normal',
      politeness: 'neutral',
      clarification: 'sometimes',
      goalClarity: 'precise',
      interrupts: false,
      modality: 'voice',
    },
    workspaceMode: 'isolated',
    transportMode: 'in-process',
    turns,
    toolInvocations: [],
    continueChainRows: [],
    totalCostUsd: 0,
    startedAt: new Date(0),
    finishedAt: new Date(0),
    finishReason: 'completed',
    capBreaches: [],
  };
}

const tool = (name: string): ToolCallEvent => ({ name, input: {} });
const card = (kind: string, options?: Array<{ id: string; label: string }>): CardEvent => ({ kind, options });

// =============================================================================
// 1. continueAlwaysPairedWithSay
// =============================================================================

describe('continueAlwaysPairedWithSay', () => {
  it('flags <continue/> with no <say>', () => {
    const v = continueAlwaysPairedWithSay(mkRun([mkTurn({ assistantText: '<continue/>' })]));
    expect(v).toHaveLength(1);
    expect(v[0].assertKind).toBe('continueAlwaysPairedWithSay');
    expect(v[0].severity).toBe('error');
    expect(v[0].evidenceTurnIdx).toBe(0);
  });

  it('flags <continue/> with an empty <say>', () => {
    const v = continueAlwaysPairedWithSay(mkRun([mkTurn({ assistantText: '<say></say><continue/>' })]));
    expect(v).toHaveLength(1);
  });

  it('passes when <continue/> is paired with a non-empty <say>', () => {
    const v = continueAlwaysPairedWithSay(mkRun([mkTurn({ assistantText: '<say>Working on it.</say><continue/>' })]));
    expect(v).toHaveLength(0);
  });

  it('passes when there is no <continue/> at all', () => {
    const v = continueAlwaysPairedWithSay(mkRun([mkTurn({ assistantText: '<say>Done.</say>' })]));
    expect(v).toHaveLength(0);
  });
});

// =============================================================================
// 2. sleepNeverWithSay
// =============================================================================

describe('sleepNeverWithSay', () => {
  it('flags <sleep/> emitted alongside a non-empty <say>', () => {
    const v = sleepNeverWithSay(mkRun([mkTurn({ assistantText: '<say>Going quiet now.</say><sleep/>' })]));
    expect(v).toHaveLength(1);
    expect(v[0].assertKind).toBe('sleepNeverWithSay');
    expect(v[0].severity).toBe('error');
  });

  it('passes when <sleep/> is silent (no <say>)', () => {
    const v = sleepNeverWithSay(mkRun([mkTurn({ assistantText: '<sleep/>' })]));
    expect(v).toHaveLength(0);
  });

  it('passes when <sleep/> has an empty <say>', () => {
    const v = sleepNeverWithSay(mkRun([mkTurn({ assistantText: '<say></say><sleep/>' })]));
    expect(v).toHaveLength(0);
  });
});

// =============================================================================
// 3. oneQuestionMarkPerTurn
// =============================================================================

describe('oneQuestionMarkPerTurn', () => {
  it('flags two stacked questions in one <say>', () => {
    const v = oneQuestionMarkPerTurn(mkRun([mkTurn({ assistantText: '<say>Ready now? Or later?</say>' })]));
    expect(v).toHaveLength(1);
    expect(v[0].assertKind).toBe('oneQuestionMarkPerTurn');
    expect(v[0].claim).toMatch(/stacked 2/);
  });

  it('passes with exactly one question', () => {
    const v = oneQuestionMarkPerTurn(mkRun([mkTurn({ assistantText: '<say>Ready to go?</say>' })]));
    expect(v).toHaveLength(0);
  });

  it('does not count a ? inside a quoted JSON string (adversarial) — one real ? passes', () => {
    // The "what now?" lives inside double quotes; its ? is stripped, leaving one real ?.
    const v = oneQuestionMarkPerTurn(mkRun([mkTurn({ assistantText: '<say>The "what now?" task. Continue?</say>' })]));
    expect(v).toHaveLength(0);
  });
});

// =============================================================================
// 4. spawnWorkerHasChunk
// =============================================================================

describe('spawnWorkerHasChunk', () => {
  it('flags a worker spawn missing chunk=', () => {
    const v = spawnWorkerHasChunk(mkRun([mkTurn({ assistantText: '<spawn role="worker"/>' })]));
    expect(v).toHaveLength(1);
    expect(v[0].assertKind).toBe('spawnWorkerHasChunk');
    expect(v[0].severity).toBe('error');
  });

  it('passes when the worker spawn includes chunk=', () => {
    const v = spawnWorkerHasChunk(mkRun([mkTurn({ assistantText: '<spawn role="worker" chunk="C-1"/>' })]));
    expect(v).toHaveLength(0);
  });

  it('passes for a non-worker spawn without chunk', () => {
    const v = spawnWorkerHasChunk(mkRun([mkTurn({ assistantText: '<spawn role="scoper"/>' })]));
    expect(v).toHaveLength(0);
  });
});

// =============================================================================
// 5. noContinueWithAskChoice
// =============================================================================

describe('noContinueWithAskChoice', () => {
  it('flags <continue/> AND a chat:ask_choice tool call in the same turn', () => {
    const v = noContinueWithAskChoice(
      mkRun([mkTurn({ assistantText: '<continue/>', toolCalls: [tool('chat:ask_choice')] })]),
    );
    expect(v).toHaveLength(1);
    expect(v[0].assertKind).toBe('noContinueWithAskChoice');
    expect(v[0].severity).toBe('error');
  });

  it('passes with <continue/> but no ask_choice', () => {
    const v = noContinueWithAskChoice(
      mkRun([mkTurn({ assistantText: '<continue/>', toolCalls: [tool('harness:status')] })]),
    );
    expect(v).toHaveLength(0);
  });

  it('passes with ask_choice but no <continue/>', () => {
    const v = noContinueWithAskChoice(
      mkRun([mkTurn({ assistantText: '<say>Pick one.</say>', toolCalls: [tool('chat:ask_choice')] })]),
    );
    expect(v).toHaveLength(0);
  });
});

// =============================================================================
// 6. noBareWhatCanIHelp
// =============================================================================

describe('noBareWhatCanIHelp', () => {
  it('flags the banned opener phrase on turn 0', () => {
    const v = noBareWhatCanIHelp(mkRun([mkTurn({ assistantText: '<say>Hi, what can I help with?</say>' })]));
    expect(v).toHaveLength(1);
    expect(v[0].assertKind).toBe('noBareWhatCanIHelp');
    expect(v[0].evidenceTurnIdx).toBe(0);
  });

  it('passes for a substantive opener', () => {
    const v = noBareWhatCanIHelp(mkRun([mkTurn({ assistantText: '<say>3 harnesses active; sheets is busiest.</say>' })]));
    expect(v).toHaveLength(0);
  });

  it('passes for an empty run (no turn 0)', () => {
    const v = noBareWhatCanIHelp(mkRun([]));
    expect(v).toHaveLength(0);
  });
});

// =============================================================================
// 7. formatLength220 (220 ok / 221 warn / >280 error boundaries)
// =============================================================================

describe('formatLength220', () => {
  const sayOf = (n: number) => `<say>${'a'.repeat(n)}</say>`;

  it('passes a <say> of exactly 220 chars (the cap)', () => {
    const v = formatLength220(mkRun([mkTurn({ assistantText: sayOf(220) })]));
    expect(v).toHaveLength(0);
  });

  it('warns at 221 chars — the runtime clamp lands ≤221, so it is graceful drift', () => {
    const v = formatLength220(mkRun([mkTurn({ assistantText: sayOf(221) })]));
    expect(v).toHaveLength(1);
    expect(v[0].assertKind).toBe('formatLength220');
    expect(v[0].severity).toBe('warn');
  });

  it('errors past the 280-char tolerance — a dump the clamp would amputate', () => {
    const v = formatLength220(mkRun([mkTurn({ assistantText: sayOf(281) })]));
    expect(v).toHaveLength(1);
    expect(v[0].severity).toBe('error');
  });
});

// =============================================================================
// 8. noMarkdownInSay
// =============================================================================

describe('noMarkdownInSay', () => {
  it('flags **bold** inside <say>', () => {
    const v = noMarkdownInSay(mkRun([mkTurn({ assistantText: '<say>This is **bold** text.</say>' })]));
    expect(v).toHaveLength(1);
    expect(v[0].assertKind).toBe('noMarkdownInSay');
    expect(v[0].severity).toBe('error');
  });

  it('flags a markdown list inside <say>', () => {
    const v = noMarkdownInSay(mkRun([mkTurn({ assistantText: '<say>- item one\n- item two</say>' })]));
    expect(v).toHaveLength(1);
  });

  it('flags a code fence inside <say>', () => {
    const v = noMarkdownInSay(mkRun([mkTurn({ assistantText: '<say>```code```</say>' })]));
    expect(v).toHaveLength(1);
  });

  it('passes plain prose (apostrophes and hyphens are not markdown)', () => {
    const v = noMarkdownInSay(mkRun([mkTurn({ assistantText: "<say>It's a low-stakes change, all set.</say>" })]));
    expect(v).toHaveLength(0);
  });
});

// =============================================================================
// 9. optionsCountWithinBounds (factory: min/max)
// =============================================================================

describe('optionsCountWithinBounds(2,3)', () => {
  const detector = optionsCountWithinBounds(2, 3);

  it('passes a final card with 2 options (in bounds)', () => {
    const v = detector(mkRun([mkTurn({ cards: [card('chat:ask_choice', [
      { id: 'a', label: 'A' }, { id: 'b', label: 'B' },
    ])] })]));
    expect(v).toHaveLength(0);
  });

  it('flags too few options (1 < min)', () => {
    const v = detector(mkRun([mkTurn({ cards: [card('ask_choice', [{ id: 'a', label: 'A' }])] })]));
    expect(v).toHaveLength(1);
    expect(v[0].assertKind).toBe('optionsCountWithinBounds');
    expect(v[0].claim).toMatch(/surfaced 1 options/);
  });

  it('flags too many options (4 > max)', () => {
    const v = detector(mkRun([mkTurn({ cards: [card('chat:ask_choice', [
      { id: 'a', label: 'A' }, { id: 'b', label: 'B' }, { id: 'c', label: 'C' }, { id: 'd', label: 'D' },
    ])] })]));
    expect(v).toHaveLength(1);
    expect(v[0].claim).toMatch(/surfaced 4 options/);
  });

  it('flags an empty run with a dedicated claim', () => {
    const v = detector(mkRun([]));
    expect(v).toHaveLength(1);
    expect(v[0].claim).toMatch(/No turns to evaluate/);
  });
});

// =============================================================================
// 10. noJargonInSay
// =============================================================================

describe('noJargonInSay', () => {
  it('flags a VOICE_JARGON_LEXICON term ("chunk") spoken aloud', () => {
    expect(VOICE_JARGON_LEXICON).toContain('chunk');
    const v = noJargonInSay(mkRun([mkTurn({ assistantText: '<say>I will split it into a chunk now.</say>' })]));
    expect(v).toHaveLength(1);
    expect(v[0].assertKind).toBe('noJargonInSay');
    expect(v[0].claim).toMatch(/internal jargon/);
  });

  it('flags a raw feature ID spoken aloud', () => {
    const v = noJargonInSay(mkRun([mkTurn({ assistantText: '<say>F-FMT-002 is ready for review.</say>' })]));
    expect(v).toHaveLength(1);
    expect(v[0].claim).toMatch(/a raw feature ID/);
  });

  it('flags a namespaced tool name spoken aloud', () => {
    const v = noJargonInSay(mkRun([mkTurn({ assistantText: '<say>Let me run harness_status for you.</say>' })]));
    expect(v).toHaveLength(1);
    expect(v[0].claim).toMatch(/a tool name/);
  });

  it('passes plain layperson speech (no ID, tool, backtick, or jargon term)', () => {
    const v = noJargonInSay(mkRun([mkTurn({ assistantText: '<say>I will split it into smaller pieces now.</say>' })]));
    expect(v).toHaveLength(0);
  });
});

// =============================================================================
// 11. groundedCountBeforeTool
// =============================================================================

describe('groundedCountBeforeTool', () => {
  it('flags a count claim made before any tool has been called', () => {
    const v = groundedCountBeforeTool(mkRun([mkTurn({ assistantText: '<say>3 harnesses are active.</say>' })]));
    expect(v).toHaveLength(1);
    expect(v[0].assertKind).toBe('groundedCountBeforeTool');
    expect(v[0].severity).toBe('error');
  });

  it('flags a blanket state claim made before any tool', () => {
    const v = groundedCountBeforeTool(mkRun([mkTurn({ assistantText: '<say>All of them are passing.</say>' })]));
    expect(v).toHaveLength(1);
  });

  it('passes the same count claim once a tool was called this turn', () => {
    const v = groundedCountBeforeTool(
      mkRun([mkTurn({ assistantText: '<say>3 harnesses are active.</say>', toolCalls: [tool('harness:status')] })]),
    );
    expect(v).toHaveLength(0);
  });

  it('passes a turn with no count/state claim', () => {
    const v = groundedCountBeforeTool(mkRun([mkTurn({ assistantText: '<say>Let me take a look.</say>' })]));
    expect(v).toHaveLength(0);
  });
});

// =============================================================================
// 12. noStrayBuiltinCalls
// =============================================================================

describe('noStrayBuiltinCalls', () => {
  it('flags a Claude built-in tool call (Bash)', () => {
    const v = noStrayBuiltinCalls(mkRun([mkTurn({ toolCalls: [tool('Bash')] })]));
    expect(v).toHaveLength(1);
    expect(v[0].assertKind).toBe('noStrayBuiltinCalls');
    expect(v[0].claim).toMatch(/'Bash'/);
  });

  it('flags a ToolSearch call (flailing loop)', () => {
    const v = noStrayBuiltinCalls(mkRun([mkTurn({ toolCalls: [tool('ToolSearch')] })]));
    expect(v).toHaveLength(1);
  });

  it('passes a legitimate agentmcp catalog tool call', () => {
    const v = noStrayBuiltinCalls(mkRun([mkTurn({ toolCalls: [tool('harness:status')] })]));
    expect(v).toHaveLength(0);
  });
});

// =============================================================================
// 12b. oneSayPerTurn
// =============================================================================

describe('oneSayPerTurn', () => {
  it('flags two <say> blocks in one turn', () => {
    const v = oneSayPerTurn(mkRun([mkTurn({ assistantText: '<say>First.</say><say>Second.</say>' })]));
    expect(v).toHaveLength(1);
    expect(v[0].assertKind).toBe('oneSayPerTurn');
    expect(v[0].claim).toMatch(/2 <say> blocks/);
  });

  it('passes exactly one <say> block', () => {
    const v = oneSayPerTurn(mkRun([mkTurn({ assistantText: '<say>Only one.</say>' })]));
    expect(v).toHaveLength(0);
  });

  it('passes a turn with no <say> block', () => {
    const v = oneSayPerTurn(mkRun([mkTurn({ assistantText: '<continue/>' })]));
    expect(v).toHaveLength(0);
  });
});

// =============================================================================
// 13. disambiguationCardRequired
// =============================================================================

describe('disambiguationCardRequired', () => {
  it('flags a run that never produced a choice card', () => {
    const v = disambiguationCardRequired(mkRun([mkTurn({ assistantText: '<say>I approved the busy one.</say>' })]));
    expect(v).toHaveLength(1);
    expect(v[0].assertKind).toBe('disambiguationCardRequired');
    expect(v[0].severity).toBe('error');
    expect(v[0].evidenceTurnIdx).toBe(0);
  });

  it('passes when an ask_choice card was emitted', () => {
    const v = disambiguationCardRequired(mkRun([mkTurn({ cards: [card('chat:ask_choice', [
      { id: 'a', label: 'A' }, { id: 'b', label: 'B' },
    ])] })]));
    expect(v).toHaveLength(0);
  });

  it('passes when any card carries ≥2 options', () => {
    const v = disambiguationCardRequired(mkRun([mkTurn({ cards: [card('state', [
      { id: 'a', label: 'A' }, { id: 'b', label: 'B' },
    ])] })]));
    expect(v).toHaveLength(0);
  });
});
