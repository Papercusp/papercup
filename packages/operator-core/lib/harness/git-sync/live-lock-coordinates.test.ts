import { describe, it, expect } from 'vitest';
import { mapLiveLockHoldingsForRepo, nestedInstallRepoPrefix } from './live-lock-coordinates';

// P-009 / WI-10002596: nested git-sync installs (slug `<parent>/<rel>`) sync a submodule as
// their own repo root, but the lock plane speaks in the parent's root coordinates.
describe('nestedInstallRepoPrefix', () => {
  it('is empty for a top-level install', () => {
    expect(nestedInstallRepoPrefix('papercusp', '/w/papercusp', '/w/papercusp')).toBe('');
  });

  it('derives the prefix from the parent root', () => {
    expect(nestedInstallRepoPrefix('papercusp/libs/papercusp', '/w/papercusp/libs/papercusp', '/w/papercusp')).toBe(
      'libs/papercusp',
    );
  });

  it('trusts the filesystem over the slug tail', () => {
    expect(nestedInstallRepoPrefix('papercusp/libs/x', '/w/papercusp/libs/generic/x', '/w/papercusp')).toBe(
      'libs/generic/x',
    );
  });

  it('refuses a repo that is not inside the parent root', () => {
    expect(nestedInstallRepoPrefix('papercusp/libs/x', '/elsewhere/x', '/w/papercusp')).toBe('');
  });

  it('falls back to the slug tail only when the repo path ends with it', () => {
    expect(nestedInstallRepoPrefix('papercusp/libs/agent-chat', '/w/papercusp/libs/agent-chat', null)).toBe(
      'libs/agent-chat',
    );
    expect(nestedInstallRepoPrefix('papercusp/libs/agent-chat', '/w/other/place', null)).toBe('');
  });

  it('is empty without a repo path', () => {
    expect(nestedInstallRepoPrefix('papercusp/libs/x', null, '/w/papercusp')).toBe('');
  });
});

describe('mapLiveLockHoldingsForRepo through a nested-install prefix', () => {
  it('maps the lock git-sync ignored when it committed the libs/papercusp mutant (1e553ccd)', () => {
    const probeLock = {
      path: 'libs/papercusp/packages/orchestrator/src/codex-gateway-config.ts',
      owner: 'su-1bb6850b',
      intent: 'mutation probe',
    };
    const prefix = nestedInstallRepoPrefix('papercusp/libs/papercusp', '/w/papercusp/libs/papercusp', '/w/papercusp');
    expect(
      mapLiveLockHoldingsForRepo([probeLock, { path: 'packages/x.ts', owner: 'su-peer', intent: 'other repo' }], prefix),
    ).toEqual([{ ...probeLock, path: 'packages/orchestrator/src/codex-gateway-config.ts' }]);
  });
});
