'use client';

/**
 * HarnessWelcomeEmptyState — the post-SPEC.md harness onboarding welcome.
 *
 * Plan: spec-md-ui-deprecation-cleanup-2026-05-30 P-005 (copy decided
 * verbatim by avi in D-003). Replaces the deleted SPEC.md bootstrap
 * toast/CTA (HarnessDashboard 2744/2772, gone with the monolith in
 * ad5897d58) — the harness home no longer points new users at a retired
 * SPEC.md; it walks the real flow: brainstorm → plan → start → watch.
 *
 * Shown as an overlay on the /adv Harness-tab dock when the selected
 * harness has no work yet: zero started plans AND zero eligible
 * (non-deprecated) features. Both sources must have LOADED and confirmed
 * empty before the card shows — a fetch error or in-flight load renders
 * nothing, so a working harness never flashes the welcome.
 *
 * Dismissal is URL state (`?welcome=false`, nuqs) per the nuqs-first
 * rule — agents can read/drive it via ui:get_state / ui:dispatch.
 */

import { useEffect, useState } from 'react';
import { parseAsBoolean, parseAsString, useQueryState } from 'nuqs';
import { fetchPlanList, type PlanListRow } from '@/app/admin/plans/plans-api';
import { useHarnessFeatures } from './useHarnessData';

/** One-shot started-plan probe for a harness. null = unknown (loading or
 * fetch error) — the caller must treat unknown as "don't show". */
function useHasStartedPlans(slug: string): boolean | null {
  const [hasStarted, setHasStarted] = useState<boolean | null>(null);
  useEffect(() => {
    if (!slug) {
      setHasStarted(null);
      return;
    }
    let cancel = false;
    setHasStarted(null);
    fetchPlanList({ harness_slugs: [slug] })
      .then(({ plans }: { plans: PlanListRow[] }) => {
        if (cancel) return;
        setHasStarted(plans.some((p) => p.startStatus !== null));
      })
      .catch(() => {
        // Unknown — keep null so the welcome never shows on a hiccup.
        if (!cancel) setHasStarted(null);
      });
    return () => {
      cancel = true;
    };
  }, [slug]);
  return hasStarted;
}

export default function HarnessWelcomeEmptyState({ slug }: { slug: string }) {
  // `?welcome=false` = dismissed. URL state so it survives reloads and is
  // agent-visible; flips back automatically the next time the param drops.
  const [welcome, setWelcome] = useQueryState('welcome', parseAsBoolean.withDefault(true));
  const [, setActiveTab] = useQueryState('tab', parseAsString);

  const { features } = useHarnessFeatures(slug);
  const hasStartedPlans = useHasStartedPlans(slug);

  if (!welcome) return null;
  if (features === null || hasStartedPlans === null) return null; // still loading / unknown
  const eligible = features.filter((f) => f.status !== 'deprecated');
  if (eligible.length > 0 || hasStartedPlans) return null;

  return (
    <div
      className="pc-adv-harnesses__welcome"
      data-testid="harness-welcome"
      onClick={() => void setWelcome(false)}
    >
      <section
        className="pc-adv-harnesses__welcome-card"
        aria-label="Welcome to your harness"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="pc-adv-harnesses__welcome-title">Welcome to your harness.</h2>
        <p className="pc-adv-harnesses__welcome-body">
          Come up with ideas in the brainstorm tab, plan them in the plan tab. Start them, and
          then watch agents work on them in the harness tab.
        </p>
        <div className="pc-adv-harnesses__welcome-actions">
          <button
            type="button"
            className="pc-adv-harnesses__create-cta"
            onClick={() => void setActiveTab('brainstorm')}
          >
            Open brainstorm
          </button>
          <button
            type="button"
            className="pc-adv-harnesses__create-cta"
            onClick={() => void setActiveTab('plans')}
          >
            Open plans
          </button>
        </div>
        <button
          type="button"
          className="pc-adv-harnesses__welcome-dismiss"
          onClick={() => void setWelcome(false)}
        >
          Show the workspace anyway
        </button>
      </section>
      <style>{`
        .pc-adv-harnesses__welcome {
          position: absolute;
          inset: 0;
          z-index: 6;
          display: flex;
          align-items: center;
          justify-content: center;
          padding: 24px;
          background: color-mix(in srgb, var(--bg, #0b0e1a), transparent 30%);
          backdrop-filter: blur(2px);
        }
        .pc-adv-harnesses__welcome-card {
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: 12px;
          max-width: 440px;
          padding: 28px 32px;
          text-align: center;
          background:
            radial-gradient(ellipse at 50% -10%, color-mix(in srgb, var(--accent-cool, #38bdf8), transparent 92%), transparent 60%),
            color-mix(in srgb, var(--bg-1, #11152a), transparent 12%);
          border: 1px solid color-mix(in srgb, var(--accent, #38bdf8), transparent 70%);
          border-radius: 10px;
          box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
        }
        .pc-adv-harnesses__welcome-title {
          margin: 0;
          font-size: 17px;
          font-weight: 700;
          color: var(--fg, #e7eaf6);
        }
        .pc-adv-harnesses__welcome-body {
          margin: 0;
          font-size: 13px;
          line-height: 1.6;
          color: rgba(220, 214, 248, 0.75);
        }
        .pc-adv-harnesses__welcome-actions {
          display: flex;
          gap: 10px;
          margin-top: 6px;
        }
        .pc-adv-harnesses__welcome-dismiss {
          margin-top: 2px;
          padding: 2px 4px;
          background: none;
          border: none;
          color: rgba(220, 214, 248, 0.45);
          font-size: 11px;
          cursor: pointer;
          text-decoration: underline;
        }
        .pc-adv-harnesses__welcome-dismiss:hover {
          color: rgba(220, 214, 248, 0.7);
        }
      `}</style>
    </div>
  );
}
