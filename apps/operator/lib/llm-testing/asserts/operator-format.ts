/**
 * Operator-specific format asserts.
 *
 * Plan: operator-behavior-tests-2026-05-14.md §4.1.
 *
 * Each helper is a `kind: 'custom'` evaluator registered against
 * `name === '<helperName>'`. Scenarios reference them as:
 *
 *   { kind: 'custom', name: 'continueAlwaysPairedWithSay', eval: continueAlwaysPairedWithSay }
 *
 * Helpers are pure functions over RunSummary so they can be unit-
 * tested against synthetic transcripts without PG/LLM.
 */

import type { RunSummary, Violation, TurnResult } from '../types';

// =============================================================================
// 1. <continue/> paired with non-empty <say>
// =============================================================================

/** Strip all `<tag>...</tag>` and self-closing `<tag/>` blocks from text. */
function stripAllTags(text: string): string {
  return text
    .replace(/<say[^>]*>([\s\S]*?)<\/say>/gi, '$1')
    .replace(/<set_mode[^>]*>[\s\S]*?<\/set_mode>/gi, '')
    .replace(/<(continue|sleep|spawn)(\s[^>]*)?\/?>/gi, '');
}

function extractSayContent(text: string): string {
  const matches = [...text.matchAll(/<say[^>]*>([\s\S]*?)<\/say>/gi)];
  return matches.map((m) => m[1]).join(' ').trim();
}

function hasContinueTag(text: string): boolean {
  return /<continue(\s[^>]*)?\/?>/i.test(text);
}

function hasSleepTag(text: string): boolean {
  return /<sleep(\s[^>]*)?\/?>/i.test(text);
}

export function continueAlwaysPairedWithSay(run: RunSummary): Violation[] {
  const violations: Violation[] = [];
  for (let i = 0; i < run.turns.length; i++) {
    const t = run.turns[i];
    if (!hasContinueTag(t.assistantText)) continue;
    const sayContent = extractSayContent(t.assistantText).trim();
    if (!sayContent) {
      violations.push({
        assertKind: 'continueAlwaysPairedWithSay',
        severity: 'error',
        evidenceTurnIdx: i,
        claim: `Turn ${i} emitted <continue/> without a non-empty <say>. Production prompt requires narration alongside continue.`,
        suggestion: "Update the brain's prompt to always emit <say> before <continue/>.",
      });
    }
  }
  return violations;
}

// =============================================================================
// 2. <sleep/> with empty (or absent) <say>
// =============================================================================

export function sleepNeverWithSay(run: RunSummary): Violation[] {
  const violations: Violation[] = [];
  for (let i = 0; i < run.turns.length; i++) {
    const t = run.turns[i];
    if (!hasSleepTag(t.assistantText)) continue;
    const sayContent = extractSayContent(t.assistantText).trim();
    if (sayContent) {
      violations.push({
        assertKind: 'sleepNeverWithSay',
        severity: 'error',
        evidenceTurnIdx: i,
        claim: `Turn ${i} emitted <sleep> AND a non-empty <say> ('${sayContent.slice(0, 60)}…'). <sleep> is silent acknowledgement — going quiet IS the response.`,
        suggestion: 'Remove the <say> when emitting <sleep>.',
      });
    }
  }
  return violations;
}

// =============================================================================
// 3. ≤1 question mark per turn (adversarial: ignore ? inside JSON tool args,
//    inside ` backtick code blocks, and URL-encoded %3F)
// =============================================================================

