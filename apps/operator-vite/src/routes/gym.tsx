import { createFileRoute } from '@tanstack/react-router';
import GymDashboard from '@/app/gym/GymDashboard';

/**
 * /gym — Harness Gym dashboard: prompt editor, proposer-diff review (accept→promote),
 * autoloop control, and run analytics (cycles/variants/compare/frontier) over the gym
 * control plane (`/api/gym/*`, D-020). Impl in apps/operator/app/gym/GymDashboard.tsx.
 */
export const Route = createFileRoute('/gym')({
  component: GymPage,
});

function GymPage() {
  return <GymDashboard />;
}
