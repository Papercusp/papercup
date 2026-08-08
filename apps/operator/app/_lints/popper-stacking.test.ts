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

/**
 * Extract the VALUE EXPRESSION of every `zIndex:` property — everything from
 * just after the colon to the end of that property (the next `,` or closing
 * brace at nesting depth 0, or end of line).
 *
 * WHY NOT `/zIndex:\s*(\d+)/` — the regex this replaced (EI-19470132622399873):
 * it required a DIGIT immediately after the colon, so it silently skipped every
 * non-literal value. `harness/Popover.tsx` shipped `zIndex: zIndex ?? 90` — the
 * 90 default that re-created the whole bug this file exists to prevent — and the
 * lint matched nothing in it, so the file read as fully compliant. A scanner
 * that cannot see the defective shape is the same failure this file's own header
 * warns about ("a test that cannot fail on the defect is worse than no test").
 *
 * Scanning the whole expression rather than a literal is also what keeps the
 * check honest for `?? N`, `|| N` and ternaries, which are the natural ways a
 * shared primitive grows a default.
 */
function zIndexExpressions(src: string): Array<{ expr: string; index: number }> {
  const out: Array<{ expr: string; index: number }> = []
  for (const m of src.matchAll(/\bzIndex:/g)) {
    const start = (m.index ?? 0) + m[0].length
    let depth = 0
    let end = start
    while (end < src.length) {
      const ch = src[end]
      if (ch === '(' || ch === '[' || ch === '{') depth++
      else if (ch === ')' || ch === ']' || ch === '}') {
        if (depth === 0) break
        depth--
      } else if ((ch === ',' && depth === 0) || ch === '\n') break
      end++
    }
    out.push({ expr: src.slice(start, end).trim(), index: m.index ?? 0 })
  }
  return out
}

/**
 * Symbols that ARE the floor. An expression built from these is safe by
 * construction and needs no numeric literal to prove it.
 *
 * `usePopperZ` / `popperFloorZ` are the LIVE floor (WI-35969): the shell floor
 * normally, one step above the topmost open modal when one is up. `TOOLTIP_FLOOR_Z`
 * is a static floor asserted above the whole modal band further down.
 */
const FLOOR_SYMBOLS = /\b(POPPER_WRAPPER_FLOOR_Z|TOOLTIP_FLOOR_Z|clampPopperZ|popperFloorZ|usePopperZ)\b/

/**
 * Names bound IN THIS FILE to a floor-derived expression, e.g.
 * `const popperZ = usePopperZ(zIndex)`.
 *
 * Needed because the live floor cannot be written inline: it comes from a HOOK,
 * and a hook cannot be called inside an object literal. Without this the
 * scanner would call `zIndex: popperZ` "undecidable" and fail correct code —
 * and a lint that cries wolf gets suppressed, which is how the real case stops
 * being caught (this file's own header says so).
 *
 * Deliberately ONE level of indirection, not a general resolver: the point is to
 * see through the hook idiom, not to become a type checker. Anything deeper
 * still reports `undecidable`, which is the honest answer.
 */
function localFloorNames(src: string, symbols: RegExp = FLOOR_SYMBOLS): Set<string> {
  const names = new Set<string>()
  for (const m of src.matchAll(/\bconst\s+([A-Za-z_$][\w$]*)\s*=\s*([^;\n]+)/g)) {
    if (symbols.test(m[2])) names.add(m[1])
  }
  return names
}

/**
 * The MODAL band's equivalents. Separate from FLOOR_SYMBOLS on purpose: a popper
 * Content built from a modal constant would be a category error even though the
 * number happens to be high enough.
 */
const MODAL_FLOOR_SYMBOLS = /\b(MODAL_FLOOR_Z|MODAL_CEILING_Z|clampModalZ|nextModalZ)\b/

/**
 * A `zIndex: number` inside an interface is a TYPE, not a value. `zIndex?:` is
 * already excluded by the `zIndex:` match (the `?` breaks it), but the
 * non-optional form is not.
 */
const TYPE_ANNOTATION = /^(number|string|any|unknown)(\s*\|\s*(number|undefined|null))*$/

