const path = require('path');

const PAPERCUSP_UPSTREAM = process.env.PAPERCUP_PAPERCUSP_UPSTREAM ?? 'http://localhost:3055';
const WEB_UPSTREAM       = process.env.PAPERCUP_WEB_UPSTREAM       ?? 'http://localhost:3001';

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  output: 'standalone',
  outputFileTracingRoot: path.join(__dirname, '../..'),
  typescript: { ignoreBuildErrors: true },
  images: { unoptimized: true },
  transpilePackages: ['@papercusp/papercusp-shared'],
  // The Papercup admin imports `@/app/harness/HarnessDashboard` directly.
  // Rather than copy the harness UI a third time, alias it to the canonical
  // location at apps/papercusp/app/harness/.
  turbopack: {
    resolveAlias: {
      '@/app/harness': path.resolve(__dirname, '../papercusp/app/harness'),
    },
  },
  // /api/org/*, /api/briefings/*, /api/public/papercup/* served LOCALLY here.
  //
  // Cross-app routes need rewrites:
  //   /api/{harness,plugins}/* → apps/papercusp on :3055
  //   /api/{admin-sidebar,repo-git,build-info}/* → apps/web on :3001
  async rewrites() {
    return [
      { source: '/api/harness/:path*',       destination: `${PAPERCUSP_UPSTREAM}/api/harness/:path*` },
      { source: '/api/plugins/:path*',       destination: `${PAPERCUSP_UPSTREAM}/api/plugins/:path*` },
      { source: '/api/admin-sidebar/:path*', destination: `${WEB_UPSTREAM}/api/admin-sidebar/:path*` },
      { source: '/api/repo-git/:path*',      destination: `${WEB_UPSTREAM}/api/repo-git/:path*` },
      { source: '/api/build-info',           destination: `${WEB_UPSTREAM}/api/build-info` },
    ];
  },
};

module.exports = nextConfig;
