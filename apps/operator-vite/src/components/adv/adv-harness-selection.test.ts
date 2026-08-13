import { describe, expect, it } from 'vitest';
import { ALL_HARNESSES_OPTION, resolveAdvHarnessSelection } from './adv-harness-selection';

const PROJECTS = ['sheets', 'papercup', 'restart'];

describe('resolveAdvHarnessSelection', () => {
  it('no projects yet → no change', () => {
    expect(resolveAdvHarnessSelection({ projectSlugs: [], urlSlug: null, persisted: 'sheets' })).toEqual({});
  });

  it('an explicit valid ?slug= in the URL wins (deep-link / refresh) over any persisted value', () => {
    expect(
      resolveAdvHarnessSelection({ projectSlugs: PROJECTS, urlSlug: 'restart', persisted: 'sheets' }),
    ).toEqual({});
    expect(
      resolveAdvHarnessSelection({ projectSlugs: PROJECTS, urlSlug: 'restart', persisted: ALL_HARNESSES_OPTION }),
    ).toEqual({});
  });

  it('an explicit ?scope=all wins over a persisted concrete pot', () => {
    expect(
      resolveAdvHarnessSelection({
        projectSlugs: PROJECTS,
        urlSlug: null,
        urlScope: 'all',
        persisted: 'sheets',
      }),
    ).toEqual({});
  });

  it('restores a persisted concrete harness into scope=expanded (exits all-mode → full tab strip)', () => {
    expect(
      resolveAdvHarnessSelection({ projectSlugs: PROJECTS, urlSlug: null, persisted: 'sheets' }),
    ).toEqual({ setSlug: 'sheets', setScope: 'expanded' });
  });

  it('also restores the persisted harness when the URL slug is stale (not a current project)', () => {
    expect(
      resolveAdvHarnessSelection({ projectSlugs: PROJECTS, urlSlug: 'deleted-harness', persisted: 'papercup' }),
    ).toEqual({ setSlug: 'papercup', setScope: 'expanded' });
  });

  it('a persisted ALL sentinel → All-harnesses (scope=all)', () => {
    expect(
      resolveAdvHarnessSelection({ projectSlugs: PROJECTS, urlSlug: null, persisted: ALL_HARNESSES_OPTION }),
    ).toEqual({ setScope: 'all' });
  });

  it('nothing persisted → defaults to All-harnesses (scope=all)', () => {
    expect(
      resolveAdvHarnessSelection({ projectSlugs: PROJECTS, urlSlug: null, persisted: null }),
    ).toEqual({ setScope: 'all' });
  });

  it('a stale persisted slug (no longer a project) → All-harnesses, not a dead selection', () => {
    expect(
      resolveAdvHarnessSelection({ projectSlugs: PROJECTS, urlSlug: null, persisted: 'gone' }),
    ).toEqual({ setScope: 'all' });
  });
});
