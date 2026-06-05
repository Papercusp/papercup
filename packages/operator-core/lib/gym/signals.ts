/**
 * Deterministic signal cores (P-003) — the un-gameable guardrails (D-011). The
 * optimizer cannot touch the repo's own tests or the planted defect, so these are
 * trustworthy gates/monitors (never optimization targets).
 *
 * Pure cores only. Running the repo's test suite pre/post and reading the harness's
 * produced issues is the integration layer (P-002 collector + fake-agent smoke /
 * P-014 real run); they feed these functions their inputs.
 */
import type { PlantedBug } from './probe-generator';

export interface TestResult {
  name: string;
  passed: boolean;
}

/**
 * Did the change break a PRE-EXISTING test? True iff some test present in BOTH the
 * pre and post runs flipped pass→fail. New failing tests and already-failing tests
 * do not count — only a genuine regression of the repo's own prior-green tests.
 */
export function regressionsFromTests(pre: readonly TestResult[], post: readonly TestResult[]): boolean {
  const postByName = new Map(post.map((t) => [t.name, t.passed]));
  for (const t of pre) {
    if (!t.passed) continue; // wasn't green before → not a regression
    const after = postByName.get(t.name);
    if (after === false) return true; // green before, red after → regression
  }
  return false;
}

/** Distinctive identifier-ish tokens (len ≥ 4) from a planted-bug location. */
function locationTokens(location: string): string[] {
  return location
    .split(/[^A-Za-z0-9]+/)
    .map((t) => t.toLowerCase())
    .filter((t) => t.length >= 4);
}

/**
 * Did the harness catch the planted defect? A cheap, near-un-gameable MONITOR: true
 * iff the harness's produced output (validator/crosscheck verdict, filed issues)
 * references the defect's location — i.e. it noticed where the bug lives. Fuzzy by
 * design (a guardrail, not a precise gate — D-011).
 */
export function plantedBugCaught(bug: PlantedBug, harnessOutputText: string): boolean {
  const hay = harnessOutputText.toLowerCase();
  return locationTokens(bug.location).some((tok) => hay.includes(tok));
}
