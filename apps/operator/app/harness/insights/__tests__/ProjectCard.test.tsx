/**
 * @vitest-environment jsdom
 *
 * ProjectCard — P-073a tests.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { ProjectCard } from '../ProjectCard';

afterEach(() => {
  cleanup();
});

describe('ProjectCard — P-073a', () => {
  it('renders name + description + owner', () => {
    render(
      <ProjectCard
        name="papercup"
        description="The Papercusp dogfood project."
        ownerDisplayName="alice"
        claimStatus="claimed"
        claimantLogin="alice"
        githubUrl="https://github.com/papercupai/papercup"
      />,
    );
    const card = screen.getByTestId('insights-project-card');
    expect(card.textContent).toContain('papercup');
    expect(card.textContent).toContain('The Papercusp dogfood project.');
    expect(card.textContent).toContain('@alice');
  });

  it('renders claim status badge in title row', () => {
    render(
      <ProjectCard
        name="papercup"
        description="desc"
        ownerDisplayName="alice"
        claimStatus="unclaimed"
        githubUrl="https://github.com/x/y"
      />,
    );
    expect(screen.getByTestId('insights-project-card').textContent).toContain(
      'Unclaimed',
    );
  });

  it('renders license when provided', () => {
    render(
      <ProjectCard
        name="papercup"
        description="desc"
        ownerDisplayName="alice"
        claimStatus="claimed"
        license="MIT"
        githubUrl="https://github.com/x/y"
      />,
    );
    expect(screen.getByTestId('insights-project-card').textContent).toContain(
      'MIT',
    );
  });

  it('omits license row when not provided', () => {
    render(
      <ProjectCard
        name="papercup"
        description="desc"
        ownerDisplayName="alice"
        claimStatus="claimed"
        githubUrl="https://github.com/x/y"
      />,
    );
    expect(screen.getByTestId('insights-project-card').textContent).not.toContain(
      'License',
    );
  });

  it('renders top-3 languages and clips beyond', () => {
    render(
      <ProjectCard
        name="papercup"
        description="desc"
        ownerDisplayName="alice"
        claimStatus="claimed"
        languages={[
          { name: 'TypeScript', color: '#3178c6', percent: 70 },
          { name: 'Rust', color: '#dea584', percent: 20 },
          { name: 'Python', color: '#3572A5', percent: 8 },
          { name: 'Shell', color: '#89e051', percent: 2 },
        ]}
        githubUrl="https://github.com/x/y"
      />,
    );
    const langs = screen.getByTestId('project-card-languages');
    expect(langs.textContent).toContain('TypeScript');
    expect(langs.textContent).toContain('Rust');
    expect(langs.textContent).toContain('Python');
    expect(langs.textContent).not.toContain('Shell');
  });

  it('renders GitHub link with target=_blank', () => {
    render(
      <ProjectCard
        name="papercup"
        description="desc"
        ownerDisplayName="alice"
        claimStatus="claimed"
        githubUrl="https://github.com/papercupai/papercup"
      />,
    );
    const link = screen.getByTestId(
      'project-card-github-link',
    ) as HTMLAnchorElement;
    expect(link.href).toBe('https://github.com/papercupai/papercup');
    expect(link.target).toBe('_blank');
  });

  it('omits Discord link when not provided', () => {
    render(
      <ProjectCard
        name="papercup"
        description="desc"
        ownerDisplayName="alice"
        claimStatus="claimed"
        githubUrl="https://github.com/x/y"
      />,
    );
    expect(screen.queryByTestId('project-card-discord-link')).toBeNull();
  });

  it('renders Discord link when provided', () => {
    render(
      <ProjectCard
        name="papercup"
        description="desc"
        ownerDisplayName="alice"
        claimStatus="claimed"
        githubUrl="https://github.com/x/y"
        discordUrl="https://discord.gg/example"
      />,
    );
    const link = screen.getByTestId(
      'project-card-discord-link',
    ) as HTMLAnchorElement;
    expect(link.href).toBe('https://discord.gg/example');
  });
});
