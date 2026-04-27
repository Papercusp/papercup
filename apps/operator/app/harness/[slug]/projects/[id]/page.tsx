import ProjectDetail from './ProjectDetail';

export const dynamic = 'force-dynamic';

export default async function ProjectDetailPage({ params }: { params: Promise<{ slug: string; id: string }> }) {
  const { slug, id } = await params;
  return <ProjectDetail slug={slug} projectId={id} />;
}
