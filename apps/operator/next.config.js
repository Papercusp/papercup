const path = require('path');
const { createMDX } = require('fumadocs-mdx/next');

const PAPERCUP_UPSTREAM = process.env.PAPERCUSP_PAPERCUP_UPSTREAM ?? 'http://localhost:3061';
const WEB_UPSTREAM      = process.env.PAPERCUSP_WEB_UPSTREAM      ?? 'http://localhost:3001';

const withMDX = createMDX();

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  output: 'standalone',
  outputFileTracingRoot: path.join(__dirname, '../..'),
  // node-pty's native .node bindings live in prebuilds/<platform>/pty.node
  // and are loaded via dynamic require — Next's tracer can't see them.
  // Force-include them so the standalone bundle ships the prebuilt binary
  // for whatever platform we're packaging on. The desktop build copies
  // node_modules from this standalone tree into the sidecar bundle.
  outputFileTracingIncludes: {
    '/api/harness/**': [
      'node_modules/@lydell/node-pty-linux-x64/prebuilds/**',
      'node_modules/@lydell/node-pty-linux-arm64/prebuilds/**',
      'node_modules/@lydell/node-pty-darwin-x64/prebuilds/**',
      'node_modules/@lydell/node-pty-darwin-arm64/prebuilds/**',
      'node_modules/@lydell/node-pty-win32-x64/prebuilds/**',
      'node_modules/@lydell/node-pty-win32-arm64/prebuilds/**',
    ],
  },
  typescript: { ignoreBuildErrors: true },
  images: { unoptimized: true },
  // Turbopack persistent cache deadlocks under load AND silently retains
  // stale transpiled artifacts from workspace deps (e.g. libs/zero-harness)
  // even after a dev restart — disable it so source edits actually rebuild.
  experimental: {
    turbopackFileSystemCacheForDev: false,
  },
  transpilePackages: [
    '@papercusp/harness',
    '@papercusp/orchestrator',
    '@papercusp/export-state',
    '@papercusp/plugin-loader',
    '@papercusp/plugin-sdk',
    '@restart/agent-chat',
    '@restart/db-org',
    '@restart/git-graph',
    '@restart/grid-core',
    '@restart/papercup-shared',
    '@restart/ui-primitives',
    '@restart/zero-harness',
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

module.exports = withMDX(nextConfig);
