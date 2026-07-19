// Guard: the two HTTP boundaries that serve getHarnessStatusFull must NOT ship its
// heavy `features` array over the wire.
//
// THE CLASS THIS LOCKS (whole-app-sync-payload-audit-2026-07-19 P-008): getHarnessStatusFull
// returns a dashboard snapshot whose `features` array was measured at 20.6MB (20,228 rows,
// 2.2s to serialize) on `/harness/:slug/status`. NO live consumer renders that array — the
// desktop route's only reader is the RETIRED apps-web HarnessDashboard, and the device UI
// works off the aggregate `counts` (its slim list route proves it). P-001 already retired the
// sync-resolver path for exactly this reason and deferred the two remaining HTTP routes here.
//
// The fix threads `includeFeatures:false` from both routes into getHarnessStatusFull, which
// drops the array while always returning `counts`. This test is the detector that keeps it
// dropped: a future edit that removes the flag (or re-adds an unguarded getHarnessStatusFull
// call on these routes) reintroduces the 20MB regression, and nothing else would catch it —
// the no-heavy-io-on-read-path guard covers the sync-resolver registry, not raw GET routes.
//
// Static source assertion (getHarnessStatusFull is fs/PG-backed — not unit-fixturable here),
// mirroring the no-heavy-io-on-read-path guard's read-the-source style.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROUTES = resolve(__dirname);
const HARNESS_CORE = resolve(__dirname, '../../../harness-core.ts');

/** Strip line + block comments so an assertion matches CODE, not prose about it. */
function code(file: string): string {
  return readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');
}

describe('getHarnessStatusFull HTTP routes never ship the 20MB features array (P-008)', () => {
  it('the desktop /harness/:slug/status route passes includeFeatures:false', () => {
    const src = code(resolve(ROUTES, 'status.ts'));
    expect(src).toMatch(/getHarnessStatusFull\s*\(/);
    expect(
      /includeFeatures:\s*false/.test(src),
      'harness/status.ts must call getHarnessStatusFull with { includeFeatures: false } — ' +
        'otherwise it ships the 20.6MB features array (P-008).',
    ).toBe(true);
  });

  it('the device /device/harnesses/:slug route passes includeFeatures:false', () => {
    const src = code(resolve(ROUTES, '../device/harnesses.ts'));
    expect(src).toMatch(/getHarnessStatusFull\s*\(/);
    expect(
      /includeFeatures:\s*false/.test(src),
      'device/harnesses.ts must call getHarnessStatusFull with { includeFeatures: false } — ' +
        'a paired phone must not receive the 20MB features array (P-008).',
    ).toBe(true);
  });

  it('getHarnessStatusFull defaults includeFeatures to true (shared-contract preserved) and gates features on it', () => {
    const src = code(HARNESS_CORE);
    // Default true: any other/future caller keeps the full shape unless it opts out.
    expect(src).toMatch(/includeFeatures\s*=\s*opts\?\.includeFeatures\s*\?\?\s*true/);
    // The returned `features` is conditional on the flag, and `counts` is unconditional.
    expect(src).toMatch(/includeFeatures\s*\?\s*\{\s*features\s*\}\s*:\s*\{\s*\}/);
    expect(src).toMatch(/\bcounts,/);
  });

  it('no getHarnessStatusFull HTTP route omits the flag (every route caller opts out)', () => {
    // Both known HTTP route callers are asserted individually above; this catches a NEW
    // route added under endpoint-route/routes/ that calls getHarnessStatusFull without the
    // opt-out. Walk the two known route files' directory tree for any bare call.
    const routeFiles = [resolve(ROUTES, 'status.ts'), resolve(ROUTES, '../device/harnesses.ts')];
    for (const f of routeFiles) {
      const src = code(f);
      const calls = src.match(/getHarnessStatusFull\s*\([^)]*\)/g) ?? [];
      for (const call of calls) {
        expect(
          /includeFeatures/.test(call) || /includeFeatures:\s*false/.test(src),
          `Bare getHarnessStatusFull call in ${f}: ${call} — pass { includeFeatures: false }.`,
        ).toBe(true);
      }
    }
  });
});
