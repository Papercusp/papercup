/**
 * P-014 (design-to-code-coverage-seam-2026-09-02): join the ACTIVATION audit to the
 * COMPLETION audit at ship time.
 *
 * Both datasets already existed and are keyed by `plan_slug`, but nothing had ever
 * compared them, so the two halves of traceability could disagree silently:
 *
 *   • The activation audit records what the source conversation REQUIRED, and where
 *     in the plan each requirement was placed (`planTargets`), with a `disposition`.
 *   • The completion audit records, per plan item, whether the CODE was verified —
 *     and D-008 is explicit that only `code`/`test` citations count as verification.
 *
 * A requirement dispositioned `covered` or `repaired` is a claim that the plan
 * ABSORBED it. That claim is only true if the item it was routed to actually got
 * built and verified. Until now a plan could mark every requirement `covered`,
 * carry an item audit whose only citation was `doc` or `none`, and ship — with the
 * activation audit asserting the requirement was handled and the completion audit
 * quietly recording that nothing was proven. Each audit is individually valid; only
 * the JOIN reveals the gap. (That is the same failure shape as P-007's coverage
 * config, one regime up: two correct artifacts whose disagreement nobody reads.)
 *
 * Deliberate scope limits, both of which are correctness requirements rather than
 * conveniences:
 *
 *   1. Only `P-NNN` targets are judgeable. `planTargets` also accepts `D-NNN` and
 *      `section:<heading>`, which have NO completion-audit counterpart by
 *      construction — the completion audit is per plan ITEM. Treating those as
 *      violations would refuse every plan whose requirements landed as decisions,
 *      which is a legitimate and common outcome. They are reported as `skipped`, so
 *      the exemption is visible rather than silent.
 *   2. Only `covered`/`repaired` are checked. `rejected` and `open` are honest
 *      dispositions that make no claim of absorption, and demanding evidence for
 *      them would punish the accurate answer.
 */
import { isVerifyingCitation, type ActivationAuditMapping, type EffectiveItemAudit } from './plan-audits';

/** Dispositions that ASSERT the plan absorbed the requirement, and so owe evidence. */
const REALIZING_DISPOSITIONS: ReadonlySet<ActivationAuditMapping['disposition']> = new Set([
  'covered',
  'repaired',
]);

/** A plan-item target. `D-NNN` and `section:<heading>` are deliberately not this. */
const PLAN_ITEM_TARGET = /^P-\d{3,}$/;

export type UnrealizedReason = 'no-item-audit' | 'no-verifying-citation';

export interface UnrealizedRequirement {
  mappingId: string;
  requirement: string;
  disposition: ActivationAuditMapping['disposition'];
  /** The `P-NNN` target that failed to demonstrate the requirement. */
  planTarget: string;
  reason: UnrealizedReason;
}

/**
 * A realizing mapping that named NO `P-NNN` target at all — every destination it gave
 * is a `D-NNN` or `section:<heading>`, which has no completion-audit counterpart by
 * construction. So the mapping asserts the plan absorbed a requirement, and nothing
 * judged that claim.
 */
export interface ExemptMapping {
  mappingId: string;
  requirement: string;
  disposition: ActivationAuditMapping['disposition'];
  /** The non-item destinations it named instead. */
  planTargets: string[];
}

export interface RequirementRealizationVerdict {
  ok: boolean;
  /** `P-NNN` targets actually judged. */
  checkedTargets: number;
  /**
   * Non-item targets (`D-NNN`, `section:…`) that carry no completion-audit
   * counterpart. Surfaced so a vacuous pass is never mistaken for a verified one.
   */
  skippedTargets: string[];
  /**
   * P-015 / D-035: the realizing mappings judged by NOTHING — those whose targets are
   * ALL non-item. This is the mapping-level view `skippedTargets` cannot give, and the
   * difference is not cosmetic: measured 2026-09-03, 4,090 of 9,912 realizing targets
   * (41.3%) are non-item, but only 366 of 2,493 realizing MAPPINGS (14.7%) carry no
   * `P-NNN` at all. The other ~3,724 non-item targets sit beside a `P-NNN` on the same
   * mapping and ARE judged through it, so the target-level number overstates the
   * unjudged population by ~11x.
   *
   * ⚠ NOT a violation, deliberately. P-015 proposed refusing these; D-035 rejected that
   * after measuring what they are — conversational requirements ("explain this more?",
   * "write all these insights into a plan now") whose honest home IS a decision or a
   * section. No plan item could implement them, and inventing one to satisfy a floor
   * would be fabricated traceability. They are REPORTED so the exemption is visible,
   * which is the guarantee this module already claimed and the gate was dropping.
   */
  exemptMappings: ExemptMapping[];
  /** Mappings dispositioned covered/repaired whose evidence is missing. */
  unrealized: UnrealizedRequirement[];
}

