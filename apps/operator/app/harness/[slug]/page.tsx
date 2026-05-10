import { notFound } from 'next/navigation';
import HarnessDashboard from '../HarnessDashboard';
import DepartmentHarnessDashboard from '../DepartmentHarnessDashboard';
import { selfUrl } from '@/lib/self-url';

export const dynamic = 'force-dynamic';

// Canonical HarnessKind: matches the orchestrator's
// libs/papercusp/packages/orchestrator/src/types.ts declaration.
// '' = legacy/unset, 'coding' = solo coding harness, 'org' = parent
// company harness, 'department' = sub-harness inside an org.
//
// 'org' currently routes to HarnessDashboard (same as 'coding') — the
// org-parent has no panels of its own; users see departments via
// /harness/<dept-slug>.
type HarnessKind = '' | 'coding' | 'org' | 'department';
type ProjectEntry = {
  slug: string;
  path: string;
  harness_kind?: HarnessKind;
  department_slug?: string;
};

async function fetchProject(slug: string): Promise<ProjectEntry | null> {
  // Self-hit the local sidecar. Use /projects/lite — we only need slug+path
  // for the routing-validity check below, not the per-project hasState/hasSpec
  // enrichment (~70× PG-pool-open in serial that the heavy /projects endpoint
  // does — measured 4-5s vs <50ms for /lite in the 2026-05-03 perf audit).
  const base = selfUrl();
  try {
    const res = await fetch(`${base}/api/harness/projects/lite`, { cache: 'no-store' });
    if (!res.ok) return null;
    const data = await res.json();
    const projects: ProjectEntry[] = data.projects ?? [];
    return projects.find((p) => p.slug === slug) ?? null;
  } catch {
    return null;
  }
}

export default async function HarnessProjectPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const project = await fetchProject(slug);

  if (!project) {
    notFound();
  }

  if (project.harness_kind === 'department' && project.department_slug) {
    return (
      <DepartmentHarnessDashboard
        harnessSlug={project.slug}
        departmentSlug={project.department_slug}
      />
    );
  }

  // Coding flavor — same as /harness, but locked to this slug via query param prefill
  return <HarnessDashboard />;
}
