import { FLAGS } from '@papercusp/flags';

import { requireFlag } from '@/lib/require-flag';

import InstalledTemplatesClient from './InstalledTemplatesClient';

export default async function InstalledTemplatesPage() {
  await requireFlag(FLAGS.TEMPLATES);
  return <InstalledTemplatesClient />;
}
