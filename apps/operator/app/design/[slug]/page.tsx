import DesignDashboard from './DesignDashboard';
import { FLAGS } from '@papercusp/flags';
import { requireFlag } from '@/lib/require-flag';

export const dynamic = 'force-dynamic';

export default async function DesignPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  await requireFlag(FLAGS.DESIGN);
  const { slug } = await params;
  return <DesignDashboard slug={slug} />;
}
