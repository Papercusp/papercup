import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import react from '@astrojs/react';
import starlightLlmsTxt from 'starlight-llms-txt';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const section = (label, directory) => ({
  label,
  items: [{ autogenerate: { directory, collapsed: true } }],
});

// ── DOCS_PREVIEW: the P-005 Starlight projection site, OFF by default ──────────
// `docs-and-memory-as-projections-2026-06-05` P-005 / `starlight-projection-site`:
// render the code-derived reference (the `defineTool`→OpenAPI spec and the
// libs/generic TypeDoc API) as a browsable human site, BEHIND a preview route.
// Gated on DOCS_PREVIEW so the default build the fleet/release pipeline runs is
// byte-for-byte unchanged and never depends on the on-demand `.papercusp/*`
// artifacts (which are gitignored and absent in a fresh release checkout). The
// preview is opt-in, built to ./dist-preview, and NEVER mirrored into the served
// docs by postbuild-copy. The ~206 hand-written MDX are untouched — their
// retirement is the owner's separate quiet-window step.
const PREVIEW = process.env.DOCS_PREVIEW === '1' || process.env.DOCS_PREVIEW === 'true';
const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));

const previewPlugins = [];
const previewSidebar = [];

if (PREVIEW) {
  const { default: starlightOpenAPI, openAPISidebarGroups } = await import('starlight-openapi');
  const { default: starlightTypeDoc, typeDocSidebarGroup } = await import('starlight-typedoc');
  const { discoverGenericLibEntryPoints } = await import('./preview-libs.mjs');

  // OpenAPI 3.1 spec projected from the defineTool registry by `npm run gen:openapi`
  // (368 operations). starlight-openapi resolves a relative `schema` against the
  // Astro root, so pass the absolute repo-root path.
  const openapiSpec = path.join(REPO_ROOT, '.papercusp', 'openapi.json');
  previewPlugins.push(
    starlightOpenAPI([
      {
        base: 'preview/api',
        schema: openapiSpec,
        sidebar: {
          label: 'Operator API (generated)',
          collapsed: true,
          operations: { badges: true, labels: 'summary', sort: 'alphabetical' },
          tags: { sort: 'alphabetical' },
        },
      },
    ]),
  );
  previewSidebar.push(...openAPISidebarGroups);

  // TypeDoc API for the borrowable libs/generic/* libraries, projected from the
  // SAME entry points `npm run gen:lib-api` uses (D-004: two independent
  // projections of one source). starlight-typedoc runs its own TypeDoc and
  // transforms the markdown into Starlight pages under preview/lib-api.
  // `skipErrorChecking` keeps doc-gen off the tree's tsc baseline (same stance as
  // gen-lib-api); `entryPointStrategy: 'resolve'` documents each lib as its own
  // module; the repo base tsconfig covers the 4 libs without their own.
  previewPlugins.push(
    starlightTypeDoc({
      entryPoints: discoverGenericLibEntryPoints(REPO_ROOT),
      tsconfig: path.join(REPO_ROOT, 'tsconfig.base.json'),
      output: 'preview/lib-api',
      errorOnEmptyDocumentation: false,
      sidebar: { label: 'Lib API (generated)', collapsed: true },
      typeDoc: {
        entryPointStrategy: 'resolve',
        skipErrorChecking: true,
        excludeInternal: true,
        excludePrivate: true,
        readme: 'none',
      },
    }),
  );
  previewSidebar.push(typeDocSidebarGroup);
}

export default defineConfig({
  // `site` is the absolute origin baked into sitemap.xml, canonical tags,
  // and the starlight-llms-txt manifest links. The engineering docs are
  // served by the operator under /internal/docs; localhost:3070 is the
  // operator's documented HTTP surface (see papercusp-su playbook).
  site: 'http://localhost:3070',
  base: '/internal/docs',
  build: { format: 'file' },
  // Preview builds go to ./dist-preview so they NEVER reach the committed served
  // mirror (postbuild-copy mirrors ./dist only, and the preview script never runs it).
  outDir: PREVIEW ? './dist-preview' : './dist',
  integrations: [
    react(),
    starlight({
      title: 'Papercusp Internal',
      description: 'Engineering reference for the Papercusp multi-agent coding harness.',
      favicon: '/favicon.svg',
      logo: { src: './src/assets/hive-docs-logo.svg', alt: 'Papercusp Internal' },
      pagefind: true,
      lastUpdated: true,
      customCss: ['./src/styles/blue-frost.css'],
      plugins: [
        starlightLlmsTxt({
          projectName: 'Papercusp',
          description:
            'Internal engineering documentation for Papercusp - a local-first multi-agent coding harness.',
        }),
        ...previewPlugins,
      ],
      sidebar: [
        section('Agents', 'agents'),
        section('Agent Spawning', 'agent-spawning'),
        section('Agent Insights', 'agent-insights'),
        section('Benchmarks', 'benchmarks'),
        section('Build System', 'build-system'),
        section('Data Sync', 'data-sync'),
        section('Design', 'design'),
        section('Desktop', 'desktop'),
        section('Endpoint System', 'endpoint-system'),
        section('Harness', 'harness'),
        section('Implementation', 'implementation'),
        section('Plugins', 'plugins'),
        section('PostHog', 'posthog'),
        section('Reference (generated)', 'reference'),
        section('Security', 'security'),
        section('Snapshots', 'snapshots'),
        section('Spec', 'spec'),
        section('System', 'system'),
        section('Testing', 'testing'),
        ...previewSidebar,
      ],
    }),
  ],
});
