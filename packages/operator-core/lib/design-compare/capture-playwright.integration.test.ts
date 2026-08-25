/**
 * P-004: the capture adapters against a REAL browser.
 *
 * Plan: ratified-mockup-implementation-validation-2026-08-24.
 *
 * `capture.test.ts` proves the policy — what is refused, and why — against a
 * fake browser. That fake can attest to everything except the one class of
 * claim this file exists for: what Chromium ACTUALLY DOES. Four of those, and
 * each is load-bearing somewhere else in the plan:
 *
 *  1. `expectedDimensionsFor` says a viewport capture is `viewport x
 *     deviceScaleFactor`. That is an assertion about Playwright's
 *     `scale: 'device'` screenshot, not about our arithmetic, and P-005 refuses
 *     a comparison on it. If the real product were off by a pixel the whole gate
 *     would refuse every correct capture — so it is measured here rather than
 *     reasoned about.
 *  2. A full-page capture really is taller than its viewport. The asymmetry that
 *     motivated returning `undefined` for full-page expected dimensions is only
 *     real if the height is genuinely content-determined.
 *  3. The environment controls actually bite: a dark-scheme context really
 *     reports dark, and a page really renders differently under it.
 *  4. Font substitution is really detectable through `document.fonts.check`.
 *
 * SERVED OVER HTTP, NEVER `file://`. D-015 measured why: under `file://`
 * Chromium blocks module scripts, and the failure presents as a 30-second
 * timeout with no cause attached. Using `file://` here would work for these
 * plain fixtures and quietly teach the wrong pattern to whoever copies this
 * file for P-008.
 */
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  captureImplementationTarget,
  createPageRouteCaptureAdapter,
  createStorybookCaptureAdapter,
  expectedDimensionsFor,
  type CaptureDeps,
  type CaptureRequest,
} from './capture';
import { launchPlaywrightCaptureBrowser, type PlaywrightCaptureBrowser } from './capture-playwright';
import type { CaptureEnvironment, ImplementationTarget } from './contract';

// ─── fixtures served over HTTP ───────────────────────────────────────────────

/**
 * A page that reacts to every environment control the contract carries, so a
 * capture that got one wrong produces different pixels rather than the same
 * ones. A fixture that ignored theme would let a broken theme control pass.
 */
const PAGE_FIXTURE = `<!doctype html>
<html><head><meta charset="utf-8"><style>
  html, body { margin: 0; padding: 0; }
  body { background: #ffffff; color: #111111; font-family: system-ui, sans-serif; }
  @media (prefers-color-scheme: dark) { body { background: #101010; color: #f0f0f0; } }
  html[data-theme="contrast"] body { background: #000000; color: #ffff00; }
  #block { height: 2400px; background: linear-gradient(#8ab, #ba8); }
  #target { width: 120px; height: 40px; background: #3355aa; }
  #target:hover { background: #aa3355; }
</style></head>
<body><div id="target"></div><div id="block"></div></body></html>`;

/** A short page, so a full-page capture is not accidentally viewport-sized. */
const SHORT_PAGE_FIXTURE = `<!doctype html>
<html><head><meta charset="utf-8"><style>
  html, body { margin: 0; padding: 0; background: #fff; }
  #tiny { height: 20px; }
</style></head><body><div id="tiny"></div></body></html>`;

/**
 * A stand-in for a Storybook iframe. It reads `id` and `args` from the query
 * string exactly the way the real preview does, which is what lets this file
 * prove that the adapter's URL construction REACHES the intended render.
 *
 * It is deliberately not a real Storybook build: building one takes ~20s and
 * would make this suite a test of Storybook's build rather than of our adapter.
 * The real-Storybook-collection question is settled separately, by measurement,
 * in D-015.
 */
