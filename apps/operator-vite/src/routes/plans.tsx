import { createFileRoute } from '@tanstack/react-router';
import PlansPane from '@/app/_components/plans/PlansPane';

/**
 * `/plans` — Direction B's focused portal embed. This is composition only:
 * PlansPane remains the canonical reader/action owner, including its filters,
 * plan dashboard navigation, and PlansCleanupStrip bulk cleanup flow.
 *
 * `layout="split"` (portal-work-two-pane-2026-09-01 D-001): the full page lays
 * the plan list out beside the selected plan's dashboard (`?pdash`, rendered
 * in the pane's own aside — the root PlanDashboardHost takeover is skipped on
 * this route), while the chat sidebar keeps the pane's stack default.
 */
export const Route = createFileRoute('/plans')({
  component: PlansEmbedRoute,
});

export function PlansEmbedRoute() {
  return (
    <div
      className="portal-focused-work-surface"
      data-testid="plans-portal-embed"
      data-portal-surface="plans"
    >
      <PlansPane layout="split" />
    </div>
  );
}
