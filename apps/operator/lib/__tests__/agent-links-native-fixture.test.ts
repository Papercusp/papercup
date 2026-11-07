// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { nativeAgentLinkSelectorExpression } from '../../e2e/_agent-links-native-fixture';

const TARGET = '/reports?sel=rpt_c88d62fe-2d3d-4d6b-84fe-217f1a29d6a2&view=all#details';
const originalHref = location.href;
const selector = (href = TARGET): string | null =>
  new Function(`return ${nativeAgentLinkSelectorExpression('#native-turn', href)}`)();
function anchor(href: string) {
  const link = document.createElement('a');
  link.setAttribute('href', href);
  document.querySelector('#native-turn')!.append(link);
  return link;
}
beforeEach(() => {
  history.replaceState(null, '', '/adv?chat=true');
  document.body.innerHTML = '<div id="native-turn"></div>';
});
afterEach(() => { document.body.innerHTML = ''; history.replaceState(null, '', originalHref); });

describe('native agent-link destination selection', () => {
  it('loads the native fixture through Node ESM without browser module assumptions', async () => {
    const file = pathToFileURL(resolve(__dirname, '../../e2e/_agent-links-native-fixture.ts')).href;
    await promisify(execFile)(process.execPath,
      ['--import', 'tsx', '--input-type=module', '-e', `await import(${JSON.stringify(file)})`],
      { cwd: resolve(__dirname, '../../../..'), timeout: 15_000 });
  }, 20_000);
  it('selects the exact query/hash among bare and decorated references', () => {
    anchor(TARGET.split('&view=')[0]);
    const link = anchor(TARGET.replace('#details', '&chat=true#details'));
    expect(document.querySelector(selector()!)).toBe(link);
  });
  it('also accepts an undecorated exact destination', () => {
    const link = anchor(TARGET);
    expect(document.querySelector(selector()!)).toBe(link);
  });
  it.each([
    ['report', TARGET.replace('c88d62fe', 'd88d62fe')],
    ['query', TARGET.replace('view=all', 'view=wrong')],
    ['hash', TARGET.replace('#details', '#wrong')],
    ['origin', `https://external.invalid${TARGET}`],
    ['extra query', TARGET.replace('#details', '&unexpected=true#details')],
    ['wrong shell state', TARGET.replace('#details', '&chat=false#details')],
    ['duplicate shell state', TARGET.replace('#details', '&chat=true&chat=true#details')],
  ])('refuses a wrong %s even when the report text looks correct', (_name, href) => {
    anchor(href);
    expect(selector()).toBeNull();
  });
  it('refuses invented retained state when the current page has no chat parameter', () => {
    history.replaceState(null, '', '/adv');
    anchor(TARGET.replace('#details', '&chat=true#details'));
    expect(selector()).toBeNull();
  });
  it('keeps an explicit destination override instead of inheriting current chat state', () => {
    const target = TARGET.replace('#details', '&chat=false#details');
    const link = anchor(target);
    expect(document.querySelector(selector(target)!)).toBe(link);
  });
  it('refuses ambiguous targets and returns null for a missing anchor', () => {
    expect(selector()).toBeNull();
    anchor(TARGET); anchor(TARGET.replace('#details', '&chat=true#details'));
    expect(() => selector()).toThrow('Ambiguous native reference');
  });
});
