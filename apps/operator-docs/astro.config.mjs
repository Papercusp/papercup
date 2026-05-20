import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import react from '@astrojs/react';
import starlightLlmsTxt from 'starlight-llms-txt';

const section = (label, directory) => ({
  label,
  items: [{ autogenerate: { directory, collapsed: true } }],
});

export default defineConfig({
  site: 'http://127.0.0.1:4325',
  base: '/internal/docs',
  integrations: [
    react(),
    starlight({
      title: 'Papercusp Internal',
      description: 'Engineering reference for the Papercusp multi-agent coding harness.',
      pagefind: true,
      lastUpdated: true,
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
        section('Snapshots', 'snapshots'),
        section('Spec', 'spec'),
        section('System', 'system'),
        section('Testing', 'testing'),
      ],
    }),
  ],
});
