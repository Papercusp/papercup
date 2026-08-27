import type { ParsedPlan, PlanDecision, PlanItem } from './parser';

export interface StagingFirstActivationProblem {
  itemId: string;
  code: 'non_final_deployed_main_wait';
  detail: string;
}

const DEPLOYED_ENV_RE = /(?:\bmain\b|:3070\b|\bgreen[- ]checkpoint\b|\bdeploy(?:ed|ment|ing)?\b)/i;
const STRONG_GATE_RE = /(?:\bwait(?:ing)?\s+(?:for|on)\b|\bblock(?:ed|ing|s)?\b|\bprerequisite\b|\bonly\s+after\b|\buntil\b|\bbefore\s+(?:continu(?:e|ing)|implement(?:ation|ing)?|clos(?:e|ing)|mark(?:ing)?\s+(?:it\s+)?done)\b|\b(?:must|required?|requires?)\b.{0,80}\b(?:before|until|prior to)\b)/i;
const FINAL_LIFECYCLE_RE = /(?:\bfinal\s+(?:shipment|promotion|deploy(?:ment)?|release|rollout|verification|acceptance)\b|\bship(?:ment)?\s+verification\b|\brelease\s+packag(?:e|ing)\b|\brollback\b|\bmigration\s+order(?:ing)?\b)/i;
const EXPLICIT_DEPLOYED_ONLY_RE = /\bdeployed[- ]only\b/i;
const STAGING_LIMIT_RE = /(?:\b(?:staging|current[- ]build)\b.{0,140}\b(?:cannot|can't|unable|does not|doesn't|is not|isn't|unavailable)\b|\b(?:cannot|can't|unable)\b.{0,140}\b(?:staging|current[- ]build)\b)/i;
const CONCRETE_REASON_RE = /(?:\bbecause\b|\bdue to\b|\bsince\b|\breason\b|\brollback\b|\brelease\s+packag(?:e|ing)\b|\bmigration\s+order(?:ing)?\b|\bproduction[- ]only\b|\bdeployed[- ]host\b)/i;

function decisionAppliesToItem(decision: PlanDecision, itemId: string): boolean {
  return decision.itemRefs.includes(itemId) || new RegExp(`\\b${itemId.replace('-', '\\-')}\\b`).test(`${decision.title}\n${decision.body}`);
}

function hasNarrowDeployedMainException(text: string): boolean {
  return EXPLICIT_DEPLOYED_ONLY_RE.test(text) && STAGING_LIMIT_RE.test(text) && CONCRETE_REASON_RE.test(text);
}

function relatedExceptionText(item: PlanItem, decisions: PlanDecision[]): string {
  return [
    item.text,
    ...decisions
      .filter((decision) => decisionAppliesToItem(decision, item.id))
      .map((decision) => `${decision.title}\n${decision.body}`),
  ].join('\n');
}

/**
 * Activation-time guard for plans that accidentally serialize ordinary implementation
 * behind the release plane. It is deliberately plan-local and conservative: only strong
 * wait/gate language is rejected, while final lifecycle work and a concrete deployed-only
 * exception remain valid.
 */
export function stagingFirstActivationProblems(plan: ParsedPlan): StagingFirstActivationProblem[] {
  const problems: StagingFirstActivationProblem[] = [];

  for (const item of plan.items) {
    const text = item.text;
    if (!DEPLOYED_ENV_RE.test(text) || !STRONG_GATE_RE.test(text)) continue;
    if (FINAL_LIFECYCLE_RE.test(text)) continue;
    if (hasNarrowDeployedMainException(relatedExceptionText(item, plan.decisions))) continue;

    problems.push({
      itemId: item.id,
      code: 'non_final_deployed_main_wait',
      detail:
        `${item.id} makes main/:3070/green-checkpoint/deployment a prerequisite for non-final implementation. ` +
        `Use staging/current-build for implementation and non-final acceptance, or declare a narrow exception on ` +
        `${item.id} (or a decision linked to it): name the deployed-only property, explain concretely why ` +
        `staging/current-build cannot exercise it, and retain deployed-main verification only for that property.`,
    });
  }

  return problems;
}
