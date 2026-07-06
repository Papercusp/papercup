/**
 * Unit tests for `./_asserts.ts` — pure `RunSummary → Violation[]` builders.
 *
 * Regression coverage for EI-7923/WI-3229: S23/S24/S25 live re-runs showed the
 * model's ACTUAL merged output was correct, but two assert-authoring bugs
 * false-positived:
 *   1. `assertTextForbidsInTurnAfter`'s `sectionStart` anchor must match how
 *      models actually phrase the current-list header, or its anchor-not-found
 *      fallback scans the WHOLE turn and catches a legitimate "what changed"
 *      narration that correctly mentions the removed item's old title.
 *   2. A hardcoded hard `turnIdx` (`assertTextRequiresInTurn`/
 *      `assertTextForbidsInTurn`) false-fails when the model legitimately takes
 *      an extra turn (e.g. a clarifying question after compaction) before its
 *      substantive answer — `assertTextRequiresFromTurn`/
 *      `assertTextForbidsFromTurn` check a range instead of one fixed index.
 *
 * The `RunSummary`/`TurnResult` builders below construct minimal, fully-valid
 * fixtures — the builders read only `run.turns`, but every required field of
 * the real types is supplied so the fixtures are genuine, not casts.
 */

import { describe, it, expect } from 'vitest';
import type { RunSummary, TurnResult } from '@papercusp/testing-shell/llm';

import {
  assertTextForbidsInTurnAfter,
  assertTextForbidsFromTurn,
  assertTextRequiresFromTurn,
} from './_asserts';

function mkTurn(partial: Partial<TurnResult> = {}): TurnResult {
  return {
    assistantText: '',
    toolCalls: [],
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

const META = { name: 't', claim: 'c' };

describe('assertTextForbidsInTurnAfter', () => {
  it('does NOT violate on a correct merged reply that narrates the removal before the anchor (EI-7923 regression)', () => {
    // The exact live-observed S23 phrasing: a "Removed: ... debounce" preamble,
    // then a "Current open work items" table WITHOUT the removed row.
    const run = mkRun([
      mkTurn(),
      mkTurn({
        assistantText:
          "Here's the updated list. Two changes since the last check:\n\n" +
          '- **Removed:** `WI-7002` — *Flaky harness-fs-watcher debounce* (no longer open)\n\n' +
          '**Current open work items (5 total):**\n\n' +
          '| ID | Title |\n|---|---|\n| WI-7001 | ... |\n',
      }),
    ]);
    const violations = assertTextForbidsInTurnAfter(
      /debounce/i,
      1,
      /current (open work items|full list|list)|updated (full )?list/i,
      META,
    ).eval(run);
    expect(violations).toEqual([]);
  });

  it('still catches a genuinely wrong merge (removed row present AFTER the anchor)', () => {
    const run = mkRun([
      mkTurn(),
      mkTurn({
        assistantText:
          '**Current open work items:**\n\n| ID | Title |\n|---|---|\n| WI-7002 | ...debounce... |\n',
      }),
    ]);
    const violations = assertTextForbidsInTurnAfter(
      /debounce/i,
      1,
      /current (open work items|full list|list)|updated (full )?list/i,
      META,
    ).eval(run);
    expect(violations).toHaveLength(1);
    expect(violations[0].assertKind).toBe('custom:t');
  });

  it('the OLD narrow anchor (regression fixture) false-positives on the same correct reply', () => {
    const run = mkRun([
      mkTurn(),
      mkTurn({
        assistantText:
          "Here's the updated list. Two changes since the last check:\n\n" +
          '- **Removed:** `WI-7002` — *Flaky harness-fs-watcher debounce* (no longer open)\n\n' +
          '**Current open work items (5 total):**\n\n' +
          '| ID | Title |\n|---|---|\n| WI-7001 | ... |\n',
      }),
    ]);
    // Old anchor never matches this phrasing -> falls back to whole-turn scan -> false violation.
    const violations = assertTextForbidsInTurnAfter(/debounce/i, 1, /updated full list|current list/i, META).eval(run);
    expect(violations).toHaveLength(1); // documents the bug this WI fixed
  });
});

describe('assertTextRequiresFromTurn', () => {
  it('passes when the correct answer lands one turn later than a fixed index would assume (EI-7923 S24 regression)', () => {
    const run = mkRun([
      mkTurn({ assistantText: 'Here are the 5 open work items: ...' }),
      mkTurn({ assistantText: 'Could you clarify what list you want?' }),
      mkTurn({ assistantText: 'Here is the current full list: ... Sandbox npm-install EROFS ...' }),
    ]);
    const violations = assertTextRequiresFromTurn(/EROFS/i, 1, META).eval(run);
    expect(violations).toEqual([]);
  });

  it('still violates when no turn from the start index onward has the required content', () => {
    const run = mkRun([mkTurn({ assistantText: 'ok' }), mkTurn({ assistantText: 'still nothing' })]);
    const violations = assertTextRequiresFromTurn(/EROFS/i, 1, META).eval(run);
    expect(violations).toHaveLength(1);
  });
});

describe('assertTextForbidsFromTurn', () => {
  it('violates if a banned value appears in ANY turn from the start index onward, not just the first', () => {
    const run = mkRun([
      mkTurn({ assistantText: 'ok' }),
      mkTurn({ assistantText: 'clarifying...' }),
      mkTurn({ assistantText: 'the list still has debounce in it' }),
    ]);
    const violations = assertTextForbidsFromTurn(/debounce/i, 1, META).eval(run);
    expect(violations).toHaveLength(1);
    expect(violations[0].evidenceTurnIdx).toBe(2);
  });

  it('passes when the banned value never appears from the start index onward', () => {
    const run = mkRun([
      mkTurn({ assistantText: 'debounce is mentioned only in turn 0, before the checked range' }),
      mkTurn({ assistantText: 'clean answer' }),
    ]);
    const violations = assertTextForbidsFromTurn(/debounce/i, 1, META).eval(run);
    expect(violations).toEqual([]);
  });
});
