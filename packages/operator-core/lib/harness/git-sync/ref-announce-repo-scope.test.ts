/**
 * Pure unit test (no git, no PG, no swarm) over the ref-announce repo-scope
 * routing rule. The case that earns this file is the UNTAGGED row: an
 * announcer on pre-fix code emits no `repo` tag, and the only sound
 * attribution is the pot's home install — attributing it to every install in
 * the hive is the live `no-such-repo` storm this rule was written to end.
 */
import { describe, expect, it } from 'vitest';

import {
  REF_ANNOUNCE_REPO_FIELD,
  refAnnounceRepoEnvelope,
  refAnnounceRepoTag,
  refAnnounceTargetsRepo,
} from './ref-announce-repo-scope';

const HOME = { slug: 'papercusp', potHomeSlug: 'papercusp' };
const SUB = { slug: 'papercusp/libs/generic/rrf', potHomeSlug: 'papercusp' };
const OTHER_SUB = { slug: 'papercusp/libs/generic/sse', potHomeSlug: 'papercusp' };

describe('refAnnounceTargetsRepo', () => {
  it('routes a tagged row to exactly the install whose slug matches', () => {
    const fe = { key: 'pot-git:ref-announce', payload: {}, ...refAnnounceRepoEnvelope(SUB.slug) };
    expect(refAnnounceTargetsRepo(fe, SUB)).toBe(true);
    expect(refAnnounceTargetsRepo(fe, OTHER_SUB)).toBe(false);
    expect(refAnnounceTargetsRepo(fe, HOME)).toBe(false);
  });

  it('routes a tagged HOME row to the home install only', () => {
    const fe = { key: 'pot-git:ref-announce', payload: {}, ...refAnnounceRepoEnvelope(HOME.slug) };
    expect(refAnnounceTargetsRepo(fe, HOME)).toBe(true);
    expect(refAnnounceTargetsRepo(fe, SUB)).toBe(false);
  });

  it('attributes an UNTAGGED row (pre-fix announcer) to the home install, never a submodule', () => {
    const fe = { key: 'pot-git:ref-announce', payload: {} };
    expect(refAnnounceTargetsRepo(fe, HOME)).toBe(true);
    expect(refAnnounceTargetsRepo(fe, SUB)).toBe(false);
    expect(refAnnounceTargetsRepo(fe, OTHER_SUB)).toBe(false);
  });

  it('treats a malformed tag (empty string, non-string) as untagged', () => {
    for (const bad of ['', 42, null, { slug: SUB.slug }]) {
      const fe = { key: 'pot-git:ref-announce', payload: {}, [REF_ANNOUNCE_REPO_FIELD]: bad };
      expect(refAnnounceRepoTag(fe)).toBeNull();
      expect(refAnnounceTargetsRepo(fe, HOME)).toBe(true);
      expect(refAnnounceTargetsRepo(fe, SUB)).toBe(false);
    }
  });

  it('a non-object envelope is untagged rather than a throw', () => {
    expect(refAnnounceRepoTag(undefined)).toBeNull();
    expect(refAnnounceRepoTag('repo')).toBeNull();
    expect(refAnnounceTargetsRepo(undefined, HOME)).toBe(true);
    expect(refAnnounceTargetsRepo(undefined, SUB)).toBe(false);
  });

  it('publisher envelope and reader field name cannot drift', () => {
    expect(refAnnounceRepoEnvelope('x')).toEqual({ [REF_ANNOUNCE_REPO_FIELD]: 'x' });
    expect(refAnnounceRepoTag(refAnnounceRepoEnvelope('x'))).toBe('x');
  });
});
