/**
 * EI-19318501078776560 — the optional-seam-dependency trap detector, sibling of
 * `lint:required-field-strands` (check-required-field-strands.test.ts).
 *
 * Pins the two live instances the filing cites (member-content-guard's `loadRevoked`,
 * survey-workspace-scope's `fetchEscalatedIssues`) as regression fixtures, plus the
 * asymmetric-risk shape: a fallback to a LOCAL default must never be flagged, only a
 * fallback that resolves to something IMPORTED (a real implementation).
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
// @ts-expect-error — .mjs guard script, no type declarations by design
import { collectExportedInterfaceMembers, collectInterfaceMembersAcrossFiles, diffOptionalSeamAdditions, findRealFallback, findStrandedObjectLiterals, formatNoFindings } from '../../../../scripts/check-optional-seam-strands.mjs';

describe('collectExportedInterfaceMembers', () => {
  it('classifies a `typeof <imported fn>` optional member as seam-shaped', () => {
    const byIface = collectExportedInterfaceMembers(`
      import { realLoader } from './x';
      export interface Deps { loadRevoked?: typeof realLoader; }
    `);
    expect(byIface.get('Deps')?.get('loadRevoked')).toEqual({ optional: true, seamShaped: true });
  });

  it('classifies an optional function-type member as seam-shaped', () => {
    const byIface = collectExportedInterfaceMembers(`
      export interface Deps { fetchEscalatedIssues?: (a: string) => Promise<number[]>; }
    `);
    expect(byIface.get('Deps')?.get('fetchEscalatedIssues')).toEqual({ optional: true, seamShaped: true });
  });

  it('does NOT classify a plain optional scalar as seam-shaped — no noise on ordinary fields', () => {
    const byIface = collectExportedInterfaceMembers(`export interface Deps { label?: string; }`);
    expect(byIface.get('Deps')?.get('label')).toEqual({ optional: true, seamShaped: false });
  });

  it('ignores non-exported interfaces', () => {
    const byIface = collectExportedInterfaceMembers(`
      interface Private { x?: () => void; }
      export interface Public { y?: () => void; }
    `);
    expect(byIface.has('Private')).toBe(false);
    expect(byIface.has('Public')).toBe(true);
  });

  it('covers exported object-type aliases, not only interfaces', () => {
    const byIface = collectExportedInterfaceMembers(`export type Deps = { f?: () => void; };`);
    expect(byIface.get('Deps')?.get('f')).toEqual({ optional: true, seamShaped: true });
  });
});

describe('diffOptionalSeamAdditions', () => {
  it('flags a newly-added optional seam member', () => {
    const before = `
      import { real } from './x';
      export interface MemberContentGuardDeps { other?: () => void; }
    `;
    const after = `
      import { real } from './x';
      export interface MemberContentGuardDeps { other?: () => void; loadRevoked?: typeof real; }
    `;
    const added = diffOptionalSeamAdditions(before, after);
    expect(added).toEqual([{ interfaceName: 'MemberContentGuardDeps', member: 'loadRevoked', siblings: ['other'] }]);
  });

  it('stays SILENT on a newly-added REQUIRED member — that is required-field-strands\' job', () => {
    const before = `export interface Deps { a?: () => void; }`;
    const after = `export interface Deps { a?: () => void; b: () => void; }`;
    expect(diffOptionalSeamAdditions(before, after)).toEqual([]);
  });

  it('stays SILENT on a newly-added optional NON-seam scalar', () => {
    const before = `export interface Deps { a?: () => void; }`;
    const after = `export interface Deps { a?: () => void; label?: string; }`;
    expect(diffOptionalSeamAdditions(before, after)).toEqual([]);
  });

  it('stays silent when the member already existed as optional+seam-shaped', () => {
    const src = `import { real } from './x'; export interface Deps { loadRevoked?: typeof real; }`;
    expect(diffOptionalSeamAdditions(src, src)).toEqual([]);
  });

  it('reports every addition across several interfaces, not just the first', () => {
    const before = `export interface A { a?: () => void; }\nexport interface B { b?: () => void; }`;
    const after = `export interface A { a?: () => void; a2?: () => void; }\nexport interface B { b?: () => void; b2?: () => void; }`;
    const added = diffOptionalSeamAdditions(before, after);
    expect(added.map((a: { member: string }) => a.member).sort()).toEqual(['a2', 'b2']);
  });
});

describe('findRealFallback — the risk gate', () => {
  it('flags a fallback that resolves to an IMPORTED identifier (a real implementation)', () => {
    const src = `
      import { loadRevokedHivePubkeysForLocalPot } from '../../federated-pot-scope';
      const loadRevoked = deps?.loadRevoked ?? loadRevokedHivePubkeysForLocalPot;
    `;
    expect(findRealFallback(src, 'loadRevoked')).toBe('loadRevokedHivePubkeysForLocalPot');
  });

  it('does NOT flag a fallback to a LOCAL default (an inline lambda / module-local const)', () => {
    const src = `
      const localDefault = async () => new Set();
      const loadRevoked = deps?.loadRevoked ?? localDefault;
    `;
    expect(findRealFallback(src, 'loadRevoked')).toBeNull();
  });

  it('returns null when there is no `??` fallback for the member at all', () => {
    const src = `const x = deps?.loadRevoked;`;
    expect(findRealFallback(src, 'loadRevoked')).toBeNull();
  });
});

describe('findStrandedObjectLiterals', () => {
  it('flags an object literal supplying a SIBLING seam member but omitting the new one', () => {
    const src = `
      const deps = { loadMembers: async () => [], now: () => 1000 };
    `;
    const hits = findStrandedObjectLiterals(src, 'loadRevoked', ['loadMembers', 'now']);
    expect(hits).toEqual([2]);
  });

  it('does NOT flag a fixture that already supplies the member', () => {
    const src = `const deps = { loadMembers: async () => [], loadRevoked: async () => new Set() };`;
    expect(findStrandedObjectLiterals(src, 'loadRevoked', ['loadMembers'])).toEqual([]);
  });

  it('does NOT flag an unrelated object literal that shares none of the sibling keys', () => {
    const src = `const opts = { workspaceId: 'ws', harnessSlug: 'h' };`;
    expect(findStrandedObjectLiterals(src, 'loadRevoked', ['loadMembers', 'now'])).toEqual([]);
  });

  it('flags every stranded site, not just the first, across multiple literals', () => {
    const src = [
      'const a = { loadMembers: async () => [] };',
      'const b = { now: () => 1 };',
      'const c = { loadMembers: async () => [], loadRevoked: async () => new Set() };',
    ].join('\n');
    expect(findStrandedObjectLiterals(src, 'loadRevoked', ['loadMembers', 'now'])).toEqual([1, 2]);
  });
});

describe('collectInterfaceMembersAcrossFiles — following `extends` across files', () => {
  let dir: string;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('resolves inherited members through a RELATIVE-import `extends` chain (the live member-content-guard shape)', () => {
    dir = mkdtempSync(join(tmpdir(), 'p024-seam-heritage-'));
    writeFileSync(
      join(dir, 'base.ts'),
      `export interface MemberDeviceSetDeps { loadMembers?: () => void; now?: () => number; }`,
    );
    writeFileSync(
      join(dir, 'guard.ts'),
      [
        `import { real } from './x';`,
        `import type { MemberDeviceSetDeps } from './base';`,
        `export interface MemberContentGuardDeps extends MemberDeviceSetDeps { loadRevoked?: typeof real; }`,
      ].join('\n'),
    );
    const members = collectInterfaceMembersAcrossFiles(join(dir, 'guard.ts'), 'MemberContentGuardDeps');
    expect([...members.keys()].sort()).toEqual(['loadMembers', 'loadRevoked', 'now']);
  });

  it('returns just the own members when the interface does not extend anything', () => {
    dir = mkdtempSync(join(tmpdir(), 'p024-seam-heritage-'));
    writeFileSync(join(dir, 'solo.ts'), `export interface Deps { a?: () => void; }`);
    const members = collectInterfaceMembersAcrossFiles(join(dir, 'solo.ts'), 'Deps');
    expect([...members.keys()]).toEqual(['a']);
  });

  it('degrades to an empty map (never throws) when the interface is not found', () => {
    dir = mkdtempSync(join(tmpdir(), 'p024-seam-heritage-'));
    writeFileSync(join(dir, 'empty.ts'), `export const x = 1;`);
    expect(collectInterfaceMembersAcrossFiles(join(dir, 'empty.ts'), 'Nope').size).toBe(0);
  });
});

/**
 * Regression pin for the two concrete instances the filing cites — both already fixed by
 * hand (member-content-guard.test.ts's `loadRevoked` stub, survey-workspace-scope.test.ts's
 * `fetchEscalatedIssues` stub), reproduced here as MINIMAL fixtures so the detector's
 * end-to-end shape (diff → risky fallback → cross-file siblings → stranded literal) is
 * pinned even though the real fixtures are no longer stranded.
 */
