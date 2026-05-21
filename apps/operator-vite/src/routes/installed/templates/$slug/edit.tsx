import { createFileRoute } from '@tanstack/react-router';
import EditTemplateClient from '@/app/installed/templates/[slug]/edit/EditTemplateClient';

/**
 * /installed/templates/$slug/edit — template editor. Translated from
 * `apps/operator/app/installed/templates/[slug]/edit/page.tsx`.
 * requireFlag gate dropped. `EditTemplateClient` is parameterless — it
 * reads the slug itself (nuqs / window.location).
 */
export const Route = createFileRoute('/installed/templates/$slug/edit')({
  component: EditTemplateClient,
});
