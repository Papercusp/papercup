import { FLAGS } from '@papercusp/flags';

import { requireFlag } from '@/lib/require-flag';

import PublishingClient from './PublishingClient';

export default async function PublishingPage() {
  await requireFlag(FLAGS.CLOUDFLARE_PUBLISH);
  return <PublishingClient />;
}
