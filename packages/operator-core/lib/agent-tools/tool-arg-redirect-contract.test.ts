/**
 * tool-contract-class-sizing-and-non-vacuous-guard-2026-09-05 P-004 — the
 * class-wide `argRedirects` reachability guard.
 *
 * Two halves, deliberately:
 *
 *  - LIVE: run the scanner over the real projected catalog. This is the guard.
 *  - CONTROLS: run the same scanner over deliberately-broken synthetic tools
 *    kept permanently in this file. Without them a green here is worthless — a
 *    scanner that can never report anything is indistinguishable from a clean
 *    catalog. Mutating a real tool to prove the point is forbidden on this
 *    shared tree (the git-sync sweep commits whatever is on disk when it
 *    fires), so the wrong implementations live here instead.
 *
 * The rationale for every rule, and for reading the JSON-Schema projection
 * rather than a `.shape` walk, is in tool-arg-redirect-contract.ts.
 */
import { describe, it, expect } from 'vitest';

import './index';
import { listAllProjectedTools } from '@papercusp/tooldef';

import { MIN_PLAUSIBLE_CATALOG_SIZE } from './tool-guidance-budget';
import {
  scanArgRedirects,
  toRedirectScannableTool,
  formatRedirectIssues,
  REDIRECT_TOOL_FLOOR,
  REDIRECT_DECLARATION_FLOOR,
  type RedirectScannableTool,
} from './tool-arg-redirect-contract';

function liveScannableTools(): RedirectScannableTool[] {
  const catalog = listAllProjectedTools();

  // The vacuous-green trap this whole file exists to avoid: an unregistered
  // catalog scans clean and reports zero issues, which reads exactly like a
  // healthy result. Borrow tool-guidance-budget's floor rather than inventing a
  // second one (EI-19377066316560032).
  expect(
    catalog.length,
    `listAllProjectedTools() returned only ${catalog.length} tool(s), far below the ` +
      `${MIN_PLAUSIBLE_CATALOG_SIZE}-tool floor. The agent-tools barrel did not register, so every assertion ` +
      `below would pass over an EMPTY catalog. Run this through vitest, or any driver that side-effect-imports ` +
      `'./index' first — without that import the barrel never registers.`,
  ).toBeGreaterThanOrEqual(MIN_PLAUSIBLE_CATALOG_SIZE);

  const scannable = catalog
    .map(toRedirectScannableTool)
    .filter((t): t is RedirectScannableTool => t !== null);

  // D-001 rule 2 / D-007 FLOOR A (i): assert the denominator POST-filter, which
  // is the population actually scanned. The pre-filter floor above cannot see a
  // projection change that drops a family of tools out of `properties` — they
  // would leave the scanned class SILENTLY while the count above stayed green.
  // That is D-008's blind spot relocated one layer out, and it is exactly the
  // shape parent D-010 measured in the alias guard.
  expect(
    scannable.length,
    `Only ${scannable.length} of ${catalog.length} catalog tools survived toRedirectScannableTool, below the ` +
      `${MIN_PLAUSIBLE_CATALOG_SIZE}-tool floor. Tools are being dropped from the scanned class because their ` +
      `projected schema yielded no accepted argument keys — the assertions below still read green while ` +
      `covering a shrinking population. Fix the projection (or the adapter); do not lower this floor to ` +
      `restore green.`,
  ).toBeGreaterThanOrEqual(MIN_PLAUSIBLE_CATALOG_SIZE);

  return scannable;
}

