/**
 * The registry-backed verification resolver (plan-item-types-registry-cupboard-2026-10-20).
 *
 * It answers the same question as the legacy `resolveVerificationLegacy` in
 * plan-verification-profile.ts, "which verification modules apply to this plan item", but it
 * reads the answer from item-type and plan-type DEFINITIONS:
 * - the plan's profile names its plan type (`papercusp/coding`, `papercusp/general`);
 * - a declared deliverable names its item type (`papercusp/<kind>`);
 * - an item with no declared deliverable and no non-code signal gets the plan type's
 *   `defaultItemType`;
 * - code-ness is "the resolved module set includes `code`", never a comparison with a kind
 *   literal, so a third-party item type is code exactly when it says so.
 *
 * Today's non-code signals (a `not-code` completion-audit verdict, the `task` work-item kind)
 * keep their meaning: generic-core plus any opted-in domain modules, with no item type.
 *
 * FAIL SAFE: a plan type or item type the registry cannot resolve (absent, retired, outside
 * the referenced revision range, or an invalid row) resolves to the FULL module catalog. A
 * missing definition can never lower the checks an item is held to.
 *
 * P-001 scope: only the built-in vocabulary is consulted, as by the legacy resolver: an
 * undeclared or unknown deliverable string is ignored, so on every built-in input this
 * resolver must equal the legacy one. The registry census (census.ts) proves that over the
 * real gates. P-002 opens the parser to namespaced slugs and makes this the default.
 */
import {
  INFERRED_PLAN_PROFILE,
  VERIFICATION_MODULES,
  isDeliverableKind,
  isNonCodeAuditVerdict,
  isNonCodeWorkItemKind,
  isVerificationProfile,
  type DeliverableKind,
  type DeliverableSource,
  type VerificationModule,
  type VerificationResolution,
  type VerificationResolver,
} from '../plan-verification-profile';
import { builtinItemTypeId, builtinKindOf, builtinPlanTypeId } from './builtin-catalog';
import { normalizeModules, type TypeReference } from './definitions';
import { buildTypeRegistrySnapshot, type TypeRegistrySnapshot } from './registry';

/** The strictest module set: what an unresolvable type is held to. */
export const STRICTEST_MODULES: readonly VerificationModule[] = Object.freeze([...VERIFICATION_MODULES]);

export function createRegistryVerificationResolver(
  registry: TypeRegistrySnapshot = buildTypeRegistrySnapshot(),
): VerificationResolver {
  return (plan, item): VerificationResolution => {
    const declaredProfile = isVerificationProfile(plan.verificationProfile) ? plan.verificationProfile : null;
    const profile = declaredProfile ?? INFERRED_PLAN_PROFILE;
    const profileSource = declaredProfile ? 'declared' : 'inferred';
    const domainModules = item.domainModules ?? [];

    let reference: TypeReference | null;
    let deliverableSource: DeliverableSource;
    if (isDeliverableKind(item.deliverable)) {
      reference = { id: builtinItemTypeId(item.deliverable) };
      deliverableSource = 'declared';
    } else if (isNonCodeAuditVerdict(item.auditVerdict)) {
      reference = null;
      deliverableSource = 'audit-verdict';
    } else if (isNonCodeWorkItemKind(item.workItemKind)) {
      reference = null;
      deliverableSource = 'work-item-kind';
    } else {
      const planType = registry.planType(builtinPlanTypeId(profile));
      // An unresolvable plan type has no default to offer: name a reference that cannot
      // resolve, so the item fails safe below instead of borrowing another type's default.
      reference = planType ? planType.definition.defaultItemType : { id: builtinPlanTypeId(profile) };
      deliverableSource = 'profile-default';
    }

    let deliverable: DeliverableKind | null;
    let modules: VerificationModule[];
    if (reference === null) {
      deliverable = null;
      modules = normalizeModules(domainModules);
    } else {
      const resolved = registry.itemType(reference.id, reference);
      deliverable = builtinKindOf(resolved?.definition.id ?? reference.id);
      modules = resolved
        ? normalizeModules([...resolved.definition.modules, ...domainModules])
        : [...STRICTEST_MODULES];
    }
    return {
      profile,
      profileSource,
      deliverable,
      codeDeliverable: modules.includes('code'),
      deliverableSource,
      modules,
    };
  };
}
