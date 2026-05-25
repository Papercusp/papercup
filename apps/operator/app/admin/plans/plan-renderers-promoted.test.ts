// @vitest-environment jsdom
/**
 * P-017: Tests for decoratePromotedBlock + buildFeatureSummary.
 *
 * Covers the contract that a status change on a promoted feature is
 * reflected correctly in both the DOM badge (decoratePromotedBlock) and
 * the NowHero summary string (buildFeatureSummary). No browser required —
 * JSDOM provides the DOM surface.
 */
import { describe, expect, it, beforeEach } from 'vitest';
import { buildFeatureSummary, decoratePromotedBlock, type PromotedFeature } from './plan-renderers';

/* ── buildFeatureSummary ─────────────────────────────────────────────── */

describe('buildFeatureSummary', () => {
  it('returns null for empty array', () => {
    expect(buildFeatureSummary([])).toBeNull();
  });

  it('returns "N features" when all are in an unlisted status', () => {
    const features: PromotedFeature[] = [
      { featureId: 'F-001', title: 'a', status: 'deprecated', harnessSlug: 'demo' },
    ];
    expect(buildFeatureSummary(features)).toBe('1 features');
  });

  it('counts todo correctly', () => {
    const features: PromotedFeature[] = [
      { featureId: 'F-001', title: 'a', status: 'todo', harnessSlug: 'demo' },
      { featureId: 'F-002', title: 'b', status: 'todo', harnessSlug: 'demo' },
    ];
    expect(buildFeatureSummary(features)).toBe('2 features: 2 todo');
  });

  it('treats null status as todo', () => {
    const features: PromotedFeature[] = [
      { featureId: 'F-001', title: 'a', status: null, harnessSlug: 'demo' },
    ];
    expect(buildFeatureSummary(features)).toBe('1 features: 1 todo');
  });

  it('merges in_progress + validating into in-flight', () => {
    const features: PromotedFeature[] = [
      { featureId: 'F-001', title: 'a', status: 'in_progress', harnessSlug: 'demo' },
      { featureId: 'F-002', title: 'b', status: 'validating', harnessSlug: 'demo' },
    ];
    expect(buildFeatureSummary(features)).toBe('2 features: 2 in-flight');
  });

  it('produces full breakdown in priority order', () => {
    const features: PromotedFeature[] = [
      { featureId: 'F-001', title: 'a', status: 'in_progress', harnessSlug: 'demo' },
      { featureId: 'F-002', title: 'b', status: 'failing',     harnessSlug: 'demo' },
      { featureId: 'F-003', title: 'c', status: 'passed',      harnessSlug: 'demo' },
      { featureId: 'F-004', title: 'd', status: 'todo',        harnessSlug: 'demo' },
      { featureId: 'F-005', title: 'e', status: 'blocked',     harnessSlug: 'demo' },
    ];
    expect(buildFeatureSummary(features)).toBe(
      '5 features: 1 in-flight · 1 failing · 1 passed · 1 todo · 1 blocked',
    );
  });

  it('reflects a status change — passing vs failing', () => {
    const passing: PromotedFeature[] = [
      { featureId: 'F-001', title: 'x', status: 'passed', harnessSlug: 'demo' },
    ];
    const failing: PromotedFeature[] = [
      { featureId: 'F-001', title: 'x', status: 'failing', harnessSlug: 'demo' },
    ];
    expect(buildFeatureSummary(passing)).toBe('1 features: 1 passed');
    expect(buildFeatureSummary(failing)).toBe('1 features: 1 failing');
  });
});

/* ── decoratePromotedBlock ───────────────────────────────────────────── */

function makeRoot(html: string): HTMLElement {
  const div = document.createElement('div');
  div.innerHTML = html;
  return div;
}

const FEATURE_TODO: PromotedFeature = {
  featureId: 'F-001',
  title: 'First feature',
  status: 'todo',
  harnessSlug: 'demo',
};
const FEATURE_PASSED: PromotedFeature = {
  featureId: 'F-001',
  title: 'First feature',
  status: 'passed',
  harnessSlug: 'demo',
};

