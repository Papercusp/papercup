/**
 * Loads each harness's plan-review (PG-canonical, mirrored from
 * `.papercusp/plan-review.md` via fs-watcher) and renders a compact
 * summary for the operator's prompt. Surfaces non-`accept` verdicts so
 * the operator can emit `inform` cards for plan-gate decisions the user
 * hasn't seen yet.
 *
 * Plan-review is one-shot per harness (skipped if the file exists), so
 * this is a flat snapshot — no history. Once the user dismissed an
 * inform card for a plan-review, it stays dismissed via the operator
 * cooldown cache; nothing in this module tracks that.
 */

import { getOrgPg, generated } from '@papercusp/db-org';

const hpr = generated.harnessPlanReviewInHarnessShared;

const MAX_BODY_BYTES = 32 * 1024;
const SUMMARY_CHARS = 200;

export type PlanReviewVerdict = 'accept' | 'accept-with-notes' | 'reject' | 'unknown';

export interface PlanReviewEntry {
  slug: string;
  verdict: PlanReviewVerdict;
  /** First non-empty line after VERDICT, trimmed to SUMMARY_CHARS. */
  summary: string;
  mtimeMs: number;
}

function parseVerdict(line: string): PlanReviewVerdict {
  const v = line.trim().toLowerCase();
  if (v === 'accept') return 'accept';
  if (v === 'accept-with-notes' || v === 'accept with notes') return 'accept-with-notes';
  if (v === 'reject') return 'reject';
  return 'unknown';
}

export async function loadHarnessPlanReviews(): Promise<PlanReviewEntry[]> {
  const { db } = getOrgPg();
  const rows = await db
    .select({ harness_slug: hpr.harnessSlug, content: hpr.content, mtime_ms: hpr.mtimeMs })
    .from(hpr);
  const out: PlanReviewEntry[] = [];
  for (const r of rows) {
    const body = r.content ?? '';
    if (body.length > MAX_BODY_BYTES) continue;
    const verdictMatch = body.match(/^VERDICT:\s*(.+)$/m);
    const verdict: PlanReviewVerdict = verdictMatch ? parseVerdict(verdictMatch[1]) : 'unknown';
    const summary = body
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => l && !/^VERDICT:/i.test(l))
      ?.slice(0, SUMMARY_CHARS) ?? '';
    out.push({
      slug: r.harness_slug,
      verdict,
      summary,
      mtimeMs: Number(r.mtime_ms) || 0,
    });
  }
  return out;
}

/**
 * Compact prompt section. Operator should only surface non-`accept`
 * verdicts to the user — `accept` is the boring case (plan-gate said
 * "ship it"); `accept-with-notes` and `reject` carry actionable content.
 */
export function renderHarnessPlanReviewsForPrompt(entries: PlanReviewEntry[]): string {
  const interesting = entries.filter((e) => e.verdict !== 'accept');
  if (interesting.length === 0) return '';
  const lines: string[] = [
    '## Plan reviews (non-trivial verdicts)',
    '',
    'Each harness gets one plan-review.md when scoping completes. Surface each',
    'non-accept verdict below as an `inform` card (action="inform", tier="low")',
    'unless the user has already dismissed it. Title format:',
    '`Plan review · <slug> · <verdict>`. Body = the summary line below.',
    '',
  ];
  for (const e of interesting) {
    lines.push(`- **${e.slug}** · ${e.verdict} — ${e.summary || '(no body)'}`);
  }
  return lines.join('\n');
}
