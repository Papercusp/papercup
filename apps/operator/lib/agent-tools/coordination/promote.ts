/**
 * promote.ts — pure helpers for `plans:promote`.
 *
 * This module used to also hold the SC-NNN allocator + SPEC.md mutator
 * (agent-coordination-architecture-v2 §11.3/§11.4), which appended
 * `[SC-NNN]` acceptance criteria to a harness SPEC.md on promote. That
 * path was retired by `plans-central-harness-ux-2026-05-26` (D-004):
 * plans replaced SPEC.md as the authoritative scope/acceptance document.
 * `plans:promote` now extracts inline VAL-* assertions into
 * `harness_plan_assertions` + `feature.claims` (D-005) instead of writing
 * SPEC.md, so the SC-NNN allocator (`parseScIds`/`maxScNum`/
 * `allocateNextScIds`) and the SPEC mutator (`appendCriteriaToSpec`/
 * `buildSpecMutation`) were removed. What remains is the pure
 * `from_items` validator the tool still calls.
 */

/**
 * One promote-input feature with the items it covers. The tool maps the
 * caller's feature list onto this shape; `findUnknownFromItems` validates
 * the `from_items` references before any side effects.
 */
export interface PromoteFeatureInput {
  title: string;
  body?: string;
  acceptance?: string[];
  from_items?: string[];
}

/**
 * Collect every `from_items` P-NNN across `features` that is NOT in
 * `knownItemIds` (the plan's actual item ids). Sorted, de-duplicated.
 *
 * A non-empty result means the caller named a plan item that does not
 * exist — `plans:promote` rejects rather than silently dropping it
 * during the mark step (audit B2).
 */
export function findUnknownFromItems(
  features: Array<{ from_items?: string[] }>,
  knownItemIds: Iterable<string>,
): string[] {
  const known = new Set(knownItemIds);
  const unknown = new Set<string>();
  for (const f of features) {
    for (const id of f.from_items ?? []) {
      if (!known.has(id)) unknown.add(id);
    }
  }
  return [...unknown].sort();
}
