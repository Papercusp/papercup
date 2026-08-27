import type { ParsedPlan, PlanDecision, PlanItem } from './parser';
import { splitPlanSections } from './plan-sections';

export interface StagingFirstActivationProblem {
  itemId: string;
  code: 'non_final_deployed_main_wait';
  detail: string;
}

const DEPLOYED_ENV_RE = /(?:\bmain\b|:3070\b|\bgreen[- ]checkpoint\b|\bdeploy(?:ed|ment|ing)?\b)/i;
const STRONG_GATE_RE = /(?:\bwait(?:ing)?\s+(?:for|on)\b|\bblock(?:ed|ing|s)?\b|\bprerequisite\b|\bonly\s+after\b|\buntil\b|\bbefore\s+(?:continu(?:e|ing)|implement(?:ation|ing)?|clos(?:e|ing)|mark(?:ing)?\s+(?:it\s+)?done)\b|\b(?:must|required?|requires?)\b.{0,80}\b(?:before|until|prior to)\b)/i;
const NEGATED_OR_META_GATE_RE = /(?:\b(?:reject|refus|forbid|prevent|detect|flag)\w*\b|\bguard(?:s|ed|ing)?\s+against\b|\bnot\s+(?:an?\s+)?prerequisite\b|\b(?:does|do|must|should|is|are)\s+not\b.{0,80}\b(?:block|wait|required?|prerequisite)\w*\b|\bnever\s+(?:block|wait|require)\w*\b)/i;
const FINAL_LIFECYCLE_RE = /(?:\bfinal\s+(?:shipment|promotion|deploy(?:ment)?|release|rollout|verification|acceptance)\b|\bship(?:ment)?\s+verification\b|\brelease\s+packag(?:e|ing)\b|\brollback\b|\bmigration\s+order(?:ing)?\b)/i;
const FINAL_PHASE_RE = /(?:\brelease\b|\bshipment\b|\brollout\b|\bclosure\b|\bship\b)/i;
const EXPLICIT_DEPLOYED_ONLY_RE = /\bdeployed[- ]only\b/i;
const STAGING_LIMIT_RE = /(?:\b(?:staging|current[- ]build)\b.{0,140}\b(?:cannot|can't|unable|does not|doesn't|is not|isn't|unavailable)\b|\b(?:cannot|can't|unable)\b.{0,140}\b(?:staging|current[- ]build)\b)/i;
const CONCRETE_REASON_RE = /(?:\bbecause\b|\bdue to\b|\bsince\b|\breason\b|\brollback\b|\brelease\s+packag(?:e|ing)\b|\bmigration\s+order(?:ing)?\b|\bproduction[- ]only\b|\bdeployed[- ]host\b)/i;
const ACCEPTANCE_SECTION_RE = /^(?:acceptance|requirements?|validation|verification)\b/i;

function itemRefPattern(itemId: string): RegExp {
  return new RegExp(`\\b${itemId.replace('-', '\\-')}\\b`);
}

function decisionAppliesToItem(decision: PlanDecision, item: PlanItem): boolean {
  return item.decisionRefs.includes(decision.id)
    || decision.itemRefs.includes(item.id)
    || itemRefPattern(item.id).test(`${decision.title}\n${decision.body}`);
}

function applicableDecisions(item: PlanItem, decisions: PlanDecision[]): PlanDecision[] {
  return decisions.filter((decision) => decisionAppliesToItem(decision, item));
}

const ANY_ITEM_REF_RE = /\bP-\d{3,}\b/i;
const ANAPHORIC_ITEM_RE = /\b(?:it|this item|that item|the item|this work|that work|the work|this lane|that lane|the lane)\b/i;

/**
 * Keep prose that actually speaks about this item instead of admitting an entire
 * multi-item status/acceptance block after one incidental reference. The following
 * anaphoric sentence is retained when it clearly continues the same item and does
 * not introduce another P-NNN reference.
 */
function itemScopedText(text: string, itemId: string): string {
  const ref = itemRefPattern(itemId);
  const clauses = text
    .split(/\n+|(?<=[.!?;])\s+/)
    .map((clause) => clause.trim())
    .filter(Boolean);

  return clauses
    .filter((clause, index) => {
      if (ref.test(clause)) return true;
      if (index === 0 || ANY_ITEM_REF_RE.test(clause) || !ANAPHORIC_ITEM_RE.test(clause)) return false;
      return ref.test(clauses[index - 1] ?? '');
    })
    .join('\n');
}

function decisionTextForItem(decision: PlanDecision, item: PlanItem): string {
  const text = `${decision.title}\n${decision.body}`;
  const relatedLine = decision.body
    .split('\n')
    .find((line) => /^\s*Related:/i.test(line));
  const explicitlyLinked = item.decisionRefs.includes(decision.id)
    || Boolean(relatedLine && itemRefPattern(item.id).test(relatedLine));
  return explicitlyLinked ? text : itemScopedText(text, item.id);
}

function hasNarrowDeployedMainException(text: string): boolean {
  return EXPLICIT_DEPLOYED_ONLY_RE.test(text) && STAGING_LIMIT_RE.test(text) && CONCRETE_REASON_RE.test(text);
}

function relatedExceptionText(item: PlanItem, decisions: PlanDecision[]): string {
  return [
    item.text,
    ...applicableDecisions(item, decisions)
      .map((decision) => decisionTextForItem(decision, item)),
  ].join('\n');
}

function hasStrongDeployedGate(text: string): boolean {
  return text
    .split(/\n+|(?<=[.!?])\s+/)
    .some((clause) =>
      DEPLOYED_ENV_RE.test(clause)
      && STRONG_GATE_RE.test(clause)
      && !NEGATED_OR_META_GATE_RE.test(clause),
    );
}

function relatedGateText(plan: ParsedPlan, item: PlanItem): string {
  const ref = itemRefPattern(item.id);
  const now = plan.now?.raw && ref.test(plan.now.raw) ? [itemScopedText(plan.now.raw, item.id)] : [];
  const acceptanceClauses = splitPlanSections(plan.raw)
    .filter((section) => ACCEPTANCE_SECTION_RE.test(section.heading) && ref.test(section.body))
    .map((section) => `${section.heading}\n${itemScopedText(section.body, item.id)}`);
  return [
    item.text,
    ...applicableDecisions(item, plan.decisions)
      .map((decision) => decisionTextForItem(decision, item)),
    ...now,
    ...acceptanceClauses,
  ].join('\n');
}

function isFinalLifecycleItem(item: PlanItem): boolean {
  return FINAL_LIFECYCLE_RE.test(item.text) || FINAL_PHASE_RE.test(item.phase ?? '');
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
    if (!hasStrongDeployedGate(relatedGateText(plan, item))) continue;
    if (isFinalLifecycleItem(item)) continue;
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
