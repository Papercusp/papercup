import { createFileRoute } from '@tanstack/react-router';
import AdminShell from '../../components/admin/AdminShell';
import PlansClient from '@/app/admin/plans/PlansClient';
import '@/app/admin/plans/plans.css';

/**
 * /admin/plans — the markdown-canonical plan browser/editor. Translated
 * from `apps/operator/app/admin/plans/page.tsx`.
 *
 * Thin wrapper, like `admin/features.tsx`: `PlansClient` and its whole
 * subtree (rail, detail, vditor editor, decorations, dialogs) carry no
 * `next/*` imports — they use `nuqs` (operator-vite already mounts
 * `NuqsAdapter` from `nuqs/adapters/tanstack-router` in `__root.tsx`),
 * React, and the shared `MarkdownEditor` / `Modal`. So it's reused
 * directly via the `@/` alias rather than needing a Vite-flavored copy
 * the way `TestingClient` did (that one used `next/dynamic`).
 *
 * The data layer is unaffected by the framework move: PlansClient
 * fetches the `/api/admin/plans/*` route handlers, which are
 * `defineTool`s mounted on the shared Hono app — same backend for the
 * Next operator and the Vite operator.
 *
 * AdminShell already lists the Plans tab; without this route file the
 * tab would 404 in the Vite build.
 */
export const Route = createFileRoute('/admin/plans')({
  component: AdminPlansPage,
});

function AdminPlansPage() {
  return (
    <AdminShell title="Plans">
      <PlansClient />
    </AdminShell>
  );
}
