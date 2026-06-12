/**
 * hiveHomeOf — the P-007 (D-002) reviewer-role inheritance resolver: which
 * hive HOME a member harness inherits the role bit from. Pins: member → home,
 * home → null (never self-inherits), standalone → null, lookup failure → null
 * (inheritance silently off, settings stay safe-default).
 */
import { describe, test, expect, vi, beforeEach } from 'vitest';

const buildProjectsLitePayload = vi.fn();
vi.mock('../../../harness/projects-lite', () => ({
  buildProjectsLitePayload: (...args: unknown[]) => buildProjectsLitePayload(...args),
}));

import { hiveHomeOf, hiveGroupRootOf, resolveRoleSource } from './pr-reviewer-settings';

const HIVES = [
  {
    root: { slug: 'acme', harness_kind: 'hive' },
    members: [
      { slug: 'acme', harness_kind: 'hive' },
      { slug: 'acme-web', hive_slug: 'acme' },
      { slug: 'acme/libs/sync', harness_kind: 'sub-harness', hive_slug: 'acme' },
    ],
  },
  { root: { slug: 'solo' }, members: [{ slug: 'solo' }] },
];

beforeEach(() => {
  buildProjectsLitePayload.mockReset();
  buildProjectsLitePayload.mockResolvedValue({ projects: [], hives: HIVES });
});

describe('hiveHomeOf (P-007 role inheritance)', () => {
  test('a hive MEMBER resolves to its home', async () => {
    expect(await hiveHomeOf('acme-web')).toBe('acme');
  });

  test('a registered sub-harness member resolves to the home', async () => {
    expect(await hiveHomeOf('acme/libs/sync')).toBe('acme');
  });

  test('the home itself never self-inherits', async () => {
    expect(await hiveHomeOf('acme')).toBeNull();
  });

  test('a standalone harness (alone in its group) has no home', async () => {
    expect(await hiveHomeOf('solo')).toBeNull();
  });

  test('an unknown slug has no home', async () => {
    expect(await hiveHomeOf('ghost')).toBeNull();
  });

  test('a lite-payload failure degrades to no inheritance, never throws', async () => {
    buildProjectsLitePayload.mockRejectedValue(new Error('registry down'));
    expect(await hiveHomeOf('acme-web')).toBeNull();
  });
});

/**
 * resolveRoleSource — the P-008 (D-003) ownership-gate precedence matrix:
 * explicit row (the kill switch) > hive ownership > home-row inheritance >
 * default off.
 */
describe('resolveRoleSource (P-008 ownership gate)', () => {
  test('an explicit per-harness row beats everything (the kill switch)', () => {
    expect(
      resolveRoleSource({ hasExplicitRow: true, ownsHome: true, homeRoleEnabled: true }),
    ).toBe('explicit');
  });

  test('ownership confers the role with no explicit row', () => {
    expect(
      resolveRoleSource({ hasExplicitRow: false, ownsHome: true, homeRoleEnabled: false }),
    ).toBe('ownership');
  });

  test('home-row inheritance applies only without ownership', () => {
    expect(
      resolveRoleSource({ hasExplicitRow: false, ownsHome: false, homeRoleEnabled: true }),
    ).toBe('inherited');
  });

  test('nothing set → off', () => {
    expect(
      resolveRoleSource({ hasExplicitRow: false, ownsHome: false, homeRoleEnabled: false }),
    ).toBe('none');
  });
});

/** hiveGroupRootOf — the P-008 root resolution: members AND the home itself. */
describe('hiveGroupRootOf', () => {
  test('a member resolves to its group root', async () => {
    expect(await hiveGroupRootOf('acme-web')).toBe('acme');
  });

  test('the home resolves to ITSELF (ownership applies on the home too)', async () => {
    expect(await hiveGroupRootOf('acme')).toBe('acme');
  });

  test('a standalone harness is its own group root', async () => {
    expect(await hiveGroupRootOf('solo')).toBe('solo');
  });

  test('unknown slug / lookup failure → null', async () => {
    expect(await hiveGroupRootOf('ghost')).toBeNull();
    buildProjectsLitePayload.mockRejectedValue(new Error('down'));
    expect(await hiveGroupRootOf('acme')).toBeNull();
  });
});
