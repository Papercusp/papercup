import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertPublicManualSource } from './scripts/source-contract.mjs';

const isLintAsCommittedClone = process.env.PAPERCUSP_LINT_AS_COMMITTED_CLONE === '1';
const sharedStarlightRoot = dirname(fileURLToPath(import.meta.resolve('@astrojs/starlight')));
const cloneStarlightRoot = fileURLToPath(new URL('../../node_modules/@astrojs/starlight/', import.meta.url));

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
  // lint:as-committed links dependencies to the shared install. Astro treats raw absolute
  // paths outside its root as root-relative, but strips Vite's /@fs prefix to the real path.
  // Use that prefix on Starlight's virtual requests so they share the main module's metadata key.
  ...(isLintAsCommittedClone
    ? {
        vite: {
          resolve: {
            preserveSymlinks: true,
            alias: [{ find: sharedStarlightRoot, replacement: `/@fs${sharedStarlightRoot}` }],
          },
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
