import { describe, it, expect } from 'vitest';
import {
  groupFilesForAttribution,
  attributionMapForRepo,
  agentsForScopedFiles,
  intentToSubject,
  coAuthorTrailer,
  DEFAULT_GIT_SYNC_SUBJECT,
  type FileAttribution,
} from './git-sync-attribution';

describe('agentsForScopedFiles (P-006 assign-don\'t-broadcast)', () => {
  const roster = [
    { agent: 'ag1', files: ['apps/operator/x.ts'] },
    { agent: 'ag2', files: ['libs/papercusp/packages/y.ts'] },
  ];
  it('maps superproject + submodule-scoped files to their declaring agents (deduped)', () => {
    const agents = agentsForScopedFiles(roster, [
      { scope: 'superproject', file: 'apps/operator/x.ts' },
      { scope: 'libs/papercusp', file: 'packages/y.ts' }, // submodule-relative
      { scope: 'libs/papercusp', file: 'packages/y.ts' }, // dup → deduped
    ]);
    expect(agents.sort()).toEqual(['ag1', 'ag2']);
  });
  it('returns [] when nothing is attributable (caller falls back to broadcast)', () => {
    expect(agentsForScopedFiles(roster, [{ scope: 'superproject', file: 'unowned.ts' }])).toEqual([]);
  });
});

describe('groupFilesForAttribution (P-004)', () => {
  it('groups attributed files per agent + a catch-all remainder LAST', () => {
    const attr = new Map<string, FileAttribution>([
      ['a.ts', { agent: 'ag2', agentLabel: 'Bee Two', intent: 'fix the parser' }],
      ['b.ts', { agent: 'ag1', agentLabel: 'Bee One', intent: 'add the flag' }],
      ['c.ts', { agent: 'ag2', agentLabel: 'Bee Two', intent: 'fix the parser' }],
    ]);
    const groups = groupFilesForAttribution(['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts'], attr);

    // ag1, ag2 (sorted by id), then the catch-all (null) LAST.
    expect(groups.map((g) => g.agent)).toEqual(['ag1', 'ag2', null]);
    expect(groups[0]).toMatchObject({ agent: 'ag1', files: ['b.ts'], subject: 'add the flag (Bee One)' });
    expect(groups[1]).toMatchObject({ agent: 'ag2', files: ['a.ts', 'c.ts'] }); // sorted within
    expect(groups[1].subject).toBe('fix the parser (Bee Two)');
    expect(groups[1].coAuthor).toBe('Bee Two <ag2@agents.papercusp>');
    // remainder = the unattributed files, sorted, with the default subject + no co-author.
    expect(groups[2]).toEqual({ agent: null, files: ['d.ts', 'e.ts'], subject: DEFAULT_GIT_SYNC_SUBJECT, coAuthor: null });
  });

  it('with no attribution, the only group is the catch-all over ALL files (flag-OFF degradation)', () => {
    const groups = groupFilesForAttribution(['x.ts', 'y.ts'], new Map());
    expect(groups).toHaveLength(1);
    expect(groups[0]).toEqual({ agent: null, files: ['x.ts', 'y.ts'], subject: DEFAULT_GIT_SYNC_SUBJECT, coAuthor: null });
  });

  it('the catch-all group is always present even when every file is attributed', () => {
    const attr = new Map<string, FileAttribution>([['a.ts', { agent: 'ag1' }]]);
    const groups = groupFilesForAttribution(['a.ts'], attr);
    expect(groups.map((g) => g.agent)).toEqual(['ag1', null]);
    expect(groups[1].files).toEqual([]); // empty remainder — caller skips an empty add
  });
});

describe('intentToSubject', () => {
  it('uses the intent + label, collapsing whitespace and clamping to 72 chars', () => {
    expect(intentToSubject('fix\n  the   parser', 'Bee')).toBe('fix the parser (Bee)');
    const long = 'x'.repeat(100);
    expect(intentToSubject(long, undefined).length).toBe(72);
  });
  it('falls back to the default subject when the intent is empty/blank', () => {
    expect(intentToSubject('', 'Bee')).toBe(DEFAULT_GIT_SYNC_SUBJECT);
    expect(intentToSubject('   ', undefined)).toBe(DEFAULT_GIT_SYNC_SUBJECT);
    expect(intentToSubject(undefined, undefined)).toBe(DEFAULT_GIT_SYNC_SUBJECT);
  });
});

describe('coAuthorTrailer', () => {
  it('formats Name <email>, synthesizing an agents address when email is unknown', () => {
    expect(coAuthorTrailer({ agent: 'ag1', agentLabel: 'Bee One', email: 'b1@x.com' })).toBe('Bee One <b1@x.com>');
    expect(coAuthorTrailer({ agent: 'ag1', agentLabel: 'Bee One' })).toBe('Bee One <ag1@agents.papercusp>');
  });
  it('falls back to the agent id as the name, or null when there is no identity', () => {
    expect(coAuthorTrailer({ agent: 'ag1' })).toBe('ag1 <ag1@agents.papercusp>');
    expect(coAuthorTrailer({ agent: '' })).toBeNull();
  });
});

describe('attributionMapForRepo', () => {
  const roster = [
    { agent: 'ag1', agentLabel: 'One', intent: 'super work', files: ['apps/operator/x.ts', 'libs/papercusp/packages/y.ts'] },
    { agent: 'ag2', agentLabel: 'Two', intent: 'sub work', files: ['libs/papercusp/packages/z.ts'] },
  ];

  it('superproject (no prefix): maps top-level paths directly', () => {
    const m = attributionMapForRepo(roster, '');
    expect(m.get('apps/operator/x.ts')?.agent).toBe('ag1');
    // submodule-inner paths are kept but simply won't match superproject gitlink dirty paths.
    expect(m.get('libs/papercusp/packages/y.ts')?.agent).toBe('ag1');
  });

  it('submodule: strips the submodule prefix so paths match submodule-relative dirty paths', () => {
    const m = attributionMapForRepo(roster, 'libs/papercusp');
    expect(m.get('packages/y.ts')?.agent).toBe('ag1');
    expect(m.get('packages/z.ts')?.agent).toBe('ag2');
    // a file outside this submodule is dropped.
    expect(m.has('apps/operator/x.ts')).toBe(false);
  });

  it('tolerates ABSOLUTE current_files by stripping the superproject root (P-004 review)', () => {
    const absRoster = [{ agent: 'ag1', files: ['/home/u/papercup/apps/operator/x.ts'] }];
    // without superRoot: the absolute path doesn't match the repo-relative key.
    expect(attributionMapForRepo(absRoster, '').has('apps/operator/x.ts')).toBe(false);
    // with superRoot: stripped to the repo-relative key → matches.
    expect(attributionMapForRepo(absRoster, '', '/home/u/papercup').get('apps/operator/x.ts')?.agent).toBe('ag1');
    // submodule + absolute also works (strip super root, then the submodule prefix).
    const absSub = [{ agent: 'ag2', files: ['/home/u/papercup/libs/papercusp/packages/z.ts'] }];
    expect(attributionMapForRepo(absSub, 'libs/papercusp', '/home/u/papercup').get('packages/z.ts')?.agent).toBe('ag2');
  });

  it('first-declared wins when two agents claim the same path (locks serialize edits)', () => {
    const dup = [
      { agent: 'first', files: ['a.ts'] },
      { agent: 'second', files: ['a.ts'] },
    ];
    expect(attributionMapForRepo(dup, '').get('a.ts')?.agent).toBe('first');
  });
});
