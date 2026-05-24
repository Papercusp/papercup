import { createFileRoute, redirect } from '@tanstack/react-router';

/**
 * /adv lands on /adv/plans. TSR's loader-redirect runs before any
 * component mount, so this is the equivalent of the Next page.tsx
 * `redirect('/adv/plans')`.
 */
export const Route = createFileRoute('/adv/')({
  beforeLoad: () => {
    throw redirect({ to: '/adv/plans' });
  },
});
