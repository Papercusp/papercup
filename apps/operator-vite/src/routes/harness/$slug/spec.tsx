import { createFileRoute, redirect } from '@tanstack/react-router';

/**
 * /harness/$slug/spec[#anchor] — friendly URL for the SPEC.md editor.
 * Redirects to the harness with the config panel + spec tab opened,
 * preserving the hash so Vditor's anchor scrolling finds the heading.
 *
 * Translated from `apps/operator/app/harness/[slug]/spec/page.tsx`.
 *
 * Hash propagation: browsers preserve `#anchor` across SPA redirects when
 * the throw-redirect doesn't strip it. TSR's `redirect()` sets `to` +
 * `search`, but the current location's hash is preserved by the History
 * API during the navigation — same observable behavior as the original
 * Next 307 redirect.
 */
export const Route = createFileRoute('/harness/$slug/spec')({
  beforeLoad: ({ params }) => {
    throw redirect({
      to: '/harness/$slug',
      params: { slug: params.slug },
      search: { panel: 'config', specTab: 'spec' },
    });
  },
});
