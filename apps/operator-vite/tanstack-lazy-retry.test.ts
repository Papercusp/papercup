/**
 * Contract test for the tanstack-lazy-retry build plugin (WI-2902).
 *
 * The plugin rewrites the `lazyRouteComponent` import that
 * `@tanstack/router-plugin` emits into every autoCodeSplit route module. If the
 * plugin's emitted shape ever drifts from TANSTACK_LAZY_IMPORT_RE, route-chunk
 * retry silently stops — so this pins the regex to the ACTUAL emitted string
 * (from node_modules/@tanstack/router-plugin/.../code-splitter/compilers.js:
 * `template.statement(\`import { ${LAZY_ROUTE_COMPONENT_IDENT} } from
 * '${PACKAGE}'\`)`, i.e. `lazyRouteComponent` from `@tanstack/react-router`),
 * across the quote/whitespace/semicolon variants babel's generator can produce.
 *
 * Run with:
 *   node_modules/.bin/vitest run --config apps/operator-vite/vitest.config.ts \
 *     apps/operator-vite/tanstack-lazy-retry.test.ts
 */
import { describe, expect, it } from 'vitest';
import {
  TANSTACK_LAZY_IMPORT_RE,
  rewriteLazyRouteComponentImport,
  retryImportStatement,
} from './tanstack-lazy-retry';

describe('TANSTACK_LAZY_IMPORT_RE', () => {
  it('matches the import the router-plugin emits, in every quote/spacing variant', () => {
    for (const emitted of [
      `import { lazyRouteComponent } from '@tanstack/react-router'`, // single quote (plugin template)
      `import { lazyRouteComponent } from "@tanstack/react-router";`, // babel double-quote + semicolon
      `import {lazyRouteComponent} from '@tanstack/react-router';`, // tight spacing
      `import {  lazyRouteComponent  } from  "@tanstack/react-router"`, // loose spacing
    ]) {
      expect(TANSTACK_LAZY_IMPORT_RE.test(emitted)).toBe(true);
    }
  });

  it('does NOT match unrelated @tanstack/react-router imports', () => {
    expect(
      TANSTACK_LAZY_IMPORT_RE.test(`import { createFileRoute } from '@tanstack/react-router'`),
    ).toBe(false);
    expect(
      TANSTACK_LAZY_IMPORT_RE.test(`import { lazyRouteComponent } from '@tanstack/solid-router'`),
    ).toBe(false);
  });
});

describe('rewriteLazyRouteComponentImport', () => {
  it('swaps the import for the retry wrapper (aliased back to lazyRouteComponent)', () => {
    const code = [
      `import { lazyRouteComponent } from '@tanstack/react-router'`,
      `const SplitComponentImporter = () => import('./route.tsx?tsr-split=component')`,
      `export const Route = createFileRoute('/x')({`,
      `  component: lazyRouteComponent(SplitComponentImporter, 'component'),`,
      `})`,
    ].join('\n');
    const out = rewriteLazyRouteComponentImport(code, '../../lib/lazy-route-component-retry');
    expect(out).not.toBeNull();
    // the original bare-package import is gone…
    expect(out).not.toMatch(/from '@tanstack\/react-router'/);
    // …replaced by our wrapper, re-aliased so the call site is untouched
    expect(out).toContain(
      "import { lazyRouteComponentWithRetry as lazyRouteComponent } from '../../lib/lazy-route-component-retry';",
    );
    // the call expression the splitter generated is preserved verbatim
    expect(out).toContain("component: lazyRouteComponent(SplitComponentImporter, 'component')");
  });

  it('returns null when there is nothing to rewrite', () => {
    expect(
      rewriteLazyRouteComponentImport(`import { createFileRoute } from '@tanstack/react-router'`, './x'),
    ).toBeNull();
  });
});

describe('retryImportStatement', () => {
  it('aliases the wrapper back to the original ident so call sites need no edit', () => {
    expect(retryImportStatement('./lib/x')).toBe(
      "import { lazyRouteComponentWithRetry as lazyRouteComponent } from './lib/x';",
    );
  });
});
