import { createFileRoute, redirect } from '@tanstack/react-router';

export const Route = createFileRoute('/adv/brainstorm')({
  beforeLoad: () => {
    throw redirect({ to: '/adv', search: { tab: 'brainstorm' } });
  },
});
