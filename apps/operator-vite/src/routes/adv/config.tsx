import { createFileRoute, redirect } from '@tanstack/react-router';

export const Route = createFileRoute('/adv/config')({
  beforeLoad: () => {
    throw redirect({ to: '/adv', search: { tab: 'config' } });
  },
});
