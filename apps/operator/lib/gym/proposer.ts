/**
 * Reflective proposer (P-015) — GEPA's reflective-mutation mechanism (D-007),
 * v1 prompts-only (D-015).
 *
 * Reads the parent variant's worst-scoring train traces + the judge's RATIONALES
 * (the reflection signal) + the running changelog, and emits a targeted PROMPT diff
 * for one or a few roles → a candidate overlay (parent overrides ⊕ the proposed
 * changes). Model/orchestration mutation is reserved for a later phase (D-015). LLM
 * injected so build → call → parse → merge is unit-tested without the network.
 */
import { tryParseJson } from './parse-json';
import { planVariantOverlay, type VariantOverlay } from './variant-overlay';
import type { GymLlmCall } from './task-generator';

export interface WorstTrace {
  taskId: string;
  composite: number;
  rationale: string;
  /** Optional distilled trace excerpt for deeper reflection. */
  distilledTrace?: string;
}

export interface ProposeInput {
  /** The parent variant's overlay to mutate from. */
  parentOverlay: VariantOverlay;
  /** The parent's worst-scoring train traces (with judge rationales). */
  worstTraces: WorstTrace[];
  /** The running judge changelog (anchored to hard numbers + narrative). */
  changelog: string;
  /** Model that proposes — should differ from the judge for the same decorrelation spirit. */
  proposerModel: string;
}

export interface ParsedProposal {
  promptOverrides: Record<string, string>;
  rationale: string;
}

export interface CandidateProposal {
  overlay: VariantOverlay;
  rationale: string;
  diffFromParent: string;
}

export function buildProposerPrompt(input: ProposeInput): { system: string; user: string } {
  const system = [
    'You optimize a multi-agent coding harness by improving its ROLE PROMPTS. You are given',
    'the harness’s worst-scoring runs with an independent judge’s RATIONALES, plus a changelog',
    'of past prompt changes. Diagnose the recurring failure mode and propose a TARGETED prompt',
    'change to ONE or a FEW roles that would most raise the judge’s scores. Change prompts only',
    '— do not propose model swaps or orchestration changes.',
    '',
    'Output ONLY a single JSON object (no prose, no fences):',
    '{"promptOverrides": {"<role>": "<full replacement prompt markdown>"}, "rationale": "<why this change targets the failures>"}',
  ].join('\n');

  const user = [
    '## Running changelog',
    input.changelog || '(none yet)',
    '',
    '## Worst-scoring runs (judge rationales)',
    ...input.worstTraces.map(
      (t) =>
        `- task ${t.taskId} (composite ${t.composite.toFixed(2)}): ${t.rationale}` +
        (t.distilledTrace ? `\n  trace: ${t.distilledTrace}` : ''),
    ),
    '',
    '## Current role overrides (parent variant)',
    JSON.stringify(input.parentOverlay.promptOverrides, null, 2),
  ].join('\n');

  return { system, user };
}

export function parseProposal(raw: unknown): ParsedProposal {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error(`proposal must be a JSON object, got: ${typeof raw}`);
  }
  const o = raw as Record<string, unknown>;
  const po = o.promptOverrides;
  if (typeof po !== 'object' || po === null) {
    throw new Error('proposal is missing a "promptOverrides" object');
  }
  if (typeof o.rationale !== 'string' || !o.rationale.trim()) {
    throw new Error('proposal is missing a non-empty "rationale"');
  }
  const promptOverrides = po as Record<string, string>;
  // Validate the roles (rejects unknown roles incl. the frozen judge) — reuse the overlay validator.
  planVariantOverlay({ promptOverrides });
  return { promptOverrides, rationale: o.rationale };
}

export async function proposeCandidate(
  input: ProposeInput,
  deps: { llmCall: GymLlmCall },
): Promise<CandidateProposal> {
  const { system, user } = buildProposerPrompt(input);
  const res = await deps.llmCall({
    model: input.proposerModel,
    system,
    messages: [{ role: 'user', content: user }],
    responseFormat: 'json',
  });
  const proposal = parseProposal(res.json ?? tryParseJson(res.text));

  // Candidate overlay = parent overrides ⊕ proposed changes (prompts-only).
  const merged: Record<string, string> = { ...input.parentOverlay.promptOverrides, ...proposal.promptOverrides };
  const overlay: VariantOverlay = { promptOverrides: merged };
  // Validate the merged overlay too.
  planVariantOverlay(overlay);

  const diffFromParent = Object.keys(proposal.promptOverrides).sort().join(', ');
  return { overlay, rationale: proposal.rationale, diffFromParent };
}
