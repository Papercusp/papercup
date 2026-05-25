import { createFileRoute, redirect } from '@tanstack/react-router';

export const Route = createFileRoute('/adv/plans')({
  beforeLoad: () => {
    throw redirect({ to: '/adv', search: { tab: 'plans' } });
  },
});
