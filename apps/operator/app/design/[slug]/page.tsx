import DesignDashboard from './DesignDashboard';

export const dynamic = 'force-dynamic';

export default async function DesignPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  return <DesignDashboard slug={slug} />;
}
