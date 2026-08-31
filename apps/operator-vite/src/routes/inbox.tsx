import { createFileRoute } from '@tanstack/react-router';
import InboxPane from '@/app/_components/inbox/InboxPane';

/**
 * `/inbox` — Direction B's focused portal embed. InboxPane owns the complete
 * canonical attention flow, including selection/detail, discussion, and the
 * explicit InboxBulkStrip resolve/review/settle lifecycle.
 */
export const Route = createFileRoute('/inbox')({
  component: InboxEmbedRoute,
});

export function InboxEmbedRoute() {
  return (
    <div
      className="portal-focused-work-surface"
      data-testid="inbox-portal-embed"
      data-portal-surface="inbox"
    >
      <InboxPane />
    </div>
  );
}
