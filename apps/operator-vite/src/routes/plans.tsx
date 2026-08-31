import { createFileRoute } from '@tanstack/react-router';
import PlansPane from '@/app/_components/plans/PlansPane';

/**
 * `/plans` — Direction B's focused portal embed. This is composition only:
 * PlansPane remains the canonical reader/action owner, including its filters,
 * plan dashboard navigation, and PlansCleanupStrip bulk cleanup flow.
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
      <PlansPane />
    </div>
  );
}
