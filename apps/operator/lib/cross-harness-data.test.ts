/**
 * Coverage for cross-harness-data.slugToSchema — the slug → PG schema-name
 * mapping (harness_<slug> with dashes→underscores, lowercased). Pure.
 */
import { describe, expect, it } from 'vitest';
import { slugToSchema } from './cross-harness-data';

describe('slugToSchema', () => {
  it('prefixes harness_ and replaces dashes with underscores', () => {
    expect(slugToSchema('my-harness')).toBe('harness_my_harness');
    expect(slugToSchema('sheets-clone')).toBe('harness_sheets_clone');
  });
  it('lowercases', () => {
    expect(slugToSchema('Foo-Bar')).toBe('harness_foo_bar');
  });
  it('handles a single-segment slug', () => {
    expect(slugToSchema('papercup')).toBe('harness_papercup');
  });
});
