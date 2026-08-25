/**
 * VAL-* inline assertion extraction.
 *
 * Parses inline VAL-* assertion sub-bullets from a plan's raw markdown body.
 * Format spec: /internal/docs/spec/validation-assertion-format
 *
 * Each assertion is a nested block under a plan item:
 *
 *   - **P-007** `todo` Implement CSV export.
 *     - **[VAL-my-plan-2026-05-26-001]**
 *       - **Verify:** …
 *       - **Evidence:** …
 *       - **Status:** `todo`
 */

export interface PlanAssertion {
  valId: string;
  itemId: string;
  verifyText: string;
  evidenceText: string;
  status: 'todo' | 'validating' | 'passed' | 'failed';
  /**
   * Whether this VAL needs a passing automated test before the feature can
   * be approved. Default `true`; an optional `RequiresTest: false` sub-bullet
   * exempts non-testable claims (copy, design-spec, judgement). The tester
   * gate (orchestrator C0) + validator gate skip `requires_test = false` VALs.
   */
  requiresTest: boolean;
}

/**
 * Non-lossy parse result used by the first-class spec compiler.
 *
 * `extractAssertions` intentionally preserves its historical behavior of
 * returning only assertions with a `Verify:` field.  Compiler/migration paths
 * need to see incomplete legacy blocks too, otherwise an ambiguous assertion
 * silently disappears instead of remaining a reviewable draft.
 */
export interface PlanAssertionCandidate {
  valId: string;
  itemId: string;
  /** Text written on the VAL header after the closing bracket, if any. */
  headerText?: string;
  verifyText?: string;
  evidenceText?: string;
  status?: PlanAssertion['status'];
  /** Undefined means the legacy block omitted the field (historical default: true). */
  requiresTest?: boolean;
}

// Accepts both canonical `**[VAL-id]**` and scoper-written `[VAL-id] description` forms.
const VAL_HEADER_RE = /^\s{1,8}-\s+\*{0,2}\[VAL-([^\]]+)\]\*{0,2}(?:\s+(.*?))?\s*$/;
const VAL_FIELD_RE = /^\s{2,12}-\s+\*\*(Verify|Evidence|Status|RequiresTest):\*\*\s*(.*)/;
const ITEM_LINE_RE = /^-\s+\*\*(P-\d{3,})\*\*/;

/**
 * Recognize the canonical nested VAL metadata bullets without exposing the
 * parsing regexes themselves to callers that only need structural detection.
 * These helpers intentionally remain line-oriented: callers still decide
 * whether the line is nested inside an active VAL block.
 */
export function isValAssertionHeaderLine(line: string): boolean {
  return VAL_HEADER_RE.test(line);
}

export function isValAssertionFieldLine(line: string): boolean {
  return VAL_FIELD_RE.test(line);
}

function parseStatus(raw: string): PlanAssertion['status'] {
  const s = raw.replace(/`/g, '').trim().toLowerCase();
  if (s === 'validating' || s === 'passed' || s === 'failed') return s;
  return 'todo';
}

// `RequiresTest:` defaults to true; only an explicit false/no/0 exempts.
function parseRequiresTest(raw: string): boolean {
  const s = raw.replace(/`/g, '').trim().toLowerCase();
  return !(s === 'false' || s === 'no' || s === '0');
}

/**
 * Extract all VAL-* assertions from the raw plan markdown, scoped to the
 * given item IDs. Pass `itemIds` as a Set for fast lookup; omit/pass empty
 * to extract from ALL items.
 */
export function extractAssertionCandidates(raw: string, itemIds?: Set<string>): PlanAssertionCandidate[] {
  const lines = raw.split('\n');
  const results: PlanAssertionCandidate[] = [];

  let currentItemId: string | null = null;
  let currentAssertion: PlanAssertionCandidate | null = null;

  function flush() {
    if (!currentAssertion) return;
    results.push(currentAssertion);
    currentAssertion = null;
  }

  for (const line of lines) {
    // Top-level item line — update current item context.
    const itemMatch = ITEM_LINE_RE.exec(line);
    if (itemMatch) {
      flush();
      currentItemId = itemMatch[1];
      continue;
    }

    if (!currentItemId) continue;
    if (itemIds && itemIds.size > 0 && !itemIds.has(currentItemId)) continue;

    // VAL-* header line: `  - **[VAL-slug-001]**`
    const valHeader = VAL_HEADER_RE.exec(line);
    if (valHeader) {
      flush();
      currentAssertion = {
        valId: `VAL-${valHeader[1]}`,
        itemId: currentItemId,
        ...(valHeader[2]?.trim() ? { headerText: valHeader[2].trim() } : {}),
      };
      continue;
    }

    if (!currentAssertion) continue;

    // Sub-field line: `    - **Verify:** …` etc.
    const fieldMatch = VAL_FIELD_RE.exec(line);
    if (fieldMatch) {
      const key = fieldMatch[1];
      const value = fieldMatch[2].trim();
      if (key === 'Verify') currentAssertion.verifyText = value;
      else if (key === 'Evidence') currentAssertion.evidenceText = value;
      else if (key === 'Status') currentAssertion.status = parseStatus(value);
      else if (key === 'RequiresTest') currentAssertion.requiresTest = parseRequiresTest(value);
    }
  }

  flush();
  return results;
}

/**
 * Extract all complete VAL-* assertions from the raw plan markdown, scoped to
 * the given item IDs. Pass `itemIds` as a Set for fast lookup; omit/pass empty
 * to extract from ALL items.
 */
export function extractAssertions(raw: string, itemIds?: Set<string>): PlanAssertion[] {
  return extractAssertionCandidates(raw, itemIds)
    .filter((candidate): candidate is PlanAssertionCandidate & { verifyText: string } =>
      Boolean(candidate.verifyText?.trim()),
    )
    .map((candidate) => ({
      valId: candidate.valId,
      itemId: candidate.itemId,
      verifyText: candidate.verifyText.trim(),
      evidenceText: (candidate.evidenceText ?? '').trim(),
      status: candidate.status ?? 'todo',
      requiresTest: candidate.requiresTest ?? true,
    }));
}
