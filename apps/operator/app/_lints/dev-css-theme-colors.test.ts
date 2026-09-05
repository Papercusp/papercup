/**
 * Carried-stylesheet theme-color guard (portal-parity-with-papercusp-2026-09-03 P-013,
 * EI-22432712291442636).
 *
 * The stylesheets packages/operator-ui/src/surfaces/index.tsx imports travel into hosts
 * that run the LIGHT theme (the cloud portal). A hardcoded near-white `color:` literal
 * in one of them — written for the operator's dark shell — renders as pale-on-pale
 * there: MEASURED 2026-09-05 on :3081, DEV's nav labels computed rgb(234,248,255) on a
 * light ground (dev.css .pc-dev-tab #d8e5ef, .is-active #eaf8ff, the SQL role select
 * #edf6ff, the required-tool name #eaf8ff). Text colour in a carried stylesheet must
 * come from the semantic vocabulary (`var(--fg)`, `var(--fg-dim)`, `var(--accent-strong)`…),
 * which the portal bridges to its own light/dark tokens; the literal may remain only as
 * the `var(--x, #literal)` fallback.
 *
 * The one legitimate literal is text on a surface the same rule paints opaque (white
 * on a red destructive button), which is exempted by construction below.
 */
import { readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import postcss from 'postcss';
import { describe, expect, it } from 'vitest';

const OPERATOR_ROOT = resolve(__dirname, '../..');
const REPO_ROOT = resolve(OPERATOR_ROOT, '../..');
const SURFACES_INDEX = resolve(REPO_ROOT, 'packages/operator-ui/src/surfaces/index.tsx');

/** Relative luminance of a #rgb/#rrggbb literal (WCAG). */
export function hexLuminance(hex: string): number {
  let h = hex.replace('#', '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const [r, g, b] = [0, 2, 4]
    .map((i) => parseInt(h.slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

/** Near-white: unreadable as TEXT on a light ground. #cbd5e1 (0.66) passes, #d8e5ef (0.77) does not. */
const NEAR_WHITE = 0.7;

export function nearWhiteTextLiterals(cssPath: string): string[] {
  const root = postcss.parse(readFileSync(cssPath, 'utf8'), { from: cssPath });
  const hits: string[] = [];
  root.walkRules((rule) => {
    const paintsOwnSurface = rule.nodes.some(
      (n) => n.type === 'decl' && /^background(-color)?$/.test(n.prop) && !/transparent|^none$/.test(n.value),
    );
    for (const decl of rule.nodes) {
      if (decl.type !== 'decl' || decl.prop !== 'color') continue;
      const m = decl.value.trim().match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
      if (!m || hexLuminance(m[0]) < NEAR_WHITE || paintsOwnSurface) continue;
      hits.push(`${relative(REPO_ROOT, cssPath)}:${decl.source?.start?.line} ${rule.selector.replace(/\s+/g, ' ').slice(0, 60)} { color: ${decl.value} }`);
    }
  });
  return hits;
}

/**
 * SHRINK-ONLY baseline: the pre-existing literals in harness.css (the /adv Work/HUD
 * family, outside the portal-parity plan's scope) measured when this guard landed.
 * Keyed by file + selector, never by line. Tokenize one and delete its entry; a NEW
 * literal anywhere fails. The last test below refuses an entry that no longer matches.
 */
const BASELINE = new Set<string>([
  'apps/operator/app/harness/harness.css .rf-mind-add, .rf-mind-del, .rf-mind-kind-btn',
  'apps/operator/app/harness/harness.css .h-top-collapse-btn:hover',
  'apps/operator/app/harness/harness.css .h-quick-action-btn:hover span, .h-quick-action-btn:focus-vi',
  'apps/operator/app/harness/harness.css .h-inbox-action:hover:not(:disabled), .h-proposal-btn:hover:',
  'apps/operator/app/harness/harness.css .h-hud-node strong, .h-hud-dial-copy strong',
  'apps/operator/app/harness/harness.css .h-root .h-stats > :first-child .h-stat-label, .h-root .h-st',
  'apps/operator/app/harness/harness.css .h-root .h-status-chip.idle',
  'apps/operator/app/harness/harness.css .h-root .h-header-actions > .h-btn.ghost:nth-last-child(2)',
  'apps/operator/app/harness/harness.css .h-root .h-header-actions > .h-btn.ghost:last-child',
  'apps/operator/app/harness/harness.css .h-root .h-stats .h-save-template-btn',
  'apps/operator/app/harness/harness.css .h-root .h-stats .h-save-snapshot-btn',
]);
const baselineKey = (hit: string) => hit.replace(/:\d+ /, ' ').replace(/ \{ color: .*$/, '');

function carriedStylesheets(): string[] {
  const src = readFileSync(SURFACES_INDEX, 'utf8');
  return [...src.matchAll(/^import\s+'([^']+\.css)';/gm)].map((m) => resolve(dirname(SURFACES_INDEX), m[1]!));
}

describe('carried stylesheets: no hardcoded near-white text colour', () => {
  it('positive control: the detector sees a near-white literal and exempts white-on-painted', () => {
    expect(hexLuminance('#eaf8ff')).toBeGreaterThan(NEAR_WHITE);
    expect(hexLuminance('#cbd5e1')).toBeLessThan(NEAR_WHITE);
    expect(hexLuminance('#202020')).toBeLessThan(0.1);
  });

  it('the surfaces index carries the DEV, Settings, Support and primitives stylesheets', () => {
    const sheets = carriedStylesheets().map((s) => relative(REPO_ROOT, s));
    expect(sheets).toEqual(
      expect.arrayContaining([
        'apps/operator/app/dev/dev.css',
        'apps/operator/app/_primitives.css',
        'apps/operator/app/settings/settings.css',
        'apps/operator/app/support/support.css',
      ]),
    );
  });

  it('every carried stylesheet takes its text colour from the semantic vocabulary (baseline aside)', () => {
    const hits = carriedStylesheets().flatMap(nearWhiteTextLiterals).filter((h) => !BASELINE.has(baselineKey(h)));
    expect(
      hits,
      'write `color: var(--fg, #literal)` (or --fg-dim / --accent-strong / --warn) so a light-theme host stays readable',
    ).toEqual([]);
  });

  it('the baseline is shrink-only: every entry still names a real literal', () => {
    const keys = new Set(carriedStylesheets().flatMap(nearWhiteTextLiterals).map(baselineKey));
    const stale = [...BASELINE].filter((k) => !keys.has(k));
    expect(stale, 'tokenized — delete the entry').toEqual([]);
  });
});