export interface RequirementRealizationInput {
  mappings: ReadonlyArray<ActivationAuditMapping>;
  itemAudits: ReadonlyArray<EffectiveItemAudit>;
}

export function judgeRequirementRealization(
  input: RequirementRealizationInput,
): RequirementRealizationVerdict {
  // Index the completion audit by item id. `foldEffectiveItemAudits` has already
  // reduced to one effective entry per item, so a plain Map is faithful here.
  const auditByItem = new Map<string, EffectiveItemAudit>();
  for (const audit of input.itemAudits) auditByItem.set(audit.entry.itemId, audit);

  const unrealized: UnrealizedRequirement[] = [];
  const skippedTargets: string[] = [];
  const exemptMappings: ExemptMapping[] = [];
  let checkedTargets = 0;

  for (const mapping of input.mappings) {
    if (!REALIZING_DISPOSITIONS.has(mapping.disposition)) continue;

    // Per-mapping accounting (D-035): a mapping is EXEMPT only when it named no
    // judgeable target at all. Counted here rather than derived from `skippedTargets`
    // afterwards, because that list is flat across mappings and cannot answer it.
    let judgeableTargets = 0;
    const nonItemTargets: string[] = [];

    for (const target of mapping.planTargets) {
      const trimmed = target.trim();
      if (!PLAN_ITEM_TARGET.test(trimmed)) {
        skippedTargets.push(trimmed);
        nonItemTargets.push(trimmed);
        continue;
      }
      judgeableTargets += 1;
      checkedTargets += 1;

      const audit = auditByItem.get(trimmed);
      if (!audit) {
        unrealized.push({
          mappingId: mapping.id,
          requirement: mapping.requirement,
          disposition: mapping.disposition,
          planTarget: trimmed,
          reason: 'no-item-audit',
        });
        continue;
      }

      // D-008: only code/test citations verify. An item audited with `doc`/`none`
      // citations is explicitly NOT verified, so a requirement routed to it has not
      // been realized however confidently the activation audit says `covered`.
      if (!audit.entry.citations.some(isVerifyingCitation)) {
        unrealized.push({
          mappingId: mapping.id,
          requirement: mapping.requirement,
          disposition: mapping.disposition,
          planTarget: trimmed,
          reason: 'no-verifying-citation',
        });
      }
    }

    if (judgeableTargets === 0) {
      exemptMappings.push({
        mappingId: mapping.id,
        requirement: mapping.requirement,
        disposition: mapping.disposition,
        planTargets: nonItemTargets,
      });
    }
  }

  return {
    ok: unrealized.length === 0,
    checkedTargets,
    skippedTargets,
    exemptMappings,
    unrealized,
  };
}

/** One-line-per-entry rendering for the gate's (non-blocking) exemption report. */
export function describeExemptMapping(entry: ExemptMapping): string {
  const requirement =
    entry.requirement.length > 80 ? `${entry.requirement.slice(0, 77)}...` : entry.requirement;
  const targets = entry.planTargets.length > 0 ? entry.planTargets.join(', ') : '(no targets)';
  return `${entry.mappingId} (${entry.disposition}) → ${targets}: "${requirement}"`;
}

/** One-line-per-entry rendering for the gate's refusal message. */
export function describeUnrealized(entry: UnrealizedRequirement): string {
  const why =
    entry.reason === 'no-item-audit'
      ? 'no item audit'
      : 'audited with no verifying (code/test) citation';
  const requirement =
    entry.requirement.length > 80 ? `${entry.requirement.slice(0, 77)}...` : entry.requirement;
  return `${entry.mappingId} (${entry.disposition}) → ${entry.planTarget}: ${why} — "${requirement}"`;
}
