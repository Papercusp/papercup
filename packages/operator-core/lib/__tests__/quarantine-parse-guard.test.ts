/**
 * quarantine-parse-guard.test.ts — WI-3371 regression guard.
 *
 * `scripts/affected-tests.mjs` used to parse quarantine.txt as
 * `const [ws] = line.split('::'); quarantined.add(ws)` — which added the
 * WORKSPACE half of a per-file `workspace::glob` entry to the whole-workspace
 * quarantine set, even though the file's own comment says per-file entries are
 * "informational only". Since every quarantine.txt entry in this repo is a
 * per-file entry (none are bare workspace lines), that bug meant
 * `npm run test:affected` never gated a real failure in ANY quarantined
 * workspace — @papercusp/operator-core (the largest, most critical workspace)
 * included. This locks the fix: a bare line quarantines its workspace; a
 * `workspace::glob` line does NOT.
 */
import { describe, it, expect } from 'vitest';
import { parseQuarantineWorkspaces } from '../../../../scripts/lib/quarantine.mjs';

describe('parseQuarantineWorkspaces (WI-3371)', () => {
  it('quarantines a BARE workspace line (no ::)', () => {
    const set = parseQuarantineWorkspaces('@papercusp/some-flaky-workspace\n');
    expect(set.has('@papercusp/some-flaky-workspace')).toBe(true);
  });

  it('does NOT quarantine the workspace for a per-file `workspace::glob` entry', () => {
    const set = parseQuarantineWorkspaces('@papercusp/operator-core::lib/sync/hyperbee/**\n');
    expect(set.has('@papercusp/operator-core')).toBe(false);
    expect(set.size).toBe(0);
  });

  it('handles a mix: bare lines quarantine, per-file lines do not', () => {
    const text = [
      '@papercusp/operator-core::lib/**/*federation*.test.ts',
      '@papercusp/fully-dark-workspace',
      '# a comment line',
      '',
      '@papercusp/p2p-voice::src/**',
    ].join('\n');
    const set = parseQuarantineWorkspaces(text);
    expect(set.has('@papercusp/fully-dark-workspace')).toBe(true);
    expect(set.has('@papercusp/operator-core')).toBe(false);
    expect(set.has('@papercusp/p2p-voice')).toBe(false);
    expect(set.size).toBe(1);
  });

  it('strips trailing comments and ignores blank lines', () => {
    const set = parseQuarantineWorkspaces('  @papercusp/dark-ws   # flaky, tracked in WI-9999\n\n\n');
    expect(set.has('@papercusp/dark-ws')).toBe(true);
    expect(set.size).toBe(1);
  });

  it('matches the LIVE repo quarantine.txt: zero bare-workspace entries today (all per-file)', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve, dirname } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
    const text = readFileSync(resolve(root, 'quarantine.txt'), 'utf8');
    const set = parseQuarantineWorkspaces(text);
    // Documents current reality, not a hard invariant: if this ever starts
    // failing because someone adds a bare workspace line, that's a real
    // whole-workspace quarantine decision to review, not a broken test.
    expect(set.has('@papercusp/operator-core')).toBe(false);
  });
});
