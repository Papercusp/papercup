/**
 * Bottom-panel control-height lint — fails CI if a control in the session
 * popup's bottom panel can drift off the shared height metric.
 *
 * THE BUG THIS EXISTS TO PREVENT (measured 2026-08-02,
 * session-popup-compaction-and-contrast-2026-08-02 P-009; owner-reported as
 * "the bottom panel buttons are all misaligned"):
 *
 * Four control heights had accumulated in one panel — 18px mode pills, 24px
 * action buttons, 29.8px fleet wells, 34px Launch — because each shape's rule
 * decided its own height independently and nothing held them to a common
 * metric. The controls were centred correctly (measured centreSpread: 0.0px on
 * every row), so nothing looked wrong in the CSS; what the eye saw was the
 * BOTTOM edges scattering by up to 10px, because a row of boxes is read on its
 * bottoms. chat-controls.css now defines `--pc-ctl-h` and every control in both
 * bands takes its height from it.
 *
 * WHY A STATIC LINT AND NOT A COMPONENT TEST: jsdom does not lay out. It
 * computes no box model, so a jsdom assertion about a rendered height passes
 * with any of these values present — ChatActionBar.test.tsx has 28 tests and
 * every one stayed green through the whole four-height period. A test that
 * cannot fail on the defect is worse than no test, because it reads as
 * coverage. The honest automated guard at this layer is the INVARIANT: the
 * shared metric exists, every control claims it, and nothing can outrank it.
 *
 * THE SPECIFIC TRAP IN THE THIRD ASSERTION: `min-height` beats `height` in the
 * cascade regardless of source order or specificity. `.pc-ctl-act` legitimately
 * still carries `min-height: 24px` (it predates this metric and is harmless
 * while 24 < 26), but raising any such value above `--pc-ctl-h` would silently
 * win over the shared height and reintroduce exactly this bug — with the shared
 * rule still sitting right there, looking correct.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const CSS_PATH = join(__dirname, '..', '_components', 'chat', 'chat-controls.css')
const css = readFileSync(CSS_PATH, 'utf8')

/** Strip comments so prose about a value never counts as a declaration. */
const code = css.replace(/\/\*[\s\S]*?\*\//g, '')

/** Every control that shares the bottom panel's rows and must share its height. */
const CONTROLS = [
  '.pc-ctl-mode',
  '.pc-ctl-act',
  '.pc-ctl-field__well',
  '.pc-fleet-strip__submit',
]

describe('session popup bottom panel — one control height', () => {
  it('defines the shared --pc-ctl-h metric', () => {
    expect(code).toMatch(/--pc-ctl-h:\s*\d+(\.\d+)?px/)
  })

  it('gives every bottom-panel control its height from the shared metric', () => {
    // The single rule that sets `height: var(--pc-ctl-h)` must list them all.
    const shared = code.match(/([^}]*)\{[^}]*height:\s*var\(--pc-ctl-h\)[^}]*\}/)
    expect(shared, 'no rule sets height: var(--pc-ctl-h)').toBeTruthy()
    const selectors = shared![1]
    const missing = CONTROLS.filter((c) => !selectors.includes(c))
    expect(missing, `these controls do not take the shared height: ${missing.join(', ')}`).toEqual(
      [],
    )
  })

  it('never lets a min-height outrank the shared height', () => {
    const metric = code.match(/--pc-ctl-h:\s*(\d+(?:\.\d+)?)px/)
    expect(metric).toBeTruthy()
    const shared = Number(metric![1])

    // Any min-height declared anywhere in this file, with the rule it sits in.
    const offenders: string[] = []
    for (const block of code.matchAll(/([^{}]*)\{([^}]*)\}/g)) {
      const [, selectors, body] = block
      const minH = body.match(/min-height:\s*(\d+(?:\.\d+)?)px/)
      if (!minH) continue
      if (Number(minH[1]) <= shared) continue
      if (!CONTROLS.some((c) => selectors.includes(c))) continue
      offenders.push(`${selectors.trim().replace(/\s+/g, ' ')} -> min-height: ${minH[1]}px`)
    }
    expect(
      offenders,
      `min-height beats height in the cascade, so these silently override --pc-ctl-h (${shared}px): ${offenders.join(' | ')}`,
    ).toEqual([])
  })
})
