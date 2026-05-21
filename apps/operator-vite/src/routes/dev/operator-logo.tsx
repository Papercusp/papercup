import { createFileRoute } from '@tanstack/react-router';
import OperatorLogoLabPage from '@/app/dev/operator-logo/page';

/**
 * /dev/operator-logo — three Papercup logo direction previews.
 * Translated from `apps/operator/app/dev/operator-logo/page.tsx` (clean).
 */
export const Route = createFileRoute('/dev/operator-logo')({
  component: OperatorLogoLabPage,
});
