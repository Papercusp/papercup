/**
 * Shared deterministic asserts for the Sentinel scenario suite
 * (sentinel-as-claude-tui-2026-06-23 voice-flow testing).
 *
 * The Sentinel runs the role='sentinel' converse brain; the agent-mcp route
 * streams the assistant turn RAW (the client strips control tags for display,
 * the server re-parses to dispatch), so `<handoff_to_queen>` lands in the
 * harness's accumulated `assistantText` and tool calls land in `toolCalls`.
 */
import type { RunSummary, Violation } from '@papercusp/testing-shell/llm';

const HANDOFF_RE = /<handoff_to_queen/i;
const DELEGATE_RE = /<delegate_deep/i;

/** SOME assistant turn must emit `<handoff_to_queen>` (work routed to the Queen). */
export function emitsHandoff(run: RunSummary): Violation[] {
  if (run.turns.some((t) => HANDOFF_RE.test(t.assistantText))) return [];
  return [
    {
      assertKind: 'custom:emitsHandoff',
      severity: 'error',
      evidenceTurnIdx: Math.max(0, run.turns.length - 1),
      claim: 'Sentinel never emitted <handoff_to_queen> for a planning-scale ask.',
      suggestion:
        'Route substantial multi-step work to the Queen via <handoff_to_queen> (files a high-priority work_item + nudges her), not plan/place/execute it itself.',
    },
  ];
}

/** NO assistant turn may emit `<handoff_to_queen>` (kept local / answered directly). */
export function noHandoff(run: RunSummary): Violation[] {
  const idx = run.turns.findIndex((t) => HANDOFF_RE.test(t.assistantText));
  if (idx < 0) return [];
  return [
    {
      assertKind: 'custom:noHandoff',
      severity: 'error',
      evidenceTurnIdx: idx,
      claim: 'Sentinel handed a quick, directly-answerable request off to the Queen.',
      suggestion:
        'Reserve <handoff_to_queen> for substantial multi-step work; answer status / quick-recall directly — a handoff spams the Queen.',
    },
  ];
}

/** NO assistant turn may emit `<delegate_deep>` (the ask should stay local / answered directly). */
export function noDelegate(run: RunSummary): Violation[] {
  const idx = run.turns.findIndex((t) => DELEGATE_RE.test(t.assistantText));
  if (idx < 0) return [];
  return [
    {
      assertKind: 'custom:noDelegate',
      severity: 'error',
      evidenceTurnIdx: idx,
      claim: 'Sentinel routed the ask through <delegate_deep> instead of answering from existing delegation state.',
      suggestion:
        'Use <delegate_deep> only for NEW hard-thinking work. A follow-up on an existing analysis should be answered from the open delegation work-item state.',
    },
  ];
}

/**
 * The Sentinel must CONSULT A TOOL before answering a question about live hive
 * state (fleet/plans/work-items/mail), rather than answering blind from memory —
 * the anti-hallucination floor for the hive-knowledge scenarios. Tool-agnostic
 * (any toolCall counts) so it doesn't brittle-pin a specific read tool name.
 */
export function consultedATool(run: RunSummary): Violation[] {
  if (run.turns.some((t) => t.toolCalls.length > 0)) return [];
  return [
    {
      assertKind: 'custom:consultedATool',
      severity: 'error',
      evidenceTurnIdx: Math.max(0, run.turns.length - 1),
      claim: 'Sentinel answered a live-hive-state question without calling any tool (blind/likely hallucinated).',
      suggestion:
        'Answer live hive questions by calling a read tool (roster / plans / work-items / coord), not from memory.',
    },
  ];
}