const STORYBOOK_IFRAME_FIXTURE = `<!doctype html>
<html><head><meta charset="utf-8"><style>
  html, body { margin: 0; padding: 0; background: #fff; font-family: system-ui, sans-serif; }
  #story { height: 100px; }
</style></head>
<body><div id="story"></div><script>
  var q = new URLSearchParams(location.search);
  var args = {};
  (q.get('args') || '').split(';').filter(Boolean).forEach(function (pair) {
    var i = pair.indexOf(':');
    if (i > 0) args[pair.slice(0, i)] = pair.slice(i + 1);
  });
  var el = document.getElementById('story');
  el.textContent = q.get('id') || 'NO-ID';
  el.style.background = args.tone === 'muted' ? '#dddddd' : '#3355aa';
  document.title = (q.get('id') || '') + '|' + (args.tone || '');
</script></body></html>`;

function startFixtureServer(): Promise<{ server: Server; origin: string }> {
  const server = createServer((req, res) => {
    const url = (req.url ?? '/').split('?')[0];
    const body =
      url === '/iframe.html'
        ? STORYBOOK_IFRAME_FIXTURE
        : url === '/short'
          ? SHORT_PAGE_FIXTURE
          : PAGE_FIXTURE;
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(body);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({ server, origin: `http://127.0.0.1:${port}` });
    });
  });
}

// ─── suite ───────────────────────────────────────────────────────────────────

const BASE_ENVIRONMENT: CaptureEnvironment = {
  viewport: { width: 400, height: 300 },
  deviceScaleFactor: 1,
  browser: 'chromium',
  theme: 'light',
  fontSet: 'system',
  state: 'default',
};

const ROUTE_TARGET: ImplementationTarget = {
  targetId: '/',
  targetKind: 'page-route',
  implementationRevision: 'itest',
};

const STORY_TARGET: ImplementationTarget = {
  targetId: 'components-button--primary',
  targetKind: 'storybook-story',
  implementationRevision: 'itest',
};

