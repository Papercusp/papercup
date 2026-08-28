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
      '.pc-wf__btn',
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
    ];
    for (const selector of essentialSelectors) expectFontFloor(selector, 13);
  });

  it('keeps secondary metadata at 12px or larger', () => {
    const metadataSelectors = [
      '.pc-wf__source-name',
      '.pc-wf__source-count',
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
    ];
    for (const selector of metadataSelectors) expectFontFloor(selector, 12);
  });

  it('uses the stronger dim foreground token for secondary production copy', () => {
    const contrastSelectors = [
      '.pc-wf__summary',
      '.pc-wf__needs-msg',
      '.pc-wf__chain-text',
      '.pc-wf__num',
      '.pc-wf__insp-desc',
      '.pc-wf__trig-detail',
      '.pc-wf__run-what',
      '.pc-wf__fail-copy',
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
