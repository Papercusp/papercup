import { FLAGS } from '@papercusp/flags';

import { requireFlag } from '@/lib/require-flag';

import ForkClient from './ForkClient';

interface Props {
  params: Promise<{ id: string }>;
}

export default async function ForkPage({ params }: Props) {
  await requireFlag(FLAGS.SNAPSHOTS);
  return <ForkClient params={params} />;
}
