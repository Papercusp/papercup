import { FLAGS } from '@papercusp/flags';

import { requireFlag } from '@/lib/require-flag';

import EditTemplateClient from './EditTemplateClient';

export default async function EditTemplatePage() {
  await requireFlag(FLAGS.TEMPLATES);
  return <EditTemplateClient />;
}
