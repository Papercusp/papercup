import { createFileRoute } from '@tanstack/react-router';
import ProjectsList from '@/app/harness/[slug]/projects/ProjectsList';

/**
 * /harness/$slug/projects — list of subprojects. Translated from
 * `apps/operator/app/harness/[slug]/projects/page.tsx`. ProjectsList is
 * shared and clean.
 */
export const Route = createFileRoute('/harness/$slug/projects/')({
  component: ProjectsListPage,
});

function ProjectsListPage() {
  const { slug } = Route.useParams();
  return <ProjectsList slug={slug} />;
}
