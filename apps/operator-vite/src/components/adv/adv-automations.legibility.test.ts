import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const CSS = readFileSync(resolve(process.cwd(), 'src/components/adv/adv-automations.css'), 'utf8');

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

describe('Automations legibility contract', () => {
  it('uses a plain flow-canvas surface without the distracting square grid', () => {
    const canvasRule = rulesFor('.pc-automations__flow-canvas').join('\n');
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
      '.pc-automations__viewbar nav button',
      '.pc-automations__metric > span',
      '.pc-automations__flow-toolbar button',
      '.pc-automations__flow-columns',
      '.pc-automations__flow-node-title strong',
      '.pc-automations__flow-node-copy',
      '.pc-automations__flow-node-meta',
      '.pc-automations__row-title strong',
      '.pc-automations__row-copy',
      '.pc-automations__row-state strong',
      '.pc-automations__row-state small',
      '.pc-automations__detailbody > p',
      '.pc-automations__statechips span',
      '.pc-automations__detailgrid span',
      '.pc-automations__detailgrid strong',
      '.pc-automations__causal-path > div > span',
      '.pc-automations__causal-path p strong',
      '.pc-automations__causal-path p small',
      '.pc-automations__causal-path em',
      '.pc-automations__trigger > span',
      '.pc-automations__trigger strong',
      '.pc-automations__trigger button',
      '.pc-automations__trigger em',
      '.pc-automations__cost p',
      '.pc-automations__actions button',
      '.pc-automations__history > div',
      '.pc-automations__activity em',
      '.pc-automations__activity time',
      '.pc-automations__sources dt',
      '.pc-automations__sources dd',
    ];
    for (const selector of essentialSelectors) expectFontFloor(selector, 13);
  });

  it('keeps secondary metadata at 12px or larger', () => {
    const metadataSelectors = [
      '.pc-automations__viewbar > span',
      '.pc-automations__panelhead span',
      '.pc-automations__chips span',
      '.pc-automations__row-spend small',
      '.pc-automations__causal-path > header span',
      '.pc-automations__trigger-section > header span',
      '.pc-automations__trigger small',
      '.pc-automations__activity small',
      '.pc-automations__spend-rows small',
      '.pc-automations__sources span',
    ];
    for (const selector of metadataSelectors) expectFontFloor(selector, 12);
  });

  it('uses the stronger dim foreground token for secondary production copy', () => {
    const contrastSelectors = [
      '.pc-automations__flow-node-copy',
      '.pc-automations__flow-node-meta',
      '.pc-automations__detailbody > p',
      '.pc-automations__trigger small',
      '.pc-automations__history > div',
      '.pc-automations__activity small',
      '.pc-automations__sources span',
    ];
    for (const selector of contrastSelectors) {
      expect(rulesFor(selector).join('\n'), `${selector} must use the stronger secondary foreground`).toContain('var(--fg-dim');
    }
  });
});
