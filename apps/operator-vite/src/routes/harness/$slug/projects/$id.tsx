import { createFileRoute } from '@tanstack/react-router';
import ProjectDetail from '@/app/harness/[slug]/projects/[id]/ProjectDetail';

/**
 * /harness/$slug/projects/$id — subproject detail. Translated from
 * `apps/operator/app/harness/[slug]/projects/[id]/page.tsx`. ProjectDetail
 * is shared and clean.
 */
export const Route = createFileRoute('/harness/$slug/projects/$id')({
  component: ProjectDetailPage,
});

function ProjectDetailPage() {
  const { slug, id } = Route.useParams();
  return <ProjectDetail slug={slug} projectId={id} />;
}
