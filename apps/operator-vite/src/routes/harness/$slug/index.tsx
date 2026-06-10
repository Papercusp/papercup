import { createFileRoute, notFound, redirect, Navigate } from '@tanstack/react-router';
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
 *
 * Coding harnesses are served by /adv; the only remaining per-slug surface is
 * the opt-in `?dock=1` shell. (The org/department dashboard was retired with the
 * org-sim — migration 192.)
 */

type ProjectEntry = {
  slug: string;
  path: string;
};

export const Route = createFileRoute('/harness/$slug/')({
  validateSearch: (search): { dock?: 1 } => {
    // `?dock=1` opts into the dock shell. TanStack Router's default search
    // parser coerces `?dock=1` to the NUMBER 1 and round-trips numbers
    // verbatim (`1` ↔ `?dock=1`), so normalize to the number 1. A normalized
    // STRING '1' is JSON-quoted to `?dock="1"` and DRIFTS across TSR's
    // re-serialisations (eventually parsing back as the quoted string `"1"`),
    // which breaks an `=== '1'` check → spurious redirect to /adv. (The
    // Next.js original compared against '1' because `searchParams.dock` was a
    // string there; under TSR it's a number.) Accept '1' too for self-heal.
    return { dock: search.dock === 1 || search.dock === '1' ? 1 : undefined };
  },
  loaderDeps: ({ search }) => ({ dock: search.dock }),
  loader: async ({ params, deps }) => {
    // /projects/lite — only slug+path; not the heavy /projects endpoint
    // (~4-5s per the 2026-05-03 perf audit).
    //
    // Retry transient failures before declaring the route missing: a fetch
    // hiccup, a mid-reload registry, or the endpoint's 1s payload cache
    // straddling a workspace switch all surface as !ok / slug-missing for a
    // beat, and mapping that beat straight to notFound() renders a lying 404
    // for a real harness. Two retries (350ms, 1.1s — past the cache TTL)
    // before giving up; a genuinely unknown slug just pays ~1.5s extra.
    let project: ProjectEntry | undefined;
    for (let attempt = 0; ; attempt++) {
      try {
        const res = await fetch('/api/harness/projects/lite', { cache: 'no-store' });
        if (res.ok) {
          const data = await res.json();
          const projects: ProjectEntry[] = data.projects ?? [];
          project = projects.find((p) => p.slug === params.slug);
          if (project) break;
        }
      } catch { /* transient network failure — retry below */ }
      if (attempt >= 2) break;
      await new Promise((r) => setTimeout(r, attempt === 0 ? 350 : 1100));
    }
    if (!project) throw notFound();
    // Coding harnesses are served by /adv; only the opt-in ?dock=1 shell still
    // renders the legacy per-slug surface here.
    if (deps.dock !== 1) {
      throw redirect({ to: '/adv', search: { tab: 'harnesses', slug: params.slug } });
    }
    return { project };
  },
  component: HarnessProjectPage,
});

function HarnessProjectPage() {
  const { project } = Route.useLoaderData();
  const search = Route.useSearch();

  // Phase 5 dock — opt-in via ?dock=1.
  if (search.dock === 1) {
    return (
      <>
        <InsightsFirstVisitGate slug={project.slug} />
        <HarnessDockShell slug={project.slug} />
      </>
    );
  }

  // Everything else is redirected to /adv in the loader; this is an unreachable
  // safety net.
  return <Navigate to="/adv" search={{ tab: 'harnesses', slug: project.slug }} replace />;
}
