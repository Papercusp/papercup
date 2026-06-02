/**
 * visibleHarnessesForViewer — §18 privacy-filter seam tests (P-072b).
 */

import { describe, expect, it } from 'vitest';
import { visibleHarnessesForViewer } from '../visible-harnesses';

const harnesses = [
  { harness_slug: 'public-one', privacy: 'shared-public' },
  { harness_slug: 'secret-one', privacy: 'shared-private' },
  { harness_slug: 'no-binding' }, // missing binding row
];

describe('visibleHarnessesForViewer', () => {
  it('anonymous viewer sees public + missing-binding, never shared-private', () => {
    const out = visibleHarnessesForViewer({
      subjectGithubUserId: 42,
      viewerGithubUserId: null,
      harnesses,
      viewerMembership: new Set(),
    });
    expect(out.map((h) => h.harness_slug)).toEqual(['public-one', 'no-binding']);
  });

  it('subject viewing own profile sees shared-private rows', () => {
    const out = visibleHarnessesForViewer({
      subjectGithubUserId: 42,
      viewerGithubUserId: 42,
      harnesses,
      viewerMembership: new Set(),
    });
    expect(out.map((h) => h.harness_slug)).toEqual([
      'public-one',
      'secret-one',
      'no-binding',
    ]);
  });

  it('member viewer unlocks the shared-private harness they belong to', () => {
    const out = visibleHarnessesForViewer({
      subjectGithubUserId: 42,
      viewerGithubUserId: 99,
      harnesses,
      viewerMembership: new Set(['secret-one']),
    });
    expect(out.map((h) => h.harness_slug)).toEqual([
      'public-one',
      'secret-one',
      'no-binding',
    ]);
  });

  it('non-member viewer cannot see a shared-private harness', () => {
    const out = visibleHarnessesForViewer({
      subjectGithubUserId: 42,
      viewerGithubUserId: 99,
      harnesses,
      viewerMembership: new Set(['some-other-harness']),
    });
    expect(out.map((h) => h.harness_slug)).toEqual(['public-one', 'no-binding']);
  });

  it('empty harness list yields empty', () => {
    expect(
      visibleHarnessesForViewer({
        subjectGithubUserId: 42,
        viewerGithubUserId: null,
        harnesses: [],
        viewerMembership: new Set(),
      }),
    ).toEqual([]);
  });
});
