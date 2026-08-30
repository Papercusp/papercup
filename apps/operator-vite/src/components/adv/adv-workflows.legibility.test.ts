import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The Workflows tab's legibility + control-layout contract.
 *
 * Plan: workflows-tab-one-frame-2026-08-28 (P-007). The one-frame redesign replaced the
 * class names this file used to pin, but NOT the rules — the floors below are carried over
 * verbatim from the sheet's previous guard, because they are what stop a dense surface from
 * drifting into unreadable microcopy one 11px at a time.
 *
 * The two structural pins at the end are here for the same reason: both are repo-wide lints
 * whose failure mode on THIS surface is invisible (a button that silently ignores its layout
 * on the desktop's webview; a tracking declaration that reds the fleet's design gate), so
 * they are also asserted locally, where the diff that would break them lives.
 */

const CSS_PATH = resolve(process.cwd(), 'src/components/adv/adv-workflows.css');
// Comments are stripped BEFORE parsing: the naive rule regex captures everything since the
// previous `}` as the selector, so a documented rule would otherwise read as a selector with
// its own comment glued to the front and match nothing. A guard that silently stops finding
// its subjects is worse than no guard, so this is load-bearing rather than tidiness.
const CSS = readFileSync(CSS_PATH, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const LEDGER_TSX = readFileSync(resolve(process.cwd(), 'src/components/adv/WorkflowsLedger.tsx'), 'utf8');

function selectorsOf(rule: string): string[] {
  return rule.split(',').map((part) => part.trim().replace(/\s+/g, ' ')).filter(Boolean);
}

function rulesFor(selector: string): string[] {
  const rules = [...CSS.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter((match) => selectorsOf(match[1]).includes(selector))
    .map((match) => match[2]);
  expect(rules.length, `missing CSS selector ${selector}`).toBeGreaterThan(0);
  return rules;
}

function expectFontFloor(selector: string, minimum: number): void {
  const sizes = rulesFor(selector)
    .flatMap((rule) => [...rule.matchAll(/font-size:\s*(\d+)px/g)].map((match) => Number(match[1])));
  expect(sizes.length, `${selector} must declare an explicit pixel font size`).toBeGreaterThan(0);
  expect(Math.min(...sizes), `${selector} must be at least ${minimum}px`).toBeGreaterThanOrEqual(minimum);
}

describe('Workflows legibility contract', () => {
  it('never renders text below decorative 11px microcopy', () => {
    const sizes = [...CSS.matchAll(/font-size:\s*(\d+)px/g)].map((match) => Number(match[1]));
    expect(sizes.length).toBeGreaterThan(0);
    expect(sizes.filter((size) => size < 11)).toEqual([]);
  });

  it('keeps essential frame, row, control and inspector copy at 13px or larger', () => {
    const essentialSelectors = [
      '.pc-wf__summary',
      '.pc-wf__lede',
      '.pc-wf__btn',
      '.pc-wf__composer-title',
      '.pc-wf__composer-label',
      '.pc-wf__composer-input',
      '.pc-wf__needs-lead',
      '.pc-wf__needs-msg',
      '.pc-wf__notice',
      '.pc-wf__seg-tab',
      '.pc-wf__facet',
      '.pc-wf__search input',
      '.pc-wf__sort',
      '.pc-wf__empty',
      '.pc-wf__name-text',
      '.pc-wf__num',
      '.pc-wf__chain-text',
      '.pc-wf__insp-desc',
      '.pc-wf__trig-label',
      '.pc-wf__fail-copy',
      '.pc-wf__empty-state p',
      '.pc-wf__loading-copy strong',
    ];
    for (const selector of essentialSelectors) expectFontFloor(selector, 13);
  });

  it('keeps secondary metadata at 12px or larger', () => {
    const metadataSelectors = [
      '.pc-wf__source-name',
      '.pc-wf__source-count',
      '.pc-wf__composer-copy',
      '.pc-wf__btn--sm',
      '.pc-wf__suggest',
      '.pc-wf__facet-n',
      '.pc-wf__chip',
      '.pc-wf__arrow',
      '.pc-wf__arm',
      '.pc-wf__armed-label',
      '.pc-wf__armed',
      '.pc-wf__pill',
      '.pc-wf__insp-meta',
      '.pc-wf__insp-h',
      '.pc-wf__topo-label',
      '.pc-wf__trig-detail',
      '.pc-wf__run-when',
      '.pc-wf__run-what',
      '.pc-wf__run-cost',
      '.pc-wf__more',
      '.pc-wf__loading-copy span',
    ];
    for (const selector of metadataSelectors) expectFontFloor(selector, 12);
  });

  it('gives both panes a definite height budget so neither can render at zero height', () => {
    // Measured in the desktop shell: with only `flex: 1` against a min-height page, the
    // ledger had clientHeight 0 while holding a 199,890px scrollHeight — in the DOM and
    // invisible on screen. A flex chain is not a height; an explicit budget is.
    for (const selector of ['.pc-wf__ledger', '.pc-wf__insp']) {
      const declared = [...CSS.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
        .filter((match) => selectorsOf(match[1]).includes(selector))
        .map((match) => match[2])
        .join('\n');
      expect(declared, `${selector} must declare a min-height`).toMatch(/min-height:/);
      expect(declared, `${selector} must declare a max-height it can scroll inside`).toMatch(/max-height:/);
      expect(declared, `${selector} must scroll inside that budget`).toMatch(/overflow-y:\s*auto/);
    }
    // The other half of the same defect: in the ~980px pane the Armed control sat entirely
    // off-screen. A dense table narrower than its columns must be reachable, not truncated.
    const ledger = [...CSS.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
      .filter((match) => selectorsOf(match[1]).includes('.pc-wf__ledger'))
      .map((match) => match[2])
      .join('\n');
    expect(ledger, '.pc-wf__ledger must scroll horizontally').toMatch(/overflow-x:\s*auto/);
  });

  it('keeps the inspector beside a compact ledger at normal shell width and stacks only when genuinely narrow', () => {
    // The 1600px desktop shell leaves this container about 792px wide after its two rails.
    // A 1000px collapse therefore removed the "persistent" inspector from the first frame.
    expect(CSS).toContain('@container (max-width: 1120px)');
    expect(CSS).toMatch(/@container \(max-width: 1120px\)[\s\S]*?\.pc-wf__table--ledger th:nth-child\(2\)/);
    expect(CSS).toMatch(/@container \(max-width: 1120px\)[\s\S]*?\.pc-wf__kind-facets\s*\{\s*display: none/);
    expect(CSS).toMatch(/@container \(max-width: 1120px\)[\s\S]*?\.pc-wf__kind-select\s*\{\s*display: block/);
    expect(CSS).toMatch(/@container \(max-width: 740px\)[\s\S]*?\.pc-wf__body\s*\{\s*grid-template-columns: minmax\(0, 1fr\)/);
    expect(CSS).not.toContain('@container (max-width: 1000px)');
  });

  it('uses the stronger dim foreground token for secondary production copy', () => {
    const contrastSelectors = [
      '.pc-wf__summary',
      '.pc-wf__lede',
      '.pc-wf__composer-copy',
      '.pc-wf__needs-msg',
      '.pc-wf__chain-text',
      '.pc-wf__num',
      '.pc-wf__insp-desc',
      '.pc-wf__trig-detail',
      '.pc-wf__run-what',
      '.pc-wf__fail-copy',
      '.pc-wf__empty-state p',
      '.pc-wf__loading-copy span',
    ];
    for (const selector of contrastSelectors) {
      expect(rulesFor(selector).join('\n'), `${selector} must use the stronger secondary foreground`).toContain('var(--fg-dim');
    }
  });

  it('overrides the shared Table primitive, whose inline 11px header would sit below the floor', () => {
    // The primitive sets fontSize 11 inline on <th>, and an inline style beats this
    // stylesheet — so the floor has to be reasserted through its own per-column hook.
    const header = LEDGER_TSX.match(/LEDGER_HEADER_STYLE\s*=\s*\{([^}]*)\}/)?.[1] ?? '';
    expect(header, 'LEDGER_HEADER_STYLE must exist in WorkflowsLedger.tsx').not.toEqual('');
    const size = Number(header.match(/fontSize:\s*(\d+)/)?.[1] ?? 0);
    expect(size, 'ledger header must be at least 12px').toBeGreaterThanOrEqual(12);
    expect(header).toContain('--fg-dim');
    // Every column must receive it — a column added without the helper would ship below.
    expect(LEDGER_TSX).toContain('withLegibleStyles(columns)');
  });

  it('never lays out a <button> selector with flex or grid (WebKitGTK ignores it)', () => {
    // The desktop webview drops display:flex on a <button>; the layout lives on the inner
    // span instead. This is also a repo-wide lint, pinned here where the diff would land.
    const buttonRules = [...CSS.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
      .filter((match) => selectorsOf(match[1]).some((part) => /button(?:[:[.]|\s*$)/.test(part)))
      .map((match) => `${match[1].trim()} { ${match[2].trim()} }`);
    const laidOut = buttonRules.filter((rule) => /display:\s*(?:flex|grid|inline-flex|inline-grid)/.test(rule));
    expect(laidOut).toEqual([]);
    expect(CSS).toContain('.pc-wf__btn-inner');
  });

  it('never backgrounds coloured text with a raw rgba token — that ships contrast-UNCHECKED', () => {
    // The repo contrast lint cannot statically composite a raw rgba() function, so a rule
    // declaring BOTH a colour and such a background lands in its "could NOT verify" snapshot
    // and the pair ships unchecked — a silent false green. color-mix() composites fine.
    // This is the drift marker that actually bit while building this surface, so it gets a
    // local detector rather than relying on a repo-wide lint to notice for us.
    const ALPHA_TOKENS = ['--bg-2', '--bg-3', '--bg-4', '--warn-bg', '--good-bg', '--bad-bg'];
    const offenders: string[] = [];
    for (const match of CSS.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const body = match[2];
      if (!/(?:^|;)\s*color:/.test(body)) continue;
      const background = body.match(/(?:^|;)\s*background:\s*([^;]+)/)?.[1] ?? '';
      if (!background) continue;
      const rawAlpha = ALPHA_TOKENS.some((token) => background.includes(`var(${token}`))
        || /\brgba\(/.test(background)
        || /\brgb\([^)]*\/\s*0?\.\d/.test(background);
      if (rawAlpha) offenders.push(`${selectorsOf(match[1]).join(', ')} -> background: ${background.trim()}`);
    }
    expect(offenders).toEqual([]);
  });

  it('declares no nonzero letter-spacing', () => {
    const tracking = [...CSS.matchAll(/letter-spacing:\s*([^;]+);/g)].map((match) => match[1].trim());
    expect(tracking.filter((value) => value !== '0' && value !== 'normal')).toEqual([]);
  });

  it('paints one page chrome, not two — only the root declares page padding', () => {
    // The retired landing reused the tab's root class, so the page painted its own padding,
    // min-height and gradient a second time, nested. Exactly one rule may be the page.
    const pageRules = [...CSS.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
      .filter((match) => /min-height:\s*calc\(100vh/.test(match[2]))
      .flatMap((match) => selectorsOf(match[1]));
    expect(pageRules).toEqual(['.pc-wf']);
  });
});
