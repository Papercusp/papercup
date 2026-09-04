import { describe, expect, it } from 'vitest';
import {
  filterInitialModulePreloadDependencies,
  isNonCriticalLazyAsset,
  stripNonCriticalLazyStylesheetsFromInitialHtml,
} from '../../build-preload-policy';

const NON_CRITICAL_ASSETS = [
  'assets/InboxPane-a1b2c3d4.js',
  'assets/PlanDetail-01234567.js?direct',
  'assets/WorkItemDiscussion-89abcdef.css',
  'assets/triggers-00112233.css',
  'assets/review-report-44556677.css',
  'assets/plan-cleanup-report-8899aabb.css',
  'assets/inbox-bulk-ccddeeff.css',
  'assets/inbox-bulk-report-fedcba98.css',
  'assets/BulkResolverStrip-76543210.css',
  'assets/SessionsRosterView-abcdef01.css#asset',
];

describe('operator-vite initial preload policy', () => {
  it('recognizes every explicitly deferred route and pane asset', () => {
    for (const asset of NON_CRITICAL_ASSETS) {
      expect(isNonCriticalLazyAsset(asset), asset).toBe(true);
    }

    expect(isNonCriticalLazyAsset('assets/InboxPane.css')).toBe(false);
    // PlansPane is imported by the focused /plans entry and its CSS is required
    // to establish the scroll viewport that makes its existing virtualizer
    // effective. Removing this stylesheet from index.html leaves every row
    // mounted on a cold direct entry (WI-2144580).
    expect(isNonCriticalLazyAsset('assets/PlansPane-deadbeef.css')).toBe(false);
    expect(isNonCriticalLazyAsset('assets/InboxPaneExtra-a1b2c3d4.css')).toBe(false);
    expect(isNonCriticalLazyAsset('assets/index-a1b2c3d4.css')).toBe(false);
  });

  it('filters only the named chunks from the initial modulepreload dependency list', () => {
    const critical = ['assets/react-a1b2c3d4.js', 'assets/index-11223344.css'];

    expect(filterInitialModulePreloadDependencies([...critical, ...NON_CRITICAL_ASSETS])).toEqual(critical);
  });

  it('removes only matching stylesheet links after Vite injects entry CSS', () => {
    const html = `<!doctype html>
<html>
  <head>
    <link rel="modulepreload" crossorigin href="/assets/InboxPane-a1b2c3d4.js">
    <link rel="stylesheet" crossorigin href="/assets/InboxPane-a1b2c3d4.css">
    <link rel=stylesheet href=/assets/SessionsRosterView-abcdef01.css>
    <link rel="stylesheet" href="/assets/index-11223344.css">
  </head>
</html>`;

    expect(stripNonCriticalLazyStylesheetsFromInitialHtml(html)).toBe(`<!doctype html>
<html>
  <head>
    <link rel="modulepreload" crossorigin href="/assets/InboxPane-a1b2c3d4.js">
    <link rel="stylesheet" href="/assets/index-11223344.css">
  </head>
</html>`);
  });
});
