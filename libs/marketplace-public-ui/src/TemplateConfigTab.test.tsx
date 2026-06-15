// @vitest-environment jsdom
/**
 * TemplateConfigTab.test.tsx — whole-app-coverage P-008.
 *
 * Pure/presentational. Covers the empty state and each of the three sections:
 * config files (with language + sensitivity badges + description), the models
 * table (incl. the '—' preferred fallback), and plugins (auto-enable vs
 * recommended, string vs object plugin entries).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { TemplateConfigTab } from './TemplateConfigTab';

afterEach(cleanup);

describe('TemplateConfigTab', () => {
  it('renders the empty state when nothing is declared', () => {
    render(<TemplateConfigTab />);
    expect(
      screen.getByText(/does not declare any config files, models, or plugins/i),
    ).toBeTruthy();
  });

  it('lists config files with language + sensitivity badges and a description', () => {
    render(
      <TemplateConfigTab
        configFiles={[
          { path: 'AGENT.md', language: 'markdown', sensitivity: 'secret', description: 'the system prompt' },
        ]}
      />,
    );
    expect(screen.getByText('AGENT.md')).toBeTruthy();
    expect(screen.getByText('markdown')).toBeTruthy();
    expect(screen.getByText('secret')).toBeTruthy();
    expect(screen.getByText('the system prompt')).toBeTruthy();
  });

  it('renders the models table with a preferred-model fallback', () => {
    render(<TemplateConfigTab models={{ worker: { preferred: 'claude-opus-4-8' }, scoper: {} }} />);
    expect(screen.getByText('worker')).toBeTruthy();
    expect(screen.getByText('claude-opus-4-8')).toBeTruthy();
    expect(screen.getByText('scoper')).toBeTruthy();
    expect(screen.getByText('—')).toBeTruthy();
  });

  it('renders plugins, distinguishing auto-enable from recommended', () => {
    render(
      <TemplateConfigTab
        plugins={['plain-plugin', { slug: 'auto-plugin', version: '2.0.0', autoEnable: true }]}
      />,
    );
    expect(screen.getByText('plain-plugin')).toBeTruthy();
    expect(screen.getByText('recommended')).toBeTruthy();
    expect(screen.getByText('auto-plugin')).toBeTruthy();
    expect(screen.getByText('v2.0.0')).toBeTruthy();
    expect(screen.getByText('auto-enable')).toBeTruthy();
  });
});
