/**
 * Read-time audit-target currentness for PENDING same-subject scorecards
 * (EI-28807501130212029).
 *
 * A pending grading audit on a same-rubric, same-subject card blocks every new
 * card (scorecards:emit's `grading_audit_required` gate), and certify-spec-clauses
 * supersedes such a card only when it is the ONE pending card. Both readers list
 * candidates with `listScorecards`, whose rows answer superseded / retracted /
 * rubric and subject-rubric currentness, but NOT evidence-binding currentness:
 * that relation (a cited immutable proof row has since been retracted) is computed
 * only by `readScorecard` and surfaces as `auditTarget.current === false`.
 *
 * The former `card.auditTarget?.current !== false` filters on list rows were
 * therefore always true, so a card whose cited proof was retracted kept blocking
 * the clause, and made "the one pending card" ambiguous for the stranded-card
 * supersede. This module re-reads exactly the cards that can carry that relation,
 * the same population the grading-integrity dispatcher re-reads before it treats
 * a pending card as auditable.
 */
import { mapWithConcurrency } from './gym/concurrency';
import { listScorecards, readScorecardRecipeHeader, type ScorecardListCursor, type ScorecardRow } from './scorecards';

/** Matches the grading-integrity dispatcher's per-pass evidence-read width. */
const PENDING_CURRENTNESS_READ_CONCURRENCY = 4;

/**
 * True for a spec-test-adequacy card whose recipe cites immutable evidence
 * bindings. Newer recipes pin row ids (`selection.bindingIds`); legacy recipes
 * pin the same rows by their exact `args.current` tuples. Only these cards have
 * an evidence-binding currentness dimension at read time.
 */
export function scorecardCitesSpecEvidenceBindings(card: Pick<ScorecardRow, 'rerunRecipe'>): boolean {
  const recipe = card.rerunRecipe;
  return recipe?.evaluator === 'plans:evaluate-spec-test-adequacy' &&
    Boolean(recipe.selection.bindingIds?.length || recipe.args.current?.length);
}

/**
 * The list-row half of "does this card hold the subject's pending audit": a
 * pending, unretracted, unsuperseded card for exactly this subject whose graded
 * rubric and subject rubric are not stale. emit's `grading_audit_required` gate and
 * certify's one-stranded-card check must share it, or certify can count a card as
 * blocking that emit ignores. Pair it with {@link withoutStaleAuditTargetPendingCards}
 * for the evidence-binding half that list rows cannot answer.
 */
export function isListedPendingSubjectBlocker(
  card: ScorecardRow,
  subject: { kind?: string | null; ref: string },
): boolean {
  return card.gradingAudit?.state === 'pending' &&
    card.rubricCurrentness?.state !== 'stale' &&
    card.subjectRubricCurrentness?.state !== 'stale' &&
    !card.retracted &&
    card.subject?.ref === subject.ref &&
    (card.subject?.kind ?? null) === (subject.kind ?? null) &&
    card.supersededBy == null;
}

/**
 * Drop pending cards whose audit target is no longer current. Fails closed: a
 * card is dropped only when its recipe header is found for the same issue id and
 * reports `auditTarget.current === false`. A read failure, a missing card, or an
 * `unknown` (null) currentness keeps the card in the list, which is the same
 * blocking outcome the caller had before this check existed. Order is preserved.
 */
export async function withoutStaleAuditTargetPendingCards<T extends ScorecardRow>(
  cards: readonly T[],
): Promise<T[]> {
  const keep = await mapWithConcurrency(cards, PENDING_CURRENTNESS_READ_CONCURRENCY, async (card) => {
    if (!scorecardCitesSpecEvidenceBindings(card)) return true;
    try {
      const header = await readScorecardRecipeHeader(card.issueId);
      return !(
        header.kind === 'found' &&
        header.scorecard.issueId === card.issueId &&
        header.scorecard.auditTarget.current === false
      );
    } catch (error) {
      console.warn(
        `[scorecard-pending-audit-currentness] audit-target read failed for ${card.issueId}; keeping it as a pending blocker:`,
        error instanceof Error ? error.message : error,
      );
      return true;
    }
  });
  return cards.filter((_, index) => keep[index]);
}

/**
 * Read the complete pending-blocker population. A full history page is never an
 * exhaustion verdict: follow the existing immutable keyset until a short page.
 * Each new invocation starts a fresh scan, so no retained cursor can starve an
 * older blocker or hide a changed audit target. A broken continuation refuses
 * the decision instead of returning an incomplete population.
 */
export async function listPendingSubjectBlockers(
  rubricRef: string,
  subject: { kind?: string | null; ref: string },
  excludeIssueId?: string,
): Promise<ScorecardRow[]> {
  const pageSize = 100;
  const pending: ScorecardRow[] = [];
  let before: ScorecardListCursor | undefined;
  for (;;) {
    const page = await listScorecards({
      rubricRef,
      subjectRef: subject.ref,
      limit: pageSize,
      ...(before ? { before } : {}),
    });
    pending.push(...await withoutStaleAuditTargetPendingCards(page.filter(
      (card) => isListedPendingSubjectBlocker(card, subject) && card.issueId !== excludeIssueId,
    )));
    if (page.length < pageSize) return pending;
    const tail = page[page.length - 1]!;
    if (!tail.createdAt || !Number.isFinite(Date.parse(tail.createdAt)) || !tail.issueId) {
      throw new Error('Pending scorecard history has no valid continuation identity');
    }
    if (before?.createdAt === tail.createdAt && before.issueId === tail.issueId) {
      throw new Error('Pending scorecard history continuation did not advance');
    }
    before = { createdAt: tail.createdAt, issueId: tail.issueId };
  }
}
