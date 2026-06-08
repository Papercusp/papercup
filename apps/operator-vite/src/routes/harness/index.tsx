import { createFileRoute, redirect } from '@tanstack/react-router';

/**
 * /harness — RETIRED as a landing surface. The operator's primary surface is
 * now `/adv`; this route exists only as a translating redirect so old links,
 * bookmarks, and toasts keep working.
 *
 * Param translation:
 *   - `?slug=` / `?project=` (legacy name) → `?slug=`
 *   - `?panel=<p>` → `?tab=<map(p)>` — legacy HarnessDashboard panels map to
 *     /adv tabs; panels with no top-level /adv tab (proposals/experts/summary/
 *     design) land on `harnesses` (they remain reachable via the harness UI).
 *
 * NOTE: the per-slug routes (`/harness/$slug` + its sub-routes) are
 * intentionally NOT redirected yet — they render org/department dashboards and
 * the dock shell, which /adv does not have parity for. They stay functional
 * until /adv covers those surfaces.
 */
const PANEL_TO_TAB: Record<string, string> = {
  dashboard: 'harnesses',
  brainstorm: 'brainstorm',
  prs: 'prs',
  insights: 'insights',
  // The Config tab was retired (config-tab-cleanup-2026-06-08); its plugin
  // management moved into Settings, so the legacy `config` panel lands there.
  config: 'settings',
  settings: 'settings',
  docs: 'docs',
  git: 'git',
  // No top-level /adv tab — closest landing is the harnesses workspace.
  proposals: 'harnesses',
  experts: 'harnesses',
  summary: 'harnesses',
  design: 'harnesses',
};

export const Route = createFileRoute('/harness/')({
  validateSearch: (search: Record<string, unknown>): { slug?: string; panel?: string } => ({
    slug:
      typeof search.slug === 'string'
        ? search.slug
        : typeof search.project === 'string'
          ? search.project
          : undefined,
    panel: typeof search.panel === 'string' ? search.panel : undefined,
  }),
  beforeLoad: ({ search }) => {
    const tab = (search.panel && PANEL_TO_TAB[search.panel]) || 'harnesses';
    throw redirect({
      to: '/adv',
      search: search.slug ? { tab, slug: search.slug } : { tab },
    });
  },
});
