/**
 * Shared substrate rules for the mug/kettle recurrence guard.
 *
 * `SUBSTRATE_SYMBOLS` is consulted only for the census's function-call detector.
 * Keeping the validation and remediation wording here makes that scope executable
 * instead of leaving it as an implicit convention in two scripts.
 */

/**
 * Return entries that the census cannot consult because they are not in the detector's
 * function vocabulary. A name-keyed system action must never be added to this set:
 * it would look exempt while changing no census result.
 */
export function findDanglingSubstrateSymbols(symbols, detectorFunctionNames) {
  const known = new Set(detectorFunctionNames);
  return [...symbols].filter((symbol) => !known.has(symbol));
}

/**
 * Build the remediation lines for new ungated findings.
 *
 * Only `wake` findings use the function-name-keyed SUBSTRATE_SYMBOLS exemption. Other
 * categories, especially `system-action`, are keyed by a different identity and must
 * be kept in the reviewed baseline when intentionally ungated (or gated when not).
 */
export function substrateRemediationLines(findings) {
  const categories = [...new Set(findings.map((finding) => finding.category))];
  const lines = [];

  if (categories.includes('wake')) {
    lines.push(
      "For wake/function-call findings, a genuine shared-substrate site belongs in the census's SUBSTRATE_SYMBOLS — not in this baseline.",
    );
  }

  const nameKeyedCategories = categories.filter((category) => category !== 'wake');
  if (nameKeyedCategories.length > 0) {
    lines.push(
      `For ${nameKeyedCategories.join(', ')} findings, SUBSTRATE_SYMBOLS is function-name keyed and cannot express those names. If the site is intentionally ungated, keep its category/subject/path identity in the reviewed baseline; otherwise gate it. Do not add a name-keyed finding to SUBSTRATE_SYMBOLS.`,
    );
  }

  return lines;
}
