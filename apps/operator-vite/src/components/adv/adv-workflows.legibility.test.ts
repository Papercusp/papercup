import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const CSS = readFileSync(resolve(process.cwd(), 'src/components/adv/adv-workflows.css'), 'utf8');

function rulesFor(selector: string): string[] {
  const rules = [...CSS.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter((match) => match[1].split(',').map((part) => part.trim()).includes(selector))
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
  it('uses a plain flow-canvas surface without the distracting square grid', () => {
    const canvasRule = rulesFor('.pc-workflows__flow-canvas').join('\n');
    expect(canvasRule).toContain('background: var(--auto-panel)');
    expect(canvasRule).not.toContain('linear-gradient');
    expect(canvasRule).not.toContain('background-size');
  });

  it('never renders text below decorative 11px microcopy', () => {
    const sizes = [...CSS.matchAll(/font-size:\s*(\d+)px/g)].map((match) => Number(match[1]));
    expect(sizes.length).toBeGreaterThan(0);
    expect(sizes.filter((size) => size < 11)).toEqual([]);
  });

  it('keeps essential flow, inspector, control, state, timing, and cost copy at 13px or larger', () => {
    const essentialSelectors = [
      '.pc-workflows__viewbar nav button',
      '.pc-workflows__metric > span',
      '.pc-workflows__flow-toolbar button',
      '.pc-workflows__flow-columns',
      '.pc-workflows__flow-node-title strong',
      '.pc-workflows__flow-node-copy',
      '.pc-workflows__flow-node-meta',
      '.pc-workflows__row-title strong',
      '.pc-workflows__row-copy',
      '.pc-workflows__row-state strong',
      '.pc-workflows__row-state small',
      '.pc-workflows__detailbody > p',
      '.pc-workflows__statechips span',
      '.pc-workflows__detailgrid span',
      '.pc-workflows__detailgrid strong',
      '.pc-workflows__causal-path > div > span',
      '.pc-workflows__causal-path p strong',
      '.pc-workflows__causal-path p small',
      '.pc-workflows__causal-path em',
      '.pc-workflows__trigger > span',
      '.pc-workflows__trigger strong',
      '.pc-workflows__trigger button',
      '.pc-workflows__trigger em',
      '.pc-workflows__cost p',
      '.pc-workflows__actions button',
      '.pc-workflows__history > div',
      '.pc-workflows__activity em',
      '.pc-workflows__activity time',
      '.pc-workflows__sources dt',
      '.pc-workflows__sources dd',
    ];
    for (const selector of essentialSelectors) expectFontFloor(selector, 13);
  });

  it('keeps secondary metadata at 12px or larger', () => {
    const metadataSelectors = [
      '.pc-workflows__viewbar > span',
      '.pc-workflows__panelhead span',
      '.pc-workflows__row-chips span',
      '.pc-workflows__row-spend small',
      '.pc-workflows__causal-path > header span',
      '.pc-workflows__trigger-section > header span',
      '.pc-workflows__trigger small',
      '.pc-workflows__activity small',
      '.pc-workflows__spend-rows small',
      '.pc-workflows__sources span',
    ];
    for (const selector of metadataSelectors) expectFontFloor(selector, 12);
  });

  it('uses the stronger dim foreground token for secondary production copy', () => {
    const contrastSelectors = [
      '.pc-workflows__flow-node-copy',
      '.pc-workflows__flow-node-meta',
      '.pc-workflows__detailbody > p',
      '.pc-workflows__trigger small',
      '.pc-workflows__history > div',
      '.pc-workflows__activity small',
      '.pc-workflows__sources span',
    ];
    for (const selector of contrastSelectors) {
      expect(rulesFor(selector).join('\n'), `${selector} must use the stronger secondary foreground`).toContain('var(--fg-dim');
    }
  });
});
