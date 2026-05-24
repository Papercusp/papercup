import { describe, expect, it } from 'vitest';
import {
  ENTRY_DISPLAY_DESCRIPTIONS,
  ENTRY_DISPLAY_LABELS,
  defaultStateForCreateHarnessEntry,
  displayDescriptionForEntry,
  displayLabelForEntry,
  entryAllowsCustomInitialState,
  requiresGithubAuthForEntry,
  validateCreateHarnessEntry,
  type CreateHarnessEntryInput,
} from './create-harness-entry-types';

describe('requiresGithubAuthForEntry', () => {
  it('true for entry_2 + entry_4', () => {
    expect(requiresGithubAuthForEntry('entry_2_github_url')).toBe(true);
    expect(requiresGithubAuthForEntry('entry_4_harness_link')).toBe(true);
  });

  it('false for entry_1 + entry_3 (local-only)', () => {
    expect(requiresGithubAuthForEntry('entry_1_init')).toBe(false);
    expect(requiresGithubAuthForEntry('entry_3_existing_folder')).toBe(false);
  });
});

describe('validateCreateHarnessEntry — Entry 1', () => {
  const base: CreateHarnessEntryInput = {
    kind: 'entry_1_init',
    slug: 'mything',
    parentDir: '/home/avi',
    folderName: 'mything',
  };

  it('ok for well-formed input', () => {
    expect(validateCreateHarnessEntry(base)).toEqual({ kind: 'ok' });
  });

  it('missing slug', () => {
    const r = validateCreateHarnessEntry({ ...base, slug: '' });
    expect(r.kind).toBe('missing_field');
    if (r.kind === 'missing_field') expect(r.field).toBe('slug');
  });

  it('missing parentDir', () => {
    const r = validateCreateHarnessEntry({ ...base, parentDir: '' });
    expect(r.kind).toBe('bad_path');
  });

  it('missing folderName', () => {
    const r = validateCreateHarnessEntry({ ...base, folderName: '' });
    expect(r.kind).toBe('missing_field');
    if (r.kind === 'missing_field') expect(r.field).toBe('folderName');
  });
});

describe('validateCreateHarnessEntry — Entry 2', () => {
  const base: CreateHarnessEntryInput = {
    kind: 'entry_2_github_url',
    githubUrl: 'https://github.com/x/y',
    oauthToken: 'ghp_xyz',
  };

  it('ok for well-formed', () => {
    expect(validateCreateHarnessEntry(base)).toEqual({ kind: 'ok' });
  });

  it('rejects empty URL', () => {
    const r = validateCreateHarnessEntry({ ...base, githubUrl: '' });
    expect(r.kind).toBe('missing_field');
  });

  it('rejects non-http URL', () => {
    const r = validateCreateHarnessEntry({ ...base, githubUrl: 'git@github.com:x/y.git' });
    expect(r.kind).toBe('bad_url');
  });

  it('rejects empty oauthToken', () => {
    const r = validateCreateHarnessEntry({ ...base, oauthToken: '' });
    expect(r.kind).toBe('bad_oauth_token');
  });
});

describe('validateCreateHarnessEntry — Entry 3', () => {
  const base: CreateHarnessEntryInput = {
    kind: 'entry_3_existing_folder',
    slug: 'mything',
    path: '/home/avi/mything',
  };

  it('ok for well-formed', () => {
    expect(validateCreateHarnessEntry(base)).toEqual({ kind: 'ok' });
  });

  it('rejects empty slug + path', () => {
    expect(validateCreateHarnessEntry({ ...base, slug: '' }).kind).toBe('missing_field');
    expect(validateCreateHarnessEntry({ ...base, path: '' }).kind).toBe('bad_path');
  });

  it('does NOT require oauth (Entry 3 is local-only)', () => {
    expect(validateCreateHarnessEntry(base)).toEqual({ kind: 'ok' });
  });
});

describe('validateCreateHarnessEntry — Entry 4', () => {
  const base: CreateHarnessEntryInput = {
    kind: 'entry_4_harness_link',
    harnessLink: 'papercusp://harness?topic=' + '0'.repeat(64) + '&github=x/y&repo_id=1',
    oauthToken: 'ghp_xyz',
  };

  it('ok for well-formed papercusp:// link', () => {
    expect(validateCreateHarnessEntry(base)).toEqual({ kind: 'ok' });
  });

  it('rejects non-papercusp link', () => {
    const r = validateCreateHarnessEntry({ ...base, harnessLink: 'https://example.com' });
    expect(r.kind).toBe('bad_url');
  });

  it('rejects empty link + missing token', () => {
    expect(validateCreateHarnessEntry({ ...base, harnessLink: '' }).kind).toBe('missing_field');
    expect(validateCreateHarnessEntry({ ...base, oauthToken: '' }).kind).toBe('bad_oauth_token');
  });
});

describe('defaultStateForCreateHarnessEntry', () => {
  it('Entry 1 → private', () => {
    expect(
      defaultStateForCreateHarnessEntry({
        kind: 'entry_1_init',
        slug: 'x',
        parentDir: '/d',
        folderName: 'x',
      }),
    ).toBe('private');
  });

  it('Entry 2 → shared-private (D-025)', () => {
    expect(
      defaultStateForCreateHarnessEntry({
        kind: 'entry_2_github_url',
        githubUrl: 'https://github.com/x/y',
        oauthToken: 't',
      }),
    ).toBe('shared-private');
  });

  it('Entry 3 → private', () => {
    expect(
      defaultStateForCreateHarnessEntry({
        kind: 'entry_3_existing_folder',
        slug: 'x',
        path: '/d',
      }),
    ).toBe('private');
  });

  it('Entry 4 → null (inherits from binding)', () => {
    expect(
      defaultStateForCreateHarnessEntry({
        kind: 'entry_4_harness_link',
        harnessLink: 'papercusp://harness?topic=' + '0'.repeat(64) + '&github=x/y&repo_id=1',
        oauthToken: 't',
      }),
    ).toBeNull();
  });
});

describe('entryAllowsCustomInitialState', () => {
  it('false for every entry (each has a fixed default per §3 + D-025)', () => {
    for (const k of [
      'entry_1_init',
      'entry_2_github_url',
      'entry_3_existing_folder',
      'entry_4_harness_link',
    ] as const) {
      expect(entryAllowsCustomInitialState(k)).toBe(false);
    }
  });
});

describe('display helpers', () => {
  it('ENTRY_DISPLAY_LABELS has all 4 kinds', () => {
    expect(Object.keys(ENTRY_DISPLAY_LABELS).sort()).toEqual([
      'entry_1_init',
      'entry_2_github_url',
      'entry_3_existing_folder',
      'entry_4_harness_link',
    ]);
  });

  it('ENTRY_DISPLAY_DESCRIPTIONS has all 4 kinds', () => {
    expect(Object.keys(ENTRY_DISPLAY_DESCRIPTIONS).length).toBe(4);
  });

  it('displayLabelForEntry returns the label', () => {
    expect(displayLabelForEntry('entry_1_init')).toBe('New local directory');
    expect(displayLabelForEntry('entry_2_github_url')).toBe('GitHub URL');
  });

  it('displayDescriptionForEntry returns the description', () => {
    expect(displayDescriptionForEntry('entry_3_existing_folder')).toContain('Private');
    expect(displayDescriptionForEntry('entry_4_harness_link')).toContain('papercusp://');
  });
});
