/**
 * Popper-stacking lint — fails CI if a body-portaled Radix popper can be
 * painted UNDER the app shell.
 *
 * THE BUG THIS EXISTS TO PREVENT (measured 2026-08-02,
 * session-popup-compaction-and-contrast-2026-08-02 P-006; owner-reported as
 * "None of the option selector dropdowns are working in the bottom panel"):
 *
 * Radix wraps popper Content in `[data-radix-popper-content-wrapper]`, which is
 * `position: fixed`. A fixed element ALWAYS establishes its own stacking
 * context, so a `z-index` set on the *Content* (harness/Select.tsx's
 * CONTENT_STYLE sets 70) only orders things INSIDE the wrapper — the wrapper
 * itself joins the ROOT stacking context at `z-index: auto`, i.e. 0.
 *
 * Meanwhile the harness shell promotes `<main>` to 70 and the floating Oracle
 * controls to 80. Net effect: every portaled menu rendered BEHIND the entire
 * app. It mounted, positioned correctly, reported `opacity: 1` and
 * `pointer-events: auto` — and `document.elementFromPoint()` at its own centre
 * returned the chat placeholder sitting above it. From the user's side, menus
 * simply "did nothing".
 *
 * WHY THIS IS A STATIC LINT AND NOT A COMPONENT TEST: jsdom does not paint. It
 * has no stacking contexts and no hit-testing, so a jsdom test asserting "the
 * menu opens" passes with the bug fully present — ChatActionBar.test.tsx has 28
 * such tests and all 28 stayed green throughout. A test that cannot fail on the
 * defect is worse than no test, because it is read as coverage. The only honest
 * automated guard at this layer is the ordering INVARIANT itself: whatever
 * z-index the shell claims, the popper wrapper must beat it.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const APP_DIR = join(__dirname, '..')

function cssFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry.startsWith('.')) continue
    const p = join(dir, entry)
    const st = statSync(p)
    if (st.isDirectory()) cssFiles(p, out)
    else if (entry.endsWith('.css')) out.push(p)
  }
  return out
}

/** Strip comments so a z-index mentioned in prose is never parsed as a rule. */
function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '')
}

/**
 * Collect `selector { ... z-index: N ... }` pairs. Deliberately a coarse
 * block-scanner rather than a full CSS parse: it only has to find integer
 * z-index declarations, and being approximate in the SAFE direction (seeing
 * extra candidate selectors) cannot produce a false pass.
 */
function zIndexRules(css: string): Array<{ selector: string; z: number }> {
  const out: Array<{ selector: string; z: number }> = []
  const blocks = stripComments(css).matchAll(/([^{}]+)\{([^{}]*)\}/g)
  for (const b of blocks) {
    const selector = b[1].trim().replace(/\s+/g, ' ')
    const m = b[2].match(/(?:^|[;\s])z-index:\s*(-?\d+)/)
    if (m) out.push({ selector, z: Number(m[1]) })
  }
  return out
}

describe('popper stacking', () => {
  const all = cssFiles(APP_DIR).map((f) => ({ file: f, css: readFileSync(f, 'utf8') }))
  const rules = all.flatMap(({ file, css }) => zIndexRules(css).map((r) => ({ ...r, file })))

  const wrapperRules = rules.filter((r) => r.selector.includes('[data-radix-popper-content-wrapper]'))

  it('gives the Radix popper wrapper an explicit z-index', () => {
    // Without this the wrapper is `z-index: auto` (== 0) and loses to any
    // promoted shell layer, however high the Content's own z-index is.
    expect(
      wrapperRules.length,
      'No CSS rule sets a z-index on [data-radix-popper-content-wrapper]. ' +
        'Setting zIndex on the Radix Content does NOT work: the wrapper is ' +
        'position:fixed and makes its own stacking context.',
    ).toBeGreaterThan(0)
  })

  it('stacks the popper wrapper above every shell layer that could cover it', () => {
    const wrapperZ = Math.max(...wrapperRules.map((r) => r.z))

    // Anything that paints the app shell itself and could therefore sit over a
    // body-portaled menu. Modal/dialog surfaces are excluded on purpose: a menu
    // opened FROM a dialog is portaled to body and must clear it too, but a
    // dialog is expected to sit above ordinary page content.
    const shell = rules.filter(
      (r) =>
        !r.selector.includes('[data-radix-popper-content-wrapper]') &&
        /(^|[\s,>+~])main(\s|$|[,.:[])|\.oracle-dock|\.oracle-fab|\.h-root|\.h-shell/.test(r.selector),
    )

    const offenders = shell.filter((r) => r.z >= wrapperZ)
    expect(
      offenders,
      `These shell layers stack at or above the popper wrapper (${wrapperZ}), so a ` +
        `portaled menu can be painted behind them and become unclickable:\n` +
        offenders.map((o) => `  ${o.z}  ${o.selector}   (${o.file})`).join('\n'),
    ).toEqual([])
  })
})
