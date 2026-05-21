import { createFileRoute } from '@tanstack/react-router';
import PublishingClient from '@/app/settings/publishing/PublishingClient';

/**
 * /settings/publishing — Cloudflare publishing settings. Translated from
 * `apps/operator/app/settings/publishing/page.tsx`.
 * `requireFlag(FLAGS.CLOUDFLARE_PUBLISH)` gate dropped (SPA-flags A3 deferral).
 */
export const Route = createFileRoute('/settings/publishing')({
  component: PublishingClient,
});
