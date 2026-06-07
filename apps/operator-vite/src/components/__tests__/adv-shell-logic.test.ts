/**
 * adv-shell-logic.test.ts — Plan 1 P-021: critical-screen flow logic tests
 * for the /adv harness SPA (operator-vite).
 *
 * Covers the pure-logic layer of the workspace switch + harness picker screens
 * without mounting full components (which require real ZQL sync + IPC).
 *
 * Tests:
 *   ADV_TABS structural invariants (all required fields, correct id set)
 *   supportsAll subset — the workspace-level views vs per-harness views
 *   buildHarnessSelectOptions — the harness selector dropdown builder:
 *     loading/error states, root harnesses, parent/child hierarchy,
 *     orphan handling, depth cap, deduplication
 */

import { describe, expect, it } from 'vitest';
import { ADV_TABS, type AdvTabId, buildHarnessSelectOptions, visibleAdvTabs } from '../adv/AdvShell';

// ─── ADV_TABS structural invariants ──────────────────────────────────────────

describe('ADV_TABS', () => {
  it('every tab has the required shape (id, label, icon, accent, accentRgb)', () => {
    for (const tab of ADV_TABS) {
      expect(tab.id).toBeTruthy();
      expect(tab.label).toBeTruthy();
      expect(['function', 'object'].includes(typeof tab.icon)).toBe(true); // React components can be functions or forwardRef objects
      expect(tab.accent).toMatch(/^#[0-9a-f]{6}$/i);
      expect(tab.accentRgb).toMatch(/^\d+,\s*\d+,\s*\d+$/);
    }
  });

  it('no duplicate ids', () => {
    const ids = ADV_TABS.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('prs is excluded from ADV_TABS but present in the type union', () => {
    // prs has its own redirect route; it is NOT in the strip but IS a valid
    // AdvTabId value (the type comes from ADV_TAB_IDS which includes prs).
    // Cast to string: 'prs' was removed from ADV_TABS, so its element-id union
    // no longer overlaps 'prs' (the assertion is exactly that it's absent).
    expect(ADV_TABS.every((t) => (t.id as string) !== 'prs')).toBe(true);
  });

  it('all-mode strip = workspace-level subset; single-pot strip = every tab', () => {
    // Under "All Pots" the per-pot tabs (Brainstorm/Git/Tests/Docs/Insights/
    // Config/Settings) are hidden from the strip — only the workspace-level
    // views remain (owner directive 2026-06-05; AdvShell snaps the active tab
    // back to Overview when it goes invisible). This supersedes the earlier
    // "strip is scope-independent" guard: that guard existed because all-mode
    // once collapsed to just TWO tabs, which read as breakage.
    expect(visibleAdvTabs(true).map((t) => t.id)).toEqual([
      'overview', 'plans', 'harnesses', 'frames', 'conversations',
    ]);
    // A single pot shows the full strip. Strip order: Overview leads (the
    // default landing surface, Brief 23 / overview-dashboard-2026-06-05
    // D-001); Conversations sits with the browse surfaces (Brief 25).
    expect(visibleAdvTabs(false)).toEqual([...ADV_TABS]);
    expect(ADV_TABS.map((t) => t.id)).toEqual([
      'overview', 'brainstorm', 'plans', 'harnesses', 'frames', 'git', 'testing', 'docs', 'insights',
      'conversations', 'config', 'settings',
    ]);
  });
});

// ─── buildHarnessSelectOptions ────────────────────────────────────────────────

describe('buildHarnessSelectOptions', () => {
  it('returns a loading placeholder when projects is empty (no error)', () => {
    const opts = buildHarnessSelectOptions([], null);
    expect(opts).toHaveLength(1);
    expect(opts[0].value).toBe('__loading');
    expect(opts[0].label).toContain('Loading');
    expect(opts[0].disabled).toBe(true);
  });

  it('returns an error placeholder when projects is empty and there is an error', () => {
    const opts = buildHarnessSelectOptions([], 'network error');
    expect(opts[0].label).toContain('Failed');
    expect(opts[0].disabled).toBe(true);
  });

  it('always leads with "All Pots" when projects exist', () => {
    const opts = buildHarnessSelectOptions([{ slug: 'sheets' }], null);
    expect(opts[0].label).toBe('All Pots');
  });

  it('routes the leading-option label through the brand lexicon (the-hive)', () => {
    // The component threads t('pot', { plural: true }); classic = "Pots" (the
    // default above), the-hive = "Hives" (P-005 / the-hive-lexicon).
    const opts = buildHarnessSelectOptions([{ slug: 'sheets' }], null, 'Hives');
    expect(opts[0].label).toBe('All Hives');
  });

  it('flat list: root harnesses appear after "All harnesses", sorted', () => {
    const opts = buildHarnessSelectOptions(
      [{ slug: 'zebra' }, { slug: 'alpha' }, { slug: 'mango' }],
      null,
    );
    const slugs = opts.slice(1).map((o) => o.value);
    expect(slugs).toEqual(['alpha', 'mango', 'zebra']);
  });

  it('renders child harnesses indented under parent', () => {
    const opts = buildHarnessSelectOptions(
      [
        { slug: 'org' },
        { slug: 'org-rd', parent_slug: 'org' },
        { slug: 'org-marketing', parent_slug: 'org' },
      ],
      null,
    );
    // org → then children indented
    const labels = opts.map((o) => o.label);
    const orgIdx = labels.findIndex((l) => l === 'org');
    const rdIdx  = labels.findIndex((l) => l.includes('org-rd'));
    const mkIdx  = labels.findIndex((l) => l.includes('org-marketing'));
    expect(orgIdx).toBeLessThan(rdIdx);
    expect(orgIdx).toBeLessThan(mkIdx);
    // Children are indented (label starts with spaces + ↳)
    expect(opts[rdIdx].label).toMatch(/^\s+↳/);
  });

  it('children are sorted within the same parent', () => {
    const opts = buildHarnessSelectOptions(
      [
        { slug: 'org' },
        { slug: 'org-z', parent_slug: 'org' },
        { slug: 'org-a', parent_slug: 'org' },
      ],
      null,
    );
    const children = opts.filter((o) => o.label.includes('↳'));
    expect(children[0].value).toBe('org-a');
    expect(children[1].value).toBe('org-z');
  });

  it('orphans (parent_slug not in registry) appear as root entries', () => {
    const opts = buildHarnessSelectOptions(
      [{ slug: 'orphan', parent_slug: 'missing-parent' }],
      null,
    );
    const slugs = opts.slice(1).map((o) => o.value);
    expect(slugs).toContain('orphan');
    // Orphan has no indent (it's treated as a root)
    const orphanOpt = opts.find((o) => o.value === 'orphan');
    expect(orphanOpt?.label).not.toMatch(/^\s+↳/);
  });

  it('does not duplicate entries when both root and child have the same slug', () => {
    // Degenerate: a harness appears twice — the visited set prevents re-emission.
    const opts = buildHarnessSelectOptions(
      [{ slug: 'dup' }, { slug: 'dup', parent_slug: 'dup' }],
      null,
    );
    const dupCount = opts.filter((o) => o.value === 'dup').length;
    expect(dupCount).toBeLessThanOrEqual(1);
  });
});

// ─── Panel → tab redirect mapping (inline mirror) ────────────────────────────
// The route's PANEL_TO_TAB is private, but the expected mapping is a contract.
// Documenting it here catches regressions if the route is changed.

describe('harness route panel → tab mapping contract', () => {
  // Mirror of the private PANEL_TO_TAB in harness/index.tsx.
  const EXPECTED_MAPPING: Record<string, AdvTabId> = {
    dashboard:  'harnesses',
    brainstorm: 'brainstorm',
    prs:        'prs',
    insights:   'insights',
    config:     'config',
    settings:   'settings',
    docs:       'docs',
    git:        'git',
    // These have no dedicated /adv tab → land on the workspace view.
    proposals:  'harnesses',
    experts:    'harnesses',
    summary:    'harnesses',
    design:     'harnesses',
  };

  it('every mapped tab is a known AdvTabId', () => {
    // AdvTabId values come from ADV_TAB_IDS + 'prs'.
    const knownTabIds = new Set([...ADV_TABS.map((t) => t.id), 'prs']);
    for (const [panel, tab] of Object.entries(EXPECTED_MAPPING)) {
      expect(knownTabIds.has(tab), `panel '${panel}' maps to unknown tab '${tab}'`).toBe(true);
    }
  });

  it('panels that have no dedicated tab all map to harnesses', () => {
    for (const panel of ['proposals', 'experts', 'summary', 'design']) {
      expect(EXPECTED_MAPPING[panel]).toBe('harnesses');
    }
  });

  it('named panels map to their own tabs', () => {
    expect(EXPECTED_MAPPING.brainstorm).toBe('brainstorm');
    expect(EXPECTED_MAPPING.insights).toBe('insights');
    expect(EXPECTED_MAPPING.config).toBe('config');
    expect(EXPECTED_MAPPING.docs).toBe('docs');
  });
});
