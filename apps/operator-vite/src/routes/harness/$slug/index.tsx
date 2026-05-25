import { createFileRoute, notFound } from '@tanstack/react-router';
import HarnessDashboard from '@/app/harness/HarnessDashboard';
import DepartmentHarnessDashboard from '@/app/harness/DepartmentHarnessDashboard';
import HarnessDockShell from '@/app/harness/[slug]/HarnessDockShell';
import { InsightsFirstVisitGate } from '@/app/harness/insights/InsightsFirstVisitGate';

/**
 * /harness/$slug — per-project harness surface. Translated from
 * `apps/operator/app/harness/[slug]/page.tsx`.
 *
 * next → TSR diff:
 *   - The original was an async Server Component fetching project info via
 *     `selfUrl()` + `fetch(${base}/api/harness/projects/lite)` and choosing
 *     a sub-dashboard. Under SPA, `fetch('/api/...')` is relative; we move
 *     the fetch into TSR's `loader`, which is the right surface for async
 *     route data (`Route.useLoaderData()` is typed).
 *   - `notFound()` from `next/navigation` → TSR `notFound()` throw.
 *   - `searchParams.dock === '1'` (server) → TSR `validateSearch` + `Route.useSearch()`.
 */

type HarnessKind = '' | 'coding' | 'org' | 'department';
type ProjectEntry = {
  slug: string;
  path: string;
  harness_kind?: HarnessKind;
  department_slug?: string;
};

export const Route = createFileRoute('/harness/$slug/')({
  validateSearch: (search): { dock?: '1' } => ({
    dock: search.dock === '1' ? '1' : undefined,
  }),
  loader: async ({ params }) => {
    // /projects/lite — only slug+path; not the heavy /projects endpoint
    // (~4-5s per the 2026-05-03 perf audit).
    const res = await fetch('/api/harness/projects/lite', { cache: 'no-store' });
    if (!res.ok) throw notFound();
    const data = await res.json();
    const projects: ProjectEntry[] = data.projects ?? [];
    const project = projects.find((p) => p.slug === params.slug);
    if (!project) throw notFound();
    return { project };
  },
  component: HarnessProjectPage,
});

function HarnessProjectPage() {
  const { project } = Route.useLoaderData();
  const search = Route.useSearch();

  // Phase 5 dock — opt-in via ?dock=1.
  if (search.dock === '1') {
    return (
      <>
        <InsightsFirstVisitGate slug={project.slug} />
        <HarnessDockShell slug={project.slug} />
      </>
    );
  }

  if (project.harness_kind === 'department' && project.department_slug) {
    return (
      <>
        <InsightsFirstVisitGate slug={project.slug} />
        <DepartmentHarnessDashboard
          harnessSlug={project.slug}
          departmentSlug={project.department_slug}
        />
      </>
    );
  }

  // Coding flavor — same as /harness, locked to this slug via the URL.
  // P-073g — on first visit (no row OR null seen_at_ts) the gate
  // redirects the contributor to /harness/<slug>/insights via
  // window.location.assign. Subsequent visits no-op.
  return (
    <>
      <InsightsFirstVisitGate slug={project.slug} />
      <HarnessDashboard />
    </>
  );
}