describe('argRedirects reachability — class-wide contract (P-004)', () => {
  it('every declared argRedirect names a key the schema actually refuses', () => {
    const scan = scanArgRedirects(liveScannableTools());

    expect(
      scan.issues,
      scan.issues.length === 0
        ? ''
        : `${scan.issues.length} argRedirect declaration(s) can never fire:\n${formatRedirectIssues(scan.issues)}\n\n` +
          `\`invalidInputCorrections\` runs ONLY over UNRECOGNIZED keys, so a redirect whose key the schema ` +
          `accepts is dead text: the caller who reads the guidance never receives the correction. This is the ` +
          `argument-contract defect class (tool-contract-repair-2026-09-05).`,
    ).toEqual([]);
  });

  it('inspected a real population — args, not just tools (D-001 rule 2)', () => {
    const scan = scanArgRedirects(liveScannableTools());

    // Counting TOOLS is not enough: a scan could resolve 800 tools and zero
    // arguments each and still report no issues. The argument denominator is
    // what makes "no issues" mean something.
    expect(
      scan.argsInspected,
      `The scan resolved ${scan.toolsInspected} tools but only ${scan.argsInspected} arguments across all of ` +
        `them. A per-argument rule over an empty argument set passes vacuously.`,
    ).toBeGreaterThan(scan.toolsInspected);

    // Every inspected tool yielded at least one key, or it would have raised a
    // `zero-accepted-keys` issue above rather than being skipped.
    expect(scan.issues.filter((i) => i.kind === 'zero-accepted-keys')).toEqual([]);
  });

  it('the redirect-carrying population has not shrunk below its floors', () => {
    const scan = scanArgRedirects(liveScannableTools());

    expect(
      scan.toolsWithRedirects,
      `Only ${scan.toolsWithRedirects} tools still carry an argRedirect, below the floor of ` +
        `${REDIRECT_TOOL_FLOOR}. A redirect repair was REMOVED — the one regression shape a scan over ` +
        `declarations-that-still-exist cannot see directly. If a tool was genuinely retired, lower ` +
        `REDIRECT_TOOL_FLOOR in tool-arg-redirect-contract.ts and say why in the commit. Never lower a floor ` +
        `just to get green.`,
    ).toBeGreaterThanOrEqual(REDIRECT_TOOL_FLOOR);

    expect(
      scan.declarations.length,
      `Only ${scan.declarations.length} argRedirect declarations remain, below the floor of ` +
        `${REDIRECT_DECLARATION_FLOOR}. See above — this is the same removal shape, counted per declaration ` +
        `rather than per tool, so deleting several redirects from one surviving tool is caught too.`,
    ).toBeGreaterThanOrEqual(REDIRECT_DECLARATION_FLOOR);
  });

  it('reports the population it measured, so a silent collapse to zero is visible', () => {
    const scan = scanArgRedirects(liveScannableTools());

    // eslint-disable-next-line no-console
    console.log(
      `[P-004 live scan] toolsInspected=${scan.toolsInspected} argsInspected=${scan.argsInspected} ` +
        `toolsWithRedirects=${scan.toolsWithRedirects} declarations=${scan.declarations.length} ` +
        `structured=${scan.structuredDeclarations} issues=${scan.issues.length}`,
    );

    expect(scan.toolsWithRedirects).toBeGreaterThan(0);
    expect(scan.declarations.length).toBeGreaterThanOrEqual(scan.toolsWithRedirects);
    // Both forms must be represented, or the scan has quietly stopped seeing one
    // of them — `assertProjectedToolGuidanceConformance` covers ONLY structured
    // redirects, so the prose tier is the half nothing else looks at.
    expect(scan.structuredDeclarations).toBeGreaterThan(0);
    expect(scan.declarations.length - scan.structuredDeclarations).toBeGreaterThan(0);
  });
});

/**
 * CONTROLS — the wrong implementations. Each asserts the scanner CAN fail, so
 * the live green above means something. Do not delete these to "clean up".
 */
