'use client';

import { useSyncQuery } from '@papercusp/sync';
import { parseAsString, useQueryState } from 'nuqs';

import type { PlanAcceptanceGateVerdictRow } from '@papercusp/operator-core/lib/sync-resolver/plan-acceptance-gate-verdict';

/**
 * P-011 — the plan-surface view of the ACCEPTANCE GATE verdict: rubric role/verdict and
 * the EXACT blocker.
 *
 * `evaluatePlanAcceptanceGate` is called by `plans:set-status` and the unshipped-plans
 * audit and NOWHERE else, so its verdict was reachable only by attempting a ship. A
 * human could not see which rubric a plan is judged against, who graded it, or what
 * would refuse — until they tried and were refused.
 *
 * ⚠ THE RENDERING RULE, and it runs OPPOSITE to the sibling coverage section. There, the
 * findings are advisory and must not look like failures (D-018). Here the codes ARE real
 * refusals, so a blocker renders as a blocker — and the honesty burden moves onto the
 * PASSES instead. Three states are satisfied-but-not-clean, and flattening any of them
 * into a green claims a verification that did not happen:
 *
 *   · `skipped` — the gate did not APPLY. Nothing was checked.
 *   · `forcedPast` — a human waived the code-truth family with a recorded reason. The
 *     gate exists to make that visible ("a force that is easy to hide is worth very
 *     little"), so the waiver and its reason are rendered, never summarized away.
 *   · `vettedUnderWaiver` — the rubric was vetted over a consult nobody critiqued
 *     (EI-20821478338037350). Allowed, but the reader is entitled to know.
 */

export const PLAN_ACCEPTANCE_GATE_PARAM = 'gate';

export function PlanAcceptanceGateSection({ slug }: { slug: string }) {
  const [openSlug, setOpenSlug] = useQueryState(PLAN_ACCEPTANCE_GATE_PARAM, parseAsString);
  const open = openSlug === slug;

  const query = useSyncQuery<PlanAcceptanceGateVerdictRow>({
    queryName: 'plans.acceptanceGate',
    args: { planSlug: slug },
    enabled: open && Boolean(slug),
  });
  const row = query.loading ? null : (query.data?.[0] ?? null);

  // A pass with a caveat is NOT a clean pass. Computed once so the badge and the body
  // cannot disagree about it.
  const caveated = Boolean(row && (row.skipped || row.forcedPast || row.vettedUnderWaiver));
  const badge = !row
    ? ''
    : row.unavailableReason
      ? ' — unavailable'
      : row.skipped
        ? ' — not checked'
        : !row.satisfied
          ? ' — BLOCKED'
          : caveated
            ? ' — passed with caveats'
            : ' — passed';

  return (
    <section className="pc-plan-gate" aria-label="Acceptance gate">
      <div className="pc-now-hero__row">
        <button
          type="button"
          data-testid="plan-acceptance-gate-toggle"
          aria-expanded={open}
          aria-controls={`plan-acceptance-gate-${slug}`}
          onClick={() => void setOpenSlug(open ? null : slug)}
        >
          Acceptance gate{badge}
        </button>
      </div>

      {open ? (
        <div id={`plan-acceptance-gate-${slug}`}>
          {query.loading ? (
            <div className="det-label">Evaluating the acceptance gate…</div>
          ) : !row || row.unavailableReason ? (
            /* The gate never throws by contract, so a failure here is infrastructure —
               and must never be shown as a pass. */
            <div className="det-label" data-testid="plan-acceptance-gate-unavailable">
              Acceptance gate could not be evaluated. This is NOT evidence that the plan
              would pass.
            </div>
          ) : (
            <>
              {/* NOT CHECKED ≠ PASSED. */}
              {row.skipped ? (
                <div className="det-label" data-testid="plan-acceptance-gate-skipped">
                  ⓘ Gate did NOT APPLY ({row.skipped.replace(/-/g, ' ')}) — nothing was
                  checked. This is not a pass.
                </div>
              ) : null}

              {/* THE EXACT BLOCKER. A real refusal, rendered as one. */}
              {!row.satisfied && row.code ? (
                <div data-testid="plan-acceptance-gate-blocking">
                  <div className="det-label">
                    ⛔ Ship BLOCKED — <strong>{row.code}</strong>
                  </div>
                  {/* The gate's teaching message is rendered VERBATIM: it names the
                      concrete next action, and summarizing it throws that away. */}
                  {row.message ? <div>{row.message}</div> : null}
                </div>
              ) : null}

              {/* A RECORDED WAIVER. Never silent — that is the whole point of stamping it. */}
              {row.forcedPast ? (
                <div data-testid="plan-acceptance-gate-forced">
                  <div className="det-label">
                    ⚠ Code-truth checks WAIVED by an explicit force — this plan did not
                    satisfy them
                  </div>
                  <div>Reason: {row.forcedPast.reason}</div>
                  <div className="det-label">
                    Waived: {row.forcedPast.checks.join(', ') || '(none recorded)'}
                  </div>
                </div>
              ) : null}

              {/* Vetted over a consult nobody critiqued (EI-20821478338037350). */}
              {row.vettedUnderWaiver ? (
                <div className="det-label" data-testid="plan-acceptance-gate-vetting-waiver">
                  ⚠ Rubric vetted under waiver — consult {row.vettedUnderWaiver.consultId}{' '}
                  received NO external critique
                  {row.vettedUnderWaiver.reason ? `: ${row.vettedUnderWaiver.reason}` : ''}
                </div>
              ) : null}

              {/* RUBRIC ROLE + VERDICT. */}
              <div className="det-label" data-testid="plan-acceptance-gate-rubric">
                {row.rubricId
                  ? `Judged against rubric: ${row.rubricId}`
                  : 'No acceptance rubric resolved for this plan.'}
              </div>
              <div className="det-label" data-testid="plan-acceptance-gate-grader">
                {row.gradedBy
                  ? `Independently graded by: ${row.gradedBy}`
                  : 'No independent grading recorded — a self-grading does not satisfy this gate.'}
              </div>
            </>
          )}
        </div>
      ) : null}
    </section>
  );
}
