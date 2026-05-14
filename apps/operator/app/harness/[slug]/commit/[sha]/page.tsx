import CommitDetailClient from './CommitDetailClient';

export const dynamic = 'force-dynamic';

export default async function CommitPage({
  params,
}: {
  params: Promise<{ slug: string; sha: string }>;
}) {
  const { slug, sha } = await params;
  return <CommitDetailClient sha={sha} slug={slug} />;
}
