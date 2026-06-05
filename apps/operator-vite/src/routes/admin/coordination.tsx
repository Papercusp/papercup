import { createFileRoute } from '@tanstack/react-router';
import AdminShell from '../../components/admin/AdminShell';
import CoordinationClient from '@/app/admin/coordination/CoordinationClient';
import '@/app/admin/coordination/coordination.css';

/**
 * /admin/coordination — operator-level, cross-harness views over the
 * coordination substrate (coordination-integration-adoption-2026-06-03 P2):
 * Issues (the cross-harness engineer_issues surface), Topics (taxonomy +
 * cross-object feed), Conversations (su-9fd2d's substrate).
 *
 * Thin wrapper like `admin/plans.tsx`: `CoordinationClient` carries no
 * `next/*` imports — nuqs (NuqsAdapter mounted in `__root.tsx`), React,
 * and `fetch` against `/api/admin/coordination/<group>/<verb>` (a
 * `defineTool` proxy on the shared Hono app), so the Next-side page
 * implementation is reused directly via the `@/` alias.
 *
 * This route file was the missing half of the P2 ship: the page +
 * proxy + Next AdminShell tab landed, but operator-vite (the LIVE SPA)
 * had no route — /admin/coordination fell through to the index loader.
 * Found by the plan's live-verify pass (Brief 45, 2026-06-05).
 */
export const Route = createFileRoute('/admin/coordination')({
  component: AdminCoordinationPage,
});

function AdminCoordinationPage() {
  return (
    <AdminShell title="Coordination">
      <CoordinationClient />
    </AdminShell>
  );
}
