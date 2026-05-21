import { createFileRoute } from '@tanstack/react-router';
import { FLAGS } from '@papercusp/flags';
import { requireFlag } from '../../../../lib/require-flag';
import EditTemplateClient from '@/app/installed/templates/[slug]/edit/EditTemplateClient';

/**
 * /installed/templates/$slug/edit — template editor. Translated from
 * `apps/operator/app/installed/templates/[slug]/edit/page.tsx`.
 * The requireFlag gate is ported to a `beforeLoad` check (lib/require-flag.ts).
 * `EditTemplateClient` is parameterless — it reads the slug itself
 * (nuqs / window.location).
 */
export const Route = createFileRoute('/installed/templates/$slug/edit')({
  beforeLoad: () => requireFlag(FLAGS.TEMPLATES),
  component: EditTemplateClient,
});
