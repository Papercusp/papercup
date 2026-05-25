/**
 * @vitest-environment jsdom
 *
 * PeopleCard — P-073c tests.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { PeopleCard, type PeopleCardPerson } from '../PeopleCard';

afterEach(() => {
  cleanup();
});

function person(
  id: number,
  overrides: Partial<PeopleCardPerson> = {},
): PeopleCardPerson {
  return {
    github_user_id: id,
    login: `user${id}`,
    display_name: null,
    avatar_url: null,
    binding_status: 'verified',
    ...overrides,
  };
}

describe('PeopleCard — P-073c', () => {
  it('empty state when no people', () => {
    render(<PeopleCard people={[]} />);
    expect(screen.getByTestId('people-card-empty').textContent).toContain(
      'No contributors',
    );
  });

  it('renders count + person links', () => {
    render(
      <PeopleCard
        people={[
          person(1, { login: 'alice' }),
          person(2, { login: 'bob' }),
        ]}
      />,
    );
    const card = screen.getByTestId('insights-people-card');
    expect(card.textContent).toContain('People');
    expect(card.textContent).toContain('2');
    expect(screen.getByTestId('people-card-person-1')).toBeTruthy();
    expect(screen.getByTestId('people-card-person-2')).toBeTruthy();
  });

  it('default href targets /users/github/<id>', () => {
    render(<PeopleCard people={[person(42, { login: 'carol' })]} />);
    const link = screen.getByTestId(
      'people-card-person-42',
    ) as HTMLAnchorElement;
    expect(link.getAttribute('href')).toBe('/users/github/42');
  });

  it('respects custom buildProfileHref', () => {
    render(
      <PeopleCard
        people={[person(42, { login: 'carol' })]}
        buildProfileHref={(p) => `/u/${p.login}`}
      />,
    );
    const link = screen.getByTestId(
      'people-card-person-42',
    ) as HTMLAnchorElement;
    expect(link.getAttribute('href')).toBe('/u/carol');
  });

  it('uses img when avatar_url present', () => {
    render(
      <PeopleCard
        people={[
          person(1, {
            login: 'alice',
            avatar_url: 'https://example.com/a.png',
          }),
        ]}
      />,
    );
    const img = screen
      .getByTestId('people-card-person-1')
      .querySelector('img') as HTMLImageElement;
    expect(img).toBeTruthy();
    expect(img.src).toBe('https://example.com/a.png');
  });

  it('renders initials fallback when no avatar_url', () => {
    render(
      <PeopleCard
        people={[person(1, { display_name: 'Alice Allison' })]}
      />,
    );
    const card = screen.getByTestId('people-card-person-1');
    expect(card.textContent).toContain('AA');
  });

  it('initials fall back to login when no display name', () => {
    render(<PeopleCard people={[person(1, { login: 'carol' })]} />);
    expect(
      screen.getByTestId('people-card-person-1').textContent,
    ).toContain('C');
  });

  it('truncates beyond maxAvatars and shows overflow pill', () => {
    const many = Array.from({ length: 15 }, (_, i) =>
      person(i + 1, { login: `u${i + 1}` }),
    );
    render(<PeopleCard people={many} maxAvatars={5} />);
    expect(screen.getByTestId('people-card-overflow').textContent).toContain(
      '+10',
    );
    expect(
      screen.queryByTestId('people-card-person-6'),
    ).toBeNull();
  });

  it('no overflow pill when within maxAvatars', () => {
    render(
      <PeopleCard
        people={[person(1), person(2)]}
        maxAvatars={5}
      />,
    );
    expect(screen.queryByTestId('people-card-overflow')).toBeNull();
  });

  it('passes binding_status through to overlay badge', () => {
    render(
      <PeopleCard
        people={[
          person(1, { login: 'alice', binding_status: 'pending' }),
        ]}
      />,
    );
    // BindingStatusBadge renders a "pending" label
    const card = screen.getByTestId('people-card-person-1');
    expect(card.textContent?.toLowerCase()).toContain('pending');
  });
});