/**
 * The verdict for one `zIndex:` expression. Deliberately THREE outcomes, not a
 * boolean: "I cannot evaluate this" is a distinct answer from "this is fine",
 * and collapsing the two is what the old literal-only regex effectively did.
 */
function verdictFor(
  expr: string,
  floor: number,
  localFloors: Set<string> = new Set(),
  floorSymbols: RegExp = FLOOR_SYMBOLS,
): { kind: 'skip' } | { kind: 'ok' } | { kind: 'below-floor'; tooLow: number[] } | { kind: 'undecidable' } {
  if (!expr || TYPE_ANNOTATION.test(expr)) return { kind: 'skip' }
  const viaLocal =
    localFloors.size > 0 && new RegExp(`\\b(${[...localFloors].join('|')})\\b`).test(expr)
  // ARITHMETIC ON A FLOOR-DERIVED BASE is safe and must not be read as a raw
  // z-index: `z + 1` is how harness/Modal offsets its centring wrap above its
  // own overlay, and reporting that `1` as "below the floor" is the cry-wolf
  // failure this file's header warns about. A ternary is NOT arithmetic — it can
  // select the literal instead of adding it — so it stays scanned.
  if (viaLocal && !expr.includes('?')) return { kind: 'ok' }
  const literals = [...expr.matchAll(/\b(\d+)\b/g)].map((n) => Number(n[1]))
  const tooLow = literals.filter((z) => z < floor)
  if (tooLow.length) return { kind: 'below-floor', tooLow }
  if (literals.length === 0 && !floorSymbols.test(expr) && !viaLocal) return { kind: 'undecidable' }
  return { kind: 'ok' }
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

  /**
   * The CSS rule above is only the FLOOR, and on its own it is not enough —
   * this is the second half of the bug, found by live measurement after the
   * first fix silently did nothing.
   *
   * Radix's Popper reads the Content's computed z-index at mount and copies it
   * onto the wrapper as an INLINE style. Inline beats a stylesheet rule without
   * `!important`, so a component that sets a LOW z-index on its Content
   * actively overrides the floor and re-creates the bug. harness/Select.tsx set
   * 70, which tied with `<main>`; the CSS rule said 1500 and was ignored.
   */
  it('never lets a popper Content set a z-index below the wrapper floor', () => {
    const wrapperZ = Math.max(...wrapperRules.map((r) => r.z))

    // Scope: the SHARED Radix primitives in app/harness only. Those are the
    // files that render a `*.Content` with `position="popper"`, i.e. the ones
    // whose z-index Radix actually copies onto the wrapper.
    //
    // Deliberately NOT every file containing `zIndex`. An earlier draft scanned
    // app/_components too and flagged SessionChatModal's internal zone panels
    // (5, 6) and GlobalSearchDialog's dialog surface (1000) — none of which are
    // popper Contents. Those are ordinary in-page layering and raising them
    // would be wrong. A lint that cries wolf on correct code gets suppressed,
    // and then it is not there for the real case.
    const harnessDir = join(APP_DIR, 'harness')
    const tsFiles = readdirSync(harnessDir)
      .filter((e) => /\.tsx$/.test(e) && !/\.test\.tsx$/.test(e))
      .map((e) => join(harnessDir, e))

    // Only these Radix families are POPPER-positioned, i.e. actually get a
    // `[data-radix-popper-content-wrapper]`. Dialog/AlertDialog deliberately
    // excluded: their Content is centred by the overlay, never wrapped in a
    // popper, so their z-index is ordinary modal layering. A structural
    // heuristic (".Portal is present") cannot tell them apart and flagged
    // harness/Modal.tsx's overlay/content pair (60, 61) as popper bugs.
    const POPPER_PACKAGES =
      /@radix-ui\/react-(select|popover|tooltip|dropdown-menu|context-menu|hover-card|menubar|navigation-menu)/

    const bad: string[] = []
    const undecidable: string[] = []
    for (const f of tsFiles) {
      const src = readFileSync(f, 'utf8')
      if (!POPPER_PACKAGES.test(src) || !/\.Content\b/.test(src)) continue
      const localFloors = localFloorNames(src)
      for (const { expr, index } of zIndexExpressions(src)) {
        const v = verdictFor(expr, wrapperZ, localFloors)
        if (v.kind === 'skip' || v.kind === 'ok') continue
        const line = src.slice(0, index).split('\n').length
        if (v.kind === 'below-floor') {
          bad.push(`  ${f}:${line}  zIndex: ${expr}   -> ${v.tooLow.join(', ')} < floor ${wrapperZ}`)
        } else {
          // Not a pass. The value is decided somewhere this scanner cannot see,
          // and silently skipping it is exactly the blind spot that let
          // `zIndex ?? 90` ship. Make the author state the floor explicitly.
          undecidable.push(`  ${f}:${line}  zIndex: ${expr}`)
        }
      }
    }

    expect(
      bad,
      'A Radix popper Content sets a z-index BELOW the wrapper floor. Radix copies ' +
        'that value onto [data-radix-popper-content-wrapper] as an inline style, which ' +
        'overrides the CSS floor — so the menu paints behind the app shell and becomes ' +
        'unclickable:\n' +
        bad.join('\n'),
    ).toEqual([])

    expect(
      undecidable,
      'A Radix popper Content sets a z-index this lint cannot evaluate, so it cannot ' +
        'prove the menu clears the app shell. Build the value from the shared floor ' +
        '(`clampPopperZ(...)` or `POPPER_WRAPPER_FLOOR_Z` from harness/popper-z.ts) ' +
        'so it is correct by construction:\n' +
        undecidable.join('\n'),
    ).toEqual([])
  })

  /**
   * FALSIFIABILITY CONTROL — the scanner run against inputs whose correct
   * verdict is known, kept permanently rather than proven once by mutating the
   * tree (the shared checkout is swept into commits every few minutes, so an
   * in-tree mutation probe can be committed by the sweep).
   *
   * The first case is the LITERAL shape that shipped undetected. Without it,
   * "the lint passes" is equally consistent with "the lint sees nothing", which
   * is precisely the state this file was in before EI-19470132622399873.
   */
  it('CONTROL: flags the defect shapes and clears the correct ones', () => {
    const floor = 1500

    // The exact expression that shipped in harness/Popover.tsx and was invisible
    // to the previous `/zIndex:\s*(\d+)/` scan.
    const shipped = zIndexExpressions('const s = { zIndex: zIndex ?? 90, top: 4 }')
    expect(shipped.map((e) => e.expr)).toEqual(['zIndex ?? 90'])
    expect(verdictFor(shipped[0].expr, floor)).toEqual({ kind: 'below-floor', tooLow: [90] })

    // Other natural ways a default grows.
    expect(verdictFor('zIndex || 70', floor).kind).toBe('below-floor')
    expect(verdictFor('big ? 1600 : 200', floor).kind).toBe('below-floor')

    // Correct by construction — must NOT be flagged, or the lint cries wolf and
    // gets suppressed, and then it is not there for the real case.
    expect(verdictFor('POPPER_WRAPPER_FLOOR_Z', floor).kind).toBe('ok')
    expect(verdictFor('clampPopperZ(zIndex)', floor).kind).toBe('ok')
    expect(verdictFor('1500', floor).kind).toBe('ok')
    expect(verdictFor('1600', floor).kind).toBe('ok')

    // A type annotation is not a value.
    expect(verdictFor('number', floor).kind).toBe('skip')

    // Undecidable is its own answer, never a silent pass.
    expect(verdictFor('someImportedValue', floor).kind).toBe('undecidable')

    // ── local-const resolution (WI-35969) ──────────────────────────────────
    // The live floor arrives through a hook, so the value reaching `zIndex:` is
    // a local binding. Seeing through exactly one level is what keeps correct
    // code from being reported as undecidable.
    const hookFile = 'const popperZ = usePopperZ(zIndex);\nconst s = { zIndex: popperZ };'
    const hookLocals = localFloorNames(hookFile)
    expect([...hookLocals]).toEqual(['popperZ'])
    expect(verdictFor('popperZ', floor, hookLocals).kind).toBe('ok')

    // …and it must NOT launder an arbitrary local. A binding that is not
    // floor-derived stays undecidable, or the widening would be a hole rather
    // than a resolution.
    const unrelated = localFloorNames('const popperZ = someOtherThing;')
    expect([...unrelated]).toEqual([])
    expect(verdictFor('popperZ', floor, unrelated).kind).toBe('undecidable')

    // A below-floor literal still loses even when a floor-derived local is in
    // scope — the literal is what Radix would copy.
    expect(verdictFor('90', floor, hookLocals).kind).toBe('below-floor')

    // ── arithmetic on a floor-derived base (WI-35969) ──────────────────────
    // harness/Modal offsets its centring wrap one above its own overlay. The
    // `1` is an offset, not a z-index, and flagging it is a false positive —
    // this case was found by the lint firing on the real fix.
    const modalLocals = localFloorNames('const z = clampModalZ(x);', MODAL_FLOOR_SYMBOLS)
    expect([...modalLocals]).toEqual(['z'])
    expect(verdictFor('z + 1', 2000, modalLocals, MODAL_FLOOR_SYMBOLS).kind).toBe('ok')
    expect(verdictFor('z', 2000, modalLocals, MODAL_FLOOR_SYMBOLS).kind).toBe('ok')
    // …but a ternary can SELECT a bad literal rather than add to it, so the
    // relaxation must not cover it.
    expect(verdictFor('big ? z : 60', 2000, modalLocals, MODAL_FLOOR_SYMBOLS).kind).toBe('below-floor')
    // The shape that shipped, checked against the MODAL floor.
    expect(verdictFor('zIndex ?? 100', 2000, modalLocals, MODAL_FLOOR_SYMBOLS)).toEqual({
      kind: 'below-floor',
      tooLow: [100],
    })

    // The extractor must stop at the property boundary: a sibling property's
    // small number is NOT this property's z-index.
    const sibling = zIndexExpressions('{ zIndex: 1500, marginTop: 4 }')
    expect(sibling.map((e) => e.expr)).toEqual(['1500'])
    expect(verdictFor(sibling[0].expr, floor).kind).toBe('ok')
  })

  /**
   * The floor exists in two places that CANNOT see each other: the CSS rule and
   * the TS constant components build their inline value from. Radix copies the
   * inline one over the CSS one, so if they drift the stylesheet silently stops
   * being the floor it claims to be.
   */
  /**
   * THE SECOND HALF OF THE ORDERING, added by WI-35969.
   *
   * The rule above only says "a popper must clear the shell". Satisfying it in
   * isolation is what produced the owner-reported bug: the popper floor was
   * raised to 1500 while `harness/Modal` still defaulted to 100 — a number
   * chosen when the tallest thing to clear was the OracleDock at 80 — so every
   * modal opened FROM a dropdown was painted UNDER that dropdown. Measured in
   * the live desktop: the agents-running pill's conversation modal at 100/101
   * beneath a popover at 1500, overlapping on the modal's header and its newest
   * turns, which reads as "the conversation never loaded".
   *
   * A static pair of floors cannot express both directions — see the
   * `popperFloorZ` docblock — so the ORDER of the constants is what is asserted
   * here, and the dynamic part is proven by arithmetic in harness/popper-z.test.ts.
   */
  const popperZSrc = readFileSync(join(APP_DIR, 'harness', 'popper-z.ts'), 'utf8')
  const constant = (name: string): number => {
    const m = popperZSrc.match(new RegExp(`${name}\\s*=\\s*(\\d+)`))
    expect(m, `harness/popper-z.ts must export a numeric ${name}`).toBeTruthy()
    return Number(m![1])
  }

  it('stacks the modal band above the popper floor, and tooltips above the band', () => {
    const wrapperZ = Math.max(...wrapperRules.map((r) => r.z))
    const modalFloor = constant('MODAL_FLOOR_Z')
    const modalCeiling = constant('MODAL_CEILING_Z')
    const tooltipFloor = constant('TOOLTIP_FLOOR_Z')

    expect(
      modalFloor,
      `MODAL_FLOOR_Z (${modalFloor}) must exceed the popper wrapper floor (${wrapperZ}), or a ` +
        `modal opened FROM a dropdown is painted behind it (WI-35969).`,
    ).toBeGreaterThan(wrapperZ)

    expect(modalCeiling).toBeGreaterThanOrEqual(modalFloor)

    expect(
      tooltipFloor,
      `TOOLTIP_FLOOR_Z (${tooltipFloor}) is STATIC, so it must clear the DEEPEST a modal can ` +
        `reach (MODAL_CEILING_Z ${modalCeiling}) — not merely the floor — or a tooltip on a ` +
        `control inside a nested modal is buried.`,
    ).toBeGreaterThan(modalCeiling)
  })

  it('keeps every CSS layer that must cover a modal above the modal band', () => {
    const modalCeiling = constant('MODAL_CEILING_Z')

    // These deliberately paint OVER a modal: a route change should curtain it,
    // and a toast fired from inside a modal must stay readable. If the modal
    // band is raised past them they silently stop working, which is invisible
    // until someone hits it.
    const MUST_OUTRANK_MODALS = /\.pc-route-loading-overlay|\.pc-route-pending-overlay|data-sonner-toaster/

    const covering = rules.filter((r) => MUST_OUTRANK_MODALS.test(r.selector))
    expect(
      covering.length,
      'Expected to find the route overlays / toaster z-index rules; if they were renamed, ' +
        'update MUST_OUTRANK_MODALS rather than deleting this check.',
    ).toBeGreaterThan(0)

    const swallowed = covering.filter((r) => r.z <= modalCeiling)
    expect(
      swallowed,
      `These layers are meant to cover a modal but stack at or below the modal ceiling ` +
        `(${modalCeiling}):\n` + swallowed.map((o) => `  ${o.z}  ${o.selector}   (${o.file})`).join('\n'),
    ).toEqual([])
  })

  it('never lets harness/Modal hard-code a z-index below the modal floor', () => {
    // The defect was a LITERAL (`zIndex ?? 100`), so scan for one directly
    // rather than trusting that the constants above are actually consumed.
    const modalFloor = constant('MODAL_FLOOR_Z')
    const src = readFileSync(join(APP_DIR, 'harness', 'Modal.tsx'), 'utf8')
    const locals = localFloorNames(src, MODAL_FLOOR_SYMBOLS)
    const offenders = zIndexExpressions(src)
      .map(({ expr, index }) => ({
        expr,
        line: src.slice(0, index).split('\n').length,
        v: verdictFor(expr, modalFloor, locals, MODAL_FLOOR_SYMBOLS),
      }))
      .filter(({ v }) => v.kind === 'below-floor')
      .map(({ expr, line }) => ({ expr, line }))
    expect(
      offenders,
      `harness/Modal.tsx sets a z-index below MODAL_FLOOR_Z (${modalFloor}). A modal under the ` +
        `popper floor is painted behind the dropdown that opened it — build the value from ` +
        `clampModalZ()/nextModalZ() in harness/popper-z.ts:\n` +
        offenders.map((o) => `  Modal.tsx:${o.line}  zIndex: ${o.expr}`).join('\n'),
    ).toEqual([])
  })

  it('keeps the TS floor constant in sync with the CSS floor', () => {
    const wrapperZ = Math.max(...wrapperRules.map((r) => r.z))
    const src = readFileSync(join(APP_DIR, 'harness', 'popper-z.ts'), 'utf8')
    const m = src.match(/POPPER_WRAPPER_FLOOR_Z\s*=\s*(\d+)/)
    expect(m, 'harness/popper-z.ts must export a numeric POPPER_WRAPPER_FLOOR_Z').toBeTruthy()
    expect(
      Number(m![1]),
      `harness/popper-z.ts sets the floor to ${m?.[1]} but the CSS rule on ` +
        `[data-radix-popper-content-wrapper] is ${wrapperZ}. Change BOTH.`,
    ).toBe(wrapperZ)
  })
})
