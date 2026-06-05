/**
 * derivePublisherPermission — item 2 of the cupboard-provisional-listing-trust
 * memo. Maps GitHub's repo `permissions` booleans to a single level used as
 * the browse-card "collaborator vs not-a-collaborator" signal.
 */

import { describe, it, expect } from 'vitest';
import { derivePublisherPermission } from '../routes/listings.ts';

describe('derivePublisherPermission', () => {
  it('returns the highest applicable role', () => {
    expect(derivePublisherPermission({ admin: true, maintain: true, push: true, pull: true })).toBe('admin');
    expect(derivePublisherPermission({ maintain: true, push: true, pull: true })).toBe('maintain');
    expect(derivePublisherPermission({ push: true, pull: true })).toBe('write');
    expect(derivePublisherPermission({ triage: true, pull: true })).toBe('triage');
    expect(derivePublisherPermission({ pull: true })).toBe('read');
    expect(derivePublisherPermission({})).toBe('none');
  });

  it('treats missing permissions as none (non-collaborator)', () => {
    expect(derivePublisherPermission(undefined)).toBe('none');
    expect(derivePublisherPermission(null)).toBe('none');
  });

  it('a public-repo non-collaborator (pull only) reads as read, not a collaborator', () => {
    // GitHub returns pull:true for any authenticated user on a public repo.
    expect(derivePublisherPermission({ pull: true, push: false, maintain: false, admin: false })).toBe('read');
  });
});
