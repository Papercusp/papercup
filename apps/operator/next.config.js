const path = require('path');

const PAPERCUP_UPSTREAM = process.env.PAPERCUSP_PAPERCUP_UPSTREAM ?? 'http://localhost:3061';
const WEB_UPSTREAM      = process.env.PAPERCUSP_WEB_UPSTREAM      ?? 'http://localhost:3001';

/** @type {import('next').NextConfig} */
module.exports = {
  reactStrictMode: true,
  output: 'standalone',
  outputFileTracingRoot: path.join(__dirname, '../..'),
  typescript: { ignoreBuildErrors: true },
  images: { unoptimized: true },
  transpilePackages: [
    '@papercusp/harness',
    '@restart/agent-chat',
    '@restart/db-org',
    '@restart/git-graph',
    '@restart/papercup-shared',
    '@restart/ui-primitives',
  ],
  // node-pty's index.js does `require(<dynamic>)` to load its
  // platform-specific native binding. Turbopack can't trace that, so we
  // mark the package family as external — Next leaves it alone and Node
  // resolves it normally at runtime.
  serverExternalPackages: [
    '@lydell/node-pty',
    '@lydell/node-pty-linux-x64',
    '@lydell/node-pty-linux-arm64',
    '@lydell/node-pty-darwin-arm64',
    '@lydell/node-pty-darwin-x64',
    '@lydell/node-pty-win32-x64',
    '@lydell/node-pty-win32-arm64',
  ],
  // /api/harness/* and /api/plugins/* are served LOCALLY by this app
  // (mounted in app/api/[[...route]]/route.ts).
  //
  // Cross-app routes still need rewrites:
  //   /api/{org,briefings,public}/* → apps/papercup on :3061 (Papercup demo)
  //   /api/{admin-sidebar,repo-git,build-info}/* → apps/web on :3001 (Restart admin)
  async rewrites() {
    return [
      { source: '/api/org/:path*',           destination: `${PAPERCUP_UPSTREAM}/api/org/:path*` },
      { source: '/api/briefings/:path*',     destination: `${PAPERCUP_UPSTREAM}/api/briefings/:path*` },
      { source: '/api/public/:path*',        destination: `${PAPERCUP_UPSTREAM}/api/public/:path*` },
      { source: '/api/admin-sidebar/:path*', destination: `${WEB_UPSTREAM}/api/admin-sidebar/:path*` },
      { source: '/api/repo-git/:path*',      destination: `${WEB_UPSTREAM}/api/repo-git/:path*` },
      { source: '/api/build-info',           destination: `${WEB_UPSTREAM}/api/build-info` },
    ];
  },
};
