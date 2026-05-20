/**
 * GET / DELETE /api/publish-credentials
 *
 * GET    — masked view of the Cloudflare-publish tenant credentials.
 * DELETE — clear them.
 *
 * Ported from app/api/publish-credentials/route.ts. `auth: 'public'` —
 * the route gates on the CLOUDFLARE_PUBLISH feature flag via
 * gateApiRoute, not on a principal.
 */
import { FLAGS } from '@papercusp/flags';
import { gateApiRoute } from '@/lib/require-flag';
import {
  deletePublishCredentials,
  maskPublishCredentials,
  readPublishCredentials,
} from '@/lib/publish-credentials';
import { defineRoute } from '../../define-route';

export default [
  defineRoute({
    method: 'GET',
    path: '/publish-credentials',
    auth: 'public',
    async handler(req) {
      const blocked = await gateApiRoute(req, FLAGS.CLOUDFLARE_PUBLISH);
      if (blocked) return blocked;
      return Response.json(maskPublishCredentials(await readPublishCredentials()));
    },
  }),
  defineRoute({
    method: 'DELETE',
    path: '/publish-credentials',
    auth: 'public',
    async handler(req) {
      const blocked = await gateApiRoute(req, FLAGS.CLOUDFLARE_PUBLISH);
      if (blocked) return blocked;
      await deletePublishCredentials();
      return Response.json({ ok: true });
    },
  }),
];
