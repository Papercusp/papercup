import { createFileRoute } from '@tanstack/react-router';
import InboxPane from '@/app/_components/inbox/InboxPane';

/**
 * `/inbox` — Direction B's focused portal embed. InboxPane owns the complete
 * canonical attention flow, including selection/detail, discussion, and the
 * explicit InboxBulkStrip resolve/review/settle lifecycle.
 *
 * `layout="split"` (portal-work-two-pane-2026-09-01 D-001): the full page lays
 * the row list out beside the selected item's detail — the ratified Direction B
 * list + detail — while the chat sidebar keeps the pane's stack default.
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
      <InboxPane layout="split" />
    </div>
  );
}
