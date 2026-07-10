/**
 * next.config.mjs — operator app (WI-3732).
 *
 * PAPERCUSP_PREVIEW_DATA_ORIGIN (env-gated, PREVIEW-ONLY): when set, every
 * `/api/*` request is rewritten to that origin — so a dev/staging preview
 * instance of THIS tree's UI rides the LIVE release process's data plane
 * (`/api/zero-harness/rest-query` + `/sse` are plain HTTP, see
 * providers/HarnessSyncProvider.tsx). Rationale: the envs here are git TREES
 * plus ONE runtime — only the release checkout runs and it exclusively owns
 * the data store, so an ad-hoc preview boots data-blind (owner friction
 * 2026-07-10: could not see /rubrics before the gate greened). With this
 * gate, `PAPERCUSP_PREVIEW_DATA_ORIGIN=http://localhost:3070 next dev -p 3171`
 * shows tip UI with real data, no gate cycle required.
 *
 * UNSET (production, the release gate, plain `next dev`): rewrites() returns
 * [] — byte-for-byte identical routing to having no next.config at all. In
 * production the operator sidecar serves `/api/*` itself before Next sees it,
 * so this rewrite is doubly inert there.
 */
const previewDataOrigin = process.env.PAPERCUSP_PREVIEW_DATA_ORIGIN;

/** @type {import('next').NextConfig} */
const nextConfig = {
  async rewrites() {
    if (!previewDataOrigin) return [];
    const origin = previewDataOrigin.replace(/\/+$/, '');
    return [
      {
        source: '/api/:path*',
        destination: `${origin}/api/:path*`,
      },
    ];
  },
};

export default nextConfig;
