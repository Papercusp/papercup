// @vitest-environment jsdom
/**
 * MarketplaceDetail.test.tsx — P-072f.
 *
 * Verifies the `publishedBy` link target switched from a GitHub-direct
 * profile URL to the in-app Papercusp profile route. The GitHub link is
 * NOT gone from the product — it lives in the user-profile header now.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import React from 'react';
import { MarketplaceDetail, type DetailResponse } from './MarketplaceDetail';

afterEach(cleanup);

function detail(over: Partial<DetailResponse['latest']> = {}): DetailResponse {
  return {
    slug: 'my-template',
    versions: ['1.0.0'],
    latest: {
      name: 'My Template',
      version: '1.0.0',
      description: 'desc',
      kind: 'template',
      publishedBy: 'alice',
      ...over,
    },
  };
}

describe('MarketplaceDetail publishedBy link (P-072f)', () => {
  it('links @publishedBy to the Papercusp profile route, not github.com', () => {
    render(<MarketplaceDetail slug="my-template" detail={detail()} />);
    const link = screen.getByText('@alice').closest('a') as HTMLAnchorElement;
    expect(link.getAttribute('href')).toBe('/users/alice');
    expect(link.getAttribute('href')).not.toContain('github.com');
  });

  it('falls back to author text when no publishedBy', () => {
    render(
      <MarketplaceDetail
        slug="my-template"
        detail={detail({ publishedBy: undefined, author: 'bob' })}
      />,
    );
    // No publisher link rendered; author shown as plain text.
    expect(screen.queryByText('@alice')).toBeNull();
    expect(screen.getByText(/bob/)).toBeTruthy();
  });
});