function countMeaningfulQuestionMarks(text: string): number {
  // Drop backtick-quoted code blocks.
  let stripped = text.replace(/```[\s\S]*?```/g, '');
  stripped = stripped.replace(/`[^`]*`/g, '');
  // Drop JSON object/string literals (best-effort: any "...?..." inside quotes).
  stripped = stripped.replace(/"[^"\n]*"/g, (m) => m.replace(/\?/g, ''));
  // Drop URL-encoded ?: %3F (case-insensitive).
  stripped = stripped.replace(/%3F/gi, '');
  return (stripped.match(/\?/g) ?? []).length;
}

export function oneQuestionMarkPerTurn(run: RunSummary): Violation[] {
  const violations: Violation[] = [];
  for (let i = 0; i < run.turns.length; i++) {
    const sayContent = extractSayContent(run.turns[i].assistantText);
    const count = countMeaningfulQuestionMarks(sayContent);
    if (count > 1) {
      violations.push({
        assertKind: 'oneQuestionMarkPerTurn',
        severity: 'error',
        evidenceTurnIdx: i,
        claim: `Turn ${i} stacked ${count} questions. Per operator prompt: 'Do not stack multiple questions in one turn.'`,
        suggestion: 'Ask one thing per turn; defer the others.',
      });
    }
  }
  return violations;
}

// =============================================================================
// 4. <spawn role="worker"/> always has chunk=
// =============================================================================

export function spawnWorkerHasChunk(run: RunSummary): Violation[] {
  const violations: Violation[] = [];
  const SPAWN_RE = /<spawn\s+([^/>]*?)\/?>/gi;
  for (let i = 0; i < run.turns.length; i++) {
    const text = run.turns[i].assistantText;
    for (const m of text.matchAll(SPAWN_RE)) {
      const attrs = m[1];
      const isWorker = /role\s*=\s*"worker"/i.test(attrs);
      const hasChunk = /chunk\s*=\s*"/i.test(attrs);
      if (isWorker && !hasChunk) {
        violations.push({
          assertKind: 'spawnWorkerHasChunk',
          severity: 'error',
          evidenceTurnIdx: i,
          claim: `Turn ${i} spawned a worker without chunk= attribute. Orchestrator rejects worker without chunk; prompt requires scoper-first.`,
          suggestion: 'Either include chunk= in the worker spawn, or spawn a scoper first.',
        });
      }
    }
  }
  return violations;
}

// =============================================================================
// 5. <continue/> and chat:ask_choice never in same turn
// =============================================================================

export function noContinueWithAskChoice(run: RunSummary): Violation[] {
  const violations: Violation[] = [];
  for (let i = 0; i < run.turns.length; i++) {
    const t = run.turns[i];
    const hasContinue = hasContinueTag(t.assistantText);
    const hasAskChoice = t.toolCalls.some((tc) => tc.name === 'chat:ask_choice');
    if (hasContinue && hasAskChoice) {
      violations.push({
        assertKind: 'noContinueWithAskChoice',
        severity: 'error',
        evidenceTurnIdx: i,
        claim: `Turn ${i} emitted BOTH <continue/> AND chat:ask_choice. After ask_choice the turn must end — buttons ARE the prompt.`,
        suggestion: 'Pick one: either ask via card (turn ends) or continue narrating (no card).',
      });
    }
  }
  return violations;
}

// =============================================================================
// 6. Opener never literally "what can I help with"
// =============================================================================

const WHAT_CAN_I_HELP_RE = /what\s+can\s+i\s+help/i;

export function noBareWhatCanIHelp(run: RunSummary): Violation[] {
  const violations: Violation[] = [];
  // Check turn 0 specifically — the opener.
  const t = run.turns[0];
  if (!t) return violations;
  const say = extractSayContent(t.assistantText);
  if (WHAT_CAN_I_HELP_RE.test(say)) {
    violations.push({
      assertKind: 'noBareWhatCanIHelp',
      severity: 'error',
      evidenceTurnIdx: 0,
      claim: `Opener used the banned phrase 'what can I help…'. Per operator prompt: 'Open with substance — never with "what can I help with".'`,
      suggestion: "Lead with an observed fact + one concrete invitation (e.g. '3 harnesses active — sheets is busiest…').",
    });
  }
  return violations;
}

// =============================================================================
// 7. Each <say> block ≤220 chars
// =============================================================================

export function formatLength220(run: RunSummary): Violation[] {
  const violations: Violation[] = [];
  for (let i = 0; i < run.turns.length; i++) {
    const matches = [...run.turns[i].assistantText.matchAll(/<say[^>]*>([\s\S]*?)<\/say>/gi)];
    for (let j = 0; j < matches.length; j++) {
      const content = matches[j][1];
      if (content.length > 220) {
        violations.push({
          assertKind: 'formatLength220',
          severity: 'error',
          evidenceTurnIdx: i,
          claim: `Turn ${i} <say> #${j} is ${content.length} chars (cap: 220). 1-2 sentences is the spec; this overruns.`,
          suggestion: 'Tighten to a single concrete observation + one invitation.',
        });
      }
    }
  }
  return violations;
}

