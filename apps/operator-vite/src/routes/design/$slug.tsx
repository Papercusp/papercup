import { createFileRoute } from '@tanstack/react-router';
import DesignDashboard from '@/app/design/[slug]/DesignDashboard';

/**
 * /design/$slug — per-harness design tab. Translated from
 * `apps/operator/app/design/[slug]/page.tsx`.
 *
 * **Deviation:** the original wraps `DesignDashboard` in
 * `await requireFlag(FLAGS.DESIGN)` (server-only). Under Vite/SPA there is
 * no equivalent runtime yet — see plan A3 "Not yet ported (Phase D/E): the
 * `await getAllFlags()` SSR flag resolution". For now the page renders
 * unconditionally; the flag gate becomes a client-side check via
 * `window.__PAPERCUSP_FLAGS__` (or an `/api/flags` fetch) once that
 * deferred port lands.
 */
export const Route = createFileRoute('/design/$slug')({
  component: DesignSlugPage,
});

function DesignSlugPage() {
  const { slug } = Route.useParams();
  return <DesignDashboard slug={slug} />;
}
