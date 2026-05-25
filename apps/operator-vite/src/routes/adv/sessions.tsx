import { createFileRoute, redirect } from '@tanstack/react-router';

export const Route = createFileRoute('/adv/sessions')({
  beforeLoad: () => {
    throw redirect({ to: '/adv', search: { tab: 'sessions' } });
  },
});
