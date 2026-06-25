/**
 * P-006 — debate + recombine surviving critiques into Proposals (hive-creative-
 * ideation D-006). The surviving ideas (verdict ≠ reject) are grouped — topically
 * related survivors PAIRED so their mechanisms can fuse ("A's mechanism + B's
 * framing"; the best ideas are usually a fusion) — then each group is debated +
 * merged by the LLM into one Proposal. Every Proposal MUST carry a cheap,
 * falsifiable first experiment (D-006) — the anti-bullshit gate enforced by
 * `validateProposal`; a group whose LLM output fails the gate is DROPPED, never
 * smuggled through.
 *
 * Pairing + validation are pure + deterministic (unit-tested without a network);
 * the merge step takes an injected `ScoutLlmCall` (the gym:judge pattern). The
 * cycle (su-cb4b9) calls `recombineProposals`; P-007 routing (su-ce4bd) consumes
 * the Proposals; P-009 (su-e8630) reuses `validateProposal` for the bettable
 * invariant.
 */
import type { ScoredIdea, Proposal, ScoutExperiment, ScoutLlmCall } from './types';
import { titleSimilarity } from '../harness/improvements/digest';
import { parseLlmJson } from './llm-json';
import { DEFAULT_SCOUT_RECOMBINE_MODEL } from './models';

/** Default recombine model — a touch stronger than the critic (it writes the
 *  proposal narrative + experiment). Overridable via RecombineOptions.model. */
export const DEFAULT_RECOMBINE_MODEL = DEFAULT_SCOUT_RECOMBINE_MODEL;

/** A group of 1-2 surviving ideas to debate/merge into one proposal. */
export interface RecombinationGroup {
  members: ScoredIdea[];
}

export interface PlanRecombinationOptions {
  /** Two survivors at/above this title-signature overlap are PAIRED to merge
   *  (related-but-not-identical; default 0.25). */
  pairSimilarityFloor?: number;
  /** Max groups produced — the per-cycle cost bound (default 4). */
  maxGroups?: number;
}

/**
 * Decide which survivors to debate/merge. Most-novel survivors anchor first;
 * each anchor is paired with its most-similar unused partner above the floor (so
 * related ideas fuse), else it stands alone. Greedy, deterministic, capped.
 */
export function planRecombinations(
  survivors: readonly ScoredIdea[],
  opts: PlanRecombinationOptions = {},
): RecombinationGroup[] {
  const floor = opts.pairSimilarityFloor ?? 0.25;
  const maxGroups = opts.maxGroups ?? 4;
  const used = new Set<string>();
  const groups: RecombinationGroup[] = [];
  const ordered = [...survivors].sort((a, b) => b.novelty - a.novelty);

  for (let i = 0; i < ordered.length; i++) {
    const a = ordered[i];
    if (used.has(a.idea.id)) continue;
    used.add(a.idea.id);

    let partner: ScoredIdea | undefined;
    let best = floor;
    for (let j = i + 1; j < ordered.length; j++) {
      const b = ordered[j];
      if (used.has(b.idea.id)) continue;
      const sim = titleSimilarity(
        `${a.idea.title} ${a.idea.body}`,
        `${b.idea.title} ${b.idea.body}`,
      );
      if (sim >= best) {
        best = sim;
        partner = b;
      }
    }
    if (partner) {
      used.add(partner.idea.id);
      groups.push({ members: [a, partner] });
    } else {
      groups.push({ members: [a] });
    }
    if (groups.length >= maxGroups) break;
  }
  return groups;
}

export interface ProposalValidation {
  ok: boolean;
  errors: string[];
}

/**
 * The D-006 gate: a Proposal is valid only if it carries the core narrative
 * (framing / mechanism / whyNew / bet), ≥1 source idea, a present grounding array,
 * AND a complete cheap-falsifiable-experiment (hypothesis + method +
 * falsifiableSignal all non-empty). Reused by P-009's bettable invariant.
 */
export function validateProposal(p: Partial<Proposal>): ProposalValidation {
  const errors: string[] = [];
  const ne = (s: unknown): boolean => typeof s === 'string' && s.trim().length > 0;

  if (!ne(p.framing)) errors.push('missing framing');
  if (!ne(p.mechanism)) errors.push('missing mechanism');
  if (!ne(p.whyNew)) errors.push('missing whyNew');
  if (!ne(p.bet)) errors.push('missing bet');

  const e = p.cheapExperiment;
  if (!e || !ne(e.hypothesis) || !ne(e.method) || !ne(e.falsifiableSignal)) {
    errors.push(
      'missing/incomplete cheapExperiment (D-006: hypothesis + method + falsifiableSignal all required)',
    );
  }
  if (!Array.isArray(p.sourceIdeaIds) || p.sourceIdeaIds.length === 0) {
    errors.push('missing sourceIdeaIds (≥1)');
  }
  if (!Array.isArray(p.addressesPatternRefs)) {
    errors.push('missing addressesPatternRefs (grounding array — may be empty)');
  }
  return { ok: errors.length === 0, errors };
}

export interface RecombineOptions extends PlanRecombinationOptions {
  projectContext?: string;
  model?: string;
  thinkingBudgetTokens?: number;
}

export interface RecombineResult {
  proposals: Proposal[];
  /** Groups whose LLM output failed the D-006 validation gate (dropped, with why). */
  dropped: { sourceIdeaIds: string[]; errors: string[] }[];
}

