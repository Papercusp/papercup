import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import { isAbsolute, relative, resolve as resolvePath, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertPublicManualSource } from './scripts/source-contract.mjs';

const isLintAsCommittedClone = process.env.PAPERCUSP_LINT_AS_COMMITTED_CLONE === '1';
function normalizeExternalAstroModuleIds() {
  const projectRoot = fileURLToPath(new URL('./', import.meta.url));
  return {
    name: 'papercusp-clone-astro-id-normalizer',
    enforce: 'pre',
    resolveId(id) {
      const queryIndex = id.indexOf('?');
      const pathEnd = queryIndex === -1 ? undefined : queryIndex;
      const query = queryIndex === -1 ? '' : id.slice(queryIndex);
      const hasFilesystemPrefix = id.startsWith('/@fs/');
      const filename = hasFilesystemPrefix
        ? id.slice('/@fs'.length, pathEnd)
        : id.slice(0, pathEnd);
      if (!filename.endsWith('.astro')) return null;
      const absoluteFilename = isAbsolute(filename)
        ? resolvePath(filename)
        : resolvePath(projectRoot, filename);

      const relativePath = relative(projectRoot, absoluteFilename);
      const outsideProjectRoot =
        relativePath === '..' || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath);
      if (!outsideProjectRoot) return null;
      // Vite's dev server strips /@fs itself, but its build load fallback can
      // treat an already canonical /@fs ID as a literal path.
      if (hasFilesystemPrefix && absoluteFilename === filename) return absoluteFilename + query;
      return `/@fs${absoluteFilename}${query}`;
    },
  };
}

// Public-facing user manual for Papercusp. Engine: Starlight (on Astro).
// The internal *engineering* docs are a separate app — apps/operator-docs.
//
// `base: '/docs'` is load-bearing: every in-content link is written as
// `/docs/<slug>` (carried over from the previous fumadocs `/docs/[[...slug]]`
// route), so the site must mount under /docs for those links to resolve.
// If this is ever deployed at a bare docs subdomain, flip base to '/' and
// rewrite the in-content links.
export default defineConfig({
  site: 'https://app.papercusp.com',
  base: '/docs',
  // lint:as-committed links dependencies to the shared install. Astro normalizes /@fs IDs to
  // their real path but treats raw external absolute IDs as app-root-relative. Normalize external
  // Astro IDs to /@fs first, then resolve canonical /@fs IDs back to their physical path so Vite's
  // build loader does not try to open /@fs as a literal directory.
  ...(isLintAsCommittedClone
    ? {
        vite: {
          resolve: {
            preserveSymlinks: false,
          },
          plugins: [normalizeExternalAstroModuleIds()],
        },
      }
    : {}),
  // Match `apps/operator-docs`: pages emitted as `<slug>.html` (not
  // `<slug>/index.html`), so the operator Hono host's `/docs/*` resolver
  // (`host-docs-public.ts`) can slug→.html-lookup uniformly.
  build: { format: 'file' },
  integrations: [
    {
      name: 'public-manual-source-contract',
      hooks: { 'astro:build:start': () => { assertPublicManualSource(); } },
    },
    starlight({
      title: 'Papercusp Docs',
      description: 'Public documentation for the Papercusp platform.',
      pagefind: true,
      customCss: ['./src/styles/blue-frost.css'],
      // The canonical repo lives under the `Papercusp` GitHub Organization —
      // `papercupai` is the maintainer's personal GitHub User login, not an
      // org, and does not own the product repos (WI-4978).
      social: [
        { icon: 'github', label: 'Source', href: 'https://github.com/Papercusp/papercusp-app' },
        { icon: 'external', label: 'Open portal', href: 'https://app.papercusp.com/' },
      ],
      sidebar: [
        { label: 'Welcome', slug: '' },
        {
          label: 'Sections',
          items: [
            'quickstart',
            'using-the-app',
            'accounts-and-billing',
            'workspaces-and-agents',
            'plans-and-work',
            'agent-modes-and-fleets',
            'voice',
            'cloud-workspaces',
            'harness-templates',
            'harness-snapshots',
            'plugins',
            'remote-access',
            'troubleshooting',
          ],
        },
      ],
    }),
  ],
});
