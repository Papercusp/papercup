import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import react from '@astrojs/react';
import starlightLlmsTxt from 'starlight-llms-txt';

const section = (label, directory) => ({
  label,
  items: [{ autogenerate: { directory, collapsed: true } }],
});

export default defineConfig({
  // `site` is the absolute origin baked into sitemap.xml, canonical tags,
  // and the starlight-llms-txt manifest links. The engineering docs are
  // served by the operator under /internal/docs; localhost:3070 is the
  // operator's documented HTTP surface (see papercusp-su playbook).
  site: 'http://localhost:3070',
  base: '/internal/docs',
  build: { format: 'file' },
  integrations: [
    react(),
    starlight({
      title: 'Papercusp Internal',
      description: 'Engineering reference for the Papercusp multi-agent coding harness.',
      pagefind: true,
      lastUpdated: true,
      customCss: ['./src/styles/blue-frost.css'],
      plugins: [
        starlightLlmsTxt({
          projectName: 'Papercusp',
          description:
            'Internal engineering documentation for Papercusp - a local-first multi-agent coding harness.',
        }),
      ],
      sidebar: [
        section('Agents', 'agents'),
        section('Agent Spawning', 'agent-spawning'),
        section('Agent Insights', 'agent-insights'),
        section('Build System', 'build-system'),
        section('Data Sync', 'data-sync'),
        section('Design', 'design'),
        section('Desktop', 'desktop'),
        section('Endpoint System', 'endpoint-system'),
        section('Implementation', 'implementation'),
        section('Plugins', 'plugins'),
        section('PostHog', 'posthog'),
        section('Reference (generated)', 'reference'),
        section('Security', 'security'),
        section('Snapshots', 'snapshots'),
        section('Spec', 'spec'),
        section('System', 'system'),
        section('Testing', 'testing'),
      ],
    }),
  ],
});
