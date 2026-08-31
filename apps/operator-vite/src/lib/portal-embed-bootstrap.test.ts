import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const indexHtml = readFileSync(join(__dirname, '../../index.html'), 'utf8');
const globalCss = readFileSync(join(__dirname, '../../../operator/app/globals.css'), 'utf8');

describe('portal embed document bootstrap', () => {
  it('chooses the portal semantic theme before the Vite bundle runs', () => {
    const embedBootstrap = indexHtml.indexOf("params.has('portalEmbed')");
    const ordinaryThemeRead = indexHtml.indexOf("const wsId = () =>", embedBootstrap);
    const bundle = indexHtml.indexOf('<script type="module" src="/src/main.tsx">');

    expect(embedBootstrap).toBeGreaterThan(-1);
    expect(embedBootstrap).toBeLessThan(ordinaryThemeRead);
    expect(ordinaryThemeRead).toBeLessThan(bundle);
    expect(indexHtml).toContain("document.documentElement.dataset.portalEmbed = 'true'");
    expect(indexHtml).toContain("? 'portal-dark'");
    expect(indexHtml).toContain(": 'portal-light'");
  });

  it('gives the framed route and AdvShell the whole iframe viewport', () => {
    expect(globalCss).toMatch(/html\[data-portal-embed='true'\] \[data-route-transition-page='true'\][^{]*\{[^}]*height:\s*100dvh/s);
    expect(globalCss).toMatch(/html\[data-portal-embed='true'\] \.pc-advshell\s*\{[^}]*height:\s*100dvh/s);
  });
});