describe('end-to-end shape — the member-content-guard live instance, minimised', () => {
  let dir: string;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('the fixture in the filing (loadMembers/now present, loadRevoked absent) is flagged as stranded', () => {
    dir = mkdtempSync(join(tmpdir(), 'p024-seam-e2e-'));
    writeFileSync(
      join(dir, 'base.ts'),
      `export interface MemberDeviceSetDeps { loadMembers?: () => void; now?: () => number; }`,
    );
    writeFileSync(
      join(dir, 'guard.ts'),
      [
        `import { loadRevokedHivePubkeysForLocalPot } from '../../federated-pot-scope';`,
        `import type { MemberDeviceSetDeps } from './base';`,
        `export interface MemberContentGuardDeps extends MemberDeviceSetDeps { loadRevoked?: typeof loadRevokedHivePubkeysForLocalPot; }`,
        `const loadRevoked = deps?.loadRevoked ?? loadRevokedHivePubkeysForLocalPot;`,
      ].join('\n'),
    );
    const afterText = readFileSync(join(dir, 'guard.ts'), 'utf8');

    expect(findRealFallback(afterText, 'loadRevoked')).toBe('loadRevokedHivePubkeysForLocalPot');
    const siblings = [...collectInterfaceMembersAcrossFiles(join(dir, 'guard.ts'), 'MemberContentGuardDeps').keys()]
      .filter((k) => k !== 'loadRevoked');
    expect(siblings.sort()).toEqual(['loadMembers', 'now']);

    const strandedFixture = `const deps = { loadMembers: async () => [], now: () => 1000 };`;
    expect(findStrandedObjectLiterals(strandedFixture, 'loadRevoked', siblings)).toEqual([1]);

    const fixedFixture = `const deps = { loadMembers: async () => [], now: () => 1000, loadRevoked: async () => new Set() };`;
    expect(findStrandedObjectLiterals(fixedFixture, 'loadRevoked', siblings)).toEqual([]);
  });
});

describe('formatNoFindings — "examined nothing" must never read as "clean"', () => {
  it('does NOT claim a clean bill when zero files were examined', () => {
    const msg = formatNoFindings(0, 'HEAD');
    expect(msg).toContain('NOT CHECKED');
    expect(msg).toContain('ZERO files');
    expect(msg).not.toMatch(/^✓/m);
  });

  it('passes cleanly when files WERE examined, and says how many', () => {
    const msg = formatNoFindings(4, 'HEAD~1');
    expect(msg).toMatch(/^✓/);
    expect(msg).toContain('4 changed file(s) examined');
    expect(msg).not.toContain('NOT CHECKED');
  });
});