describe('argRedirects reachability — detector controls (must stay falsifiable)', () => {
  const tool = (
    name: string,
    acceptedKeys: string[],
    redirects: RedirectScannableTool['redirects'],
  ): RedirectScannableTool => ({ name, acceptedKeys, redirects });

  it('CATCHES a prose redirect whose key the schema accepts (the dead-redirect shape)', () => {
    const scan = scanArgRedirects([
      tool('demo:accepted', ['scope', 'scopeRef'], { scope: 'use a narrower scope' }),
    ]);

    expect(scan.issues).toHaveLength(1);
    expect(scan.issues[0]!.kind).toBe('unreachable-redirect');
    expect(scan.issues[0]!.key).toBe('scope');
  });

  it('CATCHES the same defect in a STRUCTURED redirect, not just prose', () => {
    const scan = scanArgRedirects([
      tool('demo:structured', ['workItem'], {
        workItem: { tool: 'other:verb', args: { id: 'X' }, note: 'go here instead' },
      }),
    ]);

    expect(scan.issues.map((i) => i.kind)).toEqual(['unreachable-redirect']);
    expect(scan.declarations[0]!.form).toBe('structured');
  });

  it('CATCHES a tool that yielded zero accepted keys instead of skipping it', () => {
    // The vacuous-pass shape: a per-argument rule over an empty key set reports
    // nothing, which reads exactly like a clean tool.
    const scan = scanArgRedirects([tool('demo:empty', [], { anything: 'redirect' })]);

    expect(scan.issues.map((i) => i.kind)).toEqual(['zero-accepted-keys']);
    expect(scan.issues[0]!.key).toBeNull();
  });

  it('does NOT fire on a healthy redirect — the controls above are the scanner working, not noise', () => {
    const scan = scanArgRedirects([
      tool('demo:healthy', ['key', 'scope'], {
        q: 'key — this store has no text search',
        query: 'key — facts are addressed by exact key',
      }),
    ]);

    expect(scan.issues).toEqual([]);
    expect(scan.declarations.map((d) => d.key).sort()).toEqual(['q', 'query']);
    expect(scan.toolsWithRedirects).toBe(1);
  });

  it('counts declarations per tool so a floor cannot be gamed by one tool', () => {
    const scan = scanArgRedirects([
      tool('demo:a', ['canonical'], { legacy: 'canonical' }),
      tool('demo:b', ['canonical'], { old: 'canonical', older: 'canonical' }),
    ]);

    expect(scan.toolsWithRedirects).toBe(2);
    expect(scan.declarations).toHaveLength(3);
    expect(scan.issues).toEqual([]);
  });

  it('a tool with no redirects is inspected but is not counted as carrying one', () => {
    const scan = scanArgRedirects([tool('demo:plain', ['a', 'b'], {})]);

    expect(scan.toolsInspected).toBe(1);
    expect(scan.argsInspected).toBe(2);
    expect(scan.toolsWithRedirects).toBe(0);
    expect(scan.issues).toEqual([]);
  });

  it('adapter refuses an unexposed or key-less catalog entry rather than inventing a name', () => {
    expect(toRedirectScannableTool({ inputSchema: { properties: { a: {} } } })).toBeNull();
    expect(toRedirectScannableTool({ expose: { mcp: { name: 'demo:x' } } })).toBeNull();
    expect(toRedirectScannableTool(undefined)).toBeNull();
    // No accepted keys at all -> null, so it is COUNTED as a drop by the
    // post-filter floor rather than silently scanned as clean.
    expect(toRedirectScannableTool({ expose: { mcp: { name: 'demo:x' } }, inputSchema: { properties: {} } })).toBeNull();
  });

  it('adapter recovers keys that survive only in the discovery schema (union branches)', () => {
    // inputSchema relaxes branch-specific requirements for strict clients; a key
    // reachable only through a discovery branch is still accepted by the tool,
    // and treating it as unaccepted would make a live redirect look reachable.
    const scanned = toRedirectScannableTool({
      expose: { mcp: { name: 'demo:union' } },
      inputSchema: { properties: { shared: {} } },
      discoveryInputSchema: {
        anyOf: [{ properties: { shared: {}, path: {} } }, { properties: { shared: {}, sha: {} } }],
      },
    });

    expect(scanned).not.toBeNull();
    expect([...scanned!.acceptedKeys].sort()).toEqual(['path', 'sha', 'shared']);
  });
});
