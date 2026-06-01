import React from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { MarketplaceList, type CatalogEntry } from './MarketplaceList';

const SAMPLE_ENTRIES: CatalogEntry[] = [
  {
    slug: 'org-template',
    name: 'Org Template',
    version: '1.2.0',
    description: 'A well-structured template for SaaS projects. Includes feature tracking, roadmap management, and sprint planning.',
    author: 'papercusp',
    license: 'MIT',
    plugins: ['@papercusp/eslint', '@papercusp/prettier'],
    kind: 'template',
    topology: 'single',
    publishedAt: '2026-05-01T00:00:00Z',
    popularity30d: 42,
  },
  {
    slug: 'eslint-plugin',
    name: 'ESLint Plugin',
    version: '2.0.1',
    description: 'Enforces consistent code style and catches common mistakes.',
    author: 'papercusp',
    license: 'MIT',
    plugins: ['@papercusp/eslint'],
    kind: 'plugin',
    publishedAt: '2026-04-15T00:00:00Z',
    popularity30d: 128,
  },
  {
    slug: 'multi-dept',
    name: 'Multi-Department',
    version: '0.5.0',
    description: 'Multi-harness template with separate sub-projects per department.',
    author: 'papercusp',
    license: 'MIT',
    plugins: [],
    kind: 'template',
    topology: 'multi',
    subprojects: [
      { suffix: 'rd', kind: 'feature' },
      { suffix: 'marketing', kind: 'feature' },
    ],
    publishedAt: '2026-03-10T00:00:00Z',
    popularity30d: 17,
  },
];

const meta: Meta<typeof MarketplaceList> = {
  component: MarketplaceList,
  parameters: { layout: 'fullscreen' },
  decorators: [
    (Story) => (
      <div style={{ background: '#0c0e16', minHeight: '100vh', padding: 0 }}>
        <Story />
      </div>
    ),
  ],
};
export default meta;

type Story = StoryObj<typeof MarketplaceList>;

export const Templates: Story = {
  args: {
    kind: 'template',
    catalog: SAMPLE_ENTRIES.filter((e) => e.kind === 'template'),
  },
};

export const Plugins: Story = {
  args: {
    kind: 'plugin',
    catalog: SAMPLE_ENTRIES.filter((e) => e.kind === 'plugin'),
  },
};

export const EmptyCatalog: Story = {
  args: {
    kind: 'template',
    catalog: [],
  },
};

export const WithInstalledTemplates: Story = {
  args: {
    kind: 'template',
    catalog: SAMPLE_ENTRIES.filter((e) => e.kind === 'template'),
    installedTemplates: [
      { slug: 'org-template', version: '1.1.0', description: 'Org Template' },
    ],
  },
};

export const WithSearch: Story = {
  args: {
    kind: 'plugin',
    catalog: SAMPLE_ENTRIES,
    q: 'eslint',
  },
};
