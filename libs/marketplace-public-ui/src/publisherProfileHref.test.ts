/**
 * publisherProfileHref — P-072f link-target test.
 */

import { describe, expect, it } from 'vitest';
import { publisherProfileHref } from './publisherProfileHref';

describe('publisherProfileHref', () => {
  it('targets the in-app Papercusp username route, not GitHub', () => {
    const href = publisherProfileHref('alice');
    expect(href).toBe('/users/alice');
    expect(href).not.toContain('github.com');
  });

  it('encodes logins so path stays safe', () => {
    expect(publisherProfileHref('a b')).toBe('/users/a%20b');
  });
});
