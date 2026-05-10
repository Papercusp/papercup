const path = require('path');
const fs = require('fs');
const { createMDX } = require('fumadocs-mdx/next');

const PAPERCUP_UPSTREAM = process.env.PAPERCUSP_PAPERCUP_UPSTREAM ?? 'http://localhost:3061';
const WEB_UPSTREAM      = process.env.PAPERCUSP_WEB_UPSTREAM      ?? 'http://localhost:3001';
// Rust port (papercup-rust-server). The TypeScript Hono catchall in
// app/api/[[...route]]/route.ts is the DEFAULT backend. Requests are
// only forwarded to the Rust server when the URL carries ?backend=rust
// AND the path appears in papercup-rust-server/openapi.yaml. This makes
// Rust opt-in for both dev (3055) and production (3070) until parity.
const RUST_UPSTREAM       = process.env.PAPERCUSP_RUST_UPSTREAM     ?? 'http://127.0.0.1:3060';
const RUST_OPENAPI_PATH   = process.env.PAPERCUSP_RUST_OPENAPI
  ?? path.join(__dirname, '../../../papercup-rust-server/openapi.yaml');

/** Parse the `paths:` block of openapi.yaml without pulling in a YAML dep.
 *  Returns Next-style path templates (`/foo/{id}` -> `/foo/:id`). */
function loadRustPaths() {
  let text;
  try {
    text = fs.readFileSync(RUST_OPENAPI_PATH, 'utf8');
  } catch (e) {
    console.warn(`[next.config] rust openapi not readable at ${RUST_OPENAPI_PATH}: ${e.message}`);
    console.warn('[next.config] ?backend=rust will resolve to ZERO routes until that file exists');
    return [];
  }
  const lines = text.split('\n');
  const paths = [];
  let inPaths = false;
  for (const line of lines) {
    if (/^paths:\s*$/.test(line)) { inPaths = true; continue; }
    if (!inPaths) continue;
    // top-level key (column 0, non-space) ends the paths section
    if (/^[A-Za-z]/.test(line)) break;
    // path entries are indented exactly 2 spaces and end in ':'
    const m = line.match(/^  (\/[^\s:]+):\s*$/);
    if (m) paths.push(m[1].replace(/\{([^}]+)\}/g, ':$1'));
  }
  return paths;
}

/** Build the Rust-opt-in rewrites array. Each entry only matches when the
 *  request carries `?backend=rust`. Without the flag, the path falls
 *  through to the Hono TS catchall. */
function rustOptInRewrites() {
  const paths = loadRustPaths();
  if (paths.length === 0) return [];
  console.log(`[next.config] rust opt-in: ${paths.length} paths gated on ?backend=rust → ${RUST_UPSTREAM}`);
  return paths.map((p) => ({
    source: p,
    has: [{ type: 'query', key: 'backend', value: 'rust' }],
    destination: `${RUST_UPSTREAM}${p}`,
  }));
}