describe('decoratePromotedBlock', () => {
  it('does nothing on empty features', () => {
    const root = makeRoot('<h2>Promoted</h2><ul><li>F-001 thing</li></ul>');
    decoratePromotedBlock(root, []);
    expect(root.querySelectorAll('.pc-promoted-badge').length).toBe(0);
  });

  it('does nothing when no ## Promoted heading is present', () => {
    const root = makeRoot('<h2>Items</h2><ul><li>F-001 thing</li></ul>');
    decoratePromotedBlock(root, [FEATURE_TODO]);
    expect(root.querySelectorAll('.pc-promoted-badge').length).toBe(0);
  });

  it('injects a badge for a known feature ID under ## Promoted', () => {
    const root = makeRoot('<h2>Promoted</h2><ul><li>- [ ] F-001 First feature</li></ul>');
    decoratePromotedBlock(root, [FEATURE_TODO]);
    const badges = root.querySelectorAll('.pc-promoted-badge');
    expect(badges.length).toBe(1);
    expect(badges[0].textContent).toBe('todo');
  });

  it('does not inject a badge for an unknown feature ID', () => {
    const root = makeRoot('<h2>Promoted</h2><ul><li>F-999 unknown</li></ul>');
    decoratePromotedBlock(root, [FEATURE_TODO]);
    expect(root.querySelectorAll('.pc-promoted-badge').length).toBe(0);
  });

  it('badge label reflects status — todo → passed on status change', () => {
    const root = makeRoot('<h2>Promoted</h2><ul><li>F-001 something</li></ul>');

    // First render: todo status.
    decoratePromotedBlock(root, [FEATURE_TODO]);
    expect(root.querySelector('.pc-promoted-badge')?.textContent).toBe('todo');

    // Simulate status change: re-call with passing status.
    decoratePromotedBlock(root, [FEATURE_PASSED]);
    const badges = root.querySelectorAll('.pc-promoted-badge');
    expect(badges.length).toBe(1);
    expect(badges[0].textContent).toBe('passed');
  });

  it('clears old badges before re-decorating (idempotent)', () => {
    const root = makeRoot('<h2>Promoted</h2><ul><li>F-001 something</li></ul>');
    decoratePromotedBlock(root, [FEATURE_TODO]);
    decoratePromotedBlock(root, [FEATURE_TODO]);
    expect(root.querySelectorAll('.pc-promoted-badge').length).toBe(1);
  });

  it('badges multiple features in the same block', () => {
    const root = makeRoot(
      '<h2>Promoted</h2><ul><li>F-001 first</li><li>F-002 second</li></ul>',
    );
    const features: PromotedFeature[] = [
      { featureId: 'F-001', title: 'first', status: 'passed',  harnessSlug: 'demo' },
      { featureId: 'F-002', title: 'second', status: 'failing', harnessSlug: 'demo' },
    ];
    decoratePromotedBlock(root, features);
    const badges = Array.from(root.querySelectorAll('.pc-promoted-badge'));
    expect(badges.length).toBe(2);
    expect(badges.map((b) => b.textContent).sort()).toEqual(['failing', 'passed']);
  });

  it('does not badge features in sections before ## Promoted', () => {
    const root = makeRoot(
      '<h2>Items</h2><ul><li>F-001 listed here too</li></ul>' +
      '<h2>Promoted</h2><ul><li>F-001 actual</li></ul>',
    );
    decoratePromotedBlock(root, [FEATURE_TODO]);
    // Only one badge — the one under ## Promoted.
    expect(root.querySelectorAll('.pc-promoted-badge').length).toBe(1);
    // The badge is inside the second <ul>, not the first.
    const badge = root.querySelector('.pc-promoted-badge')!;
    const firstUl = root.querySelectorAll('ul')[0];
    expect(firstUl.contains(badge)).toBe(false);
  });

  it('stops collecting items at the next h2/h3', () => {
    const root = makeRoot(
      '<h2>Promoted</h2><ul><li>F-001 yes</li></ul>' +
      '<h2>Decisions</h2><ul><li>F-001 no</li></ul>',
    );
    decoratePromotedBlock(root, [FEATURE_TODO]);
    expect(root.querySelectorAll('.pc-promoted-badge').length).toBe(1);
    const badge = root.querySelector('.pc-promoted-badge')!;
    const decisionsSection = root.querySelectorAll('ul')[1];
    expect(decisionsSection.contains(badge)).toBe(false);
  });

  it('badge title attribute encodes feature id + title + harnessSlug', () => {
    const root = makeRoot('<h2>Promoted</h2><ul><li>F-001 something</li></ul>');
    decoratePromotedBlock(root, [FEATURE_TODO]);
    const badge = root.querySelector<HTMLElement>('.pc-promoted-badge')!;
    expect(badge.title).toContain('F-001');
    expect(badge.title).toContain('First feature');
    expect(badge.title).toContain('demo');
  });
});