// =============================================================================
// 8. No markdown inside <say>
// =============================================================================

// Markdown signals: **bold**, ## heading, - list, ```code```. Avoids false
// positives on apostrophes and URLs.
const MD_BOLD = /\*\*.+?\*\*/;
const MD_HEADING = /^\s*#{1,6}\s+/m;
const MD_LIST = /^\s*[-*]\s+/m;
const MD_CODE_FENCE = /```/;

export function noMarkdownInSay(run: RunSummary): Violation[] {
  const violations: Violation[] = [];
  for (let i = 0; i < run.turns.length; i++) {
    const matches = [...run.turns[i].assistantText.matchAll(/<say[^>]*>([\s\S]*?)<\/say>/gi)];
    for (let j = 0; j < matches.length; j++) {
      const content = matches[j][1];
      const hit = MD_BOLD.test(content)
        || MD_HEADING.test(content)
        || MD_LIST.test(content)
        || MD_CODE_FENCE.test(content);
      if (hit) {
        violations.push({
          assertKind: 'noMarkdownInSay',
          severity: 'error',
          evidenceTurnIdx: i,
          claim: `Turn ${i} <say> contains markdown formatting. <say> output is TTS-safe — no **bold**, no headings, no lists, no code fences.`,
          suggestion: 'Speak in plain prose; cards exist for structured options.',
        });
      }
    }
  }
  return violations;
}

// =============================================================================
// 9. After user_says_ready (terminal/open canvas turn), 2–3 options surface
// =============================================================================

/**
 * Count discrete options the brain offered on the LAST turn:
 *   - If a chat:ask_choice card was emitted: count its options.
 *   - Else: heuristic — count "1." / "2." / "- " / bullet-style lines in <say>.
 */
function countOptionsInLastTurn(turn: TurnResult): number {
  // Cards first.
  const card = turn.cards.find((c) => c.kind === 'chat:ask_choice' || c.kind === 'ask_choice');
  if (card?.options) return card.options.length;
  // Fallback to prose heuristic.
  const say = extractSayContent(turn.assistantText);
  const lines = say.split(/\n/).filter((l) => /^\s*([-*]|\d+[.)])\s+/.test(l));
  return lines.length;
}

export function optionsCountWithinBounds(min: number, max: number) {
  return (run: RunSummary): Violation[] => {
    const last = run.turns[run.turns.length - 1];
    if (!last) {
      return [{
        assertKind: 'optionsCountWithinBounds',
        severity: 'error',
        claim: 'No turns to evaluate options on.',
      }];
    }
    const n = countOptionsInLastTurn(last);
    if (n < min || n > max) {
      return [{
        assertKind: 'optionsCountWithinBounds',
        severity: 'error',
        evidenceTurnIdx: run.turns.length - 1,
        claim: `Last turn surfaced ${n} options (allowed: ${min}..${max}). After user_says_ready the brain should propose 2-3 concrete next steps.`,
        suggestion: 'Either emit a chat:ask_choice card with 2-3 options OR a short prose list of that size.',
      }];
    }
    return [];
  };
}

// =============================================================================
// Helper export (used by tests)
// =============================================================================

export const _internals = {
  stripAllTags,
  extractSayContent,
  countMeaningfulQuestionMarks,
  countOptionsInLastTurn,
};