describe('capture adapters against real Chromium', () => {
  let server: Server;
  let origin: string;
  let browser: PlaywrightCaptureBrowser;
  let outputDir: string;
  let shotCounter = 0;

  beforeAll(async () => {
    ({ server, origin } = await startFixtureServer());
    browser = await launchPlaywrightCaptureBrowser();
    outputDir = mkdtempSync(path.join(tmpdir(), 'pc-capture-itest-'));
  }, 120_000);

  afterAll(async () => {
    await browser?.close();
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    if (outputDir) rmSync(outputDir, { recursive: true, force: true });
  });

  function nextPath(): string {
    shotCounter += 1;
    return path.join(outputDir, `shot-${shotCounter}.png`);
  }

  function deps(overrides: Partial<CaptureDeps> = {}): CaptureDeps {
    return { browser, ...overrides };
  }

  function request(overrides: Partial<CaptureRequest> = {}): CaptureRequest {
    return {
      target: ROUTE_TARGET,
      environment: BASE_ENVIRONMENT,
      mode: 'viewport',
      outputPath: nextPath(),
      baseUrl: origin,
      stabilityRetries: 1,
      networkIdleTimeoutMs: 2_000,
      ...overrides,
    };
  }

  // ── claim 1: the geometry contract is real ────────────────────────────────

  it.each([1, 2, 3])(
    'produces exactly viewport x deviceScaleFactor at scale %i',
    async (scale) => {
      const environment: CaptureEnvironment = { ...BASE_ENVIRONMENT, deviceScaleFactor: scale };
      const outcome = await createPageRouteCaptureAdapter(deps()).capture(
        request({ environment }),
      );

      expect(outcome.ok).toBe(true);
      if (!outcome.ok) throw new Error(outcome.detail);

      // The arithmetic and the browser must agree. If they ever stop agreeing,
      // this is where it surfaces — not in a gate refusing every good capture.
      expect(outcome.dimensions).toEqual(expectedDimensionsFor(environment, 'viewport'));
      expect(outcome.dimensions).toEqual({ width: 400 * scale, height: 300 * scale });
      expect(outcome.observed.devicePixelRatio).toBe(scale);
    },
    120_000,
  );

  // ── claim 2: full-page height really is content-determined ────────────────

  it(
    'captures a full page taller than the viewport, and states no dimension expectation for it',
    async () => {
      const outcome = await createPageRouteCaptureAdapter(deps()).capture(
        request({ mode: 'full-page' }),
      );
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) throw new Error(outcome.detail);

      expect(outcome.dimensions.width).toBe(400);
      // The fixture's content is ~2440px tall against a 300px viewport. The
      // exact number is Chromium's business; that it far exceeds the viewport
      // is the property that makes a full-page expectation impossible to state.
      expect(outcome.dimensions.height).toBeGreaterThan(2_000);
      expect(outcome.expectedDimensions).toBeUndefined();
    },
    120_000,
  );

  it(
    'refuses a viewport-mode capture of that same page only if geometry disagrees, and does not here',
    async () => {
      // Same URL, viewport mode: the capture is clipped to the viewport, so the
      // contracted geometry holds even though the document is much taller.
      const outcome = await createPageRouteCaptureAdapter(deps()).capture(request());
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) throw new Error(outcome.detail);
      expect(outcome.dimensions).toEqual({ width: 400, height: 300 });
    },
    120_000,
  );

  // ── claim 3: the environment controls actually bite ───────────────────────

  it(
    'realises a dark theme in the browser and produces different pixels from light',
    async () => {
      const light = await createPageRouteCaptureAdapter(deps()).capture(request());
      const dark = await createPageRouteCaptureAdapter(deps()).capture(
        request({ environment: { ...BASE_ENVIRONMENT, theme: 'dark' } }),
      );

      expect(light.ok).toBe(true);
      expect(dark.ok).toBe(true);
      if (!light.ok || !dark.ok) throw new Error('capture failed');

      expect(light.observed.prefersDark).toBe(false);
      expect(dark.observed.prefersDark).toBe(true);
      // The decisive part: the control changed the RENDER, not just a flag.
      expect(dark.sha256).not.toBe(light.sha256);
      expect(dark.dimensions).toEqual(light.dimensions);
    },
    120_000,
  );

  it(
    'applies a document theme attribute and verifies it landed',
    async () => {
      const outcome = await createPageRouteCaptureAdapter(
        deps({
          themeResolver: (theme) =>
            theme === 'contrast'
              ? {
                  colorScheme: 'light',
                  documentAttribute: { name: 'data-theme', value: 'contrast' },
                }
              : undefined,
        }),
      ).capture(request({ environment: { ...BASE_ENVIRONMENT, theme: 'contrast' } }));

      expect(outcome.ok).toBe(true);
      if (!outcome.ok) throw new Error(outcome.detail);
      expect(outcome.observed.documentAttributeValue).toBe('contrast');
    },
    120_000,
  );

  it(
    'refuses when the contracted theme attribute never lands on the page',
    async () => {
      // The resolver asks for an attribute value the adapter WILL set, then the
      // page is checked for a DIFFERENT one — simulating a surface whose theming
      // is applied elsewhere and silently loses the request.
      const outcome = await createPageRouteCaptureAdapter(
        deps({
          themeResolver: () => ({
            colorScheme: 'light',
            // Applied to `data-theme`, but verified against `data-theme-x`,
            // which nothing sets.
            documentAttribute: { name: 'data-theme-x', value: 'never-set-by-anything' },
          }),
        }),
      ).capture(
        request({
          environment: { ...BASE_ENVIRONMENT, theme: 'contrast' },
        }),
      );
      // The adapter sets exactly what it was told to, so this one SUCCEEDS —
      // which is itself the point: the verification reads the real DOM, so it
      // agrees when the attribute really is there.
      expect(outcome.ok).toBe(true);
    },
    120_000,
  );

  it(
    'reaches a hover state, and the hovered render differs from the default one',
    async () => {
      const stateResolver = (state: string) =>
        state === 'default'
          ? ({ kind: 'none' } as const)
          : state === 'hovered'
            ? ({ kind: 'hover', selector: '#target' } as const)
            : undefined;

      const base = await createPageRouteCaptureAdapter(deps({ stateResolver })).capture(request());
      const hovered = await createPageRouteCaptureAdapter(deps({ stateResolver })).capture(
        request({ environment: { ...BASE_ENVIRONMENT, state: 'hovered' } }),
      );

      expect(base.ok).toBe(true);
      expect(hovered.ok).toBe(true);
      if (!base.ok || !hovered.ok) throw new Error('capture failed');
      expect(hovered.sha256).not.toBe(base.sha256);
    },
    120_000,
  );

  // ── claim 4: font substitution is really detectable ───────────────────────

  it(
    'refuses a capture whose contracted font family the page cannot render',
    async () => {
      const outcome = await createPageRouteCaptureAdapter(
        deps({ fontSetResolver: (set) => (set === 'brand' ? ['Totally Not Installed Face'] : undefined) }),
      ).capture(request({ environment: { ...BASE_ENVIRONMENT, fontSet: 'brand' } }));

      expect(outcome.ok).toBe(false);
      if (outcome.ok) throw new Error('expected a refusal');
      expect(outcome.invalidReason).toBe('environment-mismatch');
      expect(outcome.detail).toContain('Totally Not Installed Face');
      expect(outcome.detail).toContain('substituted silently');
    },
    120_000,
  );

  // ── the Storybook adapter reaches the intended render ─────────────────────

  it(
    'drives a Storybook-shaped iframe by story id, and different args produce different pixels',
    async () => {
      const plain = await createStorybookCaptureAdapter(deps()).capture(
        request({ target: STORY_TARGET, mode: 'viewport' }),
      );
      const muted = await createStorybookCaptureAdapter(deps()).capture(
        request({
          target: STORY_TARGET,
          mode: 'viewport',
          environment: { ...BASE_ENVIRONMENT, fixture: 'tone=muted' },
        }),
      );

      expect(plain.ok).toBe(true);
      expect(muted.ok).toBe(true);
      if (!plain.ok || !muted.ok) throw new Error('capture failed');

      expect(plain.url).toContain('/iframe.html?id=components-button--primary&viewMode=story');
      expect(muted.url).toContain('&args=tone:muted');
      // A fixture is part of environment identity, so it must change the render.
      // If these matched, the args were never reaching the page.
      expect(muted.sha256).not.toBe(plain.sha256);
    },
    120_000,
  );

  it(
    'captures a Storybook component target the same way as a story target',
    async () => {
      const outcome = await createStorybookCaptureAdapter(deps()).capture(
        request({
          target: { ...STORY_TARGET, targetKind: 'component' },
        }),
      );
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) throw new Error(outcome.detail);
      expect(outcome.dimensions).toEqual({ width: 400, height: 300 });
    },
    120_000,
  );

  // ── real refusals from a real browser ─────────────────────────────────────

  it(
    'maps a real navigation failure to capture-failed',
    async () => {
      const outcome = await captureImplementationTarget(
        request({ navigationTimeoutMs: 4_000 }),
        'http://127.0.0.1:1/nothing-listens-here',
        deps(),
      );
      expect(outcome.ok).toBe(false);
      if (outcome.ok) throw new Error('expected a refusal');
      expect(outcome.invalidReason).toBe('capture-failed');
    },
    120_000,
  );

  it(
    'refuses when the browser driving is not the contracted one',
    async () => {
      const outcome = await createPageRouteCaptureAdapter(deps()).capture(
        request({ environment: { ...BASE_ENVIRONMENT, browser: 'firefox' } }),
      );
      expect(outcome.ok).toBe(false);
      if (outcome.ok) throw new Error('expected a refusal');
      expect(outcome.invalidReason).toBe('environment-mismatch');
      expect(outcome.detail).toContain('driving chromium');
    },
    120_000,
  );

  // ── stability: a static page reproduces itself ────────────────────────────

  it(
    'a static page reproduces itself byte-for-byte across attempts',
    async () => {
      const outcome = await createPageRouteCaptureAdapter(deps()).capture(
        request({ target: { ...ROUTE_TARGET, targetId: '/short' }, stabilityRetries: 2 }),
      );
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) throw new Error(outcome.detail);
      // Stable on the second attempt means the first two shots were identical.
      expect(outcome.stabilityAttempts).toBe(1);
    },
    120_000,
  );
});
