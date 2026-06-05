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

// Accepts both canonical `**[VAL-id]**` and scoper-written `[VAL-id] description` forms.
const VAL_HEADER_RE = /^\s{1,8}-\s+\*{0,2}\[VAL-([^\]]+)\]\*{0,2}(?:\s.*)?$/;
const VAL_FIELD_RE = /^\s{2,12}-\s+\*\*(Verify|Evidence|Status|RequiresTest):\*\*\s*(.*)/;
const ITEM_LINE_RE = /^-\s+\*\*(P-\d{3,})\*\*/;

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
export function extractAssertions(
  raw: string,
  itemIds?: Set<string>,
): PlanAssertion[] {
  const lines = raw.split('\n');
  const results: PlanAssertion[] = [];

  let currentItemId: string | null = null;
  let currentAssertion: Partial<PlanAssertion> & { valId: string; itemId: string } | null = null;

  function flush() {
    if (!currentAssertion) return;
    const a = currentAssertion;
    if (a.verifyText) {
      results.push({
        valId: a.valId,
        itemId: a.itemId,
        verifyText: a.verifyText.trim(),
        evidenceText: (a.evidenceText ?? '').trim(),
        status: a.status ?? 'todo',
        requiresTest: a.requiresTest ?? true,
      });
    }
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
      currentAssertion = { valId: `VAL-${valHeader[1]}`, itemId: currentItemId };
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
