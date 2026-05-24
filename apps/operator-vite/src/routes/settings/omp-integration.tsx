import { createFileRoute } from '@tanstack/react-router';
import Page from '@/app/settings/omp-integration/page';

/**
 * /settings/omp-integration — P-012 of desktop-app-install-integration-2026-05-23.
 *
 * Opt-in engineer-collaborator wiring for OMP. Reuses the page-import
 * pattern (B-4) — page lives in apps/operator/app/settings/omp-integration/.
 */
export const Route = createFileRoute('/settings/omp-integration')({
  component: Page,
});
