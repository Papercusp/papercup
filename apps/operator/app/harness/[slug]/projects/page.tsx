import ProjectsList from './ProjectsList';

export const dynamic = 'force-dynamic';

export default async function ProjectsListPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return <ProjectsList slug={slug} />;
}
