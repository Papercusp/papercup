/**
 * settings-audit-nav.test.ts — WI-3449 (2026-07-10 settings-page audit)
 * regression guard.
 *
 * Owner-directed cleanup: (1) remove the testing-only, cut-for-V1 Oracle
 * assistant settings page (`/settings/oracle`) + its nav entry + FLAGS.TESTING
 * gate; (2) merge the two separate OMP settings pages
 * (`/settings/omp` + `/settings/omp-integration`) into one
 * (`/settings/omp`). A prior attempt at this landed in a stranded git
 * worktree and never reached the canonical tree (see the WI-3449 comment
 * thread) — this plain-data test pins the nav shape so a future edit can't
 * silently regress it back in (or silently strand the fix again without a
 * failing test to catch it).
 */
import { describe, expect, it } from 'vitest';
import { SETTINGS_GROUPS } from './layout';

const allHrefs = SETTINGS_GROUPS.flatMap((g) => g.links.map((l) => l.href));

describe('settings nav — WI-3449 audit', () => {
  it('does not list /settings/oracle (removed: testing-only, cut for V1)', () => {
    expect(allHrefs).not.toContain('/settings/oracle');
  });

  it('does not list /settings/omp-integration (merged into /settings/omp)', () => {
    expect(allHrefs).not.toContain('/settings/omp-integration');
  });

  it('still lists /settings/omp (now carries both config + integration)', () => {
    expect(allHrefs).toContain('/settings/omp');
  });

  it('no href appears twice (a merge should not leave a stray duplicate entry)', () => {
    expect(new Set(allHrefs).size).toBe(allHrefs.length);
  });
});

/**
 * WI-3532 (the sibling field-level audit). The Plugins pages were fully
 * functional and had working operator-vite route stubs, but were absent from
 * this nav and reachable only via plugins/page.tsx's own self-link — so they
 * were dead UI in practice. Owner directed: "Add them to the settings nav."
 */
describe('settings nav — WI-3532 audit', () => {
  it('lists /settings/plugins (was functional but unreachable)', () => {
    expect(allHrefs).toContain('/settings/plugins');
  });

  it('lists /settings/plugins/tools', () => {
    expect(allHrefs).toContain('/settings/plugins/tools');
  });

  // The layout picks the active link by longest-href-first, so a nested route
  // must not be shadowed by its parent. Pins the invariant that makes
  // /settings/plugins/tools highlight itself rather than /settings/plugins.
  it('resolves the most specific nav entry for a nested route', () => {
    const pathname = '/settings/plugins/tools';
    const active = [...allHrefs]
      .sort((a, b) => b.length - a.length)
      .find((href) => pathname === href || pathname.startsWith(`${href}/`));
    expect(active).toBe('/settings/plugins/tools');
  });
});