const withMDX = createMDX();

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  output: 'standalone',
  // Compress JSON/HTML/JS responses with gzip. Next 16 defaults this to
  // true, but with output:'standalone' the bundled server.js skips
  // compression entirely (Next docs: "you need to use a reverse proxy").
  // We run via `next start` (not server.js) so we DO want compression.
  // Measured 2026-05-05: agentRunsSheets.all REST response is 85 KB raw
  // vs 12 KB gzipped — 7.3x reduction. With Zero polling at 3 s, that
  // alone saves ~1.4 MB/min of bandwidth on the dashboard.
  compress: true,
  outputFileTracingRoot: path.join(__dirname, '../..'),
  // node-pty's native .node bindings live in prebuilds/<platform>/pty.node
  // and are loaded via dynamic require — Next's tracer can't see them.
  // Force-include them so the standalone bundle ships the prebuilt binary
  // for whatever platform we're packaging on. The desktop build copies
  // node_modules from this standalone tree into the sidecar bundle.
  outputFileTracingIncludes: {
    // The Hono mount lives at /api/[[...route]] and pulls node-pty in at
    // module load time, so its trace also needs the prebuilds. Without
    // this entry, /api/harness, /api/projects, /api/plugins/enabled, etc.
    // all 500 with "Failed to load native module: pty.node" because they're
    // served by the catch-all, not /api/harness/route.
    '/api/[[...route]]/**': [
      'node_modules/@lydell/node-pty-linux-x64/prebuilds/**',
      'node_modules/@lydell/node-pty-linux-arm64/prebuilds/**',
      'node_modules/@lydell/node-pty-darwin-x64/prebuilds/**',
      'node_modules/@lydell/node-pty-darwin-arm64/prebuilds/**',
      'node_modules/@lydell/node-pty-win32-x64/prebuilds/**',
      'node_modules/@lydell/node-pty-win32-arm64/prebuilds/**',
    ],
    // Operator scan loads its system prompt from scanner.md (the role
    // file). Without this trace include, the standalone build silently
    // falls through to the inline fallback in operator-prompt-system.ts
    // — which works but isn't what we want once we rev scanner.md.
    '/api/agent-mcp/operator-scan/**': [
      '../../libs/papercusp/packages/harness/prompts/scanner.md',
    ],
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
  // Next 16 dev mode rejects HMR WebSocket upgrades whose Origin doesn't
  // match the dev-server's configured host. Without this, the browser
  // (which connects to 127.0.0.1) is blocked when the page was loaded
  // from `localhost`, and vice-versa — every HMR ping fails with
  // "Blocked cross-origin request to Next.js dev resource". The HMR
  // client retries indefinitely, which prevents Suspense boundaries
  // from settling (next/dynamic stuck on its loading fallback) and
  // makes RSC payload fetches flap. The fix is the documented
  // allowedDevOrigins list — both forms of localhost + the LAN IP the
  // operator binds on. Production isn't affected (this is dev-only).
  // Wildcard list — dev only. The operator binds 0.0.0.0 so users
  // commonly access via any of localhost / 127.0.0.1 / their LAN IP.
  // Without each host being in this allow-list, Next 16 rejects the
  // HMR WebSocket as cross-origin and the page silently never resolves
  // its Suspense boundaries (chunks load but client tree never settles).
  // The wildcard covers IPv4 LAN ranges + .local mDNS without having
  // to hand-list every interface.
  allowedDevOrigins: [
    'localhost', '127.0.0.1', '0.0.0.0', '[::1]',
    '*.local',
    '192.168.*.*', '10.*.*.*', '172.16.*.*', '172.17.*.*', '172.18.*.*',
    '172.19.*.*', '172.20.*.*', '172.21.*.*', '172.22.*.*', '172.23.*.*',
    '172.24.*.*', '172.25.*.*', '172.26.*.*', '172.27.*.*', '172.28.*.*',
    '172.29.*.*', '172.30.*.*', '172.31.*.*',
  ],
  // Disable Turbopack's filesystem persistent cache for dev. With it
  // enabled (the default), Turbopack writes its own .next/dev/cache/
  // turbopack/* files continuously while watching the workspace tree —
  // and the watcher then sees those writes and triggers another rebuild.
  // The result is a self-perpetuating Fast Refresh loop: about one
  // rebuild every 3 seconds even with zero source-file changes (verified
  // 2026-05-05 — 10 [Fast Refresh] rebuilds in 30 s on an idle page,
  // 0 source-file mtime changes in the same window). Each rebuild costs
  // 500-800 ms of CPU, accumulating until the dev process eventually
  // SIGTERMs itself ([MDX] closing dev server) and systemd restarts it,
  // forcing a 14-30 s cold compile on the next request.
  //
  // Lives on `experimental.` per Next 16's ExperimentalConfig type
  // (node_modules/next/dist/server/config-shared.d.ts: turbopackFileSystem-
  // CacheForDev?: boolean is on the ExperimentalConfig interface).
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
    '@papercup/marketplace-public-ui',
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
    // agent-mcp's defineTool/Resource/Prompt walk Error.stack to derive
    // names from the caller's file path. When Next bundles the package
    // into a route, the call site is `route.js` and derivation breaks
    // with "could not derive tool name from call site". Externalize so
    // Node loads it via require() and the original file paths survive.
    '@papercusp/agent-mcp',
  ],
  // /api/harness/* and /api/plugins/* are served LOCALLY by this app
  // (mounted in app/api/[[...route]]/route.ts).
  //
  // Cross-app routes still need rewrites:
  //   /api/{org,briefings,public}/* → apps/papercup on :3061 (Papercup demo)
  //   /api/{admin-sidebar,repo-git,build-info}/* → apps/web on :3001 (Restart admin)
  async rewrites() {
    return {
      // beforeFiles MUST contain the Rust opt-in rewrites: in Next, app/
      // route.ts handlers match before afterFiles rewrites, so without
      // beforeFiles ?backend=rust would never reach the Rust upstream
      // for paths that also have a local TS handler. With beforeFiles +
      // `has` gate, the rewrite wins iff the flag is present; otherwise
      // the request falls through to TS as normal.
      beforeFiles: rustOptInRewrites(),
      afterFiles: [
        { source: '/api/org/:path*',           destination: `${PAPERCUP_UPSTREAM}/api/org/:path*` },
        { source: '/api/briefings/:path*',     destination: `${PAPERCUP_UPSTREAM}/api/briefings/:path*` },
        { source: '/api/public/:path*',        destination: `${PAPERCUP_UPSTREAM}/api/public/:path*` },
        { source: '/api/admin-sidebar/:path*', destination: `${WEB_UPSTREAM}/api/admin-sidebar/:path*` },
        { source: '/api/repo-git/:path*',      destination: `${WEB_UPSTREAM}/api/repo-git/:path*` },
        { source: '/api/build-info',           destination: `${WEB_UPSTREAM}/api/build-info` },
      ],
      fallback: [],
    };
  },
};

module.exports = withMDX(nextConfig);