export function buildRecombinePrompt(
  group: RecombinationGroup,
  opts: RecombineOptions,
): { system: string; user: string } {
  const merging = group.members.length > 1;
  const system = [
    'You are a Scout proposer for the Papercusp "Hive" (a multi-agent coding platform). You turn 1-2 surviving creative ideas into ONE concrete, bettable PROPOSAL.',
    merging
      ? "The ideas are related — DEBATE them and MERGE the best of each (one idea's mechanism + the other's framing); the strongest proposals are usually a fusion."
      : 'Sharpen this single idea into a concrete proposal.',
    'Every proposal MUST name a CHEAP, FALSIFIABLE first experiment (the anti-bullshit gate): a hypothesis, the cheap method to test it, and the observable signal that would prove it WRONG.',
    'Reason briefly, then output ONLY this JSON (no prose, no fences):',
    '{"framing": "...the problem this addresses...", "mechanism": "...the novel mechanism, how it works...", "whyNew": "...why this is new vs what already exists...", "bet": "...the upside if it works...", "experiment": {"hypothesis": "...", "method": "...the cheap first test...", "falsifiableSignal": "...the observable that would prove it WRONG..."}, "route": "plan|gym|improvement"}',
    'route: "plan" for broad/architectural scope, "gym" for a small testable optimization, "improvement" for a concrete fix.',
  ].join('\n');

  const ideaBlock = group.members
    .map((m, i) =>
      [
        `### Idea ${i + 1} (lens: ${m.idea.lens}; novelty ${m.novelty}, feasibility ${m.feasibility})`,
        `Title: ${m.idea.title}`,
        m.idea.body,
        `Mechanism: ${m.idea.mechanism}`,
      ].join('\n'),
    )
    .join('\n\n');

  const user = [
    merging ? '## Surviving ideas to debate + merge' : '## Surviving idea to sharpen',
    ideaBlock,
    '',
    '## Architecture context',
    opts.projectContext ?? '(none provided)',
  ].join('\n');

  return { system, user };
}

type ParsedProposal = {
  framing: string;
  mechanism: string;
  whyNew: string;
  bet: string;
  cheapExperiment: ScoutExperiment;
  routeHint?: Proposal['routeHint'];
};

function parseProposal(raw: unknown): ParsedProposal | null {
  if (raw == null || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
  const expSrc = (o.experiment ?? o.cheapExperiment) as Record<string, unknown> | undefined;
  const cheapExperiment: ScoutExperiment = {
    hypothesis: str(expSrc?.hypothesis),
    method: str(expSrc?.method),
    falsifiableSignal: str(expSrc?.falsifiableSignal ?? expSrc?.falsifiable_signal),
  };
  const route = str(o.route ?? o.routeHint);
  const routeHint =
    route === 'plan' || route === 'gym' || route === 'improvement' ? route : undefined;
  return {
    framing: str(o.framing),
    mechanism: str(o.mechanism),
    whyNew: str(o.whyNew ?? o.why_new),
    bet: str(o.bet),
    cheapExperiment,
    routeHint,
  };
}

/**
 * Debate + recombine survivors → validated Proposals. Filters to survivors
 * (verdict ≠ reject) internally, so the cycle can hand the full ScoredIdea[]
 * straight in. Only proposals that pass the D-006 gate are returned; the rest
 * land in `dropped` (visible, never silently lost).
 */
export async function recombineProposals(
  scored: readonly ScoredIdea[],
  deps: { llmCall: ScoutLlmCall },
  opts: RecombineOptions = {},
): Promise<RecombineResult> {
  const survivors = scored.filter((s) => s.verdict !== 'reject');
  const groups = planRecombinations(survivors, opts);
  const proposals: Proposal[] = [];
  const dropped: { sourceIdeaIds: string[]; errors: string[] }[] = [];
  let n = 0;

  for (const group of groups) {
    const sourceIdeaIds = group.members.map((m) => m.idea.id);
    const addressesPatternRefs = [
      ...new Set(group.members.flatMap((m) => m.idea.addressesPatternRefs ?? [])),
    ];
    const { system, user } = buildRecombinePrompt(group, opts);
    const thinkingBudgetTokens = opts.thinkingBudgetTokens ?? 2048;
    const res = await deps.llmCall({
      model: opts.model ?? DEFAULT_RECOMBINE_MODEL,
      system,
      messages: [{ role: 'user', content: user }],
      responseFormat: 'json',
      thinkingBudgetTokens,
      maxTokens: thinkingBudgetTokens + 2048,
    });
    const parsed = parseProposal(parseLlmJson(res));
    const base: Partial<Proposal> = parsed
      ? {
          framing: parsed.framing,
          mechanism: parsed.mechanism,
          whyNew: parsed.whyNew,
          bet: parsed.bet,
          cheapExperiment: parsed.cheapExperiment,
          sourceIdeaIds,
          addressesPatternRefs,
          ...(parsed.routeHint ? { routeHint: parsed.routeHint } : {}),
        }
      : { sourceIdeaIds, addressesPatternRefs };

    const v = validateProposal(base);
    if (v.ok) {
      proposals.push({ id: `SP-${String(++n).padStart(3, '0')}`, ...base } as Proposal);
    } else {
      dropped.push({ sourceIdeaIds, errors: v.errors });
    }
  }
  return { proposals, dropped };
}
